import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

/** @typedef {{ type: string, pcm?: ArrayBuffer }} WorkletMessage */
/** @typedef {{ messages: WorkletMessage[], process(inputs: Float32Array[][]): boolean, emitChunk(samples: number[]): void }} LoadedProcessor */

async function loadProcessor() {
  const source = await readFile(new URL("../webapp/public/live-audio-worklet.js", import.meta.url), "utf8");
  class FakeAudioWorkletProcessor {
    constructor() {
      this.messages = [];
      this.port = {
        postMessage: (message) => this.messages.push(message),
      };
    }
  }
  /** @type {(new () => LoadedProcessor) | null} */
  let Processor = null;
  vm.runInNewContext(source, {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    Date,
    Int16Array,
    Math,
    sampleRate: 48_000,
    registerProcessor(_name, value) { Processor = value; },
  });
  assert.ok(Processor);
  return new Processor();
}

test("live host worklet emits Google-recommended 40 ms PCM16 frames", async () => {
  const processor = await loadProcessor();
  const voicedInput = new Float32Array(128).fill(0.2);
  for (let index = 0; index < 16; index += 1) processor.process([[voicedInput]]);
  const chunks = processor.messages.filter((message) => message.type === "chunk");
  assert.ok(chunks.length >= 1);
  assert.equal(chunks[0].pcm.byteLength, 1_280);
});

test("40 ms VAD keeps 300 ms preroll and ends after one second of silence", async () => {
  const processor = await loadProcessor();
  const silentChunk = new Array(640).fill(0);
  const voicedChunk = new Array(640).fill(0.2);
  for (let index = 0; index < 12; index += 1) processor.emitChunk(silentChunk);
  processor.emitChunk(voicedChunk);
  const chunksAfterVoice = processor.messages.filter((message) => message.type === "chunk");
  assert.equal(chunksAfterVoice.length, 9, "eight 40 ms preroll frames plus the voiced frame");
  for (let index = 0; index < 24; index += 1) processor.emitChunk(silentChunk);
  assert.equal(processor.messages.some((message) => message.type === "audioStreamEnd"), false);
  processor.emitChunk(silentChunk);
  assert.equal(processor.messages.filter((message) => message.type === "audioStreamEnd").length, 1);
});
