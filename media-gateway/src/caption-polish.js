import {
  captionPolishContract,
  preparePolishRequest,
  redactGeminiSensitiveText,
  GEMINI_WORKLOAD_MODEL_MATRIX,
  selectRelevantGlossary,
} from "../../packages/caption-core/index.js";

const DEFAULT_TIMEOUT_MS = captionPolishContract.timeoutMilliseconds;
const SAFE_PROVIDER_ERROR_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "RangeError",
  "TimeoutError",
  "TypeError",
]);

export { selectRelevantGlossary };

export function safeProviderErrorIdentifier(error, fallbackCode = "PROVIDER_ERROR") {
  const safeFallback = /^[A-Z][A-Z0-9_]{0,79}$/u.test(fallbackCode)
    ? fallbackCode
    : "PROVIDER_ERROR";
  if (!error || typeof error !== "object") return safeFallback;
  try {
    if (Number.isSafeInteger(error.code) && error.code >= 0 && error.code <= 9_999) {
      return `${safeFallback}_CODE_${error.code}`;
    }
    return error instanceof Error && SAFE_PROVIDER_ERROR_NAMES.has(error.name)
      ? error.name
      : safeFallback;
  } catch {
    return safeFallback;
  }
}

/**
 * @param {{
 *   client?: {models?: {generateContent?: (request: unknown) => Promise<{
 *     text?: unknown,
 *     candidates?: Array<{content?: {parts?: Array<{text?: unknown}>}}>,
 *   }>}},
 *   model?: string,
 *   timeoutMs?: number,
 *   defaultDomain?: string,
 * }} [options]
 */
export function createCaptionPolisher({ client, model = GEMINI_WORKLOAD_MODEL_MATRIX.polish, timeoutMs = DEFAULT_TIMEOUT_MS, defaultDomain = "" } = {}) {
  if (model !== GEMINI_WORKLOAD_MODEL_MATRIX.polish) throw new Error("GEMINI_MODEL_OVERRIDE_FORBIDDEN");
  const fallbackDomain = String(defaultDomain ?? "").trim();
  /**
   * @param {{
   *   translatedText?: unknown,
   *   sourceText?: unknown,
   *   targetLanguage?: unknown,
   *   tone?: unknown,
   *   glossary?: unknown,
   *   domain?: unknown,
   * }} [request]
   */
  async function polish({ translatedText, ...options } = {}) {
    const prepared = preparePolishRequest({ translatedText, ...options }, { defaultDomain: fallbackDomain });
    if (!prepared) return translatedText;
    if (!client?.models?.generateContent || !model) return translatedText;

    let timeoutHandle;
    const abortController = new AbortController();
    try {
      const response = await Promise.race([
        // 2026-08-31 fix: The session-bound runtime owns model selection; caller model fields reject dispatch.
        client.models.generateContent({
          contents: [{ role: "user", parts: [{ text: redactGeminiSensitiveText(prepared.prompt) }] }],
          config: {
            abortSignal: abortController.signal,
            systemInstruction: redactGeminiSensitiveText(prepared.system),
            maxOutputTokens: 1_024,
          },
        }),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            abortController.abort(new Error("CAPTION_POLISH_TIMEOUT"));
            reject(new Error("CAPTION_POLISH_TIMEOUT"));
          }, timeoutMs);
        }),
      ]).finally(() => clearTimeout(timeoutHandle));
      const polished = String(response?.text
        ?? response?.candidates?.[0]?.content?.parts?.map((part) => part?.text ?? "").join("")
        ?? "").trim();
      if (!polished
        || polished !== polished.normalize("NFC")
        || /[<>\p{Cc}\p{Cf}]/u.test(polished)
        || Array.from(polished).length > 4_000) return translatedText;
      return polished;
    } catch (error) {
      console.warn(`[caption-polish] failed, using raw translation: ${safeProviderErrorIdentifier(error, "CAPTION_POLISH_FAILED")}`);
      return translatedText;
    }
  }

  return { polish };
}
