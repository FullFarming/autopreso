-- 2026-09-05 decision D1: the Live Call engine is assigned PER USER (profiles.voice_provider,
-- default soniox) by the operator (global admin) only. A change applies IMMEDIATELY to that
-- user's running sessions and persists for future sessions; hosts cannot change it.
-- 202609050001 revoked set_live_session_engine_admin_v1 from service_role ("next session only").
-- D1 reverses that: the console's PATCH /api/console/users { voiceProvider } writes the
-- profile, then per preparing|live session calls the admin RPC (DB first) and the gateway's
-- POST /internal/sessions/:id/engine (pipeline swap, contract C1 kept). Everything here is
-- additive and idempotent: one re-grant plus three new RPC variants; nothing is dropped.
grant execute on function public.set_live_session_engine_admin_v1(uuid,uuid,jsonb) to service_role;

-- The v1 rewrite (engine + capped/byte-budgeted engineHistory, version bump) plus the profile's
-- assignment revision on the session record, so the desktop re-pin (906fe46) and the web host
-- read a record consistent with the profile. A null revision leaves the stored one alone.
create or replace function public.set_live_session_engine_admin_v2(p_actor_id uuid, p_session_id uuid, p_engine jsonb, p_assignment_revision text)
returns table (id uuid, status text, version integer)
language plpgsql security definer set search_path = '' as $$
declare
  switched record;
begin
  if p_assignment_revision is not null and p_assignment_revision !~ '^[1-9][0-9]{0,18}$' then
    raise exception 'ASSIGNMENT_REVISION_INVALID' using errcode = '22023';
  end if;
  select * into switched from public.set_live_session_engine_admin_v1(p_actor_id, p_session_id, p_engine);
  if not found then return; end if;
  if p_assignment_revision is not null then
    update public.live_sessions s
    set event_metadata = jsonb_set(s.event_metadata, '{modelPreferences,assignmentRevision}', to_jsonb(p_assignment_revision))
    where s.id = switched.id;
  end if;
  return query select switched.id, switched.status, switched.version;
end; $$;
revoke all on function public.set_live_session_engine_admin_v2(uuid,uuid,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.set_live_session_engine_admin_v2(uuid,uuid,jsonb,text) to service_role;

-- The sessions a per-user switch targets: that host's preparing/live, not archive-deleted, oldest first.
create or replace function public.list_live_session_ids_for_host_admin_v1(p_host_id text)
returns table (id uuid, status text, languages text[])
language sql security definer set search_path = '' stable as $$
  select s.id, s.status, s.languages
  from public.live_sessions s
  where s.host_id = p_host_id and s.status in ('preparing', 'live') and s.archive_deleted_at is null
  order by s.created_at, s.id;
$$;
revoke all on function public.list_live_session_ids_for_host_admin_v1(text) from public, anon, authenticated, service_role;
grant execute on function public.list_live_session_ids_for_host_admin_v1(text) to service_role;

-- set_profile_voice_provider_v1 returned only (provider, revision) and logged effective =
-- 'next_session'. v2 also returns the profile identity the route responds with and needs for the
-- host-scoped session list, and logs effective = 'immediate'. The revision bumps only on a change.
create or replace function public.set_profile_voice_provider_v2(p_actor_id uuid, p_profile_id uuid, p_provider text)
returns table (id uuid, status text, role text, host_id text, provider text, revision bigint)
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
        'revision', target.voice_provider_revision + 1, 'effective', 'immediate'));
  end if;
  return query select p.id, p.status, p.role, p.host_id, p.voice_provider, p.voice_provider_revision
    from public.profiles p where p.id = p_profile_id;
end;
$$;
revoke all on function public.set_profile_voice_provider_v2(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.set_profile_voice_provider_v2(uuid,uuid,text) to service_role;
