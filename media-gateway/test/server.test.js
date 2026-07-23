import assert from "node:assert/strict";
import test from "node:test";

import { resolveTextToSpeechV1Client } from "../src/server.js";

test("media gateway resolves only the explicit Text-to-Speech v1 streaming client", () => {
  class V1TextToSpeechClient {}
  assert.equal(resolveTextToSpeechV1Client({ v1: { TextToSpeechClient: V1TextToSpeechClient } }), V1TextToSpeechClient);
  assert.equal(resolveTextToSpeechV1Client({ default: { v1: { TextToSpeechClient: V1TextToSpeechClient } } }), V1TextToSpeechClient);
  assert.throws(
    () => resolveTextToSpeechV1Client({ TextToSpeechClient: class LegacyClient {} }),
    /TTS_V1_CLIENT_UNAVAILABLE/u,
  );
});
