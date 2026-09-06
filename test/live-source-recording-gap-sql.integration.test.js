import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const migrationName = '202609010003_live_source_recording_gaps.sql';
const readMigration = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

test('source-gap repair preserves rows, ACLs, and the bootstrap mirror', async () => {
  const sql = await readMigration(migrationName);
  const bootstrap = await readFile(new URL('../supabase/bootstrap-new-project.sql', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes(`-- supabase/migrations/${migrationName}\n\n${sql}`));
  assert.doesNotMatch(sql, /\b(?:drop table|drop column|truncate|delete from|grant select)\b/iu);
});

test('known source failures remain durable without stopping translation or weakening media ownership', {
  skip: !process.env.NOVA_PGLITE_MODULE && 'Set NOVA_PGLITE_MODULE for isolated PostgreSQL validation',
}, async (t) => {
  const { PGlite } = await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.live_sessions(id uuid primary key,host_id text,status text,expires_at timestamptz,archive_deleted_at timestamptz);
    create table public.live_session_runtime(session_id uuid primary key,epoch integer,owner_id uuid,owner_lease_expires_at timestamptz,state text);
    create table public.live_media_recording_gaps(id uuid primary key,session_id uuid references public.live_sessions,
      epoch integer not null,started_at timestamptz not null,ended_at timestamptz,
      reason text not null check(reason in('no_viewers','host_unavailable','media_failed')),
      check(ended_at is null or ended_at>=started_at));
    create unique index live_media_one_open_gap_idx on public.live_media_recording_gaps(session_id) where ended_at is null;
    alter table public.live_media_recording_gaps enable row level security;
    revoke all on public.live_media_recording_gaps from public,anon,authenticated,service_role;`);
  const fenced = await readMigration('202608310004_live_media_write_epoch_fences.sql');
  await db.exec(fenced.match(/create or replace function public\.assert_live_media_write_epoch_v1\([\s\S]*?\n\$\$;/u)[0]);
  const recap = await readMigration('202608310002_live_recap_requests_and_record_access.sql');
  await db.exec(recap.match(/create or replace function public\.read_owned_live_recording_gaps_v1\([\s\S]*?\n\$\$;/u)[0]);
  await db.exec(await readMigration(migrationName));
  await db.exec(await readMigration(migrationName));
  const session = '10000000-0000-4000-8000-000000000001';
  const legacy = '10000000-0000-4000-8000-000000000002';
  const owner = '10000000-0000-4000-8000-000000000003';
  const segment = '10000000-0000-4000-8000-000000000004';
  const start = new Date(Date.now()-10000).toISOString();
  const end = new Date(Date.now()-1000).toISOString();
  const scalar = async (sql, args = []) => (await db.query(sql,args)).rows[0].value;
  const write = (id=segment, from=start, to=end, epoch=3, owned=owner, sessionId=session) => scalar(
    'select public.record_live_source_gap_v1($1,$2,$3,$4,$5,$6) value',[sessionId,id,from,to,epoch,owned]);
  await db.query("insert into public.live_sessions values($1,'host','live',now()+interval '1 hour',null),($2,'host','live',now()+interval '1 hour',null)",[session,legacy]);
  await db.query("insert into public.live_session_runtime values($1,3,$2,now()+interval '1 hour','active')",[session,owner]);
  await t.test('closed known interval coexists with open demand gap and exact replay is idempotent',async()=>{
    await db.query("insert into live_media_recording_gaps values($1,$2,3,now(),null,'no_viewers')",[owner,session]);
    assert.equal((await write()).idempotent,false); assert.equal((await write()).idempotent,true);
    assert.equal(await scalar('select count(*)::int value from live_media_recording_gaps'),2);
    assert.equal(await scalar('select status value from live_sessions where id=$1',[session]),'live');
    assert.equal(await scalar('select ended_at is null value from live_media_recording_gaps where id=$1',[owner]),true);
    const read = await scalar('select read_owned_live_recording_gaps_v1($1,$2) value',[session,'host']);
    assert.equal(read.recordingGaps.find(gap=>gap.id===segment).reason,'source_recording_failed');
    await assert.rejects(write(segment,start,new Date(Date.now()).toISOString()),/SOURCE_GAP_IDEMPOTENCY_CONFLICT/u);
  });
  await t.test('stale epoch, owner, and omitted fence cannot write into demand sessions',async()=>{
    await assert.rejects(write(segment,start,end,2),/MEDIA_WRITE_EPOCH_CONFLICT/u);
    await assert.rejects(write(segment,start,end,3,legacy),/MEDIA_WRITE_EPOCH_CONFLICT/u);
    await assert.rejects(write(segment,start,end,null,null),/MEDIA_WRITE_EPOCH_CONFLICT/u);
    await assert.rejects(write(segment,start,end,3,null),/INVALID_SOURCE_RECORDING_GAP/u);
  });
  await t.test('invalid, unknown, excessive and future intervals are rejected rather than estimating a whole call',async()=>{
    for(const [from,to] of [[null,end],[start,null],[end,start],['infinity','infinity'],[start,new Date(Date.now()+120000).toISOString()],[new Date(Date.now()-120000).toISOString(),end]]) {
      await assert.rejects(write(legacy,from,to),/INVALID_SOURCE_RECORDING_GAP/u);
    }
  });
  await t.test('legacy sessions permit a known unfenced window but conflicting cross-session ids are rejected',async()=>{
    assert.equal((await write(legacy,start,end,null,null,legacy)).idempotent,false);
    await assert.rejects(write(segment,start,end,null,null,legacy),/SOURCE_GAP_IDEMPOTENCY_CONFLICT/u);
  });
  await t.test('ended, paused, archived and expired sessions reject even an exact replay',async()=>{
    for(const change of ["status='stopped'","status='paused'","archive_deleted_at=now()","expires_at=now()-interval '1 second'"]) {
      await db.query(`update live_sessions set ${change} where id=$1`,[session]);
      await assert.rejects(write(),/MEDIA_SESSION_ENDED/u);
      await db.query("update live_sessions set status='live',archive_deleted_at=null,expires_at=now()+interval '1 hour' where id=$1",[session]);
    }
  });
  await t.test('only service-role RPC executes; direct table access remains revoked',async()=>{
    const signature='public.record_live_source_gap_v1(uuid,uuid,timestamptz,timestamptz,integer,uuid)';
    for(const role of ['anon','authenticated'])assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\') value',[role,signature]),false);
    assert.equal(await scalar('select has_function_privilege(\'service_role\',$1,\'EXECUTE\') value',[signature]),true);
    assert.equal(await scalar("select has_table_privilege('service_role','live_media_recording_gaps','SELECT') value"),false);
  });
});
