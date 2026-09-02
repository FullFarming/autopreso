import assert from "node:assert/strict";
import test from "node:test";

import { localTermRetrievalContract } from "../../packages/caption-core/index.js";
import {
  GeminiLiveTranscriptionAdapter,
  GeminiTextTranslateAdapter,
  createGeminiCustomVocabulary,
} from "../src/google-provider-adapters.js";
import { SupabaseViewerAuthorizer } from "../src/supabase-adapters.js";
import { LiveMediaPipeline } from "../src/live-media-pipeline.js";

test("Transcribe close waits for physical provider closure and reports a bounded closure timeout", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  for (const stalled of [false, true]) {
    let release;
    let closeCalls = 0;
    const physical = new Promise((resolve) => { release = resolve; });
    const adapter = new GeminiLiveTranscriptionAdapter({ finalDrainMilliseconds: 1,
      client: { live: { async connect() { return { sendRealtimeInput() {}, close() { closeCalls += 1; return physical; } }; } } } });
    const stream = await adapter.open({ onFinalUtterance() {} });
    let resolved = false;
    const closing = stream.close().then(() => { resolved = true; });
    await new Promise((resolve) => setImmediate(resolve));
    context.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeCalls, 1);
    assert.equal(resolved, false, "close cannot resolve before the physical close event");
    if (stalled) {
      context.mock.timers.tick(10_000);
      await closing;
      assert.throws(() => stream.assertDrained(), /STT_DRAIN_TIMEOUT/);
      release();
    } else { release(); await closing; assert.doesNotThrow(() => stream.assertDrained()); }
  }
});

test("real transcription adapter through rolling pipeline preserves raw Unicode and whitespace separately", async () => {
  let callbacks;
  const originals = [];
  const adapter = new GeminiLiveTranscriptionAdapter({ finalDrainMilliseconds: 1,
    client: { live: { async connect(options) { callbacks = options.callbacks; return { sendRealtimeInput() {}, close() {} }; } } } });
  const pipeline = new LiveMediaPipeline({ sessionId: "raw-integration", mode: "meeting", languages: ["ko"], dependencies: {
    speechToText: adapter,
    publisher: { async publish() {}, async persistAuthoritativeSource(input) {
      originals.push(input); return { sourceUtteranceId: input.utteranceKey, sourceSeq: 1, idempotent: false };
    } },
    textTranslate: { async translate() { assert.fail("source-language passthrough must not translate"); } },
  } });
  await pipeline.start();
  const rawText = " 가격을 확인했습니다. ";
  callbacks.onmessage({ serverContent: { inputTranscription: { text: rawText, languageCode: "ko" } } });
  await pipeline.gracefulDrain();
  await pipeline.close();
  assert.equal(originals.length, 1);
  assert.equal(originals[0].rawText, rawText);
  assert.equal(originals[0].normalizedText, "가격을 확인했습니다.");
});

test("raw transcription bounds and unsafe controls cannot be hidden by normalization or trim", async () => {
  let callbacks;
  const finals = [];
  const adapter = new GeminiLiveTranscriptionAdapter({ finalDrainMilliseconds: 1,
    client: { live: { async connect(options) { callbacks = options.callbacks; return { sendRealtimeInput() {}, close() {} }; } } } });
  const stream = await adapter.open({ onFinalUtterance(value) { finals.push(value); } });
  for (const text of [" ".repeat(8001) + "safe", "\nunsafe", "<script>unsafe</script>", "\u202Eunsafe"]) {
    callbacks.onmessage({ serverContent: { inputTranscription: { text, languageCode: "en" } } });
  }
  await stream.close();
  assert.equal(finals.length, 0);
});

test("Gemini 3.5 Live Transcribe opens a TEXT-only VERBATIM session with bounded terminology", async () => {
  const connections = [];
  const compiledGlossary = {
    fingerprint: `sha256:${"a".repeat(64)}`,
    version: 1,
    terms: Array.from({ length: 120 }, (_, index) => ({
      source: `Term ${index}`,
      aliases: [`Alias ${index}`],
      pronunciation: null,
      priority: index,
    })),
  };
  const adapter = new GeminiLiveTranscriptionAdapter({
    client: { live: { async connect(options) {
      connections.push(options);
      return { sendRealtimeInput() {}, close() {} };
    } } },
    languageCodes: ["ko-KR", "en-US"],
    compiledGlossary,
    finalDrainMilliseconds: 5,
  });

  const session = await adapter.open({ async onFinalUtterance() {} });
  assert.equal(connections[0].model, "gemini-3.5-transcribe-live");
  assert.deepEqual(connections[0].config.responseModalities, ["TEXT"]);
  assert.deepEqual(connections[0].config.inputAudioTranscription.languageCodes, ["ko-KR", "en-US"]);
  assert.equal(connections[0].config.inputAudioTranscription.mode, "VERBATIM");
  assert.equal(connections[0].config.inputAudioTranscription.customVocabulary.length, 100);
  assert.deepEqual(connections[0].config.inputAudioTranscription.customVocabulary.slice(0, 3), ["Term 100", "Alias 100", "Term 99"]);
  assert.equal("translationConfig" in connections[0].config, false);
  assert.equal("speechConfig" in connections[0].config, false);
  assert.equal("outputAudioTranscription" in connections[0].config, false);
  await session.close();
});

test("Gemini 3.5 Live Transcribe publishes interim hypotheses separately and commits only provider finals", async () => {
  let callbacks;
  const partials = [];
  const finals = [];
  const adapter = new GeminiLiveTranscriptionAdapter({
    client: { live: { async connect(options) {
      callbacks = options.callbacks;
      return { sendRealtimeInput() {}, close() {} };
    } } },
    languageCodes: [],
    finalDrainMilliseconds: 5,
  });
  const session = await adapter.open({
    onPartialTranscript: (value) => partials.push(value),
    onFinalUtterance: async (value) => finals.push(value),
  });

  callbacks.onmessage({ serverContent: {
    interimInputTranscription: { text: "NOVA 순영업소", languageCode: "ko-KR" },
  } });
  callbacks.onmessage({ serverContent: {
    inputTranscription: { text: "NOVA 순영업소득이 증가했습니다.", languageCode: "ko-KR" },
  } });
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(partials, [{ text: "NOVA 순영업소", sourceLanguage: "ko-KR" }]);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, "NOVA 순영업소득이 증가했습니다.");
  assert.equal(finals[0].sourceLanguage, "ko-KR");
  assert.equal(finals[0].speakerLabel, "1");
  assert.equal(finals[0].sourceStartOffsetMs, 0);
  assert.equal(finals[0].sourceEndOffsetMs, 0);
  await session.close();
});

test("Gemini Transcribe close sends audioStreamEnd and drains a late final before closing", async () => {
  let callbacks;
  let providerClosed = false;
  const sent = [];
  const finals = [];
  const adapter = new GeminiLiveTranscriptionAdapter({
    client: { live: { async connect(options) {
      callbacks = options.callbacks;
      return {
        async sendRealtimeInput(value) {
          sent.push(value);
          if (value.audioStreamEnd) {
            setTimeout(() => callbacks.onmessage({ serverContent: {
              inputTranscription: { text: "drained tail", languageCode: "en-US" },
            } }), 5);
          }
        },
        close() { providerClosed = true; },
      };
    } } },
    finalDrainMilliseconds: 25,
  });
  const session = await adapter.open({ onFinalUtterance: async (value) => finals.push(value.text) });

  await session.sendAudio(new Uint8Array(1_280));
  await session.close();

  assert.equal(sent.some((value) => value.audioStreamEnd === true), true);
  assert.deepEqual(finals, ["drained tail"]);
  assert.equal(providerClosed, true);
});

test("Gemini custom vocabulary rejects malformed compiled input and filters unsafe aliases", () => {
  const compiledGlossary = {
    fingerprint: `sha256:${"b".repeat(64)}`,
    version: 2,
    terms: [
      { source: "Net operating income", aliases: ["NOI"], pronunciation: null, priority: 90 },
      { source: "RevPAR", aliases: ["Revenue per available room"], pronunciation: "레브파", priority: 100 },
    ],
  };
  assert.deepEqual(createGeminiCustomVocabulary(compiledGlossary), [
    "NOI", "RevPAR", "Revenue per available room", "Net operating income",
  ]);
  assert.throws(() => createGeminiCustomVocabulary({
    fingerprint: "not-pinned", version: 1, terms: "not-an-array",
  }), /INVALID_COMPILED_GLOSSARY/u);
  assert.deepEqual(createGeminiCustomVocabulary({
    fingerprint: `sha256:${"c".repeat(64)}`, version: 1,
    terms: [{ source: "safe", aliases: ["<script>"], pronunciation: null, priority: 1 }],
  }), ["safe"]);
});

test("Gemini 3.5 Live Transcribe terminates a connection before the ten-minute provider limit", async () => {
  const timers = [];
  let closes = 0;
  const adapter = new GeminiLiveTranscriptionAdapter({
    client: { live: { async connect() {
      return { sendRealtimeInput() {}, close() { closes += 1; } };
    } } },
    languageCodes: ["en-US"],
    connectionLifetimeMilliseconds: 570_000,
    setTimeoutFn(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeoutFn() {},
  });
  const session = await adapter.open({ async onFinalUtterance() {} });
  const lifetime = timers.find((timer) => timer.delay === 570_000);
  assert.ok(lifetime.delay < 600_000);
  lifetime.callback();
  await assert.rejects(() => session.sendAudio(new Uint8Array(1_280)), /STT_CONNECTION_ROLLOVER_REQUIRED/u);
  assert.equal(closes, 1);
  await session.close();
  assert.equal(closes, 1);
});

test("viewer authorization accepts only a live session in the granted language", async () => {
  const urls = [];
  const signals = [];
  const authorizer = new SupabaseViewerAuthorizer({
    baseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-key",
    async fetchFn(url, init) {
      urls.push(String(url));
      signals.push(init.signal);
      return Response.json([{
        session_id: "session-1",
        grant_id: "grant-1",
        user_id: "viewer-1",
        language: "ko",
        authorized: true,
      }]);
    },
  });
  const abortController = new AbortController();
  assert.equal(await authorizer.authorize(
    { grantId: "grant-1", sessionId: "session-1", userId: "viewer-1" },
    "session-1",
    "ko",
    { signal: abortController.signal },
  ), true);
  assert.equal(signals.every((signal) => signal === abortController.signal), true);
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).pathname, "/rest/v1/rpc/authorize_live_viewer_grants_v1");
  assert.equal(await authorizer.authorize(
    { grantId: "grant-1", sessionId: "another-session", userId: "viewer-1" },
    "session-1",
    "ko",
  ), false);
});

test("Gemini text translation serves BOTH partials and finals without an alternate provider", async () => {
  const calls = [];
  const geminiClient = {
    models: {
      async generateContent(request) {
        calls.push(request);
        if (String(request.contents?.[0]?.parts?.[0]?.text ?? "").includes("실패해줘")) throw new Error("GEMINI_DOWN");
        return { text: "Hello everyone, let us begin." };
      },
    },
  };
  const adapter = new GeminiTextTranslateAdapter({ client: geminiClient });

  // Finals go through Gemini for desktop-parity quality.
  const finalText = await adapter.translate({ text: "안녕하세요 여러분 시작하겠습니다", language: "en", sourceLanguage: "ko-KR", intent: "final" });
  assert.equal(finalText, "Hello everyone, let us begin.");
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0], "model"), false, "the session-bound runtime owns model selection");
  assert.equal("thinkingConfig" in calls[0].config, false, "the server runtime owns fixed thinking policy");
  assert.equal("temperature" in calls[0].config, false);
  assert.equal("topP" in calls[0].config, false);
  assert.equal("topK" in calls[0].config, false);
  assert.ok(calls[0].config.abortSignal instanceof AbortSignal);
  assert.match(String(calls[0].contents[0].parts[0].text), /안녕하세요 여러분 시작하겠습니다/);

  // Partials also go through Gemini — captions are locked to Gemini 3.5.
  const partialText = await adapter.translate({ text: "안녕하", language: "en", sourceLanguage: "ko-KR", intent: "partial" });
  assert.equal(partialText, "Hello everyone, let us begin.");
  assert.equal(calls.length, 2);

  // A Gemini failure is explicit instead of silently changing translation engines.
  await assert.rejects(
    adapter.translate({ text: "실패해줘", language: "en", sourceLanguage: "ko-KR", intent: "final" }),
    /GEMINI_DOWN/u,
  );
});

test("Korean translation prompt preserves only explicit glossary spellings with one request and no blanket capitalization exemption", async () => {
  const calls = [];
  const adapter = new GeminiTextTranslateAdapter({ client: { models: { async generateContent(request) {
    calls.push(request);
    return { text: "노바의 매출이 증가했습니다." };
  } } } });
  await adapter.translate({ text: "NOVA Revenue increased.", language: "ko", sourceLanguage: "en", intent: "final" });
  assert.equal(calls.length, 1);
  const prompt = calls[0].config.systemInstruction;
  assert.match(prompt, /natural Korean translations or Korean transliterations/u);
  assert.match(prompt, /only when the glossary explicitly registers/u);
  assert.match(prompt, /Capitalization alone never authorizes untranslated English/u);
  assert.doesNotMatch(prompt, /Keep company names, personal names, and acronyms verbatim/u);
  assert.equal(Object.hasOwn(calls[0], "model"), false, "the session-bound runtime owns model selection");
});

test("Gemini text failure logs only a safe failure code and propagates", async () => {
  const secret = ["test", "gemini", "marker"].join("-");
  const providerError = new Error(`request https://generativelanguage.googleapis.com?key=${secret}`);
  providerError.code = `Bearer ${secret}`;
  const adapter = new GeminiTextTranslateAdapter({
    client: { models: { async generateContent() { throw providerError; } } },
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values.join(" "));
  try {
    await assert.rejects(
      adapter.translate({ text: "안녕하세요", language: "en", sourceLanguage: "ko-KR", intent: "final" }),
      (error) => error === providerError,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join("\n"), /GEMINI_TRANSLATE_FAILED/u);
  assert.doesNotMatch(warnings.join("\n"), /AIza|Bearer|googleapis\.com|key=/u);
});

test("Gemini text translation rejects output in the wrong script without fallback", async () => {
  const geminiClient = {
    models: {
      // Model echoes Korean back instead of translating: must not surface.
      async generateContent() { return { text: "안녕하세요 여러분" }; },
    },
  };
  const adapter = new GeminiTextTranslateAdapter({ client: geminiClient });
  await assert.rejects(
    adapter.translate({ text: "안녕하세요 여러분", language: "en", sourceLanguage: "ko-KR", intent: "final" }),
    /TRANSLATION_WRONG_SCRIPT/u,
  );
});

test("Gemini text translation rejects markup before target-lane display", async () => {
  const adapter = new GeminiTextTranslateAdapter({
    client: { models: { async generateContent() { return { text: "<b>Hello</b>" }; } } },
  });
  await assert.rejects(
    adapter.translate({ text: "안녕하세요", language: "en", sourceLanguage: "ko-KR", intent: "final" }),
    /TRANSLATION_INVALID/u,
  );
});

test("Gemini text translation injects only relevant glossary terms into each network prompt", async () => {
  const prompts = [];
  const systemInstructions = [];
  const geminiClient = {
    models: {
      async generateContent(request) {
        prompts.push(String(request.contents?.[0]?.parts?.[0]?.text ?? ""));
        systemInstructions.push(String(request.config?.systemInstruction ?? ""));
        return { text: "Hilton Garden Inn conversion is on track." };
      },
    },
  };
  const adapter = new GeminiTextTranslateAdapter({ client: geminiClient });
  const irrelevant = Array.from({ length: 500 }, (_, index) => `무관용어${index} = irrelevant-${index}`).join("\n");
  await adapter.translate({
    text: "힐튼 가든 인 컨버전은 순항 중입니다",
    language: "en",
    sourceLanguage: "ko-KR",
    glossaryText: `[Terms]\n${irrelevant}\n힐튼 가든 인 = Hilton Garden Inn\n컨버전 = conversion`,
    sessionContext: "Company: NOVA\nEvent type: 글로벌 타운홀\nAgenda 1: Global expansion",
    intent: "final",
  });
  assert.match(systemInstructions[0], /SECURITY BOUNDARY/u);
  const promptLines = prompts[0].split("\n");
  const payload = JSON.parse(promptLines[2]);
  assert.match(payload.session_context, /Company: NOVA/u);
  assert.match(payload.session_context, /Agenda 1: Global expansion/u);
  assert.match(payload.glossary, /힐튼 가든 인 = Hilton Garden Inn/);
  assert.match(payload.glossary, /컨버전 = conversion/);
  assert.doesNotMatch(payload.glossary, /무관용어499/u);
  assert.ok(payload.glossary.length <= localTermRetrievalContract.maximumPromptCharacters);
});

test("Gemini text prompt boundary redacts credentials while preserving business figures", async () => {
  let request;
  const adapter = new GeminiTextTranslateAdapter({
    client: { models: { async generateContent(value) { request = value; return { text: "Revenue is 123456." }; } } },
  });
  await adapter.translate({
    text: "매출 123456, 인증 코드 123456, 담당자 user@회사.한국",
    language: "en",
    sourceLanguage: "ko-KR",
    intent: "final",
  });
  const serialized = JSON.stringify(request);
  assert.match(serialized, /매출 123456/u);
  assert.doesNotMatch(serialized, /인증 코드 123456|user@회사\.한국/u);
});

test("Gemini final translation reports invalid output without a second paid attempt", async () => {
  let calls = 0;
  const adapter = new GeminiTextTranslateAdapter({ client: { models: { async generateContent() {
    calls += 1; return { text: "안녕하세요 여러분" };
  } } } });
  await assert.rejects(adapter.translate({ text: "안녕하세요 여러분", language: "en", sourceLanguage: "ko-KR", intent: "final" }), /TRANSLATION_WRONG_SCRIPT/);
  assert.equal(calls, 1);
});

test("Gemini partial translation never retries and provider errors never retry", async () => {
  let partialCalls = 0;
  const partialAdapter = new GeminiTextTranslateAdapter({
    client: {
      models: {
        async generateContent() {
          partialCalls += 1;
          return { text: "안녕하세요" };
        },
      },
    },
  });
  await assert.rejects(
    partialAdapter.translate({ text: "안녕하세요", language: "en", sourceLanguage: "ko-KR", intent: "partial" }),
    /TRANSLATION_WRONG_SCRIPT/u,
  );
  assert.equal(partialCalls, 1);

  let providerCalls = 0;
  const failingAdapter = new GeminiTextTranslateAdapter({
    client: {
      models: {
        async generateContent() {
          providerCalls += 1;
          throw new Error("GEMINI_DOWN");
        },
      },
    },
  });
  await assert.rejects(
    failingAdapter.translate({ text: "안녕하세요", language: "en", sourceLanguage: "ko-KR", intent: "final" }),
    /GEMINI_DOWN/u,
  );
  assert.equal(providerCalls, 1);
});

test("Gemini final translation validates that portable numbers survive translation", async () => {
  let calls = 0;
  const adapter = new GeminiTextTranslateAdapter({
    client: {
      models: {
        async generateContent() {
          calls += 1;
          return {
            text: calls === 1
              ? "Revenue increased significantly this quarter."
              : "Revenue rose 3.5% in 2026.",
          };
        },
      },
    },
  });
  await assert.rejects(adapter.translate({
    text: "2026년 매출이 3.5% 증가했습니다", language: "en", sourceLanguage: "ko-KR", intent: "final",
  }), /TRANSLATION_NUMBER_MISMATCH/);
  assert.equal(calls, 1);

  const persistentAdapter = new GeminiTextTranslateAdapter({
    client: { models: { async generateContent() { return { text: "Revenue increased significantly." }; } } },
  });
  await assert.rejects(
    persistentAdapter.translate({
      text: "2026년 매출이 3.5% 증가했습니다",
      language: "en",
      sourceLanguage: "ko-KR",
      intent: "final",
    }),
    /TRANSLATION_NUMBER_MISMATCH/u,
  );
});

test("Gemini numeric validation permits CJK scale-word conversion and grouping changes", async () => {
  let calls = 0;
  const adapter = new GeminiTextTranslateAdapter({
    client: {
      models: {
        async generateContent() {
          calls += 1;
          // 3억 legitimately becomes 300 million; 125,000 regroups; the digit
          // "3" from 3억 need not survive verbatim.
          return { text: "Revenue is 300 million won, from 125,000 room nights." };
        },
      },
    },
  });
  const translated = await adapter.translate({
    text: "매출은 3억 원이고 125,000 룸나이트에서 나왔습니다",
    language: "en",
    sourceLanguage: "ko-KR",
    intent: "final",
  });
  assert.equal(translated, "Revenue is 300 million won, from 125,000 room nights.");
  assert.equal(calls, 1, "a legitimate scale conversion must not trigger a retry");
});

test("Gemini translation prompt carries previous utterances for pronoun and ellipsis continuity", async () => {
  const prompts = [];
  const systemInstructions = [];
  const adapter = new GeminiTextTranslateAdapter({
    client: {
      models: {
        async generateContent(request) {
          prompts.push(String(request.contents?.[0]?.parts?.[0]?.text ?? ""));
          systemInstructions.push(String(request.config?.systemInstruction ?? ""));
          return { text: "It rose again this quarter." };
        },
      },
    },
  });
  await adapter.translate({
    text: "이번 분기에도 다시 올랐습니다",
    language: "en",
    sourceLanguage: "ko-KR",
    recentSourceText: "순영업소득이 작년에 크게 올랐습니다",
    intent: "final",
  });
  const payload = JSON.parse(prompts[0].split("BEGIN_UNTRUSTED_DATA\n")[1].split("\nEND_UNTRUSTED_DATA")[0]);
  assert.match(payload.previous_utterances, /순영업소득/u);
  assert.equal(payload.utterance, "이번 분기에도 다시 올랐습니다");
  assert.match(systemInstructions[0], /previous_utterances/u);
  assert.match(systemInstructions[0], /number|digit/iu);
});

test("Transcribe aborts a pending connection and closes its late handle without callbacks", async () => {
  let resolveConnect;
  let options;
  let closes = 0;
  let finals = 0;
  const controller = new AbortController();
  const adapter = new GeminiLiveTranscriptionAdapter({ client: { live: { connect(value) {
    options = value; return new Promise((resolve) => { resolveConnect = resolve; });
  } } } });
  const opening = adapter.open({ signal: controller.signal, onFinalUtterance() { finals += 1; } });
  const rejected = assert.rejects(opening, /STT_CONNECT_ABORTED/);
  controller.abort();
  await rejected;
  assert.equal(options.signal.aborted, true);
  options.callbacks.onmessage({ serverContent: { inputTranscription: { text: "late final" } } });
  resolveConnect({ close() { closes += 1; }, sendRealtimeInput() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
  assert.equal(finals, 0);
});

test("Transcribe connect timeout cancels the actual connect signal and never retries", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let options;
  let connects = 0;
  const adapter = new GeminiLiveTranscriptionAdapter({ connectionTimeoutMilliseconds: 500,
    client: { live: { connect(value) { connects += 1; options = value; return new Promise(() => {}); } } } });
  const opening = adapter.open({ onFinalUtterance() {} });
  const rejected = assert.rejects(opening, /STT_CONNECT_TIMEOUT/);
  context.mock.timers.tick(500);
  await rejected;
  assert.equal(options.signal.aborted, true);
  assert.equal(connects, 1);
});

test("Transcribe callback queue overload closes provider and discards queued late callbacks", async () => {
  let options;
  let closes = 0;
  let release;
  let finals = 0;
  const stalled = new Promise((resolve) => { release = resolve; });
  const adapter = new GeminiLiveTranscriptionAdapter({ maxPendingUtterances: 2, finalDrainMilliseconds: 1,
    client: { live: { async connect(value) { options = value; return { close() { closes += 1; }, sendRealtimeInput() {} }; } } } });
  const stream = await adapter.open({ async onFinalUtterance() { finals += 1; await stalled; } });
  for (let index = 0; index < 3; index += 1) options.callbacks.onmessage({ serverContent: { inputTranscription: { text: `final ${index}` } } });
  await assert.rejects(stream.sendAudio(new Uint8Array(1_280)), /STT_UTTERANCE_BACKPRESSURE/);
  assert.equal(closes, 1);
  release();
  await stream.close();
  assert.equal(finals <= 2, true);
});

test("caller cancellation reaches text SDK and never opens a second paid request", async () => {
  const controller = new AbortController();
  let request;
  let calls = 0;
  const adapter = new GeminiTextTranslateAdapter({ client: { models: { generateContent(value) {
    calls += 1; request = value; return new Promise(() => {});
  } } } });
  const translated = adapter.translate({ text: "매출 증가", language: "en", signal: controller.signal });
  const rejected = assert.rejects(translated, /GEMINI_TRANSLATE_ABORTED/);
  await Promise.resolve();
  controller.abort();
  await rejected;
  assert.equal(request.config.abortSignal.aborted, true);
  assert.equal(calls, 1);
  await assert.rejects(adapter.translate({ text: "매출 증가", language: "en", signal: controller.signal }), /GEMINI_TRANSLATE_ABORTED/);
  assert.equal(calls, 1);
});


test("Transcribe coalesces 40ms frames without negative padding and keeps the remaining PCM", async () => {
  const chunks = [];
  const adapter = new GeminiLiveTranscriptionAdapter({ finalDrainMilliseconds: 1,
    client: { live: { async connect() { return { close() {}, sendRealtimeInput(value) { if (value.audio) chunks.push(Buffer.from(value.audio.data, "base64")); } }; } } } });
  const stream = await adapter.open({ onFinalUtterance() {} });
  for (let index = 1; index <= 3; index += 1) await stream.sendAudio(new Uint8Array(1_280).fill(index));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, 3_200);
  await stream.close();
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].subarray(0, 640).every((value) => value === 3), true);
  assert.equal(chunks[1].subarray(640).every((value) => value === 0), true);
});

test("Transcribe bounds pending partial callbacks and cannot enqueue a final after partial failure", async () => {
  let callbacks;
  let partials = 0;
  let finals = 0;
  let closes = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const adapter = new GeminiLiveTranscriptionAdapter({ maxPendingUtterances: 2, finalDrainMilliseconds: 1,
    client: { live: { async connect(options) { callbacks = options.callbacks; return { close() { closes += 1; }, sendRealtimeInput() {} }; } } } });
  const stream = await adapter.open({ onFinalUtterance() { finals += 1; }, onPartialTranscript() { partials += 1; return pending; } });
  for (let index = 0; index < 3; index += 1) callbacks.onmessage({ serverContent: { interimInputTranscription: { text: "partial" } } });
  await assert.rejects(stream.sendAudio(new Uint8Array(1_280)), /STT_PARTIAL_BACKPRESSURE/);
  callbacks.onmessage({ serverContent: { inputTranscription: { text: "late" } } });
  release();
  await stream.close();
  assert.equal(partials, 2);
  assert.equal(finals, 0);
  assert.equal(closes, 1);
});

test("Transcribe ignores provider errors delivered after a successful close", async () => {
  let callbacks;
  const adapter = new GeminiLiveTranscriptionAdapter({ finalDrainMilliseconds: 1,
    client: { live: { async connect(options) { callbacks = options.callbacks; return { close() {}, sendRealtimeInput() {} }; } } } });
  const stream = await adapter.open({ onFinalUtterance() {} });
  await stream.close();
  callbacks.onerror(new Error("late provider detail"));
  callbacks.onclose();
  assert.doesNotThrow(() => stream.assertDrained());
});

test("text translation timeout aborts the SDK request and ignores a late result without retry", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let request;
  let release;
  let calls = 0;
  const adapter = new GeminiTextTranslateAdapter({ timeoutMilliseconds: 100,
    client: { models: { generateContent(value) { calls += 1; request = value; return new Promise((resolve) => { release = resolve; }); } } } });
  const translating = adapter.translate({ text: "매출 증가", language: "en" });
  const rejected = assert.rejects(translating, /GEMINI_TRANSLATE_TIMEOUT/);
  await Promise.resolve();
  context.mock.timers.tick(100);
  await rejected;
  assert.equal(request.config.abortSignal.aborted, true);
  release({ text: "Revenue increased." });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

// --- Catalog model checks and the one-attempt-per-model fallback chain ---

function translateClient(handler) {
  return { models: { async generateContent(request) { return await handler(request); } } };
}

function withQuietWarnings(run) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values.join(" "));
  return Promise.resolve().then(run).finally(() => { console.warn = originalWarn; }).then((value) => ({ value, warnings }));
}

test("adapters accept only catalog Gemini models and default to the catalog selection", () => {
  const live = { live: { connect() {} } };
  assert.equal(new GeminiLiveTranscriptionAdapter({ client: live }).model, "gemini-3.5-transcribe-live");
  assert.equal(new GeminiLiveTranscriptionAdapter({ client: live }).provider, "gemini");
  for (const forbidden of ["gemini-3.5-live-translate-preview", "gemini-3.7-flash", "attacker-model"]) {
    assert.throws(() => new GeminiLiveTranscriptionAdapter({ client: live, model: forbidden }), /GEMINI_MODEL_OVERRIDE_FORBIDDEN/u);
  }
  const text = translateClient(() => ({ text: "unused" }));
  const defaults = new GeminiTextTranslateAdapter({ client: text });
  assert.equal(defaults.model, "gemini-3.6-flash");
  assert.equal(defaults.provider, "gemini");
  assert.deepEqual(defaults.fallbackModels, []);
  for (const model of ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash"]) {
    assert.equal(new GeminiTextTranslateAdapter({ client: text, model }).model, model);
  }
  for (const forbidden of ["gemini-3.5-transcribe-live", "gemini-3.5-live-translate-preview", "stt-rt-v5", "attacker-model"]) {
    assert.throws(() => new GeminiTextTranslateAdapter({ client: text, model: forbidden }), /GEMINI_MODEL_OVERRIDE_FORBIDDEN/u);
  }
  // The chain must be catalog models, distinct from the primary, one client each.
  assert.throws(() => new GeminiTextTranslateAdapter({ client: text, fallbackModels: ["gemini-3.5-flash-lite"], fallbackClients: [] }), /GEMINI_MODEL_OVERRIDE_FORBIDDEN/u);
  assert.throws(() => new GeminiTextTranslateAdapter({ client: text, fallbackModels: ["gemini-3.6-flash"], fallbackClients: [text] }), /GEMINI_MODEL_OVERRIDE_FORBIDDEN/u);
  assert.throws(() => new GeminiTextTranslateAdapter({ client: text, fallbackModels: ["attacker-model"], fallbackClients: [text] }), /GEMINI_MODEL_OVERRIDE_FORBIDDEN/u);
  assert.throws(() => new GeminiTextTranslateAdapter({ client: text, fallbackModels: ["gemini-3.5-flash-lite"], fallbackClients: [{}] }), /GEMINI_TEXT_CLIENT_UNAVAILABLE/u);
  const chained = new GeminiTextTranslateAdapter({ client: text, model: "gemini-3.7-flash", fallbackModels: ["gemini-3.6-flash", "gemini-3.5-flash-lite"], fallbackClients: [text, text] });
  assert.deepEqual(chained.fallbackModels, ["gemini-3.6-flash", "gemini-3.5-flash-lite"]);
  assert.equal(Object.isFrozen(chained.fallbackModels), true);
});

test("a transient provider failure moves to the next catalog model exactly once and never returns to the primary", async () => {
  const calls = [];
  const unavailable = Object.assign(new Error("Service Unavailable"), { status: 503 });
  const primary = translateClient(() => { calls.push("primary"); throw unavailable; });
  const first = translateClient(() => { calls.push("first"); return { text: "Revenue rose." }; });
  const second = translateClient(() => { calls.push("second"); return { text: "must not be reached" }; });
  const adapter = new GeminiTextTranslateAdapter({
    client: primary, model: "gemini-3.6-flash", fallbackModels: ["gemini-3.5-flash-lite", "gemini-3.7-flash"], fallbackClients: [first, second],
  });
  const { value, warnings } = await withQuietWarnings(() => adapter.translate({ text: "매출이 올랐습니다", language: "en", sourceLanguage: "ko-KR", intent: "final" }));
  assert.equal(value, "Revenue rose.");
  assert.deepEqual(calls, ["primary", "first"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /GEMINI_TRANSLATE_FAILED/u);
  assert.match(warnings[0], /gemini-3\.6-flash/u);

  // 429 and 5xx from either `status` or `code` are transient; every chain model is tried once, then the last error propagates.
  const attempts = [];
  const exhausted = new GeminiTextTranslateAdapter({
    client: translateClient(() => { attempts.push("primary"); throw Object.assign(new Error("rate limited"), { code: 429 }); }),
    model: "gemini-3.6-flash",
    fallbackModels: ["gemini-3.5-flash-lite", "gemini-3.7-flash"],
    fallbackClients: [
      translateClient(() => { attempts.push("first"); throw Object.assign(new Error("bad gateway"), { status: 502 }); }),
      translateClient(() => { attempts.push("second"); throw Object.assign(new Error("overloaded"), { status: 503 }); }),
    ],
  });
  const { value: rejected } = await withQuietWarnings(() => exhausted.translate({ text: "매출", language: "en", intent: "final" }).then(() => null, (error) => error));
  assert.equal(rejected.status, 503);
  assert.deepEqual(attempts, ["primary", "first", "second"]);
});

test("quality rejections, caller aborts, and 4xx client errors never trigger a fallback model", async () => {
  const fallbackCalls = [];
  const fallback = translateClient(() => { fallbackCalls.push(1); return { text: "never" }; });
  const build = (handler) => new GeminiTextTranslateAdapter({ client: translateClient(handler), model: "gemini-3.6-flash", fallbackModels: ["gemini-3.5-flash-lite"], fallbackClients: [fallback] });
  const input = { text: "안녕하세요 여러분", language: "en", sourceLanguage: "ko-KR", intent: "final" };
  await withQuietWarnings(async () => {
    await assert.rejects(build(() => ({ text: "안녕하세요 여러분" })).translate(input), /TRANSLATION_WRONG_SCRIPT/u);
    await assert.rejects(build(() => ({ text: "<b>Hi</b>" })).translate(input), /TRANSLATION_INVALID/u);
    await assert.rejects(build(() => { throw Object.assign(new Error("bad request"), { status: 400 }); }).translate(input), /bad request/u);
    await assert.rejects(build(() => { throw new Error("GEMINI_DOWN"); }).translate(input), /GEMINI_DOWN/u);
    const controller = new AbortController();
    const aborting = build(() => new Promise(() => {}));
    const pending = assert.rejects(aborting.translate({ ...input, signal: controller.signal }), /GEMINI_TRANSLATE_ABORTED/u);
    await Promise.resolve();
    controller.abort();
    await pending;
  });
  assert.equal(fallbackCalls.length, 0);
});

test("a fallback runs only inside the caller's remaining deadline, so a primary timeout leaves no second paid attempt", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  const now = () => clock;
  const fallbackCalls = [];
  const fallback = translateClient(() => { fallbackCalls.push(1); return { text: "never" }; });
  const adapter = new GeminiTextTranslateAdapter({
    client: translateClient(() => new Promise(() => {})), model: "gemini-3.6-flash",
    fallbackModels: ["gemini-3.5-flash-lite"], fallbackClients: [fallback], timeoutMilliseconds: 100, now,
  });
  const { value: error } = await withQuietWarnings(async () => {
    const translating = adapter.translate({ text: "매출 증가", language: "en", intent: "final" }).then(() => null, (reason) => reason);
    await Promise.resolve();
    clock = 100;
    context.mock.timers.tick(100);
    return await translating;
  });
  assert.equal(error.message, "GEMINI_TRANSLATE_TIMEOUT");
  assert.equal(fallbackCalls.length, 0);

  // A fast 503 leaves budget: the fallback gets the remainder, not a fresh full timeout.
  let fallbackRequest;
  const budgeted = new GeminiTextTranslateAdapter({
    client: translateClient(() => { clock += 40; throw Object.assign(new Error("overloaded"), { status: 503 }); }),
    model: "gemini-3.6-flash",
    fallbackModels: ["gemini-3.5-flash-lite"],
    fallbackClients: [translateClient((request) => { fallbackRequest = request; return { text: "Revenue rose."}; })],
    timeoutMilliseconds: 1_000,
    now,
  });
  clock = 0;
  const { value } = await withQuietWarnings(() => budgeted.translate({ text: "매출이 올랐습니다", language: "en", sourceLanguage: "ko-KR", intent: "final" }));
  assert.equal(value, "Revenue rose.");
  assert.ok(fallbackRequest.config.abortSignal instanceof AbortSignal);
});

test("translateWithProvenance names the model that actually produced the caption", async () => {
  const primary = translateClient(() => { throw Object.assign(new Error("overloaded"), { status: 503 }); });
  const fallback = translateClient(() => ({ text: "Revenue rose." }));
  let clock = 0;
  const adapter = new GeminiTextTranslateAdapter({
    client: primary, model: "gemini-3.6-flash", fallbackModels: ["gemini-3.5-flash-lite"], fallbackClients: [fallback], now: () => (clock += 7),
  });
  const { value } = await withQuietWarnings(() => adapter.translateWithProvenance({ text: "매출이 올랐습니다", language: "en", sourceLanguage: "ko-KR", intent: "final" }));
  assert.deepEqual(Object.keys(value).sort(), ["latencyMs", "model", "provider", "text"]);
  assert.equal(value.text, "Revenue rose.");
  assert.equal(value.provider, "gemini");
  assert.equal(value.model, "gemini-3.5-flash-lite");
  assert.equal(Number.isSafeInteger(value.latencyMs) && value.latencyMs > 0, true);
  const direct = new GeminiTextTranslateAdapter({ client: fallback, model: "gemini-3.7-flash" });
  assert.equal((await direct.translateWithProvenance({ text: "매출", language: "en", intent: "final" })).model, "gemini-3.7-flash");
});

test("runtime-sanitized transient codes trigger a fallback; the generic failure code does not", async () => {
  for (const [message, expectFallback] of [["GEMINI_PROVIDER_UNAVAILABLE", true], ["GEMINI_PROVIDER_RATE_LIMITED", true], ["GEMINI_PROVIDER_FAILED", false], ["GEMINI_OUTPUT_UNSAFE", false]]) {
    const fallbackCalls = [];
    const adapter = new GeminiTextTranslateAdapter({
      client: translateClient(() => { throw new Error(message); }), model: "gemini-3.6-flash",
      fallbackModels: ["gemini-3.5-flash-lite"], fallbackClients: [translateClient(() => { fallbackCalls.push(1); return { text: "Revenue rose." }; })],
    });
    const { value } = await withQuietWarnings(() => adapter.translate({ text: "매출이 올랐습니다", language: "en", sourceLanguage: "ko-KR", intent: "final" }).then((text) => text, (error) => error));
    if (expectFallback) assert.equal(value, "Revenue rose.", message);
    else assert.equal(value.message, message);
    assert.equal(fallbackCalls.length, expectFallback ? 1 : 0, message);
  }
});

test("each attempt is capped at 2.8 s inside the 6 s total, so a hung primary still leaves the chain time to answer", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  const now = () => clock;
  let primaryRequest;
  let fallbackStartedAt = null;
  let fallbackRequest;
  const adapter = new GeminiTextTranslateAdapter({
    client: translateClient((request) => { primaryRequest = request; return new Promise(() => {}); }),
    model: "gemini-3.6-flash",
    fallbackModels: ["gemini-3.5-flash-lite"],
    fallbackClients: [translateClient((request) => { fallbackStartedAt = clock; fallbackRequest = request; return { text: "Revenue rose." }; })],
    now,
  });
  assert.equal(adapter.timeoutMilliseconds, 6_000);
  assert.equal(adapter.attemptTimeoutMilliseconds, 2_800);
  const { value } = await withQuietWarnings(async () => {
    const translating = adapter.translateWithProvenance({ text: "매출이 올랐습니다", language: "en", sourceLanguage: "ko-KR", intent: "final" });
    for (let tick = 0; tick < 3; tick += 1) await Promise.resolve();
    clock = 2_799;
    context.mock.timers.tick(2_799);
    for (let tick = 0; tick < 3; tick += 1) await Promise.resolve();
    assert.equal(fallbackStartedAt, null, "the primary keeps its full per-attempt budget");
    clock = 2_800;
    context.mock.timers.tick(1);
    return await translating;
  });
  assert.equal(primaryRequest.config.abortSignal.aborted, true, "the hung primary is abandoned at the per-attempt cap");
  assert.equal(fallbackStartedAt, 2_800);
  assert.equal(value.model, "gemini-3.5-flash-lite");
  assert.equal(value.text, "Revenue rose.");
  assert.ok(fallbackRequest.config.abortSignal instanceof AbortSignal);
  assert.throws(() => new GeminiTextTranslateAdapter({ client: translateClient(() => ({})), attemptTimeoutMilliseconds: 0 }), /GEMINI_TRANSLATE_TIMEOUT_INVALID/u);
});
