-- 2026-07-26 fix: Commit the active snapshot guard and full utterance row in
-- one transaction before a finalized caption is delivered.
--
-- The former two-request path could commit live_snapshots, fan out the final,
-- and then lose live_utterances to a timeout. This additive RPC delegates all
-- validation and authorization to the current public wrappers. A stopped or
-- expired session remains the expected false result from the snapshot guard;
-- every utterance or sequence failure raises so PostgreSQL rolls back the
-- snapshot write from the same transaction.

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
  p_translation_status text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  snapshot_stored boolean;
  utterance_stored boolean;
  last_utterance_seq bigint;
begin
  snapshot_stored := public.persist_live_snapshot_if_active(
    p_session_id,
    p_language,
    p_event
  );
  if not snapshot_stored then
    return false;
  end if;

  -- The snapshot validator proved the JSON seq is a positive bigint. Requiring
  -- the explicit utterance argument to match prevents one atomic call from
  -- recording two different identities.
  if (p_event ->> 'seq')::bigint <> p_seq then
    raise exception using
      errcode = 'P0001',
      message = 'LIVE_FINAL_SEQUENCE_MISMATCH';
  end if;

  select max(utterance_row.seq)
  into last_utterance_seq
  from public.live_utterances utterance_row
  where utterance_row.session_id = p_session_id
    and utterance_row.language = p_language;

  -- Same/older seq calls remain idempotent through the delegated unique key.
  -- A new seq may advance by exactly one only. Without this guard, a failed N
  -- followed by successful N+1 would permanently turn one request failure into
  -- a replay hole.
  if p_seq > coalesce(last_utterance_seq, 0) + 1 then
    raise exception using
      errcode = 'P0001',
      message = 'LIVE_FINAL_SEQUENCE_GAP';
  end if;

  utterance_stored := public.persist_live_utterance_if_active(
    p_session_id,
    p_language,
    p_seq,
    p_text,
    p_speaker_label,
    p_speaker_name,
    p_source_started_at,
    p_source_ended_at,
    p_emitted_at,
    p_participant_id,
    p_source_text,
    p_source_language,
    p_origin,
    p_utterance_key,
    p_translation_status
  );
  if not utterance_stored then
    raise exception using
      errcode = 'P0001',
      message = 'LIVE_FINAL_UTTERANCE_PERSIST_FAILED';
  end if;

  return true;
end;
$$;

revoke all on function public.persist_live_final_caption_if_active(
  uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz,
  timestamptz, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.persist_live_final_caption_if_active(
  uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz,
  timestamptz, uuid, text, text, text, text, text
) to service_role;

-- Rollback is application-first: the previous snapshot and utterance RPCs stay
-- available for older binaries. Do not drop this additive combined RPC.
