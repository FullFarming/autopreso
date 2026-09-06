// test/auth-profiles-sql.test.js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const name = '202609020002_auth_profiles_desktop_codes.sql';
const readMigration = (file) => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');

test('auth profiles migration is additive, service-role only, and mirrored into bootstrap', async () => {
  const sql = await readMigration(name);
  const bootstrap = await readFile(new URL('../supabase/bootstrap-new-project.sql', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes(`-- supabase/migrations/${name}\n\n${sql}`));
  assert.doesNotMatch(sql, /\b(?:drop table|drop column|truncate|delete from public\.profiles|grant select)\b/iu);
  for (const fn of ['upsert_profile_on_login_v1', 'read_profile_by_host_id_v1', 'issue_desktop_login_code_v1', 'consume_desktop_login_code_v1']) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(`, 'u'));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`, 'u'));
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public,\\s*anon,\\s*authenticated,\\s*service_role;`, 'u'));
  }
  assert.match(sql, /alter table public\.profiles enable row level security/u);
  assert.match(sql, /alter table public\.profile_events enable row level security/u);
  assert.match(sql, /alter table public\.desktop_login_codes enable row level security/u);
  assert.match(sql, /create policy profiles_self_select on public\.profiles for select to authenticated using \(\(select auth\.uid\(\)\) = id\)/u);
});

test('auth profiles PostgreSQL enforces bootstrap, upsert idempotency, and one-shot desktop codes', {
  skip: !process.env.NOVA_PGLITE_MODULE && 'Set NOVA_PGLITE_MODULE for isolated PostgreSQL validation',
}, async (t) => {
  const { PGlite } = await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as 'select null::uuid';`);
  await db.exec(await readMigration(name));
  await db.exec(await readMigration(name)); // idempotent
  const user = '00000000-0000-4000-8000-000000000011';
  await db.query('insert into auth.users values($1)', [user]);
  const first = (await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [user, 'Admin@Example.com', 'Admin', true, 'noel'])).rows[0];
  assert.deepEqual([first.status, first.role, first.host_id, first.created, first.email], ['approved', 'admin', 'noel', true, 'admin@example.com']);
  const again = (await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [user, 'admin@example.com', 'Renamed', false, null])).rows[0];
  assert.deepEqual([again.status, again.role, again.host_id, again.created, again.display_name], ['approved', 'admin', 'noel', false, 'Renamed']);
  const other = '00000000-0000-4000-8000-000000000022';
  await db.query('insert into auth.users values($1)', [other]);
  const pending = (await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [other, 'guest@example.com', null, false, null])).rows[0];
  assert.deepEqual([pending.status, pending.role, pending.host_id], ['pending', 'host', other]);
  const events = (await db.query('select action from public.profile_events order by id')).rows.map((r) => r.action);
  assert.deepEqual(events, ['bootstrap_admin', 'signup']);
  const byHost = (await db.query('select * from public.read_profile_by_host_id_v1($1)', ['noel'])).rows[0];
  assert.equal(byHost.id, user);
  const hash = Buffer.alloc(32, 7);
  const stateA = 'a'.repeat(43); const stateWrong = 'w'.repeat(43); const stateB = 'b'.repeat(43); // 32-byte base64url states are 43 chars
  assert.equal((await db.query('select public.issue_desktop_login_code_v1($1,$2,$3,now() + interval \'60 seconds\') as ok', [hash, user, stateA])).rows[0].ok, true);
  assert.equal((await db.query('select count(*)::int as n from public.consume_desktop_login_code_v1($1,$2)', [hash, stateWrong])).rows[0].n, 0);
  const consumed = (await db.query('select * from public.consume_desktop_login_code_v1($1,$2)', [hash, stateA])).rows;
  assert.equal(consumed.length, 1); assert.equal(consumed[0].host_id, 'noel');
  assert.equal((await db.query('select count(*)::int as n from public.consume_desktop_login_code_v1($1,$2)', [hash, stateA])).rows[0].n, 0);
  const expired = Buffer.alloc(32, 9);
  await db.query('select public.issue_desktop_login_code_v1($1,$2,$3,now() - interval \'1 second\')', [expired, user, stateB]);
  assert.equal((await db.query('select count(*)::int as n from public.consume_desktop_login_code_v1($1,$2)', [expired, stateB])).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from public.desktop_login_codes where code_hash=$1', [expired])).rows[0].n, 0);
});
