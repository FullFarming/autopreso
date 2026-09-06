import assert from "node:assert/strict";
import test from "node:test";
import type { ManagedCaptionSession } from "./store";
import { CaptionBroker, CaptionBrokerError, RENEWAL_GRACE_MS } from "./broker";
const soniox = {stt:{provider:"soniox",model:"stt-rt-v5",languageMode:"auto"},translation:{provider:"soniox",model:"stt-rt-v5"},summary:{provider:"gemini",model:"gemini-3.6-flash"}};
const gemini = {...soniox,stt:{provider:"gemini",model:"gemini-3.5-transcribe-live",languageMode:"auto"},translation:{provider:"gemini",model:"gemini-3.6-flash"}};
function fixture() {
  let now=Date.parse("2026-09-05T10:00:00Z");let engine=soniox;let allowed=true;
  let onProvider: (()=>Promise<void>) | undefined; let translationFinish="STOP";
  const sessions=new Map<string,ManagedCaptionSession>();const stopped=new Set<string>();let approved=true;
  const calls:Array<{url:string;body:Record<string,unknown>;headers:Headers}>=[];
  const broker=new CaptionBroker({sessions:{
    create:async(input)=>{const expiresAt=new Date(now+6*60*60_000).toISOString();sessions.set(input.sessionId,{...input,expiresAt});return expiresAt;},
    read:async(id)=>!approved||stopped.has(id)?null:sessions.get(id)??null,
    renew:async(id)=>{if(stopped.has(id)||!approved)return null;const expiresAt=new Date(now+6*60*60_000).toISOString();const current=sessions.get(id);if(current)sessions.set(id,{...current,expiresAt});return expiresAt;},
    stop:async(id)=>{if(!sessions.has(id))return false;stopped.add(id);return true;},
  },secret:"test-fixture-signing-secret",now:()=>now,readAssignment:async()=>({engine,assignmentRevision:"2"}),consumeLimit:async()=>allowed,
    readKey:()=>"server-only-fixture",fetchFn:async(url,init)=>{
      await onProvider?.();
      calls.push({url:String(url),body:JSON.parse(String(init?.body)),headers:new Headers(init?.headers)});
      if(String(url).includes("soniox"))return Response.json({api_key:"temporary-fixture",expires_at:new Date(now+60_000).toISOString()});
      if(String(url).includes("auth_tokens"))return Response.json({name:"auth_tokens/fixture"});
      return Response.json({candidates:[{finishReason:translationFinish,content:{parts:[{text:"translated text"}]}}]});
    }});
  return {broker,calls,sessions,setTranslationFinish:(value:string)=>{translationFinish=value;},onProvider:(action:()=>Promise<void>)=>{onProvider=action;},disable:()=>{approved=false;},setEngine:(value:typeof engine)=>{engine=value;},setNow:(value:number)=>{now=value;},deny:()=>{allowed=false;}};
}
test("caption session tickets pin engine across renewal and reject tampering or another owner",async()=>{
  const f=fixture();const session=await f.broker.start("user-a",{languages:["ko","en","ja"]});
  f.setEngine(gemini);
  const renewed=await f.broker.renew("user-a",{ticket:session.ticket});
  assert.deepEqual(renewed.engine,soniox);assert.equal(renewed.sessionId,session.sessionId);
  await assert.rejects(f.broker.renew("user-b",{ticket:session.ticket}), (e:CaptionBrokerError)=>e.status===401);
  await assert.rejects(f.broker.renew("user-a",{ticket:session.ticket+"x"}));
  f.setNow(Date.parse(session.expiresAt)+1000);
  await assert.rejects(f.broker.credentials("user-a",{ticket:session.ticket,provider:"soniox"}));
  const resumed=await f.broker.renew("user-a",{ticket:session.ticket});assert.deepEqual(resumed.engine,soniox);assert.equal(resumed.sessionId,session.sessionId);
});
test("temporary credentials are one use, bounded, and never expose permanent keys",async()=>{
  const f=fixture();const session=await f.broker.start("user-a",{languages:["ko","en","ja"]});
  const key=await f.broker.credentials("user-a",{ticket:session.ticket,provider:"soniox"});
  assert.equal(key.apiKey,"temporary-fixture");assert.equal(key.maxSessionDurationSeconds,600);
  assert.deepEqual(f.calls[0].body,{usage_type:"transcribe_websocket",expires_in_seconds:60,single_use:true,max_session_duration_seconds:600,client_reference_id:session.sessionId});
  assert.ok(!JSON.stringify(key).includes("server-only"));
  await assert.rejects(f.broker.credentials("user-a",{ticket:session.ticket,provider:"gemini"}));
  assert.equal(f.calls.length,1);
  f.deny();await assert.rejects(f.broker.credentials("user-a",{ticket:session.ticket,provider:"soniox"}),(e:CaptionBrokerError)=>e.status===429);
  assert.equal(f.calls.length,1);
});
test("Gemini token is model constrained and translation proxy accepts only pinned target languages",async()=>{
  const f=fixture();f.setEngine(gemini);const session=await f.broker.start("user-a",{languages:["ko","en"]});
  const key=await f.broker.credentials("user-a",{ticket:session.ticket,provider:"gemini",languageCodes:["ko-KR"],customVocabulary:["NOVA"]});
  assert.equal(key.apiKey,"auth_tokens/fixture");
  assert.equal(f.calls[0].url,"https://generativelanguage.googleapis.com/v1beta/auth_tokens");
  const constraints=f.calls[0].body.liveConnectConstraints as {model:string;config:unknown};
  assert.equal(constraints.model,"models/gemini-3.5-transcribe-live");
  assert.deepEqual(constraints.config,{responseModalities:["TEXT"],inputAudioTranscription:{languageCodes:["ko-KR"],mode:"VERBATIM",customVocabulary:["NOVA"]}});
  const translated=await f.broker.translate("user-a",{ticket:session.ticket,sourceText:"안녕하세요",targetLanguage:"en"});
  assert.deepEqual(translated,{text:"translated text",language:"en"});
  await assert.rejects(f.broker.translate("user-a",{ticket:session.ticket,sourceText:"x",targetLanguage:"ja"}));
  await assert.rejects(f.broker.translate("user-a",{ticket:session.ticket,sourceText:"x".repeat(4001),targetLanguage:"en"}));
  await assert.rejects(f.broker.start("user-a",{languages:["ko","en","ja","fr"]}));
  assert.equal(f.calls.length,2);
});

test("host stop revokes old tickets even after assignment changes; repeat stop is idempotent",async()=>{
  const f=fixture();const old=await f.broker.start("user-a",{languages:["ko","en"]});f.setEngine(gemini);
  assert.deepEqual(await f.broker.stop("user-a",{ticket:old.ticket}),{stopped:true});
  assert.deepEqual(await f.broker.stop("user-a",{ticket:old.ticket}),{stopped:true});
  await assert.rejects(f.broker.credentials("user-a",{ticket:old.ticket,provider:"soniox"}),(e:CaptionBrokerError)=>e.status===410);
  await assert.rejects(f.broker.renew("user-a",{ticket:old.ticket}),(e:CaptionBrokerError)=>e.status===410);
  const next=await f.broker.start("user-a",{languages:["ko","en"]});assert.deepEqual(next.engine,gemini);assert.equal(f.calls.length,0);
});
test("disabled profiles and mismatched stored pins cannot mint keys or translate",async()=>{
  const f=fixture();f.setEngine(gemini);const session=await f.broker.start("user-a",{languages:["ko","en"]});
  const stored=f.sessions.get(session.sessionId)!;f.sessions.set(session.sessionId,{...stored,assignmentRevision:"9"});
  await assert.rejects(f.broker.credentials("user-a",{ticket:session.ticket,provider:"gemini"}));
  f.sessions.set(session.sessionId,stored);f.disable();
  await assert.rejects(f.broker.translate("user-a",{ticket:session.ticket,sourceText:"x",targetLanguage:"en"}),(e:CaptionBrokerError)=>e.status===410);
  assert.equal(f.calls.length,0);
});

test("a provider response arriving after host stop cannot return usable credentials",async()=>{
  const f=fixture();const session=await f.broker.start("user-a",{languages:["ko","en"]});
  f.onProvider(async()=>{await f.broker.stop("user-a",{ticket:session.ticket});});
  await assert.rejects(f.broker.credentials("user-a",{ticket:session.ticket,provider:"soniox"}),(error:CaptionBrokerError)=>error.code==="CAPTION_SESSION_STOPPED");
  assert.equal(f.calls.length,1);
});

test("managed vocabulary accepts shared 240-codepoint proper names and rejects over-budget values",async()=>{
  const f=fixture();f.setEngine(gemini);const session=await f.broker.start("user-a",{languages:["ko","en"]});
  await f.broker.credentials("user-a",{ticket:session.ticket,provider:"gemini",customVocabulary:["한".repeat(240)]});
  await assert.rejects(f.broker.credentials("user-a",{ticket:session.ticket,provider:"gemini",customVocabulary:["한".repeat(241)]}));
  assert.equal(f.calls.length,1);
});
test("truncated or safety-refused translation output is never returned as final captions",async()=>{
  const f=fixture();f.setEngine(gemini);const session=await f.broker.start("user-a",{languages:["ko","en"]});
  for(const finish of ["MAX_TOKENS","SAFETY",""]){f.setTranslationFinish(finish);await assert.rejects(f.broker.translate("user-a",{ticket:session.ticket,sourceText:"x",targetLanguage:"en"}),(error:CaptionBrokerError)=>error.code==="CAPTION_TRANSLATION_INCOMPLETE");}
});

test("an expired ticket may revoke its own session but stopped sessions never resume",async()=>{
  const f=fixture();const session=await f.broker.start("user-a",{languages:["ko","en"]});f.setNow(Date.parse(session.expiresAt)+3600_000);
  await assert.rejects(f.broker.stop("user-b",{ticket:session.ticket}));
  assert.deepEqual(await f.broker.stop("user-a",{ticket:session.ticket}),{stopped:true});
  await assert.rejects(f.broker.renew("user-a",{ticket:session.ticket}),(error:CaptionBrokerError)=>error.code==="CAPTION_SESSION_STOPPED");
});

test("an expired ticket renews within the 24 hour grace window and is gone for good after it",async()=>{
  const f=fixture();const session=await f.broker.start("user-a",{languages:["ko","en"]});
  assert.equal(RENEWAL_GRACE_MS,24*60*60_000);
  f.setNow(Date.parse(session.expiresAt)+RENEWAL_GRACE_MS-60_000);
  const resumed=await f.broker.renew("user-a",{ticket:session.ticket});assert.equal(resumed.sessionId,session.sessionId);
  f.setNow(Date.parse(session.expiresAt)+RENEWAL_GRACE_MS+60_000);
  await assert.rejects(f.broker.renew("user-a",{ticket:session.ticket}),(error:CaptionBrokerError)=>error.code==="CAPTION_SESSION_EXPIRED"&&error.status===410);
  const again=await f.broker.renew("user-a",{ticket:resumed.ticket});assert.equal(again.sessionId,session.sessionId,"a renewed ticket carries its own fresh 6 h window and restarts the grace clock");
  f.setNow(Date.parse(again.expiresAt)+RENEWAL_GRACE_MS+1);
  await assert.rejects(f.broker.renew("user-a",{ticket:again.ticket}),(error:CaptionBrokerError)=>error.code==="CAPTION_SESSION_EXPIRED");
  assert.deepEqual(await f.broker.stop("user-a",{ticket:session.ticket}),{stopped:true},"the owner can still end it");
});
test("Gemini ephemeral token languages must be a subset of the ticket's pinned languages",async()=>{
  const f=fixture();f.setEngine(gemini);const session=await f.broker.start("user-a",{languages:["ko","en"]});
  for(const languageCodes of [["ja-JP"],["ko-KR","ja"],["xx-YY"]]){
    await assert.rejects(f.broker.credentials("user-a",{ticket:session.ticket,provider:"gemini",languageCodes}),(error:CaptionBrokerError)=>error.code==="CAPTION_LANGUAGES_MISMATCH"&&error.status===400);
  }
  assert.equal(f.calls.length,0,"a mismatch never reaches the provider");
  await f.broker.credentials("user-a",{ticket:session.ticket,provider:"gemini",languageCodes:["ko-KR","en-US"]});
  await f.broker.credentials("user-a",{ticket:session.ticket,provider:"gemini"});
  assert.equal(f.calls.length,2);
});
