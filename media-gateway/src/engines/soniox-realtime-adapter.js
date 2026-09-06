/**
 * Soniox `stt-rt-v5` WebSocket adapter implementing the gateway STT provider
 * contract (`open()` → stream handle), for the combined STT+translation engine.
 *
 * Structure mirrors `GeminiLiveTranscriptionAdapter.open()` (write tail,
 * pending-frame backpressure, callback tail, one terminal error, close
 * promise). Wire rules are the ones measured in the 2026-09-02 spike and
 * shared with the desktop transport (`src/caption-engine/soniox-transport.js`):
 *  - the first frame is the JSON config, audio is raw binary PCM16 @ 16 kHz;
 *  - end of audio is an EMPTY TEXT frame (`send("")`) - an empty binary frame
 *    is ignored and `finished` never arrives;
 *  - continuous speech never yields `<end>`, so a finalize scheduler asks for
 *    `<fin>` (1.2 s idle / 15 s segment cap, once per segment) and the reducer
 *    commits on `<fin>` exactly as on `<end>`.
 *
 * The api key travels only inside the config frame. It is held in a private
 * field so `JSON.stringify` / `Object.values` / logging cannot leak it, and
 * nothing in this module logs.
 */
import { WebSocket } from "ws";

import {
  SONIOX_CONTROL,
  SONIOX_ENDPOINTS,
  buildSonioxConfig,
  createSonioxFinalizeScheduler,
  createSonioxTokenReducer,
  hasSonioxContentTokens,
  sonioxLanguageCode,
} from "../../../packages/caption-core/soniox-protocol.js";
import { selectGeminiTranscriptionVocabularyFromLegacyText } from "../../../packages/caption-core/index.js";

const FRAME_BYTES = 1_280; // 40 ms of 16 kHz mono PCM16
const FRAME_MILLISECONDS = 40;
const MAX_MESSAGE_BYTES = 1_048_576;
// 290 min, under Soniox's 300-min stream cap; the owner reopens on this failure.
const DEFAULT_MAX_CONNECTION_MILLISECONDS = 17_400_000;
const ERROR_CODES = Object.freeze({
  invalid_request: "SONIOX_INVALID_REQUEST",
  unauthenticated: "SONIOX_UNAUTHENTICATED",
  temp_api_key_session_expired: "SONIOX_KEY_EXPIRED",
  limit_exceeded: "SONIOX_RATE_LIMITED",
  service_unavailable: "SONIOX_UNAVAILABLE",
  max_duration_reached: "SONIOX_MAX_DURATION",
});

const STABLE_ERROR_CODE = /^(?:STT|SONIOX)_[A-Z_]+$/u;
const MAX_REQUEST_ID_LENGTH = 128;

/** Only our own stable codes may travel as an error message; anything the `ws`
 *  library or the runtime produced is replaced by `fallback` so raw socket text
 *  never reaches logs or clients. */
function safeError(error, fallback) {
  return error instanceof Error && STABLE_ERROR_CODE.test(error.message) ? error : new Error(fallback);
}

/** Provider error → stable code, with `request_id` attached as a property
 *  (never in the message) when it is a short string. */
function providerError(message) {
  const error = new Error(ERROR_CODES[message.error_type] ?? "SONIOX_PROVIDER_FAILED");
  if (typeof message.request_id === "string" && message.request_id.length <= MAX_REQUEST_ID_LENGTH) {
    error.requestId = message.request_id;
  }
  return error;
}

// A pending timer must never be what keeps the gateway process alive.
function setUnrefTimer(callback, delay) {
  const timer = setTimeout(callback, delay);
  timer.unref?.();
  return timer;
}

/**
 * `source = target` glossary rows are the only legacy shape Soniox can consume
 * as a translation hint; rows with zero or several `=` are terminology prose.
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

export class SonioxRealtimeAdapter {
  /** Holds the api key and the config frame; never enumerable, never logged. */
  #secret;

  constructor({
    apiKey,
    languageMode = "auto",
    translation = false,
    translationLanguages = [],
    targetLanguage,
    glossaryText = "",
    domainText = "",
    endpoint = "us",
    createWebSocket = (url) => new WebSocket(url),
    now = Date.now,
    setTimer = setUnrefTimer,
    clearTimer = clearTimeout,
    maxConnectionMilliseconds = DEFAULT_MAX_CONNECTION_MILLISECONDS,
    connectionTimeoutMilliseconds = 10_000,
    drainTimeoutMilliseconds = 5_000,
    keepaliveCheckMilliseconds = 5_000,
    keepaliveIdleMilliseconds = 8_000,
    maxPendingFrames = 64,
    maxPendingUtterances = 64,
  } = {}) {
    const languages = Array.isArray(translationLanguages) ? translationLanguages.map((code) => String(code)) : [];
    const glossaryTerms = selectGeminiTranscriptionVocabularyFromLegacyText(glossaryText ?? "");
    const translationTerms = translationTermsFromLegacyGlossary(glossaryText);
    // Soniox's context window is far larger than the Gemini vocabulary budget,
    // so both sides of every explicit pair also bias recognition.
    const contextTerms = [...glossaryTerms, ...translationTerms.flatMap((pair) => [pair.source, pair.target])];
    // Validated here so an unusable key / language / pair combination is a
    // construction failure (fail closed before any socket), not a crash on open.
    const config = buildSonioxConfig({
      apiKey,
      languageMode,
      languages,
      targetLanguage,
      translation: translation === true,
      context: { terms: contextTerms, translationTerms, domain: domainText ?? "" },
      clientReferenceId: `nova-gateway-${now().toString(36)}`,
    });
    this.#secret = Object.freeze({ configJson: JSON.stringify(config) });
    this.provider = "soniox";
    this.languageMode = languageMode;
    this.translation = translation === true;
    this.translationLanguages = targetLanguage ? [targetLanguage] : [...languages];
    this.endpoint = SONIOX_ENDPOINTS[endpoint] ?? SONIOX_ENDPOINTS.us;
    this.createWebSocket = createWebSocket;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.maxConnectionMilliseconds = maxConnectionMilliseconds;
    this.connectionTimeoutMilliseconds = connectionTimeoutMilliseconds;
    this.drainTimeoutMilliseconds = drainTimeoutMilliseconds;
    this.keepaliveCheckMilliseconds = keepaliveCheckMilliseconds;
    this.keepaliveIdleMilliseconds = keepaliveIdleMilliseconds;
    this.maxPendingFrames = maxPendingFrames;
    this.maxPendingUtterances = maxPendingUtterances;
  }

  /**
   * @param {{onFinalUtterance: Function, onPartialTranscript?: Function|null,
   *   onPartialTranslation?: Function|null, onContinuityDiscard?: Function, signal?: AbortSignal}} input
   */
  async open({ onFinalUtterance, onPartialTranscript = null, onPartialTranslation = null, onContinuityDiscard = () => {}, onReconnectRequired = () => {}, signal } = {}) {
    if (signal?.aborted) throw new Error("STT_CONNECT_ABORTED");
    if (typeof onFinalUtterance !== "function"
      || (onPartialTranscript !== null && typeof onPartialTranscript !== "function")
      || (onPartialTranslation !== null && typeof onPartialTranslation !== "function")
      || typeof onContinuityDiscard !== "function") {
      throw new Error("STT_CALLBACK_INVALID");
    }
    const { now, setTimer, clearTimer } = this;
    const maxPendingFrames = this.maxPendingFrames;
    const maxPendingUtterances = this.maxPendingUtterances;
    const drainTimeoutMilliseconds = this.drainTimeoutMilliseconds;

    let terminalError = null;
    let isClosing = false;
    let didClose = false;
    let finishedReceived = false;
    let closePromise = null;
    let drainPromise = null;
    let socketClosed = null; // resolves when the socket reports close
    let audioOffsetMs = 0;
    let inputAudioMilliseconds = 0;
    let lastFinalOffsetMs = 0;
    let lastAudioAt = now();
    let pendingFrames = 0;
    let pendingUtterances = 0;
    let pendingPartials = 0;
    let writeTail = Promise.resolve();
    let callbackTail = Promise.resolve();
    let connectionTimer = null;
    let lifetimeTimer = null;
    let keepaliveTimer = null;
    let segment = null;
    let translations = {};

    const clearTimers = () => {
      for (const timer of [connectionTimer, lifetimeTimer, keepaliveTimer]) if (timer !== null) clearTimer(timer);
      connectionTimer = null;
      lifetimeTimer = null;
      keepaliveTimer = null;
    };

    const socket = this.createWebSocket(this.endpoint);
    let resolveSocketClosed;
    socketClosed = new Promise((resolve) => { resolveSocketClosed = resolve; });
    const closeSocket = () => {
      if (socket.readyState === WebSocket.CLOSED) { resolveSocketClosed(); return; }
      try { socket.close(); } catch { try { socket.terminate?.(); } catch { /* already gone */ } }
    };

    const scheduler = createSonioxFinalizeScheduler({
      now,
      setTimer,
      clearTimer,
      onFinalize: () => {
        if (terminalError || isClosing || socket.readyState !== WebSocket.OPEN) return;
        try { socket.send(SONIOX_CONTROL.finalize); } catch { /* socket gone; the close path reports it */ }
      },
    });

    const fail = (error) => {
      if (terminalError) return;
      terminalError = error;
      clearTimers();
      scheduler.dispose();
      if (reducer.hasPendingFinalText() || segment !== null) {
        try { onContinuityDiscard({ reason: error.message }); } catch { /* informational only */ }
      }
      segment = null;
      translations = {};
      rejectConnect(error);
      closeSocket();
      if (!isClosing && ["SONIOX_MAX_DURATION", "SONIOX_UNAVAILABLE", "STT_PROVIDER_CLOSED", "STT_PROVIDER_FAILED"].includes(error.message)) onReconnectRequired(error);
    };

    const emitPartial = (callback, payload) => {
      if (!callback || terminalError || isClosing || didClose) return;
      if (pendingPartials >= maxPendingUtterances) { fail(new Error("STT_PARTIAL_BACKPRESSURE")); return; }
      try {
        const result = callback(payload);
        if (result && typeof result.then === "function") {
          pendingPartials += 1;
          Promise.resolve(result)
            .catch(() => { if (!didClose) fail(new Error("STT_PARTIAL_CALLBACK_FAILED")); })
            .finally(() => { pendingPartials -= 1; });
        }
      } catch { fail(new Error("STT_PARTIAL_CALLBACK_FAILED")); }
    };

    const targetLanguages = this.translationLanguages;
    const resolveTranslationLanguage = language => targetLanguages.find(target => sonioxLanguageCode(target) === language) ?? language;
    const reducer = createSonioxTokenReducer({
      onSourcePartial: (event) => emitPartial(onPartialTranscript, { text: event.text, sourceLanguage: event.language ?? undefined, segmentId: event.segmentId }),
      // Buffered until the boundary so one segment yields one utterance that
      // already carries its translation lanes.
      onSourceFinal: (event) => { segment = { ...event }; },
      onTranslationPartial: (event) => emitPartial(onPartialTranslation, {
        language: resolveTranslationLanguage(event.language), text: event.text, sourceLanguage: event.sourceLanguage ?? undefined, segmentId: event.segmentId,
      }),
      onTranslationFinal: (event) => { translations[resolveTranslationLanguage(event.language)] = { text: event.text, sourceLanguage: event.sourceLanguage ?? undefined }; },
      onBoundary: () => {
        scheduler.noteBoundary();
        const closed = segment;
        const lanes = translations;
        segment = null;
        translations = {};
        if (!closed || !closed.text.trim() || terminalError || didClose) return;
        if (pendingUtterances >= maxPendingUtterances) { fail(new Error("STT_UTTERANCE_BACKPRESSURE")); return; }
        pendingUtterances += 1;
        const sourceStartOffsetMs = Number.isFinite(closed.startMs) ? closed.startMs : lastFinalOffsetMs;
        const sourceEndOffsetMs = Math.max(sourceStartOffsetMs, Number.isFinite(closed.endMs) ? closed.endMs : audioOffsetMs);
        lastFinalOffsetMs = sourceEndOffsetMs;
        const utterance = {
          speakerLabel: "speaker-1",
          text: closed.text,
          rawText: closed.text,
          sourceLanguage: closed.language ?? undefined,
          segmentId: closed.segmentId,
          sourceStartOffsetMs,
          sourceEndOffsetMs,
          sourceEndedAt: new Date(now()).toISOString(),
          translations: lanes,
        };
        callbackTail = callbackTail.then(() => {
          if (terminalError || didClose) return;
          return onFinalUtterance(utterance);
        }).catch((error) => {
          fail(error instanceof Error ? error : new Error("STT_UTTERANCE_FAILED"));
        }).finally(() => { pendingUtterances -= 1; });
      },
    });

    let resolveFinished;
    let rejectConnect;
    let resolveOpen;
    const finished = new Promise((resolve) => { resolveFinished = resolve; });
    const opened = new Promise((resolve, reject) => { resolveOpen = resolve; rejectConnect = reject; });
    opened.catch(() => undefined);

    const handleMessage = (raw) => {
      if (terminalError || didClose) return;
      let message;
      try {
        // Byte length is checked BEFORE decoding so an oversized frame never
        // costs a UTF-8 pass or a JSON parse.
        const byteLength = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw), "utf8");
        if (byteLength > MAX_MESSAGE_BYTES) throw new Error("too large");
        message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
      } catch {
        fail(new Error("SONIOX_MESSAGE_INVALID"));
        return;
      }
      if (message && typeof message.error_type === "string") {
        fail(providerError(message));
        return;
      }
      reducer.apply(message);
      // The segment clock starts with the first COMMITTED text: provisional
      // tokens and empty result frames neither start nor postpone a finalize.
      if (!isClosing && hasSonioxContentTokens(message) && reducer.hasPendingFinalText()) {
        scheduler.noteTokens({ hasPendingFinalText: true, atMs: now() });
      }
      if (message?.finished === true) {
        finishedReceived = true;
        // Nothing follows `finished`; committed text that no `<end>` closed
        // would otherwise be lost, so close it exactly as a `<fin>` would.
        if (reducer.hasPendingFinalText()) reducer.apply({ tokens: [{ text: "<fin>", is_final: true }] });
        scheduler.noteBoundary();
        resolveFinished();
        // A `finished` nobody asked for means the provider ended the stream on
        // its own: a dead socket, not a drain. The utterance just committed is
        // delivered first, then the owner learns the stream is gone and reopens.
        if (!isClosing) callbackTail.then(() => fail(new Error("STT_PROVIDER_CLOSED")));
      }
    };

    socket.on("message", handleMessage);
    // Only a `finished` inside OUR drain makes a later error/close expected.
    const isExpectedClosure = () => didClose || (finishedReceived && isClosing);
    socket.on("error", () => {
      if (isExpectedClosure()) return;
      fail(new Error(connectionTimer !== null ? "STT_CONNECT_FAILED" : "STT_PROVIDER_FAILED"));
    });
    socket.on("close", () => {
      resolveSocketClosed();
      if (!terminalError && !isExpectedClosure()) {
        fail(new Error(connectionTimer !== null ? "STT_CONNECT_FAILED" : "STT_PROVIDER_CLOSED"));
      }
      clearTimers();
      scheduler.dispose();
    });
    const onAbort = () => fail(new Error(connectionTimer !== null ? "STT_CONNECT_ABORTED" : "STT_DRAIN_ABORTED"));
    signal?.addEventListener("abort", onAbort, { once: true });

    connectionTimer = setTimer(() => fail(new Error("STT_CONNECT_TIMEOUT")), this.connectionTimeoutMilliseconds);
    const onOpen = () => {
      if (terminalError) return;
      try { socket.send(this.#secret.configJson); } catch { fail(new Error("STT_CONNECT_FAILED")); return; }
      resolveOpen();
    };
    if (socket.readyState === WebSocket.OPEN) onOpen();
    else socket.once("open", onOpen);
    try {
      await opened;
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      throw error;
    } finally {
      if (connectionTimer !== null) clearTimer(connectionTimer);
      connectionTimer = null;
    }

    lastAudioAt = now();
    lifetimeTimer = setTimer(() => fail(new Error("SONIOX_MAX_DURATION")), this.maxConnectionMilliseconds);
    const armKeepalive = () => {
      keepaliveTimer = setTimer(() => {
        keepaliveTimer = null;
        if (terminalError || isClosing || didClose) return;
        if (now() - lastAudioAt > this.keepaliveIdleMilliseconds && socket.readyState === WebSocket.OPEN) {
          try { socket.send(SONIOX_CONTROL.keepalive); } catch { fail(new Error("STT_PROVIDER_WRITE_FAILED")); return; }
        }
        armKeepalive();
      }, this.keepaliveCheckMilliseconds);
    };
    armKeepalive();

    const enqueueWrite = (task) => {
      if (terminalError) return Promise.reject(terminalError);
      if (isClosing) return Promise.reject(new Error("STT_STREAM_CLOSED"));
      if (pendingFrames >= maxPendingFrames) return Promise.reject(new Error("STT_AUDIO_BACKPRESSURE"));
      pendingFrames += 1;
      const work = writeTail.then(async () => {
        if (terminalError) throw terminalError;
        try { await task(); } catch (error) { throw safeError(error, "STT_PROVIDER_WRITE_FAILED"); }
      });
      writeTail = work.catch((error) => { fail(error); });
      return work.finally(() => { pendingFrames -= 1; });
    };

    const sendText = (payload) => {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("STT_STREAM_CLOSED");
      socket.send(payload);
    };

    // End of audio: the EMPTY TEXT frame, then wait for `finished` (bounded).
    const drain = () => {
      if (drainPromise) return drainPromise;
      isClosing = true;
      signal?.removeEventListener("abort", onAbort);
      scheduler.dispose();
      drainPromise = (async () => {
        await writeTail;
        if (terminalError) throw terminalError;
        if (!finishedReceived) {
          try { sendText(""); } catch (error) {
            fail(safeError(error, "STT_PROVIDER_WRITE_FAILED"));
            throw terminalError;
          }
          let deadline;
          try {
            await Promise.race([
              finished,
              // A socket that dies mid-drain is reported now, not at the deadline.
              socketClosed.then(() => { throw terminalError ?? new Error("STT_PROVIDER_CLOSED"); }),
              new Promise((_, reject) => {
                deadline = setTimer(() => reject(new Error("STT_DRAIN_TIMEOUT")), drainTimeoutMilliseconds);
              }),
            ]);
          } catch (error) {
            fail(safeError(error, "STT_DRAIN_FAILED"));
            throw terminalError;
          } finally {
            if (deadline !== undefined) clearTimer(deadline);
          }
        }
        // Whether `finished` arrived now or before the drain began, the final
        // utterance it may have committed must be delivered before we resolve.
        await callbackTail;
      })();
      return drainPromise;
    };

    const usage = () => ({ inputAudioMilliseconds });

    return {
      supportsRolloverRemap: false,
      maxConnectionMilliseconds: this.maxConnectionMilliseconds,
      sendAudio(frame) {
        if (!(frame instanceof Uint8Array) || frame.byteLength !== FRAME_BYTES) {
          return Promise.reject(new Error("STT_AUDIO_REQUEST_INVALID"));
        }
        const owned = Buffer.from(frame);
        return enqueueWrite(async () => {
          if (socket.readyState !== WebSocket.OPEN) throw new Error("STT_STREAM_CLOSED");
          socket.send(owned);
          audioOffsetMs += FRAME_MILLISECONDS;
          inputAudioMilliseconds += FRAME_MILLISECONDS;
          lastAudioAt = now();
        });
      },
      async getFinalWords() {
        if (terminalError) throw terminalError;
        return [];
      },
      async waitForFinalWords() {
        if (terminalError) throw terminalError;
        return [];
      },
      getUsage: usage,
      gracefulDrain: () => drain(),
      assertDrained() { if (terminalError) throw terminalError; },
      abort() {
        isClosing = true;
        signal?.removeEventListener("abort", onAbort);
        fail(new Error("STT_DRAIN_ABORTED"));
        clearTimers();
        scheduler.dispose();
        closeSocket();
      },
      close() {
        if (closePromise) return closePromise;
        isClosing = true;
        signal?.removeEventListener("abort", onAbort);
        closePromise = (async () => {
          try {
            if (!terminalError) await drain();
          } catch {
            // drain() already recorded the terminal error; assertDrained surfaces it.
          } finally {
            // Never let `didClose` cut off an utterance already handed to the owner.
            await callbackTail;
            clearTimers();
            scheduler.dispose();
            closeSocket();
          }
          let transportClosed = socket.readyState === WebSocket.CLOSED;
          if (!transportClosed) {
            let deadline;
            transportClosed = await Promise.race([
              socketClosed.then(() => true),
              new Promise((resolve) => { deadline = setTimer(() => resolve(false), drainTimeoutMilliseconds); }),
            ]);
            if (deadline !== undefined) clearTimer(deadline);
            if (!transportClosed) { try { socket.terminate?.(); } catch { /* nothing left to terminate */ } }
          }
          didClose = true;
          return { transportClosed, ...usage() };
        })();
        return closePromise;
      },
    };
  }
}
