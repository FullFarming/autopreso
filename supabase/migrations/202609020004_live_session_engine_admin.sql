-- 2026-09-02 console: the admin "배포" push switches the engine of sessions that are
-- already running. The host PATCH RPC (update_live_session_with_event_v2) locks
-- status = 'preparing', so the console needs its own admin-only path that also
-- accepts 'live'. It rewrites event_metadata.modelPreferences.engine, appends to
-- engineHistory (cap 64, oldest dropped), and bumps version so a running host
-- client notices the change. Event logging stays with the route: one deploy =
-- one profile_events.engine_defaults row, whatever the session count.
create or replace function public.set_live_session_engine_admin_v1(p_actor_id uuid, p_session_id uuid, p_engine jsonb)
returns table (id uuid, status text, version integer)
language plpgsql security definer set search_path = '' as $$
declare
  actor_host_id text;
  section text;
  existing_preferences jsonb;
  history jsonb;
  history_length integer;
  changed_at text := to_char(statement_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  perform public.assert_console_admin_v1(p_actor_id);
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

  select s.event_metadata -> 'modelPreferences' into existing_preferences
  from public.live_sessions s
  where s.id = p_session_id and s.status in ('preparing', 'live') and s.archive_deleted_at is null
  for update;
  if not found then return; end if;

  -- A legacy { source, summary } value is replaced, not merged: the webapp reader accepts
  -- only { engine, engineHistory } once an engine key is present.
  if existing_preferences is null or jsonb_typeof(existing_preferences) <> 'object' or not (existing_preferences ? 'engine') then
    existing_preferences := '{}'::jsonb;
  end if;
  history := existing_preferences -> 'engineHistory';
  if history is null or jsonb_typeof(history) <> 'array' then history := '[]'::jsonb; end if;
  history := history || jsonb_build_array(jsonb_build_object('engine', p_engine, 'changedAt', changed_at, 'byHostId', actor_host_id));
  history_length := jsonb_array_length(history);
  if history_length > 64 then
    select coalesce(jsonb_agg(t.entry order by t.ord), '[]'::jsonb) into history
    from jsonb_array_elements(history) with ordinality as t(entry, ord)
    where t.ord > history_length - 64;
  end if;

  return query
    update public.live_sessions s
    set event_metadata = jsonb_set(coalesce(s.event_metadata, '{}'::jsonb), '{modelPreferences}',
          existing_preferences || jsonb_build_object('engine', p_engine, 'engineHistory', history)),
        version = s.version + 1,
        updated_at = statement_timestamp()
    where s.id = p_session_id and s.status in ('preparing', 'live') and s.archive_deleted_at is null
    returning s.id, s.status, s.version;
end; $$;
revoke all on function public.set_live_session_engine_admin_v1(uuid,uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.set_live_session_engine_admin_v1(uuid,uuid,jsonb) to service_role;

create or replace function public.list_live_session_ids_admin_v1()
returns table (id uuid, status text, languages text[])
language sql security definer set search_path = '' stable as $$
  select s.id, s.status, s.languages
  from public.live_sessions s
  where s.status in ('preparing', 'live') and s.archive_deleted_at is null
  order by s.created_at, s.id;
$$;
revoke all on function public.list_live_session_ids_admin_v1() from public, anon, authenticated, service_role;
grant execute on function public.list_live_session_ids_admin_v1() to service_role;
