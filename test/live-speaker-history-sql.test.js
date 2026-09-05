import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';import test from 'node:test';
const name='202608310005_live_canonical_source_snapshots.sql',hostSnapshotMigration='202609010002_live_host_source_snapshot.sql';
const readMigration=(file)=>readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8');
test('speaker history migration stores immutable source and snapshot metadata',{skip:!process.env.NOVA_PGLITE_MODULE},async(t)=>{
const {PGlite}=await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);const db=new PGlite();t.after(()=>db.close());
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

await db.exec('alter table live_sessions add column archived_at timestamptz; create table live_utterances(session_id uuid,language text,seq bigint,speaker_label text,speaker_name text,primary key(session_id,language,seq)); create table live_snapshots(session_id uuid,language text,last_seq bigint,captions jsonb,primary key(session_id,language));');
await db.exec(original.match(/create or replace function public\.read_owned_authoritative_live_transcript_v1\([\s\S]*?\n\$\$;/u)[0]);
await db.exec(recapSql.match(/create or replace function public\.read_participant_live_source_transcript_v1\([\s\S]*?\n\$\$;/u)[0]);
await db.exec(`create function persist_live_snapshot_if_active(p_session_id uuid,p_language text,p_event jsonb) returns boolean language plpgsql as $$begin insert into public.live_snapshots(session_id,language,last_seq,captions) values(p_session_id,p_language,(p_event->>'seq')::bigint,jsonb_build_array(p_event)) on conflict(session_id,language) do update set last_seq=excluded.last_seq,captions=excluded.captions;return true;end $$;`);
await db.exec(`create function persist_live_utterance_if_active(p_session_id uuid,p_language text,p_seq bigint,p_text text,p_speaker_label text,p_speaker_name text,p_source_started_at timestamptz,p_source_ended_at timestamptz,p_emitted_at timestamptz,p_participant_id uuid,p_source_text text,p_source_language text,p_origin text,p_utterance_key text,p_translation_status text) returns boolean language plpgsql as $$begin insert into public.live_utterances(session_id,language,seq,speaker_label,speaker_name) values(p_session_id,p_language,p_seq,p_speaker_label,p_speaker_name) on conflict do nothing;return true;end $$;`);
const atomic=await readMigration('20260726064308_atomic_live_final_caption.sql');await db.exec(atomic);
for(const file of ['202609050003_live_speaker_roster.sql','202609050004_speaker_profile_history.sql']){
  const sql=await readMigration(file);
  assert.doesNotMatch(sql,/drop table|drop column|truncate|delete from|grant select/i,file);
  // Both are unapplied in production: a second run must be a no-op, not a failure.
  await db.exec(sql);await db.exec(sql);
}
assert.equal((await db.query("select count(*)::int as n from pg_proc where proname like '%before_speaker_profile' or proname like '%_before_profile'")).rows[0].n,4,'the renamed originals exist exactly once after two runs');
const id='00000000-0000-4000-8000-000000000001',sid='00000000-0000-4000-8000-000000000002';
await db.query("insert into live_sessions(id,host_id,status,expires_at) values($1,'host','live',now()+interval '1 hour')",[id]);
const profile={id:sid,version:1,displayName:'민지',company:'회사',department:'부서',photoAssetId:null};
await db.query('select replace_live_speaker_roster_v1($1,$2,0,$3,$4)',[id,'host',JSON.stringify([{...profile,participantId:null}]),sid]);
const observation={state:'mixed',languageCode:'und',providerLanguageCode:'ko-KR',evidence:'conflict',languages:['ko','en']};
const persist=(identity=profile)=>db.query(`select persist_authoritative_live_source_utterance_v4($1,'key','매출 revenue','매출 revenue','und','host','1','Host',null,null,null,null,'2026-08-31T00:00:00Z','2026-08-31T00:00:01Z','google-stt',null,null,null,$2,$3,null) as value`,[id,observation,identity]);
assert.equal((await persist()).rows[0].value.idempotent,false);assert.equal((await persist()).rows[0].value.idempotent,true);
await assert.rejects(persist({...profile,displayName:'위조'}),/SPEAKER_PROFILE_INVALID/);
await db.query('select replace_live_speaker_roster_v1($1,$2,1,$3,$4)',[id,'host',JSON.stringify([{...profile,displayName:'변경',participantId:null}]),sid]);
assert.equal((await persist()).rows[0].value.idempotent,true);
const event={type:'caption',seq:1,text:'번역',speakerRole:'host',speakerName:'민지',speakerDepartment:'부서',speakerJobTitle:'',speakerProfile:profile};
const caption=(value=event)=>db.query(`select persist_live_final_caption_if_active($1,'ko',$2,1,'번역','민지','민지',null,null,now(),null,null,null,null,null,null) as stored`,[id,value]);
assert.equal((await caption()).rows[0].stored,true);assert.equal((await caption()).rows[0].stored,true);
assert.deepEqual((await db.query('select speaker_profile from live_utterances')).rows[0].speaker_profile,profile);
assert.deepEqual((await db.query('select captions from live_snapshots')).rows[0].captions[0].speakerProfile,profile);
await assert.rejects(caption({...event,speakerName:'변경',speakerProfile:{...profile,version:2,displayName:'변경'}}),/IDEMPOTENCY_CONFLICT/);
await assert.rejects(caption({...event,speakerName:'위조'}),/SPEAKER_PROFILE_INVALID/);
await assert.rejects(caption({...event,speakerRole:'admin'}),/SPEAKER_PROFILE_INVALID/);
const rows=(await db.query('select speaker_profile,speaker_name from live_source_utterances')).rows;assert.deepEqual(rows[0].speaker_profile,profile);assert.equal(rows[0].speaker_name,'민지');
const snapshot=(await db.query('select read_owned_live_source_snapshot_v1($1,$2) as value',[id,'host'])).rows[0].value;assert.deepEqual(snapshot.sources[0].speakerProfile,profile);
await assert.rejects(db.query('select read_owned_live_source_snapshot_v1($1,$2)',[id,'other']),/FORBIDDEN|HOST/);
});
