import { redactGeminiSensitiveText } from "../packages/caption-core/index.js";

const GEMINI_TEXT_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * @typedef {{
 *   apiKey?: unknown,
 *   model?: unknown,
 *   system?: string,
 *   prompt?: string,
 *   abortSignal?: AbortSignal,
 *   fetchImpl?: typeof globalThis.fetch,
 *   onPartial?: (text: string) => void,
 *   responseJsonSchema?: Record<string, unknown>,
 * }} GeminiTextOptions
 */

/** @typedef {{thinkingConfig: {thinkingLevel: string}, maxOutputTokens: number, responseMimeType?: string, responseJsonSchema?: Record<string, unknown>}} GeminiGenerationConfig */

/** @param {GeminiTextOptions} [options] */
export async function generateGeminiText({ apiKey, model, system = "", prompt = "", abortSignal, fetchImpl = globalThis.fetch } = {}) {
  return generateGeminiTextRequest({ apiKey, model, system, prompt, abortSignal, fetchImpl });
}

/** @param {GeminiTextOptions} [options] */
export async function generateGeminiStructuredJson({
  apiKey,
  model,
  system = "",
  prompt = "",
  abortSignal,
  fetchImpl = globalThis.fetch,
  responseJsonSchema,
} = {}) {
  return generateGeminiTextRequest({
    apiKey,
    model,
    system,
    prompt,
    abortSignal,
    fetchImpl,
    generationConfig: {
      thinkingConfig: { thinkingLevel: "low" },
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
      ...(responseJsonSchema ? { responseJsonSchema } : {}),
    },
  });
}

/** @param {GeminiTextOptions} [options] */
export async function streamGeminiText({ apiKey, model, system = "", prompt = "", abortSignal, fetchImpl = globalThis.fetch, onPartial } = {}) {
  const { key, modelId } = validateGeminiTextOptions({ apiKey, model, fetchImpl });
  const response = await fetchImpl(`${GEMINI_TEXT_API_BASE}/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": key,
    },
    signal: abortSignal,
    body: JSON.stringify(buildGenerateContentBody({
      system,
      prompt,
      generationConfig: {
        thinkingConfig: { thinkingLevel: "low" },
        maxOutputTokens: 2048,
      },
    })),
  });

  if (!response.ok) {
    throw new Error(`Gemini text generation failed: HTTP ${response.status}`);
  }

  let text = "";
  for await (const chunkText of readSseTextChunks(response.body)) {
    text += chunkText;
    if (typeof onPartial === "function") onPartial(text);
  }
  return { text: text.trim() };
}

/** @param {{apiKey?: unknown, model?: unknown, fetchImpl?: typeof globalThis.fetch}} options */
function validateGeminiTextOptions({ apiKey, model, fetchImpl }) {
  const key = String(apiKey ?? "").trim();
  const modelId = String(model ?? "").trim();
  if (!key) throw new Error("Gemini API key is required.");
  if (!modelId) throw new Error("Gemini text model is required.");
  if (typeof fetchImpl !== "function") throw new Error("fetch is required for Gemini text generation.");
  return { key, modelId };
}

/** @param {GeminiTextOptions & {generationConfig?: GeminiGenerationConfig}} [options] */
async function generateGeminiTextRequest({
  apiKey,
  model,
  system = "",
  prompt = "",
  abortSignal,
  fetchImpl = globalThis.fetch,
  generationConfig = {
    thinkingConfig: { thinkingLevel: "low" },
    maxOutputTokens: 2048,
  },
} = {}) {
  const { key, modelId } = validateGeminiTextOptions({ apiKey, model, fetchImpl });

  const response = await fetchImpl(`${GEMINI_TEXT_API_BASE}/${encodeURIComponent(modelId)}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": key,
    },
    signal: abortSignal,
    body: JSON.stringify(buildGenerateContentBody({ system, prompt, generationConfig })),
  });

  if (!response.ok) {
    throw new Error(`Gemini text generation failed: HTTP ${response.status}`);
  }

  const body = await response.json();
  const text = extractTextFromResponseBody(body).trim();
  return { text: text || "" };
}

/** @param {{system: string, prompt: string, generationConfig: GeminiGenerationConfig}} options */
function buildGenerateContentBody({ system, prompt, generationConfig }) {
  const redactedSystem = redactGeminiSensitiveText(system);
  const redactedPrompt = redactGeminiSensitiveText(prompt);
  return {
    ...(redactedSystem ? { systemInstruction: { parts: [{ text: redactedSystem }] } } : {}),
    contents: [{ role: "user", parts: [{ text: redactedPrompt }] }],
    generationConfig,
  };
}

/** @param {ReadableStream<Uint8Array> | null} body */
async function* readSseTextChunks(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  if (!body) return;
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = findSseBoundary(buffer))) {
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const text = extractTextFromSseEvent(event);
      if (text) yield text;
    }
  }
  buffer += decoder.decode();
  const text = extractTextFromSseEvent(buffer);
  if (text) yield text;
}

/** @param {string} value */
function findSseBoundary(value) {
  const match = /\r?\n\r?\n/u.exec(value);
  return match ? { index: match.index, length: match[0].length } : null;
}

/** @param {string} event */
function extractTextFromSseEvent(event) {
  const lines = event.split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean);
  let text = "";
  for (const line of lines) {
    if (line === "[DONE]") continue;
    text += extractTextFromResponseBody(JSON.parse(line));
  }
  return text;
}

/** @param {unknown} body */
function extractTextFromResponseBody(body) {
  if (!body || typeof body !== "object" || !("candidates" in body) || !Array.isArray(body.candidates)) return "";
  const content = body.candidates[0]?.content;
  if (!content || typeof content !== "object" || !("parts" in content) || !Array.isArray(content.parts)) return "";
  return content.parts.map((part) => {
    if (!part || typeof part !== "object" || !("text" in part)) return "";
    return typeof part.text === "string" ? part.text : "";
  }).join("");
}
