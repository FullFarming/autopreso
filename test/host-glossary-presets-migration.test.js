import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "20260727012000_host_glossary_presets.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

test("host glossary migration is additive and follows canonical language support", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(migrations.indexOf("202607230001_live_multilingual_languages.sql") < migrations.indexOf(migrationName));
  assert.ok(migrations.indexOf("20260727011000_live_cover_20mb.sql") < migrations.indexOf(migrationName));

  const sql = await readMigration();
  assert.doesNotMatch(sql, /\bdrop\s+(?:table|column|type|function)\b|\btruncate\b/iu);
  assert.match(sql, /create table public\.host_glossary_presets/iu);
  for (const column of [
    "id uuid", "host_id text", "name text", "domain text", "glossary text",
    "language_a text", "language_b text", "version integer", "created_at timestamptz", "updated_at timestamptz",
  ]) assert.match(sql, new RegExp(column, "iu"), column);
});

test("table constraints bound host content, canonical pair, timestamps, names, and capacity indexes", async () => {
  const sql = await readMigration();
  assert.match(sql, /char_length\(host_id\) between 1 and 100/iu);
  assert.match(sql, /char_length\(name\) between 1 and 80/iu);
  assert.match(sql, /char_length\(domain\) <= 600/iu);
  assert.match(sql, /char_length\(glossary\) between 1 and 16000/iu);
  assert.match(sql, /public\.live_language_valid\(language_a\)/iu);
  assert.match(sql, /public\.live_language_valid\(language_b\)/iu);
  assert.match(sql, /language_a <> language_b/iu);
  assert.match(sql, /version integer not null default 1[\s\S]*version >= 1/iu);
  assert.match(sql, /created_at timestamptz not null default statement_timestamp\(\)/iu);
  assert.match(sql, /updated_at timestamptz not null default statement_timestamp\(\)/iu);
  assert.match(sql, /create unique index host_glossary_presets_host_name_unique[\s\S]*lower\(host_id\)[\s\S]*lower\(name\)/iu);
  assert.match(sql, /create index host_glossary_presets_host_id_idx[\s\S]*\(host_id\)/iu);
});

test("table and all RPCs are service-role only with fail-closed RLS", async () => {
  const sql = await readMigration();
  assert.match(sql, /alter table public\.host_glossary_presets enable row level security/iu);
  assert.match(sql, /revoke all on table public\.host_glossary_presets\s+from public, anon, authenticated, service_role/iu);
  assert.doesNotMatch(sql, /grant (?:select|insert|update|delete|all)[^;]*on table public\.host_glossary_presets/iu);

  const signatures = [
    "list_host_glossary_presets(text)",
    "create_host_glossary_preset(text, text, text, text, text, text)",
    "update_host_glossary_preset(uuid, text, integer, text, text, text, text, text)",
    "delete_host_glossary_preset(uuid, text, integer)",
  ];
  for (const signature of signatures) {
    const escaped = signature.replace(/[()[\]]/gu, "\\$&");
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, "iu"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, "iu"));
  }
  assert.equal((sql.match(/security definer/giu) ?? []).length, 4);
  assert.equal((sql.match(/set search_path = ''/giu) ?? []).length, 4);
});

test("list and mutation RPCs expose the fixed backend row contract", async () => {
  const sql = await readMigration();
  const rowShape = /returns table \(\s*id uuid,\s*name text,\s*domain text,\s*glossary text,\s*language_a text,\s*language_b text,\s*version integer,\s*updated_at timestamptz\s*\)/iu;
  assert.equal((sql.match(new RegExp(rowShape.source, "giu")) ?? []).length, 3);
  assert.match(sql, /create or replace function public\.delete_host_glossary_preset\([\s\S]*returns boolean/iu);
  assert.doesNotMatch(sql, /returns table\s*\([^)]*\bhost_id\s+text/iu,
    "host identity must not be reflected in the public RPC row shape");
});

test("create is concurrency-safe at fifty presets and update-delete are atomic version guards", async () => {
  const sql = await readMigration();
  const createRpc = sql.match(/create or replace function public\.create_host_glossary_preset\([\s\S]*?\n\$\$;/iu)?.[0] ?? "";
  assert.match(createRpc, /pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(clean_host_id, 0\)\)/iu);
  assert.match(createRpc, /select count\(\*\)[\s\S]*from public\.host_glossary_presets[\s\S]*preset_count >= 50/iu);
  assert.match(createRpc, /GLOSSARY_PRESET_LIMIT_REACHED/u);

  const updateRpc = sql.match(/create or replace function public\.update_host_glossary_preset\([\s\S]*?\n\$\$;/iu)?.[0] ?? "";
  assert.match(updateRpc, /where preset_row\.id = p_id[\s\S]*preset_row\.host_id = clean_host_id[\s\S]*preset_row\.version = p_expected_version/iu);
  assert.match(updateRpc, /version = preset_row\.version \+ 1/iu);
  assert.match(updateRpc, /GET DIAGNOSTICS affected_count = ROW_COUNT/iu);
  assert.match(updateRpc, /GLOSSARY_PRESET_NOT_FOUND/u);
  assert.match(updateRpc, /GLOSSARY_PRESET_VERSION_CONFLICT/u);

  const deleteRpc = sql.match(/create or replace function public\.delete_host_glossary_preset\([\s\S]*?\n\$\$;/iu)?.[0] ?? "";
  assert.match(deleteRpc, /where preset_row\.id = p_id[\s\S]*preset_row\.host_id = clean_host_id[\s\S]*preset_row\.version = p_expected_version/iu);
  assert.match(deleteRpc, /GET DIAGNOSTICS affected_count = ROW_COUNT/iu);
  assert.match(deleteRpc, /GLOSSARY_PRESET_NOT_FOUND/u);
  assert.match(deleteRpc, /GLOSSARY_PRESET_VERSION_CONFLICT/u);
});

test("database input boundaries fail closed without pretending to perform NFC normalization", async () => {
  const sql = await readMigration();
  assert.match(sql, /INVALID_HOST_GLOSSARY_PRESET_INPUT/u);
  assert.match(sql, /GLOSSARY_PRESET_NAME_CONFLICT/u);
  assert.doesNotMatch(sql, /normalize\([\s\S]*NFC/iu,
    "NFC canonicalization belongs at the application ingress; DB keeps independent length and blank guards");
  assert.match(sql, /-- Verification \(run after applying to a development project only\):/u);
});
