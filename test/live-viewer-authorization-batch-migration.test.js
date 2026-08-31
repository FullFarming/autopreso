import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "202608150003_live_viewer_authorization_batch.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

function extractFunction(sql, functionName) {
  const match = sql.match(new RegExp(`create or replace function public\\.${functionName}\\([\\s\\S]*?\\n\\$\\$;`, "iu"));
  assert.ok(match, `${functionName} body exists`);
  return match[0];
}

test("viewer authorization batch migration is additive and ordered after language/viewer grants", async () => {
  const migrations = await readdir(new URL("../supabase/migrations/", import.meta.url));
  assert.ok(migrations.indexOf("202607230001_live_multilingual_languages.sql") < migrations.indexOf(migrationName));
  const sql = await readMigration();
  assert.match(sql, /create or replace function public\.authorize_live_viewer_grants_v1\(p_requests jsonb\)/iu);
  assert.doesNotMatch(sql, /drop table|drop column|alter table|delete from|update public\.viewer_grants|insert into/iu);
});

test("batch RPC has exact safe result contract and rejects malformed batches", async () => {
  const sql = await readMigration();
  const fn = extractFunction(sql, "authorize_live_viewer_grants_v1");
  assert.match(fn, /returns table \(\s*session_id uuid,\s*grant_id uuid,\s*user_id text,\s*language text,\s*authorized boolean\s*\)/iu);
  assert.match(fn, /jsonb_typeof\(p_requests\) <> 'array'[\s\S]*LIVE_VIEWER_AUTH_BATCH_INVALID/iu);
  assert.match(fn, /jsonb_array_length\(p_requests\) > 50[\s\S]*LIVE_VIEWER_AUTH_BATCH_TOO_LARGE/iu);
  assert.match(fn, /jsonb_array_length\(p_requests\) = 0[\s\S]*LIVE_VIEWER_AUTH_BATCH_EMPTY/iu);
  assert.match(fn, /jsonb_object_keys[\s\S]*array\['grant_id', 'language', 'session_id', 'user_id'\][\s\S]*LIVE_VIEWER_AUTH_BATCH_SHAPE/iu);
  assert.match(fn, /count\(\*\) > 1[\s\S]*LIVE_VIEWER_AUTH_BATCH_DUPLICATE/iu);
});

test("batch RPC validates canonical input and authorizes with one bounded live or paused query", async () => {
  const sql = await readMigration();
  const fn = extractFunction(sql, "authorize_live_viewer_grants_v1");
  assert.match(fn, /with request_rows as \([\s\S]*jsonb_array_elements\(p_requests\) with ordinality/iu);
  assert.match(fn, /request_row\.session_id_text !~\*[\s\S]*LIVE_VIEWER_AUTH_BATCH_SHAPE/iu);
  assert.match(fn, /public\.live_language_valid\(request_row\.language\) is not true[\s\S]*LIVE_VIEWER_AUTH_BATCH_SHAPE/iu);
  assert.match(fn, /session_row\.status in \('live', 'paused'\)/iu);
  assert.match(fn, /session_row\.expires_at > statement_timestamp\(\)/iu);
  assert.match(fn, /grant_row\.revoked_at is null[\s\S]*grant_row\.expires_at > statement_timestamp\(\)/iu);
  assert.match(fn, /grant_row\.session_id = request_row\.session_id[\s\S]*grant_row\.id = request_row\.grant_id[\s\S]*grant_row\.user_id = request_row\.user_id/iu);
  assert.match(fn, /request_row\.language = any\(session_row\.languages\)/iu);
  assert.match(fn, /order by request_row\.ordinal/iu);
  assert.match(fn, /coalesce\(authorized_row\.authorized, false\) as authorized/iu);
});

test("batch RPC stays service-role only and leaks no profile or PII fields", async () => {
  const sql = await readMigration();
  assert.match(sql, /revoke all on function public\.authorize_live_viewer_grants_v1\(jsonb\)\s+from public, anon, authenticated/iu);
  assert.match(sql, /grant execute on function public\.authorize_live_viewer_grants_v1\(jsonb\)\s+to service_role/iu);
  assert.doesNotMatch(sql, /email|display_name|company|department|job_title|profile/iu);
});

test("fresh bootstrap mirrors viewer authorization batch migration", async () => {
  const [sql, bootstrap] = await Promise.all([readMigration(), readFile(bootstrapUrl, "utf8")]);
  const marker = `-- supabase/migrations/${migrationName}`;
  assert.match(bootstrap, new RegExp(`${marker}[\\s\\S]*create or replace function public\\.authorize_live_viewer_grants_v1\\(p_requests jsonb\\)`, "iu"));
  assert.ok(bootstrap.includes(sql.trimEnd()));
});
