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
