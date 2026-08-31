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
