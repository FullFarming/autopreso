-- `current_time` is a PostgreSQL special value with type time with time zone.
-- Using an unqualified PL/pgSQL variable with that name can therefore resolve to
-- the SQL special value and fail when assigned to a timestamptz column.
create or replace function public.consume_live_rate_limit(
  p_scope text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_count integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_scope is null
    or p_key_hash is null
    or p_limit is null
    or p_window_seconds is null
    or p_scope !~ '^[a-z][a-z0-9-]{1,63}$'
    or p_key_hash !~ '^[0-9a-f]{64}$'
    or p_limit < 1 or p_limit > 10000
    or p_window_seconds < 1 or p_window_seconds > 86400
  then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_INPUT';
  end if;

  insert into public.live_rate_limits as bucket (
    scope, key_hash, window_started_at, request_count, updated_at
  ) values (
    p_scope, p_key_hash, v_now, 1, v_now
  )
  on conflict (scope, key_hash) do update
    set request_count = case
          when bucket.window_started_at + make_interval(secs => p_window_seconds) <= v_now then 1
          else bucket.request_count + 1
        end,
        window_started_at = case
          when bucket.window_started_at + make_interval(secs => p_window_seconds) <= v_now then v_now
          else bucket.window_started_at
        end,
        updated_at = v_now
  returning request_count into current_count;

  return current_count <= p_limit;
end;
$$;

revoke all on function public.consume_live_rate_limit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_live_rate_limit(text, text, integer, integer)
  to service_role;
