import { createServer } from "node:http";

import { WebSocket, WebSocketServer } from "ws";

import { AUDIO_CONFIG, validateLiveSettings } from "./config.js";
import { GatewayConnectionLimiter } from "./gateway-connection-limiter.js";
import {
  getOpaqueClientKey,
  isAllowedWebSocketUpgrade,
  isMetricsRequestAuthorized,
  readGatewaySecurityPolicy,
} from "./gateway-security.js";
import { GatewayMetrics } from "./metrics.js";
import { verifyLiveToken } from "./token-verifier.js";

const AUTH_TIMEOUT_MILLISECONDS = 5_000;
const AUTHORIZATION_CADENCE_MILLISECONDS = 2_500;
const AUTHORIZATION_CACHE_MILLISECONDS = 5_000;
const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u;
const INPUT_FRAME_BYTES = AUDIO_CONFIG.inputSampleRate * 2 * AUDIO_CONFIG.chunkMilliseconds / 1_000;
const INPUT_BYTES_PER_SECOND = AUDIO_CONFIG.inputSampleRate * 2;

export function createGatewayServer({
  pipelineFactory,
  hostAuthorizer,
  viewerAuthorizer,
  floorController = null,
  gatewaySecret,
  viewerSecret,
  metrics = new GatewayMetrics(),
  heartbeatIntervalMilliseconds = 30_000,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setReauthorizeIntervalFn = setInterval,
  clearReauthorizeIntervalFn = clearInterval,
  setHostLeaseIntervalFn = setInterval,
  clearHostLeaseIntervalFn = clearInterval,
  viewerAuthorizeTimeoutMilliseconds = 5_000,
  hostStartTimeoutMilliseconds = 10_000,
  maxQueuedHostOperations = 8,
  slowConsumerPredicate = (viewer) => viewer.bufferedAmount >= 750_000,
  securityPolicy = readGatewaySecurityPolicy(),
  connectionLimiter = new GatewayConnectionLimiter({ now }),
  audioBurstMilliseconds = 2_000,
  maxSessionAudioMilliseconds = 6 * 60 * 60 * 1_000,
  maxSessionAudioBytes = INPUT_BYTES_PER_SECOND * 6 * 60 * 60,
  maxSessionAudioEntries = 1_000,
}) {
  if (!Number.isFinite(heartbeatIntervalMilliseconds) || heartbeatIntervalMilliseconds <= 0) throw new Error("INVALID_HEARTBEAT_INTERVAL");
  if (!Number.isFinite(viewerAuthorizeTimeoutMilliseconds) || viewerAuthorizeTimeoutMilliseconds <= 0) throw new Error("INVALID_VIEWER_AUTHORIZE_TIMEOUT");
  if (!Number.isFinite(hostStartTimeoutMilliseconds) || hostStartTimeoutMilliseconds <= 0) throw new Error("INVALID_HOST_START_TIMEOUT");
  if (!Number.isSafeInteger(maxQueuedHostOperations) || maxQueuedHostOperations < 0) throw new Error("INVALID_HOST_QUEUE_LIMIT");
  if (!Number.isFinite(audioBurstMilliseconds) || audioBurstMilliseconds < AUDIO_CONFIG.chunkMilliseconds) throw new Error("INVALID_AUDIO_BURST");
  if (!Number.isFinite(maxSessionAudioMilliseconds) || maxSessionAudioMilliseconds <= 0) throw new Error("INVALID_SESSION_AUDIO_DURATION");
  if (!Number.isSafeInteger(maxSessionAudioBytes) || maxSessionAudioBytes < INPUT_FRAME_BYTES) throw new Error("INVALID_SESSION_AUDIO_BYTES");
  if (!Number.isSafeInteger(maxSessionAudioEntries) || maxSessionAudioEntries < 1) throw new Error("INVALID_SESSION_AUDIO_ENTRIES");
  const hostSessions = new Map();
  const hostOperationTails = new Map();
  const hostOperationCounts = new Map();
  const successfullyClosedPipelines = new WeakSet();
  const pipelineCloseFlights = new WeakMap();
  const pipelinesPendingClose = new Set();
  const viewerTopics = new Map();
  const viewerMetadata = new WeakMap();
  const floorHolders = new Map();
  const connectionCleanup = new Map();
  const sessionAudioUsage = new Map();
  const shutdownAbortController = new AbortController();
  let isShuttingDown = false;
  const audioBurstBytes = INPUT_BYTES_PER_SECOND * audioBurstMilliseconds / 1_000;
  const consumeAudioBudget = (sessionId, frameBytes) => {
    const timestamp = now();
    let usage = sessionAudioUsage.get(sessionId);
    if (!usage) {
      if (sessionAudioUsage.size >= maxSessionAudioEntries) {
        for (const [candidateSessionId, candidate] of sessionAudioUsage) {
          if (timestamp - candidate.startedAt >= maxSessionAudioMilliseconds) sessionAudioUsage.delete(candidateSessionId);
        }
      }
      if (sessionAudioUsage.size >= maxSessionAudioEntries) throw new Error("SESSION_AUDIO_CAPACITY_EXCEEDED");
      usage = { startedAt: timestamp, bytes: 0, tokens: audioBurstBytes, refilledAt: timestamp };
      sessionAudioUsage.set(sessionId, usage);
    }
    if (timestamp - usage.startedAt >= maxSessionAudioMilliseconds) throw new Error("SESSION_AUDIO_LIMIT_EXCEEDED");
    if (usage.bytes + frameBytes > maxSessionAudioBytes) throw new Error("SESSION_AUDIO_LIMIT_EXCEEDED");
    const elapsed = Math.max(0, timestamp - usage.refilledAt);
    usage.tokens = Math.min(audioBurstBytes, usage.tokens + elapsed * INPUT_BYTES_PER_SECOND / 1_000);
    usage.refilledAt = timestamp;
    if (usage.tokens < frameBytes) throw new Error("AUDIO_RATE_LIMITED");
    usage.tokens -= frameBytes;
    usage.bytes += frameBytes;
  };
  const closePipelineOnce = async (pipeline) => {
    if (!pipeline || successfullyClosedPipelines.has(pipeline)) return;
    const activeClose = pipelineCloseFlights.get(pipeline);
    if (activeClose) return activeClose;
    const closeFlight = Promise.resolve()
      .then(() => pipeline.close())
      .then(() => {
        successfullyClosedPipelines.add(pipeline);
        pipelinesPendingClose.delete(pipeline);
      })
      .catch((error) => {
        pipelinesPendingClose.add(pipeline);
        throw error;
      })
      .finally(() => {
        if (pipelineCloseFlights.get(pipeline) === closeFlight) pipelineCloseFlights.delete(pipeline);
      });
    pipelineCloseFlights.set(pipeline, closeFlight);
    return closeFlight;
  };
  const withHostSessionLock = (sessionId, operation, { bypassQueueLimit = false } = {}) => {
    const outstanding = hostOperationCounts.get(sessionId) ?? 0;
    const queued = Math.max(0, outstanding - 1);
    if (!bypassQueueLimit && outstanding > 0 && queued >= maxQueuedHostOperations) {
      return Promise.reject(new Error("HOST_OPERATION_QUEUE_FULL"));
    }
    hostOperationCounts.set(sessionId, outstanding + 1);
    const previous = hostOperationTails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.catch(() => undefined);
    hostOperationTails.set(sessionId, tail);
    void tail.then(() => {
      if (hostOperationTails.get(sessionId) === tail) hostOperationTails.delete(sessionId);
      const remaining = (hostOperationCounts.get(sessionId) ?? 1) - 1;
      if (remaining === 0) hostOperationCounts.delete(sessionId);
      else hostOperationCounts.set(sessionId, remaining);
    });
    return result;
  };
  const authorizeViewer = (claims, sessionId, language, abortController) => new Promise((resolve, reject) => {
    const { signal } = abortController;
    let isSettled = false;
    let timeout = null;
    const settle = (callback, value) => {
      if (isSettled) return;
      isSettled = true;
      if (timeout) clearTimeoutFn(timeout);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => settle(
      reject,
      signal.reason instanceof Error ? signal.reason : new Error("GRANT_CHECK_CANCELLED"),
    );
    timeout = setTimeoutFn(
      () => abortController.abort(new Error("GRANT_CHECK_TIMEOUT")),
      Math.min(AUTHORIZATION_CADENCE_MILLISECONDS, viewerAuthorizeTimeoutMilliseconds),
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => viewerAuthorizer.authorize(claims, sessionId, language, { signal }))
      .then((value) => settle(resolve, value), (error) => settle(reject, error));
  });
  const authorizeHost = (claims, settings, abortController, options) => new Promise((resolve, reject) => {
    const { signal } = abortController;
    let isSettled = false;
    const timeout = setTimeoutFn(
      () => abortController.abort(new Error("HOST_AUTHORIZATION_TIMEOUT")),
      Math.min(AUTHORIZATION_CADENCE_MILLISECONDS, viewerAuthorizeTimeoutMilliseconds),
    );
    const settle = (callback, value) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeoutFn(timeout);
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => settle(reject, signal.reason instanceof Error ? signal.reason : new Error("HOST_AUTHORIZATION_CANCELLED"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => hostAuthorizer.authorize(claims, settings, { signal, ...options }))
      .then((value) => settle(resolve, value), (error) => settle(reject, error));
  });
  const stopHostLease = (state) => {
    if (state?.leaseTimer) clearHostLeaseIntervalFn(state.leaseTimer);
    state?.leaseAbortController?.abort(new Error("HOST_LEASE_STOPPED"));
    if (state) {
      state.leaseTimer = null;
      state.leaseAbortController = null;
      state.leaseInFlight = null;
    }
  };
  const startHostLease = (state, claims) => {
    state.leaseTimer = setHostLeaseIntervalFn(() => {
      if (state.leaseInFlight || state.webSocket.readyState !== WebSocket.OPEN) return;
      const abortController = new AbortController();
      state.leaseAbortController = abortController;
      const lease = authorizeHost(claims, state.settings, abortController, { requireLive: true, compareVersion: false })
        .then((isAuthorized) => {
          if (!isAuthorized && hostSessions.get(state.settings.sessionId) === state) {
            closePipelineSocket(state.webSocket, new Error("SESSION_REVOKED"));
          }
        })
        .catch(() => {
          if (hostSessions.get(state.settings.sessionId) === state) {
            closePipelineSocket(state.webSocket, new Error("SESSION_REVOKED"));
          }
        })
        .finally(() => {
          if (state.leaseInFlight === lease) state.leaseInFlight = null;
          if (state.leaseAbortController === abortController) state.leaseAbortController = null;
        });
      state.leaseInFlight = lease;
    }, AUTHORIZATION_CADENCE_MILLISECONDS);
    state.leaseTimer?.unref?.();
  };
  const broadcastFloor = async (sessionId, holder) => {
    const state = hostSessions.get(sessionId);
    const payload = { type: "floor", sessionId, holder: holder ? { displayName: holder.displayName } : null };
    if (state) sendJson(state.webSocket, payload);
    const languages = state?.settings.languages ?? [];
    await Promise.all(languages.map((language) => deliverToAuthorizedViewers(
      sessionId,
      language,
      (viewer) => sendJson(viewer, { type: "live-event", payload }),
    )));
  };
  const releaseFloor = async (sessionId, { grantId = null, reason = "ended", notifyHolder = true } = {}) => {
    const holder = floorHolders.get(sessionId);
    if (!holder) return;
    if (grantId !== null && holder.grantId !== grantId) return;
    floorHolders.delete(sessionId);
    try {
      await floorController?.release(sessionId, holder.grantId);
    } catch {
      metrics.increment("floor_release_failures_total");
    }
    try {
      hostSessions.get(sessionId)?.pipeline.setFloorSpeaker?.(null);
    } catch {
      // A stopped pipeline must not block clearing the floor.
    }
    if (notifyHolder) sendJson(holder.webSocket, { type: "speak-ended", sessionId, reason });
    await broadcastFloor(sessionId, null);
  };
  const server = createServer((request, response) => {
    if (request.url === "/health" || request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/metrics" && isMetricsRequestAuthorized(request, securityPolicy.metricsToken)) {
      response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4", "Cache-Control": "no-store" });
      response.end(metrics.render());
      return;
    }
    response.writeHead(404).end();
  });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1_024 });
  const heartbeatTimer = setInterval(() => {
    for (const webSocket of webSockets.clients) {
      if (webSocket.isAlive === false) {
        metrics.increment("stale_connections_terminated_total");
        webSocket.terminate();
        continue;
      }
      webSocket.isAlive = false;
      webSocket.ping();
      metrics.increment("heartbeat_pings_total");
    }
  }, heartbeatIntervalMilliseconds);
  heartbeatTimer.unref();
  const tickTimer = setInterval(() => {
    for (const state of hostSessions.values()) {
      void state.pipeline.tick().catch((error) => closePipelineSocket(state.webSocket, error));
    }
  }, 250);
  tickTimer.unref();

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/live") {
      socket.destroy();
      return;
    }
    const releaseConnection = connectionLimiter.acquire(getOpaqueClientKey(request, gatewaySecret));
    if (!releaseConnection) {
      metrics.increment("connection_limit_rejections_total");
      rejectUpgrade(socket, 429, "Too Many Requests");
      return;
    }
    if (!isAllowedWebSocketUpgrade(request, securityPolicy, { gatewaySecret, viewerSecret, now })) {
      releaseConnection();
      metrics.increment("origin_rejections_total");
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    try {
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.once("close", releaseConnection);
        webSockets.emit("connection", webSocket);
      });
    } catch {
      releaseConnection();
      socket.destroy();
    }
  });

  webSockets.on("connection", (webSocket) => {
    webSocket.isAlive = true;
    let claims = null;
    let topic = null;
    let reauthorizeTimer = null;
    let reauthorizeInFlight = null;
    let reauthorizeGeneration = 0;
    let tokenExpiryTimer = null;
    const authorizationControllers = new Set();
    const runViewerAuthorization = async (sessionId, language) => {
      const abortController = new AbortController();
      authorizationControllers.add(abortController);
      try {
        return await authorizeViewer(claims, sessionId, language, abortController);
      } finally {
        authorizationControllers.delete(abortController);
      }
    };
    const ensureViewerAuthorization = async ({ force = false } = {}) => {
      const metadata = viewerMetadata.get(webSocket);
      if (!metadata) return false;
      if (!force && now() - metadata.lastAuthorizedAt < AUTHORIZATION_CACHE_MILLISECONDS) return true;
      if (reauthorizeInFlight) return reauthorizeInFlight;
      const generation = reauthorizeGeneration;
      const authorization = runViewerAuthorization(metadata.sessionId, metadata.language);
      const inFlight = authorization
        .then((isAuthorized) => {
          if (generation !== reauthorizeGeneration) return false;
          if (!isAuthorized) {
            closeWithError(webSocket, "GRANT_REVOKED", "시청 권한이 만료되었습니다.", 4403);
            return false;
          }
          metadata.lastAuthorizedAt = now();
          return true;
        })
        .catch(() => {
          if (generation === reauthorizeGeneration) closeWithError(webSocket, "GRANT_REVOKED", "시청 권한을 확인할 수 없습니다.", 4403);
          return false;
        })
        .finally(() => {
          if (reauthorizeInFlight === inFlight) reauthorizeInFlight = null;
        });
      reauthorizeInFlight = inFlight;
      return inFlight;
    };
    const authTimer = setTimeoutFn(() => closeWithError(webSocket, "UNAUTHORIZED", "인증 시간이 만료되었습니다.", 4401), AUTH_TIMEOUT_MILLISECONDS);
    const cleanupTimers = onceOnly(() => {
      clearTimeoutFn(authTimer);
      if (tokenExpiryTimer) clearTimeoutFn(tokenExpiryTimer);
      if (reauthorizeTimer) clearReauthorizeIntervalFn(reauthorizeTimer);
      reauthorizeTimer = null;
      reauthorizeInFlight = null;
      reauthorizeGeneration += 1;
      viewerMetadata.delete(webSocket);
      for (const abortController of authorizationControllers) abortController.abort();
      authorizationControllers.clear();
      metrics.increment("connection_cleanups_total");
    });
    connectionCleanup.set(webSocket, cleanupTimers);
    webSocket.on("pong", () => {
      webSocket.isAlive = true;
      metrics.increment("heartbeat_pongs_total");
    });
    metrics.increment("connections_total");

    webSocket.on("message", async (data, isBinary) => {
      try {
        if (isShuttingDown) throw new Error("GATEWAY_SHUTTING_DOWN");
        if (!claims) {
          if (isBinary) throw new Error("UNAUTHORIZED");
          const message = parseJson(data);
          if (message.type !== "authenticate" || typeof message.token !== "string") throw new Error("UNAUTHORIZED");
          claims = verifyLiveToken(message.token, { gatewaySecret, viewerSecret, now });
          clearTimeoutFn(authTimer);
          const expiresAt = claims.role === "HOST" ? claims.exp * 1_000 : claims.expiresAt;
          tokenExpiryTimer = setTimeoutFn(
            () => closeWithError(webSocket, "TOKEN_EXPIRED", "게이트웨이 인증이 만료되었습니다.", 4401),
            Math.max(0, expiresAt - now()),
          );
          sendJson(webSocket, { type: "authenticated", role: claims.role });
          return;
        }
        if (claims.role === "HOST") {
          if (isBinary) {
            const state = hostSessions.get(claims.sessionId);
            if (!state || state.webSocket !== webSocket) throw new Error("SESSION_NOT_STARTED");
            if (floorHolders.has(claims.sessionId)) {
              // A participant holds the speaking floor: their audio wins.
              metrics.increment("dropped_audio_frames_total");
              return;
            }
            if (data.byteLength !== INPUT_FRAME_BYTES) throw new Error("INVALID_AUDIO_FRAME");
            consumeAudioBudget(claims.sessionId, data.byteLength);
            if (state.pendingFrames * AUDIO_CONFIG.chunkMilliseconds >= AUDIO_CONFIG.staleFrameMilliseconds) {
              metrics.increment("dropped_audio_frames_total");
              return;
            }
            state.pendingFrames += 1;
            const capturedAt = Date.now();
            state.audioTail = state.audioTail
              .then(() => state.pipeline.acceptAudio(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), capturedAt))
              .catch((error) => closePipelineSocket(webSocket, error))
              .finally(() => { state.pendingFrames -= 1; });
            metrics.increment("audio_frames_total");
            return;
          }
          const message = parseJson(data);
          const active = hostSessions.get(claims.sessionId);
          if (message.type === "audioStreamEnd" && active?.webSocket === webSocket) {
            await active.audioTail;
            await active.pipeline.endAudioStream();
            sendJson(webSocket, { type: "audio-stream-ended", sessionId: claims.sessionId });
            return;
          }
          if (!["start", "update"].includes(message.type)
            || message.sessionId !== claims.sessionId
            || !Number.isSafeInteger(message.version)) throw new Error("INVALID_START");
          const normalizedSettings = validateLiveSettings(message);
          const hostMessage = {
            ...message,
            ...normalizedSettings,
            sessionId: claims.sessionId,
          };
          try {
            const prepared = await withHostSessionLock(claims.sessionId, async () => {
              if (shutdownAbortController.signal.aborted) throw shutdownAbortController.signal.reason;
              const previous = hostSessions.get(claims.sessionId);
              let candidate = null;
              const operationAbortController = new AbortController();
              const abortForShutdown = () => operationAbortController.abort(
                shutdownAbortController.signal.reason ?? new Error("GATEWAY_SHUTTING_DOWN"),
              );
              shutdownAbortController.signal.addEventListener("abort", abortForShutdown, { once: true });
              const startTimer = setTimeoutFn(
                () => operationAbortController.abort(new Error("HOST_START_TIMEOUT")),
                hostStartTimeoutMilliseconds,
              );
              try {
                const isAuthorized = await authorizeHost(claims, hostMessage, operationAbortController, {
                  requireLive: false,
                  compareVersion: true,
                });
                if (!isAuthorized) throw new Error("SESSION_REVOKED");
                const factoryPromise = Promise.resolve().then(() => pipelineFactory(
                  hostMessage,
                  previous?.pipeline ?? null,
                  (event) => sendJson(webSocket, event),
                  { signal: operationAbortController.signal },
                ));
                void factoryPromise.then((lateCandidate) => {
                  if (operationAbortController.signal.aborted) {
                    return closePipelineOnce(lateCandidate).catch(() => undefined);
                  }
                  return undefined;
                }, () => undefined);
                candidate = await waitForAbort(factoryPromise, operationAbortController.signal);
                await waitForAbort(
                  Promise.resolve().then(() => candidate.start({ signal: operationAbortController.signal })),
                  operationAbortController.signal,
                );
                const isStillAuthorized = await authorizeHost(claims, hostMessage, operationAbortController, {
                  requireLive: false,
                  compareVersion: true,
                });
                if (!isStillAuthorized) throw new Error("SESSION_REVOKED");
                if (isShuttingDown || webSocket.readyState !== WebSocket.OPEN) {
                  throw new Error("GATEWAY_SHUTTING_DOWN");
                }
              } catch (error) {
                await closePipelineOnce(candidate).catch(() => undefined);
                throw error;
              } finally {
                clearTimeoutFn(startTimer);
                shutdownAbortController.signal.removeEventListener("abort", abortForShutdown);
              }
              const state = {
                pipeline: candidate,
                webSocket,
                audioTail: Promise.resolve(),
                pendingFrames: 0,
                settings: {
                  sessionId: claims.sessionId,
                  version: hostMessage.version,
                  sessionType: hostMessage.sessionType,
                  outputMode: hostMessage.outputMode,
                  voiceProvider: hostMessage.voiceProvider,
                  maxViewers: hostMessage.maxViewers,
                  glossaryPack: hostMessage.glossaryPack,
                  languages: [...hostMessage.languages],
                },
                leaseTimer: null,
                leaseAbortController: null,
                leaseInFlight: null,
              };
              hostSessions.set(claims.sessionId, state);
              startHostLease(state, claims);
              if (previous) {
                stopHostLease(previous);
                await closePipelineOnce(previous.pipeline).catch(() => undefined);
              }
              if (previous?.webSocket !== webSocket) previous?.webSocket.close(4410, "REPLACED");
              metrics.set("host_sessions", hostSessions.size);
              return {
                sessionType: hostMessage.sessionType,
                outputMode: hostMessage.outputMode,
                voiceProvider: hostMessage.voiceProvider,
                maxViewers: hostMessage.maxViewers,
                glossaryPack: hostMessage.glossaryPack,
              };
            });
            sendJson(webSocket, {
              type: message.type === "update" ? "updated" : "started",
              sessionId: claims.sessionId,
              sessionType: prepared.sessionType,
              outputMode: prepared.outputMode,
              voiceProvider: prepared.voiceProvider,
              maxViewers: prepared.maxViewers,
              glossaryPack: prepared.glossaryPack,
              languages: hostMessage.languages,
              audio: { sampleRate: AUDIO_CONFIG.inputSampleRate, channels: 1, chunkMilliseconds: AUDIO_CONFIG.chunkMilliseconds },
            });
            // The replaced pipeline owned any speaking-floor attribution.
            await releaseFloor(claims.sessionId, { reason: "session-updated" }).catch(() => undefined);
          } catch (error) {
            const code = error instanceof Error ? error.message : "PIPELINE_START_FAILED";
            sendJson(webSocket, { type: "error", code, message: gatewayMessage(code) });
          }
          return;
        }
        if (isBinary) {
          const holder = floorHolders.get(claims.sessionId);
          if (!holder || holder.webSocket !== webSocket) {
            // Frames race speak-ended after a preemption; dropping them keeps
            // the viewer connection (and their captions) alive.
            metrics.increment("dropped_audio_frames_total");
            return;
          }
          const state = hostSessions.get(claims.sessionId);
          if (!state) throw new Error("SESSION_NOT_STARTED");
          if (data.byteLength !== INPUT_FRAME_BYTES) throw new Error("INVALID_AUDIO_FRAME");
          consumeAudioBudget(claims.sessionId, data.byteLength);
          if (holder.pendingFrames * AUDIO_CONFIG.chunkMilliseconds >= AUDIO_CONFIG.staleFrameMilliseconds) {
            metrics.increment("dropped_audio_frames_total");
            return;
          }
          holder.pendingFrames += 1;
          const capturedAt = Date.now();
          holder.audioTail = holder.audioTail
            .then(() => state.pipeline.acceptAudio(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), capturedAt))
            .catch(() => releaseFloor(claims.sessionId, { reason: "error" }))
            .finally(() => { holder.pendingFrames -= 1; });
          metrics.increment("floor_audio_frames_total");
          return;
        }
        const message = parseJson(data);
        if (message.type === "speak-start") {
          if (!floorController) throw new Error("FLOOR_UNAVAILABLE");
          if (!viewerMetadata.get(webSocket)) throw new Error("INVALID_SUBSCRIPTION");
          const state = hostSessions.get(claims.sessionId);
          if (!state) {
            sendJson(webSocket, { type: "error", code: "SESSION_NOT_STARTED", message: gatewayMessage("SESSION_NOT_STARTED") });
            return;
          }
          const result = await floorController.take(claims.sessionId, claims.grantId);
          if (result?.ok !== true) {
            const code = typeof result?.code === "string" ? result.code : "FLOOR_DENIED";
            sendJson(webSocket, { type: "error", code, message: gatewayMessage(code) });
            return;
          }
          const previous = floorHolders.get(claims.sessionId);
          const holder = {
            webSocket,
            grantId: claims.grantId,
            displayName: typeof result.displayName === "string" && result.displayName.trim() ? result.displayName.trim() : "참가자",
            pendingFrames: 0,
            audioTail: Promise.resolve(),
          };
          floorHolders.set(claims.sessionId, holder);
          if (previous && previous.webSocket !== webSocket) {
            sendJson(previous.webSocket, { type: "speak-ended", sessionId: claims.sessionId, reason: "preempted" });
          }
          try {
            state.pipeline.setFloorSpeaker?.({ grantId: holder.grantId, displayName: holder.displayName });
          } catch {
            // Pipeline attribution is best-effort; the floor grant already succeeded.
          }
          metrics.increment("floor_takes_total");
          sendJson(webSocket, {
            type: "speak-started",
            sessionId: claims.sessionId,
            displayName: holder.displayName,
            audio: { sampleRate: AUDIO_CONFIG.inputSampleRate, channels: 1, chunkMilliseconds: AUDIO_CONFIG.chunkMilliseconds },
          });
          await broadcastFloor(claims.sessionId, holder);
          return;
        }
        if (message.type === "speak-end") {
          await releaseFloor(claims.sessionId, { grantId: claims.grantId });
          return;
        }
        if (message.type === "unsubscribe") {
          await releaseFloor(claims.sessionId, { grantId: claims.grantId });
          removeViewer(topic, webSocket, viewerTopics);
          topic = null;
          if (reauthorizeTimer) clearReauthorizeIntervalFn(reauthorizeTimer);
          reauthorizeTimer = null;
          reauthorizeInFlight = null;
          reauthorizeGeneration += 1;
          viewerMetadata.delete(webSocket);
          for (const abortController of authorizationControllers) abortController.abort();
          return;
        }
        if (message.type !== "subscribe"
          || message.sessionId !== claims.sessionId
          || typeof message.language !== "string"
          || !LANGUAGE_CODE_PATTERN.test(message.language)) {
          throw new Error("INVALID_SUBSCRIPTION");
        }
        if (!await runViewerAuthorization(message.sessionId, message.language)) throw new Error("GRANT_REVOKED");
        removeViewer(topic, webSocket, viewerTopics);
        topic = `${message.sessionId}:${message.language}`;
        const viewers = viewerTopics.get(topic) ?? new Set();
        viewers.add(webSocket);
        viewerTopics.set(topic, viewers);
        viewerMetadata.set(webSocket, {
          claims,
          sessionId: message.sessionId,
          language: message.language,
          lastAuthorizedAt: now(),
          ensureAuthorized: ensureViewerAuthorization,
        });
        metrics.set("viewer_connections", [...viewerTopics.values()].reduce((sum, topicViewers) => sum + topicViewers.size, 0));
        sendJson(webSocket, { type: "subscribed", sessionId: message.sessionId, language: message.language });
        if (reauthorizeTimer) clearReauthorizeIntervalFn(reauthorizeTimer);
        reauthorizeGeneration += 1;
        const currentReauthorizeGeneration = reauthorizeGeneration;
        reauthorizeTimer = setReauthorizeIntervalFn(() => {
          if (currentReauthorizeGeneration === reauthorizeGeneration) void ensureViewerAuthorization({ force: true });
        }, AUTHORIZATION_CADENCE_MILLISECONDS);
      } catch (error) {
        const code = error instanceof Error ? error.message : "GATEWAY_ERROR";
        closeWithError(webSocket, code, gatewayMessage(code), code === "UNAUTHORIZED" ? 4401 : 4400);
      }
    });

    webSocket.on("close", async () => {
      cleanupTimers();
      connectionCleanup.delete(webSocket);
      removeViewer(topic, webSocket, viewerTopics);
      if (claims && claims.role !== "HOST" && floorHolders.get(claims.sessionId)?.webSocket === webSocket) {
        await releaseFloor(claims.sessionId, { grantId: claims.grantId, notifyHolder: false }).catch(() => undefined);
      }
      if (claims?.role === "HOST") {
        if (hostSessions.get(claims.sessionId)?.webSocket === webSocket) {
          await releaseFloor(claims.sessionId, { reason: "session-ended" }).catch(() => undefined);
        }
        await withHostSessionLock(claims.sessionId, async () => {
          const current = hostSessions.get(claims.sessionId);
          if (current?.webSocket !== webSocket) return;
          hostSessions.delete(claims.sessionId);
          stopHostLease(current);
          await closePipelineOnce(current.pipeline).catch(() => undefined);
        }, { bypassQueueLimit: true });
      }
      metrics.set("host_sessions", hostSessions.size);
      metrics.set("viewer_connections", [...viewerTopics.values()].reduce((sum, viewers) => sum + viewers.size, 0));
    });
  });

  return {
    server,
    metrics,
    async broadcastEvent(sessionId, language, event) {
      await deliverToAuthorizedViewers(sessionId, language, (viewer) => sendJson(viewer, { type: "live-event", payload: event }));
    },
    async broadcastAudio(sessionId, language, frame) {
      await deliverToAuthorizedViewers(sessionId, language, (viewer) => {
        if (viewer.readyState !== WebSocket.OPEN) return;
        if (slowConsumerPredicate(viewer)) {
          metrics.increment("slow_consumers_terminated_total");
          closeWithError(viewer, "SLOW_CONSUMER", "오디오 재생이 네트워크 속도를 따라가지 못해 연결을 종료합니다.", 4408);
          return;
        }
        viewer.send(frame, { binary: true });
      });
    },
    async close() {
      if (isShuttingDown) return;
      isShuttingDown = true;
      shutdownAbortController.abort(new Error("GATEWAY_SHUTTING_DOWN"));
      clearInterval(tickTimer);
      clearInterval(heartbeatTimer);
      await Promise.all([...hostOperationTails.values()]);
      // 2026-07-19 fix: detach ownership before terminating sockets. Their close
      // handlers must not observe and close a pipeline already owned by shutdown.
      const ownedHostStates = [...hostSessions.values()];
      hostSessions.clear();
      metrics.set("host_sessions", 0);
      for (const state of ownedHostStates) {
        stopHostLease(state);
        await closePipelineOnce(state.pipeline).catch(() => undefined);
      }
      for (const pipeline of [...pipelinesPendingClose]) await closePipelineOnce(pipeline).catch(() => undefined);
      for (const client of webSockets.clients) {
        connectionCleanup.get(client)?.();
        client.terminate();
      }
      connectionCleanup.clear();
      sessionAudioUsage.clear();
      await new Promise((resolve) => webSockets.close(resolve));
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };

  function closePipelineSocket(webSocket, error) {
    const code = error instanceof Error ? error.message : "PIPELINE_FAILED";
    closeWithError(webSocket, code, gatewayMessage(code), 1011);
  }

  async function deliverToAuthorizedViewers(sessionId, language, deliver) {
    const viewers = [...(viewerTopics.get(`${sessionId}:${language}`) ?? [])];
    await Promise.all(viewers.map(async (viewer) => {
      if (viewer.readyState !== WebSocket.OPEN) return;
      const metadata = viewerMetadata.get(viewer);
      if (!metadata || !await metadata.ensureAuthorized()) return;
      if (viewer.readyState === WebSocket.OPEN) deliver(viewer);
    }));
  }
}

function parseJson(data) {
  const value = JSON.parse(data.toString("utf8"));
  if (!value || typeof value !== "object") throw new Error("INVALID_MESSAGE");
  return value;
}

function rejectUpgrade(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function sendJson(webSocket, message) {
  if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(message));
}

function closeWithError(webSocket, code, message, closeCode) {
  sendJson(webSocket, { type: "error", code, message });
  webSocket.close(closeCode, code.slice(0, 120));
}

function onceOnly(callback) {
  let didRun = false;
  return () => {
    if (didRun) return;
    didRun = true;
    callback();
  };
}

function waitForAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function removeViewer(topic, webSocket, topics) {
  if (!topic) return;
  const viewers = topics.get(topic);
  viewers?.delete(webSocket);
  if (viewers?.size === 0) topics.delete(topic);
}

function gatewayMessage(code) {
  if (code === "GRANT_REVOKED") return "시청 권한이 만료되었거나 회수되었습니다.";
  if (code === "UNAUTHORIZED") return "게이트웨이 인증에 실패했습니다.";
  if (code === "TOKEN_EXPIRED") return "게이트웨이 인증이 만료되었습니다.";
  if (code === "SESSION_REVOKED" || code === "SESSION_STOPPED") return "라이브 세션이 종료되었거나 설정이 변경되었습니다.";
  if (code === "SLOW_CONSUMER") return "오디오 재생이 네트워크 속도를 따라가지 못해 연결을 종료합니다.";
  if (code === "FLOOR_DENIED" || code === "SESSION_NOT_LIVE") return "지금은 발언권을 가져올 수 없습니다.";
  if (code === "GRANT_INVALID") return "발언 권한이 확인되지 않았습니다. 다시 입장해 주세요.";
  if (code === "FLOOR_UNAVAILABLE") return "이 게이트웨이에서는 발언 기능을 사용할 수 없습니다.";
  if (code === "SESSION_NOT_STARTED") return "라이브 세션이 아직 시작되지 않았습니다.";
  if (code === "QUEUE_LATENCY_EXCEEDED") return "지연된 음성 작업을 건너뛰고 자동으로 재시작했습니다.";
  return "미디어 게이트웨이 요청을 처리할 수 없습니다.";
}
