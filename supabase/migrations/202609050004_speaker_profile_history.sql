-- 2026-09-05 feat: Persist the identity selected at the audio boundary, never the latest profile.
alter table public.live_source_utterances add column speaker_profile jsonb, add column speaker_attribution text check(speaker_attribution is null or speaker_attribution='unresolved');
alter table public.live_utterances add column speaker_profile jsonb, add column speaker_attribution text check(speaker_attribution is null or speaker_attribution='unresolved');
create function public.assert_live_speaker_profile_v1(p_session_id uuid,p_profile jsonb,p_attribution text)
returns void language plpgsql stable security definer set search_path='' as $$
begin
 if p_attribution is not null and p_attribution<>'unresolved' then raise exception 'SPEAKER_PROFILE_INVALID'; end if;
 if p_profile is null then return; end if;
 if p_attribution is not null or not exists(select 1 from public.live_speaker_profile_versions v where v.session_id=p_session_id and (v.profile-'participantId')=p_profile) then raise exception 'SPEAKER_PROFILE_INVALID'; end if;
end $$;
revoke all on function public.assert_live_speaker_profile_v1(uuid,jsonb,text) from public,anon,authenticated,service_role;
create or replace function public.persist_authoritative_live_source_utterance_v4(
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
  p_language_observation jsonb,
  p_speaker_profile jsonb,
  p_speaker_attribution text,
  p_source_provenance jsonb default null
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
  perform public.assert_live_speaker_profile_v1(p_session_id,p_speaker_profile,p_speaker_attribution);
  if p_speaker_role is null or (p_speaker_attribution='unresolved' and (p_speaker_role<>'unknown' or p_participant_id is not null)) or (p_speaker_profile is not null and p_speaker_role not in ('host','participant')) then raise exception 'SPEAKER_PROFILE_INVALID'; end if;
  if p_source_provenance is not null and (not public.live_input_source_provenance_valid_v1(p_source_provenance) or p_stt_provider is distinct from 'gemini-live-input-transcription' or p_stt_model is distinct from 'gemini-3.5-live-translate-preview' or p_source_started_at is not null) then raise exception 'INVALID_LIVE_SOURCE_PROVENANCE'; end if;
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
    if p_speaker_profile is null then
    clean_speaker_name := matched_participant.display_name;
    clean_speaker_department := matched_participant.department;
    clean_speaker_job_title := matched_participant.job_title;
    end if;
  end if;

  if p_speaker_profile is not null then
    clean_speaker_name := p_speaker_profile->>'displayName';
    clean_speaker_label := clean_speaker_name;
    clean_speaker_department := p_speaker_profile->>'department';
  end if;

  select * into existing_source
  from public.live_source_utterances source_row
  where source_row.session_id = p_session_id
    and source_row.utterance_key = clean_key;
  if found then
    if existing_source.speaker_profile is distinct from p_speaker_profile
      or existing_source.speaker_attribution is distinct from p_speaker_attribution
      or existing_source.source_provenance is distinct from p_source_provenance
      or existing_source.language_observation is distinct from p_language_observation
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
    speaker_profile,speaker_attribution,source_provenance,language_observation, session_id, source_seq, utterance_key, raw_text, normalized_text,
    source_language, speaker_role, speaker_label, speaker_name,
    speaker_department, speaker_job_title, participant_id,
    source_started_at, source_ended_at, provider_committed_at,
    stt_provider, stt_model, translation_model, pipeline_config_fingerprint,
    glossary_fingerprint, created_at
  ) values (
    p_speaker_profile,p_speaker_attribution,p_source_provenance,p_language_observation, p_session_id, next_source_seq, clean_key, p_raw_text, clean_normalized_text,
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

revoke all on function public.persist_authoritative_live_source_utterance_v4(uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb, jsonb, text, jsonb) from public,anon,authenticated,service_role;
grant execute on function public.persist_authoritative_live_source_utterance_v4(uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb, jsonb, text, jsonb) to service_role;

create function public.persist_authoritative_live_source_utterance_v4_fenced_v1(p_epoch integer,p_owner_id uuid,
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
  p_language_observation jsonb,
  p_speaker_profile jsonb,
  p_speaker_attribution text,
  p_source_provenance jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$ begin
 perform public.assert_live_media_write_epoch_v1(p_session_id,p_epoch,p_owner_id);
 return public.persist_authoritative_live_source_utterance_v4(p_session_id, p_utterance_key, p_raw_text, p_normalized_text, p_source_language, p_speaker_role, p_speaker_label, p_speaker_name, p_speaker_department, p_speaker_job_title, p_participant_id, p_source_started_at, p_source_ended_at, p_provider_committed_at, p_stt_provider, p_stt_model, p_translation_model, p_pipeline_config_fingerprint, p_language_observation, p_speaker_profile, p_speaker_attribution, p_source_provenance);
end $$;
revoke all on function public.persist_authoritative_live_source_utterance_v4_fenced_v1(integer,uuid,uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb, jsonb, text, jsonb) from public,anon,authenticated,service_role;
grant execute on function public.persist_authoritative_live_source_utterance_v4_fenced_v1(integer,uuid,uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb, jsonb, text, jsonb) to service_role;

create or replace function public.read_owned_live_source_snapshot_v1(
  p_session_id uuid, p_host_id text,
  p_after_source_seq bigint default 0, p_limit integer default 200
)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  recording_gaps jsonb;
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
  if p_host_id is null or char_length(p_host_id) not between 1 and 256 then
    raise exception using errcode='42501',message='SOURCE_FORBIDDEN';
  end if;
  perform 1 from public.live_sessions target where target.id=p_session_id
    and target.host_id=p_host_id and target.archive_deleted_at is null;
  if not found then
    raise exception using errcode='42501',message='SOURCE_FORBIDDEN';
  end if;
  -- The owner can inspect captured originals during a call and afterwards.
  -- Participant grant, revocation and six-hour checks remain in their own RPC.
  recording_gaps := public.read_owned_live_recording_gaps_v1(p_session_id,p_host_id) -> 'recordingGaps';

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
  if estimated_bytes + octet_length(recording_gaps::text) > 12*1024*1024 then
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
  ) || case when source.speaker_profile is not null then jsonb_build_object('speakerProfile',source.speaker_profile) else '{}'::jsonb end || case when source.speaker_attribution is not null then jsonb_build_object('speakerAttribution',source.speaker_attribution) else '{}'::jsonb end order by source.source_seq),'[]'::jsonb),max(source.source_seq) into source_rows,next_source_seq
    from (select * from public.live_source_utterances target
      where target.session_id=p_session_id and target.source_seq>p_after_source_seq
      order by target.source_seq limit p_limit) source
    left join lateral (select row.corrected_text from public.live_source_utterance_corrections row
      where row.source_utterance_id=source.id and row.session_id=p_session_id order by row.revision desc limit 1) correction on true;
  has_next := next_source_seq is not null and next_source_seq < last_source_seq;
  return jsonb_build_object('sessionId',p_session_id,'sources',source_rows,'lastSourceSeq',last_source_seq,
    'hasNextPage',has_next,'nextAfterSourceSeq',case when has_next then next_source_seq else null end,
    'recordsExpiresAt',null,'recordingGaps',recording_gaps);
end;
$$;
revoke all on function public.read_owned_live_source_snapshot_v1(uuid,text,bigint,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.read_owned_live_source_snapshot_v1(uuid,text,bigint,integer) to service_role;

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
  recording_gaps jsonb;
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

  if (select count(*) from public.live_media_recording_gaps target where target.session_id=p_session_id) > 12000 then
    raise exception using errcode='P0001',message='SOURCE_SNAPSHOT_TOO_LARGE';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',target.id,'startedAt',target.started_at,
    'endedAt',target.ended_at,'reason',target.reason) order by target.started_at,target.id),'[]'::jsonb)
    into recording_gaps from public.live_media_recording_gaps target where target.session_id=p_session_id;

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
  ) || case when source.speaker_profile is not null then jsonb_build_object('speakerProfile',source.speaker_profile) else '{}'::jsonb end || case when source.speaker_attribution is not null then jsonb_build_object('speakerAttribution',source.speaker_attribution) else '{}'::jsonb end order by source.source_seq),'[]'::jsonb),max(source.source_seq) into source_rows,next_source_seq
    from (select * from public.live_source_utterances target
      where target.session_id=p_session_id and target.source_seq>p_after_source_seq
      order by target.source_seq limit p_limit) source
    left join lateral (select row.corrected_text from public.live_source_utterance_corrections row
      where row.source_utterance_id=source.id and row.session_id=p_session_id order by row.revision desc limit 1) correction on true;
  has_next := next_source_seq is not null and next_source_seq < last_source_seq;
  return jsonb_build_object('sessionId',p_session_id,'sources',source_rows,'lastSourceSeq',last_source_seq,
    'hasNextPage',has_next,'nextAfterSourceSeq',case when has_next then next_source_seq else null end,
    'recordsExpiresAt',records_expire_at,'recordingGaps',recording_gaps);
end;
$$;
revoke all on function public.read_participant_live_source_snapshot_v1(uuid,text,uuid,bigint,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.read_participant_live_source_snapshot_v1(uuid,text,uuid,bigint,integer) to service_role;

-- 2026-09-05 fix: Authorize custom identity before delegating to the existing caption sanitizer.
alter function public.persist_live_snapshot_if_active(uuid,text,jsonb) rename to persist_live_snapshot_if_active_before_speaker_profile;
revoke all on function public.persist_live_snapshot_if_active_before_speaker_profile(uuid,text,jsonb) from public,anon,authenticated,service_role;
create function public.persist_live_snapshot_if_active(p_session_id uuid,p_language text,p_event jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare stored boolean; clean_event jsonb; existing jsonb; additions jsonb;
begin
 if not(p_event ? 'speakerProfile' or p_event ? 'speakerAttribution') then return public.persist_live_snapshot_if_active_before_speaker_profile(p_session_id,p_language,p_event); end if;
 perform public.assert_live_speaker_profile_v1(p_session_id,p_event->'speakerProfile',p_event->>'speakerAttribution');
 if p_event ? 'speakerProfile' and (coalesce(p_event->>'speakerRole','') not in ('host','participant') or p_event->>'speakerName' is distinct from p_event->'speakerProfile'->>'displayName' or p_event->>'speakerDepartment' is distinct from p_event->'speakerProfile'->>'department') then raise exception 'SPEAKER_PROFILE_INVALID'; end if;
 if p_event->>'speakerAttribution'='unresolved' and p_event->>'speakerRole' is distinct from 'unknown' then raise exception 'SPEAKER_PROFILE_INVALID'; end if;
 additions:=jsonb_build_object('speakerAttribution',p_event->'speakerAttribution','speakerProfile',p_event->'speakerProfile');
 if p_event ? 'speakerProfile' then additions:=additions||jsonb_build_object('speakerRole',p_event->'speakerRole','speakerName',p_event->'speakerProfile'->>'displayName','speakerDepartment',p_event->'speakerProfile'->>'department','speakerJobTitle',''); end if;
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into additions from jsonb_each(additions) where value<>'null'::jsonb;
 clean_event:=p_event-array['speakerProfile','speakerAttribution','speakerRole','speakerName','speakerDepartment','speakerJobTitle'];
 select captions->0 into existing from public.live_snapshots where session_id=p_session_id and language=p_language and last_seq=(p_event->>'seq')::bigint;
 if existing is not null and (existing->'speakerProfile' is distinct from p_event->'speakerProfile' or existing->>'speakerAttribution' is distinct from p_event->>'speakerAttribution') then raise exception 'SPEAKER_PROFILE_IDEMPOTENCY_CONFLICT'; end if;
 stored:=public.persist_live_snapshot_if_active_before_speaker_profile(p_session_id,p_language,clean_event);
 if stored then update public.live_snapshots set captions=jsonb_build_array((captions->0)||additions) where session_id=p_session_id and language=p_language and last_seq=(p_event->>'seq')::bigint; end if;
 return stored;
end $$;
revoke all on function public.persist_live_snapshot_if_active(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.persist_live_snapshot_if_active(uuid,text,jsonb) to service_role;
alter function public.persist_live_final_caption_if_active(uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text) rename to persist_live_final_caption_before_speaker_profile;
revoke all on function public.persist_live_final_caption_before_speaker_profile(uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text) from public,anon,authenticated,service_role;
create function public.persist_live_final_caption_if_active(
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
  p_translation_status text) returns boolean language plpgsql security definer set search_path='' as $$
declare stored boolean; previous public.live_utterances%rowtype; existed boolean;
begin
 perform public.assert_live_speaker_profile_v1(p_session_id,p_event->'speakerProfile',p_event->>'speakerAttribution');
 if p_event ? 'speakerProfile' and (coalesce(p_event->>'speakerRole','') not in ('host','participant') or p_event->>'speakerName' is distinct from p_event->'speakerProfile'->>'displayName' or p_event->>'speakerDepartment' is distinct from p_event->'speakerProfile'->>'department') then raise exception 'SPEAKER_PROFILE_INVALID'; end if;
 if p_event->>'speakerAttribution'='unresolved' and p_event->>'speakerRole' is distinct from 'unknown' then raise exception 'SPEAKER_PROFILE_INVALID'; end if;
 select * into previous from public.live_utterances where session_id=p_session_id and language=p_language and seq=p_seq;
 existed:=found;
 if existed and (previous.speaker_profile is distinct from p_event->'speakerProfile' or previous.speaker_attribution is distinct from p_event->>'speakerAttribution') then raise exception 'SPEAKER_PROFILE_IDEMPOTENCY_CONFLICT'; end if;
 stored:=public.persist_live_final_caption_before_speaker_profile(p_session_id, p_language, p_event, p_seq, p_text, p_speaker_label, p_speaker_name, p_source_started_at, p_source_ended_at, p_emitted_at, p_participant_id, p_source_text, p_source_language, p_origin, p_utterance_key, p_translation_status);
 if stored and not existed then update public.live_utterances set speaker_profile=p_event->'speakerProfile',speaker_attribution=p_event->>'speakerAttribution' where session_id=p_session_id and language=p_language and seq=p_seq; end if;
 return stored;
end $$;
revoke all on function public.persist_live_final_caption_if_active(uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text) from public,anon,authenticated,service_role;
grant execute on function public.persist_live_final_caption_if_active(uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text) to service_role;

alter function public.read_owned_authoritative_live_transcript_v1(text, uuid, bigint, integer) rename to read_owned_authoritative_live_transcript_v1_before_profile;
revoke all on function public.read_owned_authoritative_live_transcript_v1_before_profile(text, uuid, bigint, integer) from public,anon,authenticated,service_role;
create function public.read_owned_authoritative_live_transcript_v1(
  p_host_id text,
  p_session_id uuid,
  p_after_source_seq bigint default 0,
  p_limit integer default 200
) returns table(
  source_utterance_id uuid,
  source_seq bigint,
  utterance_key text,
  raw_text text,
  normalized_text text,
  effective_text text,
  source_language text,
  speaker_role text,
  speaker_label text,
  speaker_name text,
  speaker_department text,
  speaker_job_title text,
  participant_id uuid,
  source_started_at timestamptz,
  source_ended_at timestamptz,
  provider_committed_at timestamptz,
  stt_provider text,
  stt_model text,
  translation_model text,
  pipeline_config_fingerprint text,
  glossary_fingerprint text,
  correction_revision integer,
  corrected_at timestamptz,
  translations jsonb
,speaker_profile jsonb,speaker_attribution text)
language sql stable security definer set search_path='' as $$
 select original.*,source.speaker_profile,source.speaker_attribution from public.read_owned_authoritative_live_transcript_v1_before_profile(p_host_id, p_session_id, p_after_source_seq, p_limit) original join public.live_source_utterances source on source.id=original.source_utterance_id and source.session_id=p_session_id;
$$;
revoke all on function public.read_owned_authoritative_live_transcript_v1(text, uuid, bigint, integer) from public,anon,authenticated,service_role;
grant execute on function public.read_owned_authoritative_live_transcript_v1(text, uuid, bigint, integer) to service_role;

alter function public.read_participant_live_source_transcript_v1(uuid, text, bigint, integer) rename to read_participant_live_source_transcript_v1_before_profile;
revoke all on function public.read_participant_live_source_transcript_v1_before_profile(uuid, text, bigint, integer) from public,anon,authenticated,service_role;
create function public.read_participant_live_source_transcript_v1(
  p_session_id uuid, p_user_id text,
  p_after_source_seq bigint default 0, p_limit integer default 200
) returns table(
  source_utterance_id uuid, source_seq bigint, effective_text text,
  source_language text, speaker_label text, source_started_at timestamptz,
  source_ended_at timestamptz
,speaker_profile jsonb,speaker_attribution text)
language sql stable security definer set search_path='' as $$
 select original.*,source.speaker_profile,source.speaker_attribution from public.read_participant_live_source_transcript_v1_before_profile(p_session_id, p_user_id, p_after_source_seq, p_limit) original join public.live_source_utterances source on source.id=original.source_utterance_id and source.session_id=p_session_id;
$$;
revoke all on function public.read_participant_live_source_transcript_v1(uuid, text, bigint, integer) from public,anon,authenticated,service_role;
grant execute on function public.read_participant_live_source_transcript_v1(uuid, text, bigint, integer) to service_role;
