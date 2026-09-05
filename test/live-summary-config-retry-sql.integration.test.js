import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const name='202609010005_live_summary_configuration_retry.sql';
const readMigration=(file)=>readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8');
test('configuration retry repair preserves existing failure rows and mirrors bootstrap',async()=>{
  const sql=await readMigration(name);const bootstrap=await readFile(new URL('../supabase/bootstrap-new-project.sql',import.meta.url),'utf8');
  assert.ok(bootstrap.includes(`-- supabase/migrations/${name}\n\n${sql}`));
  assert.doesNotMatch(sql,/\b(?:drop table|drop column|truncate|delete from|SUMMARY_FAILED)\b/iu);
});

test('new missing-configuration failures permit bounded explicit reclaim without resetting existing failures',{
  skip:!process.env.NOVA_PGLITE_MODULE&&'Set NOVA_PGLITE_MODULE for isolated PostgreSQL validation',
},async(t)=>{
  const {PGlite}=await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);const db=new PGlite();t.after(()=>db.close());
  await db.exec(`create schema extensions;create role anon;create role authenticated;create role service_role;
    create function extensions.gen_random_uuid() returns uuid language sql as 'select gen_random_uuid()';
    create function public.live_language_valid(text) returns boolean language sql as 'select $1 in (''ko'',''en'')';
    create table live_sessions(id uuid primary key,status text);
    create table live_meeting_summaries(session_id uuid,language text,summary jsonb,model text,created_at timestamptz,unique(session_id,language));`);
  await db.exec(await readMigration('20260727014000_live_summary_generation_jobs.sql'));
  await db.exec(await readMigration('20260729235900_live_summary_generation_recovery.sql'));
  const session='40000000-0000-4000-8000-000000000001';
  await db.query("insert into live_sessions values($1,'stopped')",[session]);
  const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
  const claim=(language='ko')=>scalar('select public.claim_live_summary_generation($1,$2) value',[session,language]);
  const fail=(token,code,language='ko')=>scalar('select public.fail_live_summary_generation($1,$2,$3,$4) value',[session,language,token,code]);
  const status=(language='ko')=>scalar('select public.read_live_summary_generation_status($1,$2) value',[session,language]);
  const existing=await claim('en');await fail(existing.generationToken,'SUMMARY_FAILED','en');
  await db.exec(await readMigration(name));await db.exec(await readMigration(name));
  await t.test('generic pre-existing failures are untouched and cannot be auto reclaimed',async()=>{
    assert.equal((await status('en')).status,'permanent_failed');
    assert.equal((await claim('en')).status,'permanent_failed');
    assert.equal(await scalar("select attempt_count value from live_summary_generation_jobs where language='en'"),1);
  });
  await t.test('only an explicit claim advances the missing-configuration job and stale tokens cannot finish it',async()=>{
    const first=await claim();assert.equal(await fail(first.generationToken,'SUMMARY_NOT_CONFIGURED'),true);
    assert.equal((await status()).status,'retryable_failed');
    assert.equal(await scalar("select attempt_count value from live_summary_generation_jobs where language='ko'"),1);
    const second=await claim();assert.notEqual(second.generationToken,first.generationToken);
    assert.equal(await fail(first.generationToken,'SUMMARY_NOT_CONFIGURED'),false);
    await fail(second.generationToken,'SUMMARY_NOT_CONFIGURED');
    const third=await claim();await fail(third.generationToken,'SUMMARY_NOT_CONFIGURED');
    assert.equal((await status()).status,'exhausted');assert.equal((await claim()).status,'exhausted');
    assert.equal(await scalar("select attempt_count value from live_summary_generation_jobs where language='ko'"),3);
  });
  await t.test('repair retains service-only execution and private job rows',async()=>{
    const signature='public.fail_live_summary_generation(uuid,text,uuid,text)';
    for(const role of ['anon','authenticated'])assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE') value",[role,signature]),false);
    assert.equal(await scalar("select has_table_privilege('service_role','live_summary_generation_jobs','SELECT') value"),false);
  });
});
