import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveCallArchive, readLiveArchiveSessionId } from '../src/live-call-archive.js';
const id = '12345678-1234-4234-8234-123456789abc';
const context = { sessionId: id, baseUrl: 'https://workspace.example', localAppOrigin: 'http://127.0.0.1:3210', hostId: 'host' };
const stamp = '2026-09-01T00:00:00.000Z';
const original = seq => ({ sourceUtteranceId:`source-${seq}`,sourceSeq:seq,effectiveText:`원문 ${seq}`,sourceLanguage:'ko',speakerName:'호스트',speakerLabel:'Host',sourceStartedAt:stamp,providerCommittedAt:stamp });
function detail(language='ko', summary=null) { return { record:{sessionId:id,title:'회의',startedAt:stamp,endedAt:stamp,languages:['ko','en']},selectedLanguage:language,transcript:{language,utterances:[{seq:1,text:language==='ko'?'번역 한국어':'English output',speaker:'Host',emittedAt:stamp}]},summary }; }
function harness(options={}) {
 const calls=[],imports=[];
 const archive=createLiveCallArchive({ requestRemote:async(baseUrl,path,request)=>{calls.push({baseUrl,path,request});return options.requestRemote ? options.requestRemote(baseUrl,path,request) : {ok:true,data:path.includes('/transcript?')?{transcript:{sessionId:id,items:[original(1)],hasNextPage:false,nextAfterSourceSeq:null}}:{detail:detail(path.includes('language=en')?'en':'ko')}};},importLocal:async(payload,ctx)=>{imports.push({payload,ctx}); return {ok:true};},...options });
 return {archive,calls,imports};
}
test('only valid bare or live-prefixed UUIDs can identify remote archives',()=>{
 assert.equal(readLiveArchiveSessionId(id),id);assert.equal(readLiveArchiveSessionId(`live-${id}`),id);
 for(const input of ['',null,'../private','live-foo',`live-${id}?url=bad`,{},id.toUpperCase()+'x'])assert.throws(()=>readLiveArchiveSessionId(input));
});
test('canonical originals page independently and both translations remain unpaired, remote summary imports without generation',async()=>{
 const summary={title:'요약',overview:'검증된 요약',chapters:[],decisions:[],actionItems:[]};
 const h=harness({requestRemote:async(_base,path)=>({ok:true,data:path.includes('/transcript?')?{transcript:{sessionId:id,items:[original(path.includes('afterSourceSeq=0')?1:2)],hasNextPage:path.includes('afterSourceSeq=0'),nextAfterSourceSeq:path.includes('afterSourceSeq=0')?1:null}}:{detail:detail(path.includes('language=en')?'en':'ko',{summary,createdAt:stamp})}})});
 await h.archive.refresh(context);
 assert.equal(h.imports.length,1);const value=h.imports[0].payload;
 assert.deepEqual(value.lines.filter(line=>line.sourceText).map(line=>[line.sourceSeq,line.sourceText]),[[1,'원문 1'],[2,'원문 2']]);
 assert.deepEqual(value.lines.filter(line=>line.translatedText).map(line=>[line.sourceText,line.targetLanguage,line.translatedText]),[['','ko','번역 한국어'],['','en','English output']]);
 assert.equal(value.summary.overview,summary.overview);assert.equal(value.id,`live-${id}`);
 assert.equal(value.lines.every(line=>!(line.sourceText&&line.translatedText)),true);
});
test('empty canonical source never uses translation or old sourceText as replacement',async()=>{
 const h=harness({requestRemote:async(_base,path)=>({ok:true,data:path.includes('/transcript?')?{transcript:{sessionId:id,items:[],hasNextPage:false,nextAfterSourceSeq:null}}:{detail:{...detail(path.includes('language=en')?'en':'ko'),transcript:{language:path.includes('language=en')?'en':'ko',utterances:[{seq:1,text:'Translation only',sourceText:'unverified old source',speaker:'Host',emittedAt:stamp}]}}}})});
 await h.archive.refresh(context);assert.equal(h.imports[0].payload.lines.length,2);assert.equal(h.imports[0].payload.lines.every(line=>line.sourceText===''),true);assert.equal(h.imports[0].payload.summary,null);
});
test('page error or repeated cursor cannot import a partial archive',async()=>{
 for(const result of [{ok:false,code:'SOURCE_READ_FAILED'},{ok:true,data:{transcript:{sessionId:id,items:[original(1)],hasNextPage:true,nextAfterSourceSeq:0}}}]){
 const h=harness({requestRemote:async(_base,path)=>path.includes('/transcript?')?result:{ok:true,data:{detail:detail()}}});
 await assert.rejects(h.archive.refresh(context));assert.equal(h.imports.length,0);
 }
});
test('a mismatched remote session fails before importing data',async()=>{
 const h=harness({requestRemote:async()=>({ok:true,data:{detail:{...detail(),record:{...detail().record,sessionId:'other'}}}})});
 await assert.rejects(h.archive.refresh(context));assert.equal(h.imports.length,0);
});
test('simultaneous refreshes share one read and the next explicit open fetches again',async()=>{
 let release=()=>{};
 /** @type {Promise<void>} */
 const pending=new Promise(resolve=>{release=resolve;});
 let requests=0;
 const h=harness({requestRemote:async(_base,path)=>{requests++;await pending;return {ok:true,data:path.includes('/transcript?')?{transcript:{sessionId:id,items:[],hasNextPage:false,nextAfterSourceSeq:null}}:{detail:detail(path.includes('language=en')?'en':'ko')}};}});
 const first=h.archive.refresh(context),second=h.archive.refresh(context);assert.equal(first,second);release();await first;assert.equal(h.imports.length,1);const count=requests;await h.archive.refresh(context);assert.ok(requests>count);assert.equal(h.imports.length,2);
});
test('a local import failure is explicit and never retries remote generation',async()=>{
 const h=harness({importLocal:async()=>({ok:false,code:'IMPORT_FAILED'})});await assert.rejects(h.archive.refresh(context),/기록/u);
 assert.equal(h.calls.every(call=>call.request.method==='GET'),true);assert.equal(h.calls.some(call=>/summary\//u.test(call.path)),false);
});

test('source projection rows in translation detail never duplicate the canonical original',async()=>{
 const h=harness({requestRemote:async(_base,path)=>({ok:true,data:path.includes('/transcript?')?{transcript:{sessionId:id,items:[original(1)],hasNextPage:false,nextAfterSourceSeq:null}}:{detail:{...detail(path.includes('language=en')?'en':'ko'),transcript:{language:path.includes('language=en')?'en':'ko',utterances:[{seq:1,origin:'source',text:'원문 projection',speaker:'Host',emittedAt:stamp}]}}}})});
 await h.archive.refresh(context);assert.equal(h.imports[0].payload.lines.length,1);assert.equal(h.imports[0].payload.lines[0].sourceText,'원문 1');
});
test('a read deadline is explicit, has no retry, and leaves the local record untouched',async()=>{
 let now=0,requests=0;const h=harness({now:()=>now,requestRemote:async(_base,_path,options)=>{requests++;assert.equal(options.timeoutMilliseconds,15000);now=60001;return {ok:true,data:{detail:detail()}};}});
 await assert.rejects(h.archive.refresh(context),error=>error instanceof Error && "code" in error && error.code==='LIVE_ARCHIVE_TIMEOUT');assert.equal(requests,1);assert.equal(h.imports.length,0);
});
test('pagination is bounded even if a valid endpoint keeps claiming more data',async()=>{
 let pages=0;const h=harness({requestRemote:async(_base,path)=>{
 if(!path.includes('/transcript?'))return {ok:true,data:{detail:detail()}};
 pages++;const after=Number(new URL(path,'https://workspace.example').searchParams.get('afterSourceSeq'));
 return {ok:true,data:{transcript:{sessionId:id,items:Array.from({length:50},(_,index)=>original(after+index+1)),hasNextPage:true,nextAfterSourceSeq:after+50}}};
 }});await assert.rejects(h.archive.refresh(context),error=>error instanceof Error && "code" in error && error.code==='LIVE_ARCHIVE_PAGINATION_INVALID');assert.equal(pages,400);assert.equal(h.imports.length,0);
});
test('oversized responses fail before any local write',async()=>{
 const h=harness({requestRemote:async()=>({ok:true,data:{detail:detail(),padding:'x'.repeat(20*1024*1024)}})});
 await assert.rejects(h.archive.refresh(context),error=>error instanceof Error && "code" in error && error.code==='LIVE_ARCHIVE_TOO_LARGE');assert.equal(h.imports.length,0);
});

test('canonical source retains supplementary Unicode and whitespace within codepoint and byte limits',async()=>{
 const sourceText='  '+String.fromCodePoint(0x20000).repeat(5000)+'\n원문  ';
 const h=harness({requestRemote:async(_base,path)=>({ok:true,data:path.includes('/transcript?')?{transcript:{sessionId:id,items:[{...original(1),effectiveText:sourceText}],hasNextPage:false,nextAfterSourceSeq:null}}:{detail:detail(path.includes('language=en')?'en':'ko')}})});
 await h.archive.refresh(context);assert.equal(h.imports[0].payload.lines[0].sourceText,sourceText);
 const oversized=harness({requestRemote:async(_base,path)=>({ok:true,data:path.includes('/transcript?')?{transcript:{sessionId:id,items:[{...original(1),effectiveText:String.fromCodePoint(0x20000).repeat(6001)}],hasNextPage:false,nextAfterSourceSeq:null}}:{detail:detail()}})});
 await assert.rejects(oversized.archive.refresh(context),error=>error instanceof Error&&'code' in error&&error.code==='LIVE_ARCHIVE_TOO_LARGE');assert.equal(oversized.imports.length,0);
});
