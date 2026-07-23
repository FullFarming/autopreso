import assert from "node:assert/strict";
import test from "node:test";

import { AcousticRangeSession, estimateAcousticRange } from "../src/acoustic-range.js";

const SAMPLE_RATE = 16_000;

test("stable PCM tones classify into low, mid, and high acoustic ranges", () => {
  assert.equal(estimateAcousticRange(sinePcm(110, 800)).range, "low");
  assert.equal(estimateAcousticRange(sinePcm(190, 800)).range, "mid");
  assert.equal(estimateAcousticRange(sinePcm(300, 800)).range, "high");
});

test("silence, broadband noise, and short samples remain uncertain", () => {
  assert.equal(estimateAcousticRange(new Uint8Array(SAMPLE_RATE * 2)).range, "uncertain");
  assert.equal(estimateAcousticRange(noisePcm(800)).range, "uncertain");
  assert.equal(estimateAcousticRange(sinePcm(180, 80)).range, "uncertain");
});

test("one falsetto-like outlier cannot change a locked session range", () => {
  const session = new AcousticRangeSession({ sampleRate: SAMPLE_RATE });
  session.push(sinePcm(120, 800));
  assert.equal(session.resolveSpeakerRange("speaker-1"), "low");
  session.push(sinePcm(310, 800));
  assert.equal(session.resolveSpeakerRange("speaker-1"), "low");
  session.push(sinePcm(315, 800));
  assert.throws(() => session.resolveSpeakerRange("speaker-1"), /ACOUSTIC_RANGE_CONFLICT/u);
});

test("session analysis discards raw PCM after resolution and on close", () => {
  const session = new AcousticRangeSession({ sampleRate: SAMPLE_RATE });
  session.push(sinePcm(180, 800));
  assert.equal(session.bufferedBytes > 0, true);
  session.resolveSpeakerRange("speaker-1");
  assert.equal(session.bufferedBytes, 0);
  session.push(sinePcm(180, 800));
  session.clear();
  assert.equal(session.bufferedBytes, 0);
});

function sinePcm(frequency, milliseconds, amplitude = 0.45) {
  const sampleCount = Math.round(SAMPLE_RATE * milliseconds / 1_000);
  const bytes = new Uint8Array(sampleCount * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * frequency * index / SAMPLE_RATE) * amplitude * 32_767);
    view.setInt16(index * 2, sample, true);
  }
  return bytes;
}

function noisePcm(milliseconds) {
  const sampleCount = Math.round(SAMPLE_RATE * milliseconds / 1_000);
  const bytes = new Uint8Array(sampleCount * 2);
  const view = new DataView(bytes.buffer);
  let state = 0x12345678;
  for (let index = 0; index < sampleCount; index += 1) {
    state = (1_664_525 * state + 1_013_904_223) >>> 0;
    view.setInt16(index * 2, ((state & 0xffff) - 32_768) / 2, true);
  }
  return bytes;
}
