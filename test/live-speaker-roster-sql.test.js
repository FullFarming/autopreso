import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
const read = () => readFile(new URL('../supabase/migrations/202609050003_live_speaker_roster.sql', import.meta.url), 'utf8');
test('speaker roster exposes service-only additive immutable profile storage', async () => {
 const sql=await read(); assert.match(sql,/live_speaker_profile_versions/);assert.match(sql,/for update/);assert.match(sql,/enable row level security/);assert.match(sql,/SPEAKER_ROSTER_CONFLICT/);assert.doesNotMatch(sql,/drop table|drop column|truncate|delete from|grant select/i);
 assert.doesNotMatch(sql,/create table public\.(?!.*if not exists)|^create function/im,'0003 is unapplied in production and must be re-runnable: create table if not exists / create or replace function');
});
test('roster CAS, ownership, immutable versions, participant boundaries and terminal guards', {skip: !process.env.NOVA_PGLITE_MODULE}, async(t)=>{
 const {PGlite}=await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role;create table live_sessions(id uuid primary key,host_id text,status text);create table live_participants(id uuid primary key,session_id uuid);`);await db.exec(await read());
 await db.exec(await read()); // idempotent: a second apply is a no-op
 const id='00000000-0000-4000-8000-000000000001', sid='00000000-0000-4000-8000-000000000002',pid='00000000-0000-4000-8000-000000000003';
 await db.query("insert into live_sessions values($1,'owner','preparing')",[id]);
 const get=async()=> (await db.query('select get_live_speaker_roster_v1($1,$2) as state',[id,'owner'])).rows[0].state;
 const speaker={id:sid,version:1,displayName:'김민지',company:'회사',department:'부서',photoAssetId:null,participantId:null};
 const put=(revision,speakers=[speaker],active=sid)=>db.query('select replace_live_speaker_roster_v1($1,$2,$3,$4,$5) as state',[id,'owner',revision,JSON.stringify(speakers),active]);
 assert.equal((await get()).revision,0);await assert.rejects(db.query('select get_live_speaker_roster_v1($1,$2)',[id,'other']),/FORBIDDEN/);
 await put(0);assert.equal((await get()).appliedRevision,1);await assert.rejects(put(0),/CONFLICT/);
 await put(1,[{...speaker,displayName:'새 이름'}]);assert.equal((await get()).speakers[0].version,2);assert.equal((await db.query('select count(*)::int as n from live_speaker_profile_versions')).rows[0].n,2);
 await assert.rejects(put(2,[{...speaker,participantId:pid}]),/PARTICIPANT/);await assert.rejects(put(2,[],sid),/ACTIVE/);await assert.rejects(put(2,[speaker,speaker]),/DUPLICATE/);
 await db.query("update live_sessions set status='live' where id=$1",[id]);await put(2);assert.equal((await get()).appliedRevision,2);
 await db.query('select ack_live_speaker_roster_v1($1,3)',[id]);assert.equal((await get()).appliedRevision,3);await assert.rejects(db.query('select ack_live_speaker_roster_v1($1,4)',[id]),/REVISION/);

 const photo='00000000-0000-4000-8000-000000000004';
 await db.query('select create_live_speaker_photo_v1($1,$2,$3,$4,$5)',[id,'owner',photo,'image/png','YWJj']);
 assert.deepEqual((await db.query('select get_live_speaker_photo_v1($1,$2) as photo',[id,photo])).rows[0].photo,{contentType:'image/png',bytesBase64:'YWJj'});
 await assert.rejects(db.query('select create_live_speaker_photo_v1($1,$2,$3,$4,$5)',[id,'owner',photo,'image/png','YWJj']),/duplicate/);
 await assert.rejects(db.query('select create_live_speaker_photo_v1($1,$2,$3,$4,$5)',[id,'other',pid,'image/png','YWJj']),/FORBIDDEN/);
 await assert.rejects(db.query('select create_live_speaker_photo_v1($1,$2,$3,$4,$5)',[id,'owner',pid,'image/svg+xml','YWJj']),/PHOTO/);
 await assert.rejects(db.query('select create_live_speaker_photo_v1($1,$2,$3,$4,$5)',[id,'owner',pid,'image/png',Buffer.alloc(262145).toString('base64')]),/PHOTO/);
 const raced=await Promise.allSettled([put(3,[],null),put(3,[],null)]);
 assert.equal(raced.filter(x=>x.status==='fulfilled').length,1);
 assert.equal((await get()).revision,4);assert.equal((await db.query('select count(*)::int as n from live_speaker_profile_versions')).rows[0].n,3);
 await db.query("update live_sessions set status='stopped' where id=$1",[id]);await assert.rejects(put(4),/TERMINAL/);
 await db.exec('set role authenticated');await assert.rejects(db.query('select get_live_speaker_roster_gateway_v1($1)',[id]),/permission denied/);
});
