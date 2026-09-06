import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTION_AUDIO_CHUNK_DURATION_MS,
  CAPTION_AUDIO_PROCESSOR_BUFFER_SIZE,
  CAPTION_AUDIO_SAMPLE_RATE,
  captureMicrophoneStream,
  createCaptionAudioChunker,
  getMicrophoneAudioConstraints,
} from "../public/subtitle-audio-capture.js";

test("Caption-only and Live Call share the same capture constants", () => {
  assert.equal(CAPTION_AUDIO_SAMPLE_RATE, 24_000);
  assert.equal(CAPTION_AUDIO_CHUNK_DURATION_MS, 100);
  assert.equal(CAPTION_AUDIO_PROCESSOR_BUFFER_SIZE, 1_024);
});

test("selected microphone capture keeps processing constraints and falls back once", async () => {
  const requests = [];
  const fallbackStream = { id: "default-mic" };
  const mediaDevices = {
    async getUserMedia(request) {
      requests.push(request);
      if (requests.length === 1) throw Object.assign(new Error("stale device"), { name: "OverconstrainedError" });
      return fallbackStream;
    },
  };

  const stream = await captureMicrophoneStream(mediaDevices, "selected-mic");

  assert.equal(stream, fallbackStream);
  assert.deepEqual(requests, [
    { audio: getMicrophoneAudioConstraints("selected-mic") },
    { audio: getMicrophoneAudioConstraints() },
  ]);
  assert.deepEqual(requests[0].audio, {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    deviceId: { exact: "selected-mic" },
  });
});

test("shared chunker emits source-tagged 24 kHz 100 ms PCM without path-specific framing", () => {
  const emitted = [];
  const chunker = createCaptionAudioChunker({
    inputSampleRate: 24_000,
    source: "system",
    onChunk: (chunk) => emitted.push(chunk),
  });
  chunker.push(new Float32Array(1_200).fill(0.25));
  assert.equal(emitted.length, 0);
  chunker.push(new Float32Array(1_200).fill(0.25));

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].source, "system");
  assert.equal(emitted[0].sampleRate, 24_000);
  assert.equal(emitted[0].frameDurationMs, 100);
  assert.ok(emitted[0].pcm instanceof ArrayBuffer);
  assert.equal(emitted[0].pcm.byteLength, 4_800);
});

test("shared chunker carries resampled fragments across callbacks", () => {
  const emitted = [];
  const chunker = createCaptionAudioChunker({
    inputSampleRate: 48_000,
    source: "mic",
    onChunk: (chunk) => emitted.push(chunk),
  });
  chunker.push(Float32Array.from({ length: 2_401 }, (_, index) => Math.sin(index / 20)));
  assert.equal(emitted.length, 0);
  chunker.push(Float32Array.from({ length: 2_401 }, (_, index) => Math.sin(index / 20)));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].source, "mic");
  assert.ok(emitted[0].pcm instanceof ArrayBuffer);
  assert.equal(emitted[0].pcm.byteLength, 4_800);
});
