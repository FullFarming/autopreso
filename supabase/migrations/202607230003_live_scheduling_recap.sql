-- 2026-07-23 feat: Add host scheduling, explicit start/leave transitions,
-- QR-only admission, and privacy-bounded recap access. Existing RPC overloads
-- remain available; participant identity retained for recaps is limited to the
-- anonymous auth user ID and is deleted with the recap after 30 days.

alter table public.live_sessions
  add column if not exists title text,
  add column if not exists scheduled_at timestamptz;

alter table public.live_sessions
  add constraint live_sessions_title_check
  check (
    title is null
    or (
      char_length(title) between 1 and 120
      and title = normalize(btrim(title), NFC)
      and title !~ '[[:cntrl:]]'
      and title !~ '[<>]'
    )
  ),
  add constraint live_sessions_schedule_window_check
  check (
    scheduled_at is null
    or (
      scheduled_at >= created_at - interval '5 minutes'
      and scheduled_at <= created_at + interval '30 days'
    )
  );

-- Scheduled sessions need to remain valid until their planned start. Legacy
-- rows have scheduled_at null and retain the original six-hour lifetime.
alter table public.live_sessions
  drop constraint live_sessions_expiry_check,
  add constraint live_sessions_expiry_check
  check (
    expires_at > greatest(created_at, coalesce(scheduled_at, created_at))
    and expires_at <= greatest(created_at, coalesce(scheduled_at, created_at)) + interval '6 hours'
  );

comment on column public.live_sessions.title is
  'Optional NFC-normalized attendee-facing meeting title.';
comment on column public.live_sessions.scheduled_at is
  'Optional host schedule, at most 30 days after session creation.';

grant select (title, scheduled_at) on public.live_sessions to authenticated;

create table public.live_recap_grants (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  user_id text not null check (char_length(user_id) between 1 and 256),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (session_id, user_id),
  constraint live_recap_grants_expiry_check check (
    expires_at > created_at
    and expires_at <= created_at + interval '30 days'
  )
);

create index live_recap_grants_expiry_idx
  on public.live_recap_grants (expires_at);

alter table public.live_recap_grants enable row level security;

create policy live_recap_grants_owner_select
  on public.live_recap_grants for select to authenticated
  using (
    user_id = (select auth.uid())::text
    and expires_at > now()
  );

create policy live_sessions_recap_viewer_select
  on public.live_sessions for select to authenticated
  using (
    status = 'stopped'
    and exists (
      select 1
      from public.live_recap_grants recap_grant
      where recap_grant.session_id = live_sessions.id
        and recap_grant.user_id = (select auth.uid())::text
        and recap_grant.expires_at > now()
    )
  );

create policy live_utterances_recap_select
  on public.live_utterances for select to authenticated
  using (
    exists (
      select 1
      from public.live_sessions session_row
      where session_row.id = live_utterances.session_id
        and session_row.status = 'stopped'
        and (
          session_row.host_id = (select auth.uid())::text
          or exists (
            select 1
            from public.live_recap_grants recap_grant
            where recap_grant.session_id = session_row.id
              and recap_grant.user_id = (select auth.uid())::text
              and recap_grant.expires_at > now()
          )
        )
    )
  );

create policy live_meeting_summaries_recap_select
  on public.live_meeting_summaries for select to authenticated
  using (
    exists (
      select 1
      from public.live_sessions session_row
      where session_row.id = live_meeting_summaries.session_id
        and session_row.status = 'stopped'
        and (
          session_row.host_id = (select auth.uid())::text
          or exists (
            select 1
            from public.live_recap_grants recap_grant
            where recap_grant.session_id = session_row.id
              and recap_grant.user_id = (select auth.uid())::text
              and recap_grant.expires_at > now()
          )
        )
    )
  );

grant select on public.live_recap_grants, public.live_utterances,
  public.live_meeting_summaries to authenticated;
grant select, insert, update, delete on public.live_recap_grants to service_role;
grant select, insert, update, delete on public.live_utterances,
  public.live_meeting_summaries to service_role;

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
    or p_max_viewers not between 1 and 50
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
    or p_max_viewers not between 1 and 50
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

create or replace function public.start_live_session(
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
    raise exception using errcode = '22023', message = 'INVALID_START_INPUT';
  end if;

  update public.live_sessions as session_row
  set status = 'live',
      updated_at = statement_timestamp(),
      version = session_row.version + 1
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.status = 'preparing'
    and session_row.version = p_expected_version
    and session_row.expires_at > statement_timestamp()
  returning session_row.version into next_version;

  if next_version is null then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT_OR_FORBIDDEN';
  end if;
  return next_version;
end;
$$;

create or replace function public.leave_live_session(
  p_session_id uuid,
  p_grant_id uuid,
  p_user_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  grant_row public.viewer_grants%rowtype;
  remaining_viewers integer;
begin
  if p_session_id is null
    or p_grant_id is null
    or p_user_id is null
    or char_length(p_user_id) not between 1 and 256
  then
    return false;
  end if;

  select * into session_row
  from public.live_sessions
  where id = p_session_id
  for update;
  if not found then
    return false;
  end if;

  select * into grant_row
  from public.viewer_grants
  where id = p_grant_id
    and session_id = p_session_id
    and user_id = p_user_id
  for update;
  if not found then
    return false;
  end if;

  if session_row.floor_grant_id = p_grant_id then
    update public.live_sessions
    set floor_grant_id = null,
        floor_display_name = null,
        floor_taken_at = null
    where id = p_session_id;
  end if;

  delete from public.viewer_grants
  where id = p_grant_id
    and session_id = p_session_id
    and user_id = p_user_id;

  select count(*)::integer into remaining_viewers
  from public.viewer_grants
  where session_id = p_session_id
    and revoked_at is null
    and expires_at > statement_timestamp();

  update public.live_sessions
  set viewer_count = remaining_viewers,
      updated_at = statement_timestamp()
  where id = p_session_id;
  return true;
end;
$$;

-- QR links are now the sole attendee admission mechanism. This overload keeps
-- the legacy admission-bound invite function available for old clients.
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
    or session_row.status not in ('preparing', 'live')
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
    or session_row.status not in ('preparing', 'live')
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
    and session_row.status in ('preparing', 'live')
    and session_row.expires_at > statement_timestamp();

  if session_rate_key is null then
    raise exception using errcode = 'P0001', message = 'INVITE_CLOSED';
  end if;
  return session_rate_key;
end;
$$;

create or replace function public.redeem_live_invite_v2(
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
  display_name text,
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
  voice_provider := session_row.voice_provider;
  status := session_row.status;
  title := session_row.title;
  scheduled_at := session_row.scheduled_at;
  return next;
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
  delete from public.live_utterances utterance_row
  using public.live_sessions session_row
  where utterance_row.session_id = session_row.id
    and session_row.ended_at <= statement_timestamp() - interval '30 days';
  delete from public.live_meeting_summaries summary_row
  using public.live_sessions session_row
  where summary_row.session_id = session_row.id
    and session_row.ended_at <= statement_timestamp() - interval '30 days';

  return stopped_count;
end;
$$;

revoke all on function public.create_live_session(
  uuid, text, text, text, text[], integer, text, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.update_live_session(
  uuid, text, integer, text, text, text[], integer, text, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.start_live_session(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.leave_live_session(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.create_live_invite(uuid, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.lock_live_invite_session(text)
  from public, anon, authenticated, service_role;
revoke all on function public.resolve_live_invite_rate_key(text)
  from public, anon, authenticated;
revoke all on function public.redeem_live_invite_v2(text, text, text, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.terminate_live_session(uuid, text)
  from public, anon, authenticated;
revoke all on function public.cleanup_expired_live_state()
  from public, anon, authenticated;

grant execute on function public.create_live_session(
  uuid, text, text, text, text[], integer, text, text, text, timestamptz, timestamptz
) to service_role;
grant execute on function public.update_live_session(
  uuid, text, integer, text, text, text[], integer, text, text, text, timestamptz
) to service_role;
grant execute on function public.start_live_session(uuid, text, integer)
  to service_role;
grant execute on function public.leave_live_session(uuid, uuid, text)
  to service_role;
grant execute on function public.create_live_invite(uuid, text, text, timestamptz)
  to service_role;
grant execute on function public.resolve_live_invite_rate_key(text)
  to service_role;
grant execute on function public.redeem_live_invite_v2(text, text, text, timestamptz, text)
  to service_role;
grant execute on function public.terminate_live_session(uuid, text)
  to service_role;
grant execute on function public.cleanup_expired_live_state()
  to service_role;

-- Development verification (run only after applying to a linked dev project):
--   select public.start_live_session(gen_random_uuid(), gen_random_uuid()::text, 1);
--     -> VERSION_CONFLICT_OR_FORBIDDEN
--   select public.leave_live_session(gen_random_uuid(), gen_random_uuid(), 'missing');
--     -> false
