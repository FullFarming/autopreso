import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveMediaPipeline } from '../src/live-media-pipeline.js';
import { createGeminiCaptionConfig } from '../../packages/caption-core/index.js';
const sessionId='11111111-1111-4111-8111-111111111111';
const participantId='55555555-5555-4555-8555-555555555555';
const speaker=(digit,name,linked=null)=>({id:`${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,version:1,displayName:name,company:'회사',department:'부서',photoAssetId:null,participantId:linked});
const roster=(revision,active,speakers)=>({sessionId,revision,appliedRevision:0,activeOnsiteSpeakerId:active?.id??null,speakers});
function setup(initial){
 let now=Date.parse('2026-09-05T00:00:00Z');let selected=initial;const events=[],sources=[],acks=[];let callbacks;
 const pipeline=new LiveMediaPipeline({sessionId,sessionType:'meeting',mode:'meeting',languages:['en'],captionConfig:createGeminiCaptionConfig({languages:['en']}),now:()=>now,dependencies:{speechToText:{async open(options){callbacks=options;return{supportsRolloverRemap:false,async sendAudio(){},async close(){}};}},publisher:{async fetchSpeakerRoster(){if(selected instanceof Error)throw selected;return selected;},async ackSpeakerRoster(_session,revision){acks.push(revision);},async publish(_s,_l,event){events.push(event);},async persistAuthoritativeSource(value){sources.push(value);return{sourceUtteranceId:`source-${sources.length}`,sourceSeq:sources.length,idempotent:false};}}}});
 return {pipeline,events,sources,acks,async update(value){selected=value;now+=1001;await pipeline.tick();},async capture(floor=null){await pipeline.acceptAudio(new Uint8Array(1280),now,floor,floor?'participant':'mic');},async final(start,end,text='The project is ready.'){return pipeline.acceptFinalUtterance({speakerLabel:'0',text,sourceLanguage:'en',sourceStartOffsetMs:start,sourceEndOffsetMs:end,sourceSessionStartOffsetMs:start,sourceSessionEndOffsetMs:end,sourceEndedAt:new Date(now).toISOString()});},get callbacks(){return callbacks;}};
}
test('roster applies only at accepted audio boundary and delayed A B C retain snapshot A',async()=>{
 const a=speaker('2','Alice'),b=speaker('3','Bob'),c=speaker('4','Carol');const state=setup(roster(1,a,[a,b,c]));
 await state.pipeline.start();assert.deepEqual(state.acks,[]);await state.capture();assert.deepEqual(state.acks,[1]);
 await state.update(roster(2,b,[a,b,c]));assert.deepEqual(state.acks,[1]);await state.capture();
 await state.update(roster(3,c,[a,b,c]));await state.capture();
 await state.final(0,40);await state.final(40,80,'The next project is ready.');await state.final(80,120,'The final project is ready.');
 a.displayName='Mutated';
 assert.deepEqual(state.sources.map(s=>s.speakerProfile.displayName),['Alice','Bob','Carol']);
 assert.deepEqual(state.events.filter(e=>e.type==='caption'&&e.isFinal).map(e=>e.speakerProfile.displayName),['Alice','Bob','Carol']);
 assert.equal(state.sources[0].speakerName,'Alice');assert.deepEqual(state.acks,[1,2,3]);await state.pipeline.close();
});
test('captured linked floor profile takes priority, unlinked floor retains its own identity',async()=>{
 const a=speaker('2','Onsite'),p=speaker('3','Online',participantId);const state=setup(roster(1,a,[a,p]));await state.pipeline.start();
 await state.capture({participantId,displayName:'Guest'});state.pipeline.setFloorSpeaker(null);
 await state.final(0,40);assert.equal(state.sources[0].speakerProfile.displayName,'Online');assert.equal(state.sources[0].participantId,participantId);
 await state.capture({participantId:'66666666-6666-4666-8666-666666666666',displayName:'Other'});
 await state.final(40,80,'Another sentence is ready.');assert.equal(state.sources[1].speakerProfile,undefined);assert.equal(state.sources[1].speakerName,'Other');assert.equal(state.sources[1].participantId,'66666666-6666-4666-8666-666666666666');await state.pipeline.close();
});
test('ambiguous and onsetless finals use unresolved metadata, never current roster',async()=>{
 const a=speaker('2','Alice'),b=speaker('3','Bob');const state=setup(roster(1,a,[a,b]));await state.pipeline.start();await state.capture();
 await state.update(roster(2,b,[a,b]));await state.capture();await state.final(20,60);
 assert.equal(state.sources[0].speakerAttribution,'unresolved');assert.equal(state.sources[0].speakerRole,'unknown');assert.equal(state.sources[0].speakerProfile,undefined);
 assert.equal(state.events.find(e=>e.type==='caption'&&e.isFinal).speaker.label,'발언자 확인 필요');await state.pipeline.close();
});

test('Gemini manual speaker boundary drains old onsetless final under previous profile',async()=>{
 const { GEMINI_ENGINE_SELECTION }=await import('../../packages/caption-core/caption-engine-catalog.js');
 const a=speaker('2','Alice'),b=speaker('3','Bob');let selected=roster(1,a,[a,b]);let now=Date.parse('2026-09-05T00:00:00Z');const opens=[],sources=[];let releaseOld;
 const pipeline=new LiveMediaPipeline({sessionId,sessionType:'meeting',mode:'meeting',languages:['en'],captionConfig:createGeminiCaptionConfig({languages:['en'],engine:GEMINI_ENGINE_SELECTION}),now:()=>now,dependencies:{
 textTranslate:{async translate(){throw new Error('SOURCE_LANE_MUST_NOT_TRANSLATE');}},speechToText:{async open(callbacks){const index=opens.length;opens.push(callbacks);return{supportsRolloverRemap:false,async sendAudio(){},async close(){if(index===0)await new Promise(resolve=>{releaseOld=resolve;});}};}},
 publisher:{async fetchSpeakerRoster(){if(selected instanceof Error)throw selected;return selected;},async ackSpeakerRoster(){},async publish(){},async persistAuthoritativeSource(value){sources.push(value);return{sourceUtteranceId:'source-'+sources.length,sourceSeq:sources.length};}}}});
 await pipeline.start();await pipeline.acceptAudio(new Uint8Array(1280),now,null,'mic');
 selected=roster(2,b,[a,b]);now+=1001;await pipeline.tick();await pipeline.acceptAudio(new Uint8Array(1280),now,null,'mic');
 assert.equal(opens.length,2);
 await opens[0].onFinalUtterance({speakerLabel:'0',text:'This is the previous speaker.',sourceLanguage:'en',sourceEndedAt:new Date(now).toISOString()});
 releaseOld();await opens[1].onFinalUtterance({speakerLabel:'0',text:'This is the next speaker.',sourceLanguage:'en',sourceEndedAt:new Date(now).toISOString()});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(sources.map(value=>value.speakerProfile.displayName),['Alice','Bob']);await pipeline.close();
});

test('initial roster outage records unresolved identity instead of guessing Host',async()=>{
 const state=setup(new Error('unavailable'));await state.pipeline.start();await state.capture({participantId,displayName:'Guest'});await state.final(0,40);
 assert.equal(state.sources[0].speakerAttribution,'unresolved');assert.equal(state.sources[0].speakerRole,'unknown');assert.equal(state.sources[0].participantId,null);
 await state.pipeline.close();
});

test('overlapping host and floor admissions serialize roster acknowledgement across provider rotation',async()=>{
 const { GEMINI_ENGINE_SELECTION }=await import('../../packages/caption-core/caption-engine-catalog.js');
 const a=speaker('2','Alice'),b=speaker('3','Bob'),c=speaker('4','Carol');let selected=roster(1,a,[a,b,c]);let now=0;let openCount=0;let releaseOpen;const acks=[];
 const pipeline=new LiveMediaPipeline({sessionId,mode:'meeting',languages:['en'],captionConfig:createGeminiCaptionConfig({languages:['en'],engine:GEMINI_ENGINE_SELECTION}),now:()=>now,dependencies:{textTranslate:{async translate(){return'Unused';}},speechToText:{async open(){openCount++;if(openCount===2)await new Promise(resolve=>{releaseOpen=resolve;});return{supportsRolloverRemap:false,async sendAudio(){},async close(){}};}},publisher:{async fetchSpeakerRoster(){return selected;},async ackSpeakerRoster(_s,revision){acks.push(revision);},async publish(){}}}});
 await pipeline.start();await pipeline.acceptAudio(new Uint8Array(1280),now,null,'mic');
 selected=roster(2,b,[a,b,c]);now=1001;await pipeline.tick();const second=pipeline.acceptAudio(new Uint8Array(1280),now,null,'mic');await new Promise(resolve=>setImmediate(resolve));
 selected=roster(3,c,[a,b,c]);now=2002;await pipeline.tick();const third=pipeline.acceptAudio(new Uint8Array(1280),now,{participantId,displayName:'Guest'},'participant');releaseOpen();
 await Promise.all([second,third]);assert.deepEqual(acks,[1,2,3]);await pipeline.close();
});
