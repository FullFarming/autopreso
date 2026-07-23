import { AUDIO_CONFIG, STT_CONFIG } from "./config.js";
import { Pcm16StreamConditioner } from "./pcm-conditioning.js";
import { StableTranscriptSegmenter, StableUtteranceSegmenter } from "./stable-utterance-segmenter.js";
import { segmentTextForStreamingTts } from "./tts-text-segmentation.js";

const CHIRP_LOCALES = new Map([
  ["en", "en-US"],
  ["ko", "ko-KR"],
  ["ja", "ja-JP"],
  ["zh-CN", "cmn-CN"], ["zh-Hans", "cmn-CN"], ["zh-Hant", "cmn-TW"],
  ["es", "es-ES"],
  ["pt", "pt-BR"], ["fr", "fr-FR"], ["de", "de-DE"], ["ru", "ru-RU"],
  ["hi", "hi-IN"], ["id", "id-ID"], ["vi", "vi-VN"], ["it", "it-IT"],
]);

const LIVE_TRANSLATION_LANGUAGE_CODES = new Map([
  ["en", "en-US"], ["ko", "ko-KR"], ["ja", "ja-JP"],
  ["zh-CN", "zh-Hans"],
  ["zh", "zh-Hans"],
  ["zh-Hans", "zh-Hans"],
  ["zh-Hant", "zh-Hant"],
  ["es", "es-ES"], ["pt", "pt-BR"], ["fr", "fr-FR"], ["de", "de-DE"],
  ["ru", "ru-RU"], ["hi", "hi-IN"], ["id", "id-ID"], ["vi", "vi-VN"], ["it", "it-IT"],
]);

const TTS_RESPONSE_HIGH_WATER_BYTES = 144_000;
const TTS_RESPONSE_LOW_WATER_BYTES = 72_000;
const MAX_TTS_RESPONSE_BUFFER_BYTES = 480_000;
const GEMINI_INPUT_CHUNK_BYTES = 3_200;

export class GeminiLiveTranslateAdapter {
  constructor({
    client,
    model,
    reconnectDelay = (attempt) => new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** Math.min(attempt - 1, 6), 30_000))),
  }) {
    this.client = client;
    this.model = model;
    this.reconnectDelay = reconnectDelay;
  }

  async open({ language, onCaption, onAudio, onInterruption }) {
    const targetLanguageCode = LIVE_TRANSLATION_LANGUAGE_CODES.get(language) ?? language;
    let session = null;
    let resumptionHandle = null;
    let reconnecting = null;
    let reconnectAttempts = 0;
    let terminalError = null;
    let isClosed = false;
    let nextConnectionGeneration = 0;
    let activeConnectionGeneration = 0;
    let callbackTail = Promise.resolve();
    let inputTail = Buffer.alloc(0);
    let inputQueue = Promise.resolve();
    const clearInputTail = () => { inputTail = Buffer.alloc(0); };
    const enqueueInput = (task) => {
      const queued = inputQueue.then(task, task);
      inputQueue = queued.catch(() => undefined);
      return queued;
    };
    const enqueueCallback = (task) => {
      callbackTail = callbackTail.then(task, task).catch(() => undefined);
    };
    const closedSessions = new WeakSet();
    const closeSessionOnce = (providerSession) => {
      if (!providerSession || closedSessions.has(providerSession)) return;
      closedSessions.add(providerSession);
      providerSession.close();
    };
    const connect = async () => {
      const connectionGeneration = ++nextConnectionGeneration;
      const previousSession = session;
      const nextSession = await this.client.live.connect({
        model: this.model,
        config: {
          responseModalities: ["AUDIO"],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          translationConfig: {
            targetLanguageCode,
            echoTargetLanguage: false,
          },
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {},
        },
        callbacks: {
          onmessage(message) {
            if (connectionGeneration !== activeConnectionGeneration || isClosed) return;
            if (message.sessionResumptionUpdate?.newHandle) resumptionHandle = message.sessionResumptionUpdate.newHandle;
            if (message.goAway) void reconnect();
            const transcription = message.serverContent?.outputTranscription;
            const isInterrupted = Boolean(message.serverContent?.interrupted);
            const audioParts = (message.serverContent?.modelTurn?.parts ?? []).flatMap((part) => {
              const inlineData = part.inlineData ?? part.inline_data;
              if (typeof inlineData?.data !== "string" || !String(inlineData.mimeType ?? inlineData.mime_type).startsWith("audio/pcm")) return [];
              const pcm = Uint8Array.from(Buffer.from(inlineData.data, "base64"));
              return pcm.byteLength > 0 ? [pcm] : [];
            });
            enqueueCallback(async () => {
              if (connectionGeneration !== activeConnectionGeneration || isClosed) return;
              if (transcription?.text) await onCaption({ text: transcription.text, isFinal: Boolean(message.serverContent?.turnComplete) });
              if (connectionGeneration !== activeConnectionGeneration || isClosed) return;
              if (isInterrupted) await onInterruption?.();
              for (const pcm of audioParts) {
                if (connectionGeneration !== activeConnectionGeneration || isClosed) return;
                await onAudio?.({ pcm, sampleRate: AUDIO_CONFIG.outputSampleRate });
              }
            });
          },
          onclose() { if (!isClosed && connectionGeneration === activeConnectionGeneration) void reconnect(); },
          onerror() { if (!isClosed && connectionGeneration === activeConnectionGeneration) void reconnect(); },
        },
      });
      if (isClosed) {
        closeSessionOnce(nextSession);
        return;
      }
      session = nextSession;
      activeConnectionGeneration = connectionGeneration;
      reconnectAttempts = 0;
      if (previousSession !== nextSession) closeSessionOnce(previousSession);
    };
    const reconnect = async () => {
      if (reconnecting || isClosed) return reconnecting;
      // A partial PCM frame belongs to exactly one provider connection. Reusing
      // it after resumption can splice unrelated speech across generations.
      clearInputTail();
      reconnecting = (async () => {
        while (!isClosed) {
          reconnectAttempts += 1;
          await this.reconnectDelay(reconnectAttempts);
          if (isClosed) return;
          try {
            await connect();
            return;
          } catch (error) {
            if (isPermanentProviderError(error)) {
              terminalError = new Error("GEMINI_CONFIGURATION_REJECTED");
              return;
            }
            // The current provider session stays owned until a replacement connects.
          }
        }
      })().finally(() => { reconnecting = null; });
      return reconnecting;
    };
    await connect();
    return {
      async sendAudio(frame) {
        const pcm = Buffer.from(frame);
        return enqueueInput(async () => {
          if (reconnecting) await reconnecting;
          if (isClosed) return;
          if (terminalError) throw terminalError;
          if (!session) throw new Error("GEMINI_SESSION_UNAVAILABLE");
          const generation = activeConnectionGeneration;
          const providerSession = session;
          const combined = inputTail.byteLength === 0 ? pcm : Buffer.concat([inputTail, pcm]);
          const completeBytes = combined.byteLength - (combined.byteLength % GEMINI_INPUT_CHUNK_BYTES);
          inputTail = Buffer.from(combined.subarray(completeBytes));
          for (let offset = 0; offset < completeBytes; offset += GEMINI_INPUT_CHUNK_BYTES) {
            if (generation !== activeConnectionGeneration || providerSession !== session || isClosed) return;
            const chunk = combined.subarray(offset, offset + GEMINI_INPUT_CHUNK_BYTES);
            await providerSession.sendRealtimeInput({
              audio: { data: chunk.toString("base64"), mimeType: `audio/pcm;rate=${AUDIO_CONFIG.inputSampleRate}` },
            });
          }
        });
      },
      async audioStreamEnd() {
        return enqueueInput(async () => {
          if (reconnecting) await reconnecting;
          if (!session || isClosed) { clearInputTail(); return; }
          const providerSession = session;
          const generation = activeConnectionGeneration;
          if (inputTail.byteLength > 0) {
            const padded = Buffer.alloc(GEMINI_INPUT_CHUNK_BYTES);
            inputTail.copy(padded);
            clearInputTail();
            await providerSession.sendRealtimeInput({
              audio: { data: padded.toString("base64"), mimeType: `audio/pcm;rate=${AUDIO_CONFIG.inputSampleRate}` },
            });
          }
          if (generation === activeConnectionGeneration && providerSession === session && !isClosed) {
            await providerSession.sendRealtimeInput({ audioStreamEnd: true });
          }
        });
      },
      async close() {
        if (isClosed) return;
        isClosed = true;
        activeConnectionGeneration = 0;
        clearInputTail();
        await inputQueue;
        closeSessionOnce(session);
      },
    };
  }
}

function isPermanentProviderError(error) {
  const status = Number(error?.status ?? error?.code);
  if ([400, 401, 403].includes(status)) return true;
  const message = error instanceof Error ? error.message : "";
  return /API[_ ]?KEY|PERMISSION_DENIED|INVALID_ARGUMENT|UNAUTHENTICATED/iu.test(message);
}

export class CloudTranslationAdvancedAdapter {
  constructor({ client, projectId, location = "global" }) {
    this.client = client;
    this.parent = `projects/${projectId}/locations/${location}`;
  }

  async translate({ text, language, sourceLanguage }) {
    const request = {
      parent: this.parent,
      contents: [String(text)],
      mimeType: "text/plain",
      targetLanguageCode: toTranslationLanguageCode(language),
      ...(sourceLanguage ? { sourceLanguageCode: toTranslationLanguageCode(sourceLanguage) } : {}),
    };
    const [response] = await this.client.translateText(request);
    const translated = String(response?.translations?.[0]?.translatedText ?? "").trim();
    if (!translated) throw new Error("TRANSLATION_EMPTY");
    return translated;
  }
}

function toTranslationLanguageCode(language) {
  const normalized = String(language).trim();
  const aliases = new Map([
    ["ko-KR", "ko"],
    ["en-US", "en"],
    ["ja-JP", "ja"],
    ["cmn-CN", "zh-CN"],
    ["zh-Hans", "zh-CN"],
    ["zh-Hant", "zh-TW"],
  ]);
  return aliases.get(normalized) ?? normalized;
}

export class CloudSpeechToTextAdapter {
  constructor({ client, projectId, languageCodes = ["auto"], diarization = true }) {
    if (!Array.isArray(languageCodes) || languageCodes.length === 0 || languageCodes.length > 3) {
      throw new Error("STT_LANGUAGE_CANDIDATE_LIMIT");
    }
    this.client = client;
    this.projectId = projectId;
    this.languageCodes = languageCodes;
    this.diarization = diarization;
  }

  async open({ onFinalUtterance, onContinuityDiscard = () => {}, diarization = this.diarization }) {
    const finalWordMap = new Map();
    const seenFinalResults = new Map();
    const finalWordWaiters = new Set();
    const segmenter = diarization
      ? new StableUtteranceSegmenter()
      : new StableTranscriptSegmenter({ onContinuityDiscard });
    const inFlightUtterances = new Set();
    let terminalError = null;
    let settleResponse;
    const responseSettled = new Promise((resolve) => { settleResponse = resolve; });
    if (typeof this.client.streamingRecognize !== "function") throw new Error("STT_STREAMING_UNAVAILABLE");
    const stream = this.client.streamingRecognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: AUDIO_CONFIG.inputSampleRate,
        audioChannelCount: 1,
        languageCode: this.languageCodes[0],
        ...(this.languageCodes.length > 1 ? { alternativeLanguageCodes: this.languageCodes.slice(1) } : {}),
        model: "latest_long",
        enableWordTimeOffsets: true,
        enableAutomaticPunctuation: true,
        ...(diarization ? { diarizationConfig: {
          enableSpeakerDiarization: true,
          minSpeakerCount: STT_CONFIG.minSpeakers,
          maxSpeakerCount: STT_CONFIG.maxSpeakers,
        } } : {}),
      },
      interimResults: true,
    });
    stream.on("data", (response) => {
      try {
        for (const result of response.results ?? []) {
          const alternative = result.alternatives?.[0];
          const words = alternative?.words ?? [];
          let isDuplicateFinal = false;
          if (result.isFinal) {
            const resultKey = createFinalResultKey(words, alternative?.transcript ?? "");
            isDuplicateFinal = seenFinalResults.has(resultKey);
            if (!isDuplicateFinal) {
              seenFinalResults.set(resultKey, true);
              if (seenFinalResults.size > 256) seenFinalResults.delete(seenFinalResults.keys().next().value);
              for (const word of words) {
                const normalizedWord = toWord(word, diarization ? undefined : "1");
                finalWordMap.set(`${normalizedWord.startMs}:${normalizedWord.endMs}`, normalizedWord);
              }
              if (words.length > 0) {
                const finalWords = sortedFinalWords(finalWordMap);
                for (const waiter of finalWordWaiters) waiter.resolve(finalWords);
                finalWordWaiters.clear();
              }
            }
          }
          if (isDuplicateFinal) continue;
          for (const utterance of segmenter.accept(result)) {
            const task = Promise.resolve()
              .then(() => onFinalUtterance({
                ...utterance,
                sourceEndedAt: new Date().toISOString(),
              }))
              .catch((error) => {
                terminalError = error instanceof Error ? error : new Error("STT_UTTERANCE_FAILED");
              })
              .finally(() => inFlightUtterances.delete(task));
            inFlightUtterances.add(task);
          }
        }
      } catch (error) {
        terminalError = error instanceof Error ? error : new Error("STT_STREAM_FAILED");
        for (const waiter of finalWordWaiters) waiter.reject(terminalError);
        finalWordWaiters.clear();
        stream.destroy?.();
      }
    });
    stream.on("error", (error) => {
      terminalError = safeSpeechProviderError(error);
      for (const waiter of finalWordWaiters) waiter.reject(terminalError);
      finalWordWaiters.clear();
      settleResponse();
    });
    stream.on("end", settleResponse);
    stream.on("close", settleResponse);
    return {
      async sendAudio(frame) {
        if (terminalError) throw terminalError;
        stream.write(frame);
      },
      async getFinalWords() {
        if (terminalError) throw terminalError;
        return sortedFinalWords(finalWordMap);
      },
      async waitForFinalWords(timeoutMilliseconds) {
        if (terminalError) throw terminalError;
        if (finalWordMap.size > 0) return sortedFinalWords(finalWordMap);
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            finalWordWaiters.delete(waiter);
            reject(new Error("STT_ROLLOVER_WORDS_UNAVAILABLE"));
          }, timeoutMilliseconds);
          const waiter = {
            resolve: (words) => {
              clearTimeout(timeout);
              resolve(words);
            },
            reject: (error) => {
              clearTimeout(timeout);
              reject(error);
            },
          };
          finalWordWaiters.add(waiter);
        });
      },
      async close() {
        stream.end();
        let responseTimeout;
        try {
          await Promise.race([
            responseSettled,
            new Promise((resolve) => { responseTimeout = setTimeout(resolve, 3_000); }),
          ]);
        } finally {
          clearTimeout(responseTimeout);
        }
        await Promise.allSettled(inFlightUtterances);
        segmenter.clear();
        if (terminalError) throw terminalError;
      },
    };
  }
}

function createFinalResultKey(words, transcript) {
  const wordIdentity = words.map((word) => [
    String(word.word ?? "").normalize("NFC"),
    durationMilliseconds(word.startOffset ?? word.startTime),
    durationMilliseconds(word.endOffset ?? word.endTime),
  ].join(":"));
  return `${String(transcript).normalize("NFC").trim()}\u0000${wordIdentity.join("\u0001")}`;
}

export class ChirpTextToSpeechAdapter {
  constructor({ client }) {
    this.client = client;
  }

  async *synthesizeStream({ language, voiceName, text, sampleRate, signal }) {
    if (typeof this.client.streamingSynthesize !== "function") throw new Error("TTS_STREAMING_UNAVAILABLE");
    const locale = CHIRP_LOCALES.get(language) ?? language;
    const segments = segmentTextForStreamingTts(String(text));
    if (segments.length === 0) return;
    const conditioner = new Pcm16StreamConditioner({ sampleRate, preserveGain: true });
    let pendingByte = null;
    for await (const providerChunk of synthesizeChirpSegments({
      client: this.client,
      locale,
      voiceName,
      segments,
      sampleRate,
      signal,
    })) {
        let bytes = providerChunk;
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
        if (bytes.byteLength === 0) continue;
        const conditioned = conditioner.process(bytes);
        if (conditioned.byteLength > 0) yield conditioned;
    }
    if (pendingByte !== null) throw new Error("INVALID_PCM16_STREAM");
    const tail = conditioner.finish();
    if (tail.byteLength > 0) yield tail;
  }
}

async function* synthesizeChirpSegments({ client, locale, voiceName, segments, sampleRate, signal }) {
  const stream = client.streamingSynthesize();
  let isCancelled = false;
  let didEndResponse = false;
  let isStreamDestroyed = false;
  const destroyStreamOnce = () => {
      if (isStreamDestroyed || typeof stream.destroy !== "function") return;
      isStreamDestroyed = true;
      stream.destroy();
  };
  let isResponsePaused = false;
  const responses = new AsyncResponseQueue({
      maxBufferedBytes: MAX_TTS_RESPONSE_BUFFER_BYTES,
      onOverflow: destroyStreamOnce,
      onBufferedBytesChange(bufferedBytes) {
        if (!isResponsePaused && bufferedBytes >= TTS_RESPONSE_HIGH_WATER_BYTES && typeof stream.pause === "function") {
          isResponsePaused = true;
          stream.pause();
        } else if (isResponsePaused && bufferedBytes <= TTS_RESPONSE_LOW_WATER_BYTES && typeof stream.resume === "function") {
          isResponsePaused = false;
          stream.resume();
        }
      },
  });
  const onAbort = () => {
      isCancelled = true;
      const reason = signal?.reason instanceof Error ? signal.reason : new Error("TTS_STREAM_ABORTED");
      responses.fail(reason);
      destroyStreamOnce();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  stream.on("data", (response) => {
      try {
        const audio = response?.audioContent;
        if (!audio || audio.byteLength === 0) return;
        responses.push(new Uint8Array(audio));
      } catch (error) {
        responses.fail(error);
      }
  });
  stream.on("error", (error) => responses.fail(error instanceof Error ? error : new Error("TTS_STREAM_FAILED")));
  stream.on("end", () => {
    didEndResponse = true;
    responses.end();
  });
  const writer = (async () => {
      stream.write({
        streamingConfig: {
          voice: { languageCode: locale, name: `${locale}-Chirp3-HD-${voiceName}` },
          streamingAudioConfig: { audioEncoding: "PCM", sampleRateHertz: sampleRate, speakingRate: 1.08 },
        },
      });
      for (const text of segments) {
        if (isCancelled) return;
        if (!stream.write({ input: { text } })) await onceEvent(stream, "drain", signal);
        // 2026-07-20 fix: every input remains below Google's 5,000-byte request cap.
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (!isCancelled) {
        stream.end();
      }
  })().catch((error) => responses.fail(error));
  try {
    for await (const chunk of responses) yield chunk;
    await writer;
  } finally {
    isCancelled = true;
    signal?.removeEventListener("abort", onAbort);
    if (!didEndResponse) destroyStreamOnce();
  }
}

function toWord(word, fallbackSpeakerLabel = "") {
  return {
    word: word.word ?? "",
    startMs: durationMilliseconds(word.startOffset ?? word.startTime),
    endMs: durationMilliseconds(word.endOffset ?? word.endTime),
    speakerLabel: String(word.speakerLabel ?? word.speakerTag ?? fallbackSpeakerLabel),
  };
}

function sortedFinalWords(finalWordMap) {
  return [...finalWordMap.values()].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

function safeSpeechProviderError(error) {
  const statusCode = Number.isInteger(Number(error?.code)) ? Number(error.code) : 2;
  const statusName = GRPC_STATUS_NAMES.get(statusCode) ?? "UNKNOWN";
  const details = String(error?.details ?? error?.message ?? "");
  let providerReason = statusName;
  if (/permission|not authorized|access denied/iu.test(details)) providerReason = "PERMISSION_DENIED";
  else if (/quota|resource exhausted|rate limit/iu.test(details)) providerReason = "RESOURCE_EXHAUSTED";
  else if (/API.+not.+enabled|service.+disabled/iu.test(details)) providerReason = "API_DISABLED";
  else if (/diarization|speaker/iu.test(details)) providerReason = "DIARIZATION_CONFIGURATION_REJECTED";
  else if (/language/iu.test(details)) providerReason = "LANGUAGE_CONFIGURATION_REJECTED";
  else if (/model/iu.test(details)) providerReason = "MODEL_CONFIGURATION_REJECTED";
  else if (/encoding|sample.?rate|channel/iu.test(details)) providerReason = "AUDIO_CONFIGURATION_REJECTED";
  else if (/config|request/iu.test(details)) providerReason = "RECOGNITION_CONFIGURATION_REJECTED";
  const safeError = new Error(`STT_PROVIDER_${statusName}`);
  safeError.providerStatusCode = statusCode;
  safeError.providerReason = providerReason;
  return safeError;
}

const GRPC_STATUS_NAMES = new Map([
  [0, "OK"], [1, "CANCELLED"], [2, "UNKNOWN"], [3, "INVALID_ARGUMENT"],
  [4, "DEADLINE_EXCEEDED"], [5, "NOT_FOUND"], [6, "ALREADY_EXISTS"],
  [7, "PERMISSION_DENIED"], [8, "RESOURCE_EXHAUSTED"], [9, "FAILED_PRECONDITION"],
  [10, "ABORTED"], [11, "OUT_OF_RANGE"], [12, "UNIMPLEMENTED"], [13, "INTERNAL"],
  [14, "UNAVAILABLE"], [15, "DATA_LOSS"], [16, "UNAUTHENTICATED"],
]);

function durationMilliseconds(duration) {
  return Number(duration?.seconds ?? 0) * 1_000 + Number(duration?.nanos ?? 0) / 1_000_000;
}

class AsyncResponseQueue {
  #values = [];
  #waiters = [];
  #ended = false;
  #error = null;
  #bufferedBytes = 0;

  constructor({ maxBufferedBytes = Number.POSITIVE_INFINITY, onOverflow = () => {}, onBufferedBytesChange = () => {} } = {}) {
    this.maxBufferedBytes = maxBufferedBytes;
    this.onOverflow = onOverflow;
    this.onBufferedBytesChange = onBufferedBytesChange;
  }

  push(value) {
    if (this.#ended || this.#error) return;
    const valueBytes = value?.byteLength ?? 0;
    if (valueBytes > this.maxBufferedBytes || this.#bufferedBytes + valueBytes > this.maxBufferedBytes) {
      this.fail(new Error("TTS_RESPONSE_BUFFER_EXCEEDED"));
      this.onOverflow();
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else {
      this.#values.push(value);
      this.#bufferedBytes += valueBytes;
      this.onBufferedBytesChange(this.#bufferedBytes);
    }
  }

  end() {
    if (this.#ended || this.#error) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error) {
    if (this.#ended || this.#error) return;
    this.#error = error instanceof Error ? error : new Error("TTS_STREAM_FAILED");
    this.#values = [];
    this.#bufferedBytes = 0;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(this.#error);
  }

  next() {
    if (this.#values.length > 0) {
      const value = this.#values.shift();
      this.#bufferedBytes -= value?.byteLength ?? 0;
      this.onBufferedBytesChange(this.#bufferedBytes);
      return Promise.resolve({ value, done: false });
    }
    if (this.#error) return Promise.reject(this.#error);
    if (this.#ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

function onceEvent(emitter, eventName, signal) {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("TTS_STREAM_ABORTED"));
    };
    const cleanup = () => {
      emitter.off(eventName, onEvent);
      emitter.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    emitter.once(eventName, onEvent);
    emitter.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
