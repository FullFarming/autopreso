-- 2026-09-02 console: one audit row per "배포" (spec §9 감사). set_engine_defaults_v1
-- stores p_engine as engine_defaults.engine AND logs the same value as its own
-- profile_events.engine_defaults payload, so the per-session outcome of a deploy
-- cannot ride on that argument without polluting the stored engine object. The
-- route calls this after the session fan-out with
-- { engine, sessionsSwitched, sessionsFailed, sessionsQueued }; the row is tagged
-- kind = 'deploy' so it can be told apart from the bare engine row. The action
-- stays 'engine_defaults' (the check constraint on profile_events.action is not
-- widened). Additive: no table or column changes.
create or replace function public.record_console_deploy_v1(p_actor_id uuid, p_payload jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  counter text;
  counter_value numeric;
begin
  perform public.assert_console_admin_v1(p_actor_id);
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 8000
     or jsonb_typeof(p_payload -> 'engine') is distinct from 'object' then
    raise exception 'DEPLOY_PAYLOAD_INVALID' using errcode = '22023';
  end if;
  foreach counter in array array['sessionsSwitched', 'sessionsFailed', 'sessionsQueued'] loop
    if jsonb_typeof(p_payload -> counter) is distinct from 'number' then
      raise exception 'DEPLOY_PAYLOAD_INVALID' using errcode = '22023';
    end if;
    counter_value := (p_payload ->> counter)::numeric;
    if counter_value < 0 or counter_value <> floor(counter_value) then
      raise exception 'DEPLOY_PAYLOAD_INVALID' using errcode = '22023';
    end if;
  end loop;
  insert into public.profile_events (profile_id, actor_id, action, payload)
  values (p_actor_id, p_actor_id, 'engine_defaults', p_payload || jsonb_build_object('kind', 'deploy'));
  return true;
end; $$;
revoke all on function public.record_console_deploy_v1(uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.record_console_deploy_v1(uuid,jsonb) to service_role;
