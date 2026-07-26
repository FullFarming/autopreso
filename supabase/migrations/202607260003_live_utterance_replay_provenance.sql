-- 2026-07-26 fix: Preserve the live translation decision in durable replay.
-- Existing rows remain null and continue through the application reader's
-- legacy source_text-based inference. New rows retain the exact live status so
-- a failed target-language caption cannot reappear as a translation later.

alter table public.live_utterances
  add column if not exists translation_status text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.live_utterances'::regclass
      and conname = 'live_utterances_translation_status_check'
  ) then
    alter table public.live_utterances
      add constraint live_utterances_translation_status_check
      check (translation_status is null or translation_status in ('verbatim', 'translated', 'failed'));
  end if;
end;
$$;

comment on column public.live_utterances.translation_status is
  'Exact live caption translation decision. Null means legacy/unknown and is inferred by readers from existing provenance.';

-- Additive overload: all older callers remain valid. The prior overload keeps
-- ownership, session state, language, size, participant, source, and identity
-- validation in one place; this layer only patches the supplementary status.
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
  stored boolean;
  clean_translation_status text;
begin
  stored := public.persist_live_utterance_if_active(
    p_session_id, p_language, p_seq, p_text, p_speaker_label, p_speaker_name,
    p_source_started_at, p_source_ended_at, p_emitted_at, p_participant_id,
    p_source_text, p_source_language, p_origin, p_utterance_key
  );
  if not stored then
    return false;
  end if;

  clean_translation_status := case
    when p_translation_status in ('verbatim', 'translated', 'failed') then p_translation_status
    else null
  end;
  if clean_translation_status is null then
    return true;
  end if;

  update public.live_utterances
  set translation_status = coalesce(translation_status, clean_translation_status)
  where session_id = p_session_id
    and language = p_language
    and seq = p_seq;
  return true;
exception
  when check_violation or invalid_text_representation then
    return stored;
end;
$$;

revoke all on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz, timestamptz,
  uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz, timestamptz,
  uuid, text, text, text, text, text
) to service_role;

-- Rollback is application-first: older readers ignore this nullable column and
-- older RPC overloads remain available. Do not drop the column or function.
