import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "202608150006_live_gateway_readiness_start.sql";
const repairMigrationName = "202608150007_live_plpgsql_ambiguity_repair.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

function extractFunction(sql, functionName) {
  const match = sql.match(new RegExp(
    `create or replace function public\\.${functionName}\\([\\s\\S]*?\\n\\$\\$;`,
    "iu",
  ));
  assert.ok(match, `${functionName} exists`);
  return match[0];
}

test("readiness migration follows live records and is mirrored exactly", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(migrations.indexOf("202608150005_live_records_sheets_outbox.sql") < migrations.indexOf(migrationName));

  const [sql, bootstrap] = await Promise.all([readMigration(), readFile(bootstrapUrl, "utf8")]);
  const marker = `-- supabase/migrations/${migrationName}`;
  assert.equal(bootstrap.split(marker).length - 1, 1);
  assert.ok(
    bootstrap.includes(`${marker}\n\n${sql}\n-- supabase/migrations/${repairMigrationName}`),
    "bootstrap keeps one exact readiness block immediately before its forward repair",
  );
});

test("activation receipt fields are additive, coherent, and cross-session unique", async () => {
  const sql = await readMigration();
  assert.match(sql, /alter table public\.live_sessions[\s\S]*add column if not exists gateway_activation_key uuid[\s\S]*add column if not exists gateway_settings_fingerprint text[\s\S]*add column if not exists gateway_activated_at timestamptz/iu);
  assert.match(sql, /gateway_activation_key is null[\s\S]*gateway_settings_fingerprint is null[\s\S]*gateway_activated_at is null[\s\S]*gateway_settings_fingerprint ~ '\^sha256:\[0-9a-f\]\{64\}\$'/iu);
  assert.match(sql, /create unique index live_sessions_gateway_activation_key_idx[\s\S]*gateway_activation_key[\s\S]*where gateway_activation_key is not null/iu);
  assert.doesNotMatch(sql, /drop\s+(table|column)|truncate/iu);
});

test("the independently constrained viewer counter permits the approved 200-person capacity", async () => {
  const sql = await readMigration();
  assert.match(sql, /drop constraint if exists live_sessions_viewer_count_check[\s\S]*add constraint live_sessions_viewer_count_check[\s\S]*viewer_count between 0 and 200/iu);
});

test("readiness RPC has the exact gateway-only input and public output shape", async () => {
  const body = extractFunction(await readMigration(), "activate_live_session_after_gateway_ready_v1");
  assert.match(body, /p_session_id uuid,\s*p_host_id text,\s*p_expected_version integer,\s*p_activation_key uuid,\s*p_gateway_settings_fingerprint text,\s*p_session_type text,\s*p_output_mode text,\s*p_voice_provider text,\s*p_languages text\[\],\s*p_max_viewers integer,\s*p_glossary_pack text,\s*p_pinned_glossary_fingerprint text/iu);
  assert.match(body, /returns table \(\s*session_id uuid,\s*status text,\s*version integer\s*\)/iu);
  assert.match(body, /security definer[\s\S]*set search_path = ''/iu);
});

test("readiness validates the complete bounded settings receipt before locking", async () => {
  const body = extractFunction(await readMigration(), "activate_live_session_after_gateway_ready_v1");
  assert.match(body, /p_expected_version < 1[\s\S]*p_gateway_settings_fingerprint !~ '\^sha256:\[0-9a-f\]\{64\}\$'/iu);
  assert.match(body, /p_expected_version >= 2147483647/iu);
  assert.match(body, /p_session_type not in \('presentation', 'meeting'\)[\s\S]*p_output_mode not in \('captions', 'captions_audio', 'audio'\)[\s\S]*p_voice_provider not in \('gemini', 'openai'\)/iu);
  assert.match(body, /not public\.live_languages_valid\(p_languages\)[\s\S]*p_max_viewers not between 1 and 200[\s\S]*p_glossary_pack not in \('general_cre', 'hotel', 'fnb'\)/iu);
  assert.match(body, /p_pinned_glossary_fingerprint is not null[\s\S]*p_pinned_glossary_fingerprint !~ '\^sha256:\[0-9a-f\]\{64\}\$'[\s\S]*INVALID_GATEWAY_READINESS_INPUT/iu);
});

test("first activation locks one session and fences owner version status and every persisted setting", async () => {
  const body = extractFunction(await readMigration(), "activate_live_session_after_gateway_ready_v1");
  assert.match(body, /from public\.live_sessions session_row[\s\S]*where session_row\.id = p_session_id[\s\S]*for update/iu);
  assert.match(body, /session_row\.host_id <> p_host_id[\s\S]*HOST_ACCESS_REQUIRED/iu);
  assert.match(body, /session_row\.status <> 'preparing'[\s\S]*session_row\.version <> p_expected_version[\s\S]*session_row\.expires_at <= statement_timestamp\(\)/iu);
  assert.match(body, /session_row\.session_type is distinct from p_session_type[\s\S]*session_row\.output_mode is distinct from p_output_mode[\s\S]*session_row\.voice_provider is distinct from p_voice_provider/iu);
  assert.match(body, /session_row\.languages is distinct from p_languages[\s\S]*session_row\.max_viewers is distinct from p_max_viewers[\s\S]*session_row\.glossary_pack is distinct from p_glossary_pack[\s\S]*session_row\.pinned_glossary_fingerprint is distinct from p_pinned_glossary_fingerprint/iu);
  assert.match(body, /set status = 'live'[\s\S]*version = session_row\.version \+ 1[\s\S]*gateway_activation_key = p_activation_key[\s\S]*gateway_settings_fingerprint = p_gateway_settings_fingerprint[\s\S]*gateway_activated_at = statement_timestamp\(\)/iu);
});

test("lost ACK replay returns the same live version only for the exact receipt", async () => {
  const body = extractFunction(await readMigration(), "activate_live_session_after_gateway_ready_v1");
  assert.match(body, /session_row\.status = 'live'[\s\S]*session_row\.version = p_expected_version \+ 1[\s\S]*session_row\.gateway_activation_key = p_activation_key[\s\S]*session_row\.gateway_settings_fingerprint = p_gateway_settings_fingerprint/iu);
  assert.match(body, /return query select session_row\.id, session_row\.status, session_row\.version;[\s\S]*return;/iu);
  assert.equal((body.match(/set status = 'live'/giu) ?? []).length, 1);
  assert.match(body, /GATEWAY_READINESS_CONFLICT/iu);
});

test("activation keys cannot cross sessions and unique races fail with the same safe conflict", async () => {
  const body = extractFunction(await readMigration(), "activate_live_session_after_gateway_ready_v1");
  assert.match(body, /other_session\.gateway_activation_key = p_activation_key[\s\S]*other_session\.id <> p_session_id[\s\S]*GATEWAY_READINESS_CONFLICT/iu);
  assert.match(body, /when unique_violation then[\s\S]*GATEWAY_READINESS_CONFLICT/iu);
});

test("only service role can activate and the premature legacy start path is dormant", async () => {
  const sql = await readMigration();
  const signature = "activate_live_session_after_gateway_ready_v1(uuid, text, integer, uuid, text, text, text, text, text[], integer, text, text)";
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(", ", ",\\s*").replaceAll("\\(", "\\(\\s*").replaceAll("\\)", "\\s*\\)");
  assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, "iu"));
  assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, "iu"));
  assert.match(sql, /revoke all on function public\.start_live_session\(uuid, text, integer\)[\s\S]*from public, anon, authenticated, service_role/iu);
  assert.doesNotMatch(sql, /grant execute on function public\.start_live_session\(uuid, text, integer\)/iu);
});

test("readiness transition contains no external IO, credentials, or participant data", async () => {
  const sql = await readMigration();
  assert.doesNotMatch(sql, /https?:|googleapis|fetch|webhook|net\.|credential|invite_token|access_token|participant/iu);
});
