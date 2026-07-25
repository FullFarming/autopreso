-- 2026-07-23 feat: Persist bounded participant identity and activity for
-- meeting recaps, while keeping the six-digit admission secret HMAC-only and
-- stable for the lifetime of one session. All changes are additive.

alter table public.viewer_grants
  add column if not exists department text,
  add column if not exists job_title text;

alter table public.viewer_grants
  add constraint viewer_grants_department_check check (
    department is null or (
      char_length(department) between 1 and 80
      and department = normalize(btrim(department), NFC)
      and department !~ '[[:cntrl:]]'
      and department !~ '[<>]'
    )
  ),
  add constraint viewer_grants_job_title_check check (
    job_title is null or (
      char_length(job_title) between 1 and 100
      and job_title = normalize(btrim(job_title), NFC)
      and job_title !~ '[[:cntrl:]]'
      and job_title !~ '[<>]'
    )
  );

comment on column public.viewer_grants.department is
  'Nullable for legacy grants; new participant joins provide an NFC-normalized department.';
comment on column public.viewer_grants.job_title is
  'Nullable for legacy grants; new participant joins provide an NFC-normalized job title.';

alter table public.live_sessions
  add column if not exists admission_generation bigint not null default 0,
  add column if not exists admission_state text not null default 'uninitialized';

update public.live_sessions
set admission_open_until = case
      when admission_code_hmac is not null and status <> 'stopped' then expires_at
      else admission_open_until
    end,
    admission_generation = case when admission_code_hmac is null then 0 else 1 end,
    admission_state = case
      when status = 'stopped' then 'ended'
      when admission_code_hmac is not null then 'open'
      else 'uninitialized'
    end;

alter table public.live_sessions
  add constraint live_sessions_admission_generation_check
    check (admission_generation >= 0),
  add constraint live_sessions_admission_state_check
    check (admission_state in ('uninitialized', 'open', 'paused', 'ended')),
  add constraint live_sessions_admission_lifecycle_check check (
    (
      admission_state = 'uninitialized'
      and admission_code_hmac is null
      and admission_open_until is null
      and admission_generation = 0
    )
    or (
      admission_state in ('open', 'paused')
      and admission_code_hmac ~ '^[0-9a-f]{64}$'
      and admission_open_until is not null
      and admission_generation >= 1
    )
    or (
      admission_state = 'ended'
      and admission_code_hmac is null
      and admission_open_until is null
    )
  );

comment on column public.live_sessions.admission_generation is
  'Increments only when the session receives its first HMAC admission code.';
comment on column public.live_sessions.admission_state is
  'Admission lifecycle. Pause preserves the HMAC; only stop or expiry ends it.';

create table public.live_participants (
  id uuid primary key,
  grant_id uuid not null,
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  user_id text not null check (char_length(user_id) between 1 and 256),
  display_name text not null,
  department text not null,
  job_title text not null,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  left_at timestamptz,
  last_spoke_at timestamptz,
  utterance_count integer not null default 0 check (utterance_count >= 0),
  speaking_seconds numeric(12, 3) not null default 0
    check (speaking_seconds >= 0),
  retention_expires_at timestamptz,
  constraint live_participants_identity_check check (
    char_length(display_name) between 1 and 40
    and display_name = normalize(btrim(display_name), NFC)
    and display_name !~ '[[:cntrl:]]'
    and display_name !~ '[<>]'
    and char_length(department) between 1 and 80
    and department = normalize(btrim(department), NFC)
    and department !~ '[[:cntrl:]]'
    and department !~ '[<>]'
    and char_length(job_title) between 1 and 100
    and job_title = normalize(btrim(job_title), NFC)
    and job_title !~ '[[:cntrl:]]'
    and job_title !~ '[<>]'
  ),
  constraint live_participants_time_order_check check (
    last_seen_at >= joined_at
    and (left_at is null or left_at >= joined_at)
    and (last_spoke_at is null or last_spoke_at >= joined_at)
    and (
      retention_expires_at is null
      or (
        left_at is not null
        and retention_expires_at > left_at
        and retention_expires_at <= greatest(left_at, last_seen_at) + interval '30 days'
      )
    )
  ),
  unique (session_id, user_id),
  unique (session_id, grant_id)
);

create index live_participants_session_last_seen_idx
  on public.live_participants (session_id, last_seen_at desc);
create index live_participants_retention_expiry_idx
  on public.live_participants (retention_expires_at)
  where retention_expires_at is not null;

alter table public.live_participants enable row level security;

create policy live_participants_host_select
  on public.live_participants for select to authenticated
  using (
    (retention_expires_at is null or retention_expires_at > now())
    and exists (
      select 1
      from public.live_sessions session_row
      where session_row.id = live_participants.session_id
        and session_row.host_id = (select auth.uid())::text
    )
  );

grant select on public.live_participants to authenticated;
grant select, insert, update, delete on public.live_participants to service_role;

create table public.live_participant_events (
  id bigint generated always as identity primary key,
  participant_id uuid not null references public.live_participants(id) on delete cascade,
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  event_type text not null
    check (event_type in ('joined', 'left', 'speak_started', 'speak_ended')),
  occurred_at timestamptz not null default now()
);

create index live_participant_events_session_time_idx
  on public.live_participant_events (session_id, occurred_at);

alter table public.live_participant_events enable row level security;

create policy live_participant_events_host_select
  on public.live_participant_events for select to authenticated
  using (
    exists (
      select 1
      from public.live_sessions session_row
      where session_row.id = live_participant_events.session_id
        and session_row.host_id = (select auth.uid())::text
    )
  );

grant select on public.live_participant_events to authenticated;
grant select, insert, update, delete on public.live_participant_events to service_role;

alter table public.live_utterances
  add column if not exists source_started_at timestamptz,
  add column if not exists participant_id uuid
    references public.live_participants(id) on delete set null;

create index live_utterances_participant_time_idx
  on public.live_utterances (participant_id, emitted_at)
  where participant_id is not null;

create or replace function public.enforce_stable_live_admission()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'stopped' then
      new.admission_code_hmac := null;
      new.admission_open_until := null;
      new.admission_state := 'ended';
    elsif new.admission_code_hmac is null then
      new.admission_generation := 0;
      new.admission_state := 'uninitialized';
    else
      new.admission_generation := greatest(new.admission_generation, 1);
      new.admission_state := 'open';
      new.admission_open_until := new.expires_at;
    end if;
    return new;
  end if;

  if new.status = 'stopped' then
    new.admission_code_hmac := null;
    new.admission_open_until := null;
    new.admission_state := 'ended';
    return new;
  end if;

  if old.admission_code_hmac is not null
    and new.admission_code_hmac is distinct from old.admission_code_hmac
  then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CODE_IMMUTABLE';
  end if;

  if old.admission_code_hmac is null and new.admission_code_hmac is not null then
    new.admission_generation := old.admission_generation + 1;
    new.admission_state := 'open';
    new.admission_open_until := new.expires_at;
  elsif old.admission_code_hmac is not null then
    new.admission_generation := old.admission_generation;
    new.admission_open_until := new.expires_at;
    if new.admission_state not in ('open', 'paused') then
      new.admission_state := old.admission_state;
    end if;
  else
    new.admission_generation := 0;
    new.admission_state := 'uninitialized';
    new.admission_open_until := null;
  end if;
  return new;
end;
$$;

create trigger live_sessions_stable_admission_before_write
before insert or update of admission_code_hmac, admission_open_until,
  admission_generation, admission_state, status, expires_at
on public.live_sessions
for each row execute function public.enforce_stable_live_admission();

create or replace function public.apply_live_viewer_grant(
  p_session_id uuid,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_display_name text,
  p_department text,
  p_job_title text
)
returns table (
  grant_id uuid,
  grant_user_id text,
  grant_expires_at timestamptz,
  resolved_viewer_count integer,
  resolved_display_name text,
  resolved_department text,
  resolved_job_title text,
  participant_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  grant_result record;
  normalized_department text;
  normalized_job_title text;
begin
  normalized_department := normalize(btrim(coalesce(p_department, '')), NFC);
  normalized_job_title := normalize(btrim(coalesce(p_job_title, '')), NFC);
  if char_length(normalized_department) not between 1 and 80
    or normalized_department ~ '[[:cntrl:]]'
    or normalized_department ~ '[<>]'
    or char_length(normalized_job_title) not between 1 and 100
    or normalized_job_title ~ '[[:cntrl:]]'
    or normalized_job_title ~ '[<>]'
  then
    raise exception using errcode = '22023', message = 'INVALID_PARTICIPANT_IDENTITY';
  end if;

  select * into grant_result
  from public.apply_live_viewer_grant(
    p_session_id, p_user_id, p_device_hash, p_grant_expires_at, p_display_name
  );

  update public.viewer_grants
  set department = normalized_department,
      job_title = normalized_job_title
  where id = grant_result.grant_id;

  insert into public.live_participants as participant_row (
    id, grant_id, session_id, user_id, display_name, department, job_title,
    joined_at, last_seen_at, left_at, retention_expires_at
  ) values (
    grant_result.grant_id, grant_result.grant_id, p_session_id, p_user_id,
    grant_result.resolved_display_name, normalized_department,
    normalized_job_title, statement_timestamp(), statement_timestamp(), null, null
  )
  on conflict (session_id, user_id) do update
    set grant_id = excluded.grant_id,
        display_name = excluded.display_name,
        department = excluded.department,
        job_title = excluded.job_title,
        last_seen_at = statement_timestamp(),
        left_at = null,
        retention_expires_at = null
  returning participant_row.id into participant_id;

  insert into public.live_participant_events (
    participant_id, session_id, event_type, occurred_at
  ) values (
    participant_id, p_session_id, 'joined', statement_timestamp()
  );

  grant_id := grant_result.grant_id;
  grant_user_id := grant_result.grant_user_id;
  grant_expires_at := grant_result.grant_expires_at;
  resolved_viewer_count := grant_result.resolved_viewer_count;
  resolved_display_name := grant_result.resolved_display_name;
  resolved_department := normalized_department;
  resolved_job_title := normalized_job_title;
  return next;
end;
$$;

create or replace function public.open_live_admission(
  p_session_id uuid,
  p_host_id text,
  p_code_hmac text,
  p_open_until timestamptz,
  p_expected_version integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  next_version integer;
begin
  if p_session_id is null
    or p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_code_hmac is null
    or p_code_hmac !~ '^[0-9a-f]{64}$'
    or p_open_until is null
    or p_open_until <= statement_timestamp()
    or p_expected_version is null
    or p_expected_version < 1
  then
    raise exception using errcode = '22023', message = 'INVALID_ADMISSION_INPUT';
  end if;

  select * into session_row
  from public.live_sessions
  where id = p_session_id
  for update;

  if not found
    or session_row.host_id <> p_host_id
    or session_row.status not in ('preparing', 'live')
    or session_row.expires_at <= statement_timestamp()
    or p_open_until > session_row.expires_at
  then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT_OR_FORBIDDEN';
  end if;
  if session_row.version <> p_expected_version then
    if session_row.admission_code_hmac = p_code_hmac
      and session_row.admission_state = 'open'
    then
      return session_row.version;
    end if;
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT_OR_FORBIDDEN';
  end if;
  if session_row.admission_code_hmac is not null
    and session_row.admission_code_hmac <> p_code_hmac
  then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CODE_IMMUTABLE';
  end if;

  update public.live_sessions
  set admission_code_hmac = p_code_hmac,
      admission_open_until = session_row.expires_at,
      admission_state = 'open',
      updated_at = statement_timestamp(),
      version = version + 1
  where id = p_session_id
  returning version into next_version;
  return next_version;
end;
$$;

create or replace function public.close_live_admission(
  p_session_id uuid,
  p_host_id text,
  p_expected_version integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_version integer;
begin
  if p_session_id is null
    or p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_expected_version is null
    or p_expected_version < 1
  then
    raise exception using errcode = '22023', message = 'INVALID_ADMISSION_INPUT';
  end if;

  update public.live_sessions as session_row
  set admission_state = case
        when session_row.admission_code_hmac is null then 'uninitialized'
        else 'paused'
      end,
      updated_at = statement_timestamp(),
      version = session_row.version + 1
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.version = p_expected_version
    and session_row.status in ('preparing', 'live')
    and session_row.expires_at > statement_timestamp()
  returning session_row.version into next_version;

  if next_version is null then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT_OR_FORBIDDEN';
  end if;
  return next_version;
end;
$$;

create or replace function public.redeem_live_admission_v3(
  p_code_hmac text,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_display_name text,
  p_department text,
  p_job_title text
)
returns table (
  grant_id uuid,
  session_id uuid,
  user_id text,
  grant_expires_at timestamptz,
  session_type text,
  output_mode text,
  languages text[],
  session_expires_at timestamptz,
  viewer_count integer,
  max_viewers integer,
  glossary_pack text,
  display_name text,
  department text,
  job_title text,
  participant_id uuid,
  voice_provider text,
  status text,
  title text,
  scheduled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
  grant_result record;
begin
  if p_code_hmac is null or p_code_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_ADMISSION_INPUT';
  end if;
  select * into session_row
  from public.live_sessions
  where admission_code_hmac = p_code_hmac
  for update;
  if not found
    or session_row.admission_state <> 'open'
    or session_row.admission_open_until <= statement_timestamp()
    or session_row.status not in ('preparing', 'live')
    or session_row.expires_at <= statement_timestamp()
  then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
  end if;

  select * into grant_result
  from public.apply_live_viewer_grant(
    session_row.id, p_user_id, p_device_hash, p_grant_expires_at,
    p_display_name, p_department, p_job_title
  );

  grant_id := grant_result.grant_id;
  session_id := session_row.id;
  user_id := grant_result.grant_user_id;
  grant_expires_at := grant_result.grant_expires_at;
  session_type := session_row.session_type;
  output_mode := session_row.output_mode;
  languages := session_row.languages;
  session_expires_at := session_row.expires_at;
  viewer_count := grant_result.resolved_viewer_count;
  max_viewers := session_row.max_viewers;
  glossary_pack := session_row.glossary_pack;
  display_name := grant_result.resolved_display_name;
  department := grant_result.resolved_department;
  job_title := grant_result.resolved_job_title;
  participant_id := grant_result.participant_id;
  voice_provider := session_row.voice_provider;
  status := session_row.status;
  title := session_row.title;
  scheduled_at := session_row.scheduled_at;
  return next;
end;
$$;

create or replace function public.redeem_live_invite_v3(
  p_token_hmac text,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_display_name text,
  p_department text,
  p_job_title text
)
returns table (
  grant_id uuid,
  session_id uuid,
  user_id text,
  grant_expires_at timestamptz,
  session_type text,
  output_mode text,
  languages text[],
  session_expires_at timestamptz,
  viewer_count integer,
  max_viewers integer,
  glossary_pack text,
  display_name text,
  department text,
  job_title text,
  participant_id uuid,
  voice_provider text,
  status text,
  title text,
  scheduled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  resolved_session_id uuid;
  session_row public.live_sessions%rowtype;
  grant_result record;
begin
  resolved_session_id := public.lock_live_invite_session(p_token_hmac);
  select * into session_row
  from public.live_sessions
  where id = resolved_session_id
  for update;

  select * into grant_result
  from public.apply_live_viewer_grant(
    session_row.id, p_user_id, p_device_hash, p_grant_expires_at,
    p_display_name, p_department, p_job_title
  );

  grant_id := grant_result.grant_id;
  session_id := session_row.id;
  user_id := grant_result.grant_user_id;
  grant_expires_at := grant_result.grant_expires_at;
  session_type := session_row.session_type;
  output_mode := session_row.output_mode;
  languages := session_row.languages;
  session_expires_at := session_row.expires_at;
  viewer_count := grant_result.resolved_viewer_count;
  max_viewers := session_row.max_viewers;
  glossary_pack := session_row.glossary_pack;
  display_name := grant_result.resolved_display_name;
  department := grant_result.resolved_department;
  job_title := grant_result.resolved_job_title;
  participant_id := grant_result.participant_id;
  voice_provider := session_row.voice_provider;
  status := session_row.status;
  title := session_row.title;
  scheduled_at := session_row.scheduled_at;
  return next;
end;
$$;

create or replace function public.record_live_participant_leave()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  participant_row public.live_participants%rowtype;
begin
  select * into participant_row
  from public.live_participants
  where session_id = old.session_id
    and grant_id = old.id
  for update;
  if not found then
    return old;
  end if;

  update public.live_participants
  set last_seen_at = greatest(last_seen_at, statement_timestamp()),
      left_at = coalesce(left_at, statement_timestamp()),
      retention_expires_at = least(
        coalesce(retention_expires_at, statement_timestamp() + interval '30 days'),
        statement_timestamp() + interval '30 days'
      )
  where id = participant_row.id;
  insert into public.live_participant_events (
    participant_id, session_id, event_type, occurred_at
  ) values (
    participant_row.id, old.session_id, 'left', statement_timestamp()
  );
  return old;
end;
$$;

create trigger viewer_grants_participant_leave_before_delete
before delete on public.viewer_grants
for each row execute function public.record_live_participant_leave();

create or replace function public.sync_live_participants_on_session_end()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ended_timestamp timestamptz;
begin
  if new.status <> 'stopped' or old.status = 'stopped' then
    return new;
  end if;
  ended_timestamp := coalesce(new.ended_at, statement_timestamp());
  update public.live_participants
  set last_seen_at = greatest(last_seen_at, ended_timestamp),
      left_at = coalesce(left_at, ended_timestamp),
      retention_expires_at = ended_timestamp + interval '30 days'
  where session_id = new.id;

  insert into public.live_recap_grants (session_id, user_id, expires_at, created_at)
  select new.id, participant_row.user_id,
    ended_timestamp + interval '30 days', ended_timestamp
  from public.live_participants participant_row
  where participant_row.session_id = new.id
  on conflict (session_id, user_id) do update
    set expires_at = excluded.expires_at,
        created_at = excluded.created_at;
  return new;
end;
$$;

create trigger live_sessions_participant_retention_after_end
after update of status, ended_at on public.live_sessions
for each row execute function public.sync_live_participants_on_session_end();

create or replace function public.read_live_participant_roster(
  p_session_id uuid,
  p_host_id text
)
returns table (
  participant_id uuid,
  grant_id uuid,
  user_id text,
  display_name text,
  department text,
  job_title text,
  joined_at timestamptz,
  last_seen_at timestamptz,
  left_at timestamptz,
  last_spoke_at timestamptz,
  utterance_count integer,
  speaking_seconds numeric,
  retention_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_session_id is null
    or p_host_id is null
    or char_length(p_host_id) not between 1 and 256
  then
    raise exception using errcode = '22023', message = 'INVALID_ROSTER_INPUT';
  end if;
  if not exists (
    select 1
    from public.live_sessions session_row
    where session_row.id = p_session_id
      and session_row.host_id = p_host_id
  ) then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;

  return query
  select participant_row.id,
    participant_row.grant_id,
    participant_row.user_id,
    participant_row.display_name,
    participant_row.department,
    participant_row.job_title,
    participant_row.joined_at,
    participant_row.last_seen_at,
    participant_row.left_at,
    participant_row.last_spoke_at,
    participant_row.utterance_count,
    participant_row.speaking_seconds,
    participant_row.retention_expires_at
  from public.live_participants participant_row
  where participant_row.session_id = p_session_id
    and (
      participant_row.retention_expires_at is null
      or participant_row.retention_expires_at > statement_timestamp()
    )
  order by participant_row.joined_at, participant_row.id;
end;
$$;

create or replace function public.take_live_floor(p_session_id uuid, p_grant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  grant_row public.viewer_grants%rowtype;
  participant_row public.live_participants%rowtype;
begin
  select * into session_row
  from public.live_sessions
  where id = p_session_id
    and expires_at > statement_timestamp()
  for update;
  if not found or session_row.status <> 'live' then
    return jsonb_build_object('ok', false, 'code', 'SESSION_NOT_LIVE');
  end if;

  select * into grant_row
  from public.viewer_grants
  where id = p_grant_id
    and session_id = p_session_id
    and revoked_at is null
    and expires_at > statement_timestamp()
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'GRANT_INVALID');
  end if;

  if session_row.floor_grant_id is not null
    and session_row.floor_grant_id <> p_grant_id
  then
    select * into participant_row
    from public.live_participants
    where session_id = p_session_id
      and grant_id = session_row.floor_grant_id;
    if found then
      insert into public.live_participant_events (
        participant_id, session_id, event_type, occurred_at
      ) values (
        participant_row.id, p_session_id, 'speak_ended', statement_timestamp()
      );
    end if;
  end if;

  select * into participant_row
  from public.live_participants
  where session_id = p_session_id and grant_id = p_grant_id
  for update;
  if found then
    update public.live_participants
    set last_spoke_at = statement_timestamp(),
        last_seen_at = greatest(last_seen_at, statement_timestamp())
    where id = participant_row.id;
    if session_row.floor_grant_id is distinct from p_grant_id then
      insert into public.live_participant_events (
        participant_id, session_id, event_type, occurred_at
      ) values (
        participant_row.id, p_session_id, 'speak_started', statement_timestamp()
      );
    end if;
  end if;

  update public.live_sessions
  set floor_grant_id = p_grant_id,
      floor_display_name = coalesce(grant_row.display_name, 'Participant'),
      floor_taken_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where id = p_session_id;

  return jsonb_build_object(
    'ok', true,
    'displayName', coalesce(grant_row.display_name, 'Participant'),
    'participantId', participant_row.id,
    'previousGrantId', session_row.floor_grant_id,
    'previousDisplayName', session_row.floor_display_name
  );
end;
$$;

create or replace function public.release_live_floor(p_session_id uuid, p_grant_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_grant_id uuid;
  participant_row public.live_participants%rowtype;
begin
  select floor_grant_id into current_grant_id
  from public.live_sessions
  where id = p_session_id
  for update;
  if not found or current_grant_id is null then
    return false;
  end if;
  if p_grant_id is not null and current_grant_id <> p_grant_id then
    return false;
  end if;

  select * into participant_row
  from public.live_participants
  where session_id = p_session_id and grant_id = current_grant_id;
  if found then
    insert into public.live_participant_events (
      participant_id, session_id, event_type, occurred_at
    ) values (
      participant_row.id, p_session_id, 'speak_ended', statement_timestamp()
    );
  end if;

  update public.live_sessions
  set floor_grant_id = null,
      floor_display_name = null,
      floor_taken_at = null,
      updated_at = statement_timestamp()
  where id = p_session_id;
  return true;
end;
$$;

create or replace function public.persist_live_utterance_if_active(
  p_session_id uuid,
  p_language text,
  p_seq bigint,
  p_text text,
  p_speaker_label text,
  p_speaker_name text,
  p_source_started_at timestamptz,
  p_source_ended_at timestamptz,
  p_emitted_at timestamptz,
  p_participant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored boolean;
  changed integer;
  speech_seconds numeric;
  participant_row public.live_participants%rowtype;
begin
  if p_participant_id is not null then
    select * into participant_row
    from public.live_participants
    where id = p_participant_id and session_id = p_session_id
    for update;
    if not found then
      return false;
    end if;
  end if;

  stored := public.persist_live_utterance_if_active(
    p_session_id, p_language, p_seq, p_text, p_speaker_label, p_speaker_name,
    p_source_ended_at, p_emitted_at
  );
  if not stored or p_participant_id is null then
    return stored;
  end if;

  speech_seconds := case
    when p_source_started_at is not null
      and p_source_ended_at is not null
      and p_source_ended_at >= p_source_started_at
      and p_source_ended_at - p_source_started_at <= interval '1 hour'
    then extract(epoch from p_source_ended_at - p_source_started_at)
    else 0
  end;
  update public.live_utterances
  set participant_id = p_participant_id,
      source_started_at = case
        when p_source_started_at is not null
          and p_source_ended_at is not null
          and p_source_ended_at >= p_source_started_at
          and p_source_ended_at - p_source_started_at <= interval '1 hour'
        then p_source_started_at
        else null
      end
  where session_id = p_session_id
    and language = p_language
    and seq = p_seq
    and participant_id is null;
  get diagnostics changed = row_count;
  if changed = 1 and not exists (
    select 1
    from public.live_utterances existing_utterance
    where existing_utterance.session_id = p_session_id
      and existing_utterance.participant_id = p_participant_id
      and existing_utterance.seq = p_seq
      and existing_utterance.language <> p_language
  ) then
    update public.live_participants as participant_target
    set utterance_count = participant_target.utterance_count + 1,
        speaking_seconds = participant_target.speaking_seconds + speech_seconds,
        last_spoke_at = greatest(
          coalesce(participant_target.last_spoke_at, p_emitted_at),
          p_emitted_at
        ),
        last_seen_at = greatest(participant_target.last_seen_at, p_emitted_at)
    where participant_target.id = p_participant_id;
  end if;
  return true;
end;
$$;

create or replace function public.cleanup_expired_live_participants()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  with deleted as (
    delete from public.live_participants
    where retention_expires_at <= statement_timestamp()
    returning id
  )
  select count(*)::integer into deleted_count from deleted;
  return deleted_count;
end;
$$;

do $$
declare
  existing_job_id bigint;
begin
  select jobid into existing_job_id
  from cron.job
  where jobname = 'realtime-noel-live-participant-cleanup'
  order by jobid
  limit 1;
  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;
  perform cron.schedule(
    'realtime-noel-live-participant-cleanup',
    '*/5 * * * *',
    'select public.cleanup_expired_live_participants();'
  );
end;
$$;

revoke all on function public.apply_live_viewer_grant(
  uuid, text, text, timestamptz, text, text, text
) from public, anon, authenticated;
revoke all on function public.open_live_admission(uuid, text, text, timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.close_live_admission(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.redeem_live_admission_v3(
  text, text, text, timestamptz, text, text, text
) from public, anon, authenticated;
revoke all on function public.redeem_live_invite_v3(
  text, text, text, timestamptz, text, text, text
) from public, anon, authenticated;
revoke all on function public.record_live_participant_leave()
  from public, anon, authenticated;
revoke all on function public.sync_live_participants_on_session_end()
  from public, anon, authenticated;
revoke all on function public.read_live_participant_roster(uuid, text)
  from public, anon, authenticated;
revoke all on function public.take_live_floor(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.release_live_floor(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz, timestamptz, uuid
) from public, anon, authenticated;
revoke all on function public.cleanup_expired_live_participants()
  from public, anon, authenticated;

grant execute on function public.apply_live_viewer_grant(
  uuid, text, text, timestamptz, text, text, text
) to service_role;
grant execute on function public.open_live_admission(uuid, text, text, timestamptz, integer)
  to service_role;
grant execute on function public.close_live_admission(uuid, text, integer)
  to service_role;
grant execute on function public.redeem_live_admission_v3(
  text, text, text, timestamptz, text, text, text
) to service_role;
grant execute on function public.redeem_live_invite_v3(
  text, text, text, timestamptz, text, text, text
) to service_role;
grant execute on function public.read_live_participant_roster(uuid, text)
  to service_role;
grant execute on function public.take_live_floor(uuid, uuid)
  to service_role;
grant execute on function public.release_live_floor(uuid, uuid)
  to service_role;
grant execute on function public.persist_live_utterance_if_active(
  uuid, text, bigint, text, text, text, timestamptz, timestamptz, timestamptz, uuid
) to service_role;
grant execute on function public.cleanup_expired_live_participants()
  to service_role;

-- Development verification after applying to a linked development project:
-- 1. Call open_live_admission twice with the same HMAC: generation stays 1.
-- 2. Call it with a different HMAC before stop: ADMISSION_CODE_IMMUTABLE.
-- 3. close_live_admission changes only admission_state to paused; reopening with
--    the original HMAC succeeds and both QR and code redemption remain usable.
-- 4. Ending the session clears the HMAC, sets state ended, and retains the
--    participant roster, events, utterances, and recap grants for 30 days.
