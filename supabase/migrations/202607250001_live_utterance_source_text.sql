-- 2026-07-25 feat: Record what each speaker actually said alongside the
-- per-language translation, so a viewer reading the meeting in ONE chosen
-- language can still reveal the original for any line (원문보기).
--
-- Why a new column instead of reading the sibling row: live_utterances is keyed
-- (session_id, language, seq) and the source-language row only exists when that
-- language is one of the session's configured languages. An English-only
-- session translating Korean speech therefore had no recoverable original at
-- all. Storing it on the row that needs it removes that dependency.
--
-- Additive only: no column, constraint, overload, or grant is removed. Existing
-- rows keep source_text/source_language null and remain valid.

alter table public.live_utterances
  add column if not exists source_text text,
  add column if not exists source_language text;

do $$
begin
  -- The original is bounded exactly like the translated text it accompanies.
  -- Without this an utterance could carry an arbitrarily large second payload,
  -- doubling every persisted row and every replayed broadcast frame.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.live_utterances'::regclass
      and conname = 'live_utterances_source_text_check'
  ) then
    alter table public.live_utterances
      add constraint live_utterances_source_text_check
      check (source_text is null or (
        char_length(btrim(source_text)) between 1 and 8000
        and octet_length(source_text) <= 24000
      ));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.live_utterances'::regclass
      and conname = 'live_utterances_source_language_check'
  ) then
    alter table public.live_utterances
      add constraint live_utterances_source_language_check
      check (source_language is null or source_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$');
  end if;
end;
$$;

comment on column public.live_utterances.source_text is
  'What the speaker actually said, when text is a translation of it. Null on the source-language row, where text already IS the original.';
comment on column public.live_utterances.source_language is
  'Normalized language the utterance was recognized in, or null when the provider reported none.';

-- Provenance overload. It delegates to the participant-attribution overload so
-- the live/language/seq/byte gates keep living in exactly one place, then
-- patches provenance onto the stored row.
create or replace function public.persist_live_utterance_if_active(
  p_session_id uuid,
  p_language text,
  p_seq bigint,
  p_text text,
  p_speaker_label text,
  p_speaker_name text,
  p_source_started_at timestamptz,
  p_source_ended_at timestamptz,
  p_emitted_at timestamptz,
  p_participant_id uuid,
  p_source_text text,
  p_source_language text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored boolean;
  clean_source_text text;
  clean_source_language text;
begin
  stored := public.persist_live_utterance_if_active(
    p_session_id, p_language, p_seq, p_text, p_speaker_label, p_speaker_name,
    p_source_started_at, p_source_ended_at, p_emitted_at, p_participant_id
  );
  if not stored then
    return stored;
  end if;

  -- Provenance is strictly supplementary: a blank, oversized, or malformed
  -- original degrades to null rather than discarding a caption that is already
  -- persisted and already broadcast.
  clean_source_text := nullif(btrim(coalesce(p_source_text, '')), '');
  if clean_source_text is not null and (
    char_length(clean_source_text) > 8000 or octet_length(clean_source_text) > 24000
  ) then
    clean_source_text := null;
  end if;
  clean_source_language := nullif(btrim(coalesce(p_source_language, '')), '');
  if clean_source_language is not null
    and clean_source_language !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
  then
    clean_source_language := null;
  end if;

  if clean_source_text is null and clean_source_language is null then
    return stored;
  end if;

  update public.live_utterances
  set source_text = coalesce(clean_source_text, source_text),
      source_language = coalesce(clean_source_language, source_language)
  where session_id = p_session_id
    and language = p_language
    and seq = p_seq;
  return stored;
exception
  when check_violation or invalid_text_representation then
    -- The caption row itself is already committed by the delegate; a bad
    -- provenance patch must not turn a recorded utterance into a failure.
    return stored;
end;
$$;

revoke all on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz, timestamptz, uuid, text, text
) to service_role;

-- Development verification after applying to a linked development project:
-- 1. Existing live_utterances rows are unchanged and source_text is null.
-- 2. A translated caption stores both text and source_text; the source-language
--    row stores text with source_text null.
-- 3. Repeating the same (session_id, language, seq) stays idempotent and still
--    returns true.
-- 4. A 30,000-byte p_source_text returns true and leaves source_text null
--    rather than failing the caption.
-- 5. anon/authenticated cannot execute any persist_live_utterance_if_active
--    overload, including this one.
