import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSpikeArgs, readWav16kMono, summarizeMetrics } from "../scripts/engine-spike.mjs";

test("args default to soniox+gemini, modes auto/ko/en, us endpoint", () => {
  const args = parseSpikeArgs(["--wav", "a.wav"]);
  assert.deepEqual(args, { wav: "a.wav", providers: ["soniox", "gemini"], modes: ["auto", "ko", "en"], endpoint: "us", realtime: true, out: null });
  assert.deepEqual(parseSpikeArgs(["--wav", "a.wav", "--providers", "soniox", "--modes", "ko", "--endpoint", "jp", "--no-realtime"]).modes, ["ko"]);
  assert.throws(() => parseSpikeArgs([]), /--wav/u);
});

test("wav reader accepts 16 kHz mono PCM16 and rejects others", () => {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + 4, 4); header.write("WAVE", 8); header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(4, 40);
  const pcm = readWav16kMono(Buffer.concat([header, Buffer.from([1, 0, 2, 0])]));
  assert.equal(pcm.length, 4);
  header.writeUInt32LE(24000, 24);
  assert.throws(() => readWav16kMono(Buffer.concat([header, Buffer.from([1, 0, 2, 0])])), /16000/u);
});

test("metrics summarize p50/p95 and counts", () => {
  const summary = summarizeMetrics({ firstPartialMs: [100, 200, 300], finalLagMs: [500, 700], otherScriptFinals: 1, finals: 12 });
  assert.equal(summary.firstPartialMs.p50, 200);
  assert.equal(summary.finalLagMs.p95, 700);
  assert.equal(summary.otherScriptFinals, 1);
});
