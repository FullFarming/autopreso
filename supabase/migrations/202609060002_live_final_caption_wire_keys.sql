-- 2026-09-06 forward repair (Live Call captions not recorded). The gateway's durable caption
-- event includes two wire-only provenance keys, `authoritativeSourceId` and `sourceSequence`,
-- that the base snapshot validator does not allow, so persist_live_snapshot_if_active returned
-- false and the atomic final never stored (source rows persisted, captions and snapshots did
-- not). The 17-argument persist_live_final_caption_if_active already receives the link as
-- p_authoritative_source_id; it now strips the two keys from p_event before delegating. Body is
-- otherwise identical to 202609060001. Additive, re-runnable.

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

  -- 2026-09-06: the caption wire event carries authoritativeSourceId/sourceSequence for
  -- viewers, but the snapshot validator (persist_live_snapshot_if_active_20260725) allows only
  -- its own key set and returns false for anything else. The link is this function's own
  -- p_authoritative_source_id; strip the wire-only keys so the durable snapshot stores.
  stored := public.persist_live_final_caption_if_active(
    p_session_id, p_language, p_event - array['authoritativeSourceId', 'sourceSequence']::text[], p_seq, p_text,
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
