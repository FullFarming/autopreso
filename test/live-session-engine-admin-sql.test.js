// test/live-session-engine-admin-sql.test.js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const name = '202609020004_live_session_engine_admin.sql';
const profilesMigration = '202609020002_auth_profiles_desktop_codes.sql';
const consoleMigration = '202609020003_console_rpcs.sql';
const readMigration = (file) => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
const FUNCTIONS = ['set_live_session_engine_admin_v1', 'list_live_session_ids_admin_v1'];

const ENGINE_A = { stt: { provider: 'gemini', model: 'gemini-3.5-transcribe-live', languageMode: 'auto' }, translation: { provider: 'gemini', model: 'gemini-3.7-flash' }, summary: { provider: 'gemini', model: 'gemini-3.7-flash' } };
const ENGINE_B = { stt: { provider: 'soniox', model: 'stt-rt-v5', languageMode: 'ko' }, translation: { provider: 'gemini', model: 'gemini-3.7-flash' }, summary: { provider: 'gemini', model: 'gemini-3.7-flash' } };

test('live session engine admin migration is additive, service-role only, mirrored into bootstrap', async () => {
  const sql = await readMigration(name);
  const bootstrap = await readFile(new URL('../supabase/bootstrap-new-project.sql', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes(`-- supabase/migrations/${name}\n\n${sql}`));
  assert.doesNotMatch(sql, /\b(?:drop table|drop column|truncate|delete from|grant select)\b/iu);
  for (const fn of FUNCTIONS) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(`, 'u'));
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public,\\s*anon,\\s*authenticated,\\s*service_role;`, 'u'));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`, 'u'));
  }
  assert.match(sql, /perform public\.assert_console_admin_v1\(p_actor_id\)/u);
  assert.match(sql, /security definer set search_path = ''/u);
});

test('admin engine switch rewrites engine, appends capped + byte-budgeted history with reason admin, bumps version, and skips inactive sessions', {
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

  const live = '00000000-0000-4000-8000-0000000000a1', preparing = '00000000-0000-4000-8000-0000000000a2';
  const stopped = '00000000-0000-4000-8000-0000000000a3', deleted = '00000000-0000-4000-8000-0000000000a4', legacy = '00000000-0000-4000-8000-0000000000a5';
  const liveMetadata = { ticker: 'ACME', agenda: [{ title: 'Q1' }], modelPreferences: { engine: ENGINE_A, engineHistory: [] } };
  await db.query(`insert into public.live_sessions(id,host_id,status,languages,version,event_metadata,created_at) values
    ($1,'h1','live','{ko,en}',3,$6::jsonb, now() - interval '3 minutes'),
    ($2,'h1','preparing','{ko}',1,'{}'::jsonb, now() - interval '2 minutes'),
    ($3,'h1','stopped','{ko}',5,'{}'::jsonb, now() - interval '1 minute'),
    ($4,'h1','live','{ko}',1,'{}'::jsonb, now()),
    ($5,'h1','live','{ja}',2,$7::jsonb, now())`,
    [live, preparing, stopped, deleted, legacy, JSON.stringify(liveMetadata),
      JSON.stringify({ modelPreferences: { source: { provider: 'gemini', model: 'legacy' }, summary: { provider: 'gemini', model: 'legacy' } } })]);
  await db.query('update public.live_sessions set archive_deleted_at = now() where id = $1', [deleted]);

  // non-admin actor is refused before anything is touched
  await assert.rejects(db.query('select * from public.set_live_session_engine_admin_v1($1,$2,$3::jsonb)', [host, live, JSON.stringify(ENGINE_B)]), /ACTOR_NOT_ADMIN/u);
  assert.equal((await db.query('select version from public.live_sessions where id = $1', [live])).rows[0].version, 3);

  // malformed engines are refused with ENGINE_INVALID (structure only; the catalog check is the webapp's)
  for (const bad of ['[]', '{}', JSON.stringify({ ...ENGINE_A, stt: { provider: 'gemini' } }), JSON.stringify({ ...ENGINE_A, translation: 'gemini' }), JSON.stringify({ ...ENGINE_A, summary: { provider: 1, model: 'x' } })]) {
    await assert.rejects(db.query('select * from public.set_live_session_engine_admin_v1($1,$2,$3::jsonb)', [admin, live, bad]), /ENGINE_INVALID/u, bad);
  }
  await assert.rejects(db.query('select * from public.set_live_session_engine_admin_v1($1,$2,null::jsonb)', [admin, live]), /ENGINE_INVALID/u);

  // live session: engine replaced, history appended with the actor's host_id, version +1, other event_metadata keys preserved
  const first = (await db.query('select * from public.set_live_session_engine_admin_v1($1,$2,$3::jsonb)', [admin, live, JSON.stringify(ENGINE_B)])).rows;
  assert.deepEqual(first, [{ id: live, status: 'live', version: 4 }]);
  let row = (await db.query('select event_metadata, updated_at from public.live_sessions where id = $1', [live])).rows[0];
  assert.equal(row.event_metadata.ticker, 'ACME');
  assert.deepEqual(row.event_metadata.agenda, [{ title: 'Q1' }]);
  assert.deepEqual(Object.keys(row.event_metadata.modelPreferences).sort(), ['engine', 'engineHistory']);
  assert.deepEqual(row.event_metadata.modelPreferences.engine, ENGINE_B);
  assert.equal(row.event_metadata.modelPreferences.engineHistory.length, 1);
  const entry = row.event_metadata.modelPreferences.engineHistory[0];
  assert.deepEqual(Object.keys(entry).sort(), ['byHostId', 'changedAt', 'engine', 'reason']);
  assert.deepEqual(entry.engine, ENGINE_B);
  assert.equal(entry.byHostId, 'noel');
  assert.equal(entry.reason, 'admin');
  assert.ok(Number.isFinite(Date.parse(entry.changedAt)), entry.changedAt);
  assert.match(entry.changedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);

  // second call appends again (history length 2, oldest first)
  const second = (await db.query('select * from public.set_live_session_engine_admin_v1($1,$2,$3::jsonb)', [admin, live, JSON.stringify(ENGINE_A)])).rows;
  assert.deepEqual(second, [{ id: live, status: 'live', version: 5 }]);
  row = (await db.query('select event_metadata from public.live_sessions where id = $1', [live])).rows[0];
  assert.deepEqual(row.event_metadata.modelPreferences.engine, ENGINE_A);
  assert.deepEqual(row.event_metadata.modelPreferences.engineHistory.map((e) => e.engine.stt.provider), ['soniox', 'gemini']);

  // preparing session with empty metadata: modelPreferences created from scratch
  const prep = (await db.query('select * from public.set_live_session_engine_admin_v1($1,$2,$3::jsonb)', [admin, preparing, JSON.stringify(ENGINE_B)])).rows;
  assert.deepEqual(prep, [{ id: preparing, status: 'preparing', version: 2 }]);
  row = (await db.query('select event_metadata from public.live_sessions where id = $1', [preparing])).rows[0];
  assert.deepEqual(row.event_metadata, { modelPreferences: { engine: ENGINE_B, engineHistory: row.event_metadata.modelPreferences.engineHistory } });
  assert.equal(row.event_metadata.modelPreferences.engineHistory.length, 1);

  // legacy { source, summary } modelPreferences is replaced, not merged: the webapp reader rejects a mixed shape
  await db.query('select * from public.set_live_session_engine_admin_v1($1,$2,$3::jsonb)', [admin, legacy, JSON.stringify(ENGINE_B)]);
  row = (await db.query('select event_metadata from public.live_sessions where id = $1', [legacy])).rows[0];
  assert.deepEqual(Object.keys(row.event_metadata.modelPreferences).sort(), ['engine', 'engineHistory']);

  // stopped and archive-deleted sessions match nothing: zero rows, no error, untouched
  for (const id of [stopped, deleted]) {
    assert.deepEqual((await db.query('select * from public.set_live_session_engine_admin_v1($1,$2,$3::jsonb)', [admin, id, JSON.stringify(ENGINE_B)])).rows, []);
  }
  assert.equal((await db.query('select version from public.live_sessions where id = $1', [stopped])).rows[0].version, 5);
  assert.deepEqual((await db.query('select event_metadata from public.live_sessions where id = $1', [deleted])).rows[0].event_metadata, {});
  assert.deepEqual((await db.query('select * from public.set_live_session_engine_admin_v1($1,$2,$3::jsonb)', [admin, '00000000-0000-4000-8000-0000000000ff', JSON.stringify(ENGINE_B)])).rows, []);

  // history is capped at 8 (Task 4 fix I1), oldest dropped
  for (let i = 0; i < 65; i += 1) {
    const engine = { ...ENGINE_A, stt: { ...ENGINE_A.stt, languageMode: `m${i}` } };
    await db.query('select * from public.set_live_session_engine_admin_v1($1,$2,$3::jsonb)', [admin, preparing, JSON.stringify(engine)]);
  }
  row = (await db.query('select event_metadata, version, octet_length(event_metadata::text) as bytes from public.live_sessions where id = $1', [preparing])).rows[0];
  const history = row.event_metadata.modelPreferences.engineHistory;
  assert.equal(history.length, 8);
  assert.equal(history[0].engine.stt.languageMode, 'm57'); // the seed entry and m0..m56 fell off
  assert.equal(history[7].engine.stt.languageMode, 'm64');
  assert.ok(history.every((e) => e.reason === 'admin'));
  assert.equal(row.event_metadata.modelPreferences.engine.stt.languageMode, 'm64');
  assert.equal(row.version, 2 + 65);
  assert.ok(row.bytes <= 3800, String(row.bytes));

  // byte budget: with the largest agenda (20 × 120 chars) the whole body stays ≤ 3800 bytes; newest entries kept, agenda untouched
  const budgeted = '00000000-0000-4000-8000-0000000000a6';
  const agenda = Array.from({ length: 20 }, (_, i) => ({ ordinal: i + 1, label: 'a'.repeat(120) }));
  await db.query(`insert into public.live_sessions(id,host_id,status,languages,version,event_metadata) values ($1,'h1','live','{ko,en}',1,$2::jsonb)`,
    [budgeted, JSON.stringify({ ticker: 'ACME', eventType: 'earnings_call', agenda, modelPreferences: { engine: ENGINE_A, engineHistory: [] } })]);
  for (let i = 0; i < 12; i += 1) {
    const engine = { ...ENGINE_B, stt: { ...ENGINE_B.stt, languageMode: i % 2 === 0 ? 'ko' : 'en' } };
    await db.query('select * from public.set_live_session_engine_admin_v1($1,$2,$3::jsonb)', [admin, budgeted, JSON.stringify(engine)]);
    const state = (await db.query('select event_metadata, octet_length(event_metadata::text) as bytes from public.live_sessions where id = $1', [budgeted])).rows[0];
    assert.ok(state.bytes <= 3800, `${i}: ${state.bytes}`);
    const kept = state.event_metadata.modelPreferences.engineHistory;
    assert.ok(kept.length >= 1 && kept.length <= 8, String(kept.length));
    assert.equal(kept.at(-1).engine.stt.languageMode, i % 2 === 0 ? 'ko' : 'en', 'the newest change is always kept');
    assert.deepEqual(state.event_metadata.agenda, agenda);
    assert.equal(state.event_metadata.ticker, 'ACME');
  }

  // list returns only preparing/live, not archive-deleted, oldest first
  const listed = (await db.query('select * from public.list_live_session_ids_admin_v1()')).rows;
  assert.deepEqual(listed, [
    { id: live, status: 'live', languages: ['ko', 'en'] },
    { id: preparing, status: 'preparing', languages: ['ko'] },
    { id: legacy, status: 'live', languages: ['ja'] },
    { id: budgeted, status: 'live', languages: ['ko', 'en'] },
  ]);
});
