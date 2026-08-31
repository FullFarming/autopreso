import assert from "node:assert/strict";
import test from "node:test";

import {
  createGeminiServerRuntime,
  GEMINI_SERVER_WORKLOAD_MODELS,
} from "./index.js";
import { parseUsage } from "./policy.js";

function createFakeGoogleGenAI(handler) {
  const constructions = [];
  class FakeGoogleGenAI {
    constructor(options) {
      constructions.push(options);
      this.models = { generateContent: handler };
      this.live = { connect() { throw new Error("unused"); } };
    }
  }
  return { FakeGoogleGenAI, constructions };
}

test("token observations distinguish unknown usage from an explicitly reported zero", () => {
  const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  assert.deepEqual(parseUsage(undefined), { ...zero, usageKnown: false });
  assert.deepEqual(parseUsage({}), { ...zero, usageKnown: false });
  assert.deepEqual(parseUsage({ promptTokenCount: 7 }), { ...zero, inputTokens: 7, usageKnown: false });
  assert.deepEqual(parseUsage({ promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }), { ...zero, usageKnown: true });
  assert.throws(() => parseUsage({ promptTokenCount: -1 }), /GEMINI_USAGE_INVALID/u);
});

test("rejected paid responses retain their actual usage and network failures remain unknown without retry", async () => {
  const usageMetadata = { promptTokenCount: 11, candidatesTokenCount: 4, totalTokenCount: 15 };
  const responses = [
    { text: "<b>unsafe</b>", usageMetadata },
    { promptFeedback: { blockReason: "SAFETY" }, usageMetadata },
    { usageMetadata },
    new Error("NETWORK_FAILED"),
    { text: "safe" },
  ];
  const observations = [];
  let calls = 0;
  const { FakeGoogleGenAI } = createFakeGoogleGenAI(async () => {
    calls++;
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  });
  const runtime = createGeminiServerRuntime({ GoogleGenAI: FakeGoogleGenAI, apiKey: "fixture", observe: (event) => observations.push(event) });
  const request = { sessionId: "usage-fixture", workload: "translation", contents: [{ role: "user", parts: [{ text: "Translate." }] }] };
  for (const code of ["GEMINI_OUTPUT_UNSAFE", "GEMINI_PROVIDER_REFUSAL", "GEMINI_OUTPUT_INVALID", "GEMINI_PROVIDER_FAILED"]) {
    await assert.rejects(runtime.generateContent(request), new RegExp(code, "u"));
  }
  await runtime.generateContent(request);
  assert.equal(calls, 5);
  assert.equal(observations.length, 5);
  for (const event of observations.slice(0, 3)) {
    assert.equal(event.usageKnown, true);
    assert.deepEqual([event.inputTokens, event.outputTokens, event.totalTokens], [11, 4, 15]);
  }
  assert.ok(observations.slice(3).every((event) => event.usageKnown === false));
});

test("server runtime constructs one no-retry client and dispatches only fixed workload models", async () => {
  const calls = [];
  const observations = [];
  const { FakeGoogleGenAI, constructions } = createFakeGoogleGenAI(async (request) => {
    calls.push(request);
    return {
      text: "정상 응답",
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4, totalTokenCount: 15 },
    };
  });
  const runtime = createGeminiServerRuntime({
    GoogleGenAI: FakeGoogleGenAI,
    apiKey: "server-only-key",
    now: (() => { let value = 10; return () => value += 5; })(),
    observe(event) { observations.push(event); },
  });
  const signal = new AbortController().signal;
  const result = await runtime.generateContent({
    sessionId: "session-1",
    workload: "translation",
    contents: [{ role: "user", parts: [{ text: `담당자@회사.한국 ${"A".repeat(43)} 매출 123456` }] }],
    config: { systemInstruction: "Translate safely.", maxOutputTokens: 128 },
    signal,
  });

  assert.deepEqual(constructions, [{
    apiKey: "server-only-key",
    httpOptions: { retryOptions: { attempts: 1 } },
  }]);
  assert.equal(calls[0].model, GEMINI_SERVER_WORKLOAD_MODELS.translation);
  assert.equal(calls[0].config.abortSignal, signal);
  assert.equal("temperature" in calls[0].config, false);
  assert.equal("topP" in calls[0].config, false);
  assert.equal("topK" in calls[0].config, false);
  assert.equal(JSON.stringify(calls[0]).includes("담당자@회사.한국"), false);
  assert.equal(JSON.stringify(calls[0]).includes("A".repeat(43)), false);
  assert.equal(JSON.stringify(calls[0]).includes("매출 123456"), true);
  assert.deepEqual(result, { outputText: "정상 응답" });
  const sessionClient = runtime.createSessionClient("session-1", "polish");
  assert.deepEqual(await sessionClient.models.generateContent({
    contents: [{ role: "user", parts: [{ text: "polish" }] }],
    config: { maxOutputTokens: 64, abortSignal: signal },
  }), { text: "정상 응답" });
  assert.equal(calls[1].model, GEMINI_SERVER_WORKLOAD_MODELS.polish);
  assert.deepEqual(observations[0], {
    workload: "translation",
    model: "gemini-3.7-flash",
    latencyMilliseconds: 5,
    inputTokens: 11,
    outputTokens: 4,
    totalTokens: 15,
    usageKnown: true,
    code: "OK",
  });
  assert.deepEqual(calls[0].config.thinkingConfig, { thinkingLevel: "low" });
  assert.deepEqual(Object.keys(observations[0]).sort(), [
    "code", "inputTokens", "latencyMilliseconds", "model", "outputTokens", "totalTokens", "usageKnown", "workload",
  ]);
  assert.equal(JSON.stringify(observations).includes("session-1"), false);
});

test("every SDK prompt boundary redacts a raw six-digit field but preserves contextual business figures", async () => {
  const calls = [];
  const { FakeGoogleGenAI } = createFakeGoogleGenAI(async (request) => {
    calls.push(request);
    return { text: "safe" };
  });
  const runtime = createGeminiServerRuntime({ GoogleGenAI: FakeGoogleGenAI, apiKey: "server-only-key" });
  for (const workload of ["topic", "translation", "polish", "recap"]) {
    await runtime.generateContent({
      sessionId: `session-${workload}`,
      workload,
      contents: [{ role: "user", parts: [{ text: "123456" }, { text: "매출 123456" }] }],
      config: { systemInstruction: "123456" },
    });
  }
  for (const call of calls) {
    assert.equal(call.contents[0].parts[0].text, "[CODE]");
    assert.equal(call.contents[0].parts[1].text, "매출 123456");
    assert.equal(call.config.systemInstruction, "[CODE]");
  }
  assert.deepEqual(calls.map((call) => call.config.thinkingConfig?.thinkingLevel), ["low", "low", "low", "medium"]);
});

test("outstanding provider work retains global and session slots after caller timeout", async () => {
  let releaseFirst;
  let calls = 0;
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });
  const { FakeGoogleGenAI } = createFakeGoogleGenAI(async () => {
    calls += 1;
    if (calls === 1) return firstResponse;
    return { text: "후속 응답" };
  });
  const runtime = createGeminiServerRuntime({
    GoogleGenAI: FakeGoogleGenAI,
    apiKey: "server-only-key",
    limits: { globalOutstanding: 1, sessionOutstanding: 1 },
  });
  const underlying = runtime.generateContent({
    sessionId: "session-1", workload: "polish",
    contents: [{ role: "user", parts: [{ text: "first" }] }],
  });
  await assert.rejects(
    () => Promise.race([underlying, Promise.reject(new Error("CALLER_TIMEOUT"))]),
    /CALLER_TIMEOUT/u,
  );
  await assert.rejects(
    () => runtime.generateContent({
      sessionId: "session-1", workload: "polish",
      contents: [{ role: "user", parts: [{ text: "second" }] }],
    }),
    /GEMINI_GLOBAL_BUDGET_EXHAUSTED/u,
  );
  releaseFirst({ text: "첫 응답" });
  await underlying;
  assert.deepEqual(await runtime.generateContent({
    sessionId: "session-1", workload: "polish",
    contents: [{ role: "user", parts: [{ text: "third" }] }],
  }), { outputText: "후속 응답" });
});

test("recap has no model input and returns only schema-valid caller-validated values", async () => {
  const responses = [
    { text: '{"summary":"임대 현황","actions":["검토"]}' },
    { text: '{"summary":"임대 현황","actions":[],"unknown":true}' },
    { promptFeedback: { blockReason: "SAFETY" } },
  ];
  const calls = [];
  const { FakeGoogleGenAI } = createFakeGoogleGenAI(async (request) => {
    calls.push(request);
    return responses.shift();
  });
  const runtime = createGeminiServerRuntime({ GoogleGenAI: FakeGoogleGenAI, apiKey: "server-only-key" });
  const responseJsonSchema = {
    type: "object", additionalProperties: false, required: ["summary", "actions"],
    properties: {
      summary: { type: "string" },
      actions: { type: "array", items: { type: "string" } },
    },
  };
  const request = {
    sessionId: "session-1",
    systemInstruction: "Summarize.",
    prompt: "회의를 요약하세요.",
    responseJsonSchema,
    validate(value) { return { summary: value.summary, actions: [...value.actions] }; },
  };

  assert.deepEqual(await runtime.generateRecap(request), { summary: "임대 현황", actions: ["검토"] });
  assert.equal(calls[0].model, GEMINI_SERVER_WORKLOAD_MODELS.recap);
  assert.deepEqual(calls[0].config.thinkingConfig, { thinkingLevel: "medium" });
  assert.equal(Object.hasOwn(request, "model"), false);
  await assert.rejects(() => runtime.generateRecap(request), /GEMINI_OUTPUT_SCHEMA_INVALID/u);
  await assert.rejects(() => runtime.generateRecap(request), /GEMINI_PROVIDER_REFUSAL/u);
  await assert.rejects(() => runtime.generateRecap({ ...request, model: "other-model" }), /INVALID_GEMINI_RECAP_REQUEST/u);
});

test("runtime rejects unknown workloads, deprecated sampling, unsafe output, and non-numeric usage", async () => {
  const responses = [
    { text: "<b>markup</b>" },
    { text: "NFC 가" },
    { text: "safe", usageMetadata: { promptTokenCount: "secret" } },
  ];
  const { FakeGoogleGenAI } = createFakeGoogleGenAI(async () => responses.shift());
  const runtime = createGeminiServerRuntime({ GoogleGenAI: FakeGoogleGenAI, apiKey: "server-only-key" });
  const base = { sessionId: "session-1", workload: "topic", contents: [{ role: "user", parts: [{ text: "prompt" }] }] };

  await assert.rejects(() => runtime.generateContent({ ...base, workload: "unknown" }), /INVALID_GEMINI_WORKLOAD/u);
  await assert.rejects(() => runtime.generateContent({ ...base, config: { temperature: 0 } }), /INVALID_GEMINI_GENERATION_CONFIG/u);
  await assert.rejects(() => runtime.generateContent({ ...base, config: { thinkingConfig: { thinkingLevel: "low" } } }), /INVALID_GEMINI_GENERATION_CONFIG/u);
  await assert.rejects(() => runtime.generateContent(base), /GEMINI_OUTPUT_UNSAFE/u);
  await assert.rejects(() => runtime.generateContent(base), /GEMINI_OUTPUT_UNSAFE/u);
  await assert.rejects(() => runtime.generateContent(base), /GEMINI_USAGE_INVALID/u);
});

test("request-rate and schema bounds reject before provider dispatch without leaking provider messages", async () => {
  let calls = 0;
  const observations = [];
  const { FakeGoogleGenAI } = createFakeGoogleGenAI(async () => {
    calls += 1;
    throw new Error("GEMINI_PRIVATE_SECRET_private@example.com");
  });
  const runtime = createGeminiServerRuntime({
    GoogleGenAI: FakeGoogleGenAI,
    apiKey: "server-only-key",
    limits: {
      globalOutstanding: 2,
      sessionOutstanding: 2,
      globalRequestsPerMinute: 1,
      sessionRequestsPerMinute: 1,
    },
    observe(event) { observations.push(event); },
  });
  const base = {
    sessionId: "session-1",
    workload: "translation",
    contents: [{ role: "user", parts: [{ text: "safe prompt" }] }],
  };
  await assert.rejects(() => runtime.generateContent(base), /^Error: GEMINI_PROVIDER_FAILED$/u);
  await assert.rejects(() => runtime.generateContent(base), /GEMINI_GLOBAL_RATE_LIMITED/u);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(observations).includes("private@example.com"), false);

  const recapRuntime = createGeminiServerRuntime({
    GoogleGenAI: FakeGoogleGenAI,
    apiKey: "server-only-key",
  });
  await assert.rejects(() => recapRuntime.generateRecap({
    sessionId: "session-2",
    systemInstruction: "x".repeat(10_001),
    prompt: "safe",
    responseJsonSchema: { type: "object", additionalProperties: false, properties: {} },
    validate: (value) => value,
  }), /INVALID_GEMINI_GENERATION_CONFIG/u);
  const deeplyNestedSchema = { type: "string" };
  for (let index = 0; index < 9; index += 1) {
    deeplyNestedSchema.items = { ...deeplyNestedSchema };
    deeplyNestedSchema.type = "array";
  }
  await assert.rejects(() => recapRuntime.generateRecap({
    sessionId: "session-2",
    systemInstruction: "safe",
    prompt: "safe",
    responseJsonSchema: deeplyNestedSchema,
    validate: (value) => value,
  }), /INVALID_GEMINI_RECAP_REQUEST/u);
  assert.equal(calls, 1);
});

test("rejected semaphore admission spends no rate quota and expired session windows are evicted", async () => {
  let releaseFirst;
  let currentTime = 0;
  let calls = 0;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const { FakeGoogleGenAI } = createFakeGoogleGenAI(async () => {
    calls += 1;
    if (calls === 1) return first;
    return { text: "safe" };
  });
  const runtime = createGeminiServerRuntime({
    GoogleGenAI: FakeGoogleGenAI,
    apiKey: "server-only-key",
    now: () => currentTime,
    limits: {
      globalOutstanding: 1,
      sessionOutstanding: 1,
      globalRequestsPerMinute: 2,
      sessionRequestsPerMinute: 2,
      maximumTrackedSessions: 1,
    },
  });
  const request = (sessionId) => ({
    sessionId,
    workload: "polish",
    contents: [{ role: "user", parts: [{ text: "safe" }] }],
  });
  const pending = runtime.generateContent(request("session-1"));
  await assert.rejects(() => runtime.generateContent(request("session-2")), /GEMINI_GLOBAL_BUDGET_EXHAUSTED/u);
  releaseFirst({ text: "safe" });
  await pending;
  await assert.rejects(() => runtime.generateContent(request("session-2")), /GEMINI_SESSION_RATE_STATE_EXHAUSTED/u);
  assert.equal(calls, 1);
  currentTime = 60_001;
  assert.deepEqual(await runtime.generateContent(request("session-2")), { outputText: "safe" });
  assert.equal(calls, 2);
  runtime.releaseSession("session-2");
});
