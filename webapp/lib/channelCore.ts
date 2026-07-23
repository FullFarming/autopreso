// Provider-agnostic translation channel, ported from
// autopreso/src/subtitle-realtime.js createTranslationChannel.
//
// One channel per (audioSource × targetLanguage). Owns the language lock,
// wrong-direction suppression, the 1200ms quiet-flush commit timer, and the
// commit→polish pipeline. Partials are NEVER polished or delayed (P0:
// realtime feel).

import {
  detectLanguage,
  createSpokenLanguageState,
  isTargetLanguageText,
  type DetectedLanguage,
  type LanguageCode,
} from "./languageDetect";
import type { AudioSource, EngineEvent, PolishFn, ToneKind } from "./types";

export const SUBTITLE_COMMIT_MS = 1200;

export interface TransportCtx {
  source: AudioSource;
  targetLanguage: LanguageCode;
  getSourceText(): string;
  setSourceText(value: string): void;
  getTranslatedText(): string;
  setTranslatedText(value: string): void;
  shouldDisplay(): boolean;
  rememberSourceTranscriptDelta(delta: string, providerLanguageCode?: unknown): void;
  rememberSourceTranscriptSnapshot(transcript: string, previousTranscript?: string, providerLanguageCode?: unknown): void;
  emitPartial(): void;
  scheduleCommit(): void;
  commitSubtitle(subtitle: { sourceText: string; translatedText: string }): void;
  resetUtterance(): void;
  resetForSpeakerBoundary?(): void;
  onSessionClosed(): void;
  onTransportReady(): void;
  getResumptionHandle?(): string;
  setResumptionHandle?(handle: string): void;
  onServerGoAway?(): void;
  /** Send a raw payload on the live socket (no-op if not open). Lets a
   *  transport react to mid-stream events — e.g. request a response when
   *  server VAD reports speech_stopped. */
  send(payload: string): void;
  broadcast(event: EngineEvent): void;
}

export interface Transport {
  /** Providers with a setup handshake (Gemini Live) reject input sent before
   *  the server acks setup; the channel buffers audio until onTransportReady. */
  requiresSetupAck?: boolean;
  /** Async: ephemeral token minting happens here. */
  connect(): Promise<WebSocket>;
  setupPayloads(options?: { resumptionHandle?: string }): string[];
  audioPayload(base64Pcm24k: string): string | string[];
  /** Discards provider-specific resampler/frame tails on stop or reconnect. */
  resetAudioInput?(): void;
  handleMessage(raw: string, ctx: TransportCtx): void;
  closePayload?(): string | undefined;
}

export interface ChannelSettings {
  tone: ToneKind;
  glossary: string;
  domain: string;
}

export interface TranslationChannel {
  open(): void;
  sendAudio(base64Pcm24k: string): void;
  resetAudioInput(): void;
  close(options?: { graceful?: boolean }): Promise<void>;
}

const MAX_PENDING_AUDIO_CHUNKS = 8;
const MAX_PENDING_AUDIO_AGE_MS = 750;
const DEFAULT_POLISH_TIMEOUT_MS = 1_500;
const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 5_000;

export function createTranslationChannel({
  source,
  targetLanguage,
  transport,
  settings,
  broadcast,
  polish,
  crossLanguageOnly = false,
  commitQuietMs = SUBTITLE_COMMIT_MS,
  polishTimeoutMs = DEFAULT_POLISH_TIMEOUT_MS,
  reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
  reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
}: {
  source: AudioSource;
  targetLanguage: LanguageCode;
  transport: Transport;
  settings: ChannelSettings;
  broadcast: (event: EngineEvent) => void;
  polish: PolishFn;
  /** When the source transcript is unavailable (transcription disabled in a
   *  single-direction session), the source-language suppression gate can't run.
   *  This trusts the model's instructed translation and gates only on the
   *  output language being the target. Safe only for one-channel sessions. */
  crossLanguageOnly?: boolean;
  /** Quiet-flush delay before a streamed line commits. Gemini's translate model
   *  never sends turnComplete, so its commit relies entirely on this timer —
   *  a shorter value finalizes subtitles sooner (closer to OpenAI's instant
   *  commit-on-done). */
  commitQuietMs?: number;
  polishTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}): TranslationChannel {
  let socket: WebSocket | null = null;
  let connecting = false;
  let configured = false;
  let pendingAudio: Array<{ audio: string; enqueuedAt: number }> = [];
  let sourceText = "";
  let translatedText = "";
  let sourceLanguageHint: DetectedLanguage = "unknown";
  const spokenLanguageState = createSpokenLanguageState();
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  let closeResolve: (() => void) | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let channelClosed = false;
  let intentionalClose = false;
  let resumptionHandle = "";
  let commitTail = Promise.resolve();
  let lastPartialKey = "";
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;

  // Commit pipeline: refine the finalized line into the configured tone, then
  // broadcast it. Partials never pass through here. If the channel was torn
  // down while polishing, the late line is dropped so it can never paint into
  // the next session.
  function commitSubtitle(subtitle: { sourceText: string; translatedText: string }) {
    const next = commitTail.then(() => commitSubtitleNow(subtitle), () => commitSubtitleNow(subtitle));
    commitTail = next.catch(() => undefined);
    return next;
  }

  async function commitSubtitleNow({
    sourceText: committedSource,
    translatedText: committedTranslation,
  }: { sourceText: string; translatedText: string }) {
    const finalSource = String(committedSource ?? "").trim();
    const rawTranslation = String(committedTranslation ?? "").trim();
    if (!rawTranslation) return;
    let finalTranslation = rawTranslation;
    try {
      const polishing = Promise.resolve(polish({
          translatedText: rawTranslation,
          sourceText: finalSource,
          targetLanguage,
          tone: settings.tone,
          glossary: settings.glossary,
          domain: settings.domain,
        }));
      const safePolishing = polishing.catch(() => rawTranslation);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(rawTranslation), polishTimeoutMs);
      });
      finalTranslation = (await Promise.race([safePolishing, timeout])) || rawTranslation;
      if (timer) clearTimeout(timer);
    } catch {
      finalTranslation = rawTranslation;
    }
    if (channelClosed) return;
    broadcast({ type: "committed", source, targetLanguage, sourceText: finalSource, translatedText: finalTranslation });
  }

  function resetUtterance() {
    clearCommitTimer();
    sourceText = "";
    translatedText = "";
    sourceLanguageHint = "unknown";
    spokenLanguageState.reset();
    lastPartialKey = "";
  }

  function resetForSpeakerBoundary() {
    clearCommitTimer();
    sourceText = "";
    translatedText = "";
    sourceLanguageHint = "unknown";
    spokenLanguageState.resetForSpeakerBoundary();
    lastPartialKey = "";
  }

  function clearCommitTimer() {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = null;
  }

  function clearCloseTimer() {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
  }

  function finishClose() {
    clearCloseTimer();
    const resolve = closeResolve;
    closeResolve = null;
    socket?.close();
    resolve?.();
  }

  function scheduleCommit() {
    clearCommitTimer();
    commitTimer = setTimeout(() => {
      const subtitle = normalizedSubtitle();
      if (subtitle.translatedText && shouldDisplay()) {
        void commitSubtitle(subtitle);
        resetUtterance();
      } else if (resolvedSourceLanguage() !== "unknown") {
        resetUtterance();
      }
      commitTimer = null;
    }, commitQuietMs);
  }

  function normalizedSubtitle() {
    return {
      sourceText: sourceText.trim(),
      translatedText: translatedText.trim(),
    };
  }

  function shouldDisplay(): boolean {
    if (crossLanguageOnly) {
      // No source transcript to gate on — trust the interpreter instruction and
      // require only that the output reads as the target language.
      return isTargetLanguageText(translatedText, targetLanguage);
    }
    const sourceLanguage = resolvedSourceLanguage();
    if (sourceLanguage === "unknown") return false;
    // Output-language gate. The "unknown" escape hatch exists for text too
    // short to judge (numbers, interjections); long text that still comes back
    // "unknown" is a mixed KO/EN line (fast code-switched speech) and must be
    // suppressed, not displayed as a garbled subtitle. Judged text uses a
    // relaxed confidence so Korean lines with English proper nouns still pass.
    const isTargetLanguageOutput = isTargetLanguageText(translatedText, targetLanguage);
    return targetLanguage !== sourceLanguage && isTargetLanguageOutput;
  }

  function resolvedSourceLanguage(): DetectedLanguage {
    return sourceLanguageHint === "unknown" ? spokenLanguageState.resolved(sourceText) : sourceLanguageHint;
  }

  function rememberSourceTranscriptDelta(delta: string, providerLanguageCode?: unknown) {
    applySourceLanguage(spokenLanguageState.rememberDelta(delta, providerLanguageCode));
  }

  function rememberSourceTranscriptSnapshot(transcript: string, previousTranscript = "", providerLanguageCode?: unknown) {
    applySourceLanguage(spokenLanguageState.rememberSnapshot(transcript, previousTranscript, providerLanguageCode));
  }

  function applySourceLanguage(sourceLanguage: DetectedLanguage) {
    if (sourceLanguage === "unknown") return;
    const outputLanguage = detectLanguage(translatedText, { minimumSignalChars: 1 });
    if (outputLanguage !== "unknown" && outputLanguage !== targetLanguage) {
      translatedText = "";
    }
    if (sourceLanguage === targetLanguage) {
      translatedText = "";
    } else if (sourceLanguageHint !== "unknown" && sourceLanguageHint !== sourceLanguage && sourceLanguageHint === targetLanguage) {
      translatedText = "";
    }
    sourceLanguageHint = sourceLanguage;
  }

  function emitPartial() {
    if (!shouldDisplay()) return;
    const subtitle = normalizedSubtitle();
    if (!subtitle.translatedText) return;
    const partialKey = `${subtitle.sourceText}\u0000${subtitle.translatedText}`;
    if (partialKey === lastPartialKey) return;
    lastPartialKey = partialKey;
    broadcast({ type: "partial", source, targetLanguage, ...subtitle });
  }

  function markTransportReady() {
    if (!socket || channelClosed) return;
    configured = true;
    reconnectAttempts = 0;
    const cutoff = Date.now() - MAX_PENDING_AUDIO_AGE_MS;
    for (const pending of pendingAudio) {
      if (pending.enqueuedAt >= cutoff) sendAudioPayloads(pending.audio);
    }
    pendingAudio = [];
  }

  function sendAudioPayloads(audio: string) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const encoded = transport.audioPayload(audio);
    const payloads = Array.isArray(encoded) ? encoded : [encoded];
    for (const payload of payloads) socket.send(payload);
  }

  const ctx: TransportCtx = {
    source,
    targetLanguage,
    getSourceText: () => sourceText,
    setSourceText: (value) => { sourceText = value; },
    getTranslatedText: () => translatedText,
    setTranslatedText: (value) => { translatedText = value; },
    shouldDisplay,
    rememberSourceTranscriptDelta,
    rememberSourceTranscriptSnapshot,
    emitPartial,
    scheduleCommit,
    commitSubtitle: (subtitle) => { void commitSubtitle(subtitle); },
    resetUtterance,
    resetForSpeakerBoundary,
    onSessionClosed: finishClose,
    onTransportReady: markTransportReady,
    getResumptionHandle: () => resumptionHandle,
    setResumptionHandle: (handle) => { if (handle) resumptionHandle = handle; },
    onServerGoAway: () => {
      if (socket && !intentionalClose) socket.close();
    },
    send: (payload) => {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(payload);
    },
    broadcast,
  };

  function attachSocket(ws: WebSocket) {
    socket = ws;
    // A fresh socket means the channel is live again — lift the teardown
    // guard so markTransportReady and commitSubtitle work for the session.
    channelClosed = false;
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      for (const payload of transport.setupPayloads({ resumptionHandle })) ws.send(payload);
      if (transport.requiresSetupAck) return;
      markTransportReady();
    });

    ws.addEventListener("message", (event) => {
      const data = event.data;
      const text = typeof data === "string"
        ? data
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : "";
      if (!text) return;
      transport.handleMessage(text, ctx);
    });

    ws.addEventListener("error", () => {
      broadcast({ type: "status", status: "reconnecting", source, targetLanguage });
      try { ws.close(); } catch { /* noop */ }
    });

    ws.addEventListener("close", (event) => {
      // Abnormal closes carry the provider's rejection reason (depleted
      // credits, bad setup, auth) — surface it so failures are diagnosable
      // instead of looking like silent no-subtitles.
      const code = event.code;
      if (code && code !== 1000 && code !== 1005) {
        const reasonText = event.reason ?? "";
        if (reasonText) {
          broadcast({
            type: "error",
            message: `Translation session closed (${code}): ${reasonText}`,
            code: "TRANSLATION_SOCKET_CLOSED",
          });
        }
      }
      channelClosed = intentionalClose;
      clearCommitTimer();
      clearCloseTimer();
      const resolve = closeResolve;
      closeResolve = null;
      socket = null;
      configured = false;
      transport.resetAudioInput?.();
      pendingAudio = [];
      resetUtterance();
      resolve?.();
      if (!intentionalClose) scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (intentionalClose || channelClosed || reconnectTimer) return;
    const delay = Math.min(reconnectBaseMs * (2 ** reconnectAttempts), reconnectMaxMs);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!intentionalClose && !channelClosed) ensureSocket();
    }, delay);
  }

  function ensureSocket() {
    if (socket || connecting || channelClosed || reconnectTimer) return;
    connecting = true;
    transport
      .connect()
      .then((ws) => {
        connecting = false;
        if (channelClosed) {
          try { ws.close(); } catch { /* noop */ }
          return;
        }
        attachSocket(ws);
      })
      .catch((error: any) => {
        connecting = false;
        broadcast({
          type: "error",
          message: `번역 연결 실패 (${source}/${targetLanguage}): ${error?.message ?? error}`,
          code: "TRANSLATION_CONNECT_FAILED",
        });
        scheduleReconnect();
      });
  }

  return {
    open() {
      intentionalClose = false;
      channelClosed = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      ensureSocket();
    },
    sendAudio(audio: string) {
      ensureSocket();
      if (!socket || !configured || socket.readyState !== WebSocket.OPEN) {
        const enqueuedAt = Date.now();
        pendingAudio.push({ audio, enqueuedAt });
        pendingAudio = pendingAudio.filter((pending) => enqueuedAt - pending.enqueuedAt <= MAX_PENDING_AUDIO_AGE_MS);
        if (pendingAudio.length > MAX_PENDING_AUDIO_CHUNKS) pendingAudio.shift();
        return;
      }
      sendAudioPayloads(audio);
    },
    resetAudioInput() {
      transport.resetAudioInput?.();
      pendingAudio = [];
    },
    async close({ graceful = false }: { graceful?: boolean } = {}) {
      intentionalClose = true;
      channelClosed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      clearCommitTimer();
      transport.resetAudioInput?.();
      const closeMessage = transport.closePayload?.();
      // Graceful close only when the provider has a close handshake (OpenAI
      // session.close → session.closed); Gemini Live has none, so fall
      // through to an immediate socket close.
      if (graceful && socket && configured && closeMessage && socket.readyState === WebSocket.OPEN) {
        if (closeResolve) {
          return new Promise<void>((resolve) => {
            const previousResolve = closeResolve!;
            closeResolve = () => {
              previousResolve();
              resolve();
            };
          });
        }
        const currentSocket = socket;
        const closed = new Promise<void>((resolve) => {
          closeResolve = resolve;
          closeTimer = setTimeout(finishClose, 3000);
        });
        socket.send(closeMessage);
        if (currentSocket === socket) await closed;
        return;
      }
      socket?.close();
      socket = null;
      configured = false;
      pendingAudio = [];
      resetUtterance();
    },
  };
}
