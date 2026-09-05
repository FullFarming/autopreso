import { createHash } from "node:crypto";
import { createGeminiAdmissionController, DEFAULT_GEMINI_LIMITS, validateGeminiLimits } from "./admission.js";
import {
  assertSafeOutputValue, isPlainObject, matchesJsonSchema,
  parseUsage, readStrictOutputText, safeErrorCode, sanitizeContents, sanitizeGenerationConfig,
  validateSessionId, WORKLOAD_OUTPUT_CODEPOINTS,
  resolveGeminiWorkloadModel,
} from "./policy.js";

const MAX_PROVIDER_RESPONSE_CODEPOINTS = 100_000;
const sharedAdmissions = new WeakMap();

function getSharedAdmission(apiKey, fetchFn, now, limits) {
  const normalizedLimits = validateGeminiLimits(limits);
  const limitKey = JSON.stringify(normalizedLimits);
  let clocks = sharedAdmissions.get(fetchFn);
  if (!clocks) { clocks = new WeakMap(); sharedAdmissions.set(fetchFn, clocks); }
  let credentials = clocks.get(now);
  if (!credentials) { credentials = new Map(); clocks.set(now, credentials); }
  const key = createHash("sha256").update(apiKey).digest("hex");
  const previous = credentials.get(key);
  if (previous) {
    if (previous.limitKey !== limitKey) throw new Error("INVALID_GEMINI_SHARED_ADMISSION");
    return previous.admission;
  }
  if (credentials.size >= 64) throw new Error("GEMINI_ADMISSION_CREDENTIAL_LIMIT");
  const admission = createGeminiAdmissionController({ limits: normalizedLimits, now });
  // Model-specific wrappers share one credential budget. Injected transports
  // and clocks remain isolated for tests; changing models never resets quotas.
  credentials.set(key, { admission, limitKey });
  return admission;
}

/**
 * @param {{
 *   apiKey?: string,
 *   model?: string,
 *   fetchFn?: typeof fetch,
 *   limits?: object,
 *   observe?: (event: unknown) => void,
 *   now?: () => number,
 * }} [options]
 */
export function createGeminiRestRecapGenerator({ apiKey, model = undefined, fetchFn = globalThis.fetch, limits = DEFAULT_GEMINI_LIMITS, observe = () => undefined, now = Date.now } = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 512 || /[\p{Cc}\p{Cf}]/u.test(apiKey)
    || typeof fetchFn !== "function" || typeof observe !== "function" || typeof now !== "function") throw new Error("INVALID_GEMINI_REST_RECAP_CONFIG");
  const selectedModel = resolveGeminiWorkloadModel("recap", model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent`;
  const admission = getSharedAdmission(apiKey, fetchFn, now, limits);

  return Object.freeze({
    async generateContent(input = {}) {
      const allowedKeys = new Set(["maxOutputTokens", "prompt", "schema", "sessionId", "signal"]);
      if (!isPlainObject(input) || Object.keys(input).some((key) => !allowedKeys.has(key)) || !isPlainObject(input.schema)
        || input.schema.type !== "object" || input.schema.additionalProperties !== false || !Number.isSafeInteger(input.maxOutputTokens)) {
        throw new Error("INVALID_GEMINI_REST_RECAP_REQUEST");
      }
      validateSessionId(input.sessionId);
      if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw new Error("INVALID_GEMINI_ABORT_SIGNAL");
      const contents = sanitizeContents([{ role: "user", parts: [{ text: input.prompt }] }]);
      const generationConfig = {
        ...sanitizeGenerationConfig({
          responseMimeType: "application/json",
          responseJsonSchema: input.schema,
          maxOutputTokens: input.maxOutputTokens,
        }),
        thinkingConfig: { thinkingLevel: "medium" },
      };
      admission.acquire(input.sessionId);
      const startedAt = now();
      let usage = parseUsage(undefined);
      try {
        const response = await fetchFn(url, {
          method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({ contents, generationConfig }), signal: input.signal,
        });
        if (!response?.ok) throw new Error(response?.status === 429 ? "GEMINI_PROVIDER_RATE_LIMITED" : "GEMINI_PROVIDER_FAILED");
        const payload = await response.json();
        usage = parseUsage(payload?.usageMetadata);
        let serializedPayload;
        try { serializedPayload = JSON.stringify(payload); } catch { throw new Error("GEMINI_PROVIDER_FAILED"); }
        if (Array.from(serializedPayload).length > MAX_PROVIDER_RESPONSE_CODEPOINTS) throw new Error("GEMINI_PROVIDER_FAILED");
        const outputText = readStrictOutputText(payload, WORKLOAD_OUTPUT_CODEPOINTS.recap);
        let parsed;
        try { parsed = JSON.parse(outputText); } catch { throw new Error("GEMINI_OUTPUT_SCHEMA_INVALID"); }
        if (!matchesJsonSchema(parsed, input.schema)) throw new Error("GEMINI_OUTPUT_SCHEMA_INVALID");
        assertSafeOutputValue(parsed);
        safelyObserve({ workload: "recap", model: selectedModel,
          latencyMilliseconds: elapsedMilliseconds(startedAt), ...usage, code: "OK" });
        return { outputText };
      } catch (error) {
        const code = safeErrorCode(error);
        safelyObserve({ workload: "recap", model: selectedModel,
          latencyMilliseconds: elapsedMilliseconds(startedAt), ...usage, code });
        throw new Error(code);
      } finally {
        admission.release(input.sessionId);
      }
    },
    releaseSession(sessionId) { admission.releaseSession(sessionId); },
  });

  function elapsedMilliseconds(startedAt) {
    const elapsed = now() - startedAt;
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
  }
  function safelyObserve(event) { try { observe(Object.freeze(event)); } catch { /* Metrics never alter provider semantics. */ } }
}
