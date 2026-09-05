import { createCaptionPcmResampler } from "../caption-pcm-resampler.js";
import {
  SONIOX_CONTROL,
  SONIOX_ENDPOINTS,
  buildSonioxConfig,
  createSonioxFinalizeScheduler,
  createSonioxTokenReducer,
  hasSonioxContentTokens,
  sonioxLanguageCode,
} from "../../packages/caption-core/soniox-protocol.js";
import { selectGeminiTranscriptionVocabularyFromLegacyText } from "../../packages/caption-core/index.js";

const REPLAY_RING_BYTES = 48_000; // 1.5 s of 16 kHz mono PCM16
const MAXIMUM_SESSION_MS = 18_000_000; // Soniox's 300-min stream cap
const ROLLOVER_MS = 17_400_000; // 290 min, under the cap
const ROLLOVER_HEADROOM_MS = 60_000; // an offset may never push the roll into the cap
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

// A pending finalize must never be what keeps the host process alive.
function setUnrefTimer(callback, delay) {
  const timer = setTimeout(callback, delay);
  timer.unref?.();
  return timer;
}

/**
 * Same surface as createGeminiTranscribeTransport plus:
 *  binaryAudio: true            - audioPayload returns a Buffer to send as a binary frame
 *  requiresSetupAck: false      - Soniox has no setupComplete; first result = ready
 *  replayPayloads()             - last 1.5 s of already-resampled PCM for reconnect/mode switch
 *  keepalivePayload()           - JSON keepalive control message
 *  finalizePayload()            - JSON manual-finalize control message
 *  closePayload()               - "" : end of audio is an EMPTY TEXT frame (spike
 *                                 2026-09-02: an empty binary frame never finishes)
 *  dispose()                    - cancels the finalize timer (client calls it on close)
 *  ctx.sendControl(text)        - hook the transport uses to send a control frame on
 *                                 its own initiative; returns whether it went out
 *
 * Finalize: continuous speech never yields `<end>` (spike 2026-09-02), so a
 * createSonioxFinalizeScheduler asks for `<fin>` after 1.2 s without new tokens
 * while final source text is pending, or at a 15 s segment cap, once per segment.
 *
 * Rollover stagger: `rolloverOffsetMilliseconds` shifts this transport's roll so
 * two inputs started together (desktop mic + system) do not reconnect in the
 * same instant and double the live Soniox connection count at the roll.
 *
 * @param {{engine: any, settings: Record<string, unknown>, apiKey?: string,
 *   endpoint?: "us"|"jp", now?: () => number, rolloverOffsetMilliseconds?: number,
 *   setTimer?: (callback: () => void, delay: number) => any, clearTimer?: (timer: any) => void}} input
 */
export function createSonioxTransport({
  engine, settings, apiKey, endpoint = "us", now = Date.now, setTimer = setUnrefTimer, clearTimer = clearTimeout,
  rolloverOffsetMilliseconds = 0,
}) {
  const rolloverOffset = Number.isFinite(rolloverOffsetMilliseconds) && rolloverOffsetMilliseconds > 0
    ? Math.trunc(rolloverOffsetMilliseconds) : 0;
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
  let scheduler = null;
  let lastCtx = null;
  let configJson = "";
  let lastSourceText = "";

  // Built once, at start time, from assertReady() - never from inside the
  // WebSocket "open" listener, where a throw would escape every try/catch the
  // client has and take the host process down with it.
  function buildConfigJson() {
    if (!configJson) {
      configJson = JSON.stringify(buildSonioxConfig({
        apiKey,
        languageMode: engine.stt.languageMode,
        languages,
        translation,
        targetLanguage: typeof settings.sonioxTargetLanguage === "string" ? settings.sonioxTargetLanguage : undefined,
        context: { terms: contextTerms, translationTerms, domain: settings.translationDomain ?? "" },
        clientReferenceId,
      }));
    }
    return configJson;
  }

  function targetLanguageFromProvider(language) {
    if (typeof settings.sonioxTargetLanguage === "string" && sonioxLanguageCode(settings.sonioxTargetLanguage) === language) return settings.sonioxTargetLanguage;
    return languages.find((target) => sonioxLanguageCode(target) === language) ?? language;
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
        targetLanguage: targetLanguageFromProvider(event.language),
        text: event.text,
        isFinal: false,
        sourceLanguage: event.sourceLanguage,
        sourceText: lastSourceText,
        segmentId: event.segmentId,
        provider: "soniox",
      }),
      onTranslationFinal: (event) => ctx.onTranslation?.({
        targetLanguage: targetLanguageFromProvider(event.language),
        text: event.text,
        isFinal: true,
        sourceLanguage: event.sourceLanguage,
        sourceText: lastSourceText,
        segmentId: event.segmentId,
        provider: "soniox",
      }),
      onBoundary: (kind) => {
        lastSourceText = "";
        scheduler?.noteBoundary();
        ctx.onBoundary?.(kind);
      },
    });
  }

  function makeScheduler() {
    return createSonioxFinalizeScheduler({
      now,
      setTimer,
      clearTimer,
      onFinalize: () => {
        // The client owns the socket and answers false when there is none to
        // send on; either way the next boundary (or the next setup) re-arms.
        try { lastCtx?.sendControl?.(SONIOX_CONTROL.finalize); } catch { /* socket gone; nothing to finalize */ }
      },
    });
  }

  return {
    requiresSetupAck: false,
    binaryAudio: true,
    // Tells the client this transport owns the translation: its source interims
    // are transcript progress, not a cue to buy a Gemini preview translation.
    providesTranslation: translation,
    providerLabel: "Soniox",
    maximumSessionMilliseconds: MAXIMUM_SESSION_MS,
    // Soniox streams for 300 minutes; rolling at 290 keeps the desktop well
    // inside that cap without paying a reconnect plus audio replay every 9.5
    // minutes the way the shared Gemini rollover would.
    rolloverMilliseconds: Math.min(ROLLOVER_MS + rolloverOffset, MAXIMUM_SESSION_MS - ROLLOVER_HEADROOM_MS),
    replayRingBytes: REPLAY_RING_BYTES,
    assertReady() {
      if (!String(apiKey ?? "").trim()) throw new Error("Soniox API key is required for realtime subtitles.");
      // Validate the whole config here so an unusable language/translation
      // combination surfaces as a start failure, not as a crash on open.
      buildConfigJson();
    },
    connect({ createWebSocket }) {
      return createWebSocket(SONIOX_ENDPOINTS[endpoint] ?? SONIOX_ENDPOINTS.us, undefined, {});
    },
    setupPayloads() {
      announcedReady = false;
      reducer = null;
      lastSourceText = "";
      // A new socket starts with a clean finalize clock; a timer armed for the
      // previous socket must not fire into this one.
      scheduler?.dispose();
      scheduler = makeScheduler();
      // Contract: never throws. assertReady() has normally validated and cached
      // the config already; if it was skipped and the config is unusable, an
      // empty list tells the client to fail the session instead of streaming
      // audio into a socket that was never configured.
      try {
        return [buildConfigJson()];
      } catch {
        return [];
      }
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
    finalizePayload() {
      // A finalize the client sends itself counts as in flight for the scheduler.
      scheduler?.noteFinalizeSent();
      return SONIOX_CONTROL.finalize;
    },
    // End of audio is an EMPTY TEXT frame. The spike measured the alternative:
    // an empty binary frame is ignored and the provider never sends `finished`.
    // Nothing is left to finalize on a stream that is ending, so the timer goes.
    closePayload() {
      scheduler?.dispose();
      return "";
    },
    dispose() { scheduler?.dispose(); },
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
      if (!scheduler) scheduler = makeScheduler();
      lastCtx = ctx;
      reducer.apply(message);
      // The segment clock starts with the first COMMITTED text: provisional
      // tokens alone are nothing to finalize, so they neither start nor postpone
      // it, and an empty result frame is not a new token either - neither may
      // delay (or, for a long provisional-only stretch, force) a finalize.
      if (hasSonioxContentTokens(message) && reducer.hasPendingFinalText()) {
        scheduler.noteTokens({ hasPendingFinalText: true, atMs: now() });
      }
      if (message?.finished === true) {
        scheduler.noteBoundary();
        ctx.onBoundary?.("stream-finished");
      }
    },
  };
}
