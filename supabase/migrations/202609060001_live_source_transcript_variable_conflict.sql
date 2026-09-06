-- 2026-09-06 forward repair. 202608220001 declared row variables (source_row, session_row,
-- participant_row) and aliased the tables under the same names inside the SQL statements those
-- variables live next to. PL/pgSQL's default variable_conflict = error rejects every such
-- `alias.column` reference with SQLSTATE 42702 ("column reference is ambiguous") the first time
-- the statement executes. In production the 17-argument persist_live_final_caption_if_active
-- failed on every final caption (400 from PostgREST), the gateway treated the failed persist as
-- fatal and closed the host socket, so Live Calls dropped seconds after each utterance and could
-- not be ended (the desktop refuses to end without a drained connection).
--
-- Same policy as 202608150007: pin `#variable_conflict use_column` so table aliases win inside
-- SQL statements. Bodies are otherwise byte-identical to 202608220001. Additive, re-runnable.

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
#variable_conflict use_column
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
revoke all on function public.persist_authoritative_live_source_utterance_v1(
  uuid, text, text, text, text, text, text, text, text, text, uuid,
  timestamptz, timestamptz, timestamptz, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.persist_authoritative_live_source_utterance_v1(
  uuid, text, text, text, text, text, text, text, text, text, uuid,
  timestamptz, timestamptz, timestamptz, text, text, text, text
) to service_role;

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
#variable_conflict use_column
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
revoke all on function public.persist_live_final_caption_if_active(
  uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz,
  timestamptz, uuid, text, text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.persist_live_final_caption_if_active(
  uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz,
  timestamptz, uuid, text, text, text, text, text, uuid
) to service_role;

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
#variable_conflict use_column
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
revoke all on function public.append_owned_live_source_correction_v1(
  text, uuid, uuid, integer, text, text
) from public, anon, authenticated;
grant execute on function public.append_owned_live_source_correction_v1(
  text, uuid, uuid, integer, text, text
) to service_role;
