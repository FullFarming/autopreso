import { WebSocket } from "ws";

// Confirmed model split: OpenAI serves VOICE translation only, through its
// dedicated streaming speech-to-speech translation model. Overridable via
// constructor (wired to OPENAI_REALTIME_TRANSLATE_MODEL) so a newer
// generation can be adopted without a code change.
const DEFAULT_REALTIME_TRANSLATION_MODEL = "gpt-realtime-translate";
const realtimeTranslationUrl = (model) =>
  `wss://api.openai.com/v1/realtime/translations?model=${encodeURIComponent(model)}`;
const INPUT_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000;
const DEFAULT_MAX_BUFFERED_BYTES = 256_000;
const DEFAULT_CONNECT_TIMEOUT_MILLISECONDS = 8_000;
const DEFAULT_CLOSE_TIMEOUT_MILLISECONDS = 3_000;

export class OpenAIRealtimeTranslationAdapter {
  constructor({
    apiKey,
    model = DEFAULT_REALTIME_TRANSLATION_MODEL,
    createWebSocket = (url, protocols, options) => new WebSocket(url, protocols, options),
    maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
    connectTimeoutMilliseconds = DEFAULT_CONNECT_TIMEOUT_MILLISECONDS,
    closeTimeoutMilliseconds = DEFAULT_CLOSE_TIMEOUT_MILLISECONDS,
  }) {
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("OPENAI_API_KEY_REQUIRED");
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) throw new Error("INVALID_OPENAI_BUFFER_LIMIT");
    this.apiKey = apiKey.trim();
    this.model = typeof model === "string" && model.trim() ? model.trim() : DEFAULT_REALTIME_TRANSLATION_MODEL;
    this.createWebSocket = createWebSocket;
    this.maxBufferedBytes = maxBufferedBytes;
    this.connectTimeoutMilliseconds = connectTimeoutMilliseconds;
    this.closeTimeoutMilliseconds = closeTimeoutMilliseconds;
  }

  async open({ language, onAudio = async () => {}, onInterruption = async () => {} }) {
    const socket = this.createWebSocket(realtimeTranslationUrl(this.model), undefined, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "OpenAI-Safety-Identifier": "realtime-noel-live-translation",
      },
    });
    const maxBufferedBytes = this.maxBufferedBytes;
    const closeTimeoutMilliseconds = this.closeTimeoutMilliseconds;
    let isReady = false;
    let isReadySettled = false;
    let isClosing = false;
    let isClosed = false;
    let callbackTail = Promise.resolve();
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const connectTimer = setTimeout(() => {
      socket.terminate?.();
      settleReady(new Error("OPENAI_REALTIME_CONNECT_TIMEOUT"));
    }, this.connectTimeoutMilliseconds);
    connectTimer.unref?.();
    const settleReady = (error) => {
      clearTimeout(connectTimer);
      if (isReadySettled) return;
      isReadySettled = true;
      if (error) rejectReady(error);
      else {
        isReady = true;
        resolveReady();
      }
    };
    const enqueueCallback = (callback) => {
      callbackTail = callbackTail.catch(() => undefined).then(callback);
      callbackTail.catch(() => undefined);
    };
    socket.on("open", () => {
      socket.send(JSON.stringify({
        type: "session.update",
        session: buildOpenAITranslationSession(language),
      }));
    });
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
      } catch {
        return;
      }
      if (message.type === "session.updated") {
        settleReady();
        return;
      }
      if (message.type === "session.input_audio_buffer.speech_started") {
        enqueueCallback(() => onInterruption());
        return;
      }
      if (message.type === "session.output_audio.delta" && !isClosed) {
        const pcm = decodePcm16(message.delta);
        if (pcm) enqueueCallback(() => onAudio({ sampleRate: OUTPUT_SAMPLE_RATE, pcm }));
        return;
      }
      if (message.type === "session.closed") {
        isClosed = true;
        socket.close();
        return;
      }
      if (message.type === "error") {
        const code = String(message.error?.code ?? "OPENAI_REALTIME_ERROR");
        const error = new Error(code);
        settleReady(error);
        if (!isClosing) socket.close();
      }
    });
    socket.on("error", (error) => settleReady(error instanceof Error ? error : new Error("OPENAI_REALTIME_ERROR")));
    socket.on("close", () => {
      isClosed = true;
      if (!isReady) settleReady(new Error("OPENAI_REALTIME_CLOSED"));
    });
    await ready;

    return {
      async sendAudio(frame) {
        if (isClosing || isClosed || socket.readyState !== WebSocket.OPEN) throw new Error("OPENAI_REALTIME_CLOSED");
        if (socket.bufferedAmount > maxBufferedBytes) return false;
        const pcm = resamplePcm16Mono(frame, INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE);
        socket.send(JSON.stringify({
          type: "session.input_audio_buffer.append",
          audio: Buffer.from(pcm).toString("base64"),
        }));
        return true;
      },
      async audioStreamEnd() {
        // Realtime Translation owns VAD turn boundaries. Sending commit for a
        // continuously streamed VAD session can create duplicate output turns.
      },
      async close() {
        if (isClosed) {
          await callbackTail;
          return;
        }
        isClosing = true;
        const closed = new Promise((resolve) => {
          const finish = () => resolve();
          socket.once("close", finish);
          const timer = setTimeout(() => {
            socket.removeListener("close", finish);
            socket.terminate?.();
            resolve();
          }, closeTimeoutMilliseconds);
          timer.unref?.();
          socket.once("close", () => clearTimeout(timer));
        });
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "session.close" }));
        else socket.terminate?.();
        await closed;
        isClosed = true;
        await callbackTail;
      },
    };
  }
}

// OpenAI's realtime translate model takes bare ISO output codes and exposes a
// single "zh" for Chinese. This map is OpenAI-specific — the Gemini adapter
// keeps its own official list (see google-provider-adapters.js).
const OPENAI_OUTPUT_LANGUAGE_CODES = new Map([
  ["zh-Hans", "zh"], ["zh-Hant", "zh"], ["zh-CN", "zh"],
  ["pt-BR", "pt"], ["pt-PT", "pt"],
  ["ko-KR", "ko"], ["en-US", "en"], ["ja-JP", "ja"],
]);

function buildOpenAITranslationSession(language) {
  return {
    audio: {
      output: { language: OPENAI_OUTPUT_LANGUAGE_CODES.get(language) ?? language },
    },
  };
}

function decodePcm16(value) {
  if (typeof value !== "string" || !value) return null;
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) return null;
  return bytes;
}

export function resamplePcm16Mono(value, inputSampleRate, outputSampleRate) {
  const input = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (input.byteLength === 0 || input.byteLength % 2 !== 0) throw new Error("INVALID_PCM16");
  if (!Number.isSafeInteger(inputSampleRate) || inputSampleRate < 1
    || !Number.isSafeInteger(outputSampleRate) || outputSampleRate < 1) throw new Error("INVALID_SAMPLE_RATE");
  if (inputSampleRate === outputSampleRate) return Uint8Array.from(input);
  const inputSamples = input.byteLength / 2;
  const outputSamples = Math.round(inputSamples * outputSampleRate / inputSampleRate);
  const output = new Uint8Array(outputSamples * 2);
  const inputView = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const outputView = new DataView(output.buffer);
  for (let index = 0; index < outputSamples; index += 1) {
    const sourcePosition = index * inputSampleRate / outputSampleRate;
    const leftIndex = Math.min(inputSamples - 1, Math.floor(sourcePosition));
    const rightIndex = Math.min(inputSamples - 1, leftIndex + 1);
    const fraction = sourcePosition - leftIndex;
    const left = inputView.getInt16(leftIndex * 2, true);
    const right = inputView.getInt16(rightIndex * 2, true);
    outputView.setInt16(index * 2, Math.round(left + (right - left) * fraction), true);
  }
  return output;
}

// ── OpenAI meeting voice ────────────────────────────────────────────────────
// Confirmed provider split: captions are Gemini 3.5, VOICE is OpenAI. The
// /v1/audio/speech pcm format is fixed 24 kHz mono s16le — exactly the
// gateway's output rate — so chunks stream through with only 16-bit
// alignment. A failure degrades to the fallback (Google Chirp) voice so a
// provider outage never silences the meeting.
const OPENAI_TTS_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const OPENAI_TTS_MAX_INPUT_CHARS = 4_096;

function pickOpenAiTtsVoice(voiceName) {
  const seed = String(voiceName ?? "");
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  return OPENAI_TTS_VOICES[hash % OPENAI_TTS_VOICES.length];
}

export class OpenAITextToSpeechAdapter {
  constructor({ apiKey, model = "gpt-4o-mini-tts", fetchImpl = globalThis.fetch, fallback = null }) {
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("OPENAI_TTS_KEY_REQUIRED");
    this.apiKey = apiKey.trim();
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.fallback = fallback;
  }

  async *synthesizeStream({ language, voiceName, text, sampleRate, signal }) {
    if (sampleRate !== 24_000) throw new Error("OPENAI_TTS_SAMPLE_RATE_UNSUPPORTED");
    const input = String(text ?? "").trim().slice(0, OPENAI_TTS_MAX_INPUT_CHARS);
    if (!input) return;
    let response;
    try {
      response = await this.fetchImpl("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          voice: pickOpenAiTtsVoice(voiceName),
          input,
          response_format: "pcm",
        }),
        ...(signal ? { signal } : {}),
      });
      if (!response?.ok || !response.body) throw new Error(`OPENAI_TTS_HTTP_${response?.status ?? "NO_RESPONSE"}`);
    } catch (error) {
      if (this.fallback) {
        console.warn(`[tts] openai voice failed (${error instanceof Error ? error.message : error}); degrading to fallback voice`);
        yield* this.fallback.synthesizeStream({ language, voiceName, text, sampleRate, signal });
        return;
      }
      throw error;
    }
    let pendingByte = null;
    for await (const chunk of response.body) {
      let bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (pendingByte !== null) {
        const joined = new Uint8Array(bytes.byteLength + 1);
        joined[0] = pendingByte;
        joined.set(bytes, 1);
        bytes = joined;
        pendingByte = null;
      }
      if (bytes.byteLength % 2 !== 0) {
        pendingByte = bytes.at(-1);
        bytes = bytes.slice(0, -1);
      }
      if (bytes.byteLength > 0) yield bytes;
    }
  }
}
