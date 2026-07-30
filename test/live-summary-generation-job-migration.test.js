import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "20260727014000_live_summary_generation_jobs.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

test("summary generation job migration is additive and registered in the root test glob", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(migrations.indexOf("202607230002_live_call_floor.sql") < migrations.indexOf(migrationName));

  const [sql, packageSource] = await Promise.all([
    readMigration(),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(sql, /\bdrop\s+(?:table|column|type|function)\b|\bdelete\s+from\b|\btruncate\b/iu);
  assert.equal(JSON.parse(packageSource).scripts.test, 'node --test "test/**/*.test.js"');
});

test("private job table has one immutable generation identity per session language", async () => {
  const sql = await readMigration();
  assert.match(sql, /create table public\.live_summary_generation_jobs\s*\(/iu);
  assert.match(sql, /session_id uuid not null references public\.live_sessions\(id\) on delete cascade/iu);
  assert.match(sql, /language text not null/iu);
  assert.match(sql, /primary key \(session_id, language\)/iu);
  assert.match(sql, /status text not null default 'running'/iu);
  assert.match(sql, /status in \('running', 'succeeded', 'failed'\)/iu);
  assert.match(sql, /generation_token uuid not null unique/iu);
  assert.match(sql, /error_code text/iu);
  for (const timestamp of ["created_at", "started_at", "updated_at", "completed_at", "failed_at"]) {
    assert.match(sql, new RegExp(`${timestamp} timestamptz`, "iu"), timestamp);
  }
  assert.match(sql, /public\.live_language_valid\(language\)/iu);
  assert.match(sql, /char_length\(error_code\) between 1 and 120/iu);
  assert.match(sql, /alter table public\.live_summary_generation_jobs enable row level security/iu);
  assert.match(sql, /revoke all on table public\.live_summary_generation_jobs\s+from public, anon, authenticated, service_role/iu);
});

test("claim is stopped-only, idempotent, and serializes one token winner", async () => {
  const sql = await readMigration();
  const claim = sql.match(/create or replace function public\.claim_live_summary_generation\([\s\S]*?\n\$\$;/iu)?.[0] ?? "";
  assert.match(claim, /returns jsonb/iu);
  assert.match(claim, /select session_row\.status[\s\S]*from public\.live_sessions[\s\S]*session_row\.id = p_session_id/iu);
  assert.match(claim, /session_status <> 'stopped'[\s\S]*LIVE_SESSION_NOT_STOPPED/iu);
  assert.match(claim, /from public\.live_meeting_summaries[\s\S]*jsonb_build_object\('ok', true, 'status', 'ready'\)/iu);

  const lockIndex = claim.indexOf("pg_advisory_xact_lock");
  const jobReadIndex = claim.indexOf("from public.live_summary_generation_jobs");
  const tokenIndex = claim.indexOf("extensions.gen_random_uuid()");
  const insertIndex = claim.indexOf("insert into public.live_summary_generation_jobs");
  assert.ok(lockIndex >= 0 && lockIndex < jobReadIndex, "the lane lock must precede the job decision");
  assert.ok(jobReadIndex < tokenIndex && tokenIndex < insertIndex, "only a missing row may allocate and store a token");
  assert.doesNotMatch(claim, /chr\(0\)/iu, "PostgreSQL text cannot contain a zero byte");
  assert.equal((claim.match(/extensions\.gen_random_uuid\(\)/giu) ?? []).length, 1);
  assert.doesNotMatch(claim, /update public\.live_summary_generation_jobs[\s\S]*generation_token\s*=/iu);

  assert.match(claim, /jsonb_build_object\(\s*'ok', true,\s*'status', 'claimed',\s*'generationToken', claimed_token::text\s*\)/iu);
  for (const status of ["ready", "running", "failed"]) {
    assert.match(claim, new RegExp(`jsonb_build_object\\('ok', true, 'status', '${status}'\\)`, "iu"));
  }
  assert.match(claim, /jsonb_build_object\('ok', false, 'code', 'INVALID_SUMMARY_GENERATION_INPUT'\)/iu);
});

test("complete atomically guards the token, stores a bounded summary, and succeeds once", async () => {
  const sql = await readMigration();
  const complete = sql.match(/create or replace function public\.complete_live_summary_generation\([\s\S]*?\n\$\$;/iu)?.[0] ?? "";
  assert.match(complete, /returns boolean/iu);
  assert.match(complete, /public\.live_language_valid\(p_language\) is not true/iu);
  assert.match(complete, /jsonb_typeof\(p_summary\) <> 'object'/iu);
  assert.match(complete, /octet_length\(p_summary::text\) > 65536/iu);
  assert.match(complete, /char_length\(p_model\) not between 1 and 120/iu);

  const updateIndex = complete.indexOf("update public.live_summary_generation_jobs");
  const rowCountIndex = complete.indexOf("GET DIAGNOSTICS affected_count = ROW_COUNT");
  const upsertIndex = complete.indexOf("insert into public.live_meeting_summaries");
  assert.ok(updateIndex >= 0 && updateIndex < rowCountIndex && rowCountIndex < upsertIndex);
  assert.match(complete, /job_row\.generation_token = p_generation_token[\s\S]*job_row\.status = 'running'/iu);
  assert.match(complete, /if affected_count = 0 then\s*return false/iu);
  assert.match(complete, /status = 'succeeded'/iu);
  assert.match(complete, /on conflict \(session_id, language\) do update/iu);
  assert.match(complete, /return true/iu);
});

test("fail is a bounded token compare-and-set and all RPCs are service-only", async () => {
  const sql = await readMigration();
  const fail = sql.match(/create or replace function public\.fail_live_summary_generation\([\s\S]*?\n\$\$;/iu)?.[0] ?? "";
  assert.match(fail, /returns boolean/iu);
  assert.match(fail, /public\.live_language_valid\(p_language\) is not true/iu);
  assert.match(fail, /char_length\(p_error_code\) not between 1 and 120/iu);
  assert.match(fail, /job_row\.generation_token = p_generation_token[\s\S]*job_row\.status = 'running'/iu);
  assert.match(fail, /status = 'failed'/iu);
  assert.match(fail, /error_code = p_error_code/iu);
  assert.match(fail, /return affected_count = 1/iu);

  const signatures = [
    "claim_live_summary_generation(uuid, text)",
    "complete_live_summary_generation(uuid, text, uuid, jsonb, text)",
    "fail_live_summary_generation(uuid, text, uuid, text)",
  ];
  for (const signature of signatures) {
    const escaped = signature.replace(/[()[\]]/gu, "\\$&");
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated, service_role`, "iu"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, "iu"));
  }
  assert.equal((sql.match(/security definer/giu) ?? []).length, 3);
  assert.equal((sql.match(/set search_path = ''/giu) ?? []).length, 3);
});
