import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "202607230001_live_multilingual_languages.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

test("multilingual migration follows its dependencies, is additive, and preserves existing rows while canonicalizing aliases", async () => {
  const migrationDirectory = new URL("../supabase/migrations/", import.meta.url);
  const migrations = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const dependencyIndex = migrations.indexOf("202607220001_live_voice_provider.sql");
  const migrationIndex = migrations.indexOf(migrationName);
  assert.notEqual(dependencyIndex, -1);
  assert.notEqual(migrationIndex, -1);
  assert.equal(dependencyIndex < migrationIndex, true);

  const sql = await readMigration();
  assert.doesNotMatch(sql, /drop\s+(column|table|type)|truncate|delete\s+from/iu);
  assert.match(sql, /update public\.live_sessions[\s\S]*public\.normalize_live_languages\(languages\)/u);
  assert.match(sql, /update public\.live_snapshots[\s\S]*public\.normalize_live_language\(language\)/u);
  assert.match(sql, /LIVE_LANGUAGE_ALIAS_COLLISION/u);
  assert.match(sql, /add constraint live_sessions_canonical_languages_check[\s\S]*not valid/iu);
  assert.match(sql, /validate constraint live_sessions_canonical_languages_check/iu);
  assert.match(sql, /add constraint live_snapshots_canonical_language_check[\s\S]*not valid/iu);
  assert.match(sql, /validate constraint live_snapshots_canonical_language_check/iu);
});

test("only approved languages are stored and input aliases normalize before 1..3 uniqueness validation", async () => {
  const sql = await readMigration();
  const approved = [
    "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "pt",
    "fr", "de", "ru", "hi", "id", "vi", "it",
  ];

  assert.match(sql, /create or replace function public\.normalize_live_language\(p_language text\)/u);
  assert.match(sql, /when 'en-US' then 'en'/u);
  assert.match(sql, /when 'ko-KR' then 'ko'/u);
  assert.match(sql, /when 'ja-JP' then 'ja'/u);
  assert.match(sql, /when 'zh-CN' then 'zh-Hans'/u);
  assert.match(sql, /when 'cmn-Hans-CN' then 'zh-Hans'/u);
  assert.match(sql, /when 'zh-TW' then 'zh-Hant'/u);
  assert.match(sql, /when 'cmn-Hant-TW' then 'zh-Hant'/u);
  assert.match(sql, /create or replace function public\.normalize_live_languages\(p_languages text\[\]\)/u);
  assert.match(sql, /create or replace function public\.live_language_valid\(p_language text\)/u);
  assert.match(sql, /coalesce\(p_language = public\.normalize_live_language\(p_language\), false\)/u);
  assert.match(sql, /create or replace function public\.live_languages_valid\(p_languages text\[\]\)/u);
  for (const language of approved) assert.match(sql, new RegExp(`'${language}'`, "u"));
  assert.match(sql, /cardinality\(p_languages\) between 1 and 3/u);
  assert.match(sql, /count\(distinct public\.normalize_live_language\(language_code\)\)/u);
  assert.match(sql, /public\.normalize_live_language\(language_code\) is null/u);
  assert.match(sql, /create or replace function public\.live_languages_canonical\(p_languages text\[\]\)/u);
  assert.match(sql, /p_languages = public\.normalize_live_languages\(p_languages\)/u);
  assert.match(sql, /create trigger live_sessions_normalize_languages_before_write/u);
  assert.doesNotMatch(sql, /\^\[A-Za-z\]/u);
});

test("create, update, join, snapshot, and topic contracts fail closed on non-canonical languages", async () => {
  const sql = await readMigration();

  // Existing create/update overloads call this function dynamically; the new
  // exact implementation therefore tightens both without replacing their APIs.
  assert.match(sql, /comment on function public\.live_languages_valid\(text\[\]\)[\s\S]*create_live_session[\s\S]*update_live_session/iu);

  const admissionLock = sql.match(
    /create or replace function public\.lock_live_admission_session\([\s\S]*?\n\$\$;/u,
  )?.[0];
  const inviteLock = sql.match(
    /create or replace function public\.lock_live_invite_session\([\s\S]*?\n\$\$;/u,
  )?.[0];
  assert.ok(admissionLock);
  assert.ok(inviteLock);
  assert.match(admissionLock, /public\.live_languages_canonical\(session_row\.languages\)/u);
  assert.match(inviteLock, /public\.live_languages_canonical\(session_row\.languages\)/u);

  assert.match(sql, /live_snapshots_canonical_language_check[\s\S]*public\.live_language_valid\(language\)/u);
  const topicAuthorization = sql.match(
    /create or replace function public\.authorize_live_viewer_topic\([\s\S]*?\n\$\$;/u,
  )?.[0];
  assert.ok(topicAuthorization);
  assert.match(topicAuthorization, /public\.live_language_valid\(p_language\)/u);
  assert.match(topicAuthorization, /p_language = any\(session_row\.languages\)/u);
  assert.match(topicAuthorization, /public\.live_languages_canonical\(session_row\.languages\)/u);
  assert.match(topicAuthorization, /session_row\.status = 'live'/u);
  assert.doesNotMatch(topicAuthorization, /session_row\.status in \('preparing', 'live'\)/u);
});

test("new and replaced helper contracts use safe search paths and least privilege", async () => {
  const sql = await readMigration();
  for (const signature of [
    "normalize_live_language(text)",
    "normalize_live_languages(text[])",
    "live_language_valid(text)",
    "live_languages_valid(text[])",
    "live_languages_canonical(text[])",
    "normalize_live_session_languages()",
    "lock_live_admission_session(text)",
    "lock_live_invite_session(text)",
    "authorize_live_viewer_topic(uuid, uuid, text, text)",
  ]) {
    const escaped = signature.replace(/[()[\]]/gu, "\\$&");
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, "u"));
  }
  assert.match(sql, /grant execute on function public\.authorize_live_viewer_topic\(uuid, uuid, text, text\)[\s\S]*to service_role/u);
  assert.equal((sql.match(/set search_path = ''/gu) ?? []).length >= 5, true);
});

test("migration includes executable verification queries for canonical boundaries", async () => {
  const sql = await readMigration();
  assert.match(sql, /-- Verification \(run after applying to a development project only\):/u);
  assert.match(sql, /public\.live_languages_valid\(array\['en', 'ja', 'zh-Hans'\]\)/u);
  assert.match(sql, /public\.normalize_live_languages\(array\['en-US', 'ko-KR', 'zh-CN'\]\)/u);
  assert.match(sql, /not public\.live_languages_valid\(array\['en', 'en'\]\)/u);
  assert.match(sql, /not public\.live_languages_valid\(array\['EN'\]\)/u);
  assert.match(sql, /not public\.live_languages_canonical\(array\['zh'\]\)/u);
  assert.match(sql, /existing_sessions_are_canonical[\s\S]*not public\.live_languages_canonical\(languages\)/u);
});
