import test from 'node:test';
import assert from 'node:assert/strict';
import { createSentenceLanguageRouting } from '../src/sentence-language-routing.js';
test('a confirmed sentence keeps its routing hint through provider flips and foreign abbreviations',()=>{
 const state=createSentenceLanguageRouting();
 assert.equal(state.observe('오늘 회의 내용을 설명합니다','ko','one').sourceHint,'ko');
 const mixed=state.observe('오늘 회의 내용을 API EBITDA Q&A로 설명합니다','en','one');
 assert.equal(mixed.sourceHint,'ko');assert.equal(mixed.observation.state,'mixed');
 assert.equal(state.resolveHint('en'),'ko');
 assert.equal(state.observe('This is an interim rewrite','en','one').suppressSource,true);
});
test('short abbreviations do not acquire English and next committed sentence can switch',()=>{
 const state=createSentenceLanguageRouting();
 assert.equal(state.observe('API','en','one').sourceHint,null);
 assert.equal(state.observe('API 매출 설명','ko','one').sourceHint,null);
 state.complete('one');assert.equal(state.observe('This is the next sentence','en','two').sourceHint,'en');
 state.complete('two');assert.equal(state.observe('これは次の文章です','ja','three').sourceHint,'ja');
});
test('new stream and speaker boundaries reset but late old final cannot unlock the current sentence',()=>{
 const state=createSentenceLanguageRouting();state.observe('This is the old sentence','en','old');
 assert.equal(state.observe('이번에는 한국어 문장입니다','ko','new').sourceHint,'ko');
 state.complete('old');assert.equal(state.resolveHint('en'),'ko');
 state.reset();assert.equal(state.resolveHint('ja'),'ja');
});

test('real pipeline does not turn a source partial into a native translation lane mid sentence',async()=>{
 const {LiveMediaPipeline}=await import('../src/live-media-pipeline.js');const {createGeminiCaptionConfig}=await import('../../packages/caption-core/index.js');const events=[];
 const pipeline=new LiveMediaPipeline({sessionId:'sentence',mode:'meeting',languages:['ko','en','ja'],captionConfig:createGeminiCaptionConfig({languages:['ko','en','ja']}),dependencies:{publisher:{async publish(_s,_l,event){events.push(event);},async persistAuthoritativeSource(){return{sourceUtteranceId:'source',sourceSeq:1};}}}});
 pipeline.acceptPartialTranscript({text:'오늘 회의 내용을 설명합니다',sourceLanguage:'ko',segmentId:'one'});await new Promise(resolve=>setImmediate(resolve));
 pipeline.acceptPartialTranscript({text:'This is an interim rewrite',sourceLanguage:'en',segmentId:'one'});
 pipeline.acceptPartialTranslation({language:'ko',text:'한국어 번역이 원문을 바꾸면 안 됩니다',sourceLanguage:'en'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(events.filter(event=>event.type==='caption').length,1);
 await pipeline.acceptFinalUtterance({text:'오늘 회의 내용을 설명합니다',speakerLabel:'0',sourceLanguage:'ko',segmentId:'one',sourceEndedAt:new Date().toISOString(),translations:{en:{text:'This explains the meeting.'},ja:{text:'会議について説明します。'}}});
 pipeline.acceptPartialTranscript({text:'This is the next full sentence',sourceLanguage:'en',segmentId:'two'});await new Promise(resolve=>setImmediate(resolve));
 const latest=events.filter(event=>event.type==='caption'&&!event.isFinal).at(-1);assert.equal(latest.language,'en');assert.equal(latest.translationStatus,'verbatim');
 await pipeline.close();
});

for(const [sourceLanguage,targetLanguage,text,translated] of [
 ['en','ko','This is the complete English sentence.','영어 문장을 한국어로 번역했습니다.'],
 ['ko','en','한국어 문장을 영어로 번역합니다.','This is the translated Korean sentence.'],
 ['ja','ko','これは日本語の文章です。','일본어 문장을 한국어로 번역했습니다.'],
])test(`auto ${sourceLanguage} input keeps ${targetLanguage} native target despite an interim source-tag flip`,async()=>{
 const {LiveMediaPipeline}=await import('../src/live-media-pipeline.js');const {createGeminiCaptionConfig}=await import('../../packages/caption-core/index.js');const events=[],sources=[];
 const pipeline=new LiveMediaPipeline({sessionId:'direction',mode:'meeting',languages:[targetLanguage],captionConfig:createGeminiCaptionConfig({languages:[targetLanguage]}),dependencies:{publisher:{async publish(_s,_l,event){events.push(event);},async persistAuthoritativeSource(value){sources.push(value);return{sourceUtteranceId:'source',sourceSeq:1};}}}});
 pipeline.acceptPartialTranscript({text,sourceLanguage,segmentId:'one'});
 pipeline.acceptPartialTranslation({language:targetLanguage,text:translated,sourceLanguage:targetLanguage});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(events.filter(event=>event.type==='caption').at(-1)?.text,translated);
 await pipeline.acceptFinalUtterance({text,speakerLabel:'0',sourceLanguage,segmentId:'one',sourceEndedAt:new Date().toISOString(),translations:{[targetLanguage]:{text:translated}}});
 assert.equal(sources[0].sourceLanguage,sourceLanguage);assert.equal(events.find(event=>event.type==='caption'&&event.isFinal)?.text,translated);await pipeline.close();
});

test('mixed and und finals retain actual source evidence despite an earlier Korean routing lock',async()=>{
 const {LiveMediaPipeline}=await import('../src/live-media-pipeline.js');const {createGeminiCaptionConfig}=await import('../../packages/caption-core/index.js');const sources=[];
 const pipeline=new LiveMediaPipeline({sessionId:'mixed',mode:'meeting',languages:['en'],captionConfig:createGeminiCaptionConfig({languages:['en']}),dependencies:{publisher:{async publish(){},async persistAuthoritativeSource(value){sources.push(value);return{sourceUtteranceId:'source-'+sources.length,sourceSeq:sources.length};}}}});
 pipeline.acceptPartialTranscript({text:'매출에 대해 설명하겠습니다',sourceLanguage:'ko',segmentId:'one'});
 await pipeline.acceptFinalUtterance({text:'매출 revenue가 증가했습니다',speakerLabel:'0',sourceLanguage:'ko',segmentId:'one',sourceEndedAt:new Date().toISOString(),translations:{en:{text:'Revenue has increased.'}}});
 await pipeline.acceptFinalUtterance({text:'API',speakerLabel:'0',sourceLanguage:'und',segmentId:'two',sourceEndedAt:new Date().toISOString(),translations:{en:{text:'Application interface.'}}});
 assert.deepEqual(sources.map(value=>[value.sourceLanguage,value.languageObservation.state]),[['und','mixed'],['und','unknown']]);await pipeline.close();
});
