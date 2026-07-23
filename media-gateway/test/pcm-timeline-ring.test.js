import assert from "node:assert/strict";
import test from "node:test";

import { PcmTimelineRing } from "../src/pcm-timeline-ring.js";

test("PCM ring slices only the finalized utterance window and rejects delayed windows", () => {
  const ring = new PcmTimelineRing({ sampleRate: 16_000, maxMilliseconds: 300 });
  ring.push(new Uint8Array(3_200).fill(1), 0);
  ring.push(new Uint8Array(3_200).fill(2), 100);
  ring.push(new Uint8Array(3_200).fill(3), 200);
  assert.deepEqual(ring.sliceWindow(100, 300), new Uint8Array(6_400).fill(2).map((value, index) => index < 3_200 ? 2 : 3));
  ring.push(new Uint8Array(3_200).fill(4), 300);
  assert.equal(ring.sliceWindow(0, 100), null, "evicted delayed finals must fail closed");
});

test("discard and clear zero owned PCM and release bounded memory", () => {
  const ring = new PcmTimelineRing({ sampleRate: 16_000, maxMilliseconds: 1_000 });
  ring.push(new Uint8Array(3_200).fill(9), 0);
  ring.push(new Uint8Array(3_200).fill(8), 100);
  ring.discardThrough(100);
  assert.equal(ring.bufferedBytes, 3_200);
  ring.clear();
  assert.equal(ring.bufferedBytes, 0);
});
