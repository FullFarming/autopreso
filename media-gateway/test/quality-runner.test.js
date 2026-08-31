import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runGeminiCaptionQualityCheck } from "../scripts/provider-quality-60s.mjs";

test("quality runner is a no-network Gemini-only shared-engine check", async () => {
  const [source, adapters, packageJson] = await Promise.all([
    readFile(new URL("../scripts/provider-quality-60s.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/google-provider-adapters.js", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(source, /createGeminiCaptionConfig/u);
  assert.match(source, /createCommittedCaptionFinalizer/u);
  assert.match(source, /LiveMediaPipeline/u);
  assert.match(source, /LIVE_EXTERNAL_ENV !== "development"/u);
  assert.match(source, /RUN_LIVE_QUALITY_PROBE/u);
  assert.doesNotMatch(source, /@google-cloud\/(?:translate|text-to-speech)/u);
  assert.doesNotMatch(source, /CloudTranslation|Chirp|OpenAI|api\.openai\.com/u);
  assert.doesNotMatch(source, /liveTranslate|publishAudio|translatedAudio/u);
  assert.doesNotMatch(source, /\bfetch\s*\(|WebSocket/u);
  assert.doesNotMatch(adapters, /CloudTranslationAdvancedAdapter|ChirpTextToSpeechAdapter/u);
  assert.doesNotMatch(packageJson, /@google-cloud\/(?:translate|text-to-speech)/u);

  const metrics = await runGeminiCaptionQualityCheck();
  assert.equal(metrics.code, "OK");
  assert.equal(metrics.provider, "gemini");
  assert.equal(metrics.transcriptionModel, "gemini-3.5-transcribe-live");
  assert.equal(metrics.textModel, "gemini-3.7-flash");
  assert.equal(metrics.simulatedAudioMilliseconds, 60_000);
  assert.equal(metrics.finalized, metrics.utterances);
  assert.equal(metrics.polishCalls, metrics.utterances);
  assert.equal(metrics.bidirectionalDirections, 2);
  assert.equal(metrics.transcriptionSessions, 1);
  assert.equal(metrics.committedCaptions, metrics.utterances * 2);
  assert.equal(metrics.translatedCaptions, metrics.utterances);
  assert.match(metrics.configFingerprint, /^gemini-caption-v2-[0-9a-f]{16}$/u);
});
