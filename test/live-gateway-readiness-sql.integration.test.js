import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const readMigration = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const extract = (sql, name) => {
  const match=sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,'iu'));
  assert.ok(match, name); return match[0];
};

test('actual activation SQL rejects null provider but preserves early manual start and every durable receipt fence', {
  skip: !process.env.NOVA_PGLITE_MODULE && 'Set NOVA_PGLITE_MODULE for isolated PostgreSQL validation',
}, async (t) => {
  const { PGlite }=await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create table public.live_sessions(
      id uuid primary key,host_id text,session_type text,output_mode text,voice_provider text,
      languages text[],max_viewers integer,glossary_pack text,pinned_glossary_fingerprint text,
      status text,version integer,expires_at timestamptz,scheduled_at timestamptz,
      created_at timestamptz default now(),updated_at timestamptz default now(),viewer_count integer default 0,
      event_metadata jsonb default '{}');`);
  const languages=await readMigration('202607230001_live_multilingual_languages.sql');
  for(const name of ['normalize_live_language','normalize_live_languages','live_language_valid','live_languages_valid'])await db.exec(extract(languages,name));
  const initial=await readMigration('202608150006_live_gateway_readiness_start.sql');
  await db.exec(initial.slice(0,initial.indexOf('create or replace function public.activate_live_session_after_gateway_ready_v1(')));
  const repair=await readMigration('202608150007_live_plpgsql_ambiguity_repair.sql');
  const name='activate_live_session_after_gateway_ready_v1';
  await db.exec(extract(repair,name));
  const signature=`public.${name}(uuid,text,integer,uuid,text,text,text,text,text[],integer,text,text)`;
  await db.exec(`revoke all on function ${signature} from public,anon,authenticated;grant execute on function ${signature} to service_role;`);
  const session='20000000-0000-4000-8000-000000000001';
  const other='20000000-0000-4000-8000-000000000002';
  const activation='20000000-0000-4000-8000-000000000003';
  const hash=`sha256:${'a'.repeat(64)}`;
  const glossary=`sha256:${'b'.repeat(64)}`;
  await db.query(`insert into public.live_sessions(id,host_id,session_type,output_mode,voice_provider,languages,max_viewers,
      glossary_pack,pinned_glossary_fingerprint,status,version,expires_at,scheduled_at,event_metadata)
    values($1,'owner','meeting','captions','gemini','{ko,en}',50,'general_cre',$3,'preparing',3,
      now()+interval '2 days',now()+interval '1 day','{"modelPreferences":{"source":"gemini-3.6-flash","summary":"gemini-3.6-flash"}}'),
      ($2,'owner','meeting','captions','gemini','{ko,en}',50,'general_cre',$3,'preparing',3,now()+interval '2 days',now()+interval '1 day','{}')`,[session,other,glossary]);
  const base={session,host:'owner',version:3,activation,hash,type:'meeting',output:'captions',provider:'gemini',languages:['ko','en'],maximum:50,glossary:'general_cre',pin:glossary};
  const activate=(overrides={})=>{
    const value={...base,...overrides};
    return db.query(`select * from public.${name}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[
      value.session,value.host,value.version,value.activation,value.hash,value.type,value.output,value.provider,value.languages,value.maximum,value.glossary,value.pin]);
  };
  const row=async()=> (await db.query('select * from live_sessions where id=$1',[session])).rows[0];
  await t.test('captions runtime null reproduces production 22023 before any mutation',async()=>{
    await assert.rejects(activate({provider:null}),(error)=>error instanceof Error&&'code' in error&&error.code==='22023'&&error.message==='INVALID_GATEWAY_READINESS_INPUT');
    assert.equal((await row()).status,'preparing');assert.equal((await row()).version,3);
    assert.equal((await row()).gateway_activation_key,null);
  });
  await t.test('receipt input, owner, version, languages and glossary must still match exactly',async()=>{
    await assert.rejects(activate({host:'someone-else'}),/HOST_ACCESS_REQUIRED/u);
    for(const mismatch of [{version:2},{pin:`sha256:${'c'.repeat(64)}`},{languages:['en','ko']},{maximum:51},{glossary:'hotel'}]) {
      await assert.rejects(activate(mismatch),/GATEWAY_READINESS_CONFLICT/u);
    }
    for(const invalid of [{hash:'bad'},{provider:'openai'},{pin:'unvalidated'},{maximum:201}]) {
      await assert.rejects(activate(invalid),/INVALID_GATEWAY_READINESS_INPUT/u);
    }
    assert.equal((await row()).status,'preparing');
  });
  await t.test('canonical database provider starts a future meeting now and exact replay changes nothing',async()=>{
    const first=await activate();assert.equal(first.rows[0].status,'live');assert.equal(first.rows[0].version,4);
    const started=await row();assert.ok(new Date(started.scheduled_at).getTime()>Date.now());
    assert.equal(started.event_metadata.modelPreferences.source,'gemini-3.6-flash');
    assert.equal(started.event_metadata.modelPreferences.summary,'gemini-3.6-flash');
    const replay=await activate();assert.deepEqual(replay.rows,first.rows);
    assert.deepEqual((await row()).gateway_activated_at,started.gateway_activated_at);
    await assert.rejects(activate({hash:`sha256:${'d'.repeat(64)}`}),/GATEWAY_READINESS_CONFLICT/u);
    await assert.rejects(activate({session:other}),/GATEWAY_READINESS_CONFLICT/u);
  });
  await t.test('ended or expired sessions cannot be revived by receipt replay',async()=>{
    await db.query("update live_sessions set status='stopped' where id=$1",[session]);
    await assert.rejects(activate(),/GATEWAY_READINESS_CONFLICT/u);
    await db.query("update live_sessions set status='live',expires_at=now()-interval '1 second' where id=$1",[session]);
    await assert.rejects(activate(),/GATEWAY_READINESS_CONFLICT/u);
  });
  await t.test('service-only execution remains closed to participant and anonymous roles',async()=>{
    for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,signature])).rows[0].allowed,false);
    assert.equal((await db.query("select has_function_privilege('service_role',$1,'EXECUTE') allowed",[signature])).rows[0].allowed,true);
  });
});
