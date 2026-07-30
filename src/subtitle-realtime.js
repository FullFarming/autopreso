// @ts-nocheck - Realtime translation server events are dynamic JSON payloads; tests cover the accepted wire shapes.
import { HttpsProxyAgent } from "https-proxy-agent";
import { WebSocket } from "ws";

import { createGeminiTransport } from "./gemini-live-translate.js";
import { DEFAULT_SUBTITLE_SETTINGS } from "./settings-store.js";
import { createSubtitleLanguageState } from "./subtitle-language-state.js";
import {
  countLanguageSignalChars,
  applyGlossaryCorrections,
  createCommittedCaptionFinalizer,
  createCrossChannelEchoDeduper,
  createGeminiCaptionConfig,
  createSourceLanguageConsensus,
  detectLanguage as detectCaptionLanguage,
  detectSourceLanguage as detectCaptionSourceLanguage,
  isOutputInTargetLanguage,
  normalizeCommittedCreCaption,
  sourceConsensusContract,
} from "../packages/caption-core/index.js";
import {
  MAX_TRANSLATION_LANGUAGES,
  isSupportedSubtitleLanguage,
  normalizeSubtitleLanguageCode,
  resolveConfiguredLanguageForScript,
  subtitleLanguageLabel,
  subtitleLanguagePrefixTokens,
} from "./subtitle-languages.js";

const VALID_AUDIO_SOURCES = new Set(["system", "mic"]);
const SUBTITLE_COMMIT_MS = 800;
// Gemini finals normally follow provider turnComplete/generationComplete. This
// longer fallback starts only after PCM energy shows a real speech-to-silence
// transition; output-fragment timing must never manufacture a sentence boundary.
const GEMINI_AUDIO_SILENCE_COMMIT_MS = 1200;
const PCM_SPEECH_RMS_THRESHOLD = 192;
// A live partial that stops growing for this long without ever finalizing
// (Gemini sent no turnComplete) is treated as an abandoned turn and cleared, so
// a frozen translation can't linger/flicker through a language switch.
const PARTIAL_STALE_CLEAR_MS = 1200;
// If NO new transcription/translation content arrives for this long, the speaker has
// stopped — END the subtitle (reset the buffer AND clear the display). Gated on CONTENT
// activity, NOT raw audio frames: the mic streams silent frames continuously, so an
// audio-frame gate never fires and the subtitle would grow/persist forever ("문장이
// 끝날 때까지 자막이 계속 떠 있음"). User spec: no input for 3s → subtitle ends.
const SILENCE_CLEAR_MS = 3000;
const PARTIAL_STABILITY_MS = 140;
// Lowered 2026-06-21: the high thresholds were defensive against Gemini's noisy
// early transcript revisions, but the robust transcript merge now keeps text
// growing cleanly — so the FIRST translation can paint much sooner (it no longer
// waits for 24 chars + a 1s hold) without showing garbled fragments.
const GEMINI_PARTIAL_MAX_HOLD_MS = 500;
const GEMINI_PARTIAL_MIN_SIGNAL_CHARS = 12;
const MAX_PENDING_AUDIO_CHUNKS = 8;
const MAX_PENDING_AUDIO_AGE_MS = 750;
const MAX_TRANSCRIPT_CHARS = 16_384;
// Live-audio backpressure guard: when the translation socket's send buffer
// backs up past this (slow network / provider stall), new frames are DROPPED
// instead of queued. Realtime subtitles must stay live — letting the ws buffer
// grow just makes the provider fall further and further behind real time until
// subtitles appear frozen ("큐가 쌓이면 멈추는 현상"). ~1MB ≈ 15s of PCM16@16k
// base64 payloads: already far behind, so shedding is strictly better.
const AUDIO_BACKPRESSURE_MAX_BUFFERED_BYTES = 1_000_000;
const SETUP_ACK_TIMEOUT_MS = 8000;
const DEFAULT_POLISH_TIMEOUT_MS = 6_000;
// Auto-reconnect backoff for server-side drops / the Gemini connection-lifetime
// cap, so multi-hour sessions survive without a manual restart.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5000;
const MAX_AUTO_RECONNECTS = 10;
const AUDIO_OUTPUT_MODES = new Set(["captions_audio", "audio"]);
function redactTransportDiagnostic(value) {
  return String(value ?? "")
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, "$1[redacted-secret]")
    .replace(/(?:AIza|sk-)[A-Za-z0-9_-]+/g, "[redacted-secret]")
    .replace(/[A-Za-z0-9+/]{64,}={0,2}/g, "[redacted-data]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 240);
}

function boundTranscript(value) {
  const text = String(value ?? "");
  return text.length <= MAX_TRANSCRIPT_CHARS ? text : text.slice(-MAX_TRANSCRIPT_CHARS);
}

function pcm16HasSpeechSignal(base64Audio) {
  if (typeof base64Audio !== "string" || !base64Audio) return true;
  const pcm = Buffer.from(base64Audio, "base64");
  if (pcm.length < 2 || pcm.length % 2 !== 0) return true;
  let squaredSum = 0;
  let samples = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    squaredSum += sample * sample;
    samples += 1;
  }
  return Math.sqrt(squaredSum / samples) >= PCM_SPEECH_RMS_THRESHOLD;
}

/** @param {Record<string, unknown>} options */
export function createSubtitleRealtimeManager(options = {}) {
  const {
    broadcast,
    settingsStore,
    env = process.env,
    log = console,
    setupAckTimeoutMs = SETUP_ACK_TIMEOUT_MS,
    polishTimeoutMs = DEFAULT_POLISH_TIMEOUT_MS,
    // Default passthrough keeps natural mode synchronous-equivalent and tests
    // that don't care about tone unaffected. Server injects the real polisher.
    polish = async ({ translatedText }) => translatedText,
  } = options;
  // Corporate networks often require an HTTP proxy for outbound 443 — the
  // browser honors the system proxy, but ws in the main process does not.
  // Honor the standard env vars so packaged apps work behind such networks.
  const proxyUrl = env.HTTPS_PROXY || env.https_proxy || "";
  const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  // handshakeTimeout converts a silently stalled upgrade (firewall dropping
  // packets) into a diagnosable error instead of an indefinite CONNECTING.
  const createWebSocket = options.createWebSocket
    ?? ((url, protocols, init) => new WebSocket(url, protocols, {
      ...init,
      handshakeTimeout: 10_000,
      ...(proxyAgent ? { agent: proxyAgent } : {}),
    }));
  const readNow = typeof options.now === "function" ? options.now : Date.now;
  // Stall watchdog: speech signal present but zero subtitle output for stallMs
  // → the pipeline is wedged (dead upstream session, silent provider failure)
  // → rebuild the channels automatically. Timings injectable for tests.
  const watchdogConfig = {
    intervalMs: 100,
    stallMs: 2_000,
    cooldownMs: 45_000,
    ...(options.stallWatchdog ?? {}),
  };
  const state = {
    sessionId: null,
    settings: { ...DEFAULT_SUBTITLE_SETTINGS },
    captionConfig: null,
    clients: new Map(),
    active: false,
    apiKeys: { gemini: "", geminiSecondary: "" },
  };
  let watchdogTimer = null;
  // Each capture source owns its liveness clock. A healthy system-audio lane
  // must never conceal a stalled microphone lane in system_mic mode.
  const livenessBySource = new Map();
  let lastStallRestartAt = 0;
  let restartInFlight = false;
  let producerGeneration = 0;

  function resetSourceLiveness(timestamp = readNow()) {
    livenessBySource.clear();
    for (const source of sourcesForInputMode(state.settings.inputMode)) {
      livenessBySource.set(source, { signalSince: 0, lastSignalAt: 0, lastOutputAt: timestamp });
    }
  }

  function noteOutput(source) {
    const timestamp = readNow();
    const outputSources = VALID_AUDIO_SOURCES.has(source)
      ? [source]
      : sourcesForInputMode(state.settings.inputMode);
    for (const outputSource of outputSources) {
      const current = livenessBySource.get(outputSource)
        ?? { signalSince: 0, lastSignalAt: 0, lastOutputAt: timestamp };
      livenessBySource.set(outputSource, { ...current, lastOutputAt: timestamp });
    }
  }

  // Manager-level broadcast tap: caption modes use visible text as liveness;
  // audio-only mode uses playable PCM and keeps hidden captions out of the
  // watchdog signal.
  function broadcastTapped(message) {
    const isCaption = message?.type === "subtitle:partial" || message?.type === "subtitle:committed";
    if (state.settings.outputMode === "audio") {
      if (message?.type === "subtitle:translated-audio") noteOutput(message?.source);
      if (isCaption) return;
    } else if (isCaption) {
      noteOutput(message?.source);
    }
    broadcast?.(message);
  }

  function clearTranslatedAudio(reason) {
    if (!AUDIO_OUTPUT_MODES.has(state.settings.outputMode)) return;
    broadcast?.({ type: "subtitle:audio-control", action: "clear", reason });
  }

  /** @param {{ sessionId?: string, settings?: Record<string, unknown> }} args */
  async function start({ sessionId, settings = {} } = {}) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("subtitle:start requires a sessionId.");
    }
    await stop();
    const saved = settingsStore ? await settingsStore.load() : {};
    const normalizedSettings = normalizeSubtitleSettings({
      ...(saved.subtitle ?? {}),
      ...(settings ?? {}),
    });
    const captionConfig = createGeminiCaptionConfig(normalizedSettings);
    const nextSettings = {
      ...normalizedSettings,
      translationProvider: "gemini",
      voiceProvider: "gemini",
      _captionConfig: captionConfig,
    };
    const apiKeys = {
      gemini: (saved.apiKeys?.gemini || env.GEMINI_API_KEY || "").trim(),
      geminiSecondary: (saved.apiKeys?.geminiSecondary || env.GEMINI_SECONDARY_API_KEY || "").trim(),
    };
    if (!apiKeys.gemini) throw new Error("Gemini API key is required for realtime subtitles.");
    state.sessionId = sessionId;
    state.settings = nextSettings;
    state.captionConfig = captionConfig;
    state.apiKeys = apiKeys;
    state.active = true;
    producerGeneration += 1;
    resetSourceLiveness();
    lastStallRestartAt = 0;
    startWatchdog();
    broadcast?.({ type: "subtitle:status", status: "connecting" });
    for (const source of sourcesForInputMode(state.settings.inputMode)) {
      ensureClient(source).open();
    }
    broadcast?.({ type: "subtitle:status", status: "listening" });
  }

  // Rebuild the translation channels IN PLACE: same sessionId, audio capture
  // untouched, settings/API keys re-read from the store. This is the recovery
  // path for a wedged pipeline (overlay double-click, glossary preset switch,
  // stall watchdog) and works headless — no dashboard page required.
  async function restartChannels({ reason = "restart" } = {}) {
    if (!state.active || !state.sessionId || restartInFlight) return false;
    const ownerSessionId = state.sessionId;
    const ownerGeneration = producerGeneration;
    restartInFlight = true;
    try {
      const saved = settingsStore ? await settingsStore.load() : {};
      if (!state.active || state.sessionId !== ownerSessionId || producerGeneration !== ownerGeneration) return false;
      // Saved settings win (a glossary/preset change is a common reason to
      // rebuild); the running session's settings fill anything not persisted.
      const normalizedSettings = normalizeSubtitleSettings({ ...(state.settings ?? {}), ...(saved.subtitle ?? {}) });
      state.captionConfig = createGeminiCaptionConfig(normalizedSettings);
      state.settings = {
        ...normalizedSettings,
        translationProvider: "gemini",
        voiceProvider: "gemini",
        _captionConfig: state.captionConfig,
      };
      state.apiKeys = {
        gemini: (saved.apiKeys?.gemini || env.GEMINI_API_KEY || "").trim(),
        geminiSecondary: (saved.apiKeys?.geminiSecondary || env.GEMINI_SECONDARY_API_KEY || "").trim(),
      };
      if (!state.apiKeys.gemini) throw new Error("Gemini API key is required for realtime subtitles.");
      clearTranslatedAudio(reason);
      log.warn?.(`[subtitle] rebuilding translation channels (${reason})`);
      broadcast?.({ type: "subtitle:status", status: "recovering", reason });
      const oldClients = [...state.clients.values()];
      state.clients.clear();
      producerGeneration += 1;
      const replacementGeneration = producerGeneration;
      await Promise.all(oldClients.map((client) => client.close({ graceful: false })));
      if (!state.active || state.sessionId !== ownerSessionId || producerGeneration !== replacementGeneration) return false;
      for (const source of sourcesForInputMode(state.settings.inputMode)) {
        ensureClient(source).open();
      }
      resetSourceLiveness();
      broadcast?.({ type: "subtitle:status", status: "listening" });
      return true;
    } finally {
      restartInFlight = false;
    }
  }

  // Capture-page speech signal (subtitle:input-status "signal"). Tracks the
  // start of the current continuous-speech window for the stall watchdog.
  function noteInputSignal({ sessionId, source } = {}) {
    if (!state.active || (sessionId && sessionId !== state.sessionId)) return;
    const now = readNow();
    const inputSources = VALID_AUDIO_SOURCES.has(source)
      ? [source]
      : sourcesForInputMode(state.settings.inputMode);
    for (const inputSource of inputSources) {
      const current = livenessBySource.get(inputSource)
        ?? { signalSince: 0, lastSignalAt: 0, lastOutputAt: now };
      const signalSince = now - current.lastSignalAt > Math.max(5_000, watchdogConfig.intervalMs)
        ? now
        : current.signalSince;
      livenessBySource.set(inputSource, { ...current, signalSince, lastSignalAt: now });
    }
  }

  function startWatchdog() {
    stopWatchdog();
    watchdogTimer = setInterval(checkForStall, watchdogConfig.intervalMs);
    watchdogTimer.unref?.();
  }

  function stopWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  function checkForStall() {
    if (!state.active || restartInFlight) return;
    const now = readNow();
    const staleSignalAfterMs = Math.max(5_000, watchdogConfig.intervalMs);
    const stalledEntry = [...livenessBySource.entries()].find(([, liveness]) => {
      if (!liveness.signalSince || now - liveness.lastSignalAt > staleSignalAfterMs) return false;
      // Output re-arms the deadline even during one continuous utterance. Using
      // only signalSince would permanently disable recovery after the first
      // successful caption if the provider froze later in the same speech run.
      return now - Math.max(liveness.signalSince, liveness.lastOutputAt) >= watchdogConfig.stallMs;
    });
    if (!stalledEntry) return;
    if (lastStallRestartAt > 0 && now - lastStallRestartAt < watchdogConfig.cooldownMs) return;
    lastStallRestartAt = now;
    const [stalledSource, stalledLiveness] = stalledEntry;
    livenessBySource.set(stalledSource, { ...stalledLiveness, signalSince: now });
    log.warn?.(`[subtitle] no ${stalledSource} subtitle output for ${watchdogConfig.stallMs}ms of continuous speech; auto-restarting channels`);
    void restartChannels({ reason: "stall_watchdog" }).catch((error) => {
      const safeDetail = redactTransportDiagnostic(error?.message ?? error);
      log.warn?.(`[subtitle] stall watchdog restart failed: ${safeDetail}`);
    });
  }

  /** @param {{ sessionId?: string, source?: string, audio?: string }} args */
  function sendAudio({ sessionId, source, audio } = {}) {
    if (!state.active || sessionId !== state.sessionId) return;
    if (!VALID_AUDIO_SOURCES.has(source)) return;
    if (typeof audio !== "string" || !audio) return;
    ensureClient(source).sendAudio(audio);
  }

  async function stop(sessionId = state.sessionId) {
    if (sessionId !== state.sessionId && state.sessionId !== null) return false;
    stopWatchdog();
    const wasActive = state.active || state.sessionId !== null || state.clients.size > 0;
    if (wasActive) clearTranslatedAudio("stop");
    const closingClients = [...state.clients.values()];
    state.clients.clear();
    // 2026-07-27 fix: revoke the producer before graceful provider shutdown.
    // Provider close may finalize a last turn; the active guard must reject it
    // after the user has already ended the caption session.
    state.active = false;
    state.sessionId = null;
    state.captionConfig = null;
    producerGeneration += 1;
    livenessBySource.clear();
    if (wasActive) broadcast?.({ type: "subtitle:status", status: "idle" });
    await Promise.all(closingClients.map((client) => client.close({ graceful: true })));
    return wasActive;
  }

  function close() {
    stopWatchdog();
    clearTranslatedAudio("close");
    for (const client of state.clients.values()) client.close();
    state.clients.clear();
    state.active = false;
    state.sessionId = null;
    state.captionConfig = null;
    producerGeneration += 1;
    livenessBySource.clear();
  }

  function ensureClient(source) {
    const existing = state.clients.get(source);
    if (existing) return existing;
    const ownerSessionId = state.sessionId;
    const ownerGeneration = producerGeneration;
    const client = createRealtimeSubtitleClient({
      source,
      settings: state.settings,
      apiKeys: state.apiKeys,
      createWebSocket,
      broadcast: (message) => {
        if (!state.active || state.sessionId !== ownerSessionId || producerGeneration !== ownerGeneration) return;
        broadcastTapped(message);
      },
      log,
      polish,
      polishTimeoutMs,
      setupAckTimeoutMs,
    });
    state.clients.set(source, client);
    return client;
  }

  return { start, sendAudio, stop, close, restartChannels, noteInputSignal, _state: state };
}

function createRealtimeSubtitleClient({ source, settings, apiKeys, createWebSocket, broadcast, log, polish, polishTimeoutMs, setupAckTimeoutMs }) {
  const captionSettings = {
    ...settings,
    translationProvider: "gemini",
    voiceProvider: "gemini",
    geminiModel: settings._captionConfig?.models?.live ?? settings.geminiModel,
  };
  const channelConfigs = translationChannelConfigs(captionSettings, apiKeys);
  // Echo registry is SHARED across the sibling channels (cross-channel echo
  // detection); the source-language coordinator is created PER-CHANNEL inside
  // createTranslationChannel so one channel's transcription can't pollute the
  // other's language read.
  const echoRegistry = createCrossChannelEchoRegistry();
  const channels = channelConfigs.map((channelConfig) => createTranslationChannel({
    source,
    ...channelConfig,
    settings: captionSettings,
    apiKeys,
    createWebSocket,
    broadcast,
    log,
    polish,
    polishTimeoutMs,
    echoRegistry,
    setupAckTimeoutMs,
  }));
  return {
    open() {
      for (const channel of channels) channel.open();
    },
    sendAudio(audio) {
      for (const channel of channels) channel.sendAudio(audio);
    },
    async close(options = {}) {
      await Promise.all(channels.map((channel) => channel.close(options)));
      channels.length = 0;
    },
  };
}

// Provider transport contract: connect(), setupPayloads(), audioPayload(),
// handleMessage(raw, ctx), closePayload(). The channel core (language lock,
// wrong-direction suppression, commit + tone polish) is provider-agnostic.
function createTranslationChannel({ source, targetLanguage, apiKeyRole, settings, apiKeys = {}, createWebSocket, broadcast, log, polish, polishTimeoutMs = DEFAULT_POLISH_TIMEOUT_MS, echoRegistry, setupAckTimeoutMs = SETUP_ACK_TIMEOUT_MS }) {
  // Per-channel source-language tracker (not shared — see the coordinator/registry
  // split). The shared `echoRegistry` handles cross-channel echo detection only.
  const sourceLanguageCoordinator = createSubtitleLanguageState({
    allowedLanguages: settings.translationLanguages,
  });
  // Per-direction engine routing (probe-verified 2026-06-12): OpenAI's
  // Every caption and interpreted-audio lane uses Gemini Live. A second
  // provider would make terminology and failure behavior diverge by mode.
  const apiKey = selectGeminiApiKey({ settings, apiKeys, apiKeyRole });
  const translationContext = resolveSubtitleTranslationContext(settings);
  const captionConfig = settings._captionConfig ?? createGeminiCaptionConfig(settings);
  const finalizer = createCommittedCaptionFinalizer({
    config: captionConfig,
    polish: async (request) => {
      let timer = null;
      try {
        return await Promise.race([
          Promise.resolve(polish(request)),
          new Promise((resolve) => { timer = setTimeout(() => resolve(request.translatedText), polishTimeoutMs); }),
        ]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    },
  });
  const termRetriever = finalizer.termRetriever;
  const transport = createGeminiTransport({ settings, targetLanguage, apiKey });
  let socket = null;
  let configured = false;
  let pendingAudio = [];
  let sourceText = "";
  let translatedText = "";
  // The last partial text actually broadcast, so an unchanged partial is never
  // re-sent — repeated identical emits make a stale line flicker (clear →
  // re-appear → clear) when a turn never finalizes.
  let lastEmittedPartial = "";
  let sourceLanguageHint = "unknown";
  let sourceLanguageBuffer = "";
  let commitTimer = null;
  let partialTimer = null;
  let setupAckTimer = null;
  let partialStaleTimer = null;
  // Silence-clear: ends the subtitle after SILENCE_CLEAR_MS of no new CONTENT.
  let silenceClearTimer = null;
  // Wall-clock of the most recent audio frame, so the buffer-reset fires only on
  // genuine SILENCE (speaker paused) and never mid-utterance during continuous
  // speech, which would fragment the translation into tiny pieces.
  let lastAudioAt = 0;
  // True while live audio is being shed because the translation socket's send
  // buffer is backed up — logs the episode edges once instead of per frame.
  let backpressureShedding = false;
  // After a cross-channel echo is detected on this channel, briefly suppress its
  // partials (commit-only) so the same wrong-direction echo can't keep flashing
  // while the speaker stays in this channel's target language.
  let partialEchoCooldownUntil = 0;
  let partialHoldStartedAt = 0;
  let sourceTranscriptFinalized = false;
  let sourceLanguageIsStrong = false;
  let closeResolve = null;
  let closeTimer = null;
  let channelClosed = false;
  let lastSurfacedSocketError = "";
  let lastClearReason = "";
  // Session-resumption handle (Gemini): survives reconnects so a dropped
  // connection continues the SAME logical session instead of starting fresh.
  let resumptionHandle = null;
  // Distinguishes a deliberate channel.close() (stop/reconfigure → stay down)
  // from a server-side drop / duration cap (→ auto-reconnect).
  let intentionalClose = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let reconnectErrorSurfaced = false;
  let consecutiveTargetLanguageViolations = 0;
  let languageDriftRestartPending = false;
  let providerOutputLanguageViolationRecorded = false;
  let hasObservedSpeechAudio = false;
  let commitTail = Promise.resolve();

  // Commit pipeline: refine the finalized line into the configured tone, then
  // broadcast it. Partials never pass through here (P0: realtime feel). If the
  // channel was torn down while polishing, the late line is dropped so it can
  // never paint into the next session.
  function commitSubtitle(subtitle) {
    const next = commitTail.then(() => commitSubtitleNow(subtitle), () => commitSubtitleNow(subtitle));
    commitTail = next.catch(() => undefined);
    return next;
  }

  async function commitSubtitleNow({ sourceText: committedSource, translatedText: committedTranslation }) {
    clearPartialTimer();
    const finalSource = String(committedSource ?? "").trim();
    const rawTranslation = String(committedTranslation ?? "").trim();
    if (!rawTranslation) return;
    const rawMatchesTargetLanguage = isOutputInTargetLanguage(rawTranslation, targetLanguage);
    // Same-language echo guard, judged from THIS channel's OWN source text. A
    // real translation's source is never already in the target language. The
    // shared source-language coordinator can lag a language switch and keep
    // reporting the previous source, which would let this channel show its own
    // input echoed back — e.g. the EN channel painting English while the speaker
    // has just switched ko→en, so source and translation appear together
    // ("영어로 인입되면 원문도 같이 표기"). Closing on own-source detection removes
    // that window regardless of the coordinator state.
    if (isSameLanguageEcho(finalSource, rawTranslation, targetLanguage)) return;
    // Cross-channel echo guard (see emitPartial): suppress when this committed
    // line is verbatim another channel's source — Gemini's transliterated
    // same-language echo.
    if (echoRegistry?.outputEchoesAnotherSource?.(targetLanguage, rawTranslation)) return;
    const coordinatedSourceLanguage = sourceLanguageCoordinator?.resolved(finalSource);
    const sourceLanguage = coordinatedSourceLanguage && coordinatedSourceLanguage !== "unknown"
      ? coordinatedSourceLanguage
      : detectSourceLanguage(finalSource, { minimumSignalChars: 1 });
    // One channel per output language now handles every source → target, so
    // there is no per-key role split to gate on. translationRole is still used
    // only as the same-language / membership suppressor (null = don't show).
    const translationRole = translationRoleForSource(sourceLanguage, targetLanguage, settings);
    if (!translationRole) return;
    const finalized = await finalizer.finalize({
      translatedText: rawTranslation,
      sourceText: finalSource,
      sourceLanguage,
      targetLanguage,
    });
    if (!finalized) return;
    if (channelClosed) return;
    // Deterministic glossary enforcement is the guaranteed safety net and runs
    // on EVERY committed line — polished or raw. A large glossary is not reliably
    // applied in full by the LLM polisher (it nails common words but drops rarer
    // registered terms / acronyms), so this pass enforces the exact term pairs
    // and translation-memory matches afterward. Partials intentionally use only
    // exact registered-alias repair; fuzzy/context retrieval is final-only so an
    // unstable partial cannot rewrite an ordinary sentence.
    const repairedSource = finalized.sourceText;
    const finalTranslation = stripSubtitlePrefix(finalized.text);
    if (!isOutputInTargetLanguage(finalTranslation, targetLanguage)) {
      noteTargetLanguageViolation();
      return;
    }
    // Echo guard: a real translation is never identical to its own source. If
    // the model passed the input through unchanged — e.g. English spoken on the
    // EN channel after the speaker switches ko→en, so the "translation" is just
    // the English source — suppress it so the source text never appears as a
    // subtitle ("영어가 영어로 원문 자막").
    if (isSourceEcho(finalSource, finalTranslation)) return;
    broadcast({
      type: "subtitle:committed",
      source,
      targetLanguage,
      sourceLanguage,
      translationRole,
      translationProvider: "gemini",
      sourceText: repairedSource,
      ...(repairedSource !== finalSource ? { rawSourceText: finalSource } : {}),
      translatedText: finalTranslation,
    });
    if (rawMatchesTargetLanguage) consecutiveTargetLanguageViolations = 0;
    else noteTargetLanguageViolation();
  }

  function noteTargetLanguageViolation() {
    consecutiveTargetLanguageViolations += 1;
    if (consecutiveTargetLanguageViolations < 2 || languageDriftRestartPending) return;
    languageDriftRestartPending = true;
    consecutiveTargetLanguageViolations = 0;
    // A resumption handle preserves the contaminated model context. Drop it so
    // the reconnect starts a genuinely fresh translation session.
    resumptionHandle = null;
    broadcast({
      type: "subtitle:error",
      message: `번역 모델이 ${targetLanguage} 이외의 언어를 반복 출력하여 새 세션으로 재연결합니다.`,
      code: "TRANSLATION_LANGUAGE_DRIFT",
      source,
      targetLanguage,
    });
    broadcast({ type: "subtitle:status", status: "reconnecting", source, targetLanguage });
    queueMicrotask(() => {
      if (intentionalClose || !socket) return;
      socket.close();
    });
  }

  function isProviderOutputLanguageAllowed(languageCode) {
    const rawLanguageCode = String(languageCode ?? "").trim().toLowerCase();
    if (!rawLanguageCode || rawLanguageCode === "und") return true;
    return normalizeProviderLanguageCode(rawLanguageCode) === targetLanguage;
  }

  function noteProviderOutputLanguageViolation() {
    if (providerOutputLanguageViolationRecorded) return;
    providerOutputLanguageViolationRecorded = true;
    noteTargetLanguageViolation();
  }

  function resetUtterance({ preserveSilenceClear = false } = {}) {
    clearCommitTimer();
    clearPartialTimer();
    if (partialStaleTimer) { clearTimeout(partialStaleTimer); partialStaleTimer = null; }
    if (!preserveSilenceClear && silenceClearTimer) { clearTimeout(silenceClearTimer); silenceClearTimer = null; }
    sourceLanguageCoordinator?.reset?.();
    echoRegistry?.resetSource?.(targetLanguage);
    sourceText = "";
    translatedText = "";
    lastEmittedPartial = "";
    sourceLanguageHint = "unknown";
    sourceLanguageBuffer = "";
    partialHoldStartedAt = 0;
    sourceTranscriptFinalized = false;
    sourceLanguageIsStrong = false;
    providerOutputLanguageViolationRecorded = false;
    hasObservedSpeechAudio = false;
    lastClearReason = "";
  }

  function clearCommitTimer() {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = null;
  }

  function clearSetupAckTimer() {
    if (setupAckTimer) clearTimeout(setupAckTimer);
    setupAckTimer = null;
  }

  function armSetupAckTimer() {
    if (!transport.requiresSetupAck) return;
    clearSetupAckTimer();
    setupAckTimer = setTimeout(() => {
      setupAckTimer = null;
      if (configured || channelClosed || intentionalClose) return;
      log.warn?.(`[subtitle] Gemini setup ack timed out for ${source}/${targetLanguage}`);
      broadcast({
        type: "subtitle:error",
        message: `Gemini Live 세션 준비 응답이 지연되어 재연결합니다 (${source}/${targetLanguage}).`,
        code: "TRANSLATION_SETUP_TIMEOUT",
      });
      broadcast({ type: "subtitle:status", status: "reconnecting", source, targetLanguage });
      if (socket && socket.readyState === WebSocket.CONNECTING) socket.terminate?.();
      else socket?.close();
    }, setupAckTimeoutMs);
  }

  function clearPartialTimer() {
    if (partialTimer) clearTimeout(partialTimer);
    partialTimer = null;
  }

  // Abandoned-turn buffer reset: when a partial stops growing without ever
  // committing (Gemini sent no turnComplete), reset only the SERVER buffer so the
  // next utterance starts clean (no stale concatenation) — but do NOT clear the
  // on-screen subtitle. Per the desired UX, a subtitle should REMAIN visible
  // during a silence gap and only be replaced when new speech actually arrives;
  // the frontend owns that display lifecycle. Echoes (wrong content) are removed
  // separately by the cross-channel/clearEcho guards, not here.
  function armPartialStaleClear(snapshotText) {
    if (partialStaleTimer) clearTimeout(partialStaleTimer);
    partialStaleTimer = setTimeout(() => {
      partialStaleTimer = null;
      if (channelClosed) return;
      if (translatedText.trim() !== snapshotText) return; // grew → still live
      // Only reset on GENUINE silence. During continuous speech the model's
      // output stream has natural micro-gaps (between sentences/chunks) while
      // audio keeps flowing — resetting then would fragment the translation into
      // tiny pieces ("있습니다." alone). If audio is still arriving, keep the
      // buffer and re-check; reset only once the speaker has actually paused.
      if (Date.now() - lastAudioAt < PARTIAL_STALE_CLEAR_MS) {
        armPartialStaleClear(snapshotText);
        return;
      }
      translatedText = "";
      lastEmittedPartial = "";
    }, PARTIAL_STALE_CLEAR_MS);
  }

  // Re-armed on every NEW content delta (source or output). If it ever fires, no new
  // content has arrived for SILENCE_CLEAR_MS → the speaker stopped → end the subtitle:
  // reset the buffers AND clear the on-screen subtitle so it doesn't linger/grow forever.
  function bumpContentActivity() {
    if (silenceClearTimer) clearTimeout(silenceClearTimer);
    silenceClearTimer = setTimeout(() => {
      silenceClearTimer = null;
      if (channelClosed) return;
      sourceText = "";
      translatedText = "";
      lastEmittedPartial = "";
      sourceLanguageBuffer = "";
      sourceLanguageCoordinator?.reset?.();
      echoRegistry?.resetSource?.(targetLanguage);
      sourceLanguageHint = "unknown";
      sourceLanguageIsStrong = false;
      // clearTargetSubtitle de-duplicates by reason, and only resetUtterance() resets
      // that memo. A silence timeout is not a commit, so two consecutive silences with
      // no commit in between would suppress the SECOND subtitle:clear and leave the
      // lane on screen until the frontend's 15s stale timeout instead of the 3s spec.
      lastClearReason = "";
      clearTargetSubtitle("silence");
    }, SILENCE_CLEAR_MS);
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

  function scheduleCommit(delayMilliseconds = SUBTITLE_COMMIT_MS) {
    clearCommitTimer();
    commitTimer = setTimeout(() => {
      const subtitle = normalizedSubtitle();
      if (subtitle.translatedText && shouldCommit()) {
        void commitSubtitle(subtitle);
        resetUtterance({ preserveSilenceClear: true });
      } else if (resolvedSourceLanguage() !== "unknown") {
        resetUtterance();
      }
      commitTimer = null;
    }, delayMilliseconds);
  }

  function normalizedSubtitle() {
    return {
      sourceText: sourceText.trim(),
      translatedText: translatedText.trim(),
    };
  }

  function shouldDisplay(options = {}) {
    const sourceLanguage = resolvedSourceLanguage(options);
    if (sourceLanguage === "unknown") return false;
    const translationRole = translationRoleForSource(sourceLanguage, targetLanguage, settings);
    if (!translationRole) return false;
    return isOutputInTargetLanguage(translatedText, targetLanguage);
  }

  function shouldCommit() {
    const sourceLanguage = resolvedSourceLanguage({ allowShortSource: true });
    if (sourceLanguage === "unknown") return false;
    return Boolean(translationRoleForSource(sourceLanguage, targetLanguage, settings));
  }

  function resolvedSourceLanguage(options = {}) {
    if (!sourceText.trim()) return "unknown";
    // Cross-channel consensus wins: it resists a single channel's hallucinated
    // source-language flip (Gemini langCode contradicting its sibling) that would
    // otherwise make this channel echo the source or show the wrong direction.
    const coordinated = sourceLanguageCoordinator?.resolved(sourceText);
    const arbitrated = echoRegistry?.resolveSource?.(coordinated ?? "unknown", {
      isStrong: sourceLanguageIsStrong,
      channelKey: targetLanguage,
    });
    if (arbitrated && arbitrated !== "unknown") return arbitrated;
    if (coordinated && coordinated !== "unknown") return coordinated;
    if (options.allowShortSource) return detectSourceLanguage(sourceText, { minimumSignalChars: 1 });
    return sourceLanguageHint === "unknown" ? detectSourceLanguage(sourceText) : sourceLanguageHint;
  }

  function ownDetectedSourceLanguage() {
    if (!sourceText.trim()) return "unknown";
    const coordinated = sourceLanguageCoordinator?.resolved(sourceText);
    if (coordinated && coordinated !== "unknown") return coordinated;
    return detectSourceLanguage(sourceText, { minimumSignalChars: 1 });
  }

  function deferPartialForSourceArbitration() {
    if (!translatedText.trim()) return;
    if (!partialHoldStartedAt) partialHoldStartedAt = Date.now();
    const maxWaitMs = sourceConsensusContract.holdMilliseconds + partialMaxHoldMs();
    const elapsed = Date.now() - partialHoldStartedAt;
    if (elapsed >= maxWaitMs) return;
    clearPartialTimer();
    partialTimer = setTimeout(() => {
      partialTimer = null;
      if (translatedText.trim()) emitPartial({ force: true });
    }, Math.min(PARTIAL_STABILITY_MS, maxWaitMs - elapsed));
  }

  function rememberSourceTranscriptDelta(delta, languageCode) {
    sourceTranscriptFinalized = false;
    if (String(delta ?? "").trim()) bumpContentActivity();
    sourceLanguageBuffer = boundTranscript(`${sourceLanguageBuffer}${delta ?? ""}`);
    const languageFromProvider = normalizeProviderLanguageCode(languageCode);
    const providerLanguage = sourceLanguageCoordinator?.apply(languageFromProvider) ?? languageFromProvider;
    const evidence = sourceLanguageCoordinator?.observe({
      providerLanguage,
      transcript: delta,
    }) ?? { language: detectSourceLanguage(sourceLanguageBuffer), isStrong: false };
    applySourceLanguage(evidence.language, { ...evidence, recentText: String(delta ?? "") });
  }

  function rememberSourceTranscriptSnapshot(transcript, previousTranscript = "") {
    sourceTranscriptFinalized = true;
    const nextTranscript = String(transcript ?? "");
    const previous = String(previousTranscript ?? "");
    const recentTranscript = previous && nextTranscript.startsWith(previous)
      ? nextTranscript.slice(previous.length)
      : previous && nextTranscript.endsWith(previous)
        ? previous
      : nextTranscript;
    if (previous && nextTranscript.endsWith(previous) && !nextTranscript.startsWith(previous)) {
      sourceText = boundTranscript(previous);
    }
    const evidence = sourceLanguageCoordinator?.observe({
      transcript: recentTranscript,
    }) ?? { language: detectSourceLanguage(recentTranscript || nextTranscript), isStrong: false };
    applySourceLanguage(evidence.language, { ...evidence, recentText: recentTranscript });
  }

  // A genuine direction switch is about to clear this channel's in-progress
  // translation. If that translation is ALREADY ON SCREEN (an emitted partial),
  // finalize it as a committed line first — the sentence COMPLETES in the
  // language it started in instead of vanishing or flipping mid-display
  // ("중간에 변경되는 경우는 없도록"). Skips the LLM polish (must land before the
  // new direction's first partial) but keeps the deterministic glossary pass.
  // The emitted partial already passed every echo/direction guard when it was
  // first broadcast, so re-deriving them here would only re-judge it against
  // the NEW direction's mixed source and wrongly suppress it.
  function flushEmittedPartialAsCommitted(previousSourceLanguage) {
    const emitted = lastEmittedPartial.trim();
    if (!emitted || channelClosed) return;
    const translationRole = translationRoleForSource(previousSourceLanguage, targetLanguage, settings);
    if (!translationRole) return;
    lastEmittedPartial = "";
    const repairedSource = termRetriever.repair(sourceText.trim(), {
      language: previousSourceLanguage,
      isFinal: true,
    });
    const terminologyCorrected = applyGlossaryCorrections(emitted, {
      glossary: translationContext.glossary,
      targetLanguage,
      sourceText: repairedSource,
    });
    const finalTranslation = stripSubtitlePrefix(normalizeCommittedCreCaption({
      text: terminologyCorrected,
      targetLanguage,
      isFinal: true,
    }));
    broadcast({
      type: "subtitle:committed",
      source,
      targetLanguage,
      sourceLanguage: previousSourceLanguage,
      translationRole,
      translationProvider: "gemini",
      sourceText: repairedSource,
      ...(repairedSource !== sourceText.trim() ? { rawSourceText: sourceText.trim() } : {}),
      translatedText: finalTranslation,
    });
  }

  function applySourceLanguage(detectedLanguage, evidence = {}) {
    // Report THIS channel's detected source to the cross-channel arbiter, then act on
    // the arbitrated (consensus) source — not this channel's raw detection — so a lone
    // hallucinated flip can't make us echo the source / show both directions.
    sourceLanguageIsStrong = evidence.isStrong === true;
    const recentText = String(evidence.recentText ?? "");
    const reportText = recentText.trim() ? recentText : sourceText;
    if (detectedLanguage && detectedLanguage !== "unknown") {
      echoRegistry?.reportSource?.(targetLanguage, detectedLanguage, reportText, { isStrong: sourceLanguageIsStrong });
    }
    const sourceLanguage = echoRegistry?.resolveSource?.(detectedLanguage, {
      isStrong: sourceLanguageIsStrong,
      channelKey: targetLanguage,
    }) ?? detectedLanguage;
    if (sourceLanguage === "unknown") return;
    const outputLanguage = detectCaptionLanguage(translatedText, { minimumSignalChars: 1 });
    // Direction switch with a correct-language subtitle on screen → complete
    // that sentence as a committed line before any clearing below.
    if (
      sourceLanguageHint !== "unknown"
      && sourceLanguageHint !== sourceLanguage
      && sourceLanguageHint !== targetLanguage
      && (outputLanguage === "unknown" || outputLanguage === targetLanguage)
    ) {
      flushEmittedPartialAsCommitted(sourceLanguageHint);
    }
    const hasDirectionSwitch = sourceLanguageHint !== "unknown" && sourceLanguageHint !== sourceLanguage;
    if (hasDirectionSwitch) {
      if (settings.audioLanguage === targetLanguage && AUDIO_OUTPUT_MODES.has(settings.outputMode)) {
        broadcast({
          type: "subtitle:audio-control",
          action: "clear",
          source,
          targetLanguage,
          reason: "source_language_changed",
        });
      }
      clearCommitTimer();
      clearPartialTimer();
      if (partialStaleTimer) {
        clearTimeout(partialStaleTimer);
        partialStaleTimer = null;
      }
      translatedText = "";
      lastEmittedPartial = "";
      partialHoldStartedAt = 0;
      sourceTranscriptFinalized = false;
    }
    if (hasDirectionSwitch && recentText.trim()) {
      sourceText = boundTranscript(recentText);
      sourceLanguageBuffer = "";
    }
    if (outputLanguage !== "unknown" && outputLanguage !== targetLanguage) {
      translatedText = "";
    }
    if (sourceLanguage === targetLanguage) {
      translatedText = "";
      clearTargetSubtitle("same_language_source");
    } else if (sourceLanguageHint !== "unknown" && sourceLanguageHint !== sourceLanguage && sourceLanguageHint === targetLanguage) {
      translatedText = "";
      clearTargetSubtitle("source_language_changed");
    }
    sourceLanguageHint = sourceLanguage;
    sourceLanguageBuffer = "";
    // Publish only the current direction's source segment. Keeping pre-switch
    // text here makes a sibling's echo detector and future script votes inherit
    // the previous language indefinitely during continuous speech.
    echoRegistry?.recordSource?.(targetLanguage, sourceText);
  }

  function clearTargetSubtitle(reason) {
    if (lastClearReason === reason) return;
    lastClearReason = reason;
    broadcast({
      type: "subtitle:clear",
      source,
      targetLanguage,
      reason,
      translationProvider: "gemini",
    });
  }

  // Invoked by a sibling channel (via the coordinator) when it records a clean
  // source that this channel just echoed — clears the racing echo partial fast.
  function clearEcho() {
    translatedText = "";
    lastEmittedPartial = "";
    partialEchoCooldownUntil = Date.now() + 2500;
    if (partialStaleTimer) { clearTimeout(partialStaleTimer); partialStaleTimer = null; }
    clearTargetSubtitle("cross_channel_echo");
  }
  echoRegistry?.registerChannel?.(targetLanguage, {
    clearEcho,
    getLastPartial: () => lastEmittedPartial,
  });

  function isPartialDisplayReady() {
    const translated = translatedText.trim();
    if (!translated) return false;
    if (sourceTranscriptFinalized && countLanguageSignalChars(translated) >= 4) return true;
    if (/[.!?。！？…]$/.test(translated)) return true;
    return countLanguageSignalChars(translated) >= GEMINI_PARTIAL_MIN_SIGNAL_CHARS
      && partialHoldStartedAt > 0
      && Date.now() - partialHoldStartedAt >= partialMaxHoldMs();
  }

  function schedulePartialFlush() {
    if (!translatedText.trim()) return;
    if (!partialHoldStartedAt) partialHoldStartedAt = Date.now();
    clearPartialTimer();
    if (isPartialDisplayReady()) {
      emitPartial({ force: true });
      return;
    }
    const elapsed = Date.now() - partialHoldStartedAt;
    const maxHoldMs = partialMaxHoldMs();
    if (elapsed >= maxHoldMs) {
      partialHoldStartedAt = 0;
      return;
    }
    const waitMs = Math.max(0, Math.min(PARTIAL_STABILITY_MS, maxHoldMs - elapsed));
    partialTimer = setTimeout(() => {
      partialTimer = null;
      if (isPartialDisplayReady()) emitPartial({ force: true });
      else schedulePartialFlush();
    }, waitMs);
  }

  function partialMaxHoldMs() {
    return GEMINI_PARTIAL_MAX_HOLD_MS;
  }

  function emitPartial({ force = false } = {}) {
    // Cooldown after a detected echo: stay commit-only briefly so a wrong-
    // direction echo can't keep flashing while the speaker holds this language.
    if (Date.now() < partialEchoCooldownUntil) { clearPartialTimer(); return; }
    // The speaker is now talking THIS channel's target language, so any pending
    // translation is a stale leftover from the previous opposite-direction turn
    // that never finalized (Gemini sent no turnComplete). Drop it so it stops
    // re-appearing — this channel cannot translate target→target. The coordinator
    // is PER-CHANNEL (see createTranslationChannel), so it reflects this channel's
    // own source language and is not polluted by the sibling channel.
    const ownSourceLanguage = ownDetectedSourceLanguage();
    const resolvedLanguage = resolvedSourceLanguage();
    if (resolvedLanguage === targetLanguage) {
      if (ownSourceLanguage !== "unknown" && ownSourceLanguage !== targetLanguage) {
        deferPartialForSourceArbitration();
        return;
      }
      translatedText = "";
      lastEmittedPartial = "";
      clearPartialTimer();
      return;
    }
    if (!shouldDisplay()) {
      if (ownSourceLanguage !== "unknown" && ownSourceLanguage !== targetLanguage) deferPartialForSourceArbitration();
      return;
    }
    const subtitle = normalizedSubtitle();
    if (!subtitle.translatedText) return;
    if (isSameLanguageEcho(subtitle.sourceText, subtitle.translatedText, targetLanguage)) return;
    if (isSourceEcho(subtitle.sourceText, subtitle.translatedText)) return;
    // Cross-channel echo: Gemini transliterates same-language audio and echoes it
    // back (English audio → ko-transliterated source on the EN channel → English
    // output). If this output is verbatim another channel's clean source, it is
    // the source itself, not a translation — suppress it.
    if (echoRegistry?.outputEchoesAnotherSource?.(targetLanguage, subtitle.translatedText)) return;
    if (!force && !isPartialDisplayReady()) return;
    // Never re-broadcast an unchanged partial: a turn that froze mid-translation
    // (no turnComplete) would otherwise re-emit the same line repeatedly and
    // flicker on screen (clear → re-appear → clear) during a language switch.
    if (subtitle.translatedText === lastEmittedPartial) return;
    const sourceLanguage = resolvedSourceLanguage();
    const translationRole = translationRoleForSource(sourceLanguage, targetLanguage, settings);
    if (!translationRole) return;
    // Partials stay on the O(registered aliases) fast path. Fuzzy/context
    // retrieval is final-only so a large local glossary cannot add frame-time
    // work or rewrite a still-growing ordinary phrase.
    const repairedSource = termRetriever.repair(subtitle.sourceText, {
      language: sourceLanguage,
      isFinal: false,
    });
    const correctedTranslation = stripSubtitlePrefix(termRetriever.repair(subtitle.translatedText, {
      language: targetLanguage,
      isFinal: false,
    }));
    lastEmittedPartial = subtitle.translatedText;
    clearPartialTimer();
    armPartialStaleClear(subtitle.translatedText);
    broadcast({
      type: "subtitle:partial",
      source,
      targetLanguage,
      sourceLanguage,
      translationRole,
      translationProvider: "gemini",
      ...subtitle,
      sourceText: repairedSource,
      translatedText: correctedTranslation,
    });
    partialHoldStartedAt = 0;
  }

  function markTransportReady() {
    if (!socket || channelClosed) return;
    clearSetupAckTimer();
    configured = true;
    // A live (re)connection succeeded — reset the auto-reconnect backoff.
    reconnectAttempts = 0;
    reconnectErrorSurfaced = false;
    languageDriftRestartPending = false;
    const cutoff = Date.now() - MAX_PENDING_AUDIO_AGE_MS;
    for (const pending of pendingAudio) {
      if (pending.enqueuedAt >= cutoff) socket.send(transport.audioPayload(pending.audio));
    }
    pendingAudio = [];
  }

  // Auto-reconnect after a server-side drop / Gemini duration cap so a long
  // session keeps running through silence gaps too (the lazy reconnect-on-next-
  // audio only fires while someone is speaking). Bounded backoff; a successful
  // setup resets the counter via markTransportReady.
  function scheduleReconnect() {
    if (intentionalClose || reconnectTimer) return;
    // Never permanently give up unless the user deliberately stops: after the
    // fast backoff is exhausted, keep retrying at the max interval forever so
    // the session self-heals whenever the network/API recovers. Surface the
    // problem ONCE (no error spam) when we cross into that slow-retry mode.
    const exhausted = reconnectAttempts >= MAX_AUTO_RECONNECTS;
    if (exhausted && !reconnectErrorSurfaced) {
      reconnectErrorSurfaced = true;
      broadcast({
        type: "subtitle:error",
        message: `번역 세션 재연결을 계속 시도하고 있습니다 (${source}/${targetLanguage}). 네트워크와 API 키를 확인하세요 — 복구되면 자동으로 다시 재생됩니다.`,
        code: "TRANSLATION_RECONNECTING",
      });
    }
    const delay = exhausted
      ? RECONNECT_MAX_MS
      : Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (intentionalClose) return;
      try {
        ensureSocket();
      } catch (error) {
        const safeDetail = redactTransportDiagnostic(error?.message ?? error);
        log.warn?.(`[subtitle] reconnect failed for ${source}/${targetLanguage}: ${safeDetail}`);
        scheduleReconnect();
      }
    }, delay);
  }

  function ensureSocket() {
    if (socket) return socket;
    if (!String(apiKey ?? "").trim()) {
      broadcast({ type: "subtitle:error", message: "실시간 자막에는 Gemini API 키가 필요합니다.", code: "GEMINI_KEY_REQUIRED" });
      throw new Error("Gemini API key is required for realtime subtitles.");
    }

    socket = transport.connect({ createWebSocket });
    // A fresh socket means the channel is live again (reconnect after a drop
    // or the Gemini 15-minute session cap) — lift the teardown guard so
    // markTransportReady and commitSubtitle work for the new session.
    channelClosed = false;

    const openedSocket = socket;
    const ownsOpenedSocket = () => socket === openedSocket && !channelClosed;
    socket.on("open", () => {
      // A late "open" from a socket the channel already tore down (close()
      // raced the connect) must not touch the channel's current state.
      if (!ownsOpenedSocket()) return;
      for (const payload of transport.setupPayloads({ resumptionHandle })) socket.send(payload);
      // Providers with a setup handshake (Gemini Live) reject input sent
      // before the server acks setup; hold audio until onTransportReady.
      if (transport.requiresSetupAck) {
        armSetupAckTimer();
        return;
      }
      markTransportReady();
    });

    socket.on("message", (raw) => {
      // A replaced/resumed Gemini socket can still flush queued callbacks.
      // Only the currently-owned generation may publish captions or audio.
      if (!ownsOpenedSocket()) return;
      transport.handleMessage(raw.toString("utf8"), {
        source,
        targetLanguage,
        outputMode: settings.audioLanguage === targetLanguage
          && AUDIO_OUTPUT_MODES.has(settings.outputMode)
          ? settings.outputMode
          : "captions",
        // Opt-in raw-transcript debugging (no disk persistence — WS only) so a
        // real-mic echo/mangle can be diagnosed from Gemini's actual input/output.
        debug: Boolean(settings.debugTranscripts),
        getSourceText: () => sourceText,
        setSourceText: (value) => { sourceText = value; },
        getTranslatedText: () => translatedText,
        setTranslatedText: (value) => { if (String(value ?? "").trim()) bumpContentActivity(); translatedText = value; },
        shouldDisplay,
        shouldCommit,
        isProviderOutputLanguageAllowed,
        noteProviderOutputLanguageViolation,
        shouldEmitAudio: () => {
          const language = resolvedSourceLanguage({ allowShortSource: true });
          return language === "unknown" || language !== targetLanguage;
        },
        rememberSourceTranscriptDelta,
        rememberSourceTranscriptSnapshot,
        emitPartial,
        schedulePartialFlush,
        scheduleCommit,
        commitSubtitle,
        resetUtterance,
        onSessionClosed: finishClose,
        suppressTranscripts: false,
        onOutputAudio: settings.audioLanguage === targetLanguage
          && AUDIO_OUTPUT_MODES.has(settings.outputMode)
          ? (audio) => broadcast({
            type: "subtitle:translated-audio",
            source,
            targetLanguage,
            sampleRate: 24_000,
            mimeType: "audio/pcm;rate=24000",
            audio,
          })
          : undefined,
        onTransportReady: markTransportReady,
        getResumptionHandle: () => resumptionHandle,
        setResumptionHandle: (handle) => { if (handle) resumptionHandle = handle; },
        onServerGoAway: () => { if (socket && !intentionalClose) socket.close(); },
        broadcast,
      });
    });

    socket.on("error", (error) => {
      if (!ownsOpenedSocket()) return;
      const detail = redactTransportDiagnostic(error?.message ?? error);
      log.warn?.(`[subtitle] realtime translation socket error for ${source}/${targetLanguage}: ${detail}`);
      // "reconnecting" alone hides the real cause from the user (console logs
      // are invisible in a packaged exe). Surface each distinct error once,
      // with corporate-network guidance where the pattern is recognizable.
      if (detail !== lastSurfacedSocketError) {
        lastSurfacedSocketError = detail;
        const guidance = describeSocketError(detail);
        broadcast({
          type: "subtitle:error",
          message: `연결 오류 (${source}/${targetLanguage}): ${detail}${guidance ? ` — ${guidance}` : ""}`,
          code: "TRANSLATION_SOCKET_ERROR",
        });
      }
      broadcast({ type: "subtitle:status", status: "reconnecting", source, targetLanguage });
      // close() on a still-CONNECTING socket makes ws emit a synthetic
      // "closed before the connection was established" error that masks the
      // real cause — terminate tears it down silently.
      if (socket && socket.readyState === WebSocket.CONNECTING) socket.terminate?.();
      else socket?.close();
    });

    // Corporate proxies answer the WebSocket upgrade with a block page
    // (403/407/302) instead of 101 — ws reports that via "unexpected-response"
    // and otherwise stalls silently. Surface the HTTP status as the diagnosis.
    socket.on("unexpected-response", (_request, response) => {
      if (!ownsOpenedSocket()) return;
      const detail = `HTTP ${response?.statusCode ?? "?"} ${response?.statusMessage ?? ""}`.trim();
      log.warn?.(`[subtitle] websocket upgrade blocked for ${source}/${targetLanguage}: ${detail}`);
      broadcast({
        type: "subtitle:error",
        message: `연결이 차단되었습니다 (${source}/${targetLanguage}): ${detail} — 네트워크 프록시/보안 장비가 WebSocket 연결을 차단했습니다. IT에 generativelanguage.googleapis.com 허용을 요청하거나 휴대폰 핫스팟으로 확인해 보세요.`,
        code: "TRANSLATION_SOCKET_BLOCKED",
      });
      broadcast({ type: "subtitle:status", status: "reconnecting", source, targetLanguage });
      socket?.terminate?.();
    });

    socket.on("close", (code, reason) => {
      if (!ownsOpenedSocket()) return;
      if (settings.audioLanguage === targetLanguage && AUDIO_OUTPUT_MODES.has(settings.outputMode)) {
        broadcast({
          type: "subtitle:audio-control",
          action: "clear",
          source,
          targetLanguage,
          reason: intentionalClose ? "close" : "reconnect",
        });
      }
      // Abnormal closes carry the provider's rejection reason (depleted
      // credits, bad setup, auth) — log AND surface it so failures are
      // diagnosable by the user instead of looking like silent no-subtitles.
      if (code && code !== 1000 && code !== 1005) {
        const safeReason = redactTransportDiagnostic(reason?.toString?.("utf8") ?? "");
        log.warn?.(`[subtitle] translation socket closed for ${source}/${targetLanguage}: code=${code} reason=${safeReason}`);
        if (safeReason) {
          broadcast({
            type: "subtitle:error",
            message: `Translation session closed (${code}): ${safeReason}`,
            code: "TRANSLATION_SOCKET_CLOSED",
          });
        }
      }
      channelClosed = true;
      clearCommitTimer();
      clearSetupAckTimer();
      if (silenceClearTimer) { clearTimeout(silenceClearTimer); silenceClearTimer = null; }
      clearCloseTimer();
      const resolve = closeResolve;
      closeResolve = null;
      socket = null;
      configured = false;
      pendingAudio = [];
      resetUtterance();
      resolve?.();
      // Server-side drop or duration/lifetime cap (not a deliberate stop):
      // reconnect — with the Gemini resumption handle — to keep the session
      // alive for hours. Auth/credit failures surface as errors and the bounded
      // backoff stops the loop after MAX_AUTO_RECONNECTS.
      if (!intentionalClose) scheduleReconnect();
    });

    return socket;
  }

  return {
    open() {
      try {
        ensureSocket();
      } catch (error) {
        const safeDetail = redactTransportDiagnostic(error?.message ?? error);
        log.warn?.(`[subtitle] failed to open realtime translation socket for ${source}/${targetLanguage}: ${safeDetail}`);
      }
    },
    sendAudio(audio) {
      const hasSpeechSignal = pcm16HasSpeechSignal(audio);
      if (hasSpeechSignal) {
        lastAudioAt = Date.now();
        hasObservedSpeechAudio = true;
        clearCommitTimer();
      } else if (hasObservedSpeechAudio && !commitTimer && translatedText.trim()) {
        scheduleCommit(GEMINI_AUDIO_SILENCE_COMMIT_MS);
      }
      let connection;
      try {
        connection = ensureSocket();
      } catch (error) {
        const safeDetail = redactTransportDiagnostic(error?.message ?? error);
        log.warn?.(`[subtitle] failed to open realtime translation socket for ${source}/${targetLanguage}: ${safeDetail}`);
        return;
      }
      if (!configured) {
        const enqueuedAt = Date.now();
        pendingAudio.push({ audio, enqueuedAt });
        pendingAudio = pendingAudio.filter((pending) => enqueuedAt - pending.enqueuedAt <= MAX_PENDING_AUDIO_AGE_MS);
        if (pendingAudio.length > MAX_PENDING_AUDIO_CHUNKS) {
          pendingAudio.splice(0, pendingAudio.length - MAX_PENDING_AUDIO_CHUNKS);
        }
        return;
      }
      // Shed live audio while the socket send buffer is backed up (see
      // AUDIO_BACKPRESSURE_MAX_BUFFERED_BYTES) so the session stays realtime
      // instead of accumulating an ever-growing in-memory queue and stalling.
      if ((connection.bufferedAmount ?? 0) > AUDIO_BACKPRESSURE_MAX_BUFFERED_BYTES) {
        if (!backpressureShedding) {
          backpressureShedding = true;
          log.warn?.(`[subtitle] translation socket backed up for ${source}/${targetLanguage} (${connection.bufferedAmount} bytes buffered); dropping live audio to stay realtime`);
          // Viewers see a "degraded" badge instead of wondering why subtitles
          // lag — the session is alive, audio is being shed to stay realtime.
          broadcast({ type: "subtitle:status", status: "degraded", source, targetLanguage });
        }
        return;
      }
      if (backpressureShedding) {
        backpressureShedding = false;
        log.warn?.(`[subtitle] translation socket drained for ${source}/${targetLanguage}; resuming live audio`);
        broadcast({ type: "subtitle:status", status: "listening", source, targetLanguage });
      }
      connection.send(transport.audioPayload(audio));
    },
    async close({ graceful = false } = {}) {
      // Deliberate stop/reconfigure: suppress auto-reconnect and cancel any
      // pending reconnect timer.
      intentionalClose = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      channelClosed = true;
      clearCommitTimer();
      clearSetupAckTimer();
      if (silenceClearTimer) { clearTimeout(silenceClearTimer); silenceClearTimer = null; }
      const closeMessage = transport.closePayload?.();
      // Gemini Live has no explicit close handshake, so the socket closes
      // immediately after the committed-caption tail drains.
      if (graceful && socket && configured && closeMessage) {
        if (closeResolve) return new Promise((resolve) => {
          const previousResolve = closeResolve;
          closeResolve = () => {
            previousResolve();
            resolve();
          };
        });
        const currentSocket = socket;
        const closed = new Promise((resolve) => {
          closeResolve = resolve;
          closeTimer = setTimeout(finishClose, 3_000);
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

function sourcesForInputMode(inputMode) {
  if (inputMode === "system") return ["system"];
  if (inputMode === "mic") return ["mic"];
  return ["system", "mic"];
}

// SHARED cross-channel echo registry. Catches Gemini's same-language echo: when
// the audio is English, the EN-target channel hallucinates a Korean-transliterated
// source and echoes the English back, while the KO-target channel transcribes the
// SAME audio as clean English. If a channel's OUTPUT equals another channel's
// recorded SOURCE, that output is the source verbatim → an echo. This is the ONLY
// piece that is shared across the sibling channels.
export function createCrossChannelEchoRegistry() {
  const echoDeduper = createCrossChannelEchoDeduper();
  const sourceConsensus = createSourceLanguageConsensus();
  return {
    reportSource: sourceConsensus.reportSource,
    resolveSource: sourceConsensus.resolveSource,
    resetSource: sourceConsensus.resetSource,
    registerChannel: echoDeduper.registerChannel,
    recordSource: echoDeduper.recordSource,
    outputEchoesAnotherSource: echoDeduper.outputEchoesAnotherSource,
  };
}

function translationRoleForSource(sourceLanguage, targetLanguage, settings = {}) {
  if (sourceLanguage === "unknown" || sourceLanguage === targetLanguage) return null;
  const targets = normalizeTranslationLanguages(settings);
  if (!targets.includes(targetLanguage)) return null;
  let source = sourceLanguage;
  if (!targets.includes(source)) {
    // Script-detection can only name one language per script (Latin → "en").
    // When the detected language is not configured but exactly one configured
    // language shares its script, treat the source as that language — e.g.
    // Spanish speech (detected "en") in an es+ko session resolves to es.
    source = resolveConfiguredLanguageForScript(source, targets);
    if (!source || source === targetLanguage) return null;
  }
  if (targets.length < 3) return 1;
  // The classic en/ko/ja trio keeps its long-standing priority matrix verbatim.
  if (targets.length === 3 && ["en", "ko", "ja"].every((language) => targets.includes(language))) {
    const roleMatrix = {
      ko: { en: 1, ja: 2 },
      en: { ko: 1, ja: 2 },
      ja: { en: 1, ko: 2 },
    };
    return roleMatrix[source]?.[targetLanguage] ?? null;
  }
  // General N-language rule: priority follows the configured order among the
  // targets other than the source.
  const ordered = targets.filter((language) => language !== source);
  const index = ordered.indexOf(targetLanguage);
  return index === -1 ? null : index + 1;
}

function translationChannelConfigs(settings, apiKeys = {}) {
  const targets = languageTargets(settings);
  // One Gemini channel owns each target. A secondary Gemini key takes the back
  // half without duplicating a target lane.
  const secondaryKey = apiKeys.geminiSecondary;
  if (secondaryKey && targets.length >= 3) {
    const half = Math.ceil(targets.length / 2);
    return targets.map((targetLanguage, index) => ({ targetLanguage, apiKeyRole: index < half ? 1 : 2 }));
  }
  return targets.map((targetLanguage) => ({ targetLanguage }));
}

function selectGeminiApiKey({ apiKeys = {}, apiKeyRole }) {
  if (apiKeyRole === 2 && apiKeys.geminiSecondary) return apiKeys.geminiSecondary;
  return apiKeys.gemini;
}

function languageTargets(settings) {
  return normalizeTranslationLanguages(settings);
}

export function normalizeSubtitleSettings(settings = {}) {
  const mergedLanguagePair = {
    ...DEFAULT_SUBTITLE_SETTINGS.languagePair,
    ...(settings.languagePair ?? {}),
  };
  const normalizedPair = {
    a: normalizeLanguageCode(mergedLanguagePair.a) || "en",
    b: normalizeLanguageCode(mergedLanguagePair.b) || "ko",
  };
  const merged = {
    ...DEFAULT_SUBTITLE_SETTINGS,
    ...settings,
    languagePair: normalizedPair,
  };
  const translationFontSize = clampNumber(merged.translationFontSize, 14, 96, DEFAULT_SUBTITLE_SETTINGS.translationFontSize);
  const translationLanguageSource = Array.isArray(settings.translationLanguages)
    ? merged
    : { ...merged, translationLanguages: undefined };
  const translationLanguages = normalizeTranslationLanguages(translationLanguageSource);
  // captions_audio is retired, so it is not accepted here either -- a stale value
  // falls back to the default instead of reviving the mixed mode.
  const outputMode = ["captions", "audio"].includes(merged.outputMode)
    ? merged.outputMode
    : DEFAULT_SUBTITLE_SETTINGS.outputMode;
  const normalizedAudioLanguage = normalizeLanguageCode(merged.audioLanguage);
  const audioLanguage = translationLanguages.includes(normalizedAudioLanguage)
    ? normalizedAudioLanguage
    : translationLanguages[0];
  return {
    ...merged,
    inputMode: ["system", "mic", "system_mic"].includes(merged.inputMode) ? merged.inputMode : DEFAULT_SUBTITLE_SETTINGS.inputMode,
    languagePair: normalizedPair,
    translationLanguages,
    outputMode,
    translationProvider: "gemini",
    voiceProvider: "gemini",
    audioLanguage,
    audioVolume: clampNumber(merged.audioVolume, 0, 1, DEFAULT_SUBTITLE_SETTINGS.audioVolume),
    displayMode: ["translation_only", "translation_source"].includes(merged.displayMode)
      ? merged.displayMode
      : DEFAULT_SUBTITLE_SETTINGS.displayMode,
    showSourceText: typeof merged.showSourceText === "boolean" ? merged.showSourceText : DEFAULT_SUBTITLE_SETTINGS.showSourceText,
    translateAllLanguages: typeof merged.translateAllLanguages === "boolean"
      ? merged.translateAllLanguages || translationLanguages.length >= 3
      : translationLanguages.length >= 3,
    position: ["bottom-center", "top-center", "middle-center"].includes(merged.position) ? merged.position : DEFAULT_SUBTITLE_SETTINGS.position,
    model: normalizeRealtimeModel(merged.model),
    translationFontSize,
    sourceFontSize: clampNumber(merged.sourceFontSize, 14, 96, Math.max(14, translationFontSize - 2)),
    maxWidth: clampNumber(merged.maxWidth, 320, 3000, DEFAULT_SUBTITLE_SETTINGS.maxWidth),
    opacity: clampNumber(merged.opacity, 0.2, 1, DEFAULT_SUBTITLE_SETTINGS.opacity),
    maxSubtitleLines: Math.round(clampNumber(merged.maxSubtitleLines, 1, 8, DEFAULT_SUBTITLE_SETTINGS.maxSubtitleLines)),
    recordProvider: ["none", "ollama"].includes(merged.recordProvider) ? merged.recordProvider : DEFAULT_SUBTITLE_SETTINGS.recordProvider,
    tone: ["natural", "business"].includes(merged.tone) ? merged.tone : DEFAULT_SUBTITLE_SETTINGS.tone,
    glossary: typeof merged.glossary === "string" ? merged.glossary : DEFAULT_SUBTITLE_SETTINGS.glossary,
    translationDomain: typeof merged.translationDomain === "string" ? merged.translationDomain : DEFAULT_SUBTITLE_SETTINGS.translationDomain,
    verticalOffset: Math.round(clampNumber(merged.verticalOffset, 0, 600, DEFAULT_SUBTITLE_SETTINGS.verticalOffset)),
    tonePolishModel: typeof merged.tonePolishModel === "string" && merged.tonePolishModel.trim()
      ? merged.tonePolishModel.trim()
      : DEFAULT_SUBTITLE_SETTINGS.tonePolishModel,
    ollamaBaseURL: typeof merged.ollamaBaseURL === "string" ? merged.ollamaBaseURL : DEFAULT_SUBTITLE_SETTINGS.ollamaBaseURL,
    ollamaModel: typeof merged.ollamaModel === "string" && merged.ollamaModel.trim()
      ? merged.ollamaModel.trim()
      : DEFAULT_SUBTITLE_SETTINGS.ollamaModel,
    // Opt-in raw-transcript debugging (default off; no disk persistence).
    debugTranscripts: merged.debugTranscripts === true,
  };
}

function normalizeTranslationLanguages(settings = {}) {
  const normalizeList = (values) => Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((language) => normalizeLanguageCode(language))
      .filter((language) => isSupportedSubtitleLanguage(language)),
  ));
  const selected = normalizeList(settings.translationLanguages);
  if (selected.length >= 2) return selected.slice(0, MAX_TRANSLATION_LANGUAGES);
  const a = normalizeLanguageCode(settings.languagePair?.a) || "en";
  const b = normalizeLanguageCode(settings.languagePair?.b) || "ko";
  if (settings.translateAllLanguages) return ["en", "ko", "ja"];
  return Array.from(new Set([a, b])).slice(0, MAX_TRANSLATION_LANGUAGES);
}

export function normalizeRealtimeModel(model) {
  const value = String(model || "").trim();
  if (!value || value.startsWith("gpt-")) return DEFAULT_SUBTITLE_SETTINGS.geminiModel;
  return value;
}

// Collapse whitespace + drop punctuation/casing so an echoed line is detected
// regardless of trivial formatting differences.
function normalizeEchoText(text) {
  return String(text ?? "")
    .replace(/\s+/gu, "")
    .replace(/[.,!?;:。、！？…·"'`]/gu, "")
    .trim()
    .toLowerCase();
}

// True when the "translation" is just the source passed through unchanged (a
// same-language echo). A genuine translation is never identical to its source,
// so this only fires on passthrough — e.g. English on the EN channel after the
// speaker switches ko→en. Requires a little signal to avoid suppressing tiny
// shared tokens.
export function isSourceEcho(sourceText, translatedText) {
  const src = normalizeEchoText(sourceText);
  const out = normalizeEchoText(translatedText);
  if (!src || !out || src !== out) return false;
  return countLanguageSignalChars(String(translatedText ?? "")) >= 2;
}

export { applyGlossaryCorrections };

function resolveSubtitleTranslationContext(settings) {
  const config = settings._captionConfig ?? createGeminiCaptionConfig(settings);
  return {
    glossary: config.glossary,
    domain: config.domain,
  };
}
// Script signals: Hangul → ko, kana → ja, Latin → en. CJK ideographs count
// toward Japanese — modern Korean rarely uses hanja, and in a KO↔JA session
// kanji-bearing text is Japanese.
const KOREAN_CHAR = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
const JAPANESE_CHAR = /[ぁ-んァ-ヶーｱ-ﾝ一-龯々]/;
const ENGLISH_CHAR = /[A-Za-z]/;

// Maps raw socket errors to actionable Korean guidance. Corporate Windows
// machines are the usual source: SSL-inspecting proxies break Node TLS
// (which ignores the OS certificate store), and locked-down networks require
// an HTTP proxy that ws does not pick up automatically.
export function describeSocketError(message) {
  const text = String(message ?? "");
  if (/certificat|self.signed|CERT_|UNABLE_TO_VERIFY/i.test(text)) {
    return "회사 보안 프록시(SSL 검사)가 연결을 가로채는 것으로 보입니다. IT에 generativelanguage.googleapis.com 허용(SSL 검사 제외)을 요청하거나, NODE_EXTRA_CA_CERTS 환경변수로 사내 루트 인증서를 지정하세요. 휴대폰 핫스팟으로 실행해 보면 원인을 확인할 수 있습니다.";
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return "API 서버 주소를 찾을 수 없습니다. 네트워크의 DNS 설정 또는 도메인 차단 여부를 확인하세요.";
  }
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH/i.test(text)) {
    return "API 서버에 연결할 수 없습니다. 방화벽 차단이거나 프록시가 필요한 네트워크일 수 있습니다 (HTTPS_PROXY 환경변수를 지원합니다).";
  }
  if (/closed before the connection was established|handshake has timed out/i.test(text)) {
    return "연결이 수립되기 전에 끊겼습니다. 방화벽이 차단 중이거나 프록시가 필요한 네트워크일 가능성이 큽니다 — 휴대폰 핫스팟으로 실행해 보면 회사 네트워크 문제인지 즉시 확인됩니다. 프록시 네트워크라면 HTTPS_PROXY 환경변수를 설정하세요.";
  }
  return "";
}

// True when the text carries a meaningful amount (>= 2 signal chars) of a
// language OTHER than `target`. Used to tell a pure same-language echo from a
// genuinely mixed-language line that still needs translating.
// A real translation always turns a DIFFERENT-language source into target-language
// output. This returns true when the output is in the target language but there is
// NO evidence of a different-language source — i.e. the model echoed the source
// back instead of translating it. Judged ONLY from this turn's own source/output
// (not the shared coordinator, which lags a language switch), so the EN channel
// never paints English while the speaker is speaking English — including the case
// where the source transcript is missing/empty (output-only echo).
//   - output not in target language        → not an echo (let other gates decide)
//   - source carries other-language content → real translation (mixed lines)
//   - source detected as a different language → real translation
//   - source empty/unknown or same as target → ECHO (suppress)
export function isSameLanguageEcho(sourceText, translatedText, targetLanguage) {
  const target = normalizeLanguageCode(targetLanguage);
  if (!target) return false;
  const output = String(translatedText ?? "").trim();
  if (!output) return false;
  if (detectCaptionLanguage(output, { minimumSignalChars: 1 }) !== target) return false;
  const source = String(sourceText ?? "").trim();
  if (source && hasOtherLanguageSignal(source, target)) return false;
  const sourceLanguage = detectSourceLanguage(source, { minimumSignalChars: 1 });
  if (sourceLanguage !== "unknown" && sourceLanguage !== target) return false;
  return true;
}

function hasOtherLanguageSignal(value, target) {
  const counts = { ko: 0, ja: 0, en: 0 };
  for (const char of String(value ?? "")) {
    if (KOREAN_CHAR.test(char)) counts.ko += 1;
    else if (JAPANESE_CHAR.test(char)) counts.ja += 1;
    else if (ENGLISH_CHAR.test(char)) counts.en += 1;
  }
  return Object.entries(counts).some(([language, count]) => language !== target && count >= 2);
}

export function detectSourceLanguage(value, options = {}) {
  return detectCaptionSourceLanguage(value, options);
}

function normalizeLanguageCode(value) {
  return normalizeSubtitleLanguageCode(value);
}

function normalizeProviderLanguageCode(value) {
  const code = String(value ?? "").trim().toLowerCase();
  if (!code) return "";
  const exact = normalizeLanguageCode(code);
  if (exact) return exact;
  const primary = code.split("-")[0];
  if (isSupportedSubtitleLanguage(primary)) return primary;
  return "";
}

const SUBTITLE_PREFIX_RE = new RegExp(
  `^(translatedText|translation|sourceText|source|번역|원문|${subtitleLanguagePrefixTokens().join("|")})\\s*[:：]\\s*`,
  "i",
);

function stripSubtitlePrefix(value) {
  return String(value ?? "").replace(SUBTITLE_PREFIX_RE, "").trim();
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
