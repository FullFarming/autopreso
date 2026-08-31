import assert from "node:assert/strict";
import test from "node:test";

import { createGeminiRestRecapGenerator } from "./index.js";

function fakeResponse({ ok = true, status = 200, json }) {
  return { ok, status, async json() { return json; } };
}

const recapSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "actions"],
  properties: {
    summary: { type: "string" },
    actions: { type: "array", items: { type: "string" } },
  },
};

test("REST recap retains paid usage through schema rejection and does not invent usage after transport failure", async () => {
  const observations = [];
  let calls = 0;
  const generator = createGeminiRestRecapGenerator({ apiKey: "fixture", observe: (event) => observations.push(event),
    async fetchFn() {
      calls++;
      if (calls === 2) throw new Error("NETWORK_FAILED");
      return fakeResponse({ json: { text: '{"summary":false,"actions":[]}',
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 16 } } });
    } });
  const request = { sessionId: "usage-fixture", prompt: "Summarize.", schema: recapSchema, maxOutputTokens: 512 };
  await assert.rejects(generator.generateContent(request), /GEMINI_OUTPUT_SCHEMA_INVALID/u);
  await assert.rejects(generator.generateContent(request), /GEMINI_PROVIDER_FAILED/u);
  assert.equal(calls, 2);
  assert.equal(observations.length, 2);
  assert.equal(observations[0].usageKnown, true);
  assert.deepEqual([observations[0].inputTokens, observations[0].outputTokens, observations[0].totalTokens], [10, 3, 16]);
  assert.equal(observations[1].usageKnown, false);
});

test("REST recap uses the fixed model, header-only key, redacted prompt, signal, and safe usage observation", async () => {
  const calls = [];
  const observations = [];
  const signal = new AbortController().signal;
  const generator = createGeminiRestRecapGenerator({
    apiKey: "server-api-key",
    now: (() => { let time = 10; return () => time += 5; })(),
    observe(event) { observations.push(event); },
    async fetchFn(url, options) {
      calls.push({ url, options });
      return fakeResponse({
        json: {
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"summary":"정상 요약","actions":["검토"]}' }] } }],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17 },
        },
      });
    },
  });

  const result = await generator.generateContent({
    sessionId: "session-1",
    prompt: "매출 123456, 인증 코드 123456, 담당자 user@회사.한국",
    schema: recapSchema,
    maxOutputTokens: 512,
    signal,
  });

  assert.deepEqual(result, { outputText: '{"summary":"정상 요약","actions":["검토"]}' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent");
  assert.equal(calls[0].url.includes("server-api-key"), false);
  assert.deepEqual(calls[0].options.headers, {
    "content-type": "application/json",
    "x-goog-api-key": "server-api-key",
  });
  assert.equal(calls[0].options.signal, signal);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(JSON.stringify(body).includes("user@회사.한국"), false);
  assert.equal(JSON.stringify(body).includes("인증 코드 123456"), false);
  assert.equal(JSON.stringify(body).includes("매출 123456"), true);
  assert.equal("model" in body, false);
  assert.equal("temperature" in body.generationConfig, false);
  assert.equal("topP" in body.generationConfig, false);
  assert.equal("topK" in body.generationConfig, false);
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: "medium" });
  assert.deepEqual(observations, [{
    workload: "recap",
    model: "gemini-3.7-flash",
    latencyMilliseconds: 5,
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 17,
    usageKnown: true,
    code: "OK",
  }]);
  assert.deepEqual(Object.keys(observations[0]).sort(), [
    "code", "inputTokens", "latencyMilliseconds", "model", "outputTokens", "totalTokens", "usageKnown", "workload",
  ]);
  assert.equal(JSON.stringify(observations).includes("session-1"), false);
});

test("REST recap redacts a raw six-digit prompt field before its single fetch", async () => {
  let body;
  const generator = createGeminiRestRecapGenerator({
    apiKey: "server-api-key",
    async fetchFn(_url, options) {
      body = JSON.parse(options.body);
      return fakeResponse({
        json: { candidates: [{ content: { parts: [{ text: '{"summary":"safe","actions":[]}' }] } }] },
      });
    },
  });
  await generator.generateContent({
    sessionId: "session-raw-code",
    prompt: "123456",
    schema: recapSchema,
    maxOutputTokens: 512,
  });
  assert.equal(body.contents[0].parts[0].text, "[CODE]");
});

test("REST recap rejects caller model selection and invalid bounded input before fetch", async () => {
  let calls = 0;
  const generator = createGeminiRestRecapGenerator({
    apiKey: "server-api-key",
    async fetchFn() { calls += 1; throw new Error("must not dispatch"); },
  });
  const base = { sessionId: "session-1", prompt: "safe", schema: recapSchema, maxOutputTokens: 512 };
  await assert.rejects(() => generator.generateContent({ ...base, model: "caller-model" }), /INVALID_GEMINI_REST_RECAP_REQUEST/u);
  await assert.rejects(() => generator.generateContent({ ...base, thinkingConfig: { thinkingLevel: "minimal" } }), /INVALID_GEMINI_REST_RECAP_REQUEST/u);
  await assert.rejects(() => generator.generateContent({ ...base, maxOutputTokens: undefined }), /INVALID_GEMINI_REST_RECAP_REQUEST/u);
  await assert.rejects(() => generator.generateContent({ ...base, prompt: "x".repeat(50_001) }), /INVALID_GEMINI_CONTENTS/u);
  await assert.rejects(() => generator.generateContent({ ...base, schema: { ...recapSchema, additionalProperties: true } }), /INVALID_GEMINI_REST_RECAP_REQUEST/u);
  assert.equal(calls, 0);
});

test("REST recap makes one request and maps transport, refusal, schema, and usage failures to safe codes", async () => {
  const fixtures = [
    { response: fakeResponse({ ok: false, status: 429, json: { error: { message: "private@example.com" } } }), code: "GEMINI_PROVIDER_RATE_LIMITED" },
    { response: fakeResponse({ json: { promptFeedback: { blockReason: "SAFETY" } } }), code: "GEMINI_PROVIDER_REFUSAL" },
    { response: fakeResponse({ json: { candidates: [{ content: { parts: [{ text: '{"summary":"safe","actions":[],"unknown":true}' }] } }] } }), code: "GEMINI_OUTPUT_SCHEMA_INVALID" },
    { response: fakeResponse({ json: { candidates: [{ content: { parts: [{ text: '{"summary":"<b>bad</b>","actions":[]}' }] } }] } }), code: "GEMINI_OUTPUT_UNSAFE" },
    { response: fakeResponse({ json: { candidates: [{ content: { parts: [{ text: '{"summary":"safe","actions":[]}' }] } }], usageMetadata: { promptTokenCount: "secret" } } }), code: "GEMINI_USAGE_INVALID" },
  ];
  for (const fixture of fixtures) {
    let calls = 0;
    const observations = [];
    const generator = createGeminiRestRecapGenerator({
      apiKey: "server-api-key",
      observe(event) { observations.push(event); },
      async fetchFn() { calls += 1; return fixture.response; },
    });
    await assert.rejects(
      () => generator.generateContent({ sessionId: "session-1", prompt: "safe", schema: recapSchema, maxOutputTokens: 512 }),
      new RegExp(fixture.code, "u"),
    );
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(observations).includes("private@example.com"), false);
    assert.equal(observations.at(-1).code, fixture.code);
  }

  let transportCalls = 0;
  const transportGenerator = createGeminiRestRecapGenerator({
    apiKey: "server-api-key",
    async fetchFn() { transportCalls += 1; throw new Error("private@example.com raw transport"); },
  });
  await assert.rejects(
    () => transportGenerator.generateContent({ sessionId: "session-1", prompt: "safe", schema: recapSchema, maxOutputTokens: 512 }),
    /^Error: GEMINI_PROVIDER_FAILED$/u,
  );
  assert.equal(transportCalls, 1);
});

test("REST recap bounds three concurrent language calls before fetch and preserves rate quota semantics", async () => {
  const pendingResolvers = [];
  let fetchCalls = 0;
  const generator = createGeminiRestRecapGenerator({
    apiKey: "server-api-key",
    limits: {
      globalOutstanding: 3,
      sessionOutstanding: 2,
      globalRequestsPerMinute: 3,
      sessionRequestsPerMinute: 2,
      maximumTrackedSessions: 10,
    },
    async fetchFn() {
      fetchCalls += 1;
      return new Promise((resolve) => pendingResolvers.push(resolve));
    },
  });
  const request = (language) => generator.generateContent({
    sessionId: "session-1",
    prompt: `summarize ${language}`,
    schema: recapSchema,
    maxOutputTokens: 512,
  });
  const korean = request("ko");
  const english = request("en");
  await assert.rejects(() => request("ja"), /GEMINI_SESSION_BUDGET_EXHAUSTED/u);
  assert.equal(fetchCalls, 2);
  for (const resolve of pendingResolvers) {
    resolve(fakeResponse({
      json: { candidates: [{ content: { parts: [{ text: '{"summary":"safe","actions":[]}' }] } }] },
    }));
  }
  await Promise.all([korean, english]);
  await assert.rejects(() => request("fr"), /GEMINI_SESSION_RATE_LIMITED/u);
  assert.equal(fetchCalls, 2);
  generator.releaseSession("session-1");
  await assert.rejects(() => request("de"), /GEMINI_SESSION_RATE_LIMITED/u);
  assert.equal(fetchCalls, 2, "a reconnect cannot reset paid request history");
});

test("REST recap enforces the global outstanding limit across sessions before fetch", async () => {
  const resolvers = [];
  let fetchCalls = 0;
  const generator = createGeminiRestRecapGenerator({
    apiKey: "server-api-key",
    limits: {
      globalOutstanding: 2,
      sessionOutstanding: 2,
      globalRequestsPerMinute: 10,
      sessionRequestsPerMinute: 5,
      maximumTrackedSessions: 10,
    },
    async fetchFn() {
      fetchCalls += 1;
      return new Promise((resolve) => resolvers.push(resolve));
    },
  });
  const request = (sessionId) => generator.generateContent({
    sessionId,
    prompt: "safe",
    schema: recapSchema,
    maxOutputTokens: 512,
  });
  const first = request("session-1");
  const second = request("session-2");
  await assert.rejects(() => request("session-3"), /GEMINI_GLOBAL_BUDGET_EXHAUSTED/u);
  assert.equal(fetchCalls, 2);
  for (const resolve of resolvers) {
    resolve(fakeResponse({
      json: { candidates: [{ content: { parts: [{ text: '{"summary":"safe","actions":[]}' }] } }] },
    }));
  }
  await Promise.all([first, second]);
});
