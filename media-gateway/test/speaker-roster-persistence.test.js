import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseLivePublisher } from '../src/supabase-adapters.js';
const sessionId='11111111-1111-4111-8111-111111111111';
const speakerId='22222222-2222-4222-8222-222222222222';
const profile={id:speakerId,version:1,displayName:'발표자',company:'회사',department:'부서',photoAssetId:null};
test('roster RPC validates session, profile and revision before staging; ack is independent of audio',async()=>{
 const requests=[]; const roster={sessionId,revision:2,appliedRevision:1,activeOnsiteSpeakerId:speakerId,speakers:[{...profile,participantId:null}]};
 const publisher=new SupabaseLivePublisher({baseUrl:'https://db.invalid',serviceRoleKey:'test',eventFanout(){},fetchFn:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify(roster));}});
 const scoped=publisher.withMediaFence(null);
 assert.deepEqual(await scoped.fetchSpeakerRoster(sessionId),roster);
 await scoped.ackSpeakerRoster(sessionId,2);
 assert.match(requests[1].url,/ack_live_speaker_roster_v1$/);
 assert.equal(requests[1].body.p_revision,2);
 roster.speakers[0].displayName='<script>';
 await assert.rejects(scoped.fetchSpeakerRoster(sessionId));
});
test('durable profiled captions retain profile-authorized metadata required by SQL',async()=>{
 let eventBody;
 const publisher=new SupabaseLivePublisher({baseUrl:'https://db.invalid',serviceRoleKey:'test',eventFanout(){},fetchFn:async(_url,options)=>{eventBody=JSON.parse(options.body).p_event;return Response.json(true);}});
 await publisher.publish(sessionId,'en',{type:'caption',sessionId,language:'en',seq:1,isFinal:true,text:'Hello',speakerProfile:profile,speakerRole:'host',speakerName:profile.displayName,speakerDepartment:profile.department,speakerJobTitle:'',speaker:{speakerId:'speaker-1',label:profile.displayName},sourceEndedAt:'2026-09-05T00:00:00Z',emittedAt:'2026-09-05T00:00:00Z'});
 assert.equal(eventBody.speakerRole,'host');assert.equal(eventBody.speakerName,profile.displayName);assert.equal(eventBody.speakerDepartment,profile.department);
});
test('real pipeline sends profile source v4 and atomic caption metadata, and replay retains snapshots',async()=>{
 const { LiveMediaPipeline }=await import('../src/live-media-pipeline.js');
 const { createGeminiCaptionConfig }=await import('../../packages/caption-core/index.js');
 const requests=[],sourceEvents=[];const sourceId='33333333-3333-4333-8333-333333333333';
 const publisher=new SupabaseLivePublisher({baseUrl:'https://db.invalid',serviceRoleKey:'test',async eventFanout(){},async sourceEventFanout(value){sourceEvents.push(value);},fetchFn:async(url,options)=>{
 const body=options.body?JSON.parse(options.body):null;requests.push({url,body});
 if(url.includes('speaker_roster'))return Response.json({sessionId,revision:1,appliedRevision:0,activeOnsiteSpeakerId:speakerId,speakers:[{...profile,participantId:null}]});
 if(url.includes('persist_authoritative'))return Response.json({ok:true,sourceUtteranceId:sourceId,sourceSeq:1,idempotent:false});
 if(url.includes('/live_utterances?'))return Response.json([{seq:1,participant_id:null,speaker_label:'0',speaker_name:profile.displayName,speaker_profile:profile,speaker_attribution:null,text:'Hello world.',source_ended_at:'2026-09-05T00:00:00Z',emitted_at:'2026-09-05T00:00:00Z'}]);
 return Response.json(true);
 }});
 const pipeline=new LiveMediaPipeline({sessionId,sessionType:'meeting',mode:'meeting',languages:['en'],captionConfig:createGeminiCaptionConfig({languages:['en']}),dependencies:{publisher:publisher.withMediaFence(null),speechToText:{async open(){return{supportsRolloverRemap:false,async sendAudio(){},async close(){}};}}}});
 await pipeline.start();await pipeline.acceptAudio(new Uint8Array(1280));await pipeline.acceptFinalUtterance({text:'Hello world.',speakerLabel:'0',sourceLanguage:'en',sourceSessionStartOffsetMs:0,sourceSessionEndOffsetMs:40,sourceStartOffsetMs:0,sourceEndOffsetMs:40,sourceEndedAt:'2026-09-05T00:00:00Z'});
 const source=requests.find(value=>value.url.includes('persist_authoritative'));
 assert.match(source.url,/persist_authoritative_live_source_utterance_v4$/);assert.deepEqual(source.body.p_speaker_profile,profile);assert.equal(source.body.p_speaker_attribution,null);assert.equal(source.body.p_speaker_name,profile.displayName);
 const caption=requests.find(value=>value.url.includes('persist_live_final_caption'));
 assert.equal(caption.body.p_event.speakerName,profile.displayName);assert.equal(caption.body.p_event.speakerRole,'host');
 assert.deepEqual(sourceEvents.find(value=>value.type==='source').speakerProfile,profile);
 assert.deepEqual((await publisher.fetchUtterancesAfter(sessionId,'en',0))[0].speakerProfile,profile);
 await pipeline.close();
});
