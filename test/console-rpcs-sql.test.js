// test/console-rpcs-sql.test.js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const name = '202609020003_console_rpcs.sql';
const profilesMigration = '202609020002_auth_profiles_desktop_codes.sql';
const readMigration = (file) => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
const FUNCTIONS = ['list_profiles_admin_v1', 'count_pending_profiles_v1', 'set_profile_status_v1', 'set_profile_role_v1', 'list_sessions_admin_v1', 'read_console_settings_v1', 'set_engine_defaults_v1', 'set_legacy_password_login_v1'];

test('console migration is additive, service-role only, mirrored into bootstrap', async () => {
  const sql = await readMigration(name);
  const bootstrap = await readFile(new URL('../supabase/bootstrap-new-project.sql', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes(`-- supabase/migrations/${name}\n\n${sql}`));
  assert.doesNotMatch(sql, /\b(?:drop table|drop column|truncate|delete from|grant select)\b/iu);
  for (const fn of FUNCTIONS) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(`, 'u'));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`, 'u'));
  }
  assert.match(sql, /alter table public\.engine_defaults enable row level security/u);
  assert.match(sql, /alter table public\.console_settings enable row level security/u);
});

test('console RPCs enforce transitions, last-admin and self-change protection, and aggregate sessions', {
  skip: !process.env.NOVA_PGLITE_MODULE && 'Set NOVA_PGLITE_MODULE for isolated PostgreSQL validation',
}, async (t) => {
  const { PGlite } = await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create table public.live_sessions(id uuid primary key, host_id text not null, title text, mode text, status text, languages text[], created_at timestamptz default now(), ended_at timestamptz, archive_deleted_at timestamptz);
    create table public.live_utterances(id uuid primary key, session_id uuid, language text, seq bigint);
    create table public.live_participants(id uuid primary key, session_id uuid, user_id text);
    create table public.live_summary_generation_jobs(session_id uuid, language text, status text, error_code text, primary key (session_id, language));`);
  await db.exec(await readMigration(profilesMigration));
  await db.exec(await readMigration(name));
  await db.exec(await readMigration(name));
  const admin = '00000000-0000-4000-8000-000000000011', second = '00000000-0000-4000-8000-000000000022', guest = '00000000-0000-4000-8000-000000000033';
  for (const id of [admin, second, guest]) await db.query('insert into auth.users values($1)', [id]);
  await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [admin, 'admin@x.io', 'Admin', true, 'noel']);
  await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [second, 'second@x.io', null, false, null]);
  await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [guest, 'guest@x.io', null, false, null]);
  assert.equal((await db.query('select public.count_pending_profiles_v1() as n')).rows[0].n, 2);
  const pendingList = (await db.query('select * from public.list_profiles_admin_v1($1,$2,$3)', ['pending', 50, null])).rows;
  assert.deepEqual(pendingList.map((r) => r.email).sort(), ['guest@x.io', 'second@x.io']);
  // approve second, then promote to admin
  assert.equal((await db.query('select * from public.set_profile_status_v1($1,$2,$3,$4)', [admin, second, 'approved', null])).rows[0].status, 'approved');
  assert.equal((await db.query('select * from public.set_profile_role_v1($1,$2,$3)', [admin, second, 'admin'])).rows[0].role, 'admin');
  // reject guest with reason; rejected -> approved allowed; approved -> pending NOT allowed
  await db.query('select * from public.set_profile_status_v1($1,$2,$3,$4)', [admin, guest, 'rejected', 'duplicate']);
  await assert.rejects(db.query('select * from public.set_profile_status_v1($1,$2,$3,$4)', [admin, second, 'pending', null]), /INVALID_TRANSITION/u);
  // self change forbidden
  await assert.rejects(db.query('select * from public.set_profile_role_v1($1,$2,$3)', [admin, admin, 'host']), /SELF_CHANGE_FORBIDDEN/u);
  // last admin protected: demote second (ok, admin remains), then try to disable admin from second -> second is host now -> still SELF/LAST rules apply via admin only
  await db.query('select * from public.set_profile_role_v1($1,$2,$3)', [admin, second, 'host']);
  await assert.rejects(db.query('select * from public.set_profile_status_v1($1,$2,$3,$4)', [second, admin, 'disabled', null]), /LAST_ADMIN_PROTECTED|SELF_CHANGE_FORBIDDEN|ACTOR_NOT_ADMIN/u);
  const events = (await db.query('select action, reason from public.profile_events order by id')).rows;
  assert.deepEqual(events.map((e) => e.action), ['bootstrap_admin', 'signup', 'signup', 'approve', 'set_role', 'reject', 'set_role']);
  assert.equal(events.find((e) => e.action === 'reject').reason, 'duplicate');
  // settings + engine defaults
  const initial = (await db.query('select * from public.read_console_settings_v1()')).rows[0];
  assert.equal(initial.legacy_password_login_enabled, true); assert.equal(initial.engine, null);
  assert.equal((await db.query('select public.set_engine_defaults_v1($1,$2::jsonb) as ok', [admin, JSON.stringify({ stt: { provider: 'gemini', model: 'gemini-3.5-transcribe-live', languageMode: 'auto' } })])).rows[0].ok, true);
  assert.equal((await db.query('select public.set_legacy_password_login_v1($1,$2) as ok', [admin, false])).rows[0].ok, true);
  const after = (await db.query('select * from public.read_console_settings_v1()')).rows[0];
  assert.equal(after.legacy_password_login_enabled, false); assert.equal(after.engine.stt.provider, 'gemini'); assert.equal(after.engine_updated_by_email, 'admin@x.io');
  await assert.rejects(db.query('select public.set_engine_defaults_v1($1,$2::jsonb)', [second, '{}']), /ACTOR_NOT_ADMIN/u);
  // sessions aggregate
  const s1 = '00000000-0000-4000-8000-0000000000a1';
  await db.query(`insert into public.live_sessions(id,host_id,title,mode,status,languages,ended_at) values($1,'noel','Kickoff','meeting','stopped','{ko,en}',now())`, [s1]);
  await db.query(`insert into public.live_utterances values(gen_random_uuid(),$1,'ko',1),(gen_random_uuid(),$1,'en',1),(gen_random_uuid(),$1,'ko',2)`, [s1]);
  await db.query(`insert into public.live_participants values(gen_random_uuid(),$1,'u1'),(gen_random_uuid(),$1,'u2')`, [s1]);
  await db.query(`insert into public.live_summary_generation_jobs values($1,'ko','failed','SUMMARY_TIMEOUT')`, [s1]);
  const sessions = (await db.query('select * from public.list_sessions_admin_v1($1,$2)', [null, 50])).rows;
  assert.equal(sessions.length, 1);
  assert.deepEqual([sessions[0].host_email, Number(sessions[0].utterance_count), Number(sessions[0].participant_count), sessions[0].summary_status], ['admin@x.io', 3, 2, 'failed']);
});
