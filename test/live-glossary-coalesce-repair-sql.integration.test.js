import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const originalName = '202608270001_live_session_multi_glossary_pins.sql';
const repairName = '202608310006_live_glossary_coalesce_repair.sql';
const readMigration = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const methods = ['replace_live_session_glossary_pins_v2', 'read_live_session_pinned_glossaries_v2'];
function extractFunction(sql, name) {
  const match = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, 'u'));
  assert.ok(match, name);
  return match[0];
}

test('glossary repair changes only five invalid qualified COALESCE expressions and mirrors bootstrap', async () => {
  const [original, repair, bootstrap] = await Promise.all([
    readMigration(originalName), readMigration(repairName),
    readFile(new URL('../supabase/bootstrap-new-project.sql', import.meta.url), 'utf8'),
  ]);
  assert.equal(original.match(/pg_catalog\.coalesce\(/gu)?.length, 5);
  for (const name of methods) {
    assert.equal(extractFunction(repair, name), extractFunction(original, name).replaceAll('pg_catalog.coalesce(', 'coalesce('));
  }
  assert.doesNotMatch(repair, /\b(?:pg_catalog|public)\.(?:coalesce|nullif|greatest|least)\s*\(/giu);
  assert.doesNotMatch(repair, /\b(?:drop|alter table|create table|truncate)\b/giu);
  assert.ok(bootstrap.includes(`-- supabase/migrations/${repairName}\n\n${repair}`));
});

test('PostgreSQL reproduces both released failures and repairs pin writes and reads atomically', {
  skip: !process.env.NOVA_PGLITE_MODULE && 'Set NOVA_PGLITE_MODULE for isolated PostgreSQL validation',
}, async (t) => {
  const { PGlite } = await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.live_sessions(id uuid primary key,host_id text not null,version integer not null,
      status text not null,session_type text,output_mode text,pinned_glossary_preset_id uuid,pinned_glossary_version integer,
      pinned_glossary_fingerprint text,updated_at timestamptz not null default now());
    create table public.host_glossary_presets(id uuid primary key,host_id text not null,
      active_document_version integer,active_document_fingerprint text);
    create table public.host_glossary_preset_versions(id uuid primary key,preset_id uuid,host_id text,version integer,
      fingerprint text,document jsonb);
  `);
  await db.exec(await readMigration(originalName));
  const liveCall = '00000000-0000-4000-8000-000000000001';
  const caption = '00000000-0000-4000-8000-000000000002';
  const hostPreset = '00000000-0000-4000-8000-000000000003';
  const otherPreset = '00000000-0000-4000-8000-000000000004';
  const versionId = '00000000-0000-4000-8000-000000000005';
  const otherVersionId = '00000000-0000-4000-8000-000000000006';
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  await db.query("insert into public.live_sessions(id,host_id,version,status,session_type,output_mode) values($1,'host',1,'preparing','meeting','captions_only'),($2,'host',1,'preparing','conference','captions_only')", [liveCall,caption]);
  await db.query("insert into public.host_glossary_presets values($1,'host',2,$3),($2,'other-host',2,$3)",[hostPreset,otherPreset,fingerprint]);
  await db.query("insert into public.host_glossary_preset_versions values($1,$2,'host',2,$5,'{\"name\":\"Private original glossary\"}'),($3,$4,'other-host',2,$5,'{}')",[versionId,hostPreset,otherVersionId,otherPreset,fingerprint]);
  await db.query("insert into public.live_session_glossary_pins(session_id,ordinal,source_kind,builtin_id,builtin_catalog_version) values($1,1,'builtin','common_business',1)",[liveCall]);
  const builtin = (id) => ({ source_kind: 'builtin', source_id: id, document_version: 1 });
  const host = (id, version = 2) => ({ source_kind: 'host', source_id: id, document_version: version });
  const replace = async (sessionId, version, pins, owner = 'host') => (await db.query(
    'select * from public.replace_live_session_glossary_pins_v2($1,$2,$3,$4)', [sessionId,owner,version,JSON.stringify(pins)],
  )).rows[0];
  const read = async (sessionId) => (await db.query('select * from public.read_live_session_pinned_glossaries_v2($1)', [sessionId])).rows;
  const state = async (sessionId) => ({
    session: (await db.query('select * from public.live_sessions where id=$1',[sessionId])).rows[0],
    pins: (await db.query('select * from public.live_session_glossary_pins where session_id=$1 order by ordinal',[sessionId])).rows,
  });
  const isUndefinedCoalesce = (error) => error?.code === '42883' && /coalesce/u.test(error.message);
  await t.test('released pin and read RPCs both fail at runtime, not migration parsing',async()=>{
    await assert.rejects(replace(liveCall,1,[builtin('common_business')]),isUndefinedCoalesce);
    await assert.rejects(read(liveCall),isUndefinedCoalesce);
    assert.equal((await state(liveCall)).session.version,1);
    assert.equal((await state(liveCall)).pins.length,1);
  });
  const beforeRepair = await state(liveCall);
  await db.exec(await readMigration(repairName));
  await db.exec(await readMigration(repairName));
  assert.deepEqual(await state(liveCall), beforeRepair);

  await t.test('built-in pins unblock both meeting and caption session paths under service_role',async()=>{
    await db.exec('set role service_role');
    try {
      for (const sessionId of [liveCall,caption]) {
        const result = await replace(sessionId,1,[builtin('common_business'),builtin('ai_ax')]);
        assert.equal(result.version,2);
        assert.deepEqual(result.glossaries.map(pin=>[pin.ordinal,pin.source_id,pin.document_version]),[[1,'common_business',1],[2,'ai_ax',1]]);
        assert.deepEqual((await read(sessionId)).map(pin=>pin.source_id),['common_business','ai_ax']);
      }
    } finally { await db.exec('reset role'); }
  });
  await t.test('owner, stale version, duplicate, malformed, six-item and inactive host pins preserve prior state',async()=>{
    const before = await state(liveCall);
    const attempts = [
      { attempt: ()=>replace(liveCall,2,[builtin('ai_ax')],'other-host'), expected: /LIVE_SESSION_NOT_FOUND/u },
      { attempt: ()=>replace(liveCall,1,[builtin('ai_ax')]), expected: /LIVE_SESSION_VERSION_CONFLICT/u },
      { attempt: ()=>replace(liveCall,2,[builtin('ai_ax'),builtin('ai_ax')]), expected: /DUPLICATE_LIVE_GLOSSARY_PIN/u },
      { attempt: ()=>replace(liveCall,2,[builtin('ai_ax'),{...builtin('common_business'),unexpected:true}]), expected: /INVALID_LIVE_GLOSSARY_PIN_INPUT/u },
      { attempt: ()=>replace(liveCall,2,Array.from({length:6},()=>builtin('ai_ax'))), expected: /INVALID_LIVE_GLOSSARY_PIN_INPUT/u },
      { attempt: ()=>replace(liveCall,2,[builtin('ai_ax'),host(otherPreset)]), expected: /ACTIVE_GLOSSARY_DOCUMENT_VERSION_NOT_FOUND/u },
      { attempt: ()=>replace(liveCall,2,[builtin('ai_ax'),host(hostPreset,1)]), expected: /ACTIVE_GLOSSARY_DOCUMENT_VERSION_NOT_FOUND/u },
    ];
    for (const { attempt, expected } of attempts) {
      await assert.rejects(attempt(),expected);
      assert.deepEqual(await state(liveCall),before);
    }
  });
  await t.test('five ordered pins work and repeated optimistic versions cannot overwrite them',async()=>{
    const pins=['common_business','ai_ax','commercial_real_estate','hospitality','proper_nouns'].map(builtin);
    const results=await Promise.allSettled([replace(liveCall,2,pins),replace(liveCall,2,[builtin('ai_ax')])]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(results.filter(result=>result.status==='rejected').length,1);
    assert.equal((await state(liveCall)).session.version,3);
    assert.deepEqual((await read(liveCall)).map(pin=>pin.source_id),pins.map(pin=>pin.source_id));
  });
  await t.test('single host pins retain legacy columns and mixed pins resolve the exact owned version',async()=>{
    const single=await replace(caption,2,[host(hostPreset)]);
    assert.equal(single.glossaries[0].fingerprint,fingerprint);
    const saved=await state(caption);
    assert.equal(saved.session.pinned_glossary_preset_id,hostPreset);
    assert.equal(saved.session.pinned_glossary_version,2);
    assert.equal((await read(caption))[0].glossary_document.name,'Private original glossary');
    await db.query('delete from public.live_session_glossary_pins where session_id=$1',[caption]);
    assert.equal((await read(caption))[0].source_id,hostPreset);
    await replace(caption,3,[builtin('common_business'),host(hostPreset)]);
    assert.equal((await state(caption)).session.pinned_glossary_preset_id,null);
    assert.deepEqual((await read(caption)).map(pin=>pin.source_kind),['builtin','host']);
    await db.query("update public.live_sessions set status='live' where id=$1",[caption]);
    await assert.rejects(replace(caption,4,[builtin('ai_ax')]),/ACTIVE_SESSION_GLOSSARY_IMMUTABLE/u);
    assert.equal((await state(caption)).session.version,4);
  });
  await t.test('RLS and service-only RPC ACLs remain intact after replay',async()=>{
    for(const method of methods){
      const result=(await db.query("select prosecdef,proconfig,has_function_privilege('service_role',oid,'EXECUTE') service,has_function_privilege('anon',oid,'EXECUTE') anonymous,has_function_privilege('authenticated',oid,'EXECUTE') authenticated from pg_proc where proname=$1",[method])).rows[0];
      assert.equal(result.prosecdef,true);assert.deepEqual(result.proconfig,['search_path=""']);
      assert.equal(result.service,true);assert.equal(result.anonymous,false);assert.equal(result.authenticated,false);
    }
    assert.equal((await db.query("select relrowsecurity from pg_class where oid='public.live_session_glossary_pins'::regclass")).rows[0].relrowsecurity,true);
    for(const role of ['anon','authenticated','service_role']) {
      assert.equal((await db.query("select has_table_privilege($1,'public.live_session_glossary_pins','SELECT,INSERT,UPDATE,DELETE') allowed",[role])).rows[0].allowed,false);
    }
  });
});
