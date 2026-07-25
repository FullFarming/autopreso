-- 2026-07-20 feat: Add revocable link admission without retaining bearer tokens.
-- This migration must run after 202607190001_live_sessions.sql and
-- 202607190002_live_voice_output.sql. Only a server-side HMAC is persisted.

create table public.live_session_invites (
  session_id uuid primary key references public.live_sessions(id) on delete cascade,
  token_hmac text not null unique check (token_hmac ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint live_session_invites_expiry_check check (expires_at > created_at),
  constraint live_session_invites_revocation_check check (
    revoked_at is null or revoked_at >= created_at
  )
);

create index live_session_invites_expiry_idx
  on public.live_session_invites (expires_at, revoked_at);

alter table public.live_session_invites enable row level security;

-- No row policy is intentional: bearer-link state is server-only. The table
-- owner remains available to the SECURITY DEFINER functions below.
revoke all on table public.live_session_invites
  from public, anon, authenticated, service_role;

create or replace function public.create_live_invite(
  p_session_id uuid,
  p_host_id text,
  p_token_hmac text,
  p_expires_at timestamptz,
  p_admission_open_until timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
begin
  if p_host_id is null
    or length(p_host_id) not between 1 and 256
    or p_token_hmac is null
    or p_token_hmac !~ '^[0-9a-f]{64}$'
    or p_expires_at is null
    or p_expires_at <= statement_timestamp()
    or p_admission_open_until is null
    or p_admission_open_until <= statement_timestamp()
  then
    raise exception using errcode = '22023', message = 'INVALID_INVITE_INPUT';
  end if;

  select * into session_row
  from public.live_sessions
  where id = p_session_id
  for update;

  if not found
    or session_row.host_id <> p_host_id
    or session_row.status not in ('preparing', 'live')
    or session_row.expires_at <= statement_timestamp()
  then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  if not (session_row.admission_open_until is not distinct from p_admission_open_until)
    or session_row.admission_open_until <= statement_timestamp()
    or p_expires_at > p_admission_open_until
    or p_expires_at > session_row.expires_at
  then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
  end if;

  insert into public.live_session_invites (
    session_id, token_hmac, expires_at, revoked_at, created_at
  ) values (
    p_session_id, p_token_hmac, p_expires_at, null, statement_timestamp()
  )
  on conflict (session_id) do update
    set token_hmac = excluded.token_hmac,
        expires_at = excluded.expires_at,
        revoked_at = null,
        created_at = statement_timestamp();
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'INVITE_TOKEN_CONFLICT';
end;
$$;

create or replace function public.resolve_live_invite_rate_key(
  p_token_hmac text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_rate_key text;
begin
  if p_token_hmac is null or p_token_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'INVITE_CLOSED';
  end if;

  select encode(extensions.digest(session_row.id::text, 'sha256'), 'hex')
  into session_rate_key
  from public.live_session_invites invite_row
  join public.live_sessions session_row on session_row.id = invite_row.session_id
  where invite_row.token_hmac = p_token_hmac
    and invite_row.revoked_at is null
    and invite_row.expires_at > statement_timestamp()
    and session_row.admission_open_until > statement_timestamp()
    and session_row.status in ('preparing', 'live')
    and session_row.expires_at > statement_timestamp();

  if session_rate_key is null then
    raise exception using errcode = 'P0001', message = 'INVITE_CLOSED';
  end if;
  return session_rate_key;
end;
$$;

create or replace function public.redeem_live_invite(
  p_token_hmac text,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz
)
returns table (
  grant_id uuid,
  session_id uuid,
  user_id text,
  grant_expires_at timestamptz,
  mode text,
  languages text[],
  session_expires_at timestamptz,
  viewer_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  candidate_session_id uuid;
  session_row public.live_sessions%rowtype;
  invite_row public.live_session_invites%rowtype;
  grant_row public.viewer_grants%rowtype;
  active_count integer;
  bounded_expiry timestamptz;
  resolved_viewer_count integer;
begin
  if p_token_hmac is null
    or p_token_hmac !~ '^[0-9a-f]{64}$'
    or p_user_id is null
    or length(p_user_id) not between 1 and 256
    or p_device_hash is null
    or p_device_hash !~ '^[0-9a-f]{64}$'
    or p_grant_expires_at is null
    or p_grant_expires_at <= statement_timestamp()
    or p_grant_expires_at > statement_timestamp() + interval '6 hours'
  then
    raise exception using errcode = '22023', message = 'INVALID_INVITE_INPUT';
  end if;

  -- The initial lookup is untrusted. The invite is re-read only after locking
  -- the session row, matching create/close/terminate lock order.
  select invite_lookup.session_id into candidate_session_id
  from public.live_session_invites invite_lookup
  where invite_lookup.token_hmac = p_token_hmac;

  if candidate_session_id is null then
    raise exception using errcode = 'P0001', message = 'INVITE_CLOSED';
  end if;

  select * into session_row
  from public.live_sessions
  where id = candidate_session_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'INVITE_CLOSED';
  end if;

  select * into invite_row
  from public.live_session_invites
  where live_session_invites.session_id = session_row.id
  for update;

  if not found
    or invite_row.token_hmac <> p_token_hmac
    or invite_row.revoked_at is not null
    or invite_row.expires_at <= statement_timestamp()
    or session_row.admission_open_until is null
    or session_row.admission_open_until <= statement_timestamp()
    or session_row.status not in ('preparing', 'live')
    or session_row.expires_at <= statement_timestamp()
  then
    raise exception using errcode = 'P0001', message = 'INVITE_CLOSED';
  end if;

  bounded_expiry := least(p_grant_expires_at, session_row.expires_at);

  select count(*)::integer into active_count
  from public.viewer_grants
  where viewer_grants.session_id = session_row.id
    and revoked_at is null
    and expires_at > statement_timestamp();

  select * into grant_row
  from public.viewer_grants
  where viewer_grants.session_id = session_row.id
    and viewer_grants.user_id = p_user_id
    and viewer_grants.device_hash = p_device_hash
  for update;

  if found and grant_row.revoked_at is null and grant_row.expires_at > statement_timestamp() then
    update public.viewer_grants
    set last_joined_at = statement_timestamp(),
        expires_at = greatest(expires_at, bounded_expiry)
    where id = grant_row.id
    returning * into grant_row;
    resolved_viewer_count := active_count;
  else
    if active_count >= 50 then
      raise exception using errcode = 'P0001', message = 'VIEWER_LIMIT_REACHED';
    end if;

    insert into public.viewer_grants (
      session_id, user_id, device_hash, expires_at, revoked_at, last_joined_at
    ) values (
      session_row.id, p_user_id, p_device_hash, bounded_expiry, null, statement_timestamp()
    )
    on conflict (session_id, user_id, device_hash) do update
      set expires_at = excluded.expires_at,
          revoked_at = null,
          last_joined_at = statement_timestamp()
    returning * into grant_row;
    resolved_viewer_count := active_count + 1;
  end if;

  update public.live_sessions
  set viewer_count = resolved_viewer_count,
      updated_at = statement_timestamp()
  where id = session_row.id;

  grant_id := grant_row.id;
  session_id := session_row.id;
  user_id := grant_row.user_id;
  grant_expires_at := grant_row.expires_at;
  mode := session_row.mode;
  languages := session_row.languages;
  session_expires_at := session_row.expires_at;
  viewer_count := resolved_viewer_count;
  return next;
end;
$$;

create or replace function public.open_live_admission(
  p_session_id uuid,
  p_host_id text,
  p_code_hmac text,
  p_open_until timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_host_id is null
    or length(p_host_id) not between 1 and 256
    or p_code_hmac is null
    or p_code_hmac !~ '^[0-9a-f]{64}$'
    or p_open_until is null
    or p_open_until <= statement_timestamp()
    or p_open_until > statement_timestamp() + interval '5 minutes'
  then
    raise exception using errcode = '22023', message = 'INVALID_ADMISSION_INPUT';
  end if;

  perform 1
  from public.live_sessions
  where id = p_session_id
    and host_id = p_host_id
    and status in ('preparing', 'live')
    and expires_at > statement_timestamp()
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  update public.live_sessions
  set admission_code_hmac = p_code_hmac,
      admission_open_until = p_open_until,
      updated_at = statement_timestamp(),
      version = version + 1
  where id = p_session_id
    and host_id = p_host_id;

  update public.live_session_invites invite_row
  set revoked_at = coalesce(invite_row.revoked_at, statement_timestamp())
  where invite_row.session_id = p_session_id;
end;
$$;

create or replace function public.close_live_admission(
  p_session_id uuid,
  p_host_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1
  from public.live_sessions
  where id = p_session_id
    and host_id = p_host_id
    and status <> 'stopped'
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  update public.live_sessions
  set admission_code_hmac = null,
      admission_open_until = null,
      updated_at = statement_timestamp(),
      version = version + 1
  where id = p_session_id
    and host_id = p_host_id;

  update public.live_session_invites invite_row
  set revoked_at = coalesce(invite_row.revoked_at, statement_timestamp())
  where invite_row.session_id = p_session_id;
end;
$$;

create or replace function public.terminate_live_session(
  p_session_id uuid,
  p_host_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1
  from public.live_sessions
  where id = p_session_id
    and host_id = p_host_id
  for update;

  if not found then
    return false;
  end if;

  update public.live_sessions
  set status = 'stopped',
      viewer_count = 0,
      admission_code_hmac = null,
      admission_open_until = null,
      ended_at = coalesce(ended_at, statement_timestamp()),
      updated_at = statement_timestamp(),
      version = version + case when status = 'stopped' then 0 else 1 end
  where id = p_session_id
    and host_id = p_host_id;

  update public.live_session_invites invite_row
  set revoked_at = coalesce(invite_row.revoked_at, statement_timestamp())
  where invite_row.session_id = p_session_id;
  update public.viewer_grants
  set revoked_at = coalesce(revoked_at, statement_timestamp())
  where session_id = p_session_id;
  delete from public.live_snapshots where session_id = p_session_id;
  delete from public.session_speakers where session_id = p_session_id;
  return true;
end;
$$;

create or replace function public.cleanup_expired_live_state()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  stopped_count integer;
begin
  -- Redeem, admission rotation, and termination all lock the session before
  -- grants or invites. Cleanup uses the same order to avoid an inverse-lock
  -- deadlock while an expired grant is being reactivated.
  perform 1
  from public.live_sessions session_lock
  where session_lock.status <> 'stopped'
    and (
      session_lock.expires_at <= statement_timestamp()
      or exists (
        select 1
        from public.viewer_grants grant_lock
        where grant_lock.session_id = session_lock.id
          and grant_lock.revoked_at is null
          and grant_lock.expires_at <= statement_timestamp()
      )
      or exists (
        select 1
        from public.live_session_invites invite_lock
        where invite_lock.session_id = session_lock.id
          and invite_lock.revoked_at is null
          and (
            invite_lock.expires_at <= statement_timestamp()
            or session_lock.admission_open_until is null
            or session_lock.admission_open_until <= statement_timestamp()
          )
      )
    )
  order by session_lock.id
  for update;

  with stopped as (
    update public.live_sessions
    set status = 'stopped',
        viewer_count = 0,
        admission_code_hmac = null,
        admission_open_until = null,
        ended_at = coalesce(ended_at, statement_timestamp()),
        updated_at = statement_timestamp(),
        version = version + 1
    where status <> 'stopped'
      and expires_at <= statement_timestamp()
    returning id
  )
  select count(*)::integer into stopped_count from stopped;

  update public.live_session_invites invite_row
  set revoked_at = coalesce(invite_row.revoked_at, statement_timestamp())
  from public.live_sessions session_row
  where invite_row.session_id = session_row.id
    and invite_row.revoked_at is null
    and (
      invite_row.expires_at <= statement_timestamp()
      or session_row.status = 'stopped'
      or session_row.expires_at <= statement_timestamp()
      or session_row.admission_open_until is null
      or session_row.admission_open_until <= statement_timestamp()
    );

  update public.viewer_grants
  set revoked_at = coalesce(revoked_at, statement_timestamp())
  where revoked_at is null
    and expires_at <= statement_timestamp();

  update public.live_sessions session_row
  set viewer_count = active_grants.viewer_count,
      updated_at = statement_timestamp()
  from (
    select session_id, count(*)::integer as viewer_count
    from public.viewer_grants
    where revoked_at is null
      and expires_at > statement_timestamp()
    group by session_id
  ) active_grants
  where session_row.id = active_grants.session_id
    and session_row.status <> 'stopped'
    and session_row.viewer_count <> active_grants.viewer_count;

  update public.live_sessions session_row
  set viewer_count = 0,
      updated_at = statement_timestamp()
  where session_row.status <> 'stopped'
    and session_row.viewer_count <> 0
    and not exists (
      select 1
      from public.viewer_grants grant_row
      where grant_row.session_id = session_row.id
        and grant_row.revoked_at is null
        and grant_row.expires_at > statement_timestamp()
    );

  delete from public.live_snapshots snapshot_row
  using public.live_sessions session_row
  where snapshot_row.session_id = session_row.id
    and session_row.status = 'stopped';
  delete from public.session_speakers speaker_row
  using public.live_sessions session_row
  where speaker_row.session_id = session_row.id
    and session_row.status = 'stopped';
  delete from public.live_session_invites
  where revoked_at < statement_timestamp() - interval '1 day';
  delete from public.live_rate_limits
  where updated_at < statement_timestamp() - interval '1 day';

  return stopped_count;
end;
$$;

revoke all on function public.create_live_invite(uuid, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function public.resolve_live_invite_rate_key(text)
  from public, anon, authenticated;
revoke all on function public.redeem_live_invite(text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.open_live_admission(uuid, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.close_live_admission(uuid, text)
  from public, anon, authenticated;
revoke all on function public.terminate_live_session(uuid, text)
  from public, anon, authenticated;
revoke all on function public.cleanup_expired_live_state()
  from public, anon, authenticated;

grant execute on function public.create_live_invite(uuid, text, text, timestamptz, timestamptz)
  to service_role;
grant execute on function public.resolve_live_invite_rate_key(text)
  to service_role;
grant execute on function public.redeem_live_invite(text, text, text, timestamptz)
  to service_role;
grant execute on function public.open_live_admission(uuid, text, text, timestamptz)
  to service_role;
grant execute on function public.close_live_admission(uuid, text)
  to service_role;
grant execute on function public.terminate_live_session(uuid, text)
  to service_role;
grant execute on function public.cleanup_expired_live_state()
  to service_role;
