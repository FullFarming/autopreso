// test/voice-provider-switch-idempotent-sql.test.js
// T2b fix round (2026-09-05): the console's per-user engine switch must be a no-op when the
// provider is unchanged (I1), and the admin session-engine rewrite must keep the assignment
// revision INSIDE the 8-entry / 3800-byte event_metadata budget (M1). 202609050005 may already be
// applied to production, so nothing there is edited: 202609050006 adds v3 variants plus the
// admin profile read the exact active-session count endpoint (I3) needs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const name = '202609050006_voice_provider_switch_idempotent.sql';
const readMigration = (file) => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
const PRIOR = [
  '202609020002_auth_profiles_desktop_codes.sql',
  '202609020003_console_rpcs.sql',
  '202609020004_live_session_engine_admin.sql',
  '202609020005_console_deploy_audit.sql',
  '202609050001_user_engine_access_renewal.sql',
  '202609050005_regrant_session_engine_admin.sql',
];
const NEW_FUNCTIONS = ['set_profile_voice_provider_v3', 'set_live_session_engine_admin_v3', 'read_profile_admin_v1'];
const ENGINE_GEMINI = { stt: { provider: 'gemini', model: 'gemini-3.5-transcribe-live', languageMode: 'auto' }, translation: { provider: 'gemini', model: 'gemini-3.6-flash' }, summary: { provider: 'gemini', model: 'gemini-3.6-flash' } };
const ENGINE_SONIOX = { stt: { provider: 'soniox', model: 'stt-rt-v5', languageMode: 'auto' }, translation: { provider: 'soniox', model: 'stt-rt-v5' }, summary: { provider: 'gemini', model: 'gemini-3.6-flash' } };

test('0006 is additive, edits no earlier migration, adds the three RPCs service-role only, and is mirrored into bootstrap', async () => {
  const sql = await readMigration(name);
  const bootstrap = await readFile(new URL('../supabase/bootstrap-new-project.sql', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes(`-- supabase/migrations/${name}\n\n${sql}`), 'bootstrap mirror');
  assert.ok(bootstrap.indexOf(`-- supabase/migrations/${name}`) > bootstrap.indexOf('-- supabase/migrations/202609050005_regrant_session_engine_admin.sql'), 'mirrored after 0005');
  assert.doesNotMatch(sql, /\b(?:drop table|drop column|drop function|truncate|delete from|grant select|alter table|alter function)\b/iu);
  for (const fn of NEW_FUNCTIONS) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(`, 'u'), fn);
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public,\\s*anon,\\s*authenticated,\\s*service_role;`, 'u'), fn);
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`, 'u'), fn);
  }
  assert.match(sql, /security definer set search_path = ''/u);
  // v3 must NOT be "call v1 then patch": the revision joins the budgeted object before the trimming loop.
  assert.doesNotMatch(sql, /set_live_session_engine_admin_v[12]\(p_actor_id/u, 'v3 copies the v1 loop instead of calling it');
  assert.match(sql, /returns table \(id uuid, status text, role text, host_id text, provider text, revision bigint, changed boolean\)/u);
  // Neither 0005 nor any earlier migration is touched by this round (they may already be applied).
  const regrant = await readMigration('202609050005_regrant_session_engine_admin.sql');
  assert.doesNotMatch(regrant, /_v3\(|changed boolean|read_profile_admin_v1/u, '0005 is left as shipped');
});

test('v3 voice provider reports changed, v3 session engine keeps assignmentRevision inside the 3800-byte budget over 12 switches, read_profile_admin_v1 is admin-only', {
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
  await db.exec(await readMigration(name));
  await db.exec(await readMigration(name)); // idempotent re-apply
  for (const fn of NEW_FUNCTIONS) {
    const { rows } = await db.query(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [fn]);
    assert.equal(rows[0].n, 1, `${fn} exists once`);
  }

  const admin = '00000000-0000-4000-8000-000000000011', user = '00000000-0000-4000-8000-000000000022';
  for (const id of [admin, user]) await db.query('insert into auth.users values($1)', [id]);
  await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [admin, 'admin@x.io', 'Admin', true, 'noel']);
  await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [user, 'user@x.io', null, false, null]);
  await db.query(`update public.profiles set status = 'approved' where id = $1`, [user]);
  const userHost = (await db.query('select host_id from public.profiles where id = $1', [user])).rows[0].host_id;

  // --- read_profile_admin_v1: the host id the active-session count derives from, never client-supplied.
  await assert.rejects(db.query('select * from public.read_profile_admin_v1($1,$2)', [user, user]), /ACTOR_NOT_ADMIN/u);
  const profile = (await db.query('select * from public.read_profile_admin_v1($1,$2)', [admin, user])).rows;
  assert.deepEqual(profile.map((r) => ({ ...r, voice_provider_revision: Number(r.voice_provider_revision) })),
    [{ id: user, status: 'approved', role: 'host', host_id: userHost, voice_provider: 'soniox', voice_provider_revision: 1 }]);
  assert.deepEqual((await db.query('select * from public.read_profile_admin_v1($1,$2)', [admin, '00000000-0000-4000-8000-0000000000ff'])).rows, [], 'unknown profile → no row, not an error');

  // --- set_profile_voice_provider_v3: same row as v2 plus `changed`; unchanged = no revision bump, no event, changed=false.
  await assert.rejects(db.query('select * from public.set_profile_voice_provider_v3($1,$2,$3)', [user, user, 'gemini']), /ACTOR_NOT_ADMIN/u);
  await assert.rejects(db.query('select * from public.set_profile_voice_provider_v3($1,$2,$3)', [admin, user, 'openai']), /VOICE_PROVIDER_INVALID/u);
  await assert.rejects(db.query('select * from public.set_profile_voice_provider_v3($1,$2,$3)', [admin, '00000000-0000-4000-8000-0000000000ff', 'gemini']), /PROFILE_NOT_FOUND/u);
  const eventsBefore = (await db.query(`select count(*)::int as n from public.profile_events where profile_id = $1 and action = 'engine_defaults'`, [user])).rows[0].n;
  const same = (await db.query('select * from public.set_profile_voice_provider_v3($1,$2,$3)', [admin, user, 'soniox'])).rows;
  assert.equal(same.length, 1);
  assert.equal(same[0].changed, false, 'the stored provider already was soniox');
  assert.equal(Number(same[0].revision), 1);
  assert.equal(same[0].host_id, userHost);
  assert.equal((await db.query(`select count(*)::int as n from public.profile_events where profile_id = $1 and action = 'engine_defaults'`, [user])).rows[0].n, eventsBefore, 'no-op writes no event');
  const flipped = (await db.query('select * from public.set_profile_voice_provider_v3($1,$2,$3)', [admin, user, 'gemini'])).rows[0];
  assert.equal(flipped.changed, true);
  assert.equal(flipped.provider, 'gemini');
  assert.equal(Number(flipped.revision), 2);
  assert.equal(flipped.id, user); assert.equal(flipped.status, 'approved'); assert.equal(flipped.role, 'host');
  const event = (await db.query(`select payload from public.profile_events where profile_id = $1 and action = 'engine_defaults' order by id desc limit 1`, [user])).rows[0];
  assert.deepEqual(event.payload, { kind: 'user_assignment', provider: 'gemini', revision: 2, effective: 'immediate' });
  const again = (await db.query('select * from public.set_profile_voice_provider_v3($1,$2,$3)', [admin, user, 'gemini'])).rows[0];
  assert.equal(again.changed, false);
  assert.equal(Number(again.revision), 2);

  // --- set_live_session_engine_admin_v3: the v1 loop with the revision inside the budgeted object.
  const live = '00000000-0000-4000-8000-0000000000a1', stopped = '00000000-0000-4000-8000-0000000000a3';
  const agenda = 'A'.repeat(2600); // a large agenda leaves < 1200 bytes for modelPreferences
  await db.query(`insert into public.live_sessions(id,host_id,status,languages,version,event_metadata) values
    ($1,$3,'live','{ko,en}',3,$4::jsonb),
    ($2,$3,'stopped','{ko}',5,'{}'::jsonb)`,
    [live, stopped, userHost, JSON.stringify({ agenda, modelPreferences: { engine: ENGINE_SONIOX, engineHistory: [], assignmentRevision: '1' } })]);
  await assert.rejects(db.query('select * from public.set_live_session_engine_admin_v3($1,$2,$3::jsonb,$4)', [admin, live, JSON.stringify(ENGINE_GEMINI), '0']), /ASSIGNMENT_REVISION_INVALID/u);
  await assert.rejects(db.query('select * from public.set_live_session_engine_admin_v3($1,$2,$3::jsonb,$4)', [user, live, JSON.stringify(ENGINE_GEMINI), '2']), /ACTOR_NOT_ADMIN/u);
  await assert.rejects(db.query('select * from public.set_live_session_engine_admin_v3($1,$2,$3::jsonb,$4)', [admin, live, JSON.stringify({ stt: 'x' }), '2']), /ENGINE_INVALID/u);
  let version = 3;
  for (let i = 0; i < 12; i += 1) {
    const engine = i % 2 === 0 ? ENGINE_GEMINI : ENGINE_SONIOX;
    const revision = String(2 + i);
    const switched = (await db.query('select * from public.set_live_session_engine_admin_v3($1,$2,$3::jsonb,$4)', [admin, live, JSON.stringify(engine), revision])).rows;
    version += 1;
    assert.deepEqual(switched, [{ id: live, status: 'live', version }]);
    const row = (await db.query('select event_metadata, octet_length(event_metadata::text) as bytes from public.live_sessions where id = $1', [live])).rows[0];
    assert.ok(row.bytes <= 3800, `switch ${i + 1}: ${row.bytes} bytes`);
    assert.equal(row.event_metadata.agenda, agenda, 'other metadata keys survive');
    assert.deepEqual(Object.keys(row.event_metadata.modelPreferences).sort(), ['assignmentRevision', 'engine', 'engineHistory']);
    assert.equal(row.event_metadata.modelPreferences.assignmentRevision, revision, 'the revision is on the record after every switch');
    assert.deepEqual(row.event_metadata.modelPreferences.engine, engine);
    const history = row.event_metadata.modelPreferences.engineHistory;
    assert.ok(history.length >= 1 && history.length <= 8, `history ${history.length}`);
    assert.deepEqual(history.at(-1).engine, engine, 'the newest entry is the one just written');
    assert.equal(history.at(-1).reason, 'admin');
  }
  // The exact M1 defect: with this agenda v2's trailing jsonb_set lands the record at 3801 bytes right
  // after its own loop trimmed to 3800; v3 measures the revision inside the loop and stays at 3800.
  const tight = 'B'.repeat(2520);
  const viaV2 = '00000000-0000-4000-8000-0000000000b2', viaV3 = '00000000-0000-4000-8000-0000000000b3';
  for (const id of [viaV2, viaV3]) {
    await db.query(`insert into public.live_sessions(id,host_id,status,languages,event_metadata) values ($1,$2,'live','{ko,en}',$3::jsonb)`,
      [id, userHost, JSON.stringify({ agenda: tight, modelPreferences: { engine: ENGINE_GEMINI, engineHistory: [], assignmentRevision: '1' } })]);
  }
  let maxV2 = 0, maxV3 = 0;
  for (let i = 0; i < 12; i += 1) {
    await db.query('select * from public.set_live_session_engine_admin_v2($1,$2,$3::jsonb,$4)', [admin, viaV2, JSON.stringify(ENGINE_GEMINI), String(2 + i)]);
    await db.query('select * from public.set_live_session_engine_admin_v3($1,$2,$3::jsonb,$4)', [admin, viaV3, JSON.stringify(ENGINE_GEMINI), String(2 + i)]);
    const bytes = async (id) => (await db.query('select octet_length(event_metadata::text) as bytes from public.live_sessions where id = $1', [id])).rows[0].bytes;
    maxV2 = Math.max(maxV2, await bytes(viaV2));
    maxV3 = Math.max(maxV3, await bytes(viaV3));
  }
  assert.ok(maxV2 > 3800, `v2 overshoots the budget it just enforced (${maxV2})`);
  assert.ok(maxV3 <= 3800, `v3 stays inside (${maxV3})`);
  // A null revision keeps the stored one; a stopped session matches nothing.
  await db.query('select * from public.set_live_session_engine_admin_v3($1,$2,$3::jsonb,$4)', [admin, live, JSON.stringify(ENGINE_GEMINI), null]);
  const kept = (await db.query('select event_metadata from public.live_sessions where id = $1', [live])).rows[0];
  assert.equal(kept.event_metadata.modelPreferences.assignmentRevision, '13');
  assert.deepEqual((await db.query('select * from public.set_live_session_engine_admin_v3($1,$2,$3::jsonb,$4)', [admin, stopped, JSON.stringify(ENGINE_GEMINI), '2'])).rows, []);
  assert.equal((await db.query('select version from public.live_sessions where id = $1', [stopped])).rows[0].version, 5);
  // Without a budget pressure the record is the v2 shape from scratch (preparing session, empty metadata).
  const preparing = '00000000-0000-4000-8000-0000000000a2';
  await db.query(`insert into public.live_sessions(id,host_id,status,languages,version) values ($1,$2,'preparing','{ko,en,ja}',1)`, [preparing, userHost]);
  assert.deepEqual((await db.query('select * from public.set_live_session_engine_admin_v3($1,$2,$3::jsonb,$4)', [admin, preparing, JSON.stringify(ENGINE_GEMINI), '2'])).rows, [{ id: preparing, status: 'preparing', version: 2 }]);
  const fresh = (await db.query('select event_metadata from public.live_sessions where id = $1', [preparing])).rows[0].event_metadata;
  assert.deepEqual(Object.keys(fresh.modelPreferences).sort(), ['assignmentRevision', 'engine', 'engineHistory']);
  assert.equal(fresh.modelPreferences.assignmentRevision, '2');
  assert.equal(fresh.modelPreferences.engineHistory.length, 1);
});
