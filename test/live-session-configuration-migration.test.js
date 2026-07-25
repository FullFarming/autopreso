import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260720040743_live_session_configuration.sql",
  import.meta.url,
);
const inviteMigrationUrl = new URL(
  "../supabase/migrations/202607200001_live_session_invites.sql",
  import.meta.url,
);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

test("canonical live configuration migration sorts after its dependencies", async () => {
  const migrationDirectory = new URL("../supabase/migrations/", import.meta.url);
  const migrations = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const dependencyNames = [
    "202607190001_live_sessions.sql",
    "202607190002_live_voice_output.sql",
    "202607200001_live_session_invites.sql",
  ];
  const migrationIndex = migrations.indexOf("20260720040743_live_session_configuration.sql");
  assert.notEqual(migrationIndex, -1);
  for (const dependencyName of dependencyNames) {
    const dependencyIndex = migrations.indexOf(dependencyName);
    assert.notEqual(dependencyIndex, -1);
    assert.equal(dependencyIndex < migrationIndex, true);
  }
});

test("canonical fields are additive, bounded, and legacy-compatible", async () => {
  const sql = await readMigration();
  assert.match(sql, /add column session_type text/u);
  assert.match(sql, /add column output_mode text/u);
  assert.match(sql, /add column max_viewers integer not null default 50/u);
  assert.match(sql, /add column glossary_pack text not null default 'general_cre'/u);
  assert.match(sql, /session_type in \('presentation', 'meeting'\)/u);
  assert.match(sql, /output_mode in \('captions', 'captions_audio', 'audio'\)/u);
  assert.match(sql, /max_viewers between 1 and 50/u);
  assert.match(sql, /viewer_count <= max_viewers/u);
  assert.match(sql, /glossary_pack in \('general_cre', 'hotel', 'fnb'\)/u);
  assert.match(sql, /@deprecated Read compatibility only/u);
  assert.match(sql, /create trigger live_sessions_compatibility_before_write/u);
  assert.doesNotMatch(sql, /drop (column|table)|alter type[\s\S]*drop value/iu);
});

test("viewer display names are NFC-normalized, trimmed, and bounded", async () => {
  const sql = await readMigration();
  assert.match(sql, /add column display_name text/u);
  assert.match(sql, /char_length\(display_name\) between 1 and 40/u);
  assert.match(sql, /display_name = normalize\(btrim\(display_name\), NFC\)/u);
  assert.match(sql, /normalized_display_name := normalize\(btrim\(p_display_name\), NFC\)/u);
  assert.match(sql, /normalized_display_name ~ '\[\[:cntrl:\]\]'/u);
  assert.match(sql, /normalized_display_name ~ '\[<>\]'/u);
  assert.match(sql, /display_name = coalesce\(normalized_display_name, display_name\)/u);
});

test("create and update RPCs use the canonical contract and optimistic capacity", async () => {
  const sql = await readMigration();
  assert.match(sql, /create or replace function public\.create_live_session\(/u);
  assert.match(sql, /create or replace function public\.update_live_session\(/u);
  assert.match(sql, /p_session_type not in \('presentation', 'meeting'\)/u);
  assert.match(sql, /p_output_mode not in \('captions', 'captions_audio', 'audio'\)/u);
  assert.match(sql, /session_row\.version = p_expected_version/u);
  assert.match(sql, /session_row\.viewer_count <= p_max_viewers/u);
  assert.match(sql, /version = session_row\.version \+ 1/u);
  assert.match(sql, /delete from public\.live_snapshots snapshot_row[\s\S]*not \(snapshot_row\.language = any\(updated_session\.languages\)\)/u);
});

test("join RPCs enforce host-selected capacity and duplicate join idempotency", async () => {
  const sql = await readMigration();
  const helper = sql.match(
    /create or replace function public\.apply_live_viewer_grant\([\s\S]*?\n\$\$;/u,
  )?.[0];
  assert.ok(helper);
  assert.match(helper, /from public\.live_sessions[\s\S]*for update/u);
  assert.match(helper, /active_count >= session_row\.max_viewers/u);
  assert.match(helper, /unique \(session_id, user_id, device_hash\)|on conflict \(session_id, user_id, device_hash\)/u);
  assert.match(helper, /if found and grant_row\.revoked_at is null[\s\S]*resolved_viewer_count := active_count/u);
  assert.doesNotMatch(helper, /active_count >= 50|viewer_count < 50/u);
  for (const name of ["redeem_live_admission", "redeem_live_invite"]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?p_display_name text`, "u"));
  }
  assert.equal((sql.match(/display_name := grant_result\.resolved_display_name/gu) ?? []).length, 2);
});

test("canonical admission window allows at most six hours without revoking joined viewers", async () => {
  const sql = await readMigration();
  const priorSql = await readFile(inviteMigrationUrl, "utf8");
  const admission = sql.match(
    /create or replace function public\.open_live_admission\([\s\S]*?\n\$\$;/u,
  )?.[0];
  assert.ok(admission);
  assert.match(admission, /p_expected_version integer/u);
  assert.match(admission, /p_open_until > statement_timestamp\(\) \+ interval '6 hours'/u);
  assert.match(admission, /p_open_until <= session_row\.expires_at/u);
  assert.match(admission, /update public\.live_session_invites invite_row/u);
  assert.doesNotMatch(admission, /update public\.viewer_grants/u);
  assert.match(priorSql, /create or replace function public\.terminate_live_session\([\s\S]*?update public\.viewer_grants/u);
});

test("versioned admission close revokes the invite but preserves viewer grants", async () => {
  const sql = await readMigration();
  const closeAdmission = sql.match(
    /create or replace function public\.close_live_admission\([\s\S]*?\n\$\$;/u,
  )?.[0];
  assert.ok(closeAdmission);
  assert.match(closeAdmission, /p_expected_version integer/u);
  assert.match(closeAdmission, /session_row\.version = p_expected_version/u);
  assert.match(closeAdmission, /version = session_row\.version \+ 1/u);
  assert.match(closeAdmission, /set admission_code_hmac = null,[\s\S]*admission_open_until = null/u);
  assert.match(closeAdmission, /update public\.live_session_invites invite_row/u);
  assert.match(closeAdmission, /return next_version/u);
  assert.doesNotMatch(closeAdmission, /update public\.viewer_grants/u);
});

test("all new privileged RPCs are service-role only with empty search paths", async () => {
  const sql = await readMigration();
  const publicSignatures = [
    "create_live_session(uuid, text, text, text, text[], integer, text, timestamptz)",
    "update_live_session(uuid, text, integer, text, text, text[], integer, text)",
    "open_live_admission(uuid, text, text, timestamptz, integer)",
    "close_live_admission(uuid, text, integer)",
    "redeem_live_admission(text, text, text, timestamptz, text)",
    "redeem_live_invite(text, text, text, timestamptz, text)",
  ];
  for (const signature of publicSignatures) {
    const escaped = signature.replace(/[()[\]]/gu, "\\$&");
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, "u"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, "u"));
  }
  assert.equal((sql.match(/security definer/gu) ?? []).length, 12);
  assert.equal((sql.match(/set search_path = ''/gu) ?? []).length, 13);
  assert.match(sql, /revoke all on function public\.apply_live_viewer_grant[\s\S]*from public, anon, authenticated, service_role/u);
});
