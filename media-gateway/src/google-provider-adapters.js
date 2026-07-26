import { AUDIO_CONFIG, STT_CONFIG, textPlausiblyInLanguage } from "./config.js";
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

// 2026-07-23 fix: gemini-3.5-live-translate-preview validates targetLanguageCode
// lazily on the FIRST audio chunk and rejects regioned codes (ko-KR/en-US)
// with close 1007 "Request contains an invalid argument". The official list
// (ai.google.dev/gemini-api/docs/live-api/live-translate) is bare BCP-47 —
// only Chinese scripts and Portuguese carry a suffix. Chirp TTS locales
// (CHIRP_LOCALES above) legitimately stay regioned; do not merge the two maps.
const LIVE_TRANSLATION_LANGUAGE_CODES = new Map([
  ["en", "en"], ["ko", "ko"], ["ja", "ja"],
  ["zh-CN", "zh-Hans"],
  ["zh", "zh-Hans"],
  ["zh-Hans", "zh-Hans"],
  ["zh-Hant", "zh-Hant"],
  ["es", "es"], ["pt", "pt-BR"], ["fr", "fr"], ["de", "de"],
  ["ru", "ru"], ["hi", "hi"], ["id", "id"], ["vi", "vi"], ["it", "it"],
]);

// Delta-accumulation for Live API transcriptions — exact copy of the desktop
// pipeline's mergeTranscript/boundTranscript (src/gemini-live-translate.js).
const MAX_LIVE_TRANSCRIPT_CHARS = 16_384;

function boundLiveTranscript(value) {
  const text = String(value ?? "");
  return text.length <= MAX_LIVE_TRANSCRIPT_CHARS ? text : text.slice(-MAX_LIVE_TRANSCRIPT_CHARS);
}

function mergeLiveTranscript(accumulated, incoming) {
  const prev = String(accumulated ?? "");
  const text = String(incoming ?? "");
  if (!text) return boundLiveTranscript(prev);
  if (!prev) return boundLiveTranscript(text);
  if (text === prev) return boundLiveTranscript(prev);
  if (text.startsWith(prev)) return boundLiveTranscript(text);
  if (prev.startsWith(text)) return boundLiveTranscript(prev);
  if (prev.endsWith(text)) return boundLiveTranscript(prev);
  return boundLiveTranscript(`${prev}${text}`);
}

/** Last committable sentence boundary in `text` (exclusive end index), or 0.
 *  During continuous speech the live-translate model never sends
 *  turnComplete, so finals come from append-only sentence commits — the same
 *  WhisperLiveKit-style pattern the desktop subtitle pipeline uses. CJK stops
 *  commit immediately; Latin punctuation needs a following space/quote so
 *  decimals ("3.5") and abbreviations ("U.S.") stay intact. */
export function lastSentenceBoundaryEnd(text) {
  const value = String(text ?? "");
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const char = value[index];
    if ("。！？…".includes(char)) return index + 1;
    if (!".!?".includes(char)) continue;
    const next = value[index + 1];
    if (next === undefined) continue; // stream may still be mid-sentence
    if (/[\s"'”’)\]]/u.test(next)) return index + 1;
  }
  return 0;
}

const TTS_RESPONSE_HIGH_WATER_BYTES = 144_000;
const TTS_RESPONSE_LOW_WATER_BYTES = 72_000;
const MAX_TTS_RESPONSE_BUFFER_BYTES = 480_000;
const GEMINI_INPUT_CHUNK_BYTES = 3_200;
const INPUT_CONTEXT_MAX_AGE_MILLISECONDS = 1_000;

export class GeminiLiveTranslateAdapter {
  constructor({
    client,
    model,
    reconnectDelay = (attempt) => new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** Math.min(attempt - 1, 6), 30_000))),
    finalFlushMilliseconds = 2_500,
    now = Date.now,
  }) {
    this.client = client;
    this.model = model;
    this.reconnectDelay = reconnectDelay;
    this.finalFlushMilliseconds = finalFlushMilliseconds;
    this.now = now;
  }

  /** `onCallbackError` receives any error thrown by a caption/audio handler. It
   *  exists so a failing caption path is observable instead of silent — see the
   *  comment on `enqueueCallback`. Defaults to a no-op so existing callers keep
   *  today's fail-open behaviour, minus the silence. */
  async open({
    language, onCaption, onAudio, onInterruption, onInputCaption = null,
    onCallbackError = null, correlateInputCaption = false,
  }) {
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
    // Live API transcription messages are DELTAS, and during continuous
    // speech the model never sends turnComplete. Like the desktop pipeline:
    // accumulate with a prefix-aware merge, commit complete sentences as
    // finals (append-only), keep the remainder as the live partial, and
    // flush the tail as final after a short silence.
    const makeTranscriptLane = () => ({ accumulated: "", committedLength: 0 });
    let outputLane = makeTranscriptLane();
    let inputLane = makeTranscriptLane();
    let inputTranscriptLanguageCode = null;
    let outputTranscriptLanguageCode = null;
    let nextUtteranceIdentity = 0;
    const utteranceNamespace = encodeURIComponent(String(language));
    const inputContexts = [];
    const captureSegments = [];
    let pendingOutputFinal = null;
    let pendingOutputTimer = null;
    let finalFlushTimer = null;
    const clearFinalFlushTimer = () => {
      if (finalFlushTimer !== null) clearTimeout(finalFlushTimer);
      finalFlushTimer = null;
    };
    const resetTranscriptLanes = () => {
      outputLane = makeTranscriptLane();
      inputLane = makeTranscriptLane();
      inputTranscriptLanguageCode = null;
      outputTranscriptLanguageCode = null;
      inputContexts.length = 0;
      captureSegments.length = 0;
      pendingOutputFinal = null;
      if (pendingOutputTimer !== null) clearTimeout(pendingOutputTimer);
      pendingOutputTimer = null;
      clearFinalFlushTimer();
    };
    const emitLane = async (lane, emit, { flushAll = false } = {}) => {
      const uncommitted = lane.accumulated.slice(lane.committedLength);
      const boundary = flushAll ? uncommitted.length : lastSentenceBoundaryEnd(uncommitted);
      if (boundary > 0) {
        const segment = uncommitted.slice(0, boundary).trim();
        lane.committedLength += boundary;
        if (segment) await emit({ text: segment, isFinal: true });
      }
      if (flushAll) {
        lane.accumulated = "";
        lane.committedLength = 0;
        return;
      }
      const tail = lane.accumulated.slice(lane.committedLength).trim();
      if (tail) await emit({ text: tail, isFinal: false });
      if (lane.committedLength > 8_192) {
        lane.accumulated = lane.accumulated.slice(lane.committedLength);
        lane.committedLength = 0;
      }
    };
    const emitInput = async (caption) => {
      let inputContext = inputContexts.at(-1) ?? null;
      if (caption.isFinal) {
        // Segment transitions and input/output final callbacks advance on
        // independent schedules. Indexing by inputContexts.length reused the
        // oldest retained host segment after it had already produced finals,
        // so the first participant final was persisted as host/null. Consume
        // the oldest transition that has not produced an input final; repeated
        // turns by the current speaker deliberately reuse the last segment.
        const capture = captureSegments.find((segment) => segment.hasInputFinal !== true)
          ?? captureSegments.at(-1)
          ?? null;
        if (capture) capture.hasInputFinal = true;
        inputContext = {
          sourceText: caption.text,
          sourceLanguage: inputTranscriptLanguageCode,
          // Every target language owns an independent Gemini session. Include
          // that lane in the identity so equal generation/counter values from
          // two sessions can never merge unrelated database utterances.
          utteranceKey: `gemini:${utteranceNamespace}:${activeConnectionGeneration}:${++nextUtteranceIdentity}`,
          capturedAt: capture?.capturedAt,
          floorSpeaker: capture?.floorSpeaker ?? null,
          createdAt: this.now(),
          captureSegment: capture,
        };
        inputContexts.push(inputContext);
        if (inputContexts.length > 100) {
          retireCaptureSegment(inputContexts.shift());
        }
      }
      await onInputCaption?.({ ...caption, languageCode: inputTranscriptLanguageCode, ...(inputContext ?? {}) });
      if (caption.isFinal && pendingOutputFinal) {
        const pending = pendingOutputFinal;
        pendingOutputFinal = null;
        if (pendingOutputTimer !== null) clearTimeout(pendingOutputTimer);
        pendingOutputTimer = null;
        await deliverOutput(pending, takeInputContext());
      }
    };
    const takeInputContext = () => {
      while (inputContexts.length > 0
        && this.now() - inputContexts[0].createdAt > INPUT_CONTEXT_MAX_AGE_MILLISECONDS) {
        retireCaptureSegment(inputContexts.shift());
      }
      return inputContexts.shift() ?? null;
    };
    function retireCaptureSegment(context) {
      const index = captureSegments.indexOf(context?.captureSegment);
      // Keep the active tail: repeated utterances by the same producer need a
      // capture identity even when no new audio-boundary segment is appended.
      if (index >= 0 && index < captureSegments.length - 1) {
        captureSegments.splice(0, index + 1);
      }
    }
    async function deliverOutput(caption, context) {
      const publicContext = context ? {
        sourceText: context.sourceText,
        sourceLanguage: context.sourceLanguage,
        utteranceKey: context.utteranceKey,
        capturedAt: context.capturedAt,
        floorSpeaker: context.floorSpeaker,
      } : {};
      await onCaption({ ...caption, ...publicContext });
      if (caption.isFinal && context) {
        retireCaptureSegment(context);
      }
    }
    const emitOutput = async (caption) => {
      const captionWithLanguage = outputTranscriptLanguageCode
        ? { ...caption, languageCode: outputTranscriptLanguageCode }
        : caption;
      const context = caption.isFinal ? takeInputContext() : (inputContexts[0] ?? null);
      if (caption.isFinal && !context && correlateInputCaption) {
        if (pendingOutputFinal) await deliverOutput(pendingOutputFinal, null);
        pendingOutputFinal = captionWithLanguage;
        if (pendingOutputTimer !== null) clearTimeout(pendingOutputTimer);
        pendingOutputTimer = setTimeout(() => {
          pendingOutputTimer = null;
          enqueueCallback(async () => {
            if (!pendingOutputFinal || isClosed) return;
            const pending = pendingOutputFinal;
            pendingOutputFinal = null;
            await deliverOutput(pending, null);
          });
        }, 120);
        return;
      }
      await deliverOutput(captionWithLanguage, context);
    };
    // Silence flush: the model sends no turn signal during continuous talk,
    // so a short pause commits whatever remains as the final segment.
    const armFinalFlushTimer = (generation) => {
      clearFinalFlushTimer();
      finalFlushTimer = setTimeout(() => {
        finalFlushTimer = null;
        enqueueCallback(async () => {
          if (generation !== activeConnectionGeneration || isClosed) return;
          await emitLane(inputLane, emitInput, { flushAll: true });
          if (generation !== activeConnectionGeneration || isClosed) return;
          await emitLane(outputLane, emitOutput, { flushAll: true });
          inputTranscriptLanguageCode = null;
        });
      }, this.finalFlushMilliseconds);
    };
    let inputTail = Buffer.alloc(0);
    let inputQueue = Promise.resolve();
    const clearInputTail = () => { inputTail = Buffer.alloc(0); };
    const enqueueInput = (task) => {
      const queued = inputQueue.then(task, task);
      inputQueue = queued.catch(() => undefined);
      return queued;
    };
    // The tail must survive a throwing handler — one bad caption cannot stop the
    // stream — but the failure MUST be reported. Swallowing it meant that when
    // the caption path failed on every message (a snapshot allowlist rejection
    // escalating to SESSION_STOPPED, a Supabase 5xx, a polish adapter throwing),
    // every caption for the rest of the session vanished while /health stayed ok
    // and the audio frame counter kept climbing. There was no log, no metric,
    // and no way to tell it apart from a quiet room.
    const enqueueCallback = (task) => {
      callbackTail = callbackTail.then(task, task).catch((error) => { onCallbackError?.(error); });
    };
    // Audio gets its OWN serialization tail. PCM must stay ordered relative to
    // PCM and captions relative to captions, but the two are independent — and
    // the committed-caption handler runs an LLM polish pass. Sharing one tail
    // meant a slow polish delayed the listener's interpreted audio by the whole
    // polish timeout, both within a message and across every message behind it.
    let audioTail = Promise.resolve();
    const enqueueAudio = (task) => {
      audioTail = audioTail.then(task, task).catch((error) => { onCallbackError?.(error); });
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
          // Desktop subtitle parity + the ultra-low-latency tuning: a short
          // end-of-speech window finalizes each utterance in ~450ms instead
          // of the provider default, without clipping mid-word.
          realtimeInputConfig: {
            automaticActivityDetection: {
              prefixPaddingMs: 100,
              silenceDurationMs: 450,
            },
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
            const inputTranscription = message.serverContent?.inputTranscription;
            const isTurnComplete = Boolean(message.serverContent?.turnComplete || message.serverContent?.generationComplete);
            const isInterrupted = Boolean(message.serverContent?.interrupted);
            const audioParts = (message.serverContent?.modelTurn?.parts ?? []).flatMap((part) => {
              const inlineData = part.inlineData ?? part.inline_data;
              if (typeof inlineData?.data !== "string" || !String(inlineData.mimeType ?? inlineData.mime_type).startsWith("audio/pcm")) return [];
              const pcm = Uint8Array.from(Buffer.from(inlineData.data, "base64"));
              return pcm.byteLength > 0 ? [pcm] : [];
            });
            // Dispatched before the caption work and on a separate tail, so
            // playout never waits on a caption polish round-trip.
            if (audioParts.length > 0) {
              enqueueAudio(async () => {
                for (const pcm of audioParts) {
                  if (connectionGeneration !== activeConnectionGeneration || isClosed) return;
                  await onAudio?.({ pcm, sampleRate: AUDIO_CONFIG.outputSampleRate });
                }
              });
            }
            enqueueCallback(async () => {
              if (connectionGeneration !== activeConnectionGeneration || isClosed) return;
              if (isInterrupted) {
                // A barge-in abandons the current utterance; stale accumulated
                // text must not leak into the next one.
                resetTranscriptLanes();
                // Audio runs on its own tail, so drain it before clearing:
                // the clear must still be ordered AFTER every PCM chunk queued
                // before the barge-in, or a clear could be followed by stale
                // audio. Awaiting the tail keeps that guarantee without putting
                // caption polish back in front of playout.
                await audioTail;
                await onInterruption?.();
                if (connectionGeneration !== activeConnectionGeneration || isClosed) return;
              }
              if (inputTranscription?.text) {
                inputLane.accumulated = mergeLiveTranscript(inputLane.accumulated, inputTranscription.text);
                if (inputTranscription.languageCode) inputTranscriptLanguageCode = inputTranscription.languageCode;
                if (!isTurnComplete) {
                  await emitLane(inputLane, emitInput);
                  if (connectionGeneration !== activeConnectionGeneration || isClosed) return;
                }
              }
              if (transcription?.text) {
                if (transcription.languageCode) outputTranscriptLanguageCode = transcription.languageCode;
                outputLane.accumulated = mergeLiveTranscript(outputLane.accumulated, transcription.text);
                if (!isTurnComplete) {
                  await emitLane(outputLane, emitOutput);
                  if (connectionGeneration !== activeConnectionGeneration || isClosed) return;
                }
              }
              if (isTurnComplete) {
                clearFinalFlushTimer();
                await emitLane(inputLane, emitInput, { flushAll: true });
                if (connectionGeneration !== activeConnectionGeneration || isClosed) return;
                await emitLane(outputLane, emitOutput, { flushAll: true });
                if (connectionGeneration !== activeConnectionGeneration || isClosed) return;
                // A completed provider turn is a hard correlation boundary.
                // Any input left unmatched here had no translated output; it
                // must not be attached to the next turn's otherwise unrelated
                // output. Keep only the latest capture marker so continuing
                // audio with the same floor can still be attributed.
                inputContexts.length = 0;
                if (captureSegments.length > 1) captureSegments.splice(0, captureSegments.length - 1);
                inputTranscriptLanguageCode = null;
                outputTranscriptLanguageCode = null;
              } else if (transcription?.text || inputTranscription?.text) {
                armFinalFlushTimer(connectionGeneration);
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
      // Ditto for half-accumulated transcripts.
      resetTranscriptLanes();
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
      async sendAudio(frame, metadata = null) {
        if (metadata && Number.isFinite(metadata.capturedAt)) {
          const previous = captureSegments.at(-1);
          const previousParticipantId = previous?.floorSpeaker?.participantId ?? null;
          const participantId = metadata.floorSpeaker?.participantId ?? null;
          if (!previous || previousParticipantId !== participantId) {
            captureSegments.push({
              capturedAt: metadata.capturedAt,
              floorSpeaker: metadata.floorSpeaker ?? null,
              hasInputFinal: false,
            });
            if (captureSegments.length > 100) captureSegments.shift();
          }
        }
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
        clearFinalFlushTimer();
        if (pendingOutputTimer !== null) clearTimeout(pendingOutputTimer);
        pendingOutputTimer = null;
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

  async open({ onFinalUtterance, onPartialTranscript = null, onContinuityDiscard = () => {}, diarization = this.diarization }) {
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
        if (typeof onPartialTranscript === "function") {
          const interimResults = (response.results ?? []).filter((result) => !result.isFinal);
          const interimText = interimResults
            .map((result) => String(result.alternatives?.[0]?.transcript ?? ""))
            .join("")
            .trim();
          if (interimText) {
            onPartialTranscript({ text: interimText, sourceLanguage: interimResults[0]?.languageCode });
          }
        }
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
      console.error("[stt] streaming recognize error:", error instanceof Error ? error.message : error);
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

const TRANSLATION_LANGUAGE_NAMES = new Map([
  ["ko", "Korean"], ["en", "English"], ["ja", "Japanese"], ["zh", "Chinese"],
  ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["pt", "Portuguese"],
  ["ru", "Russian"], ["vi", "Vietnamese"], ["id", "Indonesian"], ["th", "Thai"], ["ar", "Arabic"],
]);

function translationLanguageName(language) {
  const base = String(language ?? "").trim().toLowerCase().split("-")[0];
  return TRANSLATION_LANGUAGE_NAMES.get(base) ?? String(language ?? "").trim();
}

/** ALL meeting captions (partials and finals) are translated by Gemini 3.5
 *  Flash — the same model family and glossary as the desktop subtitle
 *  pipeline, per the confirmed provider split (captions=Gemini, voice=OpenAI).
 *  The machine-translation fallback runs ONLY when Gemini fails or times out,
 *  so captions never stall or drop. */
export class GeminiTextTranslateAdapter {
  // Interims get a much tighter budget than finals (1.2s vs 3.5s). Partial
  // lanes translate one at a time and drop the intermediate transcripts
  // (latest-wins), so a slow call does not just delay itself — it holds the lane
  // while fresher speech piles up behind it, which is what makes a caption feel
  // stuck. Abandoning a stale interim lets the next, fresher one go out; nothing
  // is lost because the finalized utterance translates again on its own budget.
  constructor({ client, model = "gemini-3.5-flash", fallback = null, timeoutMilliseconds = 3_500, partialTimeoutMilliseconds = 1_200 }) {
    if (!client?.models?.generateContent) throw new Error("GEMINI_TEXT_CLIENT_UNAVAILABLE");
    this.client = client;
    this.model = model;
    this.fallback = fallback;
    this.timeoutMilliseconds = timeoutMilliseconds;
    this.partialTimeoutMilliseconds = partialTimeoutMilliseconds;
  }

  async translate(input) {
    const { text, language, sourceLanguage, glossaryText, intent } = input;
    try {
      const targetName = translationLanguageName(language);
      const sourceHint = sourceLanguage && textPlausiblyInLanguage(text, sourceLanguage)
        ? ` The utterance is in ${translationLanguageName(sourceLanguage)}.`
        : "";
      const glossarySection = typeof glossaryText === "string" && glossaryText.trim()
        ? ["", "Glossary — always use these exact term translations:", glossaryText.trim()]
        : [];
      const prompt = [
        `You are a professional simultaneous interpreter for business meetings.${sourceHint}`,
        `Translate the utterance below into natural, business-appropriate ${targetName}.`,
        "Keep company names, personal names, and acronyms verbatim.",
        "Reply with ONLY the translation - no quotes, no notes, no alternatives.",
        ...glossarySection,
        "",
        text,
      ].join("\n");
      let timeoutHandle;
      const timeoutMilliseconds = intent === "partial" ? this.partialTimeoutMilliseconds : this.timeoutMilliseconds;
      const response = await Promise.race([
        this.client.models.generateContent({
          model: this.model,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: { temperature: 0.2, maxOutputTokens: 1_024 },
        }),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error("GEMINI_TRANSLATE_TIMEOUT")), timeoutMilliseconds);
        }),
      ]).finally(() => clearTimeout(timeoutHandle));
      const translated = String(response?.text
        ?? response?.candidates?.[0]?.content?.parts?.map((part) => part?.text ?? "").join("")
        ?? "").trim();
      if (!translated) throw new Error("TRANSLATION_EMPTY");
      // An echoing/refusing model must never surface wrong-script text.
      if (!textPlausiblyInLanguage(translated, language)) throw new Error("TRANSLATION_WRONG_SCRIPT");
      return translated;
    } catch (error) {
      const code = error instanceof Error ? error.message : "GEMINI_TRANSLATE_FAILED";
      console.warn(`[translate] gemini failed (${code}); falling back to machine translation`);
      if (this.fallback) return this.fallback.translate(input);
      throw error;
    }
  }
}
