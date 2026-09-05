import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyGlossaryCorrections,
  createCrossChannelEchoRegistry,
  describeSocketError,
  detectSourceLanguage,
  isSameLanguageEcho,
  isSourceEcho,
  normalizeRealtimeModel,
  normalizeSubtitleSettings,
} from "../src/subtitle-realtime.js";

test("desktop caption settings are caption-only and default to native Soniox", () => {
  const settings = normalizeSubtitleSettings({
    outputMode: "audio",
    audioLanguage: "ja",
    audioVolume: 0.5,
    voiceProvider: "gemini",
    model: "gemini-3.5-live-translate-preview",
    geminiModel: "gemini-3.5-live-translate-preview",
    translationLanguages: ["en", "ko", "ja"],
  });

  assert.equal(settings.outputMode, "captions");
  // The per-role model pins now live on the canonical engine selection.
  assert.deepEqual(settings.engine.stt, {
    provider: "soniox",
    model: "stt-rt-v5",
    languageMode: "auto",
  });
  assert.equal(settings.engine.translation.provider, "soniox");
  assert.equal(settings.engine.summary.provider, "gemini");
  for (const retiredKey of ["audioLanguage", "audioVolume", "voiceProvider", "model", "geminiModel"]) {
    assert.equal(Object.hasOwn(settings, retiredKey), false);
  }
  assert.equal(normalizeRealtimeModel("gemini-3.5-live-translate-preview"), "stt-rt-v5");
});

test("an explicitly selected engine survives normalization instead of being pinned back", () => {
  const settings = normalizeSubtitleSettings({
    engine: {
      stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
      translation: { provider: "gemini", model: "gemini-3.7-flash" },
      summary: { provider: "gemini", model: "gemini-3.7-flash" },
    },
  });

  assert.equal(settings.engine.translation.model, "gemini-3.7-flash");
  assert.equal(settings.engine.summary.model, "gemini-3.7-flash");
});

// Fix round 2 (I4): a combined Soniox engine can only be configured for a
// language PAIR. Start/restart must refuse the invalid pair here rather than
// opening a socket that the provider rejects.
test("normalization supports one to three Soniox caption languages", () => {
  const combined = {
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" },
    translation: { provider: "soniox", model: "stt-rt-v5" },
    summary: { provider: "gemini", model: "gemini-3.6-flash" },
  };
  const ok = normalizeSubtitleSettings({ engine: combined, translationLanguages: ["en", "ko"] });
  assert.equal(ok.engine.translation.provider, "soniox");
  for (const translationLanguages of [["ja"], ["en", "ko", "ja"]]) {
    assert.equal(normalizeSubtitleSettings({ engine: combined, translationLanguages }).engine.translation.provider, "soniox");
  }
});

test("language detection remains stable for code-switching and proper nouns", () => {
  assert.equal(detectSourceLanguage("We look at ADR and GOP this quarter 그"), "en");
  assert.equal(detectSourceLanguage("쿠시먼앤드웨이크필드 코리아가 ADR과 GOP를 봅니다"), "ko");
  assert.equal(detectSourceLanguage("安定したNOIを説明します"), "ja");
});

test("same-language output is suppressed but real translation is retained", () => {
  assert.equal(isSameLanguageEcho("This is now good", "This is now good.", "en"), true);
  assert.equal(isSameLanguageEcho("오늘 회의를 시작합니다", "We are starting today's meeting.", "en"), false);
  assert.equal(isSourceEcho("Cushman & Wakefield", "Cushman & Wakefield."), true);
  assert.equal(isSourceEcho("쿠시먼앤드웨이크필드", "Cushman & Wakefield"), false);
});

test("deterministic terminology repair remains active after text translation", () => {
  const glossary = "쿠시먼앤드웨이크필드 = Cushman & Wakefield\n순영업소득 = NOI";
  assert.equal(
    applyGlossaryCorrections("Cushman and Wakefield NOI", {
      glossary,
      sourceText: "쿠시먼앤드웨이크필드 순영업소득",
      targetLanguage: "en",
    }),
    "Cushman & Wakefield NOI",
  );
});

test("cross-channel registry still delegates to the shared caption-core contract", () => {
  const registry = createCrossChannelEchoRegistry();
  assert.equal(typeof registry.reportSource, "function");
  assert.equal(typeof registry.resolveSource, "function");
  assert.equal(typeof registry.outputEchoesAnotherSource, "function");
});

test("socket diagnostics are actionable without exposing provider internals", () => {
  assert.match(describeSocketError("self-signed certificate in certificate chain"), /보안 프록시/u);
  assert.match(describeSocketError("connect ETIMEDOUT"), /방화벽/u);
  assert.match(describeSocketError("getaddrinfo ENOTFOUND"), /DNS/u);
  assert.equal(describeSocketError("unknown"), "");
});
