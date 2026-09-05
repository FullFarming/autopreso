import { createSentenceLanguageRouting } from "./sentence-language-routing.js";
import { createHash, randomUUID } from "node:crypto";

import { AUDIO_CONFIG, normalizeLiveLanguage, textPlausiblyInLanguage, validateLiveSettings } from "./config.js";
import { OrderedTaskQueue } from "./ordered-task-queue.js";
import { RollingSpeechSession } from "./rolling-speech-session.js";
import { safeProviderErrorIdentifier } from "./caption-polish.js";
import { detectSourceLanguage, isOutputInTargetLanguage, sourceLaneMatches } from "./language-gate.js";
import { SpeakerCaptureLedger } from "./speaker-capture-ledger.js";
import { SpeakerRegistry } from "./speaker-registry.js";
import {
  createCrossChannelEchoDeduper,
  createCommittedCaptionFinalizer,
  createSourceLanguageConsensus,
  crossChannelEchoContract,
  isCombinedEngine,
} from "../../packages/caption-core/index.js";
export { evaluateCaptionPolish } from "../../packages/caption-core/index.js";
import {
  hasKoreanGrammarEvidence,
  hasUnsupportedEnglishKoreanText,
  resolveSourceLanguageObservation,
  canPassThroughSourceObservation,
  isFixedTargetOutputSupported,
} from "../../packages/caption-core/language-gate.js";

const INPUT_FRAME_BYTES = AUDIO_CONFIG.inputSampleRate * 2 * AUDIO_CONFIG.chunkMilliseconds / 1_000;
const LANGUAGE_FAILURE_LIMIT = 3;
const LANGUAGE_COOLDOWN_MILLISECONDS = 30_000;
/** Must exceed the real provider commit lag or the fallback fence expires
 *  before a caption can arrive. Capture-time floor metadata is authoritative;
 *  this grace period covers only callbacks where the provider omitted it. */
const FLOOR_ATTRIBUTION_GRACE_MILLISECONDS = 6_000;
/** Identical caption text arriving within this window is the provider
 *  re-emitting a line, not the speaker saying it again. */
const REEMISSION_WINDOW_MILLISECONDS = 1_000;
/** A persistently broken lane logs once per interval, not once per caption. */
const EMISSION_FAILURE_LOG_INTERVAL_MS = 30_000;
// Fixed internal constants (never provider or user data), so they are safe to
// print. They distinguish a durable-persistence stall — which latches the lane
// closed until reconciliation — from an ordinary provider callback fault.
const INTERNAL_EMISSION_FAILURE_CODES = Object.freeze([
  "DURABLE_CAPTION_PERSIST_FAILED",
  "DURABLE_CAPTION_LANE_FAILED",
  "AUTHORITATIVE_SOURCE_PERSIST_FAILED",
  "AUTHORITATIVE_SOURCE_LANE_FAILED",
  "SESSION_STOPPED",
]);
// Keep Live Call's visible revision cadence aligned with captions-only. Gemini
// often revises the same tail several times in a few hundred milliseconds;
// forwarding every snapshot makes the caption look as if it is being rewritten.
const PARTIAL_STABILITY_MILLISECONDS = 140;
const PARTIAL_MAX_HOLD_MILLISECONDS = 500;
const PARTIAL_MIN_SIGNAL_CHARACTERS = 12;
/** Gemini's captions-only-compatible reconnect backs off for as much as 5s.
 * Frame freshness still uses the 750ms capture guard, but an already accepted
 * ordered write gets a separate, bounded recovery window. Conflating those two
 * deadlines permanently removed every caption lane during an ordinary goAway. */
const CAPTION_POLISH_POLICIES = new Set(["off", "selective", "full"]);
const AUDIO_SOURCES = new Set(["system", "mic", "participant"]);
const MAX_SUPPRESSED_SOURCE_TEXTS = 256;
const ENGLISH_LETTER = /[A-Za-z]/u;
const KOREAN_LETTER = /[가-힣ㄱ-ㅎㅏ-ㅣ]/u;
const LANGUAGE_DRIFT_RECONNECT_THRESHOLD = 2;
/** `sttProvider` spelling for the authoritative source ledger, keyed by the
 *  engine catalog's stt provider. `supabase-adapters.js` accepts exactly these. */
const STT_PROVIDER_LABELS = Object.freeze({ gemini: "gemini-transcribe-live", soniox: "soniox" });

function isEnglishKoreanPair(languages) {
  return languages.length === 2 && languages.includes("en") && languages.includes("ko");
}

function hasClearKoreanEvidence(value) {
  const text = String(value ?? "").normalize("NFC");
  const hangulCount = (text.match(/[가-힣]/gu) ?? []).length;
  return hasKoreanGrammarEvidence(text)
    || (hangulCount >= 4 && !ENGLISH_LETTER.test(text));
}

function resolveSessionInputLanguage(languageCode, text, languages, { strictEnglishKorean = false } = {}) {
  const providerLanguage = normalizeLiveLanguage(languageCode);
  if (!isEnglishKoreanPair(languages)) return providerLanguage;
  // 2026-07-27 fix: EN/KO-only calls are a closed binary contract. Provider
  // metadata and the prior-turn consensus may lag a clear script transition.
  // In-pair single-script evidence wins; outside Latin metadata cannot be
  // relabelled as English, while strong Hangul can recover a stale provider
  // hint. Mixed text keeps the configured sentence lock.
  if (strictEnglishKorean && hasUnsupportedEnglishKoreanText(text)) return providerLanguage;
  const normalizedText = String(text ?? "").normalize("NFC");
  const hasEnglish = ENGLISH_LETTER.test(normalizedText);
  const hasKorean = KOREAN_LETTER.test(normalizedText);
  if (strictEnglishKorean && providerLanguage && !languages.includes(providerLanguage)) {
    return hasClearKoreanEvidence(normalizedText) ? "ko" : providerLanguage;
  }
  if (hasEnglish && !hasKorean) return "en";
  if (hasKorean && !hasEnglish) return "ko";
  if (providerLanguage && languages.includes(providerLanguage)) return providerLanguage;
  if (!providerLanguage && hasKoreanGrammarEvidence(normalizedText)) return "ko";
  const detected = detectSourceLanguage(text, { minimumSignalChars: 1 });
  if (detected === "en" || detected === "ko") return detected;
  if (!providerLanguage) return providerLanguage;
  if (hasKorean) return "ko";
  if (hasEnglish) return "en";
  return providerLanguage;
}

function isMalformedExplicitLanguageCode(languageCode) {
  if (languageCode === undefined || languageCode === null || String(languageCode).trim() === "") return false;
  if (String(languageCode).trim().toLowerCase() === "und") return false;
  return !normalizeLiveLanguage(languageCode);
}

function isEnglishKoreanInputRejected(languageCode, text, resolvedLanguage, languages, { strictEnglishKorean = false } = {}) {
  if (!strictEnglishKorean || !isEnglishKoreanPair(languages)) return false;
  if (hasUnsupportedEnglishKoreanText(text)) return true;
  const canonicalLanguage = normalizeLiveLanguage(languageCode);
  const hasClearKoreanOverride = resolvedLanguage === "ko"
    && hasClearKoreanEvidence(text);
  return Boolean((canonicalLanguage && !languages.includes(canonicalLanguage) && !hasClearKoreanOverride)
    || (resolvedLanguage && !languages.includes(resolvedLanguage)));
}

function isSessionOutputInTargetLanguage(text, targetLanguage, languages) {
  if (!isEnglishKoreanPair(languages)) return isOutputInTargetLanguage(text, targetLanguage);
  const normalizedText = String(text ?? "").normalize("NFC");
  if (hasUnsupportedEnglishKoreanText(normalizedText)) return false;
  return isOutputInTargetLanguage(normalizedText, targetLanguage);
}

export class LiveMediaPipeline {
  #suppressedSourceTexts = new Map();
  #translationQueues = new Map();

  /** Last two committed source finals, oldest first. Passed to the translator
   *  as previous_utterances so pronoun-dropping sources (Korean, Japanese)
   *  keep their antecedents; the current utterance is never its own context. */
  #recentSourceFinals = [];
  #stt = null;
  #sourceRecordingFailed = false;
  #sourceGapTasks = new Set();
  #sourceGapIds = new Set();
  #hostAudioSource = null;
  /** Finalized caption sequence per language: (sessionId, language) monotonic, starts at 1. */
  #captionSeq = new Map();
  #isStopped = false;
  #isDraining = false;
  #isPaused = false;
  #languageRecovery = new Map();
  #recentUtteranceKeys = new Map();
  #finalUtteranceTasks = new Map();
  #lifecycleAbort = new AbortController();
  #translationAbort = new AbortController();
  #sourceDraftGeneration = randomUUID();
  #sourceStreamGeneration = randomUUID();
  #sourceDraftRevision = 0;
  #sourceDraftPending = null;
  #sourceDraftWork = null;
  #pauseTask = Promise.resolve();
  #resumeTask = null;
  #speechRevision = 0;
  #startTask = null;
  #presentationCaptionState = new Map();
  /** Final side effects stay ordered per language while provider partials are
   *  allowed to keep flowing during the slower polish/persist path. */
  #presentationFinalTails = new Map();
  #meetingInputCaption = null;
  #requiresFreshMeetingSourceContext = false;
  #meetingInputCaptionCounter = 0;
  #meetingInputFinalQueues = new Map();
  /** Per-lane throttle for caption-emission failure logs. */
  #emissionFailureLoggedAt = new Map();
  #floorSpeaker = null;
  #sentenceLanguage = createSentenceLanguageRouting();
  #speakerCapture = new SpeakerCaptureLedger();
  #audioAcceptanceTail = Promise.resolve();
  #speakerRoster = null;
  #speakerRosterKnown = false;
  #lastCapturedSpeakerKey = null;
  #pendingSpeakerRoster = null;
  #speakerRosterPoll = null;
  #speakerRosterLastPoll = -Infinity;
  #speakerRosterAcknowledged = -1;
  #recentFloor = null;
  /** Meeting-mode interim caption lanes: per-language latest-wins throttle. */
  #partialLanes = new Map();
  /** Gemini caption lanes: per-language debounce with a bounded first paint. */
  #presentationPartialLanes = new Map();
  #didReportFatalError = false;
  #authoritativeSourceLaneFailed = false;
  #authoritativeSourceTail = Promise.resolve();
  #languageDriftCounts = new Map();

  constructor({
    sessionId,
    sessionType,
    outputMode,
    maxViewers,
    glossaryPack,
    glossaryText,
    glossaryPresetId,
    glossaryPresetName,
    compiledGlossary = undefined,
    captionConfig,
    captionConfigFingerprint,
    translationTone,
    domainText,
    geminiModel,
    geminiPolishModel,
    mode,
    voiceOutputMode,
    languages,
    dependencies,
    now = Date.now,
    speakerRegistry = null,
    initialSequence = 0,
    initialSequences = null,
    onHostEvent = null,
    onFatalError = null,
    getSubscriberCount = null,
    observeLatency = null,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    captionPolishPolicy = "selective",
  }) {
    const settings = validateLiveSettings({
      sessionType,
      outputMode,
      maxViewers,
      glossaryPack,
      glossaryText,
      translationTone,
      domainText,
      mode,
      voiceOutputMode,
      languages,
      captionConfig,
      captionConfigFingerprint,
      geminiModel,
      geminiPolishModel,
      captionPolishPolicy,
    });
    this.sessionId = sessionId;
    this.sessionType = settings.sessionType;
    this.outputMode = settings.outputMode;
    this.captionConfig = settings.captionConfig;
    this.captionConfigFingerprint = settings.captionConfigFingerprint;
    this.maxViewers = settings.maxViewers;
    this.glossaryText = this.captionConfig.glossary;
    this.translationTone = this.captionConfig.tone;
    this.domainText = this.captionConfig.domain;
    // The engine selection is the only source of provider/model identity: it
    // decides whether translation is a separate text call or arrives attached
    // to each STT final, and it is what the source ledger records as provenance.
    this.engine = this.captionConfig.engine;
    this.isCombined = isCombinedEngine(this.engine);
    this.transcriptionModel = this.engine.stt.model;
    this.sttProvider = STT_PROVIDER_LABELS[this.engine.stt.provider];
    if (!this.sttProvider) throw new Error("ENGINE_SELECTION_INVALID");
    this.translationModel = this.engine.translation.model;
    this.languages = this.captionConfig.languages;
    this.dependencies = dependencies;
    if (!this.isCombined && typeof dependencies?.textTranslate?.translate !== "function") {
      throw new Error("TEXT_TRANSLATE_REQUIRED");
    }
    this.captionFinalizer = createCommittedCaptionFinalizer({
      sessionId: this.sessionId,
      compiledGlossary,
      config: this.captionConfig,
      polish: dependencies.captionPolish?.polish
        ? (request) => dependencies.captionPolish.polish(request)
        : null,
    });
    // Partials and source-side pre-translation repair reuse the exact index
    // owned by the shared committed finalizer.
    this.termRetriever = this.captionFinalizer.termRetriever;
    this.now = now;
    if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) throw new Error("INVALID_INITIAL_SEQUENCE");
    for (const language of this.languages) {
      const seed = initialSequences?.[language] ?? initialSequence;
      if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("INVALID_INITIAL_SEQUENCE");
      this.#captionSeq.set(language, Math.max(seed, initialSequence));
    }
    this.onHostEvent = onHostEvent;
    this.onFatalError = onFatalError;
    this.getSubscriberCount = getSubscriberCount;
    this.observeLatency = observeLatency;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    if (!CAPTION_POLISH_POLICIES.has(this.captionConfig.polishPolicy.mode)) throw new Error("INVALID_CAPTION_POLISH_POLICY");
    this.captionPolishPolicy = this.captionConfig.polishPolicy.mode;
    this.sourceLanguageConsensus = createSourceLanguageConsensus({ now });
    this.crossChannelEchoDedupers = new Map(this.languages.map((language) => [language, createCrossChannelEchoDeduper({ now })]));
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
      this.#languageRecovery.set(language, { consecutiveFailures: 0, cooldownUntil: 0, status: "ready" });
    }
  }

  get lastSequence() {
    return Math.max(0, ...Object.values(this.lastSequences));
  }

  /** Per-language last finalized caption seq, e.g. { ko: 12, en: 11 }. */
  get lastSequences() {
    return Object.fromEntries(this.#captionSeq);
  }

  get isPaused() {
    return this.#isPaused;
  }

  // There is deliberately NO text-caption ingress. The host's audio arrives as
  // PCM like any participant's and this pipeline translates it itself for the
  // web record; accepting the desktop's already-translated text as well wrote
  // the same utterance twice.

  #hasEnglishKoreanFirewall() {
    return this.sessionType === "meeting" && isEnglishKoreanPair(this.languages);
  }

  #recordLanguageDrift(channel) {
    if (!this.#hasEnglishKoreanFirewall() || this.#didReportFatalError) return;
    const count = (this.#languageDriftCounts.get(channel) ?? 0) + 1;
    this.#languageDriftCounts.set(channel, count);
    if (count < LANGUAGE_DRIFT_RECONNECT_THRESHOLD) return;
    this.#didReportFatalError = true;
    try {
      this.onFatalError?.(new Error("TRANSLATION_LANGUAGE_DRIFT"));
    } catch {
      // The current callback remains fail-closed even if the out-of-band
      // recovery notifier itself fails.
    }
  }

  #clearLanguageDrift(channel) {
    this.#languageDriftCounts.delete(channel);
  }

  /** Pause keeps record identity but releases the paid speech connection. */
  pause() {
    this.#assertRunning();
    this.#isPaused = true;
    this.#speechRevision += 1;
    this.#translationAbort.abort();
    this.#sourceDraftPending = null;
    const speech = this.#stt;
    this.#stt = null;
    if (speech) {
      this.#pauseTask = speech.close();
      this.#pauseTask.catch(() => undefined);
    }
    this.#cancelAllPresentationPartials();
    this.#runTopicSideEffect("pauseTopicSession", this.sessionId);
    return this.#pauseTask;
  }

  resume() {
    this.#assertRunning();
    if (!this.#isPaused) return Promise.resolve();
    if (this.#resumeTask) return this.#resumeTask;
    const revision = this.#speechRevision;
    this.#resumeTask = (async () => {
      await this.#pauseTask;
      this.#assertRunning();
      if (revision !== this.#speechRevision) throw new Error("MEDIA_RESUME_CANCELLED");
      try {
        await this.#openSpeechSession();
        this.#assertRunning();
        if (revision !== this.#speechRevision) throw new Error("MEDIA_RESUME_CANCELLED");
        this.#translationAbort = new AbortController();
        this.#isPaused = false;
        await Promise.all(this.languages.map((language) => this.#publishLanguageStatus(language, "ready")));
        this.#runTopicSideEffect("resumeTopicSession", this.sessionId);
      } catch (error) {
        this.#isPaused = true;
        this.#translationAbort.abort();
        const speech = this.#stt;
        this.#stt = null;
        await speech?.close();
        throw error;
      }
    })().finally(() => { this.#resumeTask = null; });
    return this.#resumeTask;
  }

  /** Advances the FINALIZED caption counter. Contract C1: only committed
   *  captions consume this space, because only committed captions persist —
   *  `fetchLastUtteranceSeqs` reads the finals max and that value reseeds a
   *  fresh pipeline. Letting interim captions advance it made the reseed
   *  regress below what viewers had already seen, and the viewer's
   *  `seq <= lastSeq` guard then dropped every later caption for the rest of
   *  the session. */
  #nextCaptionSeq(language) {
    const next = (this.#captionSeq.get(language) ?? 0) + 1;
    this.#captionSeq.set(language, next);
    return next;
  }

  /** The seq the next committed caption will take, WITHOUT consuming it.
   *  Interim captions carry this so a partial is identifiable as "the line
   *  that is about to become final N" while leaving the durable counter
   *  untouched. The viewer ignores interim seq for its resume guard. */
  #peekCaptionSeq(language) {
    return (this.#captionSeq.get(language) ?? 0) + 1;
  }

  start() {
    if (this.#startTask) return this.#startTask;
    this.#startTask = this.#start();
    return this.#startTask;
  }

  async #start() {
    this.#assertRunning();
    await this.#refreshSpeakerRoster();
    await this.#openSpeechSession();
    this.#assertRunning();
    if (typeof this.dependencies.publisher.markLive === "function") await this.dependencies.publisher.markLive(this.sessionId);
    await Promise.all(this.languages.map((language) => this.#publishLanguageStatus(language, "ready")));
    if (this.speakers.list().length > 0) await this.#publishLegend();
    this.#runTopicSideEffect("startTopicSession", this.sessionId, this.languages);
  }

  async #openSpeechSession() {
    this.#sourceStreamGeneration = randomUUID();
    this.#sentenceLanguage.reset();
    this.#speakerCapture = new SpeakerCaptureLedger();
    this.#lastCapturedSpeakerKey = null;
    // One microphone feeds the engine and one authoritative source ledger.
    // Gemini translates finalized text; Soniox native target streams attach
    // aligned translations to the primary source final.
    this.#stt = new RollingSpeechSession({
      provider: {
        open: (options) => this.dependencies.speechToText.open({
          ...options,
          // Live Call has exactly one host input device. Speaker diarization is
          // unnecessary and makes rollover attribution harder to keep stable.
          diarization: false,
          // A provider that had to drop committed source text (terminal stream
          // failure mid-segment) leaves a hole in the original record; say so
          // once instead of letting the ledger look complete.
          onContinuityDiscard: (event) => this.#reportSourceRecordingFailure(event ?? {}),
        }),
      },
      onConnectionState: (state) => this.onHostEvent?.({
        type: "engine-status", sessionId: this.sessionId,
        role: state.language ? "translation" : "stt",
        provider: this.engine.stt.provider, model: this.engine.stt.model,
        ...state,
      }),
      onFinalUtterance: (utterance) => this.acceptFinalUtterance(utterance),
      onPartialTranscript: (partial) => this.acceptPartialTranscript(partial),
      onPartialTranslation: (partial) => this.acceptPartialTranslation(partial),
      onRemap: (mapping) => {
        for (const [nextLabel, previousLabel] of mapping) this.speakers.alias(nextLabel, previousLabel);
      },
      capturePcmWindows: false,
      now: this.now,
    });
    await this.#stt.start({ signal: this.#lifecycleAbort.signal });
  }

  #reportSourceRecordingFailure(failure = {}) {
    this.#recordKnownSourceGap(failure);
    if (this.#sourceRecordingFailed || this.#isStopped) return;
    this.#sourceRecordingFailed = true;
    this.observeLatency?.("source_recording_failures_total", 1);
    const event = { type: "source-status", sessionId: this.sessionId,
      status: "unavailable", code: "SOURCE_RECORDING_UNAVAILABLE" };
    this.onHostEvent?.(event);
    void Promise.resolve(this.dependencies.publisher.publishSourceStatus?.(event)).catch(() => {});
  }

  #recordKnownSourceGap(failure) {
    if (!failure || typeof failure.segmentId !== "string" || !Number.isFinite(Date.parse(failure.sourceStartedAt))
      || !Number.isFinite(Date.parse(failure.sourceEndedAt))) return;
    if (this.#sourceGapIds.has(failure.segmentId)) return;
    if (this.#sourceGapIds.size >= 2048 || this.#sourceGapTasks.size >= 8
      || typeof this.dependencies.publisher.persistSourceRecordingGap !== "function") {
      this.#reportSourceGapWriteFailure(); return;
    }
    this.#sourceGapIds.add(failure.segmentId);
    const task = Promise.resolve().then(() => this.dependencies.publisher.persistSourceRecordingGap({
      sessionId: this.sessionId, segmentId: failure.segmentId,
      sourceStartedAt: failure.sourceStartedAt, sourceEndedAt: failure.sourceEndedAt,
    })).catch(() => this.#reportSourceGapWriteFailure())
      .finally(() => this.#sourceGapTasks.delete(task));
    this.#sourceGapTasks.add(task);
  }

  #reportSourceGapWriteFailure() {
    this.observeLatency?.("source_gap_persist_failures_total", 1);
    console.warn("SOURCE_GAP_PERSIST_FAILED");
  }

  #reservePresentationFinal(language) {
    const previous = this.#presentationFinalTails.get(language) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise((resolve) => { release = () => resolve(); });
    this.#presentationFinalTails.set(language, previous.then(() => current));
    return { previous, release };
  }

  acceptAudio(frame, capturedAt = this.now(), capturedFloorSpeaker = undefined, inputSource = null) {
    const floor = structuredClone(capturedFloorSpeaker === undefined ? this.#floorSpeaker : capturedFloorSpeaker);
    // Host and participant WebSocket queues are independent. Their accepted
    // PCM must share one order with profile epochs and provider rotations.
    const work = this.#audioAcceptanceTail.then(() => this.#acceptCapturedAudio(frame, capturedAt, floor, inputSource));
    this.#audioAcceptanceTail = work.catch(() => undefined);
    return work;
  }

  async #acceptCapturedAudio(frame, capturedAt, capturedFloorSpeaker, inputSource) {
    this.#assertRunning();
    if (!(frame instanceof Uint8Array) || frame.byteLength !== INPUT_FRAME_BYTES) throw new Error("INVALID_AUDIO_FRAME");
    if (this.#isPaused || this.#isDraining) return false;
    if (this.now() - capturedAt > AUDIO_CONFIG.staleFrameMilliseconds) return false;
    const source = AUDIO_SOURCES.has(inputSource) ? inputSource : "host";
    // The pin guards against a host mixing two CAPTURE devices into one STT
    // stream. Participant floor audio is a different speaker by design — the
    // gateway floor gate already serializes it against host audio — so it
    // must neither trip the pin nor claim it for itself.
    if (source !== "participant") {
      if (this.#hostAudioSource === null) this.#hostAudioSource = source;
      else if (this.#hostAudioSource !== source) throw new Error("MULTIPLE_HOST_AUDIO_SOURCES_FORBIDDEN");
    }
    if (!this.#stt) throw new Error("STT_SESSION_NOT_STARTED");
    if (this.#pendingSpeakerRoster) {
      this.#speakerRoster = this.#pendingSpeakerRoster;
      this.#pendingSpeakerRoster = null;
    }
    const floor = capturedFloorSpeaker === undefined ? this.#floorSpeaker : capturedFloorSpeaker;
    const linked = floor && this.#speakerRoster?.speakers.find((speaker) => speaker.participantId === floor.participantId);
    const onsite = this.#speakerRoster?.speakers.find((speaker) => speaker.id === this.#speakerRoster.activeOnsiteSpeakerId);
    const selected = floor ? linked : onsite;
    const speakerProfile = selected ? Object.fromEntries(Object.entries(selected).filter(([key]) => key !== "participantId")) : null;
    const captureKey = JSON.stringify({ floor, speakerProfile });
    // Gemini does not expose reliable acoustic onset for every callback. A new
    // stream makes the old tail immutable before a different person owns PCM.
    if (this.#speakerRoster && this.engine.stt.provider === "gemini" && this.#lastCapturedSpeakerKey !== null
      && captureKey !== this.#lastCapturedSpeakerKey) await this.#stt.rotateAtSpeakerBoundary();
    if (this.#lastCapturedSpeakerKey !== null && captureKey !== this.#lastCapturedSpeakerKey) this.#sentenceLanguage.reset();
    this.#lastCapturedSpeakerKey = captureKey;
    this.#speakerCapture.capture(AUDIO_CONFIG.chunkMilliseconds, { floor, speakerProfile,
      unresolved: typeof this.dependencies.publisher.fetchSpeakerRoster === "function" && !this.#speakerRosterKnown });
    await this.#stt.sendAudio(frame);
    if (!this.#isStopped && !this.#isDraining && this.#speakerRoster && this.#speakerRosterAcknowledged < this.#speakerRoster.revision) {
      const revision = this.#speakerRoster.revision;
      this.#speakerRosterAcknowledged = revision;
      void this.dependencies.publisher.ackSpeakerRoster?.(this.sessionId, revision).catch(() => {
        this.#speakerRosterAcknowledged = Math.min(this.#speakerRosterAcknowledged, revision - 1);
        this.onHostEvent?.({ type: "speaker-roster-status", sessionId: this.sessionId, status: "unavailable", revision });
      });
    }
    return true;
  }

  async tick() {
    if (this.#isStopped || this.#isDraining || this.now() - this.#speakerRosterLastPoll < 1000) return;
    await this.#refreshSpeakerRoster();
  }

  async #refreshSpeakerRoster() {
    if (typeof this.dependencies.publisher.fetchSpeakerRoster !== "function") return;
    if (this.#speakerRosterPoll) return this.#speakerRosterPoll;
    this.#speakerRosterLastPoll = this.now();
    this.#speakerRosterPoll = Promise.resolve().then(async () => {
      const roster = await this.dependencies.publisher.fetchSpeakerRoster(this.sessionId);
      if (this.#isStopped) return;
      this.#speakerRosterKnown = true;
      if (!roster || roster.revision === 0) return;
      const previous = this.#pendingSpeakerRoster ?? this.#speakerRoster;
      if (!previous || roster.revision > previous.revision) this.#pendingSpeakerRoster = structuredClone(roster);
    }).catch(() => {
      this.onHostEvent?.({ type: "speaker-roster-status", sessionId: this.sessionId, status: "unavailable" });
    }).finally(() => { this.#speakerRosterPoll = null; });
    return this.#speakerRosterPoll;
  }

  async endAudioStream() {
    // Production STT keeps one rolling host stream open. Short browser
    // silence boundaries do not close it; the stream closes only on Stop.
  }

  acceptFinalUtterance(utterance) {
    try {
      this.#assertRunning();
      if (this.#authoritativeSourceLaneFailed) throw new Error("AUTHORITATIVE_SOURCE_LANE_FAILED");
      const sourceGeneration = utterance.sourceGeneration ?? this.#sourceStreamGeneration;
      const key = createUtteranceKey({ ...utterance, sourceGeneration, text: String(utterance.text ?? "").normalize("NFC").trim() });
      const existing = this.#finalUtteranceTasks.get(key);
      if (existing) return existing.finally(() => utterance.pcmWindow?.fill(0));
      if (this.#recentUtteranceKeys.has(key)) { utterance.pcmWindow?.fill(0); return Promise.resolve(); }
      if (this.#finalUtteranceTasks.size >= 64) throw new Error("SOURCE_BACKPRESSURE_EXCEEDED");
      const draftRevision = this.#sourceDraftRevision;
      this.#sentenceLanguage.complete(this.#sourceSentenceKey(utterance));
      const captureAttribution = this.#resolveCapturedSpeaker(utterance);
      utterance = { ...utterance, captureAttribution };
      const task = Promise.resolve().then(() => this.#processFinalUtterance(utterance, draftRevision, sourceGeneration)).then(() => {
        this.#recentUtteranceKeys.set(key, true);
        if (this.#recentUtteranceKeys.size > 256) this.#recentUtteranceKeys.delete(this.#recentUtteranceKeys.keys().next().value);
      }).finally(() => { this.#finalUtteranceTasks.delete(key); utterance.pcmWindow?.fill(0); });
      this.#finalUtteranceTasks.set(key, task);
      return task;
    } catch (error) { utterance.pcmWindow?.fill(0); return Promise.reject(error); }
  }

  /** Streams interim STT transcripts as isFinal:false captions so viewers see
   *  text while someone is still talking (the finals-only meeting pipeline
   *  previously showed nothing until Google finalized an utterance, which can
   *  take 10s+ during continuous speech). Latest-wins per language: while a
   *  translation is in flight, newer interim text replaces the queued one. */
  /** @param {{text?: unknown, sourceLanguage?: unknown, sourceGeneration?: string, segmentId?: string, sourceGenerationStartOffsetMs?: number, sourceGenerationEndOffsetMs?: number, sourceSessionStartOffsetMs?: number, sourceSessionEndOffsetMs?: number}} [value] */
  acceptPartialTranscript({ text, sourceLanguage, ...sourceBounds } = {}) {
    if (this.#isStopped || this.#isPaused || !hasCaptionOutput(this.outputMode)) return;
    const normalizedText = String(text ?? "").normalize("NFC").trim();
    if (!normalizedText) return;
    const decision = this.#sentenceLanguage.observe(normalizedText, sourceLanguage, this.#sourceSentenceKey(sourceBounds));
    if (decision.suppressSource) return;
    const languageObservation = decision.observation;
    const normalizedSourceLanguage = languageObservation.languageCode;
    const attribution = this.#resolveCapturedSpeaker(sourceBounds);
    const floor = attribution ? attribution.floor : this.#floorAttribution(Number.NaN);
    const metadata = this.#profileMetadata(attribution);
    this.#queueSourceDraft({ type: "source-draft", sessionId: this.sessionId,
      generation: this.#sourceDraftGeneration, revision: ++this.#sourceDraftRevision,
      text: normalizedText, sourceLanguage: normalizedSourceLanguage, languageObservation,
      ...metadata,
      speaker: { role: attribution?.unresolved ? "unknown" : floor ? "participant" : "host",
        label: attribution?.unresolved ? "발언자 확인 필요" : attribution?.speakerProfile?.displayName ?? (floor ? "참여자" : "발표자") },
      emittedAt: new Date(this.now()).toISOString() });
    const speaker = { ...this.#interimSpeaker(floor), ...(metadata.speakerName ? { name: metadata.speakerName, label: metadata.speakerName } : {}) };
    for (const language of this.languages) {
      // Cost guard: interim speech is published only on its verbatim source
      // lane. Target-language Gemini calls wait for the committed STT result,
      // avoiding repeated latest-wins translations while the speaker talks.
      if (!canPassThroughSourceObservation(languageObservation, language)) continue;
      const lane = this.#partialLane(language);
      lane.pending = {
        normalizedText,
        normalizedSourceLanguage,
        languageObservation,
        speaker,
        speakerMetadata: { ...this.#liveCaptionSpeakerMetadata(floor), ...metadata },
        epoch: lane.epoch,
      };
      if (!lane.inFlight) {
        lane.inFlight = true;
        void this.#drainPartialLane(language, lane).finally(() => { lane.inFlight = false; });
      }
    }
  }

  /** Streams a combined engine's interim translation (Soniox emits target-
   *  language tokens while the speaker is still talking) as an isFinal:false
   *  caption on that target lane. Contract C1: the interim carries the seq the
   *  coming final will take and never consumes one. The lane's epoch gate makes
   *  the committed final supersede any interim still queued behind it. */
  /** @param {{language?: unknown, text?: unknown, sourceLanguage?: unknown, sourceGeneration?: string, segmentId?: string, sourceGenerationStartOffsetMs?: number, sourceGenerationEndOffsetMs?: number, sourceSessionStartOffsetMs?: number, sourceSessionEndOffsetMs?: number}} [value] */
  acceptPartialTranslation({ language, text, sourceLanguage, ...sourceBounds } = {}) {
    if (this.#isStopped || this.#isPaused || !hasCaptionOutput(this.outputMode)) return;
    const targetLanguage = normalizeLiveLanguage(language);
    if (!targetLanguage || !this.languages.includes(targetLanguage)) return;
    const normalizedText = String(text ?? "").normalize("NFC").trim();
    if (!normalizedText) return;
    const normalizedSourceLanguage = normalizeLiveLanguage(sourceLanguage) || null;
    // Same-language "translation" is the source lane's verbatim interim, which
    // acceptPartialTranscript already publishes; a second copy would flicker.
    if (this.#sentenceLanguage.resolveHint(sourceLanguage) === targetLanguage) return;
    const attribution = this.#resolveCapturedSpeaker(sourceBounds);
    const floor = attribution ? attribution.floor : this.#floorAttribution(Number.NaN);
    const metadata = this.#profileMetadata(attribution);
    const lane = this.#partialLane(targetLanguage);
    lane.pending = {
      kind: "translation",
      normalizedText,
      normalizedSourceLanguage,
      languageObservation: null,
      speaker: this.#interimSpeaker(floor),
      speakerMetadata: { ...this.#liveCaptionSpeakerMetadata(floor), ...metadata },
      epoch: lane.epoch,
    };
    if (!lane.inFlight) {
      lane.inFlight = true;
      void this.#drainPartialLane(targetLanguage, lane).finally(() => { lane.inFlight = false; });
    }
  }

  /** Partials share one synthetic "live" lane (or the floor holder's lane) so
   *  the viewer can replace them in place; finals clear the "live" lane. Must
   *  be a COMPLETE SpeakerAssignment: the viewer contract validates every field
   *  (colorToken/voiceName/voiceStatus/lastSeenAt) and silently drops captions
   *  whose speaker shape is partial. */
  #interimSpeaker(floor) {
    return floor
      ? this.#floorSpeakerAssignment(floor)
      : {
        speakerId: "live",
        label: "",
        name: "",
        colorToken: "speaker-teal",
        voiceName: null,
        voiceStatus: "disabled",
        lastSeenAt: new Date(this.now()).toISOString(),
      };
  }

  #partialLane(language) {
    let lane = this.#partialLanes.get(language);
    if (!lane) {
      lane = { inFlight: false, pending: null, lastText: "", epoch: 0 };
      this.#partialLanes.set(language, lane);
    }
    return lane;
  }

  #supportsFixedTargetOutput(text, language) {
    return isFixedTargetOutputSupported(text, language, {
      protectedTerms: language === "ko"
        ? this.termRetriever.getProtectedTerms({ translatedText: text, targetLanguage: language })
        : [],
    });
  }

  /** Output-language gate for translated interims. It is the same test the
   *  source-partial path applies (fixed-target check on ko, session-language
   *  check elsewhere); finals run the stricter `#supportsFixedTargetOutput`
   *  on every target lane, so an interim can pass here and its final still be
   *  refused. */
  #isTranslatedOutputAcceptable(text, language) {
    return language === "ko"
      ? this.#supportsFixedTargetOutput(text, language)
      : isSessionOutputInTargetLanguage(text, language, this.languages);
  }

  /** One text translation through the engine's translator. `translateWithProvenance`
   *  reports the model that actually produced the text (the fallback chain may
   *  have moved off the primary); a plain `translate` seam is credited to the
   *  engine's configured model. */
  async #translateText(input) {
    const translator = this.dependencies.textTranslate;
    if (typeof translator.translateWithProvenance === "function") {
      const produced = await translator.translateWithProvenance(input);
      const model = typeof produced?.model === "string" && produced.model.trim() ? produced.model : this.translationModel;
      return { text: String(produced?.text ?? ""), model };
    }
    return { text: await translator.translate(input), model: this.translationModel };
  }

  async #drainPartialLane(language, lane) {
    while (lane.pending && !this.#isStopped && !this.#isPaused) {
      const partial = lane.pending;
      lane.pending = null;
      try {
        if (partial.kind === "translation") {
          // Deterministic terminology only: an interim never earns a text-model
          // call. The gate below is the source-partial output gate, not the
          // finals gate (finals additionally require fixed-target output).
          const textOut = this.termRetriever.repair(partial.normalizedText, { language, isFinal: false });
          if (partial.epoch !== lane.epoch) continue;
          if (lane.lastText === textOut) continue;
          if (!this.#isTranslatedOutputAcceptable(textOut, language)) continue;
          lane.lastText = textOut;
          await this.#publishCaption(language, {
            type: "caption",
            seq: this.#peekCaptionSeq(language),
            sessionId: this.sessionId,
            language,
            speaker: partial.speaker,
            ...partial.speakerMetadata,
            text: textOut,
            isFinal: false,
            sourceText: null,
            sourceLanguage: partial.normalizedSourceLanguage,
            translationStatus: "translated",
            translationModel: this.translationModel,
            sourceEndedAt: new Date(this.now()).toISOString(),
            emittedAt: new Date(this.now()).toISOString(),
          }, { mirrorToHost: true });
          continue;
        }
        // Same detection-backed decision as the final path: an interim must not
        // flash raw English on the KO lane just because the STT labelled
        // contaminated English as Korean.
        const repairLanguage = partial.normalizedSourceLanguage
          || detectSourceLanguage(partial.normalizedText, { minimumSignalChars: 1 });
        const repairedSourceText = this.termRetriever.repair(partial.normalizedText, {
          language: repairLanguage,
          isFinal: false,
        });
        const isSourceLane = canPassThroughSourceObservation(partial.languageObservation, language)
          && (language !== "ko" || this.#supportsFixedTargetOutput(repairedSourceText, language));
        // 2026-08-31 fix: 오염된 한국어 초안은 확정 발언의 최초 번역을 기다린다. 초안마다 추가 모델 호출을 만들지 않는다.
        if (!isSourceLane) continue;
        const textOut = repairedSourceText;
        const translationStatus = "verbatim";
        // A final published while this partial was translating supersedes it.
        if (partial.epoch !== lane.epoch) continue;
        if (lane.lastText === textOut) continue;
        // Output-language gate, same as finals: never show an interim that is
        // not in this lane's language.
        if (language !== "ko" && !isSessionOutputInTargetLanguage(textOut, language, this.languages)) continue;
        lane.lastText = textOut;
        const caption = {
          type: "caption",
          seq: this.#peekCaptionSeq(language),
          sessionId: this.sessionId,
          language,
          speaker: partial.speaker,
          ...partial.speakerMetadata,
          text: textOut,
          isFinal: false,
          sourceText: isSourceLane ? null : repairedSourceText,
          sourceLanguage: partial.normalizedSourceLanguage || null,
          languageObservation: partial.languageObservation,
          translationStatus,
          ...(isSourceLane ? { origin: "source" } : {}),
          sourceEndedAt: new Date(this.now()).toISOString(),
          emittedAt: new Date(this.now()).toISOString(),
        };
        await this.#publishCaption(language, caption, { mirrorToHost: true });
      } catch {
        // A failed preview is discarded; only the committed utterance can authorize target translation.
      }
    }
  }

  /** Participant speaking-floor attribution. STT finals lag the audio they
   *  describe, so a just-released floor keeps attributing for a short grace
   *  window instead of snapping back to diarization labels mid-utterance. */
  setFloorSpeaker(speaker) {
    if (speaker && typeof speaker.displayName === "string" && speaker.displayName.trim()) {
      const next = {
        participantId: String(speaker.participantId ?? ""),
        displayName: speaker.displayName.trim().slice(0, 40),
        department: typeof speaker.department === "string" ? speaker.department.trim().slice(0, 80) : "",
        jobTitle: typeof speaker.jobTitle === "string" ? speaker.jobTitle.trim().slice(0, 100) : "",
      };
      if (this.#floorSpeaker?.participantId !== next.participantId) {
        // 2026-07-26 fix: An output partial can beat the new speaker's input
        // transcript callback. Never let it reuse the previous speaker's source
        // identity; wait for one fresh input partial instead. Clearing only the
        // transient memo preserves queued late finals and their attribution.
        this.#meetingInputCaption = null;
        this.#requiresFreshMeetingSourceContext = true;
        this.#presentationCaptionState.clear();
        this.#cancelAllPresentationPartials();
        this.sourceLanguageConsensus.resetForSpeakerBoundary();
        this.#sentenceLanguage.reset();
      }
      // Speaker→speaker preemption keeps a grace record for the previous
      // holder: their lagging STT finals must not attribute to the new one.
      if (this.#floorSpeaker && this.#floorSpeaker.participantId !== next.participantId) {
        this.#recentFloor = { speaker: this.#floorSpeaker, releasedAt: this.now() };
      }
      // A POLITE hand-off (A presses Stop, then B presses Speak) arrives as
      // two calls: release sets #recentFloor to A below, then B's take lands
      // here with #floorSpeaker already null. Clearing #recentFloor here — as
      // this used to — threw away A's record on the single most common
      // transition, so A's lagging committed caption was credited to B and
      // persisted under B's participant_id. Only preemption used to preserve it.
      this.#floorSpeaker = next;
      return;
    }
    if (this.#floorSpeaker) {
      this.#recentFloor = { speaker: this.#floorSpeaker, releasedAt: this.now() };
      this.#meetingInputCaption = null;
      this.#requiresFreshMeetingSourceContext = true;
      this.#presentationCaptionState.clear();
      this.#cancelAllPresentationPartials();
      this.sourceLanguageConsensus.resetForSpeakerBoundary();
      this.#sentenceLanguage.reset();
    }
    this.#floorSpeaker = null;
  }

  /** A caption or audio handler threw somewhere inside the provider's callback
   *  tail. This used to be discarded, which made the worst failure mode in the
   *  product invisible: `#publishPresentationCaption` awaits
   *  `publisher.publish` with no try/catch, and `emitLane` marks the segment
   *  committed BEFORE awaiting the emit — so a failing publisher permanently
   *  drops committed captions with no retry. Count every occurrence and log the
   *  first per lane, then throttle, so a persistently broken lane is loud once
   *  instead of flooding. */
  #recordCaptionEmissionFailure(language, error) {
    this.observeLatency?.("caption_emission_failures_total", 1);
    const lastLoggedAt = this.#emissionFailureLoggedAt.get(language) ?? 0;
    if (this.now() - lastLoggedAt < EMISSION_FAILURE_LOG_INTERVAL_MS) return;
    this.#emissionFailureLoggedAt.set(language, this.now());
    // Our OWN failure constants are safe to name (they are fixed strings in
    // this repo, never provider or user data) and they are the only way to
    // tell a durable-persist stall from a provider callback fault in
    // production. Without this every cause collapsed to the generic fallback,
    // which made a recurring lane blackout undiagnosable from the logs.
    const internalCode = INTERNAL_EMISSION_FAILURE_CODES.find((code) => hasErrorCode(error, new Set([code])));
    const reason = internalCode ?? safeProviderErrorIdentifier(error, "CAPTION_EMISSION_FAILED");
    console.error(`[live] caption emission failed on lane ${language} (${reason}). `
      + "Captions for this lane are being dropped, not retried.");
  }

  /** Resolves which floor holder a caption belongs to, given when its speech
   *  STARTED (epoch ms). Exposed so the attribution fence is directly testable
   *  and so a provider that can stamp speech onset has a seam to feed it —
   *  today the Gemini Transcribe path has no onset and passes NaN, which makes the
   *  fence inert in production (tracked separately). */
  resolveFloorForCapture(sourceStartedAtMs = Number.NaN) {
    return this.#floorAttribution(sourceStartedAtMs);
  }

  #floorAttribution(sourceStartedAtMs = Number.NaN) {
    const recentFloor = this.#recentFloor
      && this.now() - this.#recentFloor.releasedAt <= FLOOR_ATTRIBUTION_GRACE_MILLISECONDS
      ? this.#recentFloor
      : null;
    if (this.#floorSpeaker) {
      // Attribution fence: audio captured before the floor switch belongs to
      // the previous holder even though a new holder already took the floor.
      if (recentFloor && Number.isFinite(sourceStartedAtMs) && sourceStartedAtMs < recentFloor.releasedAt) {
        return recentFloor.speaker;
      }
      return this.#floorSpeaker;
    }
    if (recentFloor) {
      // 2026-07-26 fix: Grace applies only to audio captured before release.
      // New host audio after release must not inherit the former participant.
      if (Number.isFinite(sourceStartedAtMs) && sourceStartedAtMs >= recentFloor.releasedAt) return null;
      return recentFloor.speaker;
    }
    return null;
  }

  #floorSpeakerAssignment(floor) {
    const providerLabel = `participant:${floor.participantId}`;
    let assignment;
    try {
      assignment = this.speakers.getOrCreate(providerLabel);
    } catch {
      // Registry refused the slot: still attribute the caption by name.
      assignment = {
        speakerId: providerLabel,
        colorToken: "speaker-teal",
        voiceName: null,
        voiceStatus: "disabled",
        lastSeenAt: new Date(this.now()).toISOString(),
      };
    }
    assignment.label = floor.displayName;
    assignment.name = floor.displayName;
    // The participant identity IS the speaker id: the webapp labels captions
    // as participants (name · department · title) and the utterance store
    // derives participant_id only when speakerId is "participant:<id>" —
    // the registry's default "speaker-N" id made every participant record
    // as the host.
    assignment.speakerId = providerLabel;
    // Lets caption consumers (e.g. the desktop app) distinguish participant
    // Speak-floor speech from the host's own diarized speech.
    assignment.isParticipant = true;
    if (floor.department) assignment.department = floor.department;
    if (floor.jobTitle) assignment.jobTitle = floor.jobTitle;
    return assignment;
  }

  #sourceSentenceKey(value) {
    return `${value.sourceGeneration ?? this.#sourceStreamGeneration}:${value.segmentId ?? "current"}`;
  }

  #resolveCapturedSpeaker(utterance) {
    if (!this.#speakerRoster && (this.#speakerRosterKnown || typeof this.dependencies.publisher.fetchSpeakerRoster !== "function")) return null;
    return this.#speakerCapture.resolve(utterance);
  }

  #profileMetadata(attribution) {
    if (attribution?.unresolved) return { speakerAttribution: "unresolved", speakerRole: "unknown", speakerName: "발언자 확인 필요" };
    if (!attribution?.speakerProfile) return {};
    return { speakerProfile: attribution.speakerProfile, speakerName: attribution.speakerProfile.displayName,
      speakerDepartment: attribution.speakerProfile.department };
  }

  #liveCaptionSpeakerMetadata(floor) {
    if (this.sessionType !== "meeting") return {};
    return floor
      ? {
        speakerRole: "participant",
        speakerName: floor.displayName,
        speakerDepartment: floor.department ?? "",
        speakerJobTitle: floor.jobTitle ?? "",
      }
      : {
        speakerRole: "host",
        speakerName: "Host",
        speakerDepartment: "",
        speakerJobTitle: "",
      };
  }

  async #processFinalUtterance({ speakerLabel, text, rawText = null, sourceLanguage, sourceStartOffsetMs, sourceEndOffsetMs, sourceEndedAt, pcmWindow = null, translations = null, captureAttribution = null }, draftRevision, sourceGeneration) {
    this.#assertRunning();
    if (this.#authoritativeSourceLaneFailed) throw new Error("AUTHORITATIVE_SOURCE_LANE_FAILED");
    const finalizedAt = this.now();
    // Preserve the provider's committed value byte-for-byte in the admin-only
    // source ledger. The canonical form below is a separate field used by
    // terminology normalization, translation, search, and summaries.
    const rawProviderText = String(rawText ?? text);
    const normalizedText = rawProviderText.normalize("NFC").trim();
    if (!normalizedText) return;
    const utteranceKey = createUtteranceKey({ speakerLabel, text: normalizedText, sourceGeneration, sourceStartOffsetMs, sourceEndOffsetMs, sourceEndedAt });
    // 2026-08-31 fix: pause may flush accepted speech into a final source row.
    // Persist it, then the aborted translation signal prevents new inference.
    const processingSignal = AbortSignal.any([this.#lifecycleAbort.signal, this.#translationAbort.signal]);
    const sourceStartedAt = resolveSourceStartedAt({ sourceStartOffsetMs, sourceEndOffsetMs, sourceEndedAt });
    const speakerCount = this.speakers.list().length;
    const floor = captureAttribution ? captureAttribution.floor : this.#floorAttribution(sourceStartedAt === null ? Number.NaN : Date.parse(sourceStartedAt));
    const speakerProfile = captureAttribution?.speakerProfile;
    const speakerAttribution = captureAttribution?.unresolved ? "unresolved" : null;
    const assignedSpeaker = floor
      ? this.#floorSpeakerAssignment(floor)
      : this.speakers.getOrCreate(String(speakerLabel));
    const speaker = { ...assignedSpeaker };
    if (speakerProfile) {
      speaker.label = speakerProfile.displayName;
      speaker.name = speakerProfile.displayName;
      speaker.department = speakerProfile.department;
    } else if (speakerAttribution) {
      speaker.label = "발언자 확인 필요";
      speaker.name = "발언자 확인 필요";
    }
    const profileMetadata = {
      ...(speakerProfile ? { speakerProfile } : {}),
      ...(speakerAttribution ? { speakerAttribution } : {}),
    };
    const languageObservation = resolveSourceLanguageObservation(normalizedText, sourceLanguage);
    const normalizedSourceLanguage = languageObservation.languageCode;
    // Provider text decides the source language before any canonicalization.
    // Repairing first would let a glossary term bias the lane decision.
    const repairLanguage = normalizedSourceLanguage;
    const repairedSourceText = this.termRetriever.repair(normalizedText, {
      language: repairLanguage,
      isFinal: true,
    });
    const authoritativeSource = await this.#persistAuthoritativeSource({
      utteranceKey,
      rawText: rawProviderText,
      normalizedText: repairedSourceText,
      sourceLanguage: repairLanguage || "und",
      languageObservation,
      speakerLabel: String(speakerLabel),
      ...profileMetadata,
      speaker,
      floor,
      sourceStartedAt,
      sourceEndedAt,
      providerCommittedAt: new Date(finalizedAt).toISOString(),
    });
    if (draftRevision > 0 && draftRevision === this.#sourceDraftRevision) {
      this.#queueSourceDraft({ type: "source-draft-clear", sessionId: this.sessionId,
        generation: this.#sourceDraftGeneration, revision: draftRevision });
    }
    pcmWindow?.fill(0);
    this.#assertRunning();
    if (processingSignal.aborted) return;
    if (authoritativeSource.idempotent === true) {
      let restoredLanguages = [];
      try {
        const replay = await this.dependencies.publisher.replayAuthoritativeSourceCaptions?.(
          this.sessionId, authoritativeSource.sourceUtteranceId, this.languages, { signal: processingSignal },
        );
        if (Array.isArray(replay?.restoredLanguages)) restoredLanguages = replay.restoredLanguages;
      } catch { /* A lost replay response cannot authorize another paid inference. */ }
      this.#assertRunning();
      if (processingSignal.aborted) return;
      await Promise.all(this.languages.map((language) => this.#publishLanguageStatus(language,
        restoredLanguages.includes(language) ? "ready" : "unavailable",
        restoredLanguages.includes(language) ? undefined : "SOURCE_REPLAY_INCOMPLETE")));
      return;
    }
    // Snapshot BEFORE appending: the context for utterance N is N-2 and N-1.
    const recentSourceContext = this.#recentSourceFinals.join("\n");
    this.#recentSourceFinals.push(repairedSourceText);
    if (this.#recentSourceFinals.length > 2) this.#recentSourceFinals.shift();
    const legendPromise = this.speakers.list().length !== speakerCount
      ? this.#publishLegend()
      : Promise.resolve();
    const tasks = [...this.#translationQueues].map(async ([language, queue]) => {
      const recovery = this.#languageRecovery.get(language);
      const cooldownActive = Boolean(recovery && recovery.cooldownUntil > this.now());
      let translationFailureCode = null;
      // Set when a combined engine's final simply lacked this lane. The
      // original is published as `failed` (fail-open, contract ruling 2) and
      // the lane is reported unavailable, but the miss must not count toward
      // the three-strike cooldown: the provider cannot be re-asked, and after
      // three misses `cooldownActive` would short-circuit BEFORE the fail-open
      // publish, leaving the lane silent for 30 s with no seq consumed.
      let isFailOpenMiss = false;
      try {
          const { ttsCompletion } = await queue.enqueue(async (signal) => {
            const requestSignal = AbortSignal.any([signal, processingSignal]);
            await legendPromise;
            if (requestSignal.aborted) return { ttsCompletion: null };
            this.#assertRunning();
          // 2026-08-31 fix: mixed or conflicting source evidence never authorizes
          // verbatim text on a target lane; numeric neutral text needs no model.
          const isSourceLane = canPassThroughSourceObservation(languageObservation, language)
            && (language !== "ko" || this.#supportsFixedTargetOutput(repairedSourceText, language));
          let translatedText = repairedSourceText;
          let translationStatus = isSourceLane ? "verbatim" : "translated";
          let translationModel = this.translationModel;
          if (!isSourceLane && !cooldownActive) {
            try {
              const translationGlossary = this.termRetriever.retrieve({
                sourceText: repairedSourceText,
                targetLanguage: language,
                isFinal: true,
              });
              if (this.isCombined) {
                // The STT provider translated this segment itself; the lane text
                // arrived on the same final. No text-model call is made here.
                const laneText = String(translations?.[language]?.text ?? "").normalize("NFC").trim();
                if (!laneText) throw new Error("COMBINED_TRANSLATION_MISSING");
                translatedText = laneText;
              } else {
                const produced = await this.#translateText({
                  text: repairedSourceText,
                  language,
                  // A misdetected source poisons translation; let the provider
                  // auto-detect when the text does not match the detected script.
                  sourceLanguage: languageObservation.state === "single" ? normalizedSourceLanguage : undefined,
                  signal: requestSignal,
                  glossaryText: translationGlossary,
                  sessionContext: this.domainText,
                  recentSourceText: recentSourceContext,
                  intent: "final",
                });
                translatedText = produced.text;
                translationModel = produced.model;
              }
              const finalized = await this.captionFinalizer.finalize({
                translatedText,
                sourceText: repairedSourceText,
                sourceLanguage: repairLanguage,
                targetLanguage: language,
                // This route has already paid for a text translation.
                // Never issue a second text-model request for the same final;
                // deterministic terminology enforcement still runs below.
                hasPriorTextModelCall: true,
              });
              if (!finalized) throw new Error("TRANSLATION_EMPTY");
              translatedText = finalized.text;
            } catch (error) {
              if (requestSignal.aborted) return { ttsCompletion: null };
              translationFailureCode = safeProviderErrorIdentifier(error,
                this.isCombined ? "COMBINED_TRANSLATION_FAILED" : "GEMINI_TRANSLATE_FAILED");
              await this.#publishLanguageStatus(language, "unavailable", "LANGUAGE_UNAVAILABLE");
              // A combined engine cannot be asked again: there is no separate
              // translator to retry. Keep the record whole by publishing the
              // original on this lane, labelled so no display path renders it
              // as a translation.
              if (!(this.isCombined && hasErrorCode(error, new Set(["COMBINED_TRANSLATION_MISSING"])))) {
                return { ttsCompletion: null };
              }
              isFailOpenMiss = true;
              translatedText = repairedSourceText;
              translationStatus = "failed";
            }
          }
          if (!isSourceLane && cooldownActive) return { ttsCompletion: null };
          if (requestSignal.aborted) return { ttsCompletion: null };
          this.#assertRunning();
          if (!isSourceLane && translationStatus !== "failed" && !this.#supportsFixedTargetOutput(translatedText, language)) {
            translationFailureCode = "TRANSLATION_LANGUAGE_MISMATCH";
            await this.#publishLanguageStatus(language, "unavailable", "LANGUAGE_UNAVAILABLE");
            return { ttsCompletion: null };
          }
          const caption = {
            type: "caption",
            seq: this.#nextCaptionSeq(language),
            sessionId: this.sessionId,
            language,
            speaker,
            ...this.#liveCaptionSpeakerMetadata(floor),
            ...profileMetadata,
            ...(speakerProfile ? { speakerName: speakerProfile.displayName, speakerDepartment: speakerProfile.department } : {}),
            ...(speakerAttribution ? { speakerRole: "unknown", speakerName: "발언자 확인 필요" } : {}),
            text: translatedText,
            isFinal: true,
            // null on the source lane: text already IS the original, so
            // duplicating it would double every payload for no disclosure.
            sourceText: isSourceLane ? null : repairedSourceText,
            sourceLanguage: normalizedSourceLanguage || null,
            languageObservation,
            translationStatus,
            // Only a translated caption names a model: nothing produced the
            // text of a fail-open caption, and the source lane IS the original.
            ...(translationStatus === "translated" ? { translationModel } : {}),
            ...(authoritativeSource.sourceUtteranceId ? {
              authoritativeSourceId: authoritativeSource.sourceUtteranceId,
              sourceSequence: authoritativeSource.sourceSeq,
            } : {}),
            utteranceKey,
            ...(isSourceLane ? { origin: "source" } : {}),
            sourceStartedAt,
            sourceEndedAt,
            emittedAt: new Date(this.now()).toISOString(),
          };
          if (hasCaptionOutput(this.outputMode)) {
            // Supersede any queued/in-flight interim caption for this lane.
            const partialLane = this.#partialLanes.get(language);
            if (partialLane) {
              partialLane.epoch += 1;
              partialLane.pending = null;
              partialLane.lastText = "";
            }
            // Bidirectional captions: the HOST socket (desktop app) receives
            // every finalized caption too, so participant speech is visible
            // and recordable on the host side in real time.
            await this.#publishCaption(language, caption, { mirrorToHost: true });
            this.observeLatency?.("caption_publish_latency_ms", Math.max(0, this.now() - finalizedAt));
          }
          return { ttsCompletion: null };
        });
        if (ttsCompletion) await ttsCompletion;
        if (isFailOpenMiss) {
          this.#noteFailOpenMiss(language);
        } else if (translationFailureCode) {
          await this.#recordLanguageFailure(language, translationFailureCode);
        } else if (!cooldownActive) {
          await this.#markLanguageRecovered(language);
        }
        return null;
      } catch (error) {
        const code = error instanceof Error ? error.message : "LANGUAGE_UNAVAILABLE";
        // SESSION_STOPPED is a terminal signal, not a provider fault: it must
        // stop emission without counting toward the language cooldown.
        if (code !== "LIVE_PIPELINE_STOPPED" && code !== "SESSION_STOPPED") {
          await this.#recordLanguageFailure(language, code);
        }
        return error;
      }
    });
    await Promise.all(tasks);
  }

  async #persistAuthoritativeSource(input) {
    const operation = this.dependencies.publisher?.persistAuthoritativeSource;
    if (typeof operation !== "function") {
      const error = new Error("AUTHORITATIVE_SOURCE_PUBLISHER_REQUIRED");
      this.#authoritativeSourceLaneFailed = true;
      this.#reportFatalPublisherError(error);
      throw error;
    }
    const persist = this.#authoritativeSourceTail.then(() => {
      if (this.#authoritativeSourceLaneFailed) throw new Error("AUTHORITATIVE_SOURCE_LANE_FAILED");
      return operation.call(this.dependencies.publisher, {
        sessionId: this.sessionId,
        utteranceKey: input.utteranceKey,
        rawText: input.rawText,
        normalizedText: input.normalizedText,
        sourceLanguage: input.sourceLanguage,
        languageObservation: input.languageObservation,
        speakerRole: input.speakerAttribution ? "unknown" : input.floor ? "participant" : "host",
        ...(input.speakerProfile ? { speakerProfile: input.speakerProfile } : {}),
        ...(input.speakerAttribution ? { speakerAttribution: input.speakerAttribution } : {}),
        speakerLabel: input.speakerLabel || null,
        speakerName: input.speaker?.name || input.speaker?.label || (input.floor ? null : "Host"),
        speakerDepartment: input.speakerProfile?.department ?? input.floor?.department ?? null,
        speakerJobTitle: input.floor?.jobTitle ?? null,
        participantId: input.floor?.participantId ?? null,
        sourceStartedAt: input.sourceStartedAt,
        sourceEndedAt: input.sourceEndedAt,
        providerCommittedAt: input.providerCommittedAt,
        sttProvider: this.sttProvider,
        sttModel: this.transcriptionModel,
        translationModel: this.translationModel,
        pipelineConfigFingerprint: /^sha256:[a-f0-9]{64}$/u.test(this.captionConfigFingerprint ?? "")
          ? this.captionConfigFingerprint
          : null,
      });
    });
    this.#authoritativeSourceTail = persist.catch(() => undefined);
    try {
      return await persist;
    } catch (error) {
      this.#authoritativeSourceLaneFailed = true;
      const failure = hasErrorCode(error, new Set([
        "AUTHORITATIVE_SOURCE_PERSIST_FAILED",
        "AUTHORITATIVE_SOURCE_LANE_FAILED",
      ]))
        ? error
        : new Error("AUTHORITATIVE_SOURCE_PERSIST_FAILED", { cause: error });
      this.#reportFatalPublisherError(failure);
      throw failure;
    }
  }

  #queueSourceDraft(event) {
    if (this.#isStopped || this.#isPaused || typeof this.dependencies.publisher.publishSourceDraft !== "function") return;
    this.#sourceDraftPending = event;
    if (this.#sourceDraftWork) return;
    this.#sourceDraftWork = (async () => {
      while (this.#sourceDraftPending && !this.#isStopped && !this.#isPaused) {
        const next = this.#sourceDraftPending;
        this.#sourceDraftPending = null;
        try { await this.dependencies.publisher.publishSourceDraft(next); }
        catch { this.observeLatency?.("source_draft_publish_failures_total", 1); }
      }
    })().finally(() => {
      this.#sourceDraftWork = null;
      if (this.#sourceDraftPending) this.#queueSourceDraft(this.#sourceDraftPending);
    });
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

  async #publishCaption(language, caption, { mirrorToHost }) {
    let didMirror = false;
    if (caption.origin === "source" && !caption.isFinal) {
      this.#runTopicSideEffect("noteTopicPartial", this.sessionId);
    }
    // The desktop screen is owned by the host's LOCAL caption engine, which
    // hears the host microphone directly. This pipeline translates the same
    // host audio a second time for the web app's captions and records, so
    // mirroring the host half back would put a competing second translation of
    // the same sentence on the overlay. Only PARTICIPANT speech — which the
    // local engine cannot hear — is mirrored to the desktop.
    const isParticipantCaption = typeof caption.speaker?.speakerId === "string"
      && caption.speaker.speakerId.startsWith("participant:");
    const shouldMirrorToHost = mirrorToHost
      && isParticipantCaption
      && caption.translationStatus === "translated";
    try {
      await this.dependencies.publisher.publish(this.sessionId, language, caption, {
        onLiveEvent: (liveEvent) => {
          didMirror = true;
          if (shouldMirrorToHost) this.onHostEvent?.(liveEvent);
        },
      });
    } catch (error) {
      this.#reportFatalPublisherError(error);
      throw error;
    }
    // Test/in-memory publishers may implement the older three-argument seam.
    if (shouldMirrorToHost && !didMirror) this.onHostEvent?.(caption);
  }

  #runTopicSideEffect(method, ...args) {
    if (this.isCombined) return;
    const operation = this.dependencies.publisher?.[method];
    if (typeof operation !== "function") return;
    Promise.resolve()
      .then(() => operation.apply(this.dependencies.publisher, args))
      .catch(() => this.observeLatency?.("topic_side_effect_failures_total", 1));
  }

  async completeTopicsOnSessionEnd() {
    const operation = this.dependencies.publisher?.endTopicSession;
    if (typeof operation !== "function") return;
    await operation.call(this.dependencies.publisher, this.sessionId, this.languages);
  }

  #reportFatalPublisherError(error) {
    if (this.#didReportFatalError || !hasErrorCode(error, new Set([
      "DURABLE_CAPTION_PERSIST_FAILED",
      "DURABLE_CAPTION_LANE_FAILED",
      "AUTHORITATIVE_SOURCE_PUBLISHER_REQUIRED",
      "AUTHORITATIVE_SOURCE_PERSIST_FAILED",
      "AUTHORITATIVE_SOURCE_LANE_FAILED",
    ]))) return;
    this.#didReportFatalError = true;
    try {
      this.onFatalError?.(error);
    } catch {
      // Recovery notification is out-of-band; it must never replace the
      // original persistence error observed by the provider callback.
    }
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

  /** A combined-engine final that lacked this lane: neither a strike nor a
   *  recovery. Viewers were told `unavailable`, so remember that here and let
   *  the next translated final re-announce `ready`. */
  #noteFailOpenMiss(language) {
    const recovery = this.#languageRecovery.get(language);
    if (recovery) recovery.status = "unavailable";
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

  #presentationPartialLane(language) {
    let lane = this.#presentationPartialLanes.get(language);
    if (!lane) {
      lane = {
        epoch: 0,
        firstPendingAt: null,
        pending: null,
        timer: null,
        isPublishing: false,
        inFlight: Promise.resolve(),
      };
      this.#presentationPartialLanes.set(language, lane);
    }
    return lane;
  }

  #schedulePresentationPartial(language, value, sourceContext) {
    const lane = this.#presentationPartialLane(language);
    const now = this.now();
    if (lane.firstPendingAt === null) lane.firstPendingAt = now;
    lane.pending = { value, sourceContext, epoch: lane.epoch };
    if (lane.timer) this.clearTimeoutFn(lane.timer);

    const elapsed = Math.max(0, now - lane.firstPendingAt);
    const hasSentenceBoundary = /[.!?。！？…]$/.test(String(value.text ?? "").trim());
    const hasMinimumSignal = countSignalCharacters(value.text) >= PARTIAL_MIN_SIGNAL_CHARACTERS;
    if (hasSentenceBoundary || (hasMinimumSignal && elapsed >= PARTIAL_MAX_HOLD_MILLISECONDS)) {
      this.#flushPresentationPartial(language, lane);
      return;
    }
    const delay = Math.max(0, Math.min(
      PARTIAL_STABILITY_MILLISECONDS,
      PARTIAL_MAX_HOLD_MILLISECONDS - elapsed,
    ));
    lane.timer = this.setTimeoutFn(() => {
      lane.timer = null;
      const current = lane.pending;
      if (!current || current.epoch !== lane.epoch || this.#isStopped || this.#isPaused) return;
      const heldFor = Math.max(0, this.now() - lane.firstPendingAt);
      if (countSignalCharacters(current.value.text) >= PARTIAL_MIN_SIGNAL_CHARACTERS
        && heldFor >= PARTIAL_MAX_HOLD_MILLISECONDS) {
        this.#flushPresentationPartial(language, lane);
        return;
      }
      if (heldFor >= PARTIAL_MAX_HOLD_MILLISECONDS) {
        // Captions-only also drops an under-sized hold at the deadline. Re-
        // arming here with a zero delay creates a hot timer loop until the next
        // provider delta arrives.
        lane.pending = null;
        lane.firstPendingAt = null;
        return;
      }
      this.#schedulePresentationPartial(language, current.value, current.sourceContext);
    }, delay);
  }

  #flushPresentationPartial(language, lane) {
    if (lane.timer) {
      this.clearTimeoutFn(lane.timer);
      lane.timer = null;
    }
    if (lane.isPublishing) return;
    const pending = lane.pending;
    lane.pending = null;
    lane.firstPendingAt = null;
    if (!pending || pending.epoch !== lane.epoch || this.#isStopped || this.#isPaused) return;
    lane.isPublishing = true;
    lane.inFlight = this.#publishPresentationCaption(
      language,
      pending.value,
      { stabilized: true, sourceContext: pending.sourceContext, partialEpoch: pending.epoch },
    ).catch((error) => this.#recordCaptionEmissionFailure(language, error)).finally(() => {
      lane.isPublishing = false;
      const latest = lane.pending;
      if (latest && latest.epoch === lane.epoch && !this.#isStopped && !this.#isPaused) {
        this.#schedulePresentationPartial(language, latest.value, latest.sourceContext);
      }
    });
  }

  #cancelPresentationPartial(language) {
    const lane = this.#presentationPartialLanes.get(language);
    if (!lane) return Promise.resolve();
    lane.epoch += 1;
    lane.pending = null;
    lane.firstPendingAt = null;
    if (lane.timer) {
      this.clearTimeoutFn(lane.timer);
      lane.timer = null;
    }
    return lane.inFlight;
  }

  #cancelAllPresentationPartials() {
    const inFlight = [];
    for (const language of this.#presentationPartialLanes.keys()) {
      inFlight.push(this.#cancelPresentationPartial(language));
    }
    return inFlight;
  }

  /** The desktop channel-hub pattern: the source-language lane is fed by the
   *  input transcript (the target-language session stays silent for
   *  same-language speech because echoTargetLanguage=false). The model's own
   *  languageCode wins when it matches a session language; the script check
   *  is the fallback (ko/en/ja have disjoint scripts). */
  async #publishMeetingInputCaption(value = {}) {
    const { text, isFinal, languageCode } = value;
    const normalized = String(text ?? "").normalize("NFC").trim();
    if (!normalized) return;
    const inputSource = AUDIO_SOURCES.has(value.inputSource) ? value.inputSource : "system";
    if (this.#isSuppressedSource(inputSource, normalized)) return;
    const rawLanguageCode = typeof languageCode === "string" ? languageCode.trim() : "";
    const hasExplicitLanguageCode = languageCode !== undefined
      && languageCode !== null
      && String(languageCode).trim() !== "";
    const isExplicitlyUnknown = rawLanguageCode.toLowerCase() === "und";
    const canonicalProviderHint = normalizeLiveLanguage(languageCode);
    const strictEnglishKorean = this.#hasEnglishKoreanFirewall();
    const providerHint = resolveSessionInputLanguage(languageCode, normalized, this.languages, { strictEnglishKorean });
    const explicitUtteranceKey = typeof value.utteranceKey === "string" && value.utteranceKey
      ? value.utteranceKey
      : null;
    const isContinuingInputCaption = Boolean(this.#meetingInputCaption)
      && this.#meetingInputCaption.isFinal !== true
      && (!explicitUtteranceKey || explicitUtteranceKey === this.#meetingInputCaption?.utteranceKey);
    const consensusHint = this.sourceLanguageConsensus.resolveSource(providerHint || "unknown", {
      isStrong: String(value.text ?? "").trim().length >= 4,
      channelKey: value.targetLanguage,
    });
    let hinted = resolveSessionInputLanguage(
      consensusHint === "unknown" ? providerHint : consensusHint,
      normalized,
      this.languages,
      { strictEnglishKorean },
    );
    if (isEnglishKoreanPair(this.languages)) {
      const hasEnglish = ENGLISH_LETTER.test(normalized);
      const hasKorean = KOREAN_LETTER.test(normalized);
      const hasSingleScriptEvidence = hasEnglish !== hasKorean;
      if (isContinuingInputCaption
        && !hasSingleScriptEvidence
        && ["en", "ko"].includes(this.#meetingInputCaption?.language)) {
        hinted = this.#meetingInputCaption.language;
      } else if (this.languages.includes(providerHint)) {
        // A previous sentence's two-channel consensus may still be inside its
        // hold window. At a new utterance boundary, current provider/script
        // evidence starts the new lock; ambiguous mixed-script revisions retain
        // it while clear single-script corrections still match Caption-only.
        hinted = providerHint;
      }
    }
    const utteranceKey = explicitUtteranceKey
      ? explicitUtteranceKey
      : this.#meetingInputCaption && this.#meetingInputCaption.isFinal !== true
        ? this.#meetingInputCaption.utteranceKey
        : `${this.sessionId}:input:${++this.#meetingInputCaptionCounter}`;
    // 2026-07-26 fix: Provider result metadata is the primary language signal.
    // Script is only a fallback because names, numbers, and code-switched
    // sentences can legitimately look unlike their provider-classified lane.
    // In an exact EN/KO call, outside Latin metadata is never relabelled as
    // English; only strong Hangul can recover a stale outside hint into KO.
    // Other scripts, Vietnamese leakage, and malformed explicit values fail
    // closed before consensus can relabel them.
    const isCanonicalEnglishKoreanBridge = hinted === "en" || hinted === "ko";
    const isRejectedLanguage = isEnglishKoreanInputRejected(
      languageCode,
      normalized,
      providerHint,
      this.languages,
      { strictEnglishKorean },
    )
      || (hinted && !this.languages.includes(hinted) && !isCanonicalEnglishKoreanBridge)
      || (hasExplicitLanguageCode && !canonicalProviderHint && !isExplicitlyUnknown);
    if (isRejectedLanguage || (hinted && !this.languages.includes(hinted))) {
      this.#recordLanguageDrift(`input:${inputSource}`);
      // Keep a non-publishable correlation fence. Without it, an output partial
      // can inherit the previous input context after this source row is omitted
      // (unsupported language, or the absent source lane of a one-lane pair).
      this.#meetingInputCaption = {
        text: normalized,
        language: hinted,
        isFinal: Boolean(isFinal),
        utteranceKey,
        capturedAt: value.capturedAt,
        floorSpeaker: value.floorSpeaker ?? null,
        // A one-lane EN/KO session may legitimately translate the other core
        // language without publishing a source lane. Other explicit languages
        // are rejected until that language is part of the session.
        isUnsupportedLanguage: Boolean(isRejectedLanguage),
      };
      if (isFinal) {
        for (const language of this.languages) {
          const queue = this.#meetingInputFinalQueues.get(language) ?? [];
          queue.push(this.#meetingInputCaption);
          if (queue.length > 100) queue.shift();
          this.#meetingInputFinalQueues.set(language, queue);
        }
      }
      return;
    }
    this.#clearLanguageDrift(`input:${inputSource}`);
    const lane = hinted || this.languages.find((language) => textPlausiblyInLanguage(normalized, language));
    if (!lane) return;
    if (this.crossChannelEchoDedupers.get(lane)?.outputEchoesAnotherSource(inputSource, normalized)) return;
    const repairedSourceText = this.termRetriever.repair(normalized, {
      language: lane,
      isFinal: Boolean(isFinal),
    });
    this.#requiresFreshMeetingSourceContext = false;
    this.#meetingInputCaption = {
      text: repairedSourceText,
      language: lane,
      isFinal: Boolean(isFinal),
      utteranceKey,
      capturedAt: value.capturedAt,
      floorSpeaker: value.floorSpeaker ?? null,
    };
    if (isFinal) {
      for (const language of this.languages) {
        if (language === lane) continue;
        const queue = this.#meetingInputFinalQueues.get(language) ?? [];
        queue.push(this.#meetingInputCaption);
        if (queue.length > 100) queue.shift();
        this.#meetingInputFinalQueues.set(language, queue);
      }
    }
    // origin:"source" = the untranslated input transcript on its own-language
    // lane. The webapp keeps both lanes for the bilingual record; the desktop
    // mirror excludes this row and renders only a successful opposite-language
    // translation.
    await this.#publishPresentationCaption(lane, {
      text: repairedSourceText, isFinal, origin: "source", utteranceKey,
      capturedAt: value.capturedAt, floorSpeaker: value.floorSpeaker ?? null,
    });
  }

  async #observeMeetingInputCaption(channelId, value = {}) {
    const strictEnglishKorean = this.#hasEnglishKoreanFirewall();
    const language = resolveSessionInputLanguage(
      value.languageCode,
      value.text,
      this.languages,
      { strictEnglishKorean },
    );
    if (!language
      || isMalformedExplicitLanguageCode(value.languageCode)
      || isEnglishKoreanInputRejected(
        value.languageCode,
        value.text,
        language,
        this.languages,
        { strictEnglishKorean },
      )) return;
    this.sourceLanguageConsensus.reportSource(channelId, language, value.text, {
      isStrong: String(value.text ?? "").trim().length >= 4,
    });
    const source = String(channelId).split(":", 1)[0];
    let normalizedText = "";
    let isDuplicate = false;
    for (const deduper of this.crossChannelEchoDedupers.values()) {
      const observation = deduper.observeSource(source, value.text);
      normalizedText ||= observation.normalizedText;
      isDuplicate ||= observation.isDuplicate;
    }
    if (isDuplicate && normalizedText) {
      const currentTime = this.now();
      for (const [key, expiresAt] of this.#suppressedSourceTexts) {
        if (expiresAt <= currentTime) this.#suppressedSourceTexts.delete(key);
      }
      while (this.#suppressedSourceTexts.size >= MAX_SUPPRESSED_SOURCE_TEXTS) {
        this.#suppressedSourceTexts.delete(this.#suppressedSourceTexts.keys().next().value);
      }
      this.#suppressedSourceTexts.set(
        `${source}\u0000${normalizedText}`,
        currentTime + crossChannelEchoContract.windowMilliseconds,
      );
    }
  }

  #isSuppressedSource(source, text) {
    const normalized = this.crossChannelEchoDedupers.values().next().value?.normalize(text) ?? "";
    const key = `${source}\u0000${normalized}`;
    const expiresAt = this.#suppressedSourceTexts.get(key) ?? 0;
    if (expiresAt <= this.now()) {
      this.#suppressedSourceTexts.delete(key);
      return false;
    }
    return true;
  }

  async #publishPresentationCaption(language, value, options = {}) {
    if (!hasCaptionOutput(this.outputMode) || this.#isPaused) return;
    let text = String(value.text ?? "").normalize("NFC").trim();
    if (!text) return;
    const inputSource = AUDIO_SOURCES.has(options.inputSource ?? value.inputSource)
      ? (options.inputSource ?? value.inputSource)
      : "system";
    const echoDeduper = this.crossChannelEchoDedupers.get(language);
    if (value.origin !== "source" && echoDeduper?.outputEchoesAnotherSource(inputSource, text)) return;
    const isFinal = Boolean(value.isFinal);
    const strictEnglishKorean = this.#hasEnglishKoreanFirewall();
    let sourceContext = Object.hasOwn(options, "sourceContext") ? options.sourceContext : null;
    if (value.origin !== "source" && !Object.hasOwn(options, "sourceContext")) {
      const queue = this.#meetingInputFinalQueues.get(language) ?? [];
      if (typeof value.sourceText === "string" && value.sourceText.trim()) {
        const providerSourceLanguage = resolveSessionInputLanguage(
          value.sourceLanguage,
          value.sourceText,
          this.languages,
          { strictEnglishKorean },
        );
        const providerSourceContext = {
          text: value.sourceText,
          language: providerSourceLanguage,
          utteranceKey: value.utteranceKey,
          capturedAt: value.capturedAt,
          floorSpeaker: value.floorSpeaker ?? null,
          isUnsupportedLanguage: isMalformedExplicitLanguageCode(value.sourceLanguage)
            || isEnglishKoreanInputRejected(
              value.sourceLanguage,
              value.sourceText,
              providerSourceLanguage,
              this.languages,
              { strictEnglishKorean },
            ),
        };
        const matchingIndex = findCanonicalInputContext(queue, providerSourceContext);
        sourceContext = matchingIndex >= 0
          ? queue[matchingIndex]
          : {
            ...providerSourceContext,
            text: this.termRetriever.repair(providerSourceContext.text, {
              language: providerSourceLanguage,
              isFinal,
            }),
          };
        // A matched later identity/source proves every earlier queued source
        // missed this target lane. Finals consume that stale prefix atomically;
        // partials only observe it so their eventual final can still correlate.
        if (isFinal && matchingIndex >= 0) queue.splice(0, matchingIndex + 1);
      } else {
        sourceContext = isFinal ? (queue.shift() ?? this.#meetingInputCaption) : this.#meetingInputCaption;
      }
    }
    if (value.origin !== "source" && this.#isSuppressedSource(inputSource, sourceContext?.text ?? value.sourceText)) return;
    const sourceLanguage = normalizeLiveLanguage(sourceContext?.language);
    const providerOutputLanguage = normalizeLiveLanguage(value.languageCode);
    const hasRejectedOutputMetadata = strictEnglishKorean
      && (isMalformedExplicitLanguageCode(value.languageCode)
        || Boolean(providerOutputLanguage && !this.languages.includes(providerOutputLanguage)));
    const hasRejectedOutputText = strictEnglishKorean && hasUnsupportedEnglishKoreanText(text);
    // 2026-07-26 fix: Gemini can echo the input on the output callback even
    // with echoTargetLanguage=false. Drop that callback before polish, seq, and
    // publisher persistence. Provider output metadata also provides a strict
    // target-lane boundary when available; script inspection remains a legacy
    // fallback only when Gemini omits the language code.
    if (value.origin !== "source"
      && (hasRejectedOutputMetadata
        || hasRejectedOutputText
        || (sourceContext?.isUnsupportedLanguage === true)
        || (sourceLanguage
          && !this.languages.includes(sourceLanguage)
          && sourceLanguage !== "en"
          && sourceLanguage !== "ko")
        || (sourceLanguage && sourceLanguage === language)
        || (providerOutputLanguage
          && providerOutputLanguage !== language
          && !isSessionOutputInTargetLanguage(text, language, this.languages)))) {
      if (hasRejectedOutputMetadata || hasRejectedOutputText || sourceContext?.isUnsupportedLanguage === true) {
        this.#recordLanguageDrift(`output:${inputSource}:${language}`);
      }
      return;
    }
    if (value.origin !== "source") this.#clearLanguageDrift(`output:${inputSource}:${language}`);
    if (value.origin !== "source") echoDeduper?.recordSource(inputSource, text);
    if (this.sessionType === "meeting"
      && !isFinal
      && value.origin !== "source"
      && this.#requiresFreshMeetingSourceContext
      && !sourceContext) return;
    if (!isFinal && !options.stabilized) {
      this.#schedulePresentationPartial(language, { ...value, text }, sourceContext);
      return;
    }
    if (isFinal) await this.#cancelPresentationPartial(language);
    const finalOrder = isFinal ? this.#reservePresentationFinal(language) : null;
    try {
    const startedAt = this.now();
    const isPolishCandidate = isFinal && value.origin !== "source";
    if (value.origin !== "source" && !isFinal) {
      text = this.termRetriever.repair(text, { language, isFinal });
    }
    if (isPolishCandidate) {
      const polishStartedAt = this.now();
      const sourceForFinal = sourceContext?.text ?? value.sourceText ?? "";
      const sourceLanguage = sourceContext?.sourceLanguage
        ?? value.sourceLanguage
        ?? detectSourceLanguage(sourceForFinal, { minimumSignalChars: 1 });
      const finalized = await this.captionFinalizer.finalize({
        translatedText: text,
        sourceText: sourceForFinal,
        sourceLanguage,
        targetLanguage: language,
      });
      if (!finalized) return;
      text = finalized.text;
      this.observeLatency?.(`caption_polish_policy_${this.captionPolishPolicy}_total`, 1);
      this.observeLatency?.(`caption_polish_reason_${finalized.polishDecision.reason}_total`, 1);
      this.observeLatency?.(finalized.polishDecision.shouldPolish
        ? "caption_polish_attempts_total"
        : "caption_polish_skipped_total", 1);
      this.observeLatency?.("caption_polish_latency_ms", Math.max(0, this.now() - polishStartedAt));
    }
    if (value.origin !== "source" && strictEnglishKorean && hasUnsupportedEnglishKoreanText(text)) {
      this.#recordLanguageDrift(`output:${inputSource}:${language}`);
      return;
    }
    if (value.origin !== "source" && language === "ko" && !this.#supportsFixedTargetOutput(text, language)) {
      this.#recordLanguageDrift(`output:${inputSource}:${language}`);
      return;
    }
    // Polish can run concurrently across finalized cues, but seq allocation,
    // fanout, and persistence remain in provider arrival order. Partials never
    // wait on this gate and therefore keep the live line moving.
    if (finalOrder) await finalOrder.previous;
    if (!isFinal) {
      const partialLane = this.#presentationPartialLanes.get(language);
      if (partialLane && options.partialEpoch !== partialLane.epoch) return;
    }
    // Dedupe identity is (text, isFinal, TIME) — never text alone. A provider
    // re-emitting the same committed line lands within milliseconds; a speaker
    // genuinely repeating themselves ("네, 맞습니다.", "OK.") does not. Keying
    // on text alone swallowed every repeated acknowledgement for the whole
    // session, because this memo also has no eviction. The 1s window is the
    // same adjacency rule streaming ASR commit policies use.
    const utteranceKey = sourceContext?.utteranceKey ?? value.utteranceKey ?? null;
    const previous = this.#presentationCaptionState.get(language);
    const publishedAt = this.now();
    if (previous?.text === text
      && previous.isFinal === isFinal
      && (!isFinal || (utteranceKey && previous.utteranceKey === utteranceKey))
      && publishedAt - previous.publishedAt < REEMISSION_WINDOW_MILLISECONDS) {
      return;
    }
    this.#presentationCaptionState.set(language, {
      text, isFinal, publishedAt, utteranceKey,
    });
    // Meeting captions attribute to the Speak-floor holder while one is
    // active (partials and finals alike); otherwise the shared "presenter"
    // lane, exactly like presentation mode.
    const capturedAt = Number(value.capturedAt ?? sourceContext?.capturedAt);
    const floor = this.sessionType === "meeting"
      ? (value.floorSpeaker ?? sourceContext?.floorSpeaker
        ?? this.#floorAttribution(capturedAt))
      : null;
    const translationStatus = value.origin === "source"
      ? "verbatim"
      : isSessionOutputInTargetLanguage(text, language, this.languages)
        ? "translated"
        : "failed";
    const caption = {
      type: "caption",
      // Only the committed line consumes durable seq space (contract C1).
      seq: isFinal ? this.#nextCaptionSeq(language) : this.#peekCaptionSeq(language),
      sessionId: this.sessionId,
      language,
      speaker: floor ? this.#floorSpeakerAssignment(floor) : null,
      ...this.#liveCaptionSpeakerMetadata(floor),
      text,
      isFinal,
      ...(sourceContext ? {
        sourceText: sourceContext.text,
        sourceLanguage: sourceContext.language,
      } : value.origin === "source" ? {
        sourceText: null,
        sourceLanguage: language,
      } : {}),
      ...(utteranceKey ? { utteranceKey } : {}),
      ...(value.origin === "source" ? { origin: "source" } : {}),
      // A translated lane that came back NOT in its own language is a broken
      // translation (provider echoing the source, a mislabelled lane). It is
      // still published — the transcript must not have a hole — but it is
      // labelled so display paths never render it as a real translation. This
      // is the same record-vs-display split as origin:"source": recording is
      // unconditional, while the host mirror is filtered at this boundary.
      translationStatus,
      ...(Number.isFinite(capturedAt)
        ? { sourceStartedAt: new Date(capturedAt).toISOString() }
        : {}),
      sourceEndedAt: value.sourceEndedAt ?? new Date(this.now()).toISOString(),
      emittedAt: new Date(this.now()).toISOString(),
    };
    // Bidirectional captions: the desktop host mirrors meeting captions in
    // real time (participant Speak speech is invisible to its local engine).
    await this.#publishCaption(language, caption, { mirrorToHost: this.sessionType === "meeting" });
    // Only committed captions carry the p95 2.5s target; interim latency is a
    // different (and much looser) question.
    if (isFinal) this.observeLatency?.("caption_publish_latency_ms", Math.max(0, this.now() - startedAt));
    } finally {
      finalOrder?.release();
    }
  }

  async gracefulDrain({ timeoutMilliseconds = 10_000 } = {}) {
    this.#isDraining = true;
    let timer;
    try {
      await Promise.race([
        (async () => {
          await this.#stt?.gracefulDrain();
          await this.#pauseTask;
          this.#stt = null;
          await this.#authoritativeSourceTail;
          await Promise.allSettled(this.#finalUtteranceTasks.values());
          await Promise.all([...this.#translationQueues.values()].map((queue) => queue.drain()));
          await Promise.all(this.#presentationFinalTails.values());
          await this.dependencies.publisher.suspendTopicSession?.(this.sessionId);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("MEDIA_DRAIN_TIMEOUT")), timeoutMilliseconds); }),
      ]);
    } catch (error) {
      this.abortMedia();
      throw error;
    } finally { clearTimeout(timer); }
  }

  abortMedia() {
    this.#isDraining = true;
    this.#isStopped = true;
    this.#lifecycleAbort.abort();
    this.#sourceDraftPending = null;
    this.#stt?.abort();
    Promise.resolve(this.dependencies.publisher.suspendTopicSession?.(this.sessionId))
      .catch(() => this.observeLatency?.("topic_suspend_failures_total", 1));
  }

  async close() {
    this.#isStopped = true;
    this.#lifecycleAbort.abort();
    this.#sourceDraftPending = null;
    const partialPublications = this.#cancelAllPresentationPartials();
    try {
      await Promise.all([
        ...(this.#stt ? [this.#stt.close()] : []),
        this.#pauseTask,
        ...this.#finalUtteranceTasks.values(),
        ...[...this.#translationQueues.values()].map((queue) => queue.drain()),
        ...this.#presentationFinalTails.values(),
        ...partialPublications,
        ...this.#sourceGapTasks,
      ]);
    } finally {
      // Keep the source write fence until bounded gap IO settles, even if a
      // translation transport fails to close cleanly.
      await Promise.allSettled([...this.#sourceGapTasks]);
      this.captionFinalizer.release();
    }
  }

  #assertRunning() {
    if (this.#isStopped) throw new Error("LIVE_PIPELINE_STOPPED");
  }
}

function findCanonicalInputContext(queue, providerContext) {
  const providerKey = typeof providerContext.utteranceKey === "string" ? providerContext.utteranceKey : "";
  if (providerKey) {
    const exactKeyIndex = queue.findIndex((entry) => entry.utteranceKey === providerKey);
    if (exactKeyIndex >= 0) return exactKeyIndex;
  }

  const sourceText = String(providerContext.text ?? "").normalize("NFC").trim();
  const sourceLanguage = normalizeLiveLanguage(providerContext.language);
  const exactTextMatches = [];
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index];
    if (String(entry.text ?? "").normalize("NFC").trim() !== sourceText) continue;
    exactTextMatches.push(index);
  }
  // 2026-07-26 fix: The canonical input callback is the shared source of truth
  // across target sessions. A sibling session can report a contradictory
  // languageCode for the exact same transcript; requiring that hint to agree
  // rejected the canonical context and made the target lane drop its final as
  // a same-language echo. A unique exact transcript proves identity more
  // strongly than the unstable per-session language hint.
  if (exactTextMatches.length === 1) return exactTextMatches[0];
  const textMatches = sourceLanguage
    ? exactTextMatches.filter((index) => queue[index].language === sourceLanguage)
    : exactTextMatches;
  // A single exact source match is a safe FIFO resynchronization when provider
  // sessions reconnect with different generations. When a speaker repeats the
  // same sentence, use the lane-local coordinate only inside the text/language
  // candidates: equal counters alone are not trustworthy because two Gemini
  // sessions may segment the same audio differently.
  if (textMatches.length === 1) return textMatches[0];
  const providerCoordinate = parseGeminiUtteranceCoordinate(providerKey);
  if (providerCoordinate && textMatches.length > 1) {
    const coordinateMatches = textMatches.filter(
      (index) => parseGeminiUtteranceCoordinate(queue[index].utteranceKey) === providerCoordinate,
    );
    if (coordinateMatches.length === 1) return coordinateMatches[0];
  }
  return -1;
}

function parseGeminiUtteranceCoordinate(value) {
  const match = /^gemini:[^:]+:(\d+):(\d+)$/u.exec(String(value ?? ""));
  return match ? `${match[1]}:${match[2]}` : null;
}

function hasErrorCode(error, codes) {
  let current = error;
  const visited = new Set();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if (current instanceof Error && codes.has(current.message)) return true;
    current = current.cause;
  }
  return false;
}

function resolveSourceStartedAt({ sourceStartOffsetMs, sourceEndOffsetMs, sourceEndedAt }) {
  if (!Number.isFinite(sourceStartOffsetMs) || !Number.isFinite(sourceEndOffsetMs)) return null;
  const endedAt = Date.parse(sourceEndedAt);
  const durationMilliseconds = sourceEndOffsetMs - sourceStartOffsetMs;
  if (!Number.isFinite(endedAt) || durationMilliseconds < 0) return null;
  return new Date(endedAt - durationMilliseconds).toISOString();
}

function hasCaptionOutput(outputMode) {
  return outputMode === "captions";
}

function normalizeLanguageErrorCode(code) {
  if (["QUEUE_BACKPRESSURE", "QUEUE_BACKPRESSURE_EXCEEDED"].includes(code)) return code;
  return "LANGUAGE_UNAVAILABLE";
}

function createUtteranceKey({ speakerLabel, text, sourceGeneration, sourceStartOffsetMs, sourceEndOffsetMs, sourceEndedAt }) {
  const sourceIdentity = Number.isFinite(sourceStartOffsetMs) && Number.isFinite(sourceEndOffsetMs)
    ? `${sourceStartOffsetMs}:${sourceEndOffsetMs}`
    : String(sourceEndedAt ?? "");
  const digest = createHash("sha256")
    // 2026-08-31 fix: provider offsets restart at zero on pause/resume and rollover.
    .update(JSON.stringify([sourceGeneration, String(speakerLabel), sourceIdentity, text]), "utf8")
    .digest("hex");
  return `stt-v1:${digest}`;
}

function countSignalCharacters(value) {
  return (String(value ?? "").match(/[\p{L}\p{N}]/gu) ?? []).length;
}

export { textPlausiblyInLanguage } from "./config.js";
