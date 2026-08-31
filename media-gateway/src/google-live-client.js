import { WebSocket } from "ws";

const LIVE_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const TRANSCRIBE_MODEL = "gemini-3.5-transcribe-live";
const TRANSLATE_MODEL = "gemini-3.5-live-translate-preview";
const MAXIMUM_MESSAGE_BYTES = 1_048_576;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializeSetup(model, config) {
  const allowed = new Set(["responseModalities", "inputAudioTranscription", "outputAudioTranscription", "translationConfig", "abortSignal"]);
  if (![TRANSCRIBE_MODEL, TRANSLATE_MODEL].includes(model) || !isRecord(config)
    || Object.keys(config).some((key) => !allowed.has(key))) throw new Error("GOOGLE_LIVE_CONFIG_INVALID");
  const isTranslation = model === TRANSLATE_MODEL;
  if (JSON.stringify(config.responseModalities) !== JSON.stringify([isTranslation ? "AUDIO" : "TEXT"])
    || !isRecord(config.inputAudioTranscription)) throw new Error("GOOGLE_LIVE_CONFIG_INVALID");
  const transcription = config.inputAudioTranscription;
  if (isTranslation) {
    if (Object.keys(transcription).length || !isRecord(config.outputAudioTranscription)
      || Object.keys(config.outputAudioTranscription).length || !isRecord(config.translationConfig)
      || Object.keys(config.translationConfig).sort().join() !== "echoTargetLanguage,targetLanguageCode"
      || typeof config.translationConfig.echoTargetLanguage !== "boolean"
      || typeof config.translationConfig.targetLanguageCode !== "string"
      || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(config.translationConfig.targetLanguageCode)) {
      throw new Error("GOOGLE_LIVE_CONFIG_INVALID");
    }
  } else if (config.translationConfig !== undefined || config.outputAudioTranscription !== undefined
    || Object.keys(transcription).some((key) => !["mode", "languageCodes", "customVocabulary"].includes(key))
    || transcription.mode !== "VERBATIM"
    || !Array.isArray(transcription.languageCodes) || transcription.languageCodes.length > 3
    || transcription.languageCodes.some((language) => typeof language !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(language))
    || (transcription.customVocabulary !== undefined && (!Array.isArray(transcription.customVocabulary)
      || transcription.customVocabulary.length > 1_000
      || transcription.customVocabulary.some((term) => typeof term !== "string" || !term.trim() || term.length > 1_000)))) {
    throw new Error("GOOGLE_LIVE_CONFIG_INVALID");
  }
  const payload = JSON.stringify({ setup: {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: config.responseModalities,
      ...(isTranslation ? { translationConfig: config.translationConfig } : {}),
    },
    inputAudioTranscription: transcription,
    ...(isTranslation ? { outputAudioTranscription: {} } : {}),
  } });
  if (Buffer.byteLength(payload) > 256_000) throw new Error("GOOGLE_LIVE_CONFIG_INVALID");
  return payload;
}

function serializeInput(input) {
  if (!isRecord(input) || Object.keys(input).length !== 1) throw new Error("GOOGLE_LIVE_INPUT_INVALID");
  if (input.audioStreamEnd === true) return JSON.stringify({ realtimeInput: { audioStreamEnd: true } });
  const audio = input.audio;
  if (!isRecord(audio) || Object.keys(audio).sort().join() !== "data,mimeType"
    || audio.mimeType !== "audio/pcm;rate=16000" || typeof audio.data !== "string"
    || audio.data.length > 85_336 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(audio.data)) {
    throw new Error("GOOGLE_LIVE_INPUT_INVALID");
  }
  const bytes = Buffer.from(audio.data, "base64");
  if (bytes.length < 2 || bytes.length > 64_000 || bytes.length % 2 !== 0
    || bytes.toString("base64") !== audio.data) throw new Error("GOOGLE_LIVE_INPUT_INVALID");
  return JSON.stringify({ realtimeInput: { audio } });
}

// 2026-08-31 fix: The installed SDK cannot cancel a pending Live handshake.
// Own the documented WebSocket transport so a timed-out or abandoned start
// closes the physical connection, including before setupComplete arrives.
export function createGoogleLiveClient({
  apiKey,
  WebSocketImpl = WebSocket,
  connectTimeoutMilliseconds = 10_000,
  maximumConnections = 16,
  maximumPendingBytes = 256_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/u.test(apiKey)
    || !Number.isSafeInteger(maximumConnections) || maximumConnections < 1 || maximumConnections > 256
    || !Number.isSafeInteger(connectTimeoutMilliseconds) || connectTimeoutMilliseconds < 1 || connectTimeoutMilliseconds > 30_000
    || !Number.isSafeInteger(maximumPendingBytes) || maximumPendingBytes < 64_000 || maximumPendingBytes > 1_048_576) {
    throw new Error("GOOGLE_LIVE_CLIENT_CONFIG_INVALID");
  }
  const sockets = new Set();

  async function connect({ model, config, callbacks = {}, signal = config?.abortSignal } = {}) {
    const setup = serializeSetup(model, config);
    if (!isRecord(callbacks) || ["onopen", "onmessage", "onerror", "onclose"].some((key) => callbacks[key] !== undefined && typeof callbacks[key] !== "function")
      || (signal !== undefined && !(signal instanceof AbortSignal))) throw new Error("GOOGLE_LIVE_CONFIG_INVALID");
    if (signal?.aborted) throw new Error("GOOGLE_LIVE_ABORTED");
    if (sockets.size >= maximumConnections) throw new Error("GOOGLE_LIVE_CONNECTION_LIMIT");
    let socket;
    try {
      socket = new WebSocketImpl(`${LIVE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
        followRedirects: false, perMessageDeflate: false, maxPayload: MAXIMUM_MESSAGE_BYTES,
        handshakeTimeout: connectTimeoutMilliseconds,
      });
    } catch {
      throw new Error("GOOGLE_LIVE_CONNECTION_FAILED");
    }
    sockets.add(socket);
    let terminal = false;
    let ready = false;
    let timer;
    let resolveReady;
    let rejectReady;
    const pendingSends = new Set();
    let resolveClosed;
    const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });
    const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const cleanup = () => {
      clearTimeoutFn(timer);
      signal?.removeEventListener("abort", abort);
    };
    const notify = (name, value) => {
      try { callbacks[name]?.(value); } catch {
        if (!terminal) stop("GOOGLE_LIVE_CALLBACK_FAILED");
      }
    };
    const stop = (code, reportError = true) => {
      if (terminal) return;
      terminal = true;
      cleanup();
      rejectReady(new Error(code));
      for (const reject of pendingSends) reject(new Error(code));
      pendingSends.clear();
      socket.terminate();
      if (reportError) notify("onerror", new Error(code));
    };
    const abort = () => stop("GOOGLE_LIVE_ABORTED", false);
    const session = Object.freeze({
      async sendRealtimeInput(input) {
        const payload = serializeInput(input);
        if (terminal || !ready || socket.readyState !== WebSocket.OPEN) throw new Error("GOOGLE_LIVE_CLOSED");
        if (socket.bufferedAmount + Buffer.byteLength(payload) > maximumPendingBytes) {
          stop("GOOGLE_LIVE_BACKPRESSURE");
          throw new Error("GOOGLE_LIVE_BACKPRESSURE");
        }
        await new Promise((resolve, reject) => {
          const rejectSend = (error) => { clearTimeoutFn(sendTimer); reject(error); };
          const sendTimer = setTimeoutFn(() => stop("GOOGLE_LIVE_SEND_TIMEOUT"), 5_000);
          sendTimer?.unref?.();
          pendingSends.add(rejectSend);
          try {
            socket.send(payload, (error) => {
              if (error) { stop("GOOGLE_LIVE_SEND_FAILED"); reject(new Error("GOOGLE_LIVE_SEND_FAILED")); }
              else resolve();
              clearTimeoutFn(sendTimer);
              pendingSends.delete(rejectSend);
            });
          } catch { stop("GOOGLE_LIVE_SEND_FAILED"); }
        });
      },
      close() { stop("GOOGLE_LIVE_CLOSED", false); return closedPromise; },
    });
    socket.on("error", () => stop("GOOGLE_LIVE_CONNECTION_FAILED"));
    socket.on("close", (code) => {
      sockets.delete(socket);
      cleanup();
      if (!terminal) { terminal = true; rejectReady(new Error("GOOGLE_LIVE_CLOSED")); }
      for (const reject of pendingSends) reject(new Error("GOOGLE_LIVE_CLOSED"));
      pendingSends.clear();
      resolveClosed();
      notify("onclose", { code, reason: "GOOGLE_LIVE_CLOSED" });
    });
    socket.on("open", () => {
      if (terminal) return;
      notify("onopen", {});
      if (terminal) return;
      try {
        socket.send(setup, (error) => { if (error) stop("GOOGLE_LIVE_SEND_FAILED"); });
      } catch { stop("GOOGLE_LIVE_SEND_FAILED"); }
    });
    socket.on("message", (data) => {
      if (terminal) return;
      let message;
      try {
        const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        if (raw.length > MAXIMUM_MESSAGE_BYTES) throw new Error();
        message = JSON.parse(raw.toString("utf8"));
        if (!isRecord(message)) throw new Error();
      } catch { stop("GOOGLE_LIVE_MESSAGE_INVALID"); return; }
      if (message.error) { stop("GOOGLE_LIVE_PROVIDER_REJECTED"); return; }
      if (!ready) {
        if (!isRecord(message.setupComplete)) { stop("GOOGLE_LIVE_SETUP_INVALID"); return; }
        ready = true;
        clearTimeoutFn(timer);
        resolveReady(session);
        return;
      }
      notify("onmessage", message);
    });
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeoutFn(() => stop("GOOGLE_LIVE_CONNECT_TIMEOUT"), connectTimeoutMilliseconds);
    timer?.unref?.();
    if (signal?.aborted) abort();
    return readyPromise;
  }

  return Object.freeze({ live: Object.freeze({ connect }), get activeConnections() { return sockets.size; } });
}
