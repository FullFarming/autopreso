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
