-- 2026-08-31 feat: Durable demand leases separate a meeting from its paid media runtime.
-- Existing sessions have no runtime row and keep the legacy behavior until opted in.

create table public.live_session_runtime (
  session_id uuid primary key references public.live_sessions(id) on delete cascade,
  state text not null default 'sleeping' check (state in ('sleeping','waking','active','draining','failed')),
  epoch integer not null default 0 check (epoch >= 0),
  start_requested_at timestamptz not null default statement_timestamp(),
  owner_id uuid,
  owner_lease_expires_at timestamptz,
  wake_deadline timestamptz,
  idle_after timestamptz,
  last_error_code text,
  updated_at timestamptz not null default statement_timestamp(),
  check ((owner_id is null) = (owner_lease_expires_at is null))
);

create table public.live_host_source_leases (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  source_generation uuid not null,
  host_id text not null,
  source_ready boolean not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  primary key (session_id, source_generation)
);
create unique index live_host_source_one_current_idx on public.live_host_source_leases(session_id)
  where revoked_at is null;

create table public.live_viewer_presence_leases (
  connection_id uuid primary key,
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  grant_id uuid not null references public.viewer_grants(id) on delete cascade,
  user_id text not null,
  epoch integer not null check (epoch > 0),
  owner_id uuid,
  state text not null check (state in ('pending','connected','closed')),
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  check (state <> 'connected' or owner_id is not null)
);
create unique index live_viewer_one_pending_per_grant_idx
  on public.live_viewer_presence_leases(session_id, grant_id) where state = 'pending';
create index live_viewer_presence_demand_idx
  on public.live_viewer_presence_leases(session_id, epoch, state, expires_at);

alter table public.live_session_runtime enable row level security;
alter table public.live_host_source_leases enable row level security;
alter table public.live_viewer_presence_leases enable row level security;
alter table public.live_media_recording_gaps enable row level security;
revoke all on public.live_session_runtime, public.live_host_source_leases,
  public.live_viewer_presence_leases, public.live_media_recording_gaps
  from public, anon, authenticated, service_role;

create or replace function public.get_live_media_runtime_v1(p_session_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  with authority as (
    select runtime.*, session_row.status as session_status,
      session_row.archive_deleted_at, session_row.expires_at as session_expires_at,
      exists (select 1 from public.live_host_source_leases source_row
        where source_row.session_id = runtime.session_id and source_row.source_ready
          and source_row.revoked_at is null and source_row.expires_at > statement_timestamp()
          and source_row.host_id = session_row.host_id) as source_ready
    from public.live_session_runtime runtime
    join public.live_sessions session_row on session_row.id = runtime.session_id
    where runtime.session_id = p_session_id
  ), demand as (
    select count(*) filter (where lease.state = 'connected') as connected_count,
      count(*) filter (where lease.state = 'pending') as pending_count
    from public.live_viewer_presence_leases lease
    join authority on authority.session_id = lease.session_id and authority.epoch = lease.epoch
    join public.viewer_grants grant_row on grant_row.id = lease.grant_id
      and grant_row.session_id = lease.session_id and grant_row.user_id = lease.user_id
      and grant_row.revoked_at is null and grant_row.expires_at > statement_timestamp()
    join public.live_participants participant_row on participant_row.session_id = lease.session_id
      and participant_row.grant_id = lease.grant_id and participant_row.user_id = lease.user_id
    where lease.expires_at > statement_timestamp()
      and (lease.state = 'pending' or lease.owner_id = authority.owner_id)
  )
  select jsonb_build_object(
    'sessionId', authority.session_id,
    'state', case when authority.session_status in ('stopped','failed')
      or authority.archive_deleted_at is not null then 'ended' else authority.state end,
    'epoch', authority.epoch,
    'hostSourceReady', authority.source_ready and authority.session_expires_at > statement_timestamp(),
    'hasDemand', demand.connected_count + demand.pending_count > 0,
    'connectedCount', demand.connected_count, 'pendingCount', demand.pending_count,
    'wakeDeadline', authority.wake_deadline, 'idleAfter', authority.idle_after,
    'ownerId', authority.owner_id, 'ownerLeaseExpiresAt', authority.owner_lease_expires_at,
    'startRequestedAt', authority.start_requested_at, 'lastErrorCode', authority.last_error_code,
    'canPrepareConnection', authority.session_status in ('preparing','live','paused')
      and authority.archive_deleted_at is null and authority.session_expires_at > statement_timestamp()
      and authority.state not in ('draining','failed')
  ) from authority cross join demand;
$$;

create or replace function public.request_live_media_start_v1(
  p_session_id uuid, p_host_id text, p_expected_version integer
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from public.live_sessions target where target.id = p_session_id
    and target.host_id = p_host_id and target.version = p_expected_version
    and target.status in ('preparing','live','paused') and target.archive_deleted_at is null
    and target.expires_at > statement_timestamp() for update;
  if not found then
    raise exception using errcode = '42501', message = 'VERSION_CONFLICT_OR_FORBIDDEN';
  end if;
  insert into public.live_session_runtime(session_id) values (p_session_id)
  on conflict (session_id) do nothing;
  update public.live_session_runtime target set state = 'sleeping', last_error_code = null,
    owner_id = null, owner_lease_expires_at = null, wake_deadline = null, idle_after = null
  where target.session_id = p_session_id and target.state = 'failed';
  insert into public.live_media_recording_gaps(session_id, epoch, reason)
  select runtime.session_id, runtime.epoch, 'no_viewers'
  from public.live_session_runtime runtime where runtime.session_id = p_session_id
    and runtime.state = 'sleeping'
  on conflict (session_id) where ended_at is null do nothing;
  return public.get_live_media_runtime_v1(p_session_id);
end;
$$;

create or replace function public.heartbeat_live_host_source_v1(
  p_session_id uuid, p_host_id text, p_source_generation uuid, p_source_ready boolean
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare source_row public.live_host_source_leases%rowtype;
begin
  if p_source_generation is null or p_source_ready is null then
    raise exception using errcode = '22023', message = 'INVALID_HOST_SOURCE_INPUT';
  end if;
  perform 1 from public.live_sessions target where target.id = p_session_id
    and target.host_id = p_host_id and target.status in ('preparing','live','paused')
    and target.archive_deleted_at is null and target.expires_at > statement_timestamp() for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  perform 1 from public.live_session_runtime target where target.session_id = p_session_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MEDIA_START_NOT_REQUESTED';
  end if;
  select target.* into source_row from public.live_host_source_leases target
  where target.session_id = p_session_id and target.source_generation = p_source_generation;
  if found and source_row.revoked_at is not null then
    raise exception using errcode = 'P0001', message = 'HOST_SOURCE_GENERATION_EXPIRED';
  end if;
  if not found then
    if exists (select 1 from public.live_host_source_leases target
      where target.session_id = p_session_id and target.revoked_at is null
        and target.source_ready and target.expires_at > statement_timestamp()) then
      raise exception using errcode = 'P0001', message = 'HOST_SOURCE_CONFLICT';
    end if;
    update public.live_host_source_leases target set revoked_at = statement_timestamp()
    where target.session_id = p_session_id and target.revoked_at is null;
    insert into public.live_host_source_leases (
      session_id, source_generation, host_id, source_ready, expires_at, revoked_at
    ) values (p_session_id, p_source_generation, p_host_id, p_source_ready,
      statement_timestamp() + interval '45 seconds',
      case when p_source_ready then null else statement_timestamp() end);
  else
    update public.live_host_source_leases target set source_ready = p_source_ready,
      expires_at = statement_timestamp() + interval '45 seconds',
      revoked_at = case when p_source_ready then null else statement_timestamp() end
    where target.session_id = p_session_id and target.source_generation = p_source_generation;
  end if;
  return public.get_live_media_runtime_v1(p_session_id);
end;
$$;

create or replace function public.prepare_live_viewer_connection_v1(
  p_session_id uuid, p_grant_id uuid, p_user_id text, p_connection_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  runtime_row public.live_session_runtime%rowtype;
  pending_row public.live_viewer_presence_leases%rowtype;
  authority_deadline timestamptz;
  runtime_json jsonb;
begin
  if p_connection_id is null then
    raise exception using errcode = '22023', message = 'INVALID_VIEWER_CONNECTION_INPUT';
  end if;
  perform 1 from public.live_sessions target where target.id = p_session_id
    and target.status in ('preparing','live','paused') and target.archive_deleted_at is null
    and target.expires_at > statement_timestamp() for update;
  if not found then
    raise exception using errcode = '42501', message = 'LIVE_SESSION_NOT_AVAILABLE';
  end if;
  select least(grant_row.expires_at, session_row.expires_at) into authority_deadline
  from public.viewer_grants grant_row
  join public.live_sessions session_row on session_row.id = grant_row.session_id
  join public.live_participants participant_row on participant_row.session_id = grant_row.session_id
    and participant_row.grant_id = grant_row.id and participant_row.user_id = grant_row.user_id
  where grant_row.session_id = p_session_id and grant_row.id = p_grant_id
    and grant_row.user_id = p_user_id and grant_row.revoked_at is null
    and grant_row.expires_at > statement_timestamp();
  if not found then
    raise exception using errcode = '42501', message = 'VIEWER_ACCESS_REQUIRED';
  end if;
  select target.* into runtime_row from public.live_session_runtime target
  where target.session_id = p_session_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MEDIA_START_NOT_REQUESTED';
  end if;
  runtime_json := public.get_live_media_runtime_v1(p_session_id);
  if runtime_row.state = 'failed' then
    raise exception using errcode = 'P0001', message = 'MEDIA_EXPLICIT_RETRY_REQUIRED';
  end if;
  if not (runtime_json->>'hostSourceReady')::boolean or runtime_row.state = 'draining' then
    return jsonb_build_object('status','HOST_WAITING','runtime',runtime_json,
      'connectionId',null,'expiresAt',null);
  end if;
  select target.* into pending_row from public.live_viewer_presence_leases target
  where target.session_id = p_session_id and target.grant_id = p_grant_id and target.state = 'pending';
  if found and pending_row.expires_at <= statement_timestamp()
    and statement_timestamp() < pending_row.created_at + interval '55 seconds' then
    raise exception using errcode = 'P0001', message = 'VIEWER_CONNECTION_COOLDOWN';
  end if;

  -- 2026-08-31 fix: An abandoned cold wake has no gateway process to run a timer.
  -- The next authenticated mutation fences the old epoch before allocating another.
  if runtime_row.state = 'sleeping'
    or (runtime_row.state = 'waking' and runtime_row.wake_deadline <= statement_timestamp())
    or (runtime_row.owner_id is not null and runtime_row.owner_lease_expires_at <= statement_timestamp()) then
    if runtime_row.epoch = 2147483647 then
      raise exception using errcode = 'P0001', message = 'MEDIA_EPOCH_EXHAUSTED';
    end if;
    update public.live_session_runtime target set state = 'waking', epoch = target.epoch + 1,
      owner_id = null, owner_lease_expires_at = null, idle_after = null,
      wake_deadline = statement_timestamp() + interval '45 seconds', last_error_code = null,
      updated_at = statement_timestamp()
    where target.session_id = p_session_id returning target.* into runtime_row;
    update public.live_viewer_presence_leases target set state = 'closed', expires_at = statement_timestamp()
    where target.session_id = p_session_id and target.state <> 'closed';
    pending_row := null;
  end if;
  if pending_row.connection_id is not null and pending_row.epoch = runtime_row.epoch
    and pending_row.expires_at > statement_timestamp() then
    return jsonb_build_object('status','READY','runtime',public.get_live_media_runtime_v1(p_session_id),
      'connectionId',pending_row.connection_id,'expiresAt',pending_row.expires_at);
  end if;
  update public.live_viewer_presence_leases target set state = 'closed'
  where target.session_id = p_session_id and target.grant_id = p_grant_id and target.state = 'pending';
  insert into public.live_viewer_presence_leases (
    connection_id, session_id, grant_id, user_id, epoch, state, expires_at
  ) values (p_connection_id,p_session_id,p_grant_id,p_user_id,runtime_row.epoch,'pending',
    least(authority_deadline, statement_timestamp() + interval '45 seconds')) returning * into pending_row;
  return jsonb_build_object('status','READY','runtime',public.get_live_media_runtime_v1(p_session_id),
    'connectionId',pending_row.connection_id,'expiresAt',pending_row.expires_at);
end;
$$;

create or replace function public.gateway_live_media_v1(
  p_session_id uuid, p_epoch integer, p_owner_id uuid, p_action text,
  p_connection_id uuid default null, p_grant_id uuid default null, p_user_id text default null,
  p_connection_ids uuid[] default '{}'
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  runtime_row public.live_session_runtime%rowtype;
  runtime_json jsonb;
  affected integer;
begin
  if p_owner_id is null or p_epoch is null or p_epoch < 1 or p_action is null
    or p_action not in ('claim','ready','renew','connect','disconnect','drain','sleep','fail')
    or p_connection_ids is null or cardinality(p_connection_ids) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_MEDIA_RUNTIME_ACTION';
  end if;
  perform 1 from public.live_sessions target where target.id = p_session_id for update;
  select target.* into runtime_row from public.live_session_runtime target
  where target.session_id = p_session_id and target.epoch = p_epoch for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MEDIA_EPOCH_CONFLICT';
  end if;
  runtime_json := public.get_live_media_runtime_v1(p_session_id);
  if runtime_json->>'state' = 'ended' and p_action not in ('sleep','fail','disconnect') then
    raise exception using errcode = 'P0001', message = 'MEDIA_SESSION_ENDED';
  end if;
  if p_action in ('claim','connect') and (
    not (runtime_json->>'hostSourceReady')::boolean
    or not (runtime_json->>'hasDemand')::boolean
    or (runtime_row.state = 'waking' and runtime_row.wake_deadline <= statement_timestamp())
  ) then
    raise exception using errcode = 'P0001', message = 'MEDIA_NOT_READY';
  end if;

  if p_action in ('claim','connect') and runtime_row.owner_id is null then
    if runtime_row.state <> 'waking' or runtime_row.wake_deadline <= statement_timestamp()
      or not (runtime_json->>'hostSourceReady')::boolean
      or not (runtime_json->>'hasDemand')::boolean then
      raise exception using errcode = 'P0001', message = 'MEDIA_NOT_READY';
    end if;
    update public.live_session_runtime target set owner_id = p_owner_id,
      owner_lease_expires_at = statement_timestamp() + interval '45 seconds'
    where target.session_id = p_session_id returning target.* into runtime_row;
  end if;
  if runtime_row.owner_id is distinct from p_owner_id
    or runtime_row.owner_lease_expires_at <= statement_timestamp() then
    raise exception using errcode = 'P0001', message = 'MEDIA_OWNER_CONFLICT';
  end if;

  if p_action = 'connect' then
    if runtime_row.state not in ('waking','active') then
      raise exception using errcode = 'P0001', message = 'MEDIA_NOT_READY';
    end if;
    update public.live_viewer_presence_leases lease set state = 'connected', owner_id = p_owner_id,
      expires_at = least(statement_timestamp() + interval '45 seconds', grant_row.expires_at, session_row.expires_at)
    from public.viewer_grants grant_row, public.live_sessions session_row
    where lease.connection_id = p_connection_id and lease.session_id = p_session_id and lease.epoch = p_epoch
      and lease.grant_id = p_grant_id and lease.user_id = p_user_id
      and lease.state in ('pending','connected') and lease.expires_at > statement_timestamp()
      and (lease.owner_id is null or lease.owner_id = p_owner_id)
      and grant_row.id = lease.grant_id and grant_row.session_id = lease.session_id
      and grant_row.user_id = lease.user_id and grant_row.revoked_at is null
      and grant_row.expires_at > statement_timestamp()
      and session_row.id = lease.session_id and session_row.expires_at > statement_timestamp()
      and exists (select 1 from public.live_participants participant_row
        where participant_row.session_id = lease.session_id and participant_row.grant_id = lease.grant_id
          and participant_row.user_id = lease.user_id);
    get diagnostics affected = row_count;
    if affected <> 1 then
      raise exception using errcode = '42501', message = 'VIEWER_CONNECTION_FORBIDDEN';
    end if;
    update public.live_session_runtime target set idle_after = null where target.session_id = p_session_id;
  elsif p_action = 'disconnect' then
    update public.live_viewer_presence_leases target set state = 'closed', expires_at = statement_timestamp()
    where target.connection_id = p_connection_id and target.session_id = p_session_id
      and target.epoch = p_epoch and target.owner_id = p_owner_id;
  elsif p_action = 'renew' then
    update public.live_viewer_presence_leases lease
    set expires_at = least(statement_timestamp() + interval '45 seconds', grant_row.expires_at, session_row.expires_at)
    from public.viewer_grants grant_row, public.live_sessions session_row
    where lease.connection_id = any(p_connection_ids) and lease.session_id = p_session_id
      and lease.epoch = p_epoch and lease.owner_id = p_owner_id and lease.state = 'connected'
      and lease.expires_at > statement_timestamp()
      and grant_row.id = lease.grant_id and grant_row.session_id = lease.session_id
      and grant_row.user_id = lease.user_id and grant_row.revoked_at is null
      and grant_row.expires_at > statement_timestamp()
      and session_row.id = lease.session_id and session_row.expires_at > statement_timestamp()
      and exists (select 1 from public.live_participants participant_row
        where participant_row.session_id = lease.session_id and participant_row.grant_id = lease.grant_id
          and participant_row.user_id = lease.user_id);
    update public.live_session_runtime target set owner_lease_expires_at = statement_timestamp() + interval '45 seconds'
    where target.session_id = p_session_id;
  elsif p_action = 'ready' then
    if runtime_row.state not in ('waking','active')
      or (runtime_row.state = 'waking' and runtime_row.wake_deadline <= statement_timestamp())
      or not (runtime_json->>'hostSourceReady')::boolean
      or (runtime_json->>'connectedCount')::integer < 1 then
      raise exception using errcode = 'P0001', message = 'MEDIA_NOT_READY';
    end if;
    update public.live_session_runtime target set state = 'active', wake_deadline = null, idle_after = null
    where target.session_id = p_session_id;
    update public.live_media_recording_gaps target set ended_at = statement_timestamp()
    where target.session_id = p_session_id and target.ended_at is null;
  elsif p_action = 'drain' then
    if runtime_row.state not in ('waking','active','draining') then
      raise exception using errcode = 'P0001', message = 'MEDIA_NOT_READY';
    end if;
    if runtime_row.state <> 'draining' and (runtime_json->>'hostSourceReady')::boolean
      and not (runtime_row.state = 'waking' and runtime_row.wake_deadline <= statement_timestamp())
      and ((runtime_json->>'connectedCount')::integer > 0 or runtime_row.idle_after is null
        or runtime_row.idle_after > statement_timestamp()) then
      raise exception using errcode = 'P0001', message = 'MEDIA_DRAIN_NOT_DUE';
    end if;
    update public.live_session_runtime target set state = 'draining' where target.session_id = p_session_id;
  elsif p_action in ('sleep','fail') then
    if p_action = 'sleep' and runtime_row.state not in ('draining','waking','failed')
      and runtime_json->>'state' <> 'ended' then
      raise exception using errcode = 'P0001', message = 'MEDIA_DRAIN_REQUIRED';
    end if;
    update public.live_viewer_presence_leases target set state = 'closed', expires_at = statement_timestamp()
    where target.session_id = p_session_id and target.epoch = p_epoch;
    update public.live_session_runtime target set state = case when p_action = 'fail' then 'failed' else 'sleeping' end,
      owner_id = null, owner_lease_expires_at = null, wake_deadline = null, idle_after = null,
      last_error_code = case when p_action = 'fail' then 'MEDIA_FAILED' else null end
    where target.session_id = p_session_id;
    if runtime_json->>'state' <> 'ended' then
      insert into public.live_media_recording_gaps(session_id, epoch, reason)
      values (p_session_id,p_epoch,case when p_action = 'fail' then 'media_failed'
        when not (runtime_json->>'hostSourceReady')::boolean then 'host_unavailable' else 'no_viewers' end)
      on conflict (session_id) where ended_at is null do nothing;
    end if;
  end if;
  runtime_json := public.get_live_media_runtime_v1(p_session_id);
  if runtime_json->>'state' = 'active' and (runtime_json->>'connectedCount')::integer = 0 then
    update public.live_session_runtime target set idle_after = coalesce(target.idle_after,
      statement_timestamp() + interval '30 seconds') where target.session_id = p_session_id;
  end if;
  update public.live_session_runtime target set updated_at = statement_timestamp()
  where target.session_id = p_session_id;
  return public.get_live_media_runtime_v1(p_session_id);
end;
$$;

create or replace function public.end_live_media_runtime_v1()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.status in ('stopped','failed') or new.archive_deleted_at is not null then
    update public.live_session_runtime target set state='sleeping', owner_id=null,
      owner_lease_expires_at=null, wake_deadline=null, idle_after=null,
      updated_at=statement_timestamp() where target.session_id=new.id;
    update public.live_host_source_leases target set source_ready=false,
      revoked_at=coalesce(target.revoked_at,statement_timestamp()) where target.session_id=new.id;
    update public.live_viewer_presence_leases target set state='closed',
      expires_at=least(target.expires_at,statement_timestamp()) where target.session_id=new.id;
    update public.live_media_recording_gaps target set ended_at=new.ended_at
    where target.session_id=new.id and target.ended_at is null
      and new.ended_at is not null and target.started_at<=new.ended_at;
  end if;
  return new;
end;
$$;
create trigger live_media_runtime_terminal_cleanup
after update of status, ended_at, archive_deleted_at on public.live_sessions
for each row execute function public.end_live_media_runtime_v1();

revoke all on function public.end_live_media_runtime_v1() from public, anon, authenticated, service_role;
revoke all on function public.get_live_media_runtime_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function public.request_live_media_start_v1(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.heartbeat_live_host_source_v1(uuid, text, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.prepare_live_viewer_connection_v1(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.gateway_live_media_v1(uuid, integer, uuid, text, uuid, uuid, text, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.get_live_media_runtime_v1(uuid) to service_role;
grant execute on function public.request_live_media_start_v1(uuid, text, integer) to service_role;
grant execute on function public.heartbeat_live_host_source_v1(uuid, text, uuid, boolean) to service_role;
grant execute on function public.prepare_live_viewer_connection_v1(uuid, uuid, text, uuid) to service_role;
grant execute on function public.gateway_live_media_v1(uuid, integer, uuid, text, uuid, uuid, text, uuid[]) to service_role;
