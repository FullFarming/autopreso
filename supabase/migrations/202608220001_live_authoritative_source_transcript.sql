-- 2026-08-22 feat: Preserve one immutable provider-source transcript before
-- terminology repair, translation, or live fan-out. Source text only: no raw
-- audio is stored. Rows inherit the existing archive lifecycle through their
-- parent session and are physically removed only by the 30-day parent-session purge.

-- ─── Host-configured participant speaking capability ───

alter table public.live_sessions
  add column if not exists participant_speaking_enabled boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.live_sessions'::regclass
      and conname = 'live_sessions_participant_speaking_mode_check'
  ) then
    alter table public.live_sessions
      add constraint live_sessions_participant_speaking_mode_check
      check (participant_speaking_enabled is false or session_type = 'meeting');
  end if;
end;
$$;

comment on column public.live_sessions.participant_speaking_enabled is
  'Host-configured capability. False denies every participant floor request at the database boundary.';

grant select (participant_speaking_enabled) on public.live_sessions to authenticated;

-- ─── Immutable authoritative source transcript ───

create table public.live_source_utterances (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  source_seq bigint not null check (source_seq >= 1),
  utterance_key text not null,
  raw_text text not null,
  normalized_text text not null,
  source_language text not null,
  speaker_role text not null check (speaker_role in ('host', 'participant', 'unknown')),
  speaker_label text,
  speaker_name text,
  speaker_department text,
  speaker_job_title text,
  participant_id uuid references public.live_participants(id) on delete set null,
  source_started_at timestamptz,
  source_ended_at timestamptz not null,
  provider_committed_at timestamptz not null,
  stt_provider text not null,
  stt_model text,
  translation_model text,
  pipeline_config_fingerprint text,
  glossary_fingerprint text,
  created_at timestamptz not null default now(),
  unique (session_id, source_seq),
  unique (session_id, utterance_key),
  constraint live_source_utterances_key_check check (
    char_length(utterance_key) between 1 and 200
    and octet_length(utterance_key) <= 600
    and utterance_key = btrim(utterance_key)
    and utterance_key !~ '[[:cntrl:]<>]'
  ),
  constraint live_source_utterances_raw_text_check check (
    char_length(btrim(raw_text)) between 1 and 8000
    and octet_length(raw_text) <= 24000
  ),
  constraint live_source_utterances_normalized_text_check check (
    char_length(normalized_text) between 1 and 8000
    and octet_length(normalized_text) <= 24000
    and normalized_text = normalize(btrim(normalized_text), NFC)
  ),
  constraint live_source_utterances_language_check check (
    source_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
  ),
  constraint live_source_utterances_speaker_check check (
    (speaker_label is null or (
      char_length(speaker_label) between 1 and 80
      and speaker_label = normalize(btrim(speaker_label), NFC)
      and speaker_label !~ '[[:cntrl:]<>]'
    ))
    and (speaker_name is null or (
      char_length(speaker_name) between 1 and 40
      and speaker_name = normalize(btrim(speaker_name), NFC)
      and speaker_name !~ '[[:cntrl:]<>]'
    ))
    and (speaker_department is null or (
      char_length(speaker_department) between 1 and 80
      and speaker_department = normalize(btrim(speaker_department), NFC)
      and speaker_department !~ '[[:cntrl:]<>]'
    ))
    and (speaker_job_title is null or (
      char_length(speaker_job_title) between 1 and 100
      and speaker_job_title = normalize(btrim(speaker_job_title), NFC)
      and speaker_job_title !~ '[[:cntrl:]<>]'
    ))
    and not (speaker_role in ('host', 'unknown') and participant_id is not null)
  ),
  constraint live_source_utterances_time_check check (
    (source_started_at is null or (
      source_started_at <= source_ended_at
      and source_ended_at - source_started_at <= interval '1 hour'
    ))
    and provider_committed_at >= source_ended_at
  ),
  constraint live_source_utterances_provider_check check (
    stt_provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    and (stt_model is null or (
      char_length(stt_model) between 1 and 120
      and stt_model = btrim(stt_model)
      and stt_model !~ '[[:cntrl:]<>]'
    ))
    and (translation_model is null or (
      char_length(translation_model) between 1 and 120
      and translation_model = btrim(translation_model)
      and translation_model !~ '[[:cntrl:]<>]'
    ))
  ),
  constraint live_source_utterances_fingerprint_check check (
    (pipeline_config_fingerprint is null or pipeline_config_fingerprint ~ '^sha256:[0-9a-f]{64}$')
    and (glossary_fingerprint is null or glossary_fingerprint ~ '^sha256:[0-9a-f]{64}$')
  )
);

create index live_source_utterances_session_time_idx
  on public.live_source_utterances (session_id, source_ended_at, source_seq);

comment on table public.live_source_utterances is
  'Append-only provider-final source transcript. raw_text is never glossary-repaired; normalized_text is the canonical terminology-repaired source.';
comment on column public.live_source_utterances.raw_text is
  'Exact bounded provider-final text as received. It is deliberately not trimmed or normalized on storage.';
comment on column public.live_source_utterances.normalized_text is
  'NFC, trimmed, terminology-repaired source text used by translation and summary.';

create table public.live_source_utterance_corrections (
  id uuid primary key default extensions.gen_random_uuid(),
  source_utterance_id uuid not null references public.live_source_utterances(id) on delete cascade,
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  revision integer not null check (revision >= 1),
  corrected_text text not null,
  reason text,
  actor_host_id text not null check (char_length(actor_host_id) between 1 and 256),
  created_at timestamptz not null default now(),
  unique (source_utterance_id, revision),
  constraint live_source_corrections_text_check check (
    char_length(corrected_text) between 1 and 8000
    and octet_length(corrected_text) <= 24000
    and corrected_text = normalize(btrim(corrected_text), NFC)
  ),
  constraint live_source_corrections_reason_check check (
    reason is null or (
      char_length(reason) between 1 and 500
      and reason = normalize(btrim(reason), NFC)
      and reason !~ '[[:cntrl:]<>]'
    )
  )
);

create index live_source_corrections_session_source_idx
  on public.live_source_utterance_corrections (session_id, source_utterance_id, revision desc);

comment on table public.live_source_utterance_corrections is
  'Append-only host corrections. The immutable raw and normalized source row is never overwritten.';

alter table public.live_source_utterances enable row level security;
alter table public.live_source_utterance_corrections enable row level security;

-- No direct table access, including service_role. SECURITY DEFINER functions
-- below are the only write/read surface, preventing silent UPDATE or DELETE.
revoke all on table public.live_source_utterances
  from public, anon, authenticated, service_role;
revoke all on table public.live_source_utterance_corrections
  from public, anon, authenticated, service_role;

-- ─── Source commit and idempotent sequence allocation ───

create or replace function public.persist_authoritative_live_source_utterance_v1(
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
  p_pipeline_config_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  participant_row public.live_participants%rowtype;
  existing_source public.live_source_utterances%rowtype;
  inserted_source public.live_source_utterances%rowtype;
  next_source_seq bigint;
  clean_key text;
  clean_normalized_text text;
  clean_source_language text;
  clean_speaker_label text;
  clean_speaker_name text;
  clean_speaker_department text;
  clean_speaker_job_title text;
  clean_stt_model text;
  clean_translation_model text;
begin
  clean_key := nullif(btrim(coalesce(p_utterance_key, '')), '');
  clean_normalized_text := nullif(normalize(btrim(coalesce(p_normalized_text, '')), NFC), '');
  clean_source_language := nullif(btrim(coalesce(p_source_language, '')), '');
  clean_speaker_label := nullif(normalize(btrim(coalesce(p_speaker_label, '')), NFC), '');
  clean_speaker_name := nullif(normalize(btrim(coalesce(p_speaker_name, '')), NFC), '');
  clean_speaker_department := nullif(normalize(btrim(coalesce(p_speaker_department, '')), NFC), '');
  clean_speaker_job_title := nullif(normalize(btrim(coalesce(p_speaker_job_title, '')), NFC), '');
  clean_stt_model := nullif(btrim(coalesce(p_stt_model, '')), '');
  clean_translation_model := nullif(btrim(coalesce(p_translation_model, '')), '');

  if p_session_id is null
    or clean_key is null
    or char_length(clean_key) > 200
    or octet_length(clean_key) > 600
    or clean_key ~ '[[:cntrl:]<>]'
    or p_raw_text is null
    or char_length(btrim(p_raw_text)) not between 1 and 8000
    or octet_length(p_raw_text) > 24000
    or clean_normalized_text is null
    or char_length(clean_normalized_text) > 8000
    or octet_length(clean_normalized_text) > 24000
    or clean_source_language is null
    or clean_source_language !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
    or p_speaker_role not in ('host', 'participant', 'unknown')
    or (p_speaker_role = 'participant') <> (p_participant_id is not null)
    or (clean_speaker_label is not null and (
      char_length(clean_speaker_label) > 80 or clean_speaker_label ~ '[[:cntrl:]<>]'
    ))
    or (clean_speaker_name is not null and (
      char_length(clean_speaker_name) > 40 or clean_speaker_name ~ '[[:cntrl:]<>]'
    ))
    or (clean_speaker_department is not null and (
      char_length(clean_speaker_department) > 80 or clean_speaker_department ~ '[[:cntrl:]<>]'
    ))
    or (clean_speaker_job_title is not null and (
      char_length(clean_speaker_job_title) > 100 or clean_speaker_job_title ~ '[[:cntrl:]<>]'
    ))
    or p_source_ended_at is null
    or p_provider_committed_at is null
    or p_provider_committed_at < p_source_ended_at
    or (p_source_started_at is not null and (
      p_source_started_at > p_source_ended_at
      or p_source_ended_at - p_source_started_at > interval '1 hour'
    ))
    or p_stt_provider is null
    or p_stt_provider !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    or (clean_stt_model is not null and (
      char_length(clean_stt_model) > 120 or clean_stt_model ~ '[[:cntrl:]<>]'
    ))
    or (clean_translation_model is not null and (
      char_length(clean_translation_model) > 120 or clean_translation_model ~ '[[:cntrl:]<>]'
    ))
    or (p_pipeline_config_fingerprint is not null
      and p_pipeline_config_fingerprint !~ '^sha256:[0-9a-f]{64}$')
  then
    raise exception using errcode = '22023', message = 'INVALID_AUTHORITATIVE_SOURCE_INPUT';
  end if;

  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.status = 'live'
    and session_row.expires_at > statement_timestamp()
    and session_row.archive_deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'SESSION_NOT_LIVE';
  end if;

  if p_participant_id is not null then
    select * into participant_row
    from public.live_participants participant_row
    where participant_row.id = p_participant_id
      and participant_row.session_id = p_session_id;
    if not found then
      raise exception using errcode = '42501', message = 'PARTICIPANT_SESSION_MISMATCH';
    end if;
    clean_speaker_name := participant_row.display_name;
    clean_speaker_department := participant_row.department;
    clean_speaker_job_title := participant_row.job_title;
  end if;

  select * into existing_source
  from public.live_source_utterances source_row
  where source_row.session_id = p_session_id
    and source_row.utterance_key = clean_key;
  if found then
    if existing_source.raw_text is distinct from p_raw_text
      or existing_source.normalized_text is distinct from clean_normalized_text
      or existing_source.source_language is distinct from clean_source_language
      or existing_source.speaker_role is distinct from p_speaker_role
      or existing_source.speaker_label is distinct from clean_speaker_label
      or existing_source.speaker_name is distinct from clean_speaker_name
      or existing_source.speaker_department is distinct from clean_speaker_department
      or existing_source.speaker_job_title is distinct from clean_speaker_job_title
      or existing_source.participant_id is distinct from p_participant_id
      or existing_source.source_started_at is distinct from p_source_started_at
      or existing_source.source_ended_at is distinct from p_source_ended_at
      or existing_source.provider_committed_at is distinct from p_provider_committed_at
      or existing_source.stt_provider is distinct from p_stt_provider
      or existing_source.stt_model is distinct from clean_stt_model
      or existing_source.translation_model is distinct from clean_translation_model
      or existing_source.pipeline_config_fingerprint is distinct from p_pipeline_config_fingerprint
      or existing_source.glossary_fingerprint is distinct from session_row.pinned_glossary_fingerprint
    then
      raise exception using errcode = 'P0001', message = 'SOURCE_UTTERANCE_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'ok', true,
      'sourceUtteranceId', existing_source.id,
      'sourceSeq', existing_source.source_seq,
      'idempotent', true
    );
  end if;

  select coalesce(max(source_row.source_seq), 0) + 1
  into next_source_seq
  from public.live_source_utterances source_row
  where source_row.session_id = p_session_id;

  insert into public.live_source_utterances (
    session_id, source_seq, utterance_key, raw_text, normalized_text,
    source_language, speaker_role, speaker_label, speaker_name,
    speaker_department, speaker_job_title, participant_id,
    source_started_at, source_ended_at, provider_committed_at,
    stt_provider, stt_model, translation_model, pipeline_config_fingerprint,
    glossary_fingerprint, created_at
  ) values (
    p_session_id, next_source_seq, clean_key, p_raw_text, clean_normalized_text,
    clean_source_language, p_speaker_role, clean_speaker_label, clean_speaker_name,
    clean_speaker_department, clean_speaker_job_title, p_participant_id,
    p_source_started_at, p_source_ended_at, p_provider_committed_at,
    p_stt_provider, clean_stt_model, clean_translation_model,
    p_pipeline_config_fingerprint, session_row.pinned_glossary_fingerprint,
    statement_timestamp()
  ) returning * into inserted_source;

  return jsonb_build_object(
    'ok', true,
    'sourceUtteranceId', inserted_source.id,
    'sourceSeq', inserted_source.source_seq,
    'idempotent', false
  );
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'SOURCE_UTTERANCE_IDEMPOTENCY_CONFLICT';
end;
$$;

-- ─── Additive linkage from language-lane rows ───

alter table public.live_utterances
  add column if not exists authoritative_source_id uuid
    references public.live_source_utterances(id) on delete set null;

create unique index live_utterances_authoritative_source_language_idx
  on public.live_utterances (authoritative_source_id, language)
  where authoritative_source_id is not null;

comment on column public.live_utterances.authoritative_source_id is
  'Nullable for legacy rows. New rows link every language lane to one immutable source record.';

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

  stored := public.persist_live_final_caption_if_active(
    p_session_id, p_language, p_event, p_seq, p_text,
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

-- ─── Append-only host corrections ───

create or replace function public.append_owned_live_source_correction_v1(
  p_host_id text,
  p_session_id uuid,
  p_source_utterance_id uuid,
  p_expected_revision integer,
  p_corrected_text text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  source_row public.live_source_utterances%rowtype;
  current_revision integer;
  inserted_correction public.live_source_utterance_corrections%rowtype;
  clean_text text;
  clean_reason text;
begin
  clean_text := nullif(normalize(btrim(coalesce(p_corrected_text, '')), NFC), '');
  clean_reason := nullif(normalize(btrim(coalesce(p_reason, '')), NFC), '');
  if p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_session_id is null
    or p_source_utterance_id is null
    or p_expected_revision is null
    or p_expected_revision < 0
    or clean_text is null
    or char_length(clean_text) > 8000
    or octet_length(clean_text) > 24000
    or (clean_reason is not null and (
      char_length(clean_reason) > 500 or clean_reason ~ '[[:cntrl:]<>]'
    ))
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SOURCE_CORRECTION';
  end if;

  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.archive_deleted_at is null
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;

  select * into source_row
  from public.live_source_utterances source_row
  where source_row.id = p_source_utterance_id
    and source_row.session_id = p_session_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;

  select coalesce(max(correction_row.revision), 0)
  into current_revision
  from public.live_source_utterance_corrections correction_row
  where correction_row.source_utterance_id = p_source_utterance_id;
  if current_revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'LIVE_SOURCE_CORRECTION_CONFLICT';
  end if;

  insert into public.live_source_utterance_corrections (
    source_utterance_id, session_id, revision, corrected_text, reason,
    actor_host_id, created_at
  ) values (
    p_source_utterance_id, p_session_id, current_revision + 1,
    clean_text, clean_reason, p_host_id, statement_timestamp()
  ) returning * into inserted_correction;

  return jsonb_build_object(
    'ok', true,
    'correctionId', inserted_correction.id,
    'revision', inserted_correction.revision
  );
end;
$$;

-- ─── Controlled host and terminal summary reads ───

create or replace function public.read_owned_authoritative_live_transcript_v1(
  p_host_id text,
  p_session_id uuid,
  p_after_source_seq bigint default 0,
  p_limit integer default 200
)
returns table (
  source_utterance_id uuid,
  source_seq bigint,
  utterance_key text,
  raw_text text,
  normalized_text text,
  effective_text text,
  source_language text,
  speaker_role text,
  speaker_label text,
  speaker_name text,
  speaker_department text,
  speaker_job_title text,
  participant_id uuid,
  source_started_at timestamptz,
  source_ended_at timestamptz,
  provider_committed_at timestamptz,
  stt_provider text,
  stt_model text,
  translation_model text,
  pipeline_config_fingerprint text,
  glossary_fingerprint text,
  correction_revision integer,
  corrected_at timestamptz,
  translations jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_session_id is null
    or p_after_source_seq is null
    or p_after_source_seq < 0
    or p_limit is null
    or p_limit not between 1 and 500
  then
    raise exception using errcode = '22023', message = 'INVALID_AUTHORITATIVE_TRANSCRIPT_READ';
  end if;
  perform 1
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.archive_deleted_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  perform 1
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.status in ('stopped', 'failed')
    and coalesce(session_row.ended_at, session_row.archived_at) is not null;
  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_TRANSCRIPT_NOT_READY';
  end if;

  return query
  select
    source_row.id,
    source_row.source_seq,
    source_row.utterance_key,
    source_row.raw_text,
    source_row.normalized_text,
    coalesce(latest_correction.corrected_text, source_row.normalized_text),
    source_row.source_language,
    source_row.speaker_role,
    source_row.speaker_label,
    source_row.speaker_name,
    source_row.speaker_department,
    source_row.speaker_job_title,
    source_row.participant_id,
    source_row.source_started_at,
    source_row.source_ended_at,
    source_row.provider_committed_at,
    source_row.stt_provider,
    source_row.stt_model,
    source_row.translation_model,
    source_row.pipeline_config_fingerprint,
    source_row.glossary_fingerprint,
    coalesce(latest_correction.revision, 0),
    latest_correction.created_at,
    coalesce(linked_translations.translations, '[]'::jsonb)
  from public.live_source_utterances source_row
  left join lateral (
    select correction_row.revision, correction_row.corrected_text, correction_row.created_at
    from public.live_source_utterance_corrections correction_row
    where correction_row.source_utterance_id = source_row.id
    order by correction_row.revision desc
    limit 1
  ) latest_correction on true
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'language', utterance_row.language,
        'seq', utterance_row.seq,
        'text', utterance_row.text,
        'translationStatus', utterance_row.translation_status,
        'emittedAt', utterance_row.emitted_at
      ) order by utterance_row.language
    ) as translations
    from public.live_utterances utterance_row
    where utterance_row.authoritative_source_id = source_row.id
  ) linked_translations on true
  where source_row.session_id = p_session_id
    and source_row.source_seq > p_after_source_seq
  order by source_row.source_seq
  limit p_limit;
end;
$$;

create or replace function public.read_authoritative_live_summary_input_v1(
  p_session_id uuid,
  p_after_source_seq bigint default 0,
  p_limit integer default 500
)
returns table (
  source_seq bigint,
  effective_text text,
  source_language text,
  speaker_name text,
  source_started_at timestamptz,
  source_ended_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_session_id is null
    or p_after_source_seq is null
    or p_after_source_seq < 0
    or p_limit is null
    or p_limit not between 1 and 1000
  then
    raise exception using errcode = '22023', message = 'INVALID_AUTHORITATIVE_SUMMARY_READ';
  end if;
  perform 1
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.status in ('stopped', 'failed')
    and coalesce(session_row.ended_at, session_row.archived_at) is not null
    and session_row.archive_deleted_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_NOT_TERMINAL';
  end if;

  return query
  select
    source_row.source_seq,
    coalesce(latest_correction.corrected_text, source_row.normalized_text),
    source_row.source_language,
    source_row.speaker_name,
    source_row.source_started_at,
    source_row.source_ended_at
  from public.live_source_utterances source_row
  left join lateral (
    select correction_row.corrected_text
    from public.live_source_utterance_corrections correction_row
    where correction_row.source_utterance_id = source_row.id
    order by correction_row.revision desc
    limit 1
  ) latest_correction on true
  where source_row.session_id = p_session_id
    and source_row.source_seq > p_after_source_seq
  order by source_row.source_seq
  limit p_limit;
end;
$$;

-- ─── Participant speaking authorization ───

create or replace function public.authorize_live_participant_speaking_v1(
  p_session_id uuid,
  p_grant_id uuid,
  p_user_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_session_id is not null
    and p_grant_id is not null
    and p_user_id is not null
    and char_length(p_user_id) between 1 and 256
    and exists (
      select 1
      from public.live_sessions session_row
      join public.viewer_grants grant_row
        on grant_row.session_id = session_row.id
       and grant_row.id = p_grant_id
       and grant_row.user_id = p_user_id
       and grant_row.revoked_at is null
       and grant_row.expires_at > statement_timestamp()
      join public.live_participants participant_row
        on participant_row.session_id = session_row.id
       and participant_row.grant_id = grant_row.id
       and participant_row.user_id = grant_row.user_id
      where session_row.id = p_session_id
        and session_row.participant_speaking_enabled is true
        and session_row.status = 'live'
        and session_row.expires_at > statement_timestamp()
        and session_row.archive_deleted_at is null
    );
$$;

create or replace function public.take_live_floor(p_session_id uuid, p_grant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  grant_row public.viewer_grants%rowtype;
  participant_row public.live_participants%rowtype;
begin
  select * into session_row
  from public.live_sessions
  where id = p_session_id
    and expires_at > statement_timestamp()
    and archive_deleted_at is null
  for update;
  if not found or session_row.status <> 'live' then
    return jsonb_build_object('ok', false, 'code', 'SESSION_NOT_LIVE');
  end if;
  if session_row.participant_speaking_enabled is not true then
    return jsonb_build_object('ok', false, 'code', 'PARTICIPANT_SPEAKING_DISABLED');
  end if;

  select * into grant_row
  from public.viewer_grants
  where id = p_grant_id
    and session_id = p_session_id
    and revoked_at is null
    and expires_at > statement_timestamp()
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'GRANT_INVALID');
  end if;

  if session_row.floor_grant_id is not null
    and session_row.floor_grant_id <> p_grant_id
  then
    select * into participant_row
    from public.live_participants
    where session_id = p_session_id
      and grant_id = session_row.floor_grant_id;
    if found then
      insert into public.live_participant_events (
        participant_id, session_id, event_type, occurred_at
      ) values (
        participant_row.id, p_session_id, 'speak_ended', statement_timestamp()
      );
    end if;
  end if;

  select * into participant_row
  from public.live_participants
  where session_id = p_session_id and grant_id = p_grant_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'PARTICIPANT_REQUIRED');
  end if;

  update public.live_participants
  set last_spoke_at = statement_timestamp(),
      last_seen_at = greatest(last_seen_at, statement_timestamp())
  where id = participant_row.id;
  if session_row.floor_grant_id is distinct from p_grant_id then
    insert into public.live_participant_events (
      participant_id, session_id, event_type, occurred_at
    ) values (
      participant_row.id, p_session_id, 'speak_started', statement_timestamp()
    );
  end if;

  update public.live_sessions
  set floor_grant_id = p_grant_id,
      floor_display_name = coalesce(grant_row.display_name, 'Participant'),
      floor_taken_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where id = p_session_id;

  return jsonb_build_object(
    'ok', true,
    'displayName', coalesce(grant_row.display_name, 'Participant'),
    'participantId', participant_row.id,
    'previousGrantId', session_row.floor_grant_id,
    'previousDisplayName', session_row.floor_display_name
  );
end;
$$;

-- Versioned projections keep every deployed legacy signature callable while
-- making the capability explicit to new host and participant clients.
create or replace function public.create_live_session_with_event_v2(
  p_session_id uuid,
  p_host_id text,
  p_session_type text,
  p_output_mode text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text,
  p_voice_provider text,
  p_title text,
  p_scheduled_at timestamptz,
  p_expires_at timestamptz,
  p_event_company_name text,
  p_event_reporting_period text,
  p_event_metadata jsonb,
  p_participant_speaking_enabled boolean
)
returns table (
  id uuid,
  host_id text,
  session_type text,
  output_mode text,
  status text,
  languages text[],
  viewer_count integer,
  max_viewers integer,
  version integer,
  glossary_pack text,
  voice_provider text,
  title text,
  scheduled_at timestamptz,
  admission_open_until timestamptz,
  expires_at timestamptz,
  event_company_name text,
  event_reporting_period text,
  event_metadata jsonb,
  participant_speaking_enabled boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_session record;
begin
  if p_participant_speaking_enabled is null
    or (p_participant_speaking_enabled and p_session_type <> 'meeting')
  then
    raise exception using errcode = '22023', message = 'INVALID_PARTICIPANT_SPEAKING_CONFIGURATION';
  end if;

  select * into created_session
  from public.create_live_session_with_event_v1(
    p_session_id, p_host_id, p_session_type, p_output_mode, p_languages,
    p_max_viewers, p_glossary_pack, p_voice_provider, p_title,
    p_scheduled_at, p_expires_at, p_event_company_name,
    p_event_reporting_period, p_event_metadata
  );

  update public.live_sessions session_row
  set participant_speaking_enabled = p_participant_speaking_enabled
  where session_row.id = created_session.id;

  return query select
    created_session.id,
    created_session.host_id,
    created_session.session_type,
    created_session.output_mode,
    created_session.status,
    created_session.languages,
    created_session.viewer_count,
    created_session.max_viewers,
    created_session.version,
    created_session.glossary_pack,
    created_session.voice_provider,
    created_session.title,
    created_session.scheduled_at,
    created_session.admission_open_until,
    created_session.expires_at,
    created_session.event_company_name,
    created_session.event_reporting_period,
    created_session.event_metadata,
    p_participant_speaking_enabled;
end;
$$;

create or replace function public.update_live_session_with_event_v2(
  p_session_id uuid,
  p_host_id text,
  p_expected_version integer,
  p_session_type text,
  p_output_mode text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text,
  p_voice_provider text,
  p_title text,
  p_scheduled_at timestamptz,
  p_event_company_name text,
  p_event_reporting_period text,
  p_event_metadata jsonb,
  p_participant_speaking_enabled boolean
)
returns table (
  id uuid,
  host_id text,
  session_type text,
  output_mode text,
  status text,
  languages text[],
  viewer_count integer,
  max_viewers integer,
  version integer,
  glossary_pack text,
  voice_provider text,
  title text,
  scheduled_at timestamptz,
  admission_open_until timestamptz,
  expires_at timestamptz,
  event_company_name text,
  event_reporting_period text,
  event_metadata jsonb,
  participant_speaking_enabled boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_session record;
  previous_speaking_enabled boolean;
begin
  if p_participant_speaking_enabled is null
    or (p_participant_speaking_enabled and p_session_type <> 'meeting')
  then
    raise exception using errcode = '22023', message = 'INVALID_PARTICIPANT_SPEAKING_CONFIGURATION';
  end if;

  -- The CHECK is immediate. A valid meeting(true) -> presentation(false)
  -- transition must clear the capability before v1 changes session_type, but
  -- only after the exact owner/version row is locked. If v1 returns no row for
  -- another guard (viewer count or scheduling), restore the previous value.
  select session_row.participant_speaking_enabled
  into previous_speaking_enabled
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.version = p_expected_version
    and session_row.status = 'preparing'
    and session_row.expires_at > statement_timestamp()
  for update;
  if not found then
    return;
  end if;
  if previous_speaking_enabled and not p_participant_speaking_enabled then
    update public.live_sessions session_row
    set participant_speaking_enabled = false
    where session_row.id = p_session_id
      and session_row.host_id = p_host_id
      and session_row.version = p_expected_version;
  end if;

  select * into updated_session
  from public.update_live_session_with_event_v1(
    p_session_id, p_host_id, p_expected_version, p_session_type,
    p_output_mode, p_languages, p_max_viewers, p_glossary_pack,
    p_voice_provider, p_title, p_scheduled_at, p_event_company_name,
    p_event_reporting_period, p_event_metadata
  );
  if not found then
    update public.live_sessions session_row
    set participant_speaking_enabled = previous_speaking_enabled
    where session_row.id = p_session_id
      and session_row.host_id = p_host_id
      and session_row.version = p_expected_version;
    return;
  end if;

  update public.live_sessions session_row
  set participant_speaking_enabled = p_participant_speaking_enabled
  where session_row.id = updated_session.id;

  return query select
    updated_session.id,
    updated_session.host_id,
    updated_session.session_type,
    updated_session.output_mode,
    updated_session.status,
    updated_session.languages,
    updated_session.viewer_count,
    updated_session.max_viewers,
    updated_session.version,
    updated_session.glossary_pack,
    updated_session.voice_provider,
    updated_session.title,
    updated_session.scheduled_at,
    updated_session.admission_open_until,
    updated_session.expires_at,
    updated_session.event_company_name,
    updated_session.event_reporting_period,
    updated_session.event_metadata,
    p_participant_speaking_enabled;
end;
$$;

create or replace function public.redeem_live_attendee_v3(
  p_invite_token_hmac text,
  p_code_hmac text,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_email text,
  p_display_name text,
  p_company text,
  p_department text,
  p_job_title text,
  p_privacy_consent boolean,
  p_privacy_notice_version text,
  p_summary_consent boolean,
  p_summary_delivery_notice_version text,
  p_marketing_consent boolean,
  p_marketing_notice_version text
)
returns table (
  grant_id uuid,
  session_id uuid,
  user_id text,
  grant_expires_at timestamptz,
  session_type text,
  output_mode text,
  languages text[],
  session_expires_at timestamptz,
  viewer_count integer,
  max_viewers integer,
  glossary_pack text,
  display_name text,
  email text,
  company text,
  department text,
  job_title text,
  summary_consent_at timestamptz,
  participant_id uuid,
  voice_provider text,
  status text,
  title text,
  scheduled_at timestamptz,
  participant_speaking_enabled boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  attendee_row record;
  speaking_enabled boolean;
  clean_display_name text;
begin
  clean_display_name := nullif(normalize(btrim(coalesce(p_display_name, '')), NFC), '');
  if clean_display_name is null
    or char_length(clean_display_name) > 40
    or clean_display_name ~ '[[:cntrl:]<>]'
  then
    raise exception using errcode = '22023', message = 'INVALID_ATTENDEE_DISPLAY_NAME';
  end if;

  select * into attendee_row
  from public.redeem_live_attendee_v2(
    p_invite_token_hmac, p_code_hmac, p_user_id, p_device_hash,
    p_grant_expires_at, p_email, p_company, p_department, p_job_title,
    p_privacy_consent, p_privacy_notice_version, p_summary_consent,
    p_summary_delivery_notice_version, p_marketing_consent,
    p_marketing_notice_version
  );
  update public.viewer_grants grant_row
  set display_name = clean_display_name
  where grant_row.id = attendee_row.grant_id
    and grant_row.session_id = attendee_row.session_id;
  update public.live_participants participant_row
  set display_name = clean_display_name
  where participant_row.id = attendee_row.participant_id
    and participant_row.session_id = attendee_row.session_id;
  select session_row.participant_speaking_enabled into speaking_enabled
  from public.live_sessions session_row
  where session_row.id = attendee_row.session_id;

  return query select
    attendee_row.grant_id,
    attendee_row.session_id,
    attendee_row.user_id,
    attendee_row.grant_expires_at,
    attendee_row.session_type,
    attendee_row.output_mode,
    attendee_row.languages,
    attendee_row.session_expires_at,
    attendee_row.viewer_count,
    attendee_row.max_viewers,
    attendee_row.glossary_pack,
    clean_display_name,
    attendee_row.email,
    attendee_row.company,
    attendee_row.department,
    attendee_row.job_title,
    attendee_row.summary_consent_at,
    attendee_row.participant_id,
    attendee_row.voice_provider,
    attendee_row.status,
    attendee_row.title,
    attendee_row.scheduled_at,
    coalesce(speaking_enabled, false);
end;
$$;

create or replace function public.restore_live_attendee_v2(
  p_grant_id uuid,
  p_session_id uuid,
  p_user_id text
)
returns table (
  grant_id uuid,
  session_id uuid,
  user_id text,
  grant_expires_at timestamptz,
  session_type text,
  output_mode text,
  languages text[],
  session_expires_at timestamptz,
  viewer_count integer,
  max_viewers integer,
  glossary_pack text,
  display_name text,
  email text,
  company text,
  department text,
  job_title text,
  summary_consent_at timestamptz,
  participant_id uuid,
  voice_provider text,
  status text,
  title text,
  scheduled_at timestamptz,
  participant_speaking_enabled boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  attendee_row record;
  speaking_enabled boolean;
begin
  select * into attendee_row
  from public.restore_live_attendee_v1(p_grant_id, p_session_id, p_user_id);
  select session_row.participant_speaking_enabled into speaking_enabled
  from public.live_sessions session_row
  where session_row.id = attendee_row.session_id;

  return query select
    attendee_row.grant_id,
    attendee_row.session_id,
    attendee_row.user_id,
    attendee_row.grant_expires_at,
    attendee_row.session_type,
    attendee_row.output_mode,
    attendee_row.languages,
    attendee_row.session_expires_at,
    attendee_row.viewer_count,
    attendee_row.max_viewers,
    attendee_row.glossary_pack,
    attendee_row.display_name,
    attendee_row.email,
    attendee_row.company,
    attendee_row.department,
    attendee_row.job_title,
    attendee_row.summary_consent_at,
    attendee_row.participant_id,
    attendee_row.voice_provider,
    attendee_row.status,
    attendee_row.title,
    attendee_row.scheduled_at,
    coalesce(speaking_enabled, false);
end;
$$;

create or replace function public.authorize_live_viewer_grants_v2(p_requests jsonb)
returns table (
  session_id uuid,
  grant_id uuid,
  user_id text,
  language text,
  authorized boolean,
  participant_speaking_enabled boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with authorized_rows as materialized (
    select
      row_number() over () as request_ordinal,
      authorization_row.*
    from public.authorize_live_viewer_grants_v1(p_requests) authorization_row
  )
  select
    authorization_row.session_id,
    authorization_row.grant_id,
    authorization_row.user_id,
    authorization_row.language,
    authorization_row.authorized,
    case when authorization_row.authorized
      then coalesce(session_row.participant_speaking_enabled, false)
      else false
    end
  from authorized_rows authorization_row
  left join public.live_sessions session_row
    on session_row.id = authorization_row.session_id
  order by authorization_row.request_ordinal;
$$;

create or replace function public.read_owned_live_record_v2(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  title text,
  status text,
  session_type text,
  output_mode text,
  languages text[],
  created_at timestamptz,
  scheduled_at timestamptz,
  ended_at timestamptz,
  archived_at timestamptz,
  participant_count bigint,
  utterance_count bigint,
  topic_count bigint,
  summary_state text,
  sheet_sync_state text,
  sheet_error_code text,
  sheet_id integer,
  session_index_row integer,
  tab_title text,
  projection_version bigint,
  last_exported_projection_version bigint,
  last_exported_participant_count integer,
  participant_speaking_enabled boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    record_row.session_id,
    record_row.title,
    record_row.status,
    record_row.session_type,
    record_row.output_mode,
    record_row.languages,
    record_row.created_at,
    record_row.scheduled_at,
    record_row.ended_at,
    record_row.archived_at,
    record_row.participant_count,
    record_row.utterance_count,
    record_row.topic_count,
    record_row.summary_state,
    record_row.sheet_sync_state,
    record_row.sheet_error_code,
    record_row.sheet_id,
    record_row.session_index_row,
    record_row.tab_title,
    record_row.projection_version,
    record_row.last_exported_projection_version,
    record_row.last_exported_participant_count,
    session_row.participant_speaking_enabled
  from public.read_owned_live_record_v1(p_host_id, p_session_id) record_row
  join public.live_sessions session_row on session_row.id = record_row.session_id;
$$;

-- ─── Least-privilege execution grants ───

revoke all on function public.persist_authoritative_live_source_utterance_v1(
  uuid, text, text, text, text, text, text, text, text, text, uuid,
  timestamptz, timestamptz, timestamptz, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.persist_live_final_caption_if_active(
  uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz,
  timestamptz, uuid, text, text, text, text, text, uuid
) from public, anon, authenticated;
revoke all on function public.append_owned_live_source_correction_v1(
  text, uuid, uuid, integer, text, text
) from public, anon, authenticated;
revoke all on function public.read_owned_authoritative_live_transcript_v1(
  text, uuid, bigint, integer
) from public, anon, authenticated;
revoke all on function public.read_authoritative_live_summary_input_v1(
  uuid, bigint, integer
) from public, anon, authenticated;
revoke all on function public.authorize_live_participant_speaking_v1(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.take_live_floor(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.create_live_session_with_event_v2(
  uuid, text, text, text, text[], integer, text, text, text, timestamptz,
  timestamptz, text, text, jsonb, boolean
) from public, anon, authenticated;
revoke all on function public.update_live_session_with_event_v2(
  uuid, text, integer, text, text, text[], integer, text, text, text,
  timestamptz, text, text, jsonb, boolean
) from public, anon, authenticated;
revoke all on function public.redeem_live_attendee_v3(
  text, text, text, text, timestamptz, text, text, text, text, text,
  boolean, text, boolean, text, boolean, text
) from public, anon, authenticated;
revoke all on function public.restore_live_attendee_v2(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.authorize_live_viewer_grants_v2(jsonb)
  from public, anon, authenticated;
revoke all on function public.read_owned_live_record_v2(text, uuid)
  from public, anon, authenticated;

grant execute on function public.persist_authoritative_live_source_utterance_v1(
  uuid, text, text, text, text, text, text, text, text, text, uuid,
  timestamptz, timestamptz, timestamptz, text, text, text, text
) to service_role;
grant execute on function public.persist_live_final_caption_if_active(
  uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz,
  timestamptz, uuid, text, text, text, text, text, uuid
) to service_role;
grant execute on function public.append_owned_live_source_correction_v1(
  text, uuid, uuid, integer, text, text
) to service_role;
grant execute on function public.read_owned_authoritative_live_transcript_v1(
  text, uuid, bigint, integer
) to service_role;
grant execute on function public.read_authoritative_live_summary_input_v1(
  uuid, bigint, integer
) to service_role;
grant execute on function public.authorize_live_participant_speaking_v1(uuid, uuid, text)
  to service_role;
grant execute on function public.take_live_floor(uuid, uuid)
  to service_role;
grant execute on function public.create_live_session_with_event_v2(
  uuid, text, text, text, text[], integer, text, text, text, timestamptz,
  timestamptz, text, text, jsonb, boolean
) to service_role;
grant execute on function public.update_live_session_with_event_v2(
  uuid, text, integer, text, text, text[], integer, text, text, text,
  timestamptz, text, text, jsonb, boolean
) to service_role;
grant execute on function public.redeem_live_attendee_v3(
  text, text, text, text, timestamptz, text, text, text, text, text,
  boolean, text, boolean, text, boolean, text
) to service_role;
grant execute on function public.restore_live_attendee_v2(uuid, uuid, text)
  to service_role;
grant execute on function public.authorize_live_viewer_grants_v2(jsonb)
  to service_role;
grant execute on function public.read_owned_live_record_v2(text, uuid)
  to service_role;

-- ─── Recoverable archive purge schedule ───

create extension if not exists pg_cron;

do $archive_purge_schedule$
declare
  purge_job_id bigint;
begin
  if to_regnamespace('cron') is null
    or to_regclass('cron.job') is null
    or to_regprocedure('cron.schedule(text,text,text)') is null
  then
    raise exception using errcode = 'P0001', message = 'LIVE_ARCHIVE_PURGE_CRON_UNAVAILABLE';
  end if;
  if to_regprocedure('public.purge_live_session_archives_v1(integer)') is null then
    raise exception using errcode = 'P0001', message = 'LIVE_ARCHIVE_PURGE_FUNCTION_UNAVAILABLE';
  end if;
  if not has_function_privilege(
    current_user,
    'cron.schedule(text,text,text)',
    'EXECUTE'
  ) then
    raise exception using errcode = '42501', message = 'LIVE_ARCHIVE_PURGE_CRON_FORBIDDEN';
  end if;

  -- The named pg_cron call is an atomic upsert. It cannot replace unrelated
  -- jobs and the existing purge RPC itself selects only soft-deleted rows whose
  -- 30-day archive_purge_after boundary has elapsed, in a locked batch of 50.
  purge_job_id := cron.schedule(
    'realtime-noel-live-archive-purge',
    '13 * * * *',
    'select public.purge_live_session_archives_v1(50);'
  );

  if purge_job_id is null
    or not exists (
      select 1
      from cron.job job_row
      where job_row.jobid = purge_job_id
        and job_row.jobname = 'realtime-noel-live-archive-purge'
        and btrim(job_row.schedule) = '13 * * * *'
        and btrim(job_row.command) = 'select public.purge_live_session_archives_v1(50);'
        and job_row.active is true
    )
  then
    raise exception using errcode = 'P0001', message = 'LIVE_ARCHIVE_PURGE_CRON_NOT_READY';
  end if;
end;
$archive_purge_schedule$;

-- Development verification after applying this migration manually:
-- 1. A live session commit returns sourceSeq=1; an exact utterance-key retry
--    returns the same UUID/seq with idempotent=true and adds no row.
-- 2. Retrying that key with different raw_text raises
--    SOURCE_UTTERANCE_IDEMPOTENCY_CONFLICT.
-- 3. Two concurrent distinct commits serialize on live_sessions and receive
--    consecutive sourceSeq values with no duplicate or hole.
-- 4. anon/authenticated and direct service_role table reads/writes fail; the
--    narrowly granted SECURITY DEFINER RPCs succeed.
-- 5. A host cannot read or correct another host's session; a soft-deleted
--    archive is hidden immediately and its child rows remain during recovery.
-- 6. purge_live_session_archives_v1 removes the parent after 30 days and its
--    authoritative children cascade. There is no independent transcript TTL.
-- 7. take_live_floor returns PARTICIPANT_SPEAKING_DISABLED while the flag is
--    false and never changes floor or participant-event state.
--
-- Rollback is application-first: route callers back to legacy RPCs. Keep this
-- additive schema in place through one full release cycle; do not drop tables,
-- columns, indexes, or overloads in an emergency rollback.
