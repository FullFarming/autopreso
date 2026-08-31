import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createCaptionPolishPolicyResolver,
  createGeminiTopicGenerate,
  createMediaGatewayRuntimeLoader,
  listenMediaGateway,
  observeGeminiRuntimeMetrics,
  startMediaGateway,
  resolvePipelineInitialSequences,
} from "../src/server.js";

test("demand cold start fails closed when durable caption positions cannot be restored", async () => {
  const publisher = { async fetchLastUtteranceSeqs() { throw new Error("offline"); } };
  await assert.rejects(resolvePipelineInitialSequences({ publisher,
    message: { sessionId: "session", languages: ["en"] }, requireDurableSeed: true }), /MEDIA_SEQUENCE_RESTORE_FAILED/);
});

test("demand cold start rejects missing or malformed durable positions", async () => {
  for (const persisted of [{}, { en: null }, { en: -1 }, { en: "4" }, { en: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(resolvePipelineInitialSequences({
      publisher: { async fetchLastUtteranceSeqs() { return persisted; } },
      message: { sessionId: "session", languages: ["en"] }, requireDurableSeed: true,
    }), /MEDIA_SEQUENCE_RESTORE_FAILED/);
  }
});

test("caption polish canary assignment is stable across all three policy buckets without caption text", () => {
  const resolvePolicy = createCaptionPolishPolicyResolver({
    defaultPolicy: "selective",
    policyWeights: { off: 2_500, selective: 5_000, full: 2_500 },
  });
  const first = resolvePolicy("session-stable");
  assert.equal(resolvePolicy("session-stable"), first);
  const assigned = new Set(Array.from({ length: 500 }, (_, index) => resolvePolicy(`session-${index}`)));
  assert.deepEqual([...assigned].sort(), ["full", "off", "selective"]);
  assert.throws(() => createCaptionPolishPolicyResolver({ defaultPolicy: "invalid" }), /INVALID_CAPTION_POLISH_POLICY/u);
  assert.throws(() => createCaptionPolishPolicyResolver({ policyWeights: { off: 5_001, selective: 5_000, full: 0 } }), /INVALID_CAPTION_POLISH_CANARY/u);
  assert.throws(() => createCaptionPolishPolicyResolver({ policyWeights: { off: -1, selective: 10_000, full: 0 } }), /INVALID_CAPTION_POLISH_CANARY/u);
});

test("media gateway gives caption polish the same six-second quality budget as desktop", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(source, /createCaptionPolisher\(\{[^}]*timeoutMs:\s*6_000/u);
  assert.doesNotMatch(source, /timeoutMs:\s*4_000/u);
  assert.doesNotMatch(source, /timeoutMs:\s*1_500/u);
});

test("media gateway uses the session policy resolver instead of forcing full polish", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(source, /captionPolishPolicy\s*=\s*resolveCaptionPolishPolicy\(message\.sessionId\)/u);
  assert.match(source, /captionPolishPolicy,/u);
  assert.doesNotMatch(source, /captionPolishPolicy:\s*["']full["']/u);
});

test("media gateway constructs its publisher with a live topic detector", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(source, /createLiveTopicDetector\(\{[\s\S]*?generate:\s*\(request,\s*context\)\s*=>\s*runtimeLoader\.generateTopic\(request,\s*context\)/u);
  assert.match(source, /if \(!topicGenerate\) topicGenerate = createGeminiTopicGenerate\(\{ runtime: geminiRuntime \}\)/u);
  assert.match(source, /new SupabaseLivePublisher\(\{[\s\S]*?topicDetector,/u);
});

test("media gateway listens before loading Google providers for Cloud Run cold starts", async () => {
  const order = [];
  const gateway = await startMediaGateway(mediaGatewayConfig(), {
    listen: async () => { order.push("listen"); },
    importGoogleGenAI: async () => {
      order.push("gemini");
      return { GoogleGenAI: FakeGoogleGenAI };
    },
  });
  try {
    assert.deepEqual(order, ["listen"]);
  } finally {
    await gateway.close();
  }
});

test("media gateway runtime loader imports Google providers once and releases only loaded sessions", async () => {
  const order = [];
  const metrics = { increment() {}, observe() {} };
  const loader = createMediaGatewayRuntimeLoader({
    config: mediaGatewayConfig(),
    getGateway: () => ({ metrics }),
    importGoogleGenAI: async () => {
      order.push("gemini");
      return { GoogleGenAI: FakeGoogleGenAI };
    },
    importSpeechModule: async () => {
      order.push("speech");
      return { v2: { SpeechClient: FakeSpeechClient } };
    },
  });

  await loader.releaseSession("11111111-1111-4111-8111-111111111111");
  assert.deepEqual(order, []);
  await Promise.all([loader.load(), loader.load()]);
  assert.deepEqual(order, ["gemini"]);
  await loader.releaseSession("11111111-1111-4111-8111-111111111111");
});

test("media gateway loads the authoritative pinned glossary once per pipeline start and passes only compiled JSON", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(source, /new SupabasePinnedGlossaryLoader\(config\)/u);
  assert.match(
    source,
    /pinnedGlossaryLoader\.load\(message\.sessionId,\s*\{\s*signal:\s*options\.signal\s*\}\)/u,
  );
  assert.match(source, /new LiveMediaPipeline\(\{[\s\S]*?compiledGlossary,/u);
  assert.match(source, /new GeminiLiveTranscriptionAdapter\(\{[\s\S]*?compiledGlossary,/u);
  assert.doesNotMatch(source, /compiledGlossary:\s*(?:message|hostMessage)\./u);
});

test("media gateway shares a cancellable Live transport separately from the text SDK", async () => {
  const loader = createMediaGatewayRuntimeLoader({
    config: mediaGatewayConfig(),
    getGateway: () => ({ metrics: { increment() {}, observe() {} } }),
    importGoogleGenAI: async () => ({ GoogleGenAI: FakeGoogleGenAI }),
  });

  const runtime = await loader.load();
  assert.equal(runtime.liveClient instanceof FakeGoogleGenAI, false);
  assert.equal(typeof runtime.liveClient.live.connect, "function");
  assert.equal(runtime.liveClient.activeConnections, 0);
  assert.equal((await loader.load()).liveClient, runtime.liveClient);
});

test("media gateway shares one bounded server Gemini runtime across workloads", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(source, /createGeminiServerRuntime\(\{[\s\S]*?GoogleGenAI,[\s\S]*?apiKey:\s*config\.geminiApiKey/u);
  assert.match(source, /createSessionClient\(message\.sessionId,\s*["']translation["']\)/u);
  assert.match(source, /createSessionClient\(message\.sessionId,\s*["']polish["']\)/u);
  assert.match(source, /releaseGeminiSession:\s*\(sessionId\)\s*=>\s*runtimeLoader\.releaseSession\(sessionId\)/u);
  assert.match(source, /loadedRuntime\?\.geminiRuntime\.releaseSession\(sessionId\)/u);
  assert.doesNotMatch(source, /new GoogleGenAI\(/u);
});

test("Gemini observations emit only fixed workload, model, result, latency, and numeric usage metrics", () => {
  const calls = [];
  const metrics = {
    increment(name, amount) { calls.push({ operation: "increment", name, amount }); },
    observe(name, value) { calls.push({ operation: "observe", name, value }); },
  };
  observeGeminiRuntimeMetrics(metrics, {
    workload: "topic",
    model: "gemini-3.7-flash",
    latencyMilliseconds: 27,
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    usageKnown: true,
    code: "GEMINI_PROVIDER_REFUSAL",
    prompt: "private@example.com",
    response: "grant_live_secret_123456",
    sessionId: "11111111-1111-4111-8111-111111111111",
  });
  assert.deepEqual(calls, [
    { operation: "increment", name: "gemini_topic_model_flash_37_total", amount: undefined },
    { operation: "increment", name: "gemini_topic_result_refusal_total", amount: undefined },
    { operation: "observe", name: "gemini_topic_latency_ms", value: 27 },
    { operation: "observe", name: "gemini_topic_input_tokens", value: 10 },
    { operation: "observe", name: "gemini_topic_output_tokens", value: 4 },
    { operation: "observe", name: "gemini_topic_total_tokens", value: 14 },
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /private@example|grant_live|11111111/u);
});

test("unknown billed usage is counted as unknown and never recorded as zero tokens", () => {
  const calls = [];
  observeGeminiRuntimeMetrics({ increment: (name) => calls.push(name), observe: (name) => calls.push(name) }, {
    workload: "translation", model: "gemini-3.7-flash", code: "GEMINI_PROVIDER_FAILED",
    latencyMilliseconds: 20, inputTokens: 0, outputTokens: 0, totalTokens: 0, usageKnown: false,
  });
  assert.ok(calls.includes("gemini_translation_usage_unknown_total"));
  assert.ok(calls.includes("gemini_translation_result_provider_failed_total"));
  assert.equal(calls.some((name) => /_tokens$/u.test(name)), false);
});

test("Gemini topic provider uses only the fixed model and strict JSON request", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const generate = createGeminiTopicGenerate({
    runtime: {
      async generateContent(request) {
        calls.push(request);
        return { outputText: '{"meaningful":true,"startsNewTopic":false,"title":null}' };
      },
    },
  });
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["meaningful", "startsNewTopic", "title"],
    properties: {
      meaningful: { type: "boolean" },
      startsNewTopic: { type: "boolean" },
      title: { type: ["string", "null"] },
    },
  };
  const response = await generate({
    store: false,
    input: [
      { role: "system", content: "Classify only." },
      { role: "user", content: "<UNTRUSTED_TRANSCRIPT_JSON>[]</UNTRUSTED_TRANSCRIPT_JSON>" },
    ],
    text: { format: { type: "json_schema", name: "live_topic_decision", strict: true, schema } },
  }, { signal, sessionId: "session-1" });

  assert.deepEqual(response, { outputText: '{"meaningful":true,"startsNewTopic":false,"title":null}' });
  assert.deepEqual(calls, [{
    sessionId: "session-1",
    workload: "topic",
    contents: [{ role: "user", parts: [{ text: "<UNTRUSTED_TRANSCRIPT_JSON>[]</UNTRUSTED_TRANSCRIPT_JSON>" }] }],
    config: {
      systemInstruction: "Classify only.",
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      maxOutputTokens: 512,
    },
    signal,
  }]);
  assert.equal("tools" in calls[0].config, false);
  assert.equal("store" in calls[0], false);
});

test("Gemini topic provider normalizes blocked output as a refusal and rejects unsafe request shapes", async () => {
  const generate = createGeminiTopicGenerate({
    runtime: { async generateContent() { throw new Error("GEMINI_PROVIDER_REFUSAL"); } },
  });
  const request = {
    store: false,
    input: [{ role: "system", content: "System" }, { role: "user", content: "User" }],
    text: {
      format: {
        type: "json_schema", name: "live_topic_decision", strict: true,
        schema: { type: "object", additionalProperties: false, required: [], properties: {} },
      },
    },
  };

  await assert.rejects(
    () => generate(request, { signal: new AbortController().signal, sessionId: "session-1" }),
    /GEMINI_PROVIDER_REFUSAL/u,
  );
  await assert.rejects(
    () => generate({ ...request, model: "attacker-controlled-model" }, {}),
    /INVALID_TOPIC_PROVIDER_REQUEST/u,
  );
});

test("media gateway listens on the host selected by the validated environment", async () => {
  const calls = [];
  const server = {
    listen(port, host, callback) {
      calls.push({ port, host });
      callback();
    },
  };

  await listenMediaGateway(server, { port: 8080, host: "127.0.0.1" });
  await listenMediaGateway(server, { port: 9090, host: "0.0.0.0" });

  assert.deepEqual(calls, [
    { port: 8080, host: "127.0.0.1" },
    { port: 9090, host: "0.0.0.0" },
  ]);
});

class FakeGoogleGenAI {
  constructor() {
    this.models = {
      async generateContent() {
        return { text: "{\"meaningful\":true,\"startsNewTopic\":false,\"title\":null}" };
      },
    };
    this.live = { connect() {} };
  }
}

class FakeSpeechClient {}

function mediaGatewayConfig() {
  return {
    port: 8080,
    host: "127.0.0.1",
    geminiApiKey: "test-gemini-api-key",
    projectId: "test-project",
    baseUrl: "https://example.supabase.co",
    supabaseApiKey: "test-supabase-key",
    supabaseKeyType: "secret",
    gatewaySecret: "g".repeat(32),
    viewerSecret: "v".repeat(32),
    sttLanguageCodes: ["ko-KR", "en-US"],
    sttLocation: "global",
    hostReconnectGraceMilliseconds: 90_000,
    captionPolishPolicyWeights: { off: 0, selective: 10_000, full: 0 },
  };
}

test("gateway Gemini admission budget covers a dense three-language session", async () => {
  const { GATEWAY_GEMINI_LIMITS } = await import("../src/server.js");
  const { createGeminiAdmissionController } = await import("../../packages/gemini-server/admission.js");

  // One committed final can hold: 2 translations (two non-source lanes) +
  // 1 selective polish + 1 topic detection = 4 concurrent workload calls.
  assert.ok(GATEWAY_GEMINI_LIMITS.sessionOutstanding >= 4);
  // Dense speech commits ~20 clause-level finals/min x 3 calls each.
  assert.ok(GATEWAY_GEMINI_LIMITS.sessionRequestsPerMinute >= 60);
  assert.ok(GATEWAY_GEMINI_LIMITS.globalOutstanding >= GATEWAY_GEMINI_LIMITS.sessionOutstanding);
  assert.ok(GATEWAY_GEMINI_LIMITS.globalRequestsPerMinute >= GATEWAY_GEMINI_LIMITS.sessionRequestsPerMinute);

  const admission = createGeminiAdmissionController({
    limits: GATEWAY_GEMINI_LIMITS,
    now: () => 0,
  });
  for (let index = 0; index < 4; index += 1) admission.acquire("session-dense");

  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(source, /createGeminiServerRuntime\(\{[\s\S]*?limits:\s*GATEWAY_GEMINI_LIMITS/u);
});
