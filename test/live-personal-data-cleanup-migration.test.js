import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "20260720060633_live_personal_data_cleanup.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

test("personal-data cleanup migration sorts after the canonical session migration", async () => {
  const migrationDirectory = new URL("../supabase/migrations/", import.meta.url);
  const migrations = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const dependencyIndex = migrations.indexOf("20260720040743_live_session_configuration.sql");
  const cleanupIndex = migrations.indexOf(migrationName);
  assert.notEqual(dependencyIndex, -1);
  assert.notEqual(cleanupIndex, -1);
  assert.equal(dependencyIndex < cleanupIndex, true);
});

test("termination deletes viewer identity rows after session and invite locks", async () => {
  const sql = await readMigration();
  const terminate = sql.match(
    /create or replace function public\.terminate_live_session\([\s\S]*?\n\$\$;/u,
  )?.[0];
  assert.ok(terminate);
  assert.match(terminate, /from public\.live_sessions[\s\S]*for update/u);
  assert.match(terminate, /update public\.live_session_invites invite_row/u);
  assert.match(terminate, /delete from public\.viewer_grants[\s\S]*where session_id = p_session_id/u);
  assert.equal(
    terminate.indexOf("from public.live_sessions")
      < terminate.indexOf("update public.live_session_invites invite_row"),
    true,
  );
  assert.equal(
    terminate.indexOf("update public.live_session_invites invite_row")
      < terminate.indexOf("delete from public.viewer_grants"),
    true,
  );
  assert.doesNotMatch(terminate, /update public\.viewer_grants/u);
  assert.match(terminate, /delete from public\.live_snapshots/u);
  assert.match(terminate, /delete from public\.session_speakers/u);
  assert.match(terminate, /return true/u);
});

test("cleanup removes expired, revoked, and stopped-session viewer grants", async () => {
  const sql = await readMigration();
  const cleanup = sql.match(
    /create or replace function public\.cleanup_expired_live_state\(\)[\s\S]*?\n\$\$;/u,
  )?.[0];
  assert.ok(cleanup);
  assert.match(cleanup, /from public\.live_sessions session_lock[\s\S]*order by session_lock\.id[\s\S]*for update/u);
  assert.match(cleanup, /update public\.live_session_invites invite_row/u);
  assert.match(cleanup, /delete from public\.viewer_grants grant_row/u);
  assert.match(cleanup, /grant_row\.revoked_at is not null/u);
  assert.match(cleanup, /grant_row\.expires_at <= statement_timestamp\(\)/u);
  assert.match(cleanup, /session_row\.status = 'stopped'/u);
  assert.equal(
    cleanup.indexOf("update public.live_session_invites invite_row")
      < cleanup.indexOf("delete from public.viewer_grants grant_row"),
    true,
  );
  assert.match(cleanup, /delete from public\.live_session_invites[\s\S]*interval '1 day'/u);
  assert.match(cleanup, /delete from public\.live_rate_limits[\s\S]*interval '1 day'/u);
  assert.match(cleanup, /return stopped_count/u);
  assert.doesNotMatch(cleanup, /delete from public\.live_sessions/u);
});

test("cleanup readiness accepts only an active one-to-five-minute cadence", async () => {
  const sql = await readMigration();
  const verifier = sql.match(
    /create or replace function public\.verify_live_cleanup_schedule\(\)[\s\S]*?\n\$\$;/u,
  )?.[0];
  assert.ok(verifier);
  assert.match(verifier, /job_row\.active is true/u);
  assert.match(verifier, /btrim\(job_row\.command\)[\s\S]*cleanup_expired_live_state/u);
  for (const schedule of ["* * * * *", "*/2 * * * *", "*/3 * * * *", "*/4 * * * *", "*/5 * * * *"]) {
    assert.match(verifier, new RegExp(schedule.replace(/[*/]/gu, "\\$&"), "u"));
  }
  assert.doesNotMatch(verifier, /\*\/([6-9]|[1-9][0-9]+) \* \* \* \*/u);
  assert.match(verifier, /when undefined_table or undefined_column or insufficient_privilege[\s\S]*return false/u);
});

test("cleanup functions remain service-role only and the migration is additive", async () => {
  const sql = await readMigration();
  const signatures = [
    "terminate_live_session(uuid, text)",
    "cleanup_expired_live_state()",
    "verify_live_cleanup_schedule()",
  ];
  for (const signature of signatures) {
    const escaped = signature.replace(/[()]/gu, "\\$&");
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, "u"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, "u"));
  }
  assert.equal((sql.match(/security definer/gu) ?? []).length, 3);
  assert.equal((sql.match(/set search_path = ''/gu) ?? []).length, 3);
  assert.doesNotMatch(sql, /drop (table|column)|truncate/iu);
});
