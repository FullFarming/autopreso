-- 2026-09-01 feat: Live input transcription shares the existing translation
-- connection. Keep its application/provider finalization evidence separate from
-- old provider-final rows, without guessing timing or source/translation links.
alter table public.live_source_utterances add column if not exists source_provenance jsonb;

create or replace function public.live_input_source_provenance_valid_v1(p_value jsonb)
returns boolean language sql immutable set search_path = ''
as $$
  select coalesce(jsonb_typeof(p_value)='object' and octet_length(p_value::text)<=1024
    and p_value ?& array['kind','streamGeneration','captureEpoch','finalization']
    and (p_value-array['kind','streamGeneration','captureEpoch','finalization'])='{}'::jsonb
    and p_value->>'kind'='live-input-transcription'
    and p_value->>'streamGeneration' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and p_value->>'captureEpoch' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and p_value->>'finalization' in ('provider-finished','application-quiet-boundary','application-drain-boundary','application-length-boundary'),false);
$$;
revoke all on function public.live_input_source_provenance_valid_v1(jsonb) from public,anon,authenticated,service_role;

do $$ begin
  if not exists(select 1 from pg_catalog.pg_constraint where conrelid='public.live_source_utterances'::regclass
    and conname='live_source_input_provenance_check') then
    alter table public.live_source_utterances add constraint live_source_input_provenance_check check (
      source_provenance is null or (
        public.live_input_source_provenance_valid_v1(source_provenance)
        and stt_provider='gemini-live-input-transcription'
        and stt_model is not distinct from 'gemini-3.5-live-translate-preview'
        and source_started_at is null));
  end if;
end; $$;
comment on column public.live_source_utterances.source_provenance is
  'NULL for legacy provider finals. Live input records state observed provider-finished or an explicit application quiet/drain/length boundary; capture epochs are not word alignment.';
comment on column public.live_source_utterances.provider_committed_at is
  'Source acceptance time. Legacy provider-final time; Live input records use application commit time, with finalization evidence in source_provenance.';

create or replace function public.persist_authoritative_live_source_utterance_v3(
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
  p_source_provenance jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare result jsonb; stored_provenance jsonb; changed integer;
begin
  if not public.live_input_source_provenance_valid_v1(p_source_provenance)
    or p_stt_provider is distinct from 'gemini-live-input-transcription'
    or p_stt_model is distinct from 'gemini-3.5-live-translate-preview'
    or p_source_started_at is not null
  then raise exception using errcode='22023',message='INVALID_LIVE_SOURCE_PROVENANCE'; end if;
  perform 1 from public.live_sessions target where target.id=p_session_id
    and target.status='live' and target.archive_deleted_at is null and target.expires_at>statement_timestamp() for update;
  if not found then raise exception using errcode='P0001',message='SESSION_NOT_LIVE'; end if;
  result := public.persist_authoritative_live_source_utterance_v2(p_session_id, p_utterance_key, p_raw_text, p_normalized_text, p_source_language, p_speaker_role, p_speaker_label, p_speaker_name, p_speaker_department, p_speaker_job_title, p_participant_id, p_source_started_at, p_source_ended_at, p_provider_committed_at, p_stt_provider, p_stt_model, p_translation_model, p_pipeline_config_fingerprint, p_language_observation);
  if result->>'idempotent'='true' then
    select source.source_provenance into stored_provenance from public.live_source_utterances source
      where source.id=(result->>'sourceUtteranceId')::uuid and source.session_id=p_session_id;
    if stored_provenance is distinct from p_source_provenance then
      raise exception using errcode='P0001',message='SOURCE_UTTERANCE_IDEMPOTENCY_CONFLICT';
    end if;
  else
    update public.live_source_utterances source set source_provenance=p_source_provenance
      where source.id=(result->>'sourceUtteranceId')::uuid and source.session_id=p_session_id and source.source_provenance is null;
    get diagnostics changed = row_count;
    if changed<>1 then raise exception using errcode='P0001',message='SOURCE_UTTERANCE_IDEMPOTENCY_CONFLICT'; end if;
  end if;
  return result;
end;
$$;
revoke all on function public.persist_authoritative_live_source_utterance_v3(uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb, jsonb) from public,anon,authenticated,service_role;
grant execute on function public.persist_authoritative_live_source_utterance_v3(uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb, jsonb) to service_role;

create or replace function public.persist_authoritative_live_source_utterance_v3_fenced_v1(
  p_epoch integer, p_owner_id uuid,
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
  p_source_provenance jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  perform public.assert_live_media_write_epoch_v1(p_session_id,p_epoch,p_owner_id);
  return public.persist_authoritative_live_source_utterance_v3(p_session_id, p_utterance_key, p_raw_text, p_normalized_text, p_source_language, p_speaker_role, p_speaker_label, p_speaker_name, p_speaker_department, p_speaker_job_title, p_participant_id, p_source_started_at, p_source_ended_at, p_provider_committed_at, p_stt_provider, p_stt_model, p_translation_model, p_pipeline_config_fingerprint, p_language_observation, p_source_provenance);
end;
$$;
revoke all on function public.persist_authoritative_live_source_utterance_v3_fenced_v1(integer,uuid,uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb, jsonb) from public,anon,authenticated,service_role;
grant execute on function public.persist_authoritative_live_source_utterance_v3_fenced_v1(integer,uuid,uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb, jsonb) to service_role;
