import assert from "node:assert/strict";
import test from "node:test";

import { conditionPcm16Chunk, Pcm16StreamConditioner } from "../src/pcm-conditioning.js";

function pcm(...samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

function samples(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true));
}

test("PCM conditioning leaves digital and near silence unboosted", () => {
  assert.deepEqual(conditionPcm16Chunk(pcm(0, 0, 0, 0)), pcm(0, 0, 0, 0));
  assert.deepEqual(conditionPcm16Chunk(pcm(12, -12, 24, -24)), pcm(12, -12, 24, -24));
});

test("PCM conditioning caps gain and limits peaks without int16 clipping", () => {
  assert.deepEqual(samples(conditionPcm16Chunk(pcm(1_000, -1_000))), [2_000, -2_000]);
  const conditioned = samples(conditionPcm16Chunk(pcm(32_767, -32_768, 30_000, -30_000)));
  assert.equal(Math.max(...conditioned.map(Math.abs)) <= 30_000, true);
  assert.equal(conditioned.some((sample) => sample === 32_767 || sample === -32_768), false);
});

test("stream conditioner applies a short fade only at synthesis boundaries", () => {
  const conditioner = new Pcm16StreamConditioner({ sampleRate: 24_000, fadeMilliseconds: 5, maxGain: 1 });
  const first = conditioner.process(pcm(...Array(240).fill(10_000)));
  const middle = conditioner.process(pcm(...Array(240).fill(10_000)));
  const tail = conditioner.finish();
  assert.equal(samples(first)[0], 0);
  assert.equal(samples(first).at(-1), 10_000);
  assert.equal(samples(middle)[0], 10_000);
  assert.equal(samples(tail).at(-1), 0);
  assert.equal(tail.byteLength, 240);
});
