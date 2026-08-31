import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";

const readMigration = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
const extractFunction = (sql, name) => {
  const result = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "u"));
  assert.ok(result, name);
  return result[0];
};

test("persistence cleanup preserves actual-end recap dates with the real legacy CHECK", {
  skip: !process.env.NOVA_PGLITE_MODULE && "Set NOVA_PGLITE_MODULE to a local @electric-sql/pglite module",
}, async (t) => {
  const { PGlite } = await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.live_sessions (
      id uuid primary key default gen_random_uuid(),host_id text default 'fixture-host',
      mode text default 'meeting',session_type text default 'meeting',output_mode text default 'captions',
      voice_provider text default 'gemini',status text not null,languages text[] default '{ko,en}',
      viewer_count integer default 0,max_viewers integer default 50,version integer default 1,
      glossary_pack text default 'general_cre',title text default 'fixture',scheduled_at timestamptz,
      created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
      expires_at timestamptz not null,ended_at timestamptz,archive_deleted_at timestamptz,
      admission_code_hmac text,admission_open_until timestamptz,admission_generation bigint default 0,
      admission_state text default 'ended',voice_output_mode text default 'captions',
      floor_grant_id uuid,floor_display_name text,floor_taken_at timestamptz,
      constraint live_sessions_schedule_window_check check(scheduled_at is null or
        (scheduled_at>=created_at-interval '5 minutes' and scheduled_at<=created_at+interval '30 days')),
      constraint live_sessions_expiry_check check(expires_at>greatest(created_at,coalesce(scheduled_at,created_at))
        and expires_at<=greatest(created_at,coalesce(scheduled_at,created_at))+interval '6 hours')
    );
    create table public.viewer_grants (
      id uuid primary key default gen_random_uuid(),session_id uuid,user_id text,
      expires_at timestamptz,revoked_at timestamptz
    );
    create table public.live_recap_grants (
      session_id uuid,user_id text,expires_at timestamptz not null,created_at timestamptz not null,
      primary key(session_id,user_id),constraint live_recap_grants_expiry_check check(
        expires_at>created_at and expires_at<=created_at+interval '30 days')
    );
    create table public.live_participants (
      id uuid primary key default gen_random_uuid(),session_id uuid,grant_id uuid,user_id text,
      last_seen_at timestamptz default now(),left_at timestamptz,retention_expires_at timestamptz,
      records_revoked_at timestamptz,display_name text default 'fixture',email text default 'fixture@example.test',
      company text,department text,job_title text,summary_consent_at timestamptz,
      unique(session_id,user_id)
    );
    create table public.live_session_invites(session_id uuid,expires_at timestamptz,revoked_at timestamptz);
    create table public.live_snapshots(session_id uuid);
    create table public.session_speakers(session_id uuid);
    create table public.live_rate_limits(updated_at timestamptz);
    insert into public.live_sessions(status,created_at,ended_at,expires_at,scheduled_at)
    select 'stopped',now()-interval '10 days',now()-interval '8 days',
      now()-interval '9 days'+interval '6 hours',now()-interval '9 days' from generate_series(1,68);
  `);
  const legacyIdentity = await readMigration("202607230004_live_participant_identity_admission.sql");
  await database.exec(extractFunction(legacyIdentity, "sync_live_participants_on_session_end"));
  await database.exec(`create trigger live_sessions_participant_retention_after_end
    after update of status,ended_at on public.live_sessions
    for each row execute function public.sync_live_participants_on_session_end();`);
  const before = (await database.query("select * from public.live_sessions order by id")).rows;
  const migration = await readMigration("202608310001_live_session_persistence.sql");
  await database.exec("begin");
  await database.exec(migration);
  await database.exec("commit");
  const recordAccess = await readMigration("202608310002_live_recap_requests_and_record_access.sql");
  await database.exec(extractFunction(recordAccess, "read_participant_live_record_access_v1"));
  const query = (sql, params = []) => database.query(sql, params);
  const cleanup = () => query("select public.cleanup_expired_live_state()");
  const createLiveMember = async () => {
    const session = (await query(`insert into public.live_sessions(status,expires_at)
      values ('live',now()+interval '6 hours') returning id`)).rows[0].id;
    const user = crypto.randomUUID();
    const grant = (await query(`insert into public.viewer_grants(session_id,user_id,expires_at)
      values ($1,$2,now()+interval '6 hours') returning id`, [session,user])).rows[0].id;
    await query("insert into public.live_participants(session_id,user_id,grant_id) values ($1,$2,$3)",[session,user,grant]);
    return { session,user,grant };
  };

  await t.test("68 existing stopped rows keep every existing value and acquire their original created-at anchor", async () => {
    const after = (await query("select * from public.live_sessions order by id")).rows;
    assert.equal(after.length,68);
    for (let index=0;index<68;index++) {
      const {access_window_started_at,...unchanged}=after[index];
      assert.deepEqual(unchanged,before[index]);
      assert.equal(new Date(access_window_started_at).getTime(),new Date(before[index].created_at).getTime());
    }
    await assert.rejects(query("select public.renew_live_session_access_v1($1,'fixture-host',1)",[before[0].id]),/VERSION_CONFLICT_OR_FORBIDDEN/u);
  });
  await t.test("existing actual-end trigger receipt survives two cleanup runs without extending either timestamp", async () => {
    const member=await createLiveMember();
    await query("update public.live_sessions set status='stopped',ended_at=now() where id=$1",[member.session]);
    const original=(await query("select * from public.live_recap_grants where session_id=$1",[member.session])).rows[0];
    assert.ok(original);
    await cleanup();
    await cleanup();
    const retained=(await query("select * from public.live_recap_grants where session_id=$1",[member.session])).rows[0];
    assert.deepEqual(retained,original);
    assert.equal((await query("select * from public.viewer_grants where session_id=$1",[member.session])).rows.length,0);
    const access=(await query("select * from public.read_participant_live_record_access_v1($1,$2)",[member.session,member.user])).rows[0];
    assert.equal(new Date(access.records_expires_at).getTime()-new Date(access.ended_at).getTime(),6*3600000);
  });
  await t.test("missing receipt is recovered from actual end, with multiple device grants producing one receipt", async () => {
    const row=(await query(`insert into public.live_sessions(status,created_at,ended_at,expires_at,access_window_started_at)
      values ('stopped',now()-interval '2 days',now()-interval '1 day',
      now()-interval '2 days'+interval '6 hours',now()-interval '2 days') returning id,ended_at`)).rows[0];
    const user=crypto.randomUUID();
    await query(`insert into public.viewer_grants(session_id,user_id,expires_at)
      values ($1,$2,now()+interval '1 hour'),($1,$2,now()+interval '1 hour')`,[row.id,user]);
    await cleanup(); await cleanup();
    const receipts=(await query("select * from public.live_recap_grants where session_id=$1",[row.id])).rows;
    assert.equal(receipts.length,1);
    assert.equal(new Date(receipts[0].created_at).getTime(),new Date(row.ended_at).getTime());
    assert.equal(new Date(receipts[0].expires_at).getTime()-new Date(row.ended_at).getTime(),30*86400000);
  });
  await t.test("six-hour admission expiry preserves a live meeting and does not mint a terminal receipt", async () => {
    const row=(await query(`insert into public.live_sessions(status,created_at,expires_at,access_window_started_at)
      values ('live',now()-interval '7 hours',now()-interval '1 hour',now()-interval '7 hours') returning id`)).rows[0];
    const user=crypto.randomUUID();
    await query("insert into public.viewer_grants(session_id,user_id,expires_at) values ($1,$2,now()-interval '1 hour')",[row.id,user]);
    await cleanup();
    assert.equal((await query("select status from public.live_sessions where id=$1",[row.id])).rows[0].status,"live");
    assert.equal((await query("select * from public.live_recap_grants where session_id=$1",[row.id])).rows.length,0);
    assert.equal((await query("select * from public.viewer_grants where session_id=$1",[row.id])).rows.length,0);
  });
  await t.test("cleanup does not reset an ended-plus-six-hours participant deadline", async () => {
    const member=await createLiveMember();
    await query("update public.live_sessions set status='stopped',ended_at=now()-interval '7 hours' where id=$1",[member.session]);
    await cleanup(); await cleanup();
    await assert.rejects(query("select * from public.read_participant_live_record_access_v1($1,$2)",[member.session,member.user]),/RECAP_EXPIRED/u);
  });
  await t.test("missing actual end or a past 30-day envelope cannot mint a new receipt", async () => {
    const rows=(await query(`insert into public.live_sessions(status,created_at,ended_at,expires_at,access_window_started_at)
      values ('stopped',now(),null,now()+interval '6 hours',now()),
      ('stopped',now()-interval '32 days',now()-interval '31 days',
      now()-interval '32 days'+interval '6 hours',now()-interval '32 days') returning id`)).rows;
    for (const row of rows) {
      await query("insert into public.viewer_grants(session_id,user_id,expires_at) values ($1,$2,now()+interval '1 hour')",[row.id,crypto.randomUUID()]);
    }
    await cleanup(); await cleanup();
    for (const row of rows) {
      assert.equal((await query("select * from public.live_recap_grants where session_id=$1",[row.id])).rows.length,0);
      assert.equal((await query("select * from public.viewer_grants where session_id=$1",[row.id])).rows.length,0);
    }
  });
});
