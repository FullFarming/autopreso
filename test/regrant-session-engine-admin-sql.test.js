// test/regrant-session-engine-admin-sql.test.js
// Decision D1 (2026-09-05): the operator's per-user engine assignment applies IMMEDIATELY to that
// user's running sessions. 202609050001 had revoked the admin session-engine RPC from service_role;
// this migration re-grants it and adds the per-host session list + revision-recording variants the
// console's PATCH /api/console/users path calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const name = '202609050005_regrant_session_engine_admin.sql';
const readMigration = (file) => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
const PRIOR = [
  '202609020002_auth_profiles_desktop_codes.sql',
  '202609020003_console_rpcs.sql',
  '202609020004_live_session_engine_admin.sql',
  '202609020005_console_deploy_audit.sql',
  '202609050001_user_engine_access_renewal.sql',
];
const V1 = 'public.set_live_session_engine_admin_v1(uuid,uuid,jsonb)';
const ENGINE_GEMINI = { stt: { provider: 'gemini', model: 'gemini-3.5-transcribe-live', languageMode: 'auto' }, translation: { provider: 'gemini', model: 'gemini-3.6-flash' }, summary: { provider: 'gemini', model: 'gemini-3.6-flash' } };
const ENGINE_SONIOX = { stt: { provider: 'soniox', model: 'stt-rt-v5', languageMode: 'auto' }, translation: { provider: 'soniox', model: 'stt-rt-v5' }, summary: { provider: 'gemini', model: 'gemini-3.6-flash' } };

test('regrant migration is additive, cites D1, re-grants the v1 RPC to service_role, and is mirrored into bootstrap', async () => {
  const sql = await readMigration(name);
  const bootstrap = await readFile(new URL('../supabase/bootstrap-new-project.sql', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes(`-- supabase/migrations/${name}\n\n${sql}`), 'bootstrap mirror');
  assert.match(sql, /^--.*D1/mu, 'header comment cites decision D1');
  assert.doesNotMatch(sql, /\b(?:drop table|drop column|drop function|truncate|delete from|grant select|alter table|alter function)\b/iu);
  assert.match(sql, /grant execute on function public\.set_live_session_engine_admin_v1\(uuid,uuid,jsonb\) to service_role;/u);
  assert.doesNotMatch(sql, /revoke all on function public\.set_live_session_engine_admin_v1\(uuid,uuid,jsonb\)/u, 'the re-grant is not undone in the same file');
  for (const fn of ['set_live_session_engine_admin_v2', 'list_live_session_ids_for_host_admin_v1', 'set_profile_voice_provider_v2']) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(`, 'u'), fn);
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public,\\s*anon,\\s*authenticated,\\s*service_role;`, 'u'), fn);
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`, 'u'), fn);
  }
  assert.match(sql, /security definer set search_path = ''/u);
  assert.match(sql, /'effective', 'immediate'/u, 'the per-user assignment event says immediate, not next_session');
});

test('after 202609050001 the RPC is revoked; after this migration service_role can execute it, v2 records the assignment revision, and the host list is host-scoped', {
  skip: !process.env.NOVA_PGLITE_MODULE && 'Set NOVA_PGLITE_MODULE for isolated PostgreSQL validation',
}, async (t) => {
  const { PGlite } = await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create table public.live_sessions(id uuid primary key, host_id text not null, title text, mode text, status text, languages text[],
      version integer not null default 1, created_at timestamptz default now(), ended_at timestamptz, archive_deleted_at timestamptz,
      event_metadata jsonb not null default '{}'::jsonb, updated_at timestamptz default now(),
      access_window_started_at timestamptz default now(), scheduled_at timestamptz, expires_at timestamptz, admission_state text, admission_open_until timestamptz);
    create table public.live_session_invites(session_id uuid, expires_at timestamptz, revoked_at timestamptz);
    create table public.viewer_grants(id uuid primary key, session_id uuid, user_id text, revoked_at timestamptz, expires_at timestamptz);
    create table public.live_utterances(id uuid primary key, session_id uuid, language text, seq bigint);
    create table public.live_participants(id uuid primary key, session_id uuid, user_id text);
    create table public.live_summary_generation_jobs(session_id uuid, language text, status text, error_code text, primary key (session_id, language));`);
  for (const file of PRIOR) await db.exec(await readMigration(file));
  const privilege = async () => (await db.query(`select has_function_privilege('service_role', '${V1}', 'EXECUTE') as allowed`)).rows[0].allowed;
  assert.equal(await privilege(), false, '202609050001 revoked the admin switch');

  await db.exec(await readMigration(name));
  await db.exec(await readMigration(name)); // idempotent re-apply
  assert.equal(await privilege(), true, 'D1: the console may switch running sessions again');

  const admin = '00000000-0000-4000-8000-000000000011', user = '00000000-0000-4000-8000-000000000022', other = '00000000-0000-4000-8000-000000000033';
  for (const id of [admin, user, other]) await db.query('insert into auth.users values($1)', [id]);
  await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [admin, 'admin@x.io', 'Admin', true, 'noel']);
  await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [user, 'user@x.io', null, false, null]);
  await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [other, 'other@x.io', null, false, null]);
  await db.query(`update public.profiles set status = 'approved' where id in ($1, $2)`, [user, other]);
  const hostOf = async (id) => (await db.query('select host_id from public.profiles where id = $1', [id])).rows[0].host_id;
  const userHost = await hostOf(user), otherHost = await hostOf(other);

  const live = '00000000-0000-4000-8000-0000000000a1', preparing = '00000000-0000-4000-8000-0000000000a2', stopped = '00000000-0000-4000-8000-0000000000a3', foreign = '00000000-0000-4000-8000-0000000000a4';
  await db.query(`insert into public.live_sessions(id,host_id,status,languages,version,event_metadata,created_at) values
    ($1,$5,'live','{ko,en}',3,$7::jsonb, now() - interval '3 minutes'),
    ($2,$5,'preparing','{ko,en,ja}',1,'{}'::jsonb, now() - interval '2 minutes'),
    ($3,$5,'stopped','{ko}',5,'{}'::jsonb, now() - interval '1 minute'),
    ($4,$6,'live','{ko,en}',1,'{}'::jsonb, now())`,
    [live, preparing, stopped, foreign, userHost, otherHost, JSON.stringify({ ticker: 'ACME', modelPreferences: { engine: ENGINE_SONIOX, engineHistory: [], assignmentRevision: '1' } })]);

  // Host-scoped active list: only this host's preparing/live sessions, oldest first.
  const listed = (await db.query('select * from public.list_live_session_ids_for_host_admin_v1($1)', [userHost])).rows;
  assert.deepEqual(listed, [{ id: live, status: 'live', languages: ['ko', 'en'] }, { id: preparing, status: 'preparing', languages: ['ko', 'en', 'ja'] }]);
  assert.deepEqual((await db.query('select * from public.list_live_session_ids_for_host_admin_v1($1)', ['nobody'])).rows, []);

  // set_profile_voice_provider_v2: admin-only, returns the profile identity the route needs, bumps the revision once, logs 'immediate'.
  await assert.rejects(db.query('select * from public.set_profile_voice_provider_v2($1,$2,$3)', [user, user, 'gemini']), /ACTOR_NOT_ADMIN/u);
  await assert.rejects(db.query('select * from public.set_profile_voice_provider_v2($1,$2,$3)', [admin, user, 'openai']), /VOICE_PROVIDER_INVALID/u);
  const assigned = (await db.query('select * from public.set_profile_voice_provider_v2($1,$2,$3)', [admin, user, 'gemini'])).rows;
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].id, user);
  assert.equal(assigned[0].host_id, userHost);
  assert.equal(assigned[0].status, 'approved');
  assert.equal(assigned[0].role, 'host');
  assert.equal(assigned[0].provider, 'gemini');
  assert.equal(Number(assigned[0].revision), 2);
  const again = (await db.query('select * from public.set_profile_voice_provider_v2($1,$2,$3)', [admin, user, 'gemini'])).rows[0];
  assert.equal(Number(again.revision), 2, 'an unchanged provider does not bump the revision');
  const event = (await db.query(`select payload from public.profile_events where profile_id = $1 and action = 'engine_defaults' order by id desc limit 1`, [user])).rows[0];
  assert.equal(event.payload.kind, 'user_assignment');
  assert.equal(event.payload.effective, 'immediate');
  assert.equal(event.payload.provider, 'gemini');

  // set_live_session_engine_admin_v2: the v1 rewrite plus the profile's revision on the session record.
  await assert.rejects(db.query('select * from public.set_live_session_engine_admin_v2($1,$2,$3::jsonb,$4)', [admin, live, JSON.stringify(ENGINE_GEMINI), '0']), /ASSIGNMENT_REVISION_INVALID/u);
  await assert.rejects(db.query('select * from public.set_live_session_engine_admin_v2($1,$2,$3::jsonb,$4)', [user, live, JSON.stringify(ENGINE_GEMINI), '2']), /ACTOR_NOT_ADMIN/u);
  const switched = (await db.query('select * from public.set_live_session_engine_admin_v2($1,$2,$3::jsonb,$4)', [admin, live, JSON.stringify(ENGINE_GEMINI), '2'])).rows;
  assert.deepEqual(switched, [{ id: live, status: 'live', version: 4 }]);
  let row = (await db.query('select event_metadata from public.live_sessions where id = $1', [live])).rows[0];
  assert.equal(row.event_metadata.ticker, 'ACME', 'other metadata keys survive');
  assert.deepEqual(Object.keys(row.event_metadata.modelPreferences).sort(), ['assignmentRevision', 'engine', 'engineHistory']);
  assert.deepEqual(row.event_metadata.modelPreferences.engine, ENGINE_GEMINI);
  assert.equal(row.event_metadata.modelPreferences.assignmentRevision, '2');
  assert.equal(row.event_metadata.modelPreferences.engineHistory.length, 1);
  assert.equal(row.event_metadata.modelPreferences.engineHistory[0].reason, 'admin');

  // A preparing session with no modelPreferences gets engine + history + revision from scratch.
  const prepared = (await db.query('select * from public.set_live_session_engine_admin_v2($1,$2,$3::jsonb,$4)', [admin, preparing, JSON.stringify(ENGINE_GEMINI), '2'])).rows;
  assert.deepEqual(prepared, [{ id: preparing, status: 'preparing', version: 2 }]);
  row = (await db.query('select event_metadata from public.live_sessions where id = $1', [preparing])).rows[0];
  assert.deepEqual(Object.keys(row.event_metadata.modelPreferences).sort(), ['assignmentRevision', 'engine', 'engineHistory']);
  assert.equal(row.event_metadata.modelPreferences.assignmentRevision, '2');

  // A null revision leaves whatever the record carried; stopped sessions match nothing and stay untouched.
  await db.query('select * from public.set_live_session_engine_admin_v2($1,$2,$3::jsonb,$4)', [admin, live, JSON.stringify(ENGINE_SONIOX), null]);
  row = (await db.query('select event_metadata from public.live_sessions where id = $1', [live])).rows[0];
  assert.equal(row.event_metadata.modelPreferences.assignmentRevision, '2');
  assert.deepEqual(row.event_metadata.modelPreferences.engine, ENGINE_SONIOX);
  assert.deepEqual((await db.query('select * from public.set_live_session_engine_admin_v2($1,$2,$3::jsonb,$4)', [admin, stopped, JSON.stringify(ENGINE_GEMINI), '2'])).rows, []);
  assert.equal((await db.query('select version from public.live_sessions where id = $1', [stopped])).rows[0].version, 5);
  assert.deepEqual((await db.query('select event_metadata from public.live_sessions where id = $1', [foreign])).rows[0].event_metadata, {}, 'another host\'s session is never touched');
});
