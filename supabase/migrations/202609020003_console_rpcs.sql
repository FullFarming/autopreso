-- 2026-09-02 console: admin-only RPCs for signup approval, roles, session aggregates,
-- global engine defaults, and the legacy password-login switch. All guards live here.
create table if not exists public.engine_defaults (
  id smallint primary key default 1 check (id = 1),
  engine jsonb not null,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
create table if not exists public.console_settings (
  id smallint primary key default 1 check (id = 1),
  legacy_password_login_enabled boolean not null default true,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
insert into public.console_settings (id) values (1) on conflict (id) do nothing;
alter table public.engine_defaults enable row level security;
alter table public.console_settings enable row level security;
revoke all on table public.engine_defaults, public.console_settings from anon, authenticated;

create or replace function public.assert_console_admin_v1(p_actor_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_actor_id is null or not exists (select 1 from public.profiles p where p.id = p_actor_id and p.status = 'approved' and p.role = 'admin') then
    raise exception 'ACTOR_NOT_ADMIN' using errcode = '42501';
  end if;
end; $$;
revoke all on function public.assert_console_admin_v1(uuid) from public, anon, authenticated, service_role;
grant execute on function public.assert_console_admin_v1(uuid) to service_role;

create or replace function public.list_profiles_admin_v1(p_status text, p_limit integer, p_before timestamptz)
returns table (id uuid, email text, display_name text, status text, role text, host_id text, created_at timestamptz, last_login_at timestamptz, approved_at timestamptz)
language sql security definer set search_path = '' stable as $$
  select p.id, p.email, p.display_name, p.status, p.role, p.host_id, p.created_at, p.last_login_at, p.approved_at
  from public.profiles p
  where (p_status is null or p.status = p_status) and (p_before is null or p.created_at < p_before)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;
revoke all on function public.list_profiles_admin_v1(text,integer,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.list_profiles_admin_v1(text,integer,timestamptz) to service_role;

create or replace function public.count_pending_profiles_v1() returns integer
language sql security definer set search_path = '' stable as $$
  select count(*)::integer from public.profiles p where p.status = 'pending';
$$;
revoke all on function public.count_pending_profiles_v1() from public, anon, authenticated, service_role;
grant execute on function public.count_pending_profiles_v1() to service_role;

create or replace function public.set_profile_status_v1(p_actor_id uuid, p_profile_id uuid, p_status text, p_reason text)
returns table (id uuid, status text, role text)
language plpgsql security definer set search_path = '' as $$
declare target public.profiles%rowtype; action_name text;
begin
  perform public.assert_console_admin_v1(p_actor_id);
  if p_actor_id = p_profile_id then raise exception 'SELF_CHANGE_FORBIDDEN' using errcode = '42501'; end if;
  select * into target from public.profiles p where p.id = p_profile_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not ((target.status = 'pending' and p_status in ('approved','rejected'))
       or (target.status = 'approved' and p_status = 'disabled')
       or (target.status = 'disabled' and p_status = 'approved')
       or (target.status = 'rejected' and p_status = 'approved')) then
    raise exception 'INVALID_TRANSITION' using errcode = '22023';
  end if;
  if target.role = 'admin' and target.status = 'approved' and p_status <> 'approved'
     and (select count(*) from public.profiles p where p.role = 'admin' and p.status = 'approved') <= 1 then
    raise exception 'LAST_ADMIN_PROTECTED' using errcode = '42501';
  end if;
  action_name := case p_status when 'approved' then (case when target.status = 'disabled' then 'enable' else 'approve' end)
                               when 'rejected' then 'reject' when 'disabled' then 'disable' end;
  update public.profiles p set status = p_status,
    approved_at = case when p_status = 'approved' then statement_timestamp() else p.approved_at end,
    approved_by = case when p_status = 'approved' then p_actor_id else p.approved_by end,
    updated_at = statement_timestamp()
  where p.id = p_profile_id;
  insert into public.profile_events (profile_id, actor_id, action, reason) values (p_profile_id, p_actor_id, action_name, nullif(left(btrim(coalesce(p_reason,'')),200), ''));
  return query select p.id, p.status, p.role from public.profiles p where p.id = p_profile_id;
end; $$;
revoke all on function public.set_profile_status_v1(uuid,uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.set_profile_status_v1(uuid,uuid,text,text) to service_role;

create or replace function public.set_profile_role_v1(p_actor_id uuid, p_profile_id uuid, p_role text)
returns table (id uuid, status text, role text)
language plpgsql security definer set search_path = '' as $$
declare target public.profiles%rowtype;
begin
  perform public.assert_console_admin_v1(p_actor_id);
  if p_actor_id = p_profile_id then raise exception 'SELF_CHANGE_FORBIDDEN' using errcode = '42501'; end if;
  if p_role not in ('host','admin') then raise exception 'INVALID_ROLE' using errcode = '22023'; end if;
  select * into target from public.profiles p where p.id = p_profile_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0002'; end if;
  if target.role = 'admin' and p_role = 'host' and target.status = 'approved'
     and (select count(*) from public.profiles p where p.role = 'admin' and p.status = 'approved') <= 1 then
    raise exception 'LAST_ADMIN_PROTECTED' using errcode = '42501';
  end if;
  update public.profiles p set role = p_role, updated_at = statement_timestamp() where p.id = p_profile_id;
  insert into public.profile_events (profile_id, actor_id, action, payload) values (p_profile_id, p_actor_id, 'set_role', jsonb_build_object('from', target.role, 'to', p_role));
  return query select p.id, p.status, p.role from public.profiles p where p.id = p_profile_id;
end; $$;
revoke all on function public.set_profile_role_v1(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.set_profile_role_v1(uuid,uuid,text) to service_role;

create or replace function public.list_sessions_admin_v1(p_since timestamptz, p_limit integer)
returns table (id uuid, title text, host_id text, host_email text, mode text, status text, languages text[], created_at timestamptz, ended_at timestamptz,
               utterance_count bigint, participant_count bigint, summary_status text)
language sql security definer set search_path = '' stable as $$
  select s.id, s.title, s.host_id, p.email, s.mode, s.status, s.languages, s.created_at, s.ended_at,
    (select count(*) from public.live_utterances u where u.session_id = s.id),
    (select count(distinct lp.user_id) from public.live_participants lp where lp.session_id = s.id),
    (select case when bool_or(j.status = 'failed') then 'failed' when bool_and(j.status = 'succeeded') then 'succeeded'
                 when count(*) = 0 then null else 'running' end
       from public.live_summary_generation_jobs j where j.session_id = s.id)
  from public.live_sessions s
  left join public.profiles p on p.host_id = s.host_id
  where s.archive_deleted_at is null and (p_since is null or s.created_at >= p_since)
  order by s.created_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;
revoke all on function public.list_sessions_admin_v1(timestamptz,integer) from public, anon, authenticated, service_role;
grant execute on function public.list_sessions_admin_v1(timestamptz,integer) to service_role;

create or replace function public.read_console_settings_v1()
returns table (legacy_password_login_enabled boolean, engine jsonb, engine_updated_at timestamptz, engine_updated_by_email text)
language sql security definer set search_path = '' stable as $$
  select c.legacy_password_login_enabled, e.engine, e.updated_at, p.email
  from public.console_settings c
  left join public.engine_defaults e on e.id = 1
  left join public.profiles p on p.id = e.updated_by
  where c.id = 1;
$$;
revoke all on function public.read_console_settings_v1() from public, anon, authenticated, service_role;
grant execute on function public.read_console_settings_v1() to service_role;

create or replace function public.set_engine_defaults_v1(p_actor_id uuid, p_engine jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_console_admin_v1(p_actor_id);
  if p_engine is null or jsonb_typeof(p_engine) <> 'object' or octet_length(p_engine::text) > 4000 then raise exception 'ENGINE_INVALID' using errcode = '22023'; end if;
  insert into public.engine_defaults (id, engine, updated_by, updated_at) values (1, p_engine, p_actor_id, statement_timestamp())
  on conflict (id) do update set engine = excluded.engine, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  insert into public.profile_events (profile_id, actor_id, action, payload) values (p_actor_id, p_actor_id, 'engine_defaults', p_engine);
  return true;
end; $$;
revoke all on function public.set_engine_defaults_v1(uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.set_engine_defaults_v1(uuid,jsonb) to service_role;

create or replace function public.set_legacy_password_login_v1(p_actor_id uuid, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_console_admin_v1(p_actor_id);
  update public.console_settings c set legacy_password_login_enabled = coalesce(p_enabled, true), updated_by = p_actor_id, updated_at = statement_timestamp() where c.id = 1;
  return found;
end; $$;
revoke all on function public.set_legacy_password_login_v1(uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_legacy_password_login_v1(uuid,boolean) to service_role;
