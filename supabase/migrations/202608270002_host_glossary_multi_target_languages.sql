-- Host glossary presets: persist the FULL target-language list of the active
-- document instead of collapsing it to language_b. language_b stays the first
-- target so every v1 consumer (desktop sync, legacy RPCs) keeps a coherent
-- language pair, while v2 consumers read target_languages for compatibility
-- decisions (session checklist gating, language tags).

-- 1. Column + backfill --------------------------------------------------------

alter table public.host_glossary_presets
  add column if not exists target_languages text[] not null default '{}'::text[];

update public.host_glossary_presets
set target_languages = array[language_b]
where pg_catalog.cardinality(target_languages) = 0;

-- 2. Validation helper --------------------------------------------------------

create or replace function public.live_target_languages_valid(p_targets text[], p_source text)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select
    cardinality(p_targets) between 1 and 13
    and cardinality(p_targets) = (
      select count(distinct requested.language_code)
      from unnest(p_targets) as requested(language_code)
    )
    and not exists (
      select 1
      from unnest(p_targets) as requested(language_code)
      where public.live_language_valid(requested.language_code) is not true
        or requested.language_code = p_source
    );
$$;

revoke all on function public.live_target_languages_valid(text[], text)
  from public, anon, authenticated;

-- 3. Bounded check + legacy-write consistency trigger -------------------------
-- Legacy RPCs (v1 document create, flat create/update) never mention
-- target_languages; the trigger derives array[language_b] for those writers so
-- the column can never go stale or empty.

alter table public.host_glossary_presets
  drop constraint if exists host_glossary_presets_target_languages_bounded;

alter table public.host_glossary_presets
  add constraint host_glossary_presets_target_languages_bounded
  check (pg_catalog.cardinality(target_languages) between 1 and 13);

create or replace function public.host_glossary_presets_sync_target_languages()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.target_languages is null or pg_catalog.cardinality(new.target_languages) = 0 then
    new.target_languages := array[new.language_b];
  end if;
  if new.target_languages[1] <> new.language_b then
    new.language_b := new.target_languages[1];
  end if;
  return new;
end;
$$;

drop trigger if exists host_glossary_presets_sync_target_languages on public.host_glossary_presets;

create trigger host_glossary_presets_sync_target_languages
before insert or update on public.host_glossary_presets
for each row execute function public.host_glossary_presets_sync_target_languages();

-- 4. v2 create: accepts the full target list ----------------------------------

create or replace function public.create_host_glossary_document_preset_v2(
  p_host_id text,
  p_name text,
  p_domain text,
  p_language_a text,
  p_target_languages text[],
  p_document jsonb,
  p_fingerprint text
)
returns table (
  id uuid,
  name text,
  domain text,
  language_a text,
  language_b text,
  target_languages text[],
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
  clean_fingerprint text;
  preset_count integer;
  created_preset public.host_glossary_presets%rowtype;
begin
  clean_host_id := pg_catalog.btrim(coalesce(p_host_id, ''));
  clean_name := pg_catalog.btrim(coalesce(p_name, ''));
  clean_domain := pg_catalog.btrim(coalesce(p_domain, ''));
  clean_language_a := pg_catalog.btrim(coalesce(p_language_a, ''));
  clean_fingerprint := pg_catalog.btrim(coalesce(p_fingerprint, ''));

  if pg_catalog.char_length(clean_host_id) not between 1 and 100
    or clean_host_id ~ '[[:cntrl:]]'
    or pg_catalog.char_length(clean_name) not between 1 and 80
    or clean_name ~ '[[:cntrl:]]'
    or clean_name ~ '[<>]'
    or pg_catalog.char_length(clean_domain) > 600
    or clean_domain ~ '[[:cntrl:]]'
    or public.live_language_valid(clean_language_a) is not true
    or p_target_languages is null
    or public.live_target_languages_valid(p_target_languages, clean_language_a) is not true
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
    target_languages,
    active_document_version,
    active_document_fingerprint
  ) values (
    clean_host_id,
    clean_name,
    clean_domain,
    'Document glossary',
    clean_language_a,
    p_target_languages[1],
    p_target_languages,
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
    created_preset.target_languages,
    created_preset.version,
    created_preset.active_document_version,
    created_preset.active_document_fingerprint,
    created_preset.updated_at;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'GLOSSARY_PRESET_NAME_CONFLICT';
end;
$$;

revoke all on function public.create_host_glossary_document_preset_v2(text, text, text, text, text[], jsonb, text)
  from public, anon, authenticated;

-- 5. v2 list: exposes the full target list ------------------------------------

create or replace function public.list_host_glossary_documents_v2(
  p_host_id text
)
returns table (
  id uuid,
  name text,
  domain text,
  language_a text,
  language_b text,
  target_languages text[],
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
    case
      when pg_catalog.cardinality(preset_row.target_languages) >= 1 then preset_row.target_languages
      else array[preset_row.language_b]
    end,
    preset_row.version,
    preset_row.active_document_version,
    preset_row.active_document_fingerprint,
    preset_row.updated_at
  from public.host_glossary_presets as preset_row
  where preset_row.host_id = clean_host_id
  order by preset_row.updated_at desc, preset_row.id;
end;
$$;

revoke all on function public.list_host_glossary_documents_v2(text)
  from public, anon, authenticated;
