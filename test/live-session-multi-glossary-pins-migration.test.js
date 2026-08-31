import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/202608270001_live_session_multi_glossary_pins.sql", import.meta.url);
const migrationsDirectoryUrl = new URL("../supabase/migrations/", import.meta.url);
const BUILTIN_IDS = [
  "common_business",
  "ai_ax",
  "commercial_real_estate",
  "hospitality",
  "fnb_retail",
  "proper_nouns",
  "ko_ja_idioms",
];

test("multi glossary migration is additive, bounded, ordered, and source-shape constrained", async () => {
  const sameTimestampMigrations = (await readdir(migrationsDirectoryUrl))
    .filter((name) => name.startsWith("202608270001"));
  assert.deepEqual(sameTimestampMigrations, ["202608270001_live_session_multi_glossary_pins.sql"]);
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table public\.live_session_glossary_pins/u);
  assert.match(sql, /primary key \(session_id, ordinal\)/u);
  assert.match(sql, /ordinal between 1 and 5/u);
  assert.match(sql, /source_kind in \('builtin', 'host'\)/u);
  assert.match(sql, /live_session_glossary_pins_builtin_unique/u);
  assert.match(sql, /live_session_glossary_pins_host_unique/u);
  for (const id of BUILTIN_IDS) assert.match(sql, new RegExp(`'${id}'`, "u"));
  assert.doesNotMatch(sql, /\b(?:drop table|drop column|truncate)\b/iu);
});

test("replace v2 locks the owned session and enforces version, preparing state, active host version, and one increment", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const start = sql.indexOf("create or replace function public.replace_live_session_glossary_pins_v2");
  const end = sql.indexOf("create or replace function public.read_live_session_pinned_glossaries_v2");
  const body = sql.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(body, /for update/u);
  assert.match(body, /session_row\.version <> p_expected_session_version/u);
  assert.match(body, /session_row\.status <> 'preparing'/u);
  assert.match(body, /preset_row\.host_id = clean_host_id/u);
  assert.match(body, /preset_row\.active_document_version = document_version_value/u);
  assert.match(body, /version_row\.fingerprint = preset_row\.active_document_fingerprint/u);
  assert.match(body, /version = target_session\.version \+ 1/u);
  assert.match(body, /DUPLICATE_LIVE_GLOSSARY_PIN/u);
  assert.match(body, /pg_catalog\.jsonb_array_length\(p_glossaries\) not between 1 and 5/u);
  assert.doesNotMatch(body, /\bfetch\b|http_|net\./iu);
});

test("read v2 exposes the fixed gateway row contract and falls back inside v2 to the singular pin", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const start = sql.indexOf("create or replace function public.read_live_session_pinned_glossaries_v2");
  const body = sql.slice(start);
  assert.match(body, /p_live_session_id uuid/u);
  for (const field of [
    "session_id uuid",
    "ordinal integer",
    "source_kind text",
    "source_id text",
    "document_version integer",
    "fingerprint text",
    "glossary_document jsonb",
  ]) assert.match(body, new RegExp(field, "u"));
  assert.match(body, /order by pin_row\.ordinal/u);
  assert.match(body, /Legacy singular fallback/u);
  assert.match(body, /session_row\.pinned_glossary_preset_id/u);
  assert.match(body, /PINNED_GLOSSARY_VERSION_MISMATCH/u);
  assert.match(body, /grant execute on function public\.read_live_session_pinned_glossaries_v2\(uuid\)[\s\S]*to service_role/u);
  assert.doesNotMatch(body, /to anon|to authenticated/u);
});
