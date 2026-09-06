import { WebSocket } from "ws";

import {
  MAX_INTERPRETER_AUDIO_BYTES,
  MAX_INTERPRETER_AUDIO_DELTA_BASE64_CHARS,
  MAX_INTERPRETER_TRANSCRIPT_CHARS,
  assertBoundedBase64Audio,
  assertSupportedLanguage,
  createLiveInterpreterError,
  isRecord,
  sanitizeInterpreterDelta,
} from "./domain.js";

export const OPENAI_REALTIME_TRANSLATIONS_URL = "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate";
export const DEFAULT_OPENAI_CLOSE_TIMEOUT_MS = 2_000;
const MAX_PROVIDER_MESSAGE_CHARS = 256_000;

/** @typedef {"IDLE"|"CONNECTING"|"ACTIVE"|"CLOSING"|"CLOSED"|"ERROR"} TranslationProviderState */

/**
 * @typedef {{
 * type: "state", state: "CONNECTING"|"ACTIVE"|"CLOSING"|"CLOSED"|"ERROR"
 * } | {
 * type: "output_audio_delta", audioBase64: string
 * } | {
 * type: "output_transcript_delta"|"input_transcript_delta", delta: string
 * } | {
 * type: "transcript_committed"
 * } | {
 * type: "error", code: string
 * }} TranslationProviderEvent
 */

/**
 * @param {{
 * apiKey?: unknown,
 * lane?: string,
 * targetLanguage?: unknown,
 * onEvent?: (event: TranslationProviderEvent) => void,
 * closeTimeoutMs?: number,
 * maxAudioBytes?: number,
 * maxAudioDeltaBase64Chars?: number,
 * maxTranscriptChars?: number,
 * createWebSocket?: (url: string, protocols?: string|string[], init?: import("ws").ClientOptions) => import("ws").WebSocket,
 * }} options
 */
export function createOpenAiRealtimeTranslationSession({
  apiKey,
  lane = "",
  targetLanguage,
  onEvent = () => {},
  closeTimeoutMs = DEFAULT_OPENAI_CLOSE_TIMEOUT_MS,
  maxAudioBytes = MAX_INTERPRETER_AUDIO_BYTES,
  maxAudioDeltaBase64Chars = MAX_INTERPRETER_AUDIO_DELTA_BASE64_CHARS,
  maxTranscriptChars = MAX_INTERPRETER_TRANSCRIPT_CHARS,
  createWebSocket = (url, protocols, init) => new WebSocket(url, protocols, init),
} = {}) {
  const language = assertSupportedLanguage(targetLanguage);
  /** @type {TranslationProviderState} */
  let state = "IDLE";
  let socket = null;
  let startPromise = null;
  let stopPromise = null;
  let resolveStart = null;
  let rejectStart = null;
  let resolveStop = null;
  let rejectStop = null;
  let closeTimer = null;
  let transcriptCommitPending = false;

  function start() {
    if (state === "ACTIVE") return Promise.resolve();
    if (startPromise) return startPromise;
    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!key) return Promise.reject(createLiveInterpreterError("OPENAI_API_KEY_REQUIRED", "OpenAI API 키를 설정해 주세요."));
    state = "CONNECTING";
    onEvent({ type: "state", state });
    startPromise = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    try {
      socket = createWebSocket(OPENAI_REALTIME_TRANSLATIONS_URL, undefined, {
        headers: { Authorization: `Bearer ${key}` },
      });
    } catch {
      failConnection();
      return startPromise;
    }
    socket.on("open", handleOpen);
    socket.on("message", handleMessage);
    socket.on("error", failConnection);
    socket.on("close", handleClose);
    return startPromise;
  }

  function handleOpen() {
    if (!socket || state !== "CONNECTING") return;
    socket.send(JSON.stringify({
      type: "session.update",
      session: { audio: { output: { language } } },
    }));
    state = "ACTIVE";
    onEvent({ type: "state", state });
    resolveStart?.();
    resolveStart = null;
    rejectStart = null;
  }

  /** @param {unknown} raw */
  function handleMessage(raw) {
    const line = rawToString(raw);
    if (!line || line.length > MAX_PROVIDER_MESSAGE_CHARS) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string") return;
    if (message.type === "session.closed") {
      finishStop();
      return;
    }
    if (message.type === "session.output_audio.delta") {
      if (typeof message.delta !== "string" || message.delta.length > maxAudioDeltaBase64Chars) return;
      try {
        assertBoundedBase64Audio(message.delta, maxAudioBytes);
      } catch {
        return;
      }
      onEvent({ type: "output_audio_delta", audioBase64: message.delta });
      return;
    }
    if (message.type === "session.output_transcript.delta" || message.type === "session.input_transcript.delta") {
      const delta = sanitizeInterpreterDelta(message.delta, maxTranscriptChars);
      if (!delta) return;
      transcriptCommitPending = true;
      onEvent({
        type: message.type === "session.output_transcript.delta" ? "output_transcript_delta" : "input_transcript_delta",
        delta,
      });
      return;
    }
    if ((message.type === "session.output_transcript.done" || message.type === "response.done") && transcriptCommitPending) {
      transcriptCommitPending = false;
      onEvent({ type: "transcript_committed" });
    }
  }

  function failConnection() {
    if (state === "CLOSED" || state === "ERROR") return;
    state = "ERROR";
    onEvent({ type: "state", state });
    onEvent({ type: "error", code: "OPENAI_CONNECTION_FAILED" });
    const error = createLiveInterpreterError("OPENAI_CONNECTION_FAILED", "OpenAI 실시간 통역 연결에 실패했습니다.");
    rejectStart?.(error);
    rejectStop?.(error);
    resolveStart = null;
    rejectStart = null;
    resolveStop = null;
    rejectStop = null;
  }

  function handleClose() {
    if (state === "CLOSED") return;
    if (state === "CLOSING") {
      failStop("OPENAI_CLOSED_EARLY", "OpenAI 실시간 통역 세션이 종료 확인 전에 닫혔습니다.");
      return;
    }
    failConnection();
  }

  /** @param {unknown} audioBase64 */
  function appendAudio(audioBase64) {
    if (!socket || state !== "ACTIVE") {
      throw createLiveInterpreterError("OPENAI_SESSION_NOT_ACTIVE", "OpenAI 실시간 통역 세션이 활성 상태가 아닙니다.");
    }
    const audio = assertBoundedBase64Audio(audioBase64, maxAudioBytes);
    socket.send(JSON.stringify({ type: "session.input_audio_buffer.append", audio }));
  }

  function stop() {
    if (state === "IDLE" || state === "CLOSED") return Promise.resolve();
    if (stopPromise) return stopPromise;
    if (!socket) {
      state = "CLOSED";
      onEvent({ type: "state", state });
      return Promise.resolve();
    }
    state = "CLOSING";
    onEvent({ type: "state", state });
    stopPromise = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    socket.send(JSON.stringify({ type: "session.close" }));
    closeTimer = setTimeout(() => {
      socket?.terminate?.();
      failStop("OPENAI_CLOSE_TIMEOUT", "OpenAI 실시간 통역 세션 종료 시간이 초과되었습니다.");
    }, Math.max(1, Number(closeTimeoutMs) || DEFAULT_OPENAI_CLOSE_TIMEOUT_MS));
    return stopPromise;
  }

  function finishStop() {
    clearTimeout(closeTimer);
    closeTimer = null;
    state = "CLOSED";
    onEvent({ type: "state", state });
    socket?.close();
    socket = null;
    resolveStop?.();
    resolveStop = null;
    rejectStop = null;
  }

  /** @param {string} code @param {string} message */
  function failStop(code, message) {
    clearTimeout(closeTimer);
    closeTimer = null;
    state = "ERROR";
    onEvent({ type: "state", state });
    onEvent({ type: "error", code });
    rejectStop?.(createLiveInterpreterError(code, message));
    resolveStop = null;
    rejectStop = null;
  }

  return Object.freeze({ lane, start, appendAudio, stop, getState: () => state });
}

/** @param {unknown} raw */
function rawToString(raw) {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  return "";
}
