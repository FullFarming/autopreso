-- 2026-07-20 feat: Schedule bounded cleanup for expired live session state.
-- The named pg_cron upsert is intentionally rerunnable and never touches jobs
-- owned by another feature.

create extension if not exists pg_cron;

do $migration$
declare
  cleanup_job_id bigint;
begin
  if to_regnamespace('cron') is null
    or to_regclass('cron.job') is null
    or to_regprocedure('cron.schedule(text,text,text)') is null
  then
    raise exception using errcode = 'P0001', message = 'LIVE_CLEANUP_CRON_UNAVAILABLE';
  end if;

  if to_regprocedure('public.cleanup_expired_live_state()') is null then
    raise exception using errcode = 'P0001', message = 'LIVE_CLEANUP_FUNCTION_UNAVAILABLE';
  end if;

  if not has_function_privilege(
    current_user,
    'cron.schedule(text,text,text)',
    'EXECUTE'
  ) then
    raise exception using errcode = '42501', message = 'LIVE_CLEANUP_CRON_FORBIDDEN';
  end if;

  -- pg_cron updates an existing named job atomically. This avoids an
  -- unschedule/reschedule gap and leaves every differently named job intact.
  cleanup_job_id := cron.schedule(
    'realtime-noel-live-cleanup',
    '*/5 * * * *',
    'select public.cleanup_expired_live_state();'
  );

  if cleanup_job_id is null
    or not exists (
      select 1
      from cron.job job_row
      where job_row.jobid = cleanup_job_id
        and job_row.jobname = 'realtime-noel-live-cleanup'
        and btrim(job_row.schedule) = '*/5 * * * *'
        and btrim(job_row.command) = 'select public.cleanup_expired_live_state();'
        and job_row.active is true
    )
  then
    raise exception using errcode = 'P0001', message = 'LIVE_CLEANUP_CRON_NOT_READY';
  end if;
end;
$migration$;
