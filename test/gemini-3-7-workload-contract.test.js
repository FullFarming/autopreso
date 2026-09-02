import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  captionPolishContract,
  GEMINI_WORKLOAD_MODEL_MATRIX,
} from "../packages/caption-core/index.js";
import { evaluateGlossaryQuality } from "../packages/caption-core/glossary-quality-eval.js";
import { CAPTION_ENGINE_CATALOG, DEFAULT_ENGINE_SELECTION, findEngineEntry } from "../packages/caption-core/caption-engine-catalog.js";
import { GENERATE_WORKLOADS, resolveGeminiWorkloadModel } from "../packages/gemini-server/policy.js";
import {
  createGeminiPdfGlossaryExtractor,
  createGeminiServerRuntime,
} from "../packages/gemini-server/index.js";
import { createCaptionPolisher } from "../media-gateway/src/caption-polish.js";
import {
  GeminiLiveTranscriptionAdapter,
  GeminiTextTranslateAdapter,
} from "../media-gateway/src/google-provider-adapters.js";

const TEXT_MODEL = "gemini-3.7-flash";
const TRANSCRIPTION_MODEL = DEFAULT_ENGINE_SELECTION.stt.model;
const TRANSLATION_MODEL = DEFAULT_ENGINE_SELECTION.translation.model;
// Two-stage captions: Transcribe (STT) -> Flash text translation. The REST
// workloads the session runtime may dispatch, in dispatch order for the loop below.
const REST_WORKLOADS = Object.freeze(["topic", "translation", "polish", "recap"]);
const REST_WORKLOAD_MODELS = Object.freeze(["gemini-3.6-flash", TRANSLATION_MODEL, TEXT_MODEL, "gemini-3.6-flash"]);
const THINKING_LEVELS = Object.freeze({
  glossaryExtraction: "medium",
  topic: "low",
  translation: "low",
  polish: "low",
  recap: "medium",
});

function fakeGoogleGenAI(calls, constructions) {
  return class FakeGoogleGenAI {
    constructor(options) {
      constructions.push(options);
      this.models = {
        async generateContent(request) {
          calls.push(request);
          return {
            text: "safe output",
            candidates: [{ finishReason: "STOP", content: { parts: [{ text: "safe output" }] } }],
            usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 },
          };
        },
      };
      this.live = { connect() { throw new Error("unused"); } };
    }
  };
}

test("workload matrix pins transcription to Transcribe Live and text roles to the engine defaults", () => {
  assert.equal(TRANSCRIPTION_MODEL, "gemini-3.5-transcribe-live");
  assert.equal(TRANSLATION_MODEL, "gemini-3.6-flash");
  assert.deepEqual(GEMINI_WORKLOAD_MODEL_MATRIX, {
    transcription: TRANSCRIPTION_MODEL,
    source: TRANSCRIPTION_MODEL,
    glossaryExtraction: TEXT_MODEL,
    topic: "gemini-3.6-flash",
    translation: TRANSLATION_MODEL,
    polish: TEXT_MODEL,
    recap: "gemini-3.6-flash",
  });
  assert.equal(Object.isFrozen(GEMINI_WORKLOAD_MODEL_MATRIX), true);
  // Adapter model checks go through the catalog, not a hard-coded id.
  for (const forbidden of [TEXT_MODEL, "gemini-3.5-live-translate-preview", "attacker-model"]) {
    assert.equal(findEngineEntry("stt", "gemini", forbidden), null);
    assert.throws(
      () => new GeminiLiveTranscriptionAdapter({ client: { live: { connect() {} } }, model: forbidden }),
      /GEMINI_MODEL_OVERRIDE_FORBIDDEN/u,
    );
  }
  assert.doesNotThrow(() => new GeminiLiveTranscriptionAdapter({
    client: { live: { connect() {} } },
    model: TRANSCRIPTION_MODEL,
  }));
  assert.equal(new GeminiLiveTranscriptionAdapter({ client: { live: { connect() {} } } }).model, TRANSCRIPTION_MODEL);
});

test("the translation workload is restored and accepts exactly the catalog translation models", () => {
  assert.deepEqual([...GENERATE_WORKLOADS].sort(), [...REST_WORKLOADS].sort());
  assert.equal(GENERATE_WORKLOADS.has("source"), false, "the retired direct Live Translate path stays out of REST");
  assert.equal(resolveGeminiWorkloadModel("translation"), TRANSLATION_MODEL);
  for (const entry of CAPTION_ENGINE_CATALOG.translation.filter((candidate) => candidate.provider === "gemini")) {
    assert.equal(resolveGeminiWorkloadModel("translation", entry.model), entry.model);
  }
  for (const forbidden of [TRANSCRIPTION_MODEL, "gemini-3.5-live-translate-preview", "stt-rt-v5", "attacker-model"]) {
    assert.throws(() => resolveGeminiWorkloadModel("translation", forbidden), /INVALID_GEMINI_MODEL_SELECTION/u);
  }
  assert.throws(() => resolveGeminiWorkloadModel("polish", TRANSLATION_MODEL), /INVALID_GEMINI_MODEL_SELECTION/u);
  assert.throws(() => resolveGeminiWorkloadModel("source"), /INVALID_GEMINI_WORKLOAD/u);
});

test("SDK runtime owns the exact workload thinking matrix, one-attempt policy, and safe token metrics", async () => {
  const calls = [];
  const constructions = [];
  const observations = [];
  const GoogleGenAI = fakeGoogleGenAI(calls, constructions);
  const runtime = createGeminiServerRuntime({
    GoogleGenAI,
    apiKey: "server-only-key",
    now: (() => { let value = 100; return () => value += 5; })(),
    observe(event) { observations.push(event); },
  });
  const signal = new AbortController().signal;

  for (const workload of REST_WORKLOADS) {
    await runtime.generateContent({
      sessionId: `contract-${workload}`,
      workload,
      contents: [{ role: "user", parts: [{ text: "bounded prompt" }] }],
      config: { maxOutputTokens: 128 },
      signal,
    });
  }

  assert.deepEqual(constructions, [{
    apiKey: "server-only-key",
    httpOptions: { retryOptions: { attempts: 1 } },
  }]);
  assert.equal(calls.length, REST_WORKLOADS.length);
  for (const [index, workload] of REST_WORKLOADS.entries()) {
    assert.equal(calls[index].model, REST_WORKLOAD_MODELS[index]);
    assert.equal(calls[index].config.abortSignal, signal);
    assert.deepEqual(calls[index].config.thinkingConfig, { thinkingLevel: THINKING_LEVELS[workload] });
    for (const deprecated of ["temperature", "topP", "topK", "candidateCount"]) {
      assert.equal(Object.hasOwn(calls[index].config, deprecated), false);
    }
  }
  assert.equal(observations.length, REST_WORKLOADS.length);
  for (const [index, observation] of observations.entries()) {
    assert.deepEqual(Object.keys(observation).sort(), [
      "code", "inputTokens", "latencyMilliseconds", "model", "outputTokens", "totalTokens", "usageKnown", "workload",
    ]);
    assert.equal(observation.workload, REST_WORKLOADS[index]);
    assert.equal(observation.model, REST_WORKLOAD_MODELS[index]);
    assert.equal(observation.code, "OK");
    assert.equal(Number.isSafeInteger(observation.inputTokens), true);
    assert.equal(Number.isSafeInteger(observation.outputTokens), true);
    assert.equal(Number.isSafeInteger(observation.totalTokens), true);
    assert.equal(JSON.stringify(observation).includes("contract-"), false);
    assert.equal(JSON.stringify(observation).includes("bounded prompt"), false);
  }
  await assert.rejects(
    () => runtime.generateContent({
      sessionId: "caller-thinking",
      workload: "polish",
      contents: [{ role: "user", parts: [{ text: "prompt" }] }],
      config: { thinkingConfig: { thinkingLevel: "low" } },
    }),
    /INVALID_GEMINI_GENERATION_CONFIG/u,
  );
  assert.equal(calls.length, REST_WORKLOADS.length, "caller thinking overrides must fail before provider dispatch");

  const unsafeUsageObservations = [];
  const unsafeUsageCalls = [];
  const unsafeUsageRuntime = createGeminiServerRuntime({
    GoogleGenAI: class FakeUnsafeUsageGoogleGenAI {
      constructor() {
        this.models = {
          async generateContent(request) {
            unsafeUsageCalls.push(request);
            return { text: "safe", usageMetadata: { promptTokenCount: "private-token-value" } };
          },
        };
        this.live = { connect() { throw new Error("unused"); } };
      }
    },
    apiKey: "server-only-key",
    observe(event) { unsafeUsageObservations.push(event); },
  });
  await assert.rejects(
    () => unsafeUsageRuntime.generateContent({
      sessionId: "unsafe-usage",
      workload: "polish",
      contents: [{ role: "user", parts: [{ text: "prompt" }] }],
    }),
    /GEMINI_USAGE_INVALID/u,
  );
  assert.equal(unsafeUsageCalls.length, 1);
  assert.equal(unsafeUsageObservations.length, 1);
  assert.deepEqual(unsafeUsageObservations[0], {
    workload: "polish",
    model: TEXT_MODEL,
    latencyMilliseconds: unsafeUsageObservations[0].latencyMilliseconds,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    usageKnown: false,
    code: "GEMINI_USAGE_INVALID",
  });
  assert.equal(Number.isSafeInteger(unsafeUsageObservations[0].latencyMilliseconds), true);
  assert.ok(unsafeUsageObservations[0].latencyMilliseconds >= 0);
  assert.equal(JSON.stringify(unsafeUsageObservations).includes("private-token-value"), false);
});

test("PDF glossary extraction uses medium thinking, the same signal, and exactly one REST attempt", async () => {
  const calls = [];
  const observations = [];
  const signal = new AbortController().signal;
  const extractor = createGeminiPdfGlossaryExtractor({
    apiKey: "server-only-key",
    observe(event) { observations.push(event); },
    async fetchFn(url, options) {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"candidates":[]}' }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.deepEqual(await extractor.extract({
    requestId: "opaque-contract-request",
    pdfBytes: new TextEncoder().encode("%PDF-1.7\n%%EOF\n"),
    sourceLanguage: "ko",
    targetLanguages: ["en"],
    domain: "Commercial real estate",
    signal,
  }), { candidates: [] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent`);
  assert.equal(calls[0].options.signal, signal);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: THINKING_LEVELS.glossaryExtraction });
  for (const deprecated of ["temperature", "topP", "topK", "candidateCount"]) {
    assert.equal(Object.hasOwn(body.generationConfig, deprecated), false);
  }
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0], {
    workload: "glossaryExtraction",
    model: TEXT_MODEL,
    latencyMilliseconds: observations[0].latencyMilliseconds,
    inputTokens: 7,
    outputTokens: 2,
    totalTokens: 9,
    usageKnown: true,
    code: "OK",
  });
  assert.equal(Number.isSafeInteger(observations[0].latencyMilliseconds), true);
  assert.ok(observations[0].latencyMilliseconds >= 0);
});

test("translation and polish keep exact deadlines, abort physical work, and never retry", async () => {
  const requests = [];
  const hangingClient = {
    models: {
      generateContent(request) {
        requests.push(request);
        return new Promise(() => {});
      },
    },
  };
  const defaults = new GeminiTextTranslateAdapter({ client: hangingClient, model: TEXT_MODEL });
  assert.deepEqual(defaults.fallbackModels, [], "the adapter never invents a chain; the factory supplies it from the catalog");
  assert.equal(defaults.timeoutMilliseconds, 6_000);
  assert.equal(defaults.timeoutMilliseconds, captionPolishContract.timeoutMilliseconds);
  assert.equal(defaults.partialTimeoutMilliseconds, 1_200);
  assert.equal(captionPolishContract.timeoutMilliseconds, 6_000);

  const translator = new GeminiTextTranslateAdapter({
    client: hangingClient,
    model: TEXT_MODEL,
    timeoutMilliseconds: 15,
    partialTimeoutMilliseconds: 10,
  });
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await assert.rejects(
      () => translator.translate({ text: "안녕하세요", language: "en", sourceLanguage: "ko", intent: "final" }),
      /GEMINI_TRANSLATE_TIMEOUT/u,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].config.abortSignal.aborted, true);
    assert.equal(Object.hasOwn(requests[0].config, "thinkingConfig"), false,
      "the server runtime, not the adapter caller, owns workload thinking");
    for (const deprecated of ["temperature", "topP", "topK", "candidateCount"]) {
      assert.equal(Object.hasOwn(requests[0].config, deprecated), false);
    }

    const polisher = createCaptionPolisher({ client: hangingClient, model: TEXT_MODEL, timeoutMs: 10 });
    assert.equal(await polisher.polish({
      translatedText: "raw line",
      sourceText: "원문",
      targetLanguage: "en",
      tone: "business",
    }), "raw line");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].config.abortSignal.aborted, true);
    assert.equal(Object.hasOwn(requests[1].config, "thinkingConfig"), false,
      "the server runtime, not the adapter caller, owns workload thinking");
    for (const deprecated of ["temperature", "topP", "topK", "candidateCount"]) {
      assert.equal(Object.hasOwn(requests[1].config, deprecated), false);
    }
  } finally {
    console.warn = originalWarn;
  }
});

test("the existing offline glossary golden fixture keeps deterministic invariants without a provider quality claim", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/glossary-quality-golden-v1.json", import.meta.url),
    "utf8",
  ));
  const metrics = evaluateGlossaryQuality(fixture);

  assert.equal(metrics.model, "deterministic_local_retrieval_v1");
  assert.equal(metrics.result, "pass");
  assert.ok(metrics.targetTermAccuracy >= 0.95);
  assert.equal(metrics.prohibitedRenderingCount, 0);
  assert.equal(metrics.falseCorrectionCount, 0);
  assert.equal(metrics.invariantFailureCount, 0);
  assert.equal(metrics.cacheRepeatMismatchCount, 0);
});


test("REST translation accepts only catalog translation models and defaults to the catalog default", () => {
  // The retired direct Live Translate model and the STT model must be refused outright.
  let calls = 0;
  const client = { models: { generateContent() { calls += 1; throw new Error("must not dispatch"); } } };
  for (const forbidden of ["gemini-3.5-live-translate-preview", TRANSCRIPTION_MODEL, "attacker-model"]) {
    assert.equal(findEngineEntry("translation", "gemini", forbidden), null);
    assert.throws(() => new GeminiTextTranslateAdapter({ client, model: forbidden }), /GEMINI_MODEL_OVERRIDE_FORBIDDEN/u);
  }
  assert.equal(new GeminiTextTranslateAdapter({ client }).model, TRANSLATION_MODEL);
  const entry = findEngineEntry("translation", "gemini", TRANSLATION_MODEL);
  const chained = new GeminiTextTranslateAdapter({
    client, model: TRANSLATION_MODEL, fallbackModels: entry.fallbackModels, fallbackClients: entry.fallbackModels.map(() => client),
  });
  assert.deepEqual(chained.fallbackModels, ["gemini-3.5-flash-lite"]);
  assert.equal(calls, 0);
});
