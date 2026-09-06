import { selectGeminiTranscriptionVocabularyFromLegacyText } from "../../packages/caption-core/index.js";
import { normalizeEngineSelection } from "../../packages/caption-core/caption-engine-catalog.js";
import { createGeminiTranscribeTransport, geminiTranscribeContract, geminiTranscribeLanguageCodes } from "../gemini-live-transcribe.js";
import { createSonioxTransport } from "./soniox-transport.js";

/**
 * Picks the STT transport for the selected engine. Every transport exposes:
 * { requiresSetupAck, providerLabel, maximumSessionMilliseconds, assertReady(),
 *   connect({createWebSocket}), setupPayloads(), audioPayload(base64Pcm24k),
 *   handleMessage(raw, ctx), closePayload() }
 * Optional, for combined/long-session providers such as Soniox:
 * { binaryAudio, replayRingBytes, rolloverMilliseconds, replayPayloads(),
 *   keepalivePayload(), finalizePayload(), dispose() }
 * `assertReady()` owns all start-time validation - `setupPayloads()` must never
 * throw, because it runs inside the WebSocket "open" listener. Payloads that
 * are Buffers travel as binary frames when `binaryAudio` is set; strings
 * (including an empty closePayload()) always travel as text frames.
 * ctx callbacks: onTransportReady, onInterim, onFinal, onTranslation?, onBoundary?,
 * onServerGoAway, onError?, broadcast, sendControl(text) -> boolean (transport-
 * initiated control frame on the live socket; Soniox's finalize uses it)
 *
 * `rolloverOffsetMilliseconds` staggers a long-session provider's roll per
 * input (see soniox-transport.js); the Gemini transport rolls on the client's
 * shared 9.5-minute timer and ignores it.
 *
 * @param {{engine?: unknown, settings?: Record<string, unknown>, apiKeys?: Record<string, string>,
 *   rolloverOffsetMilliseconds?: number, createSonioxTransportImpl?: Function}} input
 */
export function createSttTransport({ engine, settings = {}, apiKeys, rolloverOffsetMilliseconds = 0, createSonioxTransportImpl } = {}) {
  const selection = normalizeEngineSelection(engine);
  if (selection.stt.provider === "gemini") {
    const apiKey = apiKeys?.gemini ?? "";
    const transport = createGeminiTranscribeTransport({
      apiKey,
      languageCodes: geminiTranscribeLanguageCodes(selection.stt.languageMode),
      customVocabulary: [...selectGeminiTranscriptionVocabularyFromLegacyText(settings.glossary ?? "")],
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
      rolloverOffsetMilliseconds,
    });
  }
  throw new Error("ENGINE_SELECTION_INVALID");
}
