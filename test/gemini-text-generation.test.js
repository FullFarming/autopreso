// @ts-nocheck - fetch is a minimal fake for the Gemini REST response shape.
import assert from "node:assert/strict";
import { test } from "node:test";

import { generateGeminiText } from "../src/gemini-text-generation.js";

test("generateGeminiText calls Gemini generateContent with key, system, and prompt", async () => {
  const calls = [];
  const result = await generateGeminiText({
    apiKey: "AIza-secondary",
    model: "gemini-3.5-flash",
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
  assert.match(calls[0].url, /gemini-3\.5-flash%3AgenerateContent|gemini-3\.5-flash:generateContent/);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "AIza-secondary");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.systemInstruction.parts[0].text, "polish system");
  assert.equal(body.contents[0].parts[0].text, "polish this");
});

test("generateGeminiText throws on non-2xx responses without leaking the key", async () => {
  await assert.rejects(
    () => generateGeminiText({
      apiKey: "AIza-secret",
      model: "gemini-3.5-flash",
      prompt: "x",
      fetchImpl: async () => ({ ok: false, status: 429 }),
    }),
    /HTTP 429/,
  );
});
