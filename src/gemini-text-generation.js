import { redactGeminiSensitiveText } from "../packages/caption-core/index.js";

const GEMINI_TEXT_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** @type {Readonly<Record<string, string>>} */
const GEMINI_TEXT_FAILURE_MESSAGES = Object.freeze({
  GEMINI_TEXT_HTTP_ERROR: "Gemini text generation failed",
  GEMINI_TEXT_TIMEOUT: "Gemini text generation timed out.",
  GEMINI_TEXT_ABORTED: "Gemini text generation was cancelled.",
  GEMINI_TEXT_NETWORK_ERROR: "Gemini text transport failed.",
  GEMINI_TEXT_INVALID_RESPONSE: "Gemini text response was invalid.",
  GEMINI_TEXT_BLOCKED: "Gemini text response was blocked.",
  GEMINI_TEXT_TRUNCATED: "Gemini text response was incomplete.",
  GEMINI_TEXT_EMPTY: "Gemini text response was empty.",
});

export class GeminiTextGenerationError extends Error {
  /** @param {string} code @param {number} [status] */
  constructor(code, status) {
    const safeCode = Object.hasOwn(GEMINI_TEXT_FAILURE_MESSAGES, code) ? code : "GEMINI_TEXT_INVALID_RESPONSE";
    const safeStatus = safeCode === "GEMINI_TEXT_HTTP_ERROR" && Number.isInteger(status) && status >= 100 && status <= 599
      ? status : undefined;
    super(`${GEMINI_TEXT_FAILURE_MESSAGES[safeCode]}${safeStatus === undefined ? "" : `: HTTP ${safeStatus}`}`);
    this.name = "GeminiTextGenerationError";
    this.code = safeCode;
    this.status = safeStatus;
  }
}

/** @param {AbortSignal | undefined} signal */
function throwIfTextAborted(signal) {
  if (!signal?.aborted) return;
  throw new GeminiTextGenerationError(signal.reason?.name === "TimeoutError" ? "GEMINI_TEXT_TIMEOUT" : "GEMINI_TEXT_ABORTED");
}

/** @param {unknown} error @param {AbortSignal | undefined} signal */
function safeTextTransportFailure(error, signal) {
  throwIfTextAborted(signal);
  if (error instanceof GeminiTextGenerationError) return error;
  return new GeminiTextGenerationError(error instanceof TypeError ? "GEMINI_TEXT_NETWORK_ERROR" : "GEMINI_TEXT_INVALID_RESPONSE");
}

/** @param {Response} response @param {AbortSignal | undefined} signal */
async function rejectFailedHttpResponse(response, signal) {
  if (response.ok && !signal?.aborted) return;
  // 2026-08-31 fix: Release unread error bodies before a permitted summary attempt opens another connection.
  try { await response.body?.cancel(); }
  catch {
    throwIfTextAborted(signal);
    throw new GeminiTextGenerationError("GEMINI_TEXT_INVALID_RESPONSE");
  }
  throwIfTextAborted(signal);
  throw new GeminiTextGenerationError("GEMINI_TEXT_HTTP_ERROR", response.status);
}

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
  throwIfTextAborted(abortSignal);
  let response;
  try {
    response = await fetchImpl(`${GEMINI_TEXT_API_BASE}/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`, {
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
  } catch (error) { throw safeTextTransportFailure(error, abortSignal); }
  await rejectFailedHttpResponse(response, abortSignal);

  let text = "";
  try {
    for await (const chunkText of readSseTextChunks(response.body)) {
      throwIfTextAborted(abortSignal);
      text += chunkText;
      if (typeof onPartial === "function") onPartial(text);
    }
  } catch (error) {
    throw safeTextTransportFailure(error, abortSignal);
  }
  throwIfTextAborted(abortSignal);
  if (!text.trim()) throw new GeminiTextGenerationError("GEMINI_TEXT_EMPTY");
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
  throwIfTextAborted(abortSignal);
  let response;
  try {
    response = await fetchImpl(`${GEMINI_TEXT_API_BASE}/${encodeURIComponent(modelId)}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key,
      },
      signal: abortSignal,
      body: JSON.stringify(buildGenerateContentBody({ system, prompt, generationConfig })),
    });
  } catch (error) { throw safeTextTransportFailure(error, abortSignal); }
  await rejectFailedHttpResponse(response, abortSignal);
  let body;
  try { body = await response.json(); }
  catch {
    throwIfTextAborted(abortSignal);
    throw new GeminiTextGenerationError("GEMINI_TEXT_INVALID_RESPONSE");
  }
  throwIfTextAborted(abortSignal);
  const text = extractTextFromResponseBody(body, true).trim();
  if (!text) throw new GeminiTextGenerationError("GEMINI_TEXT_EMPTY");
  return { text };
}

// 2026-08-31 fix: Only summary availability failures may try another model; quota and configuration failures must stop.
const TRANSIENT_GEMINI_TEXT_STATUSES = new Set([408, 500, 502, 503, 504]);
const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 2_800;

/**
 * Summary-only availability routing: one attempt per distinct model.
 * Caption callers use generateGeminiText directly for exactly one request.
 *
 * @param {GeminiTextOptions & {models?: readonly unknown[], perAttemptTimeoutMs?: number}} [options]
 */
export async function generateGeminiTextWithModelFallback({
  apiKey,
  models = [],
  system = "",
  prompt = "",
  abortSignal,
  fetchImpl = globalThis.fetch,
  perAttemptTimeoutMs = DEFAULT_PER_ATTEMPT_TIMEOUT_MS,
} = {}) {
  const modelIds = [...new Set(models.map((value) => String(value ?? "").trim()).filter(Boolean))];
  if (modelIds.length === 0) throw new Error("Gemini text model is required.");
  let lastFailure = null;
  for (const modelId of modelIds) {
    throwIfTextAborted(abortSignal);
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort(abortSignal?.reason);
    abortSignal?.addEventListener("abort", abortAttempt, { once: true });
    const attemptTimer = setTimeout(() => attemptController.abort(new DOMException("Text generation deadline exceeded", "TimeoutError")), perAttemptTimeoutMs);
    try {
      return await generateGeminiTextRequest({
        apiKey, model: modelId, system, prompt, fetchImpl,
        abortSignal: attemptController.signal,
      });
    } catch (error) {
      lastFailure = error;
      throwIfTextAborted(abortSignal);
      if (!(error instanceof GeminiTextGenerationError)) throw error;
      const isTransientStatus = error.code === "GEMINI_TEXT_HTTP_ERROR" && TRANSIENT_GEMINI_TEXT_STATUSES.has(error.status);
      const isAttemptTimeout = error.code === "GEMINI_TEXT_TIMEOUT";
      const isNetworkFailure = error.code === "GEMINI_TEXT_NETWORK_ERROR";
      if (!isTransientStatus && !isAttemptTimeout && !isNetworkFailure) throw error;
    } finally {
      clearTimeout(attemptTimer);
      abortSignal?.removeEventListener("abort", abortAttempt);
    }
  }
  throw lastFailure ?? new Error("Gemini text generation failed: no model attempt completed.");
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
    let body;
    try { body = JSON.parse(line); }
    catch { throw new GeminiTextGenerationError("GEMINI_TEXT_INVALID_RESPONSE"); }
    text += extractTextFromResponseBody(body);
  }
  return text;
}

/** @param {unknown} body @param {boolean} [isFinal] */
function extractTextFromResponseBody(body, isFinal = false) {
  if (!body || typeof body !== "object") throw new GeminiTextGenerationError("GEMINI_TEXT_INVALID_RESPONSE");
  if ("promptFeedback" in body && body.promptFeedback && typeof body.promptFeedback === "object"
    && "blockReason" in body.promptFeedback && body.promptFeedback.blockReason
    && body.promptFeedback.blockReason !== "BLOCK_REASON_UNSPECIFIED") throw new GeminiTextGenerationError("GEMINI_TEXT_BLOCKED");
  if (!("candidates" in body) || !Array.isArray(body.candidates)) throw new GeminiTextGenerationError("GEMINI_TEXT_INVALID_RESPONSE");
  const candidate = body.candidates[0];
  if (!candidate) return "";
  if (candidate.finishReason === "MAX_TOKENS") throw new GeminiTextGenerationError("GEMINI_TEXT_TRUNCATED");
  if (Array.isArray(candidate.safetyRatings) && candidate.safetyRatings.some((rating) => rating?.blocked === true)) {
    throw new GeminiTextGenerationError("GEMINI_TEXT_BLOCKED");
  }
  if (candidate.finishReason !== undefined && candidate.finishReason !== "STOP") {
    const blockedReasons = ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"];
    throw new GeminiTextGenerationError(blockedReasons.includes(candidate.finishReason) ? "GEMINI_TEXT_BLOCKED" : "GEMINI_TEXT_INVALID_RESPONSE");
  }
  if (isFinal && candidate.finishReason !== "STOP") throw new GeminiTextGenerationError("GEMINI_TEXT_INVALID_RESPONSE");
  const content = candidate.content;
  if (!content || typeof content !== "object" || !("parts" in content) || !Array.isArray(content.parts)) return "";
  return content.parts.map((part) => {
    if (!part || typeof part !== "object" || !("text" in part)) return "";
    if (part.thought !== undefined && part.thought !== false) return "";
    return typeof part.text === "string" ? part.text : "";
  }).join("");
}
