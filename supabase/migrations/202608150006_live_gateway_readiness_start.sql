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
