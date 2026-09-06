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

// ---------------------------------------------------------------------------
// T4 (2026-09-05): alignment by time range, dead-lane skip, transient lane
// recovery, staggered rollover, interim suppression while a final is held.
// ---------------------------------------------------------------------------

function fakeClock() {
  let now = 0;
  const timers = new Set();
  const setTimer = (fn, ms) => { const timer = { fn, at: now + Math.max(0, ms) }; timers.add(timer); return timer; };
  const clearTimer = timer => { timers.delete(timer); };
  const advance = async (ms) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers].filter(timer => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.delete(due); now = due.at; due.fn();
      await new Promise(resolve => setImmediate(resolve));
    }
    now = target;
    await new Promise(resolve => setImmediate(resolve));
  };
  return { now: () => now, setTimer, clearTimer, advance, delays: () => [...timers].map(timer => timer.at - now) };
}

function harness({ sendAudio = () => {}, open = () => {}, ...adapterOptions } = {}) {
  const clock = fakeClock();
  const lanes = [[], [], []]; const writes = [0, 0, 0]; const results = []; const partials = []; const statuses = [];
  let nextLane = 0;
  const provider = new SonioxFanoutAdapter({ translationLanguages: ['ko', 'en', 'ja'], ...clock, ...adapterOptions, createAdapter: () => {
    const lane = nextLane++;
    return { async open(callbacks) {
      const generation = lanes[lane].length;
      await open(lane, generation);
      lanes[lane].push(callbacks);
      return { supportsRolloverRemap: false, maxConnectionMilliseconds: 17_400_000,
        async sendAudio() { writes[lane]++; await sendAudio(lane, writes[lane], generation); }, async close() {} };
    } };
  } });
  const openStream = () => provider.open({
    onFinalUtterance: value => results.push(value),
    onPartialTranslation: value => partials.push(value),
    onConnectionState: value => statuses.push(value),
  });
  const frame = new Uint8Array(1280);
  return { clock, lanes, writes, results, partials, statuses, provider, openStream, frame, tick: () => new Promise(resolve => setImmediate(resolve)) };
}

test('T4: two lanes whose end boundaries differ by 400 ms and punctuation still align (spike facts)', async () => {
  const h = harness();
  const stream = await h.openStream();
  await h.lanes[0][0].onFinalUtterance({ text: '안녕하세요 여러분', sourceLanguage: 'ko', sourceStartOffsetMs: 0, sourceEndOffsetMs: 1000 });
  await h.lanes[1][0].onFinalUtterance({ text: '안녕하세요, 여러분!', sourceLanguage: 'ko', sourceStartOffsetMs: 0, sourceEndOffsetMs: 1400, translations: { en: { text: 'Hello, everyone!' } } });
  await h.lanes[2][0].onFinalUtterance({ text: '안녕하세요 여러분.', sourceLanguage: 'ko', sourceStartOffsetMs: 60, sourceEndOffsetMs: 980, translations: { ja: { text: '皆さん、こんにちは。' } } });
  await h.tick();
  assert.equal(h.results.length, 1, 'all three lanes overlapped in time with equivalent text: no hold needed');
  assert.equal(h.results[0].translations.en.text, 'Hello, everyone!');
  assert.equal(h.results[0].translations.ja.text, '皆さん、こんにちは。');
  await stream.close();
});

test('T4: a lane that never answers releases after the configurable hold with only that lane missing, on the injected clock', async () => {
  const h = harness({ alignmentHoldMs: 2_000 });
  const stream = await h.openStream();
  await h.lanes[0][0].onFinalUtterance({ text: '안녕하세요', sourceLanguage: 'ko', sourceStartOffsetMs: 0, sourceEndOffsetMs: 1000 });
  await h.lanes[2][0].onFinalUtterance({ text: '안녕하세요', sourceLanguage: 'ko', sourceStartOffsetMs: 0, sourceEndOffsetMs: 1000, translations: { ja: { text: 'こんにちは' } } });
  await h.clock.advance(1_999);
  assert.equal(h.results.length, 0, 'held while the silent lane may still answer');
  await h.clock.advance(1);
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].translations.en, undefined);
  assert.equal(h.results[0].translations.ja.text, 'こんにちは');
  await stream.close();
});

test('T4: a differing recognition at the same offsets is rejected by the normalized text tiebreak and does not hold the final', async () => {
  const h = harness();
  const stream = await h.openStream();
  const source = { text: '안녕하세요', sourceLanguage: 'ko', sourceStartOffsetMs: 0, sourceEndOffsetMs: 1000 };
  await h.lanes[0][0].onFinalUtterance(source);
  await h.lanes[1][0].onFinalUtterance({ ...source, text: '잘 가세요', translations: { en: { text: 'Goodbye' } } });
  await h.lanes[2][0].onFinalUtterance({ ...source, translations: { ja: { text: 'こんにちは' } } });
  await h.tick();
  assert.equal(h.results.length, 1, 'a lane whose recognition already covers the source range is resolved, not awaited');
  assert.equal(h.results[0].translations.en, undefined);
  assert.equal(h.results[0].translations.ja.text, 'こんにちは');
  await stream.close();
});

test('T4: STT_AUDIO_BACKPRESSURE drops the frame and keeps the lane; it is never a lane failure', async () => {
  const h = harness({ sendAudio: (lane, count) => { if (lane === 1 && count === 1) throw new Error('STT_AUDIO_BACKPRESSURE'); } });
  const stream = await h.openStream();
  await stream.sendAudio(h.frame); await stream.sendAudio(h.frame); await stream.sendAudio(h.frame);
  assert.deepEqual(h.writes, [3, 3, 3], 'the lane keeps receiving frames after a backpressure rejection');
  assert.deepEqual(stream.droppedFrames, [0, 1, 0]);
  assert.equal(h.statuses.filter(status => status.status === 'failed').length, 0);
  assert.deepEqual(h.lanes.map(lane => lane.length), [1, 1, 1], 'no reopen for backpressure');
  await stream.close();
});

test('T4: a transient lane error reopens that lane with backoff and keeps its offsets on the session timeline', async () => {
  const h = harness({ sendAudio: (lane, count, generation) => { if (lane === 1 && generation === 0 && count === 3) throw new Error('SONIOX_UNAVAILABLE'); }, laneReopenBackoffMs: 500 });
  const stream = await h.openStream();
  for (let index = 0; index < 3; index++) await stream.sendAudio(h.frame);
  assert.deepEqual(h.lanes.map(lane => lane.length), [1, 1, 1], 'reopen waits for the backoff timer');
  assert.ok(h.statuses.some(status => status.language === 'en' && status.code === 'SONIOX_TRANSLATION_RECOVERING'));
  await stream.sendAudio(h.frame); // frame 4: dropped for the recovering lane, delivered to the others
  assert.deepEqual(h.writes, [4, 3, 4]);
  await h.clock.advance(500);
  assert.deepEqual(h.lanes.map(lane => lane.length), [1, 2, 1], 'the lane was reopened once the backoff elapsed');
  await stream.sendAudio(h.frame); // frame 5 reaches the reopened lane
  assert.deepEqual(h.writes, [5, 4, 5]);
  // The reopened lane's stream clock restarts at 0; four frames (160 ms) of
  // session audio had passed before it accepted its first frame.
  await h.lanes[0][0].onFinalUtterance({ text: '안녕하세요', sourceLanguage: 'ko', sourceStartOffsetMs: 200, sourceEndOffsetMs: 1200 });
  await h.lanes[1][1].onFinalUtterance({ text: '안녕하세요', sourceLanguage: 'ko', sourceStartOffsetMs: 40, sourceEndOffsetMs: 1040, translations: { en: { text: 'Hello' } } });
  await h.lanes[2][0].onFinalUtterance({ text: '안녕하세요', sourceLanguage: 'ko', sourceStartOffsetMs: 200, sourceEndOffsetMs: 1200, translations: { ja: { text: 'こんにちは' } } });
  await h.tick();
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].translations.en.text, 'Hello');
  assert.ok(h.statuses.some(status => status.language === 'en' && status.status === 'ready'));
  await stream.close();
});

test('T4: three consecutive failed reopen attempts mark the lane failed, and finals then publish without the 3 s hold', async () => {
  const h = harness({ sendAudio: lane => { if (lane === 1) throw new Error('SONIOX_UNAVAILABLE'); }, laneReopenBackoffMs: 100 });
  const stream = await h.openStream();
  await stream.sendAudio(h.frame);           // attempt 1 fails
  await h.clock.advance(100); await stream.sendAudio(h.frame); // attempt 2 fails (reopened stream)
  await h.clock.advance(200); await stream.sendAudio(h.frame); // attempt 3 fails -> lane failed
  await h.clock.advance(10_000);
  assert.deepEqual(h.lanes.map(lane => lane.length), [1, 3, 1], 'no further reopen after the third consecutive failure');
  assert.ok(h.statuses.some(status => status.language === 'en' && status.code === 'SONIOX_TRANSLATION_UNAVAILABLE'));
  const before = h.clock.now();
  await h.lanes[0][0].onFinalUtterance({ text: '안녕하세요', sourceLanguage: 'ko', sourceStartOffsetMs: 0, sourceEndOffsetMs: 1000 });
  await h.lanes[2][0].onFinalUtterance({ text: '안녕하세요', sourceLanguage: 'ko', sourceStartOffsetMs: 0, sourceEndOffsetMs: 1000, translations: { ja: { text: 'こんにちは' } } });
  await h.tick();
  assert.equal(h.results.length, 1, 'a dead lane is not awaited');
  assert.equal(h.clock.now() - before, 0, 'hold time with one dead lane is 0 ms (was the full 3 000 ms)');
  assert.equal(h.results[0].translations.en, undefined);
  assert.equal(h.results[0].translations.ja.text, 'こんにちは');
  await stream.sendAudio(h.frame);
  assert.equal(h.writes[0], 4); assert.equal(h.writes[2], 4);
  await stream.close();
});

test('T4: lane rollovers are staggered by 60 s per lane so three lanes never roll at the same instant', async () => {
  const h = harness();
  const stream = await h.openStream();
  const rollovers = h.clock.delays().filter(delay => delay >= 1_000_000).sort((a, b) => b - a);
  assert.deepEqual(rollovers, [17_370_000, 17_310_000, 17_250_000]);
  await stream.close();
});

test('T4: while a final is held, a secondary lane\'s partial translation for a later segment is deferred until release', async () => {
  const h = harness({ alignmentHoldMs: 3_000 });
  const stream = await h.openStream();
  await h.lanes[1][0].onPartialTranslation({ language: 'en', text: 'Hel', sourceLanguage: 'ko', segmentId: 'b1' });
  assert.equal(h.partials.length, 1, 'nothing held: partials pass through');
  await h.lanes[0][0].onFinalUtterance({ text: '안녕하세요', sourceLanguage: 'ko', sourceStartOffsetMs: 0, sourceEndOffsetMs: 1000, segmentId: 'a1' });
  await h.lanes[1][0].onFinalUtterance({ text: '안녕하세요', sourceLanguage: 'ko', sourceStartOffsetMs: 0, sourceEndOffsetMs: 1000, segmentId: 'b1', translations: { en: { text: 'Hello' } } });
  // ja lane is slow: the final is now held. The en lane moves on to the next segment.
  await h.lanes[1][0].onPartialTranslation({ language: 'en', text: 'How', sourceLanguage: 'ko', segmentId: 'b2' });
  await h.lanes[1][0].onPartialTranslation({ language: 'en', text: 'How are', sourceLanguage: 'ko', segmentId: 'b2' });
  assert.equal(h.partials.length, 1, 'a later-segment interim must not flash over the held final');
  await h.clock.advance(3_000);
  assert.equal(h.results.length, 1);
  assert.deepEqual(h.partials.slice(1).map(partial => partial.text), ['How are'], 'the latest deferred interim is released with the final');
  await stream.close();
});
