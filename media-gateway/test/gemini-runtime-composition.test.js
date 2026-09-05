import assert from "node:assert/strict";
import test from "node:test";

import { createGeminiServerRuntime } from "../../packages/gemini-server/index.js";
import { createCaptionPolisher } from "../src/caption-polish.js";
import { GeminiTextTranslateAdapter } from "../src/google-provider-adapters.js";

function createRuntime(respond, options = {}) {
  const calls = [];
  const observations = [];
  class FakeGoogleGenAI {
    constructor(configuration) {
      assert.deepEqual(configuration.httpOptions, { retryOptions: { attempts: 1 } });
      this.models = { generateContent(request) {
        calls.push(request);
        return respond(request);
      } };
      this.live = { connect() { throw new Error("AUDIO_MUST_NOT_OPEN"); } };
    }
  }
  const runtime = createGeminiServerRuntime({
    GoogleGenAI: FakeGoogleGenAI, apiKey: "fixture",
    observe: (event) => observations.push(event), ...options,
  });
  return { runtime, calls, observations };
}

const utterance = { text: "매출이 증가했습니다", language: "en", sourceLanguage: "ko", intent: "final" };
const usageMetadata = { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 };

function completedResponse(text) {
  return { candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }], usageMetadata };
}

test("REST translation adapter composition uses the two-stage translation workload bound to one catalog model, never the retired Live source workload", async () => {
  const { runtime, calls, observations } = createRuntime(async () => completedResponse("Revenue increased."));
  // The adapter and the session client must name the same catalog model: the
  // runtime binds the model at createSessionClient time and rejects request overrides.
  const translator = new GeminiTextTranslateAdapter({
    client: runtime.createSessionClient("caption-session", "translation", { model: "gemini-3.7-flash" }),
    model: "gemini-3.7-flash",
  });
  assert.equal(await translator.translate({ ...utterance, intent: "partial" }), "Revenue increased.");
  assert.equal(await translator.translate(utterance), "Revenue increased.");
  assert.equal(calls.length, 2);
  assert.equal(translator.model, calls[0].model);
  for (const request of calls) {
    assert.equal(request.model, "gemini-3.7-flash");
    assert.deepEqual(request.config.thinkingConfig, { thinkingLevel: "low" });
    assert.ok(request.config.abortSignal instanceof AbortSignal);
    assert.equal(request.config.maxOutputTokens, 1_024);
  }
  assert.deepEqual(observations.map(({ workload, model, code, usageKnown }) => ({ workload, model, code, usageKnown })), [
    { workload: "translation", model: "gemini-3.7-flash", code: "OK", usageKnown: true },
    { workload: "translation", model: "gemini-3.7-flash", code: "OK", usageKnown: true },
  ]);
  assert.throws(() => runtime.createSessionClient("caption-session", "source"), /INVALID_GEMINI_WORKLOAD/u);
  assert.throws(() => runtime.createSessionClient("caption-session", "translation", { model: "gemini-3.5-live-translate-preview" }), /INVALID_GEMINI_MODEL_SELECTION/u);
});

test("real session-bound polish returns a provider final rather than silently retaining its input draft", async () => {
  const { runtime, calls, observations } = createRuntime(async () => completedResponse("Revenue increased significantly."));
  const polisher = createCaptionPolisher({ client: runtime.createSessionClient("caption-session", "polish") });
  assert.equal(await polisher.polish({ translatedText: "Revenue went up.", sourceText: "매출이 크게 증가했습니다",
    targetLanguage: "en", tone: "business" }), "Revenue increased significantly.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "gemini-3.7-flash");
  assert.deepEqual(calls[0].config.thinkingConfig, { thinkingLevel: "low" });
  assert.ok(calls[0].config.abortSignal instanceof AbortSignal);
  assert.equal(observations[0].workload, "polish");
  assert.equal(observations[0].model, "gemini-3.7-flash");
  assert.equal(observations[0].usageKnown, true);
});

test("session-bound callers cannot override even the matching model, workload, session, or thinking policy", async () => {
  const { runtime, calls } = createRuntime(async () => completedResponse("Unused"));
  const client = runtime.createSessionClient("caption-session", "polish");
  const request = { contents: [{ role: "user", parts: [{ text: "Translate" }] }] };
  for (const injected of [{ model: "gemini-3.7-flash" }, { model: "gemini-3.7-flash" },
    { workload: "topic" }, { sessionId: "other-session" }]) {
    await assert.rejects(client.models.generateContent({ ...request, ...injected }), /INVALID_GEMINI_DISPATCH/u);
  }
  await assert.rejects(client.models.generateContent({ ...request, config: { thinkingConfig: { thinkingLevel: "high" } } }),
    /INVALID_GEMINI_GENERATION_CONFIG/u);
  assert.equal(calls.length, 0);
});

test("bound translation provider failure remains one request with unknown usage and no automatic fallback", async () => {
  const { runtime, calls, observations } = createRuntime(async () => { throw new Error("synthetic offline failure"); });
  const translator = new GeminiTextTranslateAdapter({ client: runtime.createSessionClient("caption-session", "polish") });
  await assert.rejects(translator.translate(utterance), /GEMINI_PROVIDER_FAILED/u);
  assert.equal(calls.length, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].usageKnown, false);
});

test("bound translation rejects unfinished or blocked SDK output without dropping usage or adding a request", async () => {
  for (const finishReason of [undefined, "MAX_TOKENS", "SAFETY"]) {
    const { runtime, calls, observations } = createRuntime(async () => ({
      text: "This convenience getter must not bypass a rejected candidate.",
      candidates: [{ finishReason, content: { parts: [{ text: "Revenue increased." }] } }], usageMetadata,
    }));
    const translator = new GeminiTextTranslateAdapter({ client: runtime.createSessionClient("caption-session", "polish") });
    await assert.rejects(translator.translate(utterance), /GEMINI_OUTPUT_INVALID|GEMINI_PROVIDER_REFUSAL/u);
    assert.equal(calls.length, 1);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].usageKnown, true);
    assert.equal(observations[0].totalTokens, 16);
  }
});

test("bound translation timeout aborts its SDK request and retains admission until physical work settles", async () => {
  let finishFirst;
  const firstResponse = new Promise((resolve) => { finishFirst = resolve; });
  let requestNumber = 0;
  const { runtime, calls } = createRuntime(async () => {
    requestNumber += 1;
    return requestNumber === 1 ? firstResponse : completedResponse("Revenue increased.");
  }, { limits: { globalOutstanding: 1, sessionOutstanding: 1 } });
  const translator = new GeminiTextTranslateAdapter({
    client: runtime.createSessionClient("caption-session", "polish"), timeoutMilliseconds: 10,
  });
  await assert.rejects(translator.translate(utterance), /GEMINI_TRANSLATE_TIMEOUT/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.abortSignal.aborted, true);
  await assert.rejects(translator.translate(utterance), /GEMINI_GLOBAL_BUDGET_EXHAUSTED/u);
  assert.equal(calls.length, 1);
  finishFirst(completedResponse("Revenue increased."));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, "settlement must not trigger an automatic provider retry");
  assert.equal(await translator.translate(utterance), "Revenue increased.");
  assert.equal(calls.length, 2, "only a subsequent explicit call may acquire the released slot");
});
