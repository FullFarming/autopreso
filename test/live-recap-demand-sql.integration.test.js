import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const migrationNames = [
  '202608310002_live_recap_requests_and_record_access.sql',
  '202608310003_live_media_demand_leases.sql',
  '202608310004_live_media_write_epoch_fences.sql',
];
const readMigration = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

test('new recap and demand SQL has closed public entrypoints and no destructive migration', async () => {
  const bootstrap = await readFile(new URL('../supabase/bootstrap-new-project.sql', import.meta.url),'utf8');
  for (const name of migrationNames) {
    const sql = await readMigration(name);
    assert.equal(bootstrap.split(`-- supabase/migrations/${name}`).length-1,1);
    assert.ok(bootstrap.includes(`-- supabase/migrations/${name}\n\n${sql}`));
    assert.doesNotMatch(sql, /\b(?:drop table|drop column|truncate)\b/iu);
    const functions = [...sql.matchAll(/create or replace function public\.(\w+)\(/gu)];
    for (const [, functionName] of functions) {
      assert.match(sql, new RegExp(`revoke all on function public\\.${functionName}\\(`, 'u'));
    }
    assert.doesNotMatch(sql, /set search_path = public/iu);
  }
});

// 2026-08-31 test: PGlite is opt-in so this integration harness adds no production dependency.
// The fixture intentionally includes only schemas referenced by the new migrations.
test('execute recap, authorization, demand, and epoch SQL against local PostgreSQL', {
  skip: !process.env.NOVA_PGLITE_MODULE && 'Set NOVA_PGLITE_MODULE to a local @electric-sql/pglite module',
}, async (t) => {
  const { PGlite } = await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`
    create schema extensions; create schema auth;
    create role anon; create role authenticated; create role service_role;
    create function extensions.gen_random_uuid() returns uuid language sql as 'select gen_random_uuid()';
    create function auth.uid() returns uuid language sql stable as
      'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
    create function public.live_language_valid(text) returns boolean language sql immutable as 'select $1 in (''ko'',''en'')';
    create function public.live_languages_canonical(text[]) returns boolean language sql immutable as 'select true';
    create function public.is_valid_live_attendee_email(text) returns boolean language sql immutable as
      'select $1 ~ ''^[^@]+@[^@]+[.][^@]+$''';
    create table public.live_sessions (
      id uuid primary key, host_id text, title text, scheduled_at timestamptz,
      status text, ended_at timestamptz, archive_deleted_at timestamptz,
      session_type text default 'meeting', output_mode text default 'captions',
      voice_provider text default 'gemini', glossary_pack text default 'none',
      languages text[] default '{ko,en}', max_viewers integer default 50,
      expires_at timestamptz default now()+interval '6 hours', version integer default 1
    );
    create table public.viewer_grants (
      id uuid primary key,session_id uuid references public.live_sessions,user_id text,
      revoked_at timestamptz,expires_at timestamptz
    );
    create table public.live_participants (
      id uuid primary key,session_id uuid references public.live_sessions,grant_id uuid,user_id text,
      display_name text,email text,company text,department text,job_title text,
      joined_at timestamptz default now(),summary_consent_at timestamptz,
      unique(session_id,user_id)
    );
    create table public.live_participant_consents (
      id uuid primary key default extensions.gen_random_uuid(), session_id uuid,
      participant_id uuid references public.live_participants,purpose text,notice_version text,
      revision integer,is_accepted boolean,accepted_at timestamptz,withdrawn_at timestamptz,
      recorded_at timestamptz,unique(participant_id,purpose,revision)
    );
    create table public.live_sheet_exports(session_id uuid,projection_version bigint);
    create table public.live_source_utterances (
      id uuid primary key,session_id uuid,source_seq bigint,utterance_key text,
      normalized_text text,source_language text,speaker_name text,speaker_label text,
      speaker_role text,source_started_at timestamptz,source_ended_at timestamptz
    );
    create table public.live_source_utterance_corrections (
      source_utterance_id uuid,revision integer,corrected_text text
    );
    create table public.live_topic_utterances(session_id uuid,utterance_key text,topic_id uuid,unique(session_id,utterance_key));
    create table public.live_topics(id uuid,title text);
    create table public.live_meeting_summaries(session_id uuid,language text,summary jsonb,created_at timestamptz);
    create table public.live_summary_generation_jobs(session_id uuid,language text,status text);
    create table public.live_recap_grants(session_id uuid,user_id text);
    create table public.live_utterances(session_id uuid,text text);
    alter table public.live_sessions enable row level security;
    alter table public.live_recap_grants enable row level security;
    alter table public.live_utterances enable row level security;
    alter table public.live_meeting_summaries enable row level security;
    create policy live_sessions_recap_viewer_select on public.live_sessions for select to authenticated using(false);
    create policy live_recap_grants_owner_select on public.live_recap_grants for select to authenticated using(false);
    create policy live_utterances_recap_select on public.live_utterances for select to authenticated using(false);
    create policy live_meeting_summaries_recap_select on public.live_meeting_summaries for select to authenticated using(false);
    grant usage on schema public,auth to authenticated,service_role;
    grant select on public.live_sessions,public.live_recap_grants,public.live_utterances,public.live_meeting_summaries to authenticated;
  `);
  const legacySql = await readMigration('202608150005_live_records_sheets_outbox.sql');
  const consentFunction = legacySql.match(/create or replace function public\.record_live_participant_consent_v1\([\s\S]*?\n\$\$;/u);
  assert.ok(consentFunction);
  await database.exec(consentFunction[0]);
  for (const name of migrationNames) await database.exec(await readMigration(name));

  const sessionId = '00000000-0000-4000-8000-000000000001';
  const liveId = '00000000-0000-4000-8000-000000000002';
  const userId = '00000000-0000-4000-8000-000000000011';
  const liveUserId = '00000000-0000-4000-8000-000000000012';
  const participantId = '00000000-0000-4000-8000-000000000021';
  const liveParticipantId = '00000000-0000-4000-8000-000000000022';
  const grantId = '00000000-0000-4000-8000-000000000031';
  const sourceGeneration = '00000000-0000-4000-8000-000000000041';
  const ownerId = '00000000-0000-4000-8000-000000000051';
  let connectionId = '00000000-0000-4000-8000-000000000061';
  const otherId = '00000000-0000-4000-8000-000000000071';
  const scalar = async (sql, params = []) => (await database.query(sql, params)).rows[0].value;
  const query = (sql, params = []) => database.query(sql, params);
  const action = (name, epoch = 1, owner = ownerId, ids = []) => scalar(
    'select public.gateway_live_media_v1($1,$2,$3,$4,$5,$6,$7,$8) as value',
    [liveId,epoch,owner,name,connectionId,grantId,liveUserId,ids],
  );
  await query(`insert into public.live_sessions(id,host_id,title,status,ended_at)
    values ($1,'host-a','테스트 회의','stopped',now()-interval '1 minute'),
    ($2,'host-a','라이브 회의','preparing',null)`, [sessionId,liveId]);
  await query(`insert into public.live_participants(id,session_id,grant_id,user_id,display_name,email,department,job_title)
    values ($1,$2,null,$3,'테스트 참가자','person@example.test','기획','담당'),
    ($4,$5,$6,$7,'라이브 참가자','live@example.test','기획','담당')`,
  [participantId,sessionId,userId,liveParticipantId,liveId,grantId,liveUserId]);
  await query('insert into public.viewer_grants values ($1,$2,$3,null,now()+interval \'1 hour\')', [grantId,liveId,liveUserId]);
  await query(`insert into public.live_source_utterances
    values ($1,$2,1,'speech-one','원문 내용','ko','내부 실명','진행자','host',null,now())`, [otherId,sessionId]);
  await query('insert into public.live_meeting_summaries values ($1,\'ko\',\'{"title":"회의 요약"}\',now())', [sessionId]);
  await query('insert into public.live_summary_generation_jobs values ($1,\'ko\',\'succeeded\'),($1,\'en\',\'failed\')', [sessionId]);

  await t.test('retained membership reads after live grant cleanup, with no fake active grant', async () => {
    const access = await query('select * from public.read_participant_live_record_access_v1($1,$2)', [sessionId,userId]);
    assert.equal(access.rows[0].participant_id,participantId);
    assert.equal(access.rows[0].status,'stopped');
    assert.equal(new Date(access.rows[0].records_expires_at).getTime()-new Date(access.rows[0].ended_at).getTime(),6*3600000);
    await assert.rejects(query('select * from public.read_participant_live_record_access_v1($1,$2)', [sessionId,liveUserId]), /RECAP_FORBIDDEN/u);
  });
  await t.test('request double click preserves one consent timestamp, one request, and marketing', async () => {
    await query(`select * from public.record_live_participant_consent_v1($1,$2,$3,'marketing','marketing-v1',false)`, [sessionId,participantId,userId]);
    const submit = (key) => scalar('select public.request_live_recap_v1($1,$2,$3,$4) as value', [sessionId,userId,'summary-original-email-v2',key]);
    const first = await submit(connectionId);
    const second = await submit(otherId);
    assert.equal(first.id,second.id); assert.equal(first.requestedAt,second.requestedAt);
    assert.equal(first.status,'requested');
    assert.equal(await scalar('select count(*)::int as value from public.live_recap_requests'),1);
    assert.equal(await scalar("select count(*)::int as value from public.live_participant_consents where purpose='summary_delivery'"),1);
    assert.equal(await scalar("select is_accepted as value from public.live_participant_consents where purpose='marketing'"),false);
    await assert.rejects(scalar('select public.request_live_recap_v1($1,$2,$3,$4) as value', [sessionId,userId,'summary-v1',otherId]), /INVALID_RECAP_REQUEST/u);
  });
  await t.test('source read omits private speaker names; export includes all languages once', async () => {
    const source = await query('select * from public.read_participant_live_source_transcript_v1($1,$2)', [sessionId,userId]);
    assert.equal(source.rows[0].speaker_label,'진행자');
    assert.equal(source.rows[0].effective_text,'원문 내용');
    assert.doesNotMatch(JSON.stringify(source.rows), /내부 실명/u);
    const exportData = await scalar('select public.read_owned_live_record_export_v1($1,$2) as value', [sessionId,'host-a']);
    assert.equal(exportData.participants.length,1); assert.equal(exportData.requests.length,1);
    assert.equal(exportData.utterances.length,1); assert.equal(exportData.summaries.length,2);
    assert.deepEqual(exportData.summaries.map((row)=>row.status),['ready','failed']);
    await assert.rejects(scalar('select public.read_owned_live_record_export_v1($1,$2) as value', [sessionId,'other-host']), /LIVE_RECORD_NOT_FOUND/u);
  });
  await t.test('six hour boundary and revocation fail closed without extending the window', async () => {
    await query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
    await database.exec('set role authenticated');
    assert.equal((await query('select * from public.live_meeting_summaries')).rows.length,1);
    await database.exec('reset role');
    await query('update public.live_participants set records_revoked_at=now() where id=$1', [participantId]);
    await assert.rejects(query('select * from public.read_participant_live_record_access_v1($1,$2)', [sessionId,userId]), /RECAP_FORBIDDEN/u);
    await query('update public.live_participants set records_revoked_at=null where id=$1', [participantId]);
    await query("update public.live_sessions set ended_at=now()-interval '6 hours' where id=$1", [sessionId]);
    await assert.rejects(query('select * from public.read_participant_live_record_access_v1($1,$2)', [sessionId,userId]), /RECAP_EXPIRED/u);
    await assert.rejects(scalar('select public.read_participant_live_recording_gaps_v1($1,$2) as value',[sessionId,userId]),/RECAP_EXPIRED/u);
    await assert.rejects(scalar('select public.request_live_recap_v1($1,$2,$3,$4) as value', [sessionId,userId,'summary-original-email-v2',otherId]), /RECAP_EXPIRED/u);
    assert.equal((await scalar('select public.read_owned_live_record_export_v1($1,$2) as value',[sessionId,'host-a'])).participants.length,1);
    await query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
    await database.exec('set role authenticated');
    assert.equal((await query('select * from public.live_meeting_summaries')).rows.length,0);
    await database.exec('reset role');
    await query("update public.live_sessions set ended_at=now()-interval '1 minute' where id=$1", [sessionId]);
  });
  await t.test('revoked new consent becomes cancelled, never silently reconsented by retry', async () => {
    await query(`select * from public.record_live_participant_consent_v1($1,$2,$3,'summary_delivery','summary-original-email-v2',false)`, [sessionId,participantId,userId]);
    const result = await scalar('select public.request_live_recap_v1($1,$2,$3,$4) as value', [sessionId,userId,'summary-original-email-v2',otherId]);
    assert.equal(result.status,'cancelled'); assert.ok(result.cancelledAt);
  });
  await t.test('recording gaps survive an empty transcript and keep an unknown end explicit', async () => {
    await query("insert into public.live_media_recording_gaps(session_id,epoch,reason,started_at) values ($1,0,'no_viewers',now()-interval '2 minutes')",[sessionId]);
    await query('delete from public.live_source_utterances where session_id=$1',[sessionId]);
    assert.equal((await query('select * from public.read_participant_live_source_transcript_v1($1,$2)',[sessionId,userId])).rows.length,0);
    const gaps = await scalar('select public.read_participant_live_recording_gaps_v1($1,$2) as value',[sessionId,userId]);
    assert.equal(gaps.recordingGaps.length,1); assert.equal(gaps.recordingGaps[0].endedAt,null);
    const snapshot = await scalar('select public.read_owned_live_record_export_v1($1,$2) as value',[sessionId,'host-a']);
    assert.equal(snapshot.utterances.length,0); assert.equal(snapshot.recordingGaps[0].id,gaps.recordingGaps[0].id);
    await assert.rejects(scalar('select public.read_owned_live_recording_gaps_v1($1,$2) as value',[sessionId,'other-host']),/LIVE_RECORD_NOT_FOUND/u);
    await query('insert into public.live_meeting_summaries values ($1,\'ja\',\'{"title":"追加要約"}\',now())',[sessionId]);
    const allLanguages = await scalar('select public.read_owned_live_record_export_v1($1,$2) as value',[sessionId,'host-a']);
    assert.deepEqual(allLanguages.summaries.map((row)=>row.language),['ko','en','ja']);
  });
  await t.test('archived records cannot be read or exported, and exports never truncate at the limit', async () => {
    await query('update public.live_sessions set archive_deleted_at=now() where id=$1',[sessionId]);
    await assert.rejects(scalar('select public.read_owned_live_record_export_v1($1,$2) as value',[sessionId,'host-a']),/LIVE_RECORD_NOT_FOUND/u);
    await assert.rejects(query('select * from public.read_participant_live_record_access_v1($1,$2)',[sessionId,userId]),/RECAP_FORBIDDEN/u);
    await query('update public.live_sessions set archive_deleted_at=null where id=$1',[sessionId]);
    await query("insert into public.live_participants(id,session_id,user_id) select gen_random_uuid(),$1,'extra-'||n from generate_series(1,10000) n",[sessionId]);
    await assert.rejects(scalar('select public.read_owned_live_record_export_v1($1,$2) as value',[sessionId,'host-a']),/EXPORT_TOO_LARGE/u);
    await query('delete from public.live_participants where session_id=$1 and id<>$2',[sessionId,participantId]);
  });
  await t.test('no local host source means no cold wake and no pending lease', async () => {
    await scalar('select public.request_live_media_start_v1($1,$2,$3) as value', [liveId,'host-a',1]);
    const result = await scalar('select public.prepare_live_viewer_connection_v1($1,$2,$3,$4) as value', [liveId,grantId,liveUserId,connectionId]);
    assert.equal(result.status,'HOST_WAITING'); assert.equal(result.runtime.state,'sleeping');
    assert.equal(await scalar('select count(*)::int as value from public.live_viewer_presence_leases'),0);
    const auth = await query('select * from public.authorize_live_viewer_grants_v1($1)', [JSON.stringify([
      {session_id:liveId,grant_id:grantId,user_id:liveUserId,language:'ko'},
    ])]);
    assert.equal(auth.rows[0].authorized,false);
  });
  await t.test('first real viewer wakes exactly one epoch; pending retries do not extend expiry', async () => {
    await scalar('select public.heartbeat_live_host_source_v1($1,$2,$3,true) as value', [liveId,'host-a',sourceGeneration]);
    const prepare = (id) => scalar('select public.prepare_live_viewer_connection_v1($1,$2,$3,$4) as value', [liveId,grantId,liveUserId,id]);
    const first = await prepare(connectionId); const retry = await prepare(otherId);
    assert.equal(first.runtime.epoch,1); assert.equal(retry.connectionId,first.connectionId);
    assert.equal(retry.expiresAt,first.expiresAt); assert.equal(first.runtime.connectedCount,0);
    const auth = await query('select * from public.authorize_live_viewer_grants_v1($1)', [JSON.stringify([
      {session_id:liveId,grant_id:grantId,user_id:liveUserId,language:'ko'},
    ])]);
    assert.equal(auth.rows[0].authorized,true);
    const claimed = await action('claim'); assert.equal(claimed.ownerId,ownerId);
    await assert.rejects(action('ready'), /MEDIA_NOT_READY/u);
    await assert.rejects(action('connect',1,otherId), /MEDIA_OWNER_CONFLICT/u);
    assert.equal((await action('connect')).connectedCount,1);
    assert.equal((await action('ready')).state,'active');
    assert.equal((await action('ready')).state,'active');
  });
  await t.test('renew validates grant revocation; pending demand cannot postpone idle drain', async () => {
    await query('update public.viewer_grants set revoked_at=now() where id=$1',[grantId]);
    const runtime = await action('renew',1,ownerId,[connectionId]);
    assert.equal(runtime.connectedCount,0); assert.ok(runtime.idleAfter);
    const deadline = runtime.idleAfter;
    await query('update public.viewer_grants set revoked_at=null where id=$1',[grantId]);
    await action('disconnect');
    await scalar('select public.prepare_live_viewer_connection_v1($1,$2,$3,$4) as value', [liveId,grantId,liveUserId,otherId]);
    assert.equal((await action('renew')).idleAfter,deadline);
    await assert.rejects(action('drain'), /MEDIA_DRAIN_NOT_DUE/u);
    await query("update public.live_session_runtime set idle_after=now()-interval '1 second' where session_id=$1",[liveId]);
    assert.equal((await action('drain')).state,'draining');
    assert.equal((await action('sleep')).state,'sleeping');
    assert.equal(await scalar('select status as value from public.live_sessions where id=$1',[liveId]),'preparing');
  });
  await t.test('stale epoch cannot close or persist into a newer epoch', async () => {
    await assert.rejects(scalar('select public.prepare_live_viewer_connection_v1($1,$2,$3,$4) as value',[liveId,grantId,liveUserId,connectionId]), /duplicate key/u);
    connectionId = '00000000-0000-4000-8000-000000000062';
    const next = await scalar('select public.prepare_live_viewer_connection_v1($1,$2,$3,$4) as value',[liveId,grantId,liveUserId,connectionId]);
    assert.equal(next.runtime.epoch,2);
    await assert.rejects(action('sleep',1), /MEDIA_EPOCH_CONFLICT/u);
    await action('connect',2);
    await action('ready',2);
    await query("update public.live_sessions set status='live' where id=$1",[liveId]);
    await assert.rejects(query('select public.assert_live_media_write_epoch_v1($1,$2,$3)',[liveId,1,ownerId]),/MEDIA_WRITE_EPOCH_CONFLICT/u);
    await query('select public.assert_live_media_write_epoch_v1($1,$2,$3)',[liveId,2,ownerId]);
  });
  await t.test('released source generation is a tombstone; delayed heartbeat cannot reopen capture', async () => {
    await scalar('select public.heartbeat_live_host_source_v1($1,$2,$3,false) as value',[liveId,'host-a',sourceGeneration]);
    await assert.rejects(scalar('select public.heartbeat_live_host_source_v1($1,$2,$3,true) as value',[liveId,'host-a',sourceGeneration]),/HOST_SOURCE_GENERATION_EXPIRED/u);
    await action('drain',2); await action('sleep',2);
    assert.equal((await scalar('select public.get_live_media_runtime_v1($1) as value',[liveId])).hostSourceReady,false);
  });
  await t.test('failed runtime cannot silently restart from a viewer; explicit host start resets failure', async () => {
    connectionId = '00000000-0000-4000-8000-000000000063';
    await scalar('select public.heartbeat_live_host_source_v1($1,$2,$3,true) as value',[liveId,'host-a',otherId]);
    await scalar('select public.prepare_live_viewer_connection_v1($1,$2,$3,$4) as value',[liveId,grantId,liveUserId,connectionId]);
    await action('claim',3); await action('fail',3);
    await assert.rejects(scalar('select public.prepare_live_viewer_connection_v1($1,$2,$3,$4) as value',[liveId,grantId,liveUserId,connectionId]),/MEDIA_EXPLICIT_RETRY_REQUIRED/u);
    assert.equal((await scalar('select public.request_live_media_start_v1($1,$2,$3) as value',[liveId,'host-a',1])).state,'sleeping');
  });
  await t.test('public roles cannot call service-only identity or mutation RPCs', async () => {
    await database.exec('set role authenticated');
    await assert.rejects(query('select * from public.read_participant_live_record_access_v1($1,$2)',[sessionId,userId]),/permission denied/u);
    await assert.rejects(scalar('select public.get_live_media_runtime_v1($1) as value',[liveId]),/permission denied/u);
    await database.exec('reset role');
  });
  await t.test('an actual meeting end retires media leases and closes only known gap times', async () => {
    await query("update public.live_sessions set status='stopped',ended_at=now() where id=$1",[liveId]);
    const runtime = await scalar('select public.get_live_media_runtime_v1($1) as value',[liveId]);
    assert.equal(runtime.state,'ended'); assert.equal(runtime.hostSourceReady,false);
    assert.equal(runtime.connectedCount,0); assert.equal(runtime.pendingCount,0);
    const gaps = await scalar('select public.read_owned_live_recording_gaps_v1($1,$2) as value',[liveId,'host-a']);
    assert.ok(gaps.recordingGaps.length>0);
    assert.ok(gaps.recordingGaps.every((gap)=>gap.endedAt!==null));
    await assert.rejects(query('select public.assert_live_media_write_epoch_v1($1,$2,$3)',[liveId,3,ownerId]),/MEDIA_SESSION_ENDED/u);
  });
});
