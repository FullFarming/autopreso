-- 2026-08-27 feat: Pin up to five ordered built-in or host glossaries to a
-- preparing Live session. The legacy singular columns stay readable for one
-- deprecation cycle and are populated when a single host glossary is chosen.

create table public.live_session_glossary_pins (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  ordinal integer not null,
  source_kind text not null,
  builtin_id text,
  builtin_catalog_version integer,
  host_preset_id uuid references public.host_glossary_presets(id) on delete restrict,
  host_document_version integer,
  host_document_fingerprint text,
  created_at timestamptz not null default statement_timestamp(),
  primary key (session_id, ordinal),
  constraint live_session_glossary_pins_ordinal_check check (ordinal between 1 and 5),
  constraint live_session_glossary_pins_source_kind_check check (source_kind in ('builtin', 'host')),
  constraint live_session_glossary_pins_source_shape_check check (
    (
      source_kind = 'builtin'
      and builtin_id in (
        'common_business', 'ai_ax', 'commercial_real_estate', 'hospitality',
        'fnb_retail', 'proper_nouns', 'ko_ja_idioms'
      )
      and builtin_catalog_version = 1
      and host_preset_id is null
      and host_document_version is null
      and host_document_fingerprint is null
    )
    or
    (
      source_kind = 'host'
      and builtin_id is null
      and builtin_catalog_version is null
      and host_preset_id is not null
      and host_document_version >= 1
      and host_document_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    )
  )
);

create unique index live_session_glossary_pins_builtin_unique
  on public.live_session_glossary_pins (session_id, builtin_id)
  where source_kind = 'builtin';

create unique index live_session_glossary_pins_host_unique
  on public.live_session_glossary_pins (session_id, host_preset_id)
  where source_kind = 'host';

alter table public.live_session_glossary_pins enable row level security;

revoke all on table public.live_session_glossary_pins
  from public, anon, authenticated, service_role;

create or replace function public.replace_live_session_glossary_pins_v2(
  p_session_id uuid,
  p_host_id text,
  p_expected_session_version integer,
  p_glossaries jsonb
)
returns table (
  session_id uuid,
  version integer,
  glossaries jsonb,
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
  updated_session public.live_sessions%rowtype;
  glossary_item jsonb;
  source_kind_value text;
  source_id_value text;
  document_version_value integer;
  selected_version public.host_glossary_preset_versions%rowtype;
  seen_sources text[] := array[]::text[];
  source_key text;
  glossary_count integer;
  glossary_ordinal integer;
  legacy_preset_id uuid;
  legacy_document_version integer;
  legacy_fingerprint text;
begin
  clean_host_id := pg_catalog.btrim(pg_catalog.coalesce(p_host_id, ''));
  if p_session_id is null
    or p_expected_session_version is null
    or p_expected_session_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or p_glossaries is null
    or pg_catalog.jsonb_typeof(p_glossaries) <> 'array'
    or pg_catalog.jsonb_array_length(p_glossaries) not between 1 and 5
  then
    raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
  end if;

  select * into session_row
  from public.live_sessions as candidate_session
  where candidate_session.id = p_session_id
    and candidate_session.host_id = clean_host_id
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

  delete from public.live_session_glossary_pins as existing_pin
  where existing_pin.session_id = p_session_id;

  glossary_count := pg_catalog.jsonb_array_length(p_glossaries);
  for glossary_ordinal in 1..glossary_count loop
    glossary_item := p_glossaries -> (glossary_ordinal - 1);
    if pg_catalog.jsonb_typeof(glossary_item) <> 'object'
      or glossary_item - array['source_kind', 'source_id', 'document_version'] <> '{}'::jsonb
      or not (glossary_item ?& array['source_kind', 'source_id', 'document_version'])
      or pg_catalog.jsonb_typeof(glossary_item -> 'source_kind') <> 'string'
      or pg_catalog.jsonb_typeof(glossary_item -> 'source_id') <> 'string'
      or pg_catalog.jsonb_typeof(glossary_item -> 'document_version') <> 'number'
      or (glossary_item ->> 'document_version') !~ '^[1-9][0-9]{0,9}$'
    then
      raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
    end if;

    source_kind_value := glossary_item ->> 'source_kind';
    source_id_value := glossary_item ->> 'source_id';
    if (glossary_item ->> 'document_version')::bigint > 2147483647 then
      raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
    end if;
    document_version_value := (glossary_item ->> 'document_version')::integer;
    source_key := source_kind_value || ':' || case
      when source_kind_value = 'host' then pg_catalog.lower(source_id_value)
      else source_id_value
    end;
    if source_key = any(seen_sources) then
      raise exception using errcode = '22023', message = 'DUPLICATE_LIVE_GLOSSARY_PIN';
    end if;
    seen_sources := pg_catalog.array_append(seen_sources, source_key);

    if source_kind_value = 'builtin' then
      if source_id_value not in (
        'common_business', 'ai_ax', 'commercial_real_estate', 'hospitality',
        'fnb_retail', 'proper_nouns', 'ko_ja_idioms'
      ) or document_version_value <> 1 then
        raise exception using errcode = '22023', message = 'INVALID_BUILTIN_GLOSSARY';
      end if;
      insert into public.live_session_glossary_pins (
        session_id, ordinal, source_kind, builtin_id, builtin_catalog_version
      ) values (
        p_session_id, glossary_ordinal, 'builtin', source_id_value, 1
      );
    elsif source_kind_value = 'host' then
      if source_id_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
      end if;
      select version_row.* into selected_version
      from public.host_glossary_presets as preset_row
      join public.host_glossary_preset_versions as version_row
        on version_row.preset_id = preset_row.id
       and version_row.host_id = preset_row.host_id
       and version_row.version = preset_row.active_document_version
       and version_row.fingerprint = preset_row.active_document_fingerprint
      where preset_row.id = source_id_value::uuid
        and preset_row.host_id = clean_host_id
        and preset_row.active_document_version = document_version_value;
      if not found then
        raise exception using errcode = 'P0001', message = 'ACTIVE_GLOSSARY_DOCUMENT_VERSION_NOT_FOUND';
      end if;
      insert into public.live_session_glossary_pins (
        session_id, ordinal, source_kind, host_preset_id,
        host_document_version, host_document_fingerprint
      ) values (
        p_session_id, glossary_ordinal, 'host', source_id_value::uuid,
        selected_version.version, selected_version.fingerprint
      );
      if glossary_count = 1 then
        legacy_preset_id := source_id_value::uuid;
        legacy_document_version := selected_version.version;
        legacy_fingerprint := selected_version.fingerprint;
      end if;
    else
      raise exception using errcode = '22023', message = 'INVALID_LIVE_GLOSSARY_PIN_INPUT';
    end if;
  end loop;

  update public.live_sessions as target_session
  set pinned_glossary_preset_id = legacy_preset_id,
      pinned_glossary_version = legacy_document_version,
      pinned_glossary_fingerprint = legacy_fingerprint,
      version = target_session.version + 1,
      updated_at = statement_timestamp()
  where target_session.id = p_session_id
    and target_session.host_id = clean_host_id
    and target_session.version = p_expected_session_version
  returning target_session.* into updated_session;

  return query
  select
    updated_session.id,
    updated_session.version,
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ordinal', pin_row.ordinal,
        'source_kind', pin_row.source_kind,
        'source_id', pg_catalog.coalesce(pin_row.builtin_id, pin_row.host_preset_id::text),
        'document_version', pg_catalog.coalesce(pin_row.builtin_catalog_version, pin_row.host_document_version),
        'fingerprint', pin_row.host_document_fingerprint
      ) order by pin_row.ordinal
    ),
    updated_session.updated_at
  from public.live_session_glossary_pins as pin_row
  where pin_row.session_id = p_session_id;
end;
$$;

create or replace function public.read_live_session_pinned_glossaries_v2(
  p_live_session_id uuid
)
returns table (
  session_id uuid,
  ordinal integer,
  source_kind text,
  source_id text,
  document_version integer,
  fingerprint text,
  glossary_document jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  session_row public.live_sessions%rowtype;
  pin_count integer;
  valid_host_pin_count integer;
begin
  if p_live_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_PINNED_GLOSSARY_INPUT';
  end if;
  select * into session_row
  from public.live_sessions as candidate_session
  where candidate_session.id = p_live_session_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'LIVE_SESSION_NOT_FOUND';
  end if;

  select count(*)::integer into pin_count
  from public.live_session_glossary_pins as pin_row
  where pin_row.session_id = p_live_session_id;

  if pin_count > 0 then
    select count(*)::integer into valid_host_pin_count
    from public.live_session_glossary_pins as pin_row
    left join public.host_glossary_preset_versions as version_row
      on version_row.preset_id = pin_row.host_preset_id
     and version_row.version = pin_row.host_document_version
     and version_row.fingerprint = pin_row.host_document_fingerprint
     and version_row.host_id = session_row.host_id
    where pin_row.session_id = p_live_session_id
      and (pin_row.source_kind = 'builtin' or version_row.id is not null);
    if valid_host_pin_count <> pin_count then
      raise exception using errcode = 'P0001', message = 'PINNED_GLOSSARY_VERSION_MISMATCH';
    end if;

    return query
    select
      pin_row.session_id,
      pin_row.ordinal,
      pin_row.source_kind,
      pg_catalog.coalesce(pin_row.builtin_id, pin_row.host_preset_id::text),
      pg_catalog.coalesce(pin_row.builtin_catalog_version, pin_row.host_document_version),
      pin_row.host_document_fingerprint,
      version_row.document
    from public.live_session_glossary_pins as pin_row
    left join public.host_glossary_preset_versions as version_row
      on version_row.preset_id = pin_row.host_preset_id
     and version_row.version = pin_row.host_document_version
     and version_row.fingerprint = pin_row.host_document_fingerprint
     and version_row.host_id = session_row.host_id
    where pin_row.session_id = p_live_session_id
    order by pin_row.ordinal;
    return;
  end if;

  -- Legacy singular fallback remains until its columns complete a deprecation cycle.
  if session_row.pinned_glossary_preset_id is not null
    and session_row.pinned_glossary_version is not null
    and session_row.pinned_glossary_fingerprint is not null
  then
    return query
    select
      session_row.id,
      1,
      'host'::text,
      session_row.pinned_glossary_preset_id::text,
      session_row.pinned_glossary_version,
      session_row.pinned_glossary_fingerprint,
      version_row.document
    from public.host_glossary_preset_versions as version_row
    where version_row.preset_id = session_row.pinned_glossary_preset_id
      and version_row.version = session_row.pinned_glossary_version
      and version_row.fingerprint = session_row.pinned_glossary_fingerprint
      and version_row.host_id = session_row.host_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'PINNED_GLOSSARY_VERSION_MISMATCH';
    end if;
  end if;
end;
$$;

revoke all on function public.replace_live_session_glossary_pins_v2(uuid, text, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.read_live_session_pinned_glossaries_v2(uuid)
  from public, anon, authenticated;

grant execute on function public.replace_live_session_glossary_pins_v2(uuid, text, integer, jsonb)
  to service_role;
grant execute on function public.read_live_session_pinned_glossaries_v2(uuid)
  to service_role;
