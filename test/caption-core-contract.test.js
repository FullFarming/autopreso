import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createCaptionLanguageState,
  createSourceLanguageConsensus,
  projectCanonicalCaption,
} from "../packages/caption-core/index.js";
import { createSubtitleLanguageState } from "../src/subtitle-language-state.js";
import { createSourceLanguageState } from "../media-gateway/src/source-language-state.js";

const LANGUAGE_SAMPLES = [
  { providerLanguage: "en", transcript: "이제 국내 호텔 시장을 살펴보겠습니다" },
  { providerLanguage: "ko", transcript: "We will now review the domestic hotel market" },
  { providerLanguage: "en", transcript: "Cushman & Wakefield" },
  { providerLanguage: "ko", transcript: "가" },
  { providerLanguage: "en-US", transcript: "I" },
];

test("desktop and gateway language adapters expose the caption-only state byte behavior", () => {
  const expected = createCaptionLanguageState();
  const desktop = createSubtitleLanguageState();
  const gateway = createSourceLanguageState();

  for (const sample of LANGUAGE_SAMPLES) {
    const reference = expected.observe(sample);
    assert.deepEqual(desktop.observe(sample), reference);
    assert.equal(gateway.observe(sample), reference.language === "unknown" ? "" : reference.language);
  }
});

test("caption-only realtime delegates language gating, source consensus, and echo dedupe to caption-core", async () => {
  const source = await readFile(new URL("../src/subtitle-realtime.js", import.meta.url), "utf8");
  assert.match(source, /createCrossChannelEchoDeduper\(\)/);
  assert.match(source, /createSourceLanguageConsensus\(\)/);
  assert.match(source, /isFixedTargetOutputSupported\(text, targetLanguage,\s*\{\s*protectedTerms: termRetriever\.getProtectedTerms/s);
  assert.match(source, /!isTargetOutputSupported\(corrected\)/);
  assert.match(source, /!isTargetOutputSupported\(translatedText\)/);
  assert.match(source, /return detectCaptionSourceLanguage\(value, options\)/);
  assert.doesNotMatch(source, /const SOURCE_VOTE_WINDOW_MS\s*=/);
  assert.doesNotMatch(source, /function normalizeCrossChannelText\s*\(/);
  assert.doesNotMatch(source, /function detectLanguage\s*\(/);
});

test("source consensus holds a decision until sibling agreement moves it", () => {
  let now = 1_000;
  const consensus = createSourceLanguageConsensus({ now: () => now });
  consensus.report("ko", "en", { isStrong: true });
  consensus.report("en", "en", { isStrong: true });
  assert.equal(consensus.resolve("unknown"), "en");

  now += 500;
  consensus.report("ko", "ko", { isStrong: true });
  assert.equal(consensus.resolve("unknown"), "en");
  consensus.report("en", "ko", { isStrong: true });
  assert.equal(consensus.resolve("unknown"), "ko");
});

test("canonical bilingual caption projects opposite-language overlay and both record lanes", () => {
  assert.deepEqual(projectCanonicalCaption({
    utteranceKey: "u1",
    phase: "final",
    sourceText: "We review the market.",
    translatedText: "시장을 검토합니다.",
    sourceLanguage: "en",
    targetLanguage: "ko",
    translationStatus: "translated",
  }), {
    overlay: {
      utteranceKey: "u1",
      phase: "final",
      language: "ko",
      text: "시장을 검토합니다.",
    },
    records: [
      { utteranceKey: "u1", phase: "final", language: "en", sourceLanguage: "en", sourceText: "We review the market.", text: "We review the market.", translationStatus: "source" },
      { utteranceKey: "u1", phase: "final", language: "ko", sourceLanguage: "en", sourceText: "We review the market.", text: "시장을 검토합니다.", translationStatus: "translated" },
    ],
  });
});

test("failed translation preserves source history but never exposes source on the overlay", () => {
  const projected = projectCanonicalCaption({
    utteranceKey: "u2",
    phase: "final",
    sourceText: "한국어 원문입니다.",
    translatedText: "",
    sourceLanguage: "ko",
    targetLanguage: "en",
    translationStatus: "failed",
  });
  assert.equal(projected.overlay, null);
  assert.deepEqual(projected.records, [
    { utteranceKey: "u2", phase: "final", language: "ko", sourceLanguage: "ko", sourceText: "한국어 원문입니다.", text: "한국어 원문입니다.", translationStatus: "source" },
  ]);
});

test("partial translation can paint the overlay but never enters durable records", () => {
  const projected = projectCanonicalCaption({
    utteranceKey: "u3",
    phase: "partial",
    sourceText: "We are reviewing",
    translatedText: "검토하고 있습니다",
    sourceLanguage: "en",
    targetLanguage: "ko",
    translationStatus: "translated",
  });
  assert.equal(projected.overlay?.text, "검토하고 있습니다");
  assert.deepEqual(projected.records, []);
});
