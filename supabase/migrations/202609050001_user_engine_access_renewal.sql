-- 2026-09-05 feat: Assign the next session's provider without rewriting an active session.
-- Existing profiles receive Soniox revision 1. Existing session engine snapshots remain unchanged.
alter table public.profiles
  add column if not exists voice_provider text not null default 'soniox'
    check (voice_provider in ('soniox', 'gemini')),
  add column if not exists voice_provider_revision bigint not null default 1
    check (voice_provider_revision > 0);

create or replace function public.read_host_voice_assignment_v1(p_host_id text)
returns table (provider text, revision bigint)
language sql stable security definer set search_path = '' as $$
  select p.voice_provider, p.voice_provider_revision from public.profiles p
  where p.host_id = p_host_id and p.status = 'approved';
$$;
revoke all on function public.read_host_voice_assignment_v1(text) from public, anon, authenticated, service_role;
grant execute on function public.read_host_voice_assignment_v1(text) to service_role;

create or replace function public.set_profile_voice_provider_v1(p_actor_id uuid, p_profile_id uuid, p_provider text)
returns table (provider text, revision bigint)
language plpgsql security definer set search_path = '' as $$
declare target public.profiles%rowtype;
begin
  perform public.assert_console_admin_v1(p_actor_id);
  if p_provider is null or p_provider not in ('soniox', 'gemini') then
    raise exception 'VOICE_PROVIDER_INVALID' using errcode = '22023';
  end if;
  select p.* into target from public.profiles p where p.id = p_profile_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0001'; end if;
  if target.voice_provider is distinct from p_provider then
    update public.profiles p set voice_provider = p_provider,
      voice_provider_revision = p.voice_provider_revision + 1, updated_at = statement_timestamp()
    where p.id = p_profile_id;
    insert into public.profile_events(profile_id, actor_id, action, payload)
      values(p_profile_id, p_actor_id, 'engine_defaults', jsonb_build_object(
        'kind', 'user_assignment', 'provider', p_provider,
        'revision', target.voice_provider_revision + 1, 'effective', 'next_session'));
  end if;
  return query select p.voice_provider, p.voice_provider_revision from public.profiles p where p.id = p_profile_id;
end;
$$;
revoke all on function public.set_profile_voice_provider_v1(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.set_profile_voice_provider_v1(uuid,uuid,text) to service_role;

create or replace function public.list_profiles_admin_v2(p_status text, p_limit integer, p_before timestamptz)
returns table (id uuid, email text, display_name text, status text, role text, host_id text, created_at timestamptz, last_login_at timestamptz, approved_at timestamptz, voice_provider text, voice_provider_revision bigint)
language sql stable security definer set search_path = '' as $$
  select p.id, p.email, p.display_name, p.status, p.role, p.host_id, p.created_at,
    p.last_login_at, p.approved_at, p.voice_provider, p.voice_provider_revision
  from public.profiles p
  where (p_status is null or p.status = p_status) and (p_before is null or p.created_at < p_before)
  order by p.created_at desc, p.id
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;
revoke all on function public.list_profiles_admin_v2(text,integer,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.list_profiles_admin_v2(text,integer,timestamptz) to service_role;

-- 2026-09-05 fix: Renew before the six-hour boundary, while authorization remains live.
-- A service caller must first verify the host identity; an untrusted host_id is not authentication.
create or replace function public.renew_live_session_access_v1(
  p_session_id uuid, p_host_id text, p_expected_version integer
)
returns integer language plpgsql security definer set search_path = '' as $$
declare session_row public.live_sessions%rowtype; next_version integer; next_deadline timestamptz; extend_admission boolean;
begin
  if p_session_id is null or p_host_id is null or char_length(p_host_id) not between 1 and 256
    or p_host_id <> btrim(p_host_id) or p_host_id ~ '[[:cntrl:]]'
    or p_expected_version is null or p_expected_version < 1 or p_expected_version >= 2147483647 then
    raise exception 'INVALID_LIVE_SESSION_RENEWAL_INPUT' using errcode = '22023';
  end if;
  if exists(select 1 from public.profiles p where p.host_id = p_host_id and p.status <> 'approved') then
    raise exception 'VERSION_CONFLICT_OR_FORBIDDEN' using errcode = '42501';
  end if;
  select s.* into session_row from public.live_sessions s
  where s.id = p_session_id and s.host_id = p_host_id and s.version = p_expected_version
    and s.status in ('preparing','live','paused') and s.archive_deleted_at is null for update;
  if not found then raise exception 'VERSION_CONFLICT_OR_FORBIDDEN' using errcode = 'P0001'; end if;
  if session_row.expires_at > statement_timestamp() + interval '15 minutes' then return session_row.version; end if;
  next_deadline := greatest(statement_timestamp(), coalesce(session_row.scheduled_at, statement_timestamp())) + interval '6 hours';
  -- Keep an explicitly shorter/closed invitation unchanged; only a live, open window
  -- that followed the old access boundary is carried forward by authenticated activity.
  extend_admission := session_row.status = 'live' and session_row.admission_state = 'open'
    and session_row.admission_open_until = session_row.expires_at
    and session_row.admission_open_until > statement_timestamp();
  update public.live_sessions s set access_window_started_at = statement_timestamp(),
    expires_at = next_deadline,
    admission_open_until = case when extend_admission then next_deadline else s.admission_open_until end,
    version = s.version + 1, updated_at = statement_timestamp()
  where s.id = session_row.id and s.host_id = p_host_id and s.version = p_expected_version
    and s.status in ('preparing','live','paused') and s.archive_deleted_at is null
  returning s.version into next_version;
  if next_version is null then raise exception 'VERSION_CONFLICT_OR_FORBIDDEN' using errcode = 'P0001'; end if;
  if extend_admission then
    update public.live_session_invites invite_row set expires_at = next_deadline
    where invite_row.session_id = p_session_id and invite_row.revoked_at is null
      and invite_row.expires_at = session_row.expires_at
      and invite_row.expires_at > statement_timestamp();
  end if;
  return next_version;
end;
$$;
revoke all on function public.renew_live_session_access_v1(uuid,text,integer) from public, anon, authenticated, service_role;
grant execute on function public.renew_live_session_access_v1(uuid,text,integer) to service_role;

-- 2026-09-05 fix: Renew only the authenticated, still-valid viewer grant.
-- Expired or revoked credentials must re-enter admission; host renewal never revives them.
create or replace function public.renew_live_viewer_access_v1(
  p_session_id uuid, p_grant_id uuid, p_user_id text
)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare deadline timestamptz; renewed_until timestamptz;
begin
  select s.expires_at into deadline from public.live_sessions s
  where s.id = p_session_id and s.status in ('preparing','live','paused')
    and s.archive_deleted_at is null and s.expires_at > statement_timestamp() for update;
  if not found then raise exception 'VIEWER_RENEWAL_FORBIDDEN' using errcode = '42501'; end if;
  update public.viewer_grants grant_row
  set expires_at = least(deadline, statement_timestamp() + interval '6 hours')
  where grant_row.id = p_grant_id and grant_row.session_id = p_session_id
    and grant_row.user_id = p_user_id
    and grant_row.revoked_at is null and grant_row.expires_at > statement_timestamp()
  returning grant_row.expires_at into renewed_until;
  if renewed_until is null then raise exception 'VIEWER_RENEWAL_FORBIDDEN' using errcode = '42501'; end if;
  return renewed_until;
end;
$$;
revoke all on function public.renew_live_viewer_access_v1(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.renew_live_viewer_access_v1(uuid,uuid,text) to service_role;

-- 2026-09-05 chore: Deprecated immediate-switch RPC remains for audit/rollback only.
-- Application server callers must use profile assignments for the next session.
revoke all on function public.set_live_session_engine_admin_v1(uuid,uuid,jsonb) from public, anon, authenticated, service_role;
