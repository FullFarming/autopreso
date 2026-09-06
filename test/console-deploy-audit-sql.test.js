// test/console-deploy-audit-sql.test.js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const name = '202609020005_console_deploy_audit.sql';
const profilesMigration = '202609020002_auth_profiles_desktop_codes.sql';
const consoleMigration = '202609020003_console_rpcs.sql';
const readMigration = (file) => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
const FN = 'record_console_deploy_v1';

const ENGINE = { stt: { provider: 'gemini', model: 'gemini-3.5-transcribe-live', languageMode: 'auto' }, translation: { provider: 'gemini', model: 'gemini-3.7-flash' }, summary: { provider: 'gemini', model: 'gemini-3.7-flash' } };

test('console deploy audit migration is additive, service-role only, mirrored into bootstrap', async () => {
  const sql = await readMigration(name);
  const bootstrap = await readFile(new URL('../supabase/bootstrap-new-project.sql', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes(`-- supabase/migrations/${name}\n\n${sql}`));
  assert.doesNotMatch(sql, /\b(?:drop table|drop column|truncate|delete from|grant select|alter table)\b/iu);
  assert.match(sql, new RegExp(`create or replace function public\\.${FN}\\(p_actor_id uuid, p_payload jsonb\\)`, 'u'));
  assert.match(sql, new RegExp(`revoke all on function public\\.${FN}\\(uuid,jsonb\\) from public,\\s*anon,\\s*authenticated,\\s*service_role;`, 'u'));
  assert.match(sql, new RegExp(`grant execute on function public\\.${FN}\\(uuid,jsonb\\) to service_role;`, 'u'));
  assert.match(sql, /perform public\.assert_console_admin_v1\(p_actor_id\)/u);
  assert.match(sql, /security definer set search_path = ''/u);
});

test('record_console_deploy_v1 writes one engine_defaults event with the deploy counters and refuses non-admins and malformed payloads', {
  skip: !process.env.NOVA_PGLITE_MODULE && 'Set NOVA_PGLITE_MODULE for isolated PostgreSQL validation',
}, async (t) => {
  const { PGlite } = await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create table public.live_sessions(id uuid primary key, host_id text not null, title text, mode text, status text, languages text[],
      version integer not null default 1, created_at timestamptz default now(), ended_at timestamptz, archive_deleted_at timestamptz,
      event_metadata jsonb not null default '{}'::jsonb, updated_at timestamptz default now());
    create table public.live_utterances(id uuid primary key, session_id uuid, language text, seq bigint);
    create table public.live_participants(id uuid primary key, session_id uuid, user_id text);
    create table public.live_summary_generation_jobs(session_id uuid, language text, status text, error_code text, primary key (session_id, language));`);
  await db.exec(await readMigration(profilesMigration));
  await db.exec(await readMigration(consoleMigration));
  await db.exec(await readMigration(name));
  await db.exec(await readMigration(name)); // idempotent re-apply

  const admin = '00000000-0000-4000-8000-000000000011', host = '00000000-0000-4000-8000-000000000022';
  for (const id of [admin, host]) await db.query('insert into auth.users values($1)', [id]);
  await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [admin, 'admin@x.io', 'Admin', true, 'noel']);
  await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [host, 'host@x.io', null, false, null]);
  const eventCount = async () => Number((await db.query(`select count(*)::int as n from public.profile_events where action = 'engine_defaults'`)).rows[0].n);
  const before = await eventCount();

  const payload = { engine: ENGINE, sessionsSwitched: 2, sessionsFailed: 1, sessionsQueued: 0 };
  await assert.rejects(db.query(`select public.${FN}($1,$2::jsonb)`, [host, JSON.stringify(payload)]), /ACTOR_NOT_ADMIN/u);
  for (const bad of ['[]', '{}', JSON.stringify({ ...payload, engine: 'gemini' }), JSON.stringify({ ...payload, sessionsFailed: -1 }),
    JSON.stringify({ ...payload, sessionsQueued: '0' }), JSON.stringify({ ...payload, sessionsSwitched: 1.5 }), JSON.stringify({ engine: ENGINE, sessionsSwitched: 1 })]) {
    await assert.rejects(db.query(`select public.${FN}($1,$2::jsonb)`, [admin, bad]), /DEPLOY_PAYLOAD_INVALID/u, bad);
  }
  await assert.rejects(db.query(`select public.${FN}($1,null::jsonb)`, [admin]), /DEPLOY_PAYLOAD_INVALID/u);
  assert.equal(await eventCount(), before, 'refused calls write nothing');

  assert.equal((await db.query(`select public.${FN}($1,$2::jsonb) as ok`, [admin, JSON.stringify(payload)])).rows[0].ok, true);
  assert.equal(await eventCount(), before + 1);
  const row = (await db.query(`select profile_id, actor_id, action, payload from public.profile_events where action = 'engine_defaults' order by id desc limit 1`)).rows[0];
  assert.equal(row.profile_id, admin);
  assert.equal(row.actor_id, admin);
  assert.deepEqual(row.payload, { ...payload, kind: 'deploy' });
  // The stored engine singleton is untouched: the audit row is the only side effect.
  assert.equal((await db.query('select count(*)::int as n from public.engine_defaults')).rows[0].n, 0);
});
