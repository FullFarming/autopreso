-- 2026-07-20 fix: Remove session-scoped viewer identity data when access ends.
-- Session rows remain as non-biometric operational records, while grants that
-- contain display_name, user_id, and device_hash are deleted rather than kept.

create or replace function public.terminate_live_session(
  p_session_id uuid,
  p_host_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1
  from public.live_sessions
  where id = p_session_id
    and host_id = p_host_id
  for update;

  if not found then
    return false;
  end if;

  update public.live_sessions
  set status = 'stopped',
      viewer_count = 0,
      admission_code_hmac = null,
      admission_open_until = null,
      ended_at = coalesce(ended_at, statement_timestamp()),
      updated_at = statement_timestamp(),
      version = version + case when status = 'stopped' then 0 else 1 end
  where id = p_session_id
    and host_id = p_host_id;

  -- The global order is session -> invite -> grant. Join and cleanup acquire
  -- the same locks in this order, preventing inverse-lock deadlocks.
  update public.live_session_invites invite_row
  set revoked_at = coalesce(invite_row.revoked_at, statement_timestamp())
  where invite_row.session_id = p_session_id;

  delete from public.viewer_grants
  where session_id = p_session_id;

  delete from public.live_snapshots where session_id = p_session_id;
  delete from public.session_speakers where session_id = p_session_id;
  return true;
end;
$$;

create or replace function public.cleanup_expired_live_state()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  stopped_count integer;
begin
  -- Lock every session whose dependent rows can be changed, in UUID order.
  -- This also repairs grants left by older terminate/cleanup implementations.
  perform 1
  from public.live_sessions session_lock
  where (
      session_lock.status <> 'stopped'
      and session_lock.expires_at <= statement_timestamp()
    )
    or exists (
      select 1
      from public.viewer_grants grant_lock
      where grant_lock.session_id = session_lock.id
        and (
          grant_lock.revoked_at is not null
          or grant_lock.expires_at <= statement_timestamp()
          or session_lock.status = 'stopped'
          or session_lock.expires_at <= statement_timestamp()
        )
    )
    or exists (
      select 1
      from public.live_session_invites invite_lock
      where invite_lock.session_id = session_lock.id
        and invite_lock.revoked_at is null
        and (
          invite_lock.expires_at <= statement_timestamp()
          or session_lock.status = 'stopped'
          or session_lock.expires_at <= statement_timestamp()
          or session_lock.admission_open_until is null
          or session_lock.admission_open_until <= statement_timestamp()
        )
    )
  order by session_lock.id
  for update;

  with stopped as (
    update public.live_sessions
    set status = 'stopped',
        viewer_count = 0,
        admission_code_hmac = null,
        admission_open_until = null,
        ended_at = coalesce(ended_at, statement_timestamp()),
        updated_at = statement_timestamp(),
        version = version + 1
    where status <> 'stopped'
      and expires_at <= statement_timestamp()
    returning id
  )
  select count(*)::integer into stopped_count from stopped;

  update public.live_session_invites invite_row
  set revoked_at = coalesce(invite_row.revoked_at, statement_timestamp())
  from public.live_sessions session_row
  where invite_row.session_id = session_row.id
    and invite_row.revoked_at is null
    and (
      invite_row.expires_at <= statement_timestamp()
      or session_row.status = 'stopped'
      or session_row.expires_at <= statement_timestamp()
      or session_row.admission_open_until is null
      or session_row.admission_open_until <= statement_timestamp()
    );

  delete from public.viewer_grants grant_row
  using public.live_sessions session_row
  where grant_row.session_id = session_row.id
    and (
      grant_row.revoked_at is not null
      or grant_row.expires_at <= statement_timestamp()
      or session_row.status = 'stopped'
      or session_row.expires_at <= statement_timestamp()
    );

  update public.live_sessions session_row
  set viewer_count = active_grants.viewer_count,
      updated_at = statement_timestamp()
  from (
    select session_id, count(*)::integer as viewer_count
    from public.viewer_grants
    where revoked_at is null
      and expires_at > statement_timestamp()
    group by session_id
  ) active_grants
  where session_row.id = active_grants.session_id
    and session_row.status <> 'stopped'
    and session_row.viewer_count <> active_grants.viewer_count;

  update public.live_sessions session_row
  set viewer_count = 0,
      updated_at = statement_timestamp()
  where session_row.status <> 'stopped'
    and session_row.viewer_count <> 0
    and not exists (
      select 1
      from public.viewer_grants grant_row
      where grant_row.session_id = session_row.id
        and grant_row.revoked_at is null
        and grant_row.expires_at > statement_timestamp()
    );

  delete from public.live_snapshots snapshot_row
  using public.live_sessions session_row
  where snapshot_row.session_id = session_row.id
    and session_row.status = 'stopped';
  delete from public.session_speakers speaker_row
  using public.live_sessions session_row
  where speaker_row.session_id = session_row.id
    and session_row.status = 'stopped';
  delete from public.live_session_invites
  where revoked_at < statement_timestamp() - interval '1 day';
  delete from public.live_rate_limits
  where updated_at < statement_timestamp() - interval '1 day';

  return stopped_count;
end;
$$;

create or replace function public.verify_live_cleanup_schedule()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  has_active_cleanup_job boolean := false;
begin
  if to_regclass('cron.job') is null then
    return false;
  end if;

  -- Only explicitly approved schedules of one to five minutes satisfy the
  -- readiness probe. An active but infrequent job must fail closed.
  execute $query$
    select exists (
      select 1
      from cron.job job_row
      where job_row.active is true
        and btrim(job_row.command) ~* '^(select[[:space:]]+)?(public[.])?cleanup_expired_live_state[[:space:]]*[(][[:space:]]*[)][[:space:]]*;?$'
        and btrim(job_row.schedule) in (
          '* * * * *',
          '*/2 * * * *',
          '*/3 * * * *',
          '*/4 * * * *',
          '*/5 * * * *'
        )
    )
  $query$
  into has_active_cleanup_job;

  return has_active_cleanup_job;
exception
  when undefined_table or undefined_column or insufficient_privilege then
    return false;
end;
$$;

revoke all on function public.terminate_live_session(uuid, text)
  from public, anon, authenticated;
revoke all on function public.cleanup_expired_live_state()
  from public, anon, authenticated;
revoke all on function public.verify_live_cleanup_schedule()
  from public, anon, authenticated;

grant execute on function public.terminate_live_session(uuid, text)
  to service_role;
grant execute on function public.cleanup_expired_live_state()
  to service_role;
grant execute on function public.verify_live_cleanup_schedule()
  to service_role;
