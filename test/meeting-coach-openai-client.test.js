import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SIZE_CAPS,
  generateMeetingCoachStructuredJson,
  streamMeetingCoachComposerText,
  streamMeetingCoachStructuredJson,
} from "../src/meeting-coach/index.js";

const API_KEY = "test-gemini-key";

test("Meeting Coach structured request uses Gemini generateContent with JSON output", async () => {
  /** @type {Array<{url: string, init?: RequestInit}>} */
  const calls = [];
  const responseJsonSchema = {
    type: "object",
    properties: { assistantReply: { type: "string" } },
    required: ["assistantReply"],
    additionalProperties: false,
  };
  const result = await generateMeetingCoachStructuredJson({
    apiKey: API_KEY,
    model: "caller-model-must-not-win",
    requestId: "request-1",
    prompt: "BEGIN_UNTRUSTED_DATA\n{}\nEND_UNTRUSTED_DATA",
    responseJsonSchema,
    timeoutMs: 100,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"assistantReply":"안녕하세요"}' }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.requestId, "request-1");
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent");
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "medium");
  assert.deepEqual(body.generationConfig.responseJsonSchema, responseJsonSchema);
  assert.equal(body.contents[0].parts[0].text, "BEGIN_UNTRUSTED_DATA\n{}\nEND_UNTRUSTED_DATA");
  assert.equal(new Headers(calls[0].init?.headers).get("x-goog-api-key"), API_KEY);
  assert.equal(JSON.stringify(body).includes(API_KEY), false);
});

test("Meeting Coach composer reports Gemini final text as the latest partial", async () => {
  const partials = [];
  const result = await streamMeetingCoachComposerText({
    apiKey: API_KEY,
    requestId: "manual-1",
    prompt: "안녕하세요",
    timeoutMs: 100,
    onPartial: (text) => partials.push(text),
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.contents[0].parts[0].text, "안녕하세요");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Hi there" }] } }],
      }), { status: 200 });
    },
  });

  assert.deepEqual(result, { ok: true, requestId: "manual-1", text: "Hi there" });
  assert.deepEqual(partials, ["Hi there"]);
});

test("Meeting Coach structured streaming preserves Gemini JSON text for controller-side extraction", async () => {
  const partials = [];
  const result = await streamMeetingCoachStructuredJson({
    apiKey: API_KEY,
    requestId: "prep-1",
    prompt: "준비",
    responseJsonSchema: { type: "object", properties: {}, additionalProperties: false },
    timeoutMs: 100,
    onPartial: (text) => partials.push(text),
    fetchImpl: async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"assistantReply":"안녕하세요","briefPatch":{}}' }] } }],
    }), { status: 200 }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, '{"assistantReply":"안녕하세요","briefPatch":{}}');
  assert.equal(partials.at(-1), result.text);
});

test("Meeting Coach provider deadline aborts once and never promotes a late result", async () => {
  /** @type {AbortSignal | null} */
  let signal = null;
  const result = await generateMeetingCoachStructuredJson({
    apiKey: API_KEY,
    requestId: "late-1",
    prompt: "question",
    responseJsonSchema: { type: "object", properties: {}, additionalProperties: false },
    timeoutMs: 5,
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({ output: [] }), { status: 200 })), 50));
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("timeout request must fail");
  assert.equal(result.code, "GEMINI_TIMEOUT");
  assert.equal(signal?.aborted, true);
});

test("Meeting Coach provider errors never include the API key or upstream body", async () => {
  const result = await generateMeetingCoachStructuredJson({
    apiKey: "sk-super-secret",
    requestId: "error-1",
    prompt: "question",
    responseJsonSchema: { type: "object", properties: {}, additionalProperties: false },
    timeoutMs: 100,
    fetchImpl: async () => new Response('sk-super-secret upstream detail', { status: 429 }),
  });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes("sk-super-secret"), false);
  assert.deepEqual(result, { ok: false, code: "GEMINI_RATE_LIMITED", error: "Gemini 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요." });
});

test("Gemini request preserves the complete untrusted-data suffix at the prompt cap", async () => {
  const suffix = "\nEND_UNTRUSTED_DATA";
  const prefix = "BEGIN_UNTRUSTED_DATA\n";
  const prompt = `${prefix}${"x".repeat(SIZE_CAPS.prompt - prefix.length - suffix.length)}${suffix}`;
  let sentPrompt = "";
  const result = await generateMeetingCoachStructuredJson({
    apiKey: API_KEY,
    prompt,
    responseJsonSchema: { type: "object", properties: {}, additionalProperties: false },
    fetchImpl: async (_url, init) => {
      sentPrompt = JSON.parse(String(init?.body)).contents[0].parts[0].text;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "{}" }] } }],
      }), { status: 200 });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(sentPrompt.length, SIZE_CAPS.prompt);
  assert.ok(sentPrompt.endsWith("END_UNTRUSTED_DATA"));
});

test("Meeting Coach redacts prompt identities and credentials before Gemini dispatch", async () => {
  const secrets = [
    "noel@example.com",
    "홍길동@회사.한국",
    "invite code 123456",
    ["headerpart", "payloadpart", "signaturepart"].join("."),
    `invite_${"i".repeat(48)}`,
    "grant:viewer:private-marker",
    `AIza${"A".repeat(35)}`,
  ];
  let capturedBody = "";
  const result = await generateMeetingCoachStructuredJson({
    apiKey: API_KEY,
    prompt: `${secrets.join("\n")}\n매출 123456, 영업이익 987654`,
    responseJsonSchema: { type: "object", properties: {}, additionalProperties: false },
    fetchImpl: async (_url, init) => {
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "{}" }] } }],
      }), { status: 200 });
    },
  });

  assert.equal(result.ok, true);
  for (const secret of secrets) assert.equal(capturedBody.includes(secret), false, secret);
  assert.match(JSON.parse(capturedBody).contents[0].parts[0].text, /매출 123456, 영업이익 987654/u);
});
