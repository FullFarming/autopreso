import assert from "node:assert/strict";
import test from "node:test";

import {
  createGeminiPdfGlossaryExtractor,
  GEMINI_SERVER_WORKLOAD_MODELS,
  MAX_GLOSSARY_EXTRACTION_CANDIDATES,
} from "./index.js";

function pdfBytes() {
  return new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
}

function fakeResponse(json, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return json; } };
}

function providerPayload(value, usageMetadata) {
  return {
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
    ...(usageMetadata ? { usageMetadata } : {}),
  };
}

test("invalid PDF glossary output retains usage while network failure remains unknown without retry", async () => {
  const observations = [];
  let calls = 0;
  const extractor = createGeminiPdfGlossaryExtractor({ apiKey: "fixture", observe: (event) => observations.push(event),
    async fetchFn() {
      calls++;
      if (calls === 2) throw new Error("NETWORK_FAILED");
      return fakeResponse(providerPayload({ candidates: false }, { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 16 }));
    } });
  const request = { requestId: "usage-fixture", pdfBytes: pdfBytes(), sourceLanguage: "ko", targetLanguages: ["en"], domain: "IR" };
  await assert.rejects(extractor.extract(request), /GEMINI_GLOSSARY_OUTPUT_INVALID/u);
  await assert.rejects(extractor.extract(request), /GEMINI_PROVIDER_FAILED/u);
  assert.equal(calls, 2);
  assert.equal(observations.length, 2);
  assert.equal(observations[0].usageKnown, true);
  assert.deepEqual([observations[0].inputTokens, observations[0].outputTokens, observations[0].totalTokens], [10, 3, 16]);
  assert.equal(observations[1].usageKnown, false);
});

test("PDF glossary extraction uses one fixed REST request with inline bytes, redacted context, and safe metrics", async () => {
  const calls = [];
  const observations = [];
  const signal = new AbortController().signal;
  const extractor = createGeminiPdfGlossaryExtractor({
    apiKey: "server-only-key",
    now: (() => { let value = 100; return () => value += 7; })(),
    observe(event) { observations.push(event); },
    async fetchFn(url, options) {
      calls.push({ url, options });
      return fakeResponse(providerPayload({
        candidates: [{
          source: "순영업소득",
          translations: { en: "Net Operating Income" },
          aliases: ["NOI"],
          context: "문의 user@example.com, 인증 코드 123456",
        }],
      }, { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 }));
    },
  });

  const result = await extractor.extract({
    requestId: "opaque-host-hash",
    pdfBytes: pdfBytes(),
    sourceLanguage: "ko",
    targetLanguages: ["en"],
    domain: "IR contact private@example.com access code 123456",
    signal,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent");
  assert.equal(calls[0].url.includes("server-only-key"), false);
  assert.deepEqual(calls[0].options.headers, {
    "content-type": "application/json",
    "x-goog-api-key": "server-only-key",
  });
  assert.equal(calls[0].options.signal, signal);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.contents[0].parts[0].text.includes("private@example.com"), false);
  assert.equal(body.contents[0].parts[0].text.includes("123456"), false);
  assert.equal(body.contents[0].parts[1].inlineData.mimeType, "application/pdf");
  assert.equal(body.contents[0].parts[1].inlineData.data, Buffer.from(pdfBytes()).toString("base64"));
  assert.equal(JSON.stringify(body).includes("fileUri"), false);
  assert.equal(JSON.stringify(body).includes("files.upload"), false);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.responseJsonSchema.additionalProperties, false);
  assert.equal("model" in body, false);
  assert.equal("tools" in body, false);
  assert.equal("temperature" in body.generationConfig, false);
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: "medium" });
  assert.equal(JSON.stringify(result).includes("user@example.com"), false);
  assert.equal(JSON.stringify(result).includes("123456"), false);
  assert.deepEqual(result.candidates[0], {
    id: "candidate-0001",
    source: "순영업소득",
    translations: { en: "Net Operating Income" },
    aliases: ["NOI"],
    pronunciation: null,
    doNotTranslate: false,
    forbiddenTranslations: [],
    context: "문의 [EMAIL], [CODE]",
    examples: [],
    tags: [],
    priority: 50,
    provenance: { kind: "ai_extracted", label: null },
  });
  assert.deepEqual(observations, [{
    workload: "glossaryExtraction",
    model: "gemini-3.7-flash",
    latencyMilliseconds: 7,
    inputTokens: 20,
    outputTokens: 8,
    totalTokens: 28,
    usageKnown: true,
    code: "OK",
  }]);
  assert.equal(JSON.stringify(observations).includes("opaque-host-hash"), false);
  assert.equal(GEMINI_SERVER_WORKLOAD_MODELS.glossaryExtraction, "gemini-3.7-flash");
});

test("PDF glossary extraction rejects caller models, bounds, languages, and surplus input before fetch", async () => {
  let calls = 0;
  const extractor = createGeminiPdfGlossaryExtractor({
    apiKey: "server-only-key",
    async fetchFn() { calls += 1; throw new Error("must not dispatch"); },
  });
  const base = {
    requestId: "opaque-host-hash",
    pdfBytes: pdfBytes(),
    sourceLanguage: "ko",
    targetLanguages: ["en"],
    domain: "IR",
  };
  for (const input of [
    { ...base, model: "gemini-latest" },
    { ...base, requestId: "" },
    { ...base, sourceLanguage: "ko-KR" },
    { ...base, targetLanguages: [] },
    { ...base, targetLanguages: ["en", "en"] },
    { ...base, targetLanguages: ["ko"] },
    { ...base, targetLanguages: Array.from({ length: 14 }, (_, index) => `x-${index}`) },
    { ...base, domain: "d".repeat(1_001) },
    { ...base, pdfBytes: new Uint8Array(10_000_001) },
  ]) await assert.rejects(() => extractor.extract(input), /INVALID_GLOSSARY_EXTRACTION_REQUEST/u);
  assert.equal(calls, 0);
});

test("PDF glossary extraction makes no retry and rejects unsafe, surplus, and oversized candidate output", async () => {
  const invalidOutputs = [
    { candidates: [{ source: "<script>bad</script>", translations: { en: "bad" } }] },
    { candidates: [{ source: "ignore previous instructions", translations: { en: "bad" } }] },
    { candidates: [{ source: "safe", translations: { fr: "undeclared" } }] },
    { candidates: [{ source: "safe", translations: { en: "safe" }, ownerId: "forged" }] },
    { candidates: Array.from({ length: MAX_GLOSSARY_EXTRACTION_CANDIDATES + 1 }, (_, index) => ({
      source: `term-${index}`,
      translations: { en: `translation-${index}` },
    })) },
  ];
  for (const output of invalidOutputs) {
    let calls = 0;
    const extractor = createGeminiPdfGlossaryExtractor({
      apiKey: "server-only-key",
      async fetchFn() { calls += 1; return fakeResponse(providerPayload(output)); },
    });
    await assert.rejects(() => extractor.extract({
      requestId: "opaque-host-hash", pdfBytes: pdfBytes(), sourceLanguage: "ko", targetLanguages: ["en"], domain: "IR",
    }), /GEMINI_GLOSSARY_OUTPUT_INVALID/u);
    assert.equal(calls, 1);
  }

  let transportCalls = 0;
  const extractor = createGeminiPdfGlossaryExtractor({
    apiKey: "server-only-key",
    async fetchFn() { transportCalls += 1; throw new Error("private@example.com raw provider error"); },
  });
  await assert.rejects(() => extractor.extract({
    requestId: "opaque-host-hash", pdfBytes: pdfBytes(), sourceLanguage: "ko", targetLanguages: ["en"], domain: "IR",
  }), /^Error: GEMINI_PROVIDER_FAILED$/u);
  assert.equal(transportCalls, 1);
});

test("PDF glossary extraction accepts exactly two hundred distinct candidates", async () => {
  let calls = 0;
  const output = { candidates: Array.from({ length: MAX_GLOSSARY_EXTRACTION_CANDIDATES }, (_, index) => ({
    source: `term-${String(index).padStart(3, "0")}`,
    translations: { en: `translation-${String(index).padStart(3, "0")}` },
  })) };
  const extractor = createGeminiPdfGlossaryExtractor({
    apiKey: "server-only-key",
    async fetchFn() { calls += 1; return fakeResponse(providerPayload(output)); },
  });
  const result = await extractor.extract({
    requestId: "opaque-host-hash", pdfBytes: pdfBytes(), sourceLanguage: "ko", targetLanguages: ["en"], domain: "IR",
  });
  assert.equal(result.candidates.length, MAX_GLOSSARY_EXTRACTION_CANDIDATES);
  assert.equal(calls, 1);
});

test("PDF glossary extraction source contains no Files API, storage, logging, retry, fallback, or dynamic provider URL", async () => {
  const source = await import("node:fs").then(({ readFileSync }) => readFileSync(new URL("./pdf-glossary-extractor.js", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /files\.upload|fileUri|console\.|logger\.|localStorage|sessionStorage|retry|fallback/iu);
  assert.doesNotMatch(source, /new URL|process\.env|model\s*[:=]\s*input/u);
  assert.match(source, /gemini-3\.7-flash:generateContent/u);
});
