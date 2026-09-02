import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const name = '202609020001_live_summary_generic_failure_retry.sql';
const readMigration = (file) => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');

test('generic-failure recovery extends the transient list and host reset without destroying job history', async () => {
  const migrations = (await readdir(new URL('../supabase/migrations/', import.meta.url)))
    .filter((file) => file.endsWith('.sql')).sort();
  assert.ok(migrations.indexOf('20260729235900_live_summary_generation_recovery.sql') < migrations.indexOf(name));
  const sql = await readMigration(name);
  assert.doesNotMatch(sql, /\b(?:drop table|drop column|drop function|truncate|delete from)\b/iu);
  // The deployed transient list survives (including the configuration repair
  // shipped separately); only the catch-all codes are added.
  for (const code of ['SUMMARY_NOT_CONFIGURED', 'SUMMARY_TIMEOUT', 'SUMMARY_PROVIDER_RATE_LIMITED',
    'SUMMARY_PROVIDER_UNAVAILABLE', 'SUMMARY_INCOMPLETE', 'UTTERANCES_READ_FAILED',
    'PARTICIPANT_ACTIVITY_READ_FAILED', 'SUMMARY_FAILED', 'SUMMARY_READY_MISSING', 'SUMMARY_COMPLETE_FAILED']) {
    assert.match(sql, new RegExp(`'${code}'`, 'u'));
  }
  assert.doesNotMatch(sql, /transient_error := p_error_code in \([^)]*'NO_UTTERANCES'/su,
    'an empty record must stay non-transient so it is never retried as a failure');
  // Every fail-RPC fence stays: token, running status, and a live lease.
  assert.match(sql, /job_row\.generation_token = p_generation_token[\s\S]*job_row\.status = 'running'[\s\S]*job_row\.lease_expires_at > statement_timestamp\(\)/u);
  assert.match(sql, /attempt_count between 0 and 3/u, 'the reset lane needs zero while the cap of three stays');
  assert.match(sql, /error_code = 'SUMMARY_HOST_RESET'/u,
    'the failed-row state check forbids a null error code, so the reset records its own reason');
  // Empty is terminal: a reset would turn "nothing was said" into a retryable
  // failure, and only a fresh POST may re-evaluate the utterances.
  assert.match(sql, /job_row\.status = 'failed'\s*\n?\s*and job_row\.error_code <> 'NO_UTTERANCES'/u,
    'the reset predicate must exclude an empty lane');
  // The RPC itself is repeatable; the only bound is the route's rate limit.
  assert.match(sql, /bounded by the per-host-session summary rate limit/u);
  assert.doesNotMatch(sql, /failed job once\b/u, 'the header must not claim a one-shot guard the SQL does not enforce');
  assert.match(sql, /'NO_UTTERANCES' then\s*\n\s*return jsonb_build_object\('ok', true, 'status', 'empty'\)/u);
  assert.match(sql, /create or replace function public\.reset_live_summary_generation_v1\(\s*p_session_id uuid,\s*p_language text,\s*p_host_id text\s*\)[\s\S]*security definer[\s\S]*set search_path = ''/u);
  assert.match(sql, /session_row\.host_id = p_host_id[\s\S]*session_row\.status in \('stopped', 'failed'\)/u);
  assert.match(sql, /revoke all on function public\.reset_live_summary_generation_v1\(uuid, text, text\)\s*\n\s*from public, anon, authenticated, service_role;/u);
  assert.match(sql, /grant execute on function public\.reset_live_summary_generation_v1\(uuid, text, text\)\s*\n\s*to service_role;/u);
});

test('a generic failure is reclaimable and only the owning host can reset an exhausted lane', {
  skip: !process.env.NOVA_PGLITE_MODULE && 'Set NOVA_PGLITE_MODULE for isolated PostgreSQL validation',
}, async (t) => {
  const { PGlite } = await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`create schema extensions;create role anon;create role authenticated;create role service_role;
    create function extensions.gen_random_uuid() returns uuid language sql as 'select gen_random_uuid()';
    create function public.live_language_valid(text) returns boolean language sql as 'select $1 in (''ko'',''en'')';
    create table live_sessions(id uuid primary key,status text,host_id text);
    create table live_meeting_summaries(session_id uuid,language text,summary jsonb,model text,created_at timestamptz,unique(session_id,language));`);
  // Every summary migration that precedes this one, in filename order, so the
  // test runs against the same function history a real database carries
  // (including 202609010005, whose transient list this one supersedes).
  const priorSummaryMigrations = (await readdir(new URL('../supabase/migrations/', import.meta.url)))
    .filter((file) => file.endsWith('.sql') && file.includes('live_summary')).sort()
    .filter((file) => file < name);
  assert.ok(priorSummaryMigrations.includes('202609010005_live_summary_configuration_retry.sql'));
  assert.equal(priorSummaryMigrations.at(-1), '202609010005_live_summary_configuration_retry.sql');
  for (const file of priorSummaryMigrations) await db.exec(await readMigration(file));
  await db.exec(await readMigration(name));
  await db.exec(await readMigration(name));
  const session = '50000000-0000-4000-8000-000000000001';
  await db.query("insert into live_sessions values($1,'stopped','host-owner')", [session]);
  const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
  const claim = (language = 'ko') => scalar('select public.claim_live_summary_generation($1,$2) value', [session, language]);
  const fail = (token, code, language = 'ko') => scalar('select public.fail_live_summary_generation($1,$2,$3,$4) value', [session, language, token, code]);
  const status = (language = 'ko') => scalar('select public.read_live_summary_generation_status($1,$2) value', [session, language]);
  const reset = (hostId, language = 'ko') => scalar('select public.reset_live_summary_generation_v1($1,$2,$3) value', [session, language, hostId]);
  const attempts = (language = 'ko') => scalar('select attempt_count value from live_summary_generation_jobs where language=$1', [language]);

  await t.test('the generic catch-all failure is retried automatically up to the existing cap', async () => {
    const first = await claim();
    assert.equal(await fail(first.generationToken, 'SUMMARY_FAILED'), true);
    assert.equal((await status()).status, 'retryable_failed');
    const second = await claim();
    assert.equal(second.status, 'claimed');
    assert.equal(await attempts(), 2);
    assert.equal(await fail(first.generationToken, 'SUMMARY_FAILED'), false, 'a stale token can never fail a live attempt');
    await fail(second.generationToken, 'SUMMARY_FAILED');
    const third = await claim();
    await fail(third.generationToken, 'SUMMARY_FAILED');
    assert.equal((await status()).status, 'exhausted');
    assert.equal((await claim()).status, 'exhausted');
    assert.equal(await attempts(), 3);
  });

  await t.test('only the owning host resets, and each reset restores one bounded attempt budget', async () => {
    assert.equal(await reset('host-intruder'), false);
    assert.equal(await attempts(), 3);
    assert.equal(await reset('host-owner'), true);
    assert.equal(await attempts(), 0);
    const reclaimed = await claim();
    assert.equal(reclaimed.status, 'claimed');
    assert.equal(await attempts(), 1);
    assert.equal(await reset('host-owner'), false, 'a running lease is never stolen by a reset');
    await fail(reclaimed.generationToken, 'SUMMARY_REFUSED');
    assert.equal((await status()).status, 'permanent_failed');
    assert.equal(await reset('host-owner'), true, 'a permanent failure is host-recoverable');
  });

  await t.test('the reset is repeatable: exhaust, reset, exhaust again, reset again - the RPC has no one-shot guard', async () => {
    // The only bound on host resets is the route's per-host-session summary
    // rate limit (10/hour); the RPC itself may be called as often as a lane is
    // stuck. Pin that so nobody assumes a one-shot guard the SQL never had.
    assert.equal(await attempts(), 0, 'the previous subtest left a freshly reset lane');
    for (let round = 1; round <= 2; round += 1) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const claimed = await claim();
        assert.equal(claimed.status, 'claimed', `round ${round} attempt ${attempt} is claimable`);
        assert.equal(await fail(claimed.generationToken, 'SUMMARY_FAILED'), true);
      }
      assert.equal((await status()).status, 'exhausted');
      assert.equal(await attempts(), 3);
      assert.equal(await reset('host-owner'), true, `reset number ${round + 1} after exhaustion succeeds`);
      assert.equal(await attempts(), 0);
      assert.equal((await status()).status, 'retryable_failed');
    }
  });

  await t.test('a session with no recorded speech reads as empty, is never retried, and cannot be reset by a stranger', async () => {
    const empty = await claim('en');
    assert.equal(await fail(empty.generationToken, 'NO_UTTERANCES', 'en'), true);
    assert.equal((await status('en')).status, 'empty');
    assert.equal((await claim('en')).status, 'permanent_failed');
    assert.equal(await attempts('en'), 1);
    assert.equal(await reset('host-intruder', 'en'), false);
    // Empty is terminal: even the owner cannot turn it into a retryable failure.
    // A new POST re-evaluates the utterances instead.
    assert.equal(await reset('host-owner', 'en'), false, 'an empty lane is never reset');
    assert.equal((await status('en')).status, 'empty');
    assert.equal(await attempts('en'), 1);
  });

  await t.test('a live or already summarized lane refuses the reset and the RPC stays service-only', async () => {
    await db.query("insert into live_meeting_summaries values($1,'en','{}'::jsonb,'gemini-3.6-flash',now())", [session]);
    assert.equal(await reset('host-owner', 'en'), false, 'a stored summary must never be discarded by a reset');
    await db.query("update live_sessions set status='live' where id=$1", [session]);
    assert.equal(await reset('host-owner'), false, 'a session that has not ended is not resettable');
    await db.query("update live_sessions set status='stopped' where id=$1", [session]);
    const signature = 'public.reset_live_summary_generation_v1(uuid,text,text)';
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE') value", [role, signature]), false);
    }
    assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [signature]), true);
  });
});
