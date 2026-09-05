import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const name = '202608310005_live_canonical_source_snapshots.sql';
const hostSnapshotMigration = '202609010002_live_host_source_snapshot.sql';
const readMigration = (file) => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
test('canonical source migration is additive and bootstrap matches exactly', async () => {
  const sql = await readMigration(name);
  const bootstrap = await readFile(new URL('../supabase/bootstrap-new-project.sql', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes(`-- supabase/migrations/${name}\n\n${sql}`));
  assert.doesNotMatch(sql, /\b(?:drop table|drop column|truncate)\b/iu);
  const hostSql = await readMigration(hostSnapshotMigration);
  assert.ok(bootstrap.includes(`-- supabase/migrations/${hostSnapshotMigration}\n\n${hostSql}`));
  assert.doesNotMatch(hostSql, /\b(?:insert into|update public|delete from|grant select|drop|truncate)\b/iu);
  const inputSql=await readMigration('202609010004_live_input_source_provenance.sql');
  assert.ok(bootstrap.includes('-- supabase/migrations/202609010004_live_input_source_provenance.sql\n\n'+inputSql));
  assert.doesNotMatch(inputSql,/\b(?:drop table|drop column|truncate|delete from|grant select)\b/iu);
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
    create table public.live_media_recording_gaps(id uuid primary key,session_id uuid,epoch integer not null default 0,started_at timestamptz,ended_at timestamptz,reason text);
  `);
  const original = await readMigration('202608220001_live_authoritative_source_transcript.sql');
  await db.exec(original.slice(original.indexOf('create table public.live_source_utterances'), original.indexOf('-- ─── Source commit')));
  const originalCommit = original.match(/create or replace function public\.persist_authoritative_live_source_utterance_v1\([\s\S]*?\n\$\$;/u);
  await db.exec(originalCommit[0]);
  await db.exec(original.match(/create or replace function public\.read_authoritative_live_summary_input_v1\([\s\S]*?\n\$\$;/u)[0]);
  const fenced = await readMigration('202608310004_live_media_write_epoch_fences.sql');
  await db.exec(fenced.match(/create or replace function public\.assert_live_media_write_epoch_v1\([\s\S]*?\n\$\$;/u)[0]);
  await db.exec(await readMigration(name));
  await db.exec(await readMigration(name));
  const recapSql = await readMigration('202608310002_live_recap_requests_and_record_access.sql');
  await db.exec(recapSql.match(/create or replace function public\.read_owned_live_recording_gaps_v1\([\s\S]*?\n\$\$;/u)[0]);
  await db.exec(await readMigration(hostSnapshotMigration));
  await db.exec(await readMigration(hostSnapshotMigration));
  await db.exec(await readMigration('202609010003_live_source_recording_gaps.sql'));
  await db.exec(await readMigration('202609010004_live_input_source_provenance.sql'));
  await db.exec(await readMigration('202609010004_live_input_source_provenance.sql'));
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
  await t.test('participant source refresh restores known source failures without inventing a caption',async()=>{
    const gapId='00000000-0000-4000-8000-000000000009';
    await db.query("select public.record_live_source_gap_v1($1,$2,now()-interval '10 seconds',now()-interval '1 second',3,$3)",[session,gapId,owner]);
    const page=await snapshot();assert.equal(page.sources.length,1);
    assert.equal(page.recordingGaps.length,1);assert.equal(page.recordingGaps[0].reason,'source_recording_failed');
    await assert.rejects(snapshot('outsider'),/SOURCE_FORBIDDEN/u);
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
  await t.test('host reads the same canonical ledger during live states and after participant access expires',async()=>{
    const hostRead=async(hostId='host',after=0,size=1)=>(await db.query('select public.read_owned_live_source_snapshot_v1($1,$2,$3,$4) value',[session,hostId,after,size])).rows[0].value;
    const sourceId=(await hostRead()).sources[0].sourceUtteranceId;
    await db.query("insert into live_sessions(id,host_id,status,expires_at) values($1,'another-host','live',now()+interval '1 hour')",[owner]);
    await db.query("insert into live_source_utterance_corrections(source_utterance_id,session_id,revision,corrected_text,actor_host_id) values($1,$2,2,'Wrong-session correction','another-host')",[sourceId,owner]);
    await db.query("insert into live_media_recording_gaps(id,session_id,started_at,ended_at,reason) values($1,$2,now(),null,'host_unavailable')",[grant,session]);
    for(const status of ['preparing','live','paused','stopped','failed']) {
      await db.query("update live_sessions set status=$2,ended_at=now()-interval '7 hours',expires_at=now()-interval '1 hour' where id=$1",[session,status]);
      const page=await hostRead();
      assert.equal(page.sources[0].text,'수정된 원문');assert.equal(page.sources[0].sourceLanguage,'und');
      assert.deepEqual(page.sources[0].languageObservation,observation);
      assert.equal(page.lastSourceSeq,2);assert.equal(page.hasNextPage,true);assert.equal(page.nextAfterSourceSeq,1);
      assert.equal(page.recordsExpiresAt,null);assert.equal(page.recordingGaps.find(gap=>gap.id===grant).reason,'host_unavailable');assert.equal(page.recordingGaps.find(gap=>gap.id===grant).endedAt,null);
      assert.doesNotMatch(JSON.stringify(page),/raw_text|Private|sttProvider|translations|participantId/u);
    }
    const tail=await hostRead('host',1);assert.equal(tail.sources[0].sourceSeq,2);assert.equal(tail.hasNextPage,false);
    await assert.rejects(hostRead('another-host'),/SOURCE_FORBIDDEN/u);
    for(const invalid of [{after:-1,size:1},{after:0,size:501},{after:9007199254740992,size:1}])await assert.rejects(hostRead('host',invalid.after,invalid.size),/INVALID_SOURCE_SNAPSHOT_INPUT/u);
    await assert.rejects(snapshot('member',null),/RECAP_EXPIRED/u);
    await db.query('update live_sessions set archive_deleted_at=now() where id=$1',[session]);
    await assert.rejects(hostRead(),/SOURCE_FORBIDDEN/u);
    await db.query('update live_sessions set archive_deleted_at=null where id=$1',[session]);
  });
  await t.test('host snapshot grants only the new definer RPC and keeps canonical tables private',async()=>{
    const info=(await db.query("select prosecdef,provolatile,proconfig,has_function_privilege('service_role',oid,'EXECUTE') service,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated from pg_proc where proname='read_owned_live_source_snapshot_v1'")).rows[0];
    assert.equal(info.prosecdef,true);assert.equal(info.provolatile,'s');assert.deepEqual(info.proconfig,['search_path=""']);
    assert.equal(info.service,true);assert.equal(info.anon,false);assert.equal(info.authenticated,false);
    assert.equal(await scalar("select has_table_privilege('service_role','public.live_source_utterances','SELECT') value"),false);
    assert.equal(await scalar("select has_table_privilege('service_role','public.live_source_utterance_corrections','SELECT') value"),false);
    await db.exec('set role service_role');
    assert.equal((await db.query('select public.read_owned_live_source_snapshot_v1($1,$2,0,500) value',[session,'host'])).rows[0].value.sources.length,2);
    await db.exec('reset role');
    for(const role of ['anon','authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select public.read_owned_live_source_snapshot_v1($1,$2,0,500)',[session,'host']),/permission denied/u);
      await db.exec('reset role');
    }
  });
  await db.exec('alter table public.live_sessions add column archived_at timestamptz');
  await t.test('Live input source raw text and truthful finalization persist independently through all four boundaries',async()=>{
    await db.query("update live_sessions set status='live',ended_at=null,expires_at=now()+interval '1 hour',archive_deleted_at=null where id=$1",[session]);
    await db.query("update live_session_runtime set state='active',owner_lease_expires_at=now()+interval '1 hour' where session_id=$1",[session]);
    const neutral={state:'unknown',languageCode:'und',providerLanguageCode:null,evidence:'neutral',languages:[]};
    const provenance={kind:'live-input-transcription',streamGeneration:owner,captureEpoch:grant,finalization:'application-quiet-boundary'};
    const sourceArgs=(key,proof=provenance)=>[session,key,'  2026  ','2026','und','unknown',null,null,null,null,null,null,
      '2026-09-01T00:00:01Z','2026-09-01T00:00:02Z','gemini-live-input-transcription','gemini-3.5-live-translate-preview',null,null,neutral,proof];
    const write=async(key,proof=provenance,epoch=3)=>{
      const args=[epoch,owner,...sourceArgs(key,proof)];
      return (await db.query('select public.persist_authoritative_live_source_utterance_v3_fenced_v1('+args.map((_,i)=>'$'+(i+1)).join(',')+') value',args)).rows[0].value;
    };
    for(const finalization of ['provider-finished','application-quiet-boundary','application-drain-boundary','application-length-boundary']) {
      const proof={...provenance,finalization};const key='live-input:'+finalization;
      const first=await write(key,proof);assert.equal(first.idempotent,false);
      assert.equal((await write(key,proof)).idempotent,true);
      const row=(await db.query('select * from live_source_utterances where id=$1',[first.sourceUtteranceId])).rows[0];
      assert.equal(row.raw_text,'  2026  ');assert.equal(row.normalized_text,'2026');assert.equal(row.source_started_at,null);
      assert.equal(row.stt_model,'gemini-3.5-live-translate-preview');assert.deepEqual(row.source_provenance,proof);
      assert.equal(row.translation_model,null);assert.equal(row.source_language,'und');
      await assert.rejects(write(key,{...proof,captureEpoch:participant}),/SOURCE_UTTERANCE_IDEMPOTENCY_CONFLICT/u);
    }
    assert.equal((await snapshot()).sources.filter(source=>source.text==='2026').length,4);
    await assert.rejects(write('stale-owner',provenance,2),/MEDIA_WRITE_EPOCH_CONFLICT/u);
    const legacyArgs=sourceArgs('legacy-null').slice(0,-1);
    await db.query('select public.persist_authoritative_live_source_utterance_v2('+legacyArgs.map((_,i)=>'$'+(i+1)).join(',')+')',legacyArgs);
    await assert.rejects(write('legacy-null'),/SOURCE_UTTERANCE_IDEMPOTENCY_CONFLICT/u);
    assert.equal((await db.query("select source_provenance from live_source_utterances where utterance_key='legacy-null'")).rows[0].source_provenance,null);
    const before=Number((await db.query('select count(*) total from live_source_utterances')).rows[0].total);
    for(const invalid of [{...provenance,finalization:'guessed'},{...provenance,private:'extra'},{...provenance,captureEpoch:'not-uuid'},null]) {
      await assert.rejects(write('invalid',invalid),/INVALID_LIVE_SOURCE_PROVENANCE/u);
    }
    assert.equal(Number((await db.query('select count(*) total from live_source_utterances')).rows[0].total),before);
    await db.query("update live_sessions set status='stopped',ended_at=now() where id=$1",[session]);
    await assert.rejects(write('late-final'),/MEDIA_SESSION_ENDED/u);
    assert.equal(Number((await db.query('select count(*) total from live_source_utterances')).rows[0].total),before);
    assert.equal((await snapshot('member',null)).sources.filter(source=>source.text==='2026').length,5);
    const summaryInput=(await db.query('select * from public.read_authoritative_live_summary_input_v1($1,0,500)',[session])).rows;
    assert.equal(summaryInput.filter(row=>row.effective_text==='2026').length,5);
    assert.ok(summaryInput.filter(row=>row.effective_text==='2026').every(row=>row.source_started_at===null));
    for(const role of ['anon','authenticated']) {
      const allowed=(await db.query("select has_function_privilege($1,oid,'EXECUTE') allowed from pg_proc where proname='persist_authoritative_live_source_utterance_v3_fenced_v1'",[role])).rows[0].allowed;
      assert.equal(allowed,false);
    }
  });
});
