import { selectGeminiTranscriptionVocabularyFromLegacyText } from "../../packages/caption-core/index.js";
import { normalizeEngineSelection } from "../../packages/caption-core/caption-engine-catalog.js";
import { createGeminiTranscribeTransport, geminiTranscribeContract } from "../gemini-live-transcribe.js";

/**
 * Picks the STT transport for the selected engine. Every transport exposes:
 * { requiresSetupAck, providerLabel, maximumSessionMilliseconds, assertReady(),
 *   connect({createWebSocket}), setupPayloads(), audioPayload(base64Pcm24k),
 *   handleMessage(raw, ctx), closePayload() }
 * ctx callbacks: onTransportReady, onInterim, onFinal, onTranslation?, onBoundary?,
 * onServerGoAway, broadcast
 *
 * @param {{engine?: unknown, settings?: Record<string, unknown>, apiKeys?: Record<string, string>,
 *   createSonioxTransportImpl?: Function}} input
 */
export function createSttTransport({ engine, settings = {}, apiKeys, createSonioxTransportImpl } = {}) {
  const selection = normalizeEngineSelection(engine);
  if (selection.stt.provider === "gemini") {
    const apiKey = apiKeys?.gemini ?? "";
    const transport = createGeminiTranscribeTransport({
      apiKey,
      customVocabulary: [...selectGeminiTranscriptionVocabularyFromLegacyText(settings.glossary)],
    });
    return Object.assign(transport, {
      providerLabel: "Gemini Transcribe",
      maximumSessionMilliseconds: geminiTranscribeContract.maximumSessionMilliseconds,
      assertReady() {
        if (!String(apiKey).trim()) throw new Error("Gemini API key is required for realtime subtitles.");
      },
    });
  }
  if (selection.stt.provider === "soniox") {
    // Task 5 supplies the real implementation; until then a Soniox selection
    // fails loudly instead of silently falling back to a paid Gemini session.
    if (typeof createSonioxTransportImpl !== "function") throw new Error("SONIOX_TRANSPORT_UNAVAILABLE");
    return createSonioxTransportImpl({ engine: selection, settings, apiKey: apiKeys?.soniox ?? "" });
  }
  throw new Error("ENGINE_SELECTION_INVALID");
}
