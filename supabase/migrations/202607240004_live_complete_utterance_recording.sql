-- 2026-07-24 fix: Preserve every valid finalized caption for the bounded
-- six-hour live session. The previous 5,000-row language gate returned false
-- without persisting, while the gateway deliberately continued broadcasting.
-- The writer remains service-role-only, input bytes remain bounded, and the
-- existing (session_id, language, seq) uniqueness keeps retries idempotent.

create or replace function public.persist_live_utterance_if_active(
  p_session_id uuid,
  p_language text,
  p_seq bigint,
  p_text text,
  p_speaker_label text,
  p_speaker_name text,
  p_source_ended_at timestamptz,
  p_emitted_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_status text;
  session_languages text[];
begin
  select session_row.status, session_row.languages
  into session_status, session_languages
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.expires_at > statement_timestamp()
  for update;

  if not found
    or session_status <> 'live'
    or p_language is null
    or not (p_language = any(session_languages))
    or p_seq is null or p_seq < 1
    or p_text is null or char_length(btrim(p_text)) not between 1 and 8000
    or octet_length(p_text) > 24000
    or p_source_ended_at is null or p_emitted_at is null
  then
    return false;
  end if;

  insert into public.live_utterances (
    session_id, language, seq, speaker_label, speaker_name, text, source_ended_at, emitted_at
  ) values (
    p_session_id, p_language, p_seq,
    nullif(btrim(coalesce(p_speaker_label, '')), ''),
    nullif(btrim(coalesce(p_speaker_name, '')), ''),
    btrim(p_text), p_source_ended_at, p_emitted_at
  )
  on conflict (session_id, language, seq) do nothing;
  return true;
exception
  when check_violation or invalid_text_representation then
    return false;
end;
$$;

revoke all on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz
) to service_role;

-- Development verification after applying to a linked development project:
-- 1. Existing live_utterances rows remain unchanged.
-- 2. A valid row with seq > 5,000 persists and returns true.
-- 3. Repeating that seq returns true without adding a duplicate.
-- 4. anon/authenticated cannot execute either utterance persistence overload.
