import assert from "node:assert/strict";
import test from "node:test";

import { GeminiTextTranslateAdapter } from "../src/google-provider-adapters.js";
import { LiveMediaPipeline } from "./helpers/gemini-pipeline.js";

function createPipelineHarness({ languages = ["ko", "en"], textTranslate, captionPolish } = {}) {
  const events = [];
  const speechSessions = [];
  const translationCalls = [];
  const polishCalls = [];
  let sourceSeq = 0;
  const pipeline = new LiveMediaPipeline({
    sessionId: "gemini-caption-only",
    sessionType: "meeting",
    outputMode: "captions_audio",
    languages,
    glossaryText: "순영업소득 = NOI",
    translationTone: "business",
    domainText: "Commercial real estate",
    captionPolishPolicy: "full",
    dependencies: {
      speechToText: {
        async open(options) {
          const session = {
            ...options,
            async sendAudio() {},
            async close() {},
            async getFinalWords() { return []; },
          };
          speechSessions.push(session);
          return session;
        },
      },
      textTranslate: {
        async translate(input) {
          translationCalls.push(input);
          if (textTranslate) return textTranslate(input);
          return input.language === "en" ? "We are reviewing NOI." : "순영업소득을 검토합니다.";
        },
      },
      captionPolish: {
        async polish(input) {
          polishCalls.push(input);
          return captionPolish ? captionPolish(input) : input.translatedText;
        },
      },
      publisher: {
        async persistAuthoritativeSource() {
          sourceSeq += 1;
          return {
            sourceUtteranceId: `00000000-0000-4000-8000-${String(sourceSeq).padStart(12, "0")}`,
            sourceSeq,
            idempotent: false,
          };
        },
        async publish(_sessionId, _language, event) { events.push(event); },
        async publishAudio() { throw new Error("TRANSLATED_AUDIO_FORBIDDEN"); },
        async markLive() {},
      },
    },
  });
  return { pipeline, events, speechSessions, translationCalls, polishCalls };
}

const KOREAN_FINAL = Object.freeze({
  speakerLabel: "Host",
  text: "순영업소득을 검토합니다.",
  sourceLanguage: "ko-KR",
  sourceEndedAt: "2026-08-27T09:00:00.000Z",
});

test("Live Call canonical config pins the catalog default engine (Transcribe Live + Flash) in v5", async () => {
  const harness = createPipelineHarness();
  assert.equal(harness.pipeline.captionConfig.provider, "gemini");
  assert.equal(harness.pipeline.captionConfig.voiceProvider, null);
  assert.equal(harness.pipeline.captionConfig.outputMode, "captions");
  assert.deepEqual(harness.pipeline.captionConfig.engine.stt, { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" });
  assert.deepEqual(harness.pipeline.captionConfig.engine.translation, { provider: "gemini", model: "gemini-3.6-flash" });
  assert.equal(harness.pipeline.captionConfig.models.transcription, "gemini-3.5-transcribe-live");
  assert.equal(harness.pipeline.captionConfig.models.summary, "gemini-3.6-flash");
  assert.equal(Object.hasOwn(harness.pipeline.captionConfig.models, "live"), false, "the direct Live Translate lane no longer exists");
  assert.equal(harness.pipeline.isCombined, false);
  assert.equal(harness.pipeline.translationModel, "gemini-3.6-flash");
  assert.equal(Object.isFrozen(harness.pipeline.captionConfig), true);
  assert.match(harness.pipeline.captionConfigFingerprint, /^gemini-caption-v5-[a-f0-9]{16}$/u);
  await harness.pipeline.start();
  assert.equal(harness.speechSessions.length, 1, "one source STT stream serves every caption lane");
  await harness.pipeline.close();
});

test("legacy audio output modes normalize to captions without an audio callback", async () => {
  const harness = createPipelineHarness({ languages: ["ko"] });
  await harness.pipeline.start();
  assert.equal(harness.pipeline.outputMode, "captions");
  assert.equal(Object.hasOwn(harness.speechSessions[0], "onAudio"), false);
  await harness.pipeline.acceptFinalUtterance(KOREAN_FINAL);
  assert.equal(harness.events.filter((event) => event.type === "caption").length, 1);
  await harness.pipeline.close();
});

test("Gemini translation failure never calls a supplied alternate provider", async () => {
  let fallbackCalls = 0;
  const adapter = new GeminiTextTranslateAdapter({
    client: { models: { async generateContent() { throw new Error("GEMINI_DOWN"); } } },
    fallback: { async translate() { fallbackCalls += 1; return "fallback"; } },
  });
  await assert.rejects(
    adapter.translate({ text: KOREAN_FINAL.text, language: "en", sourceLanguage: "ko", intent: "final" }),
    /GEMINI_DOWN/u,
  );
  assert.equal(fallbackCalls, 0);
});

test("Gemini wrong-language output fails visibly without alternate fallback", async () => {
  let fallbackCalls = 0;
  const adapter = new GeminiTextTranslateAdapter({
    client: { models: { async generateContent() { return { text: KOREAN_FINAL.text }; } } },
    fallback: { async translate() { fallbackCalls += 1; return "fallback"; } },
  });
  await assert.rejects(
    adapter.translate({ text: KOREAN_FINAL.text, language: "en", sourceLanguage: "ko", intent: "final" }),
    /TRANSLATION_WRONG_SCRIPT/u,
  );
  assert.equal(fallbackCalls, 0);
});

test("a failed final reports target health without emitting a raw source substitute", async () => {
  const harness = createPipelineHarness({
    languages: ["en"],
    textTranslate() { throw new Error("GEMINI_TRANSLATE_FAILED"); },
  });
  await harness.pipeline.start();
  await harness.pipeline.acceptFinalUtterance(KOREAN_FINAL);
  const final = harness.events.find((event) => event.type === "caption" && event.isFinal);
  assert.equal(harness.translationCalls.length, 1);
  assert.equal(final, undefined);
  assert.ok(harness.events.some((event) => event.type === "language-status" && event.status === "unavailable"));
  await harness.pipeline.close();
});

test("an empty Gemini final never publishes a synthetic target caption", async () => {
  const harness = createPipelineHarness({ languages: ["ko", "en"], textTranslate() { return ""; } });
  await harness.pipeline.start();
  await harness.pipeline.acceptFinalUtterance(KOREAN_FINAL);
  const source = harness.events.find((event) => event.type === "caption" && event.language === "ko");
  const target = harness.events.find((event) => event.type === "caption" && event.language === "en");
  assert.equal(source?.translationStatus, "verbatim");
  assert.equal(target, undefined);
  assert.doesNotMatch(harness.events.map((event) => String(event.text ?? "")).join(" "), /Translation unavailable/u);
  await harness.pipeline.close();
});

test("one committed final performs at most one text-model translation call", async () => {
  const harness = createPipelineHarness({ languages: ["en"] });
  await harness.pipeline.start();
  await harness.pipeline.acceptFinalUtterance(KOREAN_FINAL);
  assert.equal(harness.translationCalls.length, 1);
  assert.equal(harness.polishCalls.length, 0, "the finalizer must not issue a second model call");
  await harness.pipeline.close();
});

test("interim STT captions bypass both translation and final polish", async () => {
  const harness = createPipelineHarness({ languages: ["ko", "en"] });
  await harness.pipeline.start();
  harness.speechSessions[0].onPartialTranscript({ text: KOREAN_FINAL.text, sourceLanguage: "ko-KR" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.translationCalls.length, 0);
  assert.equal(harness.polishCalls.length, 0);
  const partials = harness.events.filter((event) => event.type === "caption" && !event.isFinal);
  assert.deepEqual(partials.map((event) => event.language), ["ko"]);
  await harness.pipeline.close();
});

test("provider errors never expose API keys or provider URLs in logs or status", async () => {
  const sensitiveKey = "AIza-secret-translation-key";
  const sensitiveUrl = `https://generativelanguage.googleapis.com/live?key=${sensitiveKey}`;
  const logs = [];
  const originalWarn = console.warn;
  console.warn = (...values) => logs.push(values.map(String).join(" "));
  try {
    const harness = createPipelineHarness({
      languages: ["en"],
      textTranslate() { throw new Error(`request failed ${sensitiveUrl}`); },
    });
    await harness.pipeline.start();
    await harness.pipeline.acceptFinalUtterance(KOREAN_FINAL);
    const visible = JSON.stringify({ events: harness.events, logs });
    assert.equal(visible.includes(sensitiveKey), false);
    assert.equal(visible.includes(sensitiveUrl), false);
    assert.equal(visible.includes("generativelanguage.googleapis.com"), false);
    await harness.pipeline.close();
  } finally {
    console.warn = originalWarn;
  }
});
