import assert from "node:assert/strict";
import test from "node:test";

import { estimateAcousticRange } from "../src/acoustic-range.js";
import { RollingSpeechSession } from "../src/rolling-speech-session.js";

test("close keeps caller cancellation connected while an accepted provider write is stalled", async () => {
  let aborts = 0;
  let closes = 0;
  let rejectWrite;
  const controller = new AbortController();
  const session = new RollingSpeechSession({ provider: { async open() { return {
    sendAudio() { return new Promise((_, reject) => { rejectWrite = reject; }); },
    abort() { aborts += 1; rejectWrite(new Error("STT_DRAIN_ABORTED")); },
    close() { closes += 1; },
  }; } }, onFinalUtterance() {}, onRemap() {} });
  await session.start({ signal: controller.signal });
  const writing = session.sendAudio(new Uint8Array(1280));
  const rejected = assert.rejects(writing, /STT_DRAIN_ABORTED/);
  await new Promise((resolve) => setImmediate(resolve));
  const closing = session.close();
  controller.abort();
  assert.equal(aborts, 1);
  await rejected;
  await closing;
  assert.equal(closes, 1);
});

test("close aborts and closes a stalled provider within five seconds without reopening", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let aborts = 0;
  let closes = 0;
  let opens = 0;
  let release;
  const session = new RollingSpeechSession({ provider: { async open() { opens += 1; return {
    sendAudio() { return new Promise((resolve) => { release = resolve; }); },
    abort() { aborts += 1; },
    close() { closes += 1; return new Promise(() => {}); },
  }; } }, onFinalUtterance() {}, onRemap() {} });
  await session.start();
  const writing = session.sendAudio(new Uint8Array(1280));
  await new Promise((resolve) => setImmediate(resolve));
  const closing = session.close();
  context.mock.timers.tick(5000);
  await closing;
  assert.equal(aborts, 1);
  assert.equal(closes, 1);
  assert.equal(opens, 1);
  await assert.rejects(session.gracefulDrain(), /STT_DRAIN_TIMEOUT/);
  release();
  await writing;
});

function overlapWords(label) {
  return [{ word: "hello", startMs: 100, endMs: 600, speakerLabel: label }];
}

test("async finalized-utterance failures become a fail-closed stream error", async () => {
  let emitFinalUtterance;
  let aborts = 0;
  const session = new RollingSpeechSession({
    provider: {
      async open({ onFinalUtterance }) {
        emitFinalUtterance = onFinalUtterance;
        return { async sendAudio() {}, async close() {}, abort() { aborts += 1; } };
      },
    },
    async onFinalUtterance() {
      throw new Error("QUEUE_LATENCY_EXCEEDED");
    },
    onRemap() {},
  });
  await session.start();
  await emitFinalUtterance({ speakerLabel: "A", text: "late" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborts, 1, "callback failure must stop billing even if no more audio arrives");
  await assert.rejects(() => session.sendAudio(new Uint8Array(1_280)), /QUEUE_LATENCY_EXCEEDED/);
});

test("a failed retired-stream drain stops the replacement rather than hiding missing finals", async () => {
  let now = 0;
  let opens = 0;
  let aborts = 0;
  const session = new RollingSpeechSession({ now: () => now, onFinalUtterance() {}, onRemap() {},
    provider: { async open() { const index = opens++; return {
      supportsRolloverRemap: false, async sendAudio() {}, async close() {},
      assertDrained() { if (index === 0) throw new Error("STT_DRAIN_TIMEOUT"); },
      abort() { aborts += 1; },
    }; } } });
  await session.start();
  now = 550_000;
  await session.sendAudio(new Uint8Array(1_280));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborts, 1);
  await assert.rejects(session.sendAudio(new Uint8Array(1_280)), /STT_DRAIN_TIMEOUT/);
  await assert.rejects(session.gracefulDrain(), /STT_DRAIN_TIMEOUT/);
  assert.equal(opens, 2);
});

test("stalled retiring providers cannot accumulate across planned rollovers", async () => {
  let now = 0;
  let opens = 0;
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  const session = new RollingSpeechSession({ now: () => now, onFinalUtterance() {}, onRemap() {},
    provider: { async open() { const index = opens++; return {
      supportsRolloverRemap: false, async sendAudio() {}, close() { return index === 0 ? stalled : Promise.resolve(); },
      abort() {},
    }; } } });
  await session.start();
  now = 550_000;
  await session.sendAudio(new Uint8Array(1_280));
  now = 1_100_000;
  await assert.rejects(session.sendAudio(new Uint8Array(1_280)), /STT_DRAIN_BACKPRESSURE/);
  assert.equal(opens, 2);
  release();
  await session.close();
});

test("finalized utterances enter downstream queues without waiting for earlier TTS completion", async () => {
  let emitFinalUtterance;
  let releaseFirst;
  const started = [];
  const session = new RollingSpeechSession({
    provider: {
      async open({ onFinalUtterance }) {
        emitFinalUtterance = onFinalUtterance;
        return { async sendAudio() {}, async close() {} };
      },
    },
    async onFinalUtterance(utterance) {
      started.push(utterance.text);
      if (utterance.text === "one") await new Promise((resolve) => { releaseFirst = resolve; });
    },
    onRemap() {},
  });
  await session.start();
  await emitFinalUtterance({ speakerLabel: "A", text: "one" });
  await emitFinalUtterance({ speakerLabel: "A", text: "two" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["one", "two"]);
  releaseFirst();
  await session.close();
});

test("rollover uses replayed audio for speaker mapping without duplicating its utterance", async () => {
  let now = 0;
  const streams = [];
  const emitted = [];
  const session = new RollingSpeechSession({
    now: () => now,
    provider: {
      async open({ generation, onFinalUtterance }) {
        const isRollover = streams.length > 0;
        let sent = 0;
        const stream = {
          generation,
          closed: 0,
          async sendAudio() {
            sent += 1;
            if (isRollover && sent === 1) {
              await onFinalUtterance({ speakerLabel: "next-A", text: "hello", sourceEndOffsetMs: 600 });
            }
          },
          async getFinalWords() { return isRollover ? overlapWords("next-A") : overlapWords("old-A"); },
          async waitForFinalWords() { return overlapWords("next-A"); },
          async close() { this.closed += 1; },
          onFinalUtterance,
        };
        streams.push(stream);
        return stream;
      },
    },
    async onFinalUtterance(utterance) { emitted.push(utterance.text); },
    onRemap(mapping) { assert.equal(mapping.get("next-A"), "old-A"); },
  });
  await session.start();
  await session.sendAudio(new Uint8Array(1_280));
  now = 550_000;
  await session.sendAudio(new Uint8Array(1_280));
  assert.deepEqual(emitted, []);
  await streams[1].onFinalUtterance({ speakerLabel: "next-A", text: "new words", sourceEndOffsetMs: 2_800 });
  assert.deepEqual(emitted, ["new words"]);
  assert.equal(streams[0].closed, 1);
});

test("transcribe-only rollover routes new audio once and drains the old tail in background", async () => {
  let now = 0;
  const streams = [];
  const emitted = [];
  const remaps = [];
  let releaseOldDrain;
  const session = new RollingSpeechSession({
    now: () => now,
    provider: {
      async open({ onFinalUtterance }) {
        const streamIndex = streams.length;
        const stream = {
          closed: 0,
          sent: 0,
          supportsRolloverRemap: false,
          async sendAudio() { this.sent += 1; },
          async getFinalWords() { return []; },
          async waitForFinalWords() { return []; },
          async close() {
            this.closed += 1;
            if (streamIndex !== 0) return;
            await onFinalUtterance({
              speakerLabel: "1",
              text: "old stream tail",
              sourceStartOffsetMs: 0,
              sourceEndOffsetMs: 40,
            });
            await new Promise((resolve) => { releaseOldDrain = resolve; });
          },
          onFinalUtterance,
        };
        streams.push(stream);
        return stream;
      },
    },
    async onFinalUtterance(utterance) { emitted.push(utterance.text); },
    onRemap(mapping) { remaps.push(mapping); },
  });

  await session.start();
  await session.sendAudio(new Uint8Array(1_280));
  now = 550_000;
  await session.sendAudio(new Uint8Array(1_280));

  assert.equal(streams.length, 2);
  assert.equal(streams[0].sent, 1, "the old stream receives no overlap replay");
  assert.equal(streams[1].sent, 1, "the rollover-triggering frame is routed once to the new stream");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(emitted, ["old stream tail"]);
  assert.deepEqual(remaps, []);
  assert.equal(streams[0].closed, 1);
  await streams[1].onFinalUtterance({ speakerLabel: "1", text: "fresh words", sourceEndOffsetMs: 2_800 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(emitted, ["old stream tail", "fresh words"]);
  releaseOldDrain();
  await session.close();
});

test("final speaker labels receive only their bounded PCM utterance windows", async () => {
  let emitFinalUtterance;
  const windows = [];
  const session = new RollingSpeechSession({
    provider: {
      async open({ onFinalUtterance }) {
        emitFinalUtterance = onFinalUtterance;
        return { async sendAudio() {}, async close() {} };
      },
    },
    capturePcmWindows: true,
    async onFinalUtterance(utterance) { windows.push({ label: utterance.speakerLabel, pcm: utterance.pcmWindow?.slice() ?? null }); },
    onRemap() {},
    now: () => 0,
  });
  await session.start();
  for (let index = 0; index < 13; index += 1) await session.sendAudio(sineFrame(110, index));
  for (let index = 13; index < 25; index += 1) await session.sendAudio(sineFrame(290, index));
  await emitFinalUtterance({ speakerLabel: "A", text: "low", sourceStartOffsetMs: 0, sourceEndOffsetMs: 500 });
  await emitFinalUtterance({ speakerLabel: "B", text: "high", sourceStartOffsetMs: 500, sourceEndOffsetMs: 1_000 });

  assert.deepEqual(windows.map(({ label, pcm }) => [label, estimateAcousticRange(pcm).range]), [["A", "low"], ["B", "high"]]);
  assert.equal(windows.every(({ pcm }) => pcm.byteLength === 16_000), true);
  await session.close();
});

test("a finalized window delayed beyond the PCM ring is returned as unavailable", async () => {
  let emitFinalUtterance;
  let pcmWindow = "not-called";
  const session = new RollingSpeechSession({
    provider: {
      async open({ onFinalUtterance }) {
        emitFinalUtterance = onFinalUtterance;
        return { async sendAudio() {}, async close() {} };
      },
    },
    capturePcmWindows: true,
    async onFinalUtterance(utterance) { pcmWindow = utterance.pcmWindow; },
    onRemap() {},
    now: () => 0,
  });
  await session.start();
  for (let index = 0; index < 251; index += 1) await session.sendAudio(new Uint8Array(1_280));
  await emitFinalUtterance({ speakerLabel: "A", text: "late", sourceStartOffsetMs: 0, sourceEndOffsetMs: 500 });
  assert.equal(pcmWindow, null);
  await session.close();
});

function sineFrame(frequency, frameIndex) {
  const bytes = new Uint8Array(1_280);
  const view = new DataView(bytes.buffer);
  const firstSample = frameIndex * 640;
  for (let index = 0; index < 640; index += 1) {
    view.setInt16(index * 2, Math.round(Math.sin(2 * Math.PI * frequency * (firstSample + index) / 16_000) * 14_000), true);
  }
  return bytes;
}

test("failed rollover is explicit and does not create a third paid provider", async () => {
  let now = 0;
  let opens = 0;
  let closes = 0;
  const session = new RollingSpeechSession({ now: () => now,
    provider: { async open() { opens += 1; return {
      async sendAudio() {}, async getFinalWords() { return []; },
      async waitForFinalWords() { throw new Error("STT_ROLLOVER_WORDS_UNAVAILABLE"); },
      async close() { closes += 1; },
    }; } }, onFinalUtterance() {}, onRemap() {},
  });
  await session.start();
  await session.sendAudio(new Uint8Array(1_280));
  now = 550_000;
  await assert.rejects(session.sendAudio(new Uint8Array(1_280)), /STT_ROLLOVER_WORDS_UNAVAILABLE/);
  await assert.rejects(session.sendAudio(new Uint8Array(1_280)), /STT_ROLLOVER_WORDS_UNAVAILABLE/);
  await session.close();
  assert.equal(opens, 2);
  assert.equal(closes, 2);
});

test("broken provider failure is not hidden behind automatic open retries", async () => {
  let opens = 0;
  let closes = 0;
  const session = new RollingSpeechSession({
    provider: { async open() { opens += 1; return {
      async sendAudio() { throw new Error("STT_PROVIDER_FAILED"); },
      async close() { closes += 1; },
    }; } }, onFinalUtterance() {}, onRemap() {},
  });
  await session.start();
  for (let index = 0; index < 10; index += 1) await assert.rejects(session.sendAudio(new Uint8Array(1_280)), /STT_PROVIDER_FAILED/);
  await session.close();
  assert.equal(opens, 1);
  assert.equal(closes, 1);
});

test("one rolling host stream forwards interim transcripts without opening language sessions", async () => {
  let emitPartial;
  const partials = [];
  const session = new RollingSpeechSession({
    provider: {
      async open({ onPartialTranscript }) {
        emitPartial = onPartialTranscript;
        return { async sendAudio() {}, async close() {} };
      },
    },
    async onFinalUtterance() {},
    onPartialTranscript(value) { partials.push(value); },
    onRemap() {},
  });
  await session.start();
  emitPartial({ text: "진행 중입니다", sourceLanguage: "ko-KR" });
  assert.deepEqual(partials, [{ text: "진행 중입니다", sourceLanguage: "ko-KR" }]);
  await session.close();
});

test("initial provider open failure is retained without a hidden retry", async () => {
  let opens = 0;
  const session = new RollingSpeechSession({
    provider: { async open() { opens += 1; throw new Error("STT_CONNECT_FAILED"); } },
    onFinalUtterance() {}, onRemap() {},
  });
  await assert.rejects(session.start(), /STT_CONNECT_FAILED/);
  await assert.rejects(session.start(), /STT_CONNECT_FAILED/);
  assert.equal(opens, 1);
  await session.close();
});

test("concurrent start and rollover never create duplicate provider streams", async () => {
  let clock = 0;
  let opens = 0;
  const session = new RollingSpeechSession({ now: () => clock,
    provider: { async open() { opens += 1; return { supportsRolloverRemap: false, async sendAudio() {}, async close() {} }; } },
    onFinalUtterance() {}, onRemap() {},
  });
  await Promise.all([session.start(), session.start()]);
  assert.equal(opens, 1);
  clock = 550_000;
  await Promise.all(Array.from({ length: 10 }, () => session.sendAudio(new Uint8Array(1_280))));
  assert.equal(opens, 2);
  await session.close();
});

test("closing during provider connect aborts admission and closes a late stream once", async () => {
  let resolveOpen;
  let signal;
  let closes = 0;
  let delivered = 0;
  let lateCallback;
  const session = new RollingSpeechSession({
    provider: { open(options) { signal = options.signal; lateCallback = options.onFinalUtterance;
      return new Promise((resolve) => { resolveOpen = resolve; }); } },
    onFinalUtterance() { delivered += 1; }, onRemap() {},
  });
  const started = session.start();
  const rejected = assert.rejects(started, /STT_STREAM_CLOSED|STT_DRAIN_ABORTED/);
  await new Promise((resolve) => setImmediate(resolve));
  await session.close();
  assert.equal(signal.aborted, true);
  resolveOpen({ async sendAudio() {}, async close() { closes += 1; } });
  await rejected;
  await new Promise((resolve) => setImmediate(resolve));
  await lateCallback({ text: "stale final" });
  assert.equal(delivered, 0);
  assert.equal(closes, 1);
  await assert.rejects(session.sendAudio(new Uint8Array(1_280)), /STT_STREAM_CLOSED|STT_DRAIN_ABORTED/);
});

test("aborting during rollover cannot resurrect the replacement provider", async () => {
  let clock = 0;
  let opens = 0;
  let resolveReplacement;
  let closed = 0;
  const session = new RollingSpeechSession({ now: () => clock,
    provider: { async open() {
      opens += 1;
      if (opens > 1) return await new Promise((resolve) => { resolveReplacement = resolve; });
      return { supportsRolloverRemap: false, async sendAudio() {}, async close() { closed += 1; }, abort() {} };
    } }, onFinalUtterance() {}, onRemap() {},
  });
  await session.start();
  clock = 550_000;
  const sending = session.sendAudio(new Uint8Array(1_280));
  const rejected = assert.rejects(sending, /STT_DRAIN_ABORTED|STT_STREAM_CLOSED/);
  await new Promise((resolve) => setImmediate(resolve));
  session.abort();
  resolveReplacement({ async sendAudio() {}, async close() { closed += 1; } });
  await rejected;
  await session.close();
  assert.equal(opens, 2);
  assert.equal(closed, 2);
});

test("final callback backpressure is bounded and never reopens a provider", async () => {
  let emit;
  let release;
  let opens = 0;
  let started = 0;
  const stalled = new Promise((resolve) => { release = resolve; });
  const session = new RollingSpeechSession({ maxPendingUtterances: 2,
    provider: { async open(options) { opens += 1; emit = options.onFinalUtterance; return { async sendAudio() {}, async close() {} }; } },
    async onFinalUtterance() { started += 1; await stalled; }, onRemap() {},
  });
  await session.start();
  await emit({ text: "one" });
  await emit({ text: "two" });
  await assert.rejects(emit({ text: "three" }), /STT_UTTERANCE_BACKPRESSURE/);
  assert.equal(started <= 2, true);
  await assert.rejects(session.sendAudio(new Uint8Array(1_280)), /STT_UTTERANCE_BACKPRESSURE/);
  assert.equal(opens, 1);
  release();
  await session.close();
});

test("retired stream callbacks cannot create extra translation work after rollover", async () => {
  let clock = 0;
  const callbacks = [];
  const finals = [];
  const session = new RollingSpeechSession({ now: () => clock,
    provider: { async open(options) { callbacks.push(options.onFinalUtterance); return { supportsRolloverRemap: false, async sendAudio() {}, async close() {} }; } },
    onFinalUtterance(value) { finals.push(value.text); }, onRemap() {},
  });
  await session.start();
  clock = 550_000;
  await session.sendAudio(new Uint8Array(1_280));
  await new Promise((resolve) => setImmediate(resolve));
  await callbacks[0]({ text: "retired" });
  await callbacks[1]({ text: "current" });
  assert.deepEqual(finals, ["current"]);
  await session.close();
});

test("graceful close drains accepted audio before closing and rejects new audio", async () => {
  const sent = [];
  const session = new RollingSpeechSession({
    provider: { async open() { return { async sendAudio(frame) { sent.push(frame[0]); }, async close() { sent.push("closed"); } }; } },
    onFinalUtterance() {}, onRemap() {},
  });
  await session.start();
  const writes = [1, 2, 3].map((value) => session.sendAudio(new Uint8Array(1_280).fill(value)));
  const closing = session.close();
  await assert.rejects(session.sendAudio(new Uint8Array(1_280)), /STT_STREAM_CLOSED/);
  await Promise.all(writes);
  await closing;
  assert.deepEqual(sent, [1, 2, 3, "closed"]);
});
