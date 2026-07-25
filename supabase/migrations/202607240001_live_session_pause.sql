-- 2026-07-24 feat: Add the 'paused' session lifecycle state (contract C4).
-- Pause is a real host-controlled session state between live and stopped:
--   pause_live_session  : live   -> paused (FOR UPDATE, version guarded)
--   resume_live_session : paused -> live  (FOR UPDATE, version guarded)
-- The admission code / QR never rotates across pause (the
-- enforce_stable_live_admission trigger from 202607230004 only clears the
-- admission HMAC on status = 'stopped', so pause preserves it untouched).
-- Invite, admission, join, and viewer-topic paths treat paused sessions as
-- attached: sockets stay open and late guests may still join.

-- 1. Extend the status CHECK constraint (additive, same drop/re-add pattern
--    as 202607230003).
alter table public.live_sessions
  drop constraint live_sessions_status_check,
  add constraint live_sessions_status_check
  check (status in ('preparing', 'live', 'paused', 'stopped', 'failed'));

comment on column public.live_sessions.status is
  'Session lifecycle: preparing -> live <-> paused -> stopped (or failed).';

-- 2. Pause / resume transitions.
create or replace function public.pause_live_session(
  p_session_id uuid,
  p_host_id text,
  p_expected_version integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  next_version integer;
begin
  if p_session_id is null
    or p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_expected_version is null
    or p_expected_version < 1
  then
    raise exception using errcode = '22023', message = 'INVALID_PAUSE_INPUT';
  end if;

  select * into session_row
  from public.live_sessions
  where id = p_session_id
  for update;

  if not found
    or session_row.host_id <> p_host_id
    or session_row.status <> 'live'
    or session_row.version <> p_expected_version
    or session_row.expires_at <= statement_timestamp()
  then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT_OR_FORBIDDEN';
  end if;

  update public.live_sessions
  set status = 'paused',
      updated_at = statement_timestamp(),
      version = version + 1
  where id = p_session_id
  returning version into next_version;
  return next_version;
end;
$$;

create or replace function public.resume_live_session(
  p_session_id uuid,
  p_host_id text,
  p_expected_version integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  next_version integer;
begin
  if p_session_id is null
    or p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_expected_version is null
    or p_expected_version < 1
  then
    raise exception using errcode = '22023', message = 'INVALID_RESUME_INPUT';
  end if;

  select * into session_row
  from public.live_sessions
  where id = p_session_id
  for update;

  if not found
    or session_row.host_id <> p_host_id
    or session_row.status <> 'paused'
    or session_row.version <> p_expected_version
    or session_row.expires_at <= statement_timestamp()
  then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT_OR_FORBIDDEN';
  end if;

  update public.live_sessions
  set status = 'live',
      updated_at = statement_timestamp(),
      version = version + 1
  where id = p_session_id
  returning version into next_version;
  return next_version;
end;
$$;

-- 3. terminate_live_session already terminates from any non-stopped status
--    (it has no status guard), which now includes 'paused'. Re-created
--    verbatim from 202607230003 so this contract is pinned by this migration.
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
      floor_grant_id = null,
      floor_display_name = null,
      floor_taken_at = null,
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

  insert into public.live_recap_grants (session_id, user_id, expires_at, created_at)
  select p_session_id, grant_row.user_id,
    statement_timestamp() + interval '30 days', statement_timestamp()
  from public.viewer_grants grant_row
  where grant_row.session_id = p_session_id
  on conflict (session_id, user_id) do update
    set expires_at = excluded.expires_at,
        created_at = excluded.created_at;

  delete from public.viewer_grants where session_id = p_session_id;
  delete from public.live_snapshots where session_id = p_session_id;
  delete from public.session_speakers where session_id = p_session_id;
  return true;
end;
$$;

-- 4. Admission / invite / join / viewer-topic paths stay valid while paused,
--    so the code and QR remain usable and viewer sockets stay attached.
create or replace function public.open_live_admission(
  p_session_id uuid,
  p_host_id text,
  p_code_hmac text,
  p_open_until timestamptz,
  p_expected_version integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  next_version integer;
begin
  if p_session_id is null
    or p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_code_hmac is null
    or p_code_hmac !~ '^[0-9a-f]{64}$'
    or p_open_until is null
    or p_open_until <= statement_timestamp()
    or p_expected_version is null
    or p_expected_version < 1
  then
    raise exception using errcode = '22023', message = 'INVALID_ADMISSION_INPUT';
  end if;

  select * into session_row
  from public.live_sessions
  where id = p_session_id
  for update;

  if not found
    or session_row.host_id <> p_host_id
    or session_row.status not in ('preparing', 'live', 'paused')
    or session_row.expires_at <= statement_timestamp()
    or p_open_until > session_row.expires_at
  then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT_OR_FORBIDDEN';
  end if;
  if session_row.version <> p_expected_version then
    if session_row.admission_code_hmac = p_code_hmac
      and session_row.admission_state = 'open'
    then
      return session_row.version;
    end if;
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT_OR_FORBIDDEN';
  end if;
  if session_row.admission_code_hmac is not null
    and session_row.admission_code_hmac <> p_code_hmac
  then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CODE_IMMUTABLE';
  end if;

  update public.live_sessions
  set admission_code_hmac = p_code_hmac,
      admission_open_until = session_row.expires_at,
      admission_state = 'open',
      updated_at = statement_timestamp(),
      version = version + 1
  where id = p_session_id
  returning version into next_version;
  return next_version;
end;
$$;

create or replace function public.close_live_admission(
  p_session_id uuid,
  p_host_id text,
  p_expected_version integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_version integer;
begin
  if p_session_id is null
    or p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_expected_version is null
    or p_expected_version < 1
  then
    raise exception using errcode = '22023', message = 'INVALID_ADMISSION_INPUT';
  end if;

  update public.live_sessions as session_row
  set admission_state = case
        when session_row.admission_code_hmac is null then 'uninitialized'
        else 'paused'
      end,
      updated_at = statement_timestamp(),
      version = session_row.version + 1
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.version = p_expected_version
    and session_row.status in ('preparing', 'live', 'paused')
    and session_row.expires_at > statement_timestamp()
  returning session_row.version into next_version;

  if next_version is null then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT_OR_FORBIDDEN';
  end if;
  return next_version;
end;
$$;

create or replace function public.create_live_invite(
  p_session_id uuid,
  p_host_id text,
  p_token_hmac text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
begin
  if p_session_id is null
    or p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_token_hmac is null
    or p_token_hmac !~ '^[0-9a-f]{64}$'
    or p_expires_at is null
    or p_expires_at <= statement_timestamp()
  then
    raise exception using errcode = '22023', message = 'INVALID_INVITE_INPUT';
  end if;

  select * into session_row
  from public.live_sessions
  where id = p_session_id
  for update;

  if not found
    or session_row.host_id <> p_host_id
    or session_row.status not in ('preparing', 'live', 'paused')
    or session_row.expires_at <= statement_timestamp()
    or p_expires_at > session_row.expires_at
  then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
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

create or replace function public.lock_live_invite_session(p_token_hmac text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate_session_id uuid;
  session_row public.live_sessions%rowtype;
  invite_row public.live_session_invites%rowtype;
begin
  if p_token_hmac is null or p_token_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'INVITE_CLOSED';
  end if;

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
    or session_row.status not in ('preparing', 'live', 'paused')
    or session_row.expires_at <= statement_timestamp()
    or not public.live_languages_canonical(session_row.languages)
  then
    raise exception using errcode = 'P0001', message = 'INVITE_CLOSED';
  end if;
  return session_row.id;
end;
$$;

create or replace function public.resolve_live_invite_rate_key(p_token_hmac text)
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
    and session_row.status in ('preparing', 'live', 'paused')
    and session_row.expires_at > statement_timestamp();

  if session_rate_key is null then
    raise exception using errcode = 'P0001', message = 'INVITE_CLOSED';
  end if;
  return session_rate_key;
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
    and session_row.status in ('preparing', 'live', 'paused')
    and session_row.expires_at > statement_timestamp();

  if session_rate_key is null then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
  end if;
  return session_rate_key;
end;
$$;

create or replace function public.redeem_live_admission_v3(
  p_code_hmac text,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_display_name text,
  p_department text,
  p_job_title text
)
returns table (
  grant_id uuid,
  session_id uuid,
  user_id text,
  grant_expires_at timestamptz,
  session_type text,
  output_mode text,
  languages text[],
  session_expires_at timestamptz,
  viewer_count integer,
  max_viewers integer,
  glossary_pack text,
  display_name text,
  department text,
  job_title text,
  participant_id uuid,
  voice_provider text,
  status text,
  title text,
  scheduled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
  grant_result record;
begin
  if p_code_hmac is null or p_code_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_ADMISSION_INPUT';
  end if;
  select * into session_row
  from public.live_sessions
  where admission_code_hmac = p_code_hmac
  for update;
  if not found
    or session_row.admission_state <> 'open'
    or session_row.admission_open_until <= statement_timestamp()
    or session_row.status not in ('preparing', 'live', 'paused')
    or session_row.expires_at <= statement_timestamp()
  then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
  end if;

  select * into grant_result
  from public.apply_live_viewer_grant(
    session_row.id, p_user_id, p_device_hash, p_grant_expires_at,
    p_display_name, p_department, p_job_title
  );

  grant_id := grant_result.grant_id;
  session_id := session_row.id;
  user_id := grant_result.grant_user_id;
  grant_expires_at := grant_result.grant_expires_at;
  session_type := session_row.session_type;
  output_mode := session_row.output_mode;
  languages := session_row.languages;
  session_expires_at := session_row.expires_at;
  viewer_count := grant_result.resolved_viewer_count;
  max_viewers := session_row.max_viewers;
  glossary_pack := session_row.glossary_pack;
  display_name := grant_result.resolved_display_name;
  department := grant_result.resolved_department;
  job_title := grant_result.resolved_job_title;
  participant_id := grant_result.participant_id;
  voice_provider := session_row.voice_provider;
  status := session_row.status;
  title := session_row.title;
  scheduled_at := session_row.scheduled_at;
  return next;
end;
$$;

-- lock_live_invite_session above already admits paused sessions, which
-- carries redeem_live_invite_v3 (it delegates its status gate to the lock).

create or replace function public.authorize_live_viewer_topic(
  p_session_id uuid,
  p_grant_id uuid,
  p_user_id text,
  p_language text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_session_id is not null
    and p_grant_id is not null
    and p_user_id is not null
    and length(p_user_id) between 1 and 256
    and p_language is not null
    and public.live_language_valid(p_language)
    and exists (
      select 1
      from public.live_sessions session_row
      join public.viewer_grants grant_row
        on grant_row.session_id = session_row.id
      where session_row.id = p_session_id
        and session_row.status in ('live', 'paused')
        and session_row.expires_at > statement_timestamp()
        and public.live_languages_canonical(session_row.languages)
        and p_language = any(session_row.languages)
        and grant_row.id = p_grant_id
        and grant_row.user_id = p_user_id
        and grant_row.revoked_at is null
        and grant_row.expires_at > statement_timestamp()
    );
$$;

-- 5. Realtime broadcast policies: viewers keep receiving session-status
--    events while paused; hosts keep their preparing/live/paused channels.
alter policy live_broadcast_viewer_receive on realtime.messages
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
        and session_row.status in ('live', 'paused')
        and session_row.expires_at > now()
        and grant_row.user_id = (select auth.uid())::text
        and grant_row.revoked_at is null
        and grant_row.expires_at > now()
    )
  );

alter policy live_broadcast_host_receive on realtime.messages
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
        and session_row.status in ('preparing', 'live', 'paused')
        and session_row.expires_at > now()
    )
  );

alter policy live_broadcast_host_send on realtime.messages
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
        and session_row.status in ('preparing', 'live', 'paused')
        and session_row.expires_at > now()
    )
  );

-- 6. Function privileges (security definer + revoke pattern).
revoke all on function public.pause_live_session(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.resume_live_session(uuid, text, integer)
  from public, anon, authenticated;

grant execute on function public.pause_live_session(uuid, text, integer)
  to service_role;
grant execute on function public.resume_live_session(uuid, text, integer)
  to service_role;

-- Development verification (run only after applying to a linked dev project):
--   select public.pause_live_session(gen_random_uuid(), 'missing-host', 1);
--     -> VERSION_CONFLICT_OR_FORBIDDEN
--   select public.resume_live_session(gen_random_uuid(), 'missing-host', 1);
--     -> VERSION_CONFLICT_OR_FORBIDDEN
--   Pausing a live session must keep admission_code_hmac, admission_state,
--   and admission_open_until unchanged (enforce_stable_live_admission).
