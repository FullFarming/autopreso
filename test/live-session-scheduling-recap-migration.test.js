import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "202607230003_live_scheduling_recap.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

test("scheduling migration follows the live call floor and preserves existing columns and tables", async () => {
  const migrationDirectory = new URL("../supabase/migrations/", import.meta.url);
  const migrations = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const dependencyIndex = migrations.indexOf("202607230002_live_call_floor.sql");
  const migrationIndex = migrations.indexOf(migrationName);
  assert.notEqual(dependencyIndex, -1);
  assert.notEqual(migrationIndex, -1);
  assert.equal(dependencyIndex < migrationIndex, true);

  const sql = await readMigration();
  assert.doesNotMatch(sql, /drop\s+(column|table|type)|truncate/iu);
  assert.match(sql, /add column if not exists title text/iu);
  assert.match(sql, /add column if not exists scheduled_at timestamptz/iu);
  assert.match(sql, /title is null[\s\S]*char_length\(title\) between 1 and 120/iu);
  assert.match(sql, /scheduled_at <= created_at \+ interval '30 days'/iu);
});

test("new create and update overloads expose title and schedule without replacing legacy signatures", async () => {
  const sql = await readMigration();
  assert.match(sql, /create or replace function public\.create_live_session\([\s\S]*p_title text,[\s\S]*p_scheduled_at timestamptz,[\s\S]*p_expires_at timestamptz[\s\S]*returns table[\s\S]*title text,[\s\S]*scheduled_at timestamptz/iu);
  assert.match(sql, /create or replace function public\.update_live_session\([\s\S]*p_title text,[\s\S]*p_scheduled_at timestamptz[\s\S]*returns table[\s\S]*title text,[\s\S]*scheduled_at timestamptz/iu);
  assert.doesNotMatch(sql, /drop function public\.(create_live_session|update_live_session)/iu);
  assert.match(sql, /p_scheduled_at > statement_timestamp\(\) \+ interval '30 days'/iu);
  assert.match(sql, /greatest\(statement_timestamp\(\), coalesce\(p_scheduled_at, statement_timestamp\(\)\)\)/iu);
});

test("host start is an optimistic preparing-to-live transition and remains service-role only", async () => {
  const sql = await readMigration();
  const start = sql.match(
    /create or replace function public\.start_live_session\([\s\S]*?\n\$\$;/u,
  )?.[0];
  assert.ok(start);
  assert.match(start, /session_row\.status = 'preparing'/u);
  assert.match(start, /session_row\.version = p_expected_version/u);
  assert.match(start, /set status = 'live'[\s\S]*version = session_row\.version \+ 1/iu);
  assert.match(start, /VERSION_CONFLICT_OR_FORBIDDEN/u);
  assert.match(sql, /revoke all on function public\.start_live_session\(uuid, text, integer\)[\s\S]*from public, anon, authenticated/iu);
  assert.match(sql, /grant execute on function public\.start_live_session\(uuid, text, integer\)[\s\S]*to service_role/iu);
});

test("viewer leave locks session before grant, releases an owned floor, and deletes personal grant data", async () => {
  const sql = await readMigration();
  const leave = sql.match(
    /create or replace function public\.leave_live_session\([\s\S]*?\n\$\$;/u,
  )?.[0];
  assert.ok(leave);
  assert.match(leave, /from public\.live_sessions[\s\S]*for update/u);
  assert.match(leave, /from public\.viewer_grants[\s\S]*for update/u);
  assert.equal(leave.indexOf("from public.live_sessions") < leave.indexOf("from public.viewer_grants"), true);
  assert.match(leave, /floor_grant_id = null/iu);
  assert.match(leave, /delete from public\.viewer_grants/iu);
  assert.match(sql, /revoke all on function public\.leave_live_session\(uuid, uuid, text\)[\s\S]*from public, anon, authenticated/iu);
  assert.match(sql, /grant execute on function public\.leave_live_session\(uuid, uuid, text\)[\s\S]*to service_role/iu);
});

test("QR-only invite admission supports a preparing waiting room and returns attendee metadata", async () => {
  const sql = await readMigration();
  const inviteCreate = sql.match(
    /create or replace function public\.create_live_invite\(\s*p_session_id uuid,\s*p_host_id text,\s*p_token_hmac text,\s*p_expires_at timestamptz\s*\)[\s\S]*?\n\$\$;/u,
  )?.[0];
  const inviteLock = sql.match(
    /create or replace function public\.lock_live_invite_session\(p_token_hmac text\)[\s\S]*?\n\$\$;/u,
  )?.[0];
  const redemption = sql.match(
    /create or replace function public\.redeem_live_invite_v2\([\s\S]*?\n\$\$;/u,
  )?.[0];
  assert.ok(inviteCreate);
  assert.ok(inviteLock);
  assert.ok(redemption);
  assert.doesNotMatch(inviteCreate, /admission_open_until/u);
  assert.doesNotMatch(inviteLock, /admission_open_until/u);
  assert.match(inviteLock, /session_row\.status not in \('preparing', 'live'\)/u);
  assert.match(redemption, /voice_provider text,[\s\S]*status text,[\s\S]*title text,[\s\S]*scheduled_at timestamptz/iu);
  assert.match(redemption, /public\.apply_live_viewer_grant/iu);
  assert.match(redemption, /voice_provider := session_row\.voice_provider/iu);
  assert.match(sql, /grant execute on function public\.redeem_live_invite_v2\(text, text, text, timestamptz, text\)[\s\S]*to service_role/iu);
});

test("recap access stores no device hash, expires after 30 days, and is RLS-limited to host or participant", async () => {
  const sql = await readMigration();
  assert.match(sql, /create table public\.live_recap_grants/iu);
  assert.doesNotMatch(
    sql.match(/create table public\.live_recap_grants[\s\S]*?\n\);/iu)?.[0] ?? "",
    /device_hash|display_name/iu,
  );
  assert.match(sql, /expires_at <= created_at \+ interval '30 days'/iu);
  assert.match(sql, /alter table public\.live_recap_grants enable row level security/iu);
  assert.match(sql, /user_id = \(select auth\.uid\(\)\)::text/iu);
  assert.match(sql, /create policy live_utterances_recap_select/iu);
  assert.match(sql, /create policy live_meeting_summaries_recap_select/iu);
  assert.match(sql, /insert into public\.live_recap_grants[\s\S]*from public\.viewer_grants/iu);
  assert.match(sql, /delete from public\.live_recap_grants[\s\S]*expires_at <= statement_timestamp\(\)/iu);
  assert.match(sql, /delete from public\.live_utterances[\s\S]*interval '30 days'/iu);
  assert.match(sql, /delete from public\.live_meeting_summaries[\s\S]*interval '30 days'/iu);
});
