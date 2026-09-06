import assert from "node:assert/strict";
import test from "node:test";

import { encodeLiveAudioWireFrame, LIVE_AUDIO_WIRE_BYTES } from "../src/live-audio-wire.js";

test("gateway audio envelope tags system PCM without changing its bytes", () => {
  const pcm = Buffer.allocUnsafe(1_280);
  for (let index = 0; index < pcm.length; index += 1) pcm[index] = index % 251;

  const frame = encodeLiveAudioWireFrame("system", pcm);

  assert.ok(frame);
  assert.equal(frame.length, LIVE_AUDIO_WIRE_BYTES);
  assert.deepEqual([...frame.subarray(0, 4)], [0x4e, 1, 1, 0]);
  assert.deepEqual(frame.subarray(4), pcm);
});

test("gateway audio envelope gives microphone frames a distinct source tag", () => {
  const pcm = Buffer.alloc(1_280, 0xa5);
  const frame = encodeLiveAudioWireFrame("mic", pcm);

  assert.ok(frame);
  assert.deepEqual([...frame.subarray(0, 4)], [0x4e, 1, 2, 0]);
  assert.deepEqual(frame.subarray(4), pcm);
});

test("gateway audio envelope rejects malformed source, type, and payload size", () => {
  assert.equal(encodeLiveAudioWireFrame("participant", Buffer.alloc(1_280)), null);
  assert.equal(encodeLiveAudioWireFrame("system", new Uint8Array(1_280)), null);
  assert.equal(encodeLiveAudioWireFrame("mic", Buffer.alloc(1_279)), null);
  assert.equal(encodeLiveAudioWireFrame("mic", Buffer.alloc(1_281)), null);
});
