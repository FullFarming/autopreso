// @ts-nocheck - provider WebSocket messages are runtime-validated below.
import { HttpsProxyAgent } from "https-proxy-agent";
import { WebSocket } from "ws";

import { createSttTransport } from "./caption-engine/create-stt-transport.js";
import { DEFAULT_SUBTITLE_SETTINGS } from "./settings-store.js";
import {
  engineRequiredApiKeys,
  normalizeEngineSelection,
} from "../packages/caption-core/caption-engine-catalog.js";
import {
  applyGlossaryCorrections,
  countLanguageSignalChars,
  createCommittedCaptionFinalizer,
  createCrossChannelEchoDeduper,
  createGeminiCaptionConfig,
  createSourceLanguageConsensus,
  detectSourceLanguage as detectCaptionSourceLanguage,
  isEllipsisPlaceholder,
  isOutputInTargetLanguage,
  isFixedTargetOutputSupported,
} from "../packages/caption-core/index.js";
import {
  MAX_TRANSLATION_LANGUAGES,
  isSupportedSubtitleLanguage,
  normalizeSubtitleLanguageCode,
  resolveConfiguredLanguageForScript,
  subtitleLanguagePrefixTokens,
} from "./subtitle-languages.js";

const VALID_AUDIO_SOURCES = new Set(["system", "mic"]);
const MAX_PENDING_AUDIO_CHUNKS = 8;
const MAX_PENDING_AUDIO_AGE_MS = 750;
const AUDIO_BACKPRESSURE_MAX_BUFFERED_BYTES = 1_000_000;
const SETUP_ACK_TIMEOUT_MS = 8_000;
const DEFAULT_POLISH_TIMEOUT_MS = 6_000;
const PARTIAL_TRANSLATION_DEBOUNCE_MS = 160;
const TRANSCRIBE_ROLLOVER_MS = 570_000;
const TRANSCRIBE_FINAL_DRAIN_MS = 750;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5_000;
const MAX_AUTO_RECONNECTS = 10;
const MAX_TRANSCRIPT_CHARACTERS = 16_384;
const KEEPALIVE_INTERVAL_MS = 4_000;
const KEEPALIVE_IDLE_MS = 8_000;
// Provider rejections that a retry cannot fix: reconnecting would only burn the
// ladder and hide the real cause from the user.
const NON_RETRYABLE_TRANSPORT_ERRORS = new Set(["SONIOX_UNAUTHENTICATED", "SONIOX_INVALID_REQUEST"]);

function redactTransportDiagnostic(value) {
  return String(value ?? "")
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/giu, "$1[redacted-secret]")
    .replace(/(?:AIza|sk-)[A-Za-z0-9_-]+/gu, "[redacted-secret]")
    .replace(/[A-Za-z0-9+/]{64,}={0,2}/gu, "[redacted-data]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, 240);
}

function boundTranscript(value) {
  const text = String(value ?? "").normalize("NFC");
  return text.length <= MAX_TRANSCRIPT_CHARACTERS ? text : text.slice(-MAX_TRANSCRIPT_CHARACTERS);
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
    partialTranslationDebounceMs = PARTIAL_TRANSLATION_DEBOUNCE_MS,
    transcribeRolloverMs = TRANSCRIBE_ROLLOVER_MS,
    transcribeFinalDrainMs = TRANSCRIBE_FINAL_DRAIN_MS,
    reconnectBaseMs = RECONNECT_BASE_MS,
    polish = async ({ translatedText }) => translatedText,
    // Injection point for tests and for Task 5's Soniox transport.
    createSttTransport: createTransport = createSttTransport,
  } = options;
  const proxyUrl = env.HTTPS_PROXY || env.https_proxy || "";
  const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  const createWebSocket = options.createWebSocket
    ?? ((url, protocols, init) => new WebSocket(url, protocols, {
      ...init,
      handshakeTimeout: 10_000,
      ...(proxyAgent ? { agent: proxyAgent } : {}),
    }));
  const readNow = typeof options.now === "function" ? options.now : Date.now;
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
    apiKeys: { gemini: "", geminiSecondary: "", soniox: "" },
  };
  let producerGeneration = 0;
  let restartInFlight = false;
  let watchdogTimer = null;
  let lastStallRestartAt = 0;
  const livenessBySource = new Map();

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

  function broadcastCurrent(message, ownerSessionId, ownerGeneration) {
    if (!state.active || state.sessionId !== ownerSessionId || producerGeneration !== ownerGeneration) return;
    if (message?.type === "subtitle:partial" || message?.type === "subtitle:committed") noteOutput(message.source);
    broadcast?.(message);
  }

  function stopWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  function startWatchdog() {
    stopWatchdog();
    watchdogTimer = setInterval(checkForStall, watchdogConfig.intervalMs);
    watchdogTimer.unref?.();
  }

  function checkForStall() {
    if (!state.active || restartInFlight) return;
    const timestamp = readNow();
    const staleSignalAfterMs = Math.max(5_000, watchdogConfig.intervalMs);
    const stalled = [...livenessBySource.entries()].find(([, liveness]) => (
      liveness.signalSince > 0
      && timestamp - liveness.lastSignalAt <= staleSignalAfterMs
      && timestamp - Math.max(liveness.signalSince, liveness.lastOutputAt) >= watchdogConfig.stallMs
    ));
    if (!stalled) return;
    if (lastStallRestartAt > 0 && timestamp - lastStallRestartAt < watchdogConfig.cooldownMs) return;
    lastStallRestartAt = timestamp;
    const [stalledSource, liveness] = stalled;
    livenessBySource.set(stalledSource, { ...liveness, signalSince: timestamp });
    void restartChannels({ reason: "stall_watchdog" }).catch((error) => {
      log.warn?.(`[subtitle] stall watchdog restart failed: ${redactTransportDiagnostic(error?.message ?? error)}`);
    });
  }

  // Every provider the selected engine touches needs its own key slot; the
  // engine catalog decides which of them are actually required.
  function readApiKeys(saved = {}) {
    return {
      gemini: String(saved.apiKeys?.gemini || env.GEMINI_API_KEY || "").trim(),
      geminiSecondary: String(saved.apiKeys?.geminiSecondary || env.GEMINI_SECONDARY_API_KEY || "").trim(),
      soniox: String(saved.apiKeys?.soniox || env.SONIOX_API_KEY || "").trim(),
    };
  }

  function assertEngineApiKeys(engine, apiKeys) {
    const missingKey = engineRequiredApiKeys(engine).find((name) => !apiKeys[name]);
    if (missingKey) throw new Error(`${missingKey} API key is required for the selected caption engine.`);
  }

  /** @param {{sessionId?: string, settings?: Record<string, unknown>}} [input] */
  async function start({ sessionId, settings = {} } = {}) {
    if (typeof sessionId !== "string" || !sessionId) throw new Error("subtitle:start requires a sessionId.");
    await stop();
    const saved = settingsStore ? await settingsStore.load() : {};
    const normalizedSettings = normalizeSubtitleSettings({ ...(saved.subtitle ?? {}), ...(settings ?? {}) });
    const apiKeys = readApiKeys(saved);
    assertEngineApiKeys(normalizedSettings.engine, apiKeys);
    state.sessionId = sessionId;
    state.settings = normalizedSettings;
    state.captionConfig = createGeminiCaptionConfig(normalizedSettings);
    state.apiKeys = apiKeys;
    state.active = true;
    producerGeneration += 1;
    resetSourceLiveness();
    lastStallRestartAt = 0;
    startWatchdog();
    broadcast?.({ type: "subtitle:status", status: "connecting" });
    for (const source of sourcesForInputMode(normalizedSettings.inputMode)) ensureClient(source).open();
    broadcast?.({ type: "subtitle:status", status: "listening" });
  }

  function ensureClient(source) {
    const existing = state.clients.get(source);
    if (existing) return existing;
    const ownerSessionId = state.sessionId;
    const ownerGeneration = producerGeneration;
    const client = createSourceTranscriptionClient({
      source,
      settings: state.settings,
      captionConfig: state.captionConfig,
      transport: createTransport({
        engine: state.settings.engine,
        settings: state.settings,
        apiKeys: state.apiKeys,
      }),
      createWebSocket,
      broadcast: (message) => broadcastCurrent(message, ownerSessionId, ownerGeneration),
      log,
      polish,
      polishTimeoutMs,
      setupAckTimeoutMs,
      partialTranslationDebounceMs,
      transcribeRolloverMs,
      transcribeFinalDrainMs,
      reconnectBaseMs,
    });
    state.clients.set(source, client);
    return client;
  }

  function sendAudio({ sessionId, source, audio } = {}) {
    if (!state.active || sessionId !== state.sessionId) return;
    if (!VALID_AUDIO_SOURCES.has(source) || typeof audio !== "string" || !audio) return;
    ensureClient(source).sendAudio(audio);
  }

  async function stop(sessionId = state.sessionId) {
    if (sessionId !== state.sessionId && state.sessionId !== null) return false;
    const wasActive = state.active || state.sessionId !== null || state.clients.size > 0;
    stopWatchdog();
    const clients = [...state.clients.values()];
    state.clients.clear();
    state.active = false;
    state.sessionId = null;
    state.captionConfig = null;
    producerGeneration += 1;
    livenessBySource.clear();
    if (wasActive) broadcast?.({ type: "subtitle:status", status: "idle" });
    await Promise.all(clients.map((client) => client.close({ graceful: true })));
    return wasActive;
  }

  function close() {
    stopWatchdog();
    const clients = [...state.clients.values()];
    state.clients.clear();
    state.active = false;
    state.sessionId = null;
    state.captionConfig = null;
    producerGeneration += 1;
    livenessBySource.clear();
    for (const client of clients) void client.close();
  }

  // Task 6: open the replacement channels BEFORE tearing down the old ones,
  // so a settings save (e.g. an engine swap) bounds the caption gap by the new
  // provider's connect time instead of by the old socket's drain time. The
  // input mode itself is pinned to whatever is already running - a restart is
  // for picking up an engine/key change, not for silently reshaping which
  // audio sources are captured.
  async function restartChannels({ reason = "restart" } = {}) {
    if (!state.active || restartInFlight || !state.sessionId) return false;
    restartInFlight = true;
    const ownerSessionId = state.sessionId;
    try {
      const saved = settingsStore ? await settingsStore.load() : {};
      if (!state.active || state.sessionId !== ownerSessionId) return false;
      const normalizedSettings = normalizeSubtitleSettings({
        ...(state.settings ?? {}),
        ...(saved.subtitle ?? {}),
        inputMode: state.settings.inputMode,
      });
      const apiKeys = readApiKeys(saved);
      assertEngineApiKeys(normalizedSettings.engine, apiKeys);
      const previousClients = [...state.clients.values()];
      state.clients.clear();
      producerGeneration += 1;
      const replacementGeneration = producerGeneration;
      state.settings = normalizedSettings;
      state.captionConfig = createGeminiCaptionConfig(normalizedSettings);
      state.apiKeys = apiKeys;
      broadcast?.({ type: "subtitle:status", status: "recovering", reason });
      let replacements;
      try {
        replacements = sourcesForInputMode(normalizedSettings.inputMode).map((source) => ensureClient(source));
        for (const client of replacements) client.open();
      } catch (error) {
        // The replacement engine could not even be constructed (e.g. an
        // invalid engine selection slipping past validation). The OLD
        // channels are still the ones state.clients pointed at before this
        // block ran, so closing them here - rather than rethrowing and
        // leaving both generations half-alive - is what actually restores a
        // clean, single-generation state.
        await Promise.all(previousClients.map((client) => client.close({ graceful: true })));
        log.warn?.(`[subtitle] restartChannels failed to open replacement channels: ${redactTransportDiagnostic(error?.message ?? error)}`);
        broadcast?.({
          type: "subtitle:error",
          code: "ENGINE_RESTART_FAILED",
          reason,
          message: "엔진 교체에 실패했습니다. 설정을 확인하고 자막을 다시 시작해 주세요.",
          recoveryAllowed: false,
        });
        return false;
      }
      await Promise.all(replacements.map((client) => client.waitUntilReady(2_500).catch(() => undefined)));
      if (!state.active || state.sessionId !== ownerSessionId || producerGeneration !== replacementGeneration) {
        await Promise.all(previousClients.map((client) => client.close({ graceful: true })));
        return false;
      }
      await Promise.all(previousClients.map((client) => client.close({ graceful: true })));
      resetSourceLiveness();
      broadcast?.({ type: "subtitle:status", status: "listening" });
      return true;
    } finally {
      restartInFlight = false;
    }
  }

  /** @param {{sessionId?: string, source?: string}} [input] */
  function noteInputSignal({ sessionId, source } = {}) {
    if (!state.active || (sessionId && sessionId !== state.sessionId)) return;
    const timestamp = readNow();
    const inputSources = VALID_AUDIO_SOURCES.has(source)
      ? [source]
      : sourcesForInputMode(state.settings.inputMode);
    for (const inputSource of inputSources) {
      const current = livenessBySource.get(inputSource)
        ?? { signalSince: 0, lastSignalAt: 0, lastOutputAt: timestamp };
      const signalSince = timestamp - current.lastSignalAt > Math.max(5_000, watchdogConfig.intervalMs)
        ? timestamp
        : current.signalSince;
      livenessBySource.set(inputSource, { ...current, signalSince, lastSignalAt: timestamp });
    }
  }

  return { start, sendAudio, stop, close, restartChannels, noteInputSignal, _state: state };
}

function createSourceTranscriptionClient({
  source,
  settings,
  captionConfig,
  transport,
  createWebSocket,
  broadcast,
  log,
  polish,
  polishTimeoutMs,
  setupAckTimeoutMs,
  partialTranslationDebounceMs,
  transcribeRolloverMs,
  transcribeFinalDrainMs,
  reconnectBaseMs,
}) {
  const providerLabel = transport.providerLabel ?? "Gemini Transcribe";
  const maximumSessionMs = transport.maximumSessionMilliseconds ?? Number.POSITIVE_INFINITY;
  const lanes = languageTargets(settings).map((targetLanguage) => createTextTranslationLane({
    source,
    targetLanguage,
    settings,
    captionConfig,
    broadcast,
    polish,
    polishTimeoutMs,
    partialTranslationDebounceMs,
  }));
  let socket = null;
  let configured = false;
  // Woken by markTransportReady (success) and by the socket "close" handler
  // (gave up before ever becoming ready) - either way waitUntilReady must not
  // hang a restart for its full timeout on a dead socket.
  let readyWaiters = [];
  let intentionalClose = false;
  let pendingAudio = [];
  let setupAckTimer = null;
  let rolloverTimer = null;
  let rolloverDrainTimer = null;
  let rolloverSocket = null;
  let preservePendingAudio = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let backpressureShedding = false;
  // Providers with no setup ack (Soniox) never fail the setup handshake, so an
  // unrecoverable rejection has to stop the reconnect ladder explicitly.
  let noReconnect = false;
  // One start-failure report per client: audio frames arrive every 40 ms.
  let reportedStartFailure = false;
  let keepaliveTimer = null;
  let lastAudioSentAt = 0;
  let replayOnNextOpen = false;

  function clearTimer(timer) {
    if (timer) clearTimeout(timer);
    return null;
  }

  // Binary-audio transports (Soniox) hand back Buffers that must travel as
  // binary frames; JSON transports (Gemini) keep the single-argument call.
  function sendTransportPayload(openedSocket, payload) {
    if (transport.binaryAudio) openedSocket.send(payload, { binary: true });
    else openedSocket.send(payload);
  }

  function stopKeepalive() {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }

  function startKeepalive(openedSocket) {
    stopKeepalive();
    if (typeof transport.keepalivePayload !== "function") return;
    keepaliveTimer = setInterval(() => {
      if (socket !== openedSocket || intentionalClose || !configured) return;
      if (Date.now() - lastAudioSentAt <= KEEPALIVE_IDLE_MS) return;
      try { openedSocket.send(transport.keepalivePayload()); } catch { stopKeepalive(); }
    }, KEEPALIVE_INTERVAL_MS);
    keepaliveTimer.unref?.();
  }

  function markTransportReady(openedSocket) {
    if (socket !== openedSocket || intentionalClose) return;
    // A no-ack transport is marked ready on open, so its first result message
    // reports readiness again; re-flushing and re-arming would be wrong.
    if (configured) return;
    setupAckTimer = clearTimer(setupAckTimer);
    configured = true;
    for (const wake of readyWaiters.splice(0)) wake();
    reconnectAttempts = 0;
    // A rollover or reconnect drops audio the provider never transcribed; the
    // transport's replay ring re-sends that tail so the segment survives.
    if (replayOnNextOpen) {
      for (const payload of transport.replayPayloads?.() ?? []) sendTransportPayload(openedSocket, payload);
      replayOnNextOpen = false;
    }
    const cutoff = Date.now() - MAX_PENDING_AUDIO_AGE_MS;
    for (const pending of pendingAudio) {
      if (pending.preserveThroughRollover || pending.enqueuedAt >= cutoff) {
        sendTransportPayload(openedSocket, transport.audioPayload(pending.audio));
      }
    }
    pendingAudio = [];
    preservePendingAudio = false;
    startKeepalive(openedSocket);
    rolloverTimer = clearTimer(rolloverTimer);
    rolloverTimer = setTimeout(() => {
      if (socket !== openedSocket || intentionalClose) return;
      requestGracefulRollover(openedSocket, "session_rollover");
    }, Math.min(transport.rolloverMilliseconds ?? transcribeRolloverMs, maximumSessionMs - 1));
    rolloverTimer.unref?.();
  }

  function requestGracefulRollover(openedSocket, reason) {
    if (socket !== openedSocket || intentionalClose || rolloverSocket === openedSocket) return;
    rolloverTimer = clearTimer(rolloverTimer);
    stopKeepalive();
    configured = false;
    rolloverSocket = openedSocket;
    preservePendingAudio = true;
    replayOnNextOpen = true;
    broadcast({ type: "subtitle:status", status: "reconnecting", source, reason });
    try {
      sendTransportPayload(openedSocket, transport.closePayload());
    } catch (error) {
      log.warn?.(`[subtitle] Transcribe rollover end failed for ${source}: ${redactTransportDiagnostic(error?.message ?? error)}`);
    }
    rolloverDrainTimer = clearTimer(rolloverDrainTimer);
    rolloverDrainTimer = setTimeout(() => {
      if (socket === openedSocket && !intentionalClose) openedSocket.close();
    }, transcribeFinalDrainMs);
    rolloverDrainTimer.unref?.();
  }

  function armSetupTimeout(openedSocket) {
    setupAckTimer = clearTimer(setupAckTimer);
    setupAckTimer = setTimeout(() => {
      if (socket !== openedSocket || configured || intentionalClose) return;
      broadcast({
        type: "subtitle:error",
        message: `${providerLabel} 세션 준비 응답이 지연되었습니다 (${source}).`,
        code: "TRANSCRIBE_SETUP_TIMEOUT",
      });
      openedSocket.terminate?.();
    }, setupAckTimeoutMs);
    setupAckTimer.unref?.();
  }

  function scheduleReconnect() {
    if (noReconnect || intentionalClose || reconnectTimer) return;
    if (reconnectAttempts >= MAX_AUTO_RECONNECTS) {
      broadcast({
        type: "subtitle:error",
        message: `${providerLabel} 재연결을 중단했습니다 (${source}). 네트워크와 API 키를 확인한 뒤 자막을 다시 시작하세요.`,
        code: "TRANSCRIBE_RECONNECT_EXHAUSTED",
      });
      return;
    }
    const delay = Math.min(reconnectBaseMs * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
    reconnectAttempts += 1;
    replayOnNextOpen = true;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (intentionalClose) return;
      try { ensureSocket(); } catch (error) {
        log.warn?.(`[subtitle] Transcribe reconnect failed for ${source}: ${redactTransportDiagnostic(error?.message ?? error)}`);
        scheduleReconnect();
      }
    }, delay);
    reconnectTimer.unref?.();
  }

  function ensureSocket() {
    if (socket) return socket;
    if (typeof transport.assertReady === "function") transport.assertReady();
    const openedSocket = transport.connect({ createWebSocket });
    socket = openedSocket;
    configured = false;
    openedSocket.on("open", () => {
      if (socket !== openedSocket || intentionalClose) return;
      // This listener sits outside open()'s try/catch, so anything thrown here
      // would reach the process. Fail the session loudly instead.
      try {
        const payloads = transport.setupPayloads();
        if (!payloads?.length) throw new Error("transport produced no setup payload");
        for (const payload of payloads) openedSocket.send(payload);
      } catch (error) {
        broadcast({
          type: "subtitle:error",
          message: `${providerLabel} 시작 실패 (${source}): ${redactTransportDiagnostic(error?.message ?? error)}`,
          code: "TRANSCRIBE_START_FAILED",
        });
        intentionalClose = true;
        openedSocket.terminate?.();
        return;
      }
      // Soniox acknowledges nothing: the config frame is accepted or the socket
      // is rejected, so the session is ready the moment setup is on the wire.
      if (transport.requiresSetupAck === false) markTransportReady(openedSocket);
      else armSetupTimeout(openedSocket);
    });
    openedSocket.on("message", (raw) => {
      if (socket !== openedSocket || intentionalClose) return;
      transport.handleMessage(raw, {
        onTransportReady: () => markTransportReady(openedSocket),
        onInterim: (event) => { for (const lane of lanes) lane.preview(event); },
        onFinal: (event) => { for (const lane of lanes) lane.commit(event); },
        // Combined STT+translation providers surface the translation themselves;
        // Gemini Transcribe never fires these two.
        onTranslation: (event) => {
          for (const lane of lanes) if (lane.targetLanguage === event.targetLanguage) lane.acceptProviderTranslation(event);
        },
        onBoundary: (kind) => { for (const lane of lanes) lane.onProviderBoundary?.(kind); },
        onServerGoAway: () => {
          requestGracefulRollover(openedSocket, "provider_go_away");
        },
        onError: (code, detail) => {
          if (NON_RETRYABLE_TRANSPORT_ERRORS.has(code)) noReconnect = true;
          broadcast({
            type: "subtitle:error",
            code,
            message: `${providerLabel} 연결 오류: ${code}`,
            source,
            requestId: detail?.requestId ?? null,
          });
        },
        broadcast,
      });
    });
    openedSocket.on("error", (error) => {
      if (socket !== openedSocket || intentionalClose) return;
      const detail = redactTransportDiagnostic(error?.message ?? error);
      const guidance = describeSocketError(detail);
      broadcast({
        type: "subtitle:error",
        message: `${providerLabel} 연결 오류 (${source}): ${detail}${guidance ? ` — ${guidance}` : ""}`,
        code: "TRANSCRIBE_SOCKET_ERROR",
      });
      if (openedSocket.readyState === WebSocket.CONNECTING) openedSocket.terminate?.();
      else openedSocket.close();
    });
    openedSocket.on("unexpected-response", (_request, response) => {
      if (socket !== openedSocket || intentionalClose) return;
      broadcast({
        type: "subtitle:error",
        message: `${providerLabel} 연결이 차단되었습니다 (${response?.statusCode ?? "?"}).`,
        code: "TRANSCRIBE_SOCKET_BLOCKED",
      });
      openedSocket.terminate?.();
    });
    openedSocket.on("close", (code, reason) => {
      if (socket !== openedSocket) return;
      const didGracefulRollover = rolloverSocket === openedSocket;
      socket = null;
      configured = false;
      // The socket died before ever becoming ready (or intentional close beat
      // it there) - wake any restartChannels waiter now instead of leaving it
      // to burn its full waitUntilReady timeout on a connection that is gone.
      for (const wake of readyWaiters.splice(0)) wake();
      stopKeepalive();
      setupAckTimer = clearTimer(setupAckTimer);
      rolloverTimer = clearTimer(rolloverTimer);
      rolloverDrainTimer = clearTimer(rolloverDrainTimer);
      rolloverSocket = null;
      if (!didGracefulRollover) {
        pendingAudio = [];
        preservePendingAudio = false;
      }
      for (const lane of lanes) lane.invalidatePreview();
      if (code && code !== 1000 && code !== 1005) {
        const detail = redactTransportDiagnostic(reason?.toString?.("utf8") ?? "");
        log.warn?.(`[subtitle] Transcribe socket closed for ${source}: code=${code} reason=${detail}`);
      }
      if (!intentionalClose) {
        if (didGracefulRollover) {
          try { ensureSocket(); } catch (error) {
            log.warn?.(`[subtitle] Transcribe rollover reconnect failed for ${source}: ${redactTransportDiagnostic(error?.message ?? error)}`);
            scheduleReconnect();
          }
        } else {
          scheduleReconnect();
        }
      }
    });
    return openedSocket;
  }

  return {
    open() {
      try { ensureSocket(); } catch (error) {
        broadcast({
          type: "subtitle:error",
          message: `${providerLabel}를 시작할 수 없습니다: ${redactTransportDiagnostic(error?.message ?? error)}`,
          code: "TRANSCRIBE_START_FAILED",
        });
      }
    },
    // Lets restartChannels bound the open-new-before-close-old gap by connect
    // time: resolves immediately if already ready, and no later than
    // timeoutMs even if the replacement socket never comes up.
    waitUntilReady(timeoutMs = 2_500) {
      if (configured) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
        readyWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    },
    sendAudio(audio) {
      // Audio arrives from an async WebSocket listener with no outer catch, so a
      // transport that refuses to start must not throw out of here either.
      let connection;
      try {
        connection = ensureSocket();
      } catch (error) {
        if (!reportedStartFailure) {
          reportedStartFailure = true;
          broadcast({
            type: "subtitle:error",
            message: `${providerLabel}를 시작할 수 없습니다: ${redactTransportDiagnostic(error?.message ?? error)}`,
            code: "TRANSCRIBE_START_FAILED",
          });
        }
        return;
      }
      if (!configured) {
        const enqueuedAt = Date.now();
        pendingAudio.push({ audio, enqueuedAt, preserveThroughRollover: preservePendingAudio });
        pendingAudio = pendingAudio.filter((pending) => enqueuedAt - pending.enqueuedAt <= MAX_PENDING_AUDIO_AGE_MS)
          .slice(-MAX_PENDING_AUDIO_CHUNKS);
        return;
      }
      if ((connection.bufferedAmount ?? 0) > AUDIO_BACKPRESSURE_MAX_BUFFERED_BYTES) {
        if (!backpressureShedding) {
          backpressureShedding = true;
          broadcast({ type: "subtitle:status", status: "degraded", source });
        }
        return;
      }
      if (backpressureShedding) {
        backpressureShedding = false;
        broadcast({ type: "subtitle:status", status: "listening", source });
      }
      lastAudioSentAt = Date.now();
      sendTransportPayload(connection, transport.audioPayload(audio));
    },
    async close({ graceful = false } = {}) {
      intentionalClose = true;
      stopKeepalive();
      reconnectTimer = clearTimer(reconnectTimer);
      setupAckTimer = clearTimer(setupAckTimer);
      rolloverTimer = clearTimer(rolloverTimer);
      rolloverDrainTimer = clearTimer(rolloverDrainTimer);
      rolloverSocket = null;
      preservePendingAudio = false;
      replayOnNextOpen = false;
      for (const lane of lanes) lane.close();
      if (graceful && socket && configured) sendTransportPayload(socket, transport.closePayload());
      socket?.close();
      socket = null;
      configured = false;
      pendingAudio = [];
    },
  };
}

function createTextTranslationLane({
  source,
  targetLanguage,
  settings,
  captionConfig,
  broadcast,
  polish,
  polishTimeoutMs,
  partialTranslationDebounceMs,
}) {
  const finalizer = createCommittedCaptionFinalizer({
    config: captionConfig,
    polish: (request) => withTimeout(() => polish(request), polishTimeoutMs, null),
  });
  const termRetriever = finalizer.termRetriever;
  let previewTimer = null;
  let previewRevision = 0;
  let previewPending = null;
  let previewInFlight = false;
  let finalTail = Promise.resolve();
  let closed = false;

  function resolveSourceLanguage(event) {
    const detected = detectSourceLanguage(event.text, { minimumSignalChars: 1 });
    if (detected !== "unknown") return detected;
    return normalizeProviderLanguageCode(event.languageCode) || "unknown";
  }

  function isTargetOutputSupported(text) {
    if (targetLanguage !== "ko") return isOutputInTargetLanguage(text, targetLanguage);
    return isFixedTargetOutputSupported(text, targetLanguage, {
      protectedTerms: termRetriever.getProtectedTerms({ translatedText: text, targetLanguage }),
    });
  }

  function resolveTranslationRole(sourceText, sourceLanguage) {
    // Mixed Korean speech still needs its Korean rendition; source-language
    // detection cannot authorize copying ordinary English onto that target.
    if (sourceLanguage === "ko" && targetLanguage === "ko"
      && normalizeTranslationLanguages(settings).includes("ko")
      && !isTargetOutputSupported(sourceText)) return 1;
    return translationRoleForSource(sourceLanguage, targetLanguage, settings);
  }

  async function translatePreview(event, revision) {
    const sourceText = boundTranscript(event.text).trim();
    const sourceLanguage = resolveSourceLanguage(event);
    const translationRole = resolveTranslationRole(sourceText, sourceLanguage);
    if (!translationRole || closed) return;
    const translated = String(await withTimeout(() => polish({
      translatedText: "…",
      sourceText,
      targetLanguage,
      tone: captionConfig.tone,
      glossary: captionConfig.glossary,
      domain: captionConfig.domain,
      polishProvider: "gemini",
    }), polishTimeoutMs, "") ?? "").trim();
    if (closed || revision !== previewRevision || !translated || translated === "…") return;
    const corrected = stripSubtitlePrefix(termRetriever.repair(translated, {
      language: targetLanguage,
      isFinal: false,
    }));
    if (!corrected || !isTargetOutputSupported(corrected) || isSourceEcho(sourceText, corrected)) return;
    broadcast({
      type: "subtitle:partial",
      source,
      targetLanguage,
      sourceLanguage,
      translationRole,
      translationProvider: "gemini",
      sourceText,
      translatedText: corrected,
      isAuthoritative: false,
    });
  }

  function preview(event) {
    previewRevision += 1;
    const revision = previewRevision;
    previewPending = { event, revision };
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
    schedulePreview(partialTranslationDebounceMs);
  }

  function schedulePreview(delayMs) {
    if (closed || previewInFlight || previewTimer || !previewPending) return;
    previewTimer = setTimeout(() => {
      previewTimer = null;
      void drainPreview().catch(() => undefined);
    }, delayMs);
  }

  async function drainPreview() {
    if (closed || !previewPending) return;
    const { event, revision } = previewPending;
    previewPending = null;
    previewInFlight = true;
    try {
      await translatePreview(event, revision);
    } finally {
      previewInFlight = false;
      if (previewPending && !closed) schedulePreview(0);
    }
  }

  async function commitNow(event) {
    // Soniox already committed this segment's translation through
    // acceptProviderTranslation; re-translating it would double-bill and race.
    if (event.providerTranslated) return;
    const sourceText = boundTranscript(event.text).trim();
    const sourceLanguage = resolveSourceLanguage(event);
    const translationRole = resolveTranslationRole(sourceText, sourceLanguage);
    if (!translationRole || closed) {
      if (sourceLanguage === targetLanguage) {
        broadcast({ type: "subtitle:clear", source, targetLanguage, reason: "same_language_source", translationProvider: "gemini" });
      }
      return;
    }
    const finalized = await finalizer.finalize({
      sourceText,
      translatedText: "…",
      sourceLanguage,
      targetLanguage,
    });
    if (closed) return;
    const translatedText = stripSubtitlePrefix(finalized?.text ?? "");
    if (!finalized || !translatedText || isEllipsisPlaceholder(translatedText)
      || !isTargetOutputSupported(translatedText) || isSourceEcho(sourceText, translatedText)) {
      broadcast({
        type: "subtitle:error",
        message: `${targetLanguage} 텍스트 번역을 확정하지 못했습니다.`,
        code: "TEXT_TRANSLATION_FAILED",
        source,
        targetLanguage,
      });
      return;
    }
    broadcast({
      type: "subtitle:committed",
      source,
      targetLanguage,
      sourceLanguage,
      translationRole,
      translationProvider: "gemini",
      sourceText: finalized.sourceText,
      ...(finalized.sourceText !== sourceText ? { rawSourceText: sourceText } : {}),
      translatedText,
      isAuthoritative: true,
    });
  }

  function commit(event) {
    invalidatePreview();
    finalTail = finalTail.then(() => commitNow(event), () => commitNow(event));
  }

  function invalidatePreview() {
    previewRevision += 1;
    previewPending = null;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
  }

  function close() {
    closed = true;
    invalidatePreview();
    finalizer.release?.();
  }

  // Combined providers (Soniox) deliver the translation themselves; the Gemini
  // text lane never receives this. A provider translation is still model output,
  // so it clears exactly the same gates a Gemini final does: no-role handling
  // (with the finals-only same-language clear), placeholder drop,
  // target-language check, and source-echo rejection.
  function acceptProviderTranslationNow(event) {
    if (closed) return;
    const sourceText = boundTranscript(event.sourceText ?? "").trim();
    const sourceLanguage = normalizeProviderLanguageCode(event.sourceLanguage)
      || resolveSourceLanguage({ text: sourceText, languageCode: event.sourceLanguage });
    // resolveTranslationRole comes first so the mixed-Korean exception (Korean
    // speech that still needs its Korean rendition) keeps its role instead of
    // being cleared away as same-language.
    const translationRole = resolveTranslationRole(sourceText || event.text, sourceLanguage);
    if (!translationRole) {
      // Finals only, exactly like commitNow: the speaker has moved to this
      // lane's own language, so drop the stale rendition. A partial in that
      // situation is ignored in silence, the way translatePreview does.
      if (event.isFinal && sourceLanguage === targetLanguage) {
        broadcast({
          type: "subtitle:clear",
          source,
          targetLanguage,
          reason: "same_language_source",
          translationProvider: event.provider ?? "gemini",
        });
      }
      return;
    }
    const corrected = stripSubtitlePrefix(termRetriever.repair(boundTranscript(event.text).normalize("NFC"), {
      language: targetLanguage,
      isFinal: event.isFinal,
    }));
    if (!corrected || isEllipsisPlaceholder(corrected)) return;
    if (!isTargetOutputSupported(corrected)) {
      // A final that never reached the target language is a failed translation,
      // not silence: surface it so the lane is not left mysteriously empty.
      if (event.isFinal) {
        broadcast({
          type: "subtitle:error",
          message: `${targetLanguage} 텍스트 번역을 확정하지 못했습니다.`,
          code: "TEXT_TRANSLATION_FAILED",
          source,
          targetLanguage,
        });
      }
      return;
    }
    if (isSourceEcho(sourceText, corrected)) return;
    if (!event.isFinal) {
      broadcast({
        type: "subtitle:partial",
        source,
        targetLanguage,
        sourceLanguage,
        translationRole,
        translationProvider: event.provider,
        sourceText,
        translatedText: corrected,
        isAuthoritative: false,
        segmentId: event.segmentId,
      });
      return;
    }
    broadcast({
      type: "subtitle:committed",
      source,
      targetLanguage,
      sourceLanguage,
      translationRole,
      translationProvider: event.provider,
      sourceText,
      translatedText: applyGlossaryCorrections(corrected, {
        glossary: captionConfig.glossary,
        sourceText,
        targetLanguage,
      }).trim(),
      isAuthoritative: true,
      segmentId: event.segmentId,
    });
  }

  return {
    preview,
    commit,
    invalidatePreview,
    close,
    targetLanguage,
    acceptProviderTranslation(event) {
      if (closed) return;
      // Partials stay on the immediate path; finals join the same promise chain
      // as Gemini commits so a provider final can never overtake one in flight.
      if (!event?.isFinal) {
        acceptProviderTranslationNow(event);
        return;
      }
      invalidatePreview();
      finalTail = finalTail.then(
        () => acceptProviderTranslationNow(event),
        () => acceptProviderTranslationNow(event),
      );
    },
    onProviderBoundary(kind) { if (kind === "interrupted") invalidatePreview(); },
  };
}

async function withTimeout(run, timeoutMilliseconds, fallback) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMilliseconds); }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sourcesForInputMode(inputMode) {
  if (inputMode === "system") return ["system"];
  if (inputMode === "mic") return ["mic"];
  return ["system", "mic"];
}

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
    source = resolveConfiguredLanguageForScript(source, targets);
    if (!source || source === targetLanguage) return null;
  }
  if (targets.length < 3) return 1;
  if (targets.length === 3 && ["en", "ko", "ja"].every((language) => targets.includes(language))) {
    const roleMatrix = {
      ko: { en: 1, ja: 2 },
      en: { ko: 1, ja: 2 },
      ja: { en: 1, ko: 2 },
    };
    return roleMatrix[source]?.[targetLanguage] ?? null;
  }
  const ordered = targets.filter((language) => language !== source);
  const index = ordered.indexOf(targetLanguage);
  return index === -1 ? null : index + 1;
}

function languageTargets(settings) {
  return normalizeTranslationLanguages(settings);
}

export function normalizeSubtitleSettings(settings = {}) {
  const mergedLanguagePair = { ...DEFAULT_SUBTITLE_SETTINGS.languagePair, ...(settings.languagePair ?? {}) };
  const normalizedPair = {
    a: normalizeLanguageCode(mergedLanguagePair.a) || "en",
    b: normalizeLanguageCode(mergedLanguagePair.b) || "ko",
  };
  const merged = { ...DEFAULT_SUBTITLE_SETTINGS, ...settings, languagePair: normalizedPair };
  const translationLanguageSource = Array.isArray(settings.translationLanguages)
    ? merged
    : { ...merged, translationLanguages: undefined };
  const translationLanguages = normalizeTranslationLanguages(translationLanguageSource);
  const translationFontSize = clampNumber(merged.translationFontSize, 14, 96, DEFAULT_SUBTITLE_SETTINGS.translationFontSize);
  const retiredKeys = new Set(["audioLanguage", "audioVolume", "voiceProvider", "model", "geminiModel"]);
  const canonicalMerged = Object.fromEntries(Object.entries(merged).filter(([key]) => !retiredKeys.has(key)));
  return {
    ...canonicalMerged,
    inputMode: ["system", "mic", "system_mic"].includes(merged.inputMode) ? merged.inputMode : DEFAULT_SUBTITLE_SETTINGS.inputMode,
    languagePair: normalizedPair,
    translationLanguages,
    outputMode: "captions",
    translationProvider: "gemini",
    engine: normalizeEngineSelection(merged.engine),
    displayMode: ["translation_only", "translation_source"].includes(merged.displayMode)
      ? merged.displayMode
      : DEFAULT_SUBTITLE_SETTINGS.displayMode,
    showSourceText: typeof merged.showSourceText === "boolean" ? merged.showSourceText : DEFAULT_SUBTITLE_SETTINGS.showSourceText,
    translateAllLanguages: typeof merged.translateAllLanguages === "boolean"
      ? merged.translateAllLanguages || translationLanguages.length >= 3
      : translationLanguages.length >= 3,
    position: ["bottom-center", "top-center", "middle-center"].includes(merged.position) ? merged.position : DEFAULT_SUBTITLE_SETTINGS.position,
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
    debugTranscripts: merged.debugTranscripts === true,
  };
}

function normalizeTranslationLanguages(settings = {}) {
  const normalizeList = (values) => Array.from(new Set((Array.isArray(values) ? values : [])
    .map((language) => normalizeLanguageCode(language))
    .filter((language) => isSupportedSubtitleLanguage(language))));
  const selected = normalizeList(settings.translationLanguages);
  if (selected.length >= 2) return selected.slice(0, MAX_TRANSLATION_LANGUAGES);
  const a = normalizeLanguageCode(settings.languagePair?.a) || "en";
  const b = normalizeLanguageCode(settings.languagePair?.b) || "ko";
  if (settings.translateAllLanguages) return ["en", "ko", "ja"];
  return Array.from(new Set([a, b])).slice(0, MAX_TRANSLATION_LANGUAGES);
}

export function normalizeRealtimeModel(model) {
  void model;
  return normalizeEngineSelection(undefined).stt.model;
}

function normalizeEchoText(text) {
  return String(text ?? "")
    .replace(/\s+/gu, "")
    .replace(/[.,!?;:。、！？…·"'`]/gu, "")
    .trim()
    .toLowerCase();
}

export function isSourceEcho(sourceText, translatedText) {
  const source = normalizeEchoText(sourceText);
  const translated = normalizeEchoText(translatedText);
  return Boolean(source && translated && source === translated
    && countLanguageSignalChars(String(translatedText ?? "")) >= 2);
}

export { applyGlossaryCorrections };

export function detectSourceLanguage(value, options = {}) {
  return detectCaptionSourceLanguage(value, options);
}

export function isSameLanguageEcho(sourceText, translatedText, targetLanguage) {
  const target = normalizeLanguageCode(targetLanguage);
  const output = String(translatedText ?? "").trim();
  if (!target || !output || !isOutputInTargetLanguage(output, target)) return false;
  const source = String(sourceText ?? "").trim();
  if (source) {
    const sourceLanguage = detectSourceLanguage(source, { minimumSignalChars: 1 });
    if (sourceLanguage !== "unknown" && sourceLanguage !== target) return false;
  }
  return true;
}

function normalizeLanguageCode(value) {
  return normalizeSubtitleLanguageCode(value);
}

function normalizeProviderLanguageCode(value) {
  const code = String(value ?? "").trim().toLowerCase();
  if (!code) return "";
  return normalizeLanguageCode(code) || normalizeLanguageCode(code.split("-")[0]);
}

const SUBTITLE_PREFIX_RE = new RegExp(
  `^(translatedText|translation|sourceText|source|번역|원문|${subtitleLanguagePrefixTokens().join("|")})\\s*[:：]\\s*`,
  "iu",
);

function stripSubtitlePrefix(value) {
  return String(value ?? "").replace(SUBTITLE_PREFIX_RE, "").trim();
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

export function describeSocketError(message) {
  const text = String(message ?? "");
  if (/certificat|self.signed|CERT_|UNABLE_TO_VERIFY/iu.test(text)) {
    return "회사 보안 프록시의 인증서를 확인하고 generativelanguage.googleapis.com 연결 허용을 요청하세요.";
  }
  if (/ENOTFOUND|EAI_AGAIN/iu.test(text)) return "DNS 설정과 API 도메인 차단 여부를 확인하세요.";
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH/iu.test(text)) {
    return "방화벽 또는 HTTPS_PROXY 설정을 확인하세요.";
  }
  if (/closed before the connection was established|handshake has timed out/iu.test(text)) {
    return "WebSocket 연결을 허용하는 네트워크에서 다시 시도하세요.";
  }
  return "";
}
