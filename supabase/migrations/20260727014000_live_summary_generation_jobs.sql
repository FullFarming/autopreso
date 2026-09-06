-- 2026-07-27 feat: Make post-session summary generation a single-winner,
-- durable state transition. The table is private; service code may only claim,
-- complete, or fail one immutable session-language generation through RPCs.

create table public.live_summary_generation_jobs (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  language text not null,
  status text not null default 'running',
  generation_token uuid not null unique,
  error_code text,
  created_at timestamptz not null default statement_timestamp(),
  started_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  failed_at timestamptz,
  primary key (session_id, language),
  constraint live_summary_generation_jobs_language_check check (
    public.live_language_valid(language)
  ),
  constraint live_summary_generation_jobs_status_check check (
    status in ('running', 'succeeded', 'failed')
  ),
  constraint live_summary_generation_jobs_error_code_check check (
    error_code is null
    or (
      char_length(error_code) between 1 and 120
      and error_code = btrim(error_code)
      and error_code !~ '[[:cntrl:]]'
    )
  ),
  constraint live_summary_generation_jobs_state_check check (
    (
      status = 'running'
      and error_code is null
      and completed_at is null
      and failed_at is null
    )
    or (
      status = 'succeeded'
      and error_code is null
      and completed_at is not null
      and failed_at is null
    )
    or (
      status = 'failed'
      and error_code is not null
      and completed_at is null
      and failed_at is not null
    )
  ),
  constraint live_summary_generation_jobs_timestamps_check check (
    started_at >= created_at
    and updated_at >= created_at
    and (completed_at is null or completed_at >= started_at)
    and (failed_at is null or failed_at >= started_at)
  )
);

alter table public.live_summary_generation_jobs enable row level security;

revoke all on table public.live_summary_generation_jobs
  from public, anon, authenticated, service_role;

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
  claimed_token uuid;
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

  -- The lock covers the decision and insert. A concurrent loser observes the
  -- committed row after waiting and therefore neither allocates nor stores a
  -- second token. The primary key remains the independent database invariant.
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

  select job_row.status
  into job_status
  from public.live_summary_generation_jobs as job_row
  where job_row.session_id = p_session_id
    and job_row.language = p_language;

  if job_status = 'running' then
    return jsonb_build_object('ok', true, 'status', 'running');
  end if;
  if job_status = 'failed' then
    return jsonb_build_object('ok', true, 'status', 'failed');
  end if;
  if job_status = 'succeeded' then
    -- Completion writes the summary and state in one transaction, so a
    -- succeeded job has the same externally observable meaning as ready.
    return jsonb_build_object('ok', true, 'status', 'ready');
  end if;

  claimed_token := extensions.gen_random_uuid();
  insert into public.live_summary_generation_jobs (
    session_id,
    language,
    status,
    generation_token
  ) values (
    p_session_id,
    p_language,
    'running',
    claimed_token
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
      completed_at = statement_timestamp(),
      failed_at = null,
      updated_at = statement_timestamp()
  where job_row.session_id = p_session_id
    and job_row.language = p_language
    and job_row.generation_token = p_generation_token
    and job_row.status = 'running';

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  if affected_count = 0 then
    return false;
  end if;

  -- PostgreSQL functions execute inside the caller transaction. A summary
  -- constraint or upsert failure rolls the succeeded transition back as well.
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

  update public.live_summary_generation_jobs as job_row
  set status = 'failed',
      error_code = p_error_code,
      completed_at = null,
      failed_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where job_row.session_id = p_session_id
    and job_row.language = p_language
    and job_row.generation_token = p_generation_token
    and job_row.status = 'running';

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  return affected_count = 1;
end;
$$;

revoke all on function public.claim_live_summary_generation(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_live_summary_generation(uuid, text, uuid, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.fail_live_summary_generation(uuid, text, uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.claim_live_summary_generation(uuid, text)
  to service_role;
grant execute on function public.complete_live_summary_generation(uuid, text, uuid, jsonb, text)
  to service_role;
grant execute on function public.fail_live_summary_generation(uuid, text, uuid, text)
  to service_role;

-- Verification (run after applying to a development project only):
-- 1. End a development session and call claim twice concurrently. Exactly one
--    response is claimed with a token; the other is running without a token.
-- 2. Complete with a different UUID -> false and no summary row. Complete with
--    the claimed token -> true, one summary row, and succeeded job state.
-- 3. Direct authenticated/service-role table access remains denied; only these
--    three RPCs are executable by service_role.
