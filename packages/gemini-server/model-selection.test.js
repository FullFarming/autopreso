import assert from "node:assert/strict";
import test from "node:test";
import { createGeminiServerRuntime, createGeminiRestRecapGenerator } from "./index.js";

const MODELS = ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"];
const contents = [{ role: "user", parts: [{ text: "Summarize this synthetic example." }] }];
const completed = () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "A brief summary." }] } }],
  usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 } });
function fixture({ respond = async () => completed(), limits } = {}) {
  const calls = [], observed = [];
  class GoogleGenAI {
    constructor(options) { assert.deepEqual(options.httpOptions, { retryOptions: { attempts: 1 } }); }
    live = { connect() { throw new Error("NO_LIVE_API_CALLS"); } };
    models = { generateContent: async (request) => { calls.push(request); return respond(request); } };
  }
  const runtime = createGeminiServerRuntime({ GoogleGenAI, apiKey: "synthetic", observe: (event) => observed.push(event), ...(limits ? { limits } : {}) });
  return { runtime, calls, observed };
}

test("only Gemini 3.6 executes topic and recap workloads and reports the actual model", async () => {
  const h = fixture();
  for (const workload of ["topic", "recap"]) {
    const client = h.runtime.createSessionClient(workload, workload, { model: MODELS[1] });
    await client.models.generateContent({ contents });
    assert.equal(h.calls.at(-1).model, MODELS[1]);
    assert.equal(h.observed.at(-1).model, MODELS[1]);
    assert.equal(h.observed.at(-1).usageKnown, true);
  }
  assert.equal(h.calls.length, 2);
});

test("both catalog-listed summary models (3.6 and 3.7) are valid selections for topic and recap workloads", async () => {
  const h = fixture();
  for (const workload of ["topic", "recap"]) {
    const client = h.runtime.createSessionClient(`selection-${workload}-3.7`, workload, { model: MODELS[0] });
    await client.models.generateContent({ contents });
    assert.equal(h.calls.at(-1).model, MODELS[0]);
  }
  assert.equal(h.calls.length, 2);
});

test("binding rejects unrelated models or surplus options and requests cannot override a validated selection", async () => {
  const h = fixture();
  for (const workload of ["topic", "recap"]) {
    for (const model of [MODELS[2], "gemini-3.5-flash-lite", "gemini-9-flash", "gemini-3.5-live-translate-preview", "gemini-latest", "", null]) {
      assert.throws(() => h.runtime.createSessionClient("selection", workload, { model }), /INVALID_GEMINI_MODEL_SELECTION/u);
    }
    assert.throws(() => h.runtime.createSessionClient("selection", workload, { model: MODELS[0], fallback: MODELS[1] }), /INVALID_GEMINI_MODEL_SELECTION/u);
  }
  // The retired direct Live source workload is not a REST workload; translation is, and it accepts only catalog translation models.
  assert.throws(() => h.runtime.createSessionClient("selection", "source", { model: MODELS[0] }), /INVALID_GEMINI_WORKLOAD/u);
  for (const model of ["gemini-3.5-transcribe-live", "gemini-3.5-live-translate-preview", "gemini-9-flash", "", null]) {
    assert.throws(() => h.runtime.createSessionClient("selection", "translation", { model }), /INVALID_GEMINI_MODEL_SELECTION/u);
  }
  assert.throws(() => h.runtime.createSessionClient("selection", "translation", { model: "gemini-3.6-flash", fallback: "gemini-3.5-flash-lite" }), /INVALID_GEMINI_MODEL_SELECTION/u);
  assert.throws(() => h.runtime.createSessionClient("selection", "polish", { model: MODELS[1] }), /INVALID_GEMINI_MODEL_SELECTION/u);
  const client = h.runtime.createSessionClient("selection", "topic", { model: MODELS[1] });
  await assert.rejects(client.models.generateContent({ contents, model: MODELS[2] }), /INVALID_GEMINI_DISPATCH/u);
  assert.equal(h.calls.length, 0);
});

test("rebinding the same model does not reset a session request quota or add a fallback", async () => {
  const h = fixture({ limits: { sessionRequestsPerMinute: 1 } });
  await h.runtime.createSessionClient("same-session", "topic", { model: MODELS[1] }).models.generateContent({ contents });
  await assert.rejects(h.runtime.createSessionClient("same-session", "topic", { model: MODELS[1] }).models.generateContent({ contents }), /GEMINI_SESSION_RATE_LIMITED/u);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].model, MODELS[1]);
});

test("bound recap keeps schema validation and disallows caller session or model overrides", async () => {
  const h = fixture({ respond: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"summary":"Done"}' }] } }] }) });
  const client = h.runtime.createSessionClient("recap-owner", "recap", { model: MODELS[1] });
  const request = { prompt: "Summarize.", responseJsonSchema: { type: "object", additionalProperties: false,
    required: ["summary"], properties: { summary: { type: "string" } } }, validate: (value) => value };
  assert.deepEqual(await client.generateRecap(request), { summary: "Done" });
  assert.equal(h.calls[0].model, MODELS[1]);
  await assert.rejects(client.generateRecap({ ...request, sessionId: "another-session" }), /INVALID_GEMINI_RECAP_REQUEST/u);
  await assert.rejects(client.generateRecap({ ...request, model: MODELS[0] }), /INVALID_GEMINI_RECAP_REQUEST/u);
  assert.equal(h.calls.length, 1);
});

test("a rejected model rebind cannot create a second request or change an admitted request", async () => {
  const h = fixture();
  const client = h.runtime.createSessionClient("same-session", "topic", { model: MODELS[1] });
  assert.throws(() => h.runtime.createSessionClient("same-session", "topic", { model: MODELS[2] }), /INVALID_GEMINI_MODEL_SELECTION/u);
  await client.models.generateContent({ contents });
  assert.deepEqual(h.calls.map((request) => request.model), [MODELS[1]]);
});

test("REST recap selects its constructor model and shares admission across separately constructed factories", async () => {
  const calls = [], observed = [];
  const fetchFn = async (url) => { calls.push(url); return Response.json({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"summary":"Done"}' }] } }],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
  }); };
  const common = { apiKey: "synthetic", fetchFn, limits: { sessionRequestsPerMinute: 1 }, observe: (event) => observed.push(event) };
  const request = { sessionId: "same-recap", prompt: "Summarize.", maxOutputTokens: 512,
    schema: { type: "object", additionalProperties: false, properties: { summary: { type: "string" } }, required: ["summary"] } };
  await createGeminiRestRecapGenerator({ ...common, model: MODELS[1] }).generateContent(request);
  await assert.rejects(createGeminiRestRecapGenerator({ ...common, model: MODELS[1] }).generateContent(request), /GEMINI_SESSION_RATE_LIMITED/u);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /models\/gemini-3\.6-flash:generateContent$/u);
  assert.equal(observed[0].model, MODELS[1]);
  assert.throws(() => createGeminiRestRecapGenerator({ ...common, model: "gemini-latest" }), /INVALID_GEMINI_MODEL_SELECTION/u);
  assert.throws(() => createGeminiRestRecapGenerator({ ...common, model: MODELS[1], limits: { sessionRequestsPerMinute: 20 } }), /INVALID_GEMINI_SHARED_ADMISSION/u);
});
