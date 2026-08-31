-- Batch live viewer grant authorization for reconnect fan-in.
-- Additive only: the existing single-request RPC remains available.

create or replace function public.authorize_live_viewer_grants_v1(p_requests jsonb)
returns table (
  session_id uuid,
  grant_id uuid,
  user_id text,
  language text,
  authorized boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_requests is null or jsonb_typeof(p_requests) <> 'array' then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_INVALID';
  end if;

  if jsonb_array_length(p_requests) = 0 then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_EMPTY';
  end if;

  if jsonb_array_length(p_requests) > 50 then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_TOO_LARGE';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_requests) with ordinality as request_item(value, ordinal)
    where jsonb_typeof(request_item.value) <> 'object'
      or (
        select array_agg(key order by key)
        from jsonb_object_keys(request_item.value) as key
      ) is distinct from array['grant_id', 'language', 'session_id', 'user_id']
  ) then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_SHAPE';
  end if;

  if exists (
    with request_rows as (
      select
        request_item.ordinal,
        request_item.value ->> 'session_id' as session_id_text,
        request_item.value ->> 'grant_id' as grant_id_text,
        request_item.value ->> 'user_id' as user_id,
        request_item.value ->> 'language' as language
      from jsonb_array_elements(p_requests) with ordinality as request_item(value, ordinal)
    )
    select 1
    from request_rows request_row
    where request_row.session_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or request_row.grant_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or request_row.user_id is null
      or length(request_row.user_id) not between 1 and 256
      or public.live_language_valid(request_row.language) is not true
  ) then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_SHAPE';
  end if;

  if exists (
    with request_rows as (
      select
        (request_item.value ->> 'session_id')::uuid as session_id,
        (request_item.value ->> 'grant_id')::uuid as grant_id,
        request_item.value ->> 'user_id' as user_id,
        request_item.value ->> 'language' as language
      from jsonb_array_elements(p_requests) with ordinality as request_item(value, ordinal)
    )
    select 1
    from request_rows request_row
    group by request_row.session_id, request_row.grant_id, request_row.user_id, request_row.language
    having count(*) > 1
  ) then
    raise exception using errcode = 'P0001', message = 'LIVE_VIEWER_AUTH_BATCH_DUPLICATE';
  end if;

  return query
  with request_rows as (
    select
      request_item.ordinal,
      (request_item.value ->> 'session_id')::uuid as session_id,
      (request_item.value ->> 'grant_id')::uuid as grant_id,
      request_item.value ->> 'user_id' as user_id,
      request_item.value ->> 'language' as language
    from jsonb_array_elements(p_requests) with ordinality as request_item(value, ordinal)
  ),
  authorized_rows as (
    select
      request_row.ordinal,
      true as authorized
    from request_rows request_row
    join public.live_sessions session_row
      on session_row.id = request_row.session_id
     and session_row.status in ('live', 'paused')
     and session_row.expires_at > statement_timestamp()
     and public.live_languages_canonical(session_row.languages)
     and request_row.language = any(session_row.languages)
    join public.viewer_grants grant_row
      on grant_row.session_id = request_row.session_id
     and grant_row.id = request_row.grant_id
     and grant_row.user_id = request_row.user_id
     and grant_row.revoked_at is null
     and grant_row.expires_at > statement_timestamp()
  )
  select
    request_row.session_id,
    request_row.grant_id,
    request_row.user_id,
    request_row.language,
    coalesce(authorized_row.authorized, false) as authorized
  from request_rows request_row
  left join authorized_rows authorized_row on authorized_row.ordinal = request_row.ordinal
  order by request_row.ordinal;
end;
$$;

revoke all on function public.authorize_live_viewer_grants_v1(jsonb)
  from public, anon, authenticated;

grant execute on function public.authorize_live_viewer_grants_v1(jsonb)
  to service_role;
