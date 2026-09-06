import assert from 'node:assert/strict';import {readFile,readdir} from 'node:fs/promises';import {pathToFileURL} from 'node:url';import test from 'node:test';
// Hosted auth, realtime, storage and cron surfaces are fixtures; application migrations and caption/source RPCs are unchanged.
test('ordered application migrations preserve speaker source, caption and record history',{skip:!process.env.NOVA_PGLITE_MODULE},async(t)=>{
const {PGlite}=await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);
const db=new PGlite();t.after(()=>db.close());await db.exec(`create role anon;create role authenticated;create role service_role;create schema cron;create table cron.job(jobid bigint,jobname text,schedule text,command text,active boolean);create function cron.unschedule(bigint) returns boolean language sql as 'select true';create function cron.schedule(text,text,text) returns bigint language plpgsql as 'begin insert into cron.job values(1,$1,$2,$3,true);return 1;end';create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create schema auth;create schema extensions;create schema realtime;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);create function auth.uid() returns uuid language sql as 'select null::uuid';create function auth.role() returns text language sql as 'select null::text';create function realtime.topic() returns text language sql as 'select null::text';create table realtime.messages(id bigint,extension text);create function extensions.gen_random_uuid() returns uuid language sql as 'select gen_random_uuid()';`);
const dir=new URL('../supabase/migrations',import.meta.url).pathname;for(const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort()){let sql=await readFile(`${dir}/${file}`,'utf8');sql=sql.replace(/create extension if not exists pgcrypto with schema extensions;/g,'').replace(/create extension if not exists pg_cron;/g,'');try{await db.exec(sql)}catch(error){throw new Error(file+': '+error.message);}}
const id='00000000-0000-4000-8000-000000000001',speaker='00000000-0000-4000-8000-000000000002';
await db.query("insert into live_sessions(id,host_id,mode,status,languages,expires_at) values($1,'host','meeting','live',array['ko'],now()+interval '1 hour')",[id]);
const profile={id:speaker,version:1,displayName:'민지',company:'회사',department:'부서',photoAssetId:null};
await db.query('select replace_live_speaker_roster_v1($1,$2,0,$3,$4)',[id,'host',JSON.stringify([{...profile,participantId:null}]),speaker]);
const observation={state:'mixed',languageCode:'und',providerLanguageCode:'ko-KR',evidence:'conflict',languages:['ko','en']};
await db.query(`select persist_authoritative_live_source_utterance_v4($1,'key','매출 revenue','매출 revenue','und','host','민지','민지','부서',null,null,null,'2026-08-31T00:00:00Z','2026-08-31T00:00:01Z','google-stt',null,null,null,$2,$3,null)`,[id,observation,profile]);
const event={type:'caption',seq:1,sessionId:id,language:'ko',speaker:null,text:'번역',isFinal:true,sourceStartedAt:null,sourceEndedAt:'2026-08-31T00:00:00Z',emittedAt:'2026-08-31T00:00:01Z',speakerRole:'host',speakerName:'민지',speakerDepartment:'부서',speakerJobTitle:'',speakerProfile:profile};
const result=await db.query(`select persist_live_final_caption_if_active($1,'ko',$2,1,'번역','민지','민지',null,'2026-08-31T00:00:00Z','2026-08-31T00:00:01Z',null,null,null,null,'key','translated') as stored`,[id,event]);assert.equal(result.rows[0].stored,true);
assert.deepEqual((await db.query('select read_owned_live_source_snapshot_v1($1,$2) as value',[id,'host'])).rows[0].value.sources[0].speakerProfile,profile);
assert.deepEqual((await db.query('select speaker_profile from live_utterances')).rows[0].speaker_profile,profile);

await db.query(`select persist_authoritative_live_source_utterance_v4($1,'unknown','unknown','unknown','und','unknown','발언자 확인 필요',null,null,null,null,null,'2026-08-31T00:00:00Z','2026-08-31T00:00:01Z','google-stt',null,null,null,$2,null,'unresolved')`,[id,observation]);
const unresolved={...event,seq:2,speakerRole:'unknown',speakerName:'발언자 확인 필요',speakerAttribution:'unresolved'};delete unresolved.speakerProfile;
assert.equal((await db.query(`select persist_live_final_caption_if_active($1,'ko',$2,2,'번역','발언자 확인 필요',null,null,'2026-08-31T00:00:00Z','2026-08-31T00:00:01Z',null,null,null,null,'unknown','translated') as stored`,[id,unresolved])).rows[0].stored,true);
assert.equal((await db.query('select speaker_attribution from live_utterances where seq=2')).rows[0].speaker_attribution,'unresolved');
await db.query("update live_sessions set status='stopped',ended_at=now() where id=$1",[id]);
const records=(await db.query('select * from read_owned_authoritative_live_transcript_v1($1,$2)',['host',id])).rows;
assert.deepEqual(records[0].speaker_profile,profile);assert.equal(records[1].speaker_attribution,'unresolved');



});
