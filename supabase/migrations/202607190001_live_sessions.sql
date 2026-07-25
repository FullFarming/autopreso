-- 2026-07-19 feat: Add session-scoped multilingual live delivery state.
-- Audio and voice characteristics are intentionally absent; only the latest
-- finalized caption snapshot and speaker presentation metadata may persist.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.live_languages_valid(p_languages text[])
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select
    cardinality(p_languages) between 1 and 3
    and cardinality(p_languages) = (
      select count(distinct language_code)
      from unnest(p_languages) as language_code
    )
    and not exists (
      select 1
      from unnest(p_languages) as language_code
      where language_code !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
    );
$$;

create table public.live_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  host_id text not null,
  mode text not null check (mode in ('presentation', 'meeting', 'townhall')),
  status text not null default 'preparing' check (status in ('preparing', 'live', 'stopped', 'failed')),
  languages text[] not null check (public.live_languages_valid(languages)),
  viewer_count integer not null default 0 check (viewer_count between 0 and 50),
  version integer not null default 1 check (version >= 1),
  admission_code_hmac text,
  admission_open_until timestamptz,
  expires_at timestamptz not null default (now() + interval '6 hours'),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint live_sessions_admission_pair_check check (
    (admission_code_hmac is null and admission_open_until is null)
    or (admission_code_hmac ~ '^[0-9a-f]{64}$' and admission_open_until is not null)
  ),
  constraint live_sessions_expiry_check check (
    expires_at > created_at and expires_at <= created_at + interval '6 hours'
  )
);

create unique index live_sessions_active_admission_code_idx
  on public.live_sessions (admission_code_hmac)
  where admission_code_hmac is not null;
create index live_sessions_host_status_idx on public.live_sessions (host_id, status);
create index live_sessions_expiry_idx on public.live_sessions (expires_at) where status <> 'stopped';

create table public.viewer_grants (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  user_id text not null,
  device_hash text not null check (device_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_joined_at timestamptz not null default now(),
  unique (session_id, user_id, device_hash)
);

create index viewer_grants_active_lookup_idx
  on public.viewer_grants (session_id, user_id, expires_at)
  where revoked_at is null;
create index viewer_grants_expiry_idx
  on public.viewer_grants (expires_at)
  where revoked_at is null;

create table public.session_speakers (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  speaker_id text not null,
  label text not null,
  color_token text not null,
  voice_name text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (session_id, speaker_id),
  unique (session_id, color_token),
  unique (session_id, voice_name)
);

create index session_speakers_last_seen_idx on public.session_speakers (session_id, last_seen_at desc);

create table public.live_snapshots (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  language text not null,
  last_seq bigint not null default 0 check (last_seq >= 0),
  captions jsonb not null default '[]'::jsonb,
  speaker_legend jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (session_id, language),
  constraint live_snapshots_language_check check (language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  constraint live_snapshots_captions_array_check check (
    jsonb_typeof(captions) = 'array' and jsonb_array_length(captions) <= 50
  ),
  constraint live_snapshots_speaker_legend_array_check check (
    jsonb_typeof(speaker_legend) = 'array' and jsonb_array_length(speaker_legend) <= 6
  )
);

create index live_snapshots_updated_idx on public.live_snapshots (session_id, updated_at desc);

-- Database-backed buckets keep brute-force protection consistent across
-- horizontally scaled Next.js and Cloud Run instances.
create table public.live_rate_limits (
  scope text not null,
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (scope, key_hash)
);

create index live_rate_limits_updated_idx on public.live_rate_limits (updated_at);

create or replace function public.enforce_live_speaker_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  speaker_count integer;
begin
  perform 1 from public.live_sessions where id = new.session_id for update;
  if not found then
    raise exception using errcode = '23503', message = 'LIVE_SESSION_NOT_FOUND';
  end if;

  if exists (
    select 1
    from public.session_speakers
    where session_id = new.session_id
      and speaker_id = new.speaker_id
  ) then
    return new;
  end if;

  select count(*)::integer into speaker_count
  from public.session_speakers
  where session_id = new.session_id;

  if speaker_count >= 6 then
    raise exception using errcode = '23514', message = 'SPEAKER_LIMIT_REACHED';
  end if;
  return new;
end;
$$;

create trigger session_speakers_limit_before_write
before insert or update of session_id on public.session_speakers
for each row execute function public.enforce_live_speaker_limit();

alter table public.live_sessions enable row level security;
alter table public.viewer_grants enable row level security;
alter table public.session_speakers enable row level security;
alter table public.live_snapshots enable row level security;
alter table public.live_rate_limits enable row level security;

create policy live_sessions_host_select
  on public.live_sessions for select to authenticated
  using (host_id = (select auth.uid())::text);

create policy live_sessions_viewer_select
  on public.live_sessions for select to authenticated
  using (
    status = 'live'
    and expires_at > now()
    and exists (
      select 1
      from public.viewer_grants grant_row
      where grant_row.session_id = live_sessions.id
        and grant_row.user_id = (select auth.uid())::text
        and grant_row.revoked_at is null
        and grant_row.expires_at > now()
    )
  );

create policy viewer_grants_owner_select
  on public.viewer_grants for select to authenticated
  using (
    user_id = (select auth.uid())::text
    and revoked_at is null
    and expires_at > now()
  );

create policy session_speakers_authorized_select
  on public.session_speakers for select to authenticated
  using (
    exists (
      select 1
      from public.live_sessions session_row
      where session_row.id = session_speakers.session_id
        and (
          session_row.host_id = (select auth.uid())::text
          or (
            session_row.status = 'live'
            and session_row.expires_at > now()
            and exists (
              select 1
              from public.viewer_grants grant_row
              where grant_row.session_id = session_row.id
                and grant_row.user_id = (select auth.uid())::text
                and grant_row.revoked_at is null
                and grant_row.expires_at > now()
            )
          )
        )
    )
  );

create policy live_snapshots_authorized_select
  on public.live_snapshots for select to authenticated
  using (
    exists (
      select 1
      from public.live_sessions session_row
      where session_row.id = live_snapshots.session_id
        and live_snapshots.language = any(session_row.languages)
        and (
          session_row.host_id = (select auth.uid())::text
          or (
            session_row.status = 'live'
            and session_row.expires_at > now()
            and exists (
              select 1
              from public.viewer_grants grant_row
              where grant_row.session_id = session_row.id
                and grant_row.user_id = (select auth.uid())::text
                and grant_row.revoked_at is null
                and grant_row.expires_at > now()
            )
          )
        )
    )
  );

grant select (
  id, host_id, mode, status, languages, viewer_count, version,
  expires_at, ended_at, created_at, updated_at
) on public.live_sessions to authenticated;
grant select (
  id, session_id, user_id, expires_at, revoked_at, created_at, last_joined_at
) on public.viewer_grants to authenticated;
grant select on public.session_speakers, public.live_snapshots to authenticated;

grant select, insert, update, delete
  on public.live_sessions, public.viewer_grants, public.session_speakers,
     public.live_snapshots, public.live_rate_limits
  to service_role;

-- Private Realtime topic format is exactly live:{session UUID}:{language}.
-- Viewers may receive Broadcast rows only while their grant and language are
-- current. Gateway publication uses service_role and bypasses this policy.
create policy live_broadcast_viewer_receive
  on realtime.messages for select to authenticated
  using (
    extension = 'broadcast'
    and cardinality(string_to_array(realtime.topic(), ':')) = 3
    and split_part(realtime.topic(), ':', 1) = 'live'
    and exists (
      select 1
      from public.live_sessions session_row
      join public.viewer_grants grant_row on grant_row.session_id = session_row.id
      where session_row.id::text = split_part(realtime.topic(), ':', 2)
        and split_part(realtime.topic(), ':', 3) = any(session_row.languages)
        and session_row.status = 'live'
        and session_row.expires_at > now()
        and grant_row.user_id = (select auth.uid())::text
        and grant_row.revoked_at is null
        and grant_row.expires_at > now()
    )
  );

create policy live_broadcast_host_receive
  on realtime.messages for select to authenticated
  using (
    extension = 'broadcast'
    and cardinality(string_to_array(realtime.topic(), ':')) = 3
    and split_part(realtime.topic(), ':', 1) = 'live'
    and exists (
      select 1
      from public.live_sessions session_row
      where session_row.id::text = split_part(realtime.topic(), ':', 2)
        and split_part(realtime.topic(), ':', 3) = any(session_row.languages)
        and session_row.host_id = (select auth.uid())::text
        and session_row.status in ('preparing', 'live')
        and session_row.expires_at > now()
    )
  );

create policy live_broadcast_host_send
  on realtime.messages for insert to authenticated
  with check (
    extension = 'broadcast'
    and cardinality(string_to_array(realtime.topic(), ':')) = 3
    and split_part(realtime.topic(), ':', 1) = 'live'
    and exists (
      select 1
      from public.live_sessions session_row
      where session_row.id::text = split_part(realtime.topic(), ':', 2)
        and split_part(realtime.topic(), ':', 3) = any(session_row.languages)
        and session_row.host_id = (select auth.uid())::text
        and session_row.status in ('preparing', 'live')
        and session_row.expires_at > now()
    )
  );

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
  if p_code_hmac !~ '^[0-9a-f]{64}$'
    or p_open_until <= statement_timestamp()
    or p_open_until > statement_timestamp() + interval '5 minutes'
  then
    raise exception using errcode = '22023', message = 'INVALID_ADMISSION_INPUT';
  end if;

  update public.live_sessions
  set admission_code_hmac = p_code_hmac,
      admission_open_until = p_open_until,
      updated_at = statement_timestamp(),
      version = version + 1
  where id = p_session_id
    and host_id = p_host_id
    and status in ('preparing', 'live')
    and expires_at > statement_timestamp();

  if not found then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
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
  update public.live_sessions
  set admission_code_hmac = null,
      admission_open_until = null,
      updated_at = statement_timestamp(),
      version = version + 1
  where id = p_session_id
    and host_id = p_host_id
    and status <> 'stopped';

  if not found then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
end;
$$;

create or replace function public.resolve_live_admission_rate_key(
  p_code_hmac text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_rate_key text;
begin
  if p_code_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
  end if;

  select encode(extensions.digest(session_row.id::text, 'sha256'), 'hex')
  into session_rate_key
  from public.live_sessions session_row
  where session_row.admission_code_hmac = p_code_hmac
    and session_row.admission_open_until > statement_timestamp()
    and session_row.status in ('preparing', 'live')
    and session_row.expires_at > statement_timestamp();

  if session_rate_key is null then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
  end if;
  return session_rate_key;
end;
$$;

create or replace function public.redeem_live_admission(
  p_code_hmac text,
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
  session_row public.live_sessions%rowtype;
  grant_row public.viewer_grants%rowtype;
  active_count integer;
  bounded_expiry timestamptz;
begin
  if p_code_hmac !~ '^[0-9a-f]{64}$'
    or p_user_id is null or length(p_user_id) = 0
    or p_device_hash !~ '^[0-9a-f]{64}$'
    or p_grant_expires_at <= statement_timestamp()
    or p_grant_expires_at > statement_timestamp() + interval '6 hours'
  then
    raise exception using errcode = '22023', message = 'INVALID_ADMISSION_INPUT';
  end if;

  select * into session_row
  from public.live_sessions
  where admission_code_hmac = p_code_hmac
    and admission_open_until > statement_timestamp()
    and status in ('preparing', 'live')
    and expires_at > statement_timestamp()
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
  end if;

  bounded_expiry := least(p_grant_expires_at, session_row.expires_at);

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
  else
    select count(*)::integer into active_count
    from public.viewer_grants
    where viewer_grants.session_id = session_row.id
      and revoked_at is null
      and expires_at > statement_timestamp();

    update public.live_sessions
    set viewer_count = active_count,
        updated_at = statement_timestamp()
    where id = session_row.id;

    update public.live_sessions
    set viewer_count = viewer_count + 1,
        updated_at = statement_timestamp()
    where id = session_row.id
      and viewer_count < 50
    returning public.live_sessions.viewer_count into viewer_count;

    if not found then
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
  end if;

  if viewer_count is null then
    select public.live_sessions.viewer_count into viewer_count
    from public.live_sessions
    where id = session_row.id;
  end if;

  grant_id := grant_row.id;
  session_id := session_row.id;
  user_id := grant_row.user_id;
  grant_expires_at := grant_row.expires_at;
  mode := session_row.mode;
  languages := session_row.languages;
  session_expires_at := session_row.expires_at;
  return next;
end;
$$;

create or replace function public.consume_live_rate_limit(
  p_scope text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_count integer;
  current_time timestamptz := clock_timestamp();
begin
  if p_scope !~ '^[a-z][a-z0-9-]{1,63}$'
    or p_key_hash !~ '^[0-9a-f]{64}$'
    or p_limit < 1 or p_limit > 10000
    or p_window_seconds < 1 or p_window_seconds > 86400
  then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_INPUT';
  end if;

  insert into public.live_rate_limits as bucket (
    scope, key_hash, window_started_at, request_count, updated_at
  ) values (
    p_scope, p_key_hash, current_time, 1, current_time
  )
  on conflict (scope, key_hash) do update
    set request_count = case
          when bucket.window_started_at + make_interval(secs => p_window_seconds) <= current_time then 1
          else bucket.request_count + 1
        end,
        window_started_at = case
          when bucket.window_started_at + make_interval(secs => p_window_seconds) <= current_time then current_time
          else bucket.window_started_at
        end,
        updated_at = current_time
  returning request_count into current_count;

  return current_count <= p_limit;
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
  delete from public.live_rate_limits
  where updated_at < statement_timestamp() - interval '1 day';

  return stopped_count;
end;
$$;

revoke all on function public.open_live_admission(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.close_live_admission(uuid, text) from public, anon, authenticated;
revoke all on function public.resolve_live_admission_rate_key(text) from public, anon, authenticated;
revoke all on function public.redeem_live_admission(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.consume_live_rate_limit(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.terminate_live_session(uuid, text) from public, anon, authenticated;
revoke all on function public.cleanup_expired_live_state() from public, anon, authenticated;

grant execute on function public.open_live_admission(uuid, text, text, timestamptz) to service_role;
grant execute on function public.close_live_admission(uuid, text) to service_role;
grant execute on function public.resolve_live_admission_rate_key(text) to service_role;
grant execute on function public.redeem_live_admission(text, text, text, timestamptz) to service_role;
grant execute on function public.consume_live_rate_limit(text, text, integer, integer) to service_role;
grant execute on function public.terminate_live_session(uuid, text) to service_role;
grant execute on function public.cleanup_expired_live_state() to service_role;
