-- 2026-08-15 feat: Add versioned glossary documents, immutable live-session
-- pins, and earnings-call section metadata. This migration is additive: the
-- legacy host_glossary_presets.glossary text contract remains readable.

alter table public.host_glossary_presets
  add column if not exists active_document_version integer,
  add column if not exists active_document_fingerprint text;

alter table public.host_glossary_presets
  drop constraint if exists host_glossary_presets_active_document_check,
  add constraint host_glossary_presets_active_document_check check (
    (active_document_version is null and active_document_fingerprint is null)
    or (
      active_document_version is not null
      and active_document_version >= 1
      and active_document_fingerprint is not null
      and active_document_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    )
  );

create table if not exists public.host_glossary_preset_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  preset_id uuid not null references public.host_glossary_presets(id) on delete cascade,
  host_id text not null,
  version integer not null,
  document_schema text not null default 'glossary-document/v1',
  document jsonb not null,
  fingerprint text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint host_glossary_preset_versions_host_id_check check (
    char_length(host_id) between 1 and 100
    and host_id = btrim(host_id)
    and host_id !~ '[[:cntrl:]]'
  ),
  constraint host_glossary_preset_versions_version_check check (version >= 1),
  constraint host_glossary_preset_versions_document_schema_check check (
    document_schema = 'glossary-document/v1'
  ),
  constraint host_glossary_preset_versions_document_check check (
    jsonb_typeof(document) = 'object'
    and octet_length(document::text) <= 5000000
  ),
  constraint host_glossary_preset_versions_fingerprint_check check (
    fingerprint ~ '^sha256:[0-9a-f]{64}$'
  ),
  unique (preset_id, version),
  unique (preset_id, fingerprint)
);

create index if not exists host_glossary_preset_versions_host_idx
  on public.host_glossary_preset_versions (host_id, preset_id, version desc);

alter table public.host_glossary_preset_versions enable row level security;

revoke all on table public.host_glossary_preset_versions
  from public, anon, authenticated, service_role;

alter table public.live_sessions
  add column if not exists pinned_glossary_preset_id uuid references public.host_glossary_presets(id) on delete restrict,
  add column if not exists pinned_glossary_version integer,
  add column if not exists pinned_glossary_fingerprint text,
  add column if not exists event_company_name text,
  add column if not exists event_reporting_period text,
  add column if not exists event_metadata jsonb not null default '{}'::jsonb;

alter table public.live_sessions
  drop constraint if exists live_sessions_pinned_glossary_check,
  add constraint live_sessions_pinned_glossary_check check (
    (pinned_glossary_preset_id is null and pinned_glossary_version is null and pinned_glossary_fingerprint is null)
    or (
      pinned_glossary_preset_id is not null
      and pinned_glossary_version is not null
      and pinned_glossary_version >= 1
      and pinned_glossary_fingerprint is not null
      and pinned_glossary_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    )
  );

alter table public.live_sessions
  drop constraint if exists live_sessions_event_metadata_check,
  add constraint live_sessions_event_metadata_check check (
    (event_company_name is null or (
      char_length(event_company_name) between 1 and 160
      and event_company_name = normalize(btrim(event_company_name), NFC)
      and event_company_name !~ '[[:cntrl:]]'
      and event_company_name !~ '[<>]'
    ))
    and (event_reporting_period is null or (
      char_length(event_reporting_period) between 1 and 80
      and event_reporting_period = normalize(btrim(event_reporting_period), NFC)
      and event_reporting_period !~ '[[:cntrl:]]'
      and event_reporting_period !~ '[<>]'
    ))
    and jsonb_typeof(event_metadata) = 'object'
    and octet_length(event_metadata::text) <= 4096
  );

create table if not exists public.live_session_sections (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  section_key text not null,
  status text not null default 'active',
  transition_key text not null,
  source_seq bigint,
  ordinal integer not null,
  version integer not null default 1,
  started_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint live_session_sections_section_key_check check (
    section_key in ('prepared_remarks', 'qa', 'other')
  ),
  constraint live_session_sections_status_check check (
    status in ('active', 'completed')
  ),
  constraint live_session_sections_transition_key_check check (
    char_length(transition_key) between 1 and 256
    and transition_key = normalize(btrim(transition_key), NFC)
    and transition_key !~ '[[:cntrl:]]'
    and transition_key !~ '[<>]'
  ),
  constraint live_session_sections_source_seq_check check (
    source_seq is null or source_seq >= 0
  ),
  constraint live_session_sections_ordinal_check check (
    ordinal between 1 and 100
  ),
  constraint live_session_sections_version_check check (version >= 1),
  constraint live_session_sections_completed_check check (
    (status = 'active' and completed_at is null)
    or (status = 'completed' and completed_at is not null and completed_at >= started_at)
  ),
  unique (session_id, transition_key),
  unique (session_id, ordinal)
);

create unique index if not exists live_session_sections_one_active_idx
  on public.live_session_sections (session_id)
  where status = 'active';

create index if not exists live_session_sections_snapshot_idx
  on public.live_session_sections (session_id, ordinal);

alter table public.live_session_sections enable row level security;

revoke all on table public.live_session_sections
  from public, anon, authenticated, service_role;

create or replace function public.create_host_glossary_document_preset_v1(
  p_host_id text,
  p_name text,
  p_domain text,
  p_language_a text,
  p_language_b text,
  p_document jsonb,
  p_fingerprint text
)
returns table (
  id uuid,
  name text,
  domain text,
  language_a text,
  language_b text,
  version integer,
  active_document_version integer,
  active_document_fingerprint text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  clean_name text;
  clean_domain text;
  clean_language_a text;
  clean_language_b text;
  clean_fingerprint text;
  preset_count integer;
  created_preset public.host_glossary_presets%rowtype;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  clean_name := pg_catalog.btrim(coalesce(p_name, ''));
  clean_domain := pg_catalog.btrim(coalesce(p_domain, ''));
  clean_language_a := pg_catalog.btrim(coalesce(p_language_a, ''));
  clean_language_b := pg_catalog.btrim(coalesce(p_language_b, ''));
  clean_fingerprint := pg_catalog.btrim(coalesce(p_fingerprint, ''));

  if pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_name) not between 1 and 80
    or clean_name ~ '[[:cntrl:]]'
    or clean_name ~ '[<>]'
    or pg_catalog.char_length(clean_domain) > 600
    or clean_domain ~ '[[:cntrl:]]'
    or public.live_language_valid(clean_language_a) is not true
    or public.live_language_valid(clean_language_b) is not true
    or clean_language_a = clean_language_b
    or p_document is null
    or jsonb_typeof(p_document) <> 'object'
    or octet_length(p_document::text) > 5000000
    or clean_fingerprint !~ '^sha256:[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_GLOSSARY_DOCUMENT_INPUT';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(clean_host_id, 0));

  select count(*) into preset_count
  from public.host_glossary_presets as preset_row
  where preset_row.host_id = clean_host_id;

  if preset_count >= 50 then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_LIMIT_REACHED';
  end if;

  insert into public.host_glossary_presets (
    host_id,
    name,
    domain,
    glossary,
    language_a,
    language_b,
    active_document_version,
    active_document_fingerprint
  ) values (
    clean_host_id,
    clean_name,
    clean_domain,
    'Document glossary',
    clean_language_a,
    clean_language_b,
    1,
    clean_fingerprint
  )
  returning * into created_preset;

  insert into public.host_glossary_preset_versions (
    preset_id, host_id, version, document, fingerprint
  ) values (
    created_preset.id, clean_host_id, 1, p_document, clean_fingerprint
  );

  return query select
    created_preset.id,
    created_preset.name,
    created_preset.domain,
    created_preset.language_a,
    created_preset.language_b,
    created_preset.version,
    created_preset.active_document_version,
    created_preset.active_document_fingerprint,
    created_preset.updated_at;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NAME_CONFLICT';
end;
$$;

create or replace function public.list_host_glossary_documents_v1(
  p_host_id text
)
returns table (
  id uuid,
  name text,
  domain text,
  language_a text,
  language_b text,
  version integer,
  active_document_version integer,
  active_document_fingerprint text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  clean_host_id text;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_GLOSSARY_DOCUMENT_INPUT';
  end if;

  return query
  select
    preset_row.id,
    preset_row.name,
    preset_row.domain,
    preset_row.language_a,
    preset_row.language_b,
    preset_row.version,
    preset_row.active_document_version,
    preset_row.active_document_fingerprint,
    preset_row.updated_at
  from public.host_glossary_presets as preset_row
  where preset_row.host_id = clean_host_id
  order by preset_row.updated_at desc, preset_row.id;
end;
$$;

create or replace function public.list_host_glossary_document_versions_v1(
  p_host_id text,
  p_preset_id uuid
)
returns table (
  preset_id uuid,
  version integer,
  document_schema text,
  fingerprint text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  clean_host_id text;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if p_preset_id is null
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_GLOSSARY_DOCUMENT_INPUT';
  end if;

  return query
  select
    version_row.preset_id,
    version_row.version,
    version_row.document_schema,
    version_row.fingerprint,
    version_row.created_at
  from public.host_glossary_preset_versions as version_row
  join public.host_glossary_presets as preset_row
    on preset_row.id = version_row.preset_id
   and preset_row.host_id = clean_host_id
  where version_row.preset_id = p_preset_id
  order by version_row.version desc;
end;
$$;

create or replace function public.read_host_glossary_document_version_v1(
  p_host_id text,
  p_preset_id uuid,
  p_version integer
)
returns table (
  preset_id uuid,
  version integer,
  document_schema text,
  fingerprint text,
  document jsonb,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  clean_host_id text;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if p_preset_id is null
    or p_version is null
    or p_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_GLOSSARY_DOCUMENT_INPUT';
  end if;

  return query
  select
    version_row.preset_id,
    version_row.version,
    version_row.document_schema,
    version_row.fingerprint,
    version_row.document,
    version_row.created_at
  from public.host_glossary_preset_versions as version_row
  join public.host_glossary_presets as preset_row
    on preset_row.id = version_row.preset_id
   and preset_row.host_id = clean_host_id
  where version_row.preset_id = p_preset_id
    and version_row.version = p_version;
end;
$$;

create or replace function public.delete_host_glossary_preset(
  p_id uuid,
  p_host_id text,
  p_expected_version integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_host_id text;
  affected_count integer;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if p_id is null
    or p_expected_version is null
    or p_expected_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_HOST_GLOSSARY_PRESET_INPUT';
  end if;

  delete from public.host_glossary_presets as preset_row
  where preset_row.id = p_id
    and preset_row.host_id = clean_host_id
    and preset_row.version = p_expected_version;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  if affected_count = 0 then
    if exists (
      select 1
      from public.host_glossary_presets as preset_row
      where preset_row.id = p_id
        and preset_row.host_id = clean_host_id
    ) then
      raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_VERSION_CONFLICT';
    end if;
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NOT_FOUND';
  end if;

  return true;
exception
  when foreign_key_violation then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_IN_USE';
end;
$$;

create or replace function public.normalize_live_session_event_text(
  p_value text,
  p_max_length integer
)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  clean_value text;
begin
  clean_value := nullif(normalize(pg_catalog.btrim(coalesce(p_value, '')), NFC), '');
  if clean_value is null then
    return null;
  end if;
  if p_max_length is null
    or p_max_length < 1
    or pg_catalog.char_length(clean_value) > p_max_length
    or clean_value ~ '[[:cntrl:]]'
    or clean_value ~ '[<>]'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_EVENT_INPUT';
  end if;
  return clean_value;
end;
$$;

create or replace function public.normalize_live_session_event_metadata(
  p_value jsonb
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  if p_value is null then
    return '{}'::jsonb;
  end if;
  if jsonb_typeof(p_value) <> 'object'
    or octet_length(p_value::text) > 4096
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_EVENT_INPUT';
  end if;
  return p_value;
end;
$$;

create or replace function public.create_live_session_with_event_v1(
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
  p_expires_at timestamptz,
  p_event_company_name text,
  p_event_reporting_period text,
  p_event_metadata jsonb
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
  expires_at timestamptz,
  event_company_name text,
  event_reporting_period text,
  event_metadata jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  base_session record;
  updated_session public.live_sessions%rowtype;
  clean_event_company_name text;
  clean_event_reporting_period text;
  clean_event_metadata jsonb;
begin
  clean_event_company_name := public.normalize_live_session_event_text(p_event_company_name, 160);
  clean_event_reporting_period := public.normalize_live_session_event_text(p_event_reporting_period, 80);
  clean_event_metadata := public.normalize_live_session_event_metadata(p_event_metadata);

  select * into base_session
  from public.create_live_session(
    p_session_id,
    p_host_id,
    p_session_type,
    p_output_mode,
    p_languages,
    p_max_viewers,
    p_glossary_pack,
    p_voice_provider,
    p_title,
    p_scheduled_at,
    p_expires_at
  );

  update public.live_sessions as session_row
  set event_company_name = clean_event_company_name,
      event_reporting_period = clean_event_reporting_period,
      event_metadata = clean_event_metadata
  where session_row.id = base_session.id
  returning * into updated_session;

  return query select
    updated_session.id,
    updated_session.host_id,
    updated_session.session_type,
    updated_session.output_mode,
    updated_session.status,
    updated_session.languages,
    updated_session.viewer_count,
    updated_session.max_viewers,
    updated_session.version,
    updated_session.glossary_pack,
    updated_session.voice_provider,
    updated_session.title,
    updated_session.scheduled_at,
    updated_session.admission_open_until,
    updated_session.expires_at,
    updated_session.event_company_name,
    updated_session.event_reporting_period,
    updated_session.event_metadata;
end;
$$;

create or replace function public.update_live_session_with_event_v1(
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
  p_scheduled_at timestamptz,
  p_event_company_name text,
  p_event_reporting_period text,
  p_event_metadata jsonb
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
  expires_at timestamptz,
  event_company_name text,
  event_reporting_period text,
  event_metadata jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  base_session record;
  updated_session public.live_sessions%rowtype;
  clean_event_company_name text;
  clean_event_reporting_period text;
  clean_event_metadata jsonb;
begin
  clean_event_company_name := public.normalize_live_session_event_text(p_event_company_name, 160);
  clean_event_reporting_period := public.normalize_live_session_event_text(p_event_reporting_period, 80);
  clean_event_metadata := public.normalize_live_session_event_metadata(p_event_metadata);

  select * into base_session
  from public.update_live_session(
    p_session_id,
    p_host_id,
    p_expected_version,
    p_session_type,
    p_output_mode,
    p_languages,
    p_max_viewers,
    p_glossary_pack,
    p_voice_provider,
    p_title,
    p_scheduled_at
  );

  if not found then
    return;
  end if;

  update public.live_sessions as session_row
  set event_company_name = clean_event_company_name,
      event_reporting_period = clean_event_reporting_period,
      event_metadata = clean_event_metadata
  where session_row.id = base_session.id
  returning * into updated_session;

  return query select
    updated_session.id,
    updated_session.host_id,
    updated_session.session_type,
    updated_session.output_mode,
    updated_session.status,
    updated_session.languages,
    updated_session.viewer_count,
    updated_session.max_viewers,
    updated_session.version,
    updated_session.glossary_pack,
    updated_session.voice_provider,
    updated_session.title,
    updated_session.scheduled_at,
    updated_session.admission_open_until,
    updated_session.expires_at,
    updated_session.event_company_name,
    updated_session.event_reporting_period,
    updated_session.event_metadata;
end;
$$;

create or replace function public.save_host_glossary_document_version_v1(
  p_host_id text,
  p_preset_id uuid,
  p_expected_preset_version integer,
  p_document jsonb,
  p_fingerprint text
)
returns table (
  id uuid,
  preset_id uuid,
  host_id text,
  document_version integer,
  fingerprint text,
  document_schema text,
  preset_version integer,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  clean_fingerprint text;
  preset_row public.host_glossary_presets%rowtype;
  existing_document_version_count integer;
  next_document_version integer;
  created_version public.host_glossary_preset_versions%rowtype;
  affected_count integer;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  clean_fingerprint := pg_catalog.btrim(coalesce(p_fingerprint, ''));

  if p_preset_id is null
    or p_expected_preset_version is null
    or p_expected_preset_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or p_document is null
    or jsonb_typeof(p_document) <> 'object'
    or octet_length(p_document::text) > 5000000
    or clean_fingerprint !~ '^sha256:[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_GLOSSARY_DOCUMENT_INPUT';
  end if;

  select * into preset_row
  from public.host_glossary_presets as preset_row
  where preset_row.id = p_preset_id
    and preset_row.host_id = clean_host_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NOT_FOUND';
  end if;

  if preset_row.version <> p_expected_preset_version then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_VERSION_CONFLICT';
  end if;

  select count(*) into existing_document_version_count
  from public.host_glossary_preset_versions as version_row
  where version_row.preset_id = p_preset_id;

  if existing_document_version_count >= 200 then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_VERSION_LIMIT_REACHED';
  end if;

  select coalesce(max(version), 0) + 1 into next_document_version
  from public.host_glossary_preset_versions as version_row
  where version_row.preset_id = p_preset_id;

  insert into public.host_glossary_preset_versions (
    preset_id, host_id, version, document, fingerprint
  ) values (
    p_preset_id, clean_host_id, next_document_version, p_document, clean_fingerprint
  )
  returning * into created_version;

  update public.host_glossary_presets as preset_row
  set version = preset_row.version + 1,
      updated_at = statement_timestamp()
  where preset_row.id = p_preset_id
    and preset_row.host_id = clean_host_id
    and preset_row.version = p_expected_preset_version;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  if affected_count = 0 then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_VERSION_CONFLICT';
  end if;

  return query select
    created_version.id,
    created_version.preset_id,
    created_version.host_id,
    created_version.version as document_version,
    created_version.fingerprint,
    created_version.document_schema,
    p_expected_preset_version + 1 as preset_version,
    created_version.created_at;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_DOCUMENT_FINGERPRINT_CONFLICT';
end;
$$;

create or replace function public.activate_host_glossary_document_version_v1(
  p_host_id text,
  p_preset_id uuid,
  p_expected_preset_version integer,
  p_document_version integer
)
returns table (
  preset_id uuid,
  host_id text,
  version integer,
  active_document_version integer,
  active_document_fingerprint text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  version_row public.host_glossary_preset_versions%rowtype;
  updated_preset public.host_glossary_presets%rowtype;
  affected_count integer;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if p_preset_id is null
    or p_expected_preset_version is null
    or p_expected_preset_version < 1
    or p_document_version is null
    or p_document_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_GLOSSARY_DOCUMENT_INPUT';
  end if;

  select * into version_row
  from public.host_glossary_preset_versions as version_row
  where version_row.preset_id = p_preset_id
    and version_row.host_id = clean_host_id
    and version_row.version = p_document_version;

  if not found then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_DOCUMENT_VERSION_NOT_FOUND';
  end if;

  update public.host_glossary_presets as preset_row
  set active_document_version = version_row.version,
      active_document_fingerprint = version_row.fingerprint,
      version = preset_row.version + 1,
      updated_at = statement_timestamp()
  where preset_row.id = p_preset_id
    and preset_row.host_id = clean_host_id
    and preset_row.version = p_expected_preset_version
  returning * into updated_preset;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  if affected_count = 0 then
    if exists (
      select 1
      from public.host_glossary_presets as preset_row
      where preset_row.id = p_preset_id
        and preset_row.host_id = clean_host_id
    ) then
      raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_VERSION_CONFLICT';
    end if;
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NOT_FOUND';
  end if;

  return query select
    updated_preset.id as preset_id,
    updated_preset.host_id,
    updated_preset.version,
    updated_preset.active_document_version,
    updated_preset.active_document_fingerprint,
    updated_preset.updated_at;
end;
$$;

create or replace function public.pin_live_session_glossary_version_v1(
  p_session_id uuid,
  p_host_id text,
  p_expected_session_version integer,
  p_preset_id uuid,
  p_document_version integer
)
returns table (
  session_id uuid,
  version integer,
  pinned_glossary_preset_id uuid,
  pinned_glossary_version integer,
  pinned_glossary_fingerprint text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  session_row public.live_sessions%rowtype;
  version_row public.host_glossary_preset_versions%rowtype;
  updated_session public.live_sessions%rowtype;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if p_session_id is null
    or p_expected_session_version is null
    or p_expected_session_version < 1
    or p_preset_id is null
    or p_document_version is null
    or p_document_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
  end if;

  select * into session_row
  from public.live_sessions as session_row
  where session_row.id = p_session_id
    and session_row.host_id = clean_host_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_NOT_FOUND';
  end if;

  if session_row.version <> p_expected_session_version then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_VERSION_CONFLICT';
  end if;

  if session_row.status <> 'preparing' then
    raise exception using errcode = 'P0001', message = 'ACTIVE_SESSION_GLOSSARY_IMMUTABLE';
  end if;

  select * into version_row
  from public.host_glossary_preset_versions as version_row
  where version_row.host_id = clean_host_id
    and version_row.preset_id = p_preset_id
    and version_row.version = p_document_version;

  if not found then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_DOCUMENT_VERSION_NOT_FOUND';
  end if;

  update public.live_sessions as session_row
  set pinned_glossary_preset_id = p_preset_id,
      pinned_glossary_version = version_row.version,
      pinned_glossary_fingerprint = version_row.fingerprint,
      version = session_row.version + 1,
      updated_at = statement_timestamp()
  where session_row.id = p_session_id
    and session_row.host_id = clean_host_id
    and session_row.version = p_expected_session_version
  returning * into updated_session;

  return query select
    updated_session.id as session_id,
    updated_session.version,
    updated_session.pinned_glossary_preset_id,
    updated_session.pinned_glossary_version,
    updated_session.pinned_glossary_fingerprint,
    updated_session.updated_at;
end;
$$;

create or replace function public.read_live_session_pinned_glossary_v1(
  p_session_id uuid
)
returns table (
  session_id uuid,
  preset_id uuid,
  version integer,
  document_schema text,
  fingerprint text,
  document jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
  matched_count integer;
begin
  if p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_PINNED_GLOSSARY_INPUT';
  end if;

  select * into session_row
  from public.live_sessions as session_row
  where session_row.id = p_session_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_NOT_FOUND';
  end if;

  if session_row.pinned_glossary_preset_id is null
    and session_row.pinned_glossary_version is null
    and session_row.pinned_glossary_fingerprint is null
  then
    return;
  end if;

  if session_row.pinned_glossary_preset_id is null
    or session_row.pinned_glossary_version is null
    or session_row.pinned_glossary_fingerprint is null
    or session_row.pinned_glossary_fingerprint !~ '^sha256:[0-9a-f]{64}$'
  then
    raise exception using errcode = 'P0001', message = 'PINNED_GLOSSARY_VERSION_MISMATCH';
  end if;

  select count(*)::integer into matched_count
  from public.live_sessions as session_row
  join public.host_glossary_presets as preset_row
    on preset_row.id = session_row.pinned_glossary_preset_id
   and preset_row.host_id = session_row.host_id
  join public.host_glossary_preset_versions as version_row
    on version_row.preset_id = session_row.pinned_glossary_preset_id
   and version_row.host_id = session_row.host_id
   and version_row.version = session_row.pinned_glossary_version
   and version_row.fingerprint = session_row.pinned_glossary_fingerprint
  where session_row.id = p_session_id;

  if matched_count <> 1 then
    raise exception using errcode = 'P0001', message = 'PINNED_GLOSSARY_VERSION_MISMATCH';
  end if;

  return query select
    session_row.id as session_id,
    version_row.preset_id,
    version_row.version,
    version_row.document_schema,
    version_row.fingerprint,
    version_row.document
  from public.live_sessions as session_row
  join public.host_glossary_presets as preset_row
    on preset_row.id = session_row.pinned_glossary_preset_id
   and preset_row.host_id = session_row.host_id
  join public.host_glossary_preset_versions as version_row
    on version_row.preset_id = session_row.pinned_glossary_preset_id
   and version_row.host_id = session_row.host_id
   and version_row.version = session_row.pinned_glossary_version
   and version_row.fingerprint = session_row.pinned_glossary_fingerprint
  where session_row.id = p_session_id;
end;
$$;

create or replace function public.transition_live_session_section_v1(
  p_session_id uuid,
  p_host_id text,
  p_expected_session_version integer,
  p_transition_key text,
  p_section_key text,
  p_source_seq bigint
)
returns table (
  session_id uuid,
  section_id uuid,
  section_key text,
  status text,
  ordinal integer,
  version integer,
  started_at timestamptz,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
  clean_transition_key text;
  clean_section_key text;
  session_row public.live_sessions%rowtype;
  existing_section public.live_session_sections%rowtype;
  inserted_section public.live_session_sections%rowtype;
  next_ordinal integer;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  clean_transition_key := normalize(pg_catalog.btrim(coalesce(p_transition_key, '')), NFC);
  clean_section_key := pg_catalog.btrim(coalesce(p_section_key, ''));

  if p_session_id is null
    or p_expected_session_version is null
    or p_expected_session_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_transition_key) not between 1 and 256
    or clean_transition_key ~ '[[:cntrl:]]'
    or clean_transition_key ~ '[<>]'
    or clean_section_key not in ('prepared_remarks', 'qa', 'other')
    or (p_source_seq is not null and p_source_seq < 0)
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_SECTION_INPUT';
  end if;

  select * into session_row
  from public.live_sessions as session_row
  where session_row.id = p_session_id
    and session_row.host_id = clean_host_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_NOT_FOUND';
  end if;

  select * into existing_section
  from public.live_session_sections as existing_section
  where existing_section.session_id = p_session_id
    and existing_section.transition_key = clean_transition_key;

  if found then
    return query select
      existing_section.session_id,
      existing_section.id as section_id,
      existing_section.section_key,
      existing_section.status,
      existing_section.ordinal,
      existing_section.version,
      existing_section.started_at,
      existing_section.completed_at;
    return;
  end if;

  if session_row.version <> p_expected_session_version then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_SECTION_VERSION_CONFLICT';
  end if;

  select coalesce(max(section_row.ordinal), 0) + 1 into next_ordinal
  from public.live_session_sections as section_row
  where section_row.session_id = p_session_id;

  if next_ordinal > 100 then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_SECTION_LIMIT_REACHED';
  end if;

  update public.live_session_sections as section_row
  set status = 'completed',
      completed_at = coalesce(section_row.completed_at, statement_timestamp()),
      version = section_row.version + 1,
      updated_at = statement_timestamp()
  where section_row.session_id = p_session_id
    and section_row.status = 'active';

  insert into public.live_session_sections (
    session_id, section_key, transition_key, source_seq, ordinal
  ) values (
    p_session_id, clean_section_key, clean_transition_key, p_source_seq, next_ordinal
  )
  returning * into inserted_section;

  update public.live_sessions as session_row
  set version = session_row.version + 1,
      updated_at = statement_timestamp()
  where session_row.id = p_session_id
    and session_row.host_id = clean_host_id
    and session_row.version = p_expected_session_version;

  return query select
    inserted_section.session_id,
    inserted_section.id as section_id,
    inserted_section.section_key,
    inserted_section.status,
    inserted_section.ordinal,
    inserted_section.version,
    inserted_section.started_at,
    inserted_section.completed_at;
end;
$$;

create or replace function public.read_live_session_event_context_v1(
  p_session_id uuid
)
returns table (
  session_id uuid,
  event_company_name text,
  event_reporting_period text,
  event_metadata jsonb,
  active_section_key text,
  sections jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_SESSION_EVENT_CONTEXT_INPUT';
  end if;

  return query
  with section_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', section_row.id,
          'session_id', section_row.session_id,
          'section_key', section_row.section_key,
          'status', section_row.status,
          'ordinal', section_row.ordinal,
          'started_at', section_row.started_at,
          'completed_at', section_row.completed_at,
          'version', section_row.version
        )
        order by section_row.ordinal
      ),
      '[]'::jsonb
    ) as sections
    from public.live_session_sections as section_row
    where section_row.session_id = p_session_id
  )
  select
    session_row.id as session_id,
    session_row.event_company_name,
    session_row.event_reporting_period,
    session_row.event_metadata,
    active_section.section_key as active_section_key,
    section_payload.sections
  from public.live_sessions as session_row
  cross join section_payload
  left join public.live_session_sections as active_section
    on active_section.session_id = session_row.id
   and active_section.status = 'active'
  where session_row.id = p_session_id;
end;
$$;

create or replace function public.cleanup_expired_live_glossary_documents()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleared_session_pins integer := 0;
  deleted_document_versions integer := 0;
  deleted_sections integer := 0;
begin
  update public.live_sessions as session_row
  set pinned_glossary_preset_id = null,
      pinned_glossary_version = null,
      pinned_glossary_fingerprint = null,
      updated_at = statement_timestamp()
  where session_row.pinned_glossary_preset_id is not null
    and coalesce(session_row.ended_at, session_row.expires_at, session_row.updated_at, session_row.created_at)
      < statement_timestamp() - interval '30 days';

  GET DIAGNOSTICS cleared_session_pins = ROW_COUNT;

  delete from public.host_glossary_preset_versions as version_row
  using public.host_glossary_presets as preset_row
  where version_row.preset_id = preset_row.id
    and version_row.created_at < statement_timestamp() - interval '30 days'
    and (
      preset_row.active_document_version is distinct from version_row.version
      or preset_row.active_document_fingerprint is distinct from version_row.fingerprint
    )
    and not exists (
      select 1
      from public.live_sessions as pinned_session
      where pinned_session.pinned_glossary_preset_id = version_row.preset_id
        and pinned_session.pinned_glossary_version = version_row.version
        and pinned_session.pinned_glossary_fingerprint = version_row.fingerprint
    );

  GET DIAGNOSTICS deleted_document_versions = ROW_COUNT;

  delete from public.live_session_sections as section_row
  using public.live_sessions as session_row
  where section_row.session_id = session_row.id
    and coalesce(session_row.ended_at, session_row.updated_at, session_row.created_at)
      < statement_timestamp() - interval '30 days';

  GET DIAGNOSTICS deleted_sections = ROW_COUNT;

  return cleared_session_pins + deleted_document_versions + deleted_sections;
end;
$$;

revoke all on function public.create_host_glossary_document_preset_v1(text, text, text, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.list_host_glossary_documents_v1(text)
  from public, anon, authenticated;
revoke all on function public.list_host_glossary_document_versions_v1(text, uuid)
  from public, anon, authenticated;
revoke all on function public.read_host_glossary_document_version_v1(text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.delete_host_glossary_preset(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.normalize_live_session_event_text(text, integer)
  from public, anon, authenticated;
revoke all on function public.normalize_live_session_event_metadata(jsonb)
  from public, anon, authenticated;
revoke all on function public.create_live_session_with_event_v1(uuid, text, text, text, text[], integer, text, text, text, timestamptz, timestamptz, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.update_live_session_with_event_v1(uuid, text, integer, text, text, text[], integer, text, text, text, timestamptz, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.save_host_glossary_document_version_v1(text, uuid, integer, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.activate_host_glossary_document_version_v1(text, uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.pin_live_session_glossary_version_v1(uuid, text, integer, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.read_live_session_pinned_glossary_v1(uuid)
  from public, anon, authenticated;
revoke all on function public.transition_live_session_section_v1(uuid, text, integer, text, text, bigint)
  from public, anon, authenticated;
revoke all on function public.read_live_session_event_context_v1(uuid)
  from public, anon, authenticated;
revoke all on function public.cleanup_expired_live_glossary_documents()
  from public, anon, authenticated;

grant execute on function public.create_host_glossary_document_preset_v1(text, text, text, text, text, jsonb, text)
  to service_role;
grant execute on function public.list_host_glossary_documents_v1(text)
  to service_role;
grant execute on function public.list_host_glossary_document_versions_v1(text, uuid)
  to service_role;
grant execute on function public.read_host_glossary_document_version_v1(text, uuid, integer)
  to service_role;
grant execute on function public.delete_host_glossary_preset(uuid, text, integer)
  to service_role;
grant execute on function public.normalize_live_session_event_text(text, integer)
  to service_role;
grant execute on function public.normalize_live_session_event_metadata(jsonb)
  to service_role;
grant execute on function public.create_live_session_with_event_v1(uuid, text, text, text, text[], integer, text, text, text, timestamptz, timestamptz, text, text, jsonb)
  to service_role;
grant execute on function public.update_live_session_with_event_v1(uuid, text, integer, text, text, text[], integer, text, text, text, timestamptz, text, text, jsonb)
  to service_role;
grant execute on function public.save_host_glossary_document_version_v1(text, uuid, integer, jsonb, text)
  to service_role;
grant execute on function public.activate_host_glossary_document_version_v1(text, uuid, integer, integer)
  to service_role;
grant execute on function public.pin_live_session_glossary_version_v1(uuid, text, integer, uuid, integer)
  to service_role;
grant execute on function public.read_live_session_pinned_glossary_v1(uuid)
  to service_role;
grant execute on function public.transition_live_session_section_v1(uuid, text, integer, text, text, bigint)
  to service_role;
grant execute on function public.read_live_session_event_context_v1(uuid)
  to service_role;
grant execute on function public.cleanup_expired_live_glossary_documents()
  to service_role;

do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_namespace
    where nspname = 'cron'
  ) then
    perform cron.schedule(
      'realtime-noel-live-glossary-document-cleanup',
      '23 19 * * *',
      'select public.cleanup_expired_live_glossary_documents();'
    );
  end if;
end;
$$;
