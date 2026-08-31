import { createGeminiAdmissionController, DEFAULT_GEMINI_LIMITS, validateGeminiLimits } from "./admission.js";
import {
  assertSafeOutputValue, GEMINI_SERVER_WORKLOAD_MODELS, GEMINI_WORKLOAD_THINKING_LEVELS, GENERATE_WORKLOADS, isPlainObject,
  matchesJsonSchema, parseUsage, readStrictOutputText, safeErrorCode, sanitizeContents,
  sanitizeGenerationConfig, validateSessionId, WORKLOAD_OUTPUT_CODEPOINTS,
} from "./policy.js";

/**
 * @param {{
 *   GoogleGenAI?: new (options: object) => {
 *     models: { generateContent: (request: object) => Promise<Record<string, unknown>> },
 *     live: { connect: (...args: unknown[]) => unknown },
 *   },
 *   apiKey?: string,
 *   limits?: object,
 *   observe?: (event: unknown) => void,
 *   now?: () => number,
 * }} [options]
 */
export function createGeminiServerRuntime({ GoogleGenAI, apiKey, limits = DEFAULT_GEMINI_LIMITS, observe = () => undefined, now = Date.now } = {}) {
  if (typeof GoogleGenAI !== "function" || typeof apiKey !== "string" || !apiKey.trim()) throw new Error("INVALID_GEMINI_SERVER_CONFIG");
  const normalizedLimits = validateGeminiLimits(limits);
  if (typeof observe !== "function" || typeof now !== "function") throw new Error("INVALID_GEMINI_SERVER_CONFIG");
  const client = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
  if (typeof client?.models?.generateContent !== "function" || typeof client?.live?.connect !== "function") throw new Error("INVALID_GEMINI_SERVER_CLIENT");
  const admission = createGeminiAdmissionController({ limits: normalizedLimits, now });

  async function generateContent(input = {}) {
    const request = prepareDispatch(input);
    admission.acquire(request.sessionId);
    const startedAt = now();
    let usage = parseUsage(undefined);
    try {
      const response = await client.models.generateContent({
        model: GEMINI_SERVER_WORKLOAD_MODELS[request.workload],
        contents: request.contents,
        config: {
          ...request.config,
          thinkingConfig: { thinkingLevel: GEMINI_WORKLOAD_THINKING_LEVELS[request.workload] },
          abortSignal: request.signal,
        },
      });
      usage = parseUsage(response?.usageMetadata);
      const outputText = readStrictOutputText(response, WORKLOAD_OUTPUT_CODEPOINTS[request.workload]);
      safelyObserve({ workload: request.workload, model: GEMINI_SERVER_WORKLOAD_MODELS[request.workload],
        latencyMilliseconds: elapsedMilliseconds(startedAt), ...usage, code: "OK" });
      return { outputText };
    } catch (error) {
      const code = safeErrorCode(error);
      safelyObserve({ workload: request.workload, model: GEMINI_SERVER_WORKLOAD_MODELS[request.workload],
        latencyMilliseconds: elapsedMilliseconds(startedAt), ...usage, code });
      throw new Error(code);
    } finally {
      admission.release(request.sessionId);
    }
  }

  async function generateRecap(input = {}) {
    const allowedKeys = new Set(["maxOutputCodepoints", "prompt", "responseJsonSchema", "sessionId", "signal", "systemInstruction", "validate"]);
    if (!isPlainObject(input) || Object.keys(input).some((key) => !allowedKeys.has(key)) || typeof input.validate !== "function"
      || !isPlainObject(input.responseJsonSchema) || input.responseJsonSchema.type !== "object"
      || input.responseJsonSchema.additionalProperties !== false) throw new Error("INVALID_GEMINI_RECAP_REQUEST");
    const maxOutputCodepoints = input.maxOutputCodepoints ?? WORKLOAD_OUTPUT_CODEPOINTS.recap;
    if (!Number.isSafeInteger(maxOutputCodepoints) || maxOutputCodepoints < 1 || maxOutputCodepoints > WORKLOAD_OUTPUT_CODEPOINTS.recap) throw new Error("INVALID_GEMINI_RECAP_REQUEST");
    const { outputText } = await generateContent({
      sessionId: input.sessionId, workload: "recap",
      contents: [{ role: "user", parts: [{ text: input.prompt }] }],
      config: { systemInstruction: input.systemInstruction, responseMimeType: "application/json",
        responseJsonSchema: input.responseJsonSchema, maxOutputTokens: 4_096 }, signal: input.signal,
    });
    if (Array.from(outputText).length > maxOutputCodepoints) throw new Error("GEMINI_OUTPUT_TOO_LARGE");
    let parsed;
    try { parsed = JSON.parse(outputText); } catch { throw new Error("GEMINI_OUTPUT_SCHEMA_INVALID"); }
    if (!matchesJsonSchema(parsed, input.responseJsonSchema)) throw new Error("GEMINI_OUTPUT_SCHEMA_INVALID");
    let validated;
    try { validated = input.validate(parsed); } catch { throw new Error("GEMINI_RECAP_VALIDATION_FAILED"); }
    assertSafeOutputValue(validated);
    return validated;
  }

  function createSessionClient(sessionId, workload) {
    validateSessionId(sessionId);
    if (!GENERATE_WORKLOADS.has(workload)) throw new Error("INVALID_GEMINI_WORKLOAD");
    return Object.freeze({ models: Object.freeze({
      async generateContent(request = {}) {
        if (!isPlainObject(request) || Object.keys(request).some((key) => !["config", "contents"].includes(key))) throw new Error("INVALID_GEMINI_DISPATCH");
        const config = { ...(request.config ?? {}) };
        const signal = config.abortSignal;
        delete config.abortSignal;
        const { outputText } = await generateContent({ sessionId, workload, contents: request.contents, config, signal });
        return { text: outputText };
      },
    }) });
  }

  function prepareDispatch(input) {
    const allowedKeys = new Set(["config", "contents", "sessionId", "signal", "workload"]);
    if (!isPlainObject(input) || Object.keys(input).some((key) => !allowedKeys.has(key))) throw new Error("INVALID_GEMINI_DISPATCH");
    const sessionId = validateSessionId(input.sessionId);
    if (!GENERATE_WORKLOADS.has(input.workload)) throw new Error("INVALID_GEMINI_WORKLOAD");
    if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw new Error("INVALID_GEMINI_ABORT_SIGNAL");
    return { sessionId, workload: input.workload, contents: sanitizeContents(input.contents),
      config: sanitizeGenerationConfig(input.config), signal: input.signal };
  }

  function elapsedMilliseconds(startedAt) {
    const elapsed = now() - startedAt;
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
  }
  function safelyObserve(event) { try { observe(Object.freeze(event)); } catch { /* Metrics never alter provider semantics. */ } }

  return Object.freeze({ generateContent, generateRecap, createSessionClient, getLiveClient() { return client; },
    releaseSession(sessionId) { admission.releaseSession(sessionId); } });
}
