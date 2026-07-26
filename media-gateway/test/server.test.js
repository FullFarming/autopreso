import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createCaptionPolishPolicyResolver, listenMediaGateway, resolveTextToSpeechV1Client } from "../src/server.js";

test("caption polish canary assignment is stable across all three policy buckets without caption text", () => {
  const resolvePolicy = createCaptionPolishPolicyResolver({
    defaultPolicy: "selective",
    policyWeights: { off: 2_500, selective: 5_000, full: 2_500 },
  });
  const first = resolvePolicy("session-stable");
  assert.equal(resolvePolicy("session-stable"), first);
  const assigned = new Set(Array.from({ length: 500 }, (_, index) => resolvePolicy(`session-${index}`)));
  assert.deepEqual([...assigned].sort(), ["full", "off", "selective"]);
  assert.throws(() => createCaptionPolishPolicyResolver({ defaultPolicy: "invalid" }), /INVALID_CAPTION_POLISH_POLICY/u);
  assert.throws(() => createCaptionPolishPolicyResolver({ policyWeights: { off: 5_001, selective: 5_000, full: 0 } }), /INVALID_CAPTION_POLISH_CANARY/u);
  assert.throws(() => createCaptionPolishPolicyResolver({ policyWeights: { off: -1, selective: 10_000, full: 0 } }), /INVALID_CAPTION_POLISH_CANARY/u);
});

test("media gateway gives caption polish the same six-second quality budget as desktop", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(source, /createCaptionPolisher\(\{[^}]*timeoutMs:\s*6_000/u);
  assert.doesNotMatch(source, /timeoutMs:\s*4_000/u);
  assert.doesNotMatch(source, /timeoutMs:\s*1_500/u);
});

test("media gateway resolves only the explicit Text-to-Speech v1 streaming client", () => {
  class V1TextToSpeechClient {}
  assert.equal(resolveTextToSpeechV1Client({ v1: { TextToSpeechClient: V1TextToSpeechClient } }), V1TextToSpeechClient);
  assert.equal(resolveTextToSpeechV1Client({ default: { v1: { TextToSpeechClient: V1TextToSpeechClient } } }), V1TextToSpeechClient);
  assert.throws(
    () => resolveTextToSpeechV1Client({ TextToSpeechClient: class LegacyClient {} }),
    /TTS_V1_CLIENT_UNAVAILABLE/u,
  );
});

test("media gateway listens on the host selected by the validated environment", async () => {
  const calls = [];
  const server = {
    listen(port, host, callback) {
      calls.push({ port, host });
      callback();
    },
  };

  await listenMediaGateway(server, { port: 8080, host: "127.0.0.1" });
  await listenMediaGateway(server, { port: 9090, host: "0.0.0.0" });

  assert.deepEqual(calls, [
    { port: 8080, host: "127.0.0.1" },
    { port: 9090, host: "0.0.0.0" },
  ]);
});
