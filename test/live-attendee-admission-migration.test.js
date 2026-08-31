import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationName = "202608150001_live_attendee_admission.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);
const local64 = "a".repeat(64);
const local65 = "a".repeat(65);
const label63 = "b".repeat(63);
const label64 = "b".repeat(64);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

function extractFunctionBody(sql, functionName) {
  const match = sql.match(new RegExp(`create or replace function public\\.${functionName}\\([\\s\\S]*?\\n\\$\\$;`, "iu"));
  assert.ok(match, `${functionName} body exists`);
  return match[0];
}

function mirrorsSqlEmailBoundary(email) {
  const normalizedEmail = email.trim().normalize("NFC").toLowerCase();
  if (email !== normalizedEmail || normalizedEmail.length > 254 || /[\s<>]/u.test(normalizedEmail)) {
    return false;
  }
  if ((normalizedEmail.match(/@/gu) ?? []).length !== 1) {
    return false;
  }
  const [localPart, domainPart] = normalizedEmail.split("@");
  if (
    localPart.length < 1 ||
    localPart.length > 64 ||
    domainPart.length > 253 ||
    domainPart.length < 3 ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..") ||
    !/^[\p{L}\p{N}\p{M}!#$%&'*+/=?^_`{|}~.-]+$/u.test(localPart)
  ) {
    return false;
  }
  const labels = domainPart.split(".");
  return labels.length >= 2 && labels.every((label) => (
    label.length >= 1 &&
    label.length <= 63 &&
    !label.startsWith("-") &&
    !label.endsWith("-") &&
    /^[\p{L}\p{N}\p{M}-]+$/u.test(label)
  ));
}

test("attendee admission adds nullable canonical delivery fields without storing original input", async () => {
  const sql = await readMigration();
  assert.match(sql, /alter table public\.live_participants[\s\S]*add column if not exists email text[\s\S]*add column if not exists company text[\s\S]*add column if not exists summary_consent_at timestamptz/iu);
  assert.match(sql, /email is null or public\.is_valid_live_attendee_email\(email\)/iu);
  assert.match(sql, /company is null or \([\s\S]*char_length\(company\) between 1 and 100[\s\S]*company = normalize\(btrim\(company\), NFC\)/iu);
  assert.doesNotMatch(sql, /original_email|raw_email|input_email|p_display_name/iu);
});

test("attendee email validator matches canonical TS boundary cases", async () => {
  const sql = await readMigration();
  assert.deepEqual([
    [".a@example.com", false],
    ["a..b@example.com", false],
    ["홍길동@example.com", true],
    ["café@example.com".normalize("NFC"), true],
    ["a@도메인.example", true],
    ["a@exa<mple.com", false],
    [`${local64}@example.com`, true],
    [`${local65}@example.com`, false],
    [`a@${label63}.com`, true],
    [`a@${label64}.com`, false],
  ].map(([email, expected]) => [email, mirrorsSqlEmailBoundary(String(email)) === expected]), [
    [".a@example.com", true],
    ["a..b@example.com", true],
    ["홍길동@example.com", true],
    ["café@example.com".normalize("NFC"), true],
    ["a@도메인.example", true],
    ["a@exa<mple.com", true],
    [`${local64}@example.com`, true],
    [`${local65}@example.com`, true],
    [`a@${label63}.com`, true],
    [`a@${label64}.com`, true],
  ]);
  assert.match(sql, /create or replace function public\.is_valid_live_attendee_email\(\s*p_email text\s*\)/iu);
  assert.match(sql, /create or replace function public\.is_valid_live_attendee_email_atom\(\s*p_value text,\s*p_allow_local_symbols boolean\s*\)/iu);
  assert.match(sql, /codepoint between 48 and 57[\s\S]*or codepoint between 65 and 90[\s\S]*or codepoint between 97 and 122/iu);
  assert.doesNotMatch(sql, /\[:alnum:\]/iu);
  assert.match(sql, /char_length\(local_part\) not between 1 and 64/iu);
  assert.match(sql, /char_length\(domain_part\) > 253/iu);
  assert.match(sql, /array_length\(domain_labels, 1\) < 2/iu);
  assert.match(sql, /local_part like '\.%'[\s\S]*or local_part like '%\.'[\s\S]*or local_part like '%\.\.%'/iu);
  assert.match(sql, /label_text like '-%'[\s\S]*or label_text like '%-'/iu);
  assert.match(sql, /char_length\(label_text\) not between 1 and 63/iu);
  assert.match(sql, /length\(normalized_email\) - length\(replace\(normalized_email, '@', ''\)\) <> 1/iu);
  assert.match(sql, /not public\.is_valid_live_attendee_email_atom\(local_part, true\)/iu);
  assert.match(sql, /not public\.is_valid_live_attendee_email_atom\(label_text, false\)/iu);
  assert.match(sql, /public\.is_valid_live_attendee_email\(normalized_email\)/iu);
});

test("attendee admission masks public labels server-side and keeps consent monotonic", async () => {
  const sql = await readMigration();
  assert.match(sql, /create or replace function public\.mask_live_attendee_email\(\s*p_email text\s*\)/iu);
  assert.match(sql, /split_part\(p_email, '@', 1\)/iu);
  assert.match(sql, /create or replace function public\.apply_live_attendee_grant\(/iu);
  assert.match(sql, /p_summary_consent boolean/iu);
  assert.match(sql, /public\.apply_live_viewer_grant\([\s\S]*public\.mask_live_attendee_email\(normalized_email\)/iu);
  assert.match(sql, /summary_consent_at = case[\s\S]*when p_summary_consent is true[\s\S]*coalesce\(participant_row\.summary_consent_at, statement_timestamp\(\)\)[\s\S]*else participant_row\.summary_consent_at/iu);
  assert.match(sql, /resolved_display_name := public\.mask_live_attendee_email\(normalized_email\)/iu);
});

test("attendee email mask is capped to the TypeScript-compatible 40-codepoint policy", async () => {
  const sql = await readMigration();
  assert.match(sql, /char_length\(masked_email\) <= 40[\s\S]*return masked_email/iu);
  assert.match(sql, /return left\(local_part, 1\) \|\| '\*\*\*@' \|\| left\(domain_part, 34\) \|\| '…'/iu);
  assert.doesNotMatch(sql, /return left\(local_part, 1\) \|\| '\*\*\*@' \|\| domain_part;/iu);
});

test("attendee consent does not carry over when the canonical email changes", async () => {
  const sql = await readMigration();
  assert.match(sql, /summary_consent_at = case[\s\S]*when participant_row\.email is distinct from normalized_email[\s\S]*and p_summary_consent is true[\s\S]*then statement_timestamp\(\)[\s\S]*when participant_row\.email is distinct from normalized_email[\s\S]*then null[\s\S]*when p_summary_consent is true[\s\S]*then coalesce\(participant_row\.summary_consent_at, statement_timestamp\(\)\)[\s\S]*else participant_row\.summary_consent_at/iu);
});

test("attendee admission redeems exactly one HMAC credential through one atomic RPC", async () => {
  const sql = await readMigration();
  assert.match(sql, /create or replace function public\.redeem_live_attendee_v1\(/iu);
  assert.match(sql, /p_invite_token_hmac text,[\s\S]*p_code_hmac text/iu);
  assert.match(sql, /\(p_invite_token_hmac is null\) = \(p_code_hmac is null\)/iu);
  assert.match(sql, /p_invite_token_hmac !~ '\^\[0-9a-f\]\{64\}\$'/iu);
  assert.match(sql, /p_code_hmac !~ '\^\[0-9a-f\]\{64\}\$'/iu);
  assert.match(sql, /public\.lock_live_invite_session\(p_invite_token_hmac\)/iu);
  assert.match(sql, /where admission_code_hmac = p_code_hmac[\s\S]*for update/iu);
  assert.match(sql, /public\.apply_live_attendee_grant\(/iu);
  assert.doesNotMatch(sql, /admission_code_plain|plaintext|p_admission_code text/iu);
});

test("attendee restore is read-only, authorized, and returns the redemption-shaped self grant", async () => {
  const sql = await readMigration();
  const restoreBody = extractFunctionBody(sql, "restore_live_attendee_v1");
  assert.match(sql, /create or replace function public\.restore_live_attendee_v1\(\s*p_grant_id uuid,\s*p_session_id uuid,\s*p_user_id text\s*\)/iu);
  assert.match(restoreBody, /from public\.viewer_grants grant_row[\s\S]*join public\.live_sessions session_row[\s\S]*join public\.live_participants participant_row/iu);
  assert.match(restoreBody, /grant_row\.id = p_grant_id[\s\S]*grant_row\.session_id = p_session_id[\s\S]*grant_row\.user_id = p_user_id[\s\S]*grant_row\.revoked_at is null[\s\S]*grant_row\.expires_at > statement_timestamp\(\)/iu);
  assert.match(restoreBody, /participant_row\.grant_id = grant_row\.id[\s\S]*participant_row\.session_id = p_session_id[\s\S]*participant_row\.user_id = p_user_id[\s\S]*participant_row\.email is not null/iu);
  assert.match(restoreBody, /session_row\.status in \('preparing', 'live', 'paused'\)/iu);
  assert.match(restoreBody, /message = 'VIEWER_RESTORE_FORBIDDEN'/u);
  assert.match(restoreBody, /display_name := public\.mask_live_attendee_email\(restore_row\.email\)/iu);
  assert.match(restoreBody, /viewer_count := restore_row\.viewer_count/iu);
  assert.doesNotMatch(restoreBody, /\bfor\s+update\b|\binsert\s+into\b|\bupdate\s+public\b|\bdelete\s+from\b/iu);
});

test("attendee admission extends the owner-checked roster RPC with nullable delivery fields", async () => {
  const sql = await readMigration();
  assert.match(sql, /create or replace function public\.read_live_participant_roster\(\s*p_session_id uuid,\s*p_host_id text\s*\)/iu);
  assert.match(sql, /session_row\.host_id = p_host_id/iu);
  assert.match(sql, /returns table \([\s\S]*display_name text,[\s\S]*email text,[\s\S]*company text,[\s\S]*department text,[\s\S]*job_title text,[\s\S]*summary_consent_at timestamptz,[\s\S]*retention_expires_at timestamptz/iu);
  assert.match(sql, /participant_row\.display_name,[\s\S]*participant_row\.email,[\s\S]*participant_row\.company,[\s\S]*participant_row\.department,[\s\S]*participant_row\.job_title,[\s\S]*participant_row\.summary_consent_at,[\s\S]*participant_row\.joined_at/iu);
  assert.match(sql, /order by participant_row\.joined_at, participant_row\.id/iu);
  assert.doesNotMatch(sql, /from public\.live_participant_profiles|join public\.live_participant_profiles|select \* from public\.live_participants/iu);
});

test("attendee admission keeps RPCs service-role only and mirrors into bootstrap", async () => {
  const [sql, bootstrap] = await Promise.all([readMigration(), readFile(bootstrapUrl, "utf8")]);
  for (const signature of [
    "is_valid_live_attendee_email(text)",
    "is_valid_live_attendee_email_atom(text, boolean)",
    "mask_live_attendee_email(text)",
    "apply_live_attendee_grant(uuid, text, text, timestamptz, text, text, text, text, boolean)",
    "redeem_live_attendee_v1(text, text, text, text, timestamptz, text, text, text, text, boolean)",
    "restore_live_attendee_v1(uuid, uuid, text)",
    "read_live_participant_roster(uuid, text)",
  ]) {
    const escaped = signature
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll(", ", ",\\s*")
      .replace("\\(", "\\(\\s*")
      .replace("\\)", "\\s*\\)");
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, "iu"), signature);
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, "iu"), signature);
  }
  assert.match(bootstrap, new RegExp(`supabase/migrations/${migrationName}`, "u"));
  assert.match(bootstrap, /create or replace function public\.redeem_live_attendee_v1\(/iu);
  assert.match(bootstrap, /create or replace function public\.restore_live_attendee_v1\(/iu);
});
