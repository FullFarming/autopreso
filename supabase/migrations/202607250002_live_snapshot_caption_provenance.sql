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
    or (p_event ? 'sourceStartedAt' and jsonb_typeof(p_event -> 'sourceStartedAt') not in ('string', 'null'))
    or (
      jsonb_typeof(p_event -> 'sourceStartedAt') = 'string'
      and (p_event ->> 'sourceStartedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
    )
    or (p_event ? 'sourceText' and jsonb_typeof(p_event -> 'sourceText') not in ('string', 'null'))
    or (
      jsonb_typeof(p_event -> 'sourceText') = 'string'
      and (
        length(btrim(p_event ->> 'sourceText')) not between 1 and 8000
        or octet_length(p_event ->> 'sourceText') > 24000
      )
    )
    or (p_event ? 'sourceLanguage' and jsonb_typeof(p_event -> 'sourceLanguage') not in ('string', 'null'))
    or (
      jsonb_typeof(p_event -> 'sourceLanguage') = 'string'
      and (p_event ->> 'sourceLanguage') !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
    )
    or (p_event ? 'translationStatus' and jsonb_typeof(p_event -> 'translationStatus') not in ('string', 'null'))
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
      or ((p_event -> 'speaker') ? 'name' and jsonb_typeof(p_event -> 'speaker' -> 'name') not in ('string', 'null'))
      or (
        jsonb_typeof(p_event -> 'speaker' -> 'name') = 'string'
        and (
          length(btrim(p_event -> 'speaker' ->> 'name')) not between 1 and 40
          or (p_event -> 'speaker' ->> 'name') ~ '[[:cntrl:]]'
          or (p_event -> 'speaker' ->> 'name') ~ '[<>]'
        )
      )
      or ((p_event -> 'speaker') ? 'department' and jsonb_typeof(p_event -> 'speaker' -> 'department') not in ('string', 'null'))
      or (
        jsonb_typeof(p_event -> 'speaker' -> 'department') = 'string'
        and (
          length(btrim(p_event -> 'speaker' ->> 'department')) not between 1 and 80
          or (p_event -> 'speaker' ->> 'department') ~ '[[:cntrl:]]'
          or (p_event -> 'speaker' ->> 'department') ~ '[<>]'
        )
      )
      or ((p_event -> 'speaker') ? 'jobTitle' and jsonb_typeof(p_event -> 'speaker' -> 'jobTitle') not in ('string', 'null'))
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
