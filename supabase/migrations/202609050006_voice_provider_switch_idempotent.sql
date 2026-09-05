-- 2026-09-05 decision D1 fix round (T2b review I1 / M1 / I3). 202609050005 may already be applied,
-- so it is left untouched; everything here is additive and idempotent (create or replace, no drops).
--
-- I1  set_profile_voice_provider_v2 is a no-op when the provider is unchanged, but the console
--     could not tell and still re-deployed every running session (history entries, version bumps,
--     and the gateway's 2 s switch cooldown → 429 ENGINE_SWITCH_RATE_LIMITED shown as 실패).
--     v3 returns the same row plus `changed`, so the route skips the deploy when nothing changed.
-- M1  set_live_session_engine_admin_v2 wrote assignmentRevision with a jsonb_set AFTER v1's
--     ≤ 8-entry / 3800-byte trimming loop, so the record could end up above the budget the loop
--     had just enforced. v3 copies v1's loop (it does not call v1) and folds the revision into the
--     modelPreferences object BEFORE the loop measures it.
-- I3  read_profile_admin_v1 gives the console the target's host_id from the profile row, so the
--     exact active-session count endpoint never trusts a client-supplied host id.

create or replace function public.set_profile_voice_provider_v3(p_actor_id uuid, p_profile_id uuid, p_provider text)
returns table (id uuid, status text, role text, host_id text, provider text, revision bigint, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  target public.profiles%rowtype;
  did_change boolean := false;
begin
  perform public.assert_console_admin_v1(p_actor_id);
  if p_provider is null or p_provider not in ('soniox', 'gemini') then
    raise exception 'VOICE_PROVIDER_INVALID' using errcode = '22023';
  end if;
  select p.* into target from public.profiles p where p.id = p_profile_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0001'; end if;
  if target.voice_provider is distinct from p_provider then
    did_change := true;
    update public.profiles p set voice_provider = p_provider,
      voice_provider_revision = p.voice_provider_revision + 1, updated_at = statement_timestamp()
    where p.id = p_profile_id;
    insert into public.profile_events(profile_id, actor_id, action, payload)
      values(p_profile_id, p_actor_id, 'engine_defaults', jsonb_build_object(
        'kind', 'user_assignment', 'provider', p_provider,
        'revision', target.voice_provider_revision + 1, 'effective', 'immediate'));
  end if;
  return query select p.id, p.status, p.role, p.host_id, p.voice_provider, p.voice_provider_revision, did_change
    from public.profiles p where p.id = p_profile_id;
end;
$$;
revoke all on function public.set_profile_voice_provider_v3(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.set_profile_voice_provider_v3(uuid,uuid,text) to service_role;

-- v1's rewrite verbatim (structure check, history cap 8, 3800-byte loop, version bump), except that
-- `assignmentRevision` is part of the modelPreferences object the loop measures. A null revision
-- keeps whatever the record already carries (inside the budget too, since it is in the base object).
create or replace function public.set_live_session_engine_admin_v3(p_actor_id uuid, p_session_id uuid, p_engine jsonb, p_assignment_revision text)
returns table (id uuid, status text, version integer)
language plpgsql security definer set search_path = '' as $$
declare
  actor_host_id text;
  section text;
  current_metadata jsonb;
  existing_preferences jsonb;
  base_preferences jsonb;
  history jsonb;
  history_length integer;
  next_metadata jsonb;
  changed_at text := to_char(statement_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  perform public.assert_console_admin_v1(p_actor_id);
  if p_assignment_revision is not null and p_assignment_revision !~ '^[1-9][0-9]{0,18}$' then
    raise exception 'ASSIGNMENT_REVISION_INVALID' using errcode = '22023';
  end if;
  -- Structure only: each of stt/translation/summary is an object with text provider/model.
  -- The catalog check (known providers and models) is the webapp's before it calls here.
  if p_engine is null or jsonb_typeof(p_engine) <> 'object' or octet_length(p_engine::text) > 4000 then
    raise exception 'ENGINE_INVALID' using errcode = '22023';
  end if;
  foreach section in array array['stt', 'translation', 'summary'] loop
    if jsonb_typeof(p_engine -> section) is distinct from 'object'
       or jsonb_typeof(p_engine -> section -> 'provider') is distinct from 'string'
       or jsonb_typeof(p_engine -> section -> 'model') is distinct from 'string' then
      raise exception 'ENGINE_INVALID' using errcode = '22023';
    end if;
  end loop;
  select p.host_id into actor_host_id from public.profiles p where p.id = p_actor_id;

  select coalesce(s.event_metadata, '{}'::jsonb), s.event_metadata -> 'modelPreferences' into current_metadata, existing_preferences
  from public.live_sessions s
  where s.id = p_session_id and s.status in ('preparing', 'live') and s.archive_deleted_at is null
  for update;
  if not found then return; end if;

  -- A legacy { source, summary } value is replaced, not merged: the webapp reader accepts
  -- only { engine, engineHistory, assignmentRevision? } once an engine key is present.
  if existing_preferences is null or jsonb_typeof(existing_preferences) <> 'object' or not (existing_preferences ? 'engine') then
    existing_preferences := '{}'::jsonb;
  end if;
  -- The revision joins the base object here, BEFORE the byte budget is measured (M1).
  base_preferences := existing_preferences || jsonb_build_object('engine', p_engine);
  if p_assignment_revision is not null then
    base_preferences := base_preferences || jsonb_build_object('assignmentRevision', p_assignment_revision);
  end if;
  history := existing_preferences -> 'engineHistory';
  if history is null or jsonb_typeof(history) <> 'array' then history := '[]'::jsonb; end if;
  history := history || jsonb_build_array(jsonb_build_object('engine', p_engine, 'changedAt', changed_at, 'byHostId', actor_host_id, 'reason', 'admin'));
  history_length := jsonb_array_length(history);
  if history_length > 8 then
    select coalesce(jsonb_agg(t.entry order by t.ord), '[]'::jsonb) into history
    from jsonb_array_elements(history) with ordinality as t(entry, ord)
    where t.ord > history_length - 8;
  end if;
  -- Byte budget on the body the row will actually hold (agenda, foreign keys and the revision included).
  loop
    next_metadata := jsonb_set(current_metadata, '{modelPreferences}', base_preferences || jsonb_build_object('engineHistory', history));
    exit when octet_length(next_metadata::text) <= 3800 or jsonb_array_length(history) = 0;
    history := history - 0; -- drop the oldest entry
  end loop;

  return query
    update public.live_sessions s
    set event_metadata = next_metadata,
        version = s.version + 1,
        updated_at = statement_timestamp()
    where s.id = p_session_id and s.status in ('preparing', 'live') and s.archive_deleted_at is null
    returning s.id, s.status, s.version;
end; $$;
revoke all on function public.set_live_session_engine_admin_v3(uuid,uuid,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.set_live_session_engine_admin_v3(uuid,uuid,jsonb,text) to service_role;

-- One profile by id for the console (admin actor only): the host_id the active-session count and
-- the switch derive from. No row for an unknown id - the route answers 404, the RPC does not raise.
create or replace function public.read_profile_admin_v1(p_actor_id uuid, p_profile_id uuid)
returns table (id uuid, status text, role text, host_id text, voice_provider text, voice_provider_revision bigint)
language plpgsql security definer set search_path = '' stable as $$
begin
  perform public.assert_console_admin_v1(p_actor_id);
  return query select p.id, p.status, p.role, p.host_id, p.voice_provider, p.voice_provider_revision
    from public.profiles p where p.id = p_profile_id;
end; $$;
revoke all on function public.read_profile_admin_v1(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.read_profile_admin_v1(uuid,uuid) to service_role;
