import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const documentMigrationName = "202608150004_live_glossary_document_session_sections.sql";
const migrationName = "202608270002_host_glossary_multi_target_languages.sql";
const migrationsUrl = new URL("../supabase/migrations/", import.meta.url);

async function readMigration(name) {
  return readFile(new URL(name, migrationsUrl), "utf8");
}

test("multi-target migration is ordered after the document preset schema", async () => {
  const migrations = (await readdir(migrationsUrl)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(migrations.indexOf(documentMigrationName) < migrations.indexOf(migrationName));
});

test("target_languages column is added, backfilled, and kept consistent by trigger", async () => {
  const sql = await readMigration(migrationName);
  assert.match(sql, /alter table public\.host_glossary_presets\s+add column if not exists target_languages text\[\]/u);
  assert.match(sql, /set target_languages = array\[language_b\]/u);
  assert.match(sql, /create trigger host_glossary_presets_sync_target_languages/u);
  assert.match(sql, /before insert or update on public\.host_glossary_presets/u);
  assert.match(sql, /host_glossary_presets_target_languages_bounded/u);
});

test("v2 RPCs expose and validate the full target language list", async () => {
  const sql = await readMigration(migrationName);
  assert.match(sql, /create or replace function public\.create_host_glossary_document_preset_v2\(/u);
  assert.match(sql, /create or replace function public\.list_host_glossary_documents_v2\(/u);
  assert.match(sql, /p_target_languages text\[\]/u);
  assert.match(sql, /public\.live_target_languages_valid\(/u);
  // language_b stays the first target so every v1 consumer keeps a coherent pair.
  assert.match(sql, /p_target_languages\[1\]/u);
  assert.equal((sql.match(/security definer/giu) ?? []).length >= 2, true);
  assert.equal((sql.match(/set search_path = ''/giu) ?? []).length >= 2, true);
  assert.match(sql, /revoke all on function public\.create_host_glossary_document_preset_v2\(text, text, text, text, text\[\], jsonb, text\)\s+from public, anon, authenticated;/u);
  assert.match(sql, /revoke all on function public\.list_host_glossary_documents_v2\(text\)\s+from public, anon, authenticated;/u);
});

test("target language validation enforces caption limits and excludes the source language", async () => {
  const sql = await readMigration(migrationName);
  assert.match(sql, /create or replace function public\.live_target_languages_valid\(p_targets text\[\], p_source text\)/u);
  assert.match(sql, /between 1 and 13/u);
  assert.match(sql, /count\(distinct /u);
  assert.match(sql, /public\.live_language_valid\(/u);
  assert.match(sql, /p_source/u);
});
