import { AUDIO_CONFIG, normalizeLiveLanguage, textPlausiblyInLanguage, validateLiveSettings } from "./config.js";
import { OrderedTaskQueue } from "./ordered-task-queue.js";
import { applyGlossaryCorrections } from "./glossary-corrections.js";
import { isOutputInTargetLanguage, sourceLaneMatches } from "./language-gate.js";
import { SpeakerRegistry } from "./speaker-registry.js";

const INPUT_FRAME_BYTES = AUDIO_CONFIG.inputSampleRate * 2 * AUDIO_CONFIG.chunkMilliseconds / 1_000;
const OUTPUT_CHUNK_BYTES = AUDIO_CONFIG.outputSampleRate * 2 * 250 / 1_000;
const TTS_INACTIVITY_MILLISECONDS = 10_000;
const TTS_MAX_SYNTHESIS_MILLISECONDS = 120_000;
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
// Keep Live Call's visible revision cadence aligned with captions-only. Gemini
// often revises the same tail several times in a few hundred milliseconds;
// forwarding every snapshot makes the caption look as if it is being rewritten.
const PARTIAL_STABILITY_MILLISECONDS = 140;
const PARTIAL_MAX_HOLD_MILLISECONDS = 500;
const PARTIAL_MIN_SIGNAL_CHARACTERS = 12;

export class LiveMediaPipeline {
  #liveSessions = new Map();
  #voiceSessions = new Map();
  #translationQueues = new Map();
  #ttsQueues = new Map();
  #lastAudioAt = null;
  #didEndTurn = false;
  /** Finalized caption sequence per language: (sessionId, language) monotonic, starts at 1. */
  #captionSeq = new Map();
  /** Transient media events (audio chunks/controls) never consume caption seq. */
  #mediaSeq = 0;
  #isStopped = false;
  #isPaused = false;
  #ttsAbortControllers = new Set();
  #languageRecovery = new Map();
  #recentUtteranceKeys = new Map();
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
  #recentFloor = null;
  /** Meeting-mode interim caption lanes: per-language latest-wins throttle. */
  #partialLanes = new Map();
  /** Gemini caption lanes: per-language debounce with a bounded first paint. */
  #presentationPartialLanes = new Map();
  #didReportFatalError = false;

  constructor({
    sessionId,
    sessionType,
    outputMode,
    maxViewers,
    glossaryPack,
    glossaryText,
    translationTone,
    domainText,
    mode,
    voiceOutputMode,
    voiceProvider,
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
      voiceProvider,
      languages,
    });
    this.sessionId = sessionId;
    this.sessionType = settings.sessionType;
    this.outputMode = settings.outputMode;
    this.voiceProvider = settings.voiceProvider;
    this.maxViewers = settings.maxViewers;
    this.glossaryPack = settings.glossaryPack;
    this.glossaryText = settings.glossaryText;
    this.translationTone = settings.translationTone;
    this.domainText = settings.domainText;
    this.languages = settings.languages;
    this.dependencies = dependencies;
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
    return Math.max(0, ...this.#captionSeq.values());
  }

  /** Per-language last finalized caption seq, e.g. { ko: 12, en: 11 }. */
  get lastSequences() {
    return Object.fromEntries(this.#captionSeq);
  }

  get isPaused() {
    return this.#isPaused;
  }

  /** Pause: discard inbound audio and stop emitting captions/TTS while keeping
   *  the pipeline, floor attribution, and per-language seq counters intact. */
  pause() {
    this.#assertRunning();
    this.#isPaused = true;
    this.#cancelAllPresentationPartials();
  }

  resume() {
    this.#assertRunning();
    this.#isPaused = false;
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

  async start() {
    if (usesLiveTranslateCaptions(this.sessionType)) {
      // Captions are locked to the SAME model as the desktop subtitle
      // pipeline: gemini-3.5-live-translate (audio in → translated captions).
      // Meeting mode differences from presentation: the first session also
      // surfaces the input transcript (source-language lane, like the desktop
      // channel hub), captions carry floor attribution, and voice — when the
      // session has audio output — is OpenAI, never Gemini.
      const isMeeting = this.sessionType === "meeting";
      const opened = await Promise.all(this.languages.map(async (language, languageIndex) => {
        try {
          const session = await this.dependencies.liveTranslate.open({
            language,
            inputSampleRate: AUDIO_CONFIG.inputSampleRate,
            outputSampleRate: AUDIO_CONFIG.outputSampleRate,
            contextCompression: true,
            sessionResumption: true,
            correlateInputCaption: isMeeting,
            onCaption: (caption) => this.#publishPresentationCaption(language, caption),
            ...(isMeeting && languageIndex === 0
              ? { onInputCaption: (caption) => this.#publishMeetingInputCaption(caption) }
              : {}),
            onAudio: !isMeeting && this.voiceProvider === "gemini"
              ? (audio) => this.#publishPresentationAudio(language, audio)
              : async () => {},
            onInterruption: () => this.#publishAudioControl(language, "clear", "interrupted"),
            onCallbackError: (error) => this.#recordCaptionEmissionFailure(language, error),
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
      if (hasAudioOutput(this.outputMode) && (this.voiceProvider === "openai" || isMeeting)) {
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
    // No session type reaches here anymore: presentation AND meeting both
    // caption through Gemini Live Translate (desktop-identical model). The
    // Cloud STT rolling-session path was removed with the 2026-07-24 provider
    // split; acceptFinalUtterance stays as the direct-injection entry point.
    throw new Error("UNSUPPORTED_SESSION_TYPE");
  }

  #reservePresentationFinal(language) {
    const previous = this.#presentationFinalTails.get(language) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.#presentationFinalTails.set(language, previous.then(() => current));
    return { previous, release };
  }

  async acceptAudio(frame, capturedAt = this.now(), capturedFloorSpeaker = undefined) {
    this.#assertRunning();
    if (!(frame instanceof Uint8Array) || frame.byteLength !== INPUT_FRAME_BYTES) throw new Error("INVALID_AUDIO_FRAME");
    if (this.#isPaused) return false;
    if (this.now() - capturedAt > AUDIO_CONFIG.staleFrameMilliseconds) return false;
    this.#lastAudioAt = this.now();
    this.#didEndTurn = false;
    if (usesLiveTranslateCaptions(this.sessionType)) {
      // The gateway snapshots the producer identity when it accepts the frame.
      // Its ordered audio tail may reach this method after speak-end or a host
      // reclaim, so resolving from the current floor here can steal the late
      // final for the host. `undefined` keeps the direct-call compatibility;
      // explicit null is a host frame captured while the floor was free.
      const floorSpeaker = this.sessionType === "meeting"
        ? (capturedFloorSpeaker === undefined
          ? this.#floorAttribution(capturedAt)
          : capturedFloorSpeaker)
        : null;
      const results = await Promise.all([...this.#liveSessions].map(async ([language, session]) => {
        try {
          await session.sendAudio(frame, { capturedAt, floorSpeaker });
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
    }
    return true;
  }

  async tick() {
    if (!usesLiveTranslateCaptions(this.sessionType) || this.#lastAudioAt === null || this.#didEndTurn) return;
    if (this.now() - this.#lastAudioAt <= AUDIO_CONFIG.streamEndAfterMilliseconds) return;
    await Promise.all([...this.#liveSessions.values()].map((session) => session.audioStreamEnd()));
    await Promise.all([...this.#voiceSessions.values()].map((session) => session.audioStreamEnd()));
    this.#didEndTurn = true;
  }

  async endAudioStream() {
    if (!usesLiveTranslateCaptions(this.sessionType) || this.#didEndTurn) return;
    await Promise.all([...this.#liveSessions.values()].map((session) => session.audioStreamEnd()));
    await Promise.all([...this.#voiceSessions.values()].map((session) => session.audioStreamEnd()));
    this.#didEndTurn = true;
  }

  acceptFinalUtterance(utterance) {
    return this.#processFinalUtterance(utterance);
  }

  /** Streams interim STT transcripts as isFinal:false captions so viewers see
   *  text while someone is still talking (the finals-only meeting pipeline
   *  previously showed nothing until Google finalized an utterance, which can
   *  take 10s+ during continuous speech). Latest-wins per language: while a
   *  translation is in flight, newer interim text replaces the queued one. */
  acceptPartialTranscript({ text, sourceLanguage } = {}) {
    if (this.#isStopped || this.#isPaused || !hasCaptionOutput(this.outputMode)) return;
    const normalizedText = String(text ?? "").normalize("NFC").trim();
    if (!normalizedText) return;
    const normalizedSourceLanguage = normalizeLiveLanguage(sourceLanguage);
    const floor = this.#floorAttribution(Number.NaN);
    // Partials share one synthetic "live" lane (or the floor holder's lane) so
    // the viewer can replace them in place; finals clear the "live" lane.
    // Must be a COMPLETE SpeakerAssignment: the viewer contract validates
    // every field (colorToken/voiceName/voiceStatus/lastSeenAt) and silently
    // drops captions whose speaker shape is partial.
    const speaker = floor
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
    for (const language of this.languages) {
      const lane = this.#partialLane(language);
      lane.pending = {
        normalizedText,
        normalizedSourceLanguage,
        sourceLanguage,
        speaker,
        speakerMetadata: this.#liveCaptionSpeakerMetadata(floor),
        epoch: lane.epoch,
      };
      if (!lane.inFlight) {
        lane.inFlight = true;
        void this.#drainPartialLane(language, lane).finally(() => { lane.inFlight = false; });
      }
    }
  }

  #partialLane(language) {
    let lane = this.#partialLanes.get(language);
    if (!lane) {
      lane = { inFlight: false, pending: null, lastText: "", epoch: 0 };
      this.#partialLanes.set(language, lane);
    }
    return lane;
  }

  async #drainPartialLane(language, lane) {
    while (lane.pending && !this.#isStopped && !this.#isPaused) {
      const partial = lane.pending;
      lane.pending = null;
      try {
        // Same detection-backed decision as the final path: an interim must not
        // flash raw English on the KO lane just because the STT labelled
        // contaminated English as Korean.
        const isSourceLane = sourceLaneMatches(partial.normalizedText, partial.normalizedSourceLanguage, language);
        let textOut = partial.normalizedText;
        // Partials never carry "failed": a throw below skips publication
        // entirely rather than fail-open, so an interim caption is only ever
        // the verbatim source or a real translation.
        const translationStatus = isSourceLane ? "verbatim" : "translated";
        if (!isSourceLane) {
          const recovery = this.#languageRecovery.get(language);
          if (recovery && recovery.cooldownUntil > this.now()) continue;
          textOut = await this.dependencies.textTranslate.translate({
            text: partial.normalizedText,
            language,
            sourceLanguage: textPlausiblyInLanguage(partial.normalizedText, partial.normalizedSourceLanguage ?? "") ? partial.sourceLanguage : undefined,
            glossaryPack: this.glossaryPack,
            glossaryText: this.glossaryText,
            intent: "partial",
          });
        }
        // A final published while this partial was translating supersedes it.
        if (partial.epoch !== lane.epoch) continue;
        if (lane.lastText === textOut) continue;
        // Output-language gate, same as finals: never show an interim that is
        // not in this lane's language.
        if (!isOutputInTargetLanguage(textOut, language)) continue;
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
          sourceText: isSourceLane ? null : partial.normalizedText,
          sourceLanguage: partial.normalizedSourceLanguage || null,
          translationStatus,
          sourceEndedAt: new Date(this.now()).toISOString(),
          emittedAt: new Date(this.now()).toISOString(),
        };
        await this.#publishCaption(language, caption, { mirrorToHost: true });
      } catch {
        // Partial captions are best-effort; the finalized utterance retries.
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
        for (const session of this.#liveSessions.values()) session.setFloorSpeaker?.(next);
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
      for (const session of this.#liveSessions.values()) session.setFloorSpeaker?.(null);
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
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[live] caption emission failed on lane ${language} (${reason}). `
      + "Captions for this lane are being dropped, not retried.");
  }

  /** Resolves which floor holder a caption belongs to, given when its speech
   *  STARTED (epoch ms). Exposed so the attribution fence is directly testable
   *  and so a provider that can stamp speech onset has a seam to feed it —
   *  today the live-translate path has no onset and passes NaN, which makes the
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

  async #processFinalUtterance({ speakerLabel, text, sourceLanguage, sourceStartOffsetMs, sourceEndOffsetMs, sourceEndedAt, pcmWindow = null }) {
    this.#assertRunning();
    if (this.#isPaused) {
      pcmWindow?.fill(0);
      return;
    }
    const finalizedAt = this.now();
    const normalizedText = String(text).normalize("NFC").trim();
    if (!normalizedText) return;
    const utteranceKey = createUtteranceKey({ speakerLabel, text: normalizedText, sourceStartOffsetMs, sourceEndOffsetMs, sourceEndedAt });
    if (this.#recentUtteranceKeys.has(utteranceKey)) {
      pcmWindow?.fill(0);
      return;
    }
    this.#recentUtteranceKeys.set(utteranceKey, true);
    if (this.#recentUtteranceKeys.size > 256) this.#recentUtteranceKeys.delete(this.#recentUtteranceKeys.keys().next().value);
    const sourceStartedAt = resolveSourceStartedAt({ sourceStartOffsetMs, sourceEndOffsetMs, sourceEndedAt });
    const speakerCount = this.speakers.list().length;
    const floor = this.#floorAttribution(sourceStartedAt === null ? Number.NaN : Date.parse(sourceStartedAt));
    const speaker = floor
      ? this.#floorSpeakerAssignment(floor)
      : this.speakers.getOrCreate(String(speakerLabel));
    const normalizedSourceLanguage = normalizeLiveLanguage(sourceLanguage);
    pcmWindow?.fill(0);
    const legendPromise = this.speakers.list().length !== speakerCount
      ? this.#publishLegend()
      : Promise.resolve();
    const tasks = [...this.#translationQueues].map(async ([language, queue]) => {
      const recovery = this.#languageRecovery.get(language);
      const cooldownActive = Boolean(recovery && recovery.cooldownUntil > this.now());
      let translationFailureCode = null;
      try {
          const { ttsCompletion } = await queue.enqueue(async (signal) => {
            await legendPromise;
            if (signal.aborted) throw new Error("QUEUE_TASK_TIMEOUT");
            this.#assertRunning();
          // Dual-language lanes (contract C6): when the caption language equals
          // the utterance's source language (as detected by the STT provider),
          // the STT text is emitted verbatim; only the other lanes translate.
          // The STT detection is per-result and can be wrong, so passthrough
          // additionally requires the text's script to match the lane language
          // — otherwise misdetected Korean would surface raw on the en lane.
          // sourceLaneMatches applies the desktop engine's count+ratio detection
          // instead of a bare script-presence test: English carrying a single
          // Korean place name used to count as Korean and was published
          // untranslated on the KO lane.
          const isSourceLane = sourceLaneMatches(normalizedText, normalizedSourceLanguage, language);
          // laneReady: the published text is genuinely in the lane language
          // (verbatim source or successful translation) — the TTS gate.
          let laneReady = isSourceLane;
          let translatedText = normalizedText;
          // Provenance for the viewer's original/translation disclosure:
          // "verbatim" = text IS the original, "translated" = text is a real
          // translation of sourceText, "failed" = fail-open published the
          // original on this lane and it is NOT in the lane language.
          let translationStatus = isSourceLane ? "verbatim" : "translated";
          if (!isSourceLane && !cooldownActive) {
            try {
              translatedText = await this.dependencies.textTranslate.translate({
                text: normalizedText,
                language,
                // A misdetected source poisons translation; let the provider
                // auto-detect when the text does not match the detected script.
                sourceLanguage: textPlausiblyInLanguage(normalizedText, normalizedSourceLanguage ?? "") ? sourceLanguage : undefined,
                glossaryPack: this.glossaryPack,
                glossaryText: this.glossaryText,
                intent: "final",
              });
              laneReady = true;
            } catch (error) {
              // Fail-open: a verbatim caption beats a dropped one.
              translationFailureCode = error instanceof Error ? error.message : "LANGUAGE_UNAVAILABLE";
              console.warn(`[translate] final translate failed for lane ${language} (${translationFailureCode}); publishing verbatim`);
              translatedText = normalizedText;
              translationStatus = "failed";
            }
          }
          if (!isSourceLane && cooldownActive) translationStatus = "failed";
          if (signal.aborted) throw new Error("QUEUE_TASK_TIMEOUT");
          this.#assertRunning();
          // Output-language gate — desktop parity (shouldDisplay). A lane must
          // never publish text that is not in its own language. This is exactly
          // where fail-open used to leak the untranslated English source onto
          // the Korean lane, making captions alternate 한글 / 영어. Suppress
          // instead, and suppress BEFORE #nextCaptionSeq so a dropped lane never
          // burns a caption seq (contract C1: only committed captions consume).
          // A "translated" result that is not actually in the lane language is
          // no translation at all (a provider echoing the source, a mislabelled
          // lane). Downgrade it to "failed" rather than presenting it to the
          // viewer as a real translation.
          //
          // Note what this does NOT do: it does not drop the caption. The record
          // has to stay hole-free so a viewer browsing this language's
          // transcript later still sees the utterance, and live_utterances.text
          // is NOT NULL so the original travels as the lane text (with the same
          // string in sourceText, which is what the records view labels as 원문).
          // Keeping raw English OFF a Korean screen is the VIEWER's job.
          // Publishing here and filtering at the desktop boundary lets both
          // lanes record while the screen stays single-lane.
          if (!isSourceLane && translationStatus === "translated"
            && !isOutputInTargetLanguage(translatedText, language)) {
            translationStatus = "failed";
            laneReady = false;
          }
          // Never synthesize speech from text that is not in the lane language.
          if (translationStatus === "failed") laneReady = false;
          const caption = {
            type: "caption",
            seq: this.#nextCaptionSeq(language),
            sessionId: this.sessionId,
            language,
            speaker,
            ...this.#liveCaptionSpeakerMetadata(floor),
            text: translatedText,
            isFinal: true,
            // null on the source lane: text already IS the original, so
            // duplicating it would double every payload for no disclosure.
            sourceText: isSourceLane ? null : normalizedText,
            sourceLanguage: normalizedSourceLanguage || null,
            translationStatus,
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
          if (!hasAudioOutput(this.outputMode)) return { ttsCompletion: null };
          // A fallback verbatim caption is not in the lane language — never
          // synthesize it with this lane's voice.
          if (!laneReady) return { ttsCompletion: null };
          // TTS is skipped for languages nobody is listening to right now;
          // the translated caption above still ran (contract C6).
          if (typeof this.getSubscriberCount === "function" && this.getSubscriberCount(language) === 0) {
            return { ttsCompletion: null };
          }
          const ttsQueue = this.#ttsQueues.get(language);
          if (!ttsQueue) throw new Error("TTS_QUEUE_UNAVAILABLE");
          const submission = await ttsQueue.submit(() => this.#synthesize(language, speaker, translatedText));
          return { ttsCompletion: submission.completion };
        });
        if (ttsCompletion) await ttsCompletion;
        if (translationFailureCode) {
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
    try {
      await this.dependencies.publisher.publish(this.sessionId, language, caption, {
        onLiveEvent: () => {
          didMirror = true;
          if (mirrorToHost) this.onHostEvent?.(caption);
        },
      });
    } catch (error) {
      this.#reportFatalPublisherError(error);
      throw error;
    }
    // Test/in-memory publishers may implement the older three-argument seam.
    if (mirrorToHost && !didMirror) this.onHostEvent?.(caption);
  }

  #reportFatalPublisherError(error) {
    if (this.#didReportFatalError || !hasErrorCode(error, new Set([
      "DURABLE_CAPTION_PERSIST_FAILED",
      "DURABLE_CAPTION_LANE_FAILED",
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
      seq: ++this.#mediaSeq,
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
        seq: ++this.#mediaSeq,
        sessionId: this.sessionId,
        language,
        speaker,
        sampleRate: AUDIO_CONFIG.outputSampleRate,
    }, chunk);
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
    const rawLanguageCode = typeof languageCode === "string" ? languageCode.trim() : "";
    const hasExplicitLanguageCode = languageCode !== undefined
      && languageCode !== null
      && String(languageCode).trim() !== "";
    const isExplicitlyUnknown = rawLanguageCode.toLowerCase() === "und";
    const hinted = normalizeLiveLanguage(languageCode);
    const utteranceKey = typeof value.utteranceKey === "string" && value.utteranceKey
      ? value.utteranceKey
      : this.#meetingInputCaption && this.#meetingInputCaption.isFinal !== true
        ? this.#meetingInputCaption.utteranceKey
        : `${this.sessionId}:input:${++this.#meetingInputCaptionCounter}`;
    // 2026-07-26 fix: Provider result metadata is the primary language signal.
    // Script is only a fallback because names, numbers, and code-switched
    // sentences can legitimately look unlike their provider-classified lane.
    // A recognized provider language outside this session is not uncertainty:
    // falling back to script would relabel Vietnamese/Japanese as EN/KO and
    // persist a false source record. Only missing or explicit BCP-47 `und`
    // metadata may use the legacy script fallback. Malformed explicit values
    // fail closed at the same boundary.
    const isCanonicalEnglishKoreanBridge = hinted === "en" || hinted === "ko";
    const isRejectedLanguage = (hinted && !this.languages.includes(hinted) && !isCanonicalEnglishKoreanBridge)
      || (hasExplicitLanguageCode && !hinted && !isExplicitlyUnknown);
    if (isRejectedLanguage || (hinted && !this.languages.includes(hinted))) {
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
    const lane = hinted || this.languages.find((language) => textPlausiblyInLanguage(normalized, language));
    if (!lane) return;
    this.#requiresFreshMeetingSourceContext = false;
    this.#meetingInputCaption = {
      text: normalized,
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
    // lane. The webapp keeps both lanes; the desktop picks exactly its selected
    // language, so same-language speech uses this source lane as the one line.
    await this.#publishPresentationCaption(lane, {
      text: normalized, isFinal, origin: "source", utteranceKey,
      capturedAt: value.capturedAt, floorSpeaker: value.floorSpeaker ?? null,
    });
  }

  async #publishPresentationCaption(language, value, options = {}) {
    if (!hasCaptionOutput(this.outputMode) || this.#isPaused) return;
    let text = String(value.text ?? "").normalize("NFC").trim();
    if (!text) return;
    const isFinal = Boolean(value.isFinal);
    let sourceContext = Object.hasOwn(options, "sourceContext") ? options.sourceContext : null;
    if (value.origin !== "source" && !Object.hasOwn(options, "sourceContext")) {
      const queue = this.#meetingInputFinalQueues.get(language) ?? [];
      if (typeof value.sourceText === "string" && value.sourceText.trim()) {
        const providerSourceContext = {
          text: value.sourceText,
          language: normalizeLiveLanguage(value.sourceLanguage),
          utteranceKey: value.utteranceKey,
          capturedAt: value.capturedAt,
          floorSpeaker: value.floorSpeaker ?? null,
        };
        const matchingIndex = findCanonicalInputContext(queue, providerSourceContext);
        sourceContext = matchingIndex >= 0 ? queue[matchingIndex] : providerSourceContext;
        // A matched later identity/source proves every earlier queued source
        // missed this target lane. Finals consume that stale prefix atomically;
        // partials only observe it so their eventual final can still correlate.
        if (isFinal && matchingIndex >= 0) queue.splice(0, matchingIndex + 1);
      } else {
        sourceContext = isFinal ? (queue.shift() ?? this.#meetingInputCaption) : this.#meetingInputCaption;
      }
    }
    const sourceLanguage = normalizeLiveLanguage(sourceContext?.language);
    const providerOutputLanguage = normalizeLiveLanguage(value.languageCode);
    // 2026-07-26 fix: Gemini can echo the input on the output callback even
    // with echoTargetLanguage=false. Drop that callback before polish, seq, and
    // publisher persistence. Provider output metadata also provides a strict
    // target-lane boundary when available; script inspection remains a legacy
    // fallback only when Gemini omits the language code.
    if (value.origin !== "source"
      && ((sourceContext?.isUnsupportedLanguage === true)
        || (sourceLanguage
          && !this.languages.includes(sourceLanguage)
          && sourceLanguage !== "en"
          && sourceLanguage !== "ko")
        || (sourceLanguage && sourceLanguage === language)
        || (providerOutputLanguage
          && providerOutputLanguage !== language
          && !isOutputInTargetLanguage(text, language)))) {
      return;
    }
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
    // Latency was previously observed ONLY on #processFinalUtterance, which no
    // session type reaches — so the live path emitted no metric at all and the
    // p95 2.5s committed-caption target could not be measured. Split polish out
    // separately: without it there is no way to tell a slow provider from a
    // slow second-pass.
    const startedAt = this.now();
    // Committed lines run the SAME two-layer finish as the desktop subtitle
    // pipeline: the LLM second-pass polish (business register, terminology,
    // proper-noun repair; fail-open) followed by the deterministic glossary
    // pass as the guaranteed safety net.
    if (isFinal && this.dependencies.captionPolish) {
      const polishStartedAt = this.now();
      const polished = await this.dependencies.captionPolish.polish({
        translatedText: text,
        sourceText: sourceContext?.text ?? "",
        targetLanguage: language,
        tone: this.translationTone,
        glossary: this.glossaryText,
        domain: this.domainText,
      });
      text = String(polished ?? "").trim() || text;
      this.observeLatency?.("caption_polish_latency_ms", Math.max(0, this.now() - polishStartedAt));
    }
    // Runs on EVERY caption, interims included, and is NOT gated on a glossary
    // being configured. Two reasons:
    //   - number notation (만/억/조 ↔ million/billion/trillion) lives inside this
    //     pass and is arithmetic, not terminology, so it has to apply to every
    //     session — gating it on glossaryText skipped it entirely whenever no
    //     preset was picked.
    //   - the caption IS the final artifact. Correcting only finals meant the
    //     screen showed "3,000억" and then visibly rewrote itself to
    //     "KRW 300 billion" when the final landed, and the record disagreed with
    //     what the reader had just seen.
    // Measured at ~0.13ms per line against the 19KB CRE glossary, so the interim
    // path can afford it.
    text = applyGlossaryCorrections(text, {
      glossary: this.glossaryText,
      targetLanguage: language,
      sourceText: sourceContext?.text ?? "",
    });
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
      // labelled so the viewer never renders it as a real translation. This is
      // the same record-vs-display split as origin:"source": recording is
      // unconditional, DISPLAY is filtered client-side.
      ...(value.origin !== "source" && !isOutputInTargetLanguage(text, language)
        ? { translationStatus: "failed" }
        : {}),
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

  async #publishPresentationAudio(language, value) {
    if (!hasAudioOutput(this.outputMode) || this.#isPaused) return;
    const pcm = value?.pcm;
    if (!(pcm instanceof Uint8Array)
      || pcm.byteLength === 0
      || pcm.byteLength % 2 !== 0
      || value.sampleRate !== AUDIO_CONFIG.outputSampleRate) {
      throw new Error("INVALID_GEMINI_AUDIO");
    }
    await this.dependencies.publisher.publishAudio(this.sessionId, language, {
      type: "audio-chunk",
      seq: ++this.#mediaSeq,
      sessionId: this.sessionId,
      language,
      speaker: null,
      sampleRate: AUDIO_CONFIG.outputSampleRate,
    }, pcm);
  }

  async close() {
    this.#isStopped = true;
    const partialPublications = this.#cancelAllPresentationPartials();
    for (const abortController of this.#ttsAbortControllers) {
      abortController.abort(new Error("LIVE_PIPELINE_STOPPED"));
    }
    await Promise.all([
      ...[...this.#liveSessions.values()].map((session) => session.close()),
      ...[...this.#voiceSessions.values()].map((session) => session.close()),
      ...[...this.#translationQueues.values()].map((queue) => queue.drain()),
      ...[...this.#ttsQueues.values()].map((queue) => queue.drain()),
      ...this.#presentationFinalTails.values(),
      ...partialPublications,
    ]);
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
  return outputMode === "captions" || outputMode === "captions_audio";
}

function hasAudioOutput(outputMode) {
  return outputMode === "captions_audio" || outputMode === "audio";
}

function usesLiveTranslateCaptions(sessionType) {
  return sessionType === "presentation" || sessionType === "meeting";
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

function countSignalCharacters(value) {
  return (String(value ?? "").match(/[\p{L}\p{N}]/gu) ?? []).length;
}

export { textPlausiblyInLanguage } from "./config.js";
