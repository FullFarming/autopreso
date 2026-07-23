import { WebSocket } from "ws";

const REALTIME_TRANSLATION_URL = "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate";
const INPUT_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000;
const DEFAULT_MAX_BUFFERED_BYTES = 256_000;
const DEFAULT_CONNECT_TIMEOUT_MILLISECONDS = 8_000;
const DEFAULT_CLOSE_TIMEOUT_MILLISECONDS = 3_000;

export class OpenAIRealtimeTranslationAdapter {
  constructor({
    apiKey,
    createWebSocket = (url, protocols, options) => new WebSocket(url, protocols, options),
    maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
    connectTimeoutMilliseconds = DEFAULT_CONNECT_TIMEOUT_MILLISECONDS,
    closeTimeoutMilliseconds = DEFAULT_CLOSE_TIMEOUT_MILLISECONDS,
  }) {
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("OPENAI_API_KEY_REQUIRED");
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) throw new Error("INVALID_OPENAI_BUFFER_LIMIT");
    this.apiKey = apiKey.trim();
    this.createWebSocket = createWebSocket;
    this.maxBufferedBytes = maxBufferedBytes;
    this.connectTimeoutMilliseconds = connectTimeoutMilliseconds;
    this.closeTimeoutMilliseconds = closeTimeoutMilliseconds;
  }

  async open({ language, onAudio = async () => {}, onInterruption = async () => {} }) {
    const socket = this.createWebSocket(REALTIME_TRANSLATION_URL, undefined, {
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

function buildOpenAITranslationSession(language) {
  return {
    audio: {
      output: { language },
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
