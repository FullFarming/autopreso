-- Realtime Noel — fresh-project bootstrap for ganiabssgqcycnchshpz
-- Concatenation of supabase/migrations/*.sql in filename (apply) order.
-- Run ONCE on the empty project (Supabase SQL Editor). Hosted 'realtime' schema must exist.

-- ===================================================================
-- supabase/migrations/202607190001_live_sessions.sql
-- ===================================================================
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

-- ===================================================================
-- supabase/migrations/202607190002_live_voice_output.sql
-- ===================================================================
-- 2026-07-19 feat: Persist only session-scoped voice output decisions.
-- Acoustic measurements, PCM, embeddings, and biometric voice features remain
-- ephemeral in the media gateway and are intentionally absent from this schema.

alter table public.live_sessions
  add column voice_output_mode text;

-- 2026-07-19 fix: preserve the behavior that existed before this setting.
-- Presentation and Meeting emitted captions, while Townhall emitted fixed
-- synthetic voices. A single default would silently change existing sessions.
update public.live_sessions
set voice_output_mode = case
  when mode = 'townhall' then 'fixed_voice'
  else 'captions'
end;

alter table public.live_sessions
  alter column voice_output_mode set default 'captions',
  alter column voice_output_mode set not null;

alter table public.live_sessions
  add constraint live_sessions_voice_output_mode_check
  check (voice_output_mode in ('captions', 'fixed_voice', 'auto_voice')),
  add constraint live_sessions_voice_output_mode_mode_check
  check (mode = 'townhall' or voice_output_mode = 'captions');

comment on column public.live_sessions.voice_output_mode is
  'Session output policy only; never stores source audio or biometric voice features.';

alter table public.session_speakers
  add column voice_status text;

-- Existing Townhall speakers already have a fixed voice. Reflect that state
-- without persisting the acoustic range that selected future automatic voices.
update public.session_speakers
set voice_status = case
  when voice_name is not null then 'ready'
  else 'disabled'
end;

alter table public.session_speakers
  alter column voice_status set default 'disabled',
  alter column voice_status set not null;

alter table public.session_speakers
  add constraint session_speakers_voice_status_check
  check (voice_status in ('disabled', 'analyzing', 'ready', 'unavailable')),
  add constraint session_speakers_ready_voice_check
  check (voice_status <> 'ready' or voice_name is not null);

comment on column public.session_speakers.voice_status is
  'Non-biometric readiness only; acoustic measurements remain gateway-memory-only.';

-- live_sessions uses column-level grants, so expose only the new public session
-- setting. Existing RLS policies continue to restrict rows to the host or a
-- viewer with a current grant.
grant select (voice_output_mode) on public.live_sessions to authenticated;

-- This migration must run after 202607190001_live_sessions.sql, which created
-- these policies. Live JSON and PCM now travel only through the authenticated
-- media gateway, so database Broadcast access is no longer part of the product.
drop policy if exists live_broadcast_viewer_receive on realtime.messages;
drop policy if exists live_broadcast_host_receive on realtime.messages;
drop policy if exists live_broadcast_host_send on realtime.messages;

create or replace function public.persist_live_snapshot_if_active(
  p_session_id uuid,
  p_language text,
  p_event jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_status text;
  session_mode text;
  session_voice_output_mode text;
  session_languages text[];
  event_seq bigint;
  sanitized_speaker jsonb;
  sanitized_event jsonb;
  source_ended_at timestamptz;
  emitted_at timestamptz;
  speaker_last_seen_at timestamptz;
begin
  select
    session_row.status,
    session_row.mode,
    session_row.voice_output_mode,
    session_row.languages
  into
    session_status,
    session_mode,
    session_voice_output_mode,
    session_languages
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.expires_at > statement_timestamp()
  for update;

  if not found
    or session_status <> 'live'
    or p_language is null
    or not (p_language = any(session_languages))
  then
    return false;
  end if;

  if p_event is null
    or jsonb_typeof(p_event) <> 'object'
    or octet_length(p_event::text) > 32768
    or not (p_event ?& array[
      'type', 'seq', 'sessionId', 'language', 'speaker', 'text',
      'isFinal', 'sourceEndedAt', 'emittedAt'
    ])
    or (p_event - array[
      'type', 'seq', 'sessionId', 'language', 'speaker', 'text',
      'isFinal', 'sourceEndedAt', 'emittedAt'
    ]::text[]) <> '{}'::jsonb
    or jsonb_typeof(p_event -> 'type') <> 'string'
    or p_event ->> 'type' <> 'caption'
    or jsonb_typeof(p_event -> 'seq') <> 'number'
    or (p_event ->> 'seq') !~ '^[0-9]{1,19}$'
    or jsonb_typeof(p_event -> 'sessionId') <> 'string'
    or p_event ->> 'sessionId' <> p_session_id::text
    or jsonb_typeof(p_event -> 'language') <> 'string'
    or p_event ->> 'language' <> p_language
    or jsonb_typeof(p_event -> 'text') <> 'string'
    or length(btrim(p_event ->> 'text')) not between 1 and 8000
    or octet_length(p_event ->> 'text') > 24000
    or p_event -> 'isFinal' <> 'true'::jsonb
    or jsonb_typeof(p_event -> 'sourceEndedAt') <> 'string'
    or (p_event ->> 'sourceEndedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
    or jsonb_typeof(p_event -> 'emittedAt') <> 'string'
    or (p_event ->> 'emittedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
  then
    return false;
  end if;

  if (p_event ->> 'seq')::numeric > 9223372036854775807 then
    return false;
  end if;
  event_seq := (p_event ->> 'seq')::bigint;
  if event_seq < 1 then
    return false;
  end if;

  begin
    source_ended_at := (p_event ->> 'sourceEndedAt')::timestamptz;
    emitted_at := (p_event ->> 'emittedAt')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    return false;
  end;
  if source_ended_at is null or emitted_at is null then
    return false;
  end if;

  if p_event -> 'speaker' = 'null'::jsonb then
    sanitized_speaker := 'null'::jsonb;
  else
    if jsonb_typeof(p_event -> 'speaker') <> 'object'
      or not ((p_event -> 'speaker') ?& array[
        'speakerId', 'label', 'colorToken', 'voiceName', 'voiceStatus', 'lastSeenAt'
      ])
      or ((p_event -> 'speaker') - array[
        'speakerId', 'label', 'colorToken', 'voiceName', 'voiceStatus', 'lastSeenAt'
      ]::text[]) <> '{}'::jsonb
      or jsonb_typeof(p_event -> 'speaker' -> 'speakerId') <> 'string'
      or (p_event -> 'speaker' ->> 'speakerId') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      or jsonb_typeof(p_event -> 'speaker' -> 'label') <> 'string'
      or length(btrim(p_event -> 'speaker' ->> 'label')) not between 1 and 80
      or octet_length(p_event -> 'speaker' ->> 'label') > 240
      or jsonb_typeof(p_event -> 'speaker' -> 'colorToken') <> 'string'
      or p_event -> 'speaker' ->> 'colorToken' not in (
        'speaker-blue', 'speaker-red', 'speaker-green',
        'speaker-purple', 'speaker-orange', 'speaker-teal'
      )
      or jsonb_typeof(p_event -> 'speaker' -> 'voiceStatus') <> 'string'
      or p_event -> 'speaker' ->> 'voiceStatus' not in (
        'disabled', 'analyzing', 'ready', 'unavailable'
      )
      or jsonb_typeof(p_event -> 'speaker' -> 'voiceName') not in ('string', 'null')
      or (
        jsonb_typeof(p_event -> 'speaker' -> 'voiceName') = 'string'
        and (p_event -> 'speaker' ->> 'voiceName') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      )
      or (
        p_event -> 'speaker' ->> 'voiceStatus' = 'ready'
        and jsonb_typeof(p_event -> 'speaker' -> 'voiceName') <> 'string'
      )
      or jsonb_typeof(p_event -> 'speaker' -> 'lastSeenAt') <> 'string'
      or (p_event -> 'speaker' ->> 'lastSeenAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
    then
      return false;
    end if;

    begin
      speaker_last_seen_at := (p_event -> 'speaker' ->> 'lastSeenAt')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      return false;
    end;
    if speaker_last_seen_at is null then
      return false;
    end if;

    if (session_mode <> 'townhall' or session_voice_output_mode = 'captions')
      and (
        p_event -> 'speaker' ->> 'voiceStatus' <> 'disabled'
        or p_event -> 'speaker' -> 'voiceName' <> 'null'::jsonb
      )
    then
      return false;
    end if;

    if session_mode = 'townhall' and session_voice_output_mode = 'fixed_voice'
      and (
        p_event -> 'speaker' ->> 'voiceStatus' <> 'ready'
        or jsonb_typeof(p_event -> 'speaker' -> 'voiceName') <> 'string'
      )
    then
      return false;
    end if;

    if session_mode = 'townhall' and session_voice_output_mode = 'auto_voice'
      and (
        p_event -> 'speaker' ->> 'voiceStatus' = 'disabled'
        or (
          p_event -> 'speaker' ->> 'voiceStatus' = 'ready'
          and jsonb_typeof(p_event -> 'speaker' -> 'voiceName') <> 'string'
        )
        or (
          p_event -> 'speaker' ->> 'voiceStatus' in ('analyzing', 'unavailable')
          and p_event -> 'speaker' -> 'voiceName' <> 'null'::jsonb
        )
      )
    then
      return false;
    end if;

    sanitized_speaker := jsonb_build_object(
      'speakerId', p_event -> 'speaker' ->> 'speakerId',
      'label', btrim(p_event -> 'speaker' ->> 'label'),
      'colorToken', p_event -> 'speaker' ->> 'colorToken',
      'voiceName', p_event -> 'speaker' -> 'voiceName',
      'voiceStatus', p_event -> 'speaker' ->> 'voiceStatus',
      'lastSeenAt', p_event -> 'speaker' ->> 'lastSeenAt'
    );
  end if;

  sanitized_event := jsonb_build_object(
    'type', 'caption',
    'seq', event_seq,
    'sessionId', p_session_id::text,
    'language', p_language,
    'speaker', sanitized_speaker,
    'text', btrim(p_event ->> 'text'),
    'isFinal', true,
    'sourceEndedAt', p_event ->> 'sourceEndedAt',
    'emittedAt', p_event ->> 'emittedAt'
  );

  insert into public.live_snapshots (
    session_id, language, last_seq, captions, speaker_legend, updated_at
  ) values (
    p_session_id, p_language, event_seq, jsonb_build_array(sanitized_event),
    '[]'::jsonb, statement_timestamp()
  )
  on conflict (session_id, language) do update
    set last_seq = excluded.last_seq,
        captions = excluded.captions,
        updated_at = statement_timestamp()
    where public.live_snapshots.last_seq < excluded.last_seq;

  return true;
exception
  when check_violation or unique_violation or invalid_text_representation then
    return false;
end;
$$;

create or replace function public.persist_session_speakers_if_active(
  p_session_id uuid,
  p_language text,
  p_speakers jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_status text;
  session_mode text;
  session_voice_output_mode text;
  session_languages text[];
  speaker_value jsonb;
  sanitized_speaker jsonb;
  sanitized_speakers jsonb := '[]'::jsonb;
  speaker_last_seen_at timestamptz;
begin
  select
    session_row.status,
    session_row.mode,
    session_row.voice_output_mode,
    session_row.languages
  into
    session_status,
    session_mode,
    session_voice_output_mode,
    session_languages
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.expires_at > statement_timestamp()
  for update;

  if not found
    or session_status <> 'live'
    or p_language is null
    or not (p_language = any(session_languages))
  then
    return false;
  end if;

  if p_speakers is null
    or jsonb_typeof(p_speakers) <> 'array'
    or jsonb_array_length(p_speakers) > 6
    or octet_length(p_speakers::text) > 16384
  then
    return false;
  end if;

  for speaker_value in
    select speaker_item.value
    from jsonb_array_elements(p_speakers) as speaker_item(value)
  loop
    if jsonb_typeof(speaker_value) <> 'object'
      or not (speaker_value ?& array[
        'speakerId', 'label', 'colorToken', 'voiceName', 'voiceStatus', 'lastSeenAt'
      ])
      or (speaker_value - array[
        'speakerId', 'label', 'colorToken', 'voiceName', 'voiceStatus', 'lastSeenAt'
      ]::text[]) <> '{}'::jsonb
      or jsonb_typeof(speaker_value -> 'speakerId') <> 'string'
      or (speaker_value ->> 'speakerId') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      or jsonb_typeof(speaker_value -> 'label') <> 'string'
      or length(btrim(speaker_value ->> 'label')) not between 1 and 80
      or octet_length(speaker_value ->> 'label') > 240
      or jsonb_typeof(speaker_value -> 'colorToken') <> 'string'
      or speaker_value ->> 'colorToken' not in (
        'speaker-blue', 'speaker-red', 'speaker-green',
        'speaker-purple', 'speaker-orange', 'speaker-teal'
      )
      or jsonb_typeof(speaker_value -> 'voiceName') not in ('string', 'null')
      or (
        jsonb_typeof(speaker_value -> 'voiceName') = 'string'
        and (speaker_value ->> 'voiceName') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      )
      or jsonb_typeof(speaker_value -> 'voiceStatus') <> 'string'
      or speaker_value ->> 'voiceStatus' not in (
        'disabled', 'analyzing', 'ready', 'unavailable'
      )
      or jsonb_typeof(speaker_value -> 'lastSeenAt') <> 'string'
      or (speaker_value ->> 'lastSeenAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
    then
      return false;
    end if;

    if (session_mode <> 'townhall' or session_voice_output_mode = 'captions')
      and (
        speaker_value ->> 'voiceStatus' <> 'disabled'
        or speaker_value -> 'voiceName' <> 'null'::jsonb
      )
    then
      return false;
    end if;

    if session_mode = 'townhall' and session_voice_output_mode = 'fixed_voice'
      and (
        speaker_value ->> 'voiceStatus' <> 'ready'
        or jsonb_typeof(speaker_value -> 'voiceName') <> 'string'
      )
    then
      return false;
    end if;

    if session_mode = 'townhall' and session_voice_output_mode = 'auto_voice'
      and (
        speaker_value ->> 'voiceStatus' = 'disabled'
        or (
          speaker_value ->> 'voiceStatus' = 'ready'
          and jsonb_typeof(speaker_value -> 'voiceName') <> 'string'
        )
        or (
          speaker_value ->> 'voiceStatus' in ('analyzing', 'unavailable')
          and speaker_value -> 'voiceName' <> 'null'::jsonb
        )
      )
    then
      return false;
    end if;

    begin
      speaker_last_seen_at := (speaker_value ->> 'lastSeenAt')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      return false;
    end;
    if speaker_last_seen_at is null then
      return false;
    end if;

    sanitized_speaker := jsonb_build_object(
      'speakerId', speaker_value ->> 'speakerId',
      'label', btrim(speaker_value ->> 'label'),
      'colorToken', speaker_value ->> 'colorToken',
      'voiceName', speaker_value -> 'voiceName',
      'voiceStatus', speaker_value ->> 'voiceStatus',
      'lastSeenAt', speaker_value ->> 'lastSeenAt'
    );
    sanitized_speakers := sanitized_speakers || jsonb_build_array(sanitized_speaker);
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(sanitized_speakers) as speaker_item(value)
    group by speaker_item.value ->> 'speakerId'
    having count(*) > 1
  ) or exists (
    select 1
    from jsonb_array_elements(sanitized_speakers) as speaker_item(value)
    group by speaker_item.value ->> 'colorToken'
    having count(*) > 1
  ) or exists (
    select 1
    from jsonb_array_elements(sanitized_speakers) as speaker_item(value)
    where speaker_item.value -> 'voiceName' <> 'null'::jsonb
    group by speaker_item.value ->> 'voiceName'
    having count(*) > 1
  ) then
    return false;
  end if;

  for speaker_value in
    select speaker_item.value
    from jsonb_array_elements(sanitized_speakers) as speaker_item(value)
  loop
    insert into public.session_speakers (
      session_id, speaker_id, label, color_token, voice_name, voice_status, last_seen_at
    ) values (
      p_session_id,
      speaker_value ->> 'speakerId',
      speaker_value ->> 'label',
      speaker_value ->> 'colorToken',
      case
        when speaker_value -> 'voiceName' = 'null'::jsonb then null
        else speaker_value ->> 'voiceName'
      end,
      speaker_value ->> 'voiceStatus',
      (speaker_value ->> 'lastSeenAt')::timestamptz
    )
    on conflict (session_id, speaker_id) do update
      set label = excluded.label,
          color_token = excluded.color_token,
          voice_name = excluded.voice_name,
          voice_status = excluded.voice_status,
          last_seen_at = greatest(public.session_speakers.last_seen_at, excluded.last_seen_at);
  end loop;

  delete from public.session_speakers speaker_row
  where speaker_row.session_id = p_session_id
    and not exists (
      select 1
      from jsonb_array_elements(sanitized_speakers) as current_speaker(value)
      where current_speaker.value ->> 'speakerId' = speaker_row.speaker_id
    );

  insert into public.live_snapshots (
    session_id, language, last_seq, captions, speaker_legend, updated_at
  ) values (
    p_session_id, p_language, 0, '[]'::jsonb, sanitized_speakers, statement_timestamp()
  )
  on conflict (session_id, language) do update
    set speaker_legend = excluded.speaker_legend,
        updated_at = statement_timestamp();

  return true;
exception
  when check_violation or unique_violation or invalid_text_representation then
    return false;
end;
$$;

create or replace function public.verify_live_cleanup_schedule()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  has_active_cleanup_job boolean := false;
begin
  if to_regclass('cron.job') is null then
    return false;
  end if;

  -- cron.job is optional in development. Constant dynamic SQL prevents a
  -- missing pg_cron relation from breaking migration or function creation.
  execute $query$
    select exists (
      select 1
      from cron.job job_row
      where job_row.active is true
        and btrim(job_row.command) ~* '^(select[[:space:]]+)?(public[.])?cleanup_expired_live_state[[:space:]]*[(][[:space:]]*[)][[:space:]]*;?$'
    )
  $query$
  into has_active_cleanup_job;

  return has_active_cleanup_job;
exception
  when undefined_table or undefined_column or insufficient_privilege then
    return false;
end;
$$;

revoke all on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.persist_session_speakers_if_active(uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.verify_live_cleanup_schedule()
  from public, anon, authenticated;
-- Keep service_role reads for snapshots, but make these SECURITY DEFINER
-- functions (plus the existing termination/cleanup functions) the only writes.
revoke insert, update, delete on public.live_snapshots, public.session_speakers
  from service_role;
grant execute on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  to service_role;
grant execute on function public.persist_session_speakers_if_active(uuid, text, jsonb)
  to service_role;
grant execute on function public.verify_live_cleanup_schedule()
  to service_role;

-- ===================================================================
-- supabase/migrations/202607200001_live_session_invites.sql
-- ===================================================================
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

-- ===================================================================
-- supabase/migrations/20260720040743_live_session_configuration.sql
-- ===================================================================
-- 2026-07-20 feat: Add the canonical live session configuration contract.
-- Legacy mode and voice_output_mode remain populated for one compatibility
-- cycle, while new callers use session_type and output_mode exclusively.

alter table public.live_sessions
  add column session_type text,
  add column output_mode text,
  add column max_viewers integer not null default 50,
  add column glossary_pack text not null default 'general_cre';

update public.live_sessions
set session_type = case
      when mode = 'presentation' then 'presentation'
      else 'meeting'
    end,
    output_mode = case
      when voice_output_mode = 'captions' then 'captions'
      else 'audio'
    end;

alter table public.live_sessions
  alter column session_type set not null,
  alter column output_mode set not null,
  add constraint live_sessions_session_type_check
    check (session_type in ('presentation', 'meeting')),
  add constraint live_sessions_output_mode_check
    check (output_mode in ('captions', 'captions_audio', 'audio')),
  add constraint live_sessions_max_viewers_check
    check (max_viewers between 1 and 50),
  add constraint live_sessions_viewer_capacity_check
    check (viewer_count <= max_viewers),
  add constraint live_sessions_glossary_pack_check
    check (glossary_pack in ('general_cre', 'hotel', 'fnb'));

comment on column public.live_sessions.mode is
  '@deprecated Read compatibility only; use session_type and output_mode.';
comment on column public.live_sessions.voice_output_mode is
  '@deprecated Read compatibility only; use output_mode.';
comment on column public.live_sessions.session_type is
  'Canonical session type: presentation or meeting.';
comment on column public.live_sessions.output_mode is
  'Canonical viewer output: captions, captions_audio, or audio.';

alter table public.viewer_grants
  add column display_name text;

alter table public.viewer_grants
  add constraint viewer_grants_display_name_check
  check (
    display_name is null
    or (
      char_length(display_name) between 1 and 40
      and display_name = normalize(btrim(display_name), NFC)
      and display_name !~ '[[:cntrl:]]'
      and display_name !~ '[<>]'
    )
  );

comment on column public.viewer_grants.display_name is
  'Session-scoped NFC-normalized viewer label; null is retained only for legacy grants.';

create or replace function public.sync_live_session_compatibility()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  canonical_changed boolean;
  legacy_changed boolean;
begin
  if tg_op = 'INSERT' then
    if new.session_type is null and new.output_mode is null then
      new.session_type := case when new.mode = 'presentation' then 'presentation' else 'meeting' end;
      new.output_mode := case when new.voice_output_mode = 'captions' then 'captions' else 'audio' end;
      return new;
    end if;

    if new.session_type is null or new.output_mode is null then
      raise exception using errcode = '23514', message = 'INCOMPLETE_CANONICAL_LIVE_CONFIGURATION';
    end if;

    new.mode := case
      when new.output_mode = 'captions' then new.session_type
      else 'townhall'
    end;
    new.voice_output_mode := case
      when new.output_mode = 'captions' then 'captions'
      else 'auto_voice'
    end;
    return new;
  end if;

  canonical_changed := new.session_type is distinct from old.session_type
    or new.output_mode is distinct from old.output_mode;
  legacy_changed := new.mode is distinct from old.mode
    or new.voice_output_mode is distinct from old.voice_output_mode;

  if canonical_changed then
    if new.session_type is null or new.output_mode is null then
      raise exception using errcode = '23514', message = 'INCOMPLETE_CANONICAL_LIVE_CONFIGURATION';
    end if;
    new.mode := case
      when new.output_mode = 'captions' then new.session_type
      else 'townhall'
    end;
    new.voice_output_mode := case
      when new.output_mode = 'captions' then 'captions'
      else 'auto_voice'
    end;
  elsif legacy_changed then
    new.session_type := case when new.mode = 'presentation' then 'presentation' else 'meeting' end;
    new.output_mode := case when new.voice_output_mode = 'captions' then 'captions' else 'audio' end;
  end if;

  return new;
end;
$$;

create trigger live_sessions_compatibility_before_write
before insert or update of session_type, output_mode, mode, voice_output_mode
on public.live_sessions
for each row execute function public.sync_live_session_compatibility();

create or replace function public.lock_live_admission_session(
  p_code_hmac text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_session_id uuid;
begin
  if p_code_hmac is null or p_code_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
  end if;

  select session_row.id into resolved_session_id
  from public.live_sessions session_row
  where session_row.admission_code_hmac = p_code_hmac
    and session_row.admission_open_until > statement_timestamp()
    and session_row.status in ('preparing', 'live')
    and session_row.expires_at > statement_timestamp()
  for update;

  if resolved_session_id is null then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
  end if;
  return resolved_session_id;
end;
$$;

create or replace function public.lock_live_invite_session(
  p_token_hmac text
)
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
    or session_row.admission_open_until is null
    or session_row.admission_open_until <= statement_timestamp()
    or session_row.status not in ('preparing', 'live')
    or session_row.expires_at <= statement_timestamp()
  then
    raise exception using errcode = 'P0001', message = 'INVITE_CLOSED';
  end if;

  return session_row.id;
end;
$$;

create or replace function public.apply_live_viewer_grant(
  p_session_id uuid,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_display_name text
)
returns table (
  grant_id uuid,
  grant_user_id text,
  grant_expires_at timestamptz,
  resolved_viewer_count integer,
  resolved_display_name text
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
  normalized_display_name text;
begin
  if p_user_id is null
    or length(p_user_id) not between 1 and 256
    or p_device_hash is null
    or p_device_hash !~ '^[0-9a-f]{64}$'
    or p_grant_expires_at is null
    or p_grant_expires_at <= statement_timestamp()
    or p_grant_expires_at > statement_timestamp() + interval '6 hours'
  then
    raise exception using errcode = '22023', message = 'INVALID_JOIN_INPUT';
  end if;

  if p_display_name is not null then
    normalized_display_name := normalize(btrim(p_display_name), NFC);
    if char_length(normalized_display_name) not between 1 and 40
      or normalized_display_name ~ '[[:cntrl:]]'
      or normalized_display_name ~ '[<>]'
    then
      raise exception using errcode = '22023', message = 'INVALID_DISPLAY_NAME';
    end if;
  end if;

  select * into session_row
  from public.live_sessions
  where id = p_session_id
    and status in ('preparing', 'live')
    and expires_at > statement_timestamp()
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
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
        expires_at = greatest(expires_at, bounded_expiry),
        display_name = coalesce(normalized_display_name, display_name)
    where id = grant_row.id
    returning * into grant_row;
    resolved_viewer_count := active_count;
  else
    if active_count >= session_row.max_viewers then
      raise exception using errcode = 'P0001', message = 'VIEWER_LIMIT_REACHED';
    end if;

    insert into public.viewer_grants (
      session_id, user_id, device_hash, expires_at, revoked_at, last_joined_at, display_name
    ) values (
      session_row.id, p_user_id, p_device_hash, bounded_expiry, null,
      statement_timestamp(), normalized_display_name
    )
    on conflict (session_id, user_id, device_hash) do update
      set expires_at = excluded.expires_at,
          revoked_at = null,
          last_joined_at = statement_timestamp(),
          display_name = coalesce(excluded.display_name, viewer_grants.display_name)
    returning * into grant_row;
    resolved_viewer_count := active_count + 1;
  end if;

  update public.live_sessions
  set viewer_count = resolved_viewer_count,
      updated_at = statement_timestamp()
  where id = session_row.id;

  grant_id := grant_row.id;
  grant_user_id := grant_row.user_id;
  grant_expires_at := grant_row.expires_at;
  resolved_display_name := grant_row.display_name;
  return next;
end;
$$;

create or replace function public.create_live_session(
  p_session_id uuid,
  p_host_id text,
  p_session_type text,
  p_output_mode text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text,
  p_expires_at timestamptz
)
returns table (
  id uuid,
  host_id text,
  session_type text,
  output_mode text,
  status text,
  languages text[],
  viewer_count integer,
  max_viewers integer,
  version integer,
  glossary_pack text,
  admission_open_until timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_session_id is null
    or p_host_id is null
    or length(p_host_id) not between 1 and 256
    or p_session_type is null
    or p_session_type not in ('presentation', 'meeting')
    or p_output_mode is null
    or p_output_mode not in ('captions', 'captions_audio', 'audio')
    or p_languages is null
    or not public.live_languages_valid(p_languages)
    or p_max_viewers is null
    or p_max_viewers not between 1 and 50
    or p_glossary_pack is null
    or p_glossary_pack not in ('general_cre', 'hotel', 'fnb')
    or p_expires_at is null
    or p_expires_at <= statement_timestamp()
    or p_expires_at > statement_timestamp() + interval '6 hours'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_INPUT';
  end if;

  return query
  insert into public.live_sessions as created_session (
    id, host_id, mode, voice_output_mode, session_type, output_mode, status,
    languages, viewer_count, max_viewers, version, glossary_pack, expires_at,
    created_at, updated_at
  ) values (
    p_session_id,
    p_host_id,
    case when p_output_mode = 'captions' then p_session_type else 'townhall' end,
    case when p_output_mode = 'captions' then 'captions' else 'auto_voice' end,
    p_session_type,
    p_output_mode,
    'preparing',
    p_languages,
    0,
    p_max_viewers,
    1,
    p_glossary_pack,
    p_expires_at,
    statement_timestamp(),
    statement_timestamp()
  )
  returning
    created_session.id,
    created_session.host_id,
    created_session.session_type,
    created_session.output_mode,
    created_session.status,
    created_session.languages,
    created_session.viewer_count,
    created_session.max_viewers,
    created_session.version,
    created_session.glossary_pack,
    created_session.admission_open_until,
    created_session.expires_at;
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'LIVE_SESSION_CONFLICT';
end;
$$;

create or replace function public.update_live_session(
  p_session_id uuid,
  p_host_id text,
  p_expected_version integer,
  p_session_type text,
  p_output_mode text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text
)
returns table (
  id uuid,
  host_id text,
  session_type text,
  output_mode text,
  status text,
  languages text[],
  viewer_count integer,
  max_viewers integer,
  version integer,
  glossary_pack text,
  admission_open_until timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  updated_session public.live_sessions%rowtype;
begin
  if p_session_id is null
    or p_host_id is null
    or length(p_host_id) not between 1 and 256
    or p_expected_version is null
    or p_expected_version < 1
    or p_session_type is null
    or p_session_type not in ('presentation', 'meeting')
    or p_output_mode is null
    or p_output_mode not in ('captions', 'captions_audio', 'audio')
    or p_languages is null
    or not public.live_languages_valid(p_languages)
    or p_max_viewers is null
    or p_max_viewers not between 1 and 50
    or p_glossary_pack is null
    or p_glossary_pack not in ('general_cre', 'hotel', 'fnb')
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_INPUT';
  end if;

  update public.live_sessions as session_row
  set session_type = p_session_type,
      output_mode = p_output_mode,
      mode = case when p_output_mode = 'captions' then p_session_type else 'townhall' end,
      voice_output_mode = case when p_output_mode = 'captions' then 'captions' else 'auto_voice' end,
      languages = p_languages,
      max_viewers = p_max_viewers,
      glossary_pack = p_glossary_pack,
      version = session_row.version + 1,
      updated_at = statement_timestamp()
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.version = p_expected_version
    and session_row.status <> 'stopped'
    and session_row.expires_at > statement_timestamp()
    and session_row.viewer_count <= p_max_viewers
  returning session_row.* into updated_session;

  if not found then
    return;
  end if;

  delete from public.live_snapshots snapshot_row
  where snapshot_row.session_id = updated_session.id
    and not (snapshot_row.language = any(updated_session.languages));

  id := updated_session.id;
  host_id := updated_session.host_id;
  session_type := updated_session.session_type;
  output_mode := updated_session.output_mode;
  status := updated_session.status;
  languages := updated_session.languages;
  viewer_count := updated_session.viewer_count;
  max_viewers := updated_session.max_viewers;
  version := updated_session.version;
  glossary_pack := updated_session.glossary_pack;
  admission_open_until := updated_session.admission_open_until;
  expires_at := updated_session.expires_at;
  return next;
end;
$$;

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
  next_version integer;
begin
  if p_session_id is null
    or p_host_id is null
    or length(p_host_id) not between 1 and 256
    or p_code_hmac is null
    or p_code_hmac !~ '^[0-9a-f]{64}$'
    or p_open_until is null
    or p_open_until <= statement_timestamp()
    or p_open_until > statement_timestamp() + interval '6 hours'
    or p_expected_version is null
    or p_expected_version < 1
  then
    raise exception using errcode = '22023', message = 'INVALID_ADMISSION_INPUT';
  end if;

  update public.live_sessions as session_row
  set admission_code_hmac = p_code_hmac,
      admission_open_until = p_open_until,
      updated_at = statement_timestamp(),
      version = session_row.version + 1
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.version = p_expected_version
    and session_row.status in ('preparing', 'live')
    and session_row.expires_at > statement_timestamp()
    and p_open_until <= session_row.expires_at
  returning session_row.version into next_version;

  if next_version is null then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT_OR_FORBIDDEN';
  end if;

  update public.live_session_invites invite_row
  set revoked_at = coalesce(invite_row.revoked_at, statement_timestamp())
  where invite_row.session_id = p_session_id;

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
    or length(p_host_id) not between 1 and 256
    or p_expected_version is null
    or p_expected_version < 1
  then
    raise exception using errcode = '22023', message = 'INVALID_ADMISSION_INPUT';
  end if;

  update public.live_sessions as session_row
  set admission_code_hmac = null,
      admission_open_until = null,
      updated_at = statement_timestamp(),
      version = session_row.version + 1
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.version = p_expected_version
    and session_row.status <> 'stopped'
    and session_row.expires_at > statement_timestamp()
  returning session_row.version into next_version;

  if next_version is null then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT_OR_FORBIDDEN';
  end if;

  update public.live_session_invites invite_row
  set revoked_at = coalesce(invite_row.revoked_at, statement_timestamp())
  where invite_row.session_id = p_session_id;

  return next_version;
end;
$$;

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
    or p_expires_at > statement_timestamp() + interval '6 hours'
    or p_admission_open_until is null
    or p_admission_open_until <= statement_timestamp()
    or p_admission_open_until > statement_timestamp() + interval '6 hours'
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
  resolved_session_id uuid;
  session_row public.live_sessions%rowtype;
  grant_result record;
begin
  resolved_session_id := public.lock_live_admission_session(p_code_hmac);
  select * into session_row from public.live_sessions where id = resolved_session_id;
  select * into grant_result
  from public.apply_live_viewer_grant(
    resolved_session_id, p_user_id, p_device_hash, p_grant_expires_at, null
  );

  grant_id := grant_result.grant_id;
  session_id := session_row.id;
  user_id := grant_result.grant_user_id;
  grant_expires_at := grant_result.grant_expires_at;
  mode := session_row.mode;
  languages := session_row.languages;
  session_expires_at := session_row.expires_at;
  viewer_count := grant_result.resolved_viewer_count;
  return next;
end;
$$;

create or replace function public.redeem_live_admission(
  p_code_hmac text,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_display_name text
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
  display_name text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  resolved_session_id uuid;
  session_row public.live_sessions%rowtype;
  grant_result record;
begin
  if p_display_name is null then
    raise exception using errcode = '22023', message = 'INVALID_DISPLAY_NAME';
  end if;
  resolved_session_id := public.lock_live_admission_session(p_code_hmac);
  select * into session_row from public.live_sessions where id = resolved_session_id;
  select * into grant_result
  from public.apply_live_viewer_grant(
    resolved_session_id, p_user_id, p_device_hash, p_grant_expires_at, p_display_name
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
  return next;
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
  resolved_session_id uuid;
  session_row public.live_sessions%rowtype;
  grant_result record;
begin
  resolved_session_id := public.lock_live_invite_session(p_token_hmac);
  select * into session_row from public.live_sessions where id = resolved_session_id;
  select * into grant_result
  from public.apply_live_viewer_grant(
    resolved_session_id, p_user_id, p_device_hash, p_grant_expires_at, null
  );

  grant_id := grant_result.grant_id;
  session_id := session_row.id;
  user_id := grant_result.grant_user_id;
  grant_expires_at := grant_result.grant_expires_at;
  mode := session_row.mode;
  languages := session_row.languages;
  session_expires_at := session_row.expires_at;
  viewer_count := grant_result.resolved_viewer_count;
  return next;
end;
$$;

create or replace function public.redeem_live_invite(
  p_token_hmac text,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_display_name text
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
  display_name text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  resolved_session_id uuid;
  session_row public.live_sessions%rowtype;
  grant_result record;
begin
  if p_display_name is null then
    raise exception using errcode = '22023', message = 'INVALID_DISPLAY_NAME';
  end if;
  resolved_session_id := public.lock_live_invite_session(p_token_hmac);
  select * into session_row from public.live_sessions where id = resolved_session_id;
  select * into grant_result
  from public.apply_live_viewer_grant(
    resolved_session_id, p_user_id, p_device_hash, p_grant_expires_at, p_display_name
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
  return next;
end;
$$;

grant select (session_type, output_mode, max_viewers, glossary_pack)
  on public.live_sessions to authenticated;
grant select (display_name) on public.viewer_grants to authenticated;

revoke all on function public.sync_live_session_compatibility()
  from public, anon, authenticated, service_role;
revoke all on function public.lock_live_admission_session(text)
  from public, anon, authenticated, service_role;
revoke all on function public.lock_live_invite_session(text)
  from public, anon, authenticated, service_role;
revoke all on function public.apply_live_viewer_grant(uuid, text, text, timestamptz, text)
  from public, anon, authenticated, service_role;
revoke all on function public.create_live_session(uuid, text, text, text, text[], integer, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.update_live_session(uuid, text, integer, text, text, text[], integer, text)
  from public, anon, authenticated;
revoke all on function public.open_live_admission(uuid, text, text, timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.close_live_admission(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.create_live_invite(uuid, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function public.redeem_live_admission(text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.redeem_live_admission(text, text, text, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.redeem_live_invite(text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.redeem_live_invite(text, text, text, timestamptz, text)
  from public, anon, authenticated;

grant execute on function public.create_live_session(uuid, text, text, text, text[], integer, text, timestamptz)
  to service_role;
grant execute on function public.update_live_session(uuid, text, integer, text, text, text[], integer, text)
  to service_role;
grant execute on function public.open_live_admission(uuid, text, text, timestamptz, integer)
  to service_role;
grant execute on function public.close_live_admission(uuid, text, integer)
  to service_role;
grant execute on function public.create_live_invite(uuid, text, text, timestamptz, timestamptz)
  to service_role;
grant execute on function public.redeem_live_admission(text, text, text, timestamptz)
  to service_role;
grant execute on function public.redeem_live_admission(text, text, text, timestamptz, text)
  to service_role;
grant execute on function public.redeem_live_invite(text, text, text, timestamptz)
  to service_role;
grant execute on function public.redeem_live_invite(text, text, text, timestamptz, text)
  to service_role;

-- ===================================================================
-- supabase/migrations/20260720060633_live_personal_data_cleanup.sql
-- ===================================================================
-- 2026-07-20 fix: Remove session-scoped viewer identity data when access ends.
-- Session rows remain as non-biometric operational records, while grants that
-- contain display_name, user_id, and device_hash are deleted rather than kept.

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

  -- The global order is session -> invite -> grant. Join and cleanup acquire
  -- the same locks in this order, preventing inverse-lock deadlocks.
  update public.live_session_invites invite_row
  set revoked_at = coalesce(invite_row.revoked_at, statement_timestamp())
  where invite_row.session_id = p_session_id;

  delete from public.viewer_grants
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
  -- Lock every session whose dependent rows can be changed, in UUID order.
  -- This also repairs grants left by older terminate/cleanup implementations.
  perform 1
  from public.live_sessions session_lock
  where (
      session_lock.status <> 'stopped'
      and session_lock.expires_at <= statement_timestamp()
    )
    or exists (
      select 1
      from public.viewer_grants grant_lock
      where grant_lock.session_id = session_lock.id
        and (
          grant_lock.revoked_at is not null
          or grant_lock.expires_at <= statement_timestamp()
          or session_lock.status = 'stopped'
          or session_lock.expires_at <= statement_timestamp()
        )
    )
    or exists (
      select 1
      from public.live_session_invites invite_lock
      where invite_lock.session_id = session_lock.id
        and invite_lock.revoked_at is null
        and (
          invite_lock.expires_at <= statement_timestamp()
          or session_lock.status = 'stopped'
          or session_lock.expires_at <= statement_timestamp()
          or session_lock.admission_open_until is null
          or session_lock.admission_open_until <= statement_timestamp()
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

  delete from public.viewer_grants grant_row
  using public.live_sessions session_row
  where grant_row.session_id = session_row.id
    and (
      grant_row.revoked_at is not null
      or grant_row.expires_at <= statement_timestamp()
      or session_row.status = 'stopped'
      or session_row.expires_at <= statement_timestamp()
    );

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

create or replace function public.verify_live_cleanup_schedule()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  has_active_cleanup_job boolean := false;
begin
  if to_regclass('cron.job') is null then
    return false;
  end if;

  -- Only explicitly approved schedules of one to five minutes satisfy the
  -- readiness probe. An active but infrequent job must fail closed.
  execute $query$
    select exists (
      select 1
      from cron.job job_row
      where job_row.active is true
        and btrim(job_row.command) ~* '^(select[[:space:]]+)?(public[.])?cleanup_expired_live_state[[:space:]]*[(][[:space:]]*[)][[:space:]]*;?$'
        and btrim(job_row.schedule) in (
          '* * * * *',
          '*/2 * * * *',
          '*/3 * * * *',
          '*/4 * * * *',
          '*/5 * * * *'
        )
    )
  $query$
  into has_active_cleanup_job;

  return has_active_cleanup_job;
exception
  when undefined_table or undefined_column or insufficient_privilege then
    return false;
end;
$$;

revoke all on function public.terminate_live_session(uuid, text)
  from public, anon, authenticated;
revoke all on function public.cleanup_expired_live_state()
  from public, anon, authenticated;
revoke all on function public.verify_live_cleanup_schedule()
  from public, anon, authenticated;

grant execute on function public.terminate_live_session(uuid, text)
  to service_role;
grant execute on function public.cleanup_expired_live_state()
  to service_role;
grant execute on function public.verify_live_cleanup_schedule()
  to service_role;

-- ===================================================================
-- supabase/migrations/20260720061119_live_cleanup_schedule.sql
-- ===================================================================
-- 2026-07-20 feat: Schedule bounded cleanup for expired live session state.
-- The named pg_cron upsert is intentionally rerunnable and never touches jobs
-- owned by another feature.

create extension if not exists pg_cron;

do $migration$
declare
  cleanup_job_id bigint;
begin
  if to_regnamespace('cron') is null
    or to_regclass('cron.job') is null
    or to_regprocedure('cron.schedule(text,text,text)') is null
  then
    raise exception using errcode = 'P0001', message = 'LIVE_CLEANUP_CRON_UNAVAILABLE';
  end if;

  if to_regprocedure('public.cleanup_expired_live_state()') is null then
    raise exception using errcode = 'P0001', message = 'LIVE_CLEANUP_FUNCTION_UNAVAILABLE';
  end if;

  if not has_function_privilege(
    current_user,
    'cron.schedule(text,text,text)',
    'EXECUTE'
  ) then
    raise exception using errcode = '42501', message = 'LIVE_CLEANUP_CRON_FORBIDDEN';
  end if;

  -- pg_cron updates an existing named job atomically. This avoids an
  -- unschedule/reschedule gap and leaves every differently named job intact.
  cleanup_job_id := cron.schedule(
    'realtime-noel-live-cleanup',
    '*/5 * * * *',
    'select public.cleanup_expired_live_state();'
  );

  if cleanup_job_id is null
    or not exists (
      select 1
      from cron.job job_row
      where job_row.jobid = cleanup_job_id
        and job_row.jobname = 'realtime-noel-live-cleanup'
        and btrim(job_row.schedule) = '*/5 * * * *'
        and btrim(job_row.command) = 'select public.cleanup_expired_live_state();'
        and job_row.active is true
    )
  then
    raise exception using errcode = 'P0001', message = 'LIVE_CLEANUP_CRON_NOT_READY';
  end if;
end;
$migration$;

-- ===================================================================
-- supabase/migrations/20260721110000_fix_live_rate_limit_timestamp.sql
-- ===================================================================
-- `current_time` is a PostgreSQL special value with type time with time zone.
-- Using an unqualified PL/pgSQL variable with that name can therefore resolve to
-- the SQL special value and fail when assigned to a timestamptz column.
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
  v_now timestamptz := clock_timestamp();
begin
  if p_scope is null
    or p_key_hash is null
    or p_limit is null
    or p_window_seconds is null
    or p_scope !~ '^[a-z][a-z0-9-]{1,63}$'
    or p_key_hash !~ '^[0-9a-f]{64}$'
    or p_limit < 1 or p_limit > 10000
    or p_window_seconds < 1 or p_window_seconds > 86400
  then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_INPUT';
  end if;

  insert into public.live_rate_limits as bucket (
    scope, key_hash, window_started_at, request_count, updated_at
  ) values (
    p_scope, p_key_hash, v_now, 1, v_now
  )
  on conflict (scope, key_hash) do update
    set request_count = case
          when bucket.window_started_at + make_interval(secs => p_window_seconds) <= v_now then 1
          else bucket.request_count + 1
        end,
        window_started_at = case
          when bucket.window_started_at + make_interval(secs => p_window_seconds) <= v_now then v_now
          else bucket.window_started_at
        end,
        updated_at = v_now
  returning request_count into current_count;

  return current_count <= p_limit;
end;
$$;

revoke all on function public.consume_live_rate_limit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_live_rate_limit(text, text, integer, integer)
  to service_role;

-- ===================================================================
-- supabase/migrations/202607220001_live_voice_provider.sql
-- ===================================================================
-- 2026-07-22 feat: Persist the independently selectable translated-audio provider.
-- Captions remain on the Gemini pipeline. Existing sessions and legacy RPC
-- callers stay on Gemini through the column default and prior RPC overloads.

alter table public.live_sessions
  add column voice_provider text not null default 'gemini',
  add constraint live_sessions_voice_provider_check
    check (voice_provider in ('gemini', 'openai')),
  add constraint live_sessions_openai_voice_presentation_check
    check (
      voice_provider <> 'openai'
      or (
        session_type = 'presentation'
        and output_mode in ('captions_audio', 'audio')
      )
    );

comment on column public.live_sessions.voice_provider is
  'Translated-audio provider only. Caption generation remains Gemini-owned.';

create or replace function public.create_live_session(
  p_session_id uuid,
  p_host_id text,
  p_session_type text,
  p_output_mode text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text,
  p_voice_provider text,
  p_expires_at timestamptz
)
returns table (
  id uuid,
  host_id text,
  session_type text,
  output_mode text,
  status text,
  languages text[],
  viewer_count integer,
  max_viewers integer,
  version integer,
  glossary_pack text,
  voice_provider text,
  admission_open_until timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_session_id is null
    or p_host_id is null
    or length(p_host_id) not between 1 and 256
    or p_session_type is null
    or p_session_type not in ('presentation', 'meeting')
    or p_output_mode is null
    or p_output_mode not in ('captions', 'captions_audio', 'audio')
    or p_voice_provider is null
    or p_voice_provider not in ('gemini', 'openai')
    or (
      p_voice_provider = 'openai'
      and (
        p_session_type <> 'presentation'
        or p_output_mode not in ('captions_audio', 'audio')
      )
    )
    or p_languages is null
    or not public.live_languages_valid(p_languages)
    or p_max_viewers is null
    or p_max_viewers not between 1 and 50
    or p_glossary_pack is null
    or p_glossary_pack not in ('general_cre', 'hotel', 'fnb')
    or p_expires_at is null
    or p_expires_at <= statement_timestamp()
    or p_expires_at > statement_timestamp() + interval '6 hours'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_INPUT';
  end if;

  return query
  insert into public.live_sessions as created_session (
    id, host_id, mode, voice_output_mode, session_type, output_mode,
    voice_provider, status, languages, viewer_count, max_viewers, version,
    glossary_pack, expires_at, created_at, updated_at
  ) values (
    p_session_id,
    p_host_id,
    case when p_output_mode = 'captions' then p_session_type else 'townhall' end,
    case when p_output_mode = 'captions' then 'captions' else 'auto_voice' end,
    p_session_type,
    p_output_mode,
    p_voice_provider,
    'preparing',
    p_languages,
    0,
    p_max_viewers,
    1,
    p_glossary_pack,
    p_expires_at,
    statement_timestamp(),
    statement_timestamp()
  )
  returning
    created_session.id,
    created_session.host_id,
    created_session.session_type,
    created_session.output_mode,
    created_session.status,
    created_session.languages,
    created_session.viewer_count,
    created_session.max_viewers,
    created_session.version,
    created_session.glossary_pack,
    created_session.voice_provider,
    created_session.admission_open_until,
    created_session.expires_at;
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'LIVE_SESSION_CONFLICT';
end;
$$;

create or replace function public.update_live_session(
  p_session_id uuid,
  p_host_id text,
  p_expected_version integer,
  p_session_type text,
  p_output_mode text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text,
  p_voice_provider text
)
returns table (
  id uuid,
  host_id text,
  session_type text,
  output_mode text,
  status text,
  languages text[],
  viewer_count integer,
  max_viewers integer,
  version integer,
  glossary_pack text,
  voice_provider text,
  admission_open_until timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  updated_session public.live_sessions%rowtype;
begin
  if p_session_id is null
    or p_host_id is null
    or length(p_host_id) not between 1 and 256
    or p_expected_version is null
    or p_expected_version < 1
    or p_session_type is null
    or p_session_type not in ('presentation', 'meeting')
    or p_output_mode is null
    or p_output_mode not in ('captions', 'captions_audio', 'audio')
    or p_voice_provider is null
    or p_voice_provider not in ('gemini', 'openai')
    or (
      p_voice_provider = 'openai'
      and (
        p_session_type <> 'presentation'
        or p_output_mode not in ('captions_audio', 'audio')
      )
    )
    or p_languages is null
    or not public.live_languages_valid(p_languages)
    or p_max_viewers is null
    or p_max_viewers not between 1 and 50
    or p_glossary_pack is null
    or p_glossary_pack not in ('general_cre', 'hotel', 'fnb')
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_INPUT';
  end if;

  update public.live_sessions as session_row
  set session_type = p_session_type,
      output_mode = p_output_mode,
      voice_provider = p_voice_provider,
      mode = case when p_output_mode = 'captions' then p_session_type else 'townhall' end,
      voice_output_mode = case when p_output_mode = 'captions' then 'captions' else 'auto_voice' end,
      languages = p_languages,
      max_viewers = p_max_viewers,
      glossary_pack = p_glossary_pack,
      version = session_row.version + 1,
      updated_at = statement_timestamp()
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.version = p_expected_version
    and session_row.status <> 'stopped'
    and session_row.expires_at > statement_timestamp()
    and session_row.viewer_count <= p_max_viewers
  returning session_row.* into updated_session;

  if not found then
    return;
  end if;

  delete from public.live_snapshots snapshot_row
  where snapshot_row.session_id = updated_session.id
    and not (snapshot_row.language = any(updated_session.languages));

  id := updated_session.id;
  host_id := updated_session.host_id;
  session_type := updated_session.session_type;
  output_mode := updated_session.output_mode;
  status := updated_session.status;
  languages := updated_session.languages;
  viewer_count := updated_session.viewer_count;
  max_viewers := updated_session.max_viewers;
  version := updated_session.version;
  glossary_pack := updated_session.glossary_pack;
  voice_provider := updated_session.voice_provider;
  admission_open_until := updated_session.admission_open_until;
  expires_at := updated_session.expires_at;
  return next;
end;
$$;

-- PostgreSQL cannot change OUT parameters with CREATE OR REPLACE. Only the
-- named-viewer overloads are replaced; four-argument legacy overloads remain.
drop function public.redeem_live_admission(text, text, text, timestamptz, text);

create or replace function public.redeem_live_admission(
  p_code_hmac text,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_display_name text
)
returns table (
  grant_id uuid,
  session_id uuid,
  user_id text,
  grant_expires_at timestamptz,
  session_type text,
  output_mode text,
  voice_provider text,
  languages text[],
  session_expires_at timestamptz,
  viewer_count integer,
  max_viewers integer,
  glossary_pack text,
  display_name text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  resolved_session_id uuid;
  session_row public.live_sessions%rowtype;
  grant_result record;
begin
  if p_display_name is null then
    raise exception using errcode = '22023', message = 'INVALID_DISPLAY_NAME';
  end if;
  resolved_session_id := public.lock_live_admission_session(p_code_hmac);
  select * into session_row from public.live_sessions where id = resolved_session_id;
  select * into grant_result
  from public.apply_live_viewer_grant(
    resolved_session_id, p_user_id, p_device_hash, p_grant_expires_at, p_display_name
  );

  grant_id := grant_result.grant_id;
  session_id := session_row.id;
  user_id := grant_result.grant_user_id;
  grant_expires_at := grant_result.grant_expires_at;
  session_type := session_row.session_type;
  output_mode := session_row.output_mode;
  voice_provider := session_row.voice_provider;
  languages := session_row.languages;
  session_expires_at := session_row.expires_at;
  viewer_count := grant_result.resolved_viewer_count;
  max_viewers := session_row.max_viewers;
  glossary_pack := session_row.glossary_pack;
  display_name := grant_result.resolved_display_name;
  return next;
end;
$$;

drop function public.redeem_live_invite(text, text, text, timestamptz, text);

create or replace function public.redeem_live_invite(
  p_token_hmac text,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_display_name text
)
returns table (
  grant_id uuid,
  session_id uuid,
  user_id text,
  grant_expires_at timestamptz,
  session_type text,
  output_mode text,
  voice_provider text,
  languages text[],
  session_expires_at timestamptz,
  viewer_count integer,
  max_viewers integer,
  glossary_pack text,
  display_name text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  resolved_session_id uuid;
  session_row public.live_sessions%rowtype;
  grant_result record;
begin
  if p_display_name is null then
    raise exception using errcode = '22023', message = 'INVALID_DISPLAY_NAME';
  end if;
  resolved_session_id := public.lock_live_invite_session(p_token_hmac);
  select * into session_row from public.live_sessions where id = resolved_session_id;
  select * into grant_result
  from public.apply_live_viewer_grant(
    resolved_session_id, p_user_id, p_device_hash, p_grant_expires_at, p_display_name
  );

  grant_id := grant_result.grant_id;
  session_id := session_row.id;
  user_id := grant_result.grant_user_id;
  grant_expires_at := grant_result.grant_expires_at;
  session_type := session_row.session_type;
  output_mode := session_row.output_mode;
  voice_provider := session_row.voice_provider;
  languages := session_row.languages;
  session_expires_at := session_row.expires_at;
  viewer_count := grant_result.resolved_viewer_count;
  max_viewers := session_row.max_viewers;
  glossary_pack := session_row.glossary_pack;
  display_name := grant_result.resolved_display_name;
  return next;
end;
$$;

grant select (voice_provider)
  on public.live_sessions to authenticated;

revoke all on function public.create_live_session(uuid, text, text, text, text[], integer, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.update_live_session(uuid, text, integer, text, text, text[], integer, text, text)
  from public, anon, authenticated;
revoke all on function public.redeem_live_admission(text, text, text, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.redeem_live_invite(text, text, text, timestamptz, text)
  from public, anon, authenticated;

grant execute on function public.create_live_session(uuid, text, text, text, text[], integer, text, text, timestamptz)
  to service_role;
grant execute on function public.update_live_session(uuid, text, integer, text, text, text[], integer, text, text)
  to service_role;
grant execute on function public.redeem_live_admission(text, text, text, timestamptz, text)
  to service_role;
grant execute on function public.redeem_live_invite(text, text, text, timestamptz, text)
  to service_role;

-- ===================================================================
-- supabase/migrations/202607230001_live_multilingual_languages.sql
-- ===================================================================
-- 2026-07-23 feat: Enforce one canonical multilingual contract end to end.
-- Existing rows are validated in place. The migration intentionally aborts
-- instead of rewriting an unsupported language code or deleting live state.

create or replace function public.normalize_live_language(p_language text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case p_language
    when 'en' then 'en'
    when 'en-US' then 'en'
    when 'en-GB' then 'en'
    when 'en-AU' then 'en'
    when 'en-CA' then 'en'
    when 'ko' then 'ko'
    when 'ko-KR' then 'ko'
    when 'ja' then 'ja'
    when 'ja-JP' then 'ja'
    when 'zh-Hans' then 'zh-Hans'
    when 'zh' then 'zh-Hans'
    when 'zh-CN' then 'zh-Hans'
    when 'zh-SG' then 'zh-Hans'
    when 'cmn-Hans-CN' then 'zh-Hans'
    when 'zh-Hant' then 'zh-Hant'
    when 'zh-TW' then 'zh-Hant'
    when 'zh-HK' then 'zh-Hant'
    when 'zh-MO' then 'zh-Hant'
    when 'cmn-Hant-TW' then 'zh-Hant'
    when 'es' then 'es'
    when 'es-ES' then 'es'
    when 'es-MX' then 'es'
    when 'pt' then 'pt'
    when 'pt-BR' then 'pt'
    when 'pt-PT' then 'pt'
    when 'fr' then 'fr'
    when 'fr-FR' then 'fr'
    when 'fr-CA' then 'fr'
    when 'de' then 'de'
    when 'de-DE' then 'de'
    when 'ru' then 'ru'
    when 'ru-RU' then 'ru'
    when 'hi' then 'hi'
    when 'hi-IN' then 'hi'
    when 'id' then 'id'
    when 'id-ID' then 'id'
    when 'vi' then 'vi'
    when 'vi-VN' then 'vi'
    when 'it' then 'it'
    when 'it-IT' then 'it'
    else null
  end;
$$;

create or replace function public.normalize_live_languages(p_languages text[])
returns text[]
language sql
immutable
strict
set search_path = ''
as $$
  select array(
    select public.normalize_live_language(language_code)
    from unnest(p_languages) with ordinality as requested(language_code, position)
    order by position
  );
$$;

create or replace function public.live_language_valid(p_language text)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select coalesce(p_language = public.normalize_live_language(p_language), false);
$$;

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
      select count(distinct public.normalize_live_language(language_code))
      from unnest(p_languages) as requested(language_code)
    )
    and not exists (
      select 1
      from unnest(p_languages) as requested(language_code)
      where public.normalize_live_language(language_code) is null
    );
$$;

create or replace function public.live_languages_canonical(p_languages text[])
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select
    public.live_languages_valid(p_languages)
    and p_languages = public.normalize_live_languages(p_languages);
$$;

create or replace function public.normalize_live_session_languages()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.live_languages_valid(new.languages) then
    raise exception using errcode = '23514', message = 'INVALID_LIVE_LANGUAGES';
  end if;
  new.languages := public.normalize_live_languages(new.languages);
  return new;
end;
$$;

comment on function public.normalize_live_language(text) is
  'Maps supported locale aliases to one Realtime Noel storage code; null means unsupported.';
comment on function public.normalize_live_languages(text[]) is
  'Preserves requested order and cardinality while mapping every supported locale alias.';
comment on function public.live_language_valid(text) is
  'Exact Realtime Noel storage-code allowlist; aliases must be normalized before persistence.';
comment on function public.live_languages_valid(text[]) is
  'Shared 1..3 unique normalized-language input validator used by create_live_session and update_live_session.';
comment on function public.live_languages_canonical(text[]) is
  'Exact 1..3 unique-language storage invariant used by sessions, joins, snapshots, and viewer topics.';

create trigger live_sessions_normalize_languages_before_write
before insert or update of languages
on public.live_sessions
for each row execute function public.normalize_live_session_languages();

-- Preserve compatible clients and rows by canonicalizing known locale aliases.
-- Unknown codes and aliases that collapse into duplicates abort before any row
-- is changed, so the migration remains atomic and never guesses a data merge.
do $migration$
begin
  if exists (
    select 1
    from public.live_sessions session_row
    where not public.live_languages_valid(session_row.languages)
  ) then
    raise exception using errcode = '23514', message = 'UNSUPPORTED_EXISTING_LIVE_LANGUAGE';
  end if;

  if exists (
    select 1
    from public.live_snapshots snapshot_row
    where public.normalize_live_language(snapshot_row.language) is null
  ) then
    raise exception using errcode = '23514', message = 'UNSUPPORTED_EXISTING_SNAPSHOT_LANGUAGE';
  end if;

  if exists (
    select 1
    from public.live_snapshots snapshot_row
    group by snapshot_row.session_id,
      public.normalize_live_language(snapshot_row.language)
    having count(*) > 1
  ) then
    raise exception using errcode = '23505', message = 'LIVE_LANGUAGE_ALIAS_COLLISION';
  end if;
end;
$migration$;

update public.live_sessions
set languages = public.normalize_live_languages(languages)
where languages is distinct from public.normalize_live_languages(languages);

update public.live_snapshots
set language = public.normalize_live_language(language)
where language is distinct from public.normalize_live_language(language);

-- A new NOT VALID constraint followed by VALIDATE rechecks existing rows under
-- the stricter function body. PostgreSQL does not automatically rescan an old
-- function-backed CHECK constraint after CREATE OR REPLACE FUNCTION.
alter table public.live_sessions
  add constraint live_sessions_canonical_languages_check
  check (public.live_languages_canonical(languages)) not valid;

alter table public.live_sessions
  validate constraint live_sessions_canonical_languages_check;

alter table public.live_snapshots
  add constraint live_snapshots_canonical_language_check
  check (public.live_language_valid(language)) not valid;

alter table public.live_snapshots
  validate constraint live_snapshots_canonical_language_check;

-- Both admission and invite redemption call these lock helpers before creating
-- a viewer grant. The shared language predicate therefore makes every join
-- overload fail closed if a future schema drift leaves a non-canonical session.
create or replace function public.lock_live_admission_session(
  p_code_hmac text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_session_id uuid;
begin
  if p_code_hmac is null or p_code_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
  end if;

  select session_row.id into resolved_session_id
  from public.live_sessions session_row
  where session_row.admission_code_hmac = p_code_hmac
    and session_row.admission_open_until > statement_timestamp()
    and session_row.status in ('preparing', 'live')
    and session_row.expires_at > statement_timestamp()
    and public.live_languages_canonical(session_row.languages)
  for update;

  if resolved_session_id is null then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
  end if;
  return resolved_session_id;
end;
$$;

create or replace function public.lock_live_invite_session(
  p_token_hmac text
)
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
    or session_row.admission_open_until is null
    or session_row.admission_open_until <= statement_timestamp()
    or session_row.status not in ('preparing', 'live')
    or session_row.expires_at <= statement_timestamp()
    or not public.live_languages_canonical(session_row.languages)
  then
    raise exception using errcode = 'P0001', message = 'INVITE_CLOSED';
  end if;

  return session_row.id;
end;
$$;

-- The gateway previously authorized a topic with separate grant and session
-- reads. This single statement evaluates the grant, session, selected language,
-- and expiry against one PostgreSQL snapshot, preventing split-read decisions.
-- Viewer reconnects remain closed while a session is preparing; this preserves
-- the existing gateway contract and prevents pre-live caption disclosure.
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
        -- Mirrors migration 202607240003: admitted viewers keep their seat
        -- from the pre-live waiting room until the host ends the session.
        and session_row.status in ('preparing', 'live', 'paused')
        and session_row.expires_at > statement_timestamp()
        and public.live_languages_canonical(session_row.languages)
        and p_language = any(session_row.languages)
        and grant_row.id = p_grant_id
        and grant_row.user_id = p_user_id
        and grant_row.revoked_at is null
        and grant_row.expires_at > statement_timestamp()
    );
$$;

revoke all on function public.normalize_live_language(text)
  from public, anon, authenticated;
revoke all on function public.normalize_live_languages(text[])
  from public, anon, authenticated;
revoke all on function public.live_language_valid(text)
  from public, anon, authenticated;
revoke all on function public.live_languages_valid(text[])
  from public, anon, authenticated;
revoke all on function public.live_languages_canonical(text[])
  from public, anon, authenticated;
revoke all on function public.normalize_live_session_languages()
  from public, anon, authenticated, service_role;
revoke all on function public.lock_live_admission_session(text)
  from public, anon, authenticated, service_role;
revoke all on function public.lock_live_invite_session(text)
  from public, anon, authenticated, service_role;
revoke all on function public.authorize_live_viewer_topic(uuid, uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.normalize_live_language(text)
  to service_role;
grant execute on function public.normalize_live_languages(text[])
  to service_role;
grant execute on function public.live_language_valid(text)
  to service_role;
grant execute on function public.live_languages_valid(text[])
  to service_role;
grant execute on function public.live_languages_canonical(text[])
  to service_role;
grant execute on function public.authorize_live_viewer_topic(uuid, uuid, text, text)
  to service_role;

-- Verification (run after applying to a development project only):
-- select public.live_languages_valid(array['en', 'ja', 'zh-Hans']); -- true
-- select public.normalize_live_languages(array['en-US', 'ko-KR', 'zh-CN']);
-- Expected: {en,ko,zh-Hans}
-- select not public.live_languages_valid(array['en', 'en']);       -- true
-- select not public.live_languages_valid(array['EN']);             -- true
-- select not public.live_languages_canonical(array['zh']);         -- true
-- select not public.live_languages_valid(array[]::text[]);         -- true
-- select not public.live_languages_valid(array['en', 'ko', 'ja', 'fr']); -- true
-- select count(*) = 0 as existing_sessions_are_canonical
-- from public.live_sessions
-- where not public.live_languages_canonical(languages);
-- select count(*) = 0 as existing_snapshots_are_canonical
-- from public.live_snapshots
-- where not public.live_language_valid(language);

-- ===================================================================
-- supabase/migrations/202607230002_live_call_floor.sql
-- ===================================================================
-- 2026-07-23 feat: Live Call participant speaking-floor, utterance record,
-- and meeting summaries. Additive only — no existing column or overload is
-- removed. Floor state lives on live_sessions; the utterance record and
-- summaries are new service-role-only tables reached through guarded RPCs.

alter table public.live_sessions
  add column if not exists floor_grant_id uuid references public.viewer_grants(id) on delete set null,
  add column if not exists floor_display_name text
    check (floor_display_name is null or (
      char_length(floor_display_name) between 1 and 40
      and floor_display_name !~ '[[:cntrl:]]' and floor_display_name !~ '[<>]'
    )),
  add column if not exists floor_taken_at timestamptz;

create table if not exists public.live_utterances (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  seq bigint not null check (seq >= 1),
  language text not null check (language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  speaker_label text check (speaker_label is null or char_length(speaker_label) between 1 and 80),
  speaker_name text check (speaker_name is null or (
    char_length(speaker_name) between 1 and 40
    and speaker_name !~ '[[:cntrl:]]' and speaker_name !~ '[<>]'
  )),
  text text not null check (char_length(btrim(text)) between 1 and 8000 and octet_length(text) <= 24000),
  source_ended_at timestamptz not null,
  emitted_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (session_id, language, seq)
);
create index if not exists live_utterances_session_language_seq_idx
  on public.live_utterances (session_id, language, seq);
alter table public.live_utterances enable row level security;

create table if not exists public.live_meeting_summaries (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  language text not null check (language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  summary jsonb not null check (jsonb_typeof(summary) = 'object' and octet_length(summary::text) <= 65536),
  model text check (model is null or char_length(model) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, language)
);
alter table public.live_meeting_summaries enable row level security;

create or replace function public.take_live_floor(p_session_id uuid, p_grant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  session_status text;
  previous_grant_id uuid;
  previous_display_name text;
  grant_display_name text;
begin
  select session_row.status, session_row.floor_grant_id, session_row.floor_display_name
  into session_status, previous_grant_id, previous_display_name
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.expires_at > statement_timestamp()
  for update;

  if not found or session_status <> 'live' then
    return jsonb_build_object('ok', false, 'code', 'SESSION_NOT_LIVE');
  end if;

  select grant_row.display_name into grant_display_name
  from public.viewer_grants grant_row
  where grant_row.id = p_grant_id
    and grant_row.session_id = p_session_id
    and grant_row.revoked_at is null
    and grant_row.expires_at > statement_timestamp();

  if not found then
    return jsonb_build_object('ok', false, 'code', 'GRANT_INVALID');
  end if;

  update public.live_sessions
  set floor_grant_id = p_grant_id,
      floor_display_name = coalesce(grant_display_name, '참가자'),
      floor_taken_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where id = p_session_id;

  return jsonb_build_object(
    'ok', true,
    'displayName', coalesce(grant_display_name, '참가자'),
    'previousGrantId', previous_grant_id,
    'previousDisplayName', previous_display_name
  );
end;
$$;

create or replace function public.release_live_floor(p_session_id uuid, p_grant_id uuid)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
  current_grant_id uuid;
begin
  select session_row.floor_grant_id into current_grant_id
  from public.live_sessions session_row
  where session_row.id = p_session_id
  for update;

  if not found or current_grant_id is null then
    return false;
  end if;
  -- p_grant_id null = gateway-forced release (disconnect, session stop).
  if p_grant_id is not null and current_grant_id <> p_grant_id then
    return false;
  end if;

  update public.live_sessions
  set floor_grant_id = null,
      floor_display_name = null,
      floor_taken_at = null,
      updated_at = statement_timestamp()
  where id = p_session_id;
  return true;
end;
$$;

create or replace function public.persist_live_utterance_if_active(
  p_session_id uuid,
  p_language text,
  p_seq bigint,
  p_text text,
  p_speaker_label text,
  p_speaker_name text,
  p_source_ended_at timestamptz,
  p_emitted_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
  session_status text;
  session_languages text[];
  existing_count bigint;
begin
  select session_row.status, session_row.languages
  into session_status, session_languages
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.expires_at > statement_timestamp()
  for update;

  if not found
    or session_status <> 'live'
    or p_language is null
    or not (p_language = any(session_languages))
    or p_seq is null or p_seq < 1
    or p_text is null or char_length(btrim(p_text)) not between 1 and 8000
    or octet_length(p_text) > 24000
    or p_source_ended_at is null or p_emitted_at is null
  then
    return false;
  end if;

  select count(*) into existing_count
  from public.live_utterances utterance_row
  where utterance_row.session_id = p_session_id
    and utterance_row.language = p_language;
  if existing_count >= 5000 then
    return false;
  end if;

  insert into public.live_utterances (
    session_id, language, seq, speaker_label, speaker_name, text, source_ended_at, emitted_at
  ) values (
    p_session_id, p_language, p_seq,
    nullif(btrim(coalesce(p_speaker_label, '')), ''),
    nullif(btrim(coalesce(p_speaker_name, '')), ''),
    btrim(p_text), p_source_ended_at, p_emitted_at
  )
  on conflict (session_id, language, seq) do nothing;
  return true;
exception
  when check_violation or invalid_text_representation then
    return false;
end;
$$;

revoke all on function public.take_live_floor(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_live_floor(uuid, uuid) from public, anon, authenticated;
revoke all on function public.persist_live_utterance_if_active(uuid, text, bigint, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.take_live_floor(uuid, uuid) to service_role;
grant execute on function public.release_live_floor(uuid, uuid) to service_role;
grant execute on function public.persist_live_utterance_if_active(uuid, text, bigint, text, text, text, timestamptz, timestamptz) to service_role;

-- Development verification (run manually after apply):
--   select public.take_live_floor(gen_random_uuid(), gen_random_uuid());
--     -> {"ok": false, "code": "SESSION_NOT_LIVE"}
--   select public.release_live_floor(gen_random_uuid(), null);  -> false
--   Both new tables exist with RLS enabled and no anon/authenticated grants.


-- Mirrors migration 202607240002_live_cover_image.sql: session cover image
-- for the stage countdown screen and the viewer waiting room.
-- 1) live_sessions.cover_image_path — storage object path, null until the
--    host uploads a cover. Reads map it to the boolean hasCoverImage.
alter table public.live_sessions
  add column if not exists cover_image_path text;

-- 2) Private storage bucket. Access is exclusively through the webapp cover
--    API route using the service credential — no anon/authenticated policies
--    on storage.objects are added on purpose (RLS stays fail-closed).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'live-covers',
  'live-covers',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- ===================================================================
-- supabase/migrations/202607240004_live_complete_utterance_recording.sql
-- ===================================================================
-- 2026-07-24 fix: Preserve every valid finalized caption for the bounded
-- six-hour live session. The previous 5,000-row language gate returned false
-- without persisting, while the gateway deliberately continued broadcasting.
-- The writer remains service-role-only, input bytes remain bounded, and the
-- existing (session_id, language, seq) uniqueness keeps retries idempotent.

create or replace function public.persist_live_utterance_if_active(
  p_session_id uuid,
  p_language text,
  p_seq bigint,
  p_text text,
  p_speaker_label text,
  p_speaker_name text,
  p_source_ended_at timestamptz,
  p_emitted_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_status text;
  session_languages text[];
begin
  select session_row.status, session_row.languages
  into session_status, session_languages
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.expires_at > statement_timestamp()
  for update;

  if not found
    or session_status <> 'live'
    or p_language is null
    or not (p_language = any(session_languages))
    or p_seq is null or p_seq < 1
    or p_text is null or char_length(btrim(p_text)) not between 1 and 8000
    or octet_length(p_text) > 24000
    or p_source_ended_at is null or p_emitted_at is null
  then
    return false;
  end if;

  insert into public.live_utterances (
    session_id, language, seq, speaker_label, speaker_name, text, source_ended_at, emitted_at
  ) values (
    p_session_id, p_language, p_seq,
    nullif(btrim(coalesce(p_speaker_label, '')), ''),
    nullif(btrim(coalesce(p_speaker_name, '')), ''),
    btrim(p_text), p_source_ended_at, p_emitted_at
  )
  on conflict (session_id, language, seq) do nothing;
  return true;
exception
  when check_violation or invalid_text_representation then
    return false;
end;
$$;

revoke all on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz
) to service_role;

-- Development verification after applying to a linked development project:
-- 1. Existing live_utterances rows remain unchanged.
-- 2. A valid row with seq > 5,000 persists and returns true.
-- 3. Repeating that seq returns true without adding a duplicate.
-- 4. anon/authenticated cannot execute either utterance persistence overload.

-- ===================================================================
-- supabase/migrations/202607250001_live_utterance_source_text.sql
-- ===================================================================
-- 2026-07-25 feat: Record what each speaker actually said alongside the
-- per-language translation, so a viewer reading the meeting in ONE chosen
-- language can still reveal the original for any line (원문보기).
--
-- Why a new column instead of reading the sibling row: live_utterances is keyed
-- (session_id, language, seq) and the source-language row only exists when that
-- language is one of the session's configured languages. An English-only
-- session translating Korean speech therefore had no recoverable original at
-- all. Storing it on the row that needs it removes that dependency.
--
-- Additive only: no column, constraint, overload, or grant is removed. Existing
-- rows keep source_text/source_language null and remain valid.

alter table public.live_utterances
  add column if not exists source_text text,
  add column if not exists source_language text;

do $$
begin
  -- The original is bounded exactly like the translated text it accompanies.
  -- Without this an utterance could carry an arbitrarily large second payload,
  -- doubling every persisted row and every replayed broadcast frame.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.live_utterances'::regclass
      and conname = 'live_utterances_source_text_check'
  ) then
    alter table public.live_utterances
      add constraint live_utterances_source_text_check
      check (source_text is null or (
        char_length(btrim(source_text)) between 1 and 8000
        and octet_length(source_text) <= 24000
      ));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.live_utterances'::regclass
      and conname = 'live_utterances_source_language_check'
  ) then
    alter table public.live_utterances
      add constraint live_utterances_source_language_check
      check (source_language is null or source_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$');
  end if;
end;
$$;

comment on column public.live_utterances.source_text is
  'What the speaker actually said, when text is a translation of it. Null on the source-language row, where text already IS the original.';
comment on column public.live_utterances.source_language is
  'Normalized language the utterance was recognized in, or null when the provider reported none.';

-- Provenance overload. It delegates to the participant-attribution overload so
-- the live/language/seq/byte gates keep living in exactly one place, then
-- patches provenance onto the stored row.
create or replace function public.persist_live_utterance_if_active(
  p_session_id uuid,
  p_language text,
  p_seq bigint,
  p_text text,
  p_speaker_label text,
  p_speaker_name text,
  p_source_started_at timestamptz,
  p_source_ended_at timestamptz,
  p_emitted_at timestamptz,
  p_participant_id uuid,
  p_source_text text,
  p_source_language text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored boolean;
  clean_source_text text;
  clean_source_language text;
begin
  stored := public.persist_live_utterance_if_active(
    p_session_id, p_language, p_seq, p_text, p_speaker_label, p_speaker_name,
    p_source_started_at, p_source_ended_at, p_emitted_at, p_participant_id
  );
  if not stored then
    return stored;
  end if;

  -- Provenance is strictly supplementary: a blank, oversized, or malformed
  -- original degrades to null rather than discarding a caption that is already
  -- persisted and already broadcast.
  clean_source_text := nullif(btrim(coalesce(p_source_text, '')), '');
  if clean_source_text is not null and (
    char_length(clean_source_text) > 8000 or octet_length(clean_source_text) > 24000
  ) then
    clean_source_text := null;
  end if;
  clean_source_language := nullif(btrim(coalesce(p_source_language, '')), '');
  if clean_source_language is not null
    and clean_source_language !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
  then
    clean_source_language := null;
  end if;

  if clean_source_text is null and clean_source_language is null then
    return stored;
  end if;

  update public.live_utterances
  set source_text = coalesce(clean_source_text, source_text),
      source_language = coalesce(clean_source_language, source_language)
  where session_id = p_session_id
    and language = p_language
    and seq = p_seq;
  return stored;
exception
  when check_violation or invalid_text_representation then
    -- The caption row itself is already committed by the delegate; a bad
    -- provenance patch must not turn a recorded utterance into a failure.
    return stored;
end;
$$;

revoke all on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz, timestamptz, uuid, text, text
) to service_role;

-- Development verification after applying to a linked development project:
-- 1. Existing live_utterances rows are unchanged and source_text is null.
-- 2. A translated caption stores both text and source_text; the source-language
--    row stores text with source_text null.
-- 3. Repeating the same (session_id, language, seq) stays idempotent and still
--    returns true.
-- 4. A 30,000-byte p_source_text returns true and leaves source_text null
--    rather than failing the caption.
-- 5. anon/authenticated cannot execute any persist_live_utterance_if_active
--    overload, including this one.

-- ===================================================================
-- supabase/migrations/202607250002_live_snapshot_caption_provenance.sql
-- ===================================================================
-- 2026-07-25 fix: Accept the caption shape the gateway actually publishes.
--
-- persist_live_snapshot_if_active enforced an EXACT key allowlist of nine keys:
--   not (p_event ?& array[...9]) or (p_event - array[...9]) <> '{}'::jsonb
-- The publisher, however, has always included `sourceStartedAt` —
-- resolveSourceStartedAt (media-gateway/src/live-media-pipeline.js) returns null
-- rather than undefined, so JSON.stringify always emits the key — and speakers
-- for participant floor captions additionally carry name/department/jobTitle.
-- Every such event therefore failed the allowlist and returned false, which
-- SupabaseLivePublisher escalates to SESSION_STOPPED.
--
-- 202607250001 added sourceText/sourceLanguage/translationStatus to the same
-- event, so the allowlist has to widen for the viewer's 원문보기 disclosure to
-- survive a reconnect via the snapshot at all.
--
-- Widening is NOT loosening: required keys stay required, unknown keys are
-- still rejected, every newly accepted field is type-, length-, and byte-
-- checked, and the townhall voice-mode invariants are preserved verbatim.

create or replace function public.persist_live_snapshot_if_active(
  p_session_id uuid,
  p_language text,
  p_event jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_status text;
  session_mode text;
  session_voice_output_mode text;
  session_languages text[];
  event_seq bigint;
  sanitized_speaker jsonb;
  sanitized_event jsonb;
  source_ended_at timestamptz;
  emitted_at timestamptz;
  speaker_last_seen_at timestamptz;
begin
  select
    session_row.status,
    session_row.mode,
    session_row.voice_output_mode,
    session_row.languages
  into
    session_status,
    session_mode,
    session_voice_output_mode,
    session_languages
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.expires_at > statement_timestamp()
  for update;

  if not found
    or session_status <> 'live'
    or p_language is null
    or not (p_language = any(session_languages))
  then
    return false;
  end if;

  if p_event is null
    or jsonb_typeof(p_event) <> 'object'
    -- Raised from 32768: text and sourceText are each bounded at 24000 bytes,
    -- so the old cap could not hold a legitimate bilingual caption.
    or octet_length(p_event::text) > 65536
    or not (p_event ?& array[
      'type', 'seq', 'sessionId', 'language', 'speaker', 'text',
      'isFinal', 'sourceEndedAt', 'emittedAt'
    ])
    or (p_event - array[
      'type', 'seq', 'sessionId', 'language', 'speaker', 'text',
      'isFinal', 'sourceEndedAt', 'emittedAt',
      'sourceStartedAt', 'sourceText', 'sourceLanguage', 'translationStatus'
    ]::text[]) <> '{}'::jsonb
    or jsonb_typeof(p_event -> 'type') <> 'string'
    or p_event ->> 'type' <> 'caption'
    or jsonb_typeof(p_event -> 'seq') <> 'number'
    or (p_event ->> 'seq') !~ '^[0-9]{1,19}$'
    or jsonb_typeof(p_event -> 'sessionId') <> 'string'
    or p_event ->> 'sessionId' <> p_session_id::text
    or jsonb_typeof(p_event -> 'language') <> 'string'
    or p_event ->> 'language' <> p_language
    or jsonb_typeof(p_event -> 'text') <> 'string'
    or length(btrim(p_event ->> 'text')) not between 1 and 8000
    or octet_length(p_event ->> 'text') > 24000
    or p_event -> 'isFinal' <> 'true'::jsonb
    or jsonb_typeof(p_event -> 'sourceEndedAt') <> 'string'
    or (p_event ->> 'sourceEndedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
    or jsonb_typeof(p_event -> 'emittedAt') <> 'string'
    or (p_event ->> 'emittedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
    -- Optional provenance: absent or json null is fine, a present value must be
    -- well-formed. sourceText carries the same bounds as text.
    or jsonb_typeof(p_event -> 'sourceStartedAt') not in ('string', 'null', 'undefined')
    or (
      jsonb_typeof(p_event -> 'sourceStartedAt') = 'string'
      and (p_event ->> 'sourceStartedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
    )
    or jsonb_typeof(p_event -> 'sourceText') not in ('string', 'null', 'undefined')
    or (
      jsonb_typeof(p_event -> 'sourceText') = 'string'
      and (
        length(btrim(p_event ->> 'sourceText')) not between 1 and 8000
        or octet_length(p_event ->> 'sourceText') > 24000
      )
    )
    or jsonb_typeof(p_event -> 'sourceLanguage') not in ('string', 'null', 'undefined')
    or (
      jsonb_typeof(p_event -> 'sourceLanguage') = 'string'
      and (p_event ->> 'sourceLanguage') !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
    )
    or jsonb_typeof(p_event -> 'translationStatus') not in ('string', 'null', 'undefined')
    or (
      jsonb_typeof(p_event -> 'translationStatus') = 'string'
      and p_event ->> 'translationStatus' not in (
        'verbatim', 'translated', 'failed'
      )
    )
  then
    return false;
  end if;

  if (p_event ->> 'seq')::numeric > 9223372036854775807 then
    return false;
  end if;
  event_seq := (p_event ->> 'seq')::bigint;
  if event_seq < 1 then
    return false;
  end if;

  begin
    source_ended_at := (p_event ->> 'sourceEndedAt')::timestamptz;
    emitted_at := (p_event ->> 'emittedAt')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    return false;
  end;
  if source_ended_at is null or emitted_at is null then
    return false;
  end if;

  if p_event -> 'speaker' = 'null'::jsonb then
    sanitized_speaker := 'null'::jsonb;
  else
    if jsonb_typeof(p_event -> 'speaker') <> 'object'
      or not ((p_event -> 'speaker') ?& array[
        'speakerId', 'label', 'colorToken', 'voiceName', 'voiceStatus', 'lastSeenAt'
      ])
      -- Participant floor captions carry identity alongside the presentation
      -- fields; rejecting them made every attributed caption unpersistable.
      or ((p_event -> 'speaker') - array[
        'speakerId', 'label', 'colorToken', 'voiceName', 'voiceStatus', 'lastSeenAt',
        'name', 'department', 'jobTitle'
      ]::text[]) <> '{}'::jsonb
      or jsonb_typeof(p_event -> 'speaker' -> 'speakerId') <> 'string'
      or (p_event -> 'speaker' ->> 'speakerId') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
      or jsonb_typeof(p_event -> 'speaker' -> 'label') <> 'string'
      or length(btrim(p_event -> 'speaker' ->> 'label')) not between 1 and 80
      or octet_length(p_event -> 'speaker' ->> 'label') > 240
      or jsonb_typeof(p_event -> 'speaker' -> 'colorToken') <> 'string'
      or p_event -> 'speaker' ->> 'colorToken' not in (
        'speaker-blue', 'speaker-red', 'speaker-green',
        'speaker-purple', 'speaker-orange', 'speaker-teal'
      )
      or jsonb_typeof(p_event -> 'speaker' -> 'voiceStatus') <> 'string'
      or p_event -> 'speaker' ->> 'voiceStatus' not in (
        'disabled', 'analyzing', 'ready', 'unavailable'
      )
      or jsonb_typeof(p_event -> 'speaker' -> 'voiceName') not in ('string', 'null')
      or (
        jsonb_typeof(p_event -> 'speaker' -> 'voiceName') = 'string'
        and (p_event -> 'speaker' ->> 'voiceName') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      )
      or (
        p_event -> 'speaker' ->> 'voiceStatus' = 'ready'
        and jsonb_typeof(p_event -> 'speaker' -> 'voiceName') <> 'string'
      )
      or jsonb_typeof(p_event -> 'speaker' -> 'lastSeenAt') <> 'string'
      or (p_event -> 'speaker' ->> 'lastSeenAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
      -- Identity bounds mirror live_participants / floor_display_name: no
      -- control characters, no angle brackets, same lengths as the join form.
      or jsonb_typeof(p_event -> 'speaker' -> 'name') not in ('string', 'null', 'undefined')
      or (
        jsonb_typeof(p_event -> 'speaker' -> 'name') = 'string'
        and (
          length(btrim(p_event -> 'speaker' ->> 'name')) not between 1 and 40
          or (p_event -> 'speaker' ->> 'name') ~ '[[:cntrl:]]'
          or (p_event -> 'speaker' ->> 'name') ~ '[<>]'
        )
      )
      or jsonb_typeof(p_event -> 'speaker' -> 'department') not in ('string', 'null', 'undefined')
      or (
        jsonb_typeof(p_event -> 'speaker' -> 'department') = 'string'
        and (
          length(btrim(p_event -> 'speaker' ->> 'department')) not between 1 and 80
          or (p_event -> 'speaker' ->> 'department') ~ '[[:cntrl:]]'
          or (p_event -> 'speaker' ->> 'department') ~ '[<>]'
        )
      )
      or jsonb_typeof(p_event -> 'speaker' -> 'jobTitle') not in ('string', 'null', 'undefined')
      or (
        jsonb_typeof(p_event -> 'speaker' -> 'jobTitle') = 'string'
        and (
          length(btrim(p_event -> 'speaker' ->> 'jobTitle')) not between 1 and 100
          or (p_event -> 'speaker' ->> 'jobTitle') ~ '[[:cntrl:]]'
          or (p_event -> 'speaker' ->> 'jobTitle') ~ '[<>]'
        )
      )
    then
      return false;
    end if;

    begin
      speaker_last_seen_at := (p_event -> 'speaker' ->> 'lastSeenAt')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      return false;
    end;
    if speaker_last_seen_at is null then
      return false;
    end if;

    if (session_mode <> 'townhall' or session_voice_output_mode = 'captions')
      and (
        p_event -> 'speaker' ->> 'voiceStatus' <> 'disabled'
        or p_event -> 'speaker' -> 'voiceName' <> 'null'::jsonb
      )
    then
      return false;
    end if;

    if session_mode = 'townhall' and session_voice_output_mode = 'fixed_voice'
      and (
        p_event -> 'speaker' ->> 'voiceStatus' <> 'ready'
        or jsonb_typeof(p_event -> 'speaker' -> 'voiceName') <> 'string'
      )
    then
      return false;
    end if;

    if session_mode = 'townhall' and session_voice_output_mode = 'auto_voice'
      and (
        p_event -> 'speaker' ->> 'voiceStatus' = 'disabled'
        or (
          p_event -> 'speaker' ->> 'voiceStatus' = 'ready'
          and jsonb_typeof(p_event -> 'speaker' -> 'voiceName') <> 'string'
        )
        or (
          p_event -> 'speaker' ->> 'voiceStatus' in ('analyzing', 'unavailable')
          and p_event -> 'speaker' -> 'voiceName' <> 'null'::jsonb
        )
      )
    then
      return false;
    end if;

    -- voiceName is deliberately kept as raw jsonb (string OR null): the viewer
    -- contract validates its presence, so it must not be stripped away.
    sanitized_speaker := jsonb_build_object(
      'speakerId', p_event -> 'speaker' ->> 'speakerId',
      'label', btrim(p_event -> 'speaker' ->> 'label'),
      'colorToken', p_event -> 'speaker' ->> 'colorToken',
      'voiceName', p_event -> 'speaker' -> 'voiceName',
      'voiceStatus', p_event -> 'speaker' ->> 'voiceStatus',
      'lastSeenAt', p_event -> 'speaker' ->> 'lastSeenAt'
    );
    -- Identity fields are appended only when actually present, so a
    -- presentation speaker keeps exactly the six-key shape it has today.
    if jsonb_typeof(p_event -> 'speaker' -> 'name') = 'string' then
      sanitized_speaker := sanitized_speaker
        || jsonb_build_object('name', btrim(p_event -> 'speaker' ->> 'name'));
    end if;
    if jsonb_typeof(p_event -> 'speaker' -> 'department') = 'string' then
      sanitized_speaker := sanitized_speaker
        || jsonb_build_object('department', btrim(p_event -> 'speaker' ->> 'department'));
    end if;
    if jsonb_typeof(p_event -> 'speaker' -> 'jobTitle') = 'string' then
      sanitized_speaker := sanitized_speaker
        || jsonb_build_object('jobTitle', btrim(p_event -> 'speaker' ->> 'jobTitle'));
    end if;
  end if;

  -- Provenance is rebuilt explicitly rather than passed through, so a stored
  -- snapshot can never contain a key this function did not validate.
  sanitized_event := jsonb_build_object(
    'type', 'caption',
    'seq', event_seq,
    'sessionId', p_session_id::text,
    'language', p_language,
    'speaker', sanitized_speaker,
    'text', btrim(p_event ->> 'text'),
    'isFinal', true,
    'sourceStartedAt', case
      when jsonb_typeof(p_event -> 'sourceStartedAt') = 'string'
      then to_jsonb(p_event ->> 'sourceStartedAt')
      else 'null'::jsonb
    end,
    'sourceText', case
      when jsonb_typeof(p_event -> 'sourceText') = 'string'
      then to_jsonb(btrim(p_event ->> 'sourceText'))
      else 'null'::jsonb
    end,
    'sourceLanguage', case
      when jsonb_typeof(p_event -> 'sourceLanguage') = 'string'
      then to_jsonb(p_event ->> 'sourceLanguage')
      else 'null'::jsonb
    end,
    'translationStatus', case
      when jsonb_typeof(p_event -> 'translationStatus') = 'string'
      then to_jsonb(p_event ->> 'translationStatus')
      else 'null'::jsonb
    end,
    'sourceEndedAt', p_event ->> 'sourceEndedAt',
    'emittedAt', p_event ->> 'emittedAt'
  );

  insert into public.live_snapshots (
    session_id, language, last_seq, captions, speaker_legend, updated_at
  ) values (
    p_session_id, p_language, event_seq, jsonb_build_array(sanitized_event),
    '[]'::jsonb, statement_timestamp()
  )
  on conflict (session_id, language) do update
    set last_seq = excluded.last_seq,
        captions = excluded.captions,
        updated_at = statement_timestamp()
    where public.live_snapshots.last_seq < excluded.last_seq;

  return true;
exception
  when check_violation or unique_violation or invalid_text_representation then
    return false;
end;
$$;

revoke all on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  to service_role;

-- Development verification after applying to a linked development project:
-- 1. A finalized caption carrying sourceStartedAt: null now returns true; before
--    this migration the identical event returned false.
-- 2. A participant caption whose speaker carries name/department/jobTitle
--    returns true and the stored snapshot retains those three fields.
-- 3. A translated caption stores sourceText/sourceLanguage/translationStatus,
--    and GET /api/live-sessions/<id>/snapshot returns them to the viewer.
-- 4. An event with any unknown top-level key, or an unknown speaker key, still
--    returns false.
-- 5. A 30,000-byte sourceText and a translationStatus of 'bogus' both return
--    false rather than persisting.
-- 6. A non-townhall session still rejects a speaker whose voiceStatus is not
--    'disabled' or whose voiceName is non-null.
-- 7. anon/authenticated cannot execute the function.
