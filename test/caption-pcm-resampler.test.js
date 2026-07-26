import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createCaptionPcmResampler } from "../src/caption-pcm-resampler.js";
import { createGeminiTransport } from "../src/gemini-live-translate.js";

function pcm16Buffer(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
}

test("shared FIR keeps the Caption-only impulse response unchanged", () => {
  const impulse = Array(2_400).fill(0);
  impulse[1_200] = 30_000;
  const output = createCaptionPcmResampler()(pcm16Buffer(impulse));

  assert.equal(output.byteLength, 3_200);
  assert.equal(
    crypto.createHash("sha256").update(output).digest("hex"),
    "96a5e45d82b44178ec23790defaddf74742f4959a8732aa845ef97b677acf5bc",
  );
});

test("shared FIR is stateful and identical across arbitrary input chunk boundaries", () => {
  const samples = Array.from({ length: 2_400 }, (_, index) => (
    index === 1_200 ? 30_000 : Math.round(4_000 * Math.sin(index / 17))
  ));
  const whole = createCaptionPcmResampler()(pcm16Buffer(samples));
  const chunkedResampler = createCaptionPcmResampler();
  const chunked = Buffer.concat([
    chunkedResampler(pcm16Buffer(samples.slice(0, 517))),
    chunkedResampler(pcm16Buffer(samples.slice(517, 1_731))),
    chunkedResampler(pcm16Buffer(samples.slice(1_731))),
  ]);

  assert.deepEqual(chunked, whole);
});

test("Gemini Caption-only transport uses the same shared FIR bytes", () => {
  const samples = Array.from({ length: 2_400 }, (_, index) => ((index * 97) % 20_000) - 10_000);
  const input = pcm16Buffer(samples);
  const expected = createCaptionPcmResampler()(input);
  const payload = JSON.parse(createGeminiTransport().audioPayload(input.toString("base64")));

  assert.deepEqual(Buffer.from(payload.realtimeInput.audio.data, "base64"), expected);
  assert.equal(payload.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
});
