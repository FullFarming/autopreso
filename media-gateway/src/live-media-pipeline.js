import { AUDIO_CONFIG, validateLiveSettings } from "./config.js";
import { OrderedTaskQueue } from "./ordered-task-queue.js";
import { RollingSpeechSession } from "./rolling-speech-session.js";
import { SpeakerRegistry } from "./speaker-registry.js";

const INPUT_FRAME_BYTES = AUDIO_CONFIG.inputSampleRate * 2 * AUDIO_CONFIG.chunkMilliseconds / 1_000;
const OUTPUT_CHUNK_BYTES = AUDIO_CONFIG.outputSampleRate * 2 * 250 / 1_000;
const TTS_INACTIVITY_MILLISECONDS = 10_000;
const TTS_MAX_SYNTHESIS_MILLISECONDS = 120_000;
const LANGUAGE_FAILURE_LIMIT = 3;
const LANGUAGE_COOLDOWN_MILLISECONDS = 30_000;
const FLOOR_ATTRIBUTION_GRACE_MILLISECONDS = 2_000;

export class LiveMediaPipeline {
  #liveSessions = new Map();
  #voiceSessions = new Map();
  #translationQueues = new Map();
  #ttsQueues = new Map();
  #stt = null;
  #lastAudioAt = null;
  #didEndTurn = false;
  #seq;
  #isStopped = false;
  #ttsAbortControllers = new Set();
  #languageRecovery = new Map();
  #recentUtteranceKeys = new Map();
  #presentationCaptionState = new Map();
  #floorSpeaker = null;
  #recentFloor = null;

  constructor({
    sessionId,
    sessionType,
    outputMode,
    maxViewers,
    glossaryPack,
    mode,
    voiceOutputMode,
    voiceProvider,
    languages,
    dependencies,
    now = Date.now,
    speakerRegistry = null,
    initialSequence = 0,
    onHostEvent = null,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  }) {
    const settings = validateLiveSettings({
      sessionType,
      outputMode,
      maxViewers,
      glossaryPack,
      mode,
      voiceOutputMode,
      voiceProvider,
      languages,
    });
    this.sessionId = sessionId;
    this.sessionType = settings.sessionType;
    this.outputMode = settings.outputMode;
    this.voiceProvider = settings.voiceProvider;
    this.maxViewers = settings.maxViewers;
    this.glossaryPack = settings.glossaryPack;
    this.languages = settings.languages;
    this.dependencies = dependencies;
    this.now = now;
    if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) throw new Error("INVALID_INITIAL_SEQUENCE");
    this.#seq = initialSequence;
    this.onHostEvent = onHostEvent;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.speakers = speakerRegistry ?? new SpeakerRegistry({
      sessionType: settings.sessionType,
      outputMode: settings.outputMode,
      now,
    });
    this.speakers.setMode(settings.sessionType, settings.outputMode);
    for (const language of this.languages) {
      this.#translationQueues.set(language, new OrderedTaskQueue({
        maxPending: 32,
        taskTimeoutMs: 15_000,
        admissionTimeoutMs: 2_000,
      }));
      if (hasAudioOutput(settings.outputMode)) {
        this.#ttsQueues.set(language, new OrderedTaskQueue({
          maxPending: 32,
          taskTimeoutMs: TTS_MAX_SYNTHESIS_MILLISECONDS + 5_000,
          admissionTimeoutMs: 2_000,
          onBackpressureChange: (isBackpressured) => {
            void this.#setLanguageBackpressure(language, isBackpressured);
          },
        }));
      }
      this.#languageRecovery.set(language, { consecutiveFailures: 0, cooldownUntil: 0, status: "ready" });
    }
  }

  get lastSequence() {
    return this.#seq;
  }

  async start() {
    if (usesLivePresentation(this.sessionType)) {
      const opened = await Promise.all(this.languages.map(async (language) => {
        try {
          const session = await this.dependencies.liveTranslate.open({
            language,
            inputSampleRate: AUDIO_CONFIG.inputSampleRate,
            outputSampleRate: AUDIO_CONFIG.outputSampleRate,
            contextCompression: true,
            sessionResumption: true,
            onCaption: (caption) => this.#publishPresentationCaption(language, caption),
            onAudio: this.voiceProvider === "gemini"
              ? (audio) => this.#publishPresentationAudio(language, audio)
              : async () => {},
            onInterruption: () => this.#publishAudioControl(language, "clear", "interrupted"),
          });
          await this.#publishLanguageStatus(language, "ready");
          return [language, session];
        } catch {
          await this.#publishLanguageStatus(language, "unavailable", "LANGUAGE_UNAVAILABLE");
          return null;
        }
      }));
      this.#liveSessions = new Map(opened.filter(Boolean));
      if (this.#liveSessions.size === 0) throw new Error("LANGUAGE_UNAVAILABLE");
      if (hasAudioOutput(this.outputMode) && this.voiceProvider === "openai") {
        const voiceSessions = await Promise.all(this.languages.map(async (language) => {
          try {
            const session = await this.dependencies.openaiLiveTranslate.open({
              language: language.toLowerCase().split("-")[0],
              inputSampleRate: AUDIO_CONFIG.inputSampleRate,
              outputSampleRate: AUDIO_CONFIG.outputSampleRate,
              onAudio: (audio) => this.#publishPresentationAudio(language, audio),
              onInterruption: () => this.#publishAudioControl(language, "clear", "interrupted"),
            });
            return [language, session];
          } catch {
            await this.#publishAudioControl(language, "clear", "voice_unavailable");
            await this.#publishLanguageStatus(language, "ready", "VOICE_UNAVAILABLE");
            return null;
          }
        }));
        this.#voiceSessions = new Map(voiceSessions.filter(Boolean));
      }
      if (typeof this.dependencies.publisher.markLive === "function") await this.dependencies.publisher.markLive(this.sessionId);
      return;
    }
    this.#stt = new RollingSpeechSession({
      provider: {
        open: (options) => this.dependencies.speechToText.open({
          ...options,
          diarization: this.sessionType === "meeting",
        }),
      },
      onFinalUtterance: (utterance) => this.acceptFinalUtterance(utterance),
      onRemap: (mapping) => {
        for (const [nextLabel, previousLabel] of mapping) this.speakers.alias(nextLabel, previousLabel);
      },
      capturePcmWindows: false,
      now: this.now,
    });
    await this.#stt.start();
    if (typeof this.dependencies.publisher.markLive === "function") await this.dependencies.publisher.markLive(this.sessionId);
    await Promise.all(this.languages.map((language) => this.#publishLanguageStatus(language, "ready")));
    if (this.speakers.list().length > 0) await this.#publishLegend();
  }

  async acceptAudio(frame, capturedAt = this.now()) {
    this.#assertRunning();
    if (!(frame instanceof Uint8Array) || frame.byteLength !== INPUT_FRAME_BYTES) throw new Error("INVALID_AUDIO_FRAME");
    if (this.now() - capturedAt > AUDIO_CONFIG.staleFrameMilliseconds) return false;
    this.#lastAudioAt = this.now();
    this.#didEndTurn = false;
    if (usesLivePresentation(this.sessionType)) {
      const results = await Promise.all([...this.#liveSessions].map(async ([language, session]) => {
        try {
          await session.sendAudio(frame);
          return null;
        } catch {
          this.#liveSessions.delete(language);
          await session.close().catch(() => undefined);
          await this.#publishLanguageStatus(language, "unavailable", "LANGUAGE_UNAVAILABLE");
          return language;
        }
      }));
      if (results.some(Boolean) && this.#liveSessions.size === 0) throw new Error("LANGUAGE_UNAVAILABLE");
      await Promise.all([...this.#voiceSessions].map(async ([language, session]) => {
        try {
          await session.sendAudio(frame);
        } catch {
          this.#voiceSessions.delete(language);
          await session.close().catch(() => undefined);
          await this.#publishAudioControl(language, "clear", "voice_unavailable");
          await this.#publishLanguageStatus(language, "ready", "VOICE_UNAVAILABLE");
        }
      }));
    } else {
      await this.#stt.sendAudio(frame);
    }
    return true;
  }

  async tick() {
    if (!usesLivePresentation(this.sessionType) || this.#lastAudioAt === null || this.#didEndTurn) return;
    if (this.now() - this.#lastAudioAt <= AUDIO_CONFIG.streamEndAfterMilliseconds) return;
    await Promise.all([...this.#liveSessions.values()].map((session) => session.audioStreamEnd()));
    await Promise.all([...this.#voiceSessions.values()].map((session) => session.audioStreamEnd()));
    this.#didEndTurn = true;
  }

  async endAudioStream() {
    if (!usesLivePresentation(this.sessionType) || this.#didEndTurn) return;
    await Promise.all([...this.#liveSessions.values()].map((session) => session.audioStreamEnd()));
    await Promise.all([...this.#voiceSessions.values()].map((session) => session.audioStreamEnd()));
    this.#didEndTurn = true;
  }

  acceptFinalUtterance(utterance) {
    return this.#processFinalUtterance(utterance);
  }

  /** Participant speaking-floor attribution. STT finals lag the audio they
   *  describe, so a just-released floor keeps attributing for a short grace
   *  window instead of snapping back to diarization labels mid-utterance. */
  setFloorSpeaker(speaker) {
    if (speaker && typeof speaker.displayName === "string" && speaker.displayName.trim()) {
      this.#floorSpeaker = {
        grantId: String(speaker.grantId ?? ""),
        displayName: speaker.displayName.trim().slice(0, 40),
      };
      this.#recentFloor = null;
      return;
    }
    if (this.#floorSpeaker) this.#recentFloor = { speaker: this.#floorSpeaker, releasedAt: this.now() };
    this.#floorSpeaker = null;
  }

  #floorAttribution() {
    if (this.#floorSpeaker) return this.#floorSpeaker;
    if (this.#recentFloor && this.now() - this.#recentFloor.releasedAt <= FLOOR_ATTRIBUTION_GRACE_MILLISECONDS) {
      return this.#recentFloor.speaker;
    }
    return null;
  }

  #floorSpeakerAssignment(floor) {
    const providerLabel = `participant:${floor.grantId}`;
    try {
      const assignment = this.speakers.getOrCreate(providerLabel);
      assignment.label = floor.displayName;
      return assignment;
    } catch {
      // Registry is full (6 slots): still attribute the caption by name.
      return {
        speakerId: `participant-overflow`,
        label: floor.displayName,
        colorToken: "speaker-teal",
        voiceName: null,
        voiceStatus: "disabled",
        lastSeenAt: new Date(this.now()).toISOString(),
      };
    }
  }

  async #processFinalUtterance({ speakerLabel, text, sourceLanguage, sourceStartOffsetMs, sourceEndOffsetMs, sourceEndedAt, pcmWindow = null }) {
    this.#assertRunning();
    const normalizedText = String(text).normalize("NFC").trim();
    if (!normalizedText) return;
    const utteranceKey = createUtteranceKey({ speakerLabel, text: normalizedText, sourceStartOffsetMs, sourceEndOffsetMs, sourceEndedAt });
    if (this.#recentUtteranceKeys.has(utteranceKey)) {
      pcmWindow?.fill(0);
      return;
    }
    this.#recentUtteranceKeys.set(utteranceKey, true);
    if (this.#recentUtteranceKeys.size > 256) this.#recentUtteranceKeys.delete(this.#recentUtteranceKeys.keys().next().value);
    const speakerCount = this.speakers.list().length;
    const floor = this.#floorAttribution();
    const speaker = floor
      ? this.#floorSpeakerAssignment(floor)
      : this.speakers.getOrCreate(String(speakerLabel));
    pcmWindow?.fill(0);
    const legendPromise = this.speakers.list().length !== speakerCount
      ? this.#publishLegend()
      : Promise.resolve();
    const tasks = [...this.#translationQueues].map(async ([language, queue]) => {
      const recovery = this.#languageRecovery.get(language);
      if (recovery && recovery.cooldownUntil > this.now()) return null;
      try {
          const { ttsCompletion } = await queue.enqueue(async (signal) => {
            await legendPromise;
            if (signal.aborted) throw new Error("QUEUE_TASK_TIMEOUT");
            this.#assertRunning();
          const translatedText = await this.dependencies.textTranslate.translate({
            text: normalizedText,
            language,
            sourceLanguage,
            glossaryPack: this.glossaryPack,
          });
          if (signal.aborted) throw new Error("QUEUE_TASK_TIMEOUT");
          this.#assertRunning();
          const caption = {
            type: "caption",
            seq: ++this.#seq,
            sessionId: this.sessionId,
            language,
            speaker,
            text: translatedText,
            isFinal: true,
            sourceEndedAt,
            emittedAt: new Date(this.now()).toISOString(),
          };
          if (hasCaptionOutput(this.outputMode)) {
            await this.dependencies.publisher.publish(this.sessionId, language, caption);
          }
          if (!hasAudioOutput(this.outputMode)) return { ttsCompletion: null };
          const ttsQueue = this.#ttsQueues.get(language);
          if (!ttsQueue) throw new Error("TTS_QUEUE_UNAVAILABLE");
          const submission = await ttsQueue.submit(() => this.#synthesize(language, speaker, translatedText));
          return { ttsCompletion: submission.completion };
        });
        if (ttsCompletion) await ttsCompletion;
        await this.#markLanguageRecovered(language);
        return null;
      } catch (error) {
        const code = error instanceof Error ? error.message : "LANGUAGE_UNAVAILABLE";
        if (code !== "LIVE_PIPELINE_STOPPED") {
          await this.#recordLanguageFailure(language, code);
        }
        return error;
      }
    });
    await Promise.all(tasks);
  }

  async #setLanguageBackpressure(language, isBackpressured) {
    if (this.#isStopped) return;
    const recovery = this.#languageRecovery.get(language);
    if (!recovery || recovery.cooldownUntil > this.now()) return;
    if (!isBackpressured && recovery.consecutiveFailures > 0) return;
    recovery.status = isBackpressured ? "preparing" : "ready";
    await this.#publishLanguageStatus(language, recovery.status, isBackpressured ? "QUEUE_BACKPRESSURE" : undefined);
  }

  async #publishLanguageStatus(language, status, code) {
    const event = { type: "language-status", sessionId: this.sessionId, language, status, ...(code ? { code } : {}) };
    this.onHostEvent?.(event);
    await this.dependencies.publisher.publish(this.sessionId, language, event);
  }

  async #publishLegend() {
    const legend = { type: "speaker-legend", sessionId: this.sessionId, speakers: this.speakers.list() };
    await Promise.all(this.languages.map((language) => this.dependencies.publisher.publish(this.sessionId, language, legend)));
    this.onHostEvent?.(legend);
  }

  async #recordLanguageFailure(language, code) {
    const recovery = this.#languageRecovery.get(language);
    if (!recovery) return;
    recovery.consecutiveFailures += 1;
    const statusCode = normalizeLanguageErrorCode(code);
    await this.#publishAudioControl(language, "restart", "queue_restart");
    if (recovery.consecutiveFailures >= LANGUAGE_FAILURE_LIMIT) {
      recovery.consecutiveFailures = 0;
      recovery.cooldownUntil = this.now() + LANGUAGE_COOLDOWN_MILLISECONDS;
      recovery.status = "unavailable";
      await this.#publishLanguageStatus(language, "unavailable", "LANGUAGE_COOLDOWN");
      return;
    }
    recovery.status = "preparing";
    await this.#publishLanguageStatus(language, "preparing", statusCode);
  }

  async #markLanguageRecovered(language) {
    const recovery = this.#languageRecovery.get(language);
    if (!recovery) return;
    const shouldPublish = recovery.status !== "ready";
    recovery.consecutiveFailures = 0;
    recovery.cooldownUntil = 0;
    recovery.status = "ready";
    if (shouldPublish) await this.#publishLanguageStatus(language, "ready");
  }

  async #publishAudioControl(language, action, reason) {
    const event = {
      type: "audio-control",
      seq: ++this.#seq,
      sessionId: this.sessionId,
      language,
      action,
      reason,
    };
    this.onHostEvent?.(event);
    await this.dependencies.publisher.publish(this.sessionId, language, event);
  }

  async #synthesize(language, speaker, text) {
    const abortController = new AbortController();
    this.#ttsAbortControllers.add(abortController);
    let inactivityTimer = null;
    let synthesisTimer = null;
    const armInactivityTimer = () => {
      if (inactivityTimer !== null) this.clearTimeoutFn(inactivityTimer);
      inactivityTimer = this.setTimeoutFn(() => {
        abortController.abort(new Error("TTS_STREAM_STALLED"));
      }, TTS_INACTIVITY_MILLISECONDS);
    };
    try {
      const stream = this.dependencies.textToSpeech.synthesizeStream({
        language,
        voiceName: speaker.voiceName,
        text,
        sampleRate: AUDIO_CONFIG.outputSampleRate,
        signal: abortController.signal,
      });
      if (!stream || typeof stream[Symbol.asyncIterator] !== "function") throw new Error("TTS_STREAMING_UNAVAILABLE");
      synthesisTimer = this.setTimeoutFn(() => {
        abortController.abort(new Error("TTS_SYNTHESIS_LIMIT_EXCEEDED"));
      }, TTS_MAX_SYNTHESIS_MILLISECONDS);
      const iterator = stream[Symbol.asyncIterator]();
      let pending = new Uint8Array();
      while (true) {
        armInactivityTimer();
        const result = await iterator.next();
        if (inactivityTimer !== null) {
          this.clearTimeoutFn(inactivityTimer);
          inactivityTimer = null;
        }
        if (result.done) break;
        const providerChunk = result.value;
        if (abortController.signal.aborted) throw abortController.signal.reason;
        const bytes = providerChunk instanceof Uint8Array ? providerChunk : new Uint8Array(providerChunk);
        if (bytes.byteLength === 0) continue;
        const combined = new Uint8Array(pending.byteLength + bytes.byteLength);
        combined.set(pending);
        combined.set(bytes, pending.byteLength);
        let offset = 0;
        while (combined.byteLength - offset >= OUTPUT_CHUNK_BYTES) {
          this.#assertRunning();
          await this.#publishAudioChunk(language, speaker, combined.slice(offset, offset + OUTPUT_CHUNK_BYTES));
          offset += OUTPUT_CHUNK_BYTES;
        }
        pending = combined.slice(offset);
      }
      if (pending.byteLength % 2 !== 0) throw new Error("INVALID_PCM16_STREAM");
      if (pending.byteLength > 0) {
        this.#assertRunning();
        await this.#publishAudioChunk(language, speaker, pending);
      }
    } finally {
      if (inactivityTimer !== null) this.clearTimeoutFn(inactivityTimer);
      if (synthesisTimer !== null) this.clearTimeoutFn(synthesisTimer);
      this.#ttsAbortControllers.delete(abortController);
    }
  }

  async #publishAudioChunk(language, speaker, chunk) {
    await this.dependencies.publisher.publishAudio(this.sessionId, language, {
        type: "audio-chunk",
        seq: ++this.#seq,
        sessionId: this.sessionId,
        language,
        speaker,
        sampleRate: AUDIO_CONFIG.outputSampleRate,
    }, chunk);
  }

  async #publishPresentationCaption(language, value) {
    if (!hasCaptionOutput(this.outputMode)) return;
    const text = String(value.text ?? "").normalize("NFC").trim();
    if (!text) return;
    const isFinal = Boolean(value.isFinal);
    const previous = this.#presentationCaptionState.get(language);
    if (previous?.text === text && previous.isFinal === isFinal) return;
    this.#presentationCaptionState.set(language, { text, isFinal });
    await this.dependencies.publisher.publish(this.sessionId, language, {
      type: "caption",
      seq: ++this.#seq,
      sessionId: this.sessionId,
      language,
      speaker: null,
      text,
      isFinal,
      sourceEndedAt: value.sourceEndedAt ?? new Date(this.now()).toISOString(),
      emittedAt: new Date(this.now()).toISOString(),
    });
  }

  async #publishPresentationAudio(language, value) {
    if (!hasAudioOutput(this.outputMode)) return;
    const pcm = value?.pcm;
    if (!(pcm instanceof Uint8Array)
      || pcm.byteLength === 0
      || pcm.byteLength % 2 !== 0
      || value.sampleRate !== AUDIO_CONFIG.outputSampleRate) {
      throw new Error("INVALID_GEMINI_AUDIO");
    }
    await this.dependencies.publisher.publishAudio(this.sessionId, language, {
      type: "audio-chunk",
      seq: ++this.#seq,
      sessionId: this.sessionId,
      language,
      speaker: null,
      sampleRate: AUDIO_CONFIG.outputSampleRate,
    }, pcm);
  }

  async close() {
    this.#isStopped = true;
    for (const abortController of this.#ttsAbortControllers) {
      abortController.abort(new Error("LIVE_PIPELINE_STOPPED"));
    }
    await Promise.all([
      ...[...this.#liveSessions.values()].map((session) => session.close()),
      ...[...this.#voiceSessions.values()].map((session) => session.close()),
      this.#stt?.close(),
      ...[...this.#translationQueues.values()].map((queue) => queue.drain()),
      ...[...this.#ttsQueues.values()].map((queue) => queue.drain()),
    ]);
  }

  #assertRunning() {
    if (this.#isStopped) throw new Error("LIVE_PIPELINE_STOPPED");
  }
}

function hasCaptionOutput(outputMode) {
  return outputMode === "captions" || outputMode === "captions_audio";
}

function hasAudioOutput(outputMode) {
  return outputMode === "captions_audio" || outputMode === "audio";
}

function usesLivePresentation(sessionType) {
  return sessionType === "presentation";
}

function normalizeLanguageErrorCode(code) {
  if (["QUEUE_BACKPRESSURE", "QUEUE_BACKPRESSURE_EXCEEDED", "TTS_RESPONSE_BUFFER_EXCEEDED", "TTS_STREAM_STALLED", "TTS_SYNTHESIS_LIMIT_EXCEEDED"].includes(code)) return code;
  return "LANGUAGE_UNAVAILABLE";
}

function createUtteranceKey({ speakerLabel, text, sourceStartOffsetMs, sourceEndOffsetMs, sourceEndedAt }) {
  const sourceIdentity = Number.isFinite(sourceStartOffsetMs) && Number.isFinite(sourceEndOffsetMs)
    ? `${sourceStartOffsetMs}:${sourceEndOffsetMs}`
    : String(sourceEndedAt ?? "");
  return `${String(speakerLabel)}\u0000${sourceIdentity}\u0000${text}`;
}
