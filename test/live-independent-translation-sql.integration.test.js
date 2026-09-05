import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const migrationName = '202609010001_live_independent_translation_capture.sql';
const readMigration = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
test('independent translation migration is additive and mirrored exactly in bootstrap', async () => {
  const sql = await readMigration(migrationName);
  const bootstrap = await readFile(new URL('../supabase/bootstrap-new-project.sql', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes(`-- supabase/migrations/${migrationName}\n\n${sql}`));
  assert.doesNotMatch(sql, /\b(?:drop|truncate|delete from)\b/iu);
});

test('isolated PostgreSQL validates independent translation, atomic replay, fencing and old-writer compatibility', {
  skip: !process.env.NOVA_PGLITE_MODULE && 'Set NOVA_PGLITE_MODULE for isolated PostgreSQL validation',
}, async (t) => {
  const { PGlite } = await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.live_sessions(id uuid primary key,status text,expires_at timestamptz,archive_deleted_at timestamptz,
      languages text[],mode text default 'conference',voice_output_mode text default 'disabled');
    create table public.live_participants(id uuid primary key,session_id uuid,utterance_count integer default 0,
      speaking_seconds numeric default 0,last_spoke_at timestamptz,last_seen_at timestamptz);
    create table public.live_utterances(session_id uuid,language text,seq bigint,speaker_label text,speaker_name text,
      text text,source_started_at timestamptz,source_ended_at timestamptz,emitted_at timestamptz,participant_id uuid,
      source_text text,source_language text,origin text,utterance_key text,translation_status text,authoritative_source_id uuid,
      primary key(session_id,language,seq));
    create table public.live_snapshots(session_id uuid,language text,last_seq bigint,captions jsonb,speaker_legend jsonb,
      updated_at timestamptz,primary key(session_id,language));
    create table public.live_session_runtime(session_id uuid primary key,epoch integer,owner_id uuid,owner_lease_expires_at timestamptz,state text);
    alter table public.live_utterances enable row level security;
    alter table public.live_snapshots enable row level security;`);
  const loadFunction = async (file, name, replacement = name) => {
    const sql = await readMigration(file);
    const match = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, 'u'));
    assert.ok(match, `${name} must exist in ${file}`);
    await db.exec(match[0].replace(`public.${name}(`, `public.${replacement}(`));
  };
  await loadFunction('202607240004_live_complete_utterance_recording.sql', 'persist_live_utterance_if_active');
  await loadFunction('202607230004_live_participant_identity_admission.sql', 'persist_live_utterance_if_active');
  await loadFunction('202607250001_live_utterance_source_text.sql', 'persist_live_utterance_if_active');
  await loadFunction('202607250002_live_snapshot_caption_provenance.sql', 'persist_live_snapshot_if_active', 'persist_live_snapshot_if_active_20260725');
  await loadFunction('202607260001_live_caption_identity_provenance.sql', 'persist_live_snapshot_if_active');
  await loadFunction('202607260001_live_caption_identity_provenance.sql', 'persist_live_utterance_if_active');
  await loadFunction('202607260003_live_utterance_replay_provenance.sql', 'persist_live_utterance_if_active');
  await loadFunction('20260726064308_atomic_live_final_caption.sql', 'persist_live_final_caption_if_active');
  await loadFunction('202608310004_live_media_write_epoch_fences.sql', 'assert_live_media_write_epoch_v1');
  await assert.rejects(db.query('select public.persist_independent_live_translation_v1($1,$2,$3)', [null,'en',{}]), /does not exist/u);
  const migration = await readMigration(migrationName);
  await db.exec(migration); await db.exec(migration);
  const session = '00000000-0000-4000-8000-000000000001';
  const owner = '00000000-0000-4000-8000-000000000002';
  const stream = '00000000-0000-4000-8000-000000000003';
  const participant = '00000000-0000-4000-8000-000000000004';
  const at = '2026-09-01T00:00:01.000Z';
  const event = {type:'caption',sessionId:session,language:'en',seq:1,text:'Direct translation.',speaker:null,isFinal:true,
    sourceText:null,sourceLanguage:null,sourceStartedAt:null,sourceEndedAt:at,emittedAt:at,translationStatus:'translated',
    utteranceKey:`lt:${stream}:1`,translationCapture:{kind:'independent-live-translation',streamGeneration:stream,
      captureEpoch:owner,captureStartedAt:'2026-09-01T00:00:00.000Z',captureEndedAt:at,finalization:'application-sentence-boundary'}};
  await db.query("insert into live_sessions(id,status,expires_at,languages) values($1,'live',now()+interval '1 hour',array['en','ja'])",[session]);
  await db.query("insert into live_session_runtime values($1,1,$2,now()+interval '1 hour','active')",[session,owner]);
  await db.query('insert into live_participants(id,session_id) values($1,$2)',[participant,session]);
  const persist = async (value = event, epoch = 1, gatewayOwner = owner) => (await db.query(
    'select public.persist_independent_live_translation_v1_fenced_v1($1,$2,$3,$4,$5) as value',
    [epoch,gatewayOwner,session,value.language,value])).rows[0].value;
  const state = async () => (await db.query(`select jsonb_build_object('rows',(select jsonb_agg(t) from live_utterances t),
    'snapshot',(select jsonb_agg(t) from live_snapshots t)) as value`)).rows[0].value;
  await t.test('final persists before any source exists and exact replay keeps one row',async()=>{
    assert.equal(await persist(),true); const first=await state(); assert.equal(await persist(),true); assert.deepEqual(await state(),first);
    const row=first.rows[0]; assert.deepEqual(row.translation_capture,event.translationCapture);
    for(const key of ['authoritative_source_id','source_text','source_language','source_started_at','origin','participant_id']) assert.equal(row[key],null);
    assert.deepEqual(first.snapshot[0].captions[0].translationCapture,event.translationCapture);
  });
  await t.test('conflicting replay, sequence gaps and malformed provenance cannot modify either store',async()=>{
    const before=await state();
    for(const patch of [{text:'Conflicting replay.'},{translationCapture:{...event.translationCapture,captureEpoch:stream}},
      {seq:3,utteranceKey:`lt:${stream}:3`},{sourceLanguage:'ko'},{authoritativeSourceId:owner},
      {translationCapture:{...event.translationCapture,finalization:'provider-final'}},
      {translationCapture:{...event.translationCapture,captureStartedAt:'2027-01-01T00:00:00.000Z'}},
      {translationCapture:{...event.translationCapture,extra:true}},{unexpected:true}]) {
      await assert.rejects(persist({...event,...patch})); assert.deepEqual(await state(),before);
    }
  });
  await t.test('speaker capture preserves identity but never invents source duration or participant statistics',async()=>{
    const speaker={speakerId:`participant:${participant}`,label:'참여자',colorToken:'speaker-teal',voiceName:null,
      voiceStatus:'disabled',lastSeenAt:at,name:'Participant',department:'Research'};
    const second={...event,seq:2,utteranceKey:`lt:${stream}:2`,speaker};
    assert.equal(await persist(second),true);
    await assert.rejects(persist({...second,speaker:{...speaker,department:'Changed'}}),/INDEPENDENT_TRANSLATION_REPLAY_CONFLICT/u);
    const row=(await db.query('select * from live_utterances where seq=2')).rows[0]; assert.equal(row.speaker_label,speaker.speakerId);
    assert.equal(row.participant_id,null); assert.equal(row.source_started_at,null);
    const profile=(await db.query('select * from live_participants')).rows[0]; assert.equal(profile.utterance_count,0); assert.equal(Number(profile.speaking_seconds),0);
    await assert.rejects(persist({...event,seq:3,utteranceKey:`lt:${stream}:3`,speaker:{...speaker,speakerId:`participant:${owner}`}}),/INDEPENDENT_TRANSLATION_PARTICIPANT_INVALID/u);
  });
  await t.test('epoch, owner, archive, session state and expiry fail closed without writes',async()=>{
    const before=await state();
    await assert.rejects(persist(event,2),/MEDIA_WRITE_EPOCH_CONFLICT/u);
    await assert.rejects(persist(event,1,stream),/MEDIA_WRITE_EPOCH_CONFLICT/u);
    for(const assignment of ["status='paused'","status='stopped'","archive_deleted_at=now()","expires_at=now()-interval '1 second'"]) {
      await db.exec(`update live_sessions set ${assignment}`); await assert.rejects(persist(),/MEDIA_SESSION_ENDED/u);
      assert.equal((await db.query('select public.persist_independent_live_translation_v1($1,$2,$3) value',[session,'en',event])).rows[0].value,false);
      await db.exec("update live_sessions set status='live',archive_deleted_at=null,expires_at=now()+interval '1 hour'");
    }
    assert.deepEqual(await state(),before);
  });
  await t.test('old writer still works but an independent event cannot overwrite its sequence',async()=>{
    const old={...event,language:'ja',utteranceKey:'old-source-key'}; delete old.translationCapture;
    assert.equal((await db.query(`select public.persist_live_final_caption_if_active($1,'ja',$2,1,$3,null,null,null,$4,$4,null,null,null,null,'old-source-key','translated') value`,[session,old,old.text,at])).rows[0].value,true);
    const before=await state(); await assert.rejects(persist({...event,language:'ja'}),/INDEPENDENT_TRANSLATION_REPLAY_CONFLICT/u); assert.deepEqual(await state(),before);
  });
  await t.test('failure after the delegated writer rolls back both newly inserted stores',async()=>{
    await db.exec("alter table live_utterances add constraint test_metadata_failure check (translation_capture is null or text <> 'Fail metadata patch.')");
    const before=await state();
    await assert.rejects(persist({...event,seq:3,utteranceKey:`lt:${stream}:3`,text:'Fail metadata patch.'}),/test_metadata_failure/u);
    assert.deepEqual(await state(),before);
  });
  await t.test('new functions are service-only with empty search_path and preserve table RLS',async()=>{
    for(const name of ['persist_independent_live_translation_v1','persist_independent_live_translation_v1_fenced_v1']) {
      const row=(await db.query("select prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service from pg_proc where proname=$1",[name])).rows[0];
      assert.equal(row.prosecdef,true);assert.deepEqual(row.proconfig,['search_path=""']);assert.equal(row.anon,false);assert.equal(row.authenticated,false);assert.equal(row.service,true);
    }
    const rows=(await db.query("select relrowsecurity from pg_class where oid in ('public.live_utterances'::regclass,'public.live_snapshots'::regclass)")).rows;
    assert.ok(rows.every(row=>row.relrowsecurity));
    await db.exec('set role service_role'); assert.equal(await persist(),true); await db.exec('reset role');
  });
});
