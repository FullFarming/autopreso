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
