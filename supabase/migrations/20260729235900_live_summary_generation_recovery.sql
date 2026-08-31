-- 2026-07-29 fix: Recover abandoned or transiently failed summary jobs without
-- permitting two workers to complete the same attempt. Existing RPC signatures
-- stay stable while a five-minute lease and generation token fence every claim.

alter table public.live_summary_generation_jobs
  add column attempt_count integer,
  add column lease_expires_at timestamptz,
  add column next_retry_at timestamptz,
  add column retryable boolean;

update public.live_summary_generation_jobs
set attempt_count = 1,
    lease_expires_at = started_at + interval '5 minutes',
    next_retry_at = null,
    retryable = false;

alter table public.live_summary_generation_jobs
  alter column attempt_count set default 1,
  alter column attempt_count set not null,
  alter column lease_expires_at set default (statement_timestamp() + interval '5 minutes'),
  alter column lease_expires_at set not null,
  alter column retryable set default false,
  alter column retryable set not null,
  add constraint live_summary_generation_jobs_attempt_count_check check (
    attempt_count between 1 and 3
  ),
  add constraint live_summary_generation_jobs_lease_check check (
    lease_expires_at >= started_at
  ),
  add constraint live_summary_generation_jobs_retry_state_check check (
    (
      retryable = false
      and next_retry_at is null
    )
    or (
      status = 'failed'
      and retryable = true
      and attempt_count < 3
      and next_retry_at is not null
    )
  ),
  add constraint live_summary_generation_jobs_retry_error_check check (
    retryable = false
    or error_code in (
      'SUMMARY_TIMEOUT',
      'SUMMARY_PROVIDER_RATE_LIMITED',
      'SUMMARY_PROVIDER_UNAVAILABLE',
      'SUMMARY_INCOMPLETE',
      'UTTERANCES_READ_FAILED',
      'PARTICIPANT_ACTIVITY_READ_FAILED'
    )
  );

create or replace function public.claim_live_summary_generation(
  p_session_id uuid,
  p_language text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_status text;
  job_status text;
  job_generation_token uuid;
  job_attempt_count integer;
  job_lease_expires_at timestamptz;
  job_next_retry_at timestamptz;
  job_retryable boolean;
  claimed_token uuid;
  affected_count integer;
begin
  if p_session_id is null
    or public.live_language_valid(p_language) is not true
  then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SUMMARY_GENERATION_INPUT');
  end if;

  select session_row.status
  into session_status
  from public.live_sessions as session_row
  where session_row.id = p_session_id;

  if session_status is null then
    return jsonb_build_object('ok', false, 'code', 'LIVE_SESSION_NOT_FOUND');
  end if;
  if session_status <> 'stopped' then
    return jsonb_build_object('ok', false, 'code', 'LIVE_SESSION_NOT_STOPPED');
  end if;

  -- One session-language lane makes claim and reclaim decisions serial. The
  -- token-and-attempt compare-and-set remains an independent stale-writer fence.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_session_id::text || ':' || p_language, 0)
  );

  if exists (
    select 1
    from public.live_meeting_summaries as summary_row
    where summary_row.session_id = p_session_id
      and summary_row.language = p_language
  ) then
    return jsonb_build_object('ok', true, 'status', 'ready');
  end if;

  select
    job_row.status,
    job_row.generation_token,
    job_row.attempt_count,
    job_row.lease_expires_at,
    job_row.next_retry_at,
    job_row.retryable
  into
    job_status,
    job_generation_token,
    job_attempt_count,
    job_lease_expires_at,
    job_next_retry_at,
    job_retryable
  from public.live_summary_generation_jobs as job_row
  where job_row.session_id = p_session_id
    and job_row.language = p_language;

  if job_status = 'succeeded' then
    return jsonb_build_object('ok', true, 'status', 'ready');
  end if;

  if job_status = 'running'
    and job_lease_expires_at > statement_timestamp()
  then
    return jsonb_build_object('ok', true, 'status', 'running');
  end if;

  if job_status is not null and job_attempt_count >= 3 then
    if job_status = 'running' then
      update public.live_summary_generation_jobs as job_row
      set status = 'failed',
          error_code = 'SUMMARY_MAX_ATTEMPTS_EXCEEDED',
          retryable = false,
          next_retry_at = null,
          completed_at = null,
          failed_at = statement_timestamp(),
          updated_at = statement_timestamp()
      where job_row.session_id = p_session_id
        and job_row.language = p_language
        and job_row.generation_token = job_generation_token
        and job_row.status = 'running'
        and job_row.lease_expires_at <= statement_timestamp();
    end if;
    return jsonb_build_object(
      'ok', true,
      'status', 'exhausted'
    );
  end if;

  if job_status = 'failed' and job_retryable is not true then
    return jsonb_build_object(
      'ok', true,
      'status', 'permanent_failed'
    );
  end if;

  if job_status = 'failed'
    and job_next_retry_at > statement_timestamp()
  then
    return jsonb_build_object(
      'ok', true,
      'status', 'running'
    );
  end if;

  if (
    job_status = 'running'
    and job_lease_expires_at <= statement_timestamp()
  ) or (
    job_status = 'failed'
    and job_retryable is true
    and job_next_retry_at <= statement_timestamp()
  ) then
    claimed_token := extensions.gen_random_uuid();
    update public.live_summary_generation_jobs as job_row
    set status = 'running',
        generation_token = claimed_token,
        error_code = null,
        attempt_count = job_attempt_count + 1,
        lease_expires_at = statement_timestamp() + interval '5 minutes',
        next_retry_at = null,
        retryable = false,
        started_at = statement_timestamp(),
        updated_at = statement_timestamp(),
        completed_at = null,
        failed_at = null
    where job_row.session_id = p_session_id
      and job_row.language = p_language
      and job_row.generation_token = job_generation_token
      and job_row.attempt_count = job_attempt_count;

    GET DIAGNOSTICS affected_count = ROW_COUNT;
    if affected_count <> 1 then
      return jsonb_build_object('ok', true, 'status', 'running');
    end if;

    return jsonb_build_object(
      'ok', true,
      'status', 'claimed',
      'generationToken', claimed_token::text
    );
  end if;

  if job_status is not null then
    return jsonb_build_object(
      'ok', true,
      'status', 'permanent_failed'
    );
  end if;

  claimed_token := extensions.gen_random_uuid();
  insert into public.live_summary_generation_jobs (
    session_id,
    language,
    status,
    generation_token,
    attempt_count,
    lease_expires_at,
    retryable
  ) values (
    p_session_id,
    p_language,
    'running',
    claimed_token,
    1,
    statement_timestamp() + interval '5 minutes',
    false
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'claimed',
    'generationToken', claimed_token::text
  );
end;
$$;

create or replace function public.complete_live_summary_generation(
  p_session_id uuid,
  p_language text,
  p_generation_token uuid,
  p_summary jsonb,
  p_model text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_count integer;
begin
  if p_session_id is null
    or p_generation_token is null
    or public.live_language_valid(p_language) is not true
    or p_summary is null
    or jsonb_typeof(p_summary) <> 'object'
    or octet_length(p_summary::text) > 65536
    or p_model is null
    or char_length(p_model) not between 1 and 120
    or p_model <> btrim(p_model)
    or p_model ~ '[[:cntrl:]]'
  then
    return false;
  end if;

  update public.live_summary_generation_jobs as job_row
  set status = 'succeeded',
      error_code = null,
      retryable = false,
      next_retry_at = null,
      completed_at = statement_timestamp(),
      failed_at = null,
      updated_at = statement_timestamp()
  where job_row.session_id = p_session_id
    and job_row.language = p_language
    and job_row.generation_token = p_generation_token
    and job_row.status = 'running'
    and job_row.lease_expires_at > statement_timestamp();

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  if affected_count = 0 then
    return false;
  end if;

  insert into public.live_meeting_summaries (
    session_id,
    language,
    summary,
    model,
    updated_at
  ) values (
    p_session_id,
    p_language,
    p_summary,
    p_model,
    statement_timestamp()
  )
  on conflict (session_id, language) do update
  set summary = excluded.summary,
      model = excluded.model,
      updated_at = statement_timestamp();

  return true;
end;
$$;

create or replace function public.fail_live_summary_generation(
  p_session_id uuid,
  p_language text,
  p_generation_token uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_count integer;
  transient_error boolean;
begin
  if p_session_id is null
    or p_generation_token is null
    or public.live_language_valid(p_language) is not true
    or p_error_code is null
    or char_length(p_error_code) not between 1 and 120
    or p_error_code <> btrim(p_error_code)
    or p_error_code ~ '[[:cntrl:]]'
  then
    return false;
  end if;

  transient_error := p_error_code in (
    'SUMMARY_TIMEOUT',
    'SUMMARY_PROVIDER_RATE_LIMITED',
    'SUMMARY_PROVIDER_UNAVAILABLE',
    'SUMMARY_INCOMPLETE',
    'UTTERANCES_READ_FAILED',
    'PARTICIPANT_ACTIVITY_READ_FAILED'
  );

  update public.live_summary_generation_jobs as job_row
  set status = 'failed',
      error_code = p_error_code,
      retryable = transient_error and job_row.attempt_count < 3,
      next_retry_at = case
        when transient_error and job_row.attempt_count < 3
          then statement_timestamp()
        else null
      end,
      completed_at = null,
      failed_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where job_row.session_id = p_session_id
    and job_row.language = p_language
    and job_row.generation_token = p_generation_token
    and job_row.status = 'running'
    and job_row.lease_expires_at > statement_timestamp();

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  return affected_count = 1;
end;
$$;

create or replace function public.read_live_summary_generation_status(
  p_session_id uuid,
  p_language text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_status text;
  job_error_code text;
  job_attempt_count integer;
  job_lease_expires_at timestamptz;
  job_retryable boolean;
begin
  if p_session_id is null
    or public.live_language_valid(p_language) is not true
  then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SUMMARY_GENERATION_INPUT');
  end if;

  if exists (
    select 1
    from public.live_meeting_summaries as summary_row
    where summary_row.session_id = p_session_id
      and summary_row.language = p_language
  ) then
    return jsonb_build_object('ok', true, 'status', 'ready');
  end if;

  select
    job_row.status,
    job_row.error_code,
    job_row.attempt_count,
    job_row.lease_expires_at,
    job_row.retryable
  into
    job_status,
    job_error_code,
    job_attempt_count,
    job_lease_expires_at,
    job_retryable
  from public.live_summary_generation_jobs as job_row
  where job_row.session_id = p_session_id
    and job_row.language = p_language;

  if job_status is null then
    return jsonb_build_object('ok', true, 'status', 'missing');
  end if;

  if job_status = 'succeeded' then
    return jsonb_build_object('ok', false, 'code', 'SUMMARY_READY_MISSING');
  end if;

  if job_status = 'running' then
    if job_lease_expires_at > statement_timestamp() then
      return jsonb_build_object('ok', true, 'status', 'running');
    end if;
    if job_attempt_count >= 3 then
      return jsonb_build_object('ok', true, 'status', 'exhausted');
    end if;
    return jsonb_build_object('ok', true, 'status', 'retryable_failed');
  end if;

  if job_status = 'failed' then
    if job_attempt_count >= 3
      or job_error_code = 'SUMMARY_MAX_ATTEMPTS_EXCEEDED'
    then
      return jsonb_build_object('ok', true, 'status', 'exhausted');
    end if;
    if job_retryable is true then
      return jsonb_build_object('ok', true, 'status', 'retryable_failed');
    end if;
    return jsonb_build_object('ok', true, 'status', 'permanent_failed');
  end if;

  return jsonb_build_object('ok', false, 'code', 'SUMMARY_GENERATION_STATE_INVALID');
end;
$$;

revoke all on function public.claim_live_summary_generation(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_live_summary_generation(uuid, text, uuid, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.fail_live_summary_generation(uuid, text, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.read_live_summary_generation_status(uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.claim_live_summary_generation(uuid, text)
  to service_role;
grant execute on function public.complete_live_summary_generation(uuid, text, uuid, jsonb, text)
  to service_role;
grant execute on function public.fail_live_summary_generation(uuid, text, uuid, text)
  to service_role;
grant execute on function public.read_live_summary_generation_status(uuid, text)
  to service_role;

-- Verification (development project only): expire attempt one and claim twice
-- concurrently. Exactly one caller receives the new token. The old token must
-- return false from both complete and fail, and attempt four is never allocated.
