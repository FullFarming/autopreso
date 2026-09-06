-- 2026-09-01 fix: Missing server configuration may be corrected before an
-- explicit summary request. Preserve the existing three-attempt claim/token
-- guard; do not change existing job rows or schedule provider requests.
alter table public.live_summary_generation_jobs
  drop constraint if exists live_summary_generation_jobs_retry_error_check;
alter table public.live_summary_generation_jobs
  add constraint live_summary_generation_jobs_retry_error_check check (
    retryable=false or error_code in (
      'SUMMARY_NOT_CONFIGURED','SUMMARY_TIMEOUT','SUMMARY_PROVIDER_RATE_LIMITED',
      'SUMMARY_PROVIDER_UNAVAILABLE','SUMMARY_INCOMPLETE','UTTERANCES_READ_FAILED',
      'PARTICIPANT_ACTIVITY_READ_FAILED'));

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
    'SUMMARY_NOT_CONFIGURED',
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
revoke all on function public.fail_live_summary_generation(uuid,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.fail_live_summary_generation(uuid,text,uuid,text) to service_role;
