import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const baseMigrationName = "20260727014000_live_summary_generation_jobs.sql";
const recoveryMigrationName = "20260729235900_live_summary_generation_recovery.sql";
const migrationsUrl = new URL("../supabase/migrations/", import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);

async function readMigration(name) {
  return readFile(new URL(name, migrationsUrl), "utf8");
}

function extractFunction(sql, name) {
  return sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "iu"))?.[0] ?? "";
}

test("summary recovery is a forward-only additive migration after the applied job schema", async () => {
  const migrations = (await readdir(migrationsUrl)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(migrations.indexOf(baseMigrationName) < migrations.indexOf(recoveryMigrationName));
  const sql = await readMigration(recoveryMigrationName);
  assert.doesNotMatch(sql, /\bdrop\s+(?:table|column|type|function)\b|\bdelete\s+from\b|\btruncate\b/iu);
  for (const column of ["attempt_count", "lease_expires_at", "next_retry_at", "retryable"]) {
    assert.match(sql, new RegExp(`add column ${column} `, "iu"), column);
  }
  assert.match(sql, /attempt_count between 1 and 3/iu);
  assert.match(sql, /interval '5 minutes'/iu);
  assert.match(sql, /status = 'failed'[\s\S]*retryable[\s\S]*next_retry_at is not null/iu);
});

test("claim atomically reclaims expired or retry-ready jobs with a fresh bounded token", async () => {
  const claim = extractFunction(await readMigration(recoveryMigrationName), "claim_live_summary_generation");
  assert.match(claim, /pg_advisory_xact_lock/iu);
  assert.match(claim, /job_row\.generation_token[\s\S]*job_row\.attempt_count[\s\S]*job_row\.lease_expires_at[\s\S]*job_row\.next_retry_at[\s\S]*job_row\.retryable/iu);
  assert.match(claim, /job_status = 'running'[\s\S]*job_lease_expires_at > statement_timestamp\(\)[\s\S]*status', 'running'/iu);
  assert.match(claim, /job_attempt_count >= 3[\s\S]*status', 'exhausted'/iu);
  assert.match(claim, /job_retryable is not true[\s\S]*status', 'permanent_failed'/iu);
  assert.match(claim, /claimed_token := extensions\.gen_random_uuid\(\)[\s\S]*generation_token = claimed_token[\s\S]*attempt_count = job_attempt_count \+ 1/iu);
  assert.match(claim, /job_row\.generation_token = job_generation_token[\s\S]*job_row\.attempt_count = job_attempt_count/iu);
  assert.equal((claim.match(/extensions\.gen_random_uuid\(\)/giu) ?? []).length, 2);
});

test("complete and fail reject stale leases and transient failures are explicitly bounded", async () => {
  const sql = await readMigration(recoveryMigrationName);
  const complete = extractFunction(sql, "complete_live_summary_generation");
  const fail = extractFunction(sql, "fail_live_summary_generation");
  for (const rpc of [complete, fail]) {
    assert.match(rpc, /job_row\.generation_token = p_generation_token[\s\S]*job_row\.status = 'running'[\s\S]*job_row\.lease_expires_at > statement_timestamp\(\)/iu);
  }
  for (const errorCode of [
    "SUMMARY_TIMEOUT",
    "SUMMARY_PROVIDER_RATE_LIMITED",
    "SUMMARY_PROVIDER_UNAVAILABLE",
    "SUMMARY_INCOMPLETE",
    "UTTERANCES_READ_FAILED",
    "PARTICIPANT_ACTIVITY_READ_FAILED",
  ]) assert.match(fail, new RegExp(`'${errorCode}'`, "u"));
  for (const permanentCode of ["NO_UTTERANCES", "SUMMARY_REQUEST_REJECTED", "SUMMARY_REFUSED", "SUMMARY_PARSE_FAILED"]) {
    assert.doesNotMatch(fail, new RegExp(`'${permanentCode}'`, "u"));
  }
  assert.match(fail, /retryable = transient_error and job_row\.attempt_count < 3/iu);
  assert.match(fail, /next_retry_at = case[\s\S]*transient_error and job_row\.attempt_count < 3[\s\S]*statement_timestamp\(\)/iu);
});

test("read-only status RPC reports recovery states without tokens or mutation", async () => {
  const readStatus = extractFunction(await readMigration(recoveryMigrationName), "read_live_summary_generation_status");
  for (const status of ["missing", "running", "retryable_failed", "exhausted", "permanent_failed", "ready"]) {
    assert.match(readStatus, new RegExp(`'status', '${status}'`, "u"));
  }
  assert.match(readStatus, /status = 'succeeded'[\s\S]*SUMMARY_READY_MISSING/iu);
  assert.doesNotMatch(readStatus, /\b(?:insert|update|delete)\b|generationToken|generation_token/iu);
});

test("all repaired RPC signatures remain service-role only", async () => {
  const sql = await readMigration(recoveryMigrationName);
  const signatures = [
    "claim_live_summary_generation(uuid, text)",
    "complete_live_summary_generation(uuid, text, uuid, jsonb, text)",
    "fail_live_summary_generation(uuid, text, uuid, text)",
    "read_live_summary_generation_status(uuid, text)",
  ];
  assert.equal((sql.match(/security definer/giu) ?? []).length, 4);
  assert.equal((sql.match(/set search_path = ''/giu) ?? []).length, 4);
  for (const signature of signatures) {
    const escaped = signature.replace(/[()[\]]/gu, "\\$&");
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated, service_role`, "iu"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, "iu"));
  }
});

test("fresh bootstrap contains each late migration once, byte-for-byte, in deployment order", async () => {
  const lateMigrations = [
    "20260727010000_live_optional_participant_identity.sql",
    "20260727011000_live_cover_20mb.sql",
    "20260727012000_host_glossary_presets.sql",
    "20260727013000_host_glossary_presets_coalesce_fix.sql",
    baseMigrationName,
    recoveryMigrationName,
  ];
  const [bootstrap, ...migrationSql] = await Promise.all([
    readFile(bootstrapUrl, "utf8"),
    ...lateMigrations.map(readMigration),
  ]);
  let previousIndex = -1;
  lateMigrations.forEach((name, index) => {
    const marker = `-- ${name}`;
    const markerIndex = bootstrap.indexOf(marker);
    assert.ok(markerIndex > previousIndex, `${name} must follow its dependency`);
    assert.equal(bootstrap.indexOf(marker, markerIndex + marker.length), -1, `${name} must appear once`);
    assert.ok(bootstrap.startsWith(`${marker}\n${migrationSql[index]}`, markerIndex), `${name} must be byte-for-byte`);
    previousIndex = markerIndex;
  });
});
