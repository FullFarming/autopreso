-- 2026-07-26 fix: Preserve canonical source-lane and utterance identity
-- provenance through both snapshot fallback and utterance-row replay.
--
-- 202607250002 predates the meeting-input `origin` and `utteranceKey` fields.
-- Its exact JSON allowlist therefore rejects those otherwise-valid finalized
-- captions. This migration keeps the already-applied function untouched in
-- history: it moves that implementation behind a private helper, recreates the
-- public RPC as a validating wrapper, and adds nullable row columns plus a new
-- persistence overload for lossless replay.
--
-- Existing rows remain valid with null provenance. Exact identity cannot be
-- backfilled safely, because neither source_text nor timestamps distinguish all
-- repeated utterances. Null therefore explicitly means "legacy/unknown".

alter table public.live_utterances
  add column if not exists origin text,
  add column if not exists utterance_key text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.live_utterances'::regclass
      and conname = 'live_utterances_origin_check'
  ) then
    alter table public.live_utterances
      add constraint live_utterances_origin_check
      check (origin is null or origin = 'source');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.live_utterances'::regclass
      and conname = 'live_utterances_utterance_key_check'
  ) then
    alter table public.live_utterances
      add constraint live_utterances_utterance_key_check
      check (utterance_key is null or (
        char_length(utterance_key) between 1 and 200
        and octet_length(utterance_key) <= 600
        and utterance_key !~ '[[:cntrl:]]'
      ));
  end if;
end;
$$;

comment on column public.live_utterances.origin is
  'Canonical caption provenance. source identifies an untranslated input-lane event; null means translated, non-source, or legacy unknown.';
comment on column public.live_utterances.utterance_key is
  'Gateway-generated identity shared by source and translated events for one utterance. Null on rows recorded before identity provenance.';

-- Keep the already-deployed sanitizer as a private implementation. The public
-- wrapper below removes only the two fields it validates itself, so the exact
-- allowlist and every prior security invariant continue to apply unchanged.
alter function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  rename to persist_live_snapshot_if_active_20260725;

revoke all on function public.persist_live_snapshot_if_active_20260725(uuid, text, jsonb)
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
  stored_event jsonb;
begin
  if p_event is null
    or jsonb_typeof(p_event) <> 'object'
    or (
      p_event ? 'origin'
      and jsonb_typeof(p_event -> 'origin') not in ('string', 'null')
    )
    or (
      jsonb_typeof(p_event -> 'origin') = 'string'
      and p_event ->> 'origin' <> 'source'
    )
    or (
      p_event ? 'utteranceKey'
      and jsonb_typeof(p_event -> 'utteranceKey') not in ('string', 'null')
    )
    or (
      jsonb_typeof(p_event -> 'utteranceKey') = 'string'
      and (
        char_length(p_event ->> 'utteranceKey') not between 1 and 200
        or octet_length(p_event ->> 'utteranceKey') > 600
        or (p_event ->> 'utteranceKey') ~ '[[:cntrl:]]'
      )
    )
  then
    return false;
  end if;

  stored := public.persist_live_snapshot_if_active_20260725(
    p_session_id,
    p_language,
    p_event - array['origin', 'utteranceKey']::text[]
  );
  if not stored then
    return false;
  end if;

  event_seq := (p_event ->> 'seq')::bigint;
  select snapshot_row.captions -> 0
  into stored_event
  from public.live_snapshots snapshot_row
  where snapshot_row.session_id = p_session_id
    and snapshot_row.language = p_language
    and snapshot_row.last_seq = event_seq;

  -- A same-seq retry or an older event may legitimately leave no row to patch.
  -- The delegated function already made the authoritative store/no-store
  -- decision, so provenance remains supplementary and cannot fail the caption.
  if stored_event is null then
    return true;
  end if;
  -- Canonical identity is first-write immutable. A same-seq retry may fill a
  -- legacy/missing field, but it must never replace provenance already stored
  -- for that (session, language, seq). Conflicting retries remain idempotent:
  -- return true while preserving the first accepted value.
  if not (stored_event ? 'origin')
    and jsonb_typeof(p_event -> 'origin') = 'string'
  then
    stored_event := stored_event
      || jsonb_build_object('origin', p_event ->> 'origin');
  end if;
  if not (stored_event ? 'utteranceKey')
    and jsonb_typeof(p_event -> 'utteranceKey') = 'string'
  then
    stored_event := stored_event
      || jsonb_build_object('utteranceKey', p_event ->> 'utteranceKey');
  end if;

  update public.live_snapshots
  set captions = jsonb_build_array(stored_event)
  where session_id = p_session_id
    and language = p_language
    and last_seq = event_seq;
  return true;
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$$;

revoke all on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  to service_role;

-- New overload only; every older caller remains valid. It delegates all
-- caption/session/participant gates to the 202607250001 overload and patches
-- the two supplementary fields onto the row selected by its unique key.
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
  p_utterance_key text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored boolean;
  clean_origin text;
  clean_utterance_key text;
begin
  stored := public.persist_live_utterance_if_active(
    p_session_id, p_language, p_seq, p_text, p_speaker_label, p_speaker_name,
    p_source_started_at, p_source_ended_at, p_emitted_at, p_participant_id,
    p_source_text, p_source_language
  );
  if not stored then
    return false;
  end if;

  clean_origin := case when p_origin = 'source' then 'source' else null end;
  clean_utterance_key := nullif(btrim(coalesce(p_utterance_key, '')), '');
  if clean_utterance_key is not null and (
    char_length(clean_utterance_key) > 200
    or octet_length(clean_utterance_key) > 600
    or clean_utterance_key ~ '[[:cntrl:]]'
  ) then
    clean_utterance_key := null;
  end if;

  if clean_origin is null and clean_utterance_key is null then
    return true;
  end if;
  update public.live_utterances
  -- Existing non-null provenance wins so an idempotent same-seq retry cannot
  -- relabel a committed source or correlate it to a different utterance.
  set origin = coalesce(origin, clean_origin),
      utterance_key = coalesce(utterance_key, clean_utterance_key)
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
  uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz, timestamptz,
  uuid, text, text, text, text
) to service_role;

-- Development verification after applying to a linked development project:
-- 1. Existing rows remain unchanged with origin/utterance_key null.
-- 2. A source final carrying origin:source and utteranceKey returns true; its
--    snapshot and live_utterances row retain both fields.
-- 3. A translated sibling with the same utteranceKey retains the key and null
--    origin, allowing exact cross-lane correlation without text deduplication.
-- 4. Unknown snapshot keys, origin values other than source, control characters,
--    and an utteranceKey over 200 characters return false for the snapshot.
-- 5. anon/authenticated cannot execute either public persistence RPC.
