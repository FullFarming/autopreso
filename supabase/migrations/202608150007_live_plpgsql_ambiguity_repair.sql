-- Forward repair for PL/pgSQL variable/column ambiguity in applied live RPCs.
-- The explicit compiler policy preserves released behavior while table aliases win collisions.

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
#variable_conflict use_column
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
#variable_conflict use_column
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
#variable_conflict use_column
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

create or replace function public.claim_live_sheet_sync_job_v1(
  p_claim_token uuid
)
returns table (
  job_id uuid,
  session_id uuid,
  session_index_row integer,
  sheet_id integer,
  tab_title text,
  should_create boolean,
  projection_version bigint,
  previous_participant_count integer,
  workbook_ref_version integer,
  reason text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  job_row public.live_sheet_sync_jobs%rowtype;
  lease_row public.live_sheet_workbook_leases%rowtype;
begin
  if p_claim_token is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_CLAIM';
  end if;

  select * into lease_row
  from public.live_sheet_workbook_leases lease_row
  where lease_row.scope = 'configured_workbook'
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'SHEETS_WORKBOOK_LEASE_MISSING';
  end if;

  if lease_row.running_job_id is not null
    and lease_row.lease_expires_at <= statement_timestamp()
  then
    update public.live_sheet_sync_jobs
    set state = 'failed',
        completed_at = statement_timestamp(),
        safe_error_code = 'SHEETS_CLAIM_LEASE_EXPIRED',
        updated_at = statement_timestamp()
    where id = lease_row.running_job_id
      and state = 'running'
      and claim_token = lease_row.lease_token;

    update public.live_sheet_exports export_row
    set last_outcome = 'failed',
        last_error_code = 'SHEETS_CLAIM_LEASE_EXPIRED',
        updated_at = statement_timestamp()
    from public.live_sheet_sync_jobs expired_job
    where expired_job.id = lease_row.running_job_id
      and export_row.session_id = expired_job.session_id;

    update public.live_sheet_workbook_leases
    set running_job_id = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = statement_timestamp()
    where scope = 'configured_workbook';
    lease_row.running_job_id := null;
    lease_row.lease_token := null;
    lease_row.lease_expires_at := null;
  end if;

  if lease_row.running_job_id is not null then
    return;
  end if;

  select * into job_row
  from public.live_sheet_sync_jobs
  where state = 'pending'
  order by created_at, id
  for update skip locked
  limit 1;
  if not found then
    return;
  end if;
  update public.live_sheet_sync_jobs
  set state = 'running',
      claim_token = p_claim_token,
      claimed_at = statement_timestamp(),
      lease_expires_at = statement_timestamp() + interval '5 minutes',
      attempt_count = attempt_count + 1,
      updated_at = statement_timestamp()
  where id = job_row.id
    and state = 'pending'
  returning * into job_row;

  update public.live_sheet_workbook_leases
  set running_job_id = job_row.id,
      lease_token = p_claim_token,
      lease_expires_at = job_row.lease_expires_at,
      updated_at = statement_timestamp()
  where scope = 'configured_workbook';

  return query
  select
    job_row.id,
    export_row.session_id,
    export_row.session_index_row,
    export_row.sheet_id,
    export_row.tab_title,
    export_row.last_exported_projection_version = 0,
    job_row.projection_version,
    export_row.last_exported_participant_count,
    export_row.workbook_ref_version,
    job_row.reason
  from public.live_sheet_exports export_row
  where export_row.session_id = job_row.session_id;
end;
$$;

create or replace function public.complete_live_sheet_sync_job_v1(
  p_job_id uuid,
  p_claim_token uuid,
  p_projection_version bigint,
  p_participant_count integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  job_row public.live_sheet_sync_jobs%rowtype;
  lease_row public.live_sheet_workbook_leases%rowtype;
  changed_count integer;
begin
  if p_job_id is null
    or p_claim_token is null
    or p_projection_version < 1
    or p_participant_count not between 0 and 10000
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_COMPLETION';
  end if;

  select * into lease_row
  from public.live_sheet_workbook_leases lease_row
  where lease_row.scope = 'configured_workbook'
    and lease_row.running_job_id = p_job_id
    and lease_row.lease_token = p_claim_token
    and lease_row.lease_expires_at > statement_timestamp()
  for update;
  if not found then
    return false;
  end if;

  select * into job_row
  from public.live_sheet_sync_jobs job_row
  where job_row.id = p_job_id
    and job_row.state = 'running'
    and job_row.projection_version = p_projection_version
    and job_row.claim_token = p_claim_token
    and job_row.lease_expires_at = lease_row.lease_expires_at
  for update;
  if not found then
    return false;
  end if;

  update public.live_sheet_exports
  set last_exported_projection_version = p_projection_version,
      last_exported_participant_count = p_participant_count,
      last_outcome = 'succeeded',
      last_error_code = null,
      updated_at = statement_timestamp()
  where session_id = job_row.session_id
    and projection_version >= p_projection_version
    and last_exported_projection_version < p_projection_version;
  get diagnostics changed_count = row_count;
  if changed_count <> 1 then
    return false;
  end if;

  update public.live_sheet_sync_jobs
  set state = 'succeeded',
      completed_at = statement_timestamp(),
      safe_error_code = null,
      updated_at = statement_timestamp()
  where id = p_job_id;

  update public.live_sheet_workbook_leases
  set running_job_id = null,
      lease_token = null,
      lease_expires_at = null,
      updated_at = statement_timestamp()
  where scope = 'configured_workbook'
    and running_job_id = p_job_id
    and lease_token = p_claim_token;
  return true;
end;
$$;

create or replace function public.fail_live_sheet_sync_job_v1(
  p_job_id uuid,
  p_claim_token uuid,
  p_safe_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  failed_session_id uuid;
  lease_row public.live_sheet_workbook_leases%rowtype;
begin
  if p_job_id is null
    or p_claim_token is null
    or p_safe_error_code !~ '^[A-Z0-9_]{3,64}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_FAILURE';
  end if;

  select * into lease_row
  from public.live_sheet_workbook_leases lease_row
  where lease_row.scope = 'configured_workbook'
    and lease_row.running_job_id = p_job_id
    and lease_row.lease_token = p_claim_token
    and lease_row.lease_expires_at > statement_timestamp()
  for update;
  if not found then
    return false;
  end if;

  update public.live_sheet_sync_jobs
  set state = 'failed',
      completed_at = statement_timestamp(),
      safe_error_code = p_safe_error_code,
      updated_at = statement_timestamp()
  where id = p_job_id
    and state = 'running'
    and claim_token = p_claim_token
    and lease_expires_at = lease_row.lease_expires_at
  returning session_id into failed_session_id;
  if failed_session_id is null then
    return false;
  end if;
  update public.live_sheet_exports
  set last_outcome = 'failed',
      last_error_code = p_safe_error_code,
      updated_at = statement_timestamp()
  where session_id = failed_session_id;

  update public.live_sheet_workbook_leases
  set running_job_id = null,
      lease_token = null,
      lease_expires_at = null,
      updated_at = statement_timestamp()
  where scope = 'configured_workbook'
    and running_job_id = p_job_id
    and lease_token = p_claim_token;
  return true;
end;
$$;

create or replace function public.soft_delete_owned_live_record_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  archived_at timestamptz,
  archive_deleted_at timestamptz,
  archive_purge_after timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
begin
  if p_host_id is null or char_length(p_host_id) not between 1 and 256 or p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_DELETE_INPUT';
  end if;
  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  if session_row.archived_at is null or session_row.archive_deleted_at is not null then
    raise exception using errcode = 'P0001', message = 'ARCHIVE_DELETE_NOT_AVAILABLE';
  end if;
  update public.live_sessions session_target
  set archive_deleted_at = statement_timestamp(),
      archive_purge_after = statement_timestamp() + interval '30 days',
      updated_at = statement_timestamp()
  where session_target.id = p_session_id
  returning session_target.* into session_row;
  perform public.enqueue_live_sheet_projection(p_session_id, 'archive_deleted');
  return query select
    session_row.id, session_row.archived_at,
    session_row.archive_deleted_at, session_row.archive_purge_after;
end;
$$;

create or replace function public.restore_owned_live_record_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  archived_at timestamptz,
  archive_deleted_at timestamptz,
  archive_purge_after timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
begin
  if p_host_id is null or char_length(p_host_id) not between 1 and 256 or p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_RESTORE_INPUT';
  end if;
  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  if session_row.archive_deleted_at is null
    or session_row.archive_purge_after <= statement_timestamp()
  then
    raise exception using errcode = 'P0001', message = 'ARCHIVE_RESTORE_NOT_AVAILABLE';
  end if;
  update public.live_sessions session_target
  set archive_deleted_at = null,
      archive_purge_after = null,
      updated_at = statement_timestamp()
  where session_target.id = p_session_id
  returning session_target.* into session_row;
  perform public.enqueue_live_sheet_projection(p_session_id, 'archive_restored');
  return query select
    session_row.id, session_row.archived_at,
    session_row.archive_deleted_at, session_row.archive_purge_after;
end;
$$;

create or replace function public.read_owned_live_record_purge_eligibility_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  is_deleted boolean,
  is_purge_eligible boolean,
  archive_deleted_at timestamptz,
  archive_purge_after timestamptz,
  recovery_seconds_remaining bigint
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
begin
  if p_host_id is null or char_length(p_host_id) not between 1 and 256 or p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_PURGE_READ_INPUT';
  end if;
  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  return query select
    session_row.id,
    session_row.archive_deleted_at is not null,
    session_row.archive_purge_after is not null
      and session_row.archive_purge_after <= statement_timestamp(),
    session_row.archive_deleted_at,
    session_row.archive_purge_after,
    case when session_row.archive_purge_after is null then null
      else greatest(0, extract(epoch from (
        session_row.archive_purge_after - statement_timestamp()
      ))::bigint)
    end;
end;
$$;

create or replace function public.activate_live_session_after_gateway_ready_v1(
  p_session_id uuid,
  p_host_id text,
  p_expected_version integer,
  p_activation_key uuid,
  p_gateway_settings_fingerprint text,
  p_session_type text,
  p_output_mode text,
  p_voice_provider text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text,
  p_pinned_glossary_fingerprint text
)
returns table (
  session_id uuid,
  status text,
  version integer
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
begin
  if p_session_id is null
    or p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_host_id <> btrim(p_host_id)
    or p_host_id ~ '[[:cntrl:]]'
    or p_expected_version is null
    or p_expected_version < 1
    or p_expected_version >= 2147483647
    or p_activation_key is null
    or p_gateway_settings_fingerprint is null
    or p_gateway_settings_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_session_type is null
    or p_session_type not in ('presentation', 'meeting')
    or p_output_mode is null
    or p_output_mode not in ('captions', 'captions_audio', 'audio')
    or p_voice_provider is null
    or p_voice_provider not in ('gemini', 'openai')
    or (
      p_voice_provider = 'openai'
      and (
        p_session_type <> 'presentation'
        or p_output_mode not in ('captions_audio', 'audio')
      )
    )
    or p_languages is null
    or not public.live_languages_valid(p_languages)
    or p_max_viewers is null
    or p_max_viewers not between 1 and 200
    or p_glossary_pack is null
    or p_glossary_pack not in ('general_cre', 'hotel', 'fnb')
    or (
      p_pinned_glossary_fingerprint is not null
      and p_pinned_glossary_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_GATEWAY_READINESS_INPUT';
  end if;

  select session_row.* into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'GATEWAY_READINESS_CONFLICT';
  end if;

  if session_row.host_id <> p_host_id then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;

  if session_row.status = 'live'
    and session_row.version = p_expected_version + 1
    and session_row.gateway_activation_key = p_activation_key
    and session_row.gateway_settings_fingerprint = p_gateway_settings_fingerprint
    and session_row.session_type is not distinct from p_session_type
    and session_row.output_mode is not distinct from p_output_mode
    and session_row.voice_provider is not distinct from p_voice_provider
    and session_row.languages is not distinct from p_languages
    and session_row.max_viewers is not distinct from p_max_viewers
    and session_row.glossary_pack is not distinct from p_glossary_pack
    and session_row.pinned_glossary_fingerprint is not distinct from p_pinned_glossary_fingerprint
    and session_row.expires_at > statement_timestamp()
  then
    return query select session_row.id, session_row.status, session_row.version;
    return;
  end if;

  if session_row.status <> 'preparing'
    or session_row.version <> p_expected_version
    or session_row.expires_at <= statement_timestamp()
    or session_row.session_type is distinct from p_session_type
    or session_row.output_mode is distinct from p_output_mode
    or session_row.voice_provider is distinct from p_voice_provider
    or session_row.languages is distinct from p_languages
    or session_row.max_viewers is distinct from p_max_viewers
    or session_row.glossary_pack is distinct from p_glossary_pack
    or session_row.pinned_glossary_fingerprint is distinct from p_pinned_glossary_fingerprint
  then
    raise exception using errcode = 'P0001', message = 'GATEWAY_READINESS_CONFLICT';
  end if;

  if exists (
    select 1
    from public.live_sessions other_session
    where other_session.gateway_activation_key = p_activation_key
      and other_session.id <> p_session_id
  ) then
    raise exception using errcode = 'P0001', message = 'GATEWAY_READINESS_CONFLICT';
  end if;

  begin
    update public.live_sessions as session_row
    set status = 'live',
        version = session_row.version + 1,
        gateway_activation_key = p_activation_key,
        gateway_settings_fingerprint = p_gateway_settings_fingerprint,
        gateway_activated_at = statement_timestamp(),
        updated_at = statement_timestamp()
    where session_row.id = p_session_id
      and session_row.status = 'preparing'
      and session_row.version = p_expected_version
    returning session_row.* into session_row;
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = 'GATEWAY_READINESS_CONFLICT';
  end;

  if not found then
    raise exception using errcode = 'P0001', message = 'GATEWAY_READINESS_CONFLICT';
  end if;

  return query select session_row.id, session_row.status, session_row.version;
end;
$$;

revoke all on function public.apply_live_topic_transition(
  uuid, text, text, bigint, text, uuid, integer, text, text, text, boolean
) from public, anon, authenticated;
revoke all on function public.complete_idle_live_topic(uuid, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.complete_live_topics_on_session_end(uuid)
  from public, anon, authenticated;
revoke all on function public.claim_live_sheet_sync_job_v1(uuid)
  from public, anon, authenticated;
revoke all on function public.complete_live_sheet_sync_job_v1(uuid, uuid, bigint, integer)
  from public, anon, authenticated;
revoke all on function public.fail_live_sheet_sync_job_v1(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.soft_delete_owned_live_record_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.restore_owned_live_record_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.read_owned_live_record_purge_eligibility_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.activate_live_session_after_gateway_ready_v1(
  uuid, text, integer, uuid, text, text, text, text, text[], integer, text, text
)
  from public, anon, authenticated, service_role;

grant execute on function public.apply_live_topic_transition(
  uuid, text, text, bigint, text, uuid, integer, text, text, text, boolean
) to service_role;
grant execute on function public.complete_idle_live_topic(uuid, text, uuid, integer)
  to service_role;
grant execute on function public.complete_live_topics_on_session_end(uuid)
  to service_role;
grant execute on function public.claim_live_sheet_sync_job_v1(uuid)
  to service_role;
grant execute on function public.complete_live_sheet_sync_job_v1(uuid, uuid, bigint, integer)
  to service_role;
grant execute on function public.fail_live_sheet_sync_job_v1(uuid, uuid, text)
  to service_role;
grant execute on function public.soft_delete_owned_live_record_v1(text, uuid)
  to service_role;
grant execute on function public.restore_owned_live_record_v1(text, uuid)
  to service_role;
grant execute on function public.read_owned_live_record_purge_eligibility_v1(text, uuid)
  to service_role;
grant execute on function public.activate_live_session_after_gateway_ready_v1(
  uuid, text, integer, uuid, text, text, text, text, text[], integer, text, text
)
  to service_role;
