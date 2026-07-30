const GEMINI_TEXT_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** @param {any} options */
export async function generateGeminiText({ apiKey, model, system = "", prompt = "", abortSignal, fetchImpl = globalThis.fetch } = {}) {
  const key = String(apiKey ?? "").trim();
  const modelId = String(model ?? "").trim();
  if (!key) throw new Error("Gemini API key is required.");
  if (!modelId) throw new Error("Gemini text model is required.");
  if (typeof fetchImpl !== "function") throw new Error("fetch is required for Gemini text generation.");

  const response = await fetchImpl(`${GEMINI_TEXT_API_BASE}/${encodeURIComponent(modelId)}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": key,
    },
    signal: abortSignal,
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        thinkingConfig: { thinkingLevel: "minimal" },
        maxOutputTokens: 2048,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini text generation failed: HTTP ${response.status}`);
  }

  const body = await response.json();
  const text = body?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text ?? "")
    .join("")
    .trim();
  return { text: text || "" };
}
