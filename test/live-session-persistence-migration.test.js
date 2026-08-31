import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "202608310001_live_session_persistence.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

function extractFunction(sql, name) {
  const match = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "iu"));
  assert.ok(match, `${name} exists`);
  return match[0];
}

function assignmentClauses(sql) {
  return [...sql.matchAll(/\bupdate public\.\w+(?: \w+)?\s+set ([\s\S]*?)\s+where\b/giu)]
    .map((match) => match[1]).join("\n");
}

test("persistence migration is additive, ordered, and mirrored once in bootstrap", async () => {
  const [sql, bootstrap, migrations] = await Promise.all([
    readMigration(),
    readFile(new URL("../supabase/bootstrap-new-project.sql", import.meta.url), "utf8"),
    readdir(new URL("../supabase/migrations/", import.meta.url)),
  ]);
  const ordered = migrations.filter((name) => name.endsWith(".sql")).sort();
  assert.ok(ordered.indexOf(migrationName) > ordered.indexOf("202608270002_host_glossary_multi_target_languages.sql"));
  const marker = `-- supabase/migrations/${migrationName}`;
  assert.equal(bootstrap.split(marker).length - 1, 1);
  assert.ok(bootstrap.includes(`${marker}\n\n${sql}`));
  assert.doesNotMatch(sql, /\b(?:drop table|drop column|truncate)\b/iu);
});

test("existing session windows are backfilled without extending credentials or changing schedules", async () => {
  const sql = await readMigration();
  const preamble = sql.slice(0, sql.indexOf("create or replace function"));
  assert.match(preamble, /add column if not exists access_window_started_at timestamptz/iu);
  assert.match(preamble, /set access_window_started_at = created_at\s+where access_window_started_at is null/iu);
  assert.match(preamble, /alter column access_window_started_at set default statement_timestamp\(\)/iu);
  assert.match(preamble, /alter column access_window_started_at set not null/iu);
  assert.match(preamble, /access_window_started_at >= created_at/iu);
  assert.match(preamble, /scheduled_at <= access_window_started_at \+ interval '30 days'/iu);
  assert.match(preamble, /expires_at <= greatest\(access_window_started_at, coalesce\(scheduled_at, access_window_started_at\)\) \+ interval '6 hours'/iu);
  assert.doesNotMatch(preamble, /set\s+(?:status|scheduled_at|expires_at|admission_state|admission_code_hmac)\s*=/iu);
});

test("renewal serializes owner version checks and cannot resurrect terminal or deleted sessions", async () => {
  const sql = await readMigration();
  const body = extractFunction(sql, "renew_live_session_access_v1");
  assert.match(body, /p_session_id uuid,\s*p_host_id text,\s*p_expected_version integer[\s\S]*returns integer/iu);
  assert.match(body, /p_expected_version < 1[\s\S]*p_expected_version >= 2147483647/iu);
  assert.match(body, /target_session\.host_id = p_host_id[\s\S]*target_session\.version = p_expected_version[\s\S]*target_session\.status in \('preparing', 'live', 'paused'\)[\s\S]*target_session\.archive_deleted_at is null[\s\S]*for update/iu);
  assert.match(body, /if not found then[\s\S]*VERSION_CONFLICT_OR_FORBIDDEN/iu);
  assert.match(body, /if session_row\.expires_at > statement_timestamp\(\) then\s*return session_row\.version/iu);
  assert.match(body, /set access_window_started_at = statement_timestamp\(\),[\s\S]*expires_at = greatest\(statement_timestamp\(\), coalesce\(target_session\.scheduled_at, statement_timestamp\(\)\)\)\s*\+ interval '6 hours'/iu);
  assert.match(body, /version = target_session\.version \+ 1/iu);
  assert.doesNotMatch(assignmentClauses(body), /\b(?:status|scheduled_at|title|admission_state|admission_code_hmac|admission_generation|admission_open_until)\s*=/iu);
  assert.match(body, /security definer\s+set search_path = ''/iu);
  assert.match(sql, /revoke all on function public\.renew_live_session_access_v1\(uuid, text, integer\)\s+from public, anon, authenticated, service_role/iu);
  assert.match(sql, /grant execute on function public\.renew_live_session_access_v1\(uuid, text, integer\)\s+to service_role/iu);
});

test("editing retained calls preserves an unchanged overdue schedule but bounds deliberate changes from now", async () => {
  const body = extractFunction(await readMigration(), "update_live_session");
  assert.match(body, /session_row\.host_id = p_host_id[\s\S]*session_row\.version = p_expected_version[\s\S]*session_row\.status = 'preparing'[\s\S]*session_row\.expires_at > statement_timestamp\(\)[\s\S]*for update/iu);
  assert.match(body, /p_scheduled_at is distinct from current_session\.scheduled_at[\s\S]*p_scheduled_at < statement_timestamp\(\) - interval '5 minutes'[\s\S]*p_scheduled_at > statement_timestamp\(\) \+ interval '30 days'/iu);
  assert.match(body, /access_window_started_at = statement_timestamp\(\)/iu);
  assert.doesNotMatch(body, /session_row\.created_at \+ interval '30 days'/iu);
});

test("cleanup expires access without ending calls or destroying durable content", async () => {
  const body = extractFunction(await readMigration(), "cleanup_expired_live_state");
  assert.doesNotMatch(assignmentClauses(body), /\b(?:status|ended_at|scheduled_at|title|admission_state|admission_code_hmac|admission_open_until)\s*=/iu);
  assert.doesNotMatch(body, /delete from public\.(?:live_sessions|live_utterances|live_meeting_summaries|live_participants|live_topics)\b/iu);
  assert.match(body, /invite_row\.expires_at <= statement_timestamp\(\)/iu);
  assert.match(body, /grant_row\.expires_at <= statement_timestamp\(\)/iu);
  assert.match(body, /delete from public\.live_recap_grants\s+where expires_at <= statement_timestamp\(\)/iu);
  assert.match(body, /floor_grant_id = null,[\s\S]*floor_display_name = null,[\s\S]*floor_taken_at = null/iu);
  assert.match(body, /return 0;/iu);
});

test("expiry renewal trigger does not implicitly extend admission and retains code generation fences", async () => {
  const body = extractFunction(await readMigration(), "enforce_stable_live_admission");
  const existingCodeBranch = body.slice(body.indexOf("elsif old.admission_code_hmac is not null then"), body.indexOf("  else\n    new.admission_generation := 0;"));
  assert.match(body, /ADMISSION_CODE_IMMUTABLE/iu);
  assert.match(existingCodeBranch, /new\.admission_generation := old\.admission_generation/iu);
  assert.match(existingCodeBranch, /new\.admission_open_until := least\(new\.admission_open_until, new\.expires_at\)/iu);
  assert.doesNotMatch(existingCodeBranch, /new\.admission_open_until := new\.expires_at/iu);
  assert.match(existingCodeBranch, /new\.admission_state := old\.admission_state/iu);
});

test("glossary cleanup retains saved and archived session metadata and every pinned document version", async () => {
  const sql = await readMigration();
  const body = extractFunction(sql, "cleanup_expired_live_glossary_documents");
  assert.doesNotMatch(body, /update public\.live_sessions|delete from public\.live_session_sections/iu);
  assert.match(body, /delete from public\.host_glossary_preset_versions[\s\S]*version_row\.created_at < statement_timestamp\(\) - interval '30 days'/iu);
  assert.match(body, /preset_row\.active_document_version is distinct from version_row\.version/iu);
  assert.match(body, /not exists \([\s\S]*from public\.live_sessions as pinned_session[\s\S]*pinned_session\.pinned_glossary_preset_id = version_row\.preset_id[\s\S]*pinned_session\.pinned_glossary_version = version_row\.version[\s\S]*pinned_session\.pinned_glossary_fingerprint = version_row\.fingerprint/iu);
  assert.match(body, /not exists \([\s\S]*from public\.live_session_glossary_pins as pinned_glossary[\s\S]*pinned_glossary\.host_preset_id = version_row\.preset_id[\s\S]*pinned_glossary\.host_document_version = version_row\.version[\s\S]*pinned_glossary\.host_document_fingerprint = version_row\.fingerprint/iu);
  assert.match(sql, /revoke all on function public\.cleanup_expired_live_glossary_documents\(\)\s+from public, anon, authenticated/iu);
});

test("fresh bootstrap includes both glossary dependencies before persistence cleanup references their tables", async () => {
  const bootstrap = await readFile(new URL("../supabase/bootstrap-new-project.sql", import.meta.url), "utf8");
  const dependencyNames = ["202608270001_live_session_multi_glossary_pins.sql", "202608270002_host_glossary_multi_target_languages.sql"];
  let previousIndex = bootstrap.indexOf("-- supabase/migrations/202608220001_live_authoritative_source_transcript.sql");
  for (const name of dependencyNames) {
    const sql = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
    const marker = `-- supabase/migrations/${name}`;
    assert.equal(bootstrap.split(marker).length - 1, 1);
    assert.ok(bootstrap.includes(`${marker}\n\n${sql}`));
    const index = bootstrap.indexOf(marker);
    assert.ok(index > previousIndex);
    previousIndex = index;
  }
  assert.ok(bootstrap.indexOf(`-- supabase/migrations/${migrationName}`) > previousIndex);
});
