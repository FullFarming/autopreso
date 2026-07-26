import {
  preparePolishRequest,
  selectRelevantGlossary,
} from "../../packages/caption-core/index.js";

const DEFAULT_TIMEOUT_MS = 6_000;

export { selectRelevantGlossary };

export function createCaptionPolisher({ client, model = "gemini-3.5-flash", timeoutMs = DEFAULT_TIMEOUT_MS, defaultDomain = "" } = {}) {
  const fallbackDomain = String(defaultDomain ?? "").trim();
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
            temperature: 0.2,
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
      console.warn(`[caption-polish] failed, using raw translation: ${error instanceof Error ? error.message : error}`);
      return translatedText;
    }
  }

  return { polish };
}
