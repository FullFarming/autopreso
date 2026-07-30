import assert from "node:assert/strict";
import test from "node:test";

import { estimateAcousticRange } from "../src/acoustic-range.js";
import { RollingSpeechSession } from "../src/rolling-speech-session.js";

function overlapWords(label) {
  return [{ word: "hello", startMs: 100, endMs: 600, speakerLabel: label }];
}

test("async finalized-utterance failures become a fail-closed stream error", async () => {
  let emitFinalUtterance;
  const session = new RollingSpeechSession({
    provider: {
      async open({ onFinalUtterance }) {
        emitFinalUtterance = onFinalUtterance;
        return { async sendAudio() {}, async close() {} };
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
  await assert.rejects(() => session.sendAudio(new Uint8Array(1_280)), /QUEUE_LATENCY_EXCEEDED/);
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
        const stream = {
          generation,
          closed: 0,
          async sendAudio() {
            if (isRollover) {
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
  now = 270_000;
  await session.sendAudio(new Uint8Array(1_280));
  assert.deepEqual(emitted, []);
  await streams[1].onFinalUtterance({ speakerLabel: "next-A", text: "new words", sourceEndOffsetMs: 2_800 });
  assert.deepEqual(emitted, ["new words"]);
  assert.equal(streams[0].closed, 1);
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

test("a failed rollover restarts on a fresh stream instead of poisoning the session", async () => {
  let now = 0;
  const streams = [];
  const emitted = [];
  const warnings = [];
  const secret = ["test", "rollover", "marker"].join("-");
  const session = new RollingSpeechSession({
    now: () => now,
    provider: {
      async open({ onFinalUtterance }) {
        const index = streams.length;
        const stream = {
          closed: 0,
          async sendAudio() {},
          async getFinalWords() { return []; },
          async waitForFinalWords() { throw new Error(`https://speech.example?key=${secret}`); },
          async close() { this.closed += 1; },
          onFinalUtterance,
          index,
        };
        streams.push(stream);
        return stream;
      },
    },
    async onFinalUtterance(utterance) { emitted.push(utterance.text); },
    onRemap() {},
  });
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values.join(" "));
  try {
    await session.start();
    await session.sendAudio(new Uint8Array(1_280));
    now = 270_000;
    // Rollover fires here: overlap remap fails (nobody spoke), but audio must keep flowing.
    await session.sendAudio(new Uint8Array(1_280));
    await session.sendAudio(new Uint8Array(1_280));
    assert.equal(streams.length >= 3, true); // original + failed rollover attempt + fresh restart
    const active = streams.at(-1);
    await active.onFinalUtterance({ speakerLabel: "A", text: "still alive", sourceEndOffsetMs: 400 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(emitted, ["still alive"]);
    await session.close();
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join("\n"), /STT_ROLLOVER_FAILED/u);
  assert.doesNotMatch(warnings.join("\n"), /AIza|speech\.example|key=/u);
});

test("a broken stream is replaced on the next audio frame instead of failing the session", async () => {
  const streams = [];
  const warnings = [];
  const secret = ["test", "rolling", "marker"].join("-");
  const session = new RollingSpeechSession({
    now: () => 0,
    provider: {
      async open({ onFinalUtterance }) {
        const index = streams.length;
        const stream = {
          async sendAudio() {
            if (index === 0) throw new Error(`https://speech.example?key=${secret}`);
          },
          async getFinalWords() { return []; },
          async close() {},
          onFinalUtterance,
        };
        streams.push(stream);
        return stream;
      },
    },
    async onFinalUtterance() {},
    onRemap() {},
  });
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values.join(" "));
  try {
    await session.start();
    await session.sendAudio(new Uint8Array(1_280)); // first frame hits the broken stream; must not throw
    await session.sendAudio(new Uint8Array(1_280));
    assert.equal(streams.length, 2);
    await session.close();
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join("\n"), /STT_STREAM_SEND_FAILED/u);
  assert.doesNotMatch(warnings.join("\n"), /AIza|speech\.example|key=/u);
});
