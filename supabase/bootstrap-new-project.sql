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

-- ===================================================================
-- supabase/migrations/202607260001_live_caption_identity_provenance.sql
-- ===================================================================
-- 2026-07-26 fix: Preserve canonical source-lane and utterance identity
-- provenance through both snapshot fallback and utterance-row replay.
--
-- 202607250002 predates the meeting-input `origin` and `utteranceKey` fields.
-- Its exact JSON allowlist therefore rejects those otherwise-valid finalized
-- captions. This migration keeps the already-applied function untouched in
-- history: it moves that implementation behind a private helper, recreates the
-- public RPC as a validating wrapper, and adds nullable row columns plus a new
-- persistence overload for lossless replay.
--
-- Existing rows remain valid with null provenance. Exact identity cannot be
-- backfilled safely, because neither source_text nor timestamps distinguish all
-- repeated utterances. Null therefore explicitly means "legacy/unknown".

alter table public.live_utterances
  add column if not exists origin text,
  add column if not exists utterance_key text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.live_utterances'::regclass
      and conname = 'live_utterances_origin_check'
  ) then
    alter table public.live_utterances
      add constraint live_utterances_origin_check
      check (origin is null or origin = 'source');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.live_utterances'::regclass
      and conname = 'live_utterances_utterance_key_check'
  ) then
    alter table public.live_utterances
      add constraint live_utterances_utterance_key_check
      check (utterance_key is null or (
        char_length(utterance_key) between 1 and 200
        and octet_length(utterance_key) <= 600
        and utterance_key !~ '[[:cntrl:]]'
      ));
  end if;
end;
$$;

comment on column public.live_utterances.origin is
  'Canonical caption provenance. source identifies an untranslated input-lane event; null means translated, non-source, or legacy unknown.';
comment on column public.live_utterances.utterance_key is
  'Gateway-generated identity shared by source and translated events for one utterance. Null on rows recorded before identity provenance.';

-- Keep the already-deployed sanitizer as a private implementation. The public
-- wrapper below removes only the two fields it validates itself, so the exact
-- allowlist and every prior security invariant continue to apply unchanged.
alter function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  rename to persist_live_snapshot_if_active_20260725;

revoke all on function public.persist_live_snapshot_if_active_20260725(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

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
  stored boolean;
  event_seq bigint;
  stored_event jsonb;
begin
  if p_event is null
    or jsonb_typeof(p_event) <> 'object'
    or (
      p_event ? 'origin'
      and jsonb_typeof(p_event -> 'origin') not in ('string', 'null')
    )
    or (
      jsonb_typeof(p_event -> 'origin') = 'string'
      and p_event ->> 'origin' <> 'source'
    )
    or (
      p_event ? 'utteranceKey'
      and jsonb_typeof(p_event -> 'utteranceKey') not in ('string', 'null')
    )
    or (
      jsonb_typeof(p_event -> 'utteranceKey') = 'string'
      and (
        char_length(p_event ->> 'utteranceKey') not between 1 and 200
        or octet_length(p_event ->> 'utteranceKey') > 600
        or (p_event ->> 'utteranceKey') ~ '[[:cntrl:]]'
      )
    )
  then
    return false;
  end if;

  stored := public.persist_live_snapshot_if_active_20260725(
    p_session_id,
    p_language,
    p_event - array['origin', 'utteranceKey']::text[]
  );
  if not stored then
    return false;
  end if;

  event_seq := (p_event ->> 'seq')::bigint;
  select snapshot_row.captions -> 0
  into stored_event
  from public.live_snapshots snapshot_row
  where snapshot_row.session_id = p_session_id
    and snapshot_row.language = p_language
    and snapshot_row.last_seq = event_seq;

  -- A same-seq retry or an older event may legitimately leave no row to patch.
  -- The delegated function already made the authoritative store/no-store
  -- decision, so provenance remains supplementary and cannot fail the caption.
  if stored_event is null then
    return true;
  end if;
  -- Canonical identity is first-write immutable. A same-seq retry may fill a
  -- legacy/missing field, but it must never replace provenance already stored
  -- for that (session, language, seq). Conflicting retries remain idempotent:
  -- return true while preserving the first accepted value.
  if not (stored_event ? 'origin')
    and jsonb_typeof(p_event -> 'origin') = 'string'
  then
    stored_event := stored_event
      || jsonb_build_object('origin', p_event ->> 'origin');
  end if;
  if not (stored_event ? 'utteranceKey')
    and jsonb_typeof(p_event -> 'utteranceKey') = 'string'
  then
    stored_event := stored_event
      || jsonb_build_object('utteranceKey', p_event ->> 'utteranceKey');
  end if;

  update public.live_snapshots
  set captions = jsonb_build_array(stored_event)
  where session_id = p_session_id
    and language = p_language
    and last_seq = event_seq;
  return true;
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$$;

revoke all on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  to service_role;

-- New overload only; every older caller remains valid. It delegates all
-- caption/session/participant gates to the 202607250001 overload and patches
-- the two supplementary fields onto the row selected by its unique key.
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
  p_source_language text,
  p_origin text,
  p_utterance_key text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored boolean;
  clean_origin text;
  clean_utterance_key text;
begin
  stored := public.persist_live_utterance_if_active(
    p_session_id, p_language, p_seq, p_text, p_speaker_label, p_speaker_name,
    p_source_started_at, p_source_ended_at, p_emitted_at, p_participant_id,
    p_source_text, p_source_language
  );
  if not stored then
    return false;
  end if;

  clean_origin := case when p_origin = 'source' then 'source' else null end;
  clean_utterance_key := nullif(btrim(coalesce(p_utterance_key, '')), '');
  if clean_utterance_key is not null and (
    char_length(clean_utterance_key) > 200
    or octet_length(clean_utterance_key) > 600
    or clean_utterance_key ~ '[[:cntrl:]]'
  ) then
    clean_utterance_key := null;
  end if;

  if clean_origin is null and clean_utterance_key is null then
    return true;
  end if;
  update public.live_utterances
  -- Existing non-null provenance wins so an idempotent same-seq retry cannot
  -- relabel a committed source or correlate it to a different utterance.
  set origin = coalesce(origin, clean_origin),
      utterance_key = coalesce(utterance_key, clean_utterance_key)
  where session_id = p_session_id
    and language = p_language
    and seq = p_seq;
  return true;
exception
  when check_violation or invalid_text_representation then
    return stored;
end;
$$;

revoke all on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz, timestamptz,
  uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz, timestamptz,
  uuid, text, text, text, text
) to service_role;

-- Development verification after applying to a linked development project:
-- 1. Existing rows remain unchanged with origin/utterance_key null.
-- 2. A source final carrying origin:source and utteranceKey returns true; its
--    snapshot and live_utterances row retain both fields.
-- 3. A translated sibling with the same utteranceKey retains the key and null
--    origin, allowing exact cross-lane correlation without text deduplication.
-- 4. Unknown snapshot keys, origin values other than source, control characters,
--    and an utteranceKey over 200 characters return false for the snapshot.
-- 5. anon/authenticated cannot execute either public persistence RPC.

-- ===================================================================
-- supabase/migrations/202607260002_drop_legacy_realtime_policies.sql
-- ===================================================================
-- 2026-07-26 security: Converge every database on gateway-only Live delivery.
--
-- 202607190002 retired these temporary realtime.messages policies after media
-- delivery moved to the authenticated media gateway. An obsolete block in the
-- pause migration attempted to ALTER them again: fresh migration replay failed
-- because they no longer existed, while a database that skipped the retirement
-- could retain direct Broadcast access. The historical pause artifact now
-- leaves them absent; this convergence migration handles already-applied
-- databases without assuming whether a policy currently exists.

drop policy if exists live_broadcast_viewer_receive on realtime.messages;
drop policy if exists live_broadcast_host_receive on realtime.messages;
drop policy if exists live_broadcast_host_send on realtime.messages;

-- Development verification after applying to a linked development project:
-- select count(*) = 0 as gateway_is_only_live_transport
-- from pg_policies
-- where schemaname = 'realtime'
--   and tablename = 'messages'
--   and policyname in (
--     'live_broadcast_viewer_receive',
--     'live_broadcast_host_receive',
--     'live_broadcast_host_send'
--   );

-- ===================================================================
-- supabase/migrations/202607260003_live_utterance_replay_provenance.sql
-- ===================================================================
-- 2026-07-26 fix: Preserve the live translation decision in durable replay.
-- Existing rows remain null and continue through the application reader's
-- legacy source_text-based inference. New rows retain the exact live status so
-- a failed target-language caption cannot reappear as a translation later.

alter table public.live_utterances
  add column if not exists translation_status text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.live_utterances'::regclass
      and conname = 'live_utterances_translation_status_check'
  ) then
    alter table public.live_utterances
      add constraint live_utterances_translation_status_check
      check (translation_status is null or translation_status in ('verbatim', 'translated', 'failed'));
  end if;
end;
$$;

comment on column public.live_utterances.translation_status is
  'Exact live caption translation decision. Null means legacy/unknown and is inferred by readers from existing provenance.';

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
  p_source_language text,
  p_origin text,
  p_utterance_key text,
  p_translation_status text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored boolean;
  clean_translation_status text;
begin
  stored := public.persist_live_utterance_if_active(
    p_session_id, p_language, p_seq, p_text, p_speaker_label, p_speaker_name,
    p_source_started_at, p_source_ended_at, p_emitted_at, p_participant_id,
    p_source_text, p_source_language, p_origin, p_utterance_key
  );
  if not stored then
    return false;
  end if;

  clean_translation_status := case
    when p_translation_status in ('verbatim', 'translated', 'failed') then p_translation_status
    else null
  end;
  if clean_translation_status is null then
    return true;
  end if;

  update public.live_utterances
  set translation_status = coalesce(translation_status, clean_translation_status)
  where session_id = p_session_id
    and language = p_language
    and seq = p_seq;
  return true;
exception
  when check_violation or invalid_text_representation then
    return stored;
end;
$$;

revoke all on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz, timestamptz,
  uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz, timestamptz,
  uuid, text, text, text, text, text
) to service_role;

-- Rollback is application-first: older readers ignore this nullable column and
-- older RPC overloads remain available. Do not drop the column or function.

-- 20260726061310_live_snapshot_participant_marker.sql
-- 2026-07-26 fix: Accept the validated participant marker in caption snapshots.
--
-- Participant SpeakerAssignment objects carry isParticipant:true. The deployed
-- 202607250002 sanitizer intentionally rejects every unknown speaker key, and
-- the 202607260001 provenance wrapper strips only origin/utteranceKey. A valid
-- participant final therefore returned false from the snapshot guard before
-- live fanout and durable utterance persistence, which surfaced as the false
-- SESSION_STOPPED failure while the database session was still live.
--
-- Keep exact unknown-key rejection: this wrapper validates one optional nested
-- boolean, removes only that key before delegating every existing invariant,
-- then restores the validated value onto the stored snapshot event.

alter function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  rename to persist_live_snapshot_if_active_202607260001;

revoke all on function public.persist_live_snapshot_if_active_202607260001(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

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
  stored boolean;
  event_seq bigint;
  participant_marker jsonb;
  stored_event jsonb;
begin
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    return false;
  end if;

  if jsonb_typeof(p_event -> 'speaker') = 'object'
    and (p_event -> 'speaker') ? 'isParticipant'
  then
    participant_marker := p_event -> 'speaker' -> 'isParticipant';
    if jsonb_typeof(participant_marker) <> 'boolean' then
      return false;
    end if;
  end if;

  stored := public.persist_live_snapshot_if_active_202607260001(
    p_session_id,
    p_language,
    p_event #- array['speaker', 'isParticipant']::text[]
  );
  if not stored or participant_marker is null then
    return stored;
  end if;

  event_seq := (p_event ->> 'seq')::bigint;
  select snapshot_row.captions -> 0
  into stored_event
  from public.live_snapshots snapshot_row
  where snapshot_row.session_id = p_session_id
    and snapshot_row.language = p_language
    and snapshot_row.last_seq = event_seq;

  -- Same-seq and older retries may legitimately leave nothing to patch. When
  -- a marker is already present, first-write identity remains immutable.
  if stored_event is null
    or jsonb_typeof(stored_event -> 'speaker') <> 'object'
    or (stored_event -> 'speaker') ? 'isParticipant'
  then
    return true;
  end if;

  stored_event := jsonb_set(
    stored_event,
    array['speaker', 'isParticipant']::text[],
    participant_marker,
    true
  );
  update public.live_snapshots
  set captions = jsonb_build_array(stored_event)
  where session_id = p_session_id
    and language = p_language
    and last_seq = event_seq;
  return true;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$$;

revoke all on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  to service_role;

-- Rollback is application-first. The wrapper and private predecessor are
-- additive function definitions; do not drop either during an incident.

-- 20260726064308_atomic_live_final_caption.sql
-- 2026-07-26 fix: Commit the active snapshot guard and full utterance row in
-- one transaction before a finalized caption is delivered.
--
-- The former two-request path could commit live_snapshots, fan out the final,
-- and then lose live_utterances to a timeout. This additive RPC delegates all
-- validation and authorization to the current public wrappers. A stopped or
-- expired session remains the expected false result from the snapshot guard;
-- every utterance or sequence failure raises so PostgreSQL rolls back the
-- snapshot write from the same transaction.

create or replace function public.persist_live_final_caption_if_active(
  p_session_id uuid,
  p_language text,
  p_event jsonb,
  p_seq bigint,
  p_text text,
  p_speaker_label text,
  p_speaker_name text,
  p_source_started_at timestamptz,
  p_source_ended_at timestamptz,
  p_emitted_at timestamptz,
  p_participant_id uuid,
  p_source_text text,
  p_source_language text,
  p_origin text,
  p_utterance_key text,
  p_translation_status text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  snapshot_stored boolean;
  utterance_stored boolean;
  last_utterance_seq bigint;
begin
  snapshot_stored := public.persist_live_snapshot_if_active(
    p_session_id,
    p_language,
    p_event
  );
  if not snapshot_stored then
    return false;
  end if;

  -- The snapshot validator proved the JSON seq is a positive bigint. Requiring
  -- the explicit utterance argument to match prevents one atomic call from
  -- recording two different identities.
  if (p_event ->> 'seq')::bigint <> p_seq then
    raise exception using
      errcode = 'P0001',
      message = 'LIVE_FINAL_SEQUENCE_MISMATCH';
  end if;

  select max(utterance_row.seq)
  into last_utterance_seq
  from public.live_utterances utterance_row
  where utterance_row.session_id = p_session_id
    and utterance_row.language = p_language;

  -- Same/older seq calls remain idempotent through the delegated unique key.
  -- A new seq may advance by exactly one only. Without this guard, a failed N
  -- followed by successful N+1 would permanently turn one request failure into
  -- a replay hole.
  if p_seq > coalesce(last_utterance_seq, 0) + 1 then
    raise exception using
      errcode = 'P0001',
      message = 'LIVE_FINAL_SEQUENCE_GAP';
  end if;

  utterance_stored := public.persist_live_utterance_if_active(
    p_session_id,
    p_language,
    p_seq,
    p_text,
    p_speaker_label,
    p_speaker_name,
    p_source_started_at,
    p_source_ended_at,
    p_emitted_at,
    p_participant_id,
    p_source_text,
    p_source_language,
    p_origin,
    p_utterance_key,
    p_translation_status
  );
  if not utterance_stored then
    raise exception using
      errcode = 'P0001',
      message = 'LIVE_FINAL_UTTERANCE_PERSIST_FAILED';
  end if;

  return true;
end;
$$;

revoke all on function public.persist_live_final_caption_if_active(
  uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz,
  timestamptz, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.persist_live_final_caption_if_active(
  uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz,
  timestamptz, uuid, text, text, text, text, text
) to service_role;

-- Rollback is application-first: the previous snapshot and utterance RPCs stay
-- available for older binaries. Do not drop this additive combined RPC.

-- 20260726201500_live_caption_lane_reconciliation.sql
-- 2026-07-26 fix: Reconcile an ambiguous final-caption timeout against the
-- serialized durable lane before the gateway decides which sequence is next.
--
-- The atomic writer and this reader both lock the same live_sessions row. A
-- reconciliation that starts after a timed-out request therefore observes
-- either its committed utterance or its completed rollback, never an
-- in-flight guess. The RPC is additive and service-role-only; it does not
-- modify snapshots, utterances, or session state.

create or replace function public.reconcile_live_caption_lane(
  p_session_id uuid,
  p_language text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_status text;
  session_languages text[];
  last_utterance_seq bigint;
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
  then
    return null;
  end if;

  select coalesce(max(utterance_row.seq), 0)
  into last_utterance_seq
  from public.live_utterances utterance_row
  where utterance_row.session_id = p_session_id
    and utterance_row.language = p_language;

  return jsonb_build_object(
    'max_seq', last_utterance_seq
  );
end;
$$;

revoke all on function public.reconcile_live_caption_lane(uuid, text)
  from public, anon, authenticated;
grant execute on function public.reconcile_live_caption_lane(uuid, text)
  to service_role;

-- Rollback is application-first: older gateway binaries ignore this additive
-- RPC. Keep the function in place so a rolling rollback remains compatible.

-- 20260726203000_live_snapshot_speaker_overlay_metadata.sql
-- 2026-07-26 fix: Preserve the four bounded speaker-overlay fields emitted by
-- Live Call while keeping the established snapshot sanitizer fail-closed for
-- every unknown top-level key.
--
-- The production pipeline began attaching these fields to finalized captions,
-- but the exact allowlist correctly rejected them because the database contract
-- had not moved with the event contract. Since the atomic final RPC persists
-- the snapshot before the utterance, that rejection rolled back both records.

alter function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  rename to persist_live_snapshot_if_active_20260726061310;

revoke all on function public.persist_live_snapshot_if_active_20260726061310(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

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
  stored boolean;
  event_seq bigint;
  metadata_present boolean;
  overlay_metadata jsonb;
  stored_event jsonb;
begin
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    return false;
  end if;

  metadata_present := p_event ? 'speakerRole'
    or p_event ? 'speakerName'
    or p_event ? 'speakerDepartment'
    or p_event ? 'speakerJobTitle';

  -- Metadata is one coherent tuple. Partial tuples, nulls, markup, control
  -- characters, and values outside the UI identity bounds fail closed.
  if metadata_present and (
    not (p_event ?& array[
      'speakerRole', 'speakerName', 'speakerDepartment', 'speakerJobTitle'
    ])
    or jsonb_typeof(p_event -> 'speakerRole') <> 'string'
    or p_event ->> 'speakerRole' not in ('host', 'participant')
    or jsonb_typeof(p_event -> 'speakerName') <> 'string'
    or char_length(btrim(p_event ->> 'speakerName')) not between 1 and 40
    or octet_length(p_event ->> 'speakerName') > 120
    or (p_event ->> 'speakerName') ~ '[[:cntrl:]]'
    or (p_event ->> 'speakerName') ~ '[<>]'
    or jsonb_typeof(p_event -> 'speakerDepartment') <> 'string'
    or char_length(p_event ->> 'speakerDepartment') > 80
    or octet_length(p_event ->> 'speakerDepartment') > 240
    or (p_event ->> 'speakerDepartment') ~ '[[:cntrl:]]'
    or (p_event ->> 'speakerDepartment') ~ '[<>]'
    or jsonb_typeof(p_event -> 'speakerJobTitle') <> 'string'
    or char_length(p_event ->> 'speakerJobTitle') > 100
    or octet_length(p_event ->> 'speakerJobTitle') > 300
    or (p_event ->> 'speakerJobTitle') ~ '[[:cntrl:]]'
    or (p_event ->> 'speakerJobTitle') ~ '[<>]'
    or (
      p_event ->> 'speakerRole' = 'host'
      and (
        p_event ->> 'speakerName' <> 'Host'
        or p_event ->> 'speakerDepartment' <> ''
        or p_event ->> 'speakerJobTitle' <> ''
      )
    )
  ) then
    return false;
  end if;

  stored := public.persist_live_snapshot_if_active_20260726061310(
    p_session_id,
    p_language,
    p_event - array[
      'speakerRole', 'speakerName', 'speakerDepartment', 'speakerJobTitle'
    ]::text[]
  );
  if not stored or not metadata_present then
    return stored;
  end if;

  event_seq := (p_event ->> 'seq')::bigint;
  select snapshot_row.captions -> 0
  into stored_event
  from public.live_snapshots snapshot_row
  where snapshot_row.session_id = p_session_id
    and snapshot_row.language = p_language
    and snapshot_row.last_seq = event_seq;

  -- Same-seq and older retries keep first-write identity immutable. The prior
  -- sanitizer already decided whether this event was current enough to store.
  if stored_event is null
    or stored_event ? 'speakerRole'
    or stored_event ? 'speakerName'
    or stored_event ? 'speakerDepartment'
    or stored_event ? 'speakerJobTitle'
  then
    return true;
  end if;

  overlay_metadata := jsonb_build_object(
    'speakerRole', p_event ->> 'speakerRole',
    'speakerName', btrim(p_event ->> 'speakerName'),
    'speakerDepartment', btrim(p_event ->> 'speakerDepartment'),
    'speakerJobTitle', btrim(p_event ->> 'speakerJobTitle')
  );
  stored_event := stored_event || overlay_metadata;

  update public.live_snapshots
  set captions = jsonb_build_array(stored_event)
  where session_id = p_session_id
    and language = p_language
    and last_seq = event_seq;
  return true;
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$$;

revoke all on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  to service_role;

-- Rollback is application-first. Older gateway binaries do not send these
-- optional fields, so keep this additive wrapper during a rolling rollback.

-- 20260727010000_live_optional_participant_identity.sql
-- 2026-07-27 feat: Keep participant name required while making department and
-- job title optional. Empty optional values are stored canonically as NULL;
-- existing v3 redemption signatures and service-role boundaries stay intact.

alter table public.live_participants
  alter column department drop not null,
  alter column job_title drop not null;

alter table public.live_participants
  drop constraint if exists live_participants_identity_check;

alter table public.live_participants
  add constraint live_participants_identity_check check (
    char_length(display_name) between 1 and 40
    and display_name = normalize(btrim(display_name), NFC)
    and display_name !~ '[[:cntrl:]]'
    and display_name !~ '[<>]'
    and (
      department is null or (
        char_length(department) between 1 and 80
        and department = normalize(btrim(department), NFC)
        and department !~ '[[:cntrl:]]'
        and department !~ '[<>]'
      )
    )
    and (
      job_title is null or (
        char_length(job_title) between 1 and 100
        and job_title = normalize(btrim(job_title), NFC)
        and job_title !~ '[[:cntrl:]]'
        and job_title !~ '[<>]'
      )
    )
  );

comment on column public.live_participants.department is
  'Optional NFC-normalized department; omitted or blank input is stored as NULL.';
comment on column public.live_participants.job_title is
  'Optional NFC-normalized job title; omitted or blank input is stored as NULL.';

create or replace function public.apply_live_viewer_grant(
  p_session_id uuid,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_display_name text,
  p_department text,
  p_job_title text
)
returns table (
  grant_id uuid,
  grant_user_id text,
  grant_expires_at timestamptz,
  resolved_viewer_count integer,
  resolved_display_name text,
  resolved_department text,
  resolved_job_title text,
  participant_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  grant_result record;
  normalized_department text;
  normalized_job_title text;
begin
  normalized_department := nullif(normalize(btrim(coalesce(p_department, '')), NFC), '');
  normalized_job_title := nullif(normalize(btrim(coalesce(p_job_title, '')), NFC), '');
  if (
      normalized_department is not null
      and (
        char_length(normalized_department) not between 1 and 80
        or normalized_department ~ '[[:cntrl:]]'
        or normalized_department ~ '[<>]'
      )
    ) or (
      normalized_job_title is not null
      and (
        char_length(normalized_job_title) not between 1 and 100
        or normalized_job_title ~ '[[:cntrl:]]'
        or normalized_job_title ~ '[<>]'
      )
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_PARTICIPANT_IDENTITY';
  end if;

  select * into grant_result
  from public.apply_live_viewer_grant(
    p_session_id, p_user_id, p_device_hash, p_grant_expires_at, p_display_name
  );

  update public.viewer_grants
  set department = normalized_department,
      job_title = normalized_job_title
  where id = grant_result.grant_id;

  insert into public.live_participants as participant_row (
    id, grant_id, session_id, user_id, display_name, department, job_title,
    joined_at, last_seen_at, left_at, retention_expires_at
  ) values (
    grant_result.grant_id, grant_result.grant_id, p_session_id, p_user_id,
    grant_result.resolved_display_name, normalized_department,
    normalized_job_title, statement_timestamp(), statement_timestamp(), null, null
  )
  on conflict (session_id, user_id) do update
    set grant_id = excluded.grant_id,
        display_name = excluded.display_name,
        department = excluded.department,
        job_title = excluded.job_title,
        last_seen_at = statement_timestamp(),
        left_at = null,
        retention_expires_at = null
  returning participant_row.id into participant_id;

  insert into public.live_participant_events (
    participant_id, session_id, event_type, occurred_at
  ) values (
    participant_id, p_session_id, 'joined', statement_timestamp()
  );

  grant_id := grant_result.grant_id;
  grant_user_id := grant_result.grant_user_id;
  grant_expires_at := grant_result.grant_expires_at;
  resolved_viewer_count := grant_result.resolved_viewer_count;
  resolved_display_name := grant_result.resolved_display_name;
  resolved_department := normalized_department;
  resolved_job_title := normalized_job_title;
  return next;
end;
$$;

revoke all on function public.apply_live_viewer_grant(
  uuid, text, text, timestamptz, text, text, text
) from public, anon, authenticated;
grant execute on function public.apply_live_viewer_grant(
  uuid, text, text, timestamptz, text, text, text
) to service_role;

-- 20260727011000_live_cover_20mb.sql
-- Raise only the existing private Live Call cover bucket limit. The image
-- allowlist and private access boundary remain explicit during migration.
update storage.buckets
set file_size_limit = 20971520,
    public = false,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'live-covers';

-- 20260727012000_host_glossary_presets.sql
-- 2026-07-27 feat: Add private, host-owned glossary presets for bilingual live
-- caption configuration. Service-only RPCs keep host identity server-derived,
-- enforce bounded input, and use optimistic versions for safe concurrent edits.

create table public.host_glossary_presets (
  id uuid primary key default gen_random_uuid(),
  host_id text not null,
  name text not null,
  domain text not null default '',
  glossary text not null,
  language_a text not null,
  language_b text not null,
  version integer not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint host_glossary_presets_host_id_check check (
    char_length(host_id) between 1 and 100
    and host_id = btrim(host_id)
    and host_id !~ '[[:cntrl:]]'
  ),
  constraint host_glossary_presets_name_check check (
    char_length(name) between 1 and 80
    and name = btrim(name)
    and name !~ '[[:cntrl:]]'
    and name !~ '[<>]'
  ),
  constraint host_glossary_presets_domain_check check (
    char_length(domain) <= 600
    and domain = btrim(domain)
    and domain !~ '[[:cntrl:]]'
  ),
  constraint host_glossary_presets_glossary_check check (
    char_length(glossary) between 1 and 16000
    and glossary = btrim(glossary)
    and translate(glossary, E'\n\r\t', '') !~ '[[:cntrl:]]'
  ),
  constraint host_glossary_presets_languages_check check (
    public.live_language_valid(language_a)
    and public.live_language_valid(language_b)
    and language_a <> language_b
  ),
  constraint host_glossary_presets_version_check check (version >= 1),
  constraint host_glossary_presets_timestamps_check check (updated_at >= created_at)
);

create unique index host_glossary_presets_host_name_unique
  on public.host_glossary_presets (lower(host_id), lower(name));

create index host_glossary_presets_host_id_idx
  on public.host_glossary_presets (host_id);

alter table public.host_glossary_presets enable row level security;

revoke all on table public.host_glossary_presets
  from public, anon, authenticated, service_role;

create or replace function public.list_host_glossary_presets(
  p_host_id text
)
returns table (
  id uuid,
  name text,
  domain text,
  glossary text,
  language_a text,
  language_b text,
  version integer,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
begin
  clean_host_id := pg_catalog.btrim(pg_catalog.coalesce(p_host_id, ''));
  if pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_HOST_GLOSSARY_PRESET_INPUT';
  end if;

  return query
  select
    preset_row.id,
    preset_row.name,
    preset_row.domain,
    preset_row.glossary,
    preset_row.language_a,
    preset_row.language_b,
    preset_row.version,
    preset_row.updated_at
  from public.host_glossary_presets as preset_row
  where preset_row.host_id = clean_host_id
  order by preset_row.updated_at desc, preset_row.id;
end;
$$;

create or replace function public.create_host_glossary_preset(
  p_host_id text,
  p_name text,
  p_domain text,
  p_glossary text,
  p_language_a text,
  p_language_b text
)
returns table (
  id uuid,
  name text,
  domain text,
  glossary text,
  language_a text,
  language_b text,
  version integer,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  clean_name text;
  clean_domain text;
  clean_glossary text;
  clean_language_a text;
  clean_language_b text;
  preset_count integer;
begin
  clean_host_id := pg_catalog.btrim(pg_catalog.coalesce(p_host_id, ''));
  clean_name := pg_catalog.btrim(pg_catalog.coalesce(p_name, ''));
  clean_domain := pg_catalog.btrim(pg_catalog.coalesce(p_domain, ''));
  clean_glossary := pg_catalog.btrim(pg_catalog.coalesce(p_glossary, ''));
  clean_language_a := pg_catalog.btrim(pg_catalog.coalesce(p_language_a, ''));
  clean_language_b := pg_catalog.btrim(pg_catalog.coalesce(p_language_b, ''));

  if pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_name) not between 1 and 80
    or clean_name ~ '[[:cntrl:]]'
    or clean_name ~ '[<>]'
    or pg_catalog.char_length(clean_domain) > 600
    or clean_domain ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_glossary) not between 1 and 16000
    or pg_catalog.translate(clean_glossary, E'\n\r\t', '') ~ '[[:cntrl:]]'
    or public.live_language_valid(clean_language_a) is not true
    or public.live_language_valid(clean_language_b) is not true
    or clean_language_a = clean_language_b
  then
    raise exception using errcode = '22023', message = 'INVALID_HOST_GLOSSARY_PRESET_INPUT';
  end if;

  -- A host-scoped transaction lock makes count + insert one capacity decision.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(clean_host_id, 0));

  select count(*) into preset_count
  from public.host_glossary_presets as preset_row
  where preset_row.host_id = clean_host_id;

  if preset_count >= 50 then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_LIMIT_REACHED';
  end if;

  return query
  insert into public.host_glossary_presets as preset_row (
    host_id, name, domain, glossary, language_a, language_b
  ) values (
    clean_host_id, clean_name, clean_domain, clean_glossary,
    clean_language_a, clean_language_b
  )
  returning
    preset_row.id,
    preset_row.name,
    preset_row.domain,
    preset_row.glossary,
    preset_row.language_a,
    preset_row.language_b,
    preset_row.version,
    preset_row.updated_at;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NAME_CONFLICT';
end;
$$;

create or replace function public.update_host_glossary_preset(
  p_id uuid,
  p_host_id text,
  p_expected_version integer,
  p_name text,
  p_domain text,
  p_glossary text,
  p_language_a text,
  p_language_b text
)
returns table (
  id uuid,
  name text,
  domain text,
  glossary text,
  language_a text,
  language_b text,
  version integer,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  clean_name text;
  clean_domain text;
  clean_glossary text;
  clean_language_a text;
  clean_language_b text;
  affected_count integer;
  updated_preset public.host_glossary_presets%rowtype;
begin
  clean_host_id := pg_catalog.btrim(pg_catalog.coalesce(p_host_id, ''));
  clean_name := pg_catalog.btrim(pg_catalog.coalesce(p_name, ''));
  clean_domain := pg_catalog.btrim(pg_catalog.coalesce(p_domain, ''));
  clean_glossary := pg_catalog.btrim(pg_catalog.coalesce(p_glossary, ''));
  clean_language_a := pg_catalog.btrim(pg_catalog.coalesce(p_language_a, ''));
  clean_language_b := pg_catalog.btrim(pg_catalog.coalesce(p_language_b, ''));

  if p_id is null
    or p_expected_version is null
    or p_expected_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_name) not between 1 and 80
    or clean_name ~ '[[:cntrl:]]'
    or clean_name ~ '[<>]'
    or pg_catalog.char_length(clean_domain) > 600
    or clean_domain ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_glossary) not between 1 and 16000
    or pg_catalog.translate(clean_glossary, E'\n\r\t', '') ~ '[[:cntrl:]]'
    or public.live_language_valid(clean_language_a) is not true
    or public.live_language_valid(clean_language_b) is not true
    or clean_language_a = clean_language_b
  then
    raise exception using errcode = '22023', message = 'INVALID_HOST_GLOSSARY_PRESET_INPUT';
  end if;

  update public.host_glossary_presets as preset_row
  set name = clean_name,
      domain = clean_domain,
      glossary = clean_glossary,
      language_a = clean_language_a,
      language_b = clean_language_b,
      version = preset_row.version + 1,
      updated_at = statement_timestamp()
  where preset_row.id = p_id
    and preset_row.host_id = clean_host_id
    and preset_row.version = p_expected_version
  returning preset_row.* into updated_preset;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  if affected_count = 0 then
    if exists (
      select 1
      from public.host_glossary_presets as preset_row
      where preset_row.id = p_id
        and preset_row.host_id = clean_host_id
    ) then
      raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_VERSION_CONFLICT';
    end if;
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NOT_FOUND';
  end if;

  return query select
    updated_preset.id,
    updated_preset.name,
    updated_preset.domain,
    updated_preset.glossary,
    updated_preset.language_a,
    updated_preset.language_b,
    updated_preset.version,
    updated_preset.updated_at;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NAME_CONFLICT';
end;
$$;

create or replace function public.delete_host_glossary_preset(
  p_id uuid,
  p_host_id text,
  p_expected_version integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_host_id text;
  affected_count integer;
begin
  clean_host_id := pg_catalog.btrim(pg_catalog.coalesce(p_host_id, ''));
  if p_id is null
    or p_expected_version is null
    or p_expected_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_HOST_GLOSSARY_PRESET_INPUT';
  end if;

  delete from public.host_glossary_presets as preset_row
  where preset_row.id = p_id
    and preset_row.host_id = clean_host_id
    and preset_row.version = p_expected_version;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  if affected_count = 0 then
    if exists (
      select 1
      from public.host_glossary_presets as preset_row
      where preset_row.id = p_id
        and preset_row.host_id = clean_host_id
    ) then
      raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_VERSION_CONFLICT';
    end if;
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NOT_FOUND';
  end if;

  return true;
end;
$$;

revoke all on function public.list_host_glossary_presets(text)
  from public, anon, authenticated;
revoke all on function public.create_host_glossary_preset(text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.update_host_glossary_preset(uuid, text, integer, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.delete_host_glossary_preset(uuid, text, integer)
  from public, anon, authenticated;

grant execute on function public.list_host_glossary_presets(text)
  to service_role;
grant execute on function public.create_host_glossary_preset(text, text, text, text, text, text)
  to service_role;
grant execute on function public.update_host_glossary_preset(uuid, text, integer, text, text, text, text, text)
  to service_role;
grant execute on function public.delete_host_glossary_preset(uuid, text, integer)
  to service_role;

-- Verification (run after applying to a development project only):
-- select has_table_privilege('anon', 'public.host_glossary_presets', 'select'); -- false
-- select has_table_privilege('service_role', 'public.host_glossary_presets', 'select'); -- false
-- select has_function_privilege('authenticated', 'public.list_host_glossary_presets(text)', 'execute'); -- false
-- select has_function_privilege('service_role', 'public.list_host_glossary_presets(text)', 'execute'); -- true
-- select * from public.create_host_glossary_preset('host-1', 'CRE core', '', 'NOI = Net Operating Income', 'en', 'ko');
-- select * from public.list_host_glossary_presets('host-1');
-- Calling update/delete with a stale version must raise GLOSSARY_PRESET_VERSION_CONFLICT.

-- 20260727013000_host_glossary_presets_coalesce_fix.sql
-- 2026-07-27 fix: COALESCE is SQL syntax, not a pg_catalog function. Recreate
-- the four already-deployed glossary RPCs without changing their signatures,
-- ownership predicates, concurrency controls, or least-privilege grants.

create or replace function public.list_host_glossary_presets(
  p_host_id text
)
returns table (
  id uuid,
  name text,
  domain text,
  glossary text,
  language_a text,
  language_b text,
  version integer,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_HOST_GLOSSARY_PRESET_INPUT';
  end if;

  return query
  select
    preset_row.id,
    preset_row.name,
    preset_row.domain,
    preset_row.glossary,
    preset_row.language_a,
    preset_row.language_b,
    preset_row.version,
    preset_row.updated_at
  from public.host_glossary_presets as preset_row
  where preset_row.host_id = clean_host_id
  order by preset_row.updated_at desc, preset_row.id;
end;
$$;

create or replace function public.create_host_glossary_preset(
  p_host_id text,
  p_name text,
  p_domain text,
  p_glossary text,
  p_language_a text,
  p_language_b text
)
returns table (
  id uuid,
  name text,
  domain text,
  glossary text,
  language_a text,
  language_b text,
  version integer,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  clean_name text;
  clean_domain text;
  clean_glossary text;
  clean_language_a text;
  clean_language_b text;
  preset_count integer;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  clean_name := pg_catalog.btrim(coalesce(p_name, ''));
  clean_domain := pg_catalog.btrim(coalesce(p_domain, ''));
  clean_glossary := pg_catalog.btrim(coalesce(p_glossary, ''));
  clean_language_a := pg_catalog.btrim(coalesce(p_language_a, ''));
  clean_language_b := pg_catalog.btrim(coalesce(p_language_b, ''));

  if pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_name) not between 1 and 80
    or clean_name ~ '[[:cntrl:]]'
    or clean_name ~ '[<>]'
    or pg_catalog.char_length(clean_domain) > 600
    or clean_domain ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_glossary) not between 1 and 16000
    or pg_catalog.translate(clean_glossary, E'\n\r\t', '') ~ '[[:cntrl:]]'
    or public.live_language_valid(clean_language_a) is not true
    or public.live_language_valid(clean_language_b) is not true
    or clean_language_a = clean_language_b
  then
    raise exception using errcode = '22023', message = 'INVALID_HOST_GLOSSARY_PRESET_INPUT';
  end if;

  -- A host-scoped transaction lock makes count + insert one capacity decision.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(clean_host_id, 0));

  select count(*) into preset_count
  from public.host_glossary_presets as preset_row
  where preset_row.host_id = clean_host_id;

  if preset_count >= 50 then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_LIMIT_REACHED';
  end if;

  return query
  insert into public.host_glossary_presets as preset_row (
    host_id, name, domain, glossary, language_a, language_b
  ) values (
    clean_host_id, clean_name, clean_domain, clean_glossary,
    clean_language_a, clean_language_b
  )
  returning
    preset_row.id,
    preset_row.name,
    preset_row.domain,
    preset_row.glossary,
    preset_row.language_a,
    preset_row.language_b,
    preset_row.version,
    preset_row.updated_at;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NAME_CONFLICT';
end;
$$;

create or replace function public.update_host_glossary_preset(
  p_id uuid,
  p_host_id text,
  p_expected_version integer,
  p_name text,
  p_domain text,
  p_glossary text,
  p_language_a text,
  p_language_b text
)
returns table (
  id uuid,
  name text,
  domain text,
  glossary text,
  language_a text,
  language_b text,
  version integer,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  clean_name text;
  clean_domain text;
  clean_glossary text;
  clean_language_a text;
  clean_language_b text;
  affected_count integer;
  updated_preset public.host_glossary_presets%rowtype;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  clean_name := pg_catalog.btrim(coalesce(p_name, ''));
  clean_domain := pg_catalog.btrim(coalesce(p_domain, ''));
  clean_glossary := pg_catalog.btrim(coalesce(p_glossary, ''));
  clean_language_a := pg_catalog.btrim(coalesce(p_language_a, ''));
  clean_language_b := pg_catalog.btrim(coalesce(p_language_b, ''));

  if p_id is null
    or p_expected_version is null
    or p_expected_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_name) not between 1 and 80
    or clean_name ~ '[[:cntrl:]]'
    or clean_name ~ '[<>]'
    or pg_catalog.char_length(clean_domain) > 600
    or clean_domain ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_glossary) not between 1 and 16000
    or pg_catalog.translate(clean_glossary, E'\n\r\t', '') ~ '[[:cntrl:]]'
    or public.live_language_valid(clean_language_a) is not true
    or public.live_language_valid(clean_language_b) is not true
    or clean_language_a = clean_language_b
  then
    raise exception using errcode = '22023', message = 'INVALID_HOST_GLOSSARY_PRESET_INPUT';
  end if;

  update public.host_glossary_presets as preset_row
  set name = clean_name,
      domain = clean_domain,
      glossary = clean_glossary,
      language_a = clean_language_a,
      language_b = clean_language_b,
      version = preset_row.version + 1,
      updated_at = statement_timestamp()
  where preset_row.id = p_id
    and preset_row.host_id = clean_host_id
    and preset_row.version = p_expected_version
  returning preset_row.* into updated_preset;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  if affected_count = 0 then
    if exists (
      select 1
      from public.host_glossary_presets as preset_row
      where preset_row.id = p_id
        and preset_row.host_id = clean_host_id
    ) then
      raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_VERSION_CONFLICT';
    end if;
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NOT_FOUND';
  end if;

  return query select
    updated_preset.id,
    updated_preset.name,
    updated_preset.domain,
    updated_preset.glossary,
    updated_preset.language_a,
    updated_preset.language_b,
    updated_preset.version,
    updated_preset.updated_at;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NAME_CONFLICT';
end;
$$;

create or replace function public.delete_host_glossary_preset(
  p_id uuid,
  p_host_id text,
  p_expected_version integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_host_id text;
  affected_count integer;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if p_id is null
    or p_expected_version is null
    or p_expected_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_HOST_GLOSSARY_PRESET_INPUT';
  end if;

  delete from public.host_glossary_presets as preset_row
  where preset_row.id = p_id
    and preset_row.host_id = clean_host_id
    and preset_row.version = p_expected_version;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  if affected_count = 0 then
    if exists (
      select 1
      from public.host_glossary_presets as preset_row
      where preset_row.id = p_id
        and preset_row.host_id = clean_host_id
    ) then
      raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_VERSION_CONFLICT';
    end if;
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NOT_FOUND';
  end if;

  return true;
end;
$$;

revoke all on function public.list_host_glossary_presets(text)
  from public, anon, authenticated;
revoke all on function public.create_host_glossary_preset(text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.update_host_glossary_preset(uuid, text, integer, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.delete_host_glossary_preset(uuid, text, integer)
  from public, anon, authenticated;

grant execute on function public.list_host_glossary_presets(text)
  to service_role;
grant execute on function public.create_host_glossary_preset(text, text, text, text, text, text)
  to service_role;
grant execute on function public.update_host_glossary_preset(uuid, text, integer, text, text, text, text, text)
  to service_role;
grant execute on function public.delete_host_glossary_preset(uuid, text, integer)
  to service_role;

-- Verification (run after applying to a development project only):
-- select * from public.list_host_glossary_presets('host-1');
-- Expected: zero or more rows, never SQLSTATE 42883 for pg_catalog.coalesce.

-- 20260727014000_live_summary_generation_jobs.sql
-- 2026-07-27 feat: Make post-session summary generation a single-winner,
-- durable state transition. The table is private; service code may only claim,
-- complete, or fail one immutable session-language generation through RPCs.

create table public.live_summary_generation_jobs (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  language text not null,
  status text not null default 'running',
  generation_token uuid not null unique,
  error_code text,
  created_at timestamptz not null default statement_timestamp(),
  started_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  failed_at timestamptz,
  primary key (session_id, language),
  constraint live_summary_generation_jobs_language_check check (
    public.live_language_valid(language)
  ),
  constraint live_summary_generation_jobs_status_check check (
    status in ('running', 'succeeded', 'failed')
  ),
  constraint live_summary_generation_jobs_error_code_check check (
    error_code is null
    or (
      char_length(error_code) between 1 and 120
      and error_code = btrim(error_code)
      and error_code !~ '[[:cntrl:]]'
    )
  ),
  constraint live_summary_generation_jobs_state_check check (
    (
      status = 'running'
      and error_code is null
      and completed_at is null
      and failed_at is null
    )
    or (
      status = 'succeeded'
      and error_code is null
      and completed_at is not null
      and failed_at is null
    )
    or (
      status = 'failed'
      and error_code is not null
      and completed_at is null
      and failed_at is not null
    )
  ),
  constraint live_summary_generation_jobs_timestamps_check check (
    started_at >= created_at
    and updated_at >= created_at
    and (completed_at is null or completed_at >= started_at)
    and (failed_at is null or failed_at >= started_at)
  )
);

alter table public.live_summary_generation_jobs enable row level security;

revoke all on table public.live_summary_generation_jobs
  from public, anon, authenticated, service_role;

create or replace function public.claim_live_summary_generation(
  p_session_id uuid,
  p_language text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_status text;
  job_status text;
  claimed_token uuid;
begin
  if p_session_id is null
    or public.live_language_valid(p_language) is not true
  then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SUMMARY_GENERATION_INPUT');
  end if;

  select session_row.status
  into session_status
  from public.live_sessions as session_row
  where session_row.id = p_session_id;

  if session_status is null then
    return jsonb_build_object('ok', false, 'code', 'LIVE_SESSION_NOT_FOUND');
  end if;
  if session_status <> 'stopped' then
    return jsonb_build_object('ok', false, 'code', 'LIVE_SESSION_NOT_STOPPED');
  end if;

  -- The lock covers the decision and insert. A concurrent loser observes the
  -- committed row after waiting and therefore neither allocates nor stores a
  -- second token. The primary key remains the independent database invariant.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_session_id::text || ':' || p_language, 0)
  );

  if exists (
    select 1
    from public.live_meeting_summaries as summary_row
    where summary_row.session_id = p_session_id
      and summary_row.language = p_language
  ) then
    return jsonb_build_object('ok', true, 'status', 'ready');
  end if;

  select job_row.status
  into job_status
  from public.live_summary_generation_jobs as job_row
  where job_row.session_id = p_session_id
    and job_row.language = p_language;

  if job_status = 'running' then
    return jsonb_build_object('ok', true, 'status', 'running');
  end if;
  if job_status = 'failed' then
    return jsonb_build_object('ok', true, 'status', 'failed');
  end if;
  if job_status = 'succeeded' then
    -- Completion writes the summary and state in one transaction, so a
    -- succeeded job has the same externally observable meaning as ready.
    return jsonb_build_object('ok', true, 'status', 'ready');
  end if;

  claimed_token := extensions.gen_random_uuid();
  insert into public.live_summary_generation_jobs (
    session_id,
    language,
    status,
    generation_token
  ) values (
    p_session_id,
    p_language,
    'running',
    claimed_token
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'claimed',
    'generationToken', claimed_token::text
  );
end;
$$;

create or replace function public.complete_live_summary_generation(
  p_session_id uuid,
  p_language text,
  p_generation_token uuid,
  p_summary jsonb,
  p_model text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_count integer;
begin
  if p_session_id is null
    or p_generation_token is null
    or public.live_language_valid(p_language) is not true
    or p_summary is null
    or jsonb_typeof(p_summary) <> 'object'
    or octet_length(p_summary::text) > 65536
    or p_model is null
    or char_length(p_model) not between 1 and 120
    or p_model <> btrim(p_model)
    or p_model ~ '[[:cntrl:]]'
  then
    return false;
  end if;

  update public.live_summary_generation_jobs as job_row
  set status = 'succeeded',
      error_code = null,
      completed_at = statement_timestamp(),
      failed_at = null,
      updated_at = statement_timestamp()
  where job_row.session_id = p_session_id
    and job_row.language = p_language
    and job_row.generation_token = p_generation_token
    and job_row.status = 'running';

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  if affected_count = 0 then
    return false;
  end if;

  -- PostgreSQL functions execute inside the caller transaction. A summary
  -- constraint or upsert failure rolls the succeeded transition back as well.
  insert into public.live_meeting_summaries (
    session_id,
    language,
    summary,
    model,
    updated_at
  ) values (
    p_session_id,
    p_language,
    p_summary,
    p_model,
    statement_timestamp()
  )
  on conflict (session_id, language) do update
  set summary = excluded.summary,
      model = excluded.model,
      updated_at = statement_timestamp();

  return true;
end;
$$;

create or replace function public.fail_live_summary_generation(
  p_session_id uuid,
  p_language text,
  p_generation_token uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_count integer;
begin
  if p_session_id is null
    or p_generation_token is null
    or public.live_language_valid(p_language) is not true
    or p_error_code is null
    or char_length(p_error_code) not between 1 and 120
    or p_error_code <> btrim(p_error_code)
    or p_error_code ~ '[[:cntrl:]]'
  then
    return false;
  end if;

  update public.live_summary_generation_jobs as job_row
  set status = 'failed',
      error_code = p_error_code,
      completed_at = null,
      failed_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where job_row.session_id = p_session_id
    and job_row.language = p_language
    and job_row.generation_token = p_generation_token
    and job_row.status = 'running';

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  return affected_count = 1;
end;
$$;

revoke all on function public.claim_live_summary_generation(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_live_summary_generation(uuid, text, uuid, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.fail_live_summary_generation(uuid, text, uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.claim_live_summary_generation(uuid, text)
  to service_role;
grant execute on function public.complete_live_summary_generation(uuid, text, uuid, jsonb, text)
  to service_role;
grant execute on function public.fail_live_summary_generation(uuid, text, uuid, text)
  to service_role;

-- Verification (run after applying to a development project only):
-- 1. End a development session and call claim twice concurrently. Exactly one
--    response is claimed with a token; the other is running without a token.
-- 2. Complete with a different UUID -> false and no summary row. Complete with
--    the claimed token -> true, one summary row, and succeeded job state.
-- 3. Direct authenticated/service-role table access remains denied; only these
--    three RPCs are executable by service_role.

-- 20260729235900_live_summary_generation_recovery.sql
-- 2026-07-29 fix: Recover abandoned or transiently failed summary jobs without
-- permitting two workers to complete the same attempt. Existing RPC signatures
-- stay stable while a five-minute lease and generation token fence every claim.

alter table public.live_summary_generation_jobs
  add column attempt_count integer,
  add column lease_expires_at timestamptz,
  add column next_retry_at timestamptz,
  add column retryable boolean;

update public.live_summary_generation_jobs
set attempt_count = 1,
    lease_expires_at = started_at + interval '5 minutes',
    next_retry_at = null,
    retryable = false;

alter table public.live_summary_generation_jobs
  alter column attempt_count set default 1,
  alter column attempt_count set not null,
  alter column lease_expires_at set default (statement_timestamp() + interval '5 minutes'),
  alter column lease_expires_at set not null,
  alter column retryable set default false,
  alter column retryable set not null,
  add constraint live_summary_generation_jobs_attempt_count_check check (
    attempt_count between 1 and 3
  ),
  add constraint live_summary_generation_jobs_lease_check check (
    lease_expires_at >= started_at
  ),
  add constraint live_summary_generation_jobs_retry_state_check check (
    (
      retryable = false
      and next_retry_at is null
    )
    or (
      status = 'failed'
      and retryable = true
      and attempt_count < 3
      and next_retry_at is not null
    )
  ),
  add constraint live_summary_generation_jobs_retry_error_check check (
    retryable = false
    or error_code in (
      'SUMMARY_TIMEOUT',
      'SUMMARY_PROVIDER_RATE_LIMITED',
      'SUMMARY_PROVIDER_UNAVAILABLE',
      'SUMMARY_INCOMPLETE',
      'UTTERANCES_READ_FAILED',
      'PARTICIPANT_ACTIVITY_READ_FAILED'
    )
  );

create or replace function public.claim_live_summary_generation(
  p_session_id uuid,
  p_language text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_status text;
  job_status text;
  job_generation_token uuid;
  job_attempt_count integer;
  job_lease_expires_at timestamptz;
  job_next_retry_at timestamptz;
  job_retryable boolean;
  claimed_token uuid;
  affected_count integer;
begin
  if p_session_id is null
    or public.live_language_valid(p_language) is not true
  then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SUMMARY_GENERATION_INPUT');
  end if;

  select session_row.status
  into session_status
  from public.live_sessions as session_row
  where session_row.id = p_session_id;

  if session_status is null then
    return jsonb_build_object('ok', false, 'code', 'LIVE_SESSION_NOT_FOUND');
  end if;
  if session_status <> 'stopped' then
    return jsonb_build_object('ok', false, 'code', 'LIVE_SESSION_NOT_STOPPED');
  end if;

  -- One session-language lane makes claim and reclaim decisions serial. The
  -- token-and-attempt compare-and-set remains an independent stale-writer fence.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_session_id::text || ':' || p_language, 0)
  );

  if exists (
    select 1
    from public.live_meeting_summaries as summary_row
    where summary_row.session_id = p_session_id
      and summary_row.language = p_language
  ) then
    return jsonb_build_object('ok', true, 'status', 'ready');
  end if;

  select
    job_row.status,
    job_row.generation_token,
    job_row.attempt_count,
    job_row.lease_expires_at,
    job_row.next_retry_at,
    job_row.retryable
  into
    job_status,
    job_generation_token,
    job_attempt_count,
    job_lease_expires_at,
    job_next_retry_at,
    job_retryable
  from public.live_summary_generation_jobs as job_row
  where job_row.session_id = p_session_id
    and job_row.language = p_language;

  if job_status = 'succeeded' then
    return jsonb_build_object('ok', true, 'status', 'ready');
  end if;

  if job_status = 'running'
    and job_lease_expires_at > statement_timestamp()
  then
    return jsonb_build_object('ok', true, 'status', 'running');
  end if;

  if job_status is not null and job_attempt_count >= 3 then
    if job_status = 'running' then
      update public.live_summary_generation_jobs as job_row
      set status = 'failed',
          error_code = 'SUMMARY_MAX_ATTEMPTS_EXCEEDED',
          retryable = false,
          next_retry_at = null,
          completed_at = null,
          failed_at = statement_timestamp(),
          updated_at = statement_timestamp()
      where job_row.session_id = p_session_id
        and job_row.language = p_language
        and job_row.generation_token = job_generation_token
        and job_row.status = 'running'
        and job_row.lease_expires_at <= statement_timestamp();
    end if;
    return jsonb_build_object(
      'ok', true,
      'status', 'exhausted'
    );
  end if;

  if job_status = 'failed' and job_retryable is not true then
    return jsonb_build_object(
      'ok', true,
      'status', 'permanent_failed'
    );
  end if;

  if job_status = 'failed'
    and job_next_retry_at > statement_timestamp()
  then
    return jsonb_build_object(
      'ok', true,
      'status', 'running'
    );
  end if;

  if (
    job_status = 'running'
    and job_lease_expires_at <= statement_timestamp()
  ) or (
    job_status = 'failed'
    and job_retryable is true
    and job_next_retry_at <= statement_timestamp()
  ) then
    claimed_token := extensions.gen_random_uuid();
    update public.live_summary_generation_jobs as job_row
    set status = 'running',
        generation_token = claimed_token,
        error_code = null,
        attempt_count = job_attempt_count + 1,
        lease_expires_at = statement_timestamp() + interval '5 minutes',
        next_retry_at = null,
        retryable = false,
        started_at = statement_timestamp(),
        updated_at = statement_timestamp(),
        completed_at = null,
        failed_at = null
    where job_row.session_id = p_session_id
      and job_row.language = p_language
      and job_row.generation_token = job_generation_token
      and job_row.attempt_count = job_attempt_count;

    GET DIAGNOSTICS affected_count = ROW_COUNT;
    if affected_count <> 1 then
      return jsonb_build_object('ok', true, 'status', 'running');
    end if;

    return jsonb_build_object(
      'ok', true,
      'status', 'claimed',
      'generationToken', claimed_token::text
    );
  end if;

  if job_status is not null then
    return jsonb_build_object(
      'ok', true,
      'status', 'permanent_failed'
    );
  end if;

  claimed_token := extensions.gen_random_uuid();
  insert into public.live_summary_generation_jobs (
    session_id,
    language,
    status,
    generation_token,
    attempt_count,
    lease_expires_at,
    retryable
  ) values (
    p_session_id,
    p_language,
    'running',
    claimed_token,
    1,
    statement_timestamp() + interval '5 minutes',
    false
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'claimed',
    'generationToken', claimed_token::text
  );
end;
$$;

create or replace function public.complete_live_summary_generation(
  p_session_id uuid,
  p_language text,
  p_generation_token uuid,
  p_summary jsonb,
  p_model text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_count integer;
begin
  if p_session_id is null
    or p_generation_token is null
    or public.live_language_valid(p_language) is not true
    or p_summary is null
    or jsonb_typeof(p_summary) <> 'object'
    or octet_length(p_summary::text) > 65536
    or p_model is null
    or char_length(p_model) not between 1 and 120
    or p_model <> btrim(p_model)
    or p_model ~ '[[:cntrl:]]'
  then
    return false;
  end if;

  update public.live_summary_generation_jobs as job_row
  set status = 'succeeded',
      error_code = null,
      retryable = false,
      next_retry_at = null,
      completed_at = statement_timestamp(),
      failed_at = null,
      updated_at = statement_timestamp()
  where job_row.session_id = p_session_id
    and job_row.language = p_language
    and job_row.generation_token = p_generation_token
    and job_row.status = 'running'
    and job_row.lease_expires_at > statement_timestamp();

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  if affected_count = 0 then
    return false;
  end if;

  insert into public.live_meeting_summaries (
    session_id,
    language,
    summary,
    model,
    updated_at
  ) values (
    p_session_id,
    p_language,
    p_summary,
    p_model,
    statement_timestamp()
  )
  on conflict (session_id, language) do update
  set summary = excluded.summary,
      model = excluded.model,
      updated_at = statement_timestamp();

  return true;
end;
$$;

create or replace function public.fail_live_summary_generation(
  p_session_id uuid,
  p_language text,
  p_generation_token uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_count integer;
  transient_error boolean;
begin
  if p_session_id is null
    or p_generation_token is null
    or public.live_language_valid(p_language) is not true
    or p_error_code is null
    or char_length(p_error_code) not between 1 and 120
    or p_error_code <> btrim(p_error_code)
    or p_error_code ~ '[[:cntrl:]]'
  then
    return false;
  end if;

  transient_error := p_error_code in (
    'SUMMARY_TIMEOUT',
    'SUMMARY_PROVIDER_RATE_LIMITED',
    'SUMMARY_PROVIDER_UNAVAILABLE',
    'SUMMARY_INCOMPLETE',
    'UTTERANCES_READ_FAILED',
    'PARTICIPANT_ACTIVITY_READ_FAILED'
  );

  update public.live_summary_generation_jobs as job_row
  set status = 'failed',
      error_code = p_error_code,
      retryable = transient_error and job_row.attempt_count < 3,
      next_retry_at = case
        when transient_error and job_row.attempt_count < 3
          then statement_timestamp()
        else null
      end,
      completed_at = null,
      failed_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where job_row.session_id = p_session_id
    and job_row.language = p_language
    and job_row.generation_token = p_generation_token
    and job_row.status = 'running'
    and job_row.lease_expires_at > statement_timestamp();

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  return affected_count = 1;
end;
$$;

create or replace function public.read_live_summary_generation_status(
  p_session_id uuid,
  p_language text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_status text;
  job_error_code text;
  job_attempt_count integer;
  job_lease_expires_at timestamptz;
  job_retryable boolean;
begin
  if p_session_id is null
    or public.live_language_valid(p_language) is not true
  then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SUMMARY_GENERATION_INPUT');
  end if;

  if exists (
    select 1
    from public.live_meeting_summaries as summary_row
    where summary_row.session_id = p_session_id
      and summary_row.language = p_language
  ) then
    return jsonb_build_object('ok', true, 'status', 'ready');
  end if;

  select
    job_row.status,
    job_row.error_code,
    job_row.attempt_count,
    job_row.lease_expires_at,
    job_row.retryable
  into
    job_status,
    job_error_code,
    job_attempt_count,
    job_lease_expires_at,
    job_retryable
  from public.live_summary_generation_jobs as job_row
  where job_row.session_id = p_session_id
    and job_row.language = p_language;

  if job_status is null then
    return jsonb_build_object('ok', true, 'status', 'missing');
  end if;

  if job_status = 'succeeded' then
    return jsonb_build_object('ok', false, 'code', 'SUMMARY_READY_MISSING');
  end if;

  if job_status = 'running' then
    if job_lease_expires_at > statement_timestamp() then
      return jsonb_build_object('ok', true, 'status', 'running');
    end if;
    if job_attempt_count >= 3 then
      return jsonb_build_object('ok', true, 'status', 'exhausted');
    end if;
    return jsonb_build_object('ok', true, 'status', 'retryable_failed');
  end if;

  if job_status = 'failed' then
    if job_attempt_count >= 3
      or job_error_code = 'SUMMARY_MAX_ATTEMPTS_EXCEEDED'
    then
      return jsonb_build_object('ok', true, 'status', 'exhausted');
    end if;
    if job_retryable is true then
      return jsonb_build_object('ok', true, 'status', 'retryable_failed');
    end if;
    return jsonb_build_object('ok', true, 'status', 'permanent_failed');
  end if;

  return jsonb_build_object('ok', false, 'code', 'SUMMARY_GENERATION_STATE_INVALID');
end;
$$;

revoke all on function public.claim_live_summary_generation(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_live_summary_generation(uuid, text, uuid, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.fail_live_summary_generation(uuid, text, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.read_live_summary_generation_status(uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.claim_live_summary_generation(uuid, text)
  to service_role;
grant execute on function public.complete_live_summary_generation(uuid, text, uuid, jsonb, text)
  to service_role;
grant execute on function public.fail_live_summary_generation(uuid, text, uuid, text)
  to service_role;
grant execute on function public.read_live_summary_generation_status(uuid, text)
  to service_role;

-- Verification (development project only): expire attempt one and claim twice
-- concurrently. Exactly one caller receives the new token. The old token must
-- return false from both complete and fail, and attempt four is never allocated.

-- ===================================================================
-- supabase/migrations/202608150001_live_attendee_admission.sql

-- 2026-08-15 feat: Add attendee email admission without treating email as
-- identity proof. Existing v3 admission RPCs stay in place; the v1 attendee RPC
-- is the new atomic boundary for email/company/summary consent.

alter table public.live_participants
  add column if not exists email text,
  add column if not exists company text,
  add column if not exists summary_consent_at timestamptz;

create or replace function public.is_valid_live_attendee_email_atom(
  p_value text,
  p_allow_local_symbols boolean
)
returns boolean
language plpgsql
security definer
immutable
set search_path = ''
as $$
declare
  char_text text;
  codepoint integer;
begin
  if p_value is null or p_value = '' then
    return false;
  end if;

  foreach char_text in array regexp_split_to_array(p_value, '') loop
    codepoint := ascii(char_text);

    if codepoint between 48 and 57
      or codepoint between 65 and 90
      or codepoint between 97 and 122
      or codepoint between 192 and 687
      or codepoint between 768 and 879
      or codepoint between 4352 and 4607
      or codepoint between 12592 and 12687
      or codepoint between 44032 and 55203
    then
      continue;
    end if;

    if p_allow_local_symbols
      and position(char_text in '!#$%&''*+/=?^_`{|}~.-') > 0
    then
      continue;
    end if;

    if not p_allow_local_symbols and char_text = '-' then
      continue;
    end if;

    return false;
  end loop;

  return true;
end;
$$;

create or replace function public.is_valid_live_attendee_email(
  p_email text
)
returns boolean
language plpgsql
security definer
immutable
set search_path = ''
as $$
declare
  normalized_email text;
  local_part text;
  domain_part text;
  domain_labels text[];
  label_text text;
begin
  if p_email is null then
    return false;
  end if;

  normalized_email := lower(normalize(btrim(p_email), NFC));
  if p_email <> normalized_email
    or char_length(normalized_email) > 254
    or normalized_email ~ '[[:space:][:cntrl:]<>]'
    or length(normalized_email) - length(replace(normalized_email, '@', '')) <> 1
  then
    return false;
  end if;

  local_part := split_part(normalized_email, '@', 1);
  domain_part := split_part(normalized_email, '@', 2);
  if char_length(local_part) not between 1 and 64
    or char_length(domain_part) > 253
    or char_length(domain_part) < 3
    or local_part like '.%'
    or local_part like '%.'
    or local_part like '%..%'
    or not public.is_valid_live_attendee_email_atom(local_part, true)
  then
    return false;
  end if;

  domain_labels := string_to_array(domain_part, '.');
  if array_length(domain_labels, 1) < 2 then
    return false;
  end if;

  foreach label_text in array domain_labels loop
    if char_length(label_text) not between 1 and 63
      or label_text like '-%'
      or label_text like '%-'
      or not public.is_valid_live_attendee_email_atom(label_text, false)
    then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

alter table public.live_participants
  drop constraint if exists live_participants_attendee_profile_check;

alter table public.live_participants
  add constraint live_participants_attendee_profile_check check (
    (
      email is null or public.is_valid_live_attendee_email(email)
    )
    and (
      company is null or (
        char_length(company) between 1 and 100
        and company = normalize(btrim(company), NFC)
        and company !~ '[[:cntrl:]]'
        and company !~ '[<>]'
      )
    )
  );

comment on column public.live_participants.email is
  'Nullable for legacy rows; new attendee admission stores canonical lowercase delivery email only.';
comment on column public.live_participants.company is
  'Optional NFC-normalized company supplied at attendee admission.';
comment on column public.live_participants.summary_consent_at is
  'Monotonic opt-in timestamp for later summary delivery; false joins keep it null.';

create or replace function public.mask_live_attendee_email(
  p_email text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  local_part text;
  domain_part text;
  masked_email text;
begin
  if p_email is null or position('@' in p_email) <= 1 then
    raise exception using errcode = '22023', message = 'INVALID_ATTENDEE_EMAIL';
  end if;
  local_part := split_part(p_email, '@', 1);
  domain_part := split_part(p_email, '@', 2);
  if local_part = '' or domain_part = '' then
    raise exception using errcode = '22023', message = 'INVALID_ATTENDEE_EMAIL';
  end if;
  masked_email := left(local_part, 1) || '***@' || domain_part;
  if char_length(masked_email) <= 40 then
    return masked_email;
  end if;
  return left(local_part, 1) || '***@' || left(domain_part, 34) || '…';
end;
$$;

create or replace function public.apply_live_attendee_grant(
  p_session_id uuid,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_email text,
  p_company text,
  p_department text,
  p_job_title text,
  p_summary_consent boolean
)
returns table (
  grant_id uuid,
  grant_user_id text,
  grant_expires_at timestamptz,
  resolved_viewer_count integer,
  resolved_display_name text,
  resolved_email text,
  resolved_company text,
  resolved_department text,
  resolved_job_title text,
  resolved_summary_consent_at timestamptz,
  participant_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  grant_result record;
  normalized_email text;
  normalized_company text;
  normalized_department text;
  normalized_job_title text;
begin
  normalized_email := lower(normalize(btrim(coalesce(p_email, '')), NFC));
  normalized_company := nullif(normalize(btrim(coalesce(p_company, '')), NFC), '');
  normalized_department := nullif(normalize(btrim(coalesce(p_department, '')), NFC), '');
  normalized_job_title := nullif(normalize(btrim(coalesce(p_job_title, '')), NFC), '');

  if p_summary_consent is null
    or not public.is_valid_live_attendee_email(normalized_email)
    or (
      normalized_company is not null
      and (
        char_length(normalized_company) not between 1 and 100
        or normalized_company ~ '[[:cntrl:]]'
        or normalized_company ~ '[<>]'
      )
    )
    or (
      normalized_department is not null
      and (
        char_length(normalized_department) not between 1 and 80
        or normalized_department ~ '[[:cntrl:]]'
        or normalized_department ~ '[<>]'
      )
    )
    or (
      normalized_job_title is not null
      and (
        char_length(normalized_job_title) not between 1 and 100
        or normalized_job_title ~ '[[:cntrl:]]'
        or normalized_job_title ~ '[<>]'
      )
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_ATTENDEE_PROFILE';
  end if;

  select * into grant_result
  from public.apply_live_viewer_grant(
    p_session_id,
    p_user_id,
    p_device_hash,
    p_grant_expires_at,
    public.mask_live_attendee_email(normalized_email),
    normalized_department,
    normalized_job_title
  );

  update public.live_participants as participant_row
  set display_name = public.mask_live_attendee_email(normalized_email),
      email = normalized_email,
      company = normalized_company,
      department = normalized_department,
      job_title = normalized_job_title,
      summary_consent_at = case
        when participant_row.email is distinct from normalized_email
          and p_summary_consent is true
          then statement_timestamp()
        when participant_row.email is distinct from normalized_email
          then null
        when p_summary_consent is true
          then coalesce(participant_row.summary_consent_at, statement_timestamp())
        else participant_row.summary_consent_at
      end
  where participant_row.id = grant_result.participant_id
  returning participant_row.summary_consent_at into resolved_summary_consent_at;

  grant_id := grant_result.grant_id;
  grant_user_id := grant_result.grant_user_id;
  grant_expires_at := grant_result.grant_expires_at;
  resolved_viewer_count := grant_result.resolved_viewer_count;
  resolved_display_name := public.mask_live_attendee_email(normalized_email);
  resolved_email := normalized_email;
  resolved_company := normalized_company;
  resolved_department := normalized_department;
  resolved_job_title := normalized_job_title;
  participant_id := grant_result.participant_id;
  return next;
end;
$$;

create or replace function public.redeem_live_attendee_v1(
  p_invite_token_hmac text,
  p_code_hmac text,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_email text,
  p_company text,
  p_department text,
  p_job_title text,
  p_summary_consent boolean
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
  email text,
  company text,
  department text,
  job_title text,
  summary_consent_at timestamptz,
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
  resolved_session_id uuid;
  session_row public.live_sessions%rowtype;
  grant_result record;
begin
  if (p_invite_token_hmac is null) = (p_code_hmac is null)
    or (p_invite_token_hmac is not null and p_invite_token_hmac !~ '^[0-9a-f]{64}$')
    or (p_code_hmac is not null and p_code_hmac !~ '^[0-9a-f]{64}$')
  then
    raise exception using errcode = '22023', message = 'INVALID_ATTENDEE_CREDENTIAL';
  end if;

  if p_invite_token_hmac is not null then
    resolved_session_id := public.lock_live_invite_session(p_invite_token_hmac);
    select * into session_row
    from public.live_sessions
    where id = resolved_session_id
    for update;
  else
    select * into session_row
    from public.live_sessions
    where admission_code_hmac = p_code_hmac
    for update;
    if not found
      or session_row.admission_state <> 'open'
      or session_row.admission_open_until <= statement_timestamp()
      or session_row.status not in ('preparing', 'live')
      or session_row.expires_at <= statement_timestamp()
    then
      raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
    end if;
  end if;

  select * into grant_result
  from public.apply_live_attendee_grant(
    session_row.id,
    p_user_id,
    p_device_hash,
    p_grant_expires_at,
    p_email,
    p_company,
    p_department,
    p_job_title,
    p_summary_consent
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
  email := grant_result.resolved_email;
  company := grant_result.resolved_company;
  department := grant_result.resolved_department;
  job_title := grant_result.resolved_job_title;
  summary_consent_at := grant_result.resolved_summary_consent_at;
  participant_id := grant_result.participant_id;
  voice_provider := session_row.voice_provider;
  status := session_row.status;
  title := session_row.title;
  scheduled_at := session_row.scheduled_at;
  return next;
end;
$$;

create or replace function public.restore_live_attendee_v1(
  p_grant_id uuid,
  p_session_id uuid,
  p_user_id text
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
  email text,
  company text,
  department text,
  job_title text,
  summary_consent_at timestamptz,
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
declare
  restore_row record;
begin
  if p_grant_id is null
    or p_session_id is null
    or p_user_id is null
    or char_length(p_user_id) not between 1 and 256
  then
    raise exception using errcode = '22023', message = 'INVALID_ATTENDEE_RESTORE';
  end if;

  select
    grant_row.id as grant_id,
    grant_row.user_id as grant_user_id,
    grant_row.expires_at as grant_expires_at,
    session_row.id as session_id,
    session_row.session_type,
    session_row.output_mode,
    session_row.languages,
    session_row.expires_at as session_expires_at,
    session_row.viewer_count,
    session_row.max_viewers,
    session_row.glossary_pack,
    session_row.voice_provider,
    session_row.status,
    session_row.title,
    session_row.scheduled_at,
    participant_row.id as participant_id,
    participant_row.email,
    participant_row.company,
    participant_row.department,
    participant_row.job_title,
    participant_row.summary_consent_at
  into restore_row
  from public.viewer_grants grant_row
  join public.live_sessions session_row
    on session_row.id = grant_row.session_id
  join public.live_participants participant_row
    on participant_row.grant_id = grant_row.id
   and participant_row.session_id = p_session_id
   and participant_row.user_id = p_user_id
   and participant_row.email is not null
   and (
     participant_row.retention_expires_at is null
     or participant_row.retention_expires_at > statement_timestamp()
   )
  where grant_row.id = p_grant_id
    and grant_row.session_id = p_session_id
    and grant_row.user_id = p_user_id
    and grant_row.revoked_at is null
    and grant_row.expires_at > statement_timestamp()
    and session_row.status in ('preparing', 'live', 'paused')
    and session_row.expires_at > statement_timestamp();
  if not found then
    raise exception using errcode = 'P0001', message = 'VIEWER_RESTORE_FORBIDDEN';
  end if;

  grant_id := restore_row.grant_id;
  session_id := restore_row.session_id;
  user_id := restore_row.grant_user_id;
  grant_expires_at := restore_row.grant_expires_at;
  session_type := restore_row.session_type;
  output_mode := restore_row.output_mode;
  languages := restore_row.languages;
  session_expires_at := restore_row.session_expires_at;
  viewer_count := restore_row.viewer_count;
  max_viewers := restore_row.max_viewers;
  glossary_pack := restore_row.glossary_pack;
  display_name := public.mask_live_attendee_email(restore_row.email);
  email := restore_row.email;
  company := restore_row.company;
  department := restore_row.department;
  job_title := restore_row.job_title;
  summary_consent_at := restore_row.summary_consent_at;
  participant_id := restore_row.participant_id;
  voice_provider := restore_row.voice_provider;
  status := restore_row.status;
  title := restore_row.title;
  scheduled_at := restore_row.scheduled_at;
  return next;
end;
$$;
drop function if exists public.read_live_participant_roster(uuid, text);

create or replace function public.read_live_participant_roster(
  p_session_id uuid,
  p_host_id text
)
returns table (
  participant_id uuid,
  grant_id uuid,
  user_id text,
  display_name text,
  email text,
  company text,
  department text,
  job_title text,
  summary_consent_at timestamptz,
  joined_at timestamptz,
  last_seen_at timestamptz,
  left_at timestamptz,
  last_spoke_at timestamptz,
  utterance_count integer,
  speaking_seconds numeric,
  retention_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_session_id is null
    or p_host_id is null
    or char_length(p_host_id) not between 1 and 256
  then
    raise exception using errcode = '22023', message = 'INVALID_ROSTER_INPUT';
  end if;
  if not exists (
    select 1
    from public.live_sessions session_row
    where session_row.id = p_session_id
      and session_row.host_id = p_host_id
  ) then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;

  return query
  select participant_row.id,
    participant_row.grant_id,
    participant_row.user_id,
    participant_row.display_name,
    participant_row.email,
    participant_row.company,
    participant_row.department,
    participant_row.job_title,
    participant_row.summary_consent_at,
    participant_row.joined_at,
    participant_row.last_seen_at,
    participant_row.left_at,
    participant_row.last_spoke_at,
    participant_row.utterance_count,
    participant_row.speaking_seconds,
    participant_row.retention_expires_at
  from public.live_participants participant_row
  where participant_row.session_id = p_session_id
    and (
      participant_row.retention_expires_at is null
      or participant_row.retention_expires_at > statement_timestamp()
    )
  order by participant_row.joined_at, participant_row.id;
end;
$$;

revoke all on function public.is_valid_live_attendee_email_atom(text, boolean)
  from public, anon, authenticated;
revoke all on function public.is_valid_live_attendee_email(text)
  from public, anon, authenticated;
revoke all on function public.mask_live_attendee_email(text)
  from public, anon, authenticated;
revoke all on function public.apply_live_attendee_grant(
  uuid, text, text, timestamptz, text, text, text, text, boolean
) from public, anon, authenticated;
revoke all on function public.redeem_live_attendee_v1(
  text, text, text, text, timestamptz, text, text, text, text, boolean
) from public, anon, authenticated;
revoke all on function public.restore_live_attendee_v1(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.read_live_participant_roster(uuid, text)
  from public, anon, authenticated;

grant execute on function public.is_valid_live_attendee_email_atom(text, boolean)
  to service_role;
grant execute on function public.is_valid_live_attendee_email(text)
  to service_role;
grant execute on function public.mask_live_attendee_email(text)
  to service_role;
grant execute on function public.apply_live_attendee_grant(
  uuid, text, text, timestamptz, text, text, text, text, boolean
) to service_role;
grant execute on function public.redeem_live_attendee_v1(
  text, text, text, text, timestamptz, text, text, text, text, boolean
) to service_role;
grant execute on function public.restore_live_attendee_v1(uuid, uuid, text)
  to service_role;
grant execute on function public.read_live_participant_roster(uuid, text)
  to service_role;

-- supabase/migrations/202608150002_live_semantic_topics.sql

-- Phase 2 live semantic topic persistence.
-- Additive only: durable captions remain the source of truth.

create table if not exists public.live_topics (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  ordinal integer not null check (ordinal between 1 and 1000),
  status text not null default 'active',
  title text not null default 'Live topic',
  summary text,
  completion_reason text,
  detector_health text not null default 'healthy',
  version integer not null default 1,
  started_at timestamptz not null default statement_timestamp(),
  last_activity_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (session_id, ordinal),
  constraint live_topics_status_check check (status in ('active', 'completed')),
  constraint live_topics_title_plain_check check (
    char_length(title) between 1 and 120
    and title = normalize(btrim(title), NFC)
    and title !~ '[[:cntrl:]]'
    and title !~ '[<>]'
    and translate(title, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') = title
  ),
  constraint live_topics_summary_plain_check check (
    summary is null
    or (
      char_length(summary) between 1 and 500
      and summary = normalize(btrim(summary), NFC)
      and summary !~ '[[:cntrl:]]'
      and summary !~ '[<>]'
      and translate(summary, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') = summary
    )
  ),
  constraint live_topics_completion_reason_check check (
    completion_reason is null
    or completion_reason in ('silence', 'semantic_shift', 'session_end')
  ),
  constraint live_topics_detector_health_check check (
    detector_health in ('healthy', 'degraded')
  ),
  constraint live_topics_version_check check (version > 0),
  constraint live_topics_completed_shape_check check (
    (
      status = 'active'
      and completion_reason is null
      and completed_at is null
    )
    or (
      status = 'completed'
      and completion_reason is not null
      and completed_at is not null
    )
  )
);

create unique index if not exists live_topics_one_active_partial_idx
  on public.live_topics (session_id)
  where status = 'active';

create index if not exists live_topics_session_status_ordinal_idx
  on public.live_topics (session_id, status, ordinal);

create table if not exists public.live_topic_utterances (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  utterance_key text not null,
  topic_id uuid not null references public.live_topics(id) on delete cascade,
  position integer not null check (position between 1 and 10000),
  source_seq bigint not null check (source_seq > 0),
  source_language text not null,
  assigned_at timestamptz not null default statement_timestamp(),
  primary key (session_id, utterance_key),
  unique (topic_id, position),
  constraint live_topic_utterances_key_check check (
    char_length(utterance_key) between 1 and 256
    and octet_length(utterance_key) <= 768
    and utterance_key = normalize(btrim(utterance_key), NFC)
    and utterance_key !~ '[[:cntrl:]]'
    and utterance_key !~ '[<>]'
    and translate(utterance_key, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') = utterance_key
  )
);

create index if not exists live_topic_utterances_topic_position_idx
  on public.live_topic_utterances (topic_id, position);

create index if not exists live_topic_utterances_session_seq_idx
  on public.live_topic_utterances (session_id, source_language, source_seq);


create table if not exists public.live_topic_processed_utterances (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  utterance_key text not null,
  source_seq bigint not null check (source_seq > 0),
  source_language text not null,
  processed_reason text not null default 'not_meaningful',
  processed_at timestamptz not null default statement_timestamp(),
  primary key (session_id, utterance_key),
  constraint live_topic_processed_utterances_reason_check check (processed_reason in ('not_meaningful')),
  constraint live_topic_processed_utterances_key_check check (
    char_length(utterance_key) between 1 and 256
    and octet_length(utterance_key) <= 768
    and utterance_key = normalize(btrim(utterance_key), NFC)
    and utterance_key !~ '[[:cntrl:]]'
    and utterance_key !~ '[<>]'
    and translate(utterance_key, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') = utterance_key
  )
);

create index if not exists live_topic_processed_utterances_session_seq_idx
  on public.live_topic_processed_utterances (session_id, source_language, source_seq);

alter table public.live_topics enable row level security;
alter table public.live_topic_utterances enable row level security;
alter table public.live_topic_processed_utterances enable row level security;

revoke all on table public.live_topics from public, anon, authenticated;
revoke all on table public.live_topic_utterances from public, anon, authenticated;
revoke all on table public.live_topic_processed_utterances from public, anon, authenticated;
grant select, insert, update, delete on table public.live_topics to service_role;
grant select, insert, update, delete on table public.live_topic_utterances to service_role;
grant select, insert, update, delete on table public.live_topic_processed_utterances to service_role;

create or replace function public.read_live_topic_context(
  p_session_id uuid,
  p_language text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  clean_language text := lower(btrim(coalesce(p_language, '')));
  topic_payload jsonb;
  topic_membership_payload jsonb;
  latest_source_seq bigint;
begin
  if p_session_id is null or not public.live_language_valid(clean_language) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TOPIC_CONTEXT_INPUT');
  end if;

  with bounded_topics as (
    select topic_row.*
    from public.live_topics topic_row
    where topic_row.session_id = p_session_id
    order by topic_row.ordinal desc
    limit 1000
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', bounded_topics.id,
        'session_id', bounded_topics.session_id,
        'ordinal', bounded_topics.ordinal,
        'title', bounded_topics.title,
        'summary', bounded_topics.summary,
        'status', bounded_topics.status,
        'completion_reason', bounded_topics.completion_reason,
        'detector_health', bounded_topics.detector_health,
        'started_at', bounded_topics.started_at,
        'completed_at', bounded_topics.completed_at,
        'version', bounded_topics.version
      )
      order by bounded_topics.ordinal
    ),
    '[]'::jsonb
  )
    into topic_payload
  from bounded_topics;

  with bounded_topics as (
    select topic_row.id, topic_row.ordinal
    from public.live_topics topic_row
    where topic_row.session_id = p_session_id
    order by topic_row.ordinal desc
    limit 1000
  ),
  bounded_memberships as (
    select membership_row.*
    from public.live_topic_utterances membership_row
    join bounded_topics on bounded_topics.id = membership_row.topic_id
    where membership_row.session_id = p_session_id
    order by membership_row.source_seq desc
    limit 12000
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'session_id', bounded_memberships.session_id,
        'topic_id', bounded_memberships.topic_id,
        'utterance_key', bounded_memberships.utterance_key,
        'position', bounded_memberships.position
      )
      order by bounded_memberships.position
    ),
    '[]'::jsonb
  )
    into topic_membership_payload
  from bounded_memberships;

  select coalesce(max(source_utterance.seq), 0)
    into latest_source_seq
  from public.live_utterances source_utterance
  where source_utterance.session_id = p_session_id
    and source_utterance.language = clean_language
    and source_utterance.origin = 'source'
    and source_utterance.utterance_key is not null;

  return jsonb_build_object(
    'ok', true,
    'event', 'topic-upsert',
    'topics', topic_payload,
    'topic_memberships', topic_membership_payload,
    'memberships_added', '[]'::jsonb,
    'latest_source_seq', latest_source_seq
  );
end;
$$;

create or replace function public.apply_live_topic_transition(
  p_session_id uuid,
  p_language text,
  p_utterance_key text,
  p_source_seq bigint,
  p_decision text,
  p_expected_topic_id uuid,
  p_expected_version integer,
  p_title text,
  p_summary text,
  p_detector_health text,
  p_meaningful boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  clean_language text := lower(btrim(coalesce(p_language, '')));
  clean_utterance_key text := normalize(btrim(coalesce(p_utterance_key, '')), NFC);
  raw_title text := nullif(normalize(btrim(coalesce(p_title, '')), NFC), '');
  clean_title text := coalesce(raw_title, 'Live topic');
  clean_summary text := nullif(normalize(btrim(coalesce(p_summary, '')), NFC), '');
  clean_detector_health text := coalesce(nullif(p_detector_health, ''), 'healthy');
  existing_membership record;
  processed_membership record;
  source_utterance record;
  topic_row record;
  target_topic_id uuid;
  target_topic record;
  completed_topic record;
  next_ordinal integer;
  membership_position integer;
  target_topic_payload jsonb;
  completed_topic_payload jsonb;
begin
  if p_session_id is null
    or not public.live_language_valid(clean_language)
    or char_length(clean_utterance_key) not between 1 and 256
    or octet_length(clean_utterance_key) > 768
    or clean_utterance_key ~ '[[:cntrl:]]'
    or clean_utterance_key ~ '[<>]'
    or translate(clean_utterance_key, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') <> clean_utterance_key
    or p_source_seq is null
    or p_source_seq <= 0
    or p_decision not in ('continue', 'shift')
    or clean_detector_health not in ('healthy', 'degraded')
    or p_meaningful is null
    or char_length(clean_title) not between 1 and 120
    or clean_title !~ '[^<>[:cntrl:]]'
    or clean_title ~ '[[:cntrl:]]'
    or clean_title ~ '[<>]'
    or translate(clean_title, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') <> clean_title
    or (
      clean_summary is not null
      and (
        char_length(clean_summary) not between 1 and 500
        or clean_summary ~ '[[:cntrl:]]'
        or clean_summary ~ '[<>]'
        or translate(clean_summary, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') <> clean_summary
      )
    )
  then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TOPIC_TRANSITION_INPUT');
  end if;

  select existing_membership.*
    into existing_membership
  from public.live_topic_utterances existing_membership
  where existing_membership.session_id = p_session_id
    and existing_membership.utterance_key = clean_utterance_key;

  if found then
    select topic_row.*
      into target_topic
    from public.live_topics topic_row
    where topic_row.id = existing_membership.topic_id;

    target_topic_payload := jsonb_build_object(
      'id', target_topic.id,
      'session_id', target_topic.session_id,
      'ordinal', target_topic.ordinal,
      'title', target_topic.title,
      'summary', target_topic.summary,
      'status', target_topic.status,
      'completion_reason', target_topic.completion_reason,
      'detector_health', target_topic.detector_health,
      'started_at', target_topic.started_at,
      'completed_at', target_topic.completed_at,
      'version', target_topic.version
    );

    return jsonb_build_object('ok', true, 'status', 'idempotent',
      'event', 'topic-upsert',
      'topics', jsonb_build_array(target_topic_payload),
      'memberships_added', '[]'::jsonb
    );
  end if;

  select processed_membership.*
    into processed_membership
  from public.live_topic_processed_utterances processed_membership
  where processed_membership.session_id = p_session_id
    and processed_membership.utterance_key = clean_utterance_key;

  if found then
    return jsonb_build_object('ok', true, 'status', 'idempotent',
      'event', 'topic-upsert',
      'topics', '[]'::jsonb,
      'memberships_added', '[]'::jsonb
    );
  end if;

  select source_utterance.*
    into source_utterance
  from public.live_utterances source_utterance
  where source_utterance.session_id = p_session_id
    and source_utterance.language = clean_language
    and source_utterance.origin = 'source'
    and source_utterance.utterance_key = clean_utterance_key
    and source_utterance.seq = p_source_seq;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'SOURCE_FINAL_NOT_DURABLE');
  end if;

  select topic_row.*
    into topic_row
  from public.live_topics topic_row
  where topic_row.session_id = p_session_id
    and topic_row.status = 'active'
  for update;

  if found and (
    p_expected_topic_id is null
    or topic_row.id <> p_expected_topic_id
    or topic_row.version <> p_expected_version
  ) then
    return jsonb_build_object('ok', false, 'code', 'TOPIC_VERSION_CONFLICT');
  end if;

  if p_meaningful is false then
    if not found then
      insert into public.live_topic_processed_utterances (
        session_id,
        utterance_key,
        source_seq,
        source_language
      ) values (
        p_session_id,
        clean_utterance_key,
        p_source_seq,
        clean_language
      )
      on conflict (session_id, utterance_key) do nothing;

      return jsonb_build_object('ok', true, 'status', 'ignored',
        'event', 'topic-upsert',
        'topics', '[]'::jsonb,
        'memberships_added', '[]'::jsonb
      );
    end if;

    select coalesce(max(membership_row.position), 0) + 1
      into membership_position
    from public.live_topic_utterances membership_row
    where membership_row.topic_id = topic_row.id;

    insert into public.live_topic_utterances (
      session_id,
      utterance_key,
      topic_id,
      position,
      source_seq,
      source_language
    ) values (
      p_session_id,
      clean_utterance_key,
      topic_row.id,
      membership_position,
      p_source_seq,
      clean_language
    )
    on conflict (session_id, utterance_key) do nothing;

    insert into public.live_topic_processed_utterances (
      session_id,
      utterance_key,
      source_seq,
      source_language
    ) values (
      p_session_id,
      clean_utterance_key,
      p_source_seq,
      clean_language
    )
    on conflict (session_id, utterance_key) do nothing;

    target_topic_payload := jsonb_build_object(
      'id', topic_row.id,
      'session_id', topic_row.session_id,
      'ordinal', topic_row.ordinal,
      'title', topic_row.title,
      'summary', topic_row.summary,
      'status', topic_row.status,
      'completion_reason', topic_row.completion_reason,
      'detector_health', topic_row.detector_health,
      'started_at', topic_row.started_at,
      'completed_at', topic_row.completed_at,
      'version', topic_row.version
    );

    return jsonb_build_object('ok', true, 'status', 'processed',
      'event', 'topic-upsert',
      'topics', jsonb_build_array(target_topic_payload),
      'memberships_added', jsonb_build_array(jsonb_build_object(
        'session_id', p_session_id,
        'topic_id', topic_row.id,
        'utterance_key', clean_utterance_key,
        'position', membership_position
      ))
    );
  end if;

  if not found then
    select coalesce(max(topic_row.ordinal), 0) + 1
      into next_ordinal
    from public.live_topics topic_row
    where topic_row.session_id = p_session_id;

    insert into public.live_topics (
      session_id,
      ordinal,
      title,
      summary,
      detector_health,
      last_activity_at
    ) values (
      p_session_id,
      next_ordinal,
      clean_title,
      clean_summary,
      clean_detector_health,
      source_utterance.emitted_at
    )
    returning id into target_topic_id;
  elsif p_decision = 'shift' then
    update public.live_topics
      set status = 'completed',
          completion_reason = 'semantic_shift',
          completed_at = source_utterance.emitted_at,
          updated_at = statement_timestamp(),
          version = version + 1
    where id = topic_row.id
    returning * into completed_topic;

    completed_topic_payload := jsonb_build_object(
      'id', completed_topic.id,
      'session_id', completed_topic.session_id,
      'ordinal', completed_topic.ordinal,
      'title', completed_topic.title,
      'summary', completed_topic.summary,
      'status', completed_topic.status,
      'completion_reason', completed_topic.completion_reason,
      'detector_health', completed_topic.detector_health,
      'started_at', completed_topic.started_at,
      'completed_at', completed_topic.completed_at,
      'version', completed_topic.version
    );

    select coalesce(max(next_topic.ordinal), 0) + 1
      into next_ordinal
    from public.live_topics next_topic
    where next_topic.session_id = p_session_id;

    insert into public.live_topics (
      session_id,
      ordinal,
      title,
      summary,
      detector_health,
      last_activity_at
    ) values (
      p_session_id,
      next_ordinal,
      clean_title,
      clean_summary,
      clean_detector_health,
      source_utterance.emitted_at
    )
    returning id into target_topic_id;
  else
    update public.live_topics
      set title = coalesce(raw_title, title),
          summary = coalesce(clean_summary, summary),
          detector_health = clean_detector_health,
          last_activity_at = source_utterance.emitted_at,
          updated_at = statement_timestamp(),
          version = version + 1
    where id = topic_row.id
    returning id into target_topic_id;
  end if;

  select coalesce(max(membership_row.position), 0) + 1
    into membership_position
  from public.live_topic_utterances membership_row
  where membership_row.topic_id = target_topic_id;

  insert into public.live_topic_utterances (
    session_id,
    utterance_key,
    topic_id,
    position,
    source_seq,
    source_language
  ) values (
    p_session_id,
    clean_utterance_key,
    target_topic_id,
    membership_position,
    p_source_seq,
    clean_language
  )
  on conflict (session_id, utterance_key) do nothing;

  select topic_row.*
    into target_topic
  from public.live_topics topic_row
  where topic_row.id = target_topic_id;

  target_topic_payload := jsonb_build_object(
    'id', target_topic.id,
    'session_id', target_topic.session_id,
    'ordinal', target_topic.ordinal,
    'title', target_topic.title,
    'summary', target_topic.summary,
    'status', target_topic.status,
    'completion_reason', target_topic.completion_reason,
    'detector_health', target_topic.detector_health,
    'started_at', target_topic.started_at,
    'completed_at', target_topic.completed_at,
    'version', target_topic.version
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'applied',
    'event', 'topic-upsert',
    'topics', case
      when completed_topic_payload is null then jsonb_build_array(target_topic_payload)
      else jsonb_build_array(completed_topic_payload, target_topic_payload)
    end,
    'memberships_added', jsonb_build_array(jsonb_build_object(
      'session_id', p_session_id,
      'topic_id', target_topic_id,
      'utterance_key', clean_utterance_key,
      'position', membership_position
    ))
  );
end;
$$;

create or replace function public.complete_idle_live_topic(
  p_session_id uuid,
  p_language text,
  p_topic_id uuid,
  p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  clean_language text := lower(btrim(coalesce(p_language, '')));
  topic_row record;
  latest_source_final_at timestamptz;
  completed_topic record;
  completed_topic_payload jsonb;
begin
  if p_session_id is null
    or p_topic_id is null
    or not public.live_language_valid(clean_language)
    or p_expected_version is null
  then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IDLE_TOPIC_INPUT');
  end if;

  select topic_row.*
    into topic_row
  from public.live_topics topic_row
  where topic_row.id = p_topic_id
    and topic_row.session_id = p_session_id
    and topic_row.status = 'active'
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'TOPIC_NOT_ACTIVE');
  end if;

  if topic_row.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'TOPIC_VERSION_CONFLICT');
  end if;

  if topic_row.last_activity_at > statement_timestamp() - interval '12 seconds' then
    return jsonb_build_object('ok', false, 'code', 'TOPIC_NOT_IDLE');
  end if;

  select max(source_utterance.emitted_at)
    into latest_source_final_at
  from public.live_utterances source_utterance
  left join public.live_topic_utterances membership_row
    on membership_row.session_id = source_utterance.session_id
   and membership_row.utterance_key = source_utterance.utterance_key
  left join public.live_topic_processed_utterances processed_row
    on processed_row.session_id = source_utterance.session_id
   and processed_row.utterance_key = source_utterance.utterance_key
  where source_utterance.session_id = p_session_id
    and source_utterance.language = clean_language
    and source_utterance.origin = 'source'
    and source_utterance.utterance_key is not null
    and membership_row.utterance_key is null
    and processed_row.utterance_key is null;

  if latest_source_final_at > topic_row.last_activity_at then
    return jsonb_build_object('ok', false, 'code', 'LATEST_SOURCE_FINAL_UNASSIGNED');
  end if;

  update public.live_topics
    set status = 'completed',
        completion_reason = 'silence',
        completed_at = statement_timestamp(),
        updated_at = statement_timestamp(),
        version = version + 1
  where id = topic_row.id
  returning * into completed_topic;

  completed_topic_payload := jsonb_build_object(
    'id', completed_topic.id,
    'session_id', completed_topic.session_id,
    'ordinal', completed_topic.ordinal,
    'title', completed_topic.title,
    'summary', completed_topic.summary,
    'status', completed_topic.status,
    'completion_reason', completed_topic.completion_reason,
    'detector_health', completed_topic.detector_health,
    'started_at', completed_topic.started_at,
    'completed_at', completed_topic.completed_at,
    'version', completed_topic.version
  );

  return jsonb_build_object(
    'ok', true,
    'event', 'topic-upsert',
    'topics', jsonb_build_array(completed_topic_payload),
    'memberships_added', '[]'::jsonb
  );
end;
$$;

create or replace function public.complete_live_topics_on_session_end(
  p_session_id uuid
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row record;
  changed_count integer := 0;
begin
  if p_session_id is null then
    return 0;
  end if;

  select session_row.*
    into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id;

  if not found or session_row.status not in ('live', 'paused', 'stopped') then
    return 0;
  end if;

  update public.live_topics
    set status = 'completed',
        completion_reason = 'session_end',
        completed_at = coalesce(session_row.ended_at, statement_timestamp()),
        updated_at = statement_timestamp(),
        version = version + 1
  where session_id = p_session_id
    and status = 'active';

  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;

create or replace function public.recover_live_topic_assignments(
  p_session_id uuid,
  p_language text,
  p_after_source_seq bigint default 0
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  clean_language text := lower(btrim(coalesce(p_language, '')));
  unassigned_finals jsonb := '[]'::jsonb;
  next_source_seq bigint := coalesce(p_after_source_seq, 0);
begin
  if p_session_id is null
    or not public.live_language_valid(clean_language)
    or p_after_source_seq is null
    or p_after_source_seq < 0
  then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TOPIC_RECOVERY_INPUT');
  end if;

  with bounded_source as (
    select source_utterance.*
    from public.live_utterances source_utterance
    left join public.live_topic_utterances membership_row
      on membership_row.session_id = source_utterance.session_id
     and membership_row.utterance_key = source_utterance.utterance_key
    left join public.live_topic_processed_utterances processed_row
      on processed_row.session_id = source_utterance.session_id
     and processed_row.utterance_key = source_utterance.utterance_key
    where source_utterance.session_id = p_session_id
      and source_utterance.language = clean_language
      and source_utterance.origin = 'source'
      and source_utterance.utterance_key is not null
      and source_utterance.seq > coalesce(p_after_source_seq, 0)
      and char_length(source_utterance.text) <= 2000
      and membership_row.utterance_key is null
      and processed_row.utterance_key is null
    order by source_utterance.seq
    limit 100
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'utterance_key', bounded_source.utterance_key,
          'source_seq', bounded_source.seq,
          'source_language', bounded_source.language,
          'text', left(bounded_source.text, 2000),
          'emitted_at', bounded_source.emitted_at
        )
        order by bounded_source.seq
      ),
      '[]'::jsonb
    ),
    coalesce(max(bounded_source.seq), coalesce(p_after_source_seq, 0))
  into unassigned_finals, next_source_seq
  from bounded_source;

  return jsonb_build_object(
    'ok', true,
    'unassigned_finals', unassigned_finals,
    'next_source_seq', next_source_seq
  );
end;
$$;

create or replace function public.cleanup_expired_live_topics()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed_count integer := 0;
begin
  with deleted_processed as (
    delete from public.live_topic_processed_utterances processed_row
    using (
      select session_row.id
      from public.live_sessions session_row
      where coalesce(session_row.ended_at, session_row.updated_at, session_row.created_at)
        < statement_timestamp() - interval '30 days'
    ) expired_sessions
    where processed_row.session_id = expired_sessions.id
    returning processed_row.utterance_key
  ),
  deleted_topics as (
    delete from public.live_topics topic_row
    using public.live_sessions session_row
    where topic_row.session_id = session_row.id
      and coalesce(session_row.ended_at, topic_row.completed_at, topic_row.updated_at)
        < statement_timestamp() - interval '30 days'
    returning topic_row.id
  )
  select (
    (select count(*) from deleted_processed)
    + (select count(*) from deleted_topics)
  )::integer
    into changed_count
  ;

  return changed_count;
end;
$$;

do $$
begin
  if exists (
    select 1
    from pg_namespace
    where nspname = 'cron'
  ) then
    if exists (
      select 1
      from cron.job job_row
      where job_row.jobname = 'realtime-noel-live-topic-cleanup'
    ) then
      perform cron.unschedule('realtime-noel-live-topic-cleanup');
    end if;

    perform cron.schedule(
      'realtime-noel-live-topic-cleanup',
      '17 3 * * *',
      'select public.cleanup_expired_live_topics();'
    );
  end if;
exception
  when undefined_function then
    null;
end $$;

revoke all on function public.read_live_topic_context(uuid, text)
  from public, anon, authenticated;
revoke all on function public.apply_live_topic_transition(
  uuid, text, text, bigint, text, uuid, integer, text, text, text, boolean
) from public, anon, authenticated;
revoke all on function public.complete_idle_live_topic(uuid, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.complete_live_topics_on_session_end(uuid)
  from public, anon, authenticated;
revoke all on function public.recover_live_topic_assignments(uuid, text, bigint)
  from public, anon, authenticated;
revoke all on function public.cleanup_expired_live_topics()
  from public, anon, authenticated;

grant execute on function public.read_live_topic_context(uuid, text)
  to service_role;
grant execute on function public.apply_live_topic_transition(
  uuid, text, text, bigint, text, uuid, integer, text, text, text, boolean
) to service_role;
grant execute on function public.complete_idle_live_topic(uuid, text, uuid, integer)
  to service_role;
grant execute on function public.complete_live_topics_on_session_end(uuid)
  to service_role;
grant execute on function public.recover_live_topic_assignments(uuid, text, bigint)
  to service_role;
grant execute on function public.cleanup_expired_live_topics()
  to service_role;

-- supabase/migrations/202608150003_live_viewer_authorization_batch.sql

-- Batch live viewer grant authorization for reconnect fan-in.
-- Additive only: the existing single-request RPC remains available.

create or replace function public.authorize_live_viewer_grants_v1(p_requests jsonb)
returns table (
  session_id uuid,
  grant_id uuid,
  user_id text,
  language text,
  authorized boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_requests is null or jsonb_typeof(p_requests) <> 'array' then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_INVALID';
  end if;

  if jsonb_array_length(p_requests) = 0 then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_EMPTY';
  end if;

  if jsonb_array_length(p_requests) > 50 then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_TOO_LARGE';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_requests) with ordinality as request_item(value, ordinal)
    where jsonb_typeof(request_item.value) <> 'object'
      or (
        select array_agg(key order by key)
        from jsonb_object_keys(request_item.value) as key
      ) is distinct from array['grant_id', 'language', 'session_id', 'user_id']
  ) then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_SHAPE';
  end if;

  if exists (
    with request_rows as (
      select
        request_item.ordinal,
        request_item.value ->> 'session_id' as session_id_text,
        request_item.value ->> 'grant_id' as grant_id_text,
        request_item.value ->> 'user_id' as user_id,
        request_item.value ->> 'language' as language
      from jsonb_array_elements(p_requests) with ordinality as request_item(value, ordinal)
    )
    select 1
    from request_rows request_row
    where request_row.session_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or request_row.grant_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or request_row.user_id is null
      or length(request_row.user_id) not between 1 and 256
      or public.live_language_valid(request_row.language) is not true
  ) then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_SHAPE';
  end if;

  if exists (
    with request_rows as (
      select
        (request_item.value ->> 'session_id')::uuid as session_id,
        (request_item.value ->> 'grant_id')::uuid as grant_id,
        request_item.value ->> 'user_id' as user_id,
        request_item.value ->> 'language' as language
      from jsonb_array_elements(p_requests) with ordinality as request_item(value, ordinal)
    )
    select 1
    from request_rows request_row
    group by request_row.session_id, request_row.grant_id, request_row.user_id, request_row.language
    having count(*) > 1
  ) then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_DUPLICATE';
  end if;

  return query
  with request_rows as (
    select
      request_item.ordinal,
      (request_item.value ->> 'session_id')::uuid as session_id,
      (request_item.value ->> 'grant_id')::uuid as grant_id,
      request_item.value ->> 'user_id' as user_id,
      request_item.value ->> 'language' as language
    from jsonb_array_elements(p_requests) with ordinality as request_item(value, ordinal)
  ),
  authorized_rows as (
    select
      request_row.ordinal,
      true as authorized
    from request_rows request_row
    join public.live_sessions session_row
      on session_row.id = request_row.session_id
     and session_row.status in ('live', 'paused')
     and session_row.expires_at > statement_timestamp()
     and public.live_languages_canonical(session_row.languages)
     and request_row.language = any(session_row.languages)
    join public.viewer_grants grant_row
      on grant_row.session_id = request_row.session_id
     and grant_row.id = request_row.grant_id
     and grant_row.user_id = request_row.user_id
     and grant_row.revoked_at is null
     and grant_row.expires_at > statement_timestamp()
  )
  select
    request_row.session_id,
    request_row.grant_id,
    request_row.user_id,
    request_row.language,
    coalesce(authorized_row.authorized, false) as authorized
  from request_rows request_row
  left join authorized_rows authorized_row on authorized_row.ordinal = request_row.ordinal
  order by request_row.ordinal;
end;
$$;

revoke all on function public.authorize_live_viewer_grants_v1(jsonb)
  from public, anon, authenticated;

grant execute on function public.authorize_live_viewer_grants_v1(jsonb)
  to service_role;

-- ===================================================================
-- supabase/migrations/202608150004_live_glossary_document_session_sections.sql
-- ===================================================================
-- 2026-08-15 feat: Add versioned glossary documents, immutable live-session
-- pins, and earnings-call section metadata. This migration is additive: the
-- legacy host_glossary_presets.glossary text contract remains readable.

alter table public.host_glossary_presets
  add column if not exists active_document_version integer,
  add column if not exists active_document_fingerprint text;

alter table public.host_glossary_presets
  drop constraint if exists host_glossary_presets_active_document_check,
  add constraint host_glossary_presets_active_document_check check (
    (active_document_version is null and active_document_fingerprint is null)
    or (
      active_document_version is not null
      and active_document_version >= 1
      and active_document_fingerprint is not null
      and active_document_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    )
  );

create table if not exists public.host_glossary_preset_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  preset_id uuid not null references public.host_glossary_presets(id) on delete cascade,
  host_id text not null,
  version integer not null,
  document_schema text not null default 'glossary-document/v1',
  document jsonb not null,
  fingerprint text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint host_glossary_preset_versions_host_id_check check (
    char_length(host_id) between 1 and 100
    and host_id = btrim(host_id)
    and host_id !~ '[[:cntrl:]]'
  ),
  constraint host_glossary_preset_versions_version_check check (version >= 1),
  constraint host_glossary_preset_versions_document_schema_check check (
    document_schema = 'glossary-document/v1'
  ),
  constraint host_glossary_preset_versions_document_check check (
    jsonb_typeof(document) = 'object'
    and octet_length(document::text) <= 5000000
  ),
  constraint host_glossary_preset_versions_fingerprint_check check (
    fingerprint ~ '^sha256:[0-9a-f]{64}$'
  ),
  unique (preset_id, version),
  unique (preset_id, fingerprint)
);

create index if not exists host_glossary_preset_versions_host_idx
  on public.host_glossary_preset_versions (host_id, preset_id, version desc);

alter table public.host_glossary_preset_versions enable row level security;

revoke all on table public.host_glossary_preset_versions
  from public, anon, authenticated, service_role;

alter table public.live_sessions
  add column if not exists pinned_glossary_preset_id uuid references public.host_glossary_presets(id) on delete restrict,
  add column if not exists pinned_glossary_version integer,
  add column if not exists pinned_glossary_fingerprint text,
  add column if not exists event_company_name text,
  add column if not exists event_reporting_period text,
  add column if not exists event_metadata jsonb not null default '{}'::jsonb;

alter table public.live_sessions
  drop constraint if exists live_sessions_pinned_glossary_check,
  add constraint live_sessions_pinned_glossary_check check (
    (pinned_glossary_preset_id is null and pinned_glossary_version is null and pinned_glossary_fingerprint is null)
    or (
      pinned_glossary_preset_id is not null
      and pinned_glossary_version is not null
      and pinned_glossary_version >= 1
      and pinned_glossary_fingerprint is not null
      and pinned_glossary_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    )
  );

alter table public.live_sessions
  drop constraint if exists live_sessions_event_metadata_check,
  add constraint live_sessions_event_metadata_check check (
    (event_company_name is null or (
      char_length(event_company_name) between 1 and 160
      and event_company_name = normalize(btrim(event_company_name), NFC)
      and event_company_name !~ '[[:cntrl:]]'
      and event_company_name !~ '[<>]'
    ))
    and (event_reporting_period is null or (
      char_length(event_reporting_period) between 1 and 80
      and event_reporting_period = normalize(btrim(event_reporting_period), NFC)
      and event_reporting_period !~ '[[:cntrl:]]'
      and event_reporting_period !~ '[<>]'
    ))
    and jsonb_typeof(event_metadata) = 'object'
    and octet_length(event_metadata::text) <= 4096
  );

create table if not exists public.live_session_sections (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  section_key text not null,
  status text not null default 'active',
  transition_key text not null,
  source_seq bigint,
  ordinal integer not null,
  version integer not null default 1,
  started_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint live_session_sections_section_key_check check (
    section_key in ('prepared_remarks', 'qa', 'other')
  ),
  constraint live_session_sections_status_check check (
    status in ('active', 'completed')
  ),
  constraint live_session_sections_transition_key_check check (
    char_length(transition_key) between 1 and 256
    and transition_key = normalize(btrim(transition_key), NFC)
    and transition_key !~ '[[:cntrl:]]'
    and transition_key !~ '[<>]'
  ),
  constraint live_session_sections_source_seq_check check (
    source_seq is null or source_seq >= 0
  ),
  constraint live_session_sections_ordinal_check check (
    ordinal between 1 and 100
  ),
  constraint live_session_sections_version_check check (version >= 1),
  constraint live_session_sections_completed_check check (
    (status = 'active' and completed_at is null)
    or (status = 'completed' and completed_at is not null and completed_at >= started_at)
  ),
  unique (session_id, transition_key),
  unique (session_id, ordinal)
);

create unique index if not exists live_session_sections_one_active_idx
  on public.live_session_sections (session_id)
  where status = 'active';

create index if not exists live_session_sections_snapshot_idx
  on public.live_session_sections (session_id, ordinal);

alter table public.live_session_sections enable row level security;

revoke all on table public.live_session_sections
  from public, anon, authenticated, service_role;

create or replace function public.create_host_glossary_document_preset_v1(
  p_host_id text,
  p_name text,
  p_domain text,
  p_language_a text,
  p_language_b text,
  p_document jsonb,
  p_fingerprint text
)
returns table (
  id uuid,
  name text,
  domain text,
  language_a text,
  language_b text,
  version integer,
  active_document_version integer,
  active_document_fingerprint text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  clean_name text;
  clean_domain text;
  clean_language_a text;
  clean_language_b text;
  clean_fingerprint text;
  preset_count integer;
  created_preset public.host_glossary_presets%rowtype;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  clean_name := pg_catalog.btrim(coalesce(p_name, ''));
  clean_domain := pg_catalog.btrim(coalesce(p_domain, ''));
  clean_language_a := pg_catalog.btrim(coalesce(p_language_a, ''));
  clean_language_b := pg_catalog.btrim(coalesce(p_language_b, ''));
  clean_fingerprint := pg_catalog.btrim(coalesce(p_fingerprint, ''));

  if pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_name) not between 1 and 80
    or clean_name ~ '[[:cntrl:]]'
    or clean_name ~ '[<>]'
    or pg_catalog.char_length(clean_domain) > 600
    or clean_domain ~ '[[:cntrl:]]'
    or public.live_language_valid(clean_language_a) is not true
    or public.live_language_valid(clean_language_b) is not true
    or clean_language_a = clean_language_b
    or p_document is null
    or jsonb_typeof(p_document) <> 'object'
    or octet_length(p_document::text) > 5000000
    or clean_fingerprint !~ '^sha256:[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_GLOSSARY_DOCUMENT_INPUT';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(clean_host_id, 0));

  select count(*) into preset_count
  from public.host_glossary_presets as preset_row
  where preset_row.host_id = clean_host_id;

  if preset_count >= 50 then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_LIMIT_REACHED';
  end if;

  insert into public.host_glossary_presets (
    host_id,
    name,
    domain,
    glossary,
    language_a,
    language_b,
    active_document_version,
    active_document_fingerprint
  ) values (
    clean_host_id,
    clean_name,
    clean_domain,
    'Document glossary',
    clean_language_a,
    clean_language_b,
    1,
    clean_fingerprint
  )
  returning * into created_preset;

  insert into public.host_glossary_preset_versions (
    preset_id, host_id, version, document, fingerprint
  ) values (
    created_preset.id, clean_host_id, 1, p_document, clean_fingerprint
  );

  return query select
    created_preset.id,
    created_preset.name,
    created_preset.domain,
    created_preset.language_a,
    created_preset.language_b,
    created_preset.version,
    created_preset.active_document_version,
    created_preset.active_document_fingerprint,
    created_preset.updated_at;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NAME_CONFLICT';
end;
$$;

create or replace function public.list_host_glossary_documents_v1(
  p_host_id text
)
returns table (
  id uuid,
  name text,
  domain text,
  language_a text,
  language_b text,
  version integer,
  active_document_version integer,
  active_document_fingerprint text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  clean_host_id text;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_GLOSSARY_DOCUMENT_INPUT';
  end if;

  return query
  select
    preset_row.id,
    preset_row.name,
    preset_row.domain,
    preset_row.language_a,
    preset_row.language_b,
    preset_row.version,
    preset_row.active_document_version,
    preset_row.active_document_fingerprint,
    preset_row.updated_at
  from public.host_glossary_presets as preset_row
  where preset_row.host_id = clean_host_id
  order by preset_row.updated_at desc, preset_row.id;
end;
$$;

create or replace function public.list_host_glossary_document_versions_v1(
  p_host_id text,
  p_preset_id uuid
)
returns table (
  preset_id uuid,
  version integer,
  document_schema text,
  fingerprint text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  clean_host_id text;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if p_preset_id is null
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_GLOSSARY_DOCUMENT_INPUT';
  end if;

  return query
  select
    version_row.preset_id,
    version_row.version,
    version_row.document_schema,
    version_row.fingerprint,
    version_row.created_at
  from public.host_glossary_preset_versions as version_row
  join public.host_glossary_presets as preset_row
    on preset_row.id = version_row.preset_id
   and preset_row.host_id = clean_host_id
  where version_row.preset_id = p_preset_id
  order by version_row.version desc;
end;
$$;

create or replace function public.read_host_glossary_document_version_v1(
  p_host_id text,
  p_preset_id uuid,
  p_version integer
)
returns table (
  preset_id uuid,
  version integer,
  document_schema text,
  fingerprint text,
  document jsonb,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  clean_host_id text;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if p_preset_id is null
    or p_version is null
    or p_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_GLOSSARY_DOCUMENT_INPUT';
  end if;

  return query
  select
    version_row.preset_id,
    version_row.version,
    version_row.document_schema,
    version_row.fingerprint,
    version_row.document,
    version_row.created_at
  from public.host_glossary_preset_versions as version_row
  join public.host_glossary_presets as preset_row
    on preset_row.id = version_row.preset_id
   and preset_row.host_id = clean_host_id
  where version_row.preset_id = p_preset_id
    and version_row.version = p_version;
end;
$$;

create or replace function public.delete_host_glossary_preset(
  p_id uuid,
  p_host_id text,
  p_expected_version integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_host_id text;
  affected_count integer;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if p_id is null
    or p_expected_version is null
    or p_expected_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_HOST_GLOSSARY_PRESET_INPUT';
  end if;

  delete from public.host_glossary_presets as preset_row
  where preset_row.id = p_id
    and preset_row.host_id = clean_host_id
    and preset_row.version = p_expected_version;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  if affected_count = 0 then
    if exists (
      select 1
      from public.host_glossary_presets as preset_row
      where preset_row.id = p_id
        and preset_row.host_id = clean_host_id
    ) then
      raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_VERSION_CONFLICT';
    end if;
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NOT_FOUND';
  end if;

  return true;
exception
  when foreign_key_violation then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_IN_USE';
end;
$$;

create or replace function public.normalize_live_session_event_text(
  p_value text,
  p_max_length integer
)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  clean_value text;
begin
  clean_value := nullif(normalize(pg_catalog.btrim(coalesce(p_value, '')), NFC), '');
  if clean_value is null then
    return null;
  end if;
  if p_max_length is null
    or p_max_length < 1
    or pg_catalog.char_length(clean_value) > p_max_length
    or clean_value ~ '[[:cntrl:]]'
    or clean_value ~ '[<>]'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_EVENT_INPUT';
  end if;
  return clean_value;
end;
$$;

create or replace function public.normalize_live_session_event_metadata(
  p_value jsonb
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  if p_value is null then
    return '{}'::jsonb;
  end if;
  if jsonb_typeof(p_value) <> 'object'
    or octet_length(p_value::text) > 4096
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_EVENT_INPUT';
  end if;
  return p_value;
end;
$$;

create or replace function public.create_live_session_with_event_v1(
  p_session_id uuid,
  p_host_id text,
  p_session_type text,
  p_output_mode text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text,
  p_voice_provider text,
  p_title text,
  p_scheduled_at timestamptz,
  p_expires_at timestamptz,
  p_event_company_name text,
  p_event_reporting_period text,
  p_event_metadata jsonb
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
  title text,
  scheduled_at timestamptz,
  admission_open_until timestamptz,
  expires_at timestamptz,
  event_company_name text,
  event_reporting_period text,
  event_metadata jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  base_session record;
  updated_session public.live_sessions%rowtype;
  clean_event_company_name text;
  clean_event_reporting_period text;
  clean_event_metadata jsonb;
begin
  clean_event_company_name := public.normalize_live_session_event_text(p_event_company_name, 160);
  clean_event_reporting_period := public.normalize_live_session_event_text(p_event_reporting_period, 80);
  clean_event_metadata := public.normalize_live_session_event_metadata(p_event_metadata);

  select * into base_session
  from public.create_live_session(
    p_session_id,
    p_host_id,
    p_session_type,
    p_output_mode,
    p_languages,
    p_max_viewers,
    p_glossary_pack,
    p_voice_provider,
    p_title,
    p_scheduled_at,
    p_expires_at
  );

  update public.live_sessions as session_row
  set event_company_name = clean_event_company_name,
      event_reporting_period = clean_event_reporting_period,
      event_metadata = clean_event_metadata
  where session_row.id = base_session.id
  returning * into updated_session;

  return query select
    updated_session.id,
    updated_session.host_id,
    updated_session.session_type,
    updated_session.output_mode,
    updated_session.status,
    updated_session.languages,
    updated_session.viewer_count,
    updated_session.max_viewers,
    updated_session.version,
    updated_session.glossary_pack,
    updated_session.voice_provider,
    updated_session.title,
    updated_session.scheduled_at,
    updated_session.admission_open_until,
    updated_session.expires_at,
    updated_session.event_company_name,
    updated_session.event_reporting_period,
    updated_session.event_metadata;
end;
$$;

create or replace function public.update_live_session_with_event_v1(
  p_session_id uuid,
  p_host_id text,
  p_expected_version integer,
  p_session_type text,
  p_output_mode text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text,
  p_voice_provider text,
  p_title text,
  p_scheduled_at timestamptz,
  p_event_company_name text,
  p_event_reporting_period text,
  p_event_metadata jsonb
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
  title text,
  scheduled_at timestamptz,
  admission_open_until timestamptz,
  expires_at timestamptz,
  event_company_name text,
  event_reporting_period text,
  event_metadata jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  base_session record;
  updated_session public.live_sessions%rowtype;
  clean_event_company_name text;
  clean_event_reporting_period text;
  clean_event_metadata jsonb;
begin
  clean_event_company_name := public.normalize_live_session_event_text(p_event_company_name, 160);
  clean_event_reporting_period := public.normalize_live_session_event_text(p_event_reporting_period, 80);
  clean_event_metadata := public.normalize_live_session_event_metadata(p_event_metadata);

  select * into base_session
  from public.update_live_session(
    p_session_id,
    p_host_id,
    p_expected_version,
    p_session_type,
    p_output_mode,
    p_languages,
    p_max_viewers,
    p_glossary_pack,
    p_voice_provider,
    p_title,
    p_scheduled_at
  );

  if not found then
    return;
  end if;

  update public.live_sessions as session_row
  set event_company_name = clean_event_company_name,
      event_reporting_period = clean_event_reporting_period,
      event_metadata = clean_event_metadata
  where session_row.id = base_session.id
  returning * into updated_session;

  return query select
    updated_session.id,
    updated_session.host_id,
    updated_session.session_type,
    updated_session.output_mode,
    updated_session.status,
    updated_session.languages,
    updated_session.viewer_count,
    updated_session.max_viewers,
    updated_session.version,
    updated_session.glossary_pack,
    updated_session.voice_provider,
    updated_session.title,
    updated_session.scheduled_at,
    updated_session.admission_open_until,
    updated_session.expires_at,
    updated_session.event_company_name,
    updated_session.event_reporting_period,
    updated_session.event_metadata;
end;
$$;

create or replace function public.save_host_glossary_document_version_v1(
  p_host_id text,
  p_preset_id uuid,
  p_expected_preset_version integer,
  p_document jsonb,
  p_fingerprint text
)
returns table (
  id uuid,
  preset_id uuid,
  host_id text,
  document_version integer,
  fingerprint text,
  document_schema text,
  preset_version integer,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  clean_fingerprint text;
  preset_row public.host_glossary_presets%rowtype;
  existing_document_version_count integer;
  next_document_version integer;
  created_version public.host_glossary_preset_versions%rowtype;
  affected_count integer;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  clean_fingerprint := pg_catalog.btrim(coalesce(p_fingerprint, ''));

  if p_preset_id is null
    or p_expected_preset_version is null
    or p_expected_preset_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or p_document is null
    or jsonb_typeof(p_document) <> 'object'
    or octet_length(p_document::text) > 5000000
    or clean_fingerprint !~ '^sha256:[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_GLOSSARY_DOCUMENT_INPUT';
  end if;

  select * into preset_row
  from public.host_glossary_presets as preset_row
  where preset_row.id = p_preset_id
    and preset_row.host_id = clean_host_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NOT_FOUND';
  end if;

  if preset_row.version <> p_expected_preset_version then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_VERSION_CONFLICT';
  end if;

  select count(*) into existing_document_version_count
  from public.host_glossary_preset_versions as version_row
  where version_row.preset_id = p_preset_id;

  if existing_document_version_count >= 200 then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_VERSION_LIMIT_REACHED';
  end if;

  select coalesce(max(version), 0) + 1 into next_document_version
  from public.host_glossary_preset_versions as version_row
  where version_row.preset_id = p_preset_id;

  insert into public.host_glossary_preset_versions (
    preset_id, host_id, version, document, fingerprint
  ) values (
    p_preset_id, clean_host_id, next_document_version, p_document, clean_fingerprint
  )
  returning * into created_version;

  update public.host_glossary_presets as preset_row
  set version = preset_row.version + 1,
      updated_at = statement_timestamp()
  where preset_row.id = p_preset_id
    and preset_row.host_id = clean_host_id
    and preset_row.version = p_expected_preset_version;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  if affected_count = 0 then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_VERSION_CONFLICT';
  end if;

  return query select
    created_version.id,
    created_version.preset_id,
    created_version.host_id,
    created_version.version as document_version,
    created_version.fingerprint,
    created_version.document_schema,
    p_expected_preset_version + 1 as preset_version,
    created_version.created_at;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_DOCUMENT_FINGERPRINT_CONFLICT';
end;
$$;

create or replace function public.activate_host_glossary_document_version_v1(
  p_host_id text,
  p_preset_id uuid,
  p_expected_preset_version integer,
  p_document_version integer
)
returns table (
  preset_id uuid,
  host_id text,
  version integer,
  active_document_version integer,
  active_document_fingerprint text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  version_row public.host_glossary_preset_versions%rowtype;
  updated_preset public.host_glossary_presets%rowtype;
  affected_count integer;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if p_preset_id is null
    or p_expected_preset_version is null
    or p_expected_preset_version < 1
    or p_document_version is null
    or p_document_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_GLOSSARY_DOCUMENT_INPUT';
  end if;

  select * into version_row
  from public.host_glossary_preset_versions as version_row
  where version_row.preset_id = p_preset_id
    and version_row.host_id = clean_host_id
    and version_row.version = p_document_version;

  if not found then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_DOCUMENT_VERSION_NOT_FOUND';
  end if;

  update public.host_glossary_presets as preset_row
  set active_document_version = version_row.version,
      active_document_fingerprint = version_row.fingerprint,
      version = preset_row.version + 1,
      updated_at = statement_timestamp()
  where preset_row.id = p_preset_id
    and preset_row.host_id = clean_host_id
    and preset_row.version = p_expected_preset_version
  returning * into updated_preset;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  if affected_count = 0 then
    if exists (
      select 1
      from public.host_glossary_presets as preset_row
      where preset_row.id = p_preset_id
        and preset_row.host_id = clean_host_id
    ) then
      raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_VERSION_CONFLICT';
    end if;
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NOT_FOUND';
  end if;

  return query select
    updated_preset.id as preset_id,
    updated_preset.host_id,
    updated_preset.version,
    updated_preset.active_document_version,
    updated_preset.active_document_fingerprint,
    updated_preset.updated_at;
end;
$$;

create or replace function public.pin_live_session_glossary_version_v1(
  p_session_id uuid,
  p_host_id text,
  p_expected_session_version integer,
  p_preset_id uuid,
  p_document_version integer
)
returns table (
  session_id uuid,
  version integer,
  pinned_glossary_preset_id uuid,
  pinned_glossary_version integer,
  pinned_glossary_fingerprint text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  session_row public.live_sessions%rowtype;
  version_row public.host_glossary_preset_versions%rowtype;
  updated_session public.live_sessions%rowtype;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if p_session_id is null
    or p_expected_session_version is null
    or p_expected_session_version < 1
    or p_preset_id is null
    or p_document_version is null
    or p_document_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
  end if;

  select * into session_row
  from public.live_sessions as session_row
  where session_row.id = p_session_id
    and session_row.host_id = clean_host_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_NOT_FOUND';
  end if;

  if session_row.version <> p_expected_session_version then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_VERSION_CONFLICT';
  end if;

  if session_row.status <> 'preparing' then
    raise exception using errcode = 'P0001', message = 'ACTIVE_SESSION_GLOSSARY_IMMUTABLE';
  end if;

  select * into version_row
  from public.host_glossary_preset_versions as version_row
  where version_row.host_id = clean_host_id
    and version_row.preset_id = p_preset_id
    and version_row.version = p_document_version;

  if not found then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_DOCUMENT_VERSION_NOT_FOUND';
  end if;

  update public.live_sessions as session_row
  set pinned_glossary_preset_id = p_preset_id,
      pinned_glossary_version = version_row.version,
      pinned_glossary_fingerprint = version_row.fingerprint,
      version = session_row.version + 1,
      updated_at = statement_timestamp()
  where session_row.id = p_session_id
    and session_row.host_id = clean_host_id
    and session_row.version = p_expected_session_version
  returning * into updated_session;

  return query select
    updated_session.id as session_id,
    updated_session.version,
    updated_session.pinned_glossary_preset_id,
    updated_session.pinned_glossary_version,
    updated_session.pinned_glossary_fingerprint,
    updated_session.updated_at;
end;
$$;

create or replace function public.read_live_session_pinned_glossary_v1(
  p_session_id uuid
)
returns table (
  session_id uuid,
  preset_id uuid,
  version integer,
  document_schema text,
  fingerprint text,
  document jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
  matched_count integer;
begin
  if p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_PINNED_GLOSSARY_INPUT';
  end if;

  select * into session_row
  from public.live_sessions as session_row
  where session_row.id = p_session_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_NOT_FOUND';
  end if;

  if session_row.pinned_glossary_preset_id is null
    and session_row.pinned_glossary_version is null
    and session_row.pinned_glossary_fingerprint is null
  then
    return;
  end if;

  if session_row.pinned_glossary_preset_id is null
    or session_row.pinned_glossary_version is null
    or session_row.pinned_glossary_fingerprint is null
    or session_row.pinned_glossary_fingerprint !~ '^sha256:[0-9a-f]{64}$'
  then
    raise exception using errcode = 'P0001', message = 'PINNED_GLOSSARY_VERSION_MISMATCH';
  end if;

  select count(*)::integer into matched_count
  from public.live_sessions as session_row
  join public.host_glossary_presets as preset_row
    on preset_row.id = session_row.pinned_glossary_preset_id
   and preset_row.host_id = session_row.host_id
  join public.host_glossary_preset_versions as version_row
    on version_row.preset_id = session_row.pinned_glossary_preset_id
   and version_row.host_id = session_row.host_id
   and version_row.version = session_row.pinned_glossary_version
   and version_row.fingerprint = session_row.pinned_glossary_fingerprint
  where session_row.id = p_session_id;

  if matched_count <> 1 then
    raise exception using errcode = 'P0001', message = 'PINNED_GLOSSARY_VERSION_MISMATCH';
  end if;

  return query select
    session_row.id as session_id,
    version_row.preset_id,
    version_row.version,
    version_row.document_schema,
    version_row.fingerprint,
    version_row.document
  from public.live_sessions as session_row
  join public.host_glossary_presets as preset_row
    on preset_row.id = session_row.pinned_glossary_preset_id
   and preset_row.host_id = session_row.host_id
  join public.host_glossary_preset_versions as version_row
    on version_row.preset_id = session_row.pinned_glossary_preset_id
   and version_row.host_id = session_row.host_id
   and version_row.version = session_row.pinned_glossary_version
   and version_row.fingerprint = session_row.pinned_glossary_fingerprint
  where session_row.id = p_session_id;
end;
$$;

create or replace function public.transition_live_session_section_v1(
  p_session_id uuid,
  p_host_id text,
  p_expected_session_version integer,
  p_transition_key text,
  p_section_key text,
  p_source_seq bigint
)
returns table (
  session_id uuid,
  section_id uuid,
  section_key text,
  status text,
  ordinal integer,
  version integer,
  started_at timestamptz,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  clean_transition_key text;
  clean_section_key text;
  session_row public.live_sessions%rowtype;
  existing_section public.live_session_sections%rowtype;
  inserted_section public.live_session_sections%rowtype;
  next_ordinal integer;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  clean_transition_key := normalize(pg_catalog.btrim(coalesce(p_transition_key, '')), NFC);
  clean_section_key := pg_catalog.btrim(coalesce(p_section_key, ''));

  if p_session_id is null
    or p_expected_session_version is null
    or p_expected_session_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_transition_key) not between 1 and 256
    or clean_transition_key ~ '[[:cntrl:]]'
    or clean_transition_key ~ '[<>]'
    or clean_section_key not in ('prepared_remarks', 'qa', 'other')
    or (p_source_seq is not null and p_source_seq < 0)
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_SECTION_INPUT';
  end if;

  select * into session_row
  from public.live_sessions as session_row
  where session_row.id = p_session_id
    and session_row.host_id = clean_host_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_NOT_FOUND';
  end if;

  select * into existing_section
  from public.live_session_sections as existing_section
  where existing_section.session_id = p_session_id
    and existing_section.transition_key = clean_transition_key;

  if found then
    return query select
      existing_section.session_id,
      existing_section.id as section_id,
      existing_section.section_key,
      existing_section.status,
      existing_section.ordinal,
      existing_section.version,
      existing_section.started_at,
      existing_section.completed_at;
    return;
  end if;

  if session_row.version <> p_expected_session_version then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_SECTION_VERSION_CONFLICT';
  end if;

  select coalesce(max(section_row.ordinal), 0) + 1 into next_ordinal
  from public.live_session_sections as section_row
  where section_row.session_id = p_session_id;

  if next_ordinal > 100 then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_SECTION_LIMIT_REACHED';
  end if;

  update public.live_session_sections as section_row
  set status = 'completed',
      completed_at = coalesce(section_row.completed_at, statement_timestamp()),
      version = section_row.version + 1,
      updated_at = statement_timestamp()
  where section_row.session_id = p_session_id
    and section_row.status = 'active';

  insert into public.live_session_sections (
    session_id, section_key, transition_key, source_seq, ordinal
  ) values (
    p_session_id, clean_section_key, clean_transition_key, p_source_seq, next_ordinal
  )
  returning * into inserted_section;

  update public.live_sessions as session_row
  set version = session_row.version + 1,
      updated_at = statement_timestamp()
  where session_row.id = p_session_id
    and session_row.host_id = clean_host_id
    and session_row.version = p_expected_session_version;

  return query select
    inserted_section.session_id,
    inserted_section.id as section_id,
    inserted_section.section_key,
    inserted_section.status,
    inserted_section.ordinal,
    inserted_section.version,
    inserted_section.started_at,
    inserted_section.completed_at;
end;
$$;

create or replace function public.read_live_session_event_context_v1(
  p_session_id uuid
)
returns table (
  session_id uuid,
  event_company_name text,
  event_reporting_period text,
  event_metadata jsonb,
  active_section_key text,
  sections jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_EVENT_CONTEXT_INPUT';
  end if;

  return query
  with section_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', section_row.id,
          'session_id', section_row.session_id,
          'section_key', section_row.section_key,
          'status', section_row.status,
          'ordinal', section_row.ordinal,
          'started_at', section_row.started_at,
          'completed_at', section_row.completed_at,
          'version', section_row.version
        )
        order by section_row.ordinal
      ),
      '[]'::jsonb
    ) as sections
    from public.live_session_sections as section_row
    where section_row.session_id = p_session_id
  )
  select
    session_row.id as session_id,
    session_row.event_company_name,
    session_row.event_reporting_period,
    session_row.event_metadata,
    active_section.section_key as active_section_key,
    section_payload.sections
  from public.live_sessions as session_row
  cross join section_payload
  left join public.live_session_sections as active_section
    on active_section.session_id = session_row.id
   and active_section.status = 'active'
  where session_row.id = p_session_id;
end;
$$;

create or replace function public.cleanup_expired_live_glossary_documents()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleared_session_pins integer := 0;
  deleted_document_versions integer := 0;
  deleted_sections integer := 0;
begin
  update public.live_sessions as session_row
  set pinned_glossary_preset_id = null,
      pinned_glossary_version = null,
      pinned_glossary_fingerprint = null,
      updated_at = statement_timestamp()
  where session_row.pinned_glossary_preset_id is not null
    and coalesce(session_row.ended_at, session_row.expires_at, session_row.updated_at, session_row.created_at)
      < statement_timestamp() - interval '30 days';

  GET DIAGNOSTICS cleared_session_pins = ROW_COUNT;

  delete from public.host_glossary_preset_versions as version_row
  using public.host_glossary_presets as preset_row
  where version_row.preset_id = preset_row.id
    and version_row.created_at < statement_timestamp() - interval '30 days'
    and (
      preset_row.active_document_version is distinct from version_row.version
      or preset_row.active_document_fingerprint is distinct from version_row.fingerprint
    )
    and not exists (
      select 1
      from public.live_sessions as pinned_session
      where pinned_session.pinned_glossary_preset_id = version_row.preset_id
        and pinned_session.pinned_glossary_version = version_row.version
        and pinned_session.pinned_glossary_fingerprint = version_row.fingerprint
    );

  GET DIAGNOSTICS deleted_document_versions = ROW_COUNT;

  delete from public.live_session_sections as section_row
  using public.live_sessions as session_row
  where section_row.session_id = session_row.id
    and coalesce(session_row.ended_at, session_row.updated_at, session_row.created_at)
      < statement_timestamp() - interval '30 days';

  GET DIAGNOSTICS deleted_sections = ROW_COUNT;

  return cleared_session_pins + deleted_document_versions + deleted_sections;
end;
$$;

revoke all on function public.create_host_glossary_document_preset_v1(text, text, text, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.list_host_glossary_documents_v1(text)
  from public, anon, authenticated;
revoke all on function public.list_host_glossary_document_versions_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.read_host_glossary_document_version_v1(text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.delete_host_glossary_preset(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.normalize_live_session_event_text(text, integer)
  from public, anon, authenticated;
revoke all on function public.normalize_live_session_event_metadata(jsonb)
  from public, anon, authenticated;
revoke all on function public.create_live_session_with_event_v1(uuid, text, text, text, text[], integer, text, text, text, timestamptz, timestamptz, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.update_live_session_with_event_v1(uuid, text, integer, text, text, text[], integer, text, text, text, timestamptz, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.save_host_glossary_document_version_v1(text, uuid, integer, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.activate_host_glossary_document_version_v1(text, uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.pin_live_session_glossary_version_v1(uuid, text, integer, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.read_live_session_pinned_glossary_v1(uuid)
  from public, anon, authenticated;
revoke all on function public.transition_live_session_section_v1(uuid, text, integer, text, text, bigint)
  from public, anon, authenticated;
revoke all on function public.read_live_session_event_context_v1(uuid)
  from public, anon, authenticated;
revoke all on function public.cleanup_expired_live_glossary_documents()
  from public, anon, authenticated;

grant execute on function public.create_host_glossary_document_preset_v1(text, text, text, text, text, jsonb, text)
  to service_role;
grant execute on function public.list_host_glossary_documents_v1(text)
  to service_role;
grant execute on function public.list_host_glossary_document_versions_v1(text, uuid)
  to service_role;
grant execute on function public.read_host_glossary_document_version_v1(text, uuid, integer)
  to service_role;
grant execute on function public.delete_host_glossary_preset(uuid, text, integer)
  to service_role;
grant execute on function public.normalize_live_session_event_text(text, integer)
  to service_role;
grant execute on function public.normalize_live_session_event_metadata(jsonb)
  to service_role;
grant execute on function public.create_live_session_with_event_v1(uuid, text, text, text, text[], integer, text, text, text, timestamptz, timestamptz, text, text, jsonb)
  to service_role;
grant execute on function public.update_live_session_with_event_v1(uuid, text, integer, text, text, text[], integer, text, text, text, timestamptz, text, text, jsonb)
  to service_role;
grant execute on function public.save_host_glossary_document_version_v1(text, uuid, integer, jsonb, text)
  to service_role;
grant execute on function public.activate_host_glossary_document_version_v1(text, uuid, integer, integer)
  to service_role;
grant execute on function public.pin_live_session_glossary_version_v1(uuid, text, integer, uuid, integer)
  to service_role;
grant execute on function public.read_live_session_pinned_glossary_v1(uuid)
  to service_role;
grant execute on function public.transition_live_session_section_v1(uuid, text, integer, text, text, bigint)
  to service_role;
grant execute on function public.read_live_session_event_context_v1(uuid)
  to service_role;
grant execute on function public.cleanup_expired_live_glossary_documents()
  to service_role;

do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_namespace
    where nspname = 'cron'
  ) then
    perform cron.schedule(
      'realtime-noel-live-glossary-document-cleanup',
      '23 19 * * *',
      'select public.cleanup_expired_live_glossary_documents();'
    );
  end if;
end;
$$;
-- ===================================================================
-- supabase/migrations/202608150005_live_records_sheets_outbox.sql

-- 2026-08-15 feat: Keep Live Call archives in NOVA and project participant
-- operations through a PII-free transactional Sheets outbox.

-- ─── Archive lifecycle ───

alter table public.live_sessions
  add column if not exists archived_at timestamptz,
  add column if not exists archive_deleted_at timestamptz,
  add column if not exists archive_purge_after timestamptz;

alter table public.live_sessions
  add constraint live_sessions_archive_lifecycle_check check (
    (
      archive_deleted_at is null
      and archive_purge_after is null
    )
    or (
      archived_at is not null
      and archive_deleted_at is not null
      and archive_purge_after is not null
      and archive_purge_after >= archive_deleted_at + interval '30 days'
    )
  );

alter table public.live_sessions
  drop constraint if exists live_sessions_max_viewers_check;
alter table public.live_sessions
  add constraint live_sessions_max_viewers_check
  check (max_viewers between 1 and 200);

create or replace function public.create_live_session(
  p_session_id uuid,
  p_host_id text,
  p_session_type text,
  p_output_mode text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text,
  p_voice_provider text,
  p_title text,
  p_scheduled_at timestamptz,
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
  title text,
  scheduled_at timestamptz,
  admission_open_until timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  normalized_title text;
  expiry_basis timestamptz;
begin
  normalized_title := nullif(normalize(btrim(coalesce(p_title, '')), NFC), '');
  expiry_basis := greatest(statement_timestamp(), coalesce(p_scheduled_at, statement_timestamp()));

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
    or p_max_viewers not between 1 and 200
    or p_glossary_pack is null
    or p_glossary_pack not in ('general_cre', 'hotel', 'fnb')
    or normalized_title is null
    or char_length(normalized_title) not between 1 and 120
    or normalized_title ~ '[[:cntrl:]]'
    or normalized_title ~ '[<>]'
    or (
      p_scheduled_at is not null
      and (
        p_scheduled_at < statement_timestamp() - interval '5 minutes'
        or p_scheduled_at > statement_timestamp() + interval '30 days'
      )
    )
    or p_expires_at is null
    or p_expires_at <= expiry_basis
    or p_expires_at > expiry_basis + interval '6 hours'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_INPUT';
  end if;

  return query
  insert into public.live_sessions as created_session (
    id, host_id, mode, voice_output_mode, session_type, output_mode,
    voice_provider, status, languages, viewer_count, max_viewers, version,
    glossary_pack, title, scheduled_at, expires_at, created_at, updated_at
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
    normalized_title,
    p_scheduled_at,
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
    created_session.title,
    created_session.scheduled_at,
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
  p_voice_provider text,
  p_title text,
  p_scheduled_at timestamptz
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
  title text,
  scheduled_at timestamptz,
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
  normalized_title text;
begin
  normalized_title := nullif(normalize(btrim(coalesce(p_title, '')), NFC), '');

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
    or p_max_viewers not between 1 and 200
    or p_glossary_pack is null
    or p_glossary_pack not in ('general_cre', 'hotel', 'fnb')
    or normalized_title is null
    or char_length(normalized_title) not between 1 and 120
    or normalized_title ~ '[[:cntrl:]]'
    or normalized_title ~ '[<>]'
    or (
      p_scheduled_at is not null
      and (
        p_scheduled_at < statement_timestamp() - interval '5 minutes'
        or p_scheduled_at > statement_timestamp() + interval '30 days'
      )
    )
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
      title = normalized_title,
      scheduled_at = p_scheduled_at,
      expires_at = greatest(statement_timestamp(), coalesce(p_scheduled_at, statement_timestamp()))
        + interval '6 hours',
      version = session_row.version + 1,
      updated_at = statement_timestamp()
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.version = p_expected_version
    and session_row.status = 'preparing'
    and session_row.expires_at > statement_timestamp()
    and session_row.viewer_count <= p_max_viewers
    and (
      p_scheduled_at is null
      or p_scheduled_at between
        session_row.created_at - interval '5 minutes'
        and session_row.created_at + interval '30 days'
    )
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
  title := updated_session.title;
  scheduled_at := updated_session.scheduled_at;
  admission_open_until := updated_session.admission_open_until;
  expires_at := updated_session.expires_at;
  return next;
end;
$$;

create index live_sessions_archive_owner_idx
  on public.live_sessions (host_id, archived_at desc, id)
  where archived_at is not null and archive_deleted_at is null;
create index live_sessions_archive_purge_idx
  on public.live_sessions (archive_purge_after, id)
  where archive_purge_after is not null;

drop policy if exists live_sessions_host_select on public.live_sessions;
create policy live_sessions_host_select
  on public.live_sessions for select to authenticated
  using (
    host_id = (select auth.uid())::text
    and archive_deleted_at is null
  );

update public.live_sessions
set archived_at = coalesce(ended_at, updated_at, created_at)
where archived_at is null
  and status in ('stopped', 'failed');

create or replace function public.mark_live_session_archived()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('stopped', 'failed')
    and (tg_op = 'INSERT' or old.status is distinct from new.status)
  then
    new.archived_at := coalesce(new.archived_at, new.ended_at, statement_timestamp());
  end if;
  return new;
end;
$$;

create trigger live_sessions_archive_before_write
before insert or update of status, ended_at on public.live_sessions
for each row execute function public.mark_live_session_archived();

-- ─── Purpose-scoped immutable consent ───

create table public.live_participant_consents (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  participant_id uuid not null references public.live_participants(id) on delete cascade,
  purpose text not null
    check (purpose in ('privacy', 'summary_delivery', 'marketing')),
  notice_version text not null
    check (
      char_length(notice_version) between 1 and 64
      and notice_version = normalize(btrim(notice_version), NFC)
      and notice_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    ),
  revision integer not null check (revision between 1 and 2147483647),
  is_accepted boolean not null,
  accepted_at timestamptz,
  withdrawn_at timestamptz,
  recorded_at timestamptz not null default statement_timestamp(),
  constraint live_participant_consents_state_check check (
    (
      is_accepted is true
      and accepted_at is not null
      and withdrawn_at is null
    )
    or (
      is_accepted is false
      and (
        (accepted_at is null and withdrawn_at is null)
        or (accepted_at is not null and withdrawn_at is not null and withdrawn_at >= accepted_at)
      )
    )
  ),
  unique (participant_id, purpose, revision)
);

create index live_participant_consents_session_participant_idx
  on public.live_participant_consents (session_id, participant_id, purpose, revision desc);

alter table public.live_participant_consents enable row level security;

create or replace function public.assert_live_participant_consent_binding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.live_participants participant_row
    where participant_row.id = new.participant_id
      and participant_row.session_id = new.session_id
  ) then
    raise exception using errcode = '23503', message = 'LIVE_CONSENT_PARTICIPANT_MISMATCH';
  end if;
  return new;
end;
$$;

create trigger live_participant_consents_binding_before_insert
before insert on public.live_participant_consents
for each row execute function public.assert_live_participant_consent_binding();

create or replace function public.prevent_live_participant_consent_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1
    from public.live_sessions session_row
    where session_row.id = old.session_id
  ) then
    return old;
  end if;
  raise exception using errcode = '55000', message = 'LIVE_CONSENT_AUDIT_IMMUTABLE';
end;
$$;

create trigger live_participant_consents_immutable_before_change
before update or delete on public.live_participant_consents
for each row execute function public.prevent_live_participant_consent_mutation();

insert into public.live_participant_consents (
  session_id,
  participant_id,
  purpose,
  notice_version,
  revision,
  is_accepted,
  accepted_at,
  recorded_at
)
select
  participant_row.session_id,
  participant_row.id,
  'summary_delivery',
  'legacy-summary-v1',
  1,
  true,
  participant_row.summary_consent_at,
  participant_row.summary_consent_at
from public.live_participants participant_row
where participant_row.summary_consent_at is not null
on conflict (participant_id, purpose, revision) do nothing;

-- ─── Stable Sheets coordinates and PII-free jobs ───

create sequence public.live_sheet_id_seq
  as integer minvalue 1 maxvalue 2147483647 no cycle;
create sequence public.live_sheet_index_row_seq
  as integer minvalue 1 maxvalue 2147483647 no cycle;

create table public.live_sheet_exports (
  session_id uuid primary key references public.live_sessions(id) on delete cascade,
  workbook_ref_version integer not null default 1
    check (workbook_ref_version between 1 and 2147483647),
  sheet_id integer not null default nextval('public.live_sheet_id_seq'::regclass),
  session_index_row integer not null default nextval('public.live_sheet_index_row_seq'::regclass),
  tab_title text not null,
  projection_version bigint not null default 0
    check (projection_version between 0 and 9223372036854775806),
  last_exported_projection_version bigint not null default 0
    check (last_exported_projection_version between 0 and 9223372036854775806),
  last_exported_participant_count integer not null default 0
    check (last_exported_participant_count between 0 and 10000),
  last_outcome text not null default 'never'
    check (last_outcome in ('never', 'succeeded', 'failed')),
  last_error_code text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint live_sheet_exports_sheet_id_check check (sheet_id between 1 and 2147483647),
  constraint live_sheet_exports_index_row_check check (session_index_row between 1 and 2147483647),
  constraint live_sheet_exports_version_order_check check (
    last_exported_projection_version <= projection_version
  ),
  constraint live_sheet_exports_tab_title_check check (
    char_length(tab_title) between 1 and 100
    and tab_title = normalize(btrim(tab_title), NFC)
    and tab_title !~ '[[:cntrl:]\\[\\]:*?/\\\\]'
    and left(tab_title, 1) !~ '[''=+@-]'
  ),
  constraint live_sheet_exports_error_check check (
    last_error_code is null or last_error_code ~ '^[A-Z0-9_]{3,64}$'
  ),
  unique (sheet_id),
  unique (session_index_row),
  unique (tab_title)
);

alter sequence public.live_sheet_id_seq owned by public.live_sheet_exports.sheet_id;
alter sequence public.live_sheet_index_row_seq owned by public.live_sheet_exports.session_index_row;

create table public.live_sheet_sync_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  claim_scope text not null default 'configured_workbook'
    check (claim_scope = 'configured_workbook'),
  projection_version bigint not null check (projection_version between 1 and 9223372036854775806),
  reason text not null check (
    reason in (
      'session_created',
      'session_changed',
      'session_ended',
      'participant_changed',
      'consent_changed',
      'archive_deleted',
      'archive_restored',
      'manual_retry',
      'migration_backfill'
    )
  ),
  state text not null default 'pending'
    check (state in ('pending', 'running', 'succeeded', 'failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 10),
  idempotency_key text not null
    check (idempotency_key ~ '^[0-9a-f-]{36}:[1-9][0-9]{0,18}$'),
  claim_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  safe_error_code text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint live_sheet_sync_jobs_claim_check check (
    (
      state = 'pending'
      and claim_token is null
      and claimed_at is null
      and lease_expires_at is null
      and completed_at is null
    )
    or (
      state = 'running'
      and claim_token is not null
      and claimed_at is not null
      and lease_expires_at > claimed_at
      and completed_at is null
    )
    or (
      state in ('succeeded', 'failed')
      and claim_token is not null
      and claimed_at is not null
      and lease_expires_at is not null
      and completed_at is not null
    )
  ),
  constraint live_sheet_sync_jobs_error_check check (
    safe_error_code is null or safe_error_code ~ '^[A-Z0-9_]{3,64}$'
  ),
  unique (session_id, projection_version)
);

create unique index live_sheet_sync_jobs_one_pending_idx
  on public.live_sheet_sync_jobs (session_id)
  where state = 'pending';
create unique index live_sheet_sync_jobs_one_running_idx
  on public.live_sheet_sync_jobs (claim_scope)
  where state = 'running';
create index live_sheet_sync_jobs_claim_idx
  on public.live_sheet_sync_jobs (state, created_at, id);

create table public.live_sheet_workbook_leases (
  scope text primary key check (scope = 'configured_workbook'),
  running_job_id uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default statement_timestamp(),
  constraint live_sheet_workbook_leases_state_check check (
    (
      running_job_id is null
      and lease_token is null
      and lease_expires_at is null
    )
    or (
      running_job_id is not null
      and lease_token is not null
      and lease_expires_at is not null
    )
  )
);

insert into public.live_sheet_workbook_leases (scope)
values ('configured_workbook');

alter table public.live_sheet_exports enable row level security;
alter table public.live_sheet_sync_jobs enable row level security;
alter table public.live_sheet_workbook_leases enable row level security;

create or replace function public.make_live_sheet_tab_title(
  p_session_date date,
  p_title text,
  p_sheet_id integer
)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  clean_title text;
  suffix text;
  result_title text;
begin
  if p_session_date is null or p_sheet_id not between 1 and 2147483647 then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_COORDINATE';
  end if;
  clean_title := normalize(btrim(coalesce(p_title, '')), NFC);
  clean_title := regexp_replace(clean_title, '[[:cntrl:]\[\]:*?/\\]', ' ', 'g');
  clean_title := regexp_replace(clean_title, '[[:space:]]+', ' ', 'g');
  clean_title := nullif(btrim(clean_title), '');
  suffix := ' #' || p_sheet_id::text;
  result_title := to_char(p_session_date, 'YYYY-MM-DD') || ' '
    || left(coalesce(clean_title, 'Live Call'), 100 - 11 - char_length(suffix))
    || suffix;
  return normalize(btrim(result_title), NFC);
end;
$$;

create or replace function public.enqueue_live_sheet_projection(
  p_session_id uuid,
  p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  export_row public.live_sheet_exports%rowtype;
  allocated_sheet_id integer;
  allocated_index_row integer;
  next_projection_version bigint;
begin
  if p_session_id is null
    or p_reason not in (
      'session_created', 'session_changed', 'session_ended',
      'participant_changed', 'consent_changed', 'archive_deleted',
      'archive_restored', 'manual_retry', 'migration_backfill'
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_ENQUEUE';
  end if;

  select * into session_row
  from public.live_sessions
  where id = p_session_id
  for update;
  if not found then
    raise exception using errcode = '23503', message = 'LIVE_SESSION_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.live_sheet_exports where session_id = p_session_id
  ) then
    allocated_sheet_id := nextval('public.live_sheet_id_seq'::regclass);
    allocated_index_row := nextval('public.live_sheet_index_row_seq'::regclass);
    insert into public.live_sheet_exports (
      session_id, sheet_id, session_index_row, tab_title
    ) values (
      p_session_id,
      allocated_sheet_id,
      allocated_index_row,
      public.make_live_sheet_tab_title(
        coalesce(session_row.scheduled_at, session_row.created_at)::date,
        session_row.title,
        allocated_sheet_id
      )
    )
    on conflict (session_id) do nothing;
  end if;

  select * into export_row
  from public.live_sheet_exports
  where session_id = p_session_id
  for update;

  next_projection_version := export_row.projection_version + 1;
  update public.live_sheet_exports
  set projection_version = next_projection_version,
      tab_title = case
        when export_row.last_exported_projection_version = 0
          then public.make_live_sheet_tab_title(
            coalesce(session_row.scheduled_at, session_row.created_at)::date,
            session_row.title,
            export_row.sheet_id
          )
        else export_row.tab_title
      end,
      updated_at = statement_timestamp()
  where session_id = p_session_id;

  insert into public.live_sheet_sync_jobs (
    session_id,
    projection_version,
    reason,
    state,
    idempotency_key
  ) values (
    p_session_id,
    next_projection_version,
    p_reason,
    'pending',
    p_session_id::text || ':' || next_projection_version::text
  )
  on conflict (session_id) where (state = 'pending')
  do update set
    projection_version = excluded.projection_version,
    reason = excluded.reason,
    idempotency_key = excluded.idempotency_key,
    updated_at = statement_timestamp();

  return next_projection_version;
end;
$$;

-- ─── Canonical mutation hooks ───

create or replace function public.enqueue_live_session_projection_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.enqueue_live_sheet_projection(new.id, 'session_created');
  elsif new.status in ('stopped', 'failed') and old.status is distinct from new.status then
    perform public.enqueue_live_sheet_projection(new.id, 'session_ended');
  else
    perform public.enqueue_live_sheet_projection(new.id, 'session_changed');
  end if;
  return new;
end;
$$;

create trigger live_sessions_sheet_projection_after_insert
after insert on public.live_sessions
for each row execute function public.enqueue_live_session_projection_trigger();

create trigger live_sessions_sheet_projection_after_end
after update of title, scheduled_at, languages, status, ended_at on public.live_sessions
for each row
when (
  old.title is distinct from new.title
  or old.scheduled_at is distinct from new.scheduled_at
  or old.languages is distinct from new.languages
  or old.status is distinct from new.status
  or old.ended_at is distinct from new.ended_at
)
execute function public.enqueue_live_session_projection_trigger();

create or replace function public.enqueue_live_participant_projection_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enqueue_live_sheet_projection(new.session_id, 'participant_changed');
  return new;
end;
$$;

create trigger live_participants_sheet_projection_after_change
after insert or update of email, company, department, job_title, joined_at, left_at
on public.live_participants
for each row execute function public.enqueue_live_participant_projection_trigger();

create or replace function public.enqueue_live_consent_projection_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_session record;
begin
  for affected_session in
    select distinct consent_row.session_id
    from new_consent_rows consent_row
  loop
    perform public.enqueue_live_sheet_projection(
      affected_session.session_id,
      'consent_changed'
    );
  end loop;
  return null;
end;
$$;

create trigger live_consents_sheet_projection_after_insert
after insert on public.live_participant_consents
referencing new table as new_consent_rows
for each statement execute function public.enqueue_live_consent_projection_trigger();

create or replace function public.enqueue_live_summary_projection_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_session record;
begin
  for affected_session in
    select distinct summary_row.session_id
    from new_summary_rows summary_row
  loop
    perform public.enqueue_live_sheet_projection(
      affected_session.session_id,
      'session_changed'
    );
  end loop;
  return null;
end;
$$;

create trigger live_meeting_summaries_sheet_projection_after_insert
after insert on public.live_meeting_summaries
referencing new table as new_summary_rows
for each statement execute function public.enqueue_live_summary_projection_trigger();

create trigger live_meeting_summaries_sheet_projection_after_update
after update on public.live_meeting_summaries
referencing new table as new_summary_rows
for each statement execute function public.enqueue_live_summary_projection_trigger();

create or replace function public.enqueue_failed_live_summary_projection_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enqueue_live_sheet_projection(new.session_id, 'session_changed');
  return new;
end;
$$;

create trigger live_summary_generation_jobs_sheet_projection_after_failure
after update of status on public.live_summary_generation_jobs
for each row
when (
  old.status is distinct from new.status
  and new.status = 'failed'
)
execute function public.enqueue_failed_live_summary_projection_trigger();

-- ─── Consent and admission RPCs ───

create or replace function public.record_live_participant_consent_v1(
  p_session_id uuid,
  p_participant_id uuid,
  p_user_id text,
  p_purpose text,
  p_notice_version text,
  p_is_accepted boolean
)
returns table (
  consent_id uuid,
  session_id uuid,
  participant_id uuid,
  purpose text,
  notice_version text,
  revision integer,
  is_accepted boolean,
  accepted_at timestamptz,
  withdrawn_at timestamptz,
  recorded_at timestamptz,
  projection_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  participant_row public.live_participants%rowtype;
  latest_consent public.live_participant_consents%rowtype;
  inserted_consent public.live_participant_consents%rowtype;
  normalized_notice_version text;
  next_revision integer;
begin
  normalized_notice_version := normalize(btrim(coalesce(p_notice_version, '')), NFC);
  if p_session_id is null
    or p_participant_id is null
    or p_user_id is null
    or char_length(p_user_id) not between 1 and 256
    or p_purpose not in ('privacy', 'summary_delivery', 'marketing')
    or p_is_accepted is null
    or char_length(normalized_notice_version) not between 1 and 64
    or normalized_notice_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_CONSENT_INPUT';
  end if;
  if p_purpose = 'privacy' and p_is_accepted is false then
    raise exception using errcode = '22023', message = 'PRIVACY_CONSENT_REQUIRED';
  end if;

  select * into participant_row
  from public.live_participants participant_row
  where participant_row.id = p_participant_id
    and participant_row.session_id = p_session_id
    and participant_row.user_id = p_user_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'PARTICIPANT_CONSENT_FORBIDDEN';
  end if;

  select * into latest_consent
  from public.live_participant_consents consent_row
  where consent_row.participant_id = p_participant_id
    and consent_row.purpose = p_purpose
  order by consent_row.revision desc
  limit 1;

  if found
    and latest_consent.notice_version = normalized_notice_version
    and latest_consent.is_accepted = p_is_accepted
  then
    select export_row.projection_version into projection_version
    from public.live_sheet_exports export_row
    where export_row.session_id = p_session_id;
    consent_id := latest_consent.id;
    session_id := latest_consent.session_id;
    participant_id := latest_consent.participant_id;
    purpose := latest_consent.purpose;
    notice_version := latest_consent.notice_version;
    revision := latest_consent.revision;
    is_accepted := latest_consent.is_accepted;
    accepted_at := latest_consent.accepted_at;
    withdrawn_at := latest_consent.withdrawn_at;
    recorded_at := latest_consent.recorded_at;
    return next;
    return;
  end if;

  select coalesce(max(consent_row.revision), 0) + 1 into next_revision
  from public.live_participant_consents consent_row
  where consent_row.participant_id = p_participant_id
    and consent_row.purpose = p_purpose;

  insert into public.live_participant_consents (
    session_id,
    participant_id,
    purpose,
    notice_version,
    revision,
    is_accepted,
    accepted_at,
    withdrawn_at,
    recorded_at
  ) values (
    p_session_id,
    p_participant_id,
    p_purpose,
    normalized_notice_version,
    next_revision,
    p_is_accepted,
    case when p_is_accepted then statement_timestamp() else latest_consent.accepted_at end,
    case
      when p_is_accepted then null
      when latest_consent.is_accepted then statement_timestamp()
      else latest_consent.withdrawn_at
    end,
    statement_timestamp()
  )
  returning * into inserted_consent;

  select export_row.projection_version into projection_version
  from public.live_sheet_exports export_row
  where export_row.session_id = p_session_id;
  consent_id := inserted_consent.id;
  session_id := inserted_consent.session_id;
  participant_id := inserted_consent.participant_id;
  purpose := inserted_consent.purpose;
  notice_version := inserted_consent.notice_version;
  revision := inserted_consent.revision;
  is_accepted := inserted_consent.is_accepted;
  accepted_at := inserted_consent.accepted_at;
  withdrawn_at := inserted_consent.withdrawn_at;
  recorded_at := inserted_consent.recorded_at;
  return next;
end;
$$;

create or replace function public.record_live_participant_consent_choices_v1(
  p_session_id uuid,
  p_participant_id uuid,
  p_user_id text,
  p_summary_is_accepted boolean,
  p_summary_notice_version text,
  p_marketing_is_accepted boolean,
  p_marketing_notice_version text
)
returns table (
  consent_id uuid,
  session_id uuid,
  participant_id uuid,
  purpose text,
  notice_version text,
  revision integer,
  is_accepted boolean,
  accepted_at timestamptz,
  withdrawn_at timestamptz,
  recorded_at timestamptz,
  projection_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  participant_row public.live_participants%rowtype;
  summary_consent public.live_participant_consents%rowtype;
  marketing_consent public.live_participant_consents%rowtype;
  normalized_summary_notice_version text;
  normalized_marketing_notice_version text;
  summary_revision integer;
  marketing_revision integer;
  consent_recorded_at timestamptz;
  committed_projection_version bigint;
begin
  normalized_summary_notice_version := normalize(
    btrim(coalesce(p_summary_notice_version, '')),
    NFC
  );
  normalized_marketing_notice_version := normalize(
    btrim(coalesce(p_marketing_notice_version, '')),
    NFC
  );
  if p_session_id is null
    or p_participant_id is null
    or p_user_id is null
    or char_length(p_user_id) not between 1 and 256
    or p_summary_is_accepted is null
    or p_marketing_is_accepted is null
    or char_length(normalized_summary_notice_version) not between 1 and 64
    or char_length(normalized_marketing_notice_version) not between 1 and 64
    or normalized_summary_notice_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    or normalized_marketing_notice_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_CONSENT_CHOICES_INPUT';
  end if;

  select * into participant_row
  from public.live_participants participant_row
  where participant_row.id = p_participant_id
    and participant_row.session_id = p_session_id
    and participant_row.user_id = p_user_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'PARTICIPANT_CONSENT_FORBIDDEN';
  end if;

  select * into summary_consent
  from public.live_participant_consents consent_row
  where consent_row.participant_id = p_participant_id
    and consent_row.purpose = 'summary_delivery'
  order by consent_row.revision desc
  limit 1;
  summary_revision := coalesce(summary_consent.revision, 0) + 1;

  select * into marketing_consent
  from public.live_participant_consents consent_row
  where consent_row.participant_id = p_participant_id
    and consent_row.purpose = 'marketing'
  order by consent_row.revision desc
  limit 1;
  marketing_revision := coalesce(marketing_consent.revision, 0) + 1;

  if summary_consent.id is not null
    and summary_consent.notice_version = normalized_summary_notice_version
    and summary_consent.is_accepted = p_summary_is_accepted
    and marketing_consent.id is not null
    and marketing_consent.notice_version = normalized_marketing_notice_version
    and marketing_consent.is_accepted = p_marketing_is_accepted
  then
    select export_row.projection_version into committed_projection_version
    from public.live_sheet_exports export_row
    where export_row.session_id = p_session_id;

    return query
    select
      existing_consent.id,
      existing_consent.session_id,
      existing_consent.participant_id,
      existing_consent.purpose,
      existing_consent.notice_version,
      existing_consent.revision,
      existing_consent.is_accepted,
      existing_consent.accepted_at,
      existing_consent.withdrawn_at,
      existing_consent.recorded_at,
      committed_projection_version
    from public.live_participant_consents existing_consent
    where existing_consent.id in (summary_consent.id, marketing_consent.id)
    order by case existing_consent.purpose
      when 'summary_delivery' then 1
      when 'marketing' then 2
      else 3
    end;
    return;
  end if;

  consent_recorded_at := statement_timestamp();

  insert into public.live_participant_consents (
    session_id,
    participant_id,
    purpose,
    notice_version,
    revision,
    is_accepted,
    accepted_at,
    withdrawn_at,
    recorded_at
  ) values (
    p_session_id,
    p_participant_id,
    'summary_delivery',
    normalized_summary_notice_version,
    summary_revision,
    p_summary_is_accepted,
    case
      when p_summary_is_accepted then consent_recorded_at
      else summary_consent.accepted_at
    end,
    case
      when p_summary_is_accepted then null
      when summary_consent.is_accepted then consent_recorded_at
      else summary_consent.withdrawn_at
    end,
    consent_recorded_at
  ), (
    p_session_id,
    p_participant_id,
    'marketing',
    normalized_marketing_notice_version,
    marketing_revision,
    p_marketing_is_accepted,
    case
      when p_marketing_is_accepted then consent_recorded_at
      else marketing_consent.accepted_at
    end,
    case
      when p_marketing_is_accepted then null
      when marketing_consent.is_accepted then consent_recorded_at
      else marketing_consent.withdrawn_at
    end,
    consent_recorded_at
  );

  select export_row.projection_version into committed_projection_version
  from public.live_sheet_exports export_row
  where export_row.session_id = p_session_id;

  return query
  select
    inserted_consent.id,
    inserted_consent.session_id,
    inserted_consent.participant_id,
    inserted_consent.purpose,
    inserted_consent.notice_version,
    inserted_consent.revision,
    inserted_consent.is_accepted,
    inserted_consent.accepted_at,
    inserted_consent.withdrawn_at,
    inserted_consent.recorded_at,
    committed_projection_version
  from public.live_participant_consents inserted_consent
  where inserted_consent.participant_id = p_participant_id
    and (
      (
        inserted_consent.purpose = 'summary_delivery'
        and inserted_consent.revision = summary_revision
      )
      or (
        inserted_consent.purpose = 'marketing'
        and inserted_consent.revision = marketing_revision
      )
    )
  order by case inserted_consent.purpose
    when 'summary_delivery' then 1
    when 'marketing' then 2
    else 3
  end;
end;
$$;

create or replace function public.redeem_live_attendee_v2(
  p_invite_token_hmac text,
  p_code_hmac text,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_email text,
  p_company text,
  p_department text,
  p_job_title text,
  p_privacy_consent boolean,
  p_privacy_notice_version text,
  p_summary_consent boolean,
  p_summary_notice_version text,
  p_marketing_consent boolean,
  p_marketing_notice_version text
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
  email text,
  company text,
  department text,
  job_title text,
  summary_consent_at timestamptz,
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
  attendee_result record;
begin
  if p_privacy_consent is not true
    or p_summary_consent is null
    or p_marketing_consent is null
  then
    raise exception using errcode = '22023', message = 'PRIVACY_CONSENT_REQUIRED';
  end if;

  select * into attendee_result
  from public.redeem_live_attendee_v1(
    p_invite_token_hmac,
    p_code_hmac,
    p_user_id,
    p_device_hash,
    p_grant_expires_at,
    p_email,
    p_company,
    p_department,
    p_job_title,
    p_summary_consent
  );

  perform public.record_live_participant_consent_v1(
    attendee_result.session_id, attendee_result.participant_id, p_user_id,
    'privacy', p_privacy_notice_version, true
  );
  perform public.record_live_participant_consent_v1(
    attendee_result.session_id, attendee_result.participant_id, p_user_id,
    'summary_delivery', p_summary_notice_version, p_summary_consent
  );
  perform public.record_live_participant_consent_v1(
    attendee_result.session_id, attendee_result.participant_id, p_user_id,
    'marketing', p_marketing_notice_version, p_marketing_consent
  );

  return query select
    attendee_result.grant_id,
    attendee_result.session_id,
    attendee_result.user_id,
    attendee_result.grant_expires_at,
    attendee_result.session_type,
    attendee_result.output_mode,
    attendee_result.languages,
    attendee_result.session_expires_at,
    attendee_result.viewer_count,
    attendee_result.max_viewers,
    attendee_result.glossary_pack,
    attendee_result.display_name,
    attendee_result.email,
    attendee_result.company,
    attendee_result.department,
    attendee_result.job_title,
    attendee_result.summary_consent_at,
    attendee_result.participant_id,
    attendee_result.voice_provider,
    attendee_result.status,
    attendee_result.title,
    attendee_result.scheduled_at;
end;
$$;

-- ─── Sheets worker RPCs ───

create or replace function public.claim_live_sheet_sync_job_v1(
  p_claim_token uuid
)
returns table (
  job_id uuid,
  session_id uuid,
  session_index_row integer,
  sheet_id integer,
  tab_title text,
  should_create boolean,
  projection_version bigint,
  previous_participant_count integer,
  workbook_ref_version integer,
  reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.live_sheet_sync_jobs%rowtype;
  lease_row public.live_sheet_workbook_leases%rowtype;
begin
  if p_claim_token is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_CLAIM';
  end if;

  select * into lease_row
  from public.live_sheet_workbook_leases lease_row
  where lease_row.scope = 'configured_workbook'
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'SHEETS_WORKBOOK_LEASE_MISSING';
  end if;

  if lease_row.running_job_id is not null
    and lease_row.lease_expires_at <= statement_timestamp()
  then
    update public.live_sheet_sync_jobs
    set state = 'failed',
        completed_at = statement_timestamp(),
        safe_error_code = 'SHEETS_CLAIM_LEASE_EXPIRED',
        updated_at = statement_timestamp()
    where id = lease_row.running_job_id
      and state = 'running'
      and claim_token = lease_row.lease_token;

    update public.live_sheet_exports export_row
    set last_outcome = 'failed',
        last_error_code = 'SHEETS_CLAIM_LEASE_EXPIRED',
        updated_at = statement_timestamp()
    from public.live_sheet_sync_jobs expired_job
    where expired_job.id = lease_row.running_job_id
      and export_row.session_id = expired_job.session_id;

    update public.live_sheet_workbook_leases
    set running_job_id = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = statement_timestamp()
    where scope = 'configured_workbook';
    lease_row.running_job_id := null;
    lease_row.lease_token := null;
    lease_row.lease_expires_at := null;
  end if;

  if lease_row.running_job_id is not null then
    return;
  end if;

  select * into job_row
  from public.live_sheet_sync_jobs
  where state = 'pending'
  order by created_at, id
  for update skip locked
  limit 1;
  if not found then
    return;
  end if;
  update public.live_sheet_sync_jobs
  set state = 'running',
      claim_token = p_claim_token,
      claimed_at = statement_timestamp(),
      lease_expires_at = statement_timestamp() + interval '5 minutes',
      attempt_count = attempt_count + 1,
      updated_at = statement_timestamp()
  where id = job_row.id
    and state = 'pending'
  returning * into job_row;

  update public.live_sheet_workbook_leases
  set running_job_id = job_row.id,
      lease_token = p_claim_token,
      lease_expires_at = job_row.lease_expires_at,
      updated_at = statement_timestamp()
  where scope = 'configured_workbook';

  return query
  select
    job_row.id,
    export_row.session_id,
    export_row.session_index_row,
    export_row.sheet_id,
    export_row.tab_title,
    export_row.last_exported_projection_version = 0,
    job_row.projection_version,
    export_row.last_exported_participant_count,
    export_row.workbook_ref_version,
    job_row.reason
  from public.live_sheet_exports export_row
  where export_row.session_id = job_row.session_id;
end;
$$;

create or replace function public.read_live_sheet_projection_v1(
  p_job_id uuid,
  p_claim_token uuid
)
returns table (
  session_index_row integer,
  sheet_id integer,
  tab_title text,
  should_create boolean,
  projection_version bigint,
  previous_participant_count integer,
  session_id uuid,
  session_date date,
  session_title text,
  session_status text,
  summary_state text,
  languages text[],
  archived_at timestamptz,
  archive_deleted_at timestamptz,
  participant_count integer,
  participants jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_job_id is null or p_claim_token is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_PROJECTION';
  end if;
  return query
  select
    export_row.session_index_row,
    export_row.sheet_id,
    export_row.tab_title,
    export_row.last_exported_projection_version = 0,
    job_row.projection_version,
    export_row.last_exported_participant_count,
    session_row.id,
    coalesce(session_row.scheduled_at, session_row.created_at)::date,
    session_row.title,
    session_row.status,
    case
      when (
        select count(distinct summary_row.language)
        from public.live_meeting_summaries summary_row
        where summary_row.session_id = session_row.id
          and summary_row.language = any(session_row.languages)
      ) = cardinality(session_row.languages) then 'ready'
      when exists (
        select 1
        from public.live_summary_generation_jobs summary_job
        where summary_job.session_id = session_row.id
          and summary_job.status = 'running'
      ) then 'running'
      when exists (
        select 1
        from public.live_summary_generation_jobs summary_job
        where summary_job.session_id = session_row.id
          and summary_job.status = 'failed'
      ) then 'failed'
      when session_row.status in ('stopped', 'failed') then 'pending'
      else 'not_started'
    end,
    session_row.languages,
    session_row.archived_at,
    session_row.archive_deleted_at,
    count(participant_row.id)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'participantId', participant_row.id,
          'email', participant_row.email,
          'company', participant_row.company,
          'department', participant_row.department,
          'jobTitle', participant_row.job_title,
          'joinedAt', participant_row.joined_at,
          'leftAt', participant_row.left_at,
          'deliveryStatus', case
            when participant_row.summary_consent_at is null then 'not_requested'
            else 'eligible'
          end,
          'consents', coalesce((
            select jsonb_object_agg(
              current_consent.purpose,
              jsonb_build_object(
                'noticeVersion', current_consent.notice_version,
                'isAccepted', current_consent.is_accepted,
                'acceptedAt', current_consent.accepted_at,
                'withdrawnAt', current_consent.withdrawn_at,
                'recordedAt', current_consent.recorded_at
              )
            )
            from (
              select distinct on (consent_row.purpose)
                consent_row.purpose,
                consent_row.notice_version,
                consent_row.is_accepted,
                consent_row.accepted_at,
                consent_row.withdrawn_at,
                consent_row.recorded_at
              from public.live_participant_consents consent_row
              where consent_row.participant_id = participant_row.id
              order by consent_row.purpose, consent_row.revision desc
            ) current_consent
          ), '{}'::jsonb)
        )
        order by participant_row.joined_at, participant_row.id
      ) filter (where participant_row.id is not null),
      '[]'::jsonb
    )
  from public.live_sheet_sync_jobs job_row
  join public.live_sheet_exports export_row
    on export_row.session_id = job_row.session_id
  join public.live_sheet_workbook_leases workbook_lease
    on workbook_lease.scope = job_row.claim_scope
    and workbook_lease.running_job_id = job_row.id
    and workbook_lease.lease_token = job_row.claim_token
  join public.live_sessions session_row
    on session_row.id = job_row.session_id
  left join public.live_participants participant_row
    on participant_row.session_id = session_row.id
  where job_row.id = p_job_id
    and job_row.state = 'running'
    and job_row.claim_token = p_claim_token
    and job_row.lease_expires_at > statement_timestamp()
    and workbook_lease.lease_expires_at > statement_timestamp()
  group by
    export_row.session_index_row,
    export_row.sheet_id,
    export_row.tab_title,
    export_row.last_exported_projection_version,
    export_row.last_exported_participant_count,
    job_row.projection_version,
    session_row.id,
    session_row.scheduled_at,
    session_row.created_at,
    session_row.title,
    session_row.status,
    session_row.languages,
    session_row.archived_at,
    session_row.archive_deleted_at;
end;
$$;

create or replace function public.complete_live_sheet_sync_job_v1(
  p_job_id uuid,
  p_claim_token uuid,
  p_projection_version bigint,
  p_participant_count integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.live_sheet_sync_jobs%rowtype;
  lease_row public.live_sheet_workbook_leases%rowtype;
  changed_count integer;
begin
  if p_job_id is null
    or p_claim_token is null
    or p_projection_version < 1
    or p_participant_count not between 0 and 10000
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_COMPLETION';
  end if;

  select * into lease_row
  from public.live_sheet_workbook_leases lease_row
  where lease_row.scope = 'configured_workbook'
    and lease_row.running_job_id = p_job_id
    and lease_row.lease_token = p_claim_token
    and lease_row.lease_expires_at > statement_timestamp()
  for update;
  if not found then
    return false;
  end if;

  select * into job_row
  from public.live_sheet_sync_jobs job_row
  where job_row.id = p_job_id
    and job_row.state = 'running'
    and job_row.projection_version = p_projection_version
    and job_row.claim_token = p_claim_token
    and job_row.lease_expires_at = lease_row.lease_expires_at
  for update;
  if not found then
    return false;
  end if;

  update public.live_sheet_exports
  set last_exported_projection_version = p_projection_version,
      last_exported_participant_count = p_participant_count,
      last_outcome = 'succeeded',
      last_error_code = null,
      updated_at = statement_timestamp()
  where session_id = job_row.session_id
    and projection_version >= p_projection_version
    and last_exported_projection_version < p_projection_version;
  get diagnostics changed_count = row_count;
  if changed_count <> 1 then
    return false;
  end if;

  update public.live_sheet_sync_jobs
  set state = 'succeeded',
      completed_at = statement_timestamp(),
      safe_error_code = null,
      updated_at = statement_timestamp()
  where id = p_job_id;

  update public.live_sheet_workbook_leases
  set running_job_id = null,
      lease_token = null,
      lease_expires_at = null,
      updated_at = statement_timestamp()
  where scope = 'configured_workbook'
    and running_job_id = p_job_id
    and lease_token = p_claim_token;
  return true;
end;
$$;

create or replace function public.fail_live_sheet_sync_job_v1(
  p_job_id uuid,
  p_claim_token uuid,
  p_safe_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  failed_session_id uuid;
  lease_row public.live_sheet_workbook_leases%rowtype;
begin
  if p_job_id is null
    or p_claim_token is null
    or p_safe_error_code !~ '^[A-Z0-9_]{3,64}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_FAILURE';
  end if;

  select * into lease_row
  from public.live_sheet_workbook_leases lease_row
  where lease_row.scope = 'configured_workbook'
    and lease_row.running_job_id = p_job_id
    and lease_row.lease_token = p_claim_token
    and lease_row.lease_expires_at > statement_timestamp()
  for update;
  if not found then
    return false;
  end if;

  update public.live_sheet_sync_jobs
  set state = 'failed',
      completed_at = statement_timestamp(),
      safe_error_code = p_safe_error_code,
      updated_at = statement_timestamp()
  where id = p_job_id
    and state = 'running'
    and claim_token = p_claim_token
    and lease_expires_at = lease_row.lease_expires_at
  returning session_id into failed_session_id;
  if failed_session_id is null then
    return false;
  end if;
  update public.live_sheet_exports
  set last_outcome = 'failed',
      last_error_code = p_safe_error_code,
      updated_at = statement_timestamp()
  where session_id = failed_session_id;

  update public.live_sheet_workbook_leases
  set running_job_id = null,
      lease_token = null,
      lease_expires_at = null,
      updated_at = statement_timestamp()
  where scope = 'configured_workbook'
    and running_job_id = p_job_id
    and lease_token = p_claim_token;
  return true;
end;
$$;

create or replace function public.retry_live_sheet_sync_job_v1(
  p_session_id uuid,
  p_host_id text
)
returns table (
  projection_version bigint,
  state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  failed_job public.live_sheet_sync_jobs%rowtype;
  next_version bigint;
begin
  if p_session_id is null
    or p_host_id is null
    or char_length(p_host_id) not between 1 and 256
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_RETRY';
  end if;
  if not exists (
    select 1 from public.live_sessions session_row
    where session_row.id = p_session_id and session_row.host_id = p_host_id
  ) then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  if exists (
    select 1 from public.live_sheet_sync_jobs pending_job
    where pending_job.session_id = p_session_id
      and pending_job.state = 'pending'
  ) then
    raise exception using errcode = '40001', message = 'LIVE_SHEET_RETRY_CONFLICT';
  end if;
  select * into failed_job
  from public.live_sheet_sync_jobs job_row
  where job_row.session_id = p_session_id
    and job_row.state = 'failed'
  order by job_row.created_at desc, job_row.id desc
  for update
  limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_SHEET_RETRY_NOT_AVAILABLE';
  end if;
  next_version := public.enqueue_live_sheet_projection(p_session_id, 'manual_retry');
  return query
  select pending_job.projection_version, pending_job.state
  from public.live_sheet_sync_jobs pending_job
  where pending_job.session_id = p_session_id
    and pending_job.state = 'pending'
    and pending_job.projection_version = next_version;
end;
$$;

-- ─── Recoverable archive deletion ───

create or replace function public.request_live_session_archive_deletion_v1(
  p_session_id uuid,
  p_host_id text
)
returns table (
  session_id uuid,
  archive_deleted_at timestamptz,
  archive_purge_after timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_session_id is null or p_host_id is null or char_length(p_host_id) not between 1 and 256 then
    raise exception using errcode = '22023', message = 'INVALID_ARCHIVE_DELETE_INPUT';
  end if;
  return query
  update public.live_sessions session_row
  set archive_deleted_at = statement_timestamp(),
      archive_purge_after = statement_timestamp() + interval '30 days',
      updated_at = statement_timestamp()
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.archived_at is not null
    and session_row.archive_deleted_at is null
  returning session_row.id, session_row.archive_deleted_at, session_row.archive_purge_after;
  if not found then
    raise exception using errcode = 'P0001', message = 'ARCHIVE_DELETE_NOT_AVAILABLE';
  end if;
  perform public.enqueue_live_sheet_projection(p_session_id, 'archive_deleted');
end;
$$;

create or replace function public.restore_live_session_archive_v1(
  p_session_id uuid,
  p_host_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_session_id is null or p_host_id is null or char_length(p_host_id) not between 1 and 256 then
    raise exception using errcode = '22023', message = 'INVALID_ARCHIVE_RESTORE_INPUT';
  end if;
  update public.live_sessions session_row
  set archive_deleted_at = null,
      archive_purge_after = null,
      updated_at = statement_timestamp()
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.archive_deleted_at is not null
    and session_row.archive_purge_after > statement_timestamp();
  if not found then
    return false;
  end if;
  perform public.enqueue_live_sheet_projection(p_session_id, 'archive_restored');
  return true;
end;
$$;

create or replace function public.purge_live_session_archives_v1(
  p_limit integer default 50
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_ARCHIVE_PURGE_LIMIT';
  end if;
  with purgeable as (
    select session_row.id
    from public.live_sessions session_row
    where session_row.archive_deleted_at is not null
      and session_row.archive_purge_after <= statement_timestamp()
    order by session_row.archive_purge_after, session_row.id
    for update skip locked
    limit p_limit
  ), deleted as (
    delete from public.live_sessions session_row
    using purgeable
    where session_row.id = purgeable.id
    returning session_row.id
  )
  select count(*)::integer into deleted_count from deleted;
  return deleted_count;
end;
$$;

-- ─── Retention separation ───

create or replace function public.cleanup_expired_live_state()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  stopped_count integer;
begin
  perform 1
  from public.live_sessions session_lock
  where (
      session_lock.status <> 'stopped'
      and session_lock.expires_at <= statement_timestamp()
    )
    or exists (
      select 1 from public.viewer_grants grant_lock
      where grant_lock.session_id = session_lock.id
        and (
          grant_lock.revoked_at is not null
          or grant_lock.expires_at <= statement_timestamp()
          or session_lock.status = 'stopped'
          or session_lock.expires_at <= statement_timestamp()
        )
    )
    or exists (
      select 1 from public.live_recap_grants recap_lock
      where recap_lock.session_id = session_lock.id
        and recap_lock.expires_at <= statement_timestamp()
    )
  order by session_lock.id
  for update;

  with stopped as (
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
    );

  insert into public.live_recap_grants (session_id, user_id, expires_at, created_at)
  select grant_row.session_id, grant_row.user_id,
    statement_timestamp() + interval '30 days', statement_timestamp()
  from public.viewer_grants grant_row
  join public.live_sessions session_row on session_row.id = grant_row.session_id
  where session_row.status = 'stopped'
  on conflict (session_id, user_id) do update
    set expires_at = greatest(live_recap_grants.expires_at, excluded.expires_at);

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
    where revoked_at is null and expires_at > statement_timestamp()
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
      select 1 from public.viewer_grants grant_row
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
  delete from public.live_recap_grants
  where expires_at <= statement_timestamp();

  return stopped_count;
end;
$$;

create or replace function public.cleanup_expired_live_participants()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Participant operations belong to the ADMIN archive and are removed only
  -- by the recoverable parent-session purge.
  return 0;
end;
$$;

create or replace function public.cleanup_expired_live_topics()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Topics and assignment fences remain canonical archive content.
  return 0;
end;
$$;

-- Existing sessions receive a single coalesced projection without exposing
-- participant payload in the migration or job rows.
do $$
declare
  session_row record;
begin
  for session_row in select id from public.live_sessions order by id loop
    perform public.enqueue_live_sheet_projection(session_row.id, 'migration_backfill');
  end loop;
end $$;

-- ─── Closed tables and service-role-only RPCs ───

create or replace function public.live_record_summary_state_v1(
  p_session_id uuid,
  p_languages text[],
  p_status text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_session_id is null or p_languages is null or cardinality(p_languages) < 1 then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_SUMMARY_STATE';
  end if;
  if (
    select count(distinct summary_row.language)
    from public.live_meeting_summaries summary_row
    where summary_row.session_id = p_session_id
      and summary_row.language = any(p_languages)
  ) = cardinality(p_languages) then
    return 'ready';
  end if;
  if exists (
    select 1 from public.live_summary_generation_jobs summary_job
    where summary_job.session_id = p_session_id and summary_job.status = 'running'
  ) then
    return 'running';
  end if;
  if exists (
    select 1 from public.live_summary_generation_jobs summary_job
    where summary_job.session_id = p_session_id and summary_job.status = 'failed'
  ) then
    return 'failed';
  end if;
  if p_status in ('stopped', 'failed') then
    return 'pending';
  end if;
  return 'not_started';
end;
$$;

create or replace function public.live_record_sheet_sync_state_v1(
  p_session_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  latest_state text;
  last_outcome text;
begin
  select job_row.state into latest_state
  from public.live_sheet_sync_jobs job_row
  where job_row.session_id = p_session_id
  order by job_row.updated_at desc, job_row.id desc
  limit 1;
  if latest_state = 'running' then return 'syncing'; end if;
  if latest_state in ('pending', 'failed') then return latest_state; end if;
  select export_row.last_outcome into last_outcome
  from public.live_sheet_exports export_row
  where export_row.session_id = p_session_id;
  if latest_state = 'succeeded' or last_outcome = 'succeeded' then return 'succeeded'; end if;
  if last_outcome = 'failed' then return 'failed'; end if;
  return 'not_started';
end;
$$;

create or replace function public.list_owned_live_records_v1(
  p_host_id text,
  p_page integer,
  p_page_size integer,
  p_search text
)
returns table (
  session_id uuid,
  title text,
  status text,
  languages text[],
  created_at timestamptz,
  scheduled_at timestamptz,
  ended_at timestamptz,
  archived_at timestamptz,
  participant_count integer,
  summary_state text,
  sheet_sync_state text,
  sheet_error_code text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  normalized_search text;
begin
  normalized_search := normalize(btrim(coalesce(p_search, '')), NFC);
  if p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_page < 1
    or p_page > 100000
    or p_page_size not between 1 and 100
    or char_length(normalized_search) > 100
    or normalized_search ~ '[[:cntrl:]<>]'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_LIST_INPUT';
  end if;

  return query
  select
    session_row.id,
    session_row.title,
    session_row.status,
    session_row.languages,
    session_row.created_at,
    session_row.scheduled_at,
    session_row.ended_at,
    session_row.archived_at,
    (select count(*)::integer from public.live_participants participant_row
      where participant_row.session_id = session_row.id),
    public.live_record_summary_state_v1(
      session_row.id, session_row.languages, session_row.status
    ),
    public.live_record_sheet_sync_state_v1(session_row.id),
    coalesce((
      select job_row.safe_error_code
      from public.live_sheet_sync_jobs job_row
      where job_row.session_id = session_row.id and job_row.state = 'failed'
      order by job_row.updated_at desc, job_row.id desc
      limit 1
    ), export_row.last_error_code),
    count(*) over()
  from public.live_sessions session_row
  left join public.live_sheet_exports export_row
    on export_row.session_id = session_row.id
  where session_row.host_id = p_host_id
    and session_row.archived_at is not null
    and session_row.archive_deleted_at is null
    and (
      normalized_search = ''
      or position(lower(normalized_search) in lower(session_row.title)) > 0
      or position(
        normalized_search in to_char(
          coalesce(session_row.scheduled_at, session_row.created_at) at time zone 'UTC',
          'YYYY-MM-DD'
        )
      ) > 0
    )
  order by session_row.archived_at desc, session_row.id desc
  limit p_page_size
  offset (p_page - 1)::bigint * p_page_size;
end;
$$;

create or replace function public.read_owned_live_record_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  title text,
  status text,
  session_type text,
  output_mode text,
  languages text[],
  created_at timestamptz,
  scheduled_at timestamptz,
  ended_at timestamptz,
  archived_at timestamptz,
  participant_count bigint,
  utterance_count bigint,
  topic_count bigint,
  summary_state text,
  sheet_sync_state text,
  sheet_error_code text,
  sheet_id integer,
  session_index_row integer,
  tab_title text,
  projection_version bigint,
  last_exported_projection_version bigint,
  last_exported_participant_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  owned_session public.live_sessions%rowtype;
begin
  if p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_session_id is null
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_READ_INPUT';
  end if;
  select * into owned_session
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.archive_deleted_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;

  return query
  select
    owned_session.id,
    owned_session.title,
    owned_session.status,
    owned_session.session_type,
    owned_session.output_mode,
    owned_session.languages,
    owned_session.created_at,
    owned_session.scheduled_at,
    owned_session.ended_at,
    owned_session.archived_at,
    (select count(*) from public.live_participants participant_row
      where participant_row.session_id = owned_session.id),
    (select count(*) from public.live_utterances utterance_row
      where utterance_row.session_id = owned_session.id),
    (select count(*) from public.live_topics topic_row
      where topic_row.session_id = owned_session.id),
    public.live_record_summary_state_v1(
      owned_session.id, owned_session.languages, owned_session.status
    ),
    public.live_record_sheet_sync_state_v1(owned_session.id),
    coalesce((
      select job_row.safe_error_code
      from public.live_sheet_sync_jobs job_row
      where job_row.session_id = owned_session.id and job_row.state = 'failed'
      order by job_row.updated_at desc, job_row.id desc
      limit 1
    ), export_row.last_error_code),
    export_row.sheet_id,
    export_row.session_index_row,
    export_row.tab_title,
    export_row.projection_version,
    export_row.last_exported_projection_version,
    export_row.last_exported_participant_count
  from public.live_sheet_exports export_row
  where export_row.session_id = owned_session.id;
end;
$$;

create or replace function public.read_owned_live_record_participants_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  participant_id uuid,
  display_name text,
  email text,
  company text,
  department text,
  job_title text,
  joined_at timestamptz,
  left_at timestamptz,
  privacy_is_accepted boolean,
  privacy_notice_version text,
  privacy_accepted_at timestamptz,
  privacy_withdrawn_at timestamptz,
  summary_delivery_is_accepted boolean,
  summary_delivery_notice_version text,
  summary_delivery_accepted_at timestamptz,
  summary_delivery_withdrawn_at timestamptz,
  marketing_is_accepted boolean,
  marketing_notice_version text,
  marketing_accepted_at timestamptz,
  marketing_withdrawn_at timestamptz,
  delivery_status text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_session_id is null
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_PARTICIPANTS_INPUT';
  end if;
  perform 1
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.archive_deleted_at is null
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;

  return query
  with current_consent as (
    select distinct on (consent_row.participant_id, consent_row.purpose)
      consent_row.participant_id,
      consent_row.purpose,
      consent_row.notice_version,
      consent_row.is_accepted,
      consent_row.accepted_at,
      consent_row.withdrawn_at
    from public.live_participant_consents consent_row
    where consent_row.session_id = p_session_id
    order by consent_row.participant_id, consent_row.purpose, consent_row.revision desc
  )
  select
    participant_row.id,
    participant_row.display_name,
    participant_row.email,
    participant_row.company,
    participant_row.department,
    participant_row.job_title,
    participant_row.joined_at,
    participant_row.left_at,
    coalesce(privacy_consent.is_accepted, false),
    privacy_consent.notice_version,
    privacy_consent.accepted_at,
    privacy_consent.withdrawn_at,
    coalesce(summary_consent.is_accepted, false),
    summary_consent.notice_version,
    summary_consent.accepted_at,
    summary_consent.withdrawn_at,
    coalesce(marketing_consent.is_accepted, false),
    marketing_consent.notice_version,
    marketing_consent.accepted_at,
    marketing_consent.withdrawn_at,
    case when summary_consent.is_accepted is true then 'eligible' else 'not_requested' end
  from public.live_participants participant_row
  left join current_consent privacy_consent
    on privacy_consent.participant_id = participant_row.id
   and privacy_consent.purpose = 'privacy'
  left join current_consent summary_consent
    on summary_consent.participant_id = participant_row.id
   and summary_consent.purpose = 'summary_delivery'
  left join current_consent marketing_consent
    on marketing_consent.participant_id = participant_row.id
   and marketing_consent.purpose = 'marketing'
  where participant_row.session_id = p_session_id
  order by participant_row.joined_at, participant_row.id;
end;
$$;

create or replace function public.soft_delete_owned_live_record_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  archived_at timestamptz,
  archive_deleted_at timestamptz,
  archive_purge_after timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
begin
  if p_host_id is null or char_length(p_host_id) not between 1 and 256 or p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_DELETE_INPUT';
  end if;
  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  if session_row.archived_at is null or session_row.archive_deleted_at is not null then
    raise exception using errcode = 'P0001', message = 'ARCHIVE_DELETE_NOT_AVAILABLE';
  end if;
  update public.live_sessions session_target
  set archive_deleted_at = statement_timestamp(),
      archive_purge_after = statement_timestamp() + interval '30 days',
      updated_at = statement_timestamp()
  where session_target.id = p_session_id
  returning session_target.* into session_row;
  perform public.enqueue_live_sheet_projection(p_session_id, 'archive_deleted');
  return query select
    session_row.id, session_row.archived_at,
    session_row.archive_deleted_at, session_row.archive_purge_after;
end;
$$;

create or replace function public.restore_owned_live_record_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  archived_at timestamptz,
  archive_deleted_at timestamptz,
  archive_purge_after timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
begin
  if p_host_id is null or char_length(p_host_id) not between 1 and 256 or p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_RESTORE_INPUT';
  end if;
  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  if session_row.archive_deleted_at is null
    or session_row.archive_purge_after <= statement_timestamp()
  then
    raise exception using errcode = 'P0001', message = 'ARCHIVE_RESTORE_NOT_AVAILABLE';
  end if;
  update public.live_sessions session_target
  set archive_deleted_at = null,
      archive_purge_after = null,
      updated_at = statement_timestamp()
  where session_target.id = p_session_id
  returning session_target.* into session_row;
  perform public.enqueue_live_sheet_projection(p_session_id, 'archive_restored');
  return query select
    session_row.id, session_row.archived_at,
    session_row.archive_deleted_at, session_row.archive_purge_after;
end;
$$;

create or replace function public.read_owned_live_record_purge_eligibility_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  is_deleted boolean,
  is_purge_eligible boolean,
  archive_deleted_at timestamptz,
  archive_purge_after timestamptz,
  recovery_seconds_remaining bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
begin
  if p_host_id is null or char_length(p_host_id) not between 1 and 256 or p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_PURGE_READ_INPUT';
  end if;
  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  return query select
    session_row.id,
    session_row.archive_deleted_at is not null,
    session_row.archive_purge_after is not null
      and session_row.archive_purge_after <= statement_timestamp(),
    session_row.archive_deleted_at,
    session_row.archive_purge_after,
    case when session_row.archive_purge_after is null then null
      else greatest(0, extract(epoch from (
        session_row.archive_purge_after - statement_timestamp()
      ))::bigint)
    end;
end;
$$;

revoke all on table public.live_participant_consents
  from public, anon, authenticated, service_role;
revoke all on table public.live_sheet_sync_jobs
  from public, anon, authenticated, service_role;
revoke all on table public.live_sheet_exports
  from public, anon, authenticated, service_role;
revoke all on table public.live_sheet_workbook_leases
  from public, anon, authenticated, service_role;
revoke all on sequence public.live_sheet_id_seq
  from public, anon, authenticated, service_role;
revoke all on sequence public.live_sheet_index_row_seq
  from public, anon, authenticated, service_role;

revoke all on function public.mark_live_session_archived()
  from public, anon, authenticated, service_role;
revoke all on function public.assert_live_participant_consent_binding()
  from public, anon, authenticated, service_role;
revoke all on function public.prevent_live_participant_consent_mutation()
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_live_session_projection_trigger()
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_live_participant_projection_trigger()
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_live_consent_projection_trigger()
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_live_summary_projection_trigger()
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_failed_live_summary_projection_trigger()
  from public, anon, authenticated, service_role;
revoke all on function public.live_record_summary_state_v1(uuid, text[], text)
  from public, anon, authenticated, service_role;
revoke all on function public.live_record_sheet_sync_state_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.make_live_sheet_tab_title(date, text, integer)
  from public, anon, authenticated;
revoke all on function public.enqueue_live_sheet_projection(uuid, text)
  from public, anon, authenticated;
revoke all on function public.create_live_session(
  uuid, text, text, text, text[], integer, text, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.update_live_session(
  uuid, text, integer, text, text, text[], integer, text, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.record_live_participant_consent_v1(uuid, uuid, text, text, text, boolean)
  from public, anon, authenticated;
revoke all on function public.record_live_participant_consent_choices_v1(
  uuid, uuid, text, boolean, text, boolean, text
) from public, anon, authenticated;
revoke all on function public.redeem_live_attendee_v2(
  text, text, text, text, timestamptz, text, text, text, text,
  boolean, text, boolean, text, boolean, text
) from public, anon, authenticated;
revoke all on function public.claim_live_sheet_sync_job_v1(uuid)
  from public, anon, authenticated;
revoke all on function public.read_live_sheet_projection_v1(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.complete_live_sheet_sync_job_v1(uuid, uuid, bigint, integer)
  from public, anon, authenticated;
revoke all on function public.fail_live_sheet_sync_job_v1(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.retry_live_sheet_sync_job_v1(uuid, text)
  from public, anon, authenticated;
revoke all on function public.request_live_session_archive_deletion_v1(uuid, text)
  from public, anon, authenticated;
revoke all on function public.restore_live_session_archive_v1(uuid, text)
  from public, anon, authenticated;
revoke all on function public.purge_live_session_archives_v1(integer)
  from public, anon, authenticated;
revoke all on function public.list_owned_live_records_v1(text, integer, integer, text)
  from public, anon, authenticated;
revoke all on function public.read_owned_live_record_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.read_owned_live_record_participants_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.soft_delete_owned_live_record_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.restore_owned_live_record_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.read_owned_live_record_purge_eligibility_v1(text, uuid)
  from public, anon, authenticated;

grant execute on function public.make_live_sheet_tab_title(date, text, integer)
  to service_role;
grant execute on function public.enqueue_live_sheet_projection(uuid, text)
  to service_role;
grant execute on function public.create_live_session(
  uuid, text, text, text, text[], integer, text, text, text, timestamptz, timestamptz
) to service_role;
grant execute on function public.update_live_session(
  uuid, text, integer, text, text, text[], integer, text, text, text, timestamptz
) to service_role;
grant execute on function public.record_live_participant_consent_v1(uuid, uuid, text, text, text, boolean)
  to service_role;
grant execute on function public.record_live_participant_consent_choices_v1(
  uuid, uuid, text, boolean, text, boolean, text
) to service_role;
grant execute on function public.redeem_live_attendee_v2(
  text, text, text, text, timestamptz, text, text, text, text,
  boolean, text, boolean, text, boolean, text
) to service_role;
grant execute on function public.claim_live_sheet_sync_job_v1(uuid)
  to service_role;
grant execute on function public.read_live_sheet_projection_v1(uuid, uuid)
  to service_role;
grant execute on function public.complete_live_sheet_sync_job_v1(uuid, uuid, bigint, integer)
  to service_role;
grant execute on function public.fail_live_sheet_sync_job_v1(uuid, uuid, text)
  to service_role;
grant execute on function public.retry_live_sheet_sync_job_v1(uuid, text)
  to service_role;
grant execute on function public.request_live_session_archive_deletion_v1(uuid, text)
  to service_role;
grant execute on function public.restore_live_session_archive_v1(uuid, text)
  to service_role;
grant execute on function public.purge_live_session_archives_v1(integer)
  to service_role;
grant execute on function public.list_owned_live_records_v1(text, integer, integer, text)
  to service_role;
grant execute on function public.read_owned_live_record_v1(text, uuid)
  to service_role;
grant execute on function public.read_owned_live_record_participants_v1(text, uuid)
  to service_role;
grant execute on function public.soft_delete_owned_live_record_v1(text, uuid)
  to service_role;
grant execute on function public.restore_owned_live_record_v1(text, uuid)
  to service_role;
grant execute on function public.read_owned_live_record_purge_eligibility_v1(text, uuid)
  to service_role;

revoke all on function public.cleanup_expired_live_state()
  from public, anon, authenticated;
revoke all on function public.cleanup_expired_live_participants()
  from public, anon, authenticated;
revoke all on function public.cleanup_expired_live_topics()
  from public, anon, authenticated;
grant execute on function public.cleanup_expired_live_state() to service_role;
grant execute on function public.cleanup_expired_live_participants() to service_role;
grant execute on function public.cleanup_expired_live_topics() to service_role;

-- supabase/migrations/202608150006_live_gateway_readiness_start.sql

-- 2026-08-16 feat: Make gateway readiness the sole authority that can move a
-- prepared Live Call to live, with a durable replay receipt and exact settings fence.

alter table public.live_sessions
  add column if not exists gateway_activation_key uuid,
  add column if not exists gateway_settings_fingerprint text,
  add column if not exists gateway_activated_at timestamptz;

alter table public.live_sessions
  add constraint live_sessions_gateway_activation_receipt_check check (
    (
      gateway_activation_key is null
      and gateway_settings_fingerprint is null
      and gateway_activated_at is null
    )
    or (
      gateway_activation_key is not null
      and gateway_settings_fingerprint is not null
      and gateway_activated_at is not null
      and gateway_settings_fingerprint ~ '^sha256:[0-9a-f]{64}$'
      and gateway_activated_at >= created_at
    )
  );

create unique index live_sessions_gateway_activation_key_idx
  on public.live_sessions (gateway_activation_key)
  where gateway_activation_key is not null;

-- The original inline constraint still capped this independently maintained
-- counter at 50 even after max_viewers was raised to 200.
alter table public.live_sessions
  drop constraint if exists live_sessions_viewer_count_check;
alter table public.live_sessions
  add constraint live_sessions_viewer_count_check
  check (viewer_count between 0 and 200);

create or replace function public.activate_live_session_after_gateway_ready_v1(
  p_session_id uuid,
  p_host_id text,
  p_expected_version integer,
  p_activation_key uuid,
  p_gateway_settings_fingerprint text,
  p_session_type text,
  p_output_mode text,
  p_voice_provider text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text,
  p_pinned_glossary_fingerprint text
)
returns table (
  session_id uuid,
  status text,
  version integer
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
begin
  if p_session_id is null
    or p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_host_id <> btrim(p_host_id)
    or p_host_id ~ '[[:cntrl:]]'
    or p_expected_version is null
    or p_expected_version < 1
    or p_expected_version >= 2147483647
    or p_activation_key is null
    or p_gateway_settings_fingerprint is null
    or p_gateway_settings_fingerprint !~ '^sha256:[0-9a-f]{64}$'
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
    or p_max_viewers not between 1 and 200
    or p_glossary_pack is null
    or p_glossary_pack not in ('general_cre', 'hotel', 'fnb')
    or (
      p_pinned_glossary_fingerprint is not null
      and p_pinned_glossary_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_GATEWAY_READINESS_INPUT';
  end if;

  select session_row.* into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'GATEWAY_READINESS_CONFLICT';
  end if;

  if session_row.host_id <> p_host_id then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;

  if session_row.status = 'live'
    and session_row.version = p_expected_version + 1
    and session_row.gateway_activation_key = p_activation_key
    and session_row.gateway_settings_fingerprint = p_gateway_settings_fingerprint
    and session_row.session_type is not distinct from p_session_type
    and session_row.output_mode is not distinct from p_output_mode
    and session_row.voice_provider is not distinct from p_voice_provider
    and session_row.languages is not distinct from p_languages
    and session_row.max_viewers is not distinct from p_max_viewers
    and session_row.glossary_pack is not distinct from p_glossary_pack
    and session_row.pinned_glossary_fingerprint is not distinct from p_pinned_glossary_fingerprint
    and session_row.expires_at > statement_timestamp()
  then
    return query select session_row.id, session_row.status, session_row.version;
    return;
  end if;

  if session_row.status <> 'preparing'
    or session_row.version <> p_expected_version
    or session_row.expires_at <= statement_timestamp()
    or session_row.session_type is distinct from p_session_type
    or session_row.output_mode is distinct from p_output_mode
    or session_row.voice_provider is distinct from p_voice_provider
    or session_row.languages is distinct from p_languages
    or session_row.max_viewers is distinct from p_max_viewers
    or session_row.glossary_pack is distinct from p_glossary_pack
    or session_row.pinned_glossary_fingerprint is distinct from p_pinned_glossary_fingerprint
  then
    raise exception using errcode = 'P0001', message = 'GATEWAY_READINESS_CONFLICT';
  end if;

  if exists (
    select 1
    from public.live_sessions other_session
    where other_session.gateway_activation_key = p_activation_key
      and other_session.id <> p_session_id
  ) then
    raise exception using errcode = 'P0001', message = 'GATEWAY_READINESS_CONFLICT';
  end if;

  begin
    update public.live_sessions as session_row
    set status = 'live',
        version = session_row.version + 1,
        gateway_activation_key = p_activation_key,
        gateway_settings_fingerprint = p_gateway_settings_fingerprint,
        gateway_activated_at = statement_timestamp(),
        updated_at = statement_timestamp()
    where session_row.id = p_session_id
      and session_row.status = 'preparing'
      and session_row.version = p_expected_version
    returning session_row.* into session_row;
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = 'GATEWAY_READINESS_CONFLICT';
  end;

  if not found then
    raise exception using errcode = 'P0001', message = 'GATEWAY_READINESS_CONFLICT';
  end if;

  return query select session_row.id, session_row.status, session_row.version;
end;
$$;

revoke all on function public.activate_live_session_after_gateway_ready_v1(
  uuid, text, integer, uuid, text, text, text, text, text[], integer, text, text
)
  from public, anon, authenticated, service_role;
grant execute on function public.activate_live_session_after_gateway_ready_v1(
  uuid, text, integer, uuid, text, text, text, text, text[], integer, text, text
)
  to service_role;

revoke all on function public.start_live_session(uuid, text, integer)
  from public, anon, authenticated, service_role;

-- supabase/migrations/202608150007_live_plpgsql_ambiguity_repair.sql

-- Forward repair for PL/pgSQL variable/column ambiguity in applied live RPCs.
-- The explicit compiler policy preserves released behavior while table aliases win collisions.

create or replace function public.apply_live_topic_transition(
  p_session_id uuid,
  p_language text,
  p_utterance_key text,
  p_source_seq bigint,
  p_decision text,
  p_expected_topic_id uuid,
  p_expected_version integer,
  p_title text,
  p_summary text,
  p_detector_health text,
  p_meaningful boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  clean_language text := lower(btrim(coalesce(p_language, '')));
  clean_utterance_key text := normalize(btrim(coalesce(p_utterance_key, '')), NFC);
  raw_title text := nullif(normalize(btrim(coalesce(p_title, '')), NFC), '');
  clean_title text := coalesce(raw_title, 'Live topic');
  clean_summary text := nullif(normalize(btrim(coalesce(p_summary, '')), NFC), '');
  clean_detector_health text := coalesce(nullif(p_detector_health, ''), 'healthy');
  existing_membership record;
  processed_membership record;
  source_utterance record;
  topic_row record;
  target_topic_id uuid;
  target_topic record;
  completed_topic record;
  next_ordinal integer;
  membership_position integer;
  target_topic_payload jsonb;
  completed_topic_payload jsonb;
begin
  if p_session_id is null
    or not public.live_language_valid(clean_language)
    or char_length(clean_utterance_key) not between 1 and 256
    or octet_length(clean_utterance_key) > 768
    or clean_utterance_key ~ '[[:cntrl:]]'
    or clean_utterance_key ~ '[<>]'
    or translate(clean_utterance_key, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') <> clean_utterance_key
    or p_source_seq is null
    or p_source_seq <= 0
    or p_decision not in ('continue', 'shift')
    or clean_detector_health not in ('healthy', 'degraded')
    or p_meaningful is null
    or char_length(clean_title) not between 1 and 120
    or clean_title !~ '[^<>[:cntrl:]]'
    or clean_title ~ '[[:cntrl:]]'
    or clean_title ~ '[<>]'
    or translate(clean_title, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') <> clean_title
    or (
      clean_summary is not null
      and (
        char_length(clean_summary) not between 1 and 500
        or clean_summary ~ '[[:cntrl:]]'
        or clean_summary ~ '[<>]'
        or translate(clean_summary, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') <> clean_summary
      )
    )
  then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TOPIC_TRANSITION_INPUT');
  end if;

  select existing_membership.*
    into existing_membership
  from public.live_topic_utterances existing_membership
  where existing_membership.session_id = p_session_id
    and existing_membership.utterance_key = clean_utterance_key;

  if found then
    select topic_row.*
      into target_topic
    from public.live_topics topic_row
    where topic_row.id = existing_membership.topic_id;

    target_topic_payload := jsonb_build_object(
      'id', target_topic.id,
      'session_id', target_topic.session_id,
      'ordinal', target_topic.ordinal,
      'title', target_topic.title,
      'summary', target_topic.summary,
      'status', target_topic.status,
      'completion_reason', target_topic.completion_reason,
      'detector_health', target_topic.detector_health,
      'started_at', target_topic.started_at,
      'completed_at', target_topic.completed_at,
      'version', target_topic.version
    );

    return jsonb_build_object('ok', true, 'status', 'idempotent',
      'event', 'topic-upsert',
      'topics', jsonb_build_array(target_topic_payload),
      'memberships_added', '[]'::jsonb
    );
  end if;

  select processed_membership.*
    into processed_membership
  from public.live_topic_processed_utterances processed_membership
  where processed_membership.session_id = p_session_id
    and processed_membership.utterance_key = clean_utterance_key;

  if found then
    return jsonb_build_object('ok', true, 'status', 'idempotent',
      'event', 'topic-upsert',
      'topics', '[]'::jsonb,
      'memberships_added', '[]'::jsonb
    );
  end if;

  select source_utterance.*
    into source_utterance
  from public.live_utterances source_utterance
  where source_utterance.session_id = p_session_id
    and source_utterance.language = clean_language
    and source_utterance.origin = 'source'
    and source_utterance.utterance_key = clean_utterance_key
    and source_utterance.seq = p_source_seq;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'SOURCE_FINAL_NOT_DURABLE');
  end if;

  select topic_row.*
    into topic_row
  from public.live_topics topic_row
  where topic_row.session_id = p_session_id
    and topic_row.status = 'active'
  for update;

  if found and (
    p_expected_topic_id is null
    or topic_row.id <> p_expected_topic_id
    or topic_row.version <> p_expected_version
  ) then
    return jsonb_build_object('ok', false, 'code', 'TOPIC_VERSION_CONFLICT');
  end if;

  if p_meaningful is false then
    if not found then
      insert into public.live_topic_processed_utterances (
        session_id,
        utterance_key,
        source_seq,
        source_language
      ) values (
        p_session_id,
        clean_utterance_key,
        p_source_seq,
        clean_language
      )
      on conflict (session_id, utterance_key) do nothing;

      return jsonb_build_object('ok', true, 'status', 'ignored',
        'event', 'topic-upsert',
        'topics', '[]'::jsonb,
        'memberships_added', '[]'::jsonb
      );
    end if;

    select coalesce(max(membership_row.position), 0) + 1
      into membership_position
    from public.live_topic_utterances membership_row
    where membership_row.topic_id = topic_row.id;

    insert into public.live_topic_utterances (
      session_id,
      utterance_key,
      topic_id,
      position,
      source_seq,
      source_language
    ) values (
      p_session_id,
      clean_utterance_key,
      topic_row.id,
      membership_position,
      p_source_seq,
      clean_language
    )
    on conflict (session_id, utterance_key) do nothing;

    insert into public.live_topic_processed_utterances (
      session_id,
      utterance_key,
      source_seq,
      source_language
    ) values (
      p_session_id,
      clean_utterance_key,
      p_source_seq,
      clean_language
    )
    on conflict (session_id, utterance_key) do nothing;

    target_topic_payload := jsonb_build_object(
      'id', topic_row.id,
      'session_id', topic_row.session_id,
      'ordinal', topic_row.ordinal,
      'title', topic_row.title,
      'summary', topic_row.summary,
      'status', topic_row.status,
      'completion_reason', topic_row.completion_reason,
      'detector_health', topic_row.detector_health,
      'started_at', topic_row.started_at,
      'completed_at', topic_row.completed_at,
      'version', topic_row.version
    );

    return jsonb_build_object('ok', true, 'status', 'processed',
      'event', 'topic-upsert',
      'topics', jsonb_build_array(target_topic_payload),
      'memberships_added', jsonb_build_array(jsonb_build_object(
        'session_id', p_session_id,
        'topic_id', topic_row.id,
        'utterance_key', clean_utterance_key,
        'position', membership_position
      ))
    );
  end if;

  if not found then
    select coalesce(max(topic_row.ordinal), 0) + 1
      into next_ordinal
    from public.live_topics topic_row
    where topic_row.session_id = p_session_id;

    insert into public.live_topics (
      session_id,
      ordinal,
      title,
      summary,
      detector_health,
      last_activity_at
    ) values (
      p_session_id,
      next_ordinal,
      clean_title,
      clean_summary,
      clean_detector_health,
      source_utterance.emitted_at
    )
    returning id into target_topic_id;
  elsif p_decision = 'shift' then
    update public.live_topics
      set status = 'completed',
          completion_reason = 'semantic_shift',
          completed_at = source_utterance.emitted_at,
          updated_at = statement_timestamp(),
          version = version + 1
    where id = topic_row.id
    returning * into completed_topic;

    completed_topic_payload := jsonb_build_object(
      'id', completed_topic.id,
      'session_id', completed_topic.session_id,
      'ordinal', completed_topic.ordinal,
      'title', completed_topic.title,
      'summary', completed_topic.summary,
      'status', completed_topic.status,
      'completion_reason', completed_topic.completion_reason,
      'detector_health', completed_topic.detector_health,
      'started_at', completed_topic.started_at,
      'completed_at', completed_topic.completed_at,
      'version', completed_topic.version
    );

    select coalesce(max(next_topic.ordinal), 0) + 1
      into next_ordinal
    from public.live_topics next_topic
    where next_topic.session_id = p_session_id;

    insert into public.live_topics (
      session_id,
      ordinal,
      title,
      summary,
      detector_health,
      last_activity_at
    ) values (
      p_session_id,
      next_ordinal,
      clean_title,
      clean_summary,
      clean_detector_health,
      source_utterance.emitted_at
    )
    returning id into target_topic_id;
  else
    update public.live_topics
      set title = coalesce(raw_title, title),
          summary = coalesce(clean_summary, summary),
          detector_health = clean_detector_health,
          last_activity_at = source_utterance.emitted_at,
          updated_at = statement_timestamp(),
          version = version + 1
    where id = topic_row.id
    returning id into target_topic_id;
  end if;

  select coalesce(max(membership_row.position), 0) + 1
    into membership_position
  from public.live_topic_utterances membership_row
  where membership_row.topic_id = target_topic_id;

  insert into public.live_topic_utterances (
    session_id,
    utterance_key,
    topic_id,
    position,
    source_seq,
    source_language
  ) values (
    p_session_id,
    clean_utterance_key,
    target_topic_id,
    membership_position,
    p_source_seq,
    clean_language
  )
  on conflict (session_id, utterance_key) do nothing;

  select topic_row.*
    into target_topic
  from public.live_topics topic_row
  where topic_row.id = target_topic_id;

  target_topic_payload := jsonb_build_object(
    'id', target_topic.id,
    'session_id', target_topic.session_id,
    'ordinal', target_topic.ordinal,
    'title', target_topic.title,
    'summary', target_topic.summary,
    'status', target_topic.status,
    'completion_reason', target_topic.completion_reason,
    'detector_health', target_topic.detector_health,
    'started_at', target_topic.started_at,
    'completed_at', target_topic.completed_at,
    'version', target_topic.version
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'applied',
    'event', 'topic-upsert',
    'topics', case
      when completed_topic_payload is null then jsonb_build_array(target_topic_payload)
      else jsonb_build_array(completed_topic_payload, target_topic_payload)
    end,
    'memberships_added', jsonb_build_array(jsonb_build_object(
      'session_id', p_session_id,
      'topic_id', target_topic_id,
      'utterance_key', clean_utterance_key,
      'position', membership_position
    ))
  );
end;
$$;

create or replace function public.complete_idle_live_topic(
  p_session_id uuid,
  p_language text,
  p_topic_id uuid,
  p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  clean_language text := lower(btrim(coalesce(p_language, '')));
  topic_row record;
  latest_source_final_at timestamptz;
  completed_topic record;
  completed_topic_payload jsonb;
begin
  if p_session_id is null
    or p_topic_id is null
    or not public.live_language_valid(clean_language)
    or p_expected_version is null
  then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IDLE_TOPIC_INPUT');
  end if;

  select topic_row.*
    into topic_row
  from public.live_topics topic_row
  where topic_row.id = p_topic_id
    and topic_row.session_id = p_session_id
    and topic_row.status = 'active'
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'TOPIC_NOT_ACTIVE');
  end if;

  if topic_row.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'TOPIC_VERSION_CONFLICT');
  end if;

  if topic_row.last_activity_at > statement_timestamp() - interval '12 seconds' then
    return jsonb_build_object('ok', false, 'code', 'TOPIC_NOT_IDLE');
  end if;

  select max(source_utterance.emitted_at)
    into latest_source_final_at
  from public.live_utterances source_utterance
  left join public.live_topic_utterances membership_row
    on membership_row.session_id = source_utterance.session_id
   and membership_row.utterance_key = source_utterance.utterance_key
  left join public.live_topic_processed_utterances processed_row
    on processed_row.session_id = source_utterance.session_id
   and processed_row.utterance_key = source_utterance.utterance_key
  where source_utterance.session_id = p_session_id
    and source_utterance.language = clean_language
    and source_utterance.origin = 'source'
    and source_utterance.utterance_key is not null
    and membership_row.utterance_key is null
    and processed_row.utterance_key is null;

  if latest_source_final_at > topic_row.last_activity_at then
    return jsonb_build_object('ok', false, 'code', 'LATEST_SOURCE_FINAL_UNASSIGNED');
  end if;

  update public.live_topics
    set status = 'completed',
        completion_reason = 'silence',
        completed_at = statement_timestamp(),
        updated_at = statement_timestamp(),
        version = version + 1
  where id = topic_row.id
  returning * into completed_topic;

  completed_topic_payload := jsonb_build_object(
    'id', completed_topic.id,
    'session_id', completed_topic.session_id,
    'ordinal', completed_topic.ordinal,
    'title', completed_topic.title,
    'summary', completed_topic.summary,
    'status', completed_topic.status,
    'completion_reason', completed_topic.completion_reason,
    'detector_health', completed_topic.detector_health,
    'started_at', completed_topic.started_at,
    'completed_at', completed_topic.completed_at,
    'version', completed_topic.version
  );

  return jsonb_build_object(
    'ok', true,
    'event', 'topic-upsert',
    'topics', jsonb_build_array(completed_topic_payload),
    'memberships_added', '[]'::jsonb
  );
end;
$$;

create or replace function public.complete_live_topics_on_session_end(
  p_session_id uuid
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  session_row record;
  changed_count integer := 0;
begin
  if p_session_id is null then
    return 0;
  end if;

  select session_row.*
    into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id;

  if not found or session_row.status not in ('live', 'paused', 'stopped') then
    return 0;
  end if;

  update public.live_topics
    set status = 'completed',
        completion_reason = 'session_end',
        completed_at = coalesce(session_row.ended_at, statement_timestamp()),
        updated_at = statement_timestamp(),
        version = version + 1
  where session_id = p_session_id
    and status = 'active';

  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;

create or replace function public.claim_live_sheet_sync_job_v1(
  p_claim_token uuid
)
returns table (
  job_id uuid,
  session_id uuid,
  session_index_row integer,
  sheet_id integer,
  tab_title text,
  should_create boolean,
  projection_version bigint,
  previous_participant_count integer,
  workbook_ref_version integer,
  reason text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  job_row public.live_sheet_sync_jobs%rowtype;
  lease_row public.live_sheet_workbook_leases%rowtype;
begin
  if p_claim_token is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_CLAIM';
  end if;

  select * into lease_row
  from public.live_sheet_workbook_leases lease_row
  where lease_row.scope = 'configured_workbook'
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'SHEETS_WORKBOOK_LEASE_MISSING';
  end if;

  if lease_row.running_job_id is not null
    and lease_row.lease_expires_at <= statement_timestamp()
  then
    update public.live_sheet_sync_jobs
    set state = 'failed',
        completed_at = statement_timestamp(),
        safe_error_code = 'SHEETS_CLAIM_LEASE_EXPIRED',
        updated_at = statement_timestamp()
    where id = lease_row.running_job_id
      and state = 'running'
      and claim_token = lease_row.lease_token;

    update public.live_sheet_exports export_row
    set last_outcome = 'failed',
        last_error_code = 'SHEETS_CLAIM_LEASE_EXPIRED',
        updated_at = statement_timestamp()
    from public.live_sheet_sync_jobs expired_job
    where expired_job.id = lease_row.running_job_id
      and export_row.session_id = expired_job.session_id;

    update public.live_sheet_workbook_leases
    set running_job_id = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = statement_timestamp()
    where scope = 'configured_workbook';
    lease_row.running_job_id := null;
    lease_row.lease_token := null;
    lease_row.lease_expires_at := null;
  end if;

  if lease_row.running_job_id is not null then
    return;
  end if;

  select * into job_row
  from public.live_sheet_sync_jobs
  where state = 'pending'
  order by created_at, id
  for update skip locked
  limit 1;
  if not found then
    return;
  end if;
  update public.live_sheet_sync_jobs
  set state = 'running',
      claim_token = p_claim_token,
      claimed_at = statement_timestamp(),
      lease_expires_at = statement_timestamp() + interval '5 minutes',
      attempt_count = attempt_count + 1,
      updated_at = statement_timestamp()
  where id = job_row.id
    and state = 'pending'
  returning * into job_row;

  update public.live_sheet_workbook_leases
  set running_job_id = job_row.id,
      lease_token = p_claim_token,
      lease_expires_at = job_row.lease_expires_at,
      updated_at = statement_timestamp()
  where scope = 'configured_workbook';

  return query
  select
    job_row.id,
    export_row.session_id,
    export_row.session_index_row,
    export_row.sheet_id,
    export_row.tab_title,
    export_row.last_exported_projection_version = 0,
    job_row.projection_version,
    export_row.last_exported_participant_count,
    export_row.workbook_ref_version,
    job_row.reason
  from public.live_sheet_exports export_row
  where export_row.session_id = job_row.session_id;
end;
$$;

create or replace function public.complete_live_sheet_sync_job_v1(
  p_job_id uuid,
  p_claim_token uuid,
  p_projection_version bigint,
  p_participant_count integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  job_row public.live_sheet_sync_jobs%rowtype;
  lease_row public.live_sheet_workbook_leases%rowtype;
  changed_count integer;
begin
  if p_job_id is null
    or p_claim_token is null
    or p_projection_version < 1
    or p_participant_count not between 0 and 10000
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_COMPLETION';
  end if;

  select * into lease_row
  from public.live_sheet_workbook_leases lease_row
  where lease_row.scope = 'configured_workbook'
    and lease_row.running_job_id = p_job_id
    and lease_row.lease_token = p_claim_token
    and lease_row.lease_expires_at > statement_timestamp()
  for update;
  if not found then
    return false;
  end if;

  select * into job_row
  from public.live_sheet_sync_jobs job_row
  where job_row.id = p_job_id
    and job_row.state = 'running'
    and job_row.projection_version = p_projection_version
    and job_row.claim_token = p_claim_token
    and job_row.lease_expires_at = lease_row.lease_expires_at
  for update;
  if not found then
    return false;
  end if;

  update public.live_sheet_exports
  set last_exported_projection_version = p_projection_version,
      last_exported_participant_count = p_participant_count,
      last_outcome = 'succeeded',
      last_error_code = null,
      updated_at = statement_timestamp()
  where session_id = job_row.session_id
    and projection_version >= p_projection_version
    and last_exported_projection_version < p_projection_version;
  get diagnostics changed_count = row_count;
  if changed_count <> 1 then
    return false;
  end if;

  update public.live_sheet_sync_jobs
  set state = 'succeeded',
      completed_at = statement_timestamp(),
      safe_error_code = null,
      updated_at = statement_timestamp()
  where id = p_job_id;

  update public.live_sheet_workbook_leases
  set running_job_id = null,
      lease_token = null,
      lease_expires_at = null,
      updated_at = statement_timestamp()
  where scope = 'configured_workbook'
    and running_job_id = p_job_id
    and lease_token = p_claim_token;
  return true;
end;
$$;

create or replace function public.fail_live_sheet_sync_job_v1(
  p_job_id uuid,
  p_claim_token uuid,
  p_safe_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  failed_session_id uuid;
  lease_row public.live_sheet_workbook_leases%rowtype;
begin
  if p_job_id is null
    or p_claim_token is null
    or p_safe_error_code !~ '^[A-Z0-9_]{3,64}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_FAILURE';
  end if;

  select * into lease_row
  from public.live_sheet_workbook_leases lease_row
  where lease_row.scope = 'configured_workbook'
    and lease_row.running_job_id = p_job_id
    and lease_row.lease_token = p_claim_token
    and lease_row.lease_expires_at > statement_timestamp()
  for update;
  if not found then
    return false;
  end if;

  update public.live_sheet_sync_jobs
  set state = 'failed',
      completed_at = statement_timestamp(),
      safe_error_code = p_safe_error_code,
      updated_at = statement_timestamp()
  where id = p_job_id
    and state = 'running'
    and claim_token = p_claim_token
    and lease_expires_at = lease_row.lease_expires_at
  returning session_id into failed_session_id;
  if failed_session_id is null then
    return false;
  end if;
  update public.live_sheet_exports
  set last_outcome = 'failed',
      last_error_code = p_safe_error_code,
      updated_at = statement_timestamp()
  where session_id = failed_session_id;

  update public.live_sheet_workbook_leases
  set running_job_id = null,
      lease_token = null,
      lease_expires_at = null,
      updated_at = statement_timestamp()
  where scope = 'configured_workbook'
    and running_job_id = p_job_id
    and lease_token = p_claim_token;
  return true;
end;
$$;

create or replace function public.soft_delete_owned_live_record_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  archived_at timestamptz,
  archive_deleted_at timestamptz,
  archive_purge_after timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
begin
  if p_host_id is null or char_length(p_host_id) not between 1 and 256 or p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_DELETE_INPUT';
  end if;
  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  if session_row.archived_at is null or session_row.archive_deleted_at is not null then
    raise exception using errcode = 'P0001', message = 'ARCHIVE_DELETE_NOT_AVAILABLE';
  end if;
  update public.live_sessions session_target
  set archive_deleted_at = statement_timestamp(),
      archive_purge_after = statement_timestamp() + interval '30 days',
      updated_at = statement_timestamp()
  where session_target.id = p_session_id
  returning session_target.* into session_row;
  perform public.enqueue_live_sheet_projection(p_session_id, 'archive_deleted');
  return query select
    session_row.id, session_row.archived_at,
    session_row.archive_deleted_at, session_row.archive_purge_after;
end;
$$;

create or replace function public.restore_owned_live_record_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  archived_at timestamptz,
  archive_deleted_at timestamptz,
  archive_purge_after timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
begin
  if p_host_id is null or char_length(p_host_id) not between 1 and 256 or p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_RESTORE_INPUT';
  end if;
  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  if session_row.archive_deleted_at is null
    or session_row.archive_purge_after <= statement_timestamp()
  then
    raise exception using errcode = 'P0001', message = 'ARCHIVE_RESTORE_NOT_AVAILABLE';
  end if;
  update public.live_sessions session_target
  set archive_deleted_at = null,
      archive_purge_after = null,
      updated_at = statement_timestamp()
  where session_target.id = p_session_id
  returning session_target.* into session_row;
  perform public.enqueue_live_sheet_projection(p_session_id, 'archive_restored');
  return query select
    session_row.id, session_row.archived_at,
    session_row.archive_deleted_at, session_row.archive_purge_after;
end;
$$;

create or replace function public.read_owned_live_record_purge_eligibility_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  is_deleted boolean,
  is_purge_eligible boolean,
  archive_deleted_at timestamptz,
  archive_purge_after timestamptz,
  recovery_seconds_remaining bigint
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
begin
  if p_host_id is null or char_length(p_host_id) not between 1 and 256 or p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_PURGE_READ_INPUT';
  end if;
  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  return query select
    session_row.id,
    session_row.archive_deleted_at is not null,
    session_row.archive_purge_after is not null
      and session_row.archive_purge_after <= statement_timestamp(),
    session_row.archive_deleted_at,
    session_row.archive_purge_after,
    case when session_row.archive_purge_after is null then null
      else greatest(0, extract(epoch from (
        session_row.archive_purge_after - statement_timestamp()
      ))::bigint)
    end;
end;
$$;

create or replace function public.activate_live_session_after_gateway_ready_v1(
  p_session_id uuid,
  p_host_id text,
  p_expected_version integer,
  p_activation_key uuid,
  p_gateway_settings_fingerprint text,
  p_session_type text,
  p_output_mode text,
  p_voice_provider text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text,
  p_pinned_glossary_fingerprint text
)
returns table (
  session_id uuid,
  status text,
  version integer
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
begin
  if p_session_id is null
    or p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_host_id <> btrim(p_host_id)
    or p_host_id ~ '[[:cntrl:]]'
    or p_expected_version is null
    or p_expected_version < 1
    or p_expected_version >= 2147483647
    or p_activation_key is null
    or p_gateway_settings_fingerprint is null
    or p_gateway_settings_fingerprint !~ '^sha256:[0-9a-f]{64}$'
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
    or p_max_viewers not between 1 and 200
    or p_glossary_pack is null
    or p_glossary_pack not in ('general_cre', 'hotel', 'fnb')
    or (
      p_pinned_glossary_fingerprint is not null
      and p_pinned_glossary_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_GATEWAY_READINESS_INPUT';
  end if;

  select session_row.* into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'GATEWAY_READINESS_CONFLICT';
  end if;

  if session_row.host_id <> p_host_id then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;

  if session_row.status = 'live'
    and session_row.version = p_expected_version + 1
    and session_row.gateway_activation_key = p_activation_key
    and session_row.gateway_settings_fingerprint = p_gateway_settings_fingerprint
    and session_row.session_type is not distinct from p_session_type
    and session_row.output_mode is not distinct from p_output_mode
    and session_row.voice_provider is not distinct from p_voice_provider
    and session_row.languages is not distinct from p_languages
    and session_row.max_viewers is not distinct from p_max_viewers
    and session_row.glossary_pack is not distinct from p_glossary_pack
    and session_row.pinned_glossary_fingerprint is not distinct from p_pinned_glossary_fingerprint
    and session_row.expires_at > statement_timestamp()
  then
    return query select session_row.id, session_row.status, session_row.version;
    return;
  end if;

  if session_row.status <> 'preparing'
    or session_row.version <> p_expected_version
    or session_row.expires_at <= statement_timestamp()
    or session_row.session_type is distinct from p_session_type
    or session_row.output_mode is distinct from p_output_mode
    or session_row.voice_provider is distinct from p_voice_provider
    or session_row.languages is distinct from p_languages
    or session_row.max_viewers is distinct from p_max_viewers
    or session_row.glossary_pack is distinct from p_glossary_pack
    or session_row.pinned_glossary_fingerprint is distinct from p_pinned_glossary_fingerprint
  then
    raise exception using errcode = 'P0001', message = 'GATEWAY_READINESS_CONFLICT';
  end if;

  if exists (
    select 1
    from public.live_sessions other_session
    where other_session.gateway_activation_key = p_activation_key
      and other_session.id <> p_session_id
  ) then
    raise exception using errcode = 'P0001', message = 'GATEWAY_READINESS_CONFLICT';
  end if;

  begin
    update public.live_sessions as session_row
    set status = 'live',
        version = session_row.version + 1,
        gateway_activation_key = p_activation_key,
        gateway_settings_fingerprint = p_gateway_settings_fingerprint,
        gateway_activated_at = statement_timestamp(),
        updated_at = statement_timestamp()
    where session_row.id = p_session_id
      and session_row.status = 'preparing'
      and session_row.version = p_expected_version
    returning session_row.* into session_row;
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = 'GATEWAY_READINESS_CONFLICT';
  end;

  if not found then
    raise exception using errcode = 'P0001', message = 'GATEWAY_READINESS_CONFLICT';
  end if;

  return query select session_row.id, session_row.status, session_row.version;
end;
$$;

revoke all on function public.apply_live_topic_transition(
  uuid, text, text, bigint, text, uuid, integer, text, text, text, boolean
) from public, anon, authenticated;
revoke all on function public.complete_idle_live_topic(uuid, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.complete_live_topics_on_session_end(uuid)
  from public, anon, authenticated;
revoke all on function public.claim_live_sheet_sync_job_v1(uuid)
  from public, anon, authenticated;
revoke all on function public.complete_live_sheet_sync_job_v1(uuid, uuid, bigint, integer)
  from public, anon, authenticated;
revoke all on function public.fail_live_sheet_sync_job_v1(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.soft_delete_owned_live_record_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.restore_owned_live_record_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.read_owned_live_record_purge_eligibility_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.activate_live_session_after_gateway_ready_v1(
  uuid, text, integer, uuid, text, text, text, text, text[], integer, text, text
)
  from public, anon, authenticated, service_role;

grant execute on function public.apply_live_topic_transition(
  uuid, text, text, bigint, text, uuid, integer, text, text, text, boolean
) to service_role;
grant execute on function public.complete_idle_live_topic(uuid, text, uuid, integer)
  to service_role;
grant execute on function public.complete_live_topics_on_session_end(uuid)
  to service_role;
grant execute on function public.claim_live_sheet_sync_job_v1(uuid)
  to service_role;
grant execute on function public.complete_live_sheet_sync_job_v1(uuid, uuid, bigint, integer)
  to service_role;
grant execute on function public.fail_live_sheet_sync_job_v1(uuid, uuid, text)
  to service_role;
grant execute on function public.soft_delete_owned_live_record_v1(text, uuid)
  to service_role;
grant execute on function public.restore_owned_live_record_v1(text, uuid)
  to service_role;
grant execute on function public.read_owned_live_record_purge_eligibility_v1(text, uuid)
  to service_role;
grant execute on function public.activate_live_session_after_gateway_ready_v1(
  uuid, text, integer, uuid, text, text, text, text, text[], integer, text, text
)
  to service_role;

-- supabase/migrations/202608220001_live_authoritative_source_transcript.sql

-- 2026-08-22 feat: Preserve one immutable provider-source transcript before
-- terminology repair, translation, or live fan-out. Source text only: no raw
-- audio is stored. Rows inherit the existing archive lifecycle through their
-- parent session and are physically removed only by the 30-day parent-session purge.

-- ─── Host-configured participant speaking capability ───

alter table public.live_sessions
  add column if not exists participant_speaking_enabled boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.live_sessions'::regclass
      and conname = 'live_sessions_participant_speaking_mode_check'
  ) then
    alter table public.live_sessions
      add constraint live_sessions_participant_speaking_mode_check
      check (participant_speaking_enabled is false or session_type = 'meeting');
  end if;
end;
$$;

comment on column public.live_sessions.participant_speaking_enabled is
  'Host-configured capability. False denies every participant floor request at the database boundary.';

grant select (participant_speaking_enabled) on public.live_sessions to authenticated;

-- ─── Immutable authoritative source transcript ───

create table public.live_source_utterances (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  source_seq bigint not null check (source_seq >= 1),
  utterance_key text not null,
  raw_text text not null,
  normalized_text text not null,
  source_language text not null,
  speaker_role text not null check (speaker_role in ('host', 'participant', 'unknown')),
  speaker_label text,
  speaker_name text,
  speaker_department text,
  speaker_job_title text,
  participant_id uuid references public.live_participants(id) on delete set null,
  source_started_at timestamptz,
  source_ended_at timestamptz not null,
  provider_committed_at timestamptz not null,
  stt_provider text not null,
  stt_model text,
  translation_model text,
  pipeline_config_fingerprint text,
  glossary_fingerprint text,
  created_at timestamptz not null default now(),
  unique (session_id, source_seq),
  unique (session_id, utterance_key),
  constraint live_source_utterances_key_check check (
    char_length(utterance_key) between 1 and 200
    and octet_length(utterance_key) <= 600
    and utterance_key = btrim(utterance_key)
    and utterance_key !~ '[[:cntrl:]<>]'
  ),
  constraint live_source_utterances_raw_text_check check (
    char_length(btrim(raw_text)) between 1 and 8000
    and octet_length(raw_text) <= 24000
  ),
  constraint live_source_utterances_normalized_text_check check (
    char_length(normalized_text) between 1 and 8000
    and octet_length(normalized_text) <= 24000
    and normalized_text = normalize(btrim(normalized_text), NFC)
  ),
  constraint live_source_utterances_language_check check (
    source_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
  ),
  constraint live_source_utterances_speaker_check check (
    (speaker_label is null or (
      char_length(speaker_label) between 1 and 80
      and speaker_label = normalize(btrim(speaker_label), NFC)
      and speaker_label !~ '[[:cntrl:]<>]'
    ))
    and (speaker_name is null or (
      char_length(speaker_name) between 1 and 40
      and speaker_name = normalize(btrim(speaker_name), NFC)
      and speaker_name !~ '[[:cntrl:]<>]'
    ))
    and (speaker_department is null or (
      char_length(speaker_department) between 1 and 80
      and speaker_department = normalize(btrim(speaker_department), NFC)
      and speaker_department !~ '[[:cntrl:]<>]'
    ))
    and (speaker_job_title is null or (
      char_length(speaker_job_title) between 1 and 100
      and speaker_job_title = normalize(btrim(speaker_job_title), NFC)
      and speaker_job_title !~ '[[:cntrl:]<>]'
    ))
    and not (speaker_role in ('host', 'unknown') and participant_id is not null)
  ),
  constraint live_source_utterances_time_check check (
    (source_started_at is null or (
      source_started_at <= source_ended_at
      and source_ended_at - source_started_at <= interval '1 hour'
    ))
    and provider_committed_at >= source_ended_at
  ),
  constraint live_source_utterances_provider_check check (
    stt_provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    and (stt_model is null or (
      char_length(stt_model) between 1 and 120
      and stt_model = btrim(stt_model)
      and stt_model !~ '[[:cntrl:]<>]'
    ))
    and (translation_model is null or (
      char_length(translation_model) between 1 and 120
      and translation_model = btrim(translation_model)
      and translation_model !~ '[[:cntrl:]<>]'
    ))
  ),
  constraint live_source_utterances_fingerprint_check check (
    (pipeline_config_fingerprint is null or pipeline_config_fingerprint ~ '^sha256:[0-9a-f]{64}$')
    and (glossary_fingerprint is null or glossary_fingerprint ~ '^sha256:[0-9a-f]{64}$')
  )
);

create index live_source_utterances_session_time_idx
  on public.live_source_utterances (session_id, source_ended_at, source_seq);

comment on table public.live_source_utterances is
  'Append-only provider-final source transcript. raw_text is never glossary-repaired; normalized_text is the canonical terminology-repaired source.';
comment on column public.live_source_utterances.raw_text is
  'Exact bounded provider-final text as received. It is deliberately not trimmed or normalized on storage.';
comment on column public.live_source_utterances.normalized_text is
  'NFC, trimmed, terminology-repaired source text used by translation and summary.';

create table public.live_source_utterance_corrections (
  id uuid primary key default extensions.gen_random_uuid(),
  source_utterance_id uuid not null references public.live_source_utterances(id) on delete cascade,
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  revision integer not null check (revision >= 1),
  corrected_text text not null,
  reason text,
  actor_host_id text not null check (char_length(actor_host_id) between 1 and 256),
  created_at timestamptz not null default now(),
  unique (source_utterance_id, revision),
  constraint live_source_corrections_text_check check (
    char_length(corrected_text) between 1 and 8000
    and octet_length(corrected_text) <= 24000
    and corrected_text = normalize(btrim(corrected_text), NFC)
  ),
  constraint live_source_corrections_reason_check check (
    reason is null or (
      char_length(reason) between 1 and 500
      and reason = normalize(btrim(reason), NFC)
      and reason !~ '[[:cntrl:]<>]'
    )
  )
);

create index live_source_corrections_session_source_idx
  on public.live_source_utterance_corrections (session_id, source_utterance_id, revision desc);

comment on table public.live_source_utterance_corrections is
  'Append-only host corrections. The immutable raw and normalized source row is never overwritten.';

alter table public.live_source_utterances enable row level security;
alter table public.live_source_utterance_corrections enable row level security;

-- No direct table access, including service_role. SECURITY DEFINER functions
-- below are the only write/read surface, preventing silent UPDATE or DELETE.
revoke all on table public.live_source_utterances
  from public, anon, authenticated, service_role;
revoke all on table public.live_source_utterance_corrections
  from public, anon, authenticated, service_role;

-- ─── Source commit and idempotent sequence allocation ───

create or replace function public.persist_authoritative_live_source_utterance_v1(
  p_session_id uuid,
  p_utterance_key text,
  p_raw_text text,
  p_normalized_text text,
  p_source_language text,
  p_speaker_role text,
  p_speaker_label text,
  p_speaker_name text,
  p_speaker_department text,
  p_speaker_job_title text,
  p_participant_id uuid,
  p_source_started_at timestamptz,
  p_source_ended_at timestamptz,
  p_provider_committed_at timestamptz,
  p_stt_provider text,
  p_stt_model text,
  p_translation_model text,
  p_pipeline_config_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  participant_row public.live_participants%rowtype;
  existing_source public.live_source_utterances%rowtype;
  inserted_source public.live_source_utterances%rowtype;
  next_source_seq bigint;
  clean_key text;
  clean_normalized_text text;
  clean_source_language text;
  clean_speaker_label text;
  clean_speaker_name text;
  clean_speaker_department text;
  clean_speaker_job_title text;
  clean_stt_model text;
  clean_translation_model text;
begin
  clean_key := nullif(btrim(coalesce(p_utterance_key, '')), '');
  clean_normalized_text := nullif(normalize(btrim(coalesce(p_normalized_text, '')), NFC), '');
  clean_source_language := nullif(btrim(coalesce(p_source_language, '')), '');
  clean_speaker_label := nullif(normalize(btrim(coalesce(p_speaker_label, '')), NFC), '');
  clean_speaker_name := nullif(normalize(btrim(coalesce(p_speaker_name, '')), NFC), '');
  clean_speaker_department := nullif(normalize(btrim(coalesce(p_speaker_department, '')), NFC), '');
  clean_speaker_job_title := nullif(normalize(btrim(coalesce(p_speaker_job_title, '')), NFC), '');
  clean_stt_model := nullif(btrim(coalesce(p_stt_model, '')), '');
  clean_translation_model := nullif(btrim(coalesce(p_translation_model, '')), '');

  if p_session_id is null
    or clean_key is null
    or char_length(clean_key) > 200
    or octet_length(clean_key) > 600
    or clean_key ~ '[[:cntrl:]<>]'
    or p_raw_text is null
    or char_length(btrim(p_raw_text)) not between 1 and 8000
    or octet_length(p_raw_text) > 24000
    or clean_normalized_text is null
    or char_length(clean_normalized_text) > 8000
    or octet_length(clean_normalized_text) > 24000
    or clean_source_language is null
    or clean_source_language !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
    or p_speaker_role not in ('host', 'participant', 'unknown')
    or (p_speaker_role = 'participant') <> (p_participant_id is not null)
    or (clean_speaker_label is not null and (
      char_length(clean_speaker_label) > 80 or clean_speaker_label ~ '[[:cntrl:]<>]'
    ))
    or (clean_speaker_name is not null and (
      char_length(clean_speaker_name) > 40 or clean_speaker_name ~ '[[:cntrl:]<>]'
    ))
    or (clean_speaker_department is not null and (
      char_length(clean_speaker_department) > 80 or clean_speaker_department ~ '[[:cntrl:]<>]'
    ))
    or (clean_speaker_job_title is not null and (
      char_length(clean_speaker_job_title) > 100 or clean_speaker_job_title ~ '[[:cntrl:]<>]'
    ))
    or p_source_ended_at is null
    or p_provider_committed_at is null
    or p_provider_committed_at < p_source_ended_at
    or (p_source_started_at is not null and (
      p_source_started_at > p_source_ended_at
      or p_source_ended_at - p_source_started_at > interval '1 hour'
    ))
    or p_stt_provider is null
    or p_stt_provider !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    or (clean_stt_model is not null and (
      char_length(clean_stt_model) > 120 or clean_stt_model ~ '[[:cntrl:]<>]'
    ))
    or (clean_translation_model is not null and (
      char_length(clean_translation_model) > 120 or clean_translation_model ~ '[[:cntrl:]<>]'
    ))
    or (p_pipeline_config_fingerprint is not null
      and p_pipeline_config_fingerprint !~ '^sha256:[0-9a-f]{64}$')
  then
    raise exception using errcode = '22023', message = 'INVALID_AUTHORITATIVE_SOURCE_INPUT';
  end if;

  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.status = 'live'
    and session_row.expires_at > statement_timestamp()
    and session_row.archive_deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'SESSION_NOT_LIVE';
  end if;

  if p_participant_id is not null then
    select * into participant_row
    from public.live_participants participant_row
    where participant_row.id = p_participant_id
      and participant_row.session_id = p_session_id;
    if not found then
      raise exception using errcode = '42501', message = 'PARTICIPANT_SESSION_MISMATCH';
    end if;
    clean_speaker_name := participant_row.display_name;
    clean_speaker_department := participant_row.department;
    clean_speaker_job_title := participant_row.job_title;
  end if;

  select * into existing_source
  from public.live_source_utterances source_row
  where source_row.session_id = p_session_id
    and source_row.utterance_key = clean_key;
  if found then
    if existing_source.raw_text is distinct from p_raw_text
      or existing_source.normalized_text is distinct from clean_normalized_text
      or existing_source.source_language is distinct from clean_source_language
      or existing_source.speaker_role is distinct from p_speaker_role
      or existing_source.speaker_label is distinct from clean_speaker_label
      or existing_source.speaker_name is distinct from clean_speaker_name
      or existing_source.speaker_department is distinct from clean_speaker_department
      or existing_source.speaker_job_title is distinct from clean_speaker_job_title
      or existing_source.participant_id is distinct from p_participant_id
      or existing_source.source_started_at is distinct from p_source_started_at
      or existing_source.source_ended_at is distinct from p_source_ended_at
      or existing_source.provider_committed_at is distinct from p_provider_committed_at
      or existing_source.stt_provider is distinct from p_stt_provider
      or existing_source.stt_model is distinct from clean_stt_model
      or existing_source.translation_model is distinct from clean_translation_model
      or existing_source.pipeline_config_fingerprint is distinct from p_pipeline_config_fingerprint
      or existing_source.glossary_fingerprint is distinct from session_row.pinned_glossary_fingerprint
    then
      raise exception using errcode = 'P0001', message = 'SOURCE_UTTERANCE_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'ok', true,
      'sourceUtteranceId', existing_source.id,
      'sourceSeq', existing_source.source_seq,
      'idempotent', true
    );
  end if;

  select coalesce(max(source_row.source_seq), 0) + 1
  into next_source_seq
  from public.live_source_utterances source_row
  where source_row.session_id = p_session_id;

  insert into public.live_source_utterances (
    session_id, source_seq, utterance_key, raw_text, normalized_text,
    source_language, speaker_role, speaker_label, speaker_name,
    speaker_department, speaker_job_title, participant_id,
    source_started_at, source_ended_at, provider_committed_at,
    stt_provider, stt_model, translation_model, pipeline_config_fingerprint,
    glossary_fingerprint, created_at
  ) values (
    p_session_id, next_source_seq, clean_key, p_raw_text, clean_normalized_text,
    clean_source_language, p_speaker_role, clean_speaker_label, clean_speaker_name,
    clean_speaker_department, clean_speaker_job_title, p_participant_id,
    p_source_started_at, p_source_ended_at, p_provider_committed_at,
    p_stt_provider, clean_stt_model, clean_translation_model,
    p_pipeline_config_fingerprint, session_row.pinned_glossary_fingerprint,
    statement_timestamp()
  ) returning * into inserted_source;

  return jsonb_build_object(
    'ok', true,
    'sourceUtteranceId', inserted_source.id,
    'sourceSeq', inserted_source.source_seq,
    'idempotent', false
  );
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'SOURCE_UTTERANCE_IDEMPOTENCY_CONFLICT';
end;
$$;

-- ─── Additive linkage from language-lane rows ───

alter table public.live_utterances
  add column if not exists authoritative_source_id uuid
    references public.live_source_utterances(id) on delete set null;

create unique index live_utterances_authoritative_source_language_idx
  on public.live_utterances (authoritative_source_id, language)
  where authoritative_source_id is not null;

comment on column public.live_utterances.authoritative_source_id is
  'Nullable for legacy rows. New rows link every language lane to one immutable source record.';

create or replace function public.persist_live_final_caption_if_active(
  p_session_id uuid,
  p_language text,
  p_event jsonb,
  p_seq bigint,
  p_text text,
  p_speaker_label text,
  p_speaker_name text,
  p_source_started_at timestamptz,
  p_source_ended_at timestamptz,
  p_emitted_at timestamptz,
  p_participant_id uuid,
  p_source_text text,
  p_source_language text,
  p_origin text,
  p_utterance_key text,
  p_translation_status text,
  p_authoritative_source_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored boolean;
  source_row public.live_source_utterances%rowtype;
  lane_row public.live_utterances%rowtype;
begin
  if p_authoritative_source_id is null or p_utterance_key is null then
    raise exception using errcode = '22023', message = 'AUTHORITATIVE_SOURCE_REQUIRED';
  end if;
  select * into source_row
  from public.live_source_utterances source_row
  where source_row.id = p_authoritative_source_id
    and source_row.session_id = p_session_id
    and source_row.utterance_key = p_utterance_key;
  if not found then
    raise exception using errcode = 'P0001', message = 'AUTHORITATIVE_SOURCE_LINK_CONFLICT';
  end if;

  stored := public.persist_live_final_caption_if_active(
    p_session_id, p_language, p_event, p_seq, p_text,
    p_speaker_label, p_speaker_name, p_source_started_at,
    p_source_ended_at, p_emitted_at, p_participant_id,
    p_source_text, p_source_language, p_origin, p_utterance_key,
    p_translation_status
  );
  if not stored then
    return false;
  end if;

  select * into lane_row
  from public.live_utterances utterance_row
  where utterance_row.session_id = p_session_id
    and utterance_row.language = p_language
    and utterance_row.seq = p_seq
  for update;
  if not found
    or lane_row.utterance_key is distinct from p_utterance_key
    or (
      lane_row.authoritative_source_id is not null
      and lane_row.authoritative_source_id <> p_authoritative_source_id
    )
  then
    raise exception using errcode = 'P0001', message = 'AUTHORITATIVE_SOURCE_LINK_CONFLICT';
  end if;

  update public.live_utterances
  set authoritative_source_id = p_authoritative_source_id
  where session_id = p_session_id
    and language = p_language
    and seq = p_seq
    and authoritative_source_id is null;
  return true;
end;
$$;

-- ─── Append-only host corrections ───

create or replace function public.append_owned_live_source_correction_v1(
  p_host_id text,
  p_session_id uuid,
  p_source_utterance_id uuid,
  p_expected_revision integer,
  p_corrected_text text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  source_row public.live_source_utterances%rowtype;
  current_revision integer;
  inserted_correction public.live_source_utterance_corrections%rowtype;
  clean_text text;
  clean_reason text;
begin
  clean_text := nullif(normalize(btrim(coalesce(p_corrected_text, '')), NFC), '');
  clean_reason := nullif(normalize(btrim(coalesce(p_reason, '')), NFC), '');
  if p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_session_id is null
    or p_source_utterance_id is null
    or p_expected_revision is null
    or p_expected_revision < 0
    or clean_text is null
    or char_length(clean_text) > 8000
    or octet_length(clean_text) > 24000
    or (clean_reason is not null and (
      char_length(clean_reason) > 500 or clean_reason ~ '[[:cntrl:]<>]'
    ))
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SOURCE_CORRECTION';
  end if;

  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.archive_deleted_at is null
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;

  select * into source_row
  from public.live_source_utterances source_row
  where source_row.id = p_source_utterance_id
    and source_row.session_id = p_session_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;

  select coalesce(max(correction_row.revision), 0)
  into current_revision
  from public.live_source_utterance_corrections correction_row
  where correction_row.source_utterance_id = p_source_utterance_id;
  if current_revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'LIVE_SOURCE_CORRECTION_CONFLICT';
  end if;

  insert into public.live_source_utterance_corrections (
    source_utterance_id, session_id, revision, corrected_text, reason,
    actor_host_id, created_at
  ) values (
    p_source_utterance_id, p_session_id, current_revision + 1,
    clean_text, clean_reason, p_host_id, statement_timestamp()
  ) returning * into inserted_correction;

  return jsonb_build_object(
    'ok', true,
    'correctionId', inserted_correction.id,
    'revision', inserted_correction.revision
  );
end;
$$;

-- ─── Controlled host and terminal summary reads ───

create or replace function public.read_owned_authoritative_live_transcript_v1(
  p_host_id text,
  p_session_id uuid,
  p_after_source_seq bigint default 0,
  p_limit integer default 200
)
returns table (
  source_utterance_id uuid,
  source_seq bigint,
  utterance_key text,
  raw_text text,
  normalized_text text,
  effective_text text,
  source_language text,
  speaker_role text,
  speaker_label text,
  speaker_name text,
  speaker_department text,
  speaker_job_title text,
  participant_id uuid,
  source_started_at timestamptz,
  source_ended_at timestamptz,
  provider_committed_at timestamptz,
  stt_provider text,
  stt_model text,
  translation_model text,
  pipeline_config_fingerprint text,
  glossary_fingerprint text,
  correction_revision integer,
  corrected_at timestamptz,
  translations jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_session_id is null
    or p_after_source_seq is null
    or p_after_source_seq < 0
    or p_limit is null
    or p_limit not between 1 and 500
  then
    raise exception using errcode = '22023', message = 'INVALID_AUTHORITATIVE_TRANSCRIPT_READ';
  end if;
  perform 1
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.archive_deleted_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  perform 1
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.status in ('stopped', 'failed')
    and coalesce(session_row.ended_at, session_row.archived_at) is not null;
  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_TRANSCRIPT_NOT_READY';
  end if;

  return query
  select
    source_row.id,
    source_row.source_seq,
    source_row.utterance_key,
    source_row.raw_text,
    source_row.normalized_text,
    coalesce(latest_correction.corrected_text, source_row.normalized_text),
    source_row.source_language,
    source_row.speaker_role,
    source_row.speaker_label,
    source_row.speaker_name,
    source_row.speaker_department,
    source_row.speaker_job_title,
    source_row.participant_id,
    source_row.source_started_at,
    source_row.source_ended_at,
    source_row.provider_committed_at,
    source_row.stt_provider,
    source_row.stt_model,
    source_row.translation_model,
    source_row.pipeline_config_fingerprint,
    source_row.glossary_fingerprint,
    coalesce(latest_correction.revision, 0),
    latest_correction.created_at,
    coalesce(linked_translations.translations, '[]'::jsonb)
  from public.live_source_utterances source_row
  left join lateral (
    select correction_row.revision, correction_row.corrected_text, correction_row.created_at
    from public.live_source_utterance_corrections correction_row
    where correction_row.source_utterance_id = source_row.id
    order by correction_row.revision desc
    limit 1
  ) latest_correction on true
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'language', utterance_row.language,
        'seq', utterance_row.seq,
        'text', utterance_row.text,
        'translationStatus', utterance_row.translation_status,
        'emittedAt', utterance_row.emitted_at
      ) order by utterance_row.language
    ) as translations
    from public.live_utterances utterance_row
    where utterance_row.authoritative_source_id = source_row.id
  ) linked_translations on true
  where source_row.session_id = p_session_id
    and source_row.source_seq > p_after_source_seq
  order by source_row.source_seq
  limit p_limit;
end;
$$;

create or replace function public.read_authoritative_live_summary_input_v1(
  p_session_id uuid,
  p_after_source_seq bigint default 0,
  p_limit integer default 500
)
returns table (
  source_seq bigint,
  effective_text text,
  source_language text,
  speaker_name text,
  source_started_at timestamptz,
  source_ended_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_session_id is null
    or p_after_source_seq is null
    or p_after_source_seq < 0
    or p_limit is null
    or p_limit not between 1 and 1000
  then
    raise exception using errcode = '22023', message = 'INVALID_AUTHORITATIVE_SUMMARY_READ';
  end if;
  perform 1
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.status in ('stopped', 'failed')
    and coalesce(session_row.ended_at, session_row.archived_at) is not null
    and session_row.archive_deleted_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_NOT_TERMINAL';
  end if;

  return query
  select
    source_row.source_seq,
    coalesce(latest_correction.corrected_text, source_row.normalized_text),
    source_row.source_language,
    source_row.speaker_name,
    source_row.source_started_at,
    source_row.source_ended_at
  from public.live_source_utterances source_row
  left join lateral (
    select correction_row.corrected_text
    from public.live_source_utterance_corrections correction_row
    where correction_row.source_utterance_id = source_row.id
    order by correction_row.revision desc
    limit 1
  ) latest_correction on true
  where source_row.session_id = p_session_id
    and source_row.source_seq > p_after_source_seq
  order by source_row.source_seq
  limit p_limit;
end;
$$;

-- ─── Participant speaking authorization ───

create or replace function public.authorize_live_participant_speaking_v1(
  p_session_id uuid,
  p_grant_id uuid,
  p_user_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_session_id is not null
    and p_grant_id is not null
    and p_user_id is not null
    and char_length(p_user_id) between 1 and 256
    and exists (
      select 1
      from public.live_sessions session_row
      join public.viewer_grants grant_row
        on grant_row.session_id = session_row.id
       and grant_row.id = p_grant_id
       and grant_row.user_id = p_user_id
       and grant_row.revoked_at is null
       and grant_row.expires_at > statement_timestamp()
      join public.live_participants participant_row
        on participant_row.session_id = session_row.id
       and participant_row.grant_id = grant_row.id
       and participant_row.user_id = grant_row.user_id
      where session_row.id = p_session_id
        and session_row.participant_speaking_enabled is true
        and session_row.status = 'live'
        and session_row.expires_at > statement_timestamp()
        and session_row.archive_deleted_at is null
    );
$$;

create or replace function public.take_live_floor(p_session_id uuid, p_grant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  grant_row public.viewer_grants%rowtype;
  participant_row public.live_participants%rowtype;
begin
  select * into session_row
  from public.live_sessions
  where id = p_session_id
    and expires_at > statement_timestamp()
    and archive_deleted_at is null
  for update;
  if not found or session_row.status <> 'live' then
    return jsonb_build_object('ok', false, 'code', 'SESSION_NOT_LIVE');
  end if;
  if session_row.participant_speaking_enabled is not true then
    return jsonb_build_object('ok', false, 'code', 'PARTICIPANT_SPEAKING_DISABLED');
  end if;

  select * into grant_row
  from public.viewer_grants
  where id = p_grant_id
    and session_id = p_session_id
    and revoked_at is null
    and expires_at > statement_timestamp()
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'GRANT_INVALID');
  end if;

  if session_row.floor_grant_id is not null
    and session_row.floor_grant_id <> p_grant_id
  then
    select * into participant_row
    from public.live_participants
    where session_id = p_session_id
      and grant_id = session_row.floor_grant_id;
    if found then
      insert into public.live_participant_events (
        participant_id, session_id, event_type, occurred_at
      ) values (
        participant_row.id, p_session_id, 'speak_ended', statement_timestamp()
      );
    end if;
  end if;

  select * into participant_row
  from public.live_participants
  where session_id = p_session_id and grant_id = p_grant_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'PARTICIPANT_REQUIRED');
  end if;

  update public.live_participants
  set last_spoke_at = statement_timestamp(),
      last_seen_at = greatest(last_seen_at, statement_timestamp())
  where id = participant_row.id;
  if session_row.floor_grant_id is distinct from p_grant_id then
    insert into public.live_participant_events (
      participant_id, session_id, event_type, occurred_at
    ) values (
      participant_row.id, p_session_id, 'speak_started', statement_timestamp()
    );
  end if;

  update public.live_sessions
  set floor_grant_id = p_grant_id,
      floor_display_name = coalesce(grant_row.display_name, 'Participant'),
      floor_taken_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where id = p_session_id;

  return jsonb_build_object(
    'ok', true,
    'displayName', coalesce(grant_row.display_name, 'Participant'),
    'participantId', participant_row.id,
    'previousGrantId', session_row.floor_grant_id,
    'previousDisplayName', session_row.floor_display_name
  );
end;
$$;

-- Versioned projections keep every deployed legacy signature callable while
-- making the capability explicit to new host and participant clients.
create or replace function public.create_live_session_with_event_v2(
  p_session_id uuid,
  p_host_id text,
  p_session_type text,
  p_output_mode text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text,
  p_voice_provider text,
  p_title text,
  p_scheduled_at timestamptz,
  p_expires_at timestamptz,
  p_event_company_name text,
  p_event_reporting_period text,
  p_event_metadata jsonb,
  p_participant_speaking_enabled boolean
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
  title text,
  scheduled_at timestamptz,
  admission_open_until timestamptz,
  expires_at timestamptz,
  event_company_name text,
  event_reporting_period text,
  event_metadata jsonb,
  participant_speaking_enabled boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_session record;
begin
  if p_participant_speaking_enabled is null
    or (p_participant_speaking_enabled and p_session_type <> 'meeting')
  then
    raise exception using errcode = '22023', message = 'INVALID_PARTICIPANT_SPEAKING_CONFIGURATION';
  end if;

  select * into created_session
  from public.create_live_session_with_event_v1(
    p_session_id, p_host_id, p_session_type, p_output_mode, p_languages,
    p_max_viewers, p_glossary_pack, p_voice_provider, p_title,
    p_scheduled_at, p_expires_at, p_event_company_name,
    p_event_reporting_period, p_event_metadata
  );

  update public.live_sessions session_row
  set participant_speaking_enabled = p_participant_speaking_enabled
  where session_row.id = created_session.id;

  return query select
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
    created_session.title,
    created_session.scheduled_at,
    created_session.admission_open_until,
    created_session.expires_at,
    created_session.event_company_name,
    created_session.event_reporting_period,
    created_session.event_metadata,
    p_participant_speaking_enabled;
end;
$$;

create or replace function public.update_live_session_with_event_v2(
  p_session_id uuid,
  p_host_id text,
  p_expected_version integer,
  p_session_type text,
  p_output_mode text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text,
  p_voice_provider text,
  p_title text,
  p_scheduled_at timestamptz,
  p_event_company_name text,
  p_event_reporting_period text,
  p_event_metadata jsonb,
  p_participant_speaking_enabled boolean
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
  title text,
  scheduled_at timestamptz,
  admission_open_until timestamptz,
  expires_at timestamptz,
  event_company_name text,
  event_reporting_period text,
  event_metadata jsonb,
  participant_speaking_enabled boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_session record;
  previous_speaking_enabled boolean;
begin
  if p_participant_speaking_enabled is null
    or (p_participant_speaking_enabled and p_session_type <> 'meeting')
  then
    raise exception using errcode = '22023', message = 'INVALID_PARTICIPANT_SPEAKING_CONFIGURATION';
  end if;

  -- The CHECK is immediate. A valid meeting(true) -> presentation(false)
  -- transition must clear the capability before v1 changes session_type, but
  -- only after the exact owner/version row is locked. If v1 returns no row for
  -- another guard (viewer count or scheduling), restore the previous value.
  select session_row.participant_speaking_enabled
  into previous_speaking_enabled
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.version = p_expected_version
    and session_row.status = 'preparing'
    and session_row.expires_at > statement_timestamp()
  for update;
  if not found then
    return;
  end if;
  if previous_speaking_enabled and not p_participant_speaking_enabled then
    update public.live_sessions session_row
    set participant_speaking_enabled = false
    where session_row.id = p_session_id
      and session_row.host_id = p_host_id
      and session_row.version = p_expected_version;
  end if;

  select * into updated_session
  from public.update_live_session_with_event_v1(
    p_session_id, p_host_id, p_expected_version, p_session_type,
    p_output_mode, p_languages, p_max_viewers, p_glossary_pack,
    p_voice_provider, p_title, p_scheduled_at, p_event_company_name,
    p_event_reporting_period, p_event_metadata
  );
  if not found then
    update public.live_sessions session_row
    set participant_speaking_enabled = previous_speaking_enabled
    where session_row.id = p_session_id
      and session_row.host_id = p_host_id
      and session_row.version = p_expected_version;
    return;
  end if;

  update public.live_sessions session_row
  set participant_speaking_enabled = p_participant_speaking_enabled
  where session_row.id = updated_session.id;

  return query select
    updated_session.id,
    updated_session.host_id,
    updated_session.session_type,
    updated_session.output_mode,
    updated_session.status,
    updated_session.languages,
    updated_session.viewer_count,
    updated_session.max_viewers,
    updated_session.version,
    updated_session.glossary_pack,
    updated_session.voice_provider,
    updated_session.title,
    updated_session.scheduled_at,
    updated_session.admission_open_until,
    updated_session.expires_at,
    updated_session.event_company_name,
    updated_session.event_reporting_period,
    updated_session.event_metadata,
    p_participant_speaking_enabled;
end;
$$;

create or replace function public.redeem_live_attendee_v3(
  p_invite_token_hmac text,
  p_code_hmac text,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_email text,
  p_display_name text,
  p_company text,
  p_department text,
  p_job_title text,
  p_privacy_consent boolean,
  p_privacy_notice_version text,
  p_summary_consent boolean,
  p_summary_delivery_notice_version text,
  p_marketing_consent boolean,
  p_marketing_notice_version text
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
  email text,
  company text,
  department text,
  job_title text,
  summary_consent_at timestamptz,
  participant_id uuid,
  voice_provider text,
  status text,
  title text,
  scheduled_at timestamptz,
  participant_speaking_enabled boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  attendee_row record;
  speaking_enabled boolean;
  clean_display_name text;
begin
  clean_display_name := nullif(normalize(btrim(coalesce(p_display_name, '')), NFC), '');
  if clean_display_name is null
    or char_length(clean_display_name) > 40
    or clean_display_name ~ '[[:cntrl:]<>]'
  then
    raise exception using errcode = '22023', message = 'INVALID_ATTENDEE_DISPLAY_NAME';
  end if;

  select * into attendee_row
  from public.redeem_live_attendee_v2(
    p_invite_token_hmac, p_code_hmac, p_user_id, p_device_hash,
    p_grant_expires_at, p_email, p_company, p_department, p_job_title,
    p_privacy_consent, p_privacy_notice_version, p_summary_consent,
    p_summary_delivery_notice_version, p_marketing_consent,
    p_marketing_notice_version
  );
  update public.viewer_grants grant_row
  set display_name = clean_display_name
  where grant_row.id = attendee_row.grant_id
    and grant_row.session_id = attendee_row.session_id;
  update public.live_participants participant_row
  set display_name = clean_display_name
  where participant_row.id = attendee_row.participant_id
    and participant_row.session_id = attendee_row.session_id;
  select session_row.participant_speaking_enabled into speaking_enabled
  from public.live_sessions session_row
  where session_row.id = attendee_row.session_id;

  return query select
    attendee_row.grant_id,
    attendee_row.session_id,
    attendee_row.user_id,
    attendee_row.grant_expires_at,
    attendee_row.session_type,
    attendee_row.output_mode,
    attendee_row.languages,
    attendee_row.session_expires_at,
    attendee_row.viewer_count,
    attendee_row.max_viewers,
    attendee_row.glossary_pack,
    clean_display_name,
    attendee_row.email,
    attendee_row.company,
    attendee_row.department,
    attendee_row.job_title,
    attendee_row.summary_consent_at,
    attendee_row.participant_id,
    attendee_row.voice_provider,
    attendee_row.status,
    attendee_row.title,
    attendee_row.scheduled_at,
    coalesce(speaking_enabled, false);
end;
$$;

create or replace function public.restore_live_attendee_v2(
  p_grant_id uuid,
  p_session_id uuid,
  p_user_id text
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
  email text,
  company text,
  department text,
  job_title text,
  summary_consent_at timestamptz,
  participant_id uuid,
  voice_provider text,
  status text,
  title text,
  scheduled_at timestamptz,
  participant_speaking_enabled boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  attendee_row record;
  speaking_enabled boolean;
begin
  select * into attendee_row
  from public.restore_live_attendee_v1(p_grant_id, p_session_id, p_user_id);
  select session_row.participant_speaking_enabled into speaking_enabled
  from public.live_sessions session_row
  where session_row.id = attendee_row.session_id;

  return query select
    attendee_row.grant_id,
    attendee_row.session_id,
    attendee_row.user_id,
    attendee_row.grant_expires_at,
    attendee_row.session_type,
    attendee_row.output_mode,
    attendee_row.languages,
    attendee_row.session_expires_at,
    attendee_row.viewer_count,
    attendee_row.max_viewers,
    attendee_row.glossary_pack,
    attendee_row.display_name,
    attendee_row.email,
    attendee_row.company,
    attendee_row.department,
    attendee_row.job_title,
    attendee_row.summary_consent_at,
    attendee_row.participant_id,
    attendee_row.voice_provider,
    attendee_row.status,
    attendee_row.title,
    attendee_row.scheduled_at,
    coalesce(speaking_enabled, false);
end;
$$;

create or replace function public.authorize_live_viewer_grants_v2(p_requests jsonb)
returns table (
  session_id uuid,
  grant_id uuid,
  user_id text,
  language text,
  authorized boolean,
  participant_speaking_enabled boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with authorized_rows as materialized (
    select
      row_number() over () as request_ordinal,
      authorization_row.*
    from public.authorize_live_viewer_grants_v1(p_requests) authorization_row
  )
  select
    authorization_row.session_id,
    authorization_row.grant_id,
    authorization_row.user_id,
    authorization_row.language,
    authorization_row.authorized,
    case when authorization_row.authorized
      then coalesce(session_row.participant_speaking_enabled, false)
      else false
    end
  from authorized_rows authorization_row
  left join public.live_sessions session_row
    on session_row.id = authorization_row.session_id
  order by authorization_row.request_ordinal;
$$;

create or replace function public.read_owned_live_record_v2(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  title text,
  status text,
  session_type text,
  output_mode text,
  languages text[],
  created_at timestamptz,
  scheduled_at timestamptz,
  ended_at timestamptz,
  archived_at timestamptz,
  participant_count bigint,
  utterance_count bigint,
  topic_count bigint,
  summary_state text,
  sheet_sync_state text,
  sheet_error_code text,
  sheet_id integer,
  session_index_row integer,
  tab_title text,
  projection_version bigint,
  last_exported_projection_version bigint,
  last_exported_participant_count integer,
  participant_speaking_enabled boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    record_row.session_id,
    record_row.title,
    record_row.status,
    record_row.session_type,
    record_row.output_mode,
    record_row.languages,
    record_row.created_at,
    record_row.scheduled_at,
    record_row.ended_at,
    record_row.archived_at,
    record_row.participant_count,
    record_row.utterance_count,
    record_row.topic_count,
    record_row.summary_state,
    record_row.sheet_sync_state,
    record_row.sheet_error_code,
    record_row.sheet_id,
    record_row.session_index_row,
    record_row.tab_title,
    record_row.projection_version,
    record_row.last_exported_projection_version,
    record_row.last_exported_participant_count,
    session_row.participant_speaking_enabled
  from public.read_owned_live_record_v1(p_host_id, p_session_id) record_row
  join public.live_sessions session_row on session_row.id = record_row.session_id;
$$;

-- ─── Least-privilege execution grants ───

revoke all on function public.persist_authoritative_live_source_utterance_v1(
  uuid, text, text, text, text, text, text, text, text, text, uuid,
  timestamptz, timestamptz, timestamptz, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.persist_live_final_caption_if_active(
  uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz,
  timestamptz, uuid, text, text, text, text, text, uuid
) from public, anon, authenticated;
revoke all on function public.append_owned_live_source_correction_v1(
  text, uuid, uuid, integer, text, text
) from public, anon, authenticated;
revoke all on function public.read_owned_authoritative_live_transcript_v1(
  text, uuid, bigint, integer
) from public, anon, authenticated;
revoke all on function public.read_authoritative_live_summary_input_v1(
  uuid, bigint, integer
) from public, anon, authenticated;
revoke all on function public.authorize_live_participant_speaking_v1(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.take_live_floor(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.create_live_session_with_event_v2(
  uuid, text, text, text, text[], integer, text, text, text, timestamptz,
  timestamptz, text, text, jsonb, boolean
) from public, anon, authenticated;
revoke all on function public.update_live_session_with_event_v2(
  uuid, text, integer, text, text, text[], integer, text, text, text,
  timestamptz, text, text, jsonb, boolean
) from public, anon, authenticated;
revoke all on function public.redeem_live_attendee_v3(
  text, text, text, text, timestamptz, text, text, text, text, text,
  boolean, text, boolean, text, boolean, text
) from public, anon, authenticated;
revoke all on function public.restore_live_attendee_v2(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.authorize_live_viewer_grants_v2(jsonb)
  from public, anon, authenticated;
revoke all on function public.read_owned_live_record_v2(text, uuid)
  from public, anon, authenticated;

grant execute on function public.persist_authoritative_live_source_utterance_v1(
  uuid, text, text, text, text, text, text, text, text, text, uuid,
  timestamptz, timestamptz, timestamptz, text, text, text, text
) to service_role;
grant execute on function public.persist_live_final_caption_if_active(
  uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz,
  timestamptz, uuid, text, text, text, text, text, uuid
) to service_role;
grant execute on function public.append_owned_live_source_correction_v1(
  text, uuid, uuid, integer, text, text
) to service_role;
grant execute on function public.read_owned_authoritative_live_transcript_v1(
  text, uuid, bigint, integer
) to service_role;
grant execute on function public.read_authoritative_live_summary_input_v1(
  uuid, bigint, integer
) to service_role;
grant execute on function public.authorize_live_participant_speaking_v1(uuid, uuid, text)
  to service_role;
grant execute on function public.take_live_floor(uuid, uuid)
  to service_role;
grant execute on function public.create_live_session_with_event_v2(
  uuid, text, text, text, text[], integer, text, text, text, timestamptz,
  timestamptz, text, text, jsonb, boolean
) to service_role;
grant execute on function public.update_live_session_with_event_v2(
  uuid, text, integer, text, text, text[], integer, text, text, text,
  timestamptz, text, text, jsonb, boolean
) to service_role;
grant execute on function public.redeem_live_attendee_v3(
  text, text, text, text, timestamptz, text, text, text, text, text,
  boolean, text, boolean, text, boolean, text
) to service_role;
grant execute on function public.restore_live_attendee_v2(uuid, uuid, text)
  to service_role;
grant execute on function public.authorize_live_viewer_grants_v2(jsonb)
  to service_role;
grant execute on function public.read_owned_live_record_v2(text, uuid)
  to service_role;

-- ─── Recoverable archive purge schedule ───

create extension if not exists pg_cron;

do $archive_purge_schedule$
declare
  purge_job_id bigint;
begin
  if to_regnamespace('cron') is null
    or to_regclass('cron.job') is null
    or to_regprocedure('cron.schedule(text,text,text)') is null
  then
    raise exception using errcode = 'P0001', message = 'LIVE_ARCHIVE_PURGE_CRON_UNAVAILABLE';
  end if;
  if to_regprocedure('public.purge_live_session_archives_v1(integer)') is null then
    raise exception using errcode = 'P0001', message = 'LIVE_ARCHIVE_PURGE_FUNCTION_UNAVAILABLE';
  end if;
  if not has_function_privilege(
    current_user,
    'cron.schedule(text,text,text)',
    'EXECUTE'
  ) then
    raise exception using errcode = '42501', message = 'LIVE_ARCHIVE_PURGE_CRON_FORBIDDEN';
  end if;

  -- The named pg_cron call is an atomic upsert. It cannot replace unrelated
  -- jobs and the existing purge RPC itself selects only soft-deleted rows whose
  -- 30-day archive_purge_after boundary has elapsed, in a locked batch of 50.
  purge_job_id := cron.schedule(
    'realtime-noel-live-archive-purge',
    '13 * * * *',
    'select public.purge_live_session_archives_v1(50);'
  );

  if purge_job_id is null
    or not exists (
      select 1
      from cron.job job_row
      where job_row.jobid = purge_job_id
        and job_row.jobname = 'realtime-noel-live-archive-purge'
        and btrim(job_row.schedule) = '13 * * * *'
        and btrim(job_row.command) = 'select public.purge_live_session_archives_v1(50);'
        and job_row.active is true
    )
  then
    raise exception using errcode = 'P0001', message = 'LIVE_ARCHIVE_PURGE_CRON_NOT_READY';
  end if;
end;
$archive_purge_schedule$;

-- Development verification after applying this migration manually:
-- 1. A live session commit returns sourceSeq=1; an exact utterance-key retry
--    returns the same UUID/seq with idempotent=true and adds no row.
-- 2. Retrying that key with different raw_text raises
--    SOURCE_UTTERANCE_IDEMPOTENCY_CONFLICT.
-- 3. Two concurrent distinct commits serialize on live_sessions and receive
--    consecutive sourceSeq values with no duplicate or hole.
-- 4. anon/authenticated and direct service_role table reads/writes fail; the
--    narrowly granted SECURITY DEFINER RPCs succeed.
-- 5. A host cannot read or correct another host's session; a soft-deleted
--    archive is hidden immediately and its child rows remain during recovery.
-- 6. purge_live_session_archives_v1 removes the parent after 30 days and its
--    authoritative children cascade. There is no independent transcript TTL.
-- 7. take_live_floor returns PARTICIPANT_SPEAKING_DISABLED while the flag is
--    false and never changes floor or participant-event state.
--
-- Rollback is application-first: route callers back to legacy RPCs. Keep this
-- additive schema in place through one full release cycle; do not drop tables,
-- columns, indexes, or overloads in an emergency rollback.

-- supabase/migrations/202608270001_live_session_multi_glossary_pins.sql

-- 2026-08-27 feat: Pin up to five ordered built-in or host glossaries to a
-- preparing Live session. The legacy singular columns stay readable for one
-- deprecation cycle and are populated when a single host glossary is chosen.

create table public.live_session_glossary_pins (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  ordinal integer not null,
  source_kind text not null,
  builtin_id text,
  builtin_catalog_version integer,
  host_preset_id uuid references public.host_glossary_presets(id) on delete restrict,
  host_document_version integer,
  host_document_fingerprint text,
  created_at timestamptz not null default statement_timestamp(),
  primary key (session_id, ordinal),
  constraint live_session_glossary_pins_ordinal_check check (ordinal between 1 and 5),
  constraint live_session_glossary_pins_source_kind_check check (source_kind in ('builtin', 'host')),
  constraint live_session_glossary_pins_source_shape_check check (
    (
      source_kind = 'builtin'
      and builtin_id in (
        'common_business', 'ai_ax', 'commercial_real_estate', 'hospitality',
        'fnb_retail', 'proper_nouns', 'ko_ja_idioms'
      )
      and builtin_catalog_version = 1
      and host_preset_id is null
      and host_document_version is null
      and host_document_fingerprint is null
    )
    or
    (
      source_kind = 'host'
      and builtin_id is null
      and builtin_catalog_version is null
      and host_preset_id is not null
      and host_document_version >= 1
      and host_document_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    )
  )
);

create unique index live_session_glossary_pins_builtin_unique
  on public.live_session_glossary_pins (session_id, builtin_id)
  where source_kind = 'builtin';

create unique index live_session_glossary_pins_host_unique
  on public.live_session_glossary_pins (session_id, host_preset_id)
  where source_kind = 'host';

alter table public.live_session_glossary_pins enable row level security;

revoke all on table public.live_session_glossary_pins
  from public, anon, authenticated, service_role;

create or replace function public.replace_live_session_glossary_pins_v2(
  p_session_id uuid,
  p_host_id text,
  p_expected_session_version integer,
  p_glossaries jsonb
)
returns table (
  session_id uuid,
  version integer,
  glossaries jsonb,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  session_row public.live_sessions%rowtype;
  updated_session public.live_sessions%rowtype;
  glossary_item jsonb;
  source_kind_value text;
  source_id_value text;
  document_version_value integer;
  selected_version public.host_glossary_preset_versions%rowtype;
  seen_sources text[] := array[]::text[];
  source_key text;
  glossary_count integer;
  glossary_ordinal integer;
  legacy_preset_id uuid;
  legacy_document_version integer;
  legacy_fingerprint text;
begin
  clean_host_id := pg_catalog.btrim(pg_catalog.coalesce(p_host_id, ''));
  if p_session_id is null
    or p_expected_session_version is null
    or p_expected_session_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or p_glossaries is null
    or pg_catalog.jsonb_typeof(p_glossaries) <> 'array'
    or pg_catalog.jsonb_array_length(p_glossaries) not between 1 and 5
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
  end if;

  select * into session_row
  from public.live_sessions as candidate_session
  where candidate_session.id = p_session_id
    and candidate_session.host_id = clean_host_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_NOT_FOUND';
  end if;
  if session_row.version <> p_expected_session_version then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_VERSION_CONFLICT';
  end if;
  if session_row.status <> 'preparing' then
    raise exception using errcode = 'P0001', message = 'ACTIVE_SESSION_GLOSSARY_IMMUTABLE';
  end if;

  delete from public.live_session_glossary_pins as existing_pin
  where existing_pin.session_id = p_session_id;

  glossary_count := pg_catalog.jsonb_array_length(p_glossaries);
  for glossary_ordinal in 1..glossary_count loop
    glossary_item := p_glossaries -> (glossary_ordinal - 1);
    if pg_catalog.jsonb_typeof(glossary_item) <> 'object'
      or glossary_item - array['source_kind', 'source_id', 'document_version'] <> '{}'::jsonb
      or not (glossary_item ?& array['source_kind', 'source_id', 'document_version'])
      or pg_catalog.jsonb_typeof(glossary_item -> 'source_kind') <> 'string'
      or pg_catalog.jsonb_typeof(glossary_item -> 'source_id') <> 'string'
      or pg_catalog.jsonb_typeof(glossary_item -> 'document_version') <> 'number'
      or (glossary_item ->> 'document_version') !~ '^[1-9][0-9]{0,9}$'
    then
      raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
    end if;

    source_kind_value := glossary_item ->> 'source_kind';
    source_id_value := glossary_item ->> 'source_id';
    if (glossary_item ->> 'document_version')::bigint > 2147483647 then
      raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
    end if;
    document_version_value := (glossary_item ->> 'document_version')::integer;
    source_key := source_kind_value || ':' || case
      when source_kind_value = 'host' then pg_catalog.lower(source_id_value)
      else source_id_value
    end;
    if source_key = any(seen_sources) then
      raise exception using errcode = '22023', message = 'DUPLICATE_LIVE_GLOSSARY_PIN';
    end if;
    seen_sources := pg_catalog.array_append(seen_sources, source_key);

    if source_kind_value = 'builtin' then
      if source_id_value not in (
        'common_business', 'ai_ax', 'commercial_real_estate', 'hospitality',
        'fnb_retail', 'proper_nouns', 'ko_ja_idioms'
      ) or document_version_value <> 1 then
        raise exception using errcode = '22023', message = 'INVALID_BUILTIN_GLOSSARY';
      end if;
      insert into public.live_session_glossary_pins (
        session_id, ordinal, source_kind, builtin_id, builtin_catalog_version
      ) values (
        p_session_id, glossary_ordinal, 'builtin', source_id_value, 1
      );
    elsif source_kind_value = 'host' then
      if source_id_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
      end if;
      select version_row.* into selected_version
      from public.host_glossary_presets as preset_row
      join public.host_glossary_preset_versions as version_row
        on version_row.preset_id = preset_row.id
       and version_row.host_id = preset_row.host_id
       and version_row.version = preset_row.active_document_version
       and version_row.fingerprint = preset_row.active_document_fingerprint
      where preset_row.id = source_id_value::uuid
        and preset_row.host_id = clean_host_id
        and preset_row.active_document_version = document_version_value;
      if not found then
        raise exception using errcode = 'P0001', message = 'ACTIVE_GLOSSARY_DOCUMENT_VERSION_NOT_FOUND';
      end if;
      insert into public.live_session_glossary_pins (
        session_id, ordinal, source_kind, host_preset_id,
        host_document_version, host_document_fingerprint
      ) values (
        p_session_id, glossary_ordinal, 'host', source_id_value::uuid,
        selected_version.version, selected_version.fingerprint
      );
      if glossary_count = 1 then
        legacy_preset_id := source_id_value::uuid;
        legacy_document_version := selected_version.version;
        legacy_fingerprint := selected_version.fingerprint;
      end if;
    else
      raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
    end if;
  end loop;

  update public.live_sessions as target_session
  set pinned_glossary_preset_id = legacy_preset_id,
      pinned_glossary_version = legacy_document_version,
      pinned_glossary_fingerprint = legacy_fingerprint,
      version = target_session.version + 1,
      updated_at = statement_timestamp()
  where target_session.id = p_session_id
    and target_session.host_id = clean_host_id
    and target_session.version = p_expected_session_version
  returning target_session.* into updated_session;

  return query
  select
    updated_session.id,
    updated_session.version,
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ordinal', pin_row.ordinal,
        'source_kind', pin_row.source_kind,
        'source_id', pg_catalog.coalesce(pin_row.builtin_id, pin_row.host_preset_id::text),
        'document_version', pg_catalog.coalesce(pin_row.builtin_catalog_version, pin_row.host_document_version),
        'fingerprint', pin_row.host_document_fingerprint
      ) order by pin_row.ordinal
    ),
    updated_session.updated_at
  from public.live_session_glossary_pins as pin_row
  where pin_row.session_id = p_session_id;
end;
$$;

create or replace function public.read_live_session_pinned_glossaries_v2(
  p_live_session_id uuid
)
returns table (
  session_id uuid,
  ordinal integer,
  source_kind text,
  source_id text,
  document_version integer,
  fingerprint text,
  glossary_document jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
  pin_count integer;
  valid_host_pin_count integer;
begin
  if p_live_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_PINNED_GLOSSARY_INPUT';
  end if;
  select * into session_row
  from public.live_sessions as candidate_session
  where candidate_session.id = p_live_session_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_NOT_FOUND';
  end if;

  select count(*)::integer into pin_count
  from public.live_session_glossary_pins as pin_row
  where pin_row.session_id = p_live_session_id;

  if pin_count > 0 then
    select count(*)::integer into valid_host_pin_count
    from public.live_session_glossary_pins as pin_row
    left join public.host_glossary_preset_versions as version_row
      on version_row.preset_id = pin_row.host_preset_id
     and version_row.version = pin_row.host_document_version
     and version_row.fingerprint = pin_row.host_document_fingerprint
     and version_row.host_id = session_row.host_id
    where pin_row.session_id = p_live_session_id
      and (pin_row.source_kind = 'builtin' or version_row.id is not null);
    if valid_host_pin_count <> pin_count then
      raise exception using errcode = 'P0001', message = 'PINNED_GLOSSARY_VERSION_MISMATCH';
    end if;

    return query
    select
      pin_row.session_id,
      pin_row.ordinal,
      pin_row.source_kind,
      pg_catalog.coalesce(pin_row.builtin_id, pin_row.host_preset_id::text),
      pg_catalog.coalesce(pin_row.builtin_catalog_version, pin_row.host_document_version),
      pin_row.host_document_fingerprint,
      version_row.document
    from public.live_session_glossary_pins as pin_row
    left join public.host_glossary_preset_versions as version_row
      on version_row.preset_id = pin_row.host_preset_id
     and version_row.version = pin_row.host_document_version
     and version_row.fingerprint = pin_row.host_document_fingerprint
     and version_row.host_id = session_row.host_id
    where pin_row.session_id = p_live_session_id
    order by pin_row.ordinal;
    return;
  end if;

  -- Legacy singular fallback remains until its columns complete a deprecation cycle.
  if session_row.pinned_glossary_preset_id is not null
    and session_row.pinned_glossary_version is not null
    and session_row.pinned_glossary_fingerprint is not null
  then
    return query
    select
      session_row.id,
      1,
      'host'::text,
      session_row.pinned_glossary_preset_id::text,
      session_row.pinned_glossary_version,
      session_row.pinned_glossary_fingerprint,
      version_row.document
    from public.host_glossary_preset_versions as version_row
    where version_row.preset_id = session_row.pinned_glossary_preset_id
      and version_row.version = session_row.pinned_glossary_version
      and version_row.fingerprint = session_row.pinned_glossary_fingerprint
      and version_row.host_id = session_row.host_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'PINNED_GLOSSARY_VERSION_MISMATCH';
    end if;
  end if;
end;
$$;

revoke all on function public.replace_live_session_glossary_pins_v2(uuid, text, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.read_live_session_pinned_glossaries_v2(uuid)
  from public, anon, authenticated;

grant execute on function public.replace_live_session_glossary_pins_v2(uuid, text, integer, jsonb)
  to service_role;
grant execute on function public.read_live_session_pinned_glossaries_v2(uuid)
  to service_role;

-- supabase/migrations/202608270002_host_glossary_multi_target_languages.sql

-- Host glossary presets: persist the FULL target-language list of the active
-- document instead of collapsing it to language_b. language_b stays the first
-- target so every v1 consumer (desktop sync, legacy RPCs) keeps a coherent
-- language pair, while v2 consumers read target_languages for compatibility
-- decisions (session checklist gating, language tags).

-- 1. Column + backfill --------------------------------------------------------

alter table public.host_glossary_presets
  add column if not exists target_languages text[] not null default '{}'::text[];

update public.host_glossary_presets
set target_languages = array[language_b]
where pg_catalog.cardinality(target_languages) = 0;

-- 2. Validation helper --------------------------------------------------------

create or replace function public.live_target_languages_valid(p_targets text[], p_source text)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select
    cardinality(p_targets) between 1 and 13
    and cardinality(p_targets) = (
      select count(distinct requested.language_code)
      from unnest(p_targets) as requested(language_code)
    )
    and not exists (
      select 1
      from unnest(p_targets) as requested(language_code)
      where public.live_language_valid(requested.language_code) is not true
        or requested.language_code = p_source
    );
$$;

revoke all on function public.live_target_languages_valid(text[], text)
  from public, anon, authenticated;

-- 3. Bounded check + legacy-write consistency trigger -------------------------
-- Legacy RPCs (v1 document create, flat create/update) never mention
-- target_languages; the trigger derives array[language_b] for those writers so
-- the column can never go stale or empty.

alter table public.host_glossary_presets
  drop constraint if exists host_glossary_presets_target_languages_bounded;

alter table public.host_glossary_presets
  add constraint host_glossary_presets_target_languages_bounded
  check (pg_catalog.cardinality(target_languages) between 1 and 13);

create or replace function public.host_glossary_presets_sync_target_languages()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.target_languages is null or pg_catalog.cardinality(new.target_languages) = 0 then
    new.target_languages := array[new.language_b];
  end if;
  if new.target_languages[1] <> new.language_b then
    new.language_b := new.target_languages[1];
  end if;
  return new;
end;
$$;

drop trigger if exists host_glossary_presets_sync_target_languages on public.host_glossary_presets;

create trigger host_glossary_presets_sync_target_languages
before insert or update on public.host_glossary_presets
for each row execute function public.host_glossary_presets_sync_target_languages();

-- 4. v2 create: accepts the full target list ----------------------------------

create or replace function public.create_host_glossary_document_preset_v2(
  p_host_id text,
  p_name text,
  p_domain text,
  p_language_a text,
  p_target_languages text[],
  p_document jsonb,
  p_fingerprint text
)
returns table (
  id uuid,
  name text,
  domain text,
  language_a text,
  language_b text,
  target_languages text[],
  version integer,
  active_document_version integer,
  active_document_fingerprint text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  clean_name text;
  clean_domain text;
  clean_language_a text;
  clean_fingerprint text;
  preset_count integer;
  created_preset public.host_glossary_presets%rowtype;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  clean_name := pg_catalog.btrim(coalesce(p_name, ''));
  clean_domain := pg_catalog.btrim(coalesce(p_domain, ''));
  clean_language_a := pg_catalog.btrim(coalesce(p_language_a, ''));
  clean_fingerprint := pg_catalog.btrim(coalesce(p_fingerprint, ''));

  if pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_name) not between 1 and 80
    or clean_name ~ '[[:cntrl:]]'
    or clean_name ~ '[<>]'
    or pg_catalog.char_length(clean_domain) > 600
    or clean_domain ~ '[[:cntrl:]]'
    or public.live_language_valid(clean_language_a) is not true
    or p_target_languages is null
    or public.live_target_languages_valid(p_target_languages, clean_language_a) is not true
    or p_document is null
    or jsonb_typeof(p_document) <> 'object'
    or octet_length(p_document::text) > 5000000
    or clean_fingerprint !~ '^sha256:[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_GLOSSARY_DOCUMENT_INPUT';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(clean_host_id, 0));

  select count(*) into preset_count
  from public.host_glossary_presets as preset_row
  where preset_row.host_id = clean_host_id;

  if preset_count >= 50 then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_LIMIT_REACHED';
  end if;

  insert into public.host_glossary_presets (
    host_id,
    name,
    domain,
    glossary,
    language_a,
    language_b,
    target_languages,
    active_document_version,
    active_document_fingerprint
  ) values (
    clean_host_id,
    clean_name,
    clean_domain,
    'Document glossary',
    clean_language_a,
    p_target_languages[1],
    p_target_languages,
    1,
    clean_fingerprint
  )
  returning * into created_preset;

  insert into public.host_glossary_preset_versions (
    preset_id, host_id, version, document, fingerprint
  ) values (
    created_preset.id, clean_host_id, 1, p_document, clean_fingerprint
  );

  return query select
    created_preset.id,
    created_preset.name,
    created_preset.domain,
    created_preset.language_a,
    created_preset.language_b,
    created_preset.target_languages,
    created_preset.version,
    created_preset.active_document_version,
    created_preset.active_document_fingerprint,
    created_preset.updated_at;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NAME_CONFLICT';
end;
$$;

revoke all on function public.create_host_glossary_document_preset_v2(text, text, text, text, text[], jsonb, text)
  from public, anon, authenticated;

-- 5. v2 list: exposes the full target list ------------------------------------

create or replace function public.list_host_glossary_documents_v2(
  p_host_id text
)
returns table (
  id uuid,
  name text,
  domain text,
  language_a text,
  language_b text,
  target_languages text[],
  version integer,
  active_document_version integer,
  active_document_fingerprint text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  clean_host_id text;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_GLOSSARY_DOCUMENT_INPUT';
  end if;

  return query
  select
    preset_row.id,
    preset_row.name,
    preset_row.domain,
    preset_row.language_a,
    preset_row.language_b,
    case
      when pg_catalog.cardinality(preset_row.target_languages) >= 1 then preset_row.target_languages
      else array[preset_row.language_b]
    end,
    preset_row.version,
    preset_row.active_document_version,
    preset_row.active_document_fingerprint,
    preset_row.updated_at
  from public.host_glossary_presets as preset_row
  where preset_row.host_id = clean_host_id
  order by preset_row.updated_at desc, preset_row.id;
end;
$$;

revoke all on function public.list_host_glossary_documents_v2(text)
  from public, anon, authenticated;

-- supabase/migrations/202608310001_live_session_persistence.sql

-- 2026-08-31 feat: Saved calls outlive browser connections and access windows.
-- Authentication, invites, and viewer grants remain time bounded. Only an
-- explicit host cancellation/end changes an active call to a terminal state.

alter table public.live_sessions
  add column if not exists access_window_started_at timestamptz;

update public.live_sessions
set access_window_started_at = created_at
where access_window_started_at is null;

alter table public.live_sessions
  alter column access_window_started_at set default statement_timestamp(),
  alter column access_window_started_at set not null,
  add constraint live_sessions_access_window_started_check
    check (access_window_started_at >= created_at),
  drop constraint live_sessions_schedule_window_check,
  add constraint live_sessions_schedule_window_check check (
    scheduled_at is null
    or (
      scheduled_at >= created_at - interval '5 minutes'
      and scheduled_at <= access_window_started_at + interval '30 days'
    )
  ),
  drop constraint live_sessions_expiry_check,
  add constraint live_sessions_expiry_check check (
    expires_at > greatest(access_window_started_at, coalesce(scheduled_at, access_window_started_at))
    and expires_at <= greatest(access_window_started_at, coalesce(scheduled_at, access_window_started_at)) + interval '6 hours'
  );

comment on column public.live_sessions.access_window_started_at is
  'Host-authorized finite access-window anchor. Existing rows retain created_at; renewal never changes call identity or schedule.';
comment on column public.live_sessions.expires_at is
  'Finite access deadline, not a session retention deadline. An active call remains saved after this timestamp.';
comment on column public.live_sessions.scheduled_at is
  'Optional host schedule. Explicit changes are bounded to 30 days after the current authorized window starts; overdue schedules remain saved.';

create or replace function public.enforce_stable_live_admission()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'stopped' then
      new.admission_code_hmac := null;
      new.admission_open_until := null;
      new.admission_state := 'ended';
    elsif new.admission_code_hmac is null then
      new.admission_generation := 0;
      new.admission_state := 'uninitialized';
    else
      new.admission_generation := greatest(new.admission_generation, 1);
      new.admission_state := 'open';
      new.admission_open_until := new.expires_at;
    end if;
    return new;
  end if;

  if new.status = 'stopped' then
    new.admission_code_hmac := null;
    new.admission_open_until := null;
    new.admission_state := 'ended';
    return new;
  end if;

  if old.admission_code_hmac is not null
    and new.admission_code_hmac is distinct from old.admission_code_hmac
  then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CODE_IMMUTABLE';
  end if;

  if old.admission_code_hmac is null and new.admission_code_hmac is not null then
    new.admission_generation := old.admission_generation + 1;
    new.admission_state := 'open';
    new.admission_open_until := new.expires_at;
  elsif old.admission_code_hmac is not null then
    new.admission_generation := old.admission_generation;
    -- 2026-08-31 fix: Renewing host access must not reopen an expired invitation.
    -- open_live_admission explicitly supplies a new deadline; unrelated expiry
    -- changes preserve the existing deadline, bounded by the access window.
    new.admission_open_until := least(new.admission_open_until, new.expires_at);
    if new.admission_state not in ('open', 'paused') then
      new.admission_state := old.admission_state;
    end if;
  else
    new.admission_generation := 0;
    new.admission_state := 'uninitialized';
    new.admission_open_until := null;
  end if;
  return new;
end;
$$;

create or replace function public.renew_live_session_access_v1(
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
    or p_host_id <> btrim(p_host_id)
    or p_host_id ~ '[[:cntrl:]]'
    or p_expected_version is null
    or p_expected_version < 1
    or p_expected_version >= 2147483647
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_RENEWAL_INPUT';
  end if;

  select target_session.* into session_row
  from public.live_sessions target_session
  where target_session.id = p_session_id
    and target_session.host_id = p_host_id
    and target_session.version = p_expected_version
    and target_session.status in ('preparing', 'live', 'paused')
    and target_session.archive_deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT_OR_FORBIDDEN';
  end if;

  if session_row.expires_at > statement_timestamp() then
    return session_row.version;
  end if;

  update public.live_sessions target_session
  set access_window_started_at = statement_timestamp(),
      expires_at = greatest(statement_timestamp(), coalesce(target_session.scheduled_at, statement_timestamp()))
        + interval '6 hours',
      version = target_session.version + 1,
      updated_at = statement_timestamp()
  where target_session.id = session_row.id
    and target_session.host_id = p_host_id
    and target_session.version = p_expected_version
    and target_session.status in ('preparing', 'live', 'paused')
    and target_session.archive_deleted_at is null
  returning target_session.version into next_version;

  if next_version is null then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT_OR_FORBIDDEN';
  end if;
  return next_version;
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
  p_voice_provider text,
  p_title text,
  p_scheduled_at timestamptz
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
  title text,
  scheduled_at timestamptz,
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
  current_session public.live_sessions%rowtype;
  normalized_title text;
begin
  normalized_title := nullif(normalize(btrim(coalesce(p_title, '')), NFC), '');

  if p_session_id is null
    or p_host_id is null
    or length(p_host_id) not between 1 and 256
    or p_expected_version is null
    or p_expected_version < 1
    or p_expected_version >= 2147483647
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
    or p_max_viewers not between 1 and 200
    or p_glossary_pack is null
    or p_glossary_pack not in ('general_cre', 'hotel', 'fnb')
    or normalized_title is null
    or char_length(normalized_title) not between 1 and 120
    or normalized_title ~ '[[:cntrl:]]'
    or normalized_title ~ '[<>]'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_INPUT';
  end if;

  select session_row.* into current_session
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.version = p_expected_version
    and session_row.status = 'preparing'
    and session_row.expires_at > statement_timestamp()
    and session_row.archive_deleted_at is null
  for update;
  if not found then
    return;
  end if;

  if p_scheduled_at is distinct from current_session.scheduled_at
    and p_scheduled_at is not null
    and (
      p_scheduled_at < statement_timestamp() - interval '5 minutes'
      or p_scheduled_at > statement_timestamp() + interval '30 days'
    )
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
      title = normalized_title,
      scheduled_at = p_scheduled_at,
      access_window_started_at = statement_timestamp(),
      expires_at = greatest(statement_timestamp(), coalesce(p_scheduled_at, statement_timestamp()))
        + interval '6 hours',
      version = session_row.version + 1,
      updated_at = statement_timestamp()
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.version = p_expected_version
    and session_row.status = 'preparing'
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
  title := updated_session.title;
  scheduled_at := updated_session.scheduled_at;
  admission_open_until := updated_session.admission_open_until;
  expires_at := updated_session.expires_at;
  return next;
end;
$$;

create or replace function public.cleanup_expired_live_state()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1
  from public.live_sessions session_lock
  where (
      session_lock.status <> 'stopped'
      and session_lock.expires_at <= statement_timestamp()
    )
    or exists (
      select 1 from public.viewer_grants grant_lock
      where grant_lock.session_id = session_lock.id
        and (
          grant_lock.revoked_at is not null
          or grant_lock.expires_at <= statement_timestamp()
          or session_lock.status = 'stopped'
          or session_lock.expires_at <= statement_timestamp()
        )
    )
    or exists (
      select 1 from public.live_recap_grants recap_lock
      where recap_lock.session_id = session_lock.id
        and recap_lock.expires_at <= statement_timestamp()
    )
  order by session_lock.id
  for update;

  update public.live_session_invites invite_row
  set revoked_at = coalesce(invite_row.revoked_at, statement_timestamp())
  from public.live_sessions session_row
  where invite_row.session_id = session_row.id
    and invite_row.revoked_at is null
    and (
      invite_row.expires_at <= statement_timestamp()
      or session_row.status = 'stopped'
      or session_row.expires_at <= statement_timestamp()
    );

  -- 2026-08-31 fix: Cleanup preserves receipts issued by the actual-end trigger.
  -- Extending only expires_at violates their created_at + 30 days constraint;
  -- a missing receipt is bounded to the same actual end, never the sweep time.
  insert into public.live_recap_grants (session_id, user_id, expires_at, created_at)
  select distinct grant_row.session_id, grant_row.user_id,
    session_row.ended_at + interval '30 days', session_row.ended_at
  from public.viewer_grants grant_row
  join public.live_sessions session_row on session_row.id = grant_row.session_id
  where session_row.status = 'stopped'
    and session_row.ended_at is not null
    and session_row.ended_at + interval '30 days' > statement_timestamp()
  on conflict (session_id, user_id) do nothing;

  update public.live_sessions session_row
  set floor_grant_id = null,
      floor_display_name = null,
      floor_taken_at = null
  where (
      session_row.floor_grant_id is not null
      or session_row.floor_display_name is not null
      or session_row.floor_taken_at is not null
    )
    and (
      session_row.expires_at <= statement_timestamp()
      or session_row.status in ('stopped', 'failed')
      or not exists (
        select 1 from public.viewer_grants floor_grant
        where floor_grant.id = session_row.floor_grant_id
          and floor_grant.revoked_at is null
          and floor_grant.expires_at > statement_timestamp()
      )
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
    where revoked_at is null and expires_at > statement_timestamp()
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
      select 1 from public.viewer_grants grant_row
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
  delete from public.live_recap_grants
  where expires_at <= statement_timestamp();

  return 0;
end;
$$;

create or replace function public.cleanup_expired_live_glossary_documents()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_document_versions integer := 0;
begin
  -- 2026-08-31 fix: Session pins and sections follow explicit archive purge.
  -- A saved call must recover the same glossary and agenda even after 30 days.
  -- Only unused historical document versions retain independent TTL cleanup.
  delete from public.host_glossary_preset_versions as version_row
  using public.host_glossary_presets as preset_row
  where version_row.preset_id = preset_row.id
    and version_row.created_at < statement_timestamp() - interval '30 days'
    and (
      preset_row.active_document_version is distinct from version_row.version
      or preset_row.active_document_fingerprint is distinct from version_row.fingerprint
    )
    and not exists (
      select 1
      from public.live_sessions as pinned_session
      where pinned_session.pinned_glossary_preset_id = version_row.preset_id
        and pinned_session.pinned_glossary_version = version_row.version
        and pinned_session.pinned_glossary_fingerprint = version_row.fingerprint
    )
    and not exists (
      select 1
      from public.live_session_glossary_pins as pinned_glossary
      where pinned_glossary.host_preset_id = version_row.preset_id
        and pinned_glossary.host_document_version = version_row.version
        and pinned_glossary.host_document_fingerprint = version_row.fingerprint
    );

  GET DIAGNOSTICS deleted_document_versions = ROW_COUNT;
  return deleted_document_versions;
end;
$$;

revoke all on function public.renew_live_session_access_v1(uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.renew_live_session_access_v1(uuid, text, integer)
  to service_role;

-- Replacements keep their established service-only grants. Restate the
-- security boundary explicitly so a fresh bootstrap and upgrade agree.
revoke all on function public.update_live_session(
  uuid, text, integer, text, text, text[], integer, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.update_live_session(
  uuid, text, integer, text, text, text[], integer, text, text, text, timestamptz
) to service_role;
revoke all on function public.cleanup_expired_live_state()
  from public, anon, authenticated;
grant execute on function public.cleanup_expired_live_state() to service_role;
revoke all on function public.cleanup_expired_live_glossary_documents()
  from public, anon, authenticated;
grant execute on function public.cleanup_expired_live_glossary_documents() to service_role;
revoke all on function public.enforce_stable_live_admission()
  from public, anon, authenticated;

-- Apply only after explicit approval. Roll back application callers first;
-- leave the additive anchor/RPC and persistence cleanup in place. Do not
-- revive terminal rows or re-enable a sweep that terminates retained calls.


-- supabase/migrations/202608310002_live_recap_requests_and_record_access.sql

-- 2026-08-31 feat: A recap request records consent, never an email delivery.
-- The read window is anchored to the actual meeting end, not a cookie refresh.

alter table public.live_participants
  add column if not exists records_revoked_at timestamptz;

comment on column public.live_participants.records_revoked_at is
  'Explicit read-only records revocation; live grant cleanup does not revoke durable membership.';

create table public.live_recap_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  participant_id uuid not null references public.live_participants(id) on delete cascade,
  consent_id uuid not null references public.live_participant_consents(id),
  consent_revision integer not null check (consent_revision > 0),
  notice_version text not null check (notice_version = 'summary-original-email-v2'),
  email text not null check (public.is_valid_live_attendee_email(email)),
  idempotency_key uuid not null,
  requested_at timestamptz not null default statement_timestamp(),
  unique (session_id, participant_id),
  unique (participant_id, idempotency_key)
);

alter table public.live_recap_requests enable row level security;
revoke all on public.live_recap_requests from public, anon, authenticated, service_role;
comment on table public.live_recap_requests is
  'Explicit summary-and-original email requests. No sender, email verification, delivery claim, or marketing opt-in is implied.';

create table public.live_media_recording_gaps (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  epoch integer not null,
  started_at timestamptz not null default statement_timestamp(),
  ended_at timestamptz,
  reason text not null check (reason in ('no_viewers','host_unavailable','media_failed')),
  check (ended_at is null or ended_at >= started_at)
);
create unique index live_media_one_open_gap_idx on public.live_media_recording_gaps(session_id)
  where ended_at is null;

alter table public.live_media_recording_gaps enable row level security;
revoke all on public.live_media_recording_gaps from public, anon, authenticated, service_role;

create or replace function public.read_participant_live_record_access_v1(
  p_session_id uuid,
  p_user_id text
)
returns table (
  session_id uuid, title text, scheduled_at timestamptz, status text,
  ended_at timestamptz, records_expires_at timestamptz,
  session_type text, output_mode text, voice_provider text, glossary_pack text,
  languages text[], max_viewers integer, participant_id uuid, user_id text,
  display_name text, email text, company text, department text, job_title text,
  summary_consent_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  participant_row public.live_participants%rowtype;
begin
  if p_session_id is null or p_user_id is null
    or char_length(p_user_id) not between 1 and 256 then
    raise exception using errcode = '42501', message = 'RECAP_FORBIDDEN';
  end if;
  select target.* into session_row from public.live_sessions target
  where target.id = p_session_id and target.archive_deleted_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'RECAP_FORBIDDEN';
  end if;
  select target.* into participant_row from public.live_participants target
  where target.session_id = p_session_id and target.user_id = p_user_id
    and target.records_revoked_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'RECAP_FORBIDDEN';
  end if;
  if session_row.status not in ('stopped', 'failed') or session_row.ended_at is null then
    raise exception using errcode = 'P0001', message = 'RECAP_NOT_READY';
  end if;
  if statement_timestamp() >= session_row.ended_at + interval '6 hours' then
    raise exception using errcode = 'P0001', message = 'RECAP_EXPIRED';
  end if;
  return query select session_row.id, session_row.title, session_row.scheduled_at,
    session_row.status, session_row.ended_at, session_row.ended_at + interval '6 hours',
    session_row.session_type, session_row.output_mode, session_row.voice_provider,
    session_row.glossary_pack, session_row.languages, session_row.max_viewers,
    participant_row.id, participant_row.user_id, participant_row.display_name,
    participant_row.email, participant_row.company, participant_row.department,
    participant_row.job_title, participant_row.summary_consent_at;
end;
$$;

-- 2026-08-31 fix: Legacy authenticated SELECT policies cannot bypass the new deadline.
-- This predicate derives the identity from auth.uid(), never a caller argument.
create or replace function public.can_read_live_recap_v1(p_session_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.live_sessions session_row
    join public.live_participants participant_row on participant_row.session_id = session_row.id
    where session_row.id = p_session_id
      and session_row.archive_deleted_at is null
      and session_row.status in ('stopped', 'failed')
      and session_row.ended_at is not null
      and statement_timestamp() < session_row.ended_at + interval '6 hours'
      and participant_row.user_id = (select auth.uid())::text
      and participant_row.records_revoked_at is null
  );
$$;

alter policy live_recap_grants_owner_select on public.live_recap_grants
  using (user_id = (select auth.uid())::text and public.can_read_live_recap_v1(session_id));
alter policy live_sessions_recap_viewer_select on public.live_sessions
  using (public.can_read_live_recap_v1(id));
alter policy live_utterances_recap_select on public.live_utterances
  using (public.can_read_live_recap_v1(session_id) or exists (
    select 1 from public.live_sessions session_row
    where session_row.id = live_utterances.session_id
      and session_row.host_id = (select auth.uid())::text
      and session_row.archive_deleted_at is null
      and session_row.status in ('stopped', 'failed')
  ));
alter policy live_meeting_summaries_recap_select on public.live_meeting_summaries
  using (public.can_read_live_recap_v1(session_id) or exists (
    select 1 from public.live_sessions session_row
    where session_row.id = live_meeting_summaries.session_id
      and session_row.host_id = (select auth.uid())::text
      and session_row.archive_deleted_at is null
      and session_row.status in ('stopped', 'failed')
  ));

create or replace function public.read_participant_live_source_transcript_v1(
  p_session_id uuid, p_user_id text,
  p_after_source_seq bigint default 0, p_limit integer default 200
)
returns table (
  source_utterance_id uuid, source_seq bigint, effective_text text,
  source_language text, speaker_label text, source_started_at timestamptz,
  source_ended_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform 1 from public.read_participant_live_record_access_v1(p_session_id, p_user_id);
  if p_after_source_seq is null or p_after_source_seq < 0
    or p_limit is null or p_limit not between 1 and 501 then
    raise exception using errcode = '22023', message = 'INVALID_RECAP_TRANSCRIPT_INPUT';
  end if;
  return query select source_row.id, source_row.source_seq,
    coalesce(correction.corrected_text, source_row.normalized_text),
    source_row.source_language,
    coalesce(source_row.speaker_label,
      case when source_row.speaker_role = 'host' then '진행자' else '참여자' end),
    source_row.source_started_at, source_row.source_ended_at
  from public.live_source_utterances source_row
  left join lateral (
    select correction_row.corrected_text
    from public.live_source_utterance_corrections correction_row
    where correction_row.source_utterance_id = source_row.id
    order by correction_row.revision desc limit 1
  ) correction on true
  where source_row.session_id = p_session_id and source_row.source_seq > p_after_source_seq
  order by source_row.source_seq limit p_limit;
end;
$$;

create or replace function public.live_recap_request_json_v1(p_request_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', request_row.id, 'sessionId', request_row.session_id,
    'participantId', request_row.participant_id, 'requestedAt', request_row.requested_at,
    'noticeVersion', request_row.notice_version, 'email', request_row.email,
    'revision', request_row.consent_revision,
    'displayName', participant_row.display_name, 'company', participant_row.company,
    'department', participant_row.department, 'jobTitle', participant_row.job_title,
    'consentAcceptedAt', consent_row.accepted_at,
    'status', case when latest.is_accepted and latest.notice_version = request_row.notice_version
      and participant_row.records_revoked_at is null and participant_row.email = request_row.email
      then 'requested' else 'cancelled' end,
    'cancelledAt', case when latest.is_accepted and latest.notice_version = request_row.notice_version
      and participant_row.records_revoked_at is null and participant_row.email = request_row.email then null
      else coalesce(participant_row.records_revoked_at, latest.withdrawn_at, latest.recorded_at) end
  )
  from public.live_recap_requests request_row
  join public.live_participants participant_row on participant_row.id = request_row.participant_id
  join public.live_participant_consents consent_row on consent_row.id = request_row.consent_id
  left join lateral (
    select consent.* from public.live_participant_consents consent
    where consent.participant_id = request_row.participant_id and consent.purpose = 'summary_delivery'
    order by consent.revision desc limit 1
  ) latest on true
  where request_row.id = p_request_id;
$$;

create or replace function public.read_live_recap_request_v1(p_session_id uuid, p_user_id text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare request_id uuid;
begin
  perform 1 from public.read_participant_live_record_access_v1(p_session_id, p_user_id);
  select request_row.id into request_id from public.live_recap_requests request_row
  join public.live_participants participant_row on participant_row.id = request_row.participant_id
  where request_row.session_id = p_session_id and participant_row.user_id = p_user_id;
  return public.live_recap_request_json_v1(request_id);
end;
$$;

create or replace function public.read_participant_live_recording_gaps_v1(p_session_id uuid, p_user_id text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare result jsonb;
begin
  perform 1 from public.read_participant_live_record_access_v1(p_session_id, p_user_id);
  if (select count(*) from public.live_media_recording_gaps target where target.session_id = p_session_id) > 12000 then
    raise exception using errcode = 'P0001', message = 'EXPORT_TOO_LARGE';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',target.id,'startedAt',target.started_at,
    'endedAt',target.ended_at,'reason',target.reason) order by target.started_at,target.id), '[]'::jsonb)
  into result from public.live_media_recording_gaps target where target.session_id = p_session_id;
  return jsonb_build_object('recordingGaps',result);
end;
$$;

create or replace function public.read_owned_live_recording_gaps_v1(p_session_id uuid, p_host_id text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare result jsonb;
begin
  perform 1 from public.live_sessions target where target.id = p_session_id
    and target.host_id = p_host_id and target.archive_deleted_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'LIVE_RECORD_NOT_FOUND';
  end if;
  if (select count(*) from public.live_media_recording_gaps target where target.session_id = p_session_id) > 12000 then
    raise exception using errcode = 'P0001', message = 'EXPORT_TOO_LARGE';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',target.id,'startedAt',target.started_at,
    'endedAt',target.ended_at,'reason',target.reason) order by target.started_at,target.id), '[]'::jsonb)
  into result from public.live_media_recording_gaps target where target.session_id = p_session_id;
  return jsonb_build_object('recordingGaps',result);
end;
$$;

create or replace function public.request_live_recap_v1(
  p_session_id uuid, p_user_id text, p_notice_version text, p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  participant_row public.live_participants%rowtype;
  request_id uuid;
  consent_row record;
begin
  if p_notice_version is distinct from 'summary-original-email-v2' or p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'INVALID_RECAP_REQUEST';
  end if;
  perform 1 from public.live_sessions target where target.id = p_session_id for update;
  perform 1 from public.read_participant_live_record_access_v1(p_session_id, p_user_id);
  select target.* into participant_row from public.live_participants target
  where target.session_id = p_session_id and target.user_id = p_user_id for update;
  if participant_row.records_revoked_at is not null then
    raise exception using errcode = '42501', message = 'RECAP_FORBIDDEN';
  end if;
  if exists (select 1 from public.live_sessions target where target.id = p_session_id
    and clock_timestamp() >= target.ended_at + interval '6 hours') then
    raise exception using errcode = 'P0001', message = 'RECAP_EXPIRED';
  end if;
  if participant_row.email is null or not public.is_valid_live_attendee_email(participant_row.email) then
    raise exception using errcode = '22023', message = 'RECAP_EMAIL_REQUIRED';
  end if;
  select target.id into request_id from public.live_recap_requests target
  where target.session_id = p_session_id and target.participant_id = participant_row.id;
  if found then
    return public.live_recap_request_json_v1(request_id);
  end if;
  select consent.* into consent_row
  from public.record_live_participant_consent_v1(p_session_id, participant_row.id,
    p_user_id, 'summary_delivery', p_notice_version, true) consent;
  insert into public.live_recap_requests (
    session_id, participant_id, consent_id, consent_revision, notice_version, email, idempotency_key
  ) values (p_session_id, participant_row.id, consent_row.consent_id,
    consent_row.revision, p_notice_version, participant_row.email, p_idempotency_key)
  returning id into request_id;
  return public.live_recap_request_json_v1(request_id);
end;
$$;

create or replace function public.read_owned_live_recap_requests_v1(p_session_id uuid, p_host_id text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare result jsonb;
begin
  perform 1 from public.live_sessions target where target.id = p_session_id
    and target.host_id = p_host_id and target.archive_deleted_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'LIVE_RECORD_NOT_FOUND';
  end if;
  if (select count(*) from public.live_recap_requests target where target.session_id = p_session_id) > 10000 then
    raise exception using errcode = 'P0001', message = 'EXPORT_TOO_LARGE';
  end if;
  select coalesce(jsonb_agg(public.live_recap_request_json_v1(target.id)
    order by target.requested_at, target.id), '[]'::jsonb)
  into result from public.live_recap_requests target where target.session_id = p_session_id;
  return jsonb_build_object('requests', result);
end;
$$;

-- 2026-08-31 feat: STABLE keeps all export queries on the caller statement snapshot.
-- The archive is never assembled from differently timed paginated HTTP reads.
create or replace function public.read_owned_live_record_export_v1(p_session_id uuid, p_host_id text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  participants jsonb; utterances jsonb; summaries jsonb; requests jsonb; recording_gaps jsonb;
  estimated_bytes bigint;
begin
  select target.* into session_row from public.live_sessions target
  where target.id = p_session_id and target.host_id = p_host_id
    and target.archive_deleted_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'LIVE_RECORD_NOT_FOUND';
  end if;
  if session_row.status not in ('stopped', 'failed') or session_row.ended_at is null then
    raise exception using errcode = 'P0001', message = 'LIVE_TRANSCRIPT_NOT_READY';
  end if;
  if (select count(*) from public.live_participants target where target.session_id = p_session_id) > 10000
    or (select count(*) from public.live_source_utterances target where target.session_id = p_session_id) > 12000
    or (select count(*) from public.live_recap_requests target where target.session_id = p_session_id) > 10000
    or (select count(*) from public.live_media_recording_gaps target where target.session_id = p_session_id) > 12000
    or (select count(*) from (
      select unnest(session_row.languages) as language
      union select target.language from public.live_meeting_summaries target where target.session_id = p_session_id
      union select target.language from public.live_summary_generation_jobs target where target.session_id = p_session_id
  ) all_languages) > 14 then
    raise exception using errcode = 'P0001', message = 'EXPORT_TOO_LARGE';
  end if;
  select coalesce(sum(octet_length(to_jsonb(coalesce(correction.corrected_text,source_row.normalized_text))::text)+512),0)
  into estimated_bytes from public.live_source_utterances source_row
  left join lateral (
    select target.corrected_text from public.live_source_utterance_corrections target
    where target.source_utterance_id=source_row.id order by target.revision desc limit 1
  ) correction on true where source_row.session_id=p_session_id;
  estimated_bytes := estimated_bytes
    + coalesce((select sum(octet_length(to_jsonb(target)::text)+256)
      from public.live_participants target where target.session_id=p_session_id),0)
    + coalesce((select sum(octet_length(target.summary::text)+256)
      from public.live_meeting_summaries target where target.session_id=p_session_id),0)
    + (select count(*)*1024 from public.live_recap_requests target where target.session_id=p_session_id)
    + (select count(*)*512 from public.live_media_recording_gaps target where target.session_id=p_session_id);
  if estimated_bytes > 12*1024*1024 then
    raise exception using errcode = 'P0001', message = 'EXPORT_TOO_LARGE';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', target.id, 'displayName', target.display_name, 'email', target.email,
    'company', target.company, 'department', target.department, 'jobTitle', target.job_title,
    'joinedAt', target.joined_at) order by target.joined_at, target.id), '[]'::jsonb)
  into participants from public.live_participants target where target.session_id = p_session_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', source_row.id, 'seq', source_row.source_seq,
    'speaker', coalesce(source_row.speaker_name, source_row.speaker_label,
      case when source_row.speaker_role = 'host' then '진행자' else '참여자' end),
    'language', source_row.source_language, 'startedAt', source_row.source_started_at,
    'endedAt', source_row.source_ended_at,
    'text', coalesce(correction.corrected_text, source_row.normalized_text),
    'topicTitle', topic_row.title) order by source_row.source_seq), '[]'::jsonb)
  into utterances from public.live_source_utterances source_row
  left join lateral (
    select target.corrected_text from public.live_source_utterance_corrections target
    where target.source_utterance_id = source_row.id order by target.revision desc limit 1
  ) correction on true
  left join public.live_topic_utterances topic_link on topic_link.session_id = source_row.session_id
    and topic_link.utterance_key = source_row.utterance_key
  left join public.live_topics topic_row on topic_row.id = topic_link.topic_id
  where source_row.session_id = p_session_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'language', language_row.language,
    'status', case when summary_row.summary is not null then 'ready'
      when job_row.status = 'failed' then 'failed' else 'pending' end,
    'createdAt', summary_row.created_at, 'summary', summary_row.summary
  ) order by coalesce(array_position(session_row.languages, language_row.language),1000), language_row.language), '[]'::jsonb)
  into summaries from (
    select unnest(session_row.languages) as language
    union select target.language from public.live_meeting_summaries target where target.session_id = p_session_id
    union select target.language from public.live_summary_generation_jobs target where target.session_id = p_session_id
  ) language_row
  left join public.live_meeting_summaries summary_row on summary_row.session_id = p_session_id
    and summary_row.language = language_row.language
  left join public.live_summary_generation_jobs job_row on job_row.session_id = p_session_id
    and job_row.language = language_row.language;

  requests := public.read_owned_live_recap_requests_v1(p_session_id, p_host_id)->'requests';
  select coalesce(jsonb_agg(jsonb_build_object('id', target.id, 'startedAt', target.started_at,
    'endedAt', target.ended_at, 'reason', target.reason) order by target.started_at,target.id), '[]'::jsonb)
  into recording_gaps from public.live_media_recording_gaps target where target.session_id = p_session_id;
  return jsonb_build_object('snapshotId', extensions.gen_random_uuid(), 'generatedAt', statement_timestamp(),
    'session', jsonb_build_object('id', session_row.id, 'title', session_row.title,
      'status', session_row.status, 'scheduledAt', session_row.scheduled_at,
      'endedAt', session_row.ended_at, 'languages', session_row.languages),
    'participants', participants, 'utterances', utterances, 'summaries', summaries, 'requests', requests,
    'recordingGaps', recording_gaps);
end;
$$;

revoke all on function public.read_participant_live_record_access_v1(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.can_read_live_recap_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function public.read_participant_live_source_transcript_v1(uuid, text, bigint, integer) from public, anon, authenticated, service_role;
revoke all on function public.live_recap_request_json_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function public.read_live_recap_request_v1(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.read_participant_live_recording_gaps_v1(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.read_owned_live_recording_gaps_v1(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.request_live_recap_v1(uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.read_owned_live_recap_requests_v1(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.read_owned_live_record_export_v1(uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.read_participant_live_record_access_v1(uuid, text) to service_role;
grant execute on function public.can_read_live_recap_v1(uuid) to authenticated, service_role;
grant execute on function public.read_participant_live_source_transcript_v1(uuid, text, bigint, integer) to service_role;
grant execute on function public.read_live_recap_request_v1(uuid, text) to service_role;
grant execute on function public.read_participant_live_recording_gaps_v1(uuid, text) to service_role;
grant execute on function public.read_owned_live_recording_gaps_v1(uuid, text) to service_role;
grant execute on function public.request_live_recap_v1(uuid, text, text, uuid) to service_role;
grant execute on function public.read_owned_live_recap_requests_v1(uuid, text) to service_role;
grant execute on function public.read_owned_live_record_export_v1(uuid, text) to service_role;


-- supabase/migrations/202608310003_live_media_demand_leases.sql

-- 2026-08-31 feat: Durable demand leases separate a meeting from its paid media runtime.
-- Existing sessions have no runtime row and keep the legacy behavior until opted in.

create table public.live_session_runtime (
  session_id uuid primary key references public.live_sessions(id) on delete cascade,
  state text not null default 'sleeping' check (state in ('sleeping','waking','active','draining','failed')),
  epoch integer not null default 0 check (epoch >= 0),
  start_requested_at timestamptz not null default statement_timestamp(),
  owner_id uuid,
  owner_lease_expires_at timestamptz,
  wake_deadline timestamptz,
  idle_after timestamptz,
  last_error_code text,
  updated_at timestamptz not null default statement_timestamp(),
  check ((owner_id is null) = (owner_lease_expires_at is null))
);

create table public.live_host_source_leases (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  source_generation uuid not null,
  host_id text not null,
  source_ready boolean not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  primary key (session_id, source_generation)
);
create unique index live_host_source_one_current_idx on public.live_host_source_leases(session_id)
  where revoked_at is null;

create table public.live_viewer_presence_leases (
  connection_id uuid primary key,
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  grant_id uuid not null references public.viewer_grants(id) on delete cascade,
  user_id text not null,
  epoch integer not null check (epoch > 0),
  owner_id uuid,
  state text not null check (state in ('pending','connected','closed')),
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  check (state <> 'connected' or owner_id is not null)
);
create unique index live_viewer_one_pending_per_grant_idx
  on public.live_viewer_presence_leases(session_id, grant_id) where state = 'pending';
create index live_viewer_presence_demand_idx
  on public.live_viewer_presence_leases(session_id, epoch, state, expires_at);

alter table public.live_session_runtime enable row level security;
alter table public.live_host_source_leases enable row level security;
alter table public.live_viewer_presence_leases enable row level security;
alter table public.live_media_recording_gaps enable row level security;
revoke all on public.live_session_runtime, public.live_host_source_leases,
  public.live_viewer_presence_leases, public.live_media_recording_gaps
  from public, anon, authenticated, service_role;

create or replace function public.get_live_media_runtime_v1(p_session_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  with authority as (
    select runtime.*, session_row.status as session_status,
      session_row.archive_deleted_at, session_row.expires_at as session_expires_at,
      exists (select 1 from public.live_host_source_leases source_row
        where source_row.session_id = runtime.session_id and source_row.source_ready
          and source_row.revoked_at is null and source_row.expires_at > statement_timestamp()
          and source_row.host_id = session_row.host_id) as source_ready
    from public.live_session_runtime runtime
    join public.live_sessions session_row on session_row.id = runtime.session_id
    where runtime.session_id = p_session_id
  ), demand as (
    select count(*) filter (where lease.state = 'connected') as connected_count,
      count(*) filter (where lease.state = 'pending') as pending_count
    from public.live_viewer_presence_leases lease
    join authority on authority.session_id = lease.session_id and authority.epoch = lease.epoch
    join public.viewer_grants grant_row on grant_row.id = lease.grant_id
      and grant_row.session_id = lease.session_id and grant_row.user_id = lease.user_id
      and grant_row.revoked_at is null and grant_row.expires_at > statement_timestamp()
    join public.live_participants participant_row on participant_row.session_id = lease.session_id
      and participant_row.grant_id = lease.grant_id and participant_row.user_id = lease.user_id
    where lease.expires_at > statement_timestamp()
      and (lease.state = 'pending' or lease.owner_id = authority.owner_id)
  )
  select jsonb_build_object(
    'sessionId', authority.session_id,
    'state', case when authority.session_status in ('stopped','failed')
      or authority.archive_deleted_at is not null then 'ended' else authority.state end,
    'epoch', authority.epoch,
    'hostSourceReady', authority.source_ready and authority.session_expires_at > statement_timestamp(),
    'hasDemand', demand.connected_count + demand.pending_count > 0,
    'connectedCount', demand.connected_count, 'pendingCount', demand.pending_count,
    'wakeDeadline', authority.wake_deadline, 'idleAfter', authority.idle_after,
    'ownerId', authority.owner_id, 'ownerLeaseExpiresAt', authority.owner_lease_expires_at,
    'startRequestedAt', authority.start_requested_at, 'lastErrorCode', authority.last_error_code,
    'canPrepareConnection', authority.session_status in ('preparing','live','paused')
      and authority.archive_deleted_at is null and authority.session_expires_at > statement_timestamp()
      and authority.state not in ('draining','failed')
  ) from authority cross join demand;
$$;

create or replace function public.request_live_media_start_v1(
  p_session_id uuid, p_host_id text, p_expected_version integer
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from public.live_sessions target where target.id = p_session_id
    and target.host_id = p_host_id and target.version = p_expected_version
    and target.status in ('preparing','live','paused') and target.archive_deleted_at is null
    and target.expires_at > statement_timestamp() for update;
  if not found then
    raise exception using errcode = '42501', message = 'VERSION_CONFLICT_OR_FORBIDDEN';
  end if;
  insert into public.live_session_runtime(session_id) values (p_session_id)
  on conflict (session_id) do nothing;
  update public.live_session_runtime target set state = 'sleeping', last_error_code = null,
    owner_id = null, owner_lease_expires_at = null, wake_deadline = null, idle_after = null
  where target.session_id = p_session_id and target.state = 'failed';
  insert into public.live_media_recording_gaps(session_id, epoch, reason)
  select runtime.session_id, runtime.epoch, 'no_viewers'
  from public.live_session_runtime runtime where runtime.session_id = p_session_id
    and runtime.state = 'sleeping'
  on conflict (session_id) where ended_at is null do nothing;
  return public.get_live_media_runtime_v1(p_session_id);
end;
$$;

create or replace function public.heartbeat_live_host_source_v1(
  p_session_id uuid, p_host_id text, p_source_generation uuid, p_source_ready boolean
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare source_row public.live_host_source_leases%rowtype;
begin
  if p_source_generation is null or p_source_ready is null then
    raise exception using errcode = '22023', message = 'INVALID_HOST_SOURCE_INPUT';
  end if;
  perform 1 from public.live_sessions target where target.id = p_session_id
    and target.host_id = p_host_id and target.status in ('preparing','live','paused')
    and target.archive_deleted_at is null and target.expires_at > statement_timestamp() for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  perform 1 from public.live_session_runtime target where target.session_id = p_session_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MEDIA_START_NOT_REQUESTED';
  end if;
  select target.* into source_row from public.live_host_source_leases target
  where target.session_id = p_session_id and target.source_generation = p_source_generation;
  if found and source_row.revoked_at is not null then
    raise exception using errcode = 'P0001', message = 'HOST_SOURCE_GENERATION_EXPIRED';
  end if;
  if not found then
    if exists (select 1 from public.live_host_source_leases target
      where target.session_id = p_session_id and target.revoked_at is null
        and target.source_ready and target.expires_at > statement_timestamp()) then
      raise exception using errcode = 'P0001', message = 'HOST_SOURCE_CONFLICT';
    end if;
    update public.live_host_source_leases target set revoked_at = statement_timestamp()
    where target.session_id = p_session_id and target.revoked_at is null;
    insert into public.live_host_source_leases (
      session_id, source_generation, host_id, source_ready, expires_at, revoked_at
    ) values (p_session_id, p_source_generation, p_host_id, p_source_ready,
      statement_timestamp() + interval '45 seconds',
      case when p_source_ready then null else statement_timestamp() end);
  else
    update public.live_host_source_leases target set source_ready = p_source_ready,
      expires_at = statement_timestamp() + interval '45 seconds',
      revoked_at = case when p_source_ready then null else statement_timestamp() end
    where target.session_id = p_session_id and target.source_generation = p_source_generation;
  end if;
  return public.get_live_media_runtime_v1(p_session_id);
end;
$$;

create or replace function public.prepare_live_viewer_connection_v1(
  p_session_id uuid, p_grant_id uuid, p_user_id text, p_connection_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  runtime_row public.live_session_runtime%rowtype;
  pending_row public.live_viewer_presence_leases%rowtype;
  authority_deadline timestamptz;
  runtime_json jsonb;
begin
  if p_connection_id is null then
    raise exception using errcode = '22023', message = 'INVALID_VIEWER_CONNECTION_INPUT';
  end if;
  perform 1 from public.live_sessions target where target.id = p_session_id
    and target.status in ('preparing','live','paused') and target.archive_deleted_at is null
    and target.expires_at > statement_timestamp() for update;
  if not found then
    raise exception using errcode = '42501', message = 'LIVE_SESSION_NOT_AVAILABLE';
  end if;
  select least(grant_row.expires_at, session_row.expires_at) into authority_deadline
  from public.viewer_grants grant_row
  join public.live_sessions session_row on session_row.id = grant_row.session_id
  join public.live_participants participant_row on participant_row.session_id = grant_row.session_id
    and participant_row.grant_id = grant_row.id and participant_row.user_id = grant_row.user_id
  where grant_row.session_id = p_session_id and grant_row.id = p_grant_id
    and grant_row.user_id = p_user_id and grant_row.revoked_at is null
    and grant_row.expires_at > statement_timestamp();
  if not found then
    raise exception using errcode = '42501', message = 'VIEWER_ACCESS_REQUIRED';
  end if;
  select target.* into runtime_row from public.live_session_runtime target
  where target.session_id = p_session_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MEDIA_START_NOT_REQUESTED';
  end if;
  runtime_json := public.get_live_media_runtime_v1(p_session_id);
  if runtime_row.state = 'failed' then
    raise exception using errcode = 'P0001', message = 'MEDIA_EXPLICIT_RETRY_REQUIRED';
  end if;
  if not (runtime_json->>'hostSourceReady')::boolean or runtime_row.state = 'draining' then
    return jsonb_build_object('status','HOST_WAITING','runtime',runtime_json,
      'connectionId',null,'expiresAt',null);
  end if;
  select target.* into pending_row from public.live_viewer_presence_leases target
  where target.session_id = p_session_id and target.grant_id = p_grant_id and target.state = 'pending';
  if found and pending_row.expires_at <= statement_timestamp()
    and statement_timestamp() < pending_row.created_at + interval '55 seconds' then
    raise exception using errcode = 'P0001', message = 'VIEWER_CONNECTION_COOLDOWN';
  end if;

  -- 2026-08-31 fix: An abandoned cold wake has no gateway process to run a timer.
  -- The next authenticated mutation fences the old epoch before allocating another.
  if runtime_row.state = 'sleeping'
    or (runtime_row.state = 'waking' and runtime_row.wake_deadline <= statement_timestamp())
    or (runtime_row.owner_id is not null and runtime_row.owner_lease_expires_at <= statement_timestamp()) then
    if runtime_row.epoch = 2147483647 then
      raise exception using errcode = 'P0001', message = 'MEDIA_EPOCH_EXHAUSTED';
    end if;
    update public.live_session_runtime target set state = 'waking', epoch = target.epoch + 1,
      owner_id = null, owner_lease_expires_at = null, idle_after = null,
      wake_deadline = statement_timestamp() + interval '45 seconds', last_error_code = null,
      updated_at = statement_timestamp()
    where target.session_id = p_session_id returning target.* into runtime_row;
    update public.live_viewer_presence_leases target set state = 'closed', expires_at = statement_timestamp()
    where target.session_id = p_session_id and target.state <> 'closed';
    pending_row := null;
  end if;
  if pending_row.connection_id is not null and pending_row.epoch = runtime_row.epoch
    and pending_row.expires_at > statement_timestamp() then
    return jsonb_build_object('status','READY','runtime',public.get_live_media_runtime_v1(p_session_id),
      'connectionId',pending_row.connection_id,'expiresAt',pending_row.expires_at);
  end if;
  update public.live_viewer_presence_leases target set state = 'closed'
  where target.session_id = p_session_id and target.grant_id = p_grant_id and target.state = 'pending';
  insert into public.live_viewer_presence_leases (
    connection_id, session_id, grant_id, user_id, epoch, state, expires_at
  ) values (p_connection_id,p_session_id,p_grant_id,p_user_id,runtime_row.epoch,'pending',
    least(authority_deadline, statement_timestamp() + interval '45 seconds')) returning * into pending_row;
  return jsonb_build_object('status','READY','runtime',public.get_live_media_runtime_v1(p_session_id),
    'connectionId',pending_row.connection_id,'expiresAt',pending_row.expires_at);
end;
$$;

create or replace function public.gateway_live_media_v1(
  p_session_id uuid, p_epoch integer, p_owner_id uuid, p_action text,
  p_connection_id uuid default null, p_grant_id uuid default null, p_user_id text default null,
  p_connection_ids uuid[] default '{}'
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  runtime_row public.live_session_runtime%rowtype;
  runtime_json jsonb;
  affected integer;
begin
  if p_owner_id is null or p_epoch is null or p_epoch < 1 or p_action is null
    or p_action not in ('claim','ready','renew','connect','disconnect','drain','sleep','fail')
    or p_connection_ids is null or cardinality(p_connection_ids) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_MEDIA_RUNTIME_ACTION';
  end if;
  perform 1 from public.live_sessions target where target.id = p_session_id for update;
  select target.* into runtime_row from public.live_session_runtime target
  where target.session_id = p_session_id and target.epoch = p_epoch for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MEDIA_EPOCH_CONFLICT';
  end if;
  runtime_json := public.get_live_media_runtime_v1(p_session_id);
  if runtime_json->>'state' = 'ended' and p_action not in ('sleep','fail','disconnect') then
    raise exception using errcode = 'P0001', message = 'MEDIA_SESSION_ENDED';
  end if;
  if p_action in ('claim','connect') and (
    not (runtime_json->>'hostSourceReady')::boolean
    or not (runtime_json->>'hasDemand')::boolean
    or (runtime_row.state = 'waking' and runtime_row.wake_deadline <= statement_timestamp())
  ) then
    raise exception using errcode = 'P0001', message = 'MEDIA_NOT_READY';
  end if;

  if p_action in ('claim','connect') and runtime_row.owner_id is null then
    if runtime_row.state <> 'waking' or runtime_row.wake_deadline <= statement_timestamp()
      or not (runtime_json->>'hostSourceReady')::boolean
      or not (runtime_json->>'hasDemand')::boolean then
      raise exception using errcode = 'P0001', message = 'MEDIA_NOT_READY';
    end if;
    update public.live_session_runtime target set owner_id = p_owner_id,
      owner_lease_expires_at = statement_timestamp() + interval '45 seconds'
    where target.session_id = p_session_id returning target.* into runtime_row;
  end if;
  if runtime_row.owner_id is distinct from p_owner_id
    or runtime_row.owner_lease_expires_at <= statement_timestamp() then
    raise exception using errcode = 'P0001', message = 'MEDIA_OWNER_CONFLICT';
  end if;

  if p_action = 'connect' then
    if runtime_row.state not in ('waking','active') then
      raise exception using errcode = 'P0001', message = 'MEDIA_NOT_READY';
    end if;
    update public.live_viewer_presence_leases lease set state = 'connected', owner_id = p_owner_id,
      expires_at = least(statement_timestamp() + interval '45 seconds', grant_row.expires_at, session_row.expires_at)
    from public.viewer_grants grant_row, public.live_sessions session_row
    where lease.connection_id = p_connection_id and lease.session_id = p_session_id and lease.epoch = p_epoch
      and lease.grant_id = p_grant_id and lease.user_id = p_user_id
      and lease.state in ('pending','connected') and lease.expires_at > statement_timestamp()
      and (lease.owner_id is null or lease.owner_id = p_owner_id)
      and grant_row.id = lease.grant_id and grant_row.session_id = lease.session_id
      and grant_row.user_id = lease.user_id and grant_row.revoked_at is null
      and grant_row.expires_at > statement_timestamp()
      and session_row.id = lease.session_id and session_row.expires_at > statement_timestamp()
      and exists (select 1 from public.live_participants participant_row
        where participant_row.session_id = lease.session_id and participant_row.grant_id = lease.grant_id
          and participant_row.user_id = lease.user_id);
    get diagnostics affected = row_count;
    if affected <> 1 then
      raise exception using errcode = '42501', message = 'VIEWER_CONNECTION_FORBIDDEN';
    end if;
    update public.live_session_runtime target set idle_after = null where target.session_id = p_session_id;
  elsif p_action = 'disconnect' then
    update public.live_viewer_presence_leases target set state = 'closed', expires_at = statement_timestamp()
    where target.connection_id = p_connection_id and target.session_id = p_session_id
      and target.epoch = p_epoch and target.owner_id = p_owner_id;
  elsif p_action = 'renew' then
    update public.live_viewer_presence_leases lease
    set expires_at = least(statement_timestamp() + interval '45 seconds', grant_row.expires_at, session_row.expires_at)
    from public.viewer_grants grant_row, public.live_sessions session_row
    where lease.connection_id = any(p_connection_ids) and lease.session_id = p_session_id
      and lease.epoch = p_epoch and lease.owner_id = p_owner_id and lease.state = 'connected'
      and lease.expires_at > statement_timestamp()
      and grant_row.id = lease.grant_id and grant_row.session_id = lease.session_id
      and grant_row.user_id = lease.user_id and grant_row.revoked_at is null
      and grant_row.expires_at > statement_timestamp()
      and session_row.id = lease.session_id and session_row.expires_at > statement_timestamp()
      and exists (select 1 from public.live_participants participant_row
        where participant_row.session_id = lease.session_id and participant_row.grant_id = lease.grant_id
          and participant_row.user_id = lease.user_id);
    update public.live_session_runtime target set owner_lease_expires_at = statement_timestamp() + interval '45 seconds'
    where target.session_id = p_session_id;
  elsif p_action = 'ready' then
    if runtime_row.state not in ('waking','active')
      or (runtime_row.state = 'waking' and runtime_row.wake_deadline <= statement_timestamp())
      or not (runtime_json->>'hostSourceReady')::boolean
      or (runtime_json->>'connectedCount')::integer < 1 then
      raise exception using errcode = 'P0001', message = 'MEDIA_NOT_READY';
    end if;
    update public.live_session_runtime target set state = 'active', wake_deadline = null, idle_after = null
    where target.session_id = p_session_id;
    update public.live_media_recording_gaps target set ended_at = statement_timestamp()
    where target.session_id = p_session_id and target.ended_at is null;
  elsif p_action = 'drain' then
    if runtime_row.state not in ('waking','active','draining') then
      raise exception using errcode = 'P0001', message = 'MEDIA_NOT_READY';
    end if;
    if runtime_row.state <> 'draining' and (runtime_json->>'hostSourceReady')::boolean
      and not (runtime_row.state = 'waking' and runtime_row.wake_deadline <= statement_timestamp())
      and ((runtime_json->>'connectedCount')::integer > 0 or runtime_row.idle_after is null
        or runtime_row.idle_after > statement_timestamp()) then
      raise exception using errcode = 'P0001', message = 'MEDIA_DRAIN_NOT_DUE';
    end if;
    update public.live_session_runtime target set state = 'draining' where target.session_id = p_session_id;
  elsif p_action in ('sleep','fail') then
    if p_action = 'sleep' and runtime_row.state not in ('draining','waking','failed')
      and runtime_json->>'state' <> 'ended' then
      raise exception using errcode = 'P0001', message = 'MEDIA_DRAIN_REQUIRED';
    end if;
    update public.live_viewer_presence_leases target set state = 'closed', expires_at = statement_timestamp()
    where target.session_id = p_session_id and target.epoch = p_epoch;
    update public.live_session_runtime target set state = case when p_action = 'fail' then 'failed' else 'sleeping' end,
      owner_id = null, owner_lease_expires_at = null, wake_deadline = null, idle_after = null,
      last_error_code = case when p_action = 'fail' then 'MEDIA_FAILED' else null end
    where target.session_id = p_session_id;
    if runtime_json->>'state' <> 'ended' then
      insert into public.live_media_recording_gaps(session_id, epoch, reason)
      values (p_session_id,p_epoch,case when p_action = 'fail' then 'media_failed'
        when not (runtime_json->>'hostSourceReady')::boolean then 'host_unavailable' else 'no_viewers' end)
      on conflict (session_id) where ended_at is null do nothing;
    end if;
  end if;
  runtime_json := public.get_live_media_runtime_v1(p_session_id);
  if runtime_json->>'state' = 'active' and (runtime_json->>'connectedCount')::integer = 0 then
    update public.live_session_runtime target set idle_after = coalesce(target.idle_after,
      statement_timestamp() + interval '30 seconds') where target.session_id = p_session_id;
  end if;
  update public.live_session_runtime target set updated_at = statement_timestamp()
  where target.session_id = p_session_id;
  return public.get_live_media_runtime_v1(p_session_id);
end;
$$;

create or replace function public.end_live_media_runtime_v1()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.status in ('stopped','failed') or new.archive_deleted_at is not null then
    update public.live_session_runtime target set state='sleeping', owner_id=null,
      owner_lease_expires_at=null, wake_deadline=null, idle_after=null,
      updated_at=statement_timestamp() where target.session_id=new.id;
    update public.live_host_source_leases target set source_ready=false,
      revoked_at=coalesce(target.revoked_at,statement_timestamp()) where target.session_id=new.id;
    update public.live_viewer_presence_leases target set state='closed',
      expires_at=least(target.expires_at,statement_timestamp()) where target.session_id=new.id;
    update public.live_media_recording_gaps target set ended_at=new.ended_at
    where target.session_id=new.id and target.ended_at is null
      and new.ended_at is not null and target.started_at<=new.ended_at;
  end if;
  return new;
end;
$$;
create trigger live_media_runtime_terminal_cleanup
after update of status, ended_at, archive_deleted_at on public.live_sessions
for each row execute function public.end_live_media_runtime_v1();

revoke all on function public.end_live_media_runtime_v1() from public, anon, authenticated, service_role;
revoke all on function public.get_live_media_runtime_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function public.request_live_media_start_v1(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.heartbeat_live_host_source_v1(uuid, text, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.prepare_live_viewer_connection_v1(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.gateway_live_media_v1(uuid, integer, uuid, text, uuid, uuid, text, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.get_live_media_runtime_v1(uuid) to service_role;
grant execute on function public.request_live_media_start_v1(uuid, text, integer) to service_role;
grant execute on function public.heartbeat_live_host_source_v1(uuid, text, uuid, boolean) to service_role;
grant execute on function public.prepare_live_viewer_connection_v1(uuid, uuid, text, uuid) to service_role;
grant execute on function public.gateway_live_media_v1(uuid, integer, uuid, text, uuid, uuid, text, uuid[]) to service_role;


-- supabase/migrations/202608310004_live_media_write_epoch_fences.sql

-- 2026-08-31 fix: Old gateway generations cannot append into a newly resumed call.
-- Fenced entrypoints lock session then runtime before invoking existing persistence.

create or replace function public.assert_live_media_write_epoch_v1(
  p_session_id uuid, p_epoch integer, p_owner_id uuid
)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from public.live_sessions target where target.id = p_session_id
    and target.status = 'live' and target.archive_deleted_at is null
    and target.expires_at > statement_timestamp() for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MEDIA_SESSION_ENDED';
  end if;
  perform 1 from public.live_session_runtime target where target.session_id = p_session_id
    and target.epoch = p_epoch and target.owner_id = p_owner_id
    and target.owner_lease_expires_at > statement_timestamp()
    and target.state in ('active','draining') for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MEDIA_WRITE_EPOCH_CONFLICT';
  end if;
end;
$$;
revoke all on function public.assert_live_media_write_epoch_v1(uuid, integer, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.authorize_live_viewer_grants_v1(p_requests jsonb)
returns table (
  session_id uuid,
  grant_id uuid,
  user_id text,
  language text,
  authorized boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_requests is null or jsonb_typeof(p_requests) <> 'array' then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_INVALID';
  end if;

  if jsonb_array_length(p_requests) = 0 then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_EMPTY';
  end if;

  if jsonb_array_length(p_requests) > 50 then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_TOO_LARGE';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_requests) with ordinality as request_item(value, ordinal)
    where jsonb_typeof(request_item.value) <> 'object'
      or (
        select array_agg(key order by key)
        from jsonb_object_keys(request_item.value) as key
      ) is distinct from array['grant_id', 'language', 'session_id', 'user_id']
  ) then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_SHAPE';
  end if;

  if exists (
    with request_rows as (
      select
        request_item.ordinal,
        request_item.value ->> 'session_id' as session_id_text,
        request_item.value ->> 'grant_id' as grant_id_text,
        request_item.value ->> 'user_id' as user_id,
        request_item.value ->> 'language' as language
      from jsonb_array_elements(p_requests) with ordinality as request_item(value, ordinal)
    )
    select 1
    from request_rows request_row
    where request_row.session_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or request_row.grant_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or request_row.user_id is null
      or length(request_row.user_id) not between 1 and 256
      or public.live_language_valid(request_row.language) is not true
  ) then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_SHAPE';
  end if;

  if exists (
    with request_rows as (
      select
        (request_item.value ->> 'session_id')::uuid as session_id,
        (request_item.value ->> 'grant_id')::uuid as grant_id,
        request_item.value ->> 'user_id' as user_id,
        request_item.value ->> 'language' as language
      from jsonb_array_elements(p_requests) with ordinality as request_item(value, ordinal)
    )
    select 1
    from request_rows request_row
    group by request_row.session_id, request_row.grant_id, request_row.user_id, request_row.language
    having count(*) > 1
  ) then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_DUPLICATE';
  end if;

  return query
  with request_rows as (
    select
      request_item.ordinal,
      (request_item.value ->> 'session_id')::uuid as session_id,
      (request_item.value ->> 'grant_id')::uuid as grant_id,
      request_item.value ->> 'user_id' as user_id,
      request_item.value ->> 'language' as language
    from jsonb_array_elements(p_requests) with ordinality as request_item(value, ordinal)
  ),
  authorized_rows as (
    select
      request_row.ordinal,
      true as authorized
    from request_rows request_row
    join public.live_sessions session_row
      on session_row.id = request_row.session_id
     and session_row.archive_deleted_at is null
     and (session_row.status in ('live', 'paused') or (
       session_row.status = 'preparing' and exists (
         select 1 from public.live_session_runtime runtime
         join public.live_host_source_leases source_row on source_row.session_id = runtime.session_id
         join public.live_viewer_presence_leases lease on lease.session_id = runtime.session_id
           and lease.epoch = runtime.epoch and lease.grant_id = request_row.grant_id
           and lease.user_id = request_row.user_id and lease.state in ('pending','connected')
           and lease.expires_at > statement_timestamp()
         where runtime.session_id = session_row.id and runtime.state = 'waking'
           and runtime.start_requested_at is not null and runtime.wake_deadline > statement_timestamp()
           and source_row.host_id = session_row.host_id and source_row.source_ready
           and source_row.revoked_at is null and source_row.expires_at > statement_timestamp()
       )
     ))
     and session_row.expires_at > statement_timestamp()
     and public.live_languages_canonical(session_row.languages)
     and request_row.language = any(session_row.languages)
    join public.viewer_grants grant_row
      on grant_row.session_id = request_row.session_id
     and grant_row.id = request_row.grant_id
     and grant_row.user_id = request_row.user_id
     and grant_row.revoked_at is null
     and grant_row.expires_at > statement_timestamp()
  )
  select
    request_row.session_id,
    request_row.grant_id,
    request_row.user_id,
    request_row.language,
    coalesce(authorized_row.authorized, false) as authorized
  from request_rows request_row
  left join authorized_rows authorized_row on authorized_row.ordinal = request_row.ordinal
  order by request_row.ordinal;
end;
$$;

create or replace function public.persist_authoritative_live_source_utterance_v1_fenced_v1(
  p_epoch integer,
  p_owner_id uuid,
  p_session_id uuid,
  p_utterance_key text,
  p_raw_text text,
  p_normalized_text text,
  p_source_language text,
  p_speaker_role text,
  p_speaker_label text,
  p_speaker_name text,
  p_speaker_department text,
  p_speaker_job_title text,
  p_participant_id uuid,
  p_source_started_at timestamptz,
  p_source_ended_at timestamptz,
  p_provider_committed_at timestamptz,
  p_stt_provider text,
  p_stt_model text,
  p_translation_model text,
  p_pipeline_config_fingerprint text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  perform public.assert_live_media_write_epoch_v1(p_session_id, p_epoch, p_owner_id);
  return public.persist_authoritative_live_source_utterance_v1(
    p_session_id, p_utterance_key, p_raw_text, p_normalized_text, p_source_language, p_speaker_role, p_speaker_label, p_speaker_name, p_speaker_department, p_speaker_job_title, p_participant_id, p_source_started_at, p_source_ended_at, p_provider_committed_at, p_stt_provider, p_stt_model, p_translation_model, p_pipeline_config_fingerprint
  );
end;
$$;
revoke all on function public.persist_authoritative_live_source_utterance_v1_fenced_v1(integer, uuid, uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.persist_authoritative_live_source_utterance_v1_fenced_v1(integer, uuid, uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text) to service_role;

create or replace function public.persist_live_final_caption_if_active_fenced_v1(
  p_epoch integer,
  p_owner_id uuid,
  p_session_id uuid,
  p_language text,
  p_event jsonb,
  p_seq bigint,
  p_text text,
  p_speaker_label text,
  p_speaker_name text,
  p_source_started_at timestamptz,
  p_source_ended_at timestamptz,
  p_emitted_at timestamptz,
  p_participant_id uuid,
  p_source_text text,
  p_source_language text,
  p_origin text,
  p_utterance_key text,
  p_translation_status text,
  p_authoritative_source_id uuid
)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  perform public.assert_live_media_write_epoch_v1(p_session_id, p_epoch, p_owner_id);
  return public.persist_live_final_caption_if_active(
    p_session_id, p_language, p_event, p_seq, p_text, p_speaker_label, p_speaker_name, p_source_started_at, p_source_ended_at, p_emitted_at, p_participant_id, p_source_text, p_source_language, p_origin, p_utterance_key, p_translation_status, p_authoritative_source_id
  );
end;
$$;
revoke all on function public.persist_live_final_caption_if_active_fenced_v1(integer, uuid, uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.persist_live_final_caption_if_active_fenced_v1(integer, uuid, uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text, uuid) to service_role;

revoke all on function public.authorize_live_viewer_grants_v1(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_live_viewer_grants_v1(jsonb) to service_role;

-- supabase/migrations/202608310005_live_canonical_source_snapshots.sql

-- 2026-08-31 feat: One authoritative original ledger serves every participant language.
-- Existing rows keep NULL observations: no inferred language evidence or identity backfill.

alter table public.live_source_utterances add column if not exists language_observation jsonb;
comment on column public.live_source_utterances.language_observation is
  'Immutable per-utterance language evidence. NULL means the legacy writer recorded no observation.';

create or replace function public.live_source_observation_valid_v1(p_value jsonb, p_source_language text)
returns boolean language plpgsql immutable security definer set search_path = ''
as $$
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object' then return false; end if;
  if (select array_agg(key order by key) from jsonb_object_keys(p_value) key)
    is distinct from array['evidence','languageCode','languages','providerLanguageCode','state'] then return false; end if;
  if jsonb_typeof(p_value->'languages') <> 'array' then return false; end if;
  return coalesce(
    p_value->>'state' in ('single','mixed','unknown')
    and p_value->>'languageCode' = p_source_language
    and p_source_language ~ '^[a-z]{2,3}(-[A-Za-z]{4})?$'
    and p_value->>'evidence' in ('provider-and-script','script','provider','conflict','neutral','insufficient')
    and (p_value->'providerLanguageCode' = 'null'::jsonb or
      (jsonb_typeof(p_value->'providerLanguageCode') = 'string'
        and char_length(p_value->>'providerLanguageCode') <= 35
        and p_value->>'providerLanguageCode' ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'))
    and jsonb_array_length(p_value->'languages') <= 16
    and not exists (select 1 from jsonb_array_elements(p_value->'languages') code
      where jsonb_typeof(code) <> 'string' or (code #>> '{}') !~ '^[a-z]{2,3}(-[A-Za-z]{4})?$')
    and (select count(*) = count(distinct code) from jsonb_array_elements(p_value->'languages') code)
    and case when p_value->>'state' = 'single' then
      p_source_language <> 'und' and p_value->'languages' = jsonb_build_array(p_source_language)
      else p_source_language = 'und' end, false);
end;
$$;
revoke all on function public.live_source_observation_valid_v1(jsonb,text) from public,anon,authenticated,service_role;

do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.live_source_utterances'::regclass
    and conname='live_source_observation_check') then
    alter table public.live_source_utterances add constraint live_source_observation_check
      check (language_observation is null or public.live_source_observation_valid_v1(language_observation,source_language));
  end if;
end; $$;

create or replace function public.persist_authoritative_live_source_utterance_v2(
  p_session_id uuid,
  p_utterance_key text,
  p_raw_text text,
  p_normalized_text text,
  p_source_language text,
  p_speaker_role text,
  p_speaker_label text,
  p_speaker_name text,
  p_speaker_department text,
  p_speaker_job_title text,
  p_participant_id uuid,
  p_source_started_at timestamptz,
  p_source_ended_at timestamptz,
  p_provider_committed_at timestamptz,
  p_stt_provider text,
  p_stt_model text,
  p_translation_model text,
  p_pipeline_config_fingerprint text,
  p_language_observation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_session public.live_sessions%rowtype;
  matched_participant public.live_participants%rowtype;
  existing_source public.live_source_utterances%rowtype;
  inserted_source public.live_source_utterances%rowtype;
  next_source_seq bigint;
  clean_key text;
  clean_normalized_text text;
  clean_source_language text;
  clean_speaker_label text;
  clean_speaker_name text;
  clean_speaker_department text;
  clean_speaker_job_title text;
  clean_stt_model text;
  clean_translation_model text;
begin
  if public.live_source_observation_valid_v1(p_language_observation, p_source_language) is not true then
    raise exception using errcode = '22023', message = 'INVALID_SOURCE_LANGUAGE_OBSERVATION';
  end if;
  clean_key := nullif(btrim(coalesce(p_utterance_key, '')), '');
  clean_normalized_text := nullif(normalize(btrim(coalesce(p_normalized_text, '')), NFC), '');
  clean_source_language := nullif(btrim(coalesce(p_source_language, '')), '');
  clean_speaker_label := nullif(normalize(btrim(coalesce(p_speaker_label, '')), NFC), '');
  clean_speaker_name := nullif(normalize(btrim(coalesce(p_speaker_name, '')), NFC), '');
  clean_speaker_department := nullif(normalize(btrim(coalesce(p_speaker_department, '')), NFC), '');
  clean_speaker_job_title := nullif(normalize(btrim(coalesce(p_speaker_job_title, '')), NFC), '');
  clean_stt_model := nullif(btrim(coalesce(p_stt_model, '')), '');
  clean_translation_model := nullif(btrim(coalesce(p_translation_model, '')), '');

  if p_session_id is null
    or clean_key is null
    or char_length(clean_key) > 200
    or octet_length(clean_key) > 600
    or clean_key ~ '[[:cntrl:]<>]'
    or p_raw_text is null
    or char_length(btrim(p_raw_text)) not between 1 and 8000
    or octet_length(p_raw_text) > 24000
    or clean_normalized_text is null
    or char_length(clean_normalized_text) > 8000
    or octet_length(clean_normalized_text) > 24000
    or clean_source_language is null
    or clean_source_language !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
    or p_speaker_role not in ('host', 'participant', 'unknown')
    or (p_speaker_role = 'participant') <> (p_participant_id is not null)
    or (clean_speaker_label is not null and (
      char_length(clean_speaker_label) > 80 or clean_speaker_label ~ '[[:cntrl:]<>]'
    ))
    or (clean_speaker_name is not null and (
      char_length(clean_speaker_name) > 40 or clean_speaker_name ~ '[[:cntrl:]<>]'
    ))
    or (clean_speaker_department is not null and (
      char_length(clean_speaker_department) > 80 or clean_speaker_department ~ '[[:cntrl:]<>]'
    ))
    or (clean_speaker_job_title is not null and (
      char_length(clean_speaker_job_title) > 100 or clean_speaker_job_title ~ '[[:cntrl:]<>]'
    ))
    or p_source_ended_at is null
    or p_provider_committed_at is null
    or p_provider_committed_at < p_source_ended_at
    or (p_source_started_at is not null and (
      p_source_started_at > p_source_ended_at
      or p_source_ended_at - p_source_started_at > interval '1 hour'
    ))
    or p_stt_provider is null
    or p_stt_provider !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    or (clean_stt_model is not null and (
      char_length(clean_stt_model) > 120 or clean_stt_model ~ '[[:cntrl:]<>]'
    ))
    or (clean_translation_model is not null and (
      char_length(clean_translation_model) > 120 or clean_translation_model ~ '[[:cntrl:]<>]'
    ))
    or (p_pipeline_config_fingerprint is not null
      and p_pipeline_config_fingerprint !~ '^sha256:[0-9a-f]{64}$')
  then
    raise exception using errcode = '22023', message = 'INVALID_AUTHORITATIVE_SOURCE_INPUT';
  end if;

  select * into locked_session
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.status = 'live'
    and session_row.expires_at > statement_timestamp()
    and session_row.archive_deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'SESSION_NOT_LIVE';
  end if;

  if p_participant_id is not null then
    select * into matched_participant
    from public.live_participants participant_row
    where participant_row.id = p_participant_id
      and participant_row.session_id = p_session_id;
    if not found then
      raise exception using errcode = '42501', message = 'PARTICIPANT_SESSION_MISMATCH';
    end if;
    clean_speaker_name := matched_participant.display_name;
    clean_speaker_department := matched_participant.department;
    clean_speaker_job_title := matched_participant.job_title;
  end if;

  select * into existing_source
  from public.live_source_utterances source_row
  where source_row.session_id = p_session_id
    and source_row.utterance_key = clean_key;
  if found then
    if existing_source.language_observation is distinct from p_language_observation
      or existing_source.raw_text is distinct from p_raw_text
      or existing_source.normalized_text is distinct from clean_normalized_text
      or existing_source.source_language is distinct from clean_source_language
      or existing_source.speaker_role is distinct from p_speaker_role
      or existing_source.speaker_label is distinct from clean_speaker_label
      or existing_source.speaker_name is distinct from clean_speaker_name
      or existing_source.speaker_department is distinct from clean_speaker_department
      or existing_source.speaker_job_title is distinct from clean_speaker_job_title
      or existing_source.participant_id is distinct from p_participant_id
      or existing_source.source_started_at is distinct from p_source_started_at
      or existing_source.source_ended_at is distinct from p_source_ended_at
      or existing_source.provider_committed_at is distinct from p_provider_committed_at
      or existing_source.stt_provider is distinct from p_stt_provider
      or existing_source.stt_model is distinct from clean_stt_model
      or existing_source.translation_model is distinct from clean_translation_model
      or existing_source.pipeline_config_fingerprint is distinct from p_pipeline_config_fingerprint
      or existing_source.glossary_fingerprint is distinct from locked_session.pinned_glossary_fingerprint
    then
      raise exception using errcode = 'P0001', message = 'SOURCE_UTTERANCE_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'ok', true,
      'sourceUtteranceId', existing_source.id,
      'sourceSeq', existing_source.source_seq,
      'idempotent', true
    );
  end if;

  select coalesce(max(source_row.source_seq), 0) + 1
  into next_source_seq
  from public.live_source_utterances source_row
  where source_row.session_id = p_session_id;

  insert into public.live_source_utterances (
    language_observation, session_id, source_seq, utterance_key, raw_text, normalized_text,
    source_language, speaker_role, speaker_label, speaker_name,
    speaker_department, speaker_job_title, participant_id,
    source_started_at, source_ended_at, provider_committed_at,
    stt_provider, stt_model, translation_model, pipeline_config_fingerprint,
    glossary_fingerprint, created_at
  ) values (
    p_language_observation, p_session_id, next_source_seq, clean_key, p_raw_text, clean_normalized_text,
    clean_source_language, p_speaker_role, clean_speaker_label, clean_speaker_name,
    clean_speaker_department, clean_speaker_job_title, p_participant_id,
    p_source_started_at, p_source_ended_at, p_provider_committed_at,
    p_stt_provider, clean_stt_model, clean_translation_model,
    p_pipeline_config_fingerprint, locked_session.pinned_glossary_fingerprint,
    statement_timestamp()
  ) returning * into inserted_source;

  return jsonb_build_object(
    'ok', true,
    'sourceUtteranceId', inserted_source.id,
    'sourceSeq', inserted_source.source_seq,
    'idempotent', false
  );
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'SOURCE_UTTERANCE_IDEMPOTENCY_CONFLICT';
end;
$$;

revoke all on function public.persist_authoritative_live_source_utterance_v2(uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb) from public,anon,authenticated,service_role;
grant execute on function public.persist_authoritative_live_source_utterance_v2(uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb) to service_role;

create or replace function public.persist_authoritative_live_source_utterance_v2_fenced_v1(
  p_epoch integer,
  p_owner_id uuid,
  p_session_id uuid,
  p_utterance_key text,
  p_raw_text text,
  p_normalized_text text,
  p_source_language text,
  p_speaker_role text,
  p_speaker_label text,
  p_speaker_name text,
  p_speaker_department text,
  p_speaker_job_title text,
  p_participant_id uuid,
  p_source_started_at timestamptz,
  p_source_ended_at timestamptz,
  p_provider_committed_at timestamptz,
  p_stt_provider text,
  p_stt_model text,
  p_translation_model text,
  p_pipeline_config_fingerprint text,
  p_language_observation jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  perform public.assert_live_media_write_epoch_v1(p_session_id, p_epoch, p_owner_id);
  return public.persist_authoritative_live_source_utterance_v2(
    p_session_id, p_utterance_key, p_raw_text, p_normalized_text, p_source_language, p_speaker_role, p_speaker_label, p_speaker_name, p_speaker_department, p_speaker_job_title, p_participant_id, p_source_started_at, p_source_ended_at, p_provider_committed_at, p_stt_provider, p_stt_model, p_translation_model, p_pipeline_config_fingerprint, p_language_observation
  );
end;
$$;

revoke all on function public.persist_authoritative_live_source_utterance_v2_fenced_v1(integer,uuid,uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb) from public,anon,authenticated,service_role;
grant execute on function public.persist_authoritative_live_source_utterance_v2_fenced_v1(integer,uuid,uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb) to service_role;

create or replace function public.read_participant_live_source_snapshot_v1(
  p_session_id uuid, p_user_id text, p_grant_id uuid default null,
  p_after_source_seq bigint default 0, p_limit integer default 200
)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  records_expire_at timestamptz;
  source_rows jsonb;
  last_source_seq bigint;
  next_source_seq bigint;
  has_next boolean;
  estimated_bytes bigint;
begin
  if p_after_source_seq is null or p_after_source_seq < 0 or p_after_source_seq > 9007199254740991
    or p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception using errcode = '22023', message = 'INVALID_SOURCE_SNAPSHOT_INPUT';
  end if;
  select * into session_row from public.live_sessions target
    where target.id=p_session_id and target.archive_deleted_at is null;
  if not found or not exists(select 1 from public.live_participants member
    where member.session_id=p_session_id and member.user_id=p_user_id and member.records_revoked_at is null) then
    raise exception using errcode='42501',message='SOURCE_FORBIDDEN';
  end if;
  if session_row.status in ('stopped','failed') then
    if session_row.ended_at is null then
      raise exception using errcode='P0001',message='RECAP_NOT_READY';
    end if;
    records_expire_at := session_row.ended_at + interval '6 hours';
    if records_expire_at <= statement_timestamp() then
      raise exception using errcode='P0001',message='RECAP_EXPIRED';
    end if;
  elsif session_row.status in ('preparing','live','paused') and session_row.expires_at > statement_timestamp() then
    if not exists(select 1 from public.viewer_grants grant_row where grant_row.id=p_grant_id
      and grant_row.session_id=p_session_id and grant_row.user_id=p_user_id
      and grant_row.revoked_at is null and grant_row.expires_at > statement_timestamp()) then
      raise exception using errcode='42501',message='SOURCE_FORBIDDEN';
    end if;
  else
    raise exception using errcode='42501',message='SOURCE_FORBIDDEN';
  end if;

  select coalesce(max(source.source_seq),0) into last_source_seq
    from public.live_source_utterances source where source.session_id=p_session_id;
  if last_source_seq > 9007199254740991 then
    raise exception using errcode='P0001',message='SOURCE_SNAPSHOT_TOO_LARGE';
  end if;
  select coalesce(sum(octet_length(to_jsonb(coalesce(correction.corrected_text,source.normalized_text))::text)+2048),0)
    into estimated_bytes from (select * from public.live_source_utterances target
      where target.session_id=p_session_id and target.source_seq>p_after_source_seq
      order by target.source_seq limit p_limit) source
    left join lateral (select row.corrected_text from public.live_source_utterance_corrections row
      where row.source_utterance_id=source.id and row.session_id=p_session_id order by row.revision desc limit 1) correction on true;
  if estimated_bytes > 12*1024*1024 then
    raise exception using errcode='P0001',message='SOURCE_SNAPSHOT_TOO_LARGE';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'type','source','sessionId',source.session_id,'sourceUtteranceId',source.id,'sourceSeq',source.source_seq,
    'utteranceKey',source.utterance_key,'text',coalesce(correction.corrected_text,source.normalized_text),
    'sourceLanguage',source.source_language,'languageObservation',source.language_observation,
    'speaker',jsonb_build_object('role',source.speaker_role,'label',case source.speaker_role
      when 'host' then '발표자' when 'participant' then '참여자' else '화자 미상' end),
    'isFinal',true,'sourceStartedAt',source.source_started_at,'sourceEndedAt',source.source_ended_at,
    'emittedAt',source.provider_committed_at
  ) order by source.source_seq),'[]'::jsonb),max(source.source_seq) into source_rows,next_source_seq
    from (select * from public.live_source_utterances target
      where target.session_id=p_session_id and target.source_seq>p_after_source_seq
      order by target.source_seq limit p_limit) source
    left join lateral (select row.corrected_text from public.live_source_utterance_corrections row
      where row.source_utterance_id=source.id and row.session_id=p_session_id order by row.revision desc limit 1) correction on true;
  has_next := next_source_seq is not null and next_source_seq < last_source_seq;
  return jsonb_build_object('sessionId',p_session_id,'sources',source_rows,'lastSourceSeq',last_source_seq,
    'hasNextPage',has_next,'nextAfterSourceSeq',case when has_next then next_source_seq else null end,
    'recordsExpiresAt',records_expire_at);
end;
$$;
revoke all on function public.read_participant_live_source_snapshot_v1(uuid,text,uuid,bigint,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.read_participant_live_source_snapshot_v1(uuid,text,uuid,bigint,integer) to service_role;

-- 2026-08-31 feat: Caption recovery joins language evidence through a bounded, private source projection.
create or replace function public.read_live_caption_source_observations_v1(p_session_id uuid, p_source_ids uuid[])
returns table(source_utterance_id uuid,source_seq bigint,language_observation jsonb)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_session_id is null or p_source_ids is null or cardinality(p_source_ids) > 500 then
    raise exception using errcode='22023',message='INVALID_SOURCE_SNAPSHOT_INPUT';
  end if;
  return query select source.id,source.source_seq,source.language_observation
    from public.live_source_utterances source join public.live_sessions session on session.id=source.session_id
    where source.session_id=p_session_id and source.id=any(p_source_ids) and session.archive_deleted_at is null
    order by source.source_seq;
end;
$$;
revoke all on function public.read_live_caption_source_observations_v1(uuid,uuid[])
  from public,anon,authenticated,service_role;
grant execute on function public.read_live_caption_source_observations_v1(uuid,uuid[]) to service_role;

-- supabase/migrations/202608310006_live_glossary_coalesce_repair.sql

-- 2026-08-31 fix: COALESCE is SQL syntax, not a pg_catalog function.
-- Both released glossary RPCs raised 42883 at runtime. Replace only the five
-- invalid qualifications; retain signatures, locks, ownership, limits and ACLs.
-- Apply after 202608270001. No stored rows change during this migration.
-- Keep this repair when rolling back application callers: restoring the old
-- bodies would restore the start-blocking error.

create or replace function public.replace_live_session_glossary_pins_v2(
  p_session_id uuid,
  p_host_id text,
  p_expected_session_version integer,
  p_glossaries jsonb
)
returns table (
  session_id uuid,
  version integer,
  glossaries jsonb,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  session_row public.live_sessions%rowtype;
  updated_session public.live_sessions%rowtype;
  glossary_item jsonb;
  source_kind_value text;
  source_id_value text;
  document_version_value integer;
  selected_version public.host_glossary_preset_versions%rowtype;
  seen_sources text[] := array[]::text[];
  source_key text;
  glossary_count integer;
  glossary_ordinal integer;
  legacy_preset_id uuid;
  legacy_document_version integer;
  legacy_fingerprint text;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if p_session_id is null
    or p_expected_session_version is null
    or p_expected_session_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or p_glossaries is null
    or pg_catalog.jsonb_typeof(p_glossaries) <> 'array'
    or pg_catalog.jsonb_array_length(p_glossaries) not between 1 and 5
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
  end if;

  select * into session_row
  from public.live_sessions as candidate_session
  where candidate_session.id = p_session_id
    and candidate_session.host_id = clean_host_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_NOT_FOUND';
  end if;
  if session_row.version <> p_expected_session_version then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_VERSION_CONFLICT';
  end if;
  if session_row.status <> 'preparing' then
    raise exception using errcode = 'P0001', message = 'ACTIVE_SESSION_GLOSSARY_IMMUTABLE';
  end if;

  delete from public.live_session_glossary_pins as existing_pin
  where existing_pin.session_id = p_session_id;

  glossary_count := pg_catalog.jsonb_array_length(p_glossaries);
  for glossary_ordinal in 1..glossary_count loop
    glossary_item := p_glossaries -> (glossary_ordinal - 1);
    if pg_catalog.jsonb_typeof(glossary_item) <> 'object'
      or glossary_item - array['source_kind', 'source_id', 'document_version'] <> '{}'::jsonb
      or not (glossary_item ?& array['source_kind', 'source_id', 'document_version'])
      or pg_catalog.jsonb_typeof(glossary_item -> 'source_kind') <> 'string'
      or pg_catalog.jsonb_typeof(glossary_item -> 'source_id') <> 'string'
      or pg_catalog.jsonb_typeof(glossary_item -> 'document_version') <> 'number'
      or (glossary_item ->> 'document_version') !~ '^[1-9][0-9]{0,9}$'
    then
      raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
    end if;

    source_kind_value := glossary_item ->> 'source_kind';
    source_id_value := glossary_item ->> 'source_id';
    if (glossary_item ->> 'document_version')::bigint > 2147483647 then
      raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
    end if;
    document_version_value := (glossary_item ->> 'document_version')::integer;
    source_key := source_kind_value || ':' || case
      when source_kind_value = 'host' then pg_catalog.lower(source_id_value)
      else source_id_value
    end;
    if source_key = any(seen_sources) then
      raise exception using errcode = '22023', message = 'DUPLICATE_LIVE_GLOSSARY_PIN';
    end if;
    seen_sources := pg_catalog.array_append(seen_sources, source_key);

    if source_kind_value = 'builtin' then
      if source_id_value not in (
        'common_business', 'ai_ax', 'commercial_real_estate', 'hospitality',
        'fnb_retail', 'proper_nouns', 'ko_ja_idioms'
      ) or document_version_value <> 1 then
        raise exception using errcode = '22023', message = 'INVALID_BUILTIN_GLOSSARY';
      end if;
      insert into public.live_session_glossary_pins (
        session_id, ordinal, source_kind, builtin_id, builtin_catalog_version
      ) values (
        p_session_id, glossary_ordinal, 'builtin', source_id_value, 1
      );
    elsif source_kind_value = 'host' then
      if source_id_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
      end if;
      select version_row.* into selected_version
      from public.host_glossary_presets as preset_row
      join public.host_glossary_preset_versions as version_row
        on version_row.preset_id = preset_row.id
       and version_row.host_id = preset_row.host_id
       and version_row.version = preset_row.active_document_version
       and version_row.fingerprint = preset_row.active_document_fingerprint
      where preset_row.id = source_id_value::uuid
        and preset_row.host_id = clean_host_id
        and preset_row.active_document_version = document_version_value;
      if not found then
        raise exception using errcode = 'P0001', message = 'ACTIVE_GLOSSARY_DOCUMENT_VERSION_NOT_FOUND';
      end if;
      insert into public.live_session_glossary_pins (
        session_id, ordinal, source_kind, host_preset_id,
        host_document_version, host_document_fingerprint
      ) values (
        p_session_id, glossary_ordinal, 'host', source_id_value::uuid,
        selected_version.version, selected_version.fingerprint
      );
      if glossary_count = 1 then
        legacy_preset_id := source_id_value::uuid;
        legacy_document_version := selected_version.version;
        legacy_fingerprint := selected_version.fingerprint;
      end if;
    else
      raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
    end if;
  end loop;

  update public.live_sessions as target_session
  set pinned_glossary_preset_id = legacy_preset_id,
      pinned_glossary_version = legacy_document_version,
      pinned_glossary_fingerprint = legacy_fingerprint,
      version = target_session.version + 1,
      updated_at = statement_timestamp()
  where target_session.id = p_session_id
    and target_session.host_id = clean_host_id
    and target_session.version = p_expected_session_version
  returning target_session.* into updated_session;

  return query
  select
    updated_session.id,
    updated_session.version,
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ordinal', pin_row.ordinal,
        'source_kind', pin_row.source_kind,
        'source_id', coalesce(pin_row.builtin_id, pin_row.host_preset_id::text),
        'document_version', coalesce(pin_row.builtin_catalog_version, pin_row.host_document_version),
        'fingerprint', pin_row.host_document_fingerprint
      ) order by pin_row.ordinal
    ),
    updated_session.updated_at
  from public.live_session_glossary_pins as pin_row
  where pin_row.session_id = p_session_id;
end;
$$;

create or replace function public.read_live_session_pinned_glossaries_v2(
  p_live_session_id uuid
)
returns table (
  session_id uuid,
  ordinal integer,
  source_kind text,
  source_id text,
  document_version integer,
  fingerprint text,
  glossary_document jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
  pin_count integer;
  valid_host_pin_count integer;
begin
  if p_live_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_PINNED_GLOSSARY_INPUT';
  end if;
  select * into session_row
  from public.live_sessions as candidate_session
  where candidate_session.id = p_live_session_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_NOT_FOUND';
  end if;

  select count(*)::integer into pin_count
  from public.live_session_glossary_pins as pin_row
  where pin_row.session_id = p_live_session_id;

  if pin_count > 0 then
    select count(*)::integer into valid_host_pin_count
    from public.live_session_glossary_pins as pin_row
    left join public.host_glossary_preset_versions as version_row
      on version_row.preset_id = pin_row.host_preset_id
     and version_row.version = pin_row.host_document_version
     and version_row.fingerprint = pin_row.host_document_fingerprint
     and version_row.host_id = session_row.host_id
    where pin_row.session_id = p_live_session_id
      and (pin_row.source_kind = 'builtin' or version_row.id is not null);
    if valid_host_pin_count <> pin_count then
      raise exception using errcode = 'P0001', message = 'PINNED_GLOSSARY_VERSION_MISMATCH';
    end if;

    return query
    select
      pin_row.session_id,
      pin_row.ordinal,
      pin_row.source_kind,
      coalesce(pin_row.builtin_id, pin_row.host_preset_id::text),
      coalesce(pin_row.builtin_catalog_version, pin_row.host_document_version),
      pin_row.host_document_fingerprint,
      version_row.document
    from public.live_session_glossary_pins as pin_row
    left join public.host_glossary_preset_versions as version_row
      on version_row.preset_id = pin_row.host_preset_id
     and version_row.version = pin_row.host_document_version
     and version_row.fingerprint = pin_row.host_document_fingerprint
     and version_row.host_id = session_row.host_id
    where pin_row.session_id = p_live_session_id
    order by pin_row.ordinal;
    return;
  end if;

  -- Legacy singular fallback remains until its columns complete a deprecation cycle.
  if session_row.pinned_glossary_preset_id is not null
    and session_row.pinned_glossary_version is not null
    and session_row.pinned_glossary_fingerprint is not null
  then
    return query
    select
      session_row.id,
      1,
      'host'::text,
      session_row.pinned_glossary_preset_id::text,
      session_row.pinned_glossary_version,
      session_row.pinned_glossary_fingerprint,
      version_row.document
    from public.host_glossary_preset_versions as version_row
    where version_row.preset_id = session_row.pinned_glossary_preset_id
      and version_row.version = session_row.pinned_glossary_version
      and version_row.fingerprint = session_row.pinned_glossary_fingerprint
      and version_row.host_id = session_row.host_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'PINNED_GLOSSARY_VERSION_MISMATCH';
    end if;
  end if;
end;
$$;

revoke all on function public.replace_live_session_glossary_pins_v2(uuid, text, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.read_live_session_pinned_glossaries_v2(uuid)
  from public, anon, authenticated;

grant execute on function public.replace_live_session_glossary_pins_v2(uuid, text, integer, jsonb)
  to service_role;
grant execute on function public.read_live_session_pinned_glossaries_v2(uuid)
  to service_role;

-- supabase/migrations/202609020002_auth_profiles_desktop_codes.sql

-- 2026-09-02 auth: Supabase Auth becomes the identity provider. Profiles carry the
-- approval state and the host_id string that the app session cookie will carry, so
-- every existing host_id ownership query keeps working unchanged.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','disabled')),
  role text not null default 'host' check (role in ('host','admin')),
  host_id text not null unique check (host_id ~ '^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$'),
  approved_at timestamptz,
  approved_by uuid references public.profiles(id),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists profiles_status_created_idx on public.profiles (status, created_at desc);

create table if not exists public.profile_events (
  id bigserial primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id),
  action text not null check (action in ('signup','approve','reject','disable','enable','set_role','bootstrap_admin','engine_defaults')),
  reason text check (reason is null or char_length(reason) <= 200),
  payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists profile_events_profile_idx on public.profile_events (profile_id, id desc);

create table if not exists public.desktop_login_codes (
  code_hash bytea primary key check (octet_length(code_hash) = 32),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  state text not null check (state ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.profile_events enable row level security;
alter table public.desktop_login_codes enable row level security;
revoke all on table public.profiles, public.profile_events, public.desktop_login_codes from anon, authenticated;
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles for select to authenticated using ((select auth.uid()) = id);

create or replace function public.upsert_profile_on_login_v1(
  p_user_id uuid, p_email text, p_display_name text, p_bootstrap boolean, p_legacy_host_id text
)
returns table (id uuid, email text, display_name text, status text, role text, host_id text, created boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  normalized_email text := lower(btrim(coalesce(p_email, '')));
  trimmed_name text := nullif(left(btrim(coalesce(p_display_name, '')), 80), '');
  existing public.profiles%rowtype;
  chosen_host_id text;
begin
  if p_user_id is null or normalized_email = '' or char_length(normalized_email) > 254 then
    raise exception 'PROFILE_INPUT_INVALID' using errcode = '22023';
  end if;
  select * into existing from public.profiles p where p.id = p_user_id for update;
  if found then
    update public.profiles p
      set email = normalized_email,
          display_name = coalesce(trimmed_name, p.display_name),
          last_login_at = statement_timestamp(),
          updated_at = statement_timestamp()
      where p.id = p_user_id;
    return query select p.id, p.email, p.display_name, p.status, p.role, p.host_id, false
      from public.profiles p where p.id = p_user_id;
    return;
  end if;
  chosen_host_id := p_user_id::text;
  if coalesce(p_bootstrap, false) and p_legacy_host_id is not null
     and p_legacy_host_id ~ '^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$'
     and not exists (select 1 from public.profiles p where p.host_id = p_legacy_host_id) then
    chosen_host_id := p_legacy_host_id;
  end if;
  insert into public.profiles (id, email, display_name, status, role, host_id, approved_at, last_login_at)
  values (
    p_user_id, normalized_email, trimmed_name,
    case when coalesce(p_bootstrap, false) then 'approved' else 'pending' end,
    case when coalesce(p_bootstrap, false) then 'admin' else 'host' end,
    chosen_host_id,
    case when coalesce(p_bootstrap, false) then statement_timestamp() else null end,
    statement_timestamp()
  );
  insert into public.profile_events (profile_id, actor_id, action, payload)
  values (p_user_id, case when coalesce(p_bootstrap, false) then p_user_id else null end,
          case when coalesce(p_bootstrap, false) then 'bootstrap_admin' else 'signup' end,
          jsonb_build_object('host_id', chosen_host_id));
  return query select p.id, p.email, p.display_name, p.status, p.role, p.host_id, true
    from public.profiles p where p.id = p_user_id;
end;
$$;
revoke all on function public.upsert_profile_on_login_v1(uuid,text,text,boolean,text) from public, anon, authenticated, service_role;
grant execute on function public.upsert_profile_on_login_v1(uuid,text,text,boolean,text) to service_role;

create or replace function public.read_profile_by_host_id_v1(p_host_id text)
returns table (id uuid, email text, display_name text, status text, role text, host_id text)
language sql security definer set search_path = '' stable
as $$
  select p.id, p.email, p.display_name, p.status, p.role, p.host_id
  from public.profiles p where p.host_id = p_host_id limit 1;
$$;
revoke all on function public.read_profile_by_host_id_v1(text) from public, anon, authenticated, service_role;
grant execute on function public.read_profile_by_host_id_v1(text) to service_role;

create or replace function public.issue_desktop_login_code_v1(
  p_code_hash bytea, p_profile_id uuid, p_state text, p_expires_at timestamptz
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_code_hash is null or octet_length(p_code_hash) <> 32 or p_profile_id is null
     or p_state is null or p_state !~ '^[A-Za-z0-9_-]{43}$'
     or p_expires_at is null or p_expires_at > statement_timestamp() + interval '5 minutes' then
    return false;
  end if;
  delete from public.desktop_login_codes d where d.expires_at < statement_timestamp() - interval '10 minutes';
  insert into public.desktop_login_codes (code_hash, profile_id, state, expires_at)
  values (p_code_hash, p_profile_id, p_state, p_expires_at)
  on conflict (code_hash) do nothing;
  return found;
end;
$$;
revoke all on function public.issue_desktop_login_code_v1(bytea,uuid,text,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.issue_desktop_login_code_v1(bytea,uuid,text,timestamptz) to service_role;

create or replace function public.consume_desktop_login_code_v1(p_code_hash bytea, p_state text)
returns table (profile_id uuid, host_id text, status text)
language plpgsql security definer set search_path = ''
as $$
declare
  code_row public.desktop_login_codes%rowtype;
begin
  if p_code_hash is null or p_state is null then return; end if;
  select * into code_row from public.desktop_login_codes d where d.code_hash = p_code_hash for update;
  if not found then return; end if;
  if code_row.expires_at <= statement_timestamp() then
    delete from public.desktop_login_codes d where d.code_hash = p_code_hash;
    return;
  end if;
  if code_row.consumed_at is not null or code_row.state <> p_state then return; end if;
  update public.desktop_login_codes d set consumed_at = statement_timestamp() where d.code_hash = p_code_hash;
  return query select p.id, p.host_id, p.status from public.profiles p where p.id = code_row.profile_id;
end;
$$;
revoke all on function public.consume_desktop_login_code_v1(bytea,text) from public, anon, authenticated, service_role;
grant execute on function public.consume_desktop_login_code_v1(bytea,text) to service_role;

-- supabase/migrations/202609020003_console_rpcs.sql

-- 2026-09-02 console: admin-only RPCs for signup approval, roles, session aggregates,
-- global engine defaults, and the legacy password-login switch. All guards live here.
create table if not exists public.engine_defaults (
  id smallint primary key default 1 check (id = 1),
  engine jsonb not null,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
create table if not exists public.console_settings (
  id smallint primary key default 1 check (id = 1),
  legacy_password_login_enabled boolean not null default true,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
insert into public.console_settings (id) values (1) on conflict (id) do nothing;
alter table public.engine_defaults enable row level security;
alter table public.console_settings enable row level security;
revoke all on table public.engine_defaults, public.console_settings from anon, authenticated;

create or replace function public.assert_console_admin_v1(p_actor_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_actor_id is null or not exists (select 1 from public.profiles p where p.id = p_actor_id and p.status = 'approved' and p.role = 'admin') then
    raise exception 'ACTOR_NOT_ADMIN' using errcode = '42501';
  end if;
end; $$;
revoke all on function public.assert_console_admin_v1(uuid) from public, anon, authenticated, service_role;
grant execute on function public.assert_console_admin_v1(uuid) to service_role;

create or replace function public.list_profiles_admin_v1(p_status text, p_limit integer, p_before timestamptz)
returns table (id uuid, email text, display_name text, status text, role text, host_id text, created_at timestamptz, last_login_at timestamptz, approved_at timestamptz)
language sql security definer set search_path = '' stable as $$
  select p.id, p.email, p.display_name, p.status, p.role, p.host_id, p.created_at, p.last_login_at, p.approved_at
  from public.profiles p
  where (p_status is null or p.status = p_status) and (p_before is null or p.created_at < p_before)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;
revoke all on function public.list_profiles_admin_v1(text,integer,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.list_profiles_admin_v1(text,integer,timestamptz) to service_role;

create or replace function public.count_pending_profiles_v1() returns integer
language sql security definer set search_path = '' stable as $$
  select count(*)::integer from public.profiles p where p.status = 'pending';
$$;
revoke all on function public.count_pending_profiles_v1() from public, anon, authenticated, service_role;
grant execute on function public.count_pending_profiles_v1() to service_role;

create or replace function public.set_profile_status_v1(p_actor_id uuid, p_profile_id uuid, p_status text, p_reason text)
returns table (id uuid, status text, role text)
language plpgsql security definer set search_path = '' as $$
declare target public.profiles%rowtype; action_name text;
begin
  perform public.assert_console_admin_v1(p_actor_id);
  if p_actor_id = p_profile_id then raise exception 'SELF_CHANGE_FORBIDDEN' using errcode = '42501'; end if;
  select * into target from public.profiles p where p.id = p_profile_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not ((target.status = 'pending' and p_status in ('approved','rejected'))
       or (target.status = 'approved' and p_status = 'disabled')
       or (target.status = 'disabled' and p_status = 'approved')
       or (target.status = 'rejected' and p_status = 'approved')) then
    raise exception 'INVALID_TRANSITION' using errcode = '22023';
  end if;
  if target.role = 'admin' and target.status = 'approved' and p_status <> 'approved'
     and (select count(*) from public.profiles p where p.role = 'admin' and p.status = 'approved') <= 1 then
    raise exception 'LAST_ADMIN_PROTECTED' using errcode = '42501';
  end if;
  action_name := case p_status when 'approved' then (case when target.status = 'disabled' then 'enable' else 'approve' end)
                               when 'rejected' then 'reject' when 'disabled' then 'disable' end;
  update public.profiles p set status = p_status,
    approved_at = case when p_status = 'approved' then statement_timestamp() else p.approved_at end,
    approved_by = case when p_status = 'approved' then p_actor_id else p.approved_by end,
    updated_at = statement_timestamp()
  where p.id = p_profile_id;
  insert into public.profile_events (profile_id, actor_id, action, reason) values (p_profile_id, p_actor_id, action_name, nullif(left(btrim(coalesce(p_reason,'')),200), ''));
  return query select p.id, p.status, p.role from public.profiles p where p.id = p_profile_id;
end; $$;
revoke all on function public.set_profile_status_v1(uuid,uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.set_profile_status_v1(uuid,uuid,text,text) to service_role;

create or replace function public.set_profile_role_v1(p_actor_id uuid, p_profile_id uuid, p_role text)
returns table (id uuid, status text, role text)
language plpgsql security definer set search_path = '' as $$
declare target public.profiles%rowtype;
begin
  perform public.assert_console_admin_v1(p_actor_id);
  if p_actor_id = p_profile_id then raise exception 'SELF_CHANGE_FORBIDDEN' using errcode = '42501'; end if;
  if p_role not in ('host','admin') then raise exception 'INVALID_ROLE' using errcode = '22023'; end if;
  select * into target from public.profiles p where p.id = p_profile_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0002'; end if;
  if target.role = 'admin' and p_role = 'host' and target.status = 'approved'
     and (select count(*) from public.profiles p where p.role = 'admin' and p.status = 'approved') <= 1 then
    raise exception 'LAST_ADMIN_PROTECTED' using errcode = '42501';
  end if;
  update public.profiles p set role = p_role, updated_at = statement_timestamp() where p.id = p_profile_id;
  insert into public.profile_events (profile_id, actor_id, action, payload) values (p_profile_id, p_actor_id, 'set_role', jsonb_build_object('from', target.role, 'to', p_role));
  return query select p.id, p.status, p.role from public.profiles p where p.id = p_profile_id;
end; $$;
revoke all on function public.set_profile_role_v1(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.set_profile_role_v1(uuid,uuid,text) to service_role;

create or replace function public.list_sessions_admin_v1(p_since timestamptz, p_limit integer)
returns table (id uuid, title text, host_id text, host_email text, mode text, status text, languages text[], created_at timestamptz, ended_at timestamptz,
               utterance_count bigint, participant_count bigint, summary_status text)
language sql security definer set search_path = '' stable as $$
  select s.id, s.title, s.host_id, p.email, s.mode, s.status, s.languages, s.created_at, s.ended_at,
    (select count(*) from public.live_utterances u where u.session_id = s.id),
    (select count(distinct lp.user_id) from public.live_participants lp where lp.session_id = s.id),
    (select case when bool_or(j.status = 'failed') then 'failed' when bool_and(j.status = 'succeeded') then 'succeeded'
                 when count(*) = 0 then null else 'running' end
       from public.live_summary_generation_jobs j where j.session_id = s.id)
  from public.live_sessions s
  left join public.profiles p on p.host_id = s.host_id
  where s.archive_deleted_at is null and (p_since is null or s.created_at >= p_since)
  order by s.created_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;
revoke all on function public.list_sessions_admin_v1(timestamptz,integer) from public, anon, authenticated, service_role;
grant execute on function public.list_sessions_admin_v1(timestamptz,integer) to service_role;

create or replace function public.read_console_settings_v1()
returns table (legacy_password_login_enabled boolean, engine jsonb, engine_updated_at timestamptz, engine_updated_by_email text)
language sql security definer set search_path = '' stable as $$
  select c.legacy_password_login_enabled, e.engine, e.updated_at, p.email
  from public.console_settings c
  left join public.engine_defaults e on e.id = 1
  left join public.profiles p on p.id = e.updated_by
  where c.id = 1;
$$;
revoke all on function public.read_console_settings_v1() from public, anon, authenticated, service_role;
grant execute on function public.read_console_settings_v1() to service_role;

create or replace function public.set_engine_defaults_v1(p_actor_id uuid, p_engine jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_console_admin_v1(p_actor_id);
  if p_engine is null or jsonb_typeof(p_engine) <> 'object' or octet_length(p_engine::text) > 4000 then raise exception 'ENGINE_INVALID' using errcode = '22023'; end if;
  insert into public.engine_defaults (id, engine, updated_by, updated_at) values (1, p_engine, p_actor_id, statement_timestamp())
  on conflict (id) do update set engine = excluded.engine, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  insert into public.profile_events (profile_id, actor_id, action, payload) values (p_actor_id, p_actor_id, 'engine_defaults', p_engine);
  return true;
end; $$;
revoke all on function public.set_engine_defaults_v1(uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.set_engine_defaults_v1(uuid,jsonb) to service_role;

create or replace function public.set_legacy_password_login_v1(p_actor_id uuid, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_console_admin_v1(p_actor_id);
  update public.console_settings c set legacy_password_login_enabled = coalesce(p_enabled, true), updated_by = p_actor_id, updated_at = statement_timestamp() where c.id = 1;
  return found;
end; $$;
revoke all on function public.set_legacy_password_login_v1(uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_legacy_password_login_v1(uuid,boolean) to service_role;
