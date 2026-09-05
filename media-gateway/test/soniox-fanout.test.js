import test from 'node:test';
import assert from 'node:assert/strict';
import { SonioxFanoutAdapter } from '../src/engines/soniox-fanout-adapter.js';

test('three native lanes commit one source with aligned translations; repeated text is not deduplicated', async () => {
  const callbacks = []; const results = []; let writes = 0;
  const provider = new SonioxFanoutAdapter({ translationLanguages: ['ko','en','ja'], createAdapter: () => ({ async open(options) { callbacks.push(options); return { async sendAudio() { writes++; }, async close() {} }; } }) });
  const stream = await provider.open({ onFinalUtterance: value => results.push(value) });
  await stream.sendAudio(new Uint8Array(1280)); assert.equal(writes, 3);
  for (let index = 0; index < 2; index++) {
    const source = { text: '안녕하세요', sourceLanguage: 'ko', sourceStartOffsetMs: index * 1000, sourceEndOffsetMs: (index + 1) * 1000 };
    await callbacks[2].onFinalUtterance({ ...source, translations: { ja: { text: 'こんにちは' } } });
    await callbacks[0].onFinalUtterance({ ...source, translations: {} });
    await callbacks[1].onFinalUtterance({ ...source, translations: { en: { text: 'Hello' } } });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(results.length, 2); assert.equal(results[0].translations.en.text, 'Hello'); assert.equal(results[0].translations.ja.text, 'こんにちは');
  await stream.close();
});

test('a secondary connection expiry replaces only that target and host close prevents late replacement', async () => {
  const lanes = [[], [], []]; let nextLane = 0;
  const provider = new SonioxFanoutAdapter({ translationLanguages: ['ko','en','ja'], createAdapter: () => {
    const lane = nextLane++;
    return { async open(callbacks) {
      lanes[lane].push(callbacks);
      return { supportsRolloverRemap: false, async sendAudio() {}, async close() {} };
    } };
  } });
  const stream = await provider.open({ onFinalUtterance() {} });
  lanes[1][0].onReconnectRequired(new Error('SONIOX_MAX_DURATION'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lanes.map(lane => lane.length), [1, 2, 1]);
  await stream.close();
  lanes[1][1].onReconnectRequired(new Error('SONIOX_MAX_DURATION'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lanes.map(lane => lane.length), [1, 2, 1]);
});

test('one permanently failed secondary leaves primary and other language accepting audio', async () => {
  let nextLane = 0; const writes = [0, 0, 0]; const callbacks = []; const results = [];
  const provider = new SonioxFanoutAdapter({ translationLanguages: ['ko','en','ja'], createAdapter: () => {
    const lane = nextLane++;
    return { async open(options) {
      callbacks[lane] = options;
      return { supportsRolloverRemap: false, async sendAudio() {
        writes[lane]++;
        if (lane === 1) throw new Error('SONIOX_UNAUTHENTICATED');
      }, async close() {} };
    } };
  } });
  const stream = await provider.open({ onFinalUtterance: value => results.push(value) });
  await stream.sendAudio(new Uint8Array(1280)); await stream.sendAudio(new Uint8Array(1280));
  assert.deepEqual(writes, [2, 1, 2]);
  const source = { text: '안녕하세요', sourceLanguage: 'ko', sourceStartOffsetMs: 0, sourceEndOffsetMs: 80 };
  await callbacks[0].onFinalUtterance(source);
  await callbacks[2].onFinalUtterance({ ...source, translations: { ja: { text: 'こんにちは' } } });
  await stream.close();
  assert.equal(results.length, 1); assert.equal(results[0].translations.en, undefined); assert.equal(results[0].translations.ja.text, 'こんにちは');
});

test('secondary segmentation drift joins contiguous translations only when complete source text and range agree', async () => {
  const callbacks = []; const results = [];
  const adapter = new SonioxFanoutAdapter({ translationLanguages: ['ko','en','ja'], createAdapter: () => ({ async open(options) {
    callbacks.push(options); return { supportsRolloverRemap: false, async sendAudio() {}, async close() {} };
  } }) });
  const stream = await adapter.open({ onFinalUtterance: value => results.push(value) });
  await callbacks[0].onFinalUtterance({ text: '안녕하세요 여러분', sourceLanguage: 'ko', sourceStartOffsetMs: 0, sourceEndOffsetMs: 1000 });
  await callbacks[1].onFinalUtterance({ text: '안녕하세요', sourceLanguage: 'ko', sourceStartOffsetMs: 0, sourceEndOffsetMs: 400, translations: { en: { text: 'Hello' } } });
  await callbacks[1].onFinalUtterance({ text: '여러분', sourceLanguage: 'ko', sourceStartOffsetMs: 400, sourceEndOffsetMs: 1000, translations: { en: { text: 'everyone' } } });
  await callbacks[2].onFinalUtterance({ text: '안녕하세요 여러분', sourceLanguage: 'ko', sourceStartOffsetMs: 0, sourceEndOffsetMs: 1000, translations: { ja: { text: '皆さんこんにちは' } } });
  await stream.close();
  assert.equal(results.length, 1); assert.equal(results[0].text, '안녕하세요 여러분');
  assert.equal(results[0].translations.en.text, 'Hello everyone');
  assert.equal(results[0].translations.ja.text, '皆さんこんにちは');
});

test('a differing secondary recognition is never attached to the primary source', async () => {
  const callbacks = []; const results = [];
  const adapter = new SonioxFanoutAdapter({ translationLanguages: ['ko','en','ja'], createAdapter: () => ({ async open(options) {
    callbacks.push(options); return { supportsRolloverRemap: false, async sendAudio() {}, async close() {} };
  } }) });
  const stream = await adapter.open({ onFinalUtterance: value => results.push(value) });
  const source = { text: '안녕하세요', sourceLanguage: 'ko', sourceStartOffsetMs: 0, sourceEndOffsetMs: 1000 };
  await callbacks[0].onFinalUtterance(source);
  await callbacks[1].onFinalUtterance({ ...source, text: '잘 가세요', translations: { en: { text: 'Goodbye' } } });
  await callbacks[2].onFinalUtterance({ ...source, translations: { ja: { text: 'こんにちは' } } });
  await stream.close();
  assert.equal(results.length, 1); assert.equal(results[0].translations.en, undefined);
  assert.equal(results[0].translations.ja.text, 'こんにちは');
});

test('secondary recognition loss reports only its translation lane, never a false authoritative-source gap', async () => {
  const callbacks = []; const statuses = []; const gaps = [];
  const adapter = new SonioxFanoutAdapter({ translationLanguages: ['ko','en','ja'], createAdapter: () => ({ async open(options) {
    callbacks.push(options); return { supportsRolloverRemap: false, async sendAudio() {}, async close() {} };
  } }) });
  const stream = await adapter.open({ onFinalUtterance() {}, onContinuityDiscard: value => gaps.push(value), onConnectionState: value => statuses.push(value) });
  callbacks[1].onContinuityDiscard({ reason: 'SONIOX_MAX_DURATION' });
  assert.equal(gaps.length, 0); assert.equal(statuses[0].language, 'en');
  callbacks[0].onContinuityDiscard({ reason: 'SONIOX_MAX_DURATION' });
  assert.equal(gaps.length, 1);
  await stream.close();
});
