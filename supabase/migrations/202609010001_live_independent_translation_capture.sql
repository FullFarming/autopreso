-- 2026-09-01 feat: Direct Live translation commits independently of the 3.7
-- source ledger. Capture windows describe accepted PCM for a generation, not
-- exact sentence alignment. Existing rows stay NULL; no provenance is guessed.

alter table public.live_utterances
  add column if not exists translation_capture jsonb,
  add column if not exists translation_event_hash bytea;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.live_utterances'::regclass
      and conname = 'live_utterances_independent_translation_check') then
    alter table public.live_utterances add constraint live_utterances_independent_translation_check check (
      (translation_capture is null and translation_event_hash is null)
      or (translation_capture is not null and translation_event_hash is not null
        and jsonb_typeof(translation_capture) = 'object' and octet_length(translation_capture::text) <= 2048
        and octet_length(translation_event_hash) = 32
        and authoritative_source_id is null and source_text is null and source_language is null
        and source_started_at is null and origin is null and participant_id is null
        and translation_status = 'translated')
    );
  end if;
end;
$$;

comment on column public.live_utterances.translation_capture is
  'Independent Live translation generation/capture epoch and approximate generation PCM window. Never an exact source-utterance or sentence alignment.';
comment on column public.live_utterances.translation_event_hash is
  'SHA-256 of the original independent durable event, used solely to reject conflicting same-sequence replay. NULL for earlier writers.';

create or replace function public.persist_independent_live_translation_v1(
  p_session_id uuid, p_language text, p_event jsonb
)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  capture jsonb;
  event_seq bigint;
  event_hash bytea;
  existing_row public.live_utterances%rowtype;
  event_speaker_id text;
  capture_started_at timestamptz;
  capture_ended_at timestamptz;
  stored boolean;
  changed integer;
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  instant_pattern constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$';
begin
  -- Lock order matches every media writer: session first, then its records.
  perform 1 from public.live_sessions target where target.id = p_session_id
    and target.status = 'live' and target.archive_deleted_at is null
    and target.expires_at > statement_timestamp() and p_language = any(target.languages)
    for update;
  if not found then return false; end if;

  if p_event is null or jsonb_typeof(p_event) is distinct from 'object'
    or octet_length(p_event::text) > 65536
    or jsonb_typeof(p_event -> 'seq') is distinct from 'number'
    or (p_event ->> 'seq') !~ '^[1-9][0-9]{0,15}$'
    or (p_event ->> 'seq')::numeric > 9007199254740991
    or p_event ->> 'type' is distinct from 'caption'
    or p_event ->> 'sessionId' is distinct from p_session_id::text
    or p_event ->> 'language' is distinct from p_language
    or p_event -> 'isFinal' is distinct from 'true'::jsonb
    or p_event ->> 'translationStatus' is distinct from 'translated'
    or exists (select 1 from jsonb_each(p_event) field
      where field.key in ('sourceText','sourceLanguage','sourceStartedAt','origin','authoritativeSourceId','languageObservation')
        and field.value <> 'null'::jsonb)
  then raise exception using errcode='P0001', message='INVALID_INDEPENDENT_TRANSLATION'; end if;

  capture := p_event -> 'translationCapture';
  if jsonb_typeof(capture) is distinct from 'object'
    or not (capture ?& array['kind','streamGeneration','captureEpoch','captureStartedAt','captureEndedAt','finalization'])
    or (capture - array['kind','streamGeneration','captureEpoch','captureStartedAt','captureEndedAt','finalization']) <> '{}'::jsonb
    or capture ->> 'kind' is distinct from 'independent-live-translation'
    or capture ->> 'finalization' is distinct from 'application-sentence-boundary'
    or coalesce(capture ->> 'streamGeneration','') !~* uuid_pattern
    or coalesce(capture ->> 'captureEpoch','') !~* uuid_pattern
    or coalesce(capture ->> 'captureEndedAt','') !~ instant_pattern
    or jsonb_typeof(capture -> 'captureStartedAt') not in ('string','null')
    or (capture -> 'captureStartedAt' <> 'null'::jsonb and (capture ->> 'captureStartedAt') !~ instant_pattern)
  then raise exception using errcode='P0001', message='INVALID_INDEPENDENT_TRANSLATION_CAPTURE'; end if;
  capture_started_at := (capture ->> 'captureStartedAt')::timestamptz;
  capture_ended_at := (capture ->> 'captureEndedAt')::timestamptz;
  event_seq := (p_event ->> 'seq')::bigint;
  if capture_started_at > capture_ended_at
    or p_event ->> 'sourceEndedAt' is distinct from capture ->> 'captureEndedAt'
    or p_event ->> 'utteranceKey' is distinct from 'lt:' || (capture ->> 'streamGeneration') || ':' || event_seq::text
  then raise exception using errcode='P0001', message='INVALID_INDEPENDENT_TRANSLATION_CAPTURE'; end if;

  event_speaker_id := p_event -> 'speaker' ->> 'speakerId';
  if event_speaker_id like 'participant:%' and not exists (
    select 1 from public.live_participants participant where participant.session_id = p_session_id
      and 'participant:' || participant.id::text = event_speaker_id
  ) then raise exception using errcode='P0001', message='INDEPENDENT_TRANSLATION_PARTICIPANT_INVALID'; end if;

  event_hash := pg_catalog.sha256(pg_catalog.convert_to(p_event::text, 'UTF8'));
  select * into existing_row from public.live_utterances target
    where target.session_id = p_session_id and target.language = p_language and target.seq = event_seq;
  if found then
    if existing_row.translation_capture is distinct from capture
      or existing_row.translation_event_hash is distinct from event_hash
    then raise exception using errcode='P0001', message='INDEPENDENT_TRANSLATION_REPLAY_CONFLICT'; end if;
    return true;
  end if;

  -- The unchanged pre-source overload owns strict speaker/event validation,
  -- sequential lane advancement and atomic snapshot+utterance persistence.
  -- Participant ID and source start remain NULL so a generation-wide window
  -- cannot inflate a participant's utterance count or speaking duration.
  stored := public.persist_live_final_caption_if_active(
    p_session_id, p_language, p_event - 'translationCapture', event_seq, p_event ->> 'text',
    event_speaker_id, p_event -> 'speaker' ->> 'label', null::timestamptz,
    (p_event ->> 'sourceEndedAt')::timestamptz, (p_event ->> 'emittedAt')::timestamptz,
    null::uuid, null::text, null::text, null::text, p_event ->> 'utteranceKey', 'translated'::text
  );
  if not stored then raise exception using errcode='P0001', message='INVALID_INDEPENDENT_TRANSLATION'; end if;

  update public.live_utterances set translation_capture = capture, translation_event_hash = event_hash
    where session_id = p_session_id and language = p_language and seq = event_seq;
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception using errcode='P0001', message='INDEPENDENT_TRANSLATION_COMMIT_FAILED'; end if;
  update public.live_snapshots set captions = jsonb_build_array((captions -> 0)
      || jsonb_build_object('translationCapture', capture))
    where session_id = p_session_id and language = p_language and last_seq = event_seq;
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception using errcode='P0001', message='INDEPENDENT_TRANSLATION_COMMIT_FAILED'; end if;
  return true;
end;
$$;

create or replace function public.persist_independent_live_translation_v1_fenced_v1(
  p_epoch integer, p_owner_id uuid, p_session_id uuid, p_language text, p_event jsonb
)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  perform public.assert_live_media_write_epoch_v1(p_session_id, p_epoch, p_owner_id);
  return public.persist_independent_live_translation_v1(p_session_id, p_language, p_event);
end;
$$;

revoke all on function public.persist_independent_live_translation_v1(uuid,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.persist_independent_live_translation_v1_fenced_v1(integer,uuid,uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_independent_live_translation_v1(uuid,text,jsonb) to service_role;
grant execute on function public.persist_independent_live_translation_v1_fenced_v1(integer,uuid,uuid,text,jsonb) to service_role;

-- Rollback is application-first: stop using the independent entrypoint and
-- retain these nullable fields and RPCs. No existing writer, ACL or RLS policy
-- is replaced, and neither canonical originals nor historical rows are changed.
