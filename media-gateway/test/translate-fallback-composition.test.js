import assert from "node:assert/strict";
import test from "node:test";

import { createGeminiServerRuntime } from "../../packages/gemini-server/index.js";
import { GEMINI_ENGINE_SELECTION as DEFAULT_ENGINE_SELECTION } from "../../packages/caption-core/caption-engine-catalog.js";
import { createTextTranslate } from "../src/engines/create-engines.js";

const PRIMARY = DEFAULT_ENGINE_SELECTION.translation.model; // gemini-3.6-flash
const FALLBACK = "gemini-3.5-flash-lite";
const utterance = { text: "매출이 증가했습니다", language: "en", sourceLanguage: "ko", intent: "final" };
const usageMetadata = { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 };

function completedResponse(text) {
  return { candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }], usageMetadata };
}

/** Real runtime + real factory; only the Google SDK is faked, per model id. */
function compose(respondByModel) {
  const calls = [];
  const observations = [];
  class FakeGoogleGenAI {
    constructor() {
      this.models = { async generateContent(request) { calls.push(request); return await respondByModel(request.model, request); } };
      this.live = { connect() { throw new Error("AUDIO_MUST_NOT_OPEN"); } };
    }
  }
  const runtime = createGeminiServerRuntime({ GoogleGenAI: FakeGoogleGenAI, apiKey: "fixture", observe: (event) => observations.push(event) });
  const translator = createTextTranslate({ engine: DEFAULT_ENGINE_SELECTION, geminiRuntime: runtime, sessionId: "fallback-composition" });
  return { translator, calls, observations };
}

async function quietly(run) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...values) => warnings.push(values.join(" "));
  try { return { value: await run(), warnings }; } finally { console.warn = originalWarn; }
}

test("a 5xx from the primary model reaches the adapter as a transient code and the catalog fallback produces the caption", async () => {
  const { translator, calls, observations } = compose(async (model) => {
    if (model === PRIMARY) throw Object.assign(new Error("private 503 body"), { status: 503 });
    return completedResponse("Revenue increased.");
  });
  const { value, warnings } = await quietly(() => translator.translateWithProvenance(utterance));
  assert.deepEqual({ text: value.text, provider: value.provider, model: value.model }, { text: "Revenue increased.", provider: "gemini", model: FALLBACK });
  assert.equal(Number.isSafeInteger(value.latencyMs) && value.latencyMs >= 0, true);
  assert.deepEqual(calls.map((request) => request.model), [PRIMARY, FALLBACK]);
  assert.deepEqual(observations.map(({ workload, model, code }) => ({ workload, model, code })), [
    { workload: "translation", model: PRIMARY, code: "GEMINI_PROVIDER_UNAVAILABLE" },
    { workload: "translation", model: FALLBACK, code: "OK" },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /GEMINI_PROVIDER_UNAVAILABLE/u);
  assert.equal(JSON.stringify({ warnings, observations }).includes("private"), false);
  // translate() keeps the string contract for the pipeline.
  assert.equal(await quietly(() => translator.translate(utterance)).then(({ value: text }) => text), "Revenue increased.");
});

test("a 429 from the primary model also falls through once to the catalog fallback", async () => {
  const { translator, calls, observations } = compose(async (model) => {
    if (model === PRIMARY) throw Object.assign(new Error("private 429 body"), { status: 429 });
    return completedResponse("Revenue increased.");
  });
  const { value } = await quietly(() => translator.translateWithProvenance(utterance));
  assert.equal(value.model, FALLBACK);
  assert.deepEqual(calls.map((request) => request.model), [PRIMARY, FALLBACK]);
  assert.equal(observations[0].code, "GEMINI_PROVIDER_RATE_LIMITED");
});

test("a 4xx client error is final: no fallback model is billed", async () => {
  const { translator, calls, observations } = compose(async (model) => {
    if (model === PRIMARY) throw Object.assign(new Error("private 400 body"), { status: 400 });
    return completedResponse("must not be reached");
  });
  const { value: error } = await quietly(() => translator.translate(utterance).then(() => null, (reason) => reason));
  assert.equal(error.message, "GEMINI_PROVIDER_FAILED");
  assert.deepEqual(calls.map((request) => request.model), [PRIMARY]);
  assert.deepEqual(observations.map(({ code }) => code), ["GEMINI_PROVIDER_FAILED"]);
});
