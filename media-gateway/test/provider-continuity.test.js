import test from 'node:test';
import assert from 'node:assert/strict';
import { RollingSpeechSession } from '../src/rolling-speech-session.js';

test('silent session rolls once for simultaneous timer/provider notices and stops on host close', async () => {
  const timers = new Map(); let nextId = 0; const opens = [];
  const session = new RollingSpeechSession({
    provider: { async open(callbacks) { opens.push(callbacks); return { supportsRolloverRemap: false, async sendAudio() {}, async close() {} }; } },
    onFinalUtterance() {}, onRemap() {},
    setTimer(callback) { const id = ++nextId; timers.set(id, callback); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  await session.start();
  assert.equal(timers.size, 1);
  const timer = [...timers.values()][0]; timer();
  opens[0].onReconnectRequired(new Error('STT_CONNECTION_ROLLOVER_REQUIRED'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opens.length, 2);
  await session.close();
  timer(); opens[1].onReconnectRequired(new Error('STT_PROVIDER_CLOSED'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opens.length, 2);
  assert.equal(timers.size, 0);
});

test('unexpected provider closure replaces failed stream while preserving future source and writes', async () => {
  const callbacks = []; const finals = []; let writes = 0;
  const session = new RollingSpeechSession({
    provider: { async open(options) { const first = callbacks.length === 0; callbacks.push(options); return {
      supportsRolloverRemap: false, async sendAudio() { writes++; }, async close() {},
      assertDrained() { if (first) throw new Error('STT_PROVIDER_CLOSED'); },
    }; } }, onFinalUtterance: value => finals.push(value), onRemap() {},
  });
  await session.start(); callbacks[0].onReconnectRequired(new Error('STT_PROVIDER_CLOSED'));
  await new Promise(resolve => setImmediate(resolve));
  await session.sendAudio(new Uint8Array(1280));
  await callbacks[1].onFinalUtterance({ text: 'continued', sourceStartOffsetMs: 0, sourceEndOffsetMs: 40 });
  await session.close();
  assert.equal(callbacks.length, 2); assert.equal(writes, 1); assert.equal(finals[0].text, 'continued');
});

test('Gemini goAway renews the real transcription adapter once and preserves session audio time', async () => {
  const { GeminiLiveTranscriptionAdapter } = await import('../src/google-provider-adapters.js');
  const connections = []; const finals = [];
  const adapter = new GeminiLiveTranscriptionAdapter({ finalDrainMilliseconds: 1, client: { live: { async connect(options) {
    connections.push(options); return { sendRealtimeInput() {}, close() {} };
  } } } });
  const session = new RollingSpeechSession({ provider: adapter, onFinalUtterance: value => finals.push(value), onRemap() {} });
  await session.start(); await session.sendAudio(new Uint8Array(1280));
  connections[0].callbacks.onmessage({ goAway: { timeLeft: '10s' } });
  connections[0].callbacks.onmessage({ goAway: { timeLeft: '9s' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connections.length, 2);
  await session.sendAudio(new Uint8Array(1280));
  connections[1].callbacks.onmessage({ serverContent: { inputTranscription: { text: 'next', languageCode: 'en' } } });
  await session.close();
  assert.equal(finals.length, 1); assert.equal(finals[0].sourceSessionStartOffsetMs, 40);
  connections[1].callbacks.onmessage({ goAway: { timeLeft: '0s' } });
  assert.equal(connections.length, 2);
});

test('speaker boundary fences onsetless callbacks to their captured generation', async () => {
 const opens=[];const finals=[];
 const session=new RollingSpeechSession({provider:{async open(options){opens.push(options);return {supportsRolloverRemap:false,async sendAudio(){},async close(){}};}},onFinalUtterance:value=>finals.push(value),onRemap(){}});
 await session.start();await session.sendAudio(new Uint8Array(1280));
 await session.rotateAtSpeakerBoundary(); await session.sendAudio(new Uint8Array(1280));
 await opens[1].onFinalUtterance({text:'B'});
 assert.equal(finals[0].sourceGenerationStartOffsetMs,40);
 await session.close();
});
test('host stop while a speaker rotation waits for old drain cannot open another provider',async()=>{
 let opens=0;let releaseOld;
 const session=new RollingSpeechSession({provider:{async open(){const index=opens++;return{supportsRolloverRemap:false,async sendAudio(){},async close(){if(index===0)await new Promise(resolve=>{releaseOld=resolve;});}};}},onFinalUtterance(){},onRemap(){}});
 await session.start();await session.sendAudio(new Uint8Array(1280));await session.rotateAtSpeakerBoundary();
 const rotation=session.rotateAtSpeakerBoundary();const refused=assert.rejects(rotation,/STT_STREAM_CLOSED/);await new Promise(resolve=>setImmediate(resolve));
 const closed=session.close();releaseOld();await Promise.all([refused,closed]);assert.equal(opens,2);
});
