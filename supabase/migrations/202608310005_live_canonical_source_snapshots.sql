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
