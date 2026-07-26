-- 2026-07-26 fix: Accept the validated participant marker in caption snapshots.
--
-- Participant SpeakerAssignment objects carry isParticipant:true. The deployed
-- 202607250002 sanitizer intentionally rejects every unknown speaker key, and
-- the 202607260001 provenance wrapper strips only origin/utteranceKey. A valid
-- participant final therefore returned false from the snapshot guard before
-- live fanout and durable utterance persistence, which surfaced as the false
-- SESSION_STOPPED failure while the database session was still live.
--
-- Keep exact unknown-key rejection: this wrapper validates one optional nested
-- boolean, removes only that key before delegating every existing invariant,
-- then restores the validated value onto the stored snapshot event.

alter function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  rename to persist_live_snapshot_if_active_202607260001;

revoke all on function public.persist_live_snapshot_if_active_202607260001(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

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
  stored boolean;
  event_seq bigint;
  participant_marker jsonb;
  stored_event jsonb;
begin
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    return false;
  end if;

  if jsonb_typeof(p_event -> 'speaker') = 'object'
    and (p_event -> 'speaker') ? 'isParticipant'
  then
    participant_marker := p_event -> 'speaker' -> 'isParticipant';
    if jsonb_typeof(participant_marker) <> 'boolean' then
      return false;
    end if;
  end if;

  stored := public.persist_live_snapshot_if_active_202607260001(
    p_session_id,
    p_language,
    p_event #- array['speaker', 'isParticipant']::text[]
  );
  if not stored or participant_marker is null then
    return stored;
  end if;

  event_seq := (p_event ->> 'seq')::bigint;
  select snapshot_row.captions -> 0
  into stored_event
  from public.live_snapshots snapshot_row
  where snapshot_row.session_id = p_session_id
    and snapshot_row.language = p_language
    and snapshot_row.last_seq = event_seq;

  -- Same-seq and older retries may legitimately leave nothing to patch. When
  -- a marker is already present, first-write identity remains immutable.
  if stored_event is null
    or jsonb_typeof(stored_event -> 'speaker') <> 'object'
    or (stored_event -> 'speaker') ? 'isParticipant'
  then
    return true;
  end if;

  stored_event := jsonb_set(
    stored_event,
    array['speaker', 'isParticipant']::text[],
    participant_marker,
    true
  );
  update public.live_snapshots
  set captions = jsonb_build_array(stored_event)
  where session_id = p_session_id
    and language = p_language
    and last_seq = event_seq;
  return true;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$$;

revoke all on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  to service_role;

-- Rollback is application-first. The wrapper and private predecessor are
-- additive function definitions; do not drop either during an incident.
