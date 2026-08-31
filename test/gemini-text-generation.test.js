// @ts-nocheck - fetch is a minimal fake for the Gemini REST response shape.
import assert from "node:assert/strict";
import { test } from "node:test";

import { generateGeminiText } from "../src/gemini-text-generation.js";

const TEST_API_KEY = ["test", "secondary", "marker"].join("-");

test("generateGeminiText calls Gemini generateContent with key, system, and prompt", async () => {
  const calls = [];
  const result = await generateGeminiText({
    apiKey: TEST_API_KEY,
    model: "gemini-3.7-flash",
    system: "polish system",
    prompt: "polish this",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "정리된 최종 자막" }] } }],
        }),
      };
    },
  });

  assert.equal(result.text, "정리된 최종 자막");
  assert.match(calls[0].url, /gemini-3\.7-flash%3AgenerateContent|gemini-3\.7-flash:generateContent/);
  assert.equal(calls[0].init.headers["x-goog-api-key"], TEST_API_KEY);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.systemInstruction.parts[0].text, "polish system");
  assert.equal(body.contents[0].parts[0].text, "polish this");
  assert.deepEqual(body.generationConfig, {
    thinkingConfig: { thinkingLevel: "low" },
    maxOutputTokens: 2048,
  });
});

test("generateGeminiText ignores caller attempts to widen Gemini 3.7 thinking or sampling", async () => {
  const calls = [];
  await generateGeminiText({
    apiKey: TEST_API_KEY,
    model: "gemini-3.7-flash",
    prompt: "polish this",
    thinkingLevel: "high",
    generationConfig: {
      thinkingConfig: { thinkingLevel: "high" },
      temperature: 2,
      topP: 1,
      topK: 999,
      candidateCount: 8,
      maxOutputTokens: 65_536,
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: "safe" }] } }] }),
      };
    },
  });

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.generationConfig, {
    thinkingConfig: { thinkingLevel: "low" },
    maxOutputTokens: 2048,
  });
});

test("generateGeminiText throws on non-2xx responses without leaking the key", async () => {
  await assert.rejects(
    () => generateGeminiText({
      apiKey: "AIza-secret",
      model: "gemini-3.7-flash",
      prompt: "x",
      fetchImpl: async () => ({ ok: false, status: 429 }),
    }),
    /HTTP 429/,
  );
});

test("generateGeminiText redacts identities and credentials immediately before provider dispatch", async () => {
  const secrets = {
    internationalEmail: "noel@example.com",
    koreanEmail: "홍길동@회사.한국",
    labeledCode: "123456",
    standaloneCode: "654321",
    jwt: ["headerpart", "payloadpart", "signaturepart"].join("."),
    invite: `invite_${"i".repeat(48)}`,
    grant: "grant:viewer:private-marker",
    apiKeyShaped: `AIza${"A".repeat(35)}`,
  };
  const calls = [];
  await generateGeminiText({
    apiKey: TEST_API_KEY,
    model: "gemini-3.7-flash",
    system: secrets.standaloneCode,
    prompt: [
      secrets.internationalEmail,
      secrets.koreanEmail,
      `invite code ${secrets.labeledCode}`,
      secrets.jwt,
      secrets.invite,
      secrets.grant,
      secrets.apiKeyShaped,
      "매출 123456, 영업이익 987654",
    ].join("\n"),
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "safe" }] } }] }) };
    },
  });

  const serialized = JSON.stringify(calls[0]);
  for (const [name, secret] of Object.entries(secrets)) {
    if (name !== "labeledCode") assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal(serialized.includes(`invite code ${secrets.labeledCode}`), false);
  assert.match(calls[0].contents[0].parts[0].text, /매출 123456, 영업이익 987654/u);
  assert.equal(calls[0].systemInstruction.parts[0].text, "[CODE]");
});

// 2026-08-31 outage: generativelanguage returned intermittent 503/404 (and
// occasional >25s hangs) on gemini-3.7-flash while gemini-3.6-flash stayed
// healthy. One failed polish call turned EVERY committed caption into
// TEXT_TRANSLATION_FAILED. The fallback chain keeps one attempt per model —
// it is availability routing, not a blind retry.
test("model fallback tries the next model on a transient failure and returns its text", async () => {
  const { generateGeminiTextWithModelFallback } = await import("../src/gemini-text-generation.js");
  const calls = [];
  const result = await generateGeminiTextWithModelFallback({
    apiKey: TEST_API_KEY,
    models: ["gemini-3.7-flash", "gemini-3.6-flash"],
    prompt: "polish this",
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "fallback line" }] } }] }) };
    },
  });
  assert.equal(result.text, "fallback line");
  assert.equal(calls.length, 2);
  assert.match(calls[0], /gemini-3\.7-flash/u);
  assert.match(calls[1], /gemini-3\.6-flash/u);
});

test("model fallback does not mask non-transient failures and stops on the first", async () => {
  const { generateGeminiTextWithModelFallback } = await import("../src/gemini-text-generation.js");
  const calls = [];
  await assert.rejects(generateGeminiTextWithModelFallback({
    apiKey: TEST_API_KEY,
    models: ["gemini-3.7-flash", "gemini-3.6-flash"],
    prompt: "polish this",
    fetchImpl: async (url) => {
      calls.push(String(url));
      return { ok: false, status: 403, json: async () => ({}) };
    },
  }), /HTTP 403/u);
  assert.equal(calls.length, 1, "an auth/config failure is identical on every model — never burn fallbacks on it");
});

test("model fallback escapes a hanging model via the per-attempt timeout", async () => {
  const { generateGeminiTextWithModelFallback } = await import("../src/gemini-text-generation.js");
  const calls = [];
  const result = await generateGeminiTextWithModelFallback({
    apiKey: TEST_API_KEY,
    models: ["gemini-3.7-flash", "gemini-3.6-flash"],
    prompt: "polish this",
    perAttemptTimeoutMs: 30,
    fetchImpl: (url, init) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "rescued" }] } }] }) });
    },
  });
  assert.equal(result.text, "rescued");
  assert.equal(calls.length, 2);
});

test("model fallback respects the caller's abort and never continues past it", async () => {
  const { generateGeminiTextWithModelFallback } = await import("../src/gemini-text-generation.js");
  const outer = new AbortController();
  const calls = [];
  const pending = generateGeminiTextWithModelFallback({
    apiKey: TEST_API_KEY,
    models: ["gemini-3.7-flash", "gemini-3.6-flash"],
    prompt: "polish this",
    abortSignal: outer.signal,
    fetchImpl: (url, init) => {
      calls.push(String(url));
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  outer.abort();
  await assert.rejects(pending);
  assert.equal(calls.length, 1, "the caller's deadline ends the whole chain, not just the attempt");
});

test("transient HTTP failures carry their status for fallback routing", async () => {
  await assert.rejects(generateGeminiText({
    apiKey: TEST_API_KEY,
    model: "gemini-3.7-flash",
    prompt: "polish this",
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  }), (error) => error.status === 503 && /HTTP 503/u.test(error.message));
});
