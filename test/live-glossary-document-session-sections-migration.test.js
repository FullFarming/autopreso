import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "202608150004_live_glossary_document_session_sections.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

function flexibleSignature(signature) {
  return signature
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll(", ", ",\\s*")
    .replace("\\(", "\\(\\s*")
    .replace("\\)", "\\s*\\)");
}

function extractFunction(sql, functionName) {
  const match = sql.match(new RegExp(`create or replace function public\\.${functionName}\\([\\s\\S]*?\\n\\$\\$;`, "iu"));
  assert.ok(match, `${functionName} body exists`);
  return match[0];
}

test("glossary document migration sorts after glossary presets and live semantic topics", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const migrationIndex = migrations.indexOf(migrationName);
  assert.notEqual(migrationIndex, -1);
  for (const dependencyName of [
    "20260727013000_host_glossary_presets_coalesce_fix.sql",
    "202608150002_live_semantic_topics.sql",
  ]) {
    assert.ok(migrations.indexOf(dependencyName) < migrationIndex, dependencyName);
  }
});

test("glossary document schema is additive and preserves legacy text rows", async () => {
  const sql = await readMigration();
  assert.match(sql, /alter table public\.host_glossary_presets[\s\S]*add column if not exists active_document_version integer/u);
  assert.match(sql, /alter table public\.host_glossary_presets[\s\S]*add column if not exists active_document_fingerprint text/u);
  assert.match(sql, /create table if not exists public\.host_glossary_preset_versions\s*\(/u);
  assert.match(sql, /preset_id uuid not null references public\.host_glossary_presets\(id\) on delete cascade/u);
  assert.match(sql, /host_id text not null/u);
  assert.match(sql, /document_schema text not null default 'glossary-document\/v1'/u);
  assert.match(sql, /document jsonb not null/u);
  assert.match(sql, /fingerprint text not null/u);
  assert.match(sql, /unique \(preset_id, version\)/u);
  assert.match(sql, /unique \(preset_id, fingerprint\)/u);
  assert.match(sql, /jsonb_typeof\(document\) = 'object'/u);
  assert.match(sql, /octet_length\(document::text\) <= 5000000/u);
  assert.match(sql, /fingerprint ~ '\^sha256:\[0-9a-f\]\{64\}\$'/u);
  assert.doesNotMatch(sql, /drop\s+(?:column|table)[\s\S]*(?:glossary|host_glossary_presets)/iu);
  assert.doesNotMatch(sql, /alter table public\.host_glossary_presets[\s\S]*alter column glossary/iu);
});

test("glossary document RPCs are owner-scoped, optimistic, and service-role only", async () => {
  const sql = await readMigration();
  const save = extractFunction(sql, "save_host_glossary_document_version_v1");
  const activate = extractFunction(sql, "activate_host_glossary_document_version_v1");

  assert.match(save, /p_host_id text[\s\S]*p_preset_id uuid[\s\S]*p_expected_preset_version integer[\s\S]*p_document jsonb[\s\S]*p_fingerprint text/u);
  assert.match(save, /where preset_row\.id = p_preset_id[\s\S]*and preset_row\.host_id = clean_host_id[\s\S]*and preset_row\.version = p_expected_preset_version/iu);
  assert.match(save, /GLOSSARY_PRESET_VERSION_CONFLICT/u);
  assert.match(save, /select count\(\*\) into existing_document_version_count[\s\S]*where version_row\.preset_id = p_preset_id[\s\S]*existing_document_version_count >= 200[\s\S]*GLOSSARY_VERSION_LIMIT_REACHED[\s\S]*insert into public\.host_glossary_preset_versions/iu);
  assert.match(save, /return query[\s\S]*id[\s\S]*preset_id[\s\S]*host_id[\s\S]*document_version[\s\S]*fingerprint[\s\S]*document_schema[\s\S]*preset_version[\s\S]*created_at/iu);
  assert.match(activate, /p_expected_preset_version integer[\s\S]*p_document_version integer/iu);
  assert.match(activate, /where preset_row\.id = p_preset_id[\s\S]*and preset_row\.host_id = clean_host_id[\s\S]*and preset_row\.version = p_expected_preset_version/iu);
  assert.match(activate, /active_document_version = version_row\.version[\s\S]*active_document_fingerprint = version_row\.fingerprint/iu);

  for (const signature of [
    "save_host_glossary_document_version_v1(text, uuid, integer, jsonb, text)",
    "activate_host_glossary_document_version_v1(text, uuid, integer, integer)",
  ]) {
    const escaped = flexibleSignature(signature);
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, "iu"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, "iu"));
  }
});

test("document preset RPCs support atomic create and metadata-only listing", async () => {
  const sql = await readMigration();
  const create = extractFunction(sql, "create_host_glossary_document_preset_v1");
  const listPresets = extractFunction(sql, "list_host_glossary_documents_v1");
  const listVersions = extractFunction(sql, "list_host_glossary_document_versions_v1");
  const readVersion = extractFunction(sql, "read_host_glossary_document_version_v1");
  const deletePreset = extractFunction(sql, "delete_host_glossary_preset");
  const listVersionsReturns = listVersions.match(/returns table \(([\s\S]*?)\)\nlanguage/iu)?.[1] ?? "";

  assert.match(create, /p_host_id text[\s\S]*p_name text[\s\S]*p_domain text[\s\S]*p_language_a text[\s\S]*p_language_b text[\s\S]*p_document jsonb[\s\S]*p_fingerprint text/iu);
  assert.match(create, /perform pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(clean_host_id, 0\)\)/iu);
  assert.match(create, /preset_count >= 50[\s\S]*GLOSSARY_PRESET_LIMIT_REACHED/iu);
  assert.match(create, /insert into public\.host_glossary_presets[\s\S]*active_document_version[\s\S]*active_document_fingerprint[\s\S]*values[\s\S]*1[\s\S]*clean_fingerprint/iu);
  assert.match(create, /insert into public\.host_glossary_preset_versions[\s\S]*version, document, fingerprint[\s\S]*1, p_document, clean_fingerprint/iu);
  assert.match(create, /GLOSSARY_PRESET_NAME_CONFLICT/iu);

  assert.match(listPresets, /returns table \([\s\S]*id uuid[\s\S]*name text[\s\S]*domain text[\s\S]*language_a text[\s\S]*language_b text[\s\S]*version integer[\s\S]*active_document_version integer[\s\S]*active_document_fingerprint text[\s\S]*updated_at timestamptz[\s\S]*\)/iu);
  assert.doesNotMatch(listPresets, /\bdocument jsonb\b|\bglossary text\b/iu);
  assert.match(listPresets, /where preset_row\.host_id = clean_host_id/iu);

  assert.match(listVersions, /p_host_id text[\s\S]*p_preset_id uuid/iu);
  assert.match(listVersions, /returns table \([\s\S]*preset_id uuid[\s\S]*version integer[\s\S]*document_schema text[\s\S]*fingerprint text[\s\S]*created_at timestamptz[\s\S]*\)/iu);
  assert.doesNotMatch(listVersionsReturns, /\bdocument jsonb\b|\bhost_id\b/iu);
  assert.match(listVersions, /join public\.host_glossary_presets as preset_row[\s\S]*preset_row\.host_id = clean_host_id/iu);

  assert.match(readVersion, /p_host_id text[\s\S]*p_preset_id uuid[\s\S]*p_version integer/iu);
  assert.match(readVersion, /returns table \([\s\S]*preset_id uuid[\s\S]*version integer[\s\S]*document_schema text[\s\S]*fingerprint text[\s\S]*document jsonb[\s\S]*created_at timestamptz[\s\S]*\)/iu);
  assert.match(readVersion, /join public\.host_glossary_presets as preset_row[\s\S]*preset_row\.host_id = clean_host_id/iu);
  assert.match(deletePreset, /when foreign_key_violation then[\s\S]*GLOSSARY_PRESET_IN_USE/iu);
  assert.match(sql, /add column if not exists pinned_glossary_preset_id uuid references public\.host_glossary_presets\(id\) on delete restrict/iu);

  for (const signature of [
    "create_host_glossary_document_preset_v1(text, text, text, text, text, jsonb, text)",
    "list_host_glossary_documents_v1(text)",
    "list_host_glossary_document_versions_v1(text, uuid)",
    "read_host_glossary_document_version_v1(text, uuid, integer)",
    "delete_host_glossary_preset(uuid, text, integer)",
  ]) {
    const escaped = flexibleSignature(signature);
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, "iu"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, "iu"));
  }
});

test("live sessions can pin one immutable active glossary document version", async () => {
  const sql = await readMigration();
  assert.match(sql, /alter table public\.live_sessions[\s\S]*add column if not exists pinned_glossary_preset_id uuid/u);
  assert.match(sql, /alter table public\.live_sessions[\s\S]*add column if not exists pinned_glossary_version integer/u);
  assert.match(sql, /alter table public\.live_sessions[\s\S]*add column if not exists pinned_glossary_fingerprint text/u);
  assert.match(sql, /references public\.host_glossary_presets\(id\) on delete restrict/u);

  const pin = extractFunction(sql, "pin_live_session_glossary_version_v1");
  assert.match(pin, /p_session_id uuid[\s\S]*p_host_id text[\s\S]*p_expected_session_version integer[\s\S]*p_preset_id uuid[\s\S]*p_document_version integer/u);
  assert.match(pin, /session_row\.host_id = clean_host_id/iu);
  assert.match(pin, /session_row\.version <> p_expected_session_version[\s\S]*LIVE_SESSION_VERSION_CONFLICT/iu);
  assert.match(pin, /session_row\.status <> 'preparing'[\s\S]*ACTIVE_SESSION_GLOSSARY_IMMUTABLE/iu);
  assert.doesNotMatch(pin, /session_row\.status in \('live', 'paused'\)/iu);
  assert.doesNotMatch(pin, /'scheduled'/iu);
  assert.match(pin, /version_row\.host_id = clean_host_id[\s\S]*version_row\.preset_id = p_preset_id[\s\S]*version_row\.version = p_document_version/iu);
  assert.match(pin, /pinned_glossary_preset_id = p_preset_id[\s\S]*pinned_glossary_version = version_row\.version[\s\S]*pinned_glossary_fingerprint = version_row\.fingerprint/iu);
});

test("gateway can authoritatively read the pinned glossary document at session start", async () => {
  const sql = await readMigration();
  const readPinned = extractFunction(sql, "read_live_session_pinned_glossary_v1");
  const returnsClause = readPinned.match(/returns table \(([\s\S]*?)\)\nlanguage/iu)?.[1] ?? "";
  assert.match(readPinned, /p_session_id uuid/u);
  assert.match(readPinned, /returns table \([\s\S]*session_id uuid[\s\S]*preset_id uuid[\s\S]*version integer[\s\S]*document_schema text[\s\S]*fingerprint text[\s\S]*document jsonb[\s\S]*\)/iu);
  assert.doesNotMatch(returnsClause, /\bhost_id\b|\bversion_id\b|^\s*id uuid\b/imu);
  assert.match(readPinned, /session_row\.pinned_glossary_preset_id is null[\s\S]*session_row\.pinned_glossary_version is null[\s\S]*session_row\.pinned_glossary_fingerprint is null[\s\S]*return;/iu);
  assert.match(readPinned, /join public\.host_glossary_presets as preset_row[\s\S]*preset_row\.id = session_row\.pinned_glossary_preset_id[\s\S]*preset_row\.host_id = session_row\.host_id/iu);
  assert.match(readPinned, /join public\.host_glossary_preset_versions as version_row[\s\S]*version_row\.preset_id = session_row\.pinned_glossary_preset_id[\s\S]*version_row\.host_id = session_row\.host_id[\s\S]*version_row\.version = session_row\.pinned_glossary_version[\s\S]*version_row\.fingerprint = session_row\.pinned_glossary_fingerprint/iu);
  assert.match(readPinned, /matched_count <> 1[\s\S]*PINNED_GLOSSARY_VERSION_MISMATCH/iu);
  assert.match(readPinned, /return query select[\s\S]*session_row\.id as session_id[\s\S]*version_row\.preset_id[\s\S]*version_row\.version[\s\S]*version_row\.document_schema[\s\S]*version_row\.fingerprint[\s\S]*version_row\.document/iu);
  assert.doesNotMatch(readPinned, /insert into|update public\.|delete from|for update/iu);
});

test("event metadata and section schema support one active section with stable snapshots", async () => {
  const sql = await readMigration();
  assert.match(sql, /alter table public\.live_sessions[\s\S]*add column if not exists event_company_name text/u);
  assert.match(sql, /alter table public\.live_sessions[\s\S]*add column if not exists event_reporting_period text/u);
  assert.match(sql, /alter table public\.live_sessions[\s\S]*add column if not exists event_metadata jsonb not null default '\{\}'::jsonb/u);
  assert.match(sql, /create table if not exists public\.live_session_sections\s*\(/u);
  assert.match(sql, /session_id uuid not null references public\.live_sessions\(id\) on delete cascade/u);
  assert.match(sql, /section_key text not null/u);
  assert.match(sql, /section_key in \('prepared_remarks', 'qa', 'other'\)/u);
  assert.match(sql, /transition_key text not null/u);
  assert.match(sql, /unique \(session_id, transition_key\)/u);
  assert.match(sql, /create unique index if not exists live_session_sections_one_active_idx[\s\S]*where status = 'active'/iu);

  const transition = extractFunction(sql, "transition_live_session_section_v1");
  const snapshot = extractFunction(sql, "read_live_session_event_context_v1");
  assert.match(transition, /p_expected_session_version integer[\s\S]*p_transition_key text[\s\S]*p_section_key text[\s\S]*p_source_seq bigint/iu);
  assert.match(transition, /existing_section[\s\S]*transition_key = clean_transition_key[\s\S]*return query/iu);
  assert.match(transition, /session_row\.host_id = clean_host_id/iu);
  assert.match(transition, /LIVE_SESSION_SECTION_VERSION_CONFLICT/u);
  assert.match(transition, /update public\.live_session_sections[\s\S]*status = 'completed'[\s\S]*where section_row\.session_id = p_session_id[\s\S]*and section_row\.status = 'active'/iu);
  assert.match(snapshot, /event_company_name[\s\S]*event_reporting_period[\s\S]*event_metadata[\s\S]*active_section_key[\s\S]*sections/iu);
});

test("live session event metadata is created and updated atomically through wrappers", async () => {
  const sql = await readMigration();
  const create = extractFunction(sql, "create_live_session_with_event_v1");
  const update = extractFunction(sql, "update_live_session_with_event_v1");

  assert.match(create, /p_session_id uuid[\s\S]*p_host_id text[\s\S]*p_session_type text[\s\S]*p_output_mode text[\s\S]*p_languages text\[\][\s\S]*p_max_viewers integer[\s\S]*p_glossary_pack text[\s\S]*p_voice_provider text[\s\S]*p_title text[\s\S]*p_scheduled_at timestamptz[\s\S]*p_expires_at timestamptz[\s\S]*p_event_company_name text[\s\S]*p_event_reporting_period text[\s\S]*p_event_metadata jsonb/iu);
  assert.match(create, /from public\.create_live_session\([\s\S]*p_voice_provider[\s\S]*p_title[\s\S]*p_scheduled_at[\s\S]*p_expires_at[\s\S]*\)/iu);
  assert.doesNotMatch(create, /from public\.create_live_session\(\s*p_session_id,\s*p_host_id,\s*p_session_type,\s*p_output_mode,\s*p_languages,\s*p_max_viewers,\s*p_glossary_pack,\s*p_voice_provider,\s*p_expires_at\s*\)/iu);
  assert.match(create, /update public\.live_sessions as session_row[\s\S]*event_company_name = clean_event_company_name[\s\S]*event_reporting_period = clean_event_reporting_period[\s\S]*event_metadata = clean_event_metadata[\s\S]*where session_row\.id = base_session\.id/iu);
  assert.match(create, /returns table[\s\S]*title text[\s\S]*scheduled_at timestamptz[\s\S]*event_company_name text[\s\S]*event_reporting_period text[\s\S]*event_metadata jsonb/iu);
  assert.match(create, /return query select[\s\S]*updated_session\.title[\s\S]*updated_session\.scheduled_at[\s\S]*event_company_name[\s\S]*event_reporting_period[\s\S]*event_metadata/iu);
  assert.doesNotMatch(create, /http|fetch|rest|patch/iu);

  assert.match(update, /p_session_id uuid[\s\S]*p_host_id text[\s\S]*p_expected_version integer[\s\S]*p_session_type text[\s\S]*p_output_mode text[\s\S]*p_languages text\[\][\s\S]*p_max_viewers integer[\s\S]*p_glossary_pack text[\s\S]*p_voice_provider text[\s\S]*p_title text[\s\S]*p_scheduled_at timestamptz[\s\S]*p_event_company_name text[\s\S]*p_event_reporting_period text[\s\S]*p_event_metadata jsonb/iu);
  assert.match(update, /from public\.update_live_session\([\s\S]*p_expected_version[\s\S]*p_voice_provider[\s\S]*p_title[\s\S]*p_scheduled_at[\s\S]*\)/iu);
  assert.doesNotMatch(update, /from public\.update_live_session\(\s*p_session_id,\s*p_host_id,\s*p_expected_version,\s*p_session_type,\s*p_output_mode,\s*p_languages,\s*p_max_viewers,\s*p_glossary_pack,\s*p_voice_provider\s*\)/iu);
  assert.match(update, /if not found then[\s\S]*return;[\s\S]*end if;/iu);
  assert.match(update, /update public\.live_sessions as session_row[\s\S]*event_company_name = clean_event_company_name[\s\S]*event_reporting_period = clean_event_reporting_period[\s\S]*event_metadata = clean_event_metadata[\s\S]*where session_row\.id = base_session\.id/iu);
  assert.match(update, /returns table[\s\S]*title text[\s\S]*scheduled_at timestamptz[\s\S]*event_company_name text[\s\S]*event_reporting_period text[\s\S]*event_metadata jsonb/iu);
  assert.doesNotMatch(update, /http|fetch|rest|patch/iu);

  for (const signature of [
    "create_live_session_with_event_v1(uuid, text, text, text, text[], integer, text, text, text, timestamptz, timestamptz, text, text, jsonb)",
    "update_live_session_with_event_v1(uuid, text, integer, text, text, text[], integer, text, text, text, timestamptz, text, text, jsonb)",
  ]) {
    const escaped = flexibleSignature(signature);
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, "iu"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, "iu"));
  }
});

test("retention, privileges, and bootstrap parity are explicit", async () => {
  const [sql, bootstrap] = await Promise.all([readMigration(), readFile(bootstrapUrl, "utf8")]);
  assert.match(sql, /create or replace function public\.cleanup_expired_live_glossary_documents\(\)/iu);
  assert.match(sql, /update public\.live_sessions as session_row[\s\S]*pinned_glossary_preset_id = null[\s\S]*pinned_glossary_version = null[\s\S]*pinned_glossary_fingerprint = null[\s\S]*interval '30 days'/iu);
  assert.match(sql, /delete from public\.host_glossary_preset_versions[\s\S]*interval '30 days'/iu);
  assert.match(sql, /not exists \([\s\S]*from public\.live_sessions as pinned_session[\s\S]*pinned_session\.pinned_glossary_preset_id = version_row\.preset_id[\s\S]*pinned_session\.pinned_glossary_version = version_row\.version[\s\S]*pinned_session\.pinned_glossary_fingerprint = version_row\.fingerprint/iu);
  assert.match(sql, /delete from public\.live_session_sections[\s\S]*interval '30 days'/iu);
  assert.match(sql, /cron\.schedule\([\s\S]*realtime-noel-live-glossary-document-cleanup[\s\S]*select public\.cleanup_expired_live_glossary_documents\(\);/iu);

  for (const signature of [
    "pin_live_session_glossary_version_v1(uuid, text, integer, uuid, integer)",
    "read_live_session_pinned_glossary_v1(uuid)",
    "create_live_session_with_event_v1(uuid, text, text, text, text[], integer, text, text, text, timestamptz, timestamptz, text, text, jsonb)",
    "update_live_session_with_event_v1(uuid, text, integer, text, text, text[], integer, text, text, text, timestamptz, text, text, jsonb)",
    "transition_live_session_section_v1(uuid, text, integer, text, text, bigint)",
    "read_live_session_event_context_v1(uuid)",
    "cleanup_expired_live_glossary_documents()",
  ]) {
    const escaped = flexibleSignature(signature);
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, "iu"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, "iu"));
  }
  assert.match(bootstrap, new RegExp(`-- supabase/migrations/${migrationName}[\\s\\S]*create table if not exists public\\.host_glossary_preset_versions`, "iu"));
  assert.match(bootstrap, /create or replace function public\.create_host_glossary_document_preset_v1\(/iu);
  assert.match(bootstrap, /create or replace function public\.read_live_session_pinned_glossary_v1\(/iu);
  assert.match(bootstrap, /create or replace function public\.create_live_session_with_event_v1\(/iu);
  assert.match(bootstrap, /create or replace function public\.transition_live_session_section_v1\(/iu);
});
