import { createServer } from "node:http";

import { WebSocket, WebSocketServer } from "ws";

import { AUDIO_CONFIG, normalizeLiveLanguage, validateLiveSettings } from "./config.js";
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
const INPUT_FRAME_BYTES = AUDIO_CONFIG.inputSampleRate * 2 * AUDIO_CONFIG.chunkMilliseconds / 1_000;
const INPUT_BYTES_PER_SECOND = AUDIO_CONFIG.inputSampleRate * 2;
/** Applies only when a take would cut off a live speaker, so the floor cannot
 *  be volleyed back and forth between two participants. */
const DEFAULT_FLOOR_TAKE_COOLDOWN_MILLISECONDS = 2_000;
/** Applies when the floor is unowned. Retaking a free floor interrupts nobody,
 *  so the only thing left to limit is `floorController.take` write volume --
 *  long enough to collapse a double tap, short enough to feel instant when a
 *  speaker answers straight back after the host cut in. */
const DEFAULT_FLOOR_RESUME_COOLDOWN_MILLISECONDS = 250;
/** A floor holder streams every 40ms while holding, so this only trips when a
 *  client is genuinely gone. Generous enough to survive a network hiccup or a
 *  briefly backgrounded mobile tab. */
const DEFAULT_FLOOR_IDLE_RELEASE_MILLISECONDS = 8_000;
/** Cap on live events held while one viewer's caption replay is in flight.
 *  Sized well above a normal replay round-trip so healthy sessions never hit
 *  it, and far below anything that would matter for memory over a long call. */
const MAX_REPLAY_BUFFER_EVENTS = 500;
const DEFAULT_DURABLE_RECOVERY_RETRY_DELAYS_MILLISECONDS = [1_000, 2_000, 4_000, 8_000, 16_000, 20_000];
const DEFAULT_DURABLE_RECOVERY_ATTEMPT_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_RECOVERY_AUDIO_SPOOL_MILLISECONDS = 30_000;

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
  floorTakeCooldownMilliseconds = DEFAULT_FLOOR_TAKE_COOLDOWN_MILLISECONDS,
  floorResumeCooldownMilliseconds = null,
  floorIdleReleaseMilliseconds = DEFAULT_FLOOR_IDLE_RELEASE_MILLISECONDS,
  hostReconnectGraceMilliseconds = 90_000,
  fetchFloorParticipant = null,
  replayUtterances = null,
  replayTimeoutMilliseconds = 5_000,
  durableRecoveryRetryDelaysMilliseconds = DEFAULT_DURABLE_RECOVERY_RETRY_DELAYS_MILLISECONDS,
  durableRecoveryAttemptTimeoutMilliseconds = DEFAULT_DURABLE_RECOVERY_ATTEMPT_TIMEOUT_MILLISECONDS,
  recoveryAudioSpoolMilliseconds = DEFAULT_RECOVERY_AUDIO_SPOOL_MILLISECONDS,
}) {
  if (!Number.isFinite(heartbeatIntervalMilliseconds) || heartbeatIntervalMilliseconds <= 0) throw new Error("INVALID_HEARTBEAT_INTERVAL");
  if (!Number.isFinite(viewerAuthorizeTimeoutMilliseconds) || viewerAuthorizeTimeoutMilliseconds <= 0) throw new Error("INVALID_VIEWER_AUTHORIZE_TIMEOUT");
  if (!Number.isFinite(hostStartTimeoutMilliseconds) || hostStartTimeoutMilliseconds <= 0) throw new Error("INVALID_HOST_START_TIMEOUT");
  if (!Number.isFinite(replayTimeoutMilliseconds) || replayTimeoutMilliseconds <= 0) throw new Error("INVALID_REPLAY_TIMEOUT");
  if (!Array.isArray(durableRecoveryRetryDelaysMilliseconds)
    || durableRecoveryRetryDelaysMilliseconds.length === 0
    || durableRecoveryRetryDelaysMilliseconds.some((delay) => !Number.isFinite(delay) || delay < 0 || delay > 20_000)) {
    throw new Error("INVALID_DURABLE_RECOVERY_RETRY_DELAYS");
  }
  if (!Number.isFinite(durableRecoveryAttemptTimeoutMilliseconds)
    || durableRecoveryAttemptTimeoutMilliseconds <= 0
    || durableRecoveryAttemptTimeoutMilliseconds > 60_000) {
    throw new Error("INVALID_DURABLE_RECOVERY_ATTEMPT_TIMEOUT");
  }
  if (!Number.isFinite(recoveryAudioSpoolMilliseconds)
    || recoveryAudioSpoolMilliseconds < AUDIO_CONFIG.chunkMilliseconds
    || recoveryAudioSpoolMilliseconds > DEFAULT_RECOVERY_AUDIO_SPOOL_MILLISECONDS) {
    throw new Error("INVALID_RECOVERY_AUDIO_SPOOL_WINDOW");
  }
  if (!Number.isSafeInteger(maxQueuedHostOperations) || maxQueuedHostOperations < 0) throw new Error("INVALID_HOST_QUEUE_LIMIT");
  if (!Number.isFinite(audioBurstMilliseconds) || audioBurstMilliseconds < AUDIO_CONFIG.chunkMilliseconds) throw new Error("INVALID_AUDIO_BURST");
  if (!Number.isFinite(maxSessionAudioMilliseconds) || maxSessionAudioMilliseconds <= 0) throw new Error("INVALID_SESSION_AUDIO_DURATION");
  if (!Number.isSafeInteger(maxSessionAudioBytes) || maxSessionAudioBytes < INPUT_FRAME_BYTES) throw new Error("INVALID_SESSION_AUDIO_BYTES");
  if (!Number.isSafeInteger(maxSessionAudioEntries) || maxSessionAudioEntries < 1) throw new Error("INVALID_SESSION_AUDIO_ENTRIES");
  if (!Number.isFinite(floorTakeCooldownMilliseconds) || floorTakeCooldownMilliseconds < 0) {
    throw new Error("INVALID_FLOOR_TAKE_COOLDOWN");
  }
  if (floorResumeCooldownMilliseconds !== null
    && (!Number.isFinite(floorResumeCooldownMilliseconds) || floorResumeCooldownMilliseconds < 0)) {
    throw new Error("INVALID_FLOOR_RESUME_COOLDOWN");
  }
  // Never throttle a harmless retake harder than a preemption, and keep
  // `floorTakeCooldownMilliseconds: 0` meaning "no floor rate limiting at all"
  // for the callers that already relied on that single knob.
  const resumeCooldownMilliseconds = floorResumeCooldownMilliseconds
    ?? Math.min(DEFAULT_FLOOR_RESUME_COOLDOWN_MILLISECONDS, floorTakeCooldownMilliseconds);
  if (!Number.isFinite(hostReconnectGraceMilliseconds) || hostReconnectGraceMilliseconds < 0) {
    throw new Error("INVALID_HOST_RECONNECT_GRACE");
  }
  const hostSessions = new Map();
  const hostOperationTails = new Map();
  const hostOperationCounts = new Map();
  const floorOperationTails = new Map();
  const successfullyClosedPipelines = new WeakSet();
  const pipelineCloseFlights = new WeakMap();
  const pipelinesPendingClose = new Set();
  const viewerTopics = new Map();
  const viewerMetadata = new WeakMap();
  const floorHolders = new Map();
  const floorTakeAttempts = new Map();
  const participantProfiles = new Map();
  const connectionCleanup = new Map();
  const sessionAudioUsage = new Map();
  const shutdownAbortController = new AbortController();
  let isShuttingDown = false;
  const audioBurstBytes = INPUT_BYTES_PER_SECOND * audioBurstMilliseconds / 1_000;
  const recoveryAudioSpoolMaxBytes = INPUT_BYTES_PER_SECOND * recoveryAudioSpoolMilliseconds / 1_000;
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
  const withFloorSessionLock = (sessionId, operation) => {
    const previous = floorOperationTails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.catch(() => undefined);
    floorOperationTails.set(sessionId, tail);
    void tail.then(() => {
      if (floorOperationTails.get(sessionId) === tail) floorOperationTails.delete(sessionId);
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
  // JSON live-events funnel through here so a viewer that is replaying missed
  // captions buffers concurrent live events instead of receiving them early.
  const deliverEvent = (sessionId, language, payload) => deliverToAuthorizedViewers(
    sessionId,
    language,
    (viewer) => {
      const metadata = viewerMetadata.get(viewer);
      if (metadata?.replayBuffer) {
        // Bounded on purpose. This buffer exists only to hold live events for
        // the duration of one Supabase replay round-trip; a slow or hung replay
        // used to let it grow without limit for the rest of a multi-hour
        // session. On overflow, stop buffering and deliver live instead —
        // that is safe because the viewer's committed-seq guard drops any
        // lower-seq final the replay subsequently re-sends, so nothing is
        // duplicated and nothing is lost.
        if (metadata.replayBuffer.length >= MAX_REPLAY_BUFFER_EVENTS) {
          metrics.increment("replay_buffer_overflow_total");
          metadata.replayBuffer = null;
        } else {
          metadata.replayBuffer.push(payload);
          return;
        }
      }
      sendJson(viewer, { type: "live-event", payload });
    },
  );
  const lookupParticipantProfile = async (sessionId, participantId) => {
    if (typeof fetchFloorParticipant !== "function") return null;
    const cacheKey = `${sessionId}\u0000${participantId}`;
    if (participantProfiles.has(cacheKey)) return participantProfiles.get(cacheKey);
    let profile = null;
    try {
      profile = await fetchFloorParticipant(sessionId, participantId) ?? null;
    } catch {
      profile = null; // identity enrichment is best-effort
    }
    if (profile !== null || participantProfiles.size < 10_000) participantProfiles.set(cacheKey, profile);
    return profile;
  };
  const broadcastFloor = async (sessionId, holder) => {
    const state = hostSessions.get(sessionId);
    const payload = {
      type: "floor",
      sessionId,
      holder: holder
        ? {
          participantId: holder.participantId,
          name: holder.displayName,
          department: holder.department ?? "",
          jobTitle: holder.jobTitle ?? "",
        }
        : null,
    };
    if (state) sendJson(state.webSocket, payload);
    const languages = state?.settings.languages ?? [];
    await Promise.all(languages.map((language) => deliverEvent(sessionId, language, payload)));
  };
  const broadcastSessionStatus = async (sessionId, status) => {
    const state = hostSessions.get(sessionId);
    const payload = { type: "session-status", sessionId, status };
    const languages = state?.settings.languages ?? [];
    await Promise.all(languages.map((language) => deliverEvent(sessionId, language, payload)));
  };
  const spoolRecoveryAudio = (state, frame, capturedAt, capturedFloorSpeaker, frameOrder) => {
    const cutoff = capturedAt - recoveryAudioSpoolMilliseconds;
    while (state.recoveryAudioSpool.length > 0
      && (state.recoveryAudioSpool[0].capturedAt < cutoff
        || state.recoveryAudioSpoolBytes + frame.byteLength > recoveryAudioSpoolMaxBytes)) {
      const dropped = state.recoveryAudioSpool.shift();
      state.recoveryAudioSpoolBytes -= dropped.frame.byteLength;
      metrics.increment("durable_recovery_audio_frames_dropped_total");
    }
    if (frame.byteLength > recoveryAudioSpoolMaxBytes) {
      metrics.increment("durable_recovery_audio_frames_dropped_total");
      return false;
    }
    state.recoveryAudioSpool.push({
      frame: Uint8Array.from(frame),
      capturedAt,
      capturedFloorSpeaker,
      frameOrder,
    });
    state.recoveryAudioSpool.sort((left, right) => left.frameOrder - right.frameOrder);
    state.recoveryAudioSpoolBytes += frame.byteLength;
    metrics.increment("durable_recovery_audio_frames_spooled_total");
    return true;
  };
  const drainRecoveryAudio = async (state, candidate) => {
    const cutoff = now() - recoveryAudioSpoolMilliseconds;
    while (state.recoveryAudioSpool.length > 0
      && state.recoveryAudioSpool[0].capturedAt < cutoff) {
      const dropped = state.recoveryAudioSpool.shift();
      state.recoveryAudioSpoolBytes -= dropped.frame.byteLength;
      metrics.increment("durable_recovery_audio_frames_dropped_total");
    }
    while (state.recoveryAudioSpool.length > 0) {
      const queued = state.recoveryAudioSpool.shift();
      state.recoveryAudioSpoolBytes -= queued.frame.byteLength;
      // The fresh replacement owns a new provider stream. Re-stamp delivery
      // time so its normal 750ms stale-frame guard does not discard audio that
      // was intentionally retained by the bounded recovery spool.
      await candidate.acceptAudio(queued.frame, now(), queued.capturedFloorSpeaker);
    }
  };
  const requestPipelineRecovery = (sessionId, failedPipeline, error) => {
    const state = hostSessions.get(sessionId);
    if (!state || state.pipeline !== failedPipeline) return Promise.resolve();
    if (state.recoveryFlight) return state.recoveryFlight;
    // Quarantine immediately. The failed pipeline may have consumed a seq whose
    // commit outcome is ambiguous; no later audio may enter it while the
    // durable reconciliation/replacement loop is running.
    const shouldRestorePaused = failedPipeline.isPaused === true;
    try { failedPipeline.pause?.(); } catch { /* the audio gates below remain authoritative */ }
    const recoveryAbortController = new AbortController();
    state.recoveryAbortController = recoveryAbortController;
    const recoveryFlight = (async () => {
      let failureCount = 0;
      while (!recoveryAbortController.signal.aborted && !isShuttingDown) {
        const didRecover = await withHostSessionLock(sessionId, async () => {
          const current = hostSessions.get(sessionId);
          if (!current || current !== state || current.pipeline !== failedPipeline) return true;
          let candidate = null;
          const attemptAbortController = new AbortController();
          current.recoveryAttemptAbortController = attemptAbortController;
          const abortAttempt = () => attemptAbortController.abort(
            recoveryAbortController.signal.reason ?? new Error("DURABLE_RECOVERY_CANCELLED"),
          );
          recoveryAbortController.signal.addEventListener("abort", abortAttempt, { once: true });
          const attemptTimer = setTimeoutFn(
            () => attemptAbortController.abort(new Error("DURABLE_RECOVERY_ATTEMPT_TIMEOUT")),
            durableRecoveryAttemptTimeoutMilliseconds,
          );
          attemptTimer?.unref?.();
          try {
            const factoryPromise = Promise.resolve().then(() => pipelineFactory(
              current.settings,
              failedPipeline,
              (event) => sendJson(current.hostOutput.webSocket, event),
              {
                signal: attemptAbortController.signal,
                recoveryReason: "durable-caption",
                onFatalError: (fatalError) => requestPipelineRecovery(sessionId, candidate, fatalError),
              },
            ));
            void factoryPromise.then((lateCandidate) => {
              if (attemptAbortController.signal.aborted) {
                return closePipelineOnce(lateCandidate).catch(() => undefined);
              }
              return undefined;
            }, () => undefined);
            candidate = await waitForAbort(
              factoryPromise,
              attemptAbortController.signal,
            );
            await waitForAbort(
              candidate.start({ signal: attemptAbortController.signal }),
              attemptAbortController.signal,
            );
            const holder = floorHolders.get(sessionId);
            if (holder) {
              candidate.setFloorSpeaker?.({
                participantId: holder.participantId,
                displayName: holder.displayName,
                department: holder.department,
                jobTitle: holder.jobTitle,
              });
            }
            if (shouldRestorePaused) candidate.pause?.();
            const activeHolder = floorHolders.get(sessionId);
            await Promise.all([
              current.audioTail.catch(() => undefined),
              activeHolder?.audioTail?.catch(() => undefined),
            ]);
            await drainRecoveryAudio(current, candidate);
            current.pipeline = candidate;
            metrics.increment("durable_caption_recoveries_total");
            await closePipelineOnce(failedPipeline).catch(() => {
              metrics.increment("pipeline_close_failures_total");
            });
            return true;
          } catch {
            metrics.increment("durable_caption_recovery_failures_total");
            await closePipelineOnce(candidate).catch(() => undefined);
            return false;
          } finally {
            clearTimeoutFn(attemptTimer);
            recoveryAbortController.signal.removeEventListener("abort", abortAttempt);
            if (current.recoveryAttemptAbortController === attemptAbortController) {
              current.recoveryAttemptAbortController = null;
            }
          }
        }, { bypassQueueLimit: true });
        if (didRecover || recoveryAbortController.signal.aborted || isShuttingDown) return;
        const delay = durableRecoveryRetryDelaysMilliseconds[Math.min(
          failureCount,
          durableRecoveryRetryDelaysMilliseconds.length - 1,
        )];
        failureCount += 1;
        if (!await waitForDelay(delay, recoveryAbortController.signal, setTimeoutFn, clearTimeoutFn)) return;
      }
    })();
    state.recoveryFlight = recoveryFlight.finally(() => {
      const current = hostSessions.get(sessionId);
      if (current === state && current.recoveryFlight === state.recoveryFlight) {
        current.recoveryFlight = null;
        current.recoveryAbortController = null;
      }
    });
    return state.recoveryFlight;
  };
  const releaseFloor = (sessionId, { grantId = null, reason = "ended", notifyHolder = true } = {}) => withFloorSessionLock(sessionId, async () => {
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
  });
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
    // Release a floor that has gone silent. Host audio is dropped outright while
    // ANY participant holds the floor, so a holder whose client died without
    // sending speak-end (lost message, crashed tab, backgrounded mobile app)
    // stalled the ENTIRE meeting: their frames stopped and the host's were
    // discarded, so nothing reached the pipeline and captions froze with no
    // automatic recovery. Releasing hands the floor back and notifies the holder
    // so their UI resets instead of showing a live mic that is not connected.
    for (const [sessionId, holder] of floorHolders) {
      if (now() - holder.lastFrameAt < floorIdleReleaseMilliseconds) continue;
      metrics.increment("floor_idle_releases_total");
      void releaseFloor(sessionId, { grantId: holder.grantId, reason: "idle" }).catch(() => undefined);
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
    let replayAbortController = null;
    let replayGeneration = 0;
    let tokenExpiryTimer = null;
    const authorizationControllers = new Set();
    const cancelReplay = () => {
      replayGeneration += 1;
      replayAbortController?.abort(new Error("REPLAY_CANCELLED"));
      replayAbortController = null;
    };
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
      cancelReplay();
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
            const capturedAt = now();
            const frameOrder = ++state.nextAudioFrameOrder;
            if (state.recoveryFlight) {
              spoolRecoveryAudio(
                state,
                new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
                capturedAt,
                null,
                frameOrder,
              );
              metrics.increment("audio_frames_total");
              return;
            }
            if (state.pendingFrames * AUDIO_CONFIG.chunkMilliseconds >= AUDIO_CONFIG.staleFrameMilliseconds) {
              metrics.increment("dropped_audio_frames_total");
              return;
            }
            state.pendingFrames += 1;
            state.audioTail = state.audioTail
              .then(async () => {
                if (state.recoveryFlight) {
                  spoolRecoveryAudio(
                    state,
                    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
                    capturedAt,
                    null,
                    frameOrder,
                  );
                  return;
                }
                return state.pipeline.acceptAudio(
                  new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
                  capturedAt,
                  null,
                );
              })
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
          if (message.type === "host-speak") {
            // The host reclaims the speaking floor from a participant (e.g.
            // the guest finished talking but never pressed Stop). Releasing
            // reopens the HOST binary-audio gate above; with no holder this
            // is an idempotent ack.
            await releaseFloor(claims.sessionId, { reason: "host-preempt" }).catch(() => undefined);
            sendJson(webSocket, { type: "host-speak-started", sessionId: claims.sessionId });
            return;
          }
          if (message.type === "pause" || message.type === "resume") {
            if (active?.webSocket !== webSocket) {
              sendJson(webSocket, { type: "error", code: "SESSION_NOT_STARTED", message: gatewayMessage("SESSION_NOT_STARTED") });
              return;
            }
            if (message.type === "pause") await active.pipeline.pause?.();
            else await active.pipeline.resume?.();
            const status = message.type === "pause" ? "paused" : "live";
            sendJson(webSocket, { type: message.type === "pause" ? "paused" : "resumed", sessionId: claims.sessionId });
            await broadcastSessionStatus(claims.sessionId, status);
            return;
          }
          if (!["start", "update", "restart"].includes(message.type)
            || message.sessionId !== claims.sessionId
            || !Number.isSafeInteger(message.version)) throw new Error("INVALID_START");
          const normalizedSettings = validateLiveSettings(message);
          const hostMessage = {
            ...message,
            ...normalizedSettings,
            sessionId: claims.sessionId,
          };
          // A hung reconciliation/factory attempt must not sit in front of a
          // host reattach, explicit restart, or settings update on the session
          // lock. Cancelling only the current attempt keeps the recovery
          // coordinator alive when the same detached session reattaches.
          hostSessions.get(claims.sessionId)?.recoveryAttemptAbortController?.abort(
            new Error("HOST_OPERATION_PREEMPT"),
          );
          try {
            const prepared = await withHostSessionLock(claims.sessionId, async () => {
              if (shutdownAbortController.signal.aborted) throw shutdownAbortController.signal.reason;
              const previous = hostSessions.get(claims.sessionId);
              // Host reconnect within the grace window (contract C3): the same
              // host re-authenticating with unchanged settings reattaches the
              // detached pipeline — seq counters and the speaking floor survive.
              if (message.type === "start" && previous?.detached && isSameHostSettings(previous.settings, hostMessage)) {
                const reattachAbortController = new AbortController();
                const reattachTimer = setTimeoutFn(
                  () => reattachAbortController.abort(new Error("HOST_START_TIMEOUT")),
                  hostStartTimeoutMilliseconds,
                );
                try {
                  const isAuthorized = await authorizeHost(claims, hostMessage, reattachAbortController, {
                    requireLive: true,
                    compareVersion: false,
                  });
                  if (!isAuthorized) throw new Error("SESSION_REVOKED");
                } finally {
                  clearTimeoutFn(reattachTimer);
                }
                if (previous.graceTimer) {
                  clearTimeoutFn(previous.graceTimer);
                  previous.graceTimer = null;
                }
                previous.detached = false;
                previous.webSocket = webSocket;
                // 2026-07-26 fix: the preserved pipeline owns a mutable output sink. Updating
                // it makes captions follow the newly attached host instead of
                // continuing to write to the closed pre-reconnect socket.
                previous.hostOutput.webSocket = webSocket;
                previous.settings.version = hostMessage.version;
                stopHostLease(previous);
                startHostLease(previous, claims);
                metrics.increment("host_reattaches_total");
                return {
                  reattached: true,
                  sessionType: previous.settings.sessionType,
                  outputMode: previous.settings.outputMode,
                  voiceProvider: previous.settings.voiceProvider,
                  maxViewers: previous.settings.maxViewers,
                  glossaryPack: previous.settings.glossaryPack,
                };
              }
              let candidate = null;
              const hostOutput = { webSocket };
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
                  requireLive: true,
                  compareVersion: true,
                });
                if (!isAuthorized) throw new Error("SESSION_REVOKED");
                const factoryPromise = Promise.resolve().then(() => pipelineFactory(
                  hostMessage,
                  previous?.pipeline ?? null,
                  (event) => sendJson(hostOutput.webSocket, event),
                  {
                    signal: operationAbortController.signal,
                    onFatalError: (error) => requestPipelineRecovery(claims.sessionId, candidate, error),
                  },
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
                  requireLive: true,
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
                hostOutput,
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
                  // isSameHostSettings compares these, so they must be preserved here:
                  // omitting them made every reattach read undefined and rebuild the
                  // pipeline (translationTone alone defaults to "natural", never "").
                  glossaryText: hostMessage.glossaryText,
                  translationTone: hostMessage.translationTone,
                  domainText: hostMessage.domainText,
                  languages: [...hostMessage.languages],
                },
                leaseTimer: null,
                leaseAbortController: null,
                leaseInFlight: null,
                detached: false,
                graceTimer: null,
                recoveryFlight: null,
                recoveryAbortController: null,
                recoveryAttemptAbortController: null,
                recoveryAudioSpool: [],
                recoveryAudioSpoolBytes: 0,
                nextAudioFrameOrder: 0,
              };
              hostSessions.set(claims.sessionId, state);
              startHostLease(state, claims);
              if (previous) {
                previous.recoveryAbortController?.abort(new Error("PIPELINE_REPLACED"));
                stopHostLease(previous);
                if (previous.graceTimer) {
                  clearTimeoutFn(previous.graceTimer);
                  previous.graceTimer = null;
                }
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
              type: message.type === "update" ? "updated" : message.type === "restart" ? "restarted" : "started",
              sessionId: claims.sessionId,
              sessionType: prepared.sessionType,
              outputMode: prepared.outputMode,
              voiceProvider: prepared.voiceProvider,
              maxViewers: prepared.maxViewers,
              glossaryPack: prepared.glossaryPack,
              languages: hostMessage.languages,
              audio: { sampleRate: AUDIO_CONFIG.inputSampleRate, channels: 1, chunkMilliseconds: AUDIO_CONFIG.chunkMilliseconds },
            });
            // Viewers previously learned about go-live only via their 10s REST
            // status poll; pushing it here makes the transition immediate for
            // everyone already connected to the gateway.
            await broadcastSessionStatus(claims.sessionId, "live");
            if (prepared.reattached) {
              // Reattach keeps the running pipeline, its floor attribution,
              // and the seq counters untouched.
            } else if (message.type === "restart") {
              const holder = floorHolders.get(claims.sessionId);
              if (holder) {
                try {
                  hostSessions.get(claims.sessionId)?.pipeline.setFloorSpeaker?.({
                    participantId: holder.participantId,
                    displayName: holder.displayName,
                    department: holder.department,
                    jobTitle: holder.jobTitle,
                  });
                } catch {
                  // A caption-channel recovery must not revoke the floor.
                }
              }
            } else {
              // Configuration changes replace the interpretation contract, so
              // release the old floor. A restart above deliberately preserves it.
              await releaseFloor(claims.sessionId, { reason: "session-updated" }).catch(() => undefined);
            }
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
          holder.lastFrameAt = now();
          const capturedAt = now();
          const frameOrder = ++state.nextAudioFrameOrder;
          const capturedFloorSpeaker = {
            participantId: holder.participantId,
            displayName: holder.displayName,
            department: holder.department,
            jobTitle: holder.jobTitle,
          };
          if (state.recoveryFlight) {
            spoolRecoveryAudio(
              state,
              new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
              capturedAt,
              capturedFloorSpeaker,
              frameOrder,
            );
            metrics.increment("floor_audio_frames_total");
            return;
          }
          if (holder.pendingFrames * AUDIO_CONFIG.chunkMilliseconds >= AUDIO_CONFIG.staleFrameMilliseconds) {
            metrics.increment("dropped_audio_frames_total");
            return;
          }
          holder.pendingFrames += 1;
          holder.audioTail = holder.audioTail
            .then(async () => {
              if (state.recoveryFlight) {
                spoolRecoveryAudio(
                  state,
                  new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
                  capturedAt,
                  capturedFloorSpeaker,
                  frameOrder,
                );
                return;
              }
              return state.pipeline.acceptAudio(
                new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
                capturedAt,
                capturedFloorSpeaker,
              );
            })
            .catch(() => releaseFloor(claims.sessionId, { reason: "error" }))
            .finally(() => { holder.pendingFrames -= 1; });
          metrics.increment("floor_audio_frames_total");
          return;
        }
        const message = parseJson(data);
        if (message.type === "speak-start") {
          await withFloorSessionLock(claims.sessionId, async () => {
            const speakStartReceivedAt = now();
            if (!floorController) throw new Error("FLOOR_UNAVAILABLE");
            if (!viewerMetadata.get(webSocket)) throw new Error("INVALID_SUBSCRIPTION");
            const state = hostSessions.get(claims.sessionId);
            if (!state) {
              sendJson(webSocket, { type: "error", code: "SESSION_NOT_STARTED", message: gatewayMessage("SESSION_NOT_STARTED") });
              return;
            }
            const activeHolder = floorHolders.get(claims.sessionId);
          if (activeHolder?.webSocket === webSocket && activeHolder.grantId === claims.grantId) {
            // A Speak button may be tapped again while the client reconciles
            // UI state. The existing grant is sticky until another holder or
            // the host preempts it; never call take/release on self-repeats.
            sendJson(webSocket, {
              type: "speak-started",
              sessionId: claims.sessionId,
              displayName: activeHolder.displayName,
              audio: {
                sampleRate: AUDIO_CONFIG.inputSampleRate,
                channels: 1,
                chunkMilliseconds: AUDIO_CONFIG.chunkMilliseconds,
              },
            });
            metrics.increment("floor_idempotent_starts_total");
            return;
          }
          const floorAttemptKey = `${claims.sessionId}\u0000${claims.grantId}`;
          const timestamp = now();
          const previousAttemptAt = floorTakeAttempts.get(floorAttemptKey);
          // Self-repeats already returned above, so a holder still present here
          // means this take would cut that speaker off. An unowned floor cuts
          // nobody off -- charging preemption's cooldown for it stalls the
          // common churn case (speaker -> host -> same speaker answers back).
          const applicableCooldown = activeHolder
            ? floorTakeCooldownMilliseconds
            : resumeCooldownMilliseconds;
          if (previousAttemptAt !== undefined && timestamp - previousAttemptAt < applicableCooldown) {
            sendJson(webSocket, {
              type: "error",
              code: "FLOOR_RATE_LIMITED",
              message: gatewayMessage("FLOOR_RATE_LIMITED"),
            });
            metrics.increment("floor_rate_limit_rejections_total");
            return;
          }
          floorTakeAttempts.set(floorAttemptKey, timestamp);
          if (floorTakeAttempts.size > 10_000) {
            for (const [key, attemptedAt] of floorTakeAttempts) {
              if (timestamp - attemptedAt >= floorTakeCooldownMilliseconds) floorTakeAttempts.delete(key);
            }
          }
          const result = await floorController.take(claims.sessionId, claims.grantId);
          if (result?.ok !== true) {
            const code = typeof result?.code === "string" ? result.code : "FLOOR_DENIED";
            sendJson(webSocket, { type: "error", code, message: gatewayMessage(code) });
            return;
          }
          const participantId = typeof result.participantId === "string" && result.participantId
            ? result.participantId
            : claims.grantId;
          const profile = await lookupParticipantProfile(claims.sessionId, participantId);
          const previous = floorHolders.get(claims.sessionId);
          const holder = {
            webSocket,
            grantId: claims.grantId,
            participantId,
            displayName: typeof result.displayName === "string" && result.displayName.trim() ? result.displayName.trim() : "참가자",
            department: profile?.department ?? "",
            jobTitle: profile?.jobTitle ?? "",
            pendingFrames: 0,
            audioTail: Promise.resolve(),
            // Idle-release watchdog input. A client that holds the floor streams
            // continuously (the worklet pumps every 40ms whether or not anyone is
            // speaking), so a long gap means the client is gone, not quiet.
            lastFrameAt: now(),
          };
          floorHolders.set(claims.sessionId, holder);
          if (previous && previous.webSocket !== webSocket) {
            sendJson(previous.webSocket, { type: "speak-ended", sessionId: claims.sessionId, reason: "preempted" });
          }
          try {
            state.pipeline.setFloorSpeaker?.({
              participantId: holder.participantId,
              displayName: holder.displayName,
              department: holder.department,
              jobTitle: holder.jobTitle,
            });
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
            metrics.observe("floor_broadcast_latency_ms", Math.max(0, now() - speakStartReceivedAt));
          });
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
          cancelReplay();
          viewerMetadata.delete(webSocket);
          for (const abortController of authorizationControllers) abortController.abort();
          return;
        }
        // The registry is the validator, not a shape regex: a regex either
        // rejects the 4-letter script subtags the host UI offers (zh-Hans,
        // zh-Hant) or admits regioned codes like ko-KR, which would key a
        // topic the pipeline — publishing on normalized lanes — never feeds.
        const language = normalizeLiveLanguage(message.language);
        if (message.type !== "subscribe"
          || message.sessionId !== claims.sessionId
          || typeof message.language !== "string"
          || !language
          || (message.lastSeq !== undefined && (!Number.isSafeInteger(message.lastSeq) || message.lastSeq < 0))) {
          throw new Error("INVALID_SUBSCRIPTION");
        }
        if (!await runViewerAuthorization(message.sessionId, language)) throw new Error("GRANT_REVOKED");
        cancelReplay();
        const currentReplayGeneration = replayGeneration;
        removeViewer(topic, webSocket, viewerTopics);
        topic = `${message.sessionId}:${language}`;
        const viewers = viewerTopics.get(topic) ?? new Set();
        viewers.add(webSocket);
        viewerTopics.set(topic, viewers);
        const shouldReplay = message.lastSeq !== undefined && typeof replayUtterances === "function";
        const metadata = {
          claims,
          sessionId: message.sessionId,
          language,
          lastAuthorizedAt: now(),
          ensureAuthorized: ensureViewerAuthorization,
          // While non-null, concurrent live events queue here until the replay
          // below finishes; the flush dedupes on caption seq (contract C2).
          replayBuffer: shouldReplay ? [] : null,
        };
        viewerMetadata.set(webSocket, metadata);
        metrics.set("viewer_connections", [...viewerTopics.values()].reduce((sum, topicViewers) => sum + topicViewers.size, 0));
        sendJson(webSocket, { type: "subscribed", sessionId: message.sessionId, language });
        if (reauthorizeTimer) clearReauthorizeIntervalFn(reauthorizeTimer);
        reauthorizeGeneration += 1;
        const currentReauthorizeGeneration = reauthorizeGeneration;
        reauthorizeTimer = setReauthorizeIntervalFn(() => {
          if (currentReauthorizeGeneration === reauthorizeGeneration) void ensureViewerAuthorization({ force: true });
        }, AUTHORIZATION_CADENCE_MILLISECONDS);
        if (shouldReplay) {
          let replayedThroughSeq = message.lastSeq;
          const abortController = new AbortController();
          replayAbortController = abortController;
          const replayTimer = setTimeoutFn(
            () => abortController.abort(new Error("REPLAY_TIMEOUT")),
            replayTimeoutMilliseconds,
          );
          try {
            for (let page = 0; ; page += 1) {
              if (page > 0 && !await ensureViewerAuthorization({ force: true })) throw new Error("GRANT_REVOKED");
              const pageStartSeq = replayedThroughSeq;
              const replayRequest = Promise.resolve().then(() => replayUtterances(
                message.sessionId,
                language,
                replayedThroughSeq,
                200,
                { signal: abortController.signal },
              ));
              const rows = await waitForAbort(replayRequest, abortController.signal);
              if (currentReplayGeneration !== replayGeneration || viewerMetadata.get(webSocket) !== metadata) return;
              for (const row of Array.isArray(rows) ? rows : []) {
                if (webSocket.readyState !== WebSocket.OPEN) break;
                const payload = { ...row, replay: true };
                sendJson(webSocket, { type: "live-event", payload });
                if (Number.isFinite(payload.seq)) replayedThroughSeq = Math.max(replayedThroughSeq, payload.seq);
              }
              if (!Array.isArray(rows) || rows.length < 200) break;
              if (replayedThroughSeq <= pageStartSeq) throw new Error("REPLAY_NOT_ADVANCING");
            }
          } catch (error) {
            if (currentReplayGeneration === replayGeneration) {
              if (error instanceof Error && error.message === "REPLAY_TIMEOUT") {
                metrics.increment("caption_replay_timeouts_total");
              } else {
                metrics.increment("caption_replay_failures_total");
              }
              closeWithError(webSocket, "REPLAY_FAILED", "누락된 자막 기록을 안전하게 복원하지 못했습니다.", 4411);
            }
            return;
          } finally {
            clearTimeoutFn(replayTimer);
            if (replayAbortController === abortController) replayAbortController = null;
          }
          if (currentReplayGeneration !== replayGeneration || viewerMetadata.get(webSocket) !== metadata) return;
          const buffered = metadata.replayBuffer ?? [];
          metadata.replayBuffer = null;
          for (const payload of buffered) {
            if (payload.type === "caption" && Number.isFinite(payload.seq) && payload.seq <= replayedThroughSeq) continue;
            sendJson(webSocket, { type: "live-event", payload });
          }
        }
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
        const state = hostSessions.get(claims.sessionId);
        const ownsSession = state?.webSocket === webSocket;
        const teardownHostSession = async () => {
          await withHostSessionLock(claims.sessionId, async () => {
            const current = hostSessions.get(claims.sessionId);
            if (current !== state || current.webSocket !== webSocket) return;
            stopHostLease(current);
            current.recoveryAbortController?.abort(new Error("SESSION_ENDED"));
            if (current.graceTimer) {
              clearTimeoutFn(current.graceTimer);
              current.graceTimer = null;
            }
            // Release before deleting ownership: the floor-null broadcast
            // needs the session's language list to reach the viewers.
            await releaseFloor(claims.sessionId, { reason: "session-ended" }).catch(() => undefined);
            hostSessions.delete(claims.sessionId);
            await closePipelineOnce(current.pipeline).catch(() => undefined);
            metrics.set("host_sessions", hostSessions.size);
          }, { bypassQueueLimit: true });
        };
        if (ownsSession && !isShuttingDown && !webSocket.immediateTeardown && hostReconnectGraceMilliseconds > 0) {
          // Contract C3: an unexpected host disconnect keeps the pipeline
          // detached for a grace window — floor, seq, and viewers survive a
          // reconnect. Revocations and pipeline failures still tear down now.
          state.detached = true;
          state.graceTimer = setTimeoutFn(() => {
            state.graceTimer = null;
            if (!state.detached) return;
            void teardownHostSession().catch(() => undefined);
          }, hostReconnectGraceMilliseconds);
          state.graceTimer?.unref?.();
          metrics.increment("host_grace_detachments_total");
        } else if (ownsSession) {
          // Abort before teardown queues behind the session lock. Otherwise a
          // never-settling reconciliation owns that lock and session removal
          // can never reach its in-lock cleanup.
          state.recoveryAbortController?.abort(new Error("SESSION_ENDED"));
          await teardownHostSession();
        }
      }
      metrics.set("host_sessions", hostSessions.size);
      metrics.set("viewer_connections", [...viewerTopics.values()].reduce((sum, viewers) => sum + viewers.size, 0));
    });
  });

  return {
    server,
    metrics,
    /** Current subscriber count for a (sessionId, language) topic — used to
     *  skip TTS synthesis for languages nobody is listening to. */
    subscriberCount(sessionId, language) {
      return viewerTopics.get(`${sessionId}:${language}`)?.size ?? 0;
    },
    async broadcastEvent(sessionId, language, event) {
      await deliverEvent(sessionId, language, event);
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
      for (const state of hostSessions.values()) {
        state.recoveryAbortController?.abort(new Error("GATEWAY_SHUTTING_DOWN"));
      }
      clearInterval(tickTimer);
      clearInterval(heartbeatTimer);
      await Promise.all([...hostOperationTails.values()]);
      await Promise.all([...floorOperationTails.values()]);
      // 2026-07-19 fix: detach ownership before terminating sockets. Their close
      // handlers must not observe and close a pipeline already owned by shutdown.
      const ownedHostStates = [...hostSessions.values()];
      hostSessions.clear();
      metrics.set("host_sessions", 0);
      for (const state of ownedHostStates) {
        stopHostLease(state);
        if (state.graceTimer) {
          clearTimeoutFn(state.graceTimer);
          state.graceTimer = null;
        }
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
    // A revoked/failed session must not linger in the reconnect grace window.
    webSocket.immediateTeardown = true;
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

function waitForDelay(milliseconds, signal, setTimeoutFn, clearTimeoutFn) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer = null;
    const settle = (didFinish) => {
      if (timer !== null) clearTimeoutFn(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(didFinish);
    };
    const onAbort = () => settle(false);
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeoutFn(() => settle(true), milliseconds);
    timer?.unref?.();
  });
}

function isSameHostSettings(previousSettings, message) {
  return previousSettings.sessionType === message.sessionType
    && previousSettings.outputMode === message.outputMode
    && previousSettings.voiceProvider === message.voiceProvider
    && previousSettings.maxViewers === message.maxViewers
    && previousSettings.glossaryPack === message.glossaryPack
    // Without these three, editing the desktop glossary / tone / domain and
    // restarting reused the running pipeline with the OLD values, so the edit
    // silently did nothing until a brand-new session.
    && (previousSettings.glossaryText ?? "") === (message.glossaryText ?? "")
    && (previousSettings.translationTone ?? "") === (message.translationTone ?? "")
    && (previousSettings.domainText ?? "") === (message.domainText ?? "")
    && previousSettings.languages.length === message.languages.length
    && previousSettings.languages.every((language, index) => language === message.languages[index]);
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
  if (code === "FLOOR_RATE_LIMITED") return "발언 요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.";
  if (code === "GRANT_INVALID") return "발언 권한이 확인되지 않았습니다. 다시 입장해 주세요.";
  if (code === "FLOOR_UNAVAILABLE") return "이 게이트웨이에서는 발언 기능을 사용할 수 없습니다.";
  if (code === "SESSION_NOT_STARTED") return "라이브 세션이 아직 시작되지 않았습니다.";
  if (code === "QUEUE_LATENCY_EXCEEDED") return "지연된 음성 작업을 건너뛰고 자동으로 재시작했습니다.";
  return "미디어 게이트웨이 요청을 처리할 수 없습니다.";
}
