-- 2026-09-01 feat: Read the canonical original ledger from the host live view.
-- New read-only owner RPC; no table grants, participant policies or terminal
-- audit RPCs change. Paging, corrections and known gaps share one SQL snapshot.

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
  ) order by source.source_seq),'[]'::jsonb),max(source.source_seq) into source_rows,next_source_seq
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
