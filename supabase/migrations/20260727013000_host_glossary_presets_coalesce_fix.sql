-- 2026-07-27 fix: COALESCE is SQL syntax, not a pg_catalog function. Recreate
-- the four already-deployed glossary RPCs without changing their signatures,
-- ownership predicates, concurrency controls, or least-privilege grants.

create or replace function public.list_host_glossary_presets(
  p_host_id text
)
returns table (
  id uuid,
  name text,
  domain text,
  glossary text,
  language_a text,
  language_b text,
  version integer,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  clean_host_id text;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  if pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_HOST_GLOSSARY_PRESET_INPUT';
  end if;

  return query
  select
    preset_row.id,
    preset_row.name,
    preset_row.domain,
    preset_row.glossary,
    preset_row.language_a,
    preset_row.language_b,
    preset_row.version,
    preset_row.updated_at
  from public.host_glossary_presets as preset_row
  where preset_row.host_id = clean_host_id
  order by preset_row.updated_at desc, preset_row.id;
end;
$$;

create or replace function public.create_host_glossary_preset(
  p_host_id text,
  p_name text,
  p_domain text,
  p_glossary text,
  p_language_a text,
  p_language_b text
)
returns table (
  id uuid,
  name text,
  domain text,
  glossary text,
  language_a text,
  language_b text,
  version integer,
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
  clean_glossary text;
  clean_language_a text;
  clean_language_b text;
  preset_count integer;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  clean_name := pg_catalog.btrim(coalesce(p_name, ''));
  clean_domain := pg_catalog.btrim(coalesce(p_domain, ''));
  clean_glossary := pg_catalog.btrim(coalesce(p_glossary, ''));
  clean_language_a := pg_catalog.btrim(coalesce(p_language_a, ''));
  clean_language_b := pg_catalog.btrim(coalesce(p_language_b, ''));

  if pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_name) not between 1 and 80
    or clean_name ~ '[[:cntrl:]]'
    or clean_name ~ '[<>]'
    or pg_catalog.char_length(clean_domain) > 600
    or clean_domain ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_glossary) not between 1 and 16000
    or pg_catalog.translate(clean_glossary, E'\n\r\t', '') ~ '[[:cntrl:]]'
    or public.live_language_valid(clean_language_a) is not true
    or public.live_language_valid(clean_language_b) is not true
    or clean_language_a = clean_language_b
  then
    raise exception using errcode = '22023', message = 'INVALID_HOST_GLOSSARY_PRESET_INPUT';
  end if;

  -- A host-scoped transaction lock makes count + insert one capacity decision.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(clean_host_id, 0));

  select count(*) into preset_count
  from public.host_glossary_presets as preset_row
  where preset_row.host_id = clean_host_id;

  if preset_count >= 50 then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_LIMIT_REACHED';
  end if;

  return query
  insert into public.host_glossary_presets as preset_row (
    host_id, name, domain, glossary, language_a, language_b
  ) values (
    clean_host_id, clean_name, clean_domain, clean_glossary,
    clean_language_a, clean_language_b
  )
  returning
    preset_row.id,
    preset_row.name,
    preset_row.domain,
    preset_row.glossary,
    preset_row.language_a,
    preset_row.language_b,
    preset_row.version,
    preset_row.updated_at;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NAME_CONFLICT';
end;
$$;

create or replace function public.update_host_glossary_preset(
  p_id uuid,
  p_host_id text,
  p_expected_version integer,
  p_name text,
  p_domain text,
  p_glossary text,
  p_language_a text,
  p_language_b text
)
returns table (
  id uuid,
  name text,
  domain text,
  glossary text,
  language_a text,
  language_b text,
  version integer,
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
  clean_glossary text;
  clean_language_a text;
  clean_language_b text;
  affected_count integer;
  updated_preset public.host_glossary_presets%rowtype;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  clean_name := pg_catalog.btrim(coalesce(p_name, ''));
  clean_domain := pg_catalog.btrim(coalesce(p_domain, ''));
  clean_glossary := pg_catalog.btrim(coalesce(p_glossary, ''));
  clean_language_a := pg_catalog.btrim(coalesce(p_language_a, ''));
  clean_language_b := pg_catalog.btrim(coalesce(p_language_b, ''));

  if p_id is null
    or p_expected_version is null
    or p_expected_version < 1
    or pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_name) not between 1 and 80
    or clean_name ~ '[[:cntrl:]]'
    or clean_name ~ '[<>]'
    or pg_catalog.char_length(clean_domain) > 600
    or clean_domain ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_glossary) not between 1 and 16000
    or pg_catalog.translate(clean_glossary, E'\n\r\t', '') ~ '[[:cntrl:]]'
    or public.live_language_valid(clean_language_a) is not true
    or public.live_language_valid(clean_language_b) is not true
    or clean_language_a = clean_language_b
  then
    raise exception using errcode = '22023', message = 'INVALID_HOST_GLOSSARY_PRESET_INPUT';
  end if;

  update public.host_glossary_presets as preset_row
  set name = clean_name,
      domain = clean_domain,
      glossary = clean_glossary,
      language_a = clean_language_a,
      language_b = clean_language_b,
      version = preset_row.version + 1,
      updated_at = statement_timestamp()
  where preset_row.id = p_id
    and preset_row.host_id = clean_host_id
    and preset_row.version = p_expected_version
  returning preset_row.* into updated_preset;

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

  return query select
    updated_preset.id,
    updated_preset.name,
    updated_preset.domain,
    updated_preset.glossary,
    updated_preset.language_a,
    updated_preset.language_b,
    updated_preset.version,
    updated_preset.updated_at;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NAME_CONFLICT';
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
end;
$$;

revoke all on function public.list_host_glossary_presets(text)
  from public, anon, authenticated;
revoke all on function public.create_host_glossary_preset(text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.update_host_glossary_preset(uuid, text, integer, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.delete_host_glossary_preset(uuid, text, integer)
  from public, anon, authenticated;

grant execute on function public.list_host_glossary_presets(text)
  to service_role;
grant execute on function public.create_host_glossary_preset(text, text, text, text, text, text)
  to service_role;
grant execute on function public.update_host_glossary_preset(uuid, text, integer, text, text, text, text, text)
  to service_role;
grant execute on function public.delete_host_glossary_preset(uuid, text, integer)
  to service_role;

-- Verification (run after applying to a development project only):
-- select * from public.list_host_glossary_presets('host-1');
-- Expected: zero or more rows, never SQLSTATE 42883 for pg_catalog.coalesce.
