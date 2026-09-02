import { createCaptionPcmResampler } from "../caption-pcm-resampler.js";
import {
  SONIOX_CONTROL,
  SONIOX_ENDPOINTS,
  buildSonioxConfig,
  createSonioxTokenReducer,
} from "../../packages/caption-core/soniox-protocol.js";
import { selectGeminiTranscriptionVocabularyFromLegacyText } from "../../packages/caption-core/index.js";

const REPLAY_RING_BYTES = 48_000; // 1.5 s of 16 kHz mono PCM16
const MAX_MESSAGE_BYTES = 1_048_576;
const ERROR_CODES = Object.freeze({
  invalid_request: "SONIOX_INVALID_REQUEST",
  unauthenticated: "SONIOX_UNAUTHENTICATED",
  temp_api_key_session_expired: "SONIOX_KEY_EXPIRED",
  limit_exceeded: "SONIOX_RATE_LIMITED",
  service_unavailable: "SONIOX_UNAVAILABLE",
  max_duration_reached: "SONIOX_MAX_DURATION",
});

/**
 * `source = target` glossary rows, the only legacy shape Soniox can consume as
 * a translation hint. Rows with zero or several `=` are terminology prose, not
 * a pair, and are ignored rather than guessed at.
 *
 * @param {unknown} glossary
 * @returns {Array<{source: string, target: string}>}
 */
function translationTermsFromLegacyGlossary(glossary) {
  return String(glossary ?? "").split("\n")
    .map((line) => line.split("="))
    .filter((parts) => parts.length === 2)
    .map((parts) => parts.map((part) => part.trim()))
    .filter(([source, target]) => source && target)
    .map(([source, target]) => ({ source, target }));
}

/**
 * Same surface as createGeminiTranscribeTransport plus:
 *  binaryAudio: true            - audioPayload returns a Buffer to send as a binary frame
 *  requiresSetupAck: false      - Soniox has no setupComplete; first result = ready
 *  replayPayloads()             - last 1.5 s of already-resampled PCM for reconnect/mode switch
 *  keepalivePayload()           - JSON keepalive control message
 *
 * @param {{engine: any, settings: Record<string, unknown>, apiKey?: string,
 *   endpoint?: "us"|"jp", now?: () => number}} input
 */
export function createSonioxTransport({ engine, settings, apiKey, endpoint = "us", now = Date.now }) {
  const resample = createCaptionPcmResampler();
  const languages = Array.isArray(settings.translationLanguages) ? settings.translationLanguages : ["en", "ko"];
  const translation = engine.translation.provider === "soniox";
  const glossaryTerms = selectGeminiTranscriptionVocabularyFromLegacyText(settings.glossary ?? "");
  const translationTerms = translationTermsFromLegacyGlossary(settings.glossary);
  // The Gemini vocabulary selector only admits rows it can classify as terms;
  // Soniox's context window is far larger, so both sides of every explicit
  // `source = target` row are also worth biasing recognition towards.
  const contextTerms = [...glossaryTerms, ...translationTerms.flatMap((pair) => [pair.source, pair.target])];
  const clientReferenceId = `nova-desktop-${now().toString(36)}`;
  const ring = [];
  let ringBytes = 0;
  let announcedReady = false;
  let reducer = null;
  let configJson = "";
  let lastSourceText = "";

  function setupMessage() {
    if (!configJson) {
      configJson = JSON.stringify(buildSonioxConfig({
        apiKey,
        languageMode: engine.stt.languageMode,
        languages,
        translation,
        context: { terms: contextTerms, translationTerms, domain: settings.translationDomain ?? "" },
        clientReferenceId,
      }));
    }
    return configJson;
  }

  function makeReducer(ctx) {
    return createSonioxTokenReducer({
      onSourcePartial: (event) => {
        lastSourceText = event.text;
        ctx.onInterim?.({ text: event.text, languageCode: event.language ?? undefined, segmentId: event.segmentId });
      },
      onSourceFinal: (event) => {
        lastSourceText = event.text;
        ctx.onFinal?.({
          text: event.text,
          languageCode: event.language ?? undefined,
          segmentId: event.segmentId,
          startMs: event.startMs,
          endMs: event.endMs,
          providerTranslated: translation,
        });
      },
      onTranslationPartial: (event) => ctx.onTranslation?.({
        targetLanguage: event.language,
        text: event.text,
        isFinal: false,
        sourceLanguage: event.sourceLanguage,
        sourceText: lastSourceText,
        segmentId: event.segmentId,
        provider: "soniox",
      }),
      onTranslationFinal: (event) => ctx.onTranslation?.({
        targetLanguage: event.language,
        text: event.text,
        isFinal: true,
        sourceLanguage: event.sourceLanguage,
        sourceText: lastSourceText,
        segmentId: event.segmentId,
        provider: "soniox",
      }),
      onBoundary: (kind) => {
        lastSourceText = "";
        ctx.onBoundary?.(kind);
      },
    });
  }

  return {
    requiresSetupAck: false,
    binaryAudio: true,
    providerLabel: "Soniox",
    maximumSessionMilliseconds: 18_000_000,
    replayRingBytes: REPLAY_RING_BYTES,
    assertReady() {
      if (!String(apiKey ?? "").trim()) throw new Error("Soniox API key is required for realtime subtitles.");
    },
    connect({ createWebSocket }) {
      return createWebSocket(SONIOX_ENDPOINTS[endpoint] ?? SONIOX_ENDPOINTS.us, undefined, {});
    },
    setupPayloads() {
      announcedReady = false;
      reducer = null;
      lastSourceText = "";
      return [setupMessage()];
    },
    audioPayload(base64Pcm24k) {
      const pcm16k = resample(Buffer.from(base64Pcm24k, "base64"));
      ring.push(pcm16k);
      ringBytes += pcm16k.length;
      while (ringBytes > REPLAY_RING_BYTES && ring.length > 1) ringBytes -= ring.shift().length;
      return pcm16k;
    },
    replayPayloads() { return [...ring]; },
    keepalivePayload() { return SONIOX_CONTROL.keepalive; },
    finalizePayload() { return SONIOX_CONTROL.finalize; },
    closePayload() { return Buffer.alloc(0); }, // empty binary frame = end of audio
    handleMessage(raw, ctx = {}) {
      let message;
      try {
        const encoded = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        if (Buffer.byteLength(encoded, "utf8") > MAX_MESSAGE_BYTES) throw new Error("too large");
        message = JSON.parse(encoded);
      } catch {
        ctx.onError?.("SONIOX_MESSAGE_INVALID");
        return;
      }
      if (message && typeof message.error_type === "string") {
        ctx.onError?.(ERROR_CODES[message.error_type] ?? "SONIOX_PROVIDER_FAILED", {
          requestId: typeof message.request_id === "string" ? message.request_id.slice(0, 128) : null,
        });
        return;
      }
      if (!announcedReady) { announcedReady = true; ctx.onTransportReady?.(); }
      if (!reducer) reducer = makeReducer(ctx);
      reducer.apply(message);
      if (message?.finished === true) ctx.onBoundary?.("stream-finished");
    },
  };
}
