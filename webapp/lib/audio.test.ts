import assert from "node:assert/strict";
import test from "node:test";

import { createStreamingPcm16Resampler } from "./audio";

function pcmSamples(start: number, count: number): string {
  const bytes = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) bytes.writeInt16LE((start + index) % 30_000, index * 2);
  return bytes.toString("base64");
}

test("streaming PCM resampling preserves phase across arbitrarily divided capture chunks", () => {
  const contiguous = createStreamingPcm16Resampler(24_000, 16_000);
  const divided = createStreamingPcm16Resampler(24_000, 16_000);
  const expected = contiguous.push(pcmSamples(0, 3_003));
  const actual = Buffer.concat([
    Buffer.from(divided.push(pcmSamples(0, 1_001))),
    Buffer.from(divided.push(pcmSamples(1_001, 1_001))),
    Buffer.from(divided.push(pcmSamples(2_002, 1_001))),
  ]);
  assert.deepEqual(actual, Buffer.from(expected));
});

test("streaming PCM resampler reset removes the previous capture phase and sample tail", () => {
  const reused = createStreamingPcm16Resampler(24_000, 16_000);
  const fresh = createStreamingPcm16Resampler(24_000, 16_000);
  reused.push(pcmSamples(0, 1_001));
  reused.reset();
  assert.deepEqual(Buffer.from(reused.push(pcmSamples(8_000, 2_000))), Buffer.from(fresh.push(pcmSamples(8_000, 2_000))));
});
