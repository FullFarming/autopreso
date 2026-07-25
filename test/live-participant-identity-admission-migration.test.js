import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/202607230004_live_participant_identity_admission.sql",
  import.meta.url,
);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

test("participant identity is additive, nullable for legacy grants, and retained in a host-only roster", async () => {
  const sql = await readMigration();
  assert.match(sql, /alter table public\.viewer_grants[\s\S]*add column if not exists department text[\s\S]*add column if not exists job_title text/iu);
  assert.match(sql, /create table public\.live_participants/iu);
  assert.match(sql, /grant_id uuid not null/iu);
  assert.match(sql, /department text/iu);
  assert.match(sql, /job_title text/iu);
  assert.match(sql, /left_at timestamptz/iu);
  assert.match(sql, /utterance_count integer not null default 0/iu);
  assert.match(sql, /speaking_seconds numeric\(12, 3\) not null default 0/iu);
  assert.match(sql, /alter table public\.live_participants enable row level security/iu);
  assert.match(sql, /create policy live_participants_host_select[\s\S]*session_row\.host_id = \(select auth\.uid\(\)\)::text/iu);
  assert.doesNotMatch(sql, /alter column (department|job_title) set not null/iu);
});

test("six-digit admission remains HMAC-only, session-scoped, and immutable until end or expiry", async () => {
  const sql = await readMigration();
  assert.match(sql, /add column if not exists admission_generation bigint not null default 0/iu);
  assert.match(sql, /add column if not exists admission_state text not null default 'uninitialized'/iu);
  assert.match(sql, /p_code_hmac !~ '\^\[0-9a-f\]\{64\}\$'/u);
  assert.match(sql, /admission_code_hmac ~ '\^\[0-9a-f\]\{64\}\$'/u);
  assert.doesNotMatch(sql, /admission_code_plain|plaintext|p_admission_code text/iu);
  assert.match(sql, /ADMISSION_CODE_IMMUTABLE/u);
  assert.match(sql, /new\.status = 'stopped'[\s\S]*new\.admission_state := 'ended'/iu);
  assert.match(sql, /new\.admission_code_hmac := null/iu);
  assert.match(sql, /new\.admission_generation := old\.admission_generation \+ 1/iu);
});

test("pause preserves the code while reopen accepts only the original HMAC", async () => {
  const sql = await readMigration();
  const open = sql.match(/create or replace function public\.open_live_admission\([\s\S]*?\n\$\$;/u)?.[0] ?? "";
  const close = sql.match(/create or replace function public\.close_live_admission\([\s\S]*?\n\$\$;/u)?.[0] ?? "";
  assert.match(open, /admission_code_hmac is not null[\s\S]*admission_code_hmac <> p_code_hmac[\s\S]*ADMISSION_CODE_IMMUTABLE/iu);
  assert.match(open, /admission_state = 'open'/u);
  assert.match(open, /session_row\.version <> p_expected_version[\s\S]*session_row\.admission_code_hmac = p_code_hmac[\s\S]*return session_row\.version/iu);
  assert.doesNotMatch(open, /update public\.live_session_invites/iu);
  assert.match(close, /else 'paused'/u);
  assert.doesNotMatch(close, /admission_code_hmac = null/iu);
  assert.doesNotMatch(close, /update public\.live_session_invites/iu);
  assert.doesNotMatch(close, /status = 'stopped'|ended_at =/iu);
});

test("code and QR redemption both persist the full participant identity", async () => {
  const sql = await readMigration();
  assert.match(sql, /create or replace function public\.redeem_live_admission_v3\(/u);
  assert.match(sql, /create or replace function public\.redeem_live_invite_v3\(/u);
  assert.match(sql, /p_display_name text,\s*p_department text,\s*p_job_title text/iu);
  assert.match(sql, /public\.apply_live_viewer_grant\([\s\S]*p_department, p_job_title/iu);
  assert.match(sql, /participant_id uuid,[\s\S]*department text,[\s\S]*job_title text/iu);
  assert.match(sql, /session_row\.admission_state <> 'open'/iu);
});

test("join, leave, speaking, and utterances preserve recap-grade participant activity", async () => {
  const sql = await readMigration();
  assert.match(sql, /create table public\.live_participant_events/iu);
  assert.match(sql, /event_type text not null[\s\S]*\('joined', 'left', 'speak_started', 'speak_ended'\)/iu);
  assert.match(sql, /create trigger viewer_grants_participant_leave_before_delete/iu);
  assert.match(sql, /create or replace function public\.take_live_floor\(/u);
  assert.match(sql, /'speak_started'/u);
  assert.match(sql, /session_row\.floor_grant_id is distinct from p_grant_id/iu);
  assert.match(sql, /'participantId', participant_row\.id/u);
  assert.match(sql, /create or replace function public\.release_live_floor\(/u);
  assert.match(sql, /'speak_ended'/u);
  assert.match(sql, /add column if not exists participant_id uuid/iu);
  assert.match(sql, /add column if not exists source_started_at timestamptz/iu);
  assert.match(sql, /create or replace function public\.persist_live_utterance_if_active\([\s\S]*p_source_started_at timestamptz[\s\S]*p_participant_id uuid/iu);
  assert.match(sql, /utterance_count = participant_target\.utterance_count \+ 1/iu);
  assert.match(sql, /p_source_ended_at - p_source_started_at <= interval '1 hour'/iu);
  assert.match(sql, /speaking_seconds = participant_target\.speaking_seconds \+ speech_seconds/iu);
  assert.match(sql, /existing_utterance\.participant_id = p_participant_id[\s\S]*existing_utterance\.seq = p_seq[\s\S]*existing_utterance\.language <> p_language/iu);
});

test("participant retention is bounded to 30 days and cleanup is scheduled", async () => {
  const sql = await readMigration();
  assert.match(sql, /retention_expires_at <= greatest\(left_at, last_seen_at\) \+ interval '30 days'/iu);
  assert.match(sql, /create or replace function public\.cleanup_expired_live_participants\(\)/u);
  assert.match(sql, /delete from public\.live_participants[\s\S]*retention_expires_at <= statement_timestamp\(\)/iu);
  assert.match(sql, /realtime-noel-live-participant-cleanup/u);
});

test("host roster access is ownership checked and service-role mediated", async () => {
  const sql = await readMigration();
  assert.match(sql, /create or replace function public\.read_live_participant_roster\(/iu);
  assert.match(sql, /session_row\.host_id = p_host_id/iu);
  assert.match(sql, /message = 'HOST_ACCESS_REQUIRED'/u);
  assert.match(sql, /participant_row\.retention_expires_at > statement_timestamp\(\)/iu);
});

test("all participant RPCs remain service-role only with empty search paths", async () => {
  const sql = await readMigration();
  for (const signature of [
    "open_live_admission(uuid, text, text, timestamptz, integer)",
    "close_live_admission(uuid, text, integer)",
    "redeem_live_admission_v3(text, text, text, timestamptz, text, text, text)",
    "redeem_live_invite_v3(text, text, text, timestamptz, text, text, text)",
    "read_live_participant_roster(uuid, text)",
    "take_live_floor(uuid, uuid)",
    "release_live_floor(uuid, uuid)",
    "persist_live_utterance_if_active(uuid, text, bigint, text, text, text, timestamptz, timestamptz, timestamptz, uuid)",
    "cleanup_expired_live_participants()",
  ]) {
    const flexibleSignature = signature
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll(", ", ",\\s*")
      .replace("\\(", "\\(\\s*")
      .replace("\\)", "\\s*\\)");
    assert.match(sql, new RegExp(`revoke all on function public\\.${flexibleSignature}[\\s\\S]*?from public, anon, authenticated`, "iu"), signature);
    assert.match(sql, new RegExp(`grant execute on function public\\.${flexibleSignature}[\\s\\S]*?to service_role`, "iu"), signature);
  }
  const functionBodies = sql.match(
    /create or replace function public\.[\s\S]*?\n\$\$;/giu,
  ) ?? [];
  for (const functionBody of functionBodies) {
    if (/security definer/iu.test(functionBody)) {
      assert.match(functionBody, /set search_path = ''/u);
    }
  }
});
