-- 2026-08-15 feat: Keep Live Call archives in NOVA and project participant
-- operations through a PII-free transactional Sheets outbox.

-- ─── Archive lifecycle ───

alter table public.live_sessions
  add column if not exists archived_at timestamptz,
  add column if not exists archive_deleted_at timestamptz,
  add column if not exists archive_purge_after timestamptz;

alter table public.live_sessions
  add constraint live_sessions_archive_lifecycle_check check (
    (
      archive_deleted_at is null
      and archive_purge_after is null
    )
    or (
      archived_at is not null
      and archive_deleted_at is not null
      and archive_purge_after is not null
      and archive_purge_after >= archive_deleted_at + interval '30 days'
    )
  );

alter table public.live_sessions
  drop constraint if exists live_sessions_max_viewers_check;
alter table public.live_sessions
  add constraint live_sessions_max_viewers_check
  check (max_viewers between 1 and 200);

create or replace function public.create_live_session(
  p_session_id uuid,
  p_host_id text,
  p_session_type text,
  p_output_mode text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text,
  p_voice_provider text,
  p_title text,
  p_scheduled_at timestamptz,
  p_expires_at timestamptz
)
returns table (
  id uuid,
  host_id text,
  session_type text,
  output_mode text,
  status text,
  languages text[],
  viewer_count integer,
  max_viewers integer,
  version integer,
  glossary_pack text,
  voice_provider text,
  title text,
  scheduled_at timestamptz,
  admission_open_until timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  normalized_title text;
  expiry_basis timestamptz;
begin
  normalized_title := nullif(normalize(btrim(coalesce(p_title, '')), NFC), '');
  expiry_basis := greatest(statement_timestamp(), coalesce(p_scheduled_at, statement_timestamp()));

  if p_session_id is null
    or p_host_id is null
    or length(p_host_id) not between 1 and 256
    or p_session_type is null
    or p_session_type not in ('presentation', 'meeting')
    or p_output_mode is null
    or p_output_mode not in ('captions', 'captions_audio', 'audio')
    or p_voice_provider is null
    or p_voice_provider not in ('gemini', 'openai')
    or (
      p_voice_provider = 'openai'
      and (
        p_session_type <> 'presentation'
        or p_output_mode not in ('captions_audio', 'audio')
      )
    )
    or p_languages is null
    or not public.live_languages_valid(p_languages)
    or p_max_viewers is null
    or p_max_viewers not between 1 and 200
    or p_glossary_pack is null
    or p_glossary_pack not in ('general_cre', 'hotel', 'fnb')
    or normalized_title is null
    or char_length(normalized_title) not between 1 and 120
    or normalized_title ~ '[[:cntrl:]]'
    or normalized_title ~ '[<>]'
    or (
      p_scheduled_at is not null
      and (
        p_scheduled_at < statement_timestamp() - interval '5 minutes'
        or p_scheduled_at > statement_timestamp() + interval '30 days'
      )
    )
    or p_expires_at is null
    or p_expires_at <= expiry_basis
    or p_expires_at > expiry_basis + interval '6 hours'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_INPUT';
  end if;

  return query
  insert into public.live_sessions as created_session (
    id, host_id, mode, voice_output_mode, session_type, output_mode,
    voice_provider, status, languages, viewer_count, max_viewers, version,
    glossary_pack, title, scheduled_at, expires_at, created_at, updated_at
  ) values (
    p_session_id,
    p_host_id,
    case when p_output_mode = 'captions' then p_session_type else 'townhall' end,
    case when p_output_mode = 'captions' then 'captions' else 'auto_voice' end,
    p_session_type,
    p_output_mode,
    p_voice_provider,
    'preparing',
    p_languages,
    0,
    p_max_viewers,
    1,
    p_glossary_pack,
    normalized_title,
    p_scheduled_at,
    p_expires_at,
    statement_timestamp(),
    statement_timestamp()
  )
  returning
    created_session.id,
    created_session.host_id,
    created_session.session_type,
    created_session.output_mode,
    created_session.status,
    created_session.languages,
    created_session.viewer_count,
    created_session.max_viewers,
    created_session.version,
    created_session.glossary_pack,
    created_session.voice_provider,
    created_session.title,
    created_session.scheduled_at,
    created_session.admission_open_until,
    created_session.expires_at;
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'LIVE_SESSION_CONFLICT';
end;
$$;

create or replace function public.update_live_session(
  p_session_id uuid,
  p_host_id text,
  p_expected_version integer,
  p_session_type text,
  p_output_mode text,
  p_languages text[],
  p_max_viewers integer,
  p_glossary_pack text,
  p_voice_provider text,
  p_title text,
  p_scheduled_at timestamptz
)
returns table (
  id uuid,
  host_id text,
  session_type text,
  output_mode text,
  status text,
  languages text[],
  viewer_count integer,
  max_viewers integer,
  version integer,
  glossary_pack text,
  voice_provider text,
  title text,
  scheduled_at timestamptz,
  admission_open_until timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  updated_session public.live_sessions%rowtype;
  normalized_title text;
begin
  normalized_title := nullif(normalize(btrim(coalesce(p_title, '')), NFC), '');

  if p_session_id is null
    or p_host_id is null
    or length(p_host_id) not between 1 and 256
    or p_expected_version is null
    or p_expected_version < 1
    or p_session_type is null
    or p_session_type not in ('presentation', 'meeting')
    or p_output_mode is null
    or p_output_mode not in ('captions', 'captions_audio', 'audio')
    or p_voice_provider is null
    or p_voice_provider not in ('gemini', 'openai')
    or (
      p_voice_provider = 'openai'
      and (
        p_session_type <> 'presentation'
        or p_output_mode not in ('captions_audio', 'audio')
      )
    )
    or p_languages is null
    or not public.live_languages_valid(p_languages)
    or p_max_viewers is null
    or p_max_viewers not between 1 and 200
    or p_glossary_pack is null
    or p_glossary_pack not in ('general_cre', 'hotel', 'fnb')
    or normalized_title is null
    or char_length(normalized_title) not between 1 and 120
    or normalized_title ~ '[[:cntrl:]]'
    or normalized_title ~ '[<>]'
    or (
      p_scheduled_at is not null
      and (
        p_scheduled_at < statement_timestamp() - interval '5 minutes'
        or p_scheduled_at > statement_timestamp() + interval '30 days'
      )
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_INPUT';
  end if;

  update public.live_sessions as session_row
  set session_type = p_session_type,
      output_mode = p_output_mode,
      voice_provider = p_voice_provider,
      mode = case when p_output_mode = 'captions' then p_session_type else 'townhall' end,
      voice_output_mode = case when p_output_mode = 'captions' then 'captions' else 'auto_voice' end,
      languages = p_languages,
      max_viewers = p_max_viewers,
      glossary_pack = p_glossary_pack,
      title = normalized_title,
      scheduled_at = p_scheduled_at,
      expires_at = greatest(statement_timestamp(), coalesce(p_scheduled_at, statement_timestamp()))
        + interval '6 hours',
      version = session_row.version + 1,
      updated_at = statement_timestamp()
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.version = p_expected_version
    and session_row.status = 'preparing'
    and session_row.expires_at > statement_timestamp()
    and session_row.viewer_count <= p_max_viewers
    and (
      p_scheduled_at is null
      or p_scheduled_at between
        session_row.created_at - interval '5 minutes'
        and session_row.created_at + interval '30 days'
    )
  returning session_row.* into updated_session;

  if not found then
    return;
  end if;

  delete from public.live_snapshots snapshot_row
  where snapshot_row.session_id = updated_session.id
    and not (snapshot_row.language = any(updated_session.languages));

  id := updated_session.id;
  host_id := updated_session.host_id;
  session_type := updated_session.session_type;
  output_mode := updated_session.output_mode;
  status := updated_session.status;
  languages := updated_session.languages;
  viewer_count := updated_session.viewer_count;
  max_viewers := updated_session.max_viewers;
  version := updated_session.version;
  glossary_pack := updated_session.glossary_pack;
  voice_provider := updated_session.voice_provider;
  title := updated_session.title;
  scheduled_at := updated_session.scheduled_at;
  admission_open_until := updated_session.admission_open_until;
  expires_at := updated_session.expires_at;
  return next;
end;
$$;

create index live_sessions_archive_owner_idx
  on public.live_sessions (host_id, archived_at desc, id)
  where archived_at is not null and archive_deleted_at is null;
create index live_sessions_archive_purge_idx
  on public.live_sessions (archive_purge_after, id)
  where archive_purge_after is not null;

drop policy if exists live_sessions_host_select on public.live_sessions;
create policy live_sessions_host_select
  on public.live_sessions for select to authenticated
  using (
    host_id = (select auth.uid())::text
    and archive_deleted_at is null
  );

update public.live_sessions
set archived_at = coalesce(ended_at, updated_at, created_at)
where archived_at is null
  and status in ('stopped', 'failed');

create or replace function public.mark_live_session_archived()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('stopped', 'failed')
    and (tg_op = 'INSERT' or old.status is distinct from new.status)
  then
    new.archived_at := coalesce(new.archived_at, new.ended_at, statement_timestamp());
  end if;
  return new;
end;
$$;

create trigger live_sessions_archive_before_write
before insert or update of status, ended_at on public.live_sessions
for each row execute function public.mark_live_session_archived();

-- ─── Purpose-scoped immutable consent ───

create table public.live_participant_consents (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  participant_id uuid not null references public.live_participants(id) on delete cascade,
  purpose text not null
    check (purpose in ('privacy', 'summary_delivery', 'marketing')),
  notice_version text not null
    check (
      char_length(notice_version) between 1 and 64
      and notice_version = normalize(btrim(notice_version), NFC)
      and notice_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    ),
  revision integer not null check (revision between 1 and 2147483647),
  is_accepted boolean not null,
  accepted_at timestamptz,
  withdrawn_at timestamptz,
  recorded_at timestamptz not null default statement_timestamp(),
  constraint live_participant_consents_state_check check (
    (
      is_accepted is true
      and accepted_at is not null
      and withdrawn_at is null
    )
    or (
      is_accepted is false
      and (
        (accepted_at is null and withdrawn_at is null)
        or (accepted_at is not null and withdrawn_at is not null and withdrawn_at >= accepted_at)
      )
    )
  ),
  unique (participant_id, purpose, revision)
);

create index live_participant_consents_session_participant_idx
  on public.live_participant_consents (session_id, participant_id, purpose, revision desc);

alter table public.live_participant_consents enable row level security;

create or replace function public.assert_live_participant_consent_binding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.live_participants participant_row
    where participant_row.id = new.participant_id
      and participant_row.session_id = new.session_id
  ) then
    raise exception using errcode = '23503', message = 'LIVE_CONSENT_PARTICIPANT_MISMATCH';
  end if;
  return new;
end;
$$;

create trigger live_participant_consents_binding_before_insert
before insert on public.live_participant_consents
for each row execute function public.assert_live_participant_consent_binding();

create or replace function public.prevent_live_participant_consent_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1
    from public.live_sessions session_row
    where session_row.id = old.session_id
  ) then
    return old;
  end if;
  raise exception using errcode = '55000', message = 'LIVE_CONSENT_AUDIT_IMMUTABLE';
end;
$$;

create trigger live_participant_consents_immutable_before_change
before update or delete on public.live_participant_consents
for each row execute function public.prevent_live_participant_consent_mutation();

insert into public.live_participant_consents (
  session_id,
  participant_id,
  purpose,
  notice_version,
  revision,
  is_accepted,
  accepted_at,
  recorded_at
)
select
  participant_row.session_id,
  participant_row.id,
  'summary_delivery',
  'legacy-summary-v1',
  1,
  true,
  participant_row.summary_consent_at,
  participant_row.summary_consent_at
from public.live_participants participant_row
where participant_row.summary_consent_at is not null
on conflict (participant_id, purpose, revision) do nothing;

-- ─── Stable Sheets coordinates and PII-free jobs ───

create sequence public.live_sheet_id_seq
  as integer minvalue 1 maxvalue 2147483647 no cycle;
create sequence public.live_sheet_index_row_seq
  as integer minvalue 1 maxvalue 2147483647 no cycle;

create table public.live_sheet_exports (
  session_id uuid primary key references public.live_sessions(id) on delete cascade,
  workbook_ref_version integer not null default 1
    check (workbook_ref_version between 1 and 2147483647),
  sheet_id integer not null default nextval('public.live_sheet_id_seq'::regclass),
  session_index_row integer not null default nextval('public.live_sheet_index_row_seq'::regclass),
  tab_title text not null,
  projection_version bigint not null default 0
    check (projection_version between 0 and 9223372036854775806),
  last_exported_projection_version bigint not null default 0
    check (last_exported_projection_version between 0 and 9223372036854775806),
  last_exported_participant_count integer not null default 0
    check (last_exported_participant_count between 0 and 10000),
  last_outcome text not null default 'never'
    check (last_outcome in ('never', 'succeeded', 'failed')),
  last_error_code text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint live_sheet_exports_sheet_id_check check (sheet_id between 1 and 2147483647),
  constraint live_sheet_exports_index_row_check check (session_index_row between 1 and 2147483647),
  constraint live_sheet_exports_version_order_check check (
    last_exported_projection_version <= projection_version
  ),
  constraint live_sheet_exports_tab_title_check check (
    char_length(tab_title) between 1 and 100
    and tab_title = normalize(btrim(tab_title), NFC)
    and tab_title !~ '[[:cntrl:]\\[\\]:*?/\\\\]'
    and left(tab_title, 1) !~ '[''=+@-]'
  ),
  constraint live_sheet_exports_error_check check (
    last_error_code is null or last_error_code ~ '^[A-Z0-9_]{3,64}$'
  ),
  unique (sheet_id),
  unique (session_index_row),
  unique (tab_title)
);

alter sequence public.live_sheet_id_seq owned by public.live_sheet_exports.sheet_id;
alter sequence public.live_sheet_index_row_seq owned by public.live_sheet_exports.session_index_row;

create table public.live_sheet_sync_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  claim_scope text not null default 'configured_workbook'
    check (claim_scope = 'configured_workbook'),
  projection_version bigint not null check (projection_version between 1 and 9223372036854775806),
  reason text not null check (
    reason in (
      'session_created',
      'session_changed',
      'session_ended',
      'participant_changed',
      'consent_changed',
      'archive_deleted',
      'archive_restored',
      'manual_retry',
      'migration_backfill'
    )
  ),
  state text not null default 'pending'
    check (state in ('pending', 'running', 'succeeded', 'failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 10),
  idempotency_key text not null
    check (idempotency_key ~ '^[0-9a-f-]{36}:[1-9][0-9]{0,18}$'),
  claim_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  safe_error_code text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint live_sheet_sync_jobs_claim_check check (
    (
      state = 'pending'
      and claim_token is null
      and claimed_at is null
      and lease_expires_at is null
      and completed_at is null
    )
    or (
      state = 'running'
      and claim_token is not null
      and claimed_at is not null
      and lease_expires_at > claimed_at
      and completed_at is null
    )
    or (
      state in ('succeeded', 'failed')
      and claim_token is not null
      and claimed_at is not null
      and lease_expires_at is not null
      and completed_at is not null
    )
  ),
  constraint live_sheet_sync_jobs_error_check check (
    safe_error_code is null or safe_error_code ~ '^[A-Z0-9_]{3,64}$'
  ),
  unique (session_id, projection_version)
);

create unique index live_sheet_sync_jobs_one_pending_idx
  on public.live_sheet_sync_jobs (session_id)
  where state = 'pending';
create unique index live_sheet_sync_jobs_one_running_idx
  on public.live_sheet_sync_jobs (claim_scope)
  where state = 'running';
create index live_sheet_sync_jobs_claim_idx
  on public.live_sheet_sync_jobs (state, created_at, id);

create table public.live_sheet_workbook_leases (
  scope text primary key check (scope = 'configured_workbook'),
  running_job_id uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default statement_timestamp(),
  constraint live_sheet_workbook_leases_state_check check (
    (
      running_job_id is null
      and lease_token is null
      and lease_expires_at is null
    )
    or (
      running_job_id is not null
      and lease_token is not null
      and lease_expires_at is not null
    )
  )
);

insert into public.live_sheet_workbook_leases (scope)
values ('configured_workbook');

alter table public.live_sheet_exports enable row level security;
alter table public.live_sheet_sync_jobs enable row level security;
alter table public.live_sheet_workbook_leases enable row level security;

create or replace function public.make_live_sheet_tab_title(
  p_session_date date,
  p_title text,
  p_sheet_id integer
)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  clean_title text;
  suffix text;
  result_title text;
begin
  if p_session_date is null or p_sheet_id not between 1 and 2147483647 then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_COORDINATE';
  end if;
  clean_title := normalize(btrim(coalesce(p_title, '')), NFC);
  clean_title := regexp_replace(clean_title, '[[:cntrl:]\[\]:*?/\\]', ' ', 'g');
  clean_title := regexp_replace(clean_title, '[[:space:]]+', ' ', 'g');
  clean_title := nullif(btrim(clean_title), '');
  suffix := ' #' || p_sheet_id::text;
  result_title := to_char(p_session_date, 'YYYY-MM-DD') || ' '
    || left(coalesce(clean_title, 'Live Call'), 100 - 11 - char_length(suffix))
    || suffix;
  return normalize(btrim(result_title), NFC);
end;
$$;

create or replace function public.enqueue_live_sheet_projection(
  p_session_id uuid,
  p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
  export_row public.live_sheet_exports%rowtype;
  allocated_sheet_id integer;
  allocated_index_row integer;
  next_projection_version bigint;
begin
  if p_session_id is null
    or p_reason not in (
      'session_created', 'session_changed', 'session_ended',
      'participant_changed', 'consent_changed', 'archive_deleted',
      'archive_restored', 'manual_retry', 'migration_backfill'
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_ENQUEUE';
  end if;

  select * into session_row
  from public.live_sessions
  where id = p_session_id
  for update;
  if not found then
    raise exception using errcode = '23503', message = 'LIVE_SESSION_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.live_sheet_exports where session_id = p_session_id
  ) then
    allocated_sheet_id := nextval('public.live_sheet_id_seq'::regclass);
    allocated_index_row := nextval('public.live_sheet_index_row_seq'::regclass);
    insert into public.live_sheet_exports (
      session_id, sheet_id, session_index_row, tab_title
    ) values (
      p_session_id,
      allocated_sheet_id,
      allocated_index_row,
      public.make_live_sheet_tab_title(
        coalesce(session_row.scheduled_at, session_row.created_at)::date,
        session_row.title,
        allocated_sheet_id
      )
    )
    on conflict (session_id) do nothing;
  end if;

  select * into export_row
  from public.live_sheet_exports
  where session_id = p_session_id
  for update;

  next_projection_version := export_row.projection_version + 1;
  update public.live_sheet_exports
  set projection_version = next_projection_version,
      tab_title = case
        when export_row.last_exported_projection_version = 0
          then public.make_live_sheet_tab_title(
            coalesce(session_row.scheduled_at, session_row.created_at)::date,
            session_row.title,
            export_row.sheet_id
          )
        else export_row.tab_title
      end,
      updated_at = statement_timestamp()
  where session_id = p_session_id;

  insert into public.live_sheet_sync_jobs (
    session_id,
    projection_version,
    reason,
    state,
    idempotency_key
  ) values (
    p_session_id,
    next_projection_version,
    p_reason,
    'pending',
    p_session_id::text || ':' || next_projection_version::text
  )
  on conflict (session_id) where (state = 'pending')
  do update set
    projection_version = excluded.projection_version,
    reason = excluded.reason,
    idempotency_key = excluded.idempotency_key,
    updated_at = statement_timestamp();

  return next_projection_version;
end;
$$;

-- ─── Canonical mutation hooks ───

create or replace function public.enqueue_live_session_projection_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.enqueue_live_sheet_projection(new.id, 'session_created');
  elsif new.status in ('stopped', 'failed') and old.status is distinct from new.status then
    perform public.enqueue_live_sheet_projection(new.id, 'session_ended');
  else
    perform public.enqueue_live_sheet_projection(new.id, 'session_changed');
  end if;
  return new;
end;
$$;

create trigger live_sessions_sheet_projection_after_insert
after insert on public.live_sessions
for each row execute function public.enqueue_live_session_projection_trigger();

create trigger live_sessions_sheet_projection_after_end
after update of title, scheduled_at, languages, status, ended_at on public.live_sessions
for each row
when (
  old.title is distinct from new.title
  or old.scheduled_at is distinct from new.scheduled_at
  or old.languages is distinct from new.languages
  or old.status is distinct from new.status
  or old.ended_at is distinct from new.ended_at
)
execute function public.enqueue_live_session_projection_trigger();

create or replace function public.enqueue_live_participant_projection_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enqueue_live_sheet_projection(new.session_id, 'participant_changed');
  return new;
end;
$$;

create trigger live_participants_sheet_projection_after_change
after insert or update of email, company, department, job_title, joined_at, left_at
on public.live_participants
for each row execute function public.enqueue_live_participant_projection_trigger();

create or replace function public.enqueue_live_consent_projection_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_session record;
begin
  for affected_session in
    select distinct consent_row.session_id
    from new_consent_rows consent_row
  loop
    perform public.enqueue_live_sheet_projection(
      affected_session.session_id,
      'consent_changed'
    );
  end loop;
  return null;
end;
$$;

create trigger live_consents_sheet_projection_after_insert
after insert on public.live_participant_consents
referencing new table as new_consent_rows
for each statement execute function public.enqueue_live_consent_projection_trigger();

create or replace function public.enqueue_live_summary_projection_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_session record;
begin
  for affected_session in
    select distinct summary_row.session_id
    from new_summary_rows summary_row
  loop
    perform public.enqueue_live_sheet_projection(
      affected_session.session_id,
      'session_changed'
    );
  end loop;
  return null;
end;
$$;

create trigger live_meeting_summaries_sheet_projection_after_insert
after insert on public.live_meeting_summaries
referencing new table as new_summary_rows
for each statement execute function public.enqueue_live_summary_projection_trigger();

create trigger live_meeting_summaries_sheet_projection_after_update
after update on public.live_meeting_summaries
referencing new table as new_summary_rows
for each statement execute function public.enqueue_live_summary_projection_trigger();

create or replace function public.enqueue_failed_live_summary_projection_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enqueue_live_sheet_projection(new.session_id, 'session_changed');
  return new;
end;
$$;

create trigger live_summary_generation_jobs_sheet_projection_after_failure
after update of status on public.live_summary_generation_jobs
for each row
when (
  old.status is distinct from new.status
  and new.status = 'failed'
)
execute function public.enqueue_failed_live_summary_projection_trigger();

-- ─── Consent and admission RPCs ───

create or replace function public.record_live_participant_consent_v1(
  p_session_id uuid,
  p_participant_id uuid,
  p_user_id text,
  p_purpose text,
  p_notice_version text,
  p_is_accepted boolean
)
returns table (
  consent_id uuid,
  session_id uuid,
  participant_id uuid,
  purpose text,
  notice_version text,
  revision integer,
  is_accepted boolean,
  accepted_at timestamptz,
  withdrawn_at timestamptz,
  recorded_at timestamptz,
  projection_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  participant_row public.live_participants%rowtype;
  latest_consent public.live_participant_consents%rowtype;
  inserted_consent public.live_participant_consents%rowtype;
  normalized_notice_version text;
  next_revision integer;
begin
  normalized_notice_version := normalize(btrim(coalesce(p_notice_version, '')), NFC);
  if p_session_id is null
    or p_participant_id is null
    or p_user_id is null
    or char_length(p_user_id) not between 1 and 256
    or p_purpose not in ('privacy', 'summary_delivery', 'marketing')
    or p_is_accepted is null
    or char_length(normalized_notice_version) not between 1 and 64
    or normalized_notice_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_CONSENT_INPUT';
  end if;
  if p_purpose = 'privacy' and p_is_accepted is false then
    raise exception using errcode = '22023', message = 'PRIVACY_CONSENT_REQUIRED';
  end if;

  select * into participant_row
  from public.live_participants participant_row
  where participant_row.id = p_participant_id
    and participant_row.session_id = p_session_id
    and participant_row.user_id = p_user_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'PARTICIPANT_CONSENT_FORBIDDEN';
  end if;

  select * into latest_consent
  from public.live_participant_consents consent_row
  where consent_row.participant_id = p_participant_id
    and consent_row.purpose = p_purpose
  order by consent_row.revision desc
  limit 1;

  if found
    and latest_consent.notice_version = normalized_notice_version
    and latest_consent.is_accepted = p_is_accepted
  then
    select export_row.projection_version into projection_version
    from public.live_sheet_exports export_row
    where export_row.session_id = p_session_id;
    consent_id := latest_consent.id;
    session_id := latest_consent.session_id;
    participant_id := latest_consent.participant_id;
    purpose := latest_consent.purpose;
    notice_version := latest_consent.notice_version;
    revision := latest_consent.revision;
    is_accepted := latest_consent.is_accepted;
    accepted_at := latest_consent.accepted_at;
    withdrawn_at := latest_consent.withdrawn_at;
    recorded_at := latest_consent.recorded_at;
    return next;
    return;
  end if;

  select coalesce(max(consent_row.revision), 0) + 1 into next_revision
  from public.live_participant_consents consent_row
  where consent_row.participant_id = p_participant_id
    and consent_row.purpose = p_purpose;

  insert into public.live_participant_consents (
    session_id,
    participant_id,
    purpose,
    notice_version,
    revision,
    is_accepted,
    accepted_at,
    withdrawn_at,
    recorded_at
  ) values (
    p_session_id,
    p_participant_id,
    p_purpose,
    normalized_notice_version,
    next_revision,
    p_is_accepted,
    case when p_is_accepted then statement_timestamp() else latest_consent.accepted_at end,
    case
      when p_is_accepted then null
      when latest_consent.is_accepted then statement_timestamp()
      else latest_consent.withdrawn_at
    end,
    statement_timestamp()
  )
  returning * into inserted_consent;

  select export_row.projection_version into projection_version
  from public.live_sheet_exports export_row
  where export_row.session_id = p_session_id;
  consent_id := inserted_consent.id;
  session_id := inserted_consent.session_id;
  participant_id := inserted_consent.participant_id;
  purpose := inserted_consent.purpose;
  notice_version := inserted_consent.notice_version;
  revision := inserted_consent.revision;
  is_accepted := inserted_consent.is_accepted;
  accepted_at := inserted_consent.accepted_at;
  withdrawn_at := inserted_consent.withdrawn_at;
  recorded_at := inserted_consent.recorded_at;
  return next;
end;
$$;

create or replace function public.record_live_participant_consent_choices_v1(
  p_session_id uuid,
  p_participant_id uuid,
  p_user_id text,
  p_summary_is_accepted boolean,
  p_summary_notice_version text,
  p_marketing_is_accepted boolean,
  p_marketing_notice_version text
)
returns table (
  consent_id uuid,
  session_id uuid,
  participant_id uuid,
  purpose text,
  notice_version text,
  revision integer,
  is_accepted boolean,
  accepted_at timestamptz,
  withdrawn_at timestamptz,
  recorded_at timestamptz,
  projection_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  participant_row public.live_participants%rowtype;
  summary_consent public.live_participant_consents%rowtype;
  marketing_consent public.live_participant_consents%rowtype;
  normalized_summary_notice_version text;
  normalized_marketing_notice_version text;
  summary_revision integer;
  marketing_revision integer;
  consent_recorded_at timestamptz;
  committed_projection_version bigint;
begin
  normalized_summary_notice_version := normalize(
    btrim(coalesce(p_summary_notice_version, '')),
    NFC
  );
  normalized_marketing_notice_version := normalize(
    btrim(coalesce(p_marketing_notice_version, '')),
    NFC
  );
  if p_session_id is null
    or p_participant_id is null
    or p_user_id is null
    or char_length(p_user_id) not between 1 and 256
    or p_summary_is_accepted is null
    or p_marketing_is_accepted is null
    or char_length(normalized_summary_notice_version) not between 1 and 64
    or char_length(normalized_marketing_notice_version) not between 1 and 64
    or normalized_summary_notice_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    or normalized_marketing_notice_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_CONSENT_CHOICES_INPUT';
  end if;

  select * into participant_row
  from public.live_participants participant_row
  where participant_row.id = p_participant_id
    and participant_row.session_id = p_session_id
    and participant_row.user_id = p_user_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'PARTICIPANT_CONSENT_FORBIDDEN';
  end if;

  select * into summary_consent
  from public.live_participant_consents consent_row
  where consent_row.participant_id = p_participant_id
    and consent_row.purpose = 'summary_delivery'
  order by consent_row.revision desc
  limit 1;
  summary_revision := coalesce(summary_consent.revision, 0) + 1;

  select * into marketing_consent
  from public.live_participant_consents consent_row
  where consent_row.participant_id = p_participant_id
    and consent_row.purpose = 'marketing'
  order by consent_row.revision desc
  limit 1;
  marketing_revision := coalesce(marketing_consent.revision, 0) + 1;

  if summary_consent.id is not null
    and summary_consent.notice_version = normalized_summary_notice_version
    and summary_consent.is_accepted = p_summary_is_accepted
    and marketing_consent.id is not null
    and marketing_consent.notice_version = normalized_marketing_notice_version
    and marketing_consent.is_accepted = p_marketing_is_accepted
  then
    select export_row.projection_version into committed_projection_version
    from public.live_sheet_exports export_row
    where export_row.session_id = p_session_id;

    return query
    select
      existing_consent.id,
      existing_consent.session_id,
      existing_consent.participant_id,
      existing_consent.purpose,
      existing_consent.notice_version,
      existing_consent.revision,
      existing_consent.is_accepted,
      existing_consent.accepted_at,
      existing_consent.withdrawn_at,
      existing_consent.recorded_at,
      committed_projection_version
    from public.live_participant_consents existing_consent
    where existing_consent.id in (summary_consent.id, marketing_consent.id)
    order by case existing_consent.purpose
      when 'summary_delivery' then 1
      when 'marketing' then 2
      else 3
    end;
    return;
  end if;

  consent_recorded_at := statement_timestamp();

  insert into public.live_participant_consents (
    session_id,
    participant_id,
    purpose,
    notice_version,
    revision,
    is_accepted,
    accepted_at,
    withdrawn_at,
    recorded_at
  ) values (
    p_session_id,
    p_participant_id,
    'summary_delivery',
    normalized_summary_notice_version,
    summary_revision,
    p_summary_is_accepted,
    case
      when p_summary_is_accepted then consent_recorded_at
      else summary_consent.accepted_at
    end,
    case
      when p_summary_is_accepted then null
      when summary_consent.is_accepted then consent_recorded_at
      else summary_consent.withdrawn_at
    end,
    consent_recorded_at
  ), (
    p_session_id,
    p_participant_id,
    'marketing',
    normalized_marketing_notice_version,
    marketing_revision,
    p_marketing_is_accepted,
    case
      when p_marketing_is_accepted then consent_recorded_at
      else marketing_consent.accepted_at
    end,
    case
      when p_marketing_is_accepted then null
      when marketing_consent.is_accepted then consent_recorded_at
      else marketing_consent.withdrawn_at
    end,
    consent_recorded_at
  );

  select export_row.projection_version into committed_projection_version
  from public.live_sheet_exports export_row
  where export_row.session_id = p_session_id;

  return query
  select
    inserted_consent.id,
    inserted_consent.session_id,
    inserted_consent.participant_id,
    inserted_consent.purpose,
    inserted_consent.notice_version,
    inserted_consent.revision,
    inserted_consent.is_accepted,
    inserted_consent.accepted_at,
    inserted_consent.withdrawn_at,
    inserted_consent.recorded_at,
    committed_projection_version
  from public.live_participant_consents inserted_consent
  where inserted_consent.participant_id = p_participant_id
    and (
      (
        inserted_consent.purpose = 'summary_delivery'
        and inserted_consent.revision = summary_revision
      )
      or (
        inserted_consent.purpose = 'marketing'
        and inserted_consent.revision = marketing_revision
      )
    )
  order by case inserted_consent.purpose
    when 'summary_delivery' then 1
    when 'marketing' then 2
    else 3
  end;
end;
$$;

create or replace function public.redeem_live_attendee_v2(
  p_invite_token_hmac text,
  p_code_hmac text,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_email text,
  p_company text,
  p_department text,
  p_job_title text,
  p_privacy_consent boolean,
  p_privacy_notice_version text,
  p_summary_consent boolean,
  p_summary_notice_version text,
  p_marketing_consent boolean,
  p_marketing_notice_version text
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
  email text,
  company text,
  department text,
  job_title text,
  summary_consent_at timestamptz,
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
  attendee_result record;
begin
  if p_privacy_consent is not true
    or p_summary_consent is null
    or p_marketing_consent is null
  then
    raise exception using errcode = '22023', message = 'PRIVACY_CONSENT_REQUIRED';
  end if;

  select * into attendee_result
  from public.redeem_live_attendee_v1(
    p_invite_token_hmac,
    p_code_hmac,
    p_user_id,
    p_device_hash,
    p_grant_expires_at,
    p_email,
    p_company,
    p_department,
    p_job_title,
    p_summary_consent
  );

  perform public.record_live_participant_consent_v1(
    attendee_result.session_id, attendee_result.participant_id, p_user_id,
    'privacy', p_privacy_notice_version, true
  );
  perform public.record_live_participant_consent_v1(
    attendee_result.session_id, attendee_result.participant_id, p_user_id,
    'summary_delivery', p_summary_notice_version, p_summary_consent
  );
  perform public.record_live_participant_consent_v1(
    attendee_result.session_id, attendee_result.participant_id, p_user_id,
    'marketing', p_marketing_notice_version, p_marketing_consent
  );

  return query select
    attendee_result.grant_id,
    attendee_result.session_id,
    attendee_result.user_id,
    attendee_result.grant_expires_at,
    attendee_result.session_type,
    attendee_result.output_mode,
    attendee_result.languages,
    attendee_result.session_expires_at,
    attendee_result.viewer_count,
    attendee_result.max_viewers,
    attendee_result.glossary_pack,
    attendee_result.display_name,
    attendee_result.email,
    attendee_result.company,
    attendee_result.department,
    attendee_result.job_title,
    attendee_result.summary_consent_at,
    attendee_result.participant_id,
    attendee_result.voice_provider,
    attendee_result.status,
    attendee_result.title,
    attendee_result.scheduled_at;
end;
$$;

-- ─── Sheets worker RPCs ───

create or replace function public.claim_live_sheet_sync_job_v1(
  p_claim_token uuid
)
returns table (
  job_id uuid,
  session_id uuid,
  session_index_row integer,
  sheet_id integer,
  tab_title text,
  should_create boolean,
  projection_version bigint,
  previous_participant_count integer,
  workbook_ref_version integer,
  reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.live_sheet_sync_jobs%rowtype;
  lease_row public.live_sheet_workbook_leases%rowtype;
begin
  if p_claim_token is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_CLAIM';
  end if;

  select * into lease_row
  from public.live_sheet_workbook_leases lease_row
  where lease_row.scope = 'configured_workbook'
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'SHEETS_WORKBOOK_LEASE_MISSING';
  end if;

  if lease_row.running_job_id is not null
    and lease_row.lease_expires_at <= statement_timestamp()
  then
    update public.live_sheet_sync_jobs
    set state = 'failed',
        completed_at = statement_timestamp(),
        safe_error_code = 'SHEETS_CLAIM_LEASE_EXPIRED',
        updated_at = statement_timestamp()
    where id = lease_row.running_job_id
      and state = 'running'
      and claim_token = lease_row.lease_token;

    update public.live_sheet_exports export_row
    set last_outcome = 'failed',
        last_error_code = 'SHEETS_CLAIM_LEASE_EXPIRED',
        updated_at = statement_timestamp()
    from public.live_sheet_sync_jobs expired_job
    where expired_job.id = lease_row.running_job_id
      and export_row.session_id = expired_job.session_id;

    update public.live_sheet_workbook_leases
    set running_job_id = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = statement_timestamp()
    where scope = 'configured_workbook';
    lease_row.running_job_id := null;
    lease_row.lease_token := null;
    lease_row.lease_expires_at := null;
  end if;

  if lease_row.running_job_id is not null then
    return;
  end if;

  select * into job_row
  from public.live_sheet_sync_jobs
  where state = 'pending'
  order by created_at, id
  for update skip locked
  limit 1;
  if not found then
    return;
  end if;
  update public.live_sheet_sync_jobs
  set state = 'running',
      claim_token = p_claim_token,
      claimed_at = statement_timestamp(),
      lease_expires_at = statement_timestamp() + interval '5 minutes',
      attempt_count = attempt_count + 1,
      updated_at = statement_timestamp()
  where id = job_row.id
    and state = 'pending'
  returning * into job_row;

  update public.live_sheet_workbook_leases
  set running_job_id = job_row.id,
      lease_token = p_claim_token,
      lease_expires_at = job_row.lease_expires_at,
      updated_at = statement_timestamp()
  where scope = 'configured_workbook';

  return query
  select
    job_row.id,
    export_row.session_id,
    export_row.session_index_row,
    export_row.sheet_id,
    export_row.tab_title,
    export_row.last_exported_projection_version = 0,
    job_row.projection_version,
    export_row.last_exported_participant_count,
    export_row.workbook_ref_version,
    job_row.reason
  from public.live_sheet_exports export_row
  where export_row.session_id = job_row.session_id;
end;
$$;

create or replace function public.read_live_sheet_projection_v1(
  p_job_id uuid,
  p_claim_token uuid
)
returns table (
  session_index_row integer,
  sheet_id integer,
  tab_title text,
  should_create boolean,
  projection_version bigint,
  previous_participant_count integer,
  session_id uuid,
  session_date date,
  session_title text,
  session_status text,
  summary_state text,
  languages text[],
  archived_at timestamptz,
  archive_deleted_at timestamptz,
  participant_count integer,
  participants jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_job_id is null or p_claim_token is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_PROJECTION';
  end if;
  return query
  select
    export_row.session_index_row,
    export_row.sheet_id,
    export_row.tab_title,
    export_row.last_exported_projection_version = 0,
    job_row.projection_version,
    export_row.last_exported_participant_count,
    session_row.id,
    coalesce(session_row.scheduled_at, session_row.created_at)::date,
    session_row.title,
    session_row.status,
    case
      when (
        select count(distinct summary_row.language)
        from public.live_meeting_summaries summary_row
        where summary_row.session_id = session_row.id
          and summary_row.language = any(session_row.languages)
      ) = cardinality(session_row.languages) then 'ready'
      when exists (
        select 1
        from public.live_summary_generation_jobs summary_job
        where summary_job.session_id = session_row.id
          and summary_job.status = 'running'
      ) then 'running'
      when exists (
        select 1
        from public.live_summary_generation_jobs summary_job
        where summary_job.session_id = session_row.id
          and summary_job.status = 'failed'
      ) then 'failed'
      when session_row.status in ('stopped', 'failed') then 'pending'
      else 'not_started'
    end,
    session_row.languages,
    session_row.archived_at,
    session_row.archive_deleted_at,
    count(participant_row.id)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'participantId', participant_row.id,
          'email', participant_row.email,
          'company', participant_row.company,
          'department', participant_row.department,
          'jobTitle', participant_row.job_title,
          'joinedAt', participant_row.joined_at,
          'leftAt', participant_row.left_at,
          'deliveryStatus', case
            when participant_row.summary_consent_at is null then 'not_requested'
            else 'eligible'
          end,
          'consents', coalesce((
            select jsonb_object_agg(
              current_consent.purpose,
              jsonb_build_object(
                'noticeVersion', current_consent.notice_version,
                'isAccepted', current_consent.is_accepted,
                'acceptedAt', current_consent.accepted_at,
                'withdrawnAt', current_consent.withdrawn_at,
                'recordedAt', current_consent.recorded_at
              )
            )
            from (
              select distinct on (consent_row.purpose)
                consent_row.purpose,
                consent_row.notice_version,
                consent_row.is_accepted,
                consent_row.accepted_at,
                consent_row.withdrawn_at,
                consent_row.recorded_at
              from public.live_participant_consents consent_row
              where consent_row.participant_id = participant_row.id
              order by consent_row.purpose, consent_row.revision desc
            ) current_consent
          ), '{}'::jsonb)
        )
        order by participant_row.joined_at, participant_row.id
      ) filter (where participant_row.id is not null),
      '[]'::jsonb
    )
  from public.live_sheet_sync_jobs job_row
  join public.live_sheet_exports export_row
    on export_row.session_id = job_row.session_id
  join public.live_sheet_workbook_leases workbook_lease
    on workbook_lease.scope = job_row.claim_scope
    and workbook_lease.running_job_id = job_row.id
    and workbook_lease.lease_token = job_row.claim_token
  join public.live_sessions session_row
    on session_row.id = job_row.session_id
  left join public.live_participants participant_row
    on participant_row.session_id = session_row.id
  where job_row.id = p_job_id
    and job_row.state = 'running'
    and job_row.claim_token = p_claim_token
    and job_row.lease_expires_at > statement_timestamp()
    and workbook_lease.lease_expires_at > statement_timestamp()
  group by
    export_row.session_index_row,
    export_row.sheet_id,
    export_row.tab_title,
    export_row.last_exported_projection_version,
    export_row.last_exported_participant_count,
    job_row.projection_version,
    session_row.id,
    session_row.scheduled_at,
    session_row.created_at,
    session_row.title,
    session_row.status,
    session_row.languages,
    session_row.archived_at,
    session_row.archive_deleted_at;
end;
$$;

create or replace function public.complete_live_sheet_sync_job_v1(
  p_job_id uuid,
  p_claim_token uuid,
  p_projection_version bigint,
  p_participant_count integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.live_sheet_sync_jobs%rowtype;
  lease_row public.live_sheet_workbook_leases%rowtype;
  changed_count integer;
begin
  if p_job_id is null
    or p_claim_token is null
    or p_projection_version < 1
    or p_participant_count not between 0 and 10000
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_COMPLETION';
  end if;

  select * into lease_row
  from public.live_sheet_workbook_leases lease_row
  where lease_row.scope = 'configured_workbook'
    and lease_row.running_job_id = p_job_id
    and lease_row.lease_token = p_claim_token
    and lease_row.lease_expires_at > statement_timestamp()
  for update;
  if not found then
    return false;
  end if;

  select * into job_row
  from public.live_sheet_sync_jobs job_row
  where job_row.id = p_job_id
    and job_row.state = 'running'
    and job_row.projection_version = p_projection_version
    and job_row.claim_token = p_claim_token
    and job_row.lease_expires_at = lease_row.lease_expires_at
  for update;
  if not found then
    return false;
  end if;

  update public.live_sheet_exports
  set last_exported_projection_version = p_projection_version,
      last_exported_participant_count = p_participant_count,
      last_outcome = 'succeeded',
      last_error_code = null,
      updated_at = statement_timestamp()
  where session_id = job_row.session_id
    and projection_version >= p_projection_version
    and last_exported_projection_version < p_projection_version;
  get diagnostics changed_count = row_count;
  if changed_count <> 1 then
    return false;
  end if;

  update public.live_sheet_sync_jobs
  set state = 'succeeded',
      completed_at = statement_timestamp(),
      safe_error_code = null,
      updated_at = statement_timestamp()
  where id = p_job_id;

  update public.live_sheet_workbook_leases
  set running_job_id = null,
      lease_token = null,
      lease_expires_at = null,
      updated_at = statement_timestamp()
  where scope = 'configured_workbook'
    and running_job_id = p_job_id
    and lease_token = p_claim_token;
  return true;
end;
$$;

create or replace function public.fail_live_sheet_sync_job_v1(
  p_job_id uuid,
  p_claim_token uuid,
  p_safe_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  failed_session_id uuid;
  lease_row public.live_sheet_workbook_leases%rowtype;
begin
  if p_job_id is null
    or p_claim_token is null
    or p_safe_error_code !~ '^[A-Z0-9_]{3,64}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_FAILURE';
  end if;

  select * into lease_row
  from public.live_sheet_workbook_leases lease_row
  where lease_row.scope = 'configured_workbook'
    and lease_row.running_job_id = p_job_id
    and lease_row.lease_token = p_claim_token
    and lease_row.lease_expires_at > statement_timestamp()
  for update;
  if not found then
    return false;
  end if;

  update public.live_sheet_sync_jobs
  set state = 'failed',
      completed_at = statement_timestamp(),
      safe_error_code = p_safe_error_code,
      updated_at = statement_timestamp()
  where id = p_job_id
    and state = 'running'
    and claim_token = p_claim_token
    and lease_expires_at = lease_row.lease_expires_at
  returning session_id into failed_session_id;
  if failed_session_id is null then
    return false;
  end if;
  update public.live_sheet_exports
  set last_outcome = 'failed',
      last_error_code = p_safe_error_code,
      updated_at = statement_timestamp()
  where session_id = failed_session_id;

  update public.live_sheet_workbook_leases
  set running_job_id = null,
      lease_token = null,
      lease_expires_at = null,
      updated_at = statement_timestamp()
  where scope = 'configured_workbook'
    and running_job_id = p_job_id
    and lease_token = p_claim_token;
  return true;
end;
$$;

create or replace function public.retry_live_sheet_sync_job_v1(
  p_session_id uuid,
  p_host_id text
)
returns table (
  projection_version bigint,
  state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  failed_job public.live_sheet_sync_jobs%rowtype;
  next_version bigint;
begin
  if p_session_id is null
    or p_host_id is null
    or char_length(p_host_id) not between 1 and 256
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SHEET_RETRY';
  end if;
  if not exists (
    select 1 from public.live_sessions session_row
    where session_row.id = p_session_id and session_row.host_id = p_host_id
  ) then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  if exists (
    select 1 from public.live_sheet_sync_jobs pending_job
    where pending_job.session_id = p_session_id
      and pending_job.state = 'pending'
  ) then
    raise exception using errcode = '40001', message = 'LIVE_SHEET_RETRY_CONFLICT';
  end if;
  select * into failed_job
  from public.live_sheet_sync_jobs job_row
  where job_row.session_id = p_session_id
    and job_row.state = 'failed'
  order by job_row.created_at desc, job_row.id desc
  for update
  limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_SHEET_RETRY_NOT_AVAILABLE';
  end if;
  next_version := public.enqueue_live_sheet_projection(p_session_id, 'manual_retry');
  return query
  select pending_job.projection_version, pending_job.state
  from public.live_sheet_sync_jobs pending_job
  where pending_job.session_id = p_session_id
    and pending_job.state = 'pending'
    and pending_job.projection_version = next_version;
end;
$$;

-- ─── Recoverable archive deletion ───

create or replace function public.request_live_session_archive_deletion_v1(
  p_session_id uuid,
  p_host_id text
)
returns table (
  session_id uuid,
  archive_deleted_at timestamptz,
  archive_purge_after timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_session_id is null or p_host_id is null or char_length(p_host_id) not between 1 and 256 then
    raise exception using errcode = '22023', message = 'INVALID_ARCHIVE_DELETE_INPUT';
  end if;
  return query
  update public.live_sessions session_row
  set archive_deleted_at = statement_timestamp(),
      archive_purge_after = statement_timestamp() + interval '30 days',
      updated_at = statement_timestamp()
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.archived_at is not null
    and session_row.archive_deleted_at is null
  returning session_row.id, session_row.archive_deleted_at, session_row.archive_purge_after;
  if not found then
    raise exception using errcode = 'P0001', message = 'ARCHIVE_DELETE_NOT_AVAILABLE';
  end if;
  perform public.enqueue_live_sheet_projection(p_session_id, 'archive_deleted');
end;
$$;

create or replace function public.restore_live_session_archive_v1(
  p_session_id uuid,
  p_host_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_session_id is null or p_host_id is null or char_length(p_host_id) not between 1 and 256 then
    raise exception using errcode = '22023', message = 'INVALID_ARCHIVE_RESTORE_INPUT';
  end if;
  update public.live_sessions session_row
  set archive_deleted_at = null,
      archive_purge_after = null,
      updated_at = statement_timestamp()
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.archive_deleted_at is not null
    and session_row.archive_purge_after > statement_timestamp();
  if not found then
    return false;
  end if;
  perform public.enqueue_live_sheet_projection(p_session_id, 'archive_restored');
  return true;
end;
$$;

create or replace function public.purge_live_session_archives_v1(
  p_limit integer default 50
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_ARCHIVE_PURGE_LIMIT';
  end if;
  with purgeable as (
    select session_row.id
    from public.live_sessions session_row
    where session_row.archive_deleted_at is not null
      and session_row.archive_purge_after <= statement_timestamp()
    order by session_row.archive_purge_after, session_row.id
    for update skip locked
    limit p_limit
  ), deleted as (
    delete from public.live_sessions session_row
    using purgeable
    where session_row.id = purgeable.id
    returning session_row.id
  )
  select count(*)::integer into deleted_count from deleted;
  return deleted_count;
end;
$$;

-- ─── Retention separation ───

create or replace function public.cleanup_expired_live_state()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  stopped_count integer;
begin
  perform 1
  from public.live_sessions session_lock
  where (
      session_lock.status <> 'stopped'
      and session_lock.expires_at <= statement_timestamp()
    )
    or exists (
      select 1 from public.viewer_grants grant_lock
      where grant_lock.session_id = session_lock.id
        and (
          grant_lock.revoked_at is not null
          or grant_lock.expires_at <= statement_timestamp()
          or session_lock.status = 'stopped'
          or session_lock.expires_at <= statement_timestamp()
        )
    )
    or exists (
      select 1 from public.live_recap_grants recap_lock
      where recap_lock.session_id = session_lock.id
        and recap_lock.expires_at <= statement_timestamp()
    )
  order by session_lock.id
  for update;

  with stopped as (
    update public.live_sessions
    set status = 'stopped',
        viewer_count = 0,
        floor_grant_id = null,
        floor_display_name = null,
        floor_taken_at = null,
        admission_code_hmac = null,
        admission_open_until = null,
        ended_at = coalesce(ended_at, statement_timestamp()),
        updated_at = statement_timestamp(),
        version = version + 1
    where status <> 'stopped'
      and expires_at <= statement_timestamp()
    returning id
  )
  select count(*)::integer into stopped_count from stopped;

  update public.live_session_invites invite_row
  set revoked_at = coalesce(invite_row.revoked_at, statement_timestamp())
  from public.live_sessions session_row
  where invite_row.session_id = session_row.id
    and invite_row.revoked_at is null
    and (
      invite_row.expires_at <= statement_timestamp()
      or session_row.status = 'stopped'
      or session_row.expires_at <= statement_timestamp()
    );

  insert into public.live_recap_grants (session_id, user_id, expires_at, created_at)
  select grant_row.session_id, grant_row.user_id,
    statement_timestamp() + interval '30 days', statement_timestamp()
  from public.viewer_grants grant_row
  join public.live_sessions session_row on session_row.id = grant_row.session_id
  where session_row.status = 'stopped'
  on conflict (session_id, user_id) do update
    set expires_at = greatest(live_recap_grants.expires_at, excluded.expires_at);

  delete from public.viewer_grants grant_row
  using public.live_sessions session_row
  where grant_row.session_id = session_row.id
    and (
      grant_row.revoked_at is not null
      or grant_row.expires_at <= statement_timestamp()
      or session_row.status = 'stopped'
      or session_row.expires_at <= statement_timestamp()
    );

  update public.live_sessions session_row
  set viewer_count = active_grants.viewer_count,
      updated_at = statement_timestamp()
  from (
    select session_id, count(*)::integer as viewer_count
    from public.viewer_grants
    where revoked_at is null and expires_at > statement_timestamp()
    group by session_id
  ) active_grants
  where session_row.id = active_grants.session_id
    and session_row.status <> 'stopped'
    and session_row.viewer_count <> active_grants.viewer_count;

  update public.live_sessions session_row
  set viewer_count = 0,
      updated_at = statement_timestamp()
  where session_row.status <> 'stopped'
    and session_row.viewer_count <> 0
    and not exists (
      select 1 from public.viewer_grants grant_row
      where grant_row.session_id = session_row.id
        and grant_row.revoked_at is null
        and grant_row.expires_at > statement_timestamp()
    );

  delete from public.live_snapshots snapshot_row
  using public.live_sessions session_row
  where snapshot_row.session_id = session_row.id
    and session_row.status = 'stopped';
  delete from public.session_speakers speaker_row
  using public.live_sessions session_row
  where speaker_row.session_id = session_row.id
    and session_row.status = 'stopped';
  delete from public.live_session_invites
  where revoked_at < statement_timestamp() - interval '1 day';
  delete from public.live_rate_limits
  where updated_at < statement_timestamp() - interval '1 day';
  delete from public.live_recap_grants
  where expires_at <= statement_timestamp();

  return stopped_count;
end;
$$;

create or replace function public.cleanup_expired_live_participants()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Participant operations belong to the ADMIN archive and are removed only
  -- by the recoverable parent-session purge.
  return 0;
end;
$$;

create or replace function public.cleanup_expired_live_topics()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Topics and assignment fences remain canonical archive content.
  return 0;
end;
$$;

-- Existing sessions receive a single coalesced projection without exposing
-- participant payload in the migration or job rows.
do $$
declare
  session_row record;
begin
  for session_row in select id from public.live_sessions order by id loop
    perform public.enqueue_live_sheet_projection(session_row.id, 'migration_backfill');
  end loop;
end $$;

-- ─── Closed tables and service-role-only RPCs ───

create or replace function public.live_record_summary_state_v1(
  p_session_id uuid,
  p_languages text[],
  p_status text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_session_id is null or p_languages is null or cardinality(p_languages) < 1 then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_SUMMARY_STATE';
  end if;
  if (
    select count(distinct summary_row.language)
    from public.live_meeting_summaries summary_row
    where summary_row.session_id = p_session_id
      and summary_row.language = any(p_languages)
  ) = cardinality(p_languages) then
    return 'ready';
  end if;
  if exists (
    select 1 from public.live_summary_generation_jobs summary_job
    where summary_job.session_id = p_session_id and summary_job.status = 'running'
  ) then
    return 'running';
  end if;
  if exists (
    select 1 from public.live_summary_generation_jobs summary_job
    where summary_job.session_id = p_session_id and summary_job.status = 'failed'
  ) then
    return 'failed';
  end if;
  if p_status in ('stopped', 'failed') then
    return 'pending';
  end if;
  return 'not_started';
end;
$$;

create or replace function public.live_record_sheet_sync_state_v1(
  p_session_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  latest_state text;
  last_outcome text;
begin
  select job_row.state into latest_state
  from public.live_sheet_sync_jobs job_row
  where job_row.session_id = p_session_id
  order by job_row.updated_at desc, job_row.id desc
  limit 1;
  if latest_state = 'running' then return 'syncing'; end if;
  if latest_state in ('pending', 'failed') then return latest_state; end if;
  select export_row.last_outcome into last_outcome
  from public.live_sheet_exports export_row
  where export_row.session_id = p_session_id;
  if latest_state = 'succeeded' or last_outcome = 'succeeded' then return 'succeeded'; end if;
  if last_outcome = 'failed' then return 'failed'; end if;
  return 'not_started';
end;
$$;

create or replace function public.list_owned_live_records_v1(
  p_host_id text,
  p_page integer,
  p_page_size integer,
  p_search text
)
returns table (
  session_id uuid,
  title text,
  status text,
  languages text[],
  created_at timestamptz,
  scheduled_at timestamptz,
  ended_at timestamptz,
  archived_at timestamptz,
  participant_count integer,
  summary_state text,
  sheet_sync_state text,
  sheet_error_code text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  normalized_search text;
begin
  normalized_search := normalize(btrim(coalesce(p_search, '')), NFC);
  if p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_page < 1
    or p_page > 100000
    or p_page_size not between 1 and 100
    or char_length(normalized_search) > 100
    or normalized_search ~ '[[:cntrl:]<>]'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_LIST_INPUT';
  end if;

  return query
  select
    session_row.id,
    session_row.title,
    session_row.status,
    session_row.languages,
    session_row.created_at,
    session_row.scheduled_at,
    session_row.ended_at,
    session_row.archived_at,
    (select count(*)::integer from public.live_participants participant_row
      where participant_row.session_id = session_row.id),
    public.live_record_summary_state_v1(
      session_row.id, session_row.languages, session_row.status
    ),
    public.live_record_sheet_sync_state_v1(session_row.id),
    coalesce((
      select job_row.safe_error_code
      from public.live_sheet_sync_jobs job_row
      where job_row.session_id = session_row.id and job_row.state = 'failed'
      order by job_row.updated_at desc, job_row.id desc
      limit 1
    ), export_row.last_error_code),
    count(*) over()
  from public.live_sessions session_row
  left join public.live_sheet_exports export_row
    on export_row.session_id = session_row.id
  where session_row.host_id = p_host_id
    and session_row.archived_at is not null
    and session_row.archive_deleted_at is null
    and (
      normalized_search = ''
      or position(lower(normalized_search) in lower(session_row.title)) > 0
      or position(
        normalized_search in to_char(
          coalesce(session_row.scheduled_at, session_row.created_at) at time zone 'UTC',
          'YYYY-MM-DD'
        )
      ) > 0
    )
  order by session_row.archived_at desc, session_row.id desc
  limit p_page_size
  offset (p_page - 1)::bigint * p_page_size;
end;
$$;

create or replace function public.read_owned_live_record_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  title text,
  status text,
  session_type text,
  output_mode text,
  languages text[],
  created_at timestamptz,
  scheduled_at timestamptz,
  ended_at timestamptz,
  archived_at timestamptz,
  participant_count bigint,
  utterance_count bigint,
  topic_count bigint,
  summary_state text,
  sheet_sync_state text,
  sheet_error_code text,
  sheet_id integer,
  session_index_row integer,
  tab_title text,
  projection_version bigint,
  last_exported_projection_version bigint,
  last_exported_participant_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  owned_session public.live_sessions%rowtype;
begin
  if p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_session_id is null
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_READ_INPUT';
  end if;
  select * into owned_session
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.archive_deleted_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;

  return query
  select
    owned_session.id,
    owned_session.title,
    owned_session.status,
    owned_session.session_type,
    owned_session.output_mode,
    owned_session.languages,
    owned_session.created_at,
    owned_session.scheduled_at,
    owned_session.ended_at,
    owned_session.archived_at,
    (select count(*) from public.live_participants participant_row
      where participant_row.session_id = owned_session.id),
    (select count(*) from public.live_utterances utterance_row
      where utterance_row.session_id = owned_session.id),
    (select count(*) from public.live_topics topic_row
      where topic_row.session_id = owned_session.id),
    public.live_record_summary_state_v1(
      owned_session.id, owned_session.languages, owned_session.status
    ),
    public.live_record_sheet_sync_state_v1(owned_session.id),
    coalesce((
      select job_row.safe_error_code
      from public.live_sheet_sync_jobs job_row
      where job_row.session_id = owned_session.id and job_row.state = 'failed'
      order by job_row.updated_at desc, job_row.id desc
      limit 1
    ), export_row.last_error_code),
    export_row.sheet_id,
    export_row.session_index_row,
    export_row.tab_title,
    export_row.projection_version,
    export_row.last_exported_projection_version,
    export_row.last_exported_participant_count
  from public.live_sheet_exports export_row
  where export_row.session_id = owned_session.id;
end;
$$;

create or replace function public.read_owned_live_record_participants_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  participant_id uuid,
  display_name text,
  email text,
  company text,
  department text,
  job_title text,
  joined_at timestamptz,
  left_at timestamptz,
  privacy_is_accepted boolean,
  privacy_notice_version text,
  privacy_accepted_at timestamptz,
  privacy_withdrawn_at timestamptz,
  summary_delivery_is_accepted boolean,
  summary_delivery_notice_version text,
  summary_delivery_accepted_at timestamptz,
  summary_delivery_withdrawn_at timestamptz,
  marketing_is_accepted boolean,
  marketing_notice_version text,
  marketing_accepted_at timestamptz,
  marketing_withdrawn_at timestamptz,
  delivery_status text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_host_id is null
    or char_length(p_host_id) not between 1 and 256
    or p_session_id is null
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_PARTICIPANTS_INPUT';
  end if;
  perform 1
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
    and session_row.archive_deleted_at is null
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;

  return query
  with current_consent as (
    select distinct on (consent_row.participant_id, consent_row.purpose)
      consent_row.participant_id,
      consent_row.purpose,
      consent_row.notice_version,
      consent_row.is_accepted,
      consent_row.accepted_at,
      consent_row.withdrawn_at
    from public.live_participant_consents consent_row
    where consent_row.session_id = p_session_id
    order by consent_row.participant_id, consent_row.purpose, consent_row.revision desc
  )
  select
    participant_row.id,
    participant_row.display_name,
    participant_row.email,
    participant_row.company,
    participant_row.department,
    participant_row.job_title,
    participant_row.joined_at,
    participant_row.left_at,
    coalesce(privacy_consent.is_accepted, false),
    privacy_consent.notice_version,
    privacy_consent.accepted_at,
    privacy_consent.withdrawn_at,
    coalesce(summary_consent.is_accepted, false),
    summary_consent.notice_version,
    summary_consent.accepted_at,
    summary_consent.withdrawn_at,
    coalesce(marketing_consent.is_accepted, false),
    marketing_consent.notice_version,
    marketing_consent.accepted_at,
    marketing_consent.withdrawn_at,
    case when summary_consent.is_accepted is true then 'eligible' else 'not_requested' end
  from public.live_participants participant_row
  left join current_consent privacy_consent
    on privacy_consent.participant_id = participant_row.id
   and privacy_consent.purpose = 'privacy'
  left join current_consent summary_consent
    on summary_consent.participant_id = participant_row.id
   and summary_consent.purpose = 'summary_delivery'
  left join current_consent marketing_consent
    on marketing_consent.participant_id = participant_row.id
   and marketing_consent.purpose = 'marketing'
  where participant_row.session_id = p_session_id
  order by participant_row.joined_at, participant_row.id;
end;
$$;

create or replace function public.soft_delete_owned_live_record_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  archived_at timestamptz,
  archive_deleted_at timestamptz,
  archive_purge_after timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
begin
  if p_host_id is null or char_length(p_host_id) not between 1 and 256 or p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_DELETE_INPUT';
  end if;
  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  if session_row.archived_at is null or session_row.archive_deleted_at is not null then
    raise exception using errcode = 'P0001', message = 'ARCHIVE_DELETE_NOT_AVAILABLE';
  end if;
  update public.live_sessions session_target
  set archive_deleted_at = statement_timestamp(),
      archive_purge_after = statement_timestamp() + interval '30 days',
      updated_at = statement_timestamp()
  where session_target.id = p_session_id
  returning session_target.* into session_row;
  perform public.enqueue_live_sheet_projection(p_session_id, 'archive_deleted');
  return query select
    session_row.id, session_row.archived_at,
    session_row.archive_deleted_at, session_row.archive_purge_after;
end;
$$;

create or replace function public.restore_owned_live_record_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  archived_at timestamptz,
  archive_deleted_at timestamptz,
  archive_purge_after timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
begin
  if p_host_id is null or char_length(p_host_id) not between 1 and 256 or p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_RESTORE_INPUT';
  end if;
  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  if session_row.archive_deleted_at is null
    or session_row.archive_purge_after <= statement_timestamp()
  then
    raise exception using errcode = 'P0001', message = 'ARCHIVE_RESTORE_NOT_AVAILABLE';
  end if;
  update public.live_sessions session_target
  set archive_deleted_at = null,
      archive_purge_after = null,
      updated_at = statement_timestamp()
  where session_target.id = p_session_id
  returning session_target.* into session_row;
  perform public.enqueue_live_sheet_projection(p_session_id, 'archive_restored');
  return query select
    session_row.id, session_row.archived_at,
    session_row.archive_deleted_at, session_row.archive_purge_after;
end;
$$;

create or replace function public.read_owned_live_record_purge_eligibility_v1(
  p_host_id text,
  p_session_id uuid
)
returns table (
  session_id uuid,
  is_deleted boolean,
  is_purge_eligible boolean,
  archive_deleted_at timestamptz,
  archive_purge_after timestamptz,
  recovery_seconds_remaining bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.live_sessions%rowtype;
begin
  if p_host_id is null or char_length(p_host_id) not between 1 and 256 or p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_RECORD_PURGE_READ_INPUT';
  end if;
  select * into session_row
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.host_id = p_host_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;
  return query select
    session_row.id,
    session_row.archive_deleted_at is not null,
    session_row.archive_purge_after is not null
      and session_row.archive_purge_after <= statement_timestamp(),
    session_row.archive_deleted_at,
    session_row.archive_purge_after,
    case when session_row.archive_purge_after is null then null
      else greatest(0, extract(epoch from (
        session_row.archive_purge_after - statement_timestamp()
      ))::bigint)
    end;
end;
$$;

revoke all on table public.live_participant_consents
  from public, anon, authenticated, service_role;
revoke all on table public.live_sheet_sync_jobs
  from public, anon, authenticated, service_role;
revoke all on table public.live_sheet_exports
  from public, anon, authenticated, service_role;
revoke all on table public.live_sheet_workbook_leases
  from public, anon, authenticated, service_role;
revoke all on sequence public.live_sheet_id_seq
  from public, anon, authenticated, service_role;
revoke all on sequence public.live_sheet_index_row_seq
  from public, anon, authenticated, service_role;

revoke all on function public.mark_live_session_archived()
  from public, anon, authenticated, service_role;
revoke all on function public.assert_live_participant_consent_binding()
  from public, anon, authenticated, service_role;
revoke all on function public.prevent_live_participant_consent_mutation()
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_live_session_projection_trigger()
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_live_participant_projection_trigger()
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_live_consent_projection_trigger()
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_live_summary_projection_trigger()
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_failed_live_summary_projection_trigger()
  from public, anon, authenticated, service_role;
revoke all on function public.live_record_summary_state_v1(uuid, text[], text)
  from public, anon, authenticated, service_role;
revoke all on function public.live_record_sheet_sync_state_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.make_live_sheet_tab_title(date, text, integer)
  from public, anon, authenticated;
revoke all on function public.enqueue_live_sheet_projection(uuid, text)
  from public, anon, authenticated;
revoke all on function public.create_live_session(
  uuid, text, text, text, text[], integer, text, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.update_live_session(
  uuid, text, integer, text, text, text[], integer, text, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.record_live_participant_consent_v1(uuid, uuid, text, text, text, boolean)
  from public, anon, authenticated;
revoke all on function public.record_live_participant_consent_choices_v1(
  uuid, uuid, text, boolean, text, boolean, text
) from public, anon, authenticated;
revoke all on function public.redeem_live_attendee_v2(
  text, text, text, text, timestamptz, text, text, text, text,
  boolean, text, boolean, text, boolean, text
) from public, anon, authenticated;
revoke all on function public.claim_live_sheet_sync_job_v1(uuid)
  from public, anon, authenticated;
revoke all on function public.read_live_sheet_projection_v1(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.complete_live_sheet_sync_job_v1(uuid, uuid, bigint, integer)
  from public, anon, authenticated;
revoke all on function public.fail_live_sheet_sync_job_v1(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.retry_live_sheet_sync_job_v1(uuid, text)
  from public, anon, authenticated;
revoke all on function public.request_live_session_archive_deletion_v1(uuid, text)
  from public, anon, authenticated;
revoke all on function public.restore_live_session_archive_v1(uuid, text)
  from public, anon, authenticated;
revoke all on function public.purge_live_session_archives_v1(integer)
  from public, anon, authenticated;
revoke all on function public.list_owned_live_records_v1(text, integer, integer, text)
  from public, anon, authenticated;
revoke all on function public.read_owned_live_record_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.read_owned_live_record_participants_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.soft_delete_owned_live_record_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.restore_owned_live_record_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.read_owned_live_record_purge_eligibility_v1(text, uuid)
  from public, anon, authenticated;

grant execute on function public.make_live_sheet_tab_title(date, text, integer)
  to service_role;
grant execute on function public.enqueue_live_sheet_projection(uuid, text)
  to service_role;
grant execute on function public.create_live_session(
  uuid, text, text, text, text[], integer, text, text, text, timestamptz, timestamptz
) to service_role;
grant execute on function public.update_live_session(
  uuid, text, integer, text, text, text[], integer, text, text, text, timestamptz
) to service_role;
grant execute on function public.record_live_participant_consent_v1(uuid, uuid, text, text, text, boolean)
  to service_role;
grant execute on function public.record_live_participant_consent_choices_v1(
  uuid, uuid, text, boolean, text, boolean, text
) to service_role;
grant execute on function public.redeem_live_attendee_v2(
  text, text, text, text, timestamptz, text, text, text, text,
  boolean, text, boolean, text, boolean, text
) to service_role;
grant execute on function public.claim_live_sheet_sync_job_v1(uuid)
  to service_role;
grant execute on function public.read_live_sheet_projection_v1(uuid, uuid)
  to service_role;
grant execute on function public.complete_live_sheet_sync_job_v1(uuid, uuid, bigint, integer)
  to service_role;
grant execute on function public.fail_live_sheet_sync_job_v1(uuid, uuid, text)
  to service_role;
grant execute on function public.retry_live_sheet_sync_job_v1(uuid, text)
  to service_role;
grant execute on function public.request_live_session_archive_deletion_v1(uuid, text)
  to service_role;
grant execute on function public.restore_live_session_archive_v1(uuid, text)
  to service_role;
grant execute on function public.purge_live_session_archives_v1(integer)
  to service_role;
grant execute on function public.list_owned_live_records_v1(text, integer, integer, text)
  to service_role;
grant execute on function public.read_owned_live_record_v1(text, uuid)
  to service_role;
grant execute on function public.read_owned_live_record_participants_v1(text, uuid)
  to service_role;
grant execute on function public.soft_delete_owned_live_record_v1(text, uuid)
  to service_role;
grant execute on function public.restore_owned_live_record_v1(text, uuid)
  to service_role;
grant execute on function public.read_owned_live_record_purge_eligibility_v1(text, uuid)
  to service_role;

revoke all on function public.cleanup_expired_live_state()
  from public, anon, authenticated;
revoke all on function public.cleanup_expired_live_participants()
  from public, anon, authenticated;
revoke all on function public.cleanup_expired_live_topics()
  from public, anon, authenticated;
grant execute on function public.cleanup_expired_live_state() to service_role;
grant execute on function public.cleanup_expired_live_participants() to service_role;
grant execute on function public.cleanup_expired_live_topics() to service_role;
