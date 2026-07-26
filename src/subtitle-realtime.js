// @ts-nocheck - Realtime translation server events are dynamic JSON payloads; tests cover the accepted wire shapes.
import { HttpsProxyAgent } from "https-proxy-agent";
import { WebSocket } from "ws";

import { createGeminiTransport } from "./gemini-live-translate.js";
import { DEFAULT_SUBTITLE_SETTINGS } from "./settings-store.js";
import { createSubtitleLanguageState } from "./subtitle-language-state.js";
import {
  MAX_TRANSLATION_LANGUAGES,
  isSupportedSubtitleLanguage,
  normalizeSubtitleLanguageCode,
  resolveConfiguredLanguageForScript,
  subtitleLanguageCharPattern,
  subtitleLanguageLabel,
  subtitleLanguagePrefixTokens,
  toOpenAITranslationLanguageCode,
} from "./subtitle-languages.js";

const REALTIME_TRANSLATION_URL = "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate";
const VALID_AUDIO_SOURCES = new Set(["system", "mic"]);
const DEFAULT_TRANSLATION_MODEL = "gpt-realtime-translate";
const SUBTITLE_COMMIT_MS = 800;
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
const PARTIAL_MAX_HOLD_MS = 420;
const PARTIAL_MIN_SIGNAL_CHARS = 8;
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
const LANGUAGE_LOCK_MIN_SIGNAL_CHARS = 4;
const LANGUAGE_LOCK_MIN_CONFIDENCE = 0.68;
// Korean-preference gate for MIXED Korean+English source text. Korean (Hangul) is
// the unambiguously-detectable script, so we trust it — but only when there is
// ENOUGH of it to mean Korean is actually being spoken, not a stray Hangul char
// (a Gemini mis-transcription, a Korean name) contaminating otherwise-English
// speech. The old "any Hangul → Korean" rule made KO→EN rock-solid but flipped
// EN→KO to the English source on the slightest contamination. Require both a
// minimum Hangul COUNT and a minimum Hangul RATIO.
const KOREAN_MIX_MIN_CHARS = 3;
const KOREAN_MIX_MIN_RATIO = 0.2;
// Cross-channel source-language arbitration window. Both sibling channels (ko-target,
// en-target) hear the same audio and report the source language they detect. The
// authoritative source only CHANGES when the fresh reports agree (consensus); a lone
// channel's flip against the others is held off (hysteresis). This resolves Gemini
// returning a contradictory languageCode on ONE channel (e.g. langCode=en for Korean
// audio on the ko channel while the en channel correctly says ko), which made both a
// Korean echo and the English translation show and "중간에 계속 변함".
const SOURCE_VOTE_WINDOW_MS = 4000;
// How long a consensus source language stays authoritative WITHOUT being re-confirmed
// by a fresh consensus. Past this, the hold expires and channels fall back to their
// own per-channel detection. This bounds the hysteresis so a real KO→EN switch (the
// held "ko" stops being re-confirmed the moment English starts) is recognized within
// this window instead of waiting for both channels' languageCodes to agree on "en"
// — the "영어로 얘기하는데 영어로 인식이 늦음" delay. Brief lone flips are still shorter
// than this, so they stay suppressed.
const SOURCE_HOLD_MS = 2000;
const SOURCE_SOLO_FALLBACK_MS = 15_000;
const SOURCE_SOLO_FALLBACK_REPORTS = 8;
// When the two channels DISAGREE on the source language, a sibling whose source is
// sustained Latin English (this many Latin chars, detected as English) is decisive:
// English words can't be mistaken for Korean, whereas one channel often hallucinates a
// Korean-SCRIPT transliteration of English ("디스커션 앤드…") that looks like Korean. So
// "sustained English words → English is being spoken" (the user's hint), which makes the
// transliterating channel suppress its English echo instead of both directions flipping.
const SUSTAINED_ENGLISH_MIN_CHARS = 12;
// The sustained-English tie-break judges only this many trailing chars of the
// source buffer, so pre-switch English can't outvote the language actually
// being spoken NOW (see reportSource).
const SOURCE_TAIL_JUDGE_CHARS = 80;
// Output display gate: text with at least this many signal chars is long
// enough to judge; below it the lenient "unknown is fine" rule applies.
const OUTPUT_LANGUAGE_JUDGE_MIN_CHARS = 8;
// Relaxed vs the lock confidence so correct translations carrying foreign
// proper nouns ("OpenAI 모델은...") are not misclassified as mixed.
const OUTPUT_LANGUAGE_MIN_CONFIDENCE = 0.55;
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

/** @param {any} options */
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
  // Stall watchdog: speech signal present but zero subtitle output for stallMs
  // → the pipeline is wedged (dead upstream session, silent provider failure)
  // → rebuild the channels automatically. Timings injectable for tests.
  const watchdogConfig = {
    intervalMs: 5_000,
    stallMs: 20_000,
    cooldownMs: 45_000,
    ...(options.stallWatchdog ?? {}),
  };
  const state = {
    sessionId: null,
    settings: { ...DEFAULT_SUBTITLE_SETTINGS },
    clients: new Map(),
    active: false,
    apiKeys: { openai: "", openaiSecondary: "", gemini: "", geminiSecondary: "" },
  };
  let watchdogTimer = null;
  // Start of the current continuous-speech window (input-status "signal"
  // messages from the capture page), and the last time ANY subtitle content
  // (partial or committed) was broadcast.
  let signalSince = 0;
  let lastSignalAt = 0;
  let lastOutputAt = 0;
  let lastStallRestartAt = 0;
  let restartInFlight = false;

  // Manager-level broadcast tap: caption modes use visible text as liveness;
  // audio-only mode uses playable PCM and keeps hidden captions out of the
  // watchdog signal.
  function broadcastTapped(message) {
    const isCaption = message?.type === "subtitle:partial" || message?.type === "subtitle:committed";
    if (state.settings.outputMode === "audio") {
      if (message?.type === "subtitle:translated-audio") lastOutputAt = Date.now();
      if (isCaption) return;
    } else if (isCaption) {
      lastOutputAt = Date.now();
    }
    broadcast?.(message);
  }

  function clearTranslatedAudio(reason) {
    if (!AUDIO_OUTPUT_MODES.has(state.settings.outputMode)) return;
    broadcast?.({ type: "subtitle:audio-control", action: "clear", reason });
  }

  /** @param {any} args */
  async function start({ sessionId, settings = {} } = {}) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("subtitle:start requires a sessionId.");
    }
    await stop();
    const saved = settingsStore ? await settingsStore.load() : {};
    const nextSettings = normalizeSubtitleSettings({
      ...(saved.subtitle ?? {}),
      ...(settings ?? {}),
    });
    const apiKeys = {
      openai: (saved.apiKeys?.openai || env.OPENAI_API_KEY || "").trim(),
      openaiSecondary: (saved.apiKeys?.openaiSecondary || env.OPENAI_SECONDARY_API_KEY || "").trim(),
      gemini: (saved.apiKeys?.gemini || env.GEMINI_API_KEY || "").trim(),
      geminiSecondary: (saved.apiKeys?.geminiSecondary || env.GEMINI_SECONDARY_API_KEY || "").trim(),
    };
    const captionKey = nextSettings.translationProvider === "gemini" ? apiKeys.gemini : apiKeys.openai;
    if (!captionKey) throw new Error(nextSettings.translationProvider === "gemini"
      ? "Gemini API key is required for realtime subtitles."
      : "OpenAI API key is required for realtime subtitles.");
    if (AUDIO_OUTPUT_MODES.has(nextSettings.outputMode) && nextSettings.voiceProvider === "openai" && !apiKeys.openai) {
      throw new Error("OpenAI API key is required for realtime translated audio.");
    }
    state.sessionId = sessionId;
    state.settings = nextSettings;
    state.apiKeys = apiKeys;
    state.active = true;
    signalSince = 0;
    lastSignalAt = 0;
    lastOutputAt = Date.now();
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
    restartInFlight = true;
    try {
      clearTranslatedAudio(reason);
      log.warn?.(`[subtitle] rebuilding translation channels (${reason})`);
      const saved = settingsStore ? await settingsStore.load() : {};
      if (!state.active) return false;
      // Saved settings win (a glossary/preset change is a common reason to
      // rebuild); the running session's settings fill anything not persisted.
      state.settings = normalizeSubtitleSettings({ ...(state.settings ?? {}), ...(saved.subtitle ?? {}) });
      state.apiKeys = {
        openai: (saved.apiKeys?.openai || env.OPENAI_API_KEY || "").trim(),
        openaiSecondary: (saved.apiKeys?.openaiSecondary || env.OPENAI_SECONDARY_API_KEY || "").trim(),
        gemini: (saved.apiKeys?.gemini || env.GEMINI_API_KEY || "").trim(),
        geminiSecondary: (saved.apiKeys?.geminiSecondary || env.GEMINI_SECONDARY_API_KEY || "").trim(),
      };
      const captionKey = state.settings.translationProvider === "gemini" ? state.apiKeys.gemini : state.apiKeys.openai;
      if (!captionKey) throw new Error(state.settings.translationProvider === "gemini"
        ? "Gemini API key is required for realtime subtitles."
        : "OpenAI API key is required for realtime subtitles.");
      if (AUDIO_OUTPUT_MODES.has(state.settings.outputMode) && state.settings.voiceProvider === "openai" && !state.apiKeys.openai) {
        throw new Error("OpenAI API key is required for realtime translated audio.");
      }
      broadcast?.({ type: "subtitle:status", status: "recovering", reason });
      const oldClients = [...state.clients.values()];
      state.clients.clear();
      await Promise.all(oldClients.map((client) => client.close({ graceful: false })));
      if (!state.active || !state.sessionId) return false;
      for (const source of sourcesForInputMode(state.settings.inputMode)) {
        ensureClient(source).open();
      }
      lastOutputAt = Date.now();
      broadcast?.({ type: "subtitle:status", status: "listening" });
      return true;
    } finally {
      restartInFlight = false;
    }
  }

  // Capture-page speech signal (subtitle:input-status "signal"). Tracks the
  // start of the current continuous-speech window for the stall watchdog.
  function noteInputSignal({ sessionId } = {}) {
    if (!state.active || (sessionId && sessionId !== state.sessionId)) return;
    const now = Date.now();
    if (now - lastSignalAt > Math.max(5_000, watchdogConfig.intervalMs)) signalSince = now;
    lastSignalAt = now;
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
    const now = Date.now();
    // Nobody is speaking → nothing to expect from the pipeline.
    if (!signalSince || now - lastSignalAt > Math.max(5_000, watchdogConfig.intervalMs)) return;
    // Continuous speech for stallMs with ZERO subtitle output in that window.
    if (now - signalSince < watchdogConfig.stallMs) return;
    if (lastOutputAt >= signalSince) return;
    if (now - lastStallRestartAt < watchdogConfig.cooldownMs) return;
    lastStallRestartAt = now;
    signalSince = now;
    log.warn?.(`[subtitle] no subtitle output for ${watchdogConfig.stallMs}ms of continuous speech; auto-restarting channels`);
    void restartChannels({ reason: "stall_watchdog" }).catch((error) => {
      const safeDetail = redactTransportDiagnostic(error?.message ?? error);
      log.warn?.(`[subtitle] stall watchdog restart failed: ${safeDetail}`);
    });
  }

  /** @param {any} args */
  function sendAudio({ sessionId, source, audio } = {}) {
    if (!state.active || sessionId !== state.sessionId) return;
    if (!VALID_AUDIO_SOURCES.has(source)) return;
    if (typeof audio !== "string" || !audio) return;
    ensureClient(source).sendAudio(audio);
  }

  async function stop(sessionId = state.sessionId) {
    if (sessionId !== state.sessionId && state.sessionId !== null) return;
    stopWatchdog();
    const wasActive = state.active || state.sessionId !== null || state.clients.size > 0;
    if (wasActive) clearTranslatedAudio("stop");
    await Promise.all([...state.clients.values()].map((client) => client.close({ graceful: true })));
    state.clients.clear();
    state.active = false;
    state.sessionId = null;
    if (wasActive) broadcast?.({ type: "subtitle:status", status: "idle" });
  }

  function close() {
    stopWatchdog();
    clearTranslatedAudio("close");
    for (const client of state.clients.values()) client.close();
    state.clients.clear();
    state.active = false;
    state.sessionId = null;
  }

  function ensureClient(source) {
    const existing = state.clients.get(source);
    if (existing) return existing;
    const client = createRealtimeSubtitleClient({
      source,
      settings: state.settings,
      apiKeys: state.apiKeys,
      createWebSocket,
      broadcast: (message) => {
        if (!state.active) return;
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
  const usesOpenAIVoice = AUDIO_OUTPUT_MODES.has(settings.outputMode) && settings.voiceProvider === "openai";
  const captionSettings = {
    ...settings,
    translationProvider: usesOpenAIVoice ? "gemini" : settings.translationProvider,
    ...(usesOpenAIVoice ? { outputMode: "captions" } : {}),
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
  if (usesOpenAIVoice) {
    channels.push(createTranslationChannel({
      source,
      targetLanguage: settings.audioLanguage,
      settings: {
        ...settings,
        translationProvider: "openai",
        translationLanguages: [settings.audioLanguage],
        outputMode: "audio",
      },
      apiKeys,
      createWebSocket,
      broadcast,
      log,
      polish,
      polishTimeoutMs,
      echoRegistry: null,
      setupAckTimeoutMs,
      isVoiceOnly: true,
    }));
  }

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
function createOpenAITransport({ settings, targetLanguage, apiKey, source, apiKeyRole }) {
  return {
    connect({ createWebSocket }) {
      return createWebSocket(REALTIME_TRANSLATION_URL, undefined, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "OpenAI-Safety-Identifier": safetyIdentifierForSubtitleSession(source, targetLanguage, apiKeyRole),
        },
      });
    },
    setupPayloads() {
      return [JSON.stringify({ type: "session.update", session: buildSubtitleSession(settings, targetLanguage) })];
    },
    audioPayload(audio) {
      return JSON.stringify({ type: "session.input_audio_buffer.append", audio });
    },
    handleMessage(raw, ctx) {
      handleRealtimeMessage(raw, ctx);
    },
    closePayload() {
      return JSON.stringify({ type: "session.close" });
    },
  };
}

function createTranslationChannel({ source, targetLanguage, apiKeyRole, settings, apiKeys = {}, createWebSocket, broadcast, log, polish, polishTimeoutMs = DEFAULT_POLISH_TIMEOUT_MS, echoRegistry, setupAckTimeoutMs = SETUP_ACK_TIMEOUT_MS, isVoiceOnly = false }) {
  // Per-channel source-language tracker (not shared — see the coordinator/registry
  // split). The shared `echoRegistry` handles cross-channel echo detection only.
  const sourceLanguageCoordinator = createSubtitleLanguageState();
  // Per-direction engine routing (probe-verified 2026-06-12): OpenAI's
  // translate model emits Japanese OUTPUT with 10-25s latency or not at all,
  // while Gemini streams it in realtime. Japanese-target channels therefore
  // auto-route to Gemini whenever a Gemini key exists; every other direction
  // keeps the user's selected engine. ja INPUT on OpenAI is fast — only the
  // output direction needs the override.
  // Japanese on the OpenAI translate model lags badly (10-25s) and arrives long
  // after the English line. Route ja → Gemini whenever a Gemini key exists —
  // including all-language mode — so ja appears alongside en, not seconds late.
  const useGemini = !isVoiceOnly && (settings.translationProvider === "gemini"
    ? true
    : targetLanguage === "ja" && Boolean(apiKeys.gemini));
  const apiKey = useGemini
    ? selectGeminiApiKey({ settings, apiKeys, apiKeyRole })
    : selectOpenAIApiKey({ settings, targetLanguage, apiKeys, apiKeyRole });
  const translationContext = resolveSubtitleTranslationContext(settings);
  const transport = useGemini
    ? createGeminiTransport({ settings, targetLanguage, apiKey })
    : createOpenAITransport({ settings, targetLanguage, apiKey, source, apiKeyRole });
  if (!useGemini && targetLanguage === "ja") {
    log.warn?.("[subtitle] ja-target channel is using OpenAI (no Gemini key) — Japanese output may lag significantly. Add a Gemini key for realtime Japanese subtitles.");
  }
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
    const shouldPolish = shouldPolishCommittedSubtitle(settings, translationContext, apiKeys, {
      rawTranslation,
      sourceText: finalSource,
      useGemini,
    });
    // The LLM polisher (when configured) produces the natural, business-register
    // phrasing; on failure it falls back to the raw model line.
    let finalTranslation = rawTranslation;
    if (shouldPolish) {
      try {
        const polishing = Promise.resolve(polish({
          translatedText: rawTranslation,
          sourceText: finalSource,
          targetLanguage,
          tone: settings.tone,
          glossary: translationContext.glossary,
          domain: translationContext.domain,
          polishProvider: useGemini ? "gemini" : "openai",
        }));
        const safePolishing = polishing.catch(() => rawTranslation);
        let timer = null;
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve(rawTranslation), polishTimeoutMs);
        });
        finalTranslation = (await Promise.race([safePolishing, timeout])) || rawTranslation;
        clearTimeout(timer);
      } catch {
        finalTranslation = rawTranslation;
      }
    }
    if (channelClosed) return;
    // Deterministic glossary enforcement is the guaranteed safety net and runs
    // on EVERY committed line — polished or raw. A large glossary is not reliably
    // applied in full by the LLM polisher (it nails common words but drops rarer
    // registered terms / acronyms), so this pass enforces the exact term pairs
    // and translation-memory matches afterward. It also keeps the committed line
    // consistent with the live partials, which already pass through
    // applyGlossaryCorrections — without it the partial shows the corrected term
    // and the final line can revert to the uncorrected one.
    finalTranslation = applyGlossaryCorrections(finalTranslation, {
      glossary: translationContext.glossary,
      targetLanguage,
      sourceText: finalSource,
    });
    finalTranslation = stripSubtitlePrefix(finalTranslation);
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
      ...(useGemini ? { translationProvider: "gemini" } : {}),
      sourceText: finalSource,
      translatedText: finalTranslation,
    });
  }

  function resetUtterance() {
    clearCommitTimer();
    clearPartialTimer();
    if (partialStaleTimer) { clearTimeout(partialStaleTimer); partialStaleTimer = null; }
    if (silenceClearTimer) { clearTimeout(silenceClearTimer); silenceClearTimer = null; }
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

  function scheduleCommit() {
    clearCommitTimer();
    commitTimer = setTimeout(() => {
      const subtitle = normalizedSubtitle();
      if (subtitle.translatedText && shouldDisplay()) {
        void commitSubtitle(subtitle);
        resetUtterance();
      } else if (resolvedSourceLanguage() !== "unknown") {
        resetUtterance();
      }
      commitTimer = null;
    }, SUBTITLE_COMMIT_MS);
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
    // Output-language gate — passes when the TARGET language is meaningfully
    // PRESENT, not when it DOMINATES. A Korean translation legitimately carries
    // English proper nouns/acronyms (Cushman & Wakefield, Hilton Garden Inn, ADR,
    // GOP, Value-Add…) whose Latin characters often OUTNUMBER the Hangul; the old
    // dominance check then misclassified the line as English and suppressed the
    // Korean subtitle entirely — the EN→KO "no subtitle / English passes through"
    // asymmetry (KO→EN was unaffected because English output rarely contains
    // Korean). A same-language echo (e.g. English on the KO channel) has ~zero
    // target-language characters and is still rejected; the echo guards cover the
    // rest. Short text is too small to judge → lenient.
    const totalSignal = countLanguageSignalChars(translatedText);
    if (totalSignal < OUTPUT_LANGUAGE_JUDGE_MIN_CHARS) return true;
    return countLanguageCharsFor(translatedText, targetLanguage) >= 3;
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
    const maxWaitMs = SOURCE_HOLD_MS + partialMaxHoldMs();
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
    const finalTranslation = stripSubtitlePrefix(applyGlossaryCorrections(emitted, {
      glossary: translationContext.glossary,
      targetLanguage,
      sourceText,
    }));
    broadcast({
      type: "subtitle:committed",
      source,
      targetLanguage,
      sourceLanguage: previousSourceLanguage,
      translationRole,
      ...(useGemini ? { translationProvider: "gemini" } : {}),
      sourceText: sourceText.trim(),
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
    const outputLanguage = detectLanguage(translatedText, { minimumSignalChars: 1 });
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
      if (useGemini && settings.audioLanguage === targetLanguage && AUDIO_OUTPUT_MODES.has(settings.outputMode)) {
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
      ...(useGemini ? { translationProvider: "gemini" } : {}),
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
    if (!useGemini && targetLanguage === "ko" && /[다요죠니다습니다]$/.test(translated)) return true;
    if (!useGemini && targetLanguage === "ja" && /[。！？ますです]$/.test(translated)) return true;
    const minimumSignalChars = useGemini ? GEMINI_PARTIAL_MIN_SIGNAL_CHARS : PARTIAL_MIN_SIGNAL_CHARS;
    return countLanguageSignalChars(translated) >= minimumSignalChars
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
    return useGemini ? GEMINI_PARTIAL_MAX_HOLD_MS : PARTIAL_MAX_HOLD_MS;
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
    lastEmittedPartial = subtitle.translatedText;
    clearPartialTimer();
    armPartialStaleClear(subtitle.translatedText);
    broadcast({
      type: "subtitle:partial",
      source,
      targetLanguage,
      sourceLanguage,
      translationRole,
      ...(useGemini ? { translationProvider: "gemini" } : {}),
      ...subtitle,
      translatedText: stripSubtitlePrefix(useGemini ? applyGlossaryCorrections(subtitle.translatedText, {
        glossary: translationContext.glossary,
        targetLanguage,
      }) : subtitle.translatedText),
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
      broadcast({ type: "subtitle:error", message: "Translation API key is required for realtime subtitles.", code: "OPENAI_KEY_REQUIRED" });
      throw new Error("A translation API key is required for realtime subtitles.");
    }

    socket = transport.connect({ createWebSocket });
    // A fresh socket means the channel is live again (reconnect after a drop
    // or the Gemini 15-minute session cap) — lift the teardown guard so
    // markTransportReady and commitSubtitle work for the new session.
    channelClosed = false;

    const openedSocket = socket;
    socket.on("open", () => {
      // A late "open" from a socket the channel already tore down (close()
      // raced the connect) must not touch the channel's current state.
      if (socket !== openedSocket || channelClosed) return;
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
      if (socket !== openedSocket || channelClosed) return;
      transport.handleMessage(raw.toString("utf8"), {
        source,
        targetLanguage,
        outputMode: useGemini
          && settings.audioLanguage === targetLanguage
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
        suppressTranscripts: isVoiceOnly,
        onOutputAudio: isVoiceOnly
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
      const detail = `HTTP ${response?.statusCode ?? "?"} ${response?.statusMessage ?? ""}`.trim();
      log.warn?.(`[subtitle] websocket upgrade blocked for ${source}/${targetLanguage}: ${detail}`);
      broadcast({
        type: "subtitle:error",
        message: `연결이 차단되었습니다 (${source}/${targetLanguage}): ${detail} — 네트워크 프록시/보안 장비가 WebSocket 연결을 차단했습니다. IT에 api.openai.com·generativelanguage.googleapis.com 허용을 요청하거나 휴대폰 핫스팟으로 확인해 보세요.`,
        code: "TRANSLATION_SOCKET_BLOCKED",
      });
      broadcast({ type: "subtitle:status", status: "reconnecting", source, targetLanguage });
      socket?.terminate?.();
    });

    socket.on("close", (code, reason) => {
      if ((useGemini || isVoiceOnly) && settings.audioLanguage === targetLanguage && AUDIO_OUTPUT_MODES.has(settings.outputMode)) {
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
      lastAudioAt = Date.now();
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
      // Graceful close only when the provider has a close handshake (OpenAI
      // session.close → session.closed); Gemini Live has none, so fall through
      // to an immediate socket close.
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

function normalizeCrossChannelText(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9가-힣ぁ-んァ-ヶ一-龯]/g, "");
}

// SHARED cross-channel echo registry. Catches Gemini's same-language echo: when
// the audio is English, the EN-target channel hallucinates a Korean-transliterated
// source and echoes the English back, while the KO-target channel transcribes the
// SAME audio as clean English. If a channel's OUTPUT equals another channel's
// recorded SOURCE, that output is the source verbatim → an echo. This is the ONLY
// piece that is shared across the sibling channels.
export function createCrossChannelEchoRegistry() {
  const recentSources = new Map();
  // Channels register a clearEcho callback + a getter for their last-emitted
  // partial so a freshly-recorded source can RETROACTIVELY clear a sibling's echo
  // partial that beat it in the cross-channel race (turns a ~1.5s flash into ~200ms).
  const channels = new Map();
  const CROSS_CHANNEL_WINDOW_MS = 6000;
  // Cross-channel source-language arbitration (see SOURCE_VOTE_WINDOW_MS). Each
  // channel reports the source language IT detected; the authoritative source only
  // moves on consensus, so one channel's hallucinated languageCode flip can't make
  // it echo the source / both directions show at once.
  const sourceReports = new Map();
  let authoritativeSource = "unknown";
  let authoritativeAt = 0;
  let authoritativeIsConsensus = false;
  let sourceReportSequence = 0;
  let soloChallenge = { language: "unknown", count: 0, firstAt: 0, lastAt: 0 };
  return {
    reportSource(channelKey, language, sourceText = "", options = {}) {
      if (!language || language === "unknown") return;
      const now = Date.now();
      // Judge sustained English on the RECENT TAIL of the source, not the whole
      // accumulated buffer: right after an EN→KO switch the buffer still carries
      // the earlier English, and judging the full text kept forcing the
      // authoritative source to "en" while the speaker was already in Korean —
      // the "영어→한글 전환 인식이 늦음" lag. The tail flips to Korean within a few
      // words, letting the fresh Korean consensus take over immediately.
      const tail = String(sourceText).slice(-SOURCE_TAIL_JUDGE_CHARS);
      const latinCount = (tail.match(/[A-Za-z]/g) || []).length;
      // Use detectSourceLanguage (it applies the Korean-preference ratio gate) so
      // Korean speech studded with English jargon ("…hotel conversion strategy…") is
      // NOT mistaken for English here — only genuinely English-dominant source counts.
      const sustainedEnglish = latinCount >= SUSTAINED_ENGLISH_MIN_CHARS
        && detectSourceLanguage(tail) === "en";
      sourceReportSequence += 1;
      sourceReports.set(channelKey, {
        language,
        sustainedEnglish,
        isStrong: options.isStrong === true,
        at: now,
        sequence: sourceReportSequence,
      });
      const fresh = [...sourceReports.values()].filter((r) => now - r.at < SOURCE_VOTE_WINDOW_MS);
      const langs = fresh.map((r) => r.language);
      if (authoritativeIsConsensus && language === authoritativeSource) {
        soloChallenge = { language: "unknown", count: 0, firstAt: 0, lastAt: 0 };
      } else if (authoritativeIsConsensus && options.isStrong === true && language !== authoritativeSource) {
        soloChallenge = soloChallenge.language === language
          && now - soloChallenge.lastAt < SOURCE_VOTE_WINDOW_MS
          ? { ...soloChallenge, count: soloChallenge.count + 1, lastAt: now }
          : { language, count: 1, firstAt: now, lastAt: now };
      }
      const canUseSoloFallback = authoritativeIsConsensus
        && soloChallenge.count >= SOURCE_SOLO_FALLBACK_REPORTS
        && now - soloChallenge.firstAt >= SOURCE_SOLO_FALLBACK_MS
        && !fresh.some((report) => report.language === authoritativeSource);
      // A genuine MULTI-channel consensus (≥2 siblings agreeing) moves the authoritative
      // source. A single reporter or a disagreement otherwise leaves it untouched, so
      // channels fall back to their own per-channel detection (preserving the per-channel-
      // pollution fix). Once both siblings agree, that consensus HOLDS against a later
      // lone flip for SOURCE_HOLD_MS (hysteresis).
      if (langs.length >= 2 && langs.every((l) => l === langs[0])) {
        authoritativeSource = langs[0];
        authoritativeAt = now;
        authoritativeIsConsensus = true;
        soloChallenge = { language: "unknown", count: 0, firstAt: 0, lastAt: 0 };
      } else if (canUseSoloFallback) {
        authoritativeSource = soloChallenge.language;
        authoritativeAt = now;
        authoritativeIsConsensus = false;
        soloChallenge = { language: "unknown", count: 0, firstAt: 0, lastAt: 0 };
      } else if (
        fresh.some((r) => r.sustainedEnglish)
        // The tie-break resolves a genuine cross-channel DISAGREEMENT, so it needs
        // ≥2 fresh sibling reports. (Reaching this branch with 2+ fresh reports
        // already implies they disagree — an agreement would have taken the consensus
        // branch above.) A LONE sustained-Latin report is not a disagreement: it is
        // just as likely a Latin transliteration of continuing Korean speech, which is
        // why a held Korean consensus must survive it.
        && fresh.length >= 2
        // A consensus blocks the tie-break only while it is still FRESH. The guard
        // used to be an unconditional `!authoritativeIsConsensus`, which killed the
        // tie-break permanently after the first consensus of the session (see
        // resolveSource) — exactly the state in which it is needed most: the speaker
        // switches to English, the en-target channel hallucinates a Hangul
        // transliteration, the ko-target channel hears real Latin English, and
        // nothing could release the frozen "ko".
        && !(authoritativeIsConsensus && now - authoritativeAt <= SOURCE_HOLD_MS)
        && !(authoritativeSource !== "unknown" && now - authoritativeAt <= SOURCE_HOLD_MS
          && fresh.some((r) => r.language === authoritativeSource && r.isStrong))
      ) {
        // Disagreement, but a sibling sees sustained Latin English → English IS being
        // spoken; the disagreeing channel is transliterating it to Korean script.
        authoritativeSource = "en";
        authoritativeAt = now;
        authoritativeIsConsensus = false;
        soloChallenge = { language: "unknown", count: 0, firstAt: 0, lastAt: 0 };
      } else if (
        !authoritativeIsConsensus
        &&
        authoritativeSource !== "unknown"
        && !fresh.some((r) => r.language === authoritativeSource)
        && now - authoritativeAt > SOURCE_HOLD_MS
      ) {
        // NO fresh report supports the held source anymore — the consensus that
        // installed it has dissolved (the speaker switched). Release the hold
        // NOW instead of waiting out SOURCE_HOLD_MS, so channels fall back to
        // their own detection and the new direction is picked up immediately
        // ("영어로 인입되다가 바로 한글로 인입" 전환 지연 제거). A genuine
        // hallucinated lone flip keeps at least one supporting report fresh, so
        // the hysteresis still protects against it.
        authoritativeSource = "unknown";
        authoritativeAt = 0;
        authoritativeIsConsensus = false;
        soloChallenge = { language: "unknown", count: 0, firstAt: 0, lastAt: 0 };
      }
    },
    resolveSource(fallback = "unknown", options = {}) {
      if (options.isStrong === true && fallback !== "unknown" && fallback !== authoritativeSource) {
        const now = Date.now();
        if (authoritativeIsConsensus && authoritativeSource !== "unknown") return authoritativeSource;
        const ownReport = options.channelKey === undefined ? null : sourceReports.get(options.channelKey);
        const competingReports = [...sourceReports.entries()]
          .filter(([channelKey, report]) => channelKey !== options.channelKey
            && report.language === authoritativeSource
            && now - report.at < SOURCE_HOLD_MS)
          .map(([, report]) => report);
        if (competingReports.some((report) => report.isStrong)) return authoritativeSource;
        const newestCompetingSequence = Math.max(0, ...competingReports.map((report) => report.sequence));
        if (!ownReport || ownReport.sequence > newestCompetingSequence) return fallback;
      }
      // A consensus that has not been re-confirmed recently is stale — yield to the
      // caller's per-channel detection so a genuine language switch is picked up
      // promptly instead of being pinned to the previous direction. SOURCE_HOLD_MS
      // applies to a CONSENSUS hold too: the hold used to return unconditionally
      // here, so the first time both channels agreed (the first Korean sentence of
      // any bilingual meeting) pinned the arbitrated source for the WHOLE session.
      // When the speaker then switched to English and the en-target channel
      // hallucinated a Hangul transliteration, the frozen "ko" made the ko channel
      // treat the source as its own language and show NOTHING to Korean viewers
      // while English viewers got their own words echoed back. `authoritativeAt` is
      // refreshed on every fresh consensus, so continuous same-direction speech
      // re-confirms it every few hundred ms and never goes stale — the hysteresis
      // against brief lone flips is unchanged.
      if (authoritativeSource === "unknown") return fallback;
      if (Date.now() - authoritativeAt > SOURCE_HOLD_MS) return fallback;
      return authoritativeSource;
    },
    resetSource(channelKey) {
      if (channelKey === undefined) {
        sourceReports.clear();
        authoritativeSource = "unknown";
        authoritativeAt = 0;
        authoritativeIsConsensus = false;
        soloChallenge = { language: "unknown", count: 0, firstAt: 0, lastAt: 0 };
        return;
      }
      sourceReports.delete(channelKey);
      const now = Date.now();
      const fresh = [...sourceReports.values()].filter((report) => now - report.at < SOURCE_VOTE_WINDOW_MS);
      if (fresh.some((report) => report.language === authoritativeSource)) return;
      if (!authoritativeIsConsensus && now - authoritativeAt > SOURCE_HOLD_MS) {
        authoritativeSource = "unknown";
        authoritativeAt = 0;
        authoritativeIsConsensus = false;
        soloChallenge = { language: "unknown", count: 0, firstAt: 0, lastAt: 0 };
      }
    },
    registerChannel(channelKey, hooks) {
      channels.set(channelKey, hooks);
    },
    recordSource(channelKey, text) {
      const norm = normalizeCrossChannelText(text);
      if (norm.length < 4) return;
      recentSources.set(channelKey, { norm, at: Date.now() });
      for (const [key, hooks] of channels) {
        if (key === channelKey) continue;
        const last = normalizeCrossChannelText(hooks.getLastPartial?.() ?? "");
        if (last.length >= 6 && (norm.includes(last) || last.includes(norm))) hooks.clearEcho?.();
      }
    },
    outputEchoesAnotherSource(channelKey, outputText) {
      const out = normalizeCrossChannelText(outputText);
      if (out.length < 6) return false;
      const now = Date.now();
      for (const [key, rec] of recentSources) {
        if (key === channelKey || now - rec.at > CROSS_CHANNEL_WINDOW_MS || rec.norm.length < 6) continue;
        if (rec.norm.includes(out) || out.includes(rec.norm)) return true;
      }
      return false;
    },
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
  // gpt-realtime-translate is OUTPUT-language-only: it auto-detects the source
  // and translates ANY source into the configured target language (official
  // docs — you only specify the output language). So there is exactly ONE
  // channel per output language. A second channel for the same target would
  // translate the same audio again and collide (two Korean subtitles for one
  // utterance). When a secondary key for the ACTIVE provider exists we spread
  // the *distinct* target channels across the two keys for parallel load —
  // never the same target twice. Gemini mirrors OpenAI: the second Gemini key
  // takes the back half of the targets so each engine project runs in parallel.
  const secondaryKey = settings.translationProvider === "gemini"
    ? apiKeys.geminiSecondary
    : apiKeys.openaiSecondary;
  if (secondaryKey && targets.length >= 3) {
    const half = Math.ceil(targets.length / 2);
    return targets.map((targetLanguage, index) => ({ targetLanguage, apiKeyRole: index < half ? 1 : 2 }));
  }
  return targets.map((targetLanguage) => ({ targetLanguage }));
}

function selectOpenAIApiKey({ apiKeys = {}, apiKeyRole }) {
  if (apiKeyRole === 2 && apiKeys.openaiSecondary) return apiKeys.openaiSecondary;
  return apiKeys.openai;
}

// Gemini key selection mirrors OpenAI's, but the secondary key is only used
// when Gemini is the SELECTED provider. In OpenAI mode a ja-target channel
// auto-routes to Gemini and must always use the primary Gemini key (the role
// numbers there belong to the OpenAI key split, not Gemini's).
function selectGeminiApiKey({ settings = {}, apiKeys = {}, apiKeyRole }) {
  const geminiIsSelectedProvider = settings.translationProvider === "gemini";
  if (geminiIsSelectedProvider && apiKeyRole === 2 && apiKeys.geminiSecondary) return apiKeys.geminiSecondary;
  return apiKeys.gemini;
}

function languageTargets(settings) {
  return normalizeTranslationLanguages(settings);
}

export function buildSubtitleSession(settings = DEFAULT_SUBTITLE_SETTINGS, targetLanguage = "ko") {
  // Per-provider official language codes: OpenAI's translate model takes bare
  // ISO codes with a single "zh" for Chinese; the Gemini transport keeps its
  // own map (toGeminiLanguageCode). Never share one map across providers.
  return {
    audio: {
      output: { language: toOpenAITranslationLanguageCode(targetLanguage) },
    },
  };
}

export function buildSubtitleInstructions(settings = DEFAULT_SUBTITLE_SETTINGS) {
  const targets = normalizeTranslationLanguages(settings);
  if (targets.length >= 3) {
    const labels = targets.map((language) => subtitleLanguageLabel(language)).join(", ");
    return `Use realtime translation across ${labels}. For each detected source language, display translations for the other selected languages.`;
  }
  const [a, b] = targets;
  return `Use realtime translation between ${a} and ${b}. Display translated transcript above source transcript.`;
}

/** @param {string} line @param {any} context */
export function handleRealtimeMessage(line, {
  source = "system",
  targetLanguage = "ko",
  getSourceText,
  setSourceText,
  getTranslatedText,
  setTranslatedText,
  shouldDisplay,
  rememberSourceTranscriptDelta,
  rememberSourceTranscriptSnapshot,
  emitPartial,
  schedulePartialFlush,
  scheduleCommit,
  commitSubtitle,
  resetUtterance,
  onSessionClosed,
  suppressTranscripts = false,
  onOutputAudio,
  broadcast,
} = {}) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    broadcast?.({ type: "subtitle:error", message: "Invalid realtime message.", code: "INVALID_REALTIME_MESSAGE" });
    return;
  }

  if (message.type === "session.output_audio.delta") {
    if (typeof message.delta === "string" && message.delta && Buffer.from(message.delta, "base64").byteLength % 2 === 0) {
      onOutputAudio?.(message.delta);
    }
    return;
  }

  if (suppressTranscripts && [
    "session.input_transcript.delta",
    "session.output_transcript.delta",
    "session.input_transcript.done",
    "session.input_transcript.completed",
    "session.output_transcript.done",
    "session.output_transcript.completed",
  ].includes(message.type)) return;

  if (message.type === "session.input_transcript.delta") {
    if (String(message.delta ?? "").length > MAX_TRANSCRIPT_CHARS) return;
    setSourceText?.(boundTranscript(`${getSourceText?.() ?? ""}${message.delta ?? ""}`));
    rememberSourceTranscriptDelta?.(message.delta ?? "");
    emitPartial?.();
    return;
  }

  if (message.type === "session.output_transcript.delta") {
    if (String(message.delta ?? "").length > MAX_TRANSCRIPT_CHARS) return;
    setTranslatedText?.(boundTranscript(`${getTranslatedText?.() ?? ""}${message.delta ?? ""}`));
    if (typeof schedulePartialFlush === "function") schedulePartialFlush();
    else emitPartial?.();
    scheduleCommit?.();
    return;
  }

  if (message.type === "session.input_transcript.done" || message.type === "session.input_transcript.completed") {
    if (String(message.transcript ?? "").length > MAX_TRANSCRIPT_CHARS) return;
    const previousSourceText = String(getSourceText?.() ?? "");
    const nextSourceText = boundTranscript(message.transcript ?? previousSourceText);
    setSourceText?.(nextSourceText);
    rememberSourceTranscriptSnapshot?.(nextSourceText, previousSourceText);
    emitPartial?.();
    return;
  }

  if (message.type === "session.output_transcript.done" || message.type === "session.output_transcript.completed") {
    if (String(message.transcript ?? "").length > MAX_TRANSCRIPT_CHARS) return;
    setTranslatedText?.(boundTranscript(message.transcript ?? getTranslatedText?.() ?? ""));
    const sourceText = String(getSourceText?.() ?? "").trim();
    const translatedText = String(getTranslatedText?.() ?? "").trim();
    if (translatedText && shouldDisplay?.() !== false) {
      if (typeof commitSubtitle === "function") {
        void commitSubtitle({ sourceText, translatedText });
      } else {
        broadcast?.({
          type: "subtitle:committed",
          source,
          targetLanguage,
          sourceText,
          translatedText,
        });
      }
      setSourceText?.("");
      setTranslatedText?.("");
    } else if (typeof shouldDisplay === "function" && shouldDisplay() === false) {
      if (sourceText) {
        const sourceLanguage = detectSourceLanguage(sourceText);
        if (sourceLanguage !== "unknown") {
          setSourceText?.("");
          setTranslatedText?.("");
        }
      }
    }
    return;
  }

  if (message.type === "session.updated" || message.type === "session.created") {
    broadcast?.({ type: "subtitle:status", status: "api_ready", source, targetLanguage });
    return;
  }

  if (message.type === "session.input_audio_buffer.speech_started") {
    resetUtterance?.();
    broadcast?.({ type: "subtitle:status", status: "hearing", source, targetLanguage });
    return;
  }

  if (message.type === "session.input_audio_buffer.speech_stopped") {
    broadcast?.({ type: "subtitle:status", status: "translating", source, targetLanguage });
    return;
  }

  if (message.type === "session.closed") {
    onSessionClosed?.();
    return;
  }

  if (message.type === "error") {
    broadcast?.({
      type: "subtitle:error",
      message: redactTransportDiagnostic(message.error?.message) || "Realtime translation error",
      code: message.error?.code ?? "REALTIME_TRANSLATION_ERROR",
    });
  }
}

export function normalizeSubtitleOutput(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { sourceText: "", translatedText: "" };

  const json = parseSubtitleJson(raw);
  if (json) return json;

  const translatedFromPartial = extractJsonStringField(raw, "translatedText") || extractJsonStringField(raw, "translation");
  const sourceFromPartial = extractJsonStringField(raw, "sourceText") || extractJsonStringField(raw, "source");
  if (translatedFromPartial || sourceFromPartial) {
    return { sourceText: stripSubtitlePrefix(sourceFromPartial), translatedText: stripSubtitlePrefix(translatedFromPartial) };
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 2) {
    return {
      translatedText: stripSubtitlePrefix(lines[0]),
      sourceText: stripSubtitlePrefix(lines.slice(1).join(" ")),
    };
  }

  return { sourceText: "", translatedText: stripSubtitlePrefix(raw) };
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
    translationProvider: ["gemini", "openai"].includes(merged.translationProvider) ? merged.translationProvider : "gemini",
    voiceProvider: ["gemini", "openai"].includes(merged.voiceProvider) ? merged.voiceProvider : DEFAULT_SUBTITLE_SETTINGS.voiceProvider,
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
  if (!value) return DEFAULT_TRANSLATION_MODEL;
  if (value === "gpt-realtime-2" || value === "gpt-realtime") return DEFAULT_TRANSLATION_MODEL;
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

export function applyGlossaryCorrections(text, { glossary = "", targetLanguage = "ko", sourceText = "" } = {}) {
  const raw = String(text ?? "");
  if (!raw) return raw;
  const normalizedTargetLanguage = normalizeLanguageCode(targetLanguage);
  if (!normalizedTargetLanguage) return raw;
  // Number notation is arithmetic, not terminology — it applies to every
  // committed line whether or not the session picked a glossary preset.
  if (!String(glossary ?? "").trim()) {
    return normalizeBusinessNumberNotation(raw, normalizedTargetLanguage);
  }

  let corrected = applySourceGlossaryMemory(raw, {
    glossary,
    targetLanguage: normalizedTargetLanguage,
    sourceText,
  });
  const replacements = cachedGlossaryReplacementRules(glossary, normalizedTargetLanguage);
  for (const { from, to } of replacements) {
    if (!from || !to || from === to) continue;
    corrected = replaceGlossaryTerm(corrected, from, to);
  }
  corrected = normalizeCushmanWakefield(corrected, normalizedTargetLanguage, glossary);
  corrected = normalizeBusinessNumberNotation(corrected, normalizedTargetLanguage);
  return fixKoreanObjectParticles(corrected);
}

// Pattern-based normalization for the "Cushman & Wakefield" company name, which
// the live model mangles in endless ways the glossary cannot enumerate
// term-by-term: it drops the "&", fuses "and" into the first token
// ("Kushimanend Wakefield"), or invents phonetic spellings ("Kushiman",
// "Kusiman", "K-Field"). A single fuzzy matcher catches the whole family at once
// and is robust to NEW mistranscriptions. Scoped to glossaries that actually
// reference the company so it never touches unrelated sessions.
// <first-token> [& / and / fused "end"] Wakefield [Korea] — the full spoken form
const CW_FULL_PATTERN =
  /\b(?:cushmann?|kushmann?|kushiman|kusiman|kushi)\s*(?:&|and|end|n|앤드)?\s*wakefield(\s+korea)?/gi;
// Severe garbling: an INVENTED first token (kushima / kushiman / kusiman / kushman
// / kushi — none are real English words) followed within a few junk words by a
// "Field"/"Wakefield" tail, e.g. "Kushima is why Field Korea". Anchoring on the
// non-word garble token keeps this safe from real phrases. NOT applied to the
// real-ish "cushman" token (which would false-match "Cushman ... in the field").
const CW_GARBLE_PATTERN =
  /\b(?:kushiman|kushima|kushmann?|kusiman|kushi)\w*(?:\s+\w+){0,3}?\s+(?:wake\s*)?field(\s+korea)?/gi;
// Standalone English abbreviation the model invents: "K-Field" / "KField"
const CW_KFIELD_PATTERN = /\bk-?field(\s+korea)?/gi;
// Korean phonetic forms: 쿠시먼/쿠시만/쿠쉬먼 [앤드/앤/엔드/언드] 웨이크 필드 [코리아]
const CW_KO_PATTERN = /쿠[시쉬][먼만]?(?:앤드|앤|엔드|언드|드)?\s*웨이크\s*필드(\s*코리아)?/g;

function glossaryReferencesCushmanWakefield(glossary) {
  return /cushman|wakefield|쿠시먼|쿠쉬먼|c&w|k-?field|웨이크\s*필드/i.test(String(glossary ?? ""));
}

function normalizeCushmanWakefield(text, targetLanguage, glossary) {
  const value = String(text ?? "");
  if (!value || !glossaryReferencesCushmanWakefield(glossary)) return value;
  const isKorean = targetLanguage === "ko";
  const canonical = isKorean ? "쿠시먼앤드웨이크필드" : "Cushman & Wakefield";
  const koreaSuffix = isKorean ? " 코리아" : " Korea";
  const withKorea = (korea) => `${canonical}${korea ? koreaSuffix : ""}`;
  return value
    .replace(CW_FULL_PATTERN, (_match, korea) => withKorea(korea))
    .replace(CW_GARBLE_PATTERN, (_match, korea) => withKorea(korea))
    .replace(CW_KFIELD_PATTERN, (_match, korea) => withKorea(korea))
    .replace(CW_KO_PATTERN, (_match, korea) => withKorea(korea));
}

// Parsing + sorting the glossary into replacement rules is pure for a given
// (glossary, targetLanguage) but ran on EVERY committed line. Cache the
// compiled, length-sorted rules so term lookup is fast even with a large
// glossary — the glossary text rarely changes within a session.
const glossaryRuleCache = new Map();
const GLOSSARY_RULE_CACHE_MAX = 16;
function cachedGlossaryReplacementRules(glossary, targetLanguage) {
  const key = `${targetLanguage}\u0000${glossary}`;
  const cached = glossaryRuleCache.get(key);
  if (cached) return cached;
  const rules = parseGlossaryReplacementRules(glossary, targetLanguage)
    .sort((a, b) => b.from.length - a.from.length);
  glossaryRuleCache.set(key, rules);
  if (glossaryRuleCache.size > GLOSSARY_RULE_CACHE_MAX) {
    glossaryRuleCache.delete(glossaryRuleCache.keys().next().value);
  }
  return rules;
}

function resolveSubtitleTranslationContext(settings) {
  const configuredGlossary = String(settings.glossary ?? "").trim();
  const configuredDomain = String(settings.translationDomain ?? "").trim();
  return {
    glossary: configuredGlossary,
    domain: configuredDomain,
    hasConfiguredGlossary: Boolean(configuredGlossary),
    hasConfiguredDomain: Boolean(configuredDomain),
  };
}

function shouldPolishCommittedSubtitle(settings, translationContext, apiKeys = {}, options = {}) {
  if (settings.tone === "business") return true;
  const polishKey = options.useGemini ? (apiKeys.geminiSecondary || apiKeys.gemini) : apiKeys.openaiSecondary;
  if (!polishKey) return false;
  const shouldRecoverPlaceholder = isEllipsisPlaceholder(options.rawTranslation)
    && String(options.sourceText ?? "").trim().length >= 2;
  return translationContext.hasConfiguredGlossary
    || translationContext.hasConfiguredDomain
    || shouldRecoverPlaceholder;
}

function isEllipsisPlaceholder(value) {
  return /^\s*(?:\.{2,}|…+)\s*$/.test(String(value ?? ""));
}

function parseGlossaryReplacementRules(glossary, targetLanguage) {
  const rules = [];
  for (const line of String(glossary ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("-") || trimmed.startsWith("※")) continue;
    if (!trimmed.includes("=")) continue;
    const [leftRaw, ...rightParts] = trimmed.split("=");
    const rightRaw = rightParts.join("=").trim();
    const leftTerms = [...splitGlossaryAlternatives(leftRaw), ...extractNeverTerms(leftRaw)];
    const rightTerms = [...splitGlossaryAlternatives(rightRaw), ...extractNeverTerms(rightRaw)];
    if (!leftTerms.length || !rightTerms.length) continue;
    const alignedRules = buildAlignedGlossaryRules(leftTerms, rightTerms, targetLanguage);
    if (alignedRules.length) {
      rules.push(...alignedRules);
      continue;
    }

    const rightTarget = rightTerms.find((term) => detectTermLanguage(term) === targetLanguage);
    const leftTarget = leftTerms.find((term) => detectTermLanguage(term) === targetLanguage);
    const canonical = rightTarget || leftTarget;
    if (!canonical) continue;
    for (const term of [...leftTerms, ...rightTerms]) {
      if (term !== canonical) rules.push({ from: term, to: canonical });
    }
  }
  return dedupeReplacementRules(rules);
}

function applySourceGlossaryMemory(text, { glossary, targetLanguage, sourceText }) {
  const source = normalizeMemoryText(sourceText);
  if (!source) return text;
  const matches = parseGlossarySourceMemoryRules(glossary, targetLanguage)
    .filter((rule) => sourceContainsMemoryTerm(source, rule))
    .sort((a, b) => b.from.length - a.from.length);
  return matches[0]?.to ?? text;
}

function parseGlossarySourceMemoryRules(glossary, targetLanguage) {
  const rules = [];
  let isTranslationMemorySection = false;
  for (const line of String(glossary ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      isTranslationMemorySection = /번역 메모리|translation memory|문장 매칭/i.test(trimmed);
      continue;
    }
    if (!trimmed || trimmed.startsWith("-") || trimmed.startsWith("※")) continue;
    if (!trimmed.includes("=")) continue;
    const [leftRaw, ...rightParts] = trimmed.split("=");
    const rightRaw = rightParts.join("=").trim();
    const leftTerms = splitGlossaryAlternatives(leftRaw);
    const rightTerms = splitGlossaryAlternatives(rightRaw);
    if (!leftTerms.length || !rightTerms.length) continue;
    const alignedRules = buildAlignedGlossaryRules(leftTerms, rightTerms, targetLanguage, { allowEmbedded: isTranslationMemorySection });
    if (alignedRules.length) {
      rules.push(...alignedRules);
      continue;
    }

    const rightTarget = rightTerms.find((term) => detectTermLanguage(term) === targetLanguage);
    const leftTarget = leftTerms.find((term) => detectTermLanguage(term) === targetLanguage);
    const canonical = rightTarget || leftTarget;
    if (!canonical) continue;

    for (const term of [...leftTerms, ...rightTerms]) {
      if (term === canonical) continue;
      if (detectTermLanguage(term) === targetLanguage) continue;
      rules.push({ from: term, to: canonical, allowEmbedded: isTranslationMemorySection });
    }
  }
  return dedupeReplacementRules(rules);
}

function buildAlignedGlossaryRules(leftTerms, rightTerms, targetLanguage, options = {}) {
  if (leftTerms.length < 2 || leftTerms.length !== rightTerms.length) return [];
  const rules = [];
  for (let index = 0; index < leftTerms.length; index += 1) {
    const left = leftTerms[index];
    const right = rightTerms[index];
    const leftLanguage = detectTermLanguage(left);
    const rightLanguage = detectTermLanguage(right);
    if (leftLanguage === rightLanguage) return [];
    const target = leftLanguage === targetLanguage ? left : rightLanguage === targetLanguage ? right : "";
    const source = leftLanguage === targetLanguage ? right : rightLanguage === targetLanguage ? left : "";
    if (!target || !source || target === source) return [];
    rules.push({ from: source, to: target, ...(options.allowEmbedded ? { allowEmbedded: true } : {}) });
  }
  return rules;
}

function sourceContainsMemoryTerm(source, rule) {
  const normalizedTerm = normalizeMemoryText(rule.from);
  if (!normalizedTerm) return false;
  if (source === normalizedTerm) return true;
  if (!rule.allowEmbedded) return false;
  if (!source.includes(normalizedTerm)) return false;
  const sourceChars = source.replace(/\s/g, "").length;
  const termChars = normalizedTerm.replace(/\s/g, "").length;
  return termChars >= 8 && termChars / Math.max(sourceChars, 1) >= 0.72;
}

function splitGlossaryAlternatives(value) {
  return String(value ?? "")
    .split(/\s+\/\s+/)
    .map((term) => normalizeGlossaryTerm(term))
    .filter((term) => term.length >= 2);
}

function normalizeGlossaryTerm(value) {
  return String(value ?? "")
    .replace(/\s*\([^)]*(?:NEVER|never|호텔 객실 수 단위|현재 상황|브랜드|고유명사)[^)]*\)\s*/g, "")
    .trim();
}

function extractNeverTerms(value) {
  return [...String(value ?? "").matchAll(/NEVER\s+"([^"]+)"/gi)]
    .map((match) => normalizeGlossaryTerm(match[1]))
    .filter((term) => term.length >= 2);
}

function normalizeMemoryText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[“”"'.:,;!?()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectTermLanguage(term) {
  const text = String(term ?? "");
  if (KOREAN_CHAR.test(text)) return "ko";
  if (JAPANESE_CHAR.test(text)) return "ja";
  if (ENGLISH_CHAR.test(text)) return "en";
  return "unknown";
}

function dedupeReplacementRules(rules) {
  const seen = new Set();
  const result = [];
  for (const rule of rules) {
    const key = `${rule.from}\u0000${rule.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(rule);
  }
  return result;
}

function replaceGlossaryTerm(text, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasLatinEdge = /^[A-Za-z0-9&+.-]/.test(from) || /[A-Za-z0-9&+.-]$/.test(from);
  const pattern = hasLatinEdge
    ? new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gi")
    : new RegExp(escaped, "g");
  return text.replace(pattern, to);
}

function fixKoreanObjectParticles(text) {
  return String(text ?? "")
    .replace(/([가-힣])를/g, (_match, char) => `${char}${hasKoreanFinalConsonant(char) ? "을" : "를"}`)
    .replace(/([가-힣])을/g, (_match, char) => `${char}${hasKoreanFinalConsonant(char) ? "을" : "를"}`);
}

function hasKoreanFinalConsonant(char) {
  const code = char.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

function parseSubtitleJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      sourceText: stripSubtitlePrefix(parsed.sourceText ?? parsed.source ?? ""),
      translatedText: stripSubtitlePrefix(parsed.translatedText ?? parsed.translation ?? ""),
    };
  } catch {
    return null;
  }
}

function extractJsonStringField(raw, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = raw.match(new RegExp(`"${escapedKey}"\\s*:\\s*"([^"]*)`));
  return match ? match[1].replace(/\\"/g, "\"").trim() : "";
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
    return "회사 보안 프록시(SSL 검사)가 연결을 가로채는 것으로 보입니다. IT에 api.openai.com / generativelanguage.googleapis.com 허용(SSL 검사 제외)을 요청하거나, NODE_EXTRA_CA_CERTS 환경변수로 사내 루트 인증서를 지정하세요. 휴대폰 핫스팟으로 실행해 보면 원인을 확인할 수 있습니다.";
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
  if (detectLanguage(output, { minimumSignalChars: 1 }) !== target) return false;
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

// Any letter of any supported script counts as signal. The extra scripts
// (Cyrillic, Thai, Arabic, accented Latin) never appear in en/ko/ja text, so
// legacy behavior is unchanged — but ru/th/ar output would otherwise never
// reach the partial-display thresholds.
const EXTRA_SIGNAL_CHAR = /[À-ÖØ-öø-ÿĀ-ỹА-яЁёก-๛؀-ۿ]/;

function countLanguageSignalChars(value) {
  let count = 0;
  for (const char of String(value ?? "")) {
    if (KOREAN_CHAR.test(char) || JAPANESE_CHAR.test(char) || ENGLISH_CHAR.test(char) || EXTRA_SIGNAL_CHAR.test(char)) count += 1;
  }
  return count;
}

// Count characters belonging to a specific language's script. Used by the output
// gate to confirm the target language is present even when English proper nouns
// inflate the Latin character count of a Korean/Japanese translation.
function countLanguageCharsFor(value, language) {
  const pattern = subtitleLanguageCharPattern(language);
  let count = 0;
  for (const char of String(value ?? "")) {
    if (pattern.test(char)) count += 1;
  }
  return count;
}

export function detectSourceLanguage(value, options = {}) {
  return detectLanguage(value, { preferKoreanWhenMixedWithEnglish: true, ...options });
}

function detectLanguage(value, options = {}) {
  const text = String(value ?? "");
  const counts = { ko: 0, ja: 0, en: 0 };
  for (const char of text) {
    if (KOREAN_CHAR.test(char)) counts.ko += 1;
    else if (JAPANESE_CHAR.test(char)) counts.ja += 1;
    else if (ENGLISH_CHAR.test(char)) counts.en += 1;
  }
  const signalCount = counts.ko + counts.ja + counts.en;
  const minimumSignalChars = options.minimumSignalChars ?? LANGUAGE_LOCK_MIN_SIGNAL_CHARS;
  if (signalCount < minimumSignalChars) return "unknown";
  if (options.preferKoreanWhenMixedWithEnglish && counts.ko > 0 && counts.en > 0 && counts.ja === 0) {
    // Trust Hangul as the direction signal ONLY when there is enough of it to mean
    // Korean is actually being spoken — a meaningful COUNT and RATIO. A stray Hangul
    // char or two in otherwise-English speech no longer flips the source to Korean
    // (which used to echo the English source on the EN→KO direction); real Korean
    // speech (even jargon-heavy) easily clears both thresholds, so KO→EN stays solid.
    const koRatio = counts.ko / (counts.ko + counts.en);
    if (counts.ko >= KOREAN_MIX_MIN_CHARS && koRatio >= KOREAN_MIX_MIN_RATIO) return "ko";
    // Otherwise fall through to dominance/confidence: English-dominant text → English.
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [dominantLanguage, dominantCount] = entries[0];
  if (dominantCount === entries[1][1]) return "unknown";
  const confidence = dominantCount / signalCount;
  if (confidence < (options.minimumConfidence ?? LANGUAGE_LOCK_MIN_CONFIDENCE)) return "unknown";
  return dominantLanguage;
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

function safetyIdentifierForSubtitleSession(source, targetLanguage, apiKeyRole) {
  return `realtime-noel-subtitles-${source}-${targetLanguage}${apiKeyRole ? `-api${apiKeyRole}` : ""}`;
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

// ─────────────────────────────────────────────────────────────────────────────
// Business number notation — deterministic, because it is arithmetic.
//
// Korean counts in myriads (만 10^4 / 억 10^8 / 조 10^12); English business
// speech counts in million/billion/trillion. A live model asked to "translate"
// 3,000억 원 will happily emit "3,000 hundred million won" or leave the 억
// glyph in English output, so the scale is converted here instead: 3,000억 원 →
// KRW 300 billion, and 300 billion won → 3,000억 원. This runs on every
// committed caption and therefore on every recorded transcript line.
//
// Safety rules: a figure is only rewritten when a scale word is attached to a
// number, the conversion is applied at the SAME magnitude (no FX, ever), and a
// value that cannot be expressed exactly in the target scale falls back to
// comma-grouped digits rather than inventing precision.
// ─────────────────────────────────────────────────────────────────────────────

const NUMBER = "\\d[\\d,]*(?:\\.\\d+)?";
const MYRIAD_UNIT_VALUES = { 조: 1e12, 兆: 1e12, 억: 1e8, 億: 1e8, 만: 1e4, 万: 1e4 };
const MYRIAD_PREFIX_VALUES = { 천: 1e3, 千: 1e3, 백: 1e2, 百: 1e2 };
const MYRIAD_GROUP = `${NUMBER}\\s*[천백千百]?\\s*[조억만兆億万]`;
const WESTERN_SCALE_VALUES = { "hundred million": 1e8, trillion: 1e12, billion: 1e9, million: 1e6 };
const WESTERN_SCALE = "hundred\\s+million|trillion|billion|million";
const CURRENCY_BEFORE = "KRW|USD|JPY|EUR|₩|\\$|¥|€";
const CURRENCY_AFTER =
  "원화|원|달러|엔|円|유로|ウォン|ドル|ユーロ|won|dollars?|yen|euros?|KRW|USD|JPY|EUR";

// A myriad amount, optionally compound (1조 5,000억), optionally with a sub-만
// remainder that only counts when a currency token closes the figure, plus a
// currency on either side.
const MYRIAD_AMOUNT_PATTERN = new RegExp(
  `(?:(${CURRENCY_BEFORE})\\s*)?(${MYRIAD_GROUP}(?:\\s*${MYRIAD_GROUP})*)` +
    `(?:\\s*(${NUMBER})(?=\\s*(?:${CURRENCY_AFTER})(?![A-Za-z])))?` +
    `(?:\\s*(${CURRENCY_AFTER})(?![A-Za-z]))?`,
  "gi",
);

const WESTERN_AMOUNT_PATTERN = new RegExp(
  `(?:(${CURRENCY_BEFORE})\\s*)?(${NUMBER})\\s*(${WESTERN_SCALE})(?![A-Za-z-])` +
    `(?:\\s*(${CURRENCY_AFTER})(?![A-Za-z]))?`,
  "gi",
);

// "667K USD" / "USD 641K" — the thousands shorthand these decks quote fees in.
// A bare K is NOT a money scale (K-Pop, K-Beauty, 4K video), so a currency has
// to sit on one side of it before this fires.
const THOUSANDS_SHORTHAND_PATTERN = new RegExp(
  `(?:(${CURRENCY_BEFORE})\\s*)?(${NUMBER})\\s*K(?![A-Za-z0-9-])` +
    `(?:\\s*(${CURRENCY_AFTER})(?![A-Za-z]))?`,
  "gi",
);

// "hundred million" is the literal shadow of 억 and shows up in English output
// even when the rest of the line is clean English.
const LITERAL_HUNDRED_MILLION_PATTERN = new RegExp(
  `(?:(${CURRENCY_BEFORE})\\s*)?(${NUMBER})\\s*hundred\\s+million(?![A-Za-z-])` +
    `(?:\\s*(${CURRENCY_AFTER})(?![A-Za-z]))?`,
  "gi",
);

const CURRENCY_IDS = new Map([
  ["원", "KRW"], ["원화", "KRW"], ["won", "KRW"], ["krw", "KRW"], ["₩", "KRW"], ["ウォン", "KRW"],
  ["달러", "USD"], ["dollar", "USD"], ["dollars", "USD"], ["usd", "USD"], ["$", "USD"], ["ドル", "USD"],
  ["엔", "JPY"], ["円", "JPY"], ["yen", "JPY"], ["jpy", "JPY"], ["¥", "JPY"],
  ["유로", "EUR"], ["euro", "EUR"], ["euros", "EUR"], ["eur", "EUR"], ["€", "EUR"], ["ユーロ", "EUR"],
]);

const CURRENCY_OUTPUT = {
  en: { KRW: "KRW", USD: "USD", JPY: "JPY", EUR: "EUR" },
  ko: { KRW: "원", USD: "달러", JPY: "엔", EUR: "유로" },
  ja: { KRW: "ウォン", USD: "ドル", JPY: "円", EUR: "ユーロ" },
};

/** @type {Record<string, Array<[number, string]>>} */
const MYRIAD_OUTPUT_UNITS = {
  ko: [[1e12, "조"], [1e8, "억"], [1e4, "만"]],
  ja: [[1e12, "兆"], [1e8, "億"], [1e4, "万"]],
};

/** @type {Array<[number, string]>} */
const WESTERN_OUTPUT_SCALES = [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"]];

// Units that follow a figure but are not money: the number is still fixed, the
// unit is left exactly as spoken (33,000㎡, never "33 thousand㎡").
const NON_CURRENCY_UNIT_START = /^[㎡평명개실동층%°]/u;

/**
 * Rewrites monetary/quantity scales into the notation the target language's
 * business register uses. Never converts currencies, only scale words.
 * @param {string} text @param {string} targetLanguage
 */
export function normalizeBusinessNumberNotation(text, targetLanguage) {
  const raw = String(text ?? "");
  if (!raw) return raw;
  const language = String(targetLanguage ?? "").toLowerCase();
  if (language === "en") return toWesternNotation(raw);
  if (language === "ko" || language === "ja") return toMyriadNotation(raw, language);
  return raw;
}

function toWesternNotation(text) {
  return text
    .replace(MYRIAD_AMOUNT_PATTERN, (match, before, groups, remainder, after, offset, whole) => {
      const value = parseMyriadAmount(groups, remainder);
      if (value === null) return match;
      return renderWestern(value, resolveCurrency(before, after), followedByNonCurrencyUnit(whole, offset + match.length));
    })
    .replace(LITERAL_HUNDRED_MILLION_PATTERN, (match, before, number, after, offset, whole) => {
      const value = parseNumber(number);
      if (value === null) return match;
      return renderWestern(value * 1e8, resolveCurrency(before, after), followedByNonCurrencyUnit(whole, offset + match.length));
    });
}

function toMyriadNotation(text, language) {
  return text
    .replace(WESTERN_AMOUNT_PATTERN, (match, before, number, scale, after) => {
      const parsed = parseNumber(number);
      const unit = WESTERN_SCALE_VALUES[scale.replace(/\s+/gu, " ").toLowerCase()];
      if (parsed === null || !unit) return match;
      return renderMyriad(parsed * unit, resolveCurrency(before, after), language);
    })
    .replace(THOUSANDS_SHORTHAND_PATTERN, (match, before, number, after) => {
      const currency = resolveCurrency(before, after);
      const parsed = parseNumber(number);
      if (!currency || parsed === null) return match;
      return renderMyriad(parsed * 1e3, currency, language);
    });
}

/** Sums a compound myriad expression such as "1조 5,000억" plus any sub-만 tail. */
function parseMyriadAmount(groups, remainder) {
  let total = 0;
  let matched = false;
  const pattern = new RegExp(`(${NUMBER})\\s*([천백千百]?)\\s*([조억만兆億万])`, "gu");
  for (const group of String(groups ?? "").matchAll(pattern)) {
    const parsed = parseNumber(group[1]);
    if (parsed === null) return null;
    const prefix = group[2] ? MYRIAD_PREFIX_VALUES[group[2]] : 1;
    total += parsed * prefix * MYRIAD_UNIT_VALUES[group[3]];
    matched = true;
  }
  if (!matched) return null;
  if (remainder) {
    const tail = parseNumber(remainder);
    if (tail === null) return null;
    total += tail;
  }
  return total;
}

function parseNumber(value) {
  const cleaned = String(value ?? "").replace(/,/gu, "").trim();
  if (!cleaned || !/^\d+(?:\.\d+)?$/u.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveCurrency(before, after) {
  const token = String(after ?? before ?? "").trim().toLowerCase();
  return CURRENCY_IDS.get(token) ?? "";
}

function followedByNonCurrencyUnit(whole, index) {
  return NON_CURRENCY_UNIT_START.test(String(whole ?? "").slice(index, index + 1));
}

function renderWestern(value, currency, plainDigitsOnly) {
  const prefix = currency ? `${CURRENCY_OUTPUT.en[currency]} ` : "";
  if (plainDigitsOnly) return `${prefix}${formatDigits(value)}`;
  for (const [scaleValue, scaleName] of WESTERN_OUTPUT_SCALES) {
    if (value < scaleValue) continue;
    const scaled = Number((value / scaleValue).toFixed(4));
    // Refuse to invent precision: an amount that does not land cleanly on the
    // scale is reported as digits instead of a rounded-off approximation.
    if (Math.abs(scaled * scaleValue - value) >= 0.5) break;
    return `${prefix}${formatDigits(scaled)} ${scaleName}`;
  }
  return `${prefix}${formatDigits(value)}`;
}

function renderMyriad(value, currency, language) {
  const suffix = currency ? ` ${CURRENCY_OUTPUT[language][currency]}` : "";
  const parts = [];
  let remaining = value;
  for (const [unitValue, unitName] of MYRIAD_OUTPUT_UNITS[language]) {
    const count = Math.floor(remaining / unitValue);
    if (count <= 0) continue;
    parts.push(`${formatDigits(count)}${unitName}`);
    remaining -= count * unitValue;
  }
  // Sub-만 remainders (and amounts below 만) stay plain digits.
  if (remaining >= 0.5 || !parts.length) parts.push(formatDigits(remaining || value));
  return `${parts.join(" ")}${suffix}`;
}

function formatDigits(value) {
  const rounded = Number(Number(value).toFixed(4));
  const [integerPart, decimalPart] = String(rounded).split(".");
  const grouped = integerPart.replace(/\B(?=(?:\d{3})+(?!\d))/gu, ",");
  return decimalPart ? `${grouped}.${decimalPart}` : grouped;
}
