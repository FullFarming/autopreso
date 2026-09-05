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
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: "정리된 최종 자막" }] } }],
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
        json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "safe" }] } }] }),
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
      return { ok: true, json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "safe" }] } }] }) };
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

// 2026-08-31 fix: Only summaries retain bounded availability routing; captions dispatch a single model request.
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
      return { ok: true, json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "fallback line" }] } }] }) };
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
      return Promise.resolve({ ok: true, json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "rescued" }] } }] }) });
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

test("HTTP failures cancel the unread response body before another model is dispatched", async () => {
  const { generateGeminiTextWithModelFallback } = await import("../src/gemini-text-generation.js");
  const events = [];
  const result = await generateGeminiTextWithModelFallback({
    apiKey: TEST_API_KEY, models: ["model-one", "model-two"],
    fetchImpl: async () => {
      events.push("fetch");
      if (events.length === 1) return {
        ok: false, status: 503,
        body: { cancel: async () => { events.push("cancel"); } },
        json: async () => { throw new Error("private-provider-body-must-not-be-read"); },
      };
      return { ok: true, json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "완료" }] } }] }) };
    },
  });
  assert.equal(result.text, "완료");
  assert.deepEqual(events, ["fetch", "cancel", "fetch"]);
});

test("a failed error-body cancellation cannot open another model connection", async () => {
  const { generateGeminiTextWithModelFallback } = await import("../src/gemini-text-generation.js");
  let calls = 0;
  await assert.rejects(generateGeminiTextWithModelFallback({
    apiKey: TEST_API_KEY, models: ["model-one", "model-two"],
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 503, body: { cancel: async () => { throw new Error("private-cleanup-error"); } } };
    },
  }), (error) => error.code === "GEMINI_TEXT_INVALID_RESPONSE" && !String(error.stack).includes("private-"));
  assert.equal(calls, 1);
});

test("fallback never retries quota, invalid model, parse, blocked, truncated or empty results", async () => {
  const { generateGeminiTextWithModelFallback } = await import("../src/gemini-text-generation.js");
  const cases = [
    { response: { ok: false, status: 429 }, code: "GEMINI_TEXT_HTTP_ERROR", status: 429 },
    { response: { ok: false, status: 404 }, code: "GEMINI_TEXT_HTTP_ERROR", status: 404 },
    { response: { ok: true, json: async () => { throw new SyntaxError("private-input-marker"); } }, code: "GEMINI_TEXT_INVALID_RESPONSE" },
    { body: { promptFeedback: { blockReason: "SAFETY" } }, code: "GEMINI_TEXT_BLOCKED" },
    { body: { candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "private-blocked-output" }] } }] }, code: "GEMINI_TEXT_BLOCKED" },
    { body: { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "truncated sentence" }] } }] }, code: "GEMINI_TEXT_TRUNCATED" },
    { body: { candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "private-internal-thought" }] } }] }, code: "GEMINI_TEXT_EMPTY" },
    { body: { candidates: [] }, code: "GEMINI_TEXT_EMPTY" },
    { body: { candidates: [{ content: { parts: [{ text: "not final" }] } }] }, code: "GEMINI_TEXT_INVALID_RESPONSE" },
    { body: { candidates: [{ finishReason: "UNRECOGNIZED_REASON", content: { parts: [{ text: "not final" }] } }] }, code: "GEMINI_TEXT_INVALID_RESPONSE" },
  ];
  for (const sample of cases) {
    let calls = 0;
    await assert.rejects(generateGeminiTextWithModelFallback({
      apiKey: TEST_API_KEY, models: ["model-one", "model-two", "model-three"],
      fetchImpl: async () => { calls += 1; return sample.response ?? { ok: true, json: async () => sample.body }; },
    }), (error) => {
      assert.equal(error.code, sample.code);
      assert.equal(error.status, sample.status);
      assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /private-|truncated sentence|not final|test-secondary-marker/u);
      return true;
    });
    assert.equal(calls, 1, sample.code);
  }
});

test("only visible text parts of a normally completed answer become returned text", async () => {
  const result = await generateGeminiText({
    apiKey: TEST_API_KEY, model: "model-one",
    fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [{
      finishReason: "STOP", content: { parts: [
        { thought: true, text: "private-internal-thought" }, { text: "완료된 " }, { thought: false, text: "자막" },
      ] },
    }] }) }),
  });
  assert.deepEqual(result, { text: "완료된 자막" });
});

test("network, timeout and cancellation failures expose only safe typed metadata", async () => {
  for (const kind of ["network", "timeout", "abort", "unexpected"]) {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(generateGeminiText({
      apiKey: TEST_API_KEY, model: "model-one", abortSignal: controller.signal,
      fetchImpl: async () => {
        calls += 1;
        if (kind === "timeout") controller.abort(new DOMException("private-timeout-marker", "TimeoutError"));
        if (kind === "abort") controller.abort();
        throw kind === "network" ? new TypeError("private-request-url-and-key") : new Error("private-provider-message");
      },
    }), (error) => {
      assert.equal(error.code, {
        network: "GEMINI_TEXT_NETWORK_ERROR", timeout: "GEMINI_TEXT_TIMEOUT",
        abort: "GEMINI_TEXT_ABORTED", unexpected: "GEMINI_TEXT_INVALID_RESPONSE",
      }[kind]);
      assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /private-|test-secondary-marker/u);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("an already aborted request performs zero fetches and late aborted responses never return text", async () => {
  for (const abortBeforeFetch of [true, false]) {
    const controller = new AbortController();
    let calls = 0;
    if (abortBeforeFetch) controller.abort();
    await assert.rejects(generateGeminiText({
      apiKey: TEST_API_KEY, model: "model-one", abortSignal: controller.signal,
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, json: async () => {
          controller.abort();
          return { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "late text" }] } }] };
        } };
      },
    }), (error) => error.code === "GEMINI_TEXT_ABORTED");
    assert.equal(calls, abortBeforeFetch ? 0 : 1);
  }
});

test("timeout while consuming JSON stays a timeout and does not expose a parse or network error", async () => {
  const controller = new AbortController();
  await assert.rejects(generateGeminiText({
    apiKey: TEST_API_KEY, model: "model-one", abortSignal: controller.signal,
    fetchImpl: async () => ({ ok: true, json: async () => {
      controller.abort(new DOMException("private-deadline", "TimeoutError"));
      throw new SyntaxError("private-partial-body");
    } }),
  }), (error) => error.code === "GEMINI_TEXT_TIMEOUT" && !String(error.stack).includes("private-"));
});

test("SSE intermediate chunks can omit finishReason while thought parts never reach previews", async () => {
  const { streamGeminiText } = await import("../src/gemini-text-generation.js");
  const previews = [];
  const chunks = [
    { candidates: [{ content: { parts: [{ thought: true, text: "private-thought" }] } }] },
    { candidates: [{ content: { parts: [{ text: "완료된 " }] } }] },
    { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "자막" }] } }] },
  ];
  const body = new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
    controller.close();
  } });
  assert.deepEqual(await streamGeminiText({
    apiKey: TEST_API_KEY, model: "model-one", onPartial: (text) => previews.push(text),
    fetchImpl: async () => new Response(body),
  }), { text: "완료된 자막" });
  assert.deepEqual(previews, ["완료된 ", "완료된 자막"]);
});
