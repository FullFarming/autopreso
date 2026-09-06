import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createViewerGrantToken, createRecapGrantToken, VIEWER_GRANT_COOKIE, RECAP_GRANT_COOKIE, AuthorizationError } from '../auth/live-auth';
import { authenticateSourceSnapshotRequest, authenticateSourceSnapshotAudience, SupabaseSourceSnapshotStore, parseSourceSnapshotQuery } from './source-snapshot';
import { createSessionToken, SESSION_COOKIE } from '../session';
import { LiveAdmissionError } from '../security/live-admission-store';
import { isViewerSnapshotPath } from '../security/csrf';
const sessionId='00000000-0000-4000-8000-000000000001';
const userId='00000000-0000-4000-8000-000000000002';
const grantId='00000000-0000-4000-8000-000000000003';
const cookies=(values:Record<string,string>)=>({cookies:{get:(key:string)=>values[key]?{value:values[key]}:undefined}});

test('host source audience requires the host cookie without changing participant authorization',async()=>{
  const oldUsers=process.env.ADMIN_USER_IDS;process.env.ADMIN_USER_IDS='source-host';
  try {
    const host=await createSessionToken('source-host');
    const {token:viewer}=await createViewerGrantToken({sessionId,userId,grantId});
    const mixed=cookies({[SESSION_COOKIE]:host,[VIEWER_GRANT_COOKIE]:viewer});
    assert.deepEqual(await authenticateSourceSnapshotAudience(mixed,sessionId,'host'),{role:'host',hostId:'source-host'});
    assert.deepEqual(await authenticateSourceSnapshotAudience(mixed,sessionId,null),{role:'participant',userId,grantId});
    await assert.rejects(authenticateSourceSnapshotAudience(cookies({[VIEWER_GRANT_COOKIE]:viewer}),sessionId,'host'));
    await assert.rejects(authenticateSourceSnapshotAudience(mixed,sessionId,'admin'),LiveAdmissionError);
    await assert.rejects(authenticateSourceSnapshotAudience(cookies({[SESSION_COOKIE]:`${host}tampered`}),sessionId,'host'));
  }finally {if(oldUsers===undefined)delete process.env.ADMIN_USER_IDS;else process.env.ADMIN_USER_IDS=oldUsers;}
});

test('host source store uses the private owner RPC, carries known gaps, and rejects cross-session pages',async()=>{
  const gap={id:grantId,startedAt:'2026-09-01T00:00:00.000Z',endedAt:null,reason:'no_viewers'};
  const page={sessionId,sources:[],lastSourceSeq:0,hasNextPage:false,nextAfterSourceSeq:null,recordsExpiresAt:null,recordingGaps:[gap]};
  const make=(payload:unknown,status=200)=>new SupabaseSourceSnapshotStore({
    getServerAccess:()=>({url:'https://test-ref.supabase.co',credential:{kind:'secret',key:'sb_secret_test-only-value'}}),
    fetchFn:async(url,init)=>{assert.match(String(url),/read_owned_live_source_snapshot_v1$/u);
      assert.deepEqual(JSON.parse(String(init?.body)),{p_session_id:sessionId,p_host_id:'source-host',p_after_source_seq:0,p_limit:500});
      return Response.json(payload,{status});},
  });
  const input={hostId:'source-host',afterSourceSeq:0,pageSize:500};
  assert.deepEqual(await make(page).readHost(sessionId,input),page);
  await assert.rejects(make({...page,sessionId:grantId}).readHost(sessionId,input),/응답/u);
  await assert.rejects(make({...page,recordingGaps:[{...gap,reason:'inferred'}]}).readHost(sessionId,input),/응답/u);
  await assert.rejects(make({message:'SOURCE_FORBIDDEN'},403).readHost(sessionId,input),(error:unknown)=>error instanceof LiveAdmissionError&&error.status===403);
  await assert.rejects(make({message:'EXPORT_TOO_LARGE'},400).readHost(sessionId,input),(error:unknown)=>error instanceof LiveAdmissionError&&error.status===413);
});

test('source route authenticates the selected audience before its own read rate limit and private store',async()=>{
  const route=await readFile(new URL('../../app/api/live-sessions/[id]/source-snapshot/route.ts',import.meta.url),'utf8');
  assert.ok(route.indexOf('authenticateSourceSnapshotAudience(request, sessionId, audience)')<route.indexOf('store.readHost'));
  assert.ok(route.indexOf('enforceAuthoritativeTranscriptReadRateLimit(identity.hostId')<route.indexOf('store.readHost'));
  assert.match(route,/store\.readHost\(sessionId, \{ hostId: identity\.hostId, \.\.\.page \}\)/u);
  assert.match(route,/enforceParticipantRecordReadRateLimit\(identity\.userId/u);
  assert.doesNotMatch(route,/searchParams\.get\(["']hostId/u);
  assert.match(route,/privateNoStoreHeaders\(\)/u);
});

test('source auth binds signed viewer/recap identity without exposing the host audit API',async()=>{
  const {token}=await createViewerGrantToken({sessionId,userId,grantId});
  assert.deepEqual(await authenticateSourceSnapshotRequest(cookies({[VIEWER_GRANT_COOKIE]:token}),sessionId),{userId,grantId});
  await assert.rejects(authenticateSourceSnapshotRequest(cookies({[VIEWER_GRANT_COOKIE]:token}),grantId),AuthorizationError);
  const {token:recap}=await createRecapGrantToken({sessionId,userId});
  assert.deepEqual(await authenticateSourceSnapshotRequest(cookies({[RECAP_GRANT_COOKIE]:recap}),sessionId),{userId,grantId:null});
});

test('snapshot cursor boundaries and middleware allow only the exact read surface',()=>{
  assert.deepEqual(parseSourceSnapshotQuery(new URLSearchParams()),{afterSourceSeq:0,pageSize:200});
  for(const query of ['afterSourceSeq=-1','afterSourceSeq=1.1','afterSourceSeq=9007199254740992','pageSize=501','pageSize=0'])
    assert.throws(()=>parseSourceSnapshotQuery(new URLSearchParams(query)),LiveAdmissionError);
  assert.equal(isViewerSnapshotPath(`/api/live-sessions/${sessionId}/source-snapshot`,'GET'),true);
  assert.equal(isViewerSnapshotPath(`/api/live-sessions/${sessionId}/source-snapshot`,'POST'),false);
});

test('source reader binds requested session, propagates six-hour denial, and refuses oversized response',async()=>{
  const make=(payload:unknown,status=200,headers:Record<string,string>={})=>new SupabaseSourceSnapshotStore({
    getServerAccess:()=>({url:'https://test-ref.supabase.co',credential:{kind:'secret',key:'sb_secret_test-only-value'}}),
    fetchFn:async(url,init)=>{assert.match(String(url),/read_participant_live_source_snapshot_v1$/u);
      assert.deepEqual(JSON.parse(String(init?.body)),{p_session_id:sessionId,p_user_id:userId,p_grant_id:grantId,p_after_source_seq:0,p_limit:200});
      return Response.json(payload,{status,headers});},
  });
  const input={userId,grantId,afterSourceSeq:0,pageSize:200};
  const page={sessionId,sources:[],lastSourceSeq:0,hasNextPage:false,nextAfterSourceSeq:null,recordsExpiresAt:null};
  assert.deepEqual(await make(page).read(sessionId,input),page);
  await assert.rejects(make(page,200,{'content-length':String(17*1024*1024)}).read(sessionId,input),/응답/u);
  await assert.rejects(make({...page,sessionId:grantId}).read(sessionId,input),/응답/u);
  await assert.rejects(make({message:'RECAP_EXPIRED'},400).read(sessionId,input),(error:unknown)=>error instanceof LiveAdmissionError&&error.status===410);
});

test('ordinary target snapshot joins the canonical source observation so neutral text survives refresh',async()=>{
  const {SupabaseLiveSessionStore}=await import('./store');
  const sourceId='00000000-0000-4000-8000-000000000004';
  const observation={state:'unknown',languageCode:'und',providerLanguageCode:null,evidence:'neutral',languages:[]};
  const now=new Date().toISOString();
  const store=new SupabaseLiveSessionStore('https://test-ref.supabase.co',{kind:'secret',key:'sb_secret_test-only-value'},async(url,init)=>{
    const path=String(url);
    if(path.includes('read_live_caption_source_observations_v1')){
      assert.deepEqual(JSON.parse(String(init?.body)),{p_session_id:sessionId,p_source_ids:[sourceId]});
      return Response.json([{source_utterance_id:sourceId,source_seq:1,language_observation:observation}]);
    }
    if(path.includes('read_live_topic_context'))return Response.json({ok:true,event:'topic-upsert',topics:[],topic_memberships:[],memberships_added:[],latest_source_seq:0});
    if(path.includes('/live_utterances'))return Response.json([{seq:7,authoritative_source_id:sourceId,text:'2026',
      source_text:'2026',source_language:'und',translation_status:'verbatim',source_ended_at:now,emitted_at:now}]);
    if(path.includes('/live_sessions'))return Response.json([{id:sessionId,host_id:'host',session_type:'meeting',output_mode:'captions',
      max_viewers:50,glossary_pack:'general_cre',title:'회의',status:'live',languages:['ko','en'],viewer_count:1,version:1,
      voice_provider:'gemini',admission_open_until:null,expires_at:new Date(Date.now()+60_000).toISOString()}]);
    return Response.json([]);
  });
  const page=await store.getSnapshot(sessionId,'ko');
  assert.deepEqual(page?.captions[0].languageObservation,observation);
  assert.equal(page?.captions[0].seq,7);
});
