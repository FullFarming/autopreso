import assert from "node:assert/strict";
import test from "node:test";

import { GeminiTextTranslateAdapter } from "../src/google-provider-adapters.js";
import { LiveMediaPipeline } from "../src/live-media-pipeline.js";

function createPipelineHarness({
  sessionType = "meeting",
  outputMode = "captions_audio",
  languages = ["ko", "en"],
  audioLanguage = languages[0],
  captionPolish = null,
  textTranslate = null,
} = {}) {
  const events = [];
  const audioEvents = [];
  const liveSessions = [];
  let openaiLiveOpenCalls = 0;
  let textToSpeechCalls = 0;
  const dependencies = {
    liveTranslate: {
      async open(options) {
        const session = {
          ...options,
          sent: [],
          async sendAudio(frame, metadata) { this.sent.push({ frame, metadata }); },
          async audioStreamEnd() {},
          async close() {},
        };
        liveSessions.push(session);
        return session;
      },
    },
    openaiLiveTranslate: {
      async open() {
        openaiLiveOpenCalls += 1;
        throw new Error("OPENAI_TRANSLATION_MUST_REMAIN_COLD");
      },
    },
    textTranslate: textTranslate ?? {
      async translate({ text, language }) {
        return language === "en" ? `translated ${text}` : `번역됨 ${text}`;
      },
    },
    captionPolish: captionPolish ?? { async polish({ translatedText }) { return translatedText; } },
    textToSpeech: {
      async *synthesizeStream() {
        textToSpeechCalls += 1;
        yield new Uint8Array([9, 0]);
      },
    },
    publisher: {
      async publish(_sessionId, _language, event, { onLiveEvent } = {}) {
        await onLiveEvent?.(event);
        events.push(event);
      },
      async publishAudio(_sessionId, language, header, pcm) {
        audioEvents.push({ language, header, pcm: Uint8Array.from(pcm) });
      },
      async markLive() {},
    },
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: `gemini-only-${sessionType}`,
    sessionType,
    outputMode,
    voiceProvider: "openai",
    languages,
    audioLanguage,
    glossaryText: "순영업소득 = NOI\n본 거래 = This transaction",
    glossaryPack: "general_cre",
    translationTone: "business",
    domainText: "Commercial real estate",
    geminiModel: "gemini-3.5-live-translate-preview",
    geminiPolishModel: "gemini-3.5-flash",
    captionPolishPolicy: "full",
    dependencies,
  });
  return {
    pipeline,
    events,
    audioEvents,
    liveSessions,
    get openaiLiveOpenCalls() { return openaiLiveOpenCalls; },
    get textToSpeechCalls() { return textToSpeechCalls; },
  };
}

test("Live Call canonical config is Gemini-only and matches its public fingerprint", async () => {
  const harness = createPipelineHarness();
  assert.equal(harness.pipeline.captionConfig.provider, "gemini");
  assert.equal(harness.pipeline.captionConfig.voiceProvider, "gemini");
  assert.equal(Object.isFrozen(harness.pipeline.captionConfig), true);
  assert.equal(typeof harness.pipeline.captionConfigFingerprint, "string");
  assert.match(harness.pipeline.captionConfigFingerprint, /^gemini-caption-v1-[a-f0-9]{16}$/u);
  await harness.pipeline.start();
  assert.equal(harness.openaiLiveOpenCalls, 0);
  await harness.pipeline.close();
});

test("meeting and presentation translated audio both come from the same Gemini onAudio callback", async () => {
  for (const sessionType of ["meeting", "presentation"]) {
    const harness = createPipelineHarness({ sessionType, languages: ["ko", "en"], audioLanguage: "ko" });
    await harness.pipeline.start();
    assert.equal(harness.openaiLiveOpenCalls, 0, `${sessionType} must not open OpenAI live translation`);
    assert.equal(harness.liveSessions.length, 2);
    const pcm = new Uint8Array([1, 0, 2, 0]);
    const korean = harness.liveSessions.find((session) => session.language === "ko");
    await korean.onAudio({ sampleRate: 24_000, pcm, sourceLanguage: "en" });
    assert.equal(harness.audioEvents.length, 1, `${sessionType} must publish Gemini translated audio`);
    assert.equal(harness.audioEvents[0].language, "ko");
    assert.deepEqual(harness.audioEvents[0].pcm, pcm);
    await harness.pipeline.close();
  }
});

test("accepted finals never start a separate TTS translation stream", async () => {
  const harness = createPipelineHarness({ outputMode: "audio", languages: ["en"] });
  await harness.pipeline.start();
  await harness.pipeline.acceptFinalUtterance({
    speakerLabel: "Host",
    text: "순영업소득을 검토합니다.",
    sourceLanguage: "ko-KR",
    sourceEndedAt: "2026-07-27T09:00:00.000Z",
  });
  assert.equal(harness.textToSpeechCalls, 0, "translated audio must only come from Gemini Live onAudio");

  const pcm = new Uint8Array([1, 0, 2, 0]);
  await harness.liveSessions[0].onAudio({ sampleRate: 24_000, pcm, sourceLanguage: "ko" });
  assert.equal(harness.audioEvents.length, 1);
  assert.deepEqual(harness.audioEvents[0].pcm, pcm);
  await harness.pipeline.close();
});

test("Gemini translation failure never calls a supplied non-Gemini fallback", async () => {
  let fallbackCalls = 0;
  const fallback = {
    async translate() {
      fallbackCalls += 1;
      return "machine fallback must not surface";
    },
  };
  const adapter = new GeminiTextTranslateAdapter({
    client: { models: { async generateContent() { throw new Error("GEMINI_DOWN"); } } },
    fallback,
  });

  await assert.rejects(
    adapter.translate({
      text: "순영업소득을 검토합니다.",
      language: "en",
      sourceLanguage: "ko",
      glossaryText: "순영업소득 = NOI",
      intent: "final",
    }),
    /GEMINI_DOWN/u,
  );
  assert.equal(fallbackCalls, 0);
});

test("Gemini wrong-language output also fails visibly without machine translation fallback", async () => {
  let fallbackCalls = 0;
  const adapter = new GeminiTextTranslateAdapter({
    client: { models: { async generateContent() { return { text: "순영업소득을 검토합니다." }; } } },
    fallback: { async translate() { fallbackCalls += 1; return "cloud result"; } },
  });
  await assert.rejects(
    adapter.translate({ text: "순영업소득을 검토합니다.", language: "en", sourceLanguage: "ko", intent: "final" }),
    /TRANSLATION_WRONG_SCRIPT/u,
  );
  assert.equal(fallbackCalls, 0);
});

test("a failed Gemini final is retained as raw provenance but marked failed and hidden from target display", async () => {
  let translationCalls = 0;
  const harness = createPipelineHarness({
    outputMode: "captions",
    languages: ["en"],
    textTranslate: {
      async translate() {
        translationCalls += 1;
        throw new Error("GEMINI_TRANSLATE_FAILED");
      },
    },
  });
  await harness.pipeline.start();
  await harness.pipeline.acceptFinalUtterance({
    speakerLabel: "Host",
    text: "순영업소득을 검토합니다.",
    sourceLanguage: "ko-KR",
    sourceEndedAt: "2026-07-27T09:00:00.000Z",
  });

  const final = harness.events.find((event) => event.type === "caption" && event.isFinal);
  assert.equal(translationCalls, 1);
  assert.equal(final.text, "순영업소득을 검토합니다.");
  assert.equal(final.sourceText, "순영업소득을 검토합니다.");
  assert.equal(final.translationStatus, "failed");
  assert.equal(final.language, "en");
  assert.ok(
    harness.events.some((event) => event.type === "language-status" && event.status === "unavailable"),
    "the client needs a visible unavailable state instead of a silent provider switch",
  );
  await harness.pipeline.close();
});

test("an empty Gemini final never publishes a synthetic error caption", async () => {
  let translationCalls = 0;
  const harness = createPipelineHarness({
    outputMode: "captions",
    languages: ["ko", "en"],
    textTranslate: {
      async translate() {
        translationCalls += 1;
        return "";
      },
    },
  });
  await harness.pipeline.start();
  await harness.pipeline.acceptFinalUtterance({
    speakerLabel: "Host",
    text: "발표를 시작합니다.",
    sourceLanguage: "ko-KR",
    sourceEndedAt: "2026-07-27T09:00:00.000Z",
  });

  const sourceFinal = harness.events.find((event) => event.type === "caption"
    && event.isFinal && event.language === "ko");
  const targetFinal = harness.events.find((event) => event.type === "caption"
    && event.isFinal && event.language === "en");
  assert.equal(translationCalls, 1);
  assert.equal(sourceFinal.text, "발표를 시작합니다.", "the source lane remains the raw record");
  assert.equal(sourceFinal.translationStatus, "verbatim");
  assert.equal(targetFinal, undefined, "the failed target final must not displace the last valid caption");
  assert.doesNotMatch(harness.events.map((event) => String(event.text ?? "")).join(" "),
    /Translation unavailable|번역을 (?:표시할|사용할) 수 없습니다/u);
  assert.ok(harness.events.some((event) => event.type === "language-status" && event.status === "unavailable"));
  await harness.pipeline.close();
});

test("one direct final performs at most one text-model call", async () => {
  let translationCalls = 0;
  let polishCalls = 0;
  const harness = createPipelineHarness({
    outputMode: "captions",
    languages: ["en"],
    textTranslate: {
      async translate() {
        translationCalls += 1;
        return "The company reported its result.";
      },
    },
    captionPolish: {
      async polish({ translatedText }) {
        polishCalls += 1;
        return translatedText;
      },
    },
  });
  await harness.pipeline.start();
  await harness.pipeline.acceptFinalUtterance({
    speakerLabel: "Host",
    text: "순영업소득을 검토합니다.",
    sourceLanguage: "ko-KR",
    sourceEndedAt: "2026-07-27T09:00:00.000Z",
  });

  assert.equal(translationCalls, 1);
  assert.equal(polishCalls, 0, "the same final must not make a second 3.6 request");
  await harness.pipeline.close();
});

test("both directions keep partial work below the final budget and partials bypass final polish", async () => {
  const adapter = new GeminiTextTranslateAdapter({
    client: { models: { async generateContent() { return { text: "unused" }; } } },
  });
  assert.ok(adapter.partialTimeoutMilliseconds <= 1_200);
  assert.ok(adapter.partialTimeoutMilliseconds < adapter.timeoutMilliseconds);

  for (const [language, text] of [["ko", "영업실적을 검토합니다."], ["en", "We are reviewing performance."]]) {
    let polishCalls = 0;
    const harness = createPipelineHarness({
      outputMode: "captions",
      languages: [language],
      captionPolish: {
        async polish({ translatedText }) {
          polishCalls += 1;
          return translatedText;
        },
      },
    });
    await harness.pipeline.start();
    await harness.liveSessions[0].onCaption({ text, isFinal: false, utteranceKey: `partial-${language}` });
    assert.equal(polishCalls, 0, `${language} partial must never wait for final polish`);
    await harness.pipeline.close();
  }
});

test("a one-language presentation publishes its same-language source caption", async () => {
  const harness = createPipelineHarness({
    sessionType: "presentation",
    outputMode: "captions",
    languages: ["ko"],
  });
  await harness.pipeline.start();
  const korean = harness.liveSessions.find((session) => session.language === "ko");
  await korean.onInputCaption({
    text: "순영업소득을 검토합니다.",
    languageCode: "ko-KR",
    isFinal: true,
    utteranceKey: "same-language-source",
  });
  const caption = harness.events.find((event) => event.type === "caption" && event.isFinal);
  assert.equal(caption?.language, "ko");
  assert.equal(caption?.text, "순영업소득을 검토합니다.");
  assert.equal(caption?.translationStatus, "verbatim");
  await harness.pipeline.close();
});

test("a one-language presentation publishes the configured other-language translation", async () => {
  const harness = createPipelineHarness({
    sessionType: "presentation",
    outputMode: "captions",
    languages: ["en"],
  });
  await harness.pipeline.start();
  const english = harness.liveSessions.find((session) => session.language === "en");
  await english.onInputCaption({
    text: "순영업소득을 검토합니다.",
    languageCode: "ko-KR",
    isFinal: true,
    utteranceKey: "other-language-source",
  });
  await english.onCaption({
    text: "We are reviewing NOI.",
    languageCode: "en-US",
    sourceText: "순영업소득을 검토합니다.",
    sourceLanguage: "ko-KR",
    isFinal: true,
    utteranceKey: "other-language-source",
  });
  const caption = harness.events.find((event) => event.type === "caption" && event.isFinal);
  assert.equal(caption?.language, "en");
  assert.equal(caption?.text, "We are reviewing NOI.");
  assert.equal(caption?.translationStatus, "translated");
  await harness.pipeline.close();
});

test("same-language Gemini audio is suppressed as source echo", async () => {
  const harness = createPipelineHarness({
    sessionType: "presentation",
    outputMode: "audio",
    languages: ["ko"],
    audioLanguage: "ko",
  });
  await harness.pipeline.start();
  const korean = harness.liveSessions.find((session) => session.language === "ko");
  await korean.onInputCaption({
    text: "순영업소득을 검토합니다.",
    languageCode: "ko-KR",
    isFinal: false,
    utteranceKey: "same-language-audio",
  });
  await korean.onAudio({ sampleRate: 24_000, pcm: new Uint8Array([1, 0, 2, 0]), sourceLanguage: "ko" });
  assert.equal(harness.audioEvents.length, 0, "the source-language lane must not replay the speaker's own audio");
  await harness.pipeline.close();
});

test("Gemini audio publishes only the configured audioLanguage lane", async () => {
  const harness = createPipelineHarness({
    sessionType: "presentation",
    outputMode: "audio",
    languages: ["ko", "en"],
    audioLanguage: "en",
  });
  await harness.pipeline.start();
  const pcm = new Uint8Array([1, 0, 2, 0]);
  const korean = harness.liveSessions.find((session) => session.language === "ko");
  const english = harness.liveSessions.find((session) => session.language === "en");
  await korean.onAudio({ sampleRate: 24_000, pcm, sourceLanguage: "en" });
  await english.onAudio({ sampleRate: 24_000, pcm, sourceLanguage: "ko" });
  assert.deepEqual(harness.audioEvents.map((event) => event.language), ["en"]);
  await harness.pipeline.close();
});

test("provider errors never expose API keys or provider URLs in logs or public status", async () => {
  const sensitiveKey = "AIza-secret-translation-key";
  const sensitiveUrl = `https://generativelanguage.googleapis.com/live?key=${sensitiveKey}`;
  const logs = [];
  const originalWarn = console.warn;
  console.warn = (...values) => logs.push(values.map(String).join(" "));
  try {
    const harness = createPipelineHarness({
      outputMode: "captions",
      languages: ["en"],
      textTranslate: {
        async translate() { throw new Error(`request failed ${sensitiveUrl}`); },
      },
    });
    await harness.pipeline.start();
    await harness.pipeline.acceptFinalUtterance({
      text: "순영업소득을 검토합니다.",
      sourceLanguage: "ko-KR",
      sourceEndedAt: "2026-07-27T09:00:00.000Z",
    });
    const visible = JSON.stringify({ events: harness.events, logs });
    assert.equal(visible.includes(sensitiveKey), false);
    assert.equal(visible.includes(sensitiveUrl), false);
    assert.equal(visible.includes("generativelanguage.googleapis.com"), false);
    const unavailable = harness.events.find((event) => event.type === "language-status" && event.status === "unavailable");
    assert.match(unavailable?.code ?? "", /^[A-Z][A-Z0-9_]*$/u);
    await harness.pipeline.close();
  } finally {
    console.warn = originalWarn;
  }
});
