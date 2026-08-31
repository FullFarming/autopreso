import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const name = '202608310005_live_canonical_source_snapshots.sql';
const readMigration = (file) => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
test('canonical source migration is additive and bootstrap matches exactly', async () => {
  const sql = await readMigration(name);
  const bootstrap = await readFile(new URL('../supabase/bootstrap-new-project.sql', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes(`-- supabase/migrations/${name}\n\n${sql}`));
  assert.doesNotMatch(sql, /\b(?:drop table|drop column|truncate)\b/iu);
});

test('canonical source PostgreSQL persists observations and protects live and six-hour snapshots', {
  skip: !process.env.NOVA_PGLITE_MODULE && 'Set NOVA_PGLITE_MODULE for isolated PostgreSQL validation',
}, async (t) => {
  const { PGlite } = await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create schema extensions; create role anon; create role authenticated; create role service_role;
    create function extensions.gen_random_uuid() returns uuid language sql as 'select gen_random_uuid()';
    create table public.live_sessions(id uuid primary key,host_id text,status text,expires_at timestamptz,
      ended_at timestamptz,archive_deleted_at timestamptz,pinned_glossary_fingerprint text);
    create table public.live_participants(id uuid primary key,session_id uuid,user_id text,records_revoked_at timestamptz,
      display_name text,department text,job_title text);
    create table public.viewer_grants(id uuid primary key,session_id uuid,user_id text,revoked_at timestamptz,expires_at timestamptz);
    create table public.live_session_runtime(session_id uuid primary key,epoch integer,owner_id uuid,owner_lease_expires_at timestamptz,state text);
  `);
  const original = await readMigration('202608220001_live_authoritative_source_transcript.sql');
  await db.exec(original.slice(original.indexOf('create table public.live_source_utterances'), original.indexOf('-- ─── Source commit')));
  const originalCommit = original.match(/create or replace function public\.persist_authoritative_live_source_utterance_v1\([\s\S]*?\n\$\$;/u);
  await db.exec(originalCommit[0]);
  const fenced = await readMigration('202608310004_live_media_write_epoch_fences.sql');
  await db.exec(fenced.match(/create or replace function public\.assert_live_media_write_epoch_v1\([\s\S]*?\n\$\$;/u)[0]);
  await db.exec(await readMigration(name));
  await db.exec(await readMigration(name));
  const session = '00000000-0000-4000-8000-000000000001';
  const participant = '00000000-0000-4000-8000-000000000002';
  const grant = '00000000-0000-4000-8000-000000000003';
  const owner = '00000000-0000-4000-8000-000000000004';
  const observation = { state: 'mixed', languageCode: 'und', providerLanguageCode: 'ko-KR', evidence: 'conflict', languages: ['ko', 'en'] };
  const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0].value;
  await db.query(`insert into public.live_sessions values($1,'host','live',now()+interval '1 hour',null,null,null);
    `, [session]);
  await db.query("insert into public.live_participants values($1,$2,'member',null,'Private Name','Private Team','Private Job')", [participant,session]);
  await db.query("insert into public.viewer_grants values($1,$2,'member',null,now()+interval '1 hour')", [grant,session]);
  await db.query("insert into public.live_session_runtime values($1,3,$2,now()+interval '30 seconds','active')", [session,owner]);
  const persist = (obs=observation, epoch=3) => scalar(`select public.persist_authoritative_live_source_utterance_v2_fenced_v1(
    $1,$2,$3,'key-1','매출 revenue','매출 revenue','und','host','1','Private Owner',null,null,null,
    null,'2026-08-31T00:00:00Z','2026-08-31T00:00:01Z','google-stt',null,null,null,$4) as value`, [epoch,owner,session,obs]);
  const snapshot = (user='member', grantId=grant, after=0, size=200) => scalar(
    'select public.read_participant_live_source_snapshot_v1($1,$2,$3,$4,$5) as value',[session,user,grantId,after,size]);
  await t.test('durable observation preserves und and replay does not duplicate sequence',async()=>{
    const first = await persist(); const replay = await persist();
    assert.equal(first.sourceSeq,1); assert.equal(replay.idempotent,true); assert.equal(replay.sourceUtteranceId,first.sourceUtteranceId);
    await assert.rejects(persist({...observation,evidence:'script'}),/SOURCE_UTTERANCE_IDEMPOTENCY_CONFLICT/u);
    await assert.rejects(persist(observation,2),/MEDIA_WRITE_EPOCH_CONFLICT/u);
    await assert.rejects(persist({...observation,languageCode:'ko'}),/INVALID_SOURCE_LANGUAGE_OBSERVATION/u);
  });
  await t.test('single ledger snapshot preserves observations and excludes private/provider columns',async()=>{
    const page = await snapshot(); assert.equal(page.sources.length,1); assert.equal(page.sources[0].sourceLanguage,'und');
    assert.deepEqual(page.sources[0].languageObservation,observation); assert.equal(page.sources[0].speaker.label,'발표자');
    assert.equal(page.sources[0].sourceSeq,1); assert.equal(page.recordsExpiresAt,null);
    const sourceId = page.sources[0].sourceUtteranceId;
    const joined = await db.query('select * from public.read_live_caption_source_observations_v1($1,$2)',[session,[sourceId]]);
    assert.deepEqual(joined.rows[0].language_observation,observation);
    assert.equal((await db.query('select * from public.read_live_caption_source_observations_v1($1,$2)',[owner,[sourceId]])).rows.length,0);
    assert.doesNotMatch(JSON.stringify(page),/Private|rawText|sttProvider|participantId/u);
    assert.equal((await snapshot('member',grant,1)).sources.length,0);
    await assert.rejects(snapshot('outsider'),/SOURCE_FORBIDDEN/u);
    await assert.rejects(snapshot('member',owner),/SOURCE_FORBIDDEN/u);
    await assert.rejects(snapshot('member',null),/SOURCE_FORBIDDEN/u);
  });
  await t.test('keyset pages retain legacy null observations and apply the latest owned correction',async()=>{
    const initial = await snapshot();
    const sourceId = initial.sources[0].sourceUtteranceId;
    await db.query(`insert into public.live_source_utterances(id,session_id,source_seq,utterance_key,raw_text,
      normalized_text,source_language,speaker_role,source_ended_at,provider_committed_at,stt_provider)
      values($1,$2,2,'legacy-key','Earlier writer','Earlier writer','en','unknown',now(),now(),'legacy')`,[owner,session]);
    await db.query(`insert into public.live_source_utterance_corrections(source_utterance_id,session_id,revision,corrected_text,actor_host_id)
      values($1,$2,1,'수정된 원문','host')`,[sourceId,session]);
    const first = await snapshot('member',grant,0,1);
    assert.equal(first.hasNextPage,true); assert.equal(first.nextAfterSourceSeq,1); assert.equal(first.lastSourceSeq,2);
    assert.equal(first.sources[0].text,'수정된 원문');
    const second = await snapshot('member',grant,first.nextAfterSourceSeq,1);
    assert.equal(second.sources[0].sourceSeq,2); assert.equal(second.sources[0].languageObservation,null);
    assert.equal(second.sources[0].sourceLanguage,'en'); assert.equal(second.hasNextPage,false);
    await assert.rejects(snapshot('member',grant,0,501),/INVALID_SOURCE_SNAPSHOT_INPUT/u);
  });
  await t.test('revocation and actual six-hour expiry cannot be bypassed with a live grant',async()=>{
    await db.query('update public.live_participants set records_revoked_at=now() where id=$1',[participant]);
    await assert.rejects(snapshot(),/SOURCE_FORBIDDEN/u);
    await db.query('update public.live_participants set records_revoked_at=null where id=$1',[participant]);
    await db.query("update public.live_sessions set status='stopped',ended_at=now()-interval '1 minute' where id=$1",[session]);
    assert.ok((await snapshot('member',null)).recordsExpiresAt);
    await db.query("update public.live_sessions set ended_at=now()-interval '6 hours' where id=$1",[session]);
    await assert.rejects(snapshot(),/RECAP_EXPIRED/u);
    await db.query('update public.live_sessions set ended_at=null where id=$1',[session]);
    await assert.rejects(snapshot('member',null),/RECAP_NOT_READY/u);
  });
  await t.test('public and authenticated roles cannot call source RPC or read its private table',async()=>{
    assert.equal(await scalar("select has_function_privilege('anon','public.read_participant_live_source_snapshot_v1(uuid,text,uuid,bigint,integer)','EXECUTE') as value"),false);
    assert.equal(await scalar("select has_table_privilege('authenticated','public.live_source_utterances','SELECT') as value"),false);
  });
});
