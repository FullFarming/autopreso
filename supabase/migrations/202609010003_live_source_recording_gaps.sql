-- 2026-09-01 fix: Preserve only known failed source capture windows. Translation
-- remains live; no original text or unobserved whole-call interval is invented.
alter table public.live_media_recording_gaps
  drop constraint if exists live_media_recording_gaps_reason_check;
alter table public.live_media_recording_gaps
  add constraint live_media_recording_gaps_reason_check
  check (reason in ('no_viewers','host_unavailable','media_failed','source_recording_failed'));

create or replace function public.record_live_source_gap_v1(
  p_session_id uuid, p_segment_id uuid, p_started_at timestamptz, p_ended_at timestamptz,
  p_epoch integer default null, p_owner_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  existing_gap public.live_media_recording_gaps%rowtype;
  stored_epoch integer := coalesce(p_epoch, 0);
  inserted_count integer;
begin
  if p_session_id is null or p_segment_id is null or p_started_at is null or p_ended_at is null
    or not isfinite(p_started_at) or not isfinite(p_ended_at)
    or p_started_at > p_ended_at or p_ended_at-p_started_at > interval '60 seconds'
    or p_ended_at > statement_timestamp()+interval '30 seconds'
    or (p_epoch is null) is distinct from (p_owner_id is null)
    or p_epoch < 1
  then raise exception using errcode='P0001', message='INVALID_SOURCE_RECORDING_GAP'; end if;

  -- Session then runtime is the same lock order used by caption/source writers.
  perform 1 from public.live_sessions target where target.id=p_session_id
    and target.status='live' and target.archive_deleted_at is null
    and target.expires_at>statement_timestamp() for update;
  if not found then raise exception using errcode='P0001', message='MEDIA_SESSION_ENDED'; end if;
  if p_epoch is not null then
    perform public.assert_live_media_write_epoch_v1(p_session_id,p_epoch,p_owner_id);
  elsif exists(select 1 from public.live_session_runtime target where target.session_id=p_session_id) then
    raise exception using errcode='P0001', message='MEDIA_WRITE_EPOCH_CONFLICT';
  end if;

  insert into public.live_media_recording_gaps(id,session_id,epoch,started_at,ended_at,reason)
    values(p_segment_id,p_session_id,stored_epoch,p_started_at,p_ended_at,'source_recording_failed')
    on conflict(id) do nothing;
  get diagnostics inserted_count = row_count;
  select * into existing_gap from public.live_media_recording_gaps target where target.id=p_segment_id;
  if existing_gap.session_id is distinct from p_session_id or existing_gap.epoch is distinct from stored_epoch
    or existing_gap.started_at is distinct from p_started_at or existing_gap.ended_at is distinct from p_ended_at
    or existing_gap.reason is distinct from 'source_recording_failed'
  then raise exception using errcode='P0001', message='SOURCE_GAP_IDEMPOTENCY_CONFLICT'; end if;
  return jsonb_build_object('id',existing_gap.id,'sessionId',existing_gap.session_id,
    'startedAt',existing_gap.started_at,'endedAt',existing_gap.ended_at,'reason',existing_gap.reason,
    'idempotent',inserted_count=0);
end;
$$;
revoke all on function public.record_live_source_gap_v1(uuid,uuid,timestamptz,timestamptz,integer,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.record_live_source_gap_v1(uuid,uuid,timestamptz,timestamptz,integer,uuid) to service_role;

-- The same participant authorization and six-hour limit also guard gap recovery.
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
  ) order by source.source_seq),'[]'::jsonb),max(source.source_seq) into source_rows,next_source_seq
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
