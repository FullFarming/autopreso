-- 2026-08-31 feat: A recap request records consent, never an email delivery.
-- The read window is anchored to the actual meeting end, not a cookie refresh.

alter table public.live_participants
  add column if not exists records_revoked_at timestamptz;

comment on column public.live_participants.records_revoked_at is
  'Explicit read-only records revocation; live grant cleanup does not revoke durable membership.';

create table public.live_recap_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  participant_id uuid not null references public.live_participants(id) on delete cascade,
  consent_id uuid not null references public.live_participant_consents(id),
  consent_revision integer not null check (consent_revision > 0),
  notice_version text not null check (notice_version = 'summary-original-email-v2'),
  email text not null check (public.is_valid_live_attendee_email(email)),
  idempotency_key uuid not null,
  requested_at timestamptz not null default statement_timestamp(),
  unique (session_id, participant_id),
  unique (participant_id, idempotency_key)
);

alter table public.live_recap_requests enable row level security;
revoke all on public.live_recap_requests from public, anon, authenticated, service_role;
comment on table public.live_recap_requests is
  'Explicit summary-and-original email requests. No sender, email verification, delivery claim, or marketing opt-in is implied.';

create table public.live_media_recording_gaps (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  epoch integer not null,
  started_at timestamptz not null default statement_timestamp(),
  ended_at timestamptz,
  reason text not null check (reason in ('no_viewers','host_unavailable','media_failed')),
  check (ended_at is null or ended_at >= started_at)
);
create unique index live_media_one_open_gap_idx on public.live_media_recording_gaps(session_id)
  where ended_at is null;

alter table public.live_media_recording_gaps enable row level security;
revoke all on public.live_media_recording_gaps from public, anon, authenticated, service_role;

create or replace function public.read_participant_live_record_access_v1(
  p_session_id uuid,
  p_user_id text
)
returns table (
  session_id uuid, title text, scheduled_at timestamptz, status text,
  ended_at timestamptz, records_expires_at timestamptz,
  session_type text, output_mode text, voice_provider text, glossary_pack text,
  languages text[], max_viewers integer, participant_id uuid, user_id text,
  display_name text, email text, company text, department text, job_title text,
  summary_consent_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  participant_row public.live_participants%rowtype;
begin
  if p_session_id is null or p_user_id is null
    or char_length(p_user_id) not between 1 and 256 then
    raise exception using errcode = '42501', message = 'RECAP_FORBIDDEN';
  end if;
  select target.* into session_row from public.live_sessions target
  where target.id = p_session_id and target.archive_deleted_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'RECAP_FORBIDDEN';
  end if;
  select target.* into participant_row from public.live_participants target
  where target.session_id = p_session_id and target.user_id = p_user_id
    and target.records_revoked_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'RECAP_FORBIDDEN';
  end if;
  if session_row.status not in ('stopped', 'failed') or session_row.ended_at is null then
    raise exception using errcode = 'P0001', message = 'RECAP_NOT_READY';
  end if;
  if statement_timestamp() >= session_row.ended_at + interval '6 hours' then
    raise exception using errcode = 'P0001', message = 'RECAP_EXPIRED';
  end if;
  return query select session_row.id, session_row.title, session_row.scheduled_at,
    session_row.status, session_row.ended_at, session_row.ended_at + interval '6 hours',
    session_row.session_type, session_row.output_mode, session_row.voice_provider,
    session_row.glossary_pack, session_row.languages, session_row.max_viewers,
    participant_row.id, participant_row.user_id, participant_row.display_name,
    participant_row.email, participant_row.company, participant_row.department,
    participant_row.job_title, participant_row.summary_consent_at;
end;
$$;

-- 2026-08-31 fix: Legacy authenticated SELECT policies cannot bypass the new deadline.
-- This predicate derives the identity from auth.uid(), never a caller argument.
create or replace function public.can_read_live_recap_v1(p_session_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.live_sessions session_row
    join public.live_participants participant_row on participant_row.session_id = session_row.id
    where session_row.id = p_session_id
      and session_row.archive_deleted_at is null
      and session_row.status in ('stopped', 'failed')
      and session_row.ended_at is not null
      and statement_timestamp() < session_row.ended_at + interval '6 hours'
      and participant_row.user_id = (select auth.uid())::text
      and participant_row.records_revoked_at is null
  );
$$;

alter policy live_recap_grants_owner_select on public.live_recap_grants
  using (user_id = (select auth.uid())::text and public.can_read_live_recap_v1(session_id));
alter policy live_sessions_recap_viewer_select on public.live_sessions
  using (public.can_read_live_recap_v1(id));
alter policy live_utterances_recap_select on public.live_utterances
  using (public.can_read_live_recap_v1(session_id) or exists (
    select 1 from public.live_sessions session_row
    where session_row.id = live_utterances.session_id
      and session_row.host_id = (select auth.uid())::text
      and session_row.archive_deleted_at is null
      and session_row.status in ('stopped', 'failed')
  ));
alter policy live_meeting_summaries_recap_select on public.live_meeting_summaries
  using (public.can_read_live_recap_v1(session_id) or exists (
    select 1 from public.live_sessions session_row
    where session_row.id = live_meeting_summaries.session_id
      and session_row.host_id = (select auth.uid())::text
      and session_row.archive_deleted_at is null
      and session_row.status in ('stopped', 'failed')
  ));

create or replace function public.read_participant_live_source_transcript_v1(
  p_session_id uuid, p_user_id text,
  p_after_source_seq bigint default 0, p_limit integer default 200
)
returns table (
  source_utterance_id uuid, source_seq bigint, effective_text text,
  source_language text, speaker_label text, source_started_at timestamptz,
  source_ended_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform 1 from public.read_participant_live_record_access_v1(p_session_id, p_user_id);
  if p_after_source_seq is null or p_after_source_seq < 0
    or p_limit is null or p_limit not between 1 and 501 then
    raise exception using errcode = '22023', message = 'INVALID_RECAP_TRANSCRIPT_INPUT';
  end if;
  return query select source_row.id, source_row.source_seq,
    coalesce(correction.corrected_text, source_row.normalized_text),
    source_row.source_language,
    coalesce(source_row.speaker_label,
      case when source_row.speaker_role = 'host' then '진행자' else '참여자' end),
    source_row.source_started_at, source_row.source_ended_at
  from public.live_source_utterances source_row
  left join lateral (
    select correction_row.corrected_text
    from public.live_source_utterance_corrections correction_row
    where correction_row.source_utterance_id = source_row.id
    order by correction_row.revision desc limit 1
  ) correction on true
  where source_row.session_id = p_session_id and source_row.source_seq > p_after_source_seq
  order by source_row.source_seq limit p_limit;
end;
$$;

create or replace function public.live_recap_request_json_v1(p_request_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', request_row.id, 'sessionId', request_row.session_id,
    'participantId', request_row.participant_id, 'requestedAt', request_row.requested_at,
    'noticeVersion', request_row.notice_version, 'email', request_row.email,
    'revision', request_row.consent_revision,
    'displayName', participant_row.display_name, 'company', participant_row.company,
    'department', participant_row.department, 'jobTitle', participant_row.job_title,
    'consentAcceptedAt', consent_row.accepted_at,
    'status', case when latest.is_accepted and latest.notice_version = request_row.notice_version
      and participant_row.records_revoked_at is null and participant_row.email = request_row.email
      then 'requested' else 'cancelled' end,
    'cancelledAt', case when latest.is_accepted and latest.notice_version = request_row.notice_version
      and participant_row.records_revoked_at is null and participant_row.email = request_row.email then null
      else coalesce(participant_row.records_revoked_at, latest.withdrawn_at, latest.recorded_at) end
  )
  from public.live_recap_requests request_row
  join public.live_participants participant_row on participant_row.id = request_row.participant_id
  join public.live_participant_consents consent_row on consent_row.id = request_row.consent_id
  left join lateral (
    select consent.* from public.live_participant_consents consent
    where consent.participant_id = request_row.participant_id and consent.purpose = 'summary_delivery'
    order by consent.revision desc limit 1
  ) latest on true
  where request_row.id = p_request_id;
$$;

create or replace function public.read_live_recap_request_v1(p_session_id uuid, p_user_id text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare request_id uuid;
begin
  perform 1 from public.read_participant_live_record_access_v1(p_session_id, p_user_id);
  select request_row.id into request_id from public.live_recap_requests request_row
  join public.live_participants participant_row on participant_row.id = request_row.participant_id
  where request_row.session_id = p_session_id and participant_row.user_id = p_user_id;
  return public.live_recap_request_json_v1(request_id);
end;
$$;

create or replace function public.read_participant_live_recording_gaps_v1(p_session_id uuid, p_user_id text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare result jsonb;
begin
  perform 1 from public.read_participant_live_record_access_v1(p_session_id, p_user_id);
  if (select count(*) from public.live_media_recording_gaps target where target.session_id = p_session_id) > 12000 then
    raise exception using errcode = 'P0001', message = 'EXPORT_TOO_LARGE';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',target.id,'startedAt',target.started_at,
    'endedAt',target.ended_at,'reason',target.reason) order by target.started_at,target.id), '[]'::jsonb)
  into result from public.live_media_recording_gaps target where target.session_id = p_session_id;
  return jsonb_build_object('recordingGaps',result);
end;
$$;

create or replace function public.read_owned_live_recording_gaps_v1(p_session_id uuid, p_host_id text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare result jsonb;
begin
  perform 1 from public.live_sessions target where target.id = p_session_id
    and target.host_id = p_host_id and target.archive_deleted_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'LIVE_RECORD_NOT_FOUND';
  end if;
  if (select count(*) from public.live_media_recording_gaps target where target.session_id = p_session_id) > 12000 then
    raise exception using errcode = 'P0001', message = 'EXPORT_TOO_LARGE';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',target.id,'startedAt',target.started_at,
    'endedAt',target.ended_at,'reason',target.reason) order by target.started_at,target.id), '[]'::jsonb)
  into result from public.live_media_recording_gaps target where target.session_id = p_session_id;
  return jsonb_build_object('recordingGaps',result);
end;
$$;

create or replace function public.request_live_recap_v1(
  p_session_id uuid, p_user_id text, p_notice_version text, p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  participant_row public.live_participants%rowtype;
  request_id uuid;
  consent_row record;
begin
  if p_notice_version is distinct from 'summary-original-email-v2' or p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'INVALID_RECAP_REQUEST';
  end if;
  perform 1 from public.live_sessions target where target.id = p_session_id for update;
  perform 1 from public.read_participant_live_record_access_v1(p_session_id, p_user_id);
  select target.* into participant_row from public.live_participants target
  where target.session_id = p_session_id and target.user_id = p_user_id for update;
  if participant_row.records_revoked_at is not null then
    raise exception using errcode = '42501', message = 'RECAP_FORBIDDEN';
  end if;
  if exists (select 1 from public.live_sessions target where target.id = p_session_id
    and clock_timestamp() >= target.ended_at + interval '6 hours') then
    raise exception using errcode = 'P0001', message = 'RECAP_EXPIRED';
  end if;
  if participant_row.email is null or not public.is_valid_live_attendee_email(participant_row.email) then
    raise exception using errcode = '22023', message = 'RECAP_EMAIL_REQUIRED';
  end if;
  select target.id into request_id from public.live_recap_requests target
  where target.session_id = p_session_id and target.participant_id = participant_row.id;
  if found then
    return public.live_recap_request_json_v1(request_id);
  end if;
  select consent.* into consent_row
  from public.record_live_participant_consent_v1(p_session_id, participant_row.id,
    p_user_id, 'summary_delivery', p_notice_version, true) consent;
  insert into public.live_recap_requests (
    session_id, participant_id, consent_id, consent_revision, notice_version, email, idempotency_key
  ) values (p_session_id, participant_row.id, consent_row.consent_id,
    consent_row.revision, p_notice_version, participant_row.email, p_idempotency_key)
  returning id into request_id;
  return public.live_recap_request_json_v1(request_id);
end;
$$;

create or replace function public.read_owned_live_recap_requests_v1(p_session_id uuid, p_host_id text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare result jsonb;
begin
  perform 1 from public.live_sessions target where target.id = p_session_id
    and target.host_id = p_host_id and target.archive_deleted_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'LIVE_RECORD_NOT_FOUND';
  end if;
  if (select count(*) from public.live_recap_requests target where target.session_id = p_session_id) > 10000 then
    raise exception using errcode = 'P0001', message = 'EXPORT_TOO_LARGE';
  end if;
  select coalesce(jsonb_agg(public.live_recap_request_json_v1(target.id)
    order by target.requested_at, target.id), '[]'::jsonb)
  into result from public.live_recap_requests target where target.session_id = p_session_id;
  return jsonb_build_object('requests', result);
end;
$$;

-- 2026-08-31 feat: STABLE keeps all export queries on the caller statement snapshot.
-- The archive is never assembled from differently timed paginated HTTP reads.
create or replace function public.read_owned_live_record_export_v1(p_session_id uuid, p_host_id text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  participants jsonb; utterances jsonb; summaries jsonb; requests jsonb; recording_gaps jsonb;
  estimated_bytes bigint;
begin
  select target.* into session_row from public.live_sessions target
  where target.id = p_session_id and target.host_id = p_host_id
    and target.archive_deleted_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'LIVE_RECORD_NOT_FOUND';
  end if;
  if session_row.status not in ('stopped', 'failed') or session_row.ended_at is null then
    raise exception using errcode = 'P0001', message = 'LIVE_TRANSCRIPT_NOT_READY';
  end if;
  if (select count(*) from public.live_participants target where target.session_id = p_session_id) > 10000
    or (select count(*) from public.live_source_utterances target where target.session_id = p_session_id) > 12000
    or (select count(*) from public.live_recap_requests target where target.session_id = p_session_id) > 10000
    or (select count(*) from public.live_media_recording_gaps target where target.session_id = p_session_id) > 12000
    or (select count(*) from (
      select unnest(session_row.languages) as language
      union select target.language from public.live_meeting_summaries target where target.session_id = p_session_id
      union select target.language from public.live_summary_generation_jobs target where target.session_id = p_session_id
  ) all_languages) > 14 then
    raise exception using errcode = 'P0001', message = 'EXPORT_TOO_LARGE';
  end if;
  select coalesce(sum(octet_length(to_jsonb(coalesce(correction.corrected_text,source_row.normalized_text))::text)+512),0)
  into estimated_bytes from public.live_source_utterances source_row
  left join lateral (
    select target.corrected_text from public.live_source_utterance_corrections target
    where target.source_utterance_id=source_row.id order by target.revision desc limit 1
  ) correction on true where source_row.session_id=p_session_id;
  estimated_bytes := estimated_bytes
    + coalesce((select sum(octet_length(to_jsonb(target)::text)+256)
      from public.live_participants target where target.session_id=p_session_id),0)
    + coalesce((select sum(octet_length(target.summary::text)+256)
      from public.live_meeting_summaries target where target.session_id=p_session_id),0)
    + (select count(*)*1024 from public.live_recap_requests target where target.session_id=p_session_id)
    + (select count(*)*512 from public.live_media_recording_gaps target where target.session_id=p_session_id);
  if estimated_bytes > 12*1024*1024 then
    raise exception using errcode = 'P0001', message = 'EXPORT_TOO_LARGE';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', target.id, 'displayName', target.display_name, 'email', target.email,
    'company', target.company, 'department', target.department, 'jobTitle', target.job_title,
    'joinedAt', target.joined_at) order by target.joined_at, target.id), '[]'::jsonb)
  into participants from public.live_participants target where target.session_id = p_session_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', source_row.id, 'seq', source_row.source_seq,
    'speaker', coalesce(source_row.speaker_name, source_row.speaker_label,
      case when source_row.speaker_role = 'host' then '진행자' else '참여자' end),
    'language', source_row.source_language, 'startedAt', source_row.source_started_at,
    'endedAt', source_row.source_ended_at,
    'text', coalesce(correction.corrected_text, source_row.normalized_text),
    'topicTitle', topic_row.title) order by source_row.source_seq), '[]'::jsonb)
  into utterances from public.live_source_utterances source_row
  left join lateral (
    select target.corrected_text from public.live_source_utterance_corrections target
    where target.source_utterance_id = source_row.id order by target.revision desc limit 1
  ) correction on true
  left join public.live_topic_utterances topic_link on topic_link.session_id = source_row.session_id
    and topic_link.utterance_key = source_row.utterance_key
  left join public.live_topics topic_row on topic_row.id = topic_link.topic_id
  where source_row.session_id = p_session_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'language', language_row.language,
    'status', case when summary_row.summary is not null then 'ready'
      when job_row.status = 'failed' then 'failed' else 'pending' end,
    'createdAt', summary_row.created_at, 'summary', summary_row.summary
  ) order by coalesce(array_position(session_row.languages, language_row.language),1000), language_row.language), '[]'::jsonb)
  into summaries from (
    select unnest(session_row.languages) as language
    union select target.language from public.live_meeting_summaries target where target.session_id = p_session_id
    union select target.language from public.live_summary_generation_jobs target where target.session_id = p_session_id
  ) language_row
  left join public.live_meeting_summaries summary_row on summary_row.session_id = p_session_id
    and summary_row.language = language_row.language
  left join public.live_summary_generation_jobs job_row on job_row.session_id = p_session_id
    and job_row.language = language_row.language;

  requests := public.read_owned_live_recap_requests_v1(p_session_id, p_host_id)->'requests';
  select coalesce(jsonb_agg(jsonb_build_object('id', target.id, 'startedAt', target.started_at,
    'endedAt', target.ended_at, 'reason', target.reason) order by target.started_at,target.id), '[]'::jsonb)
  into recording_gaps from public.live_media_recording_gaps target where target.session_id = p_session_id;
  return jsonb_build_object('snapshotId', extensions.gen_random_uuid(), 'generatedAt', statement_timestamp(),
    'session', jsonb_build_object('id', session_row.id, 'title', session_row.title,
      'status', session_row.status, 'scheduledAt', session_row.scheduled_at,
      'endedAt', session_row.ended_at, 'languages', session_row.languages),
    'participants', participants, 'utterances', utterances, 'summaries', summaries, 'requests', requests,
    'recordingGaps', recording_gaps);
end;
$$;

revoke all on function public.read_participant_live_record_access_v1(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.can_read_live_recap_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function public.read_participant_live_source_transcript_v1(uuid, text, bigint, integer) from public, anon, authenticated, service_role;
revoke all on function public.live_recap_request_json_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function public.read_live_recap_request_v1(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.read_participant_live_recording_gaps_v1(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.read_owned_live_recording_gaps_v1(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.request_live_recap_v1(uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.read_owned_live_recap_requests_v1(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.read_owned_live_record_export_v1(uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.read_participant_live_record_access_v1(uuid, text) to service_role;
grant execute on function public.can_read_live_recap_v1(uuid) to authenticated, service_role;
grant execute on function public.read_participant_live_source_transcript_v1(uuid, text, bigint, integer) to service_role;
grant execute on function public.read_live_recap_request_v1(uuid, text) to service_role;
grant execute on function public.read_participant_live_recording_gaps_v1(uuid, text) to service_role;
grant execute on function public.read_owned_live_recording_gaps_v1(uuid, text) to service_role;
grant execute on function public.request_live_recap_v1(uuid, text, text, uuid) to service_role;
grant execute on function public.read_owned_live_recap_requests_v1(uuid, text) to service_role;
grant execute on function public.read_owned_live_record_export_v1(uuid, text) to service_role;
