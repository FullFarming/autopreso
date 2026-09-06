import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createSubtitleRealtimeManager } from '../src/subtitle-realtime.js';
import { createSttTransport } from '../src/caption-engine/create-stt-transport.js';
const engine = { stt: { provider: 'soniox', model: 'stt-rt-v5', languageMode: 'auto' }, translation: { provider: 'soniox', model: 'stt-rt-v5' }, summary: { provider: 'gemini', model: 'gemini-3.6-flash' } };
class Socket extends EventEmitter {
  readyState = 0; sent = []; bufferedAmount = 0;
  send(data) { this.sent.push(data); }
  open() { this.readyState = 1; this.emit('open'); }
  close() { this.readyState = 3; this.emit('close', 1000); }
  terminate() { this.close(); }
}
test('three native Soniox targets stream the same audio without Flash and stop together', async () => {
  const sockets = []; const events = []; let paidTranslations = 0;
  const manager = createSubtitleRealtimeManager({ env: { SONIOX_API_KEY: 'fixture' }, broadcast: (e) => events.push(e), polish: () => { paidTranslations += 1; }, createWebSocket: () => { const s = new Socket(); sockets.push(s); return s; } });
  try {
    await manager.start({ sessionId: 'three', settings: { engine, inputMode: 'mic', translationLanguages: ['ko', 'en', 'ja'] } });
    assert.equal(sockets.length, 3);
    sockets.forEach((s) => s.open());
    assert.deepEqual(sockets.map((s) => JSON.parse(s.sent[0]).translation), ['ko','en','ja'].map((target_language) => ({ type: 'one_way', target_language })));
    manager.sendAudio({sessionId: 'three', source: 'mic', audio: Buffer.alloc(4800).toString('base64')});
    assert.ok(sockets.every((s) => s.sent.some(Buffer.isBuffer)));
    sockets.forEach((s) => s.emit('message', JSON.stringify({tokens:[{text:'안녕하세요',language:'ko',is_final:true},{text:'<end>',is_final:true}]})));
    await new Promise((r) => setImmediate(r));
    assert.equal(paidTranslations, 0);
    assert.equal(events.filter((e)=>e.type === "subtitle:committed" && e.targetLanguage === "ko" && e.isSourceCaption).length, 1);
  } finally { manager.close(); }
  assert.ok(sockets.every((s) => s.readyState === 3));
});
test('Gemini automatic recognition does not mistake output languages for input hints', () => {
  const gemini = { stt: {provider:'gemini', model:'gemini-3.5-transcribe-live', languageMode:'auto'}, translation:{provider:'gemini',model:'gemini-3.6-flash'},summary:{provider:'gemini',model:'gemini-3.6-flash'} };
  const transport = createSttTransport({ engine: gemini, settings:{translationLanguages:['en','ja']}, apiKeys:{gemini:'fixture'} });
  assert.deepEqual(JSON.parse(transport.setupPayloads()[0]).setup.inputAudioTranscription.languageCodes, []);
});

test('recovery keeps the session engine and glossary snapshot, and host stop cancels pending retry', async () => {
  const sockets=[]; let saved = {apiKeys:{soniox:'fixture'},subtitle:{engine,translationLanguages:['ko','en'],glossary:'NOVA'}};
  const manager=createSubtitleRealtimeManager({settingsStore:{load:async()=>saved}, createWebSocket:()=>{const s=new Socket();sockets.push(s);return s;},broadcast:()=>{},polish:()=>{throw new Error('Unexpected Flash');}});
  await manager.start({sessionId:'pin',settings:{inputMode:'mic'}});
  sockets[0].open();
  saved={...saved,subtitle:{...saved.subtitle,engine:{...engine,stt:{provider:'gemini',model:'gemini-3.5-transcribe-live',languageMode:'auto'},translation:{provider:'gemini',model:'gemini-3.6-flash'}},glossary:'changed'}};
  const recovery=manager.restartChannels();
  await new Promise((r)=>setImmediate(r));
  sockets[1].open(); await recovery;
  assert.equal(manager._state.settings.engine.stt.provider,'soniox');
  assert.equal(manager._state.settings.glossary,'NOVA');
  sockets[1].close(); manager.close();
  await new Promise((r)=>setTimeout(r,15));
  assert.equal(sockets.length,2);
});

test('managed captions require no local keys and renew pinned ticket before reconnect', async()=>{
  const sockets=[];const issued=[];let renewals=0;
  const session={ticket:'old',sessionId:'broker-session',engine,expiresAt:new Date(Date.now()+1000).toISOString()};
  const manager=createSubtitleRealtimeManager({env:{},broadcast:()=>{},
    stopCaptionSession:async()=>({stopped:true}),
    createCaptionCredential:async(value,provider)=>{issued.push([value.ticket,provider]);return {apiKey:'temporary'};},
    renewCaptionSession:async(value)=>{renewals++;return {...value,ticket:'renewed',expiresAt:new Date(Date.now()+3600000).toISOString()};},
    translateCaption:async()=>{throw new Error('Soniox must not invoke Flash');},
    createWebSocket:()=>{const s=new Socket();sockets.push(s);return s;},
  });
  try{
    await manager.start({sessionId:'managed',settings:{engine,inputMode:'mic',translationLanguages:['ko','en']},managedSession:session});
    await new Promise(r=>setImmediate(r));sockets[0].open();
    assert.equal(renewals,1);assert.deepEqual(issued,[['renewed','soniox']]);
    assert.equal(JSON.parse(sockets[0].sent[0]).api_key,'temporary');
    sockets[0].close();await new Promise(r=>setTimeout(r,15));
    assert.equal(sockets.length,2);assert.equal(issued.length,2);
    assert.equal(manager._state.settings.engine.stt.provider,'soniox');
  }finally{manager.close();}
});

test('managed Gemini sends ephemeral token and translates using the pinned broker session only',async()=>{
  const gemini={stt:{provider:'gemini',model:'gemini-3.5-transcribe-live',languageMode:'auto'},translation:{provider:'gemini',model:'gemini-3.6-flash'},summary:{provider:'gemini',model:'gemini-3.6-flash'}};
  const managedSession={ticket:'fixture-ticket',sessionId:'broker-gemini',engine:gemini,expiresAt:new Date(Date.now()+3600000).toISOString()};
  const requests=[];const sockets=[];const urls=[];const events=[];const stops=[];
  const manager=createSubtitleRealtimeManager({env:{},broadcast:e=>events.push(e),
    createCaptionCredential:async()=>({apiKey:'fixture-ephemeral'}),renewCaptionSession:async(value)=>value,
    stopCaptionSession:async(value)=>{stops.push(value.sessionId);},
    translateCaption:async(value,input)=>{requests.push([value.sessionId,input.targetLanguage]);return '안녕하세요 여러분';},
    polish:()=>{throw new Error('Local paid translator must not be called');},
    createWebSocket:(url)=>{urls.push(url);const s=new Socket();sockets.push(s);return s;},
  });
  await manager.start({sessionId:'gemini-managed',settings:{engine:gemini,inputMode:'mic',translationLanguages:['en','ko']},managedSession});
  await new Promise(r=>setImmediate(r));sockets[0].open();
  assert.ok(new URL(urls[0]).pathname.endsWith('BidiGenerateContentConstrained'));
  assert.equal(new URL(urls[0]).searchParams.get('key'),null);assert.equal(new URL(urls[0]).searchParams.get('access_token'),'fixture-ephemeral');
  sockets[0].emit('message',JSON.stringify({setupComplete:{}}));
  sockets[0].emit('message',JSON.stringify({serverContent:{inputTranscription:{text:'Hello everyone',languageCode:'en'}}}));
  await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(requests,[['broker-gemini','ko']]);
  assert.ok(events.some(e=>e.type==='subtitle:committed'&&e.targetLanguage==='ko'&&e.translatedText==='안녕하세요 여러분'));
  await manager.stop();assert.deepEqual(stops,['broker-gemini']);
});

test('quiet Soniox renews its broker ticket before six hours despite nine-minute connection cadence',async()=>{
  let timestamp=Date.now();const initial=timestamp;let renewals=0;const sockets=[];
  const managedSession={ticket:'original',sessionId:'long-broker',engine,expiresAt:new Date(timestamp+6*3600000).toISOString()};
  const manager=createSubtitleRealtimeManager({env:{},now:()=>timestamp,broadcast:()=>{},
    createCaptionCredential:async(value)=>{assert.ok(Date.parse(value.expiresAt)>timestamp);return {apiKey:'ephemeral'};},
    renewCaptionSession:async(value)=>{assert.ok(Date.parse(value.expiresAt)>timestamp);renewals++;return {...value,ticket:'renewed',expiresAt:new Date(timestamp+6*3600000).toISOString()};},
    stopCaptionSession:async()=>{},translateCaption:async()=>{throw new Error('Quiet Soniox must not translate');},
    createWebSocket:()=>{const s=new Socket();sockets.push(s);return s;},
  });
  try{
    await manager.start({sessionId:'quiet-long',settings:{engine,inputMode:'mic',translationLanguages:['ko','en']},managedSession});
    await new Promise(r=>setImmediate(r));sockets[0].open();
    for(let minutes=9;minutes<=369;minutes+=9){
      timestamp=initial+minutes*60000;sockets.at(-1).close();
      await new Promise(r=>setTimeout(r,3));sockets.at(-1).open();
    }
    assert.equal(renewals,1);assert.equal(sockets.length,42);assert.equal(manager._state.active,true);
  }finally{await manager.stop();}
});
