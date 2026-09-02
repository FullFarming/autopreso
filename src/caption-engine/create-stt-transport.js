import { selectGeminiTranscriptionVocabularyFromLegacyText } from "../../packages/caption-core/index.js";
import { normalizeEngineSelection } from "../../packages/caption-core/caption-engine-catalog.js";
import { createGeminiTranscribeTransport, geminiTranscribeContract } from "../gemini-live-transcribe.js";
import { createSonioxTransport } from "./soniox-transport.js";

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
    return (createSonioxTransportImpl ?? createSonioxTransport)({
      engine: selection,
      settings,
      apiKey: apiKeys?.soniox ?? "",
    });
  }
  throw new Error("ENGINE_SELECTION_INVALID");
}
