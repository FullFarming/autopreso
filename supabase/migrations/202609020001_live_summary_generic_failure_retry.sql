-- 2026-09-02 fix: A generic summary failure must not become a permanent dead
-- end, and a session with no recorded speech is an empty record rather than a
-- failure. Three changes, no data loss:
--   1. The generic catch-all codes join the transient list so the existing
--      three-attempt claim/token guard can reclaim them automatically.
--   2. read_live_summary_generation_status reports 'empty' for NO_UTTERANCES so
--      the API can present an empty state instead of a generic failure.
--   3. reset_live_summary_generation_v1 lets the owning host clear an
--      exhausted or permanently failed job once so the next claim proceeds.
-- Existing job rows are never rewritten by this migration.

alter table public.live_summary_generation_jobs
  drop constraint if exists live_summary_generation_jobs_retry_error_check;
alter table public.live_summary_generation_jobs
  add constraint live_summary_generation_jobs_retry_error_check check (
    retryable=false or error_code in (
      'SUMMARY_NOT_CONFIGURED','SUMMARY_TIMEOUT','SUMMARY_PROVIDER_RATE_LIMITED',
      'SUMMARY_PROVIDER_UNAVAILABLE','SUMMARY_INCOMPLETE','UTTERANCES_READ_FAILED',
      'PARTICIPANT_ACTIVITY_READ_FAILED','SUMMARY_FAILED','SUMMARY_READY_MISSING',
      'SUMMARY_COMPLETE_FAILED','SUMMARY_HOST_RESET'));

-- An explicit host reset returns the lane to "no attempt spent" so the next
-- claim allocates attempt one again. Only zero is newly permitted; the upper
-- bound of three stays, so the attempt budget is still bounded.
alter table public.live_summary_generation_jobs
  drop constraint if exists live_summary_generation_jobs_attempt_count_check;
alter table public.live_summary_generation_jobs
  add constraint live_summary_generation_jobs_attempt_count_check check (
    attempt_count between 0 and 3
  );

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

  -- NO_UTTERANCES stays non-transient on purpose: an empty record is not a
  -- failure to retry, and the read RPC reports it as 'empty'.
  transient_error := p_error_code in (
    'SUMMARY_NOT_CONFIGURED',
    'SUMMARY_TIMEOUT',
    'SUMMARY_PROVIDER_RATE_LIMITED',
    'SUMMARY_PROVIDER_UNAVAILABLE',
    'SUMMARY_INCOMPLETE',
    'UTTERANCES_READ_FAILED',
    'PARTICIPANT_ACTIVITY_READ_FAILED',
    'SUMMARY_FAILED',
    'SUMMARY_READY_MISSING',
    'SUMMARY_COMPLETE_FAILED'
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
    -- An empty record outranks every failure classification: there is nothing
    -- to summarize, so no attempt count and no retry advice applies.
    if job_error_code = 'NO_UTTERANCES' then
      return jsonb_build_object('ok', true, 'status', 'empty');
    end if;
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

-- Host-owned recovery for a job that no automatic claim can reach any more
-- (attempts exhausted, or a failure the fail RPC classified as permanent).
-- A stored summary is never touched, a running lease is never stolen, and the
-- reset only makes the job claimable again - it never generates anything.
create or replace function public.reset_live_summary_generation_v1(
  p_session_id uuid,
  p_language text,
  p_host_id text
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
    or public.live_language_valid(p_language) is not true
    or p_host_id is null
    or length(p_host_id) not between 1 and 256
  then
    return false;
  end if;

  if not exists (
    select 1
    from public.live_sessions as session_row
    where session_row.id = p_session_id
      and session_row.host_id = p_host_id
      and session_row.status in ('stopped', 'failed')
  ) then
    return false;
  end if;

  if exists (
    select 1
    from public.live_meeting_summaries as summary_row
    where summary_row.session_id = p_session_id
      and summary_row.language = p_language
  ) then
    return false;
  end if;

  -- One session-language lane serializes reset against claim, matching the
  -- claim RPC's advisory lock so a reset cannot interleave with a reclaim.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_session_id::text || ':' || p_language, 0)
  );

  -- live_summary_generation_jobs_state_check forbids a failed row without an
  -- error code, so the reset records itself as the reason instead of erasing
  -- one: the job history still says why the lane became claimable again.
  update public.live_summary_generation_jobs as job_row
  set status = 'failed',
      error_code = 'SUMMARY_HOST_RESET',
      attempt_count = 0,
      retryable = true,
      next_retry_at = statement_timestamp(),
      lease_expires_at = statement_timestamp(),
      completed_at = null,
      failed_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where job_row.session_id = p_session_id
    and job_row.language = p_language
    and (
      (job_row.status = 'failed' and (job_row.attempt_count >= 3 or job_row.retryable is not true))
      -- A crashed worker leaves 'running' with an expired lease; at the attempt
      -- cap no claim can recover it either. A live lease is never stolen.
      or (job_row.status = 'running'
        and job_row.lease_expires_at <= statement_timestamp()
        and job_row.attempt_count >= 3)
    );

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  return affected_count = 1;
end;
$$;

revoke all on function public.fail_live_summary_generation(uuid, text, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.read_live_summary_generation_status(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.reset_live_summary_generation_v1(uuid, text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.fail_live_summary_generation(uuid, text, uuid, text)
  to service_role;
grant execute on function public.read_live_summary_generation_status(uuid, text)
  to service_role;
grant execute on function public.reset_live_summary_generation_v1(uuid, text, text)
  to service_role;

-- Verification (development project only): fail a job with SUMMARY_FAILED and
-- confirm read status reports retryable_failed and claim allocates attempt two;
-- exhaust three attempts, confirm 'exhausted', then call
-- reset_live_summary_generation_v1 as the owning host and confirm exactly one
-- further claim is possible. A non-owner host id must return false and leave
-- attempt_count untouched.
