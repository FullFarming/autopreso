import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import { createLiveCallArchive, readLiveArchiveSessionId } from '../src/live-call-archive.js';
const main=readFileSync(new URL('../electron/main.js',import.meta.url),'utf8');
const dashboard=readFileSync(new URL('../public/subtitle-dashboard.js',import.meta.url),'utf8');
const id='12345678-1234-4234-8234-123456789abc';
const stamp='2026-09-01T00:00:00.000Z';
function nativeHarness(){
 const handlers=new Map(),remote=[],imports=[];const sender={getURL:()=> 'http://127.0.0.1:3210/subtitle.html'};
 const context={URL,Set,JSON,AbortSignal,createLiveCallArchive,readLiveArchiveSessionId,liveCallArchive:null,
  localAppOrigin:'http://127.0.0.1:3210',isHostLogoutPending:false,isHostLoginPending:false,
  dashboardWindow:{isDestroyed:()=>false,webContents:sender},ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},
  resolveLiveWorkspaceUrl:()=> 'https://trusted.example',ensureDesktopHostSession:async()=>({ok:true,data:{userId:'host'}}),
  liveCallApi:/** @returns {Promise<unknown>} */ async(base,path,options)=>{remote.push({base,path,options});return {ok:true,data:path.includes('/transcript?')?{transcript:{sessionId:id,items:[],hasNextPage:false,nextAfterSourceSeq:null}}:{detail:{record:{sessionId:id,title:'회의',languages:['ko'],startedAt:stamp,endedAt:stamp},selectedLanguage:'ko',transcript:{language:'ko',utterances:[]},summary:null}}};},
  net:{fetch:async(url,options)=>{imports.push({url,options});return {ok:true,json:async()=>({ok:true})};}},
 };
 const archive=main.slice(main.indexOf('async function archiveLiveCallSession('),main.indexOf('// ── Window reachability'));
 const allowed=main.slice(main.indexOf('function isAllowedOrigin('),main.indexOf('// Boot must never reject silently.'));
 const ipc=main.slice(main.indexOf('  ipcMain.handle("live-call:archive-refresh"'),main.indexOf('  ipcMain.handle("host-session:get"'));
 vm.runInNewContext(`${allowed}\n${archive}\n${ipc}`,context);
 return {context,remote,imports,sender,refresh:recordId=>handlers.get('live-call:archive-refresh')({sender},recordId),handler:handlers.get('live-call:archive-refresh')};
}
test('archive refresh accepts only the authenticated dashboard and fixed configured origin after restart',async()=>{
 const h=nativeHarness();const result=await h.refresh(`live-${id}`);assert.equal(result.ok,true);assert.equal(h.remote.length,2);assert.equal(h.imports.length,1);
 assert.equal(h.remote.every(call=>call.base==='https://trusted.example'&&call.options.method==='GET'),true);
 assert.equal(h.imports[0].url,'http://127.0.0.1:3210/api/subtitles/sessions/import');
 assert.equal(JSON.parse(h.imports[0].options.body).id,`live-${id}`);
});
test('forged sender, wrong origin, invalid IDs and absent authentication cannot request or import archives',async()=>{
 for(const mode of ['sender','origin','id','auth','logout']){
  const h=nativeHarness();let event={sender:h.sender},recordId=`live-${id}`;
  if(mode==='sender')event={sender:{getURL:()=>h.sender.getURL()}};
  if(mode==='origin')h.sender.getURL=()=> 'http://127.0.0.1.evil.example:3210/subtitle.html';
  if(mode==='id')recordId='../secret';
  if(mode==='auth')h.context.ensureDesktopHostSession=async()=>({ok:false,data:null});
  if(mode==='logout')h.context.isHostLogoutPending=true;
  const result=await h.handler(event,recordId);assert.equal(result.ok,false);assert.equal(h.remote.length,0);assert.equal(h.imports.length,0);
 }
});
test('an account change during remote reads cannot write the previous host archive',async()=>{
 const h=nativeHarness();let checks=0;h.context.ensureDesktopHostSession=async()=>({ok:true,data:{userId:++checks===1?'old':'new'}});
 const result=await h.refresh(id);assert.equal(result.ok,false);assert.equal(h.imports.length,0);
});
function rendererHarness(refresh){
 const events=[],errors=[];const node=()=>({textContent:'',hidden:false,replaceChildren(){},append(){}});
 const els={panel:node(),title:node(),meta:node(),summary:node(),generate:node(),audio:node(),listPanel:node(),page:null};
 const context={HTMLElement:class{},document:{activeElement:null,createElement:node},window:{realtimeNoelDesktop:{refreshLiveCallArchive:refresh}},
  sessionDetailElements:()=>els,openSessionDetail:{},t:key=>key,showError:message=>errors.push(message),
  fetch:async()=>{events.push('local-read');return{json:async()=>({ok:true,data:{meta:{},lines:[],summary:{overview:'ready'}}})};},
  formatSessionRecordTime:()=>'',transcriptTextForLanguage:()=>'',renderOpenSessionTranscript(){},renderSessionCoachHistory(){},sessionCoachHistory:()=>({}),renderSessionParticipants(){},renderSessionSummary(){},activateSessionDetailView(){},setSessionRecordsStatus:message=>errors.push(message),
 };
 const code=dashboard.slice(dashboard.indexOf('async function openSessionRecordDetail('),dashboard.indexOf('function closeSessionRecordDetail('));
 const open=vm.runInNewContext(`${code}\nopenSessionRecordDetail`,context);return{open,events,errors,context};
}
test('opening a Live record waits for canonical refresh before reading its local copy',async()=>{
 let release=()=>{};
 /** @type {Promise<void>} */
 const pending=new Promise(resolve=>{release=resolve;});const requests=[];
 const h=rendererHarness(async recordId=>{requests.push(recordId);await pending;return{ok:true};});
 const opening=h.open({id:`live-${id}`});await Promise.resolve();assert.deepEqual(h.events,[]);release();await opening;
 assert.deepEqual(requests,[`live-${id}`]);assert.deepEqual(h.events,['local-read']);assert.deepEqual(h.errors,[]);
});
test('failed refresh is explicit, while Caption Only records never contact the remote archive',async()=>{
 const h=rendererHarness(async()=>({ok:false}));await h.open({id:`live-${id}`});assert.deepEqual(h.events,[]);assert.deepEqual(h.errors,['records.loadFailed']);
 const local=rendererHarness(async()=>{throw new Error('must not call');});await local.open({id:'local-record'});assert.deepEqual(local.events,['local-read']);assert.deepEqual(local.errors,[]);
});

test('offline reads may use only a same-owner cached record and never override auth denial',async()=>{
 for(const [owner,remoteCode,expected] of [['host','NETWORK_UNAVAILABLE',true],['other','NETWORK_UNAVAILABLE',false],['','NETWORK_UNAVAILABLE',false],['host','HTTP_403',false]]){
  const h=nativeHarness();h.context.liveCallApi=async()=>({ok:false,code:remoteCode});
  let reads=0;h.context.net.fetch=async()=>{reads++;return{ok:true,json:async()=>({ok:true,data:{meta:{id:`live-${id}`,ownerHostId:owner}}})};};
  const result=await h.refresh(id);assert.equal(result.ok,false);assert.equal(result.canUseCached===true,expected);if(remoteCode==='HTTP_403')assert.equal(reads,0);
 }
});
test('a verified cached read displays a refresh warning without presenting the refresh as successful',async()=>{
 const warnings=[];
 // The page already reports errors through the existing toast utility.
 const code=dashboard.slice(dashboard.indexOf('async function openSessionRecordDetail('),dashboard.indexOf('function closeSessionRecordDetail('));
 assert.match(code,/showError\(t\("records.loadFailed"\)\)/u);
 const actual=rendererHarnessWithWarning(warnings);
 await actual.open({id:`live-${id}`});assert.deepEqual(actual.events,['local-read']);assert.deepEqual(warnings,['records.loadFailed']);
});
function rendererHarnessWithWarning(warnings){
 const h=rendererHarness(async()=>({ok:false,code:'LIVE_ARCHIVE_REFRESH_FAILED',canUseCached:true}));
 h.context.showError=message=>warnings.push(message);return h;
}
