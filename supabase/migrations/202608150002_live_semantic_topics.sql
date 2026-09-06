-- Phase 2 live semantic topic persistence.
-- Additive only: durable captions remain the source of truth.

create table if not exists public.live_topics (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  ordinal integer not null check (ordinal between 1 and 1000),
  status text not null default 'active',
  title text not null default 'Live topic',
  summary text,
  completion_reason text,
  detector_health text not null default 'healthy',
  version integer not null default 1,
  started_at timestamptz not null default statement_timestamp(),
  last_activity_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (session_id, ordinal),
  constraint live_topics_status_check check (status in ('active', 'completed')),
  constraint live_topics_title_plain_check check (
    char_length(title) between 1 and 120
    and title = normalize(btrim(title), NFC)
    and title !~ '[[:cntrl:]]'
    and title !~ '[<>]'
    and translate(title, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') = title
  ),
  constraint live_topics_summary_plain_check check (
    summary is null
    or (
      char_length(summary) between 1 and 500
      and summary = normalize(btrim(summary), NFC)
      and summary !~ '[[:cntrl:]]'
      and summary !~ '[<>]'
      and translate(summary, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') = summary
    )
  ),
  constraint live_topics_completion_reason_check check (
    completion_reason is null
    or completion_reason in ('silence', 'semantic_shift', 'session_end')
  ),
  constraint live_topics_detector_health_check check (
    detector_health in ('healthy', 'degraded')
  ),
  constraint live_topics_version_check check (version > 0),
  constraint live_topics_completed_shape_check check (
    (
      status = 'active'
      and completion_reason is null
      and completed_at is null
    )
    or (
      status = 'completed'
      and completion_reason is not null
      and completed_at is not null
    )
  )
);

create unique index if not exists live_topics_one_active_partial_idx
  on public.live_topics (session_id)
  where status = 'active';

create index if not exists live_topics_session_status_ordinal_idx
  on public.live_topics (session_id, status, ordinal);

create table if not exists public.live_topic_utterances (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  utterance_key text not null,
  topic_id uuid not null references public.live_topics(id) on delete cascade,
  position integer not null check (position between 1 and 10000),
  source_seq bigint not null check (source_seq > 0),
  source_language text not null,
  assigned_at timestamptz not null default statement_timestamp(),
  primary key (session_id, utterance_key),
  unique (topic_id, position),
  constraint live_topic_utterances_key_check check (
    char_length(utterance_key) between 1 and 256
    and octet_length(utterance_key) <= 768
    and utterance_key = normalize(btrim(utterance_key), NFC)
    and utterance_key !~ '[[:cntrl:]]'
    and utterance_key !~ '[<>]'
    and translate(utterance_key, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') = utterance_key
  )
);

create index if not exists live_topic_utterances_topic_position_idx
  on public.live_topic_utterances (topic_id, position);

create index if not exists live_topic_utterances_session_seq_idx
  on public.live_topic_utterances (session_id, source_language, source_seq);


create table if not exists public.live_topic_processed_utterances (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  utterance_key text not null,
  source_seq bigint not null check (source_seq > 0),
  source_language text not null,
  processed_reason text not null default 'not_meaningful',
  processed_at timestamptz not null default statement_timestamp(),
  primary key (session_id, utterance_key),
  constraint live_topic_processed_utterances_reason_check check (processed_reason in ('not_meaningful')),
  constraint live_topic_processed_utterances_key_check check (
    char_length(utterance_key) between 1 and 256
    and octet_length(utterance_key) <= 768
    and utterance_key = normalize(btrim(utterance_key), NFC)
    and utterance_key !~ '[[:cntrl:]]'
    and utterance_key !~ '[<>]'
    and translate(utterance_key, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') = utterance_key
  )
);

create index if not exists live_topic_processed_utterances_session_seq_idx
  on public.live_topic_processed_utterances (session_id, source_language, source_seq);

alter table public.live_topics enable row level security;
alter table public.live_topic_utterances enable row level security;
alter table public.live_topic_processed_utterances enable row level security;

revoke all on table public.live_topics from public, anon, authenticated;
revoke all on table public.live_topic_utterances from public, anon, authenticated;
revoke all on table public.live_topic_processed_utterances from public, anon, authenticated;
grant select, insert, update, delete on table public.live_topics to service_role;
grant select, insert, update, delete on table public.live_topic_utterances to service_role;
grant select, insert, update, delete on table public.live_topic_processed_utterances to service_role;

create or replace function public.read_live_topic_context(
  p_session_id uuid,
  p_language text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  clean_language text := lower(btrim(coalesce(p_language, '')));
  topic_payload jsonb;
  topic_membership_payload jsonb;
  latest_source_seq bigint;
begin
  if p_session_id is null or not public.live_language_valid(clean_language) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TOPIC_CONTEXT_INPUT');
  end if;

  with bounded_topics as (
    select topic_row.*
    from public.live_topics topic_row
    where topic_row.session_id = p_session_id
    order by topic_row.ordinal desc
    limit 1000
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', bounded_topics.id,
        'session_id', bounded_topics.session_id,
        'ordinal', bounded_topics.ordinal,
        'title', bounded_topics.title,
        'summary', bounded_topics.summary,
        'status', bounded_topics.status,
        'completion_reason', bounded_topics.completion_reason,
        'detector_health', bounded_topics.detector_health,
        'started_at', bounded_topics.started_at,
        'completed_at', bounded_topics.completed_at,
        'version', bounded_topics.version
      )
      order by bounded_topics.ordinal
    ),
    '[]'::jsonb
  )
    into topic_payload
  from bounded_topics;

  with bounded_topics as (
    select topic_row.id, topic_row.ordinal
    from public.live_topics topic_row
    where topic_row.session_id = p_session_id
    order by topic_row.ordinal desc
    limit 1000
  ),
  bounded_memberships as (
    select membership_row.*
    from public.live_topic_utterances membership_row
    join bounded_topics on bounded_topics.id = membership_row.topic_id
    where membership_row.session_id = p_session_id
    order by membership_row.source_seq desc
    limit 12000
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'session_id', bounded_memberships.session_id,
        'topic_id', bounded_memberships.topic_id,
        'utterance_key', bounded_memberships.utterance_key,
        'position', bounded_memberships.position
      )
      order by bounded_memberships.position
    ),
    '[]'::jsonb
  )
    into topic_membership_payload
  from bounded_memberships;

  select coalesce(max(source_utterance.seq), 0)
    into latest_source_seq
  from public.live_utterances source_utterance
  where source_utterance.session_id = p_session_id
    and source_utterance.language = clean_language
    and source_utterance.origin = 'source'
    and source_utterance.utterance_key is not null;

  return jsonb_build_object(
    'ok', true,
    'event', 'topic-upsert',
    'topics', topic_payload,
    'topic_memberships', topic_membership_payload,
    'memberships_added', '[]'::jsonb,
    'latest_source_seq', latest_source_seq
  );
end;
$$;

create or replace function public.apply_live_topic_transition(
  p_session_id uuid,
  p_language text,
  p_utterance_key text,
  p_source_seq bigint,
  p_decision text,
  p_expected_topic_id uuid,
  p_expected_version integer,
  p_title text,
  p_summary text,
  p_detector_health text,
  p_meaningful boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  clean_language text := lower(btrim(coalesce(p_language, '')));
  clean_utterance_key text := normalize(btrim(coalesce(p_utterance_key, '')), NFC);
  raw_title text := nullif(normalize(btrim(coalesce(p_title, '')), NFC), '');
  clean_title text := coalesce(raw_title, 'Live topic');
  clean_summary text := nullif(normalize(btrim(coalesce(p_summary, '')), NFC), '');
  clean_detector_health text := coalesce(nullif(p_detector_health, ''), 'healthy');
  existing_membership record;
  processed_membership record;
  source_utterance record;
  topic_row record;
  target_topic_id uuid;
  target_topic record;
  completed_topic record;
  next_ordinal integer;
  membership_position integer;
  target_topic_payload jsonb;
  completed_topic_payload jsonb;
begin
  if p_session_id is null
    or not public.live_language_valid(clean_language)
    or char_length(clean_utterance_key) not between 1 and 256
    or octet_length(clean_utterance_key) > 768
    or clean_utterance_key ~ '[[:cntrl:]]'
    or clean_utterance_key ~ '[<>]'
    or translate(clean_utterance_key, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') <> clean_utterance_key
    or p_source_seq is null
    or p_source_seq <= 0
    or p_decision not in ('continue', 'shift')
    or clean_detector_health not in ('healthy', 'degraded')
    or p_meaningful is null
    or char_length(clean_title) not between 1 and 120
    or clean_title !~ '[^<>[:cntrl:]]'
    or clean_title ~ '[[:cntrl:]]'
    or clean_title ~ '[<>]'
    or translate(clean_title, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') <> clean_title
    or (
      clean_summary is not null
      and (
        char_length(clean_summary) not between 1 and 500
        or clean_summary ~ '[[:cntrl:]]'
        or clean_summary ~ '[<>]'
        or translate(clean_summary, U&'\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') <> clean_summary
      )
    )
  then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TOPIC_TRANSITION_INPUT');
  end if;

  select existing_membership.*
    into existing_membership
  from public.live_topic_utterances existing_membership
  where existing_membership.session_id = p_session_id
    and existing_membership.utterance_key = clean_utterance_key;

  if found then
    select topic_row.*
      into target_topic
    from public.live_topics topic_row
    where topic_row.id = existing_membership.topic_id;

    target_topic_payload := jsonb_build_object(
      'id', target_topic.id,
      'session_id', target_topic.session_id,
      'ordinal', target_topic.ordinal,
      'title', target_topic.title,
      'summary', target_topic.summary,
      'status', target_topic.status,
      'completion_reason', target_topic.completion_reason,
      'detector_health', target_topic.detector_health,
      'started_at', target_topic.started_at,
      'completed_at', target_topic.completed_at,
      'version', target_topic.version
    );

    return jsonb_build_object('ok', true, 'status', 'idempotent',
      'event', 'topic-upsert',
      'topics', jsonb_build_array(target_topic_payload),
      'memberships_added', '[]'::jsonb
    );
  end if;

  select processed_membership.*
    into processed_membership
  from public.live_topic_processed_utterances processed_membership
  where processed_membership.session_id = p_session_id
    and processed_membership.utterance_key = clean_utterance_key;

  if found then
    return jsonb_build_object('ok', true, 'status', 'idempotent',
      'event', 'topic-upsert',
      'topics', '[]'::jsonb,
      'memberships_added', '[]'::jsonb
    );
  end if;

  select source_utterance.*
    into source_utterance
  from public.live_utterances source_utterance
  where source_utterance.session_id = p_session_id
    and source_utterance.language = clean_language
    and source_utterance.origin = 'source'
    and source_utterance.utterance_key = clean_utterance_key
    and source_utterance.seq = p_source_seq;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'SOURCE_FINAL_NOT_DURABLE');
  end if;

  select topic_row.*
    into topic_row
  from public.live_topics topic_row
  where topic_row.session_id = p_session_id
    and topic_row.status = 'active'
  for update;

  if found and (
    p_expected_topic_id is null
    or topic_row.id <> p_expected_topic_id
    or topic_row.version <> p_expected_version
  ) then
    return jsonb_build_object('ok', false, 'code', 'TOPIC_VERSION_CONFLICT');
  end if;

  if p_meaningful is false then
    if not found then
      insert into public.live_topic_processed_utterances (
        session_id,
        utterance_key,
        source_seq,
        source_language
      ) values (
        p_session_id,
        clean_utterance_key,
        p_source_seq,
        clean_language
      )
      on conflict (session_id, utterance_key) do nothing;

      return jsonb_build_object('ok', true, 'status', 'ignored',
        'event', 'topic-upsert',
        'topics', '[]'::jsonb,
        'memberships_added', '[]'::jsonb
      );
    end if;

    select coalesce(max(membership_row.position), 0) + 1
      into membership_position
    from public.live_topic_utterances membership_row
    where membership_row.topic_id = topic_row.id;

    insert into public.live_topic_utterances (
      session_id,
      utterance_key,
      topic_id,
      position,
      source_seq,
      source_language
    ) values (
      p_session_id,
      clean_utterance_key,
      topic_row.id,
      membership_position,
      p_source_seq,
      clean_language
    )
    on conflict (session_id, utterance_key) do nothing;

    insert into public.live_topic_processed_utterances (
      session_id,
      utterance_key,
      source_seq,
      source_language
    ) values (
      p_session_id,
      clean_utterance_key,
      p_source_seq,
      clean_language
    )
    on conflict (session_id, utterance_key) do nothing;

    target_topic_payload := jsonb_build_object(
      'id', topic_row.id,
      'session_id', topic_row.session_id,
      'ordinal', topic_row.ordinal,
      'title', topic_row.title,
      'summary', topic_row.summary,
      'status', topic_row.status,
      'completion_reason', topic_row.completion_reason,
      'detector_health', topic_row.detector_health,
      'started_at', topic_row.started_at,
      'completed_at', topic_row.completed_at,
      'version', topic_row.version
    );

    return jsonb_build_object('ok', true, 'status', 'processed',
      'event', 'topic-upsert',
      'topics', jsonb_build_array(target_topic_payload),
      'memberships_added', jsonb_build_array(jsonb_build_object(
        'session_id', p_session_id,
        'topic_id', topic_row.id,
        'utterance_key', clean_utterance_key,
        'position', membership_position
      ))
    );
  end if;

  if not found then
    select coalesce(max(topic_row.ordinal), 0) + 1
      into next_ordinal
    from public.live_topics topic_row
    where topic_row.session_id = p_session_id;

    insert into public.live_topics (
      session_id,
      ordinal,
      title,
      summary,
      detector_health,
      last_activity_at
    ) values (
      p_session_id,
      next_ordinal,
      clean_title,
      clean_summary,
      clean_detector_health,
      source_utterance.emitted_at
    )
    returning id into target_topic_id;
  elsif p_decision = 'shift' then
    update public.live_topics
      set status = 'completed',
          completion_reason = 'semantic_shift',
          completed_at = source_utterance.emitted_at,
          updated_at = statement_timestamp(),
          version = version + 1
    where id = topic_row.id
    returning * into completed_topic;

    completed_topic_payload := jsonb_build_object(
      'id', completed_topic.id,
      'session_id', completed_topic.session_id,
      'ordinal', completed_topic.ordinal,
      'title', completed_topic.title,
      'summary', completed_topic.summary,
      'status', completed_topic.status,
      'completion_reason', completed_topic.completion_reason,
      'detector_health', completed_topic.detector_health,
      'started_at', completed_topic.started_at,
      'completed_at', completed_topic.completed_at,
      'version', completed_topic.version
    );

    select coalesce(max(next_topic.ordinal), 0) + 1
      into next_ordinal
    from public.live_topics next_topic
    where next_topic.session_id = p_session_id;

    insert into public.live_topics (
      session_id,
      ordinal,
      title,
      summary,
      detector_health,
      last_activity_at
    ) values (
      p_session_id,
      next_ordinal,
      clean_title,
      clean_summary,
      clean_detector_health,
      source_utterance.emitted_at
    )
    returning id into target_topic_id;
  else
    update public.live_topics
      set title = coalesce(raw_title, title),
          summary = coalesce(clean_summary, summary),
          detector_health = clean_detector_health,
          last_activity_at = source_utterance.emitted_at,
          updated_at = statement_timestamp(),
          version = version + 1
    where id = topic_row.id
    returning id into target_topic_id;
  end if;

  select coalesce(max(membership_row.position), 0) + 1
    into membership_position
  from public.live_topic_utterances membership_row
  where membership_row.topic_id = target_topic_id;

  insert into public.live_topic_utterances (
    session_id,
    utterance_key,
    topic_id,
    position,
    source_seq,
    source_language
  ) values (
    p_session_id,
    clean_utterance_key,
    target_topic_id,
    membership_position,
    p_source_seq,
    clean_language
  )
  on conflict (session_id, utterance_key) do nothing;

  select topic_row.*
    into target_topic
  from public.live_topics topic_row
  where topic_row.id = target_topic_id;

  target_topic_payload := jsonb_build_object(
    'id', target_topic.id,
    'session_id', target_topic.session_id,
    'ordinal', target_topic.ordinal,
    'title', target_topic.title,
    'summary', target_topic.summary,
    'status', target_topic.status,
    'completion_reason', target_topic.completion_reason,
    'detector_health', target_topic.detector_health,
    'started_at', target_topic.started_at,
    'completed_at', target_topic.completed_at,
    'version', target_topic.version
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'applied',
    'event', 'topic-upsert',
    'topics', case
      when completed_topic_payload is null then jsonb_build_array(target_topic_payload)
      else jsonb_build_array(completed_topic_payload, target_topic_payload)
    end,
    'memberships_added', jsonb_build_array(jsonb_build_object(
      'session_id', p_session_id,
      'topic_id', target_topic_id,
      'utterance_key', clean_utterance_key,
      'position', membership_position
    ))
  );
end;
$$;

create or replace function public.complete_idle_live_topic(
  p_session_id uuid,
  p_language text,
  p_topic_id uuid,
  p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  clean_language text := lower(btrim(coalesce(p_language, '')));
  topic_row record;
  latest_source_final_at timestamptz;
  completed_topic record;
  completed_topic_payload jsonb;
begin
  if p_session_id is null
    or p_topic_id is null
    or not public.live_language_valid(clean_language)
    or p_expected_version is null
  then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IDLE_TOPIC_INPUT');
  end if;

  select topic_row.*
    into topic_row
  from public.live_topics topic_row
  where topic_row.id = p_topic_id
    and topic_row.session_id = p_session_id
    and topic_row.status = 'active'
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'TOPIC_NOT_ACTIVE');
  end if;

  if topic_row.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'TOPIC_VERSION_CONFLICT');
  end if;

  if topic_row.last_activity_at > statement_timestamp() - interval '12 seconds' then
    return jsonb_build_object('ok', false, 'code', 'TOPIC_NOT_IDLE');
  end if;

  select max(source_utterance.emitted_at)
    into latest_source_final_at
  from public.live_utterances source_utterance
  left join public.live_topic_utterances membership_row
    on membership_row.session_id = source_utterance.session_id
   and membership_row.utterance_key = source_utterance.utterance_key
  left join public.live_topic_processed_utterances processed_row
    on processed_row.session_id = source_utterance.session_id
   and processed_row.utterance_key = source_utterance.utterance_key
  where source_utterance.session_id = p_session_id
    and source_utterance.language = clean_language
    and source_utterance.origin = 'source'
    and source_utterance.utterance_key is not null
    and membership_row.utterance_key is null
    and processed_row.utterance_key is null;

  if latest_source_final_at > topic_row.last_activity_at then
    return jsonb_build_object('ok', false, 'code', 'LATEST_SOURCE_FINAL_UNASSIGNED');
  end if;

  update public.live_topics
    set status = 'completed',
        completion_reason = 'silence',
        completed_at = statement_timestamp(),
        updated_at = statement_timestamp(),
        version = version + 1
  where id = topic_row.id
  returning * into completed_topic;

  completed_topic_payload := jsonb_build_object(
    'id', completed_topic.id,
    'session_id', completed_topic.session_id,
    'ordinal', completed_topic.ordinal,
    'title', completed_topic.title,
    'summary', completed_topic.summary,
    'status', completed_topic.status,
    'completion_reason', completed_topic.completion_reason,
    'detector_health', completed_topic.detector_health,
    'started_at', completed_topic.started_at,
    'completed_at', completed_topic.completed_at,
    'version', completed_topic.version
  );

  return jsonb_build_object(
    'ok', true,
    'event', 'topic-upsert',
    'topics', jsonb_build_array(completed_topic_payload),
    'memberships_added', '[]'::jsonb
  );
end;
$$;

create or replace function public.complete_live_topics_on_session_end(
  p_session_id uuid
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row record;
  changed_count integer := 0;
begin
  if p_session_id is null then
    return 0;
  end if;

  select session_row.*
    into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id;

  if not found or session_row.status not in ('live', 'paused', 'stopped') then
    return 0;
  end if;

  update public.live_topics
    set status = 'completed',
        completion_reason = 'session_end',
        completed_at = coalesce(session_row.ended_at, statement_timestamp()),
        updated_at = statement_timestamp(),
        version = version + 1
  where session_id = p_session_id
    and status = 'active';

  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;

create or replace function public.recover_live_topic_assignments(
  p_session_id uuid,
  p_language text,
  p_after_source_seq bigint default 0
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  clean_language text := lower(btrim(coalesce(p_language, '')));
  unassigned_finals jsonb := '[]'::jsonb;
  next_source_seq bigint := coalesce(p_after_source_seq, 0);
begin
  if p_session_id is null
    or not public.live_language_valid(clean_language)
    or p_after_source_seq is null
    or p_after_source_seq < 0
  then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TOPIC_RECOVERY_INPUT');
  end if;

  with bounded_source as (
    select source_utterance.*
    from public.live_utterances source_utterance
    left join public.live_topic_utterances membership_row
      on membership_row.session_id = source_utterance.session_id
     and membership_row.utterance_key = source_utterance.utterance_key
    left join public.live_topic_processed_utterances processed_row
      on processed_row.session_id = source_utterance.session_id
     and processed_row.utterance_key = source_utterance.utterance_key
    where source_utterance.session_id = p_session_id
      and source_utterance.language = clean_language
      and source_utterance.origin = 'source'
      and source_utterance.utterance_key is not null
      and source_utterance.seq > coalesce(p_after_source_seq, 0)
      and char_length(source_utterance.text) <= 2000
      and membership_row.utterance_key is null
      and processed_row.utterance_key is null
    order by source_utterance.seq
    limit 100
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'utterance_key', bounded_source.utterance_key,
          'source_seq', bounded_source.seq,
          'source_language', bounded_source.language,
          'text', left(bounded_source.text, 2000),
          'emitted_at', bounded_source.emitted_at
        )
        order by bounded_source.seq
      ),
      '[]'::jsonb
    ),
    coalesce(max(bounded_source.seq), coalesce(p_after_source_seq, 0))
  into unassigned_finals, next_source_seq
  from bounded_source;

  return jsonb_build_object(
    'ok', true,
    'unassigned_finals', unassigned_finals,
    'next_source_seq', next_source_seq
  );
end;
$$;

create or replace function public.cleanup_expired_live_topics()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed_count integer := 0;
begin
  with deleted_processed as (
    delete from public.live_topic_processed_utterances processed_row
    using (
      select session_row.id
      from public.live_sessions session_row
      where coalesce(session_row.ended_at, session_row.updated_at, session_row.created_at)
        < statement_timestamp() - interval '30 days'
    ) expired_sessions
    where processed_row.session_id = expired_sessions.id
    returning processed_row.utterance_key
  ),
  deleted_topics as (
    delete from public.live_topics topic_row
    using public.live_sessions session_row
    where topic_row.session_id = session_row.id
      and coalesce(session_row.ended_at, topic_row.completed_at, topic_row.updated_at)
        < statement_timestamp() - interval '30 days'
    returning topic_row.id
  )
  select (
    (select count(*) from deleted_processed)
    + (select count(*) from deleted_topics)
  )::integer
    into changed_count
  ;

  return changed_count;
end;
$$;

do $$
begin
  if exists (
    select 1
    from pg_namespace
    where nspname = 'cron'
  ) then
    if exists (
      select 1
      from cron.job job_row
      where job_row.jobname = 'realtime-noel-live-topic-cleanup'
    ) then
      perform cron.unschedule('realtime-noel-live-topic-cleanup');
    end if;

    perform cron.schedule(
      'realtime-noel-live-topic-cleanup',
      '17 3 * * *',
      'select public.cleanup_expired_live_topics();'
    );
  end if;
exception
  when undefined_function then
    null;
end $$;

revoke all on function public.read_live_topic_context(uuid, text)
  from public, anon, authenticated;
revoke all on function public.apply_live_topic_transition(
  uuid, text, text, bigint, text, uuid, integer, text, text, text, boolean
) from public, anon, authenticated;
revoke all on function public.complete_idle_live_topic(uuid, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.complete_live_topics_on_session_end(uuid)
  from public, anon, authenticated;
revoke all on function public.recover_live_topic_assignments(uuid, text, bigint)
  from public, anon, authenticated;
revoke all on function public.cleanup_expired_live_topics()
  from public, anon, authenticated;

grant execute on function public.read_live_topic_context(uuid, text)
  to service_role;
grant execute on function public.apply_live_topic_transition(
  uuid, text, text, bigint, text, uuid, integer, text, text, text, boolean
) to service_role;
grant execute on function public.complete_idle_live_topic(uuid, text, uuid, integer)
  to service_role;
grant execute on function public.complete_live_topics_on_session_end(uuid)
  to service_role;
grant execute on function public.recover_live_topic_assignments(uuid, text, bigint)
  to service_role;
grant execute on function public.cleanup_expired_live_topics()
  to service_role;
