-- 2026-08-31 fix: Old gateway generations cannot append into a newly resumed call.
-- Fenced entrypoints lock session then runtime before invoking existing persistence.

create or replace function public.assert_live_media_write_epoch_v1(
  p_session_id uuid, p_epoch integer, p_owner_id uuid
)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from public.live_sessions target where target.id = p_session_id
    and target.status = 'live' and target.archive_deleted_at is null
    and target.expires_at > statement_timestamp() for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MEDIA_SESSION_ENDED';
  end if;
  perform 1 from public.live_session_runtime target where target.session_id = p_session_id
    and target.epoch = p_epoch and target.owner_id = p_owner_id
    and target.owner_lease_expires_at > statement_timestamp()
    and target.state in ('active','draining') for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MEDIA_WRITE_EPOCH_CONFLICT';
  end if;
end;
$$;
revoke all on function public.assert_live_media_write_epoch_v1(uuid, integer, uuid)
  from public, anon, authenticated, service_role;

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
set search_path = ''
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
     and session_row.archive_deleted_at is null
     and (session_row.status in ('live', 'paused') or (
       session_row.status = 'preparing' and exists (
         select 1 from public.live_session_runtime runtime
         join public.live_host_source_leases source_row on source_row.session_id = runtime.session_id
         join public.live_viewer_presence_leases lease on lease.session_id = runtime.session_id
           and lease.epoch = runtime.epoch and lease.grant_id = request_row.grant_id
           and lease.user_id = request_row.user_id and lease.state in ('pending','connected')
           and lease.expires_at > statement_timestamp()
         where runtime.session_id = session_row.id and runtime.state = 'waking'
           and runtime.start_requested_at is not null and runtime.wake_deadline > statement_timestamp()
           and source_row.host_id = session_row.host_id and source_row.source_ready
           and source_row.revoked_at is null and source_row.expires_at > statement_timestamp()
       )
     ))
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

create or replace function public.persist_authoritative_live_source_utterance_v1_fenced_v1(
  p_epoch integer,
  p_owner_id uuid,
  p_session_id uuid,
  p_utterance_key text,
  p_raw_text text,
  p_normalized_text text,
  p_source_language text,
  p_speaker_role text,
  p_speaker_label text,
  p_speaker_name text,
  p_speaker_department text,
  p_speaker_job_title text,
  p_participant_id uuid,
  p_source_started_at timestamptz,
  p_source_ended_at timestamptz,
  p_provider_committed_at timestamptz,
  p_stt_provider text,
  p_stt_model text,
  p_translation_model text,
  p_pipeline_config_fingerprint text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  perform public.assert_live_media_write_epoch_v1(p_session_id, p_epoch, p_owner_id);
  return public.persist_authoritative_live_source_utterance_v1(
    p_session_id, p_utterance_key, p_raw_text, p_normalized_text, p_source_language, p_speaker_role, p_speaker_label, p_speaker_name, p_speaker_department, p_speaker_job_title, p_participant_id, p_source_started_at, p_source_ended_at, p_provider_committed_at, p_stt_provider, p_stt_model, p_translation_model, p_pipeline_config_fingerprint
  );
end;
$$;
revoke all on function public.persist_authoritative_live_source_utterance_v1_fenced_v1(integer, uuid, uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.persist_authoritative_live_source_utterance_v1_fenced_v1(integer, uuid, uuid, text, text, text, text, text, text, text, text, text, uuid, timestamptz, timestamptz, timestamptz, text, text, text, text) to service_role;

create or replace function public.persist_live_final_caption_if_active_fenced_v1(
  p_epoch integer,
  p_owner_id uuid,
  p_session_id uuid,
  p_language text,
  p_event jsonb,
  p_seq bigint,
  p_text text,
  p_speaker_label text,
  p_speaker_name text,
  p_source_started_at timestamptz,
  p_source_ended_at timestamptz,
  p_emitted_at timestamptz,
  p_participant_id uuid,
  p_source_text text,
  p_source_language text,
  p_origin text,
  p_utterance_key text,
  p_translation_status text,
  p_authoritative_source_id uuid
)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  perform public.assert_live_media_write_epoch_v1(p_session_id, p_epoch, p_owner_id);
  return public.persist_live_final_caption_if_active(
    p_session_id, p_language, p_event, p_seq, p_text, p_speaker_label, p_speaker_name, p_source_started_at, p_source_ended_at, p_emitted_at, p_participant_id, p_source_text, p_source_language, p_origin, p_utterance_key, p_translation_status, p_authoritative_source_id
  );
end;
$$;
revoke all on function public.persist_live_final_caption_if_active_fenced_v1(integer, uuid, uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.persist_live_final_caption_if_active_fenced_v1(integer, uuid, uuid, text, jsonb, bigint, text, text, text, timestamptz, timestamptz, timestamptz, uuid, text, text, text, text, text, uuid) to service_role;

revoke all on function public.authorize_live_viewer_grants_v1(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_live_viewer_grants_v1(jsonb) to service_role;
