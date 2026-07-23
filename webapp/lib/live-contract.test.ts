import assert from "node:assert/strict";
import test from "node:test";

import { decodeAudioChunk, encodeAudioChunk } from "./live-contract";

test("audio chunk decoder accepts bounded PCM16 and rejects invalid sequence numbers", () => {
  const valid = encodeAudioChunk({
    header: {
      type: "audio-chunk",
      seq: 1,
      sessionId: "session-1",
      language: "ko",
      speaker: null,
      sampleRate: 24_000,
    },
    pcm: new Uint8Array([1, 0, 2, 0]).buffer,
  });
  assert.equal(decodeAudioChunk(valid).pcm.byteLength, 4);

  const invalidSequence = encodeAudioChunk({
    header: {
      type: "audio-chunk",
      seq: -1,
      sessionId: "session-1",
      language: "ko",
      speaker: null,
      sampleRate: 24_000,
    },
    pcm: new Uint8Array([1, 0]).buffer,
  });
  assert.throws(() => decodeAudioChunk(invalidSequence), /헤더/);
});

test("audio chunk decoder bounds header and PCM payload sizes", () => {
  const oversizedHeader = new ArrayBuffer(8);
  new DataView(oversizedHeader).setUint32(0, 4_097, false);
  assert.throws(() => decodeAudioChunk(oversizedHeader), /헤더/);

  const oversizedPcm = encodeAudioChunk({
    header: {
      type: "audio-chunk",
      seq: 2,
      sessionId: "session-1",
      language: "ko",
      speaker: null,
      sampleRate: 24_000,
    },
    pcm: new Uint8Array(256 * 1_024 + 2).buffer,
  });
  assert.throws(() => decodeAudioChunk(oversizedPcm), /PCM/);
});
