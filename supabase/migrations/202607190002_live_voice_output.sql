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
