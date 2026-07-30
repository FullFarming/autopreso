import {
  preparePolishRequest,
  selectRelevantGlossary,
} from "../../packages/caption-core/index.js";

const DEFAULT_TIMEOUT_MS = 6_000;
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
export function createCaptionPolisher({ client, model = "gemini-3.6-flash", timeoutMs = DEFAULT_TIMEOUT_MS, defaultDomain = "" } = {}) {
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
    try {
      const response = await Promise.race([
        client.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: prepared.prompt }] }],
          config: {
            systemInstruction: prepared.system,
            thinkingConfig: { thinkingLevel: "minimal" },
            maxOutputTokens: 1_024,
          },
        }),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error("CAPTION_POLISH_TIMEOUT")), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timeoutHandle));
      const polished = String(response?.text
        ?? response?.candidates?.[0]?.content?.parts?.map((part) => part?.text ?? "").join("")
        ?? "").trim();
      return polished || translatedText;
    } catch (error) {
      console.warn(`[caption-polish] failed, using raw translation: ${safeProviderErrorIdentifier(error, "CAPTION_POLISH_FAILED")}`);
      return translatedText;
    }
  }

  return { polish };
}
