import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/202607200001_live_session_invites.sql", import.meta.url);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

test("invite migration stores only one HMAC invite per session behind RLS", async () => {
  const sql = await readMigration();
  assert.match(sql, /create table public\.live_session_invites/u);
  assert.match(sql, /session_id uuid primary key/u);
  assert.match(sql, /token_hmac text not null unique/u);
  assert.match(sql, /check \(token_hmac ~ '\^\[0-9a-f\]\{64\}\$'\)/u);
  assert.match(sql, /alter table public\.live_session_invites enable row level security/u);
  assert.match(sql, /revoke all on table public\.live_session_invites[\s\S]*from public, anon, authenticated, service_role/u);
  assert.doesNotMatch(sql, /raw_token|token_plaintext|voiceprint|embedding|\bbytea\b/iu);
});

test("invite RPCs are locked, generation-bound, and service-role only", async () => {
  const sql = await readMigration();
  for (const signature of [
    "create_live_invite(uuid, text, text, timestamptz, timestamptz)",
    "resolve_live_invite_rate_key(text)",
    "redeem_live_invite(text, text, text, timestamptz)",
  ]) {
    const escaped = signature.replace(/[()]/gu, "\\$&");
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*from public, anon, authenticated`, "u"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*to service_role`, "u"));
  }
  assert.equal((sql.match(/security definer/gu) ?? []).length >= 7, true);
  assert.equal((sql.match(/set search_path = ''/gu) ?? []).length >= 7, true);
  assert.equal((sql.match(/for update/gu) ?? []).length >= 5, true);
  assert.equal((sql.match(/p_token_hmac is null/gu) ?? []).length, 3);
  assert.match(sql, /p_device_hash is null[\s\S]*p_device_hash !~ '\^\[0-9a-f\]\{64\}\$'/u);
  assert.match(sql, /session_row\.admission_open_until is not distinct from p_admission_open_until/u);
  assert.match(sql, /p_admission_open_until <= statement_timestamp\(\)/u);
  assert.match(sql, /p_expires_at > p_admission_open_until/u);
  assert.match(sql, /p_expires_at > session_row\.expires_at/u);
  assert.match(sql, /active_count >= 50/u);
});

test("admission close, termination, and cleanup revoke invites", async () => {
  const sql = await readMigration();
  assert.match(sql, /create or replace function public\.close_live_admission/u);
  assert.match(sql, /create or replace function public\.terminate_live_session/u);
  assert.match(sql, /create or replace function public\.cleanup_expired_live_state/u);
  assert.equal((sql.match(/update public\.live_session_invites/gu) ?? []).length >= 4, true);
  assert.match(sql, /revoked_at = coalesce\(invite_row\.revoked_at, statement_timestamp\(\)\)/u);
  assert.match(sql, /delete from public\.live_session_invites[\s\S]*revoked_at < statement_timestamp\(\) - interval '1 day'/u);
});

test("reopening admission revokes the previous invite before a replacement is created", async () => {
  const sql = await readMigration();
  const openFunction = sql.match(
    /create or replace function public\.open_live_admission\([\s\S]*?\n\$\$;/u,
  )?.[0];
  assert.ok(openFunction);
  assert.match(openFunction, /from public\.live_sessions[\s\S]*for update/u);
  assert.match(openFunction, /set admission_code_hmac = p_code_hmac/u);
  assert.match(openFunction, /update public\.live_session_invites invite_row[\s\S]*set revoked_at = coalesce/u);
  assert.equal(
    openFunction.indexOf("set admission_code_hmac = p_code_hmac")
      < openFunction.indexOf("update public.live_session_invites invite_row"),
    true,
  );
});
test("cleanup locks affected sessions before invites and grants", async () => {
  const sql = await readMigration();
  const cleanupFunction = sql.match(
    /create or replace function public\.cleanup_expired_live_state\(\)[\s\S]*?\n\$\$;/u,
  )?.[0];
  assert.ok(cleanupFunction);
  assert.match(cleanupFunction, /from public\.live_sessions session_lock[\s\S]*order by session_lock\.id[\s\S]*for update/u);
  assert.equal(
    cleanupFunction.indexOf("from public.live_sessions session_lock")
      < cleanupFunction.indexOf("update public.live_session_invites invite_row"),
    true,
  );
  assert.equal(
    cleanupFunction.indexOf("update public.live_session_invites invite_row")
      < cleanupFunction.indexOf("update public.viewer_grants"),
    true,
  );
});
