import { createServer } from "node:http";
import { createHash, createHmac, randomUUID } from "node:crypto";

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
import { ViewerTicketReplayGuard } from "./viewer-ticket-replay-guard.js";
import { ViewerAuthorizationBatcher } from "./viewer-authorization-batcher.js";
import { MediaDemandCoordinator } from "./media-demand-coordinator.js";

const AUTH_TIMEOUT_MILLISECONDS = 5_000;
const AUTHORIZATION_CADENCE_MILLISECONDS = 2_500;
const AUTHORIZATION_CACHE_MILLISECONDS = 5_000;
/** 발언권(participant speaking)은 세션 단위 설정이다. 주기 재검사에서 뷰어마다
 *  개별 RPC를 쏘면 발언 가능 뷰어 200명 × ~4.25s = 2시간에 ~34만 회가 되므로,
 *  주기 경로만 세션 스코프 리스로 합친다(회수 반영 지연 ≤ 이 값). grant 자체의
 *  유효성은 같은 사이클의 배치 grant 재인증이 담보하고, speak-start와
 *  subscribe는 리스를 거치지 않는 즉시 검사로 남는다. */
const SPEAKING_REAUTHORIZATION_LEASE_MILLISECONDS = 10_000;
const INPUT_FRAME_BYTES = AUDIO_CONFIG.inputSampleRate * 2 * AUDIO_CONFIG.chunkMilliseconds / 1_000;
const TAGGED_AUDIO_HEADER_BYTES = 4;
const TAGGED_AUDIO_FRAME_BYTES = TAGGED_AUDIO_HEADER_BYTES + INPUT_FRAME_BYTES;
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
const DEFAULT_MAX_BUFFERED_HOST_CAPTIONS = 512;
const DEFAULT_VIEWER_AUTHORIZATION_LEASE_MILLISECONDS = 4_000;
const DEFAULT_VIEWER_AUTHORIZATION_JITTER_MILLISECONDS = 500;
const DEFAULT_VIEWER_AUTHORIZATION_CONCURRENCY = 4;
const DEFAULT_VIEWER_AUTHORIZATION_LEASE_ENTRIES = 10_000;
const DEFAULT_VIEWER_AUTHORIZATION_BATCH_WINDOW_MILLISECONDS = 100;
const DEFAULT_VIEWER_AUTHORIZATION_BATCH_SIZE = 50;
const DEFAULT_PARTICIPANT_PROFILE_CACHE_ENTRIES = 10_000;
const DEFAULT_PARTICIPANT_PROFILE_TTL_MILLISECONDS = 5 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class ViewerAuthorizationLeaseManager {
  #leases = new Map();
  #queue = [];
  #active = 0;

  constructor({
    authorize,
    batchAuthorize = null,
    now = Date.now,
    leaseMilliseconds = DEFAULT_VIEWER_AUTHORIZATION_LEASE_MILLISECONDS,
    maxConcurrent = DEFAULT_VIEWER_AUTHORIZATION_CONCURRENCY,
    maxEntries = DEFAULT_VIEWER_AUTHORIZATION_LEASE_ENTRIES,
  }) {
    if (typeof authorize !== "function") throw new Error("INVALID_VIEWER_AUTHORIZER");
    if (batchAuthorize !== null && typeof batchAuthorize !== "function") throw new Error("INVALID_VIEWER_BATCH_AUTHORIZER");
    if (!Number.isFinite(leaseMilliseconds) || leaseMilliseconds <= 0) throw new Error("INVALID_VIEWER_AUTHORIZATION_LEASE");
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("INVALID_VIEWER_AUTHORIZATION_CONCURRENCY");
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("INVALID_VIEWER_AUTHORIZATION_LEASE_CAPACITY");
    this.authorizeRequest = authorize;
    this.batchAuthorize = batchAuthorize;
    this.now = now;
    this.leaseMilliseconds = leaseMilliseconds;
    this.maxConcurrent = maxConcurrent;
    this.maxEntries = maxEntries;
  }

  get size() {
    return this.#leases.size;
  }

  async authorize(claims, sessionId, language, { signal, force = false } = {}) {
    if (claims?.role !== "VIEWER"
      || claims.sessionId !== sessionId
      || typeof claims.grantId !== "string"
      || !claims.grantId
      || typeof claims.userId !== "string"
      || !claims.userId
      || typeof language !== "string"
      || !language) return false;
    const key = authorizationLeaseKey(claims, sessionId, language);
    const existing = this.#leases.get(key);
    if (!force && existing?.authorizedUntil > this.now()) {
      this.#leases.delete(key);
      this.#leases.set(key, existing);
      return true;
    }
    if (existing?.flight) return existing.flight;
    if (!existing) this.#makeCapacity();
    const lease = existing ?? { authorizedUntil: 0, flight: null };
    const authorization = this.batchAuthorize
      ? this.batchAuthorize({ sessionId, grantId: claims.grantId, userId: claims.userId, language }, { signal })
      : this.#runLimited(() => this.authorizeRequest(claims, sessionId, language, { signal }), signal);
    const flight = authorization.then((isAuthorized) => {
      if (isAuthorized !== true) {
        if (this.#leases.get(key) === lease) this.#leases.delete(key);
        return false;
      }
      lease.authorizedUntil = this.now() + this.leaseMilliseconds;
      return true;
    }).finally(() => {
      if (lease.flight === flight) lease.flight = null;
    });
    lease.flight = flight;
    this.#leases.set(key, lease);
    return flight;
  }

  deleteGrant(claims, sessionId, language) {
    if (!claims || typeof claims.grantId !== "string" || typeof claims.userId !== "string") return;
    this.#leases.delete(authorizationLeaseKey(claims, sessionId, language));
  }

  deleteSession(sessionId) {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.#leases.keys()) {
      if (key.startsWith(prefix)) this.#leases.delete(key);
    }
  }

  clear() {
    this.#leases.clear();
  }

  #makeCapacity() {
    if (this.#leases.size < this.maxEntries) return;
    const timestamp = this.now();
    for (const [key, lease] of this.#leases) {
      if (!lease.flight && lease.authorizedUntil <= timestamp) this.#leases.delete(key);
    }
    while (this.#leases.size >= this.maxEntries) {
      const candidate = [...this.#leases].find(([, lease]) => !lease.flight);
      if (!candidate) throw new Error("VIEWER_AUTHORIZATION_CAPACITY");
      this.#leases.delete(candidate[0]);
    }
  }

  #runLimited(task, signal) {
    if (signal?.aborted) return Promise.reject(abortReason(signal, "GRANT_CHECK_CANCELLED"));
    return new Promise((resolve, reject) => {
      const entry = { task, signal, resolve, reject, onAbort: null };
      if (signal) {
        entry.onAbort = () => {
          const index = this.#queue.indexOf(entry);
          if (index < 0) return;
          this.#queue.splice(index, 1);
          reject(abortReason(signal, "GRANT_CHECK_CANCELLED"));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.#queue.push(entry);
      this.#drain();
    });
  }

  #drain() {
    while (this.#active < this.maxConcurrent && this.#queue.length > 0) {
      const entry = this.#queue.shift();
      if (entry.signal?.aborted) {
        entry.reject(abortReason(entry.signal, "GRANT_CHECK_CANCELLED"));
        continue;
      }
      if (entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
      this.#active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.#active -= 1;
          this.#drain();
        });
    }
  }
}

export class ParticipantProfileCache {
  #entries = new Map();

  constructor({
    maxEntries = DEFAULT_PARTICIPANT_PROFILE_CACHE_ENTRIES,
    ttlMilliseconds = DEFAULT_PARTICIPANT_PROFILE_TTL_MILLISECONDS,
    now = Date.now,
  } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("INVALID_PARTICIPANT_PROFILE_CACHE_SIZE");
    if (!Number.isFinite(ttlMilliseconds) || ttlMilliseconds <= 0) throw new Error("INVALID_PARTICIPANT_PROFILE_CACHE_TTL");
    this.maxEntries = maxEntries;
    this.ttlMilliseconds = ttlMilliseconds;
    this.now = now;
  }

  get size() {
    return this.#entries.size;
  }

  get(sessionId, participantId) {
    const key = participantProfileKey(sessionId, participantId);
    const entry = this.#entries.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.#entries.delete(key);
      return { hit: false, value: null };
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return { hit: true, value: entry.value };
  }

  set(sessionId, participantId, value) {
    const key = participantProfileKey(sessionId, participantId);
    this.#entries.delete(key);
    while (this.#entries.size >= this.maxEntries) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.#entries.delete(oldestKey);
    }
    this.#entries.set(key, { value, expiresAt: this.now() + this.ttlMilliseconds });
  }

  deleteSession(sessionId) {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.#entries.keys()) {
      if (key.startsWith(prefix)) this.#entries.delete(key);
    }
  }

  clear() {
    this.#entries.clear();
  }
}

function authorizationLeaseKey(claims, sessionId, language) {
  return `${sessionId}\u0000${claims.grantId}\u0000${claims.userId}\u0000${language}`;
}

function participantProfileKey(sessionId, participantId) {
  return `${sessionId}\u0000${participantId}`;
}

function viewerAuthorizationJitter(claims, maximumMilliseconds) {
  if (maximumMilliseconds <= 0) return 0;
  const value = `${claims.sessionId}\u0000${claims.grantId}\u0000${claims.userId}`;
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash % maximumMilliseconds;
}

export function decodeHostAudioFrame(data) {
  const frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (frame.byteLength === INPUT_FRAME_BYTES) return { pcm: frame, source: null };
  if (frame.byteLength !== TAGGED_AUDIO_FRAME_BYTES
    || frame[0] !== 0x4e
    || frame[1] !== 0x01
    || (frame[2] !== 0x01 && frame[2] !== 0x02)
    || frame[3] !== 0x00) {
    throw new Error("INVALID_AUDIO_FRAME");
  }
  return {
    pcm: frame.subarray(TAGGED_AUDIO_HEADER_BYTES),
    source: frame[2] === 0x01 ? "system" : "mic",
  };
}

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
  setViewerAuthorizationBatchTimeoutFn = setTimeout,
  clearViewerAuthorizationBatchTimeoutFn = clearTimeout,
  setReauthorizeIntervalFn = setInterval,
  clearReauthorizeIntervalFn = clearInterval,
  setHostLeaseIntervalFn = setInterval,
  clearHostLeaseIntervalFn = clearInterval,
  serializeJson = JSON.stringify,
  viewerAuthorizeTimeoutMilliseconds = 5_000,
  viewerAuthorizationLeaseMilliseconds = DEFAULT_VIEWER_AUTHORIZATION_LEASE_MILLISECONDS,
  viewerAuthorizationJitterMilliseconds = DEFAULT_VIEWER_AUTHORIZATION_JITTER_MILLISECONDS,
  viewerAuthorizationMaxConcurrent = DEFAULT_VIEWER_AUTHORIZATION_CONCURRENCY,
  viewerAuthorizationBatchWindowMilliseconds = DEFAULT_VIEWER_AUTHORIZATION_BATCH_WINDOW_MILLISECONDS,
  viewerAuthorizationBatchSize = DEFAULT_VIEWER_AUTHORIZATION_BATCH_SIZE,
  hostStartTimeoutMilliseconds = 10_000,
  maxQueuedHostOperations = 8,
  slowConsumerPredicate = (viewer) => viewer.bufferedAmount >= 750_000,
  securityPolicy = readGatewaySecurityPolicy(),
  connectionLimiter = new GatewayConnectionLimiter({ now }),
  viewerTicketReplayGuard = new ViewerTicketReplayGuard({ now }),
  audioBurstMilliseconds = 2_000,
  maxSessionAudioMilliseconds = 2 * 60 * 60 * 1_000,
  maxSessionAudioBytes = INPUT_BYTES_PER_SECOND * 2 * 60 * 60,
  maxSessionAudioEntries = 1_000,
  floorTakeCooldownMilliseconds = DEFAULT_FLOOR_TAKE_COOLDOWN_MILLISECONDS,
  floorResumeCooldownMilliseconds = null,
  floorIdleReleaseMilliseconds = DEFAULT_FLOOR_IDLE_RELEASE_MILLISECONDS,
  hostReconnectGraceMilliseconds = 90_000,
  fetchFloorParticipant = null,
  participantProfileCacheMaxEntries = DEFAULT_PARTICIPANT_PROFILE_CACHE_ENTRIES,
  participantProfileCacheTtlMilliseconds = DEFAULT_PARTICIPANT_PROFILE_TTL_MILLISECONDS,
  releaseGeminiSession = async () => {},
  replayUtterances = null,
  replayTimeoutMilliseconds = 5_000,
  maxBufferedHostCaptions = DEFAULT_MAX_BUFFERED_HOST_CAPTIONS,
  mediaDemandStore = null,
  mediaDemandPollMilliseconds = 5_000,
}) {
  if (!Number.isFinite(heartbeatIntervalMilliseconds) || heartbeatIntervalMilliseconds <= 0) throw new Error("INVALID_HEARTBEAT_INTERVAL");
  if (typeof viewerTicketReplayGuard?.consume !== "function") throw new Error("INVALID_VIEWER_TICKET_REPLAY_GUARD");
  if (typeof viewerAuthorizer?.authorizeBatch !== "function") throw new Error("INVALID_VIEWER_BATCH_AUTHORIZER");
  if (!Number.isFinite(viewerAuthorizeTimeoutMilliseconds) || viewerAuthorizeTimeoutMilliseconds <= 0) throw new Error("INVALID_VIEWER_AUTHORIZE_TIMEOUT");
  if (typeof serializeJson !== "function") throw new Error("INVALID_JSON_SERIALIZER");
  if (!Number.isFinite(viewerAuthorizationLeaseMilliseconds)
    || viewerAuthorizationLeaseMilliseconds <= 0
    || viewerAuthorizationLeaseMilliseconds > AUTHORIZATION_CACHE_MILLISECONDS) throw new Error("INVALID_VIEWER_AUTHORIZATION_LEASE");
  if (!Number.isSafeInteger(viewerAuthorizationJitterMilliseconds) || viewerAuthorizationJitterMilliseconds < 0) throw new Error("INVALID_VIEWER_AUTHORIZATION_JITTER");
  if (viewerAuthorizationLeaseMilliseconds
    + viewerAuthorizationJitterMilliseconds
    + viewerAuthorizationBatchWindowMilliseconds > AUTHORIZATION_CACHE_MILLISECONDS) {
    throw new Error("INVALID_VIEWER_AUTHORIZATION_REVALIDATION_SLA");
  }
  if (!Number.isSafeInteger(viewerAuthorizationMaxConcurrent) || viewerAuthorizationMaxConcurrent < 1) throw new Error("INVALID_VIEWER_AUTHORIZATION_CONCURRENCY");
  if (!Number.isFinite(viewerAuthorizationBatchWindowMilliseconds)
    || viewerAuthorizationBatchWindowMilliseconds < 0
    || viewerAuthorizationBatchWindowMilliseconds > 1_000) throw new Error("INVALID_VIEWER_AUTHORIZATION_BATCH_WINDOW");
  if (!Number.isSafeInteger(viewerAuthorizationBatchSize)
    || viewerAuthorizationBatchSize < 1
    || viewerAuthorizationBatchSize > DEFAULT_VIEWER_AUTHORIZATION_BATCH_SIZE) throw new Error("INVALID_VIEWER_AUTHORIZATION_BATCH_SIZE");
  if (!Number.isFinite(hostStartTimeoutMilliseconds) || hostStartTimeoutMilliseconds <= 0) throw new Error("INVALID_HOST_START_TIMEOUT");
  if (!Number.isFinite(replayTimeoutMilliseconds) || replayTimeoutMilliseconds <= 0) throw new Error("INVALID_REPLAY_TIMEOUT");
  if (!Number.isSafeInteger(maxQueuedHostOperations) || maxQueuedHostOperations < 0) throw new Error("INVALID_HOST_QUEUE_LIMIT");
  if (!Number.isSafeInteger(participantProfileCacheMaxEntries) || participantProfileCacheMaxEntries < 1) throw new Error("INVALID_PARTICIPANT_PROFILE_CACHE_SIZE");
  if (!Number.isFinite(participantProfileCacheTtlMilliseconds) || participantProfileCacheTtlMilliseconds <= 0) throw new Error("INVALID_PARTICIPANT_PROFILE_CACHE_TTL");
  if (typeof releaseGeminiSession !== "function") throw new Error("INVALID_GEMINI_SESSION_RELEASER");
  if (!Number.isFinite(audioBurstMilliseconds) || audioBurstMilliseconds < AUDIO_CONFIG.chunkMilliseconds) throw new Error("INVALID_AUDIO_BURST");
  if (!Number.isFinite(maxSessionAudioMilliseconds) || maxSessionAudioMilliseconds <= 0) throw new Error("INVALID_SESSION_AUDIO_DURATION");
  if (!Number.isSafeInteger(maxSessionAudioBytes) || maxSessionAudioBytes < INPUT_FRAME_BYTES) throw new Error("INVALID_SESSION_AUDIO_BYTES");
  if (!Number.isSafeInteger(maxSessionAudioEntries) || maxSessionAudioEntries < 1) throw new Error("INVALID_SESSION_AUDIO_ENTRIES");
  if (!Number.isSafeInteger(maxBufferedHostCaptions) || maxBufferedHostCaptions < 1) {
    throw new Error("INVALID_HOST_CAPTION_BUFFER_LIMIT");
  }
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
  const failedHostSessions = new Map();
  const demand = mediaDemandStore ? new MediaDemandCoordinator({
    store: mediaDemandStore,
    now,
    pollMilliseconds: mediaDemandPollMilliseconds,
    onIdle: async (sessionId, epoch, reason) => {
      const current = hostSessions.get(sessionId);
      if (current && current.demandEpoch !== epoch) return;
      if (current) current.isDetaching = true;
      let drained = true;
      let drainTimer;
      try {
        if (current) {
          await Promise.race([(async () => {
            await drainHostAudioLanes(current);
            await current.pipeline.gracefulDrain?.({ timeoutMilliseconds: 10_000 });
          })(), new Promise((_, reject) => {
            drainTimer = setTimeoutFn(() => reject(new Error("MEDIA_DRAIN_TIMEOUT")), 10_000);
          })]);
          await detachOwnedHostSession(sessionId, current.webSocket);
        }
      } catch {
        drained = false;
        metrics.increment("media_idle_drain_failures_total");
        if (current) {
          current.pipeline.abortMedia?.();
          void detachOwnedHostSession(sessionId, current.webSocket).catch(() => undefined);
        }
      } finally {
        clearTimeoutFn(drainTimer);
        for (const socket of authenticatedSessionSockets.get(sessionId) ?? []) {
          if (socket.demandEpoch !== epoch) continue;
          sendJson(socket, { type: "media-idle", sessionId, epoch, reason: drained ? reason : "MEDIA_DRAIN_FAILED" });
          socket.immediateTeardown = true;
          if (socket.readyState === WebSocket.OPEN) socket.close(1000, "media idle");
        }
      }
      return { drained };
    },
  }) : null;
  const hostOperationTails = new Map();
  const hostOperationCounts = new Map();
  const floorOperationTails = new Map();
  const successfullyClosedPipelines = new WeakSet();
  const pipelineCloseFlights = new WeakMap();
  const pipelinesPendingClose = new Set();
  const pipelineSessionIds = new WeakMap();
  const sessionCleanupFailures = new Map();
  const viewerTopics = new Map();
  const viewerMetadata = new WeakMap();
  const authenticatedSessionSockets = new Map();
  const floorHolders = new Map();
  const floorRevisions = new Map();
  const floorTakeAttempts = new Map();
  const participantProfiles = new ParticipantProfileCache({
    maxEntries: participantProfileCacheMaxEntries,
    ttlMilliseconds: participantProfileCacheTtlMilliseconds,
    now,
  });
  const connectionCleanup = new Map();
  const sessionAudioUsage = new Map();
  /** sessionId -> { value, expiresAt, inFlight } — 주기 발언권 재검사 리스. */
  const speakingAuthorizationLeases = new Map();
  const leasedParticipantSpeakingAuthorization = (sessionId, check) => {
    const cached = speakingAuthorizationLeases.get(sessionId);
    if (cached?.inFlight) return cached.inFlight;
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value);
    const inFlight = Promise.resolve()
      .then(check)
      .then((value) => {
        speakingAuthorizationLeases.set(sessionId, {
          value,
          expiresAt: now() + SPEAKING_REAUTHORIZATION_LEASE_MILLISECONDS,
          inFlight: null,
        });
        return value;
      })
      .catch((error) => {
        speakingAuthorizationLeases.delete(sessionId);
        throw error;
      });
    speakingAuthorizationLeases.set(sessionId, { value: false, expiresAt: 0, inFlight });
    return inFlight;
  };
  const shutdownAbortController = new AbortController();
  let isShuttingDown = false;
  const audioBurstBytes = INPUT_BYTES_PER_SECOND * audioBurstMilliseconds / 1_000;
  const releaseGeminiSessionOnce = async (state) => {
    if (state.geminiSessionReleased) return;
    state.geminiSessionReleased = true;
    try {
      await releaseGeminiSession(state.settings.sessionId);
    } catch {
      metrics.increment("gemini_session_release_failures_total");
    }
  };
  const getFloorRevision = (sessionId) => floorRevisions.get(sessionId) ?? 0;
  const createHostOutput = (webSocket) => ({
    webSocket,
    clientKind: webSocket.gatewayClientKind,
    bufferedFinals: [],
    bufferedPartials: new Map(),
    finalSeqByLanguage: new Map(),
    nextBufferedOrder: 0,
  });
  const hostCaptionIdentity = (event) => {
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
    const language = typeof event.language === "string" ? event.language : "";
    const utteranceKey = typeof event.utteranceKey === "string" ? event.utteranceKey.trim() : "";
    if (utteranceKey) return `${sessionId}\u0000${language}\u0000${utteranceKey}`;
    const speaker = event.speaker && typeof event.speaker === "object" ? event.speaker : {};
    const speakerIdentity = speaker.participantId ?? speaker.role ?? speaker.name ?? event.speakerRole ?? event.speakerName ?? "";
    return `${sessionId}\u0000${language}\u0000${event.seq ?? ""}\u0000${speakerIdentity}`;
  };
  const trimHostCaptionBuffer = (hostOutput) => {
    while (hostOutput.bufferedFinals.length + hostOutput.bufferedPartials.size > maxBufferedHostCaptions) {
      let oldestPartialIdentity = null;
      let oldestPartialOrder = Number.POSITIVE_INFINITY;
      for (const [identity, buffered] of hostOutput.bufferedPartials) {
        if (buffered.order < oldestPartialOrder) {
          oldestPartialIdentity = identity;
          oldestPartialOrder = buffered.order;
        }
      }
      if (oldestPartialIdentity !== null) {
        hostOutput.bufferedPartials.delete(oldestPartialIdentity);
        metrics.increment("host_caption_buffer_partials_dropped_total");
        continue;
      }
      // A finite reconnect grace still needs a hard memory ceiling. Finals are
      // evicted only after every replaceable partial has gone, preserving the
      // committed transcript throughout all normal grace-window traffic.
      hostOutput.bufferedFinals.shift();
      metrics.increment("host_caption_buffer_finals_dropped_total");
    }
  };
  const sendHostEvent = (hostOutput, event, { isPublishedEvent = false } = {}) => {
    if (event?.type === "caption" && hostOutput.clientKind === "browser" && !isPublishedEvent) return;
    if (event?.type !== "caption") {
      sendJson(hostOutput.webSocket, event);
      return;
    }
    const language = typeof event.language === "string" ? event.language : "";
    const seq = Number.isFinite(event.seq) ? event.seq : null;
    const finalSeq = hostOutput.finalSeqByLanguage.get(language);
    if (!event.isFinal && seq !== null && Number.isFinite(finalSeq) && seq <= finalSeq) {
      metrics.increment("host_caption_stale_partials_dropped_total");
      return;
    }
    if (event.isFinal && seq !== null) {
      hostOutput.finalSeqByLanguage.set(language, Math.max(finalSeq ?? Number.NEGATIVE_INFINITY, seq));
    }
    if (hostOutput.webSocket?.readyState === WebSocket.OPEN) {
      sendJson(hostOutput.webSocket, event);
      return;
    }
    const identity = hostCaptionIdentity(event);
    const buffered = { event, order: hostOutput.nextBufferedOrder };
    hostOutput.nextBufferedOrder += 1;
    if (event.isFinal) {
      hostOutput.bufferedPartials.delete(identity);
      hostOutput.bufferedFinals.push(buffered);
    } else {
      const previous = hostOutput.bufferedPartials.get(identity);
      hostOutput.bufferedPartials.set(identity, previous ? { event, order: previous.order } : buffered);
    }
    trimHostCaptionBuffer(hostOutput);
  };
  const flushHostCaptionBuffer = (hostOutput) => {
    if (hostOutput.webSocket?.readyState !== WebSocket.OPEN) return;
    const buffered = [...hostOutput.bufferedFinals, ...hostOutput.bufferedPartials.values()];
    buffered.sort((left, right) => {
      const leftSeq = Number.isFinite(left.event.seq) ? left.event.seq : Number.POSITIVE_INFINITY;
      const rightSeq = Number.isFinite(right.event.seq) ? right.event.seq : Number.POSITIVE_INFINITY;
      return leftSeq - rightSeq || left.order - right.order;
    });
    hostOutput.bufferedFinals.length = 0;
    hostOutput.bufferedPartials.clear();
    for (const { event } of buffered) sendJson(hostOutput.webSocket, event);
  };
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
        const sessionId = pipelineSessionIds.get(pipeline);
        const failures = sessionCleanupFailures.get(sessionId);
        if (failures?.delete(pipeline) && failures.size === 0) {
          sessionCleanupFailures.delete(sessionId);
          const failure = failedHostSessions.get(sessionId);
          if (failure) failure.cleanupComplete = true;
        }
      })
      .catch((error) => {
        pipelinesPendingClose.add(pipeline);
        const sessionId = pipelineSessionIds.get(pipeline);
        if (sessionId) {
          const failures = sessionCleanupFailures.get(sessionId) ?? new Set();
          failures.add(pipeline);
          sessionCleanupFailures.set(sessionId, failures);
          failedHostSessions.set(sessionId, { cleanupComplete: false });
        }
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
  const authorizeViewerBatchRequest = (requests, { signal: outerSignal }) => new Promise((resolve, reject) => {
    const abortController = new AbortController();
    const { signal } = abortController;
    let isSettled = false;
    let timeout = null;
    const settle = (callback, value) => {
      if (isSettled) return;
      isSettled = true;
      if (timeout) clearTimeoutFn(timeout);
      signal?.removeEventListener("abort", onAbort);
      outerSignal?.removeEventListener("abort", onOuterAbort);
      callback(value);
    };
    const onAbort = () => settle(
      reject,
      signal.reason instanceof Error ? signal.reason : new Error("GRANT_CHECK_CANCELLED"),
    );
    const onOuterAbort = () => abortController.abort(abortReason(outerSignal, "GRANT_CHECK_CANCELLED"));
    timeout = setTimeoutFn(
      () => abortController.abort(new Error("GRANT_CHECK_TIMEOUT")),
      Math.min(AUTHORIZATION_CADENCE_MILLISECONDS, viewerAuthorizeTimeoutMilliseconds),
    );
    if (outerSignal?.aborted) {
      onOuterAbort();
      onAbort();
      return;
    }
    outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => viewerAuthorizer.authorizeBatch(requests, { signal }))
      .then((value) => settle(resolve, value), (error) => settle(reject, error));
  });
  const viewerAuthorizationBatcher = new ViewerAuthorizationBatcher({
    authorizeBatch: authorizeViewerBatchRequest,
    batchWindowMilliseconds: viewerAuthorizationBatchWindowMilliseconds,
    maxBatchSize: viewerAuthorizationBatchSize,
    setTimeoutFn: setViewerAuthorizationBatchTimeoutFn,
    clearTimeoutFn: clearViewerAuthorizationBatchTimeoutFn,
  });
  const viewerAuthorizationLeases = new ViewerAuthorizationLeaseManager({
    authorize: (claims, sessionId, language, options) => viewerAuthorizer.authorize(claims, sessionId, language, options),
    batchAuthorize: (request, options) => viewerAuthorizationBatcher.authorize(request, options),
    now,
    leaseMilliseconds: viewerAuthorizationLeaseMilliseconds,
    maxConcurrent: viewerAuthorizationMaxConcurrent,
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
      if (state.leaseInFlight || hostSessions.get(state.settings.sessionId) !== state) return;
      const abortController = new AbortController();
      state.leaseAbortController = abortController;
      const lease = authorizeHost(claims, state.settings, abortController, { requireLive: true, compareVersion: false })
        .then((isAuthorized) => {
          if (!isAuthorized && hostSessions.get(state.settings.sessionId) === state) {
            if (state.webSocket.readyState === WebSocket.OPEN) {
              closePipelineSocket(state.webSocket, new Error("SESSION_REVOKED"));
            } else {
              metrics.increment("detached_host_revocations_total");
              void stopOwnedHostSession(state.settings.sessionId, state.webSocket).catch(() => {
                metrics.increment("detached_host_revocation_failures_total");
              });
            }
          }
        })
        .catch(() => {
          if (hostSessions.get(state.settings.sessionId) === state) {
            if (state.webSocket.readyState === WebSocket.OPEN) {
              closePipelineSocket(state.webSocket, new Error("SESSION_REVOKED"));
            } else {
              metrics.increment("detached_host_revocations_total");
              void stopOwnedHostSession(state.settings.sessionId, state.webSocket).catch(() => {
                metrics.increment("detached_host_revocation_failures_total");
              });
            }
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
  const deliverEvent = (sessionId, language, payload) => {
    const serialized = serializeJson({ type: "live-event", payload });
    return deliverToAuthorizedViewers(sessionId, language, (viewer) => {
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
          metadata.replayBuffer.push({ payload, serialized });
          return;
        }
      }
      deliverSerializedEvent(viewer, payload, serialized);
    });
  };
  const deliverSerializedEvent = (viewer, payload, serialized) => {
    if (slowConsumerPredicate(viewer)) {
      if ((payload?.type === "caption" && payload.isFinal !== true) || payload?.type === "source-draft") {
        metrics.increment("json_partials_dropped_total");
        return true;
      }
      metrics.increment("slow_consumers_terminated_total");
      closeWithError(viewer, "SLOW_CONSUMER", "실시간 자막이 네트워크 속도를 따라가지 못해 연결을 종료합니다.", 4408);
      return false;
    }
    if (viewer.readyState !== WebSocket.OPEN) return false;
    viewer.send(serialized);
    return true;
  };
  const lookupParticipantProfile = async (sessionId, participantId) => {
    if (typeof fetchFloorParticipant !== "function") return null;
    const cached = participantProfiles.get(sessionId, participantId);
    if (cached.hit) return cached.value;
    let profile = null;
    try {
      profile = await fetchFloorParticipant(sessionId, participantId) ?? null;
    } catch {
      profile = null; // identity enrichment is best-effort
    }
    participantProfiles.set(sessionId, participantId, profile);
    return profile;
  };
  const createFloorPayload = (sessionId, holder) => ({
    type: "floor",
    sessionId,
    floorRevision: getFloorRevision(sessionId),
    holder: holder
      ? {
        participantId: holder.participantId,
        name: holder.displayName,
        department: holder.department ?? "",
        jobTitle: holder.jobTitle ?? "",
      }
      : null,
  });
  const broadcastFloor = async (sessionId, holder) => {
    floorRevisions.set(sessionId, getFloorRevision(sessionId) + 1);
    const state = hostSessions.get(sessionId);
    const payload = createFloorPayload(sessionId, holder);
    if (state) sendJson(state.webSocket, payload);
    const languages = state?.settings.languages ?? [];
    await Promise.all(languages.map((language) => deliverEvent(sessionId, language, payload)));
  };
  const broadcastSessionStatus = async (sessionId, status) => {
    const state = hostSessions.get(sessionId);
    const payload = { type: "session-status", sessionId, status };
    if (state?.hostOutput.clientKind === "browser") sendHostEvent(state.hostOutput, payload);
    const languages = state?.settings.languages ?? [];
    await Promise.all(languages.map((language) => deliverEvent(sessionId, language, payload)));
  };
  const closeAuthenticatedSessionSockets = (sessionId, ownerSocket) => {
    const sockets = authenticatedSessionSockets.get(sessionId) ?? new Set();
    authenticatedSessionSockets.delete(sessionId);
    for (const candidate of sockets) {
      if (candidate !== ownerSocket && candidate.readyState === WebSocket.OPEN) {
        candidate.close(1000, "session stopped");
      }
    }
  };
  const getHostAudioLane = (state, source) => {
    const key = source ?? "legacy";
    let lane = state.audioLanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve(), pendingFrames: 0 };
      state.audioLanes.set(key, lane);
    }
    return lane;
  };
  const drainHostAudioLanes = (state) => Promise.all(
    [...state.audioLanes.values()].map((lane) => lane.tail.catch(() => undefined)),
  );
  const failOwnedPipeline = (sessionId, failedPipeline) => {
    const state = hostSessions.get(sessionId);
    if (!state || state.pipeline !== failedPipeline) return Promise.resolve();
    if (state.failureFlight) return state.failureFlight;
    // 2026-08-31 fix: 공급자·원문 오류 후 자동 재접속이 유료 세션을 다시 만들지 못하게 한다.
    // 인증된 호스트의 명시 restart만 영구 저장 순서를 재검증한 뒤 이 실패 표시를 해제한다.
    const failure = { cleanupComplete: false };
    failedHostSessions.set(sessionId, failure);
    state.isDetaching = true;
    stopHostLease(state);
    if (state.graceTimer) {
      clearTimeoutFn(state.graceTimer);
      state.graceTimer = null;
    }
    metrics.increment("pipeline_restart_required_total");
    try { failedPipeline.abortMedia?.(); } catch { /* close remains required */ }
    state.failureFlight = withHostSessionLock(sessionId, async () => {
      if (typeof failedPipeline.abortMedia !== "function") {
        try { await failedPipeline.pause?.(); } catch { metrics.increment("pipeline_pause_failures_total"); }
      }
      await releaseFloor(sessionId, { reason: "pipeline-failed" }).catch(() => undefined);
      try {
        await closePipelineOnce(failedPipeline);
        failure.cleanupComplete = true;
        await releaseGeminiSessionOnce(state);
      } catch {
        metrics.increment("pipeline_close_failures_total");
      }
      if (hostSessions.get(sessionId) === state) hostSessions.delete(sessionId);
      metrics.set("host_sessions", hostSessions.size);
    }, { bypassQueueLimit: true }).finally(async () => {
      if (demand && state.demandEpoch !== null) {
        await demand.fail(sessionId, state.demandEpoch).catch(() => {
          metrics.increment("media_failure_fence_failures_total");
        });
      }
    });
    closePipelineSocket(state.webSocket, new Error("PIPELINE_RESTART_REQUIRED"));
    return state.failureFlight;
  };
  const releaseFloor = (
    sessionId,
    { grantId = null, reason = "ended", notifyHolder = true, broadcast = true } = {},
  ) => withFloorSessionLock(sessionId, async () => {
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
    if (broadcast) await broadcastFloor(sessionId, null);
  });
  const stopOwnedHostSession = async (sessionId, webSocket) => withHostSessionLock(sessionId, async () => {
    const current = hostSessions.get(sessionId);
    if (!current) return false;
    if (current.webSocket !== webSocket) throw new Error("SESSION_NOT_STARTED");
    stopHostLease(current);
    if (current.graceTimer) {
      clearTimeoutFn(current.graceTimer);
      current.graceTimer = null;
    }
    await releaseFloor(sessionId, {
      reason: "session-ended",
      notifyHolder: false,
      broadcast: false,
    }).catch(() => undefined);
    // Keep ownership until provider resources are actually released. A new
    // start queues behind this lock, so two provider pipelines cannot overlap.
    await closePipelineOnce(current.pipeline).catch(() => {
      metrics.increment("pipeline_close_failures_total");
      throw new Error("PIPELINE_CLEANUP_FAILED");
    });
    await current.pipeline.completeTopicsOnSessionEnd?.().catch(() => {
      metrics.increment("topic_session_end_failures_total");
    });
    await releaseGeminiSessionOnce(current);
    await broadcastSessionStatus(sessionId, "stopped").catch(() => {
      metrics.increment("session_status_broadcast_failures_total");
    });
    closeAuthenticatedSessionSockets(sessionId, webSocket);
    hostSessions.delete(sessionId);
    failedHostSessions.delete(sessionId);
    floorRevisions.delete(sessionId);
    participantProfiles.deleteSession(sessionId);
    viewerAuthorizationLeases.deleteSession(sessionId);
    viewerAuthorizationBatcher.deleteSession(sessionId);
    speakingAuthorizationLeases.delete(sessionId);
    sessionAudioUsage.delete(sessionId);
    metrics.set("host_sessions", hostSessions.size);
    return true;
  }, { bypassQueueLimit: true });
  const detachOwnedHostSession = async (sessionId, webSocket) => withHostSessionLock(sessionId, async () => {
    const current = hostSessions.get(sessionId);
    if (!current) return false;
    if (current.webSocket !== webSocket) throw new Error("SESSION_NOT_STARTED");
    current.isDetaching = true;
    stopHostLease(current);
    if (current.graceTimer) {
      clearTimeoutFn(current.graceTimer);
      current.graceTimer = null;
    }
    // 2026-08-31 fix: Leaving the host app releases paid streams without ending
    // the durable meeting or its viewers. Keep the host lock through provider
    // drain so a returning host cannot overlap two provider pipelines.
    await releaseFloor(sessionId, { reason: "host-detached", broadcast: false }).catch(() => undefined);
    await broadcastFloor(sessionId, null).catch(() => undefined);
    hostSessions.delete(sessionId);
    participantProfiles.deleteSession(sessionId);
    viewerAuthorizationLeases.deleteSession(sessionId);
    viewerAuthorizationBatcher.deleteSession(sessionId);
    speakingAuthorizationLeases.delete(sessionId);
    await closePipelineOnce(current.pipeline).catch(() => {
      metrics.increment("pipeline_close_failures_total");
      throw new Error("PIPELINE_CLEANUP_FAILED");
    });
    await releaseGeminiSessionOnce(current);
    metrics.set("host_sessions", hostSessions.size);
    return true;
  }, { bypassQueueLimit: true });
  const server = createServer((request, response) => {
    if (request.method === "GET" && (request.url === "/health" || request.url === "/healthz")) {
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
      if (!state.isDetaching) void state.pipeline.tick().catch(() => failOwnedPipeline(state.settings.sessionId, state.pipeline));
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
        webSocket.gatewayClientKind = typeof request.headers.origin === "string" ? "browser" : "desktop-main";
        webSocket.promoteGatewayConnection = releaseConnection.promote;
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
    let demandConnection = null;
    let reauthorizeTimer = null;
    let reauthorizeInFlight = null;
    let reauthorizeGeneration = 0;
    let replayAbortController = null;
    let replayGeneration = 0;
    let tokenExpiryTimer = null;
    const authorizationControllers = new Set();
    const pendingHostControllers = new Set();
    const assertHostSocketActive = (signal = null) => {
      if (signal?.aborted) throw signal.reason ?? new Error("HOST_CONNECTION_CLOSED");
      if (isShuttingDown) throw new Error("GATEWAY_SHUTTING_DOWN");
      if (webSocket.readyState !== WebSocket.OPEN) throw new Error("HOST_CONNECTION_CLOSED");
    };
    const cancelReplay = () => {
      replayGeneration += 1;
      replayAbortController?.abort(new Error("REPLAY_CANCELLED"));
      replayAbortController = null;
    };
    const runViewerAuthorization = async (sessionId, language, { force = false } = {}) => {
      const abortController = new AbortController();
      authorizationControllers.add(abortController);
      try {
        return await viewerAuthorizationLeases.authorize(claims, sessionId, language, {
          signal: abortController.signal,
          force,
        });
      } finally {
        authorizationControllers.delete(abortController);
      }
    };
    const runParticipantSpeakingAuthorization = async (sessionId) => {
      if (typeof viewerAuthorizer.authorizeSpeaking !== "function") return false;
      const abortController = new AbortController();
      authorizationControllers.add(abortController);
      try {
        return await viewerAuthorizer.authorizeSpeaking(claims, sessionId, {
          signal: abortController.signal,
        }) === true;
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
      const authorization = runViewerAuthorization(metadata.sessionId, metadata.language, { force });
      const inFlight = authorization
        .then(async (isAuthorized) => {
          if (generation !== reauthorizeGeneration) return false;
          if (!isAuthorized) {
            closeWithError(webSocket, "GRANT_REVOKED", "시청 권한이 만료되었습니다.", 4403);
            return false;
          }
          if (metadata.capabilities.participantSpeakingEnabled) {
            const isSpeakingStillAuthorized = await leasedParticipantSpeakingAuthorization(
              metadata.sessionId,
              () => runParticipantSpeakingAuthorization(metadata.sessionId),
            );
            if (generation !== reauthorizeGeneration) return false;
            if (!isSpeakingStillAuthorized) {
              metadata.capabilities.participantSpeakingEnabled = false;
              await releaseFloor(metadata.sessionId, {
                grantId: claims.grantId,
                reason: "disabled",
              });
              metrics.increment("participant_speaking_revocations_total");
            }
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
      if (claims?.sessionId) {
        const sessionSockets = authenticatedSessionSockets.get(claims.sessionId);
        sessionSockets?.delete(webSocket);
        if (sessionSockets?.size === 0) authenticatedSessionSockets.delete(claims.sessionId);
      }
      for (const abortController of authorizationControllers) abortController.abort();
      authorizationControllers.clear();
      // 2026-08-31 fix: 연결 종료 후 완료된 준비 작업이 유료 파이프라인 소유권을 되살리지 못하게 한다.
      for (const controller of pendingHostControllers) controller.abort(new Error("HOST_CONNECTION_CLOSED"));
      pendingHostControllers.clear();
      metrics.increment("connection_cleanups_total");
    });
    connectionCleanup.set(webSocket, cleanupTimers);
    webSocket.on("pong", () => {
      webSocket.isAlive = true;
      if (claims) demand?.markAlive(claims.sessionId, demandConnection);
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
          const verifiedClaims = verifyLiveToken(message.token, { gatewaySecret, viewerSecret, now });
          if (verifiedClaims.role === "VIEWER") {
            if (viewerTicketReplayGuard.consume(verifiedClaims) !== true) throw new Error("UNAUTHORIZED");
            if (webSocket.promoteGatewayConnection?.(authenticatedViewerConnectionKey(verifiedClaims, gatewaySecret)) !== true) {
              throw new Error("CONNECTION_LIMIT");
            }
          }
          claims = verifiedClaims;
          clearTimeoutFn(authTimer);
          const sessionSockets = authenticatedSessionSockets.get(claims.sessionId) ?? new Set();
          sessionSockets.add(webSocket);
          authenticatedSessionSockets.set(claims.sessionId, sessionSockets);
          if (claims.role === "HOST") {
            tokenExpiryTimer = setTimeoutFn(
              () => closeWithError(webSocket, "TOKEN_EXPIRED", "게이트웨이 인증이 만료되었습니다.", 4401),
              Math.max(0, claims.exp * 1_000 - now()),
            );
          }
          sendJson(webSocket, { type: "authenticated", role: claims.role });
          return;
        }
        if (claims.role === "HOST") {
          if (isBinary) {
            const state = hostSessions.get(claims.sessionId);
            if (!state || state.webSocket !== webSocket || state.isDetaching) throw new Error("SESSION_NOT_STARTED");
            const decoded = decodeHostAudioFrame(data);
            if (floorHolders.has(claims.sessionId)) {
              // A participant holds the speaking floor: their audio wins.
              metrics.increment("dropped_audio_frames_total");
              return;
            }
            if (state.pipeline?.isPaused === true) {
              // The pipeline drops paused frames anyway; dropping here keeps
              // paused streaming from silently burning the 2h byte budget.
              metrics.increment("dropped_audio_frames_total");
              return;
            }
            consumeAudioBudget(claims.sessionId, decoded.pcm.byteLength);
            const capturedAt = now();
            const audioLane = getHostAudioLane(state, decoded.source);
            if (audioLane.pendingFrames * AUDIO_CONFIG.chunkMilliseconds >= AUDIO_CONFIG.staleFrameMilliseconds) {
              metrics.increment("dropped_audio_frames_total");
              return;
            }
            audioLane.pendingFrames += 1;
            audioLane.tail = audioLane.tail
              .then(async () => {
                if (state.isDetaching) return;
                return state.pipeline.acceptAudio(
                  decoded.pcm,
                  capturedAt,
                  null,
                  decoded.source,
                );
              })
              .catch(() => failOwnedPipeline(claims.sessionId, state.pipeline))
              .finally(() => { audioLane.pendingFrames -= 1; });
            metrics.increment("audio_frames_total");
            return;
          }
          const message = parseJson(data);
          const active = hostSessions.get(claims.sessionId);
          if (message.type === "audioStreamEnd" && active?.webSocket === webSocket) {
            await drainHostAudioLanes(active);
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
            try {
              await withHostSessionLock(claims.sessionId, async () => {
                if (hostSessions.get(claims.sessionId) !== active || active.isDetaching) throw new Error("SESSION_NOT_STARTED");
                assertHostSocketActive();
                if (message.type === "pause") await active.pipeline.pause?.();
                else await active.pipeline.resume?.();
                assertHostSocketActive();
                if (hostSessions.get(claims.sessionId) !== active || active.isDetaching) throw new Error("SESSION_NOT_STARTED");
                const status = message.type === "pause" ? "paused" : "live";
                sendJson(webSocket, { type: message.type === "pause" ? "paused" : "resumed", sessionId: claims.sessionId });
                await broadcastSessionStatus(claims.sessionId, status);
              });
            } catch (error) {
              if (error?.message === "SESSION_NOT_STARTED" || error?.message === "HOST_CONNECTION_CLOSED") {
                sendJson(webSocket, { type: "error", code: error.message, message: gatewayMessage(error.message) });
              } else {
                await failOwnedPipeline(claims.sessionId, active.pipeline);
              }
            }
            return;
          }
          if (message.type === "detach") {
            webSocket.immediateTeardown = true;
            await detachOwnedHostSession(claims.sessionId, webSocket);
            sendJson(webSocket, { type: "detached", sessionId: claims.sessionId });
            if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1000, "host detached");
            return;
          }
          if (message.type === "stop") {
            // An explicit authenticated stop is materially different from a
            // transient socket close: providers are released immediately and
            // no reconnect-grace pipeline is retained.
            webSocket.immediateTeardown = true;
            const stopped = await stopOwnedHostSession(claims.sessionId, webSocket);
            if (stopped) metrics.increment("host_intentional_stops_total");
            else metrics.increment("host_stop_idempotent_total");
            sendJson(webSocket, { type: "stopped", sessionId: claims.sessionId });
            if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1000, "session stopped");
            return;
          }
          if (!["start", "update", "restart"].includes(message.type)
            || message.sessionId !== claims.sessionId
            || !Number.isSafeInteger(message.version)) throw new Error("INVALID_START");
          if (message.demandEnabled === true && !demand) throw new Error("MEDIA_DEMAND_DISABLED");
          const normalizedSettings = validateLiveSettings(message);
          const hostMessage = {
            ...message,
            ...normalizedSettings,
            sessionId: claims.sessionId,
          };
          try {
            const prepared = await withHostSessionLock(claims.sessionId, async () => {
              if (shutdownAbortController.signal.aborted) throw shutdownAbortController.signal.reason;
              assertHostSocketActive();
              const previous = hostSessions.get(claims.sessionId);
              const priorFailure = failedHostSessions.get(claims.sessionId);
              if (sessionCleanupFailures.has(claims.sessionId)) throw new Error("PIPELINE_CLEANUP_FAILED");
              if (priorFailure && message.type !== "restart") throw new Error("PIPELINE_RESTART_REQUIRED");
              if (priorFailure && !priorFailure.cleanupComplete) throw new Error("PIPELINE_CLEANUP_FAILED");
              if (!priorFailure && failedHostSessions.size >= maxSessionAudioEntries) throw new Error("PIPELINE_RESTART_REQUIRED");
              // Host reconnect within the grace window (contract C3): the same
              // host re-authenticating with unchanged settings reattaches the
              // detached pipeline — seq counters and the speaking floor survive.
              if (message.type === "start"
                && previous
                && !previous.isDetaching
                && isSameHostSettings(previous.settings, hostMessage)
                && ((previous.detached
                  && (previous.activationKey === null || previous.activationKey === message.activationKey))
                  || (!previous.detached
                    && previous.activationKey !== null
                    && previous.activationKey === message.activationKey))) {
                const reattachAbortController = new AbortController();
                pendingHostControllers.add(reattachAbortController);
                const abortReattachForShutdown = () => reattachAbortController.abort(new Error("GATEWAY_SHUTTING_DOWN"));
                shutdownAbortController.signal.addEventListener("abort", abortReattachForShutdown, { once: true });
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
                  assertHostSocketActive(reattachAbortController.signal);
                  if (hostSessions.get(claims.sessionId) !== previous || previous.isDetaching) {
                    throw new Error("SESSION_NOT_STARTED");
                  }
                } finally {
                  clearTimeoutFn(reattachTimer);
                  pendingHostControllers.delete(reattachAbortController);
                  shutdownAbortController.signal.removeEventListener("abort", abortReattachForShutdown);
                }
                const replacedWebSocket = previous.webSocket;
                if (previous.graceTimer) {
                  clearTimeoutFn(previous.graceTimer);
                  previous.graceTimer = null;
                }
                previous.detached = false;
                previous.webSocket = webSocket;
                webSocket.demandEpoch = previous.demandEpoch;
                // 2026-07-26 fix: the preserved pipeline owns a mutable output sink. Updating
                // it makes captions follow the newly attached host instead of
                // continuing to write to the closed pre-reconnect socket.
                previous.hostOutput.webSocket = webSocket;
                if (previous.hostOutput.clientKind !== webSocket.gatewayClientKind) {
                  previous.hostOutput.bufferedFinals.length = 0;
                  previous.hostOutput.bufferedPartials.clear();
                  previous.hostOutput.finalSeqByLanguage.clear();
                  previous.hostOutput.nextBufferedOrder = 0;
                }
                previous.hostOutput.clientKind = webSocket.gatewayClientKind;
                stopHostLease(previous);
                startHostLease(previous, claims);
                if (replacedWebSocket !== webSocket && replacedWebSocket.readyState === WebSocket.OPEN) {
                  replacedWebSocket.close(4410, "REPLACED");
                }
                metrics.increment("host_reattaches_total");
                return {
                  reattached: true,
                  sessionType: previous.settings.sessionType,
                  outputMode: previous.settings.outputMode,
                  voiceProvider: previous.settings.voiceProvider,
                  maxViewers: previous.settings.maxViewers,
                  glossaryPack: previous.settings.glossaryPack,
                  version: previous.settings.version,
                  hostOutput: previous.hostOutput,
                };
              }
              let candidate = null;
              const pipelineGeneration = randomUUID();
              let factoryAttempted = false;
              let factoryFinished = false;
              let startFailure = null;
              let demandEpoch = null;
              const hasActivationKey = message.activationKey !== undefined;
              const usesReadinessActivation = ["start", "restart"].includes(message.type)
                && typeof hostAuthorizer.activate === "function"
                && hasActivationKey;
              const hostOutput = createHostOutput(webSocket);
              const operationAbortController = new AbortController();
              pendingHostControllers.add(operationAbortController);
              const abortForShutdown = () => operationAbortController.abort(
                shutdownAbortController.signal.reason ?? new Error("GATEWAY_SHUTTING_DOWN"),
              );
              shutdownAbortController.signal.addEventListener("abort", abortForShutdown, { once: true });
              const startTimer = setTimeoutFn(
                () => operationAbortController.abort(new Error("HOST_START_TIMEOUT")),
                hostStartTimeoutMilliseconds,
              );
              try {
                if (hasActivationKey && (typeof message.activationKey !== "string" || !UUID_PATTERN.test(message.activationKey))) {
                  throw new Error("INVALID_ACTIVATION_KEY");
                }
                if (hasActivationKey && (message.type === "update" || (message.type === "restart" && !usesReadinessActivation))) {
                  throw new Error("INVALID_ACTIVATION_KEY");
                }
                const authorization = await authorizeHost(claims, hostMessage, operationAbortController, usesReadinessActivation
                  ? { readinessStart: true, compareVersion: true }
                  : { requireLive: true, compareVersion: true });
                if (!authorization) throw new Error("SESSION_REVOKED");
                demandEpoch = demand ? (await demand.read(claims.sessionId))?.epoch ?? null : null;
                webSocket.demandEpoch = demandEpoch;
                if (demandEpoch !== null) await demand.prepare(claims.sessionId, operationAbortController.signal);
                assertHostSocketActive(operationAbortController.signal);
                const pinnedGlossaryFingerprint = usesReadinessActivation
                  ? authorization.pinnedGlossaryFingerprint
                  : null;
                const readinessMode = usesReadinessActivation ? authorization.readinessMode : null;
                if (usesReadinessActivation
                  && (!["activate", "resume-live"].includes(readinessMode)
                    || !(pinnedGlossaryFingerprint === null
                      || /^sha256:[a-f0-9]{64}$/u.test(pinnedGlossaryFingerprint)))) {
                  throw new Error("SESSION_REVOKED");
                }
                factoryAttempted = true;
                const factoryPromise = Promise.resolve().then(() => pipelineFactory(
                  hostMessage,
                  previous?.pipeline ?? null,
                  (event) => sendHostEvent(hostOutput, event),
                  {
                    signal: operationAbortController.signal,
                    pipelineGeneration,
                    requireDurableSeed: demandEpoch !== null || priorFailure !== undefined,
                    // 2026-08-31 fix: 준비 상태에서는 원문 쓰기가 불가능하고 live 전용 조정 RPC도 거부된다.
                    // 서버가 확인한 preparing 재시작은 엄격한 저장 순서 조회 후 활성화 CAS를 실행한다.
                    ...(priorFailure && !(usesReadinessActivation && authorization.sessionStatus === "preparing")
                      ? { recoveryReason: "durable-caption" } : {}),
                    mediaFence: demandEpoch === null ? null : { epoch: demandEpoch, ownerId: demand.ownerId },
                    onFatalError: () => failOwnedPipeline(claims.sessionId, candidate),
                  },
                ));
                void factoryPromise.then((lateCandidate) => {
                  factoryFinished = true;
                  pipelineSessionIds.set(lateCandidate, claims.sessionId);
                  if (operationAbortController.signal.aborted) {
                    return closePipelineOnce(lateCandidate).then(() => {
                      if (startFailure) startFailure.cleanupComplete = true;
                    }).catch(() => undefined);
                  }
                  return undefined;
                }, () => {
                  factoryFinished = true;
                  if (startFailure) startFailure.cleanupComplete = true;
                });
                candidate = await waitForAbort(factoryPromise, operationAbortController.signal);
                assertHostSocketActive(operationAbortController.signal);
                await waitForAbort(
                  Promise.resolve().then(() => candidate.start({ signal: operationAbortController.signal })),
                  operationAbortController.signal,
                );
                let authoritativeVersion = hostMessage.version;
                if (usesReadinessActivation && readinessMode === "activate") {
                  const readinessSettings = {
                    sessionId: claims.sessionId,
                    version: hostMessage.version,
                    activationKey: message.activationKey,
                    sessionType: hostMessage.sessionType,
                    outputMode: hostMessage.outputMode,
                    voiceProvider: hostMessage.voiceProvider,
                    languages: [...hostMessage.languages],
                    maxViewers: hostMessage.maxViewers,
                    glossaryPack: hostMessage.glossaryPack,
                    pinnedGlossaryFingerprint,
                  };
                  readinessSettings.gatewaySettingsFingerprint = fingerprintGatewaySettings(readinessSettings);
                  const activated = await waitForAbort(
                    Promise.resolve().then(() => hostAuthorizer.activate(claims, readinessSettings, {
                      signal: operationAbortController.signal,
                    })),
                    operationAbortController.signal,
                  );
                  if (activated?.sessionId !== claims.sessionId
                    || activated?.status !== "live"
                    || activated?.version !== hostMessage.version + 1) {
                    throw new Error("INVALID_GATEWAY_READINESS_RESPONSE");
                  }
                  authoritativeVersion = activated.version;
                } else {
                  const isStillAuthorized = await authorizeHost(claims, hostMessage, operationAbortController, {
                    requireLive: true,
                    compareVersion: true,
                  });
                  if (!isStillAuthorized) throw new Error("SESSION_REVOKED");
                }
                if (isShuttingDown) {
                  throw new Error("GATEWAY_SHUTTING_DOWN");
                }
                if (demand) await demand.ready(claims.sessionId, demandEpoch);
                assertHostSocketActive(operationAbortController.signal);
                hostMessage.authoritativeVersion = authoritativeVersion;
              } catch (error) {
                let cleanupComplete = false;
                try {
                  await closePipelineOnce(candidate);
                  cleanupComplete = candidate !== null || factoryFinished;
                } catch { metrics.increment("pipeline_close_failures_total"); }
                if (factoryAttempted && !previous
                  && !["HOST_CONNECTION_CLOSED", "GATEWAY_SHUTTING_DOWN", "MEDIA_DEMAND_LOST"].includes(error?.message)) {
                  startFailure = { cleanupComplete };
                  failedHostSessions.set(claims.sessionId, startFailure);
                }
                if (demand && demandEpoch !== null) {
                  setTimeoutFn(() => { void demand.fail(claims.sessionId, demandEpoch).catch(() => undefined); }, 0);
                }
                throw error;
              } finally {
                clearTimeoutFn(startTimer);
                pendingHostControllers.delete(operationAbortController);
                shutdownAbortController.signal.removeEventListener("abort", abortForShutdown);
              }
              const state = {
                pipeline: candidate,
                pipelineGeneration,
                demandEpoch,
                webSocket,
                hostOutput,
                audioLanes: new Map(),
                settings: {
                  sessionId: claims.sessionId,
                  version: hostMessage.authoritativeVersion,
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
                  captionConfig: hostMessage.captionConfig,
                  captionConfigFingerprint: hostMessage.captionConfigFingerprint,
                  languages: [...hostMessage.languages],
                },
                leaseTimer: null,
                leaseAbortController: null,
                leaseInFlight: null,
                detached: false,
                graceTimer: null,
                failureFlight: null,
                geminiSessionReleased: false,
                activationKey: usesReadinessActivation ? message.activationKey : null,
              };
              hostSessions.set(claims.sessionId, state);
              failedHostSessions.delete(claims.sessionId);
              startHostLease(state, claims);
              if (previous) {

                stopHostLease(previous);
                if (previous.graceTimer) {
                  clearTimeoutFn(previous.graceTimer);
                  previous.graceTimer = null;
                }
                try { await closePipelineOnce(previous.pipeline); }
                catch {
                  state.isDetaching = true;
                  try { candidate.abortMedia?.(); } catch { /* close remains required */ }
                  await closePipelineOnce(candidate).catch(() => undefined);
                  hostSessions.delete(claims.sessionId);
                  metrics.set("host_sessions", hostSessions.size);
                  closePipelineSocket(previous.webSocket, new Error("PIPELINE_CLEANUP_FAILED"));
                  throw new Error("PIPELINE_CLEANUP_FAILED");
                }
              }
              if (previous?.webSocket !== webSocket) previous?.webSocket.close(4410, "REPLACED");
              metrics.set("host_sessions", hostSessions.size);
              return {
                sessionType: hostMessage.sessionType,
                outputMode: hostMessage.outputMode,
                voiceProvider: hostMessage.voiceProvider,
                maxViewers: hostMessage.maxViewers,
                glossaryPack: hostMessage.glossaryPack,
                version: hostMessage.authoritativeVersion,
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
              version: prepared.version,
              languages: hostMessage.languages,
              audio: { sampleRate: AUDIO_CONFIG.inputSampleRate, channels: 1, chunkMilliseconds: AUDIO_CONFIG.chunkMilliseconds },
            });
            if (prepared.reattached) flushHostCaptionBuffer(prepared.hostOutput);
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
            // 2026-07-27 fix: a desktop HOST reconnect starts muted and only an
            // authoritative snapshot may reopen its local capture gate. Send a
            // snapshot after every start/restart/reattach, including holder:null;
            // relying only on changes left a reconnect permanently muted or,
            // worse, tempted clients to guess that the floor was free.
            sendJson(webSocket, createFloorPayload(
              claims.sessionId,
              floorHolders.get(claims.sessionId) ?? null,
            ));
          } catch (error) {
            const code = error instanceof Error ? error.message : "PIPELINE_START_FAILED";
            sendJson(webSocket, {
              type: "error", code, message: gatewayMessage(code),
              ...(failedHostSessions.has(claims.sessionId) ? { requiresManualRestart: true } : {}),
            });
          }
          return;
        }
        if (isBinary) {
          const metadata = viewerMetadata.get(webSocket);
          const holder = floorHolders.get(claims.sessionId);
          if (!metadata?.capabilities.participantSpeakingEnabled) {
            throw new Error("VIEWER_MEDIA_FORBIDDEN");
          }
          if (!holder
            || holder.webSocket !== webSocket
            || holder.grantId !== claims.grantId) {
            // Audio can race a preemption or speak-ended acknowledgement. A
            // once-valid speaker becomes receive-only immediately, while the
            // caption socket stays connected.
            metrics.increment("dropped_audio_frames_total");
            return;
          }
          const state = hostSessions.get(claims.sessionId);
          if (!state || state.isDetaching) throw new Error("SESSION_NOT_STARTED");
          if (data.byteLength !== INPUT_FRAME_BYTES) throw new Error("INVALID_AUDIO_FRAME");
          if (state.pipeline?.isPaused === true) {
            // Same paused-drop as host frames: never charge the byte budget
            // for audio the pipeline is guaranteed to discard.
            metrics.increment("dropped_audio_frames_total");
            return;
          }
          consumeAudioBudget(claims.sessionId, data.byteLength);
          holder.lastFrameAt = now();
          const capturedAt = now();
          const capturedFloorSpeaker = {
            participantId: holder.participantId,
            displayName: holder.displayName,
            department: holder.department,
            jobTitle: holder.jobTitle,
          };
          const frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          if (holder.pendingFrames * AUDIO_CONFIG.chunkMilliseconds >= AUDIO_CONFIG.staleFrameMilliseconds) {
            metrics.increment("dropped_audio_frames_total");
            return;
          }
          holder.pendingFrames += 1;
          holder.audioTail = holder.audioTail
            .then(async () => {
              if (state.isDetaching) return;
              return state.pipeline.acceptAudio(
                frame,
                capturedAt,
                capturedFloorSpeaker,
                "participant",
              );
            })
            .catch(() => failOwnedPipeline(claims.sessionId, state.pipeline))
            .finally(() => { holder.pendingFrames -= 1; });
          metrics.increment("floor_audio_frames_total");
          return;
        }
        const message = parseJson(data);
        if (message.type === "speak-start") {
          const metadata = viewerMetadata.get(webSocket);
          if (!metadata || !await runParticipantSpeakingAuthorization(claims.sessionId)) {
            throw new Error("VIEWER_CONTROL_FORBIDDEN");
          }
          metadata.capabilities.participantSpeakingEnabled = true;
          await withFloorSessionLock(claims.sessionId, async () => {
            const speakStartReceivedAt = now();
            if (!floorController) throw new Error("FLOOR_UNAVAILABLE");
            const state = hostSessions.get(claims.sessionId);
            if (!state || state.isDetaching) {
              sendJson(webSocket, {
                type: "error",
                code: "SESSION_NOT_STARTED",
                message: gatewayMessage("SESSION_NOT_STARTED"),
              });
              return;
            }
            const activeHolder = floorHolders.get(claims.sessionId);
            if (activeHolder?.webSocket === webSocket && activeHolder.grantId === claims.grantId) {
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
              displayName: typeof result.displayName === "string" && result.displayName.trim()
                ? result.displayName.trim()
                : "참가자",
              department: profile?.department ?? "",
              jobTitle: profile?.jobTitle ?? "",
              pendingFrames: 0,
              audioTail: Promise.resolve(),
              lastFrameAt: now(),
            };
            floorHolders.set(claims.sessionId, holder);
            if (previous && previous.webSocket !== webSocket) {
              sendJson(previous.webSocket, {
                type: "speak-ended",
                sessionId: claims.sessionId,
                reason: "preempted",
              });
            }
            try {
              state.pipeline.setFloorSpeaker?.({
                participantId: holder.participantId,
                displayName: holder.displayName,
                department: holder.department,
                jobTitle: holder.jobTitle,
              });
            } catch {
              // The database grant is authoritative; attribution enrichment is
              // allowed to recover independently with the pipeline.
            }
            metrics.increment("floor_takes_total");
            sendJson(webSocket, {
              type: "speak-started",
              sessionId: claims.sessionId,
              displayName: holder.displayName,
              audio: {
                sampleRate: AUDIO_CONFIG.inputSampleRate,
                channels: 1,
                chunkMilliseconds: AUDIO_CONFIG.chunkMilliseconds,
              },
            });
            await broadcastFloor(claims.sessionId, holder);
            metrics.observe("floor_broadcast_latency_ms", Math.max(0, now() - speakStartReceivedAt));
          });
          return;
        }
        if (message.type === "speak-end") {
          const holder = floorHolders.get(claims.sessionId);
          if (!holder || holder.webSocket !== webSocket || holder.grantId !== claims.grantId) {
            throw new Error("VIEWER_CONTROL_FORBIDDEN");
          }
          await releaseFloor(claims.sessionId, { grantId: claims.grantId });
          return;
        }
        if (message.type !== "subscribe" && message.type !== "unsubscribe") {
          throw new Error("VIEWER_CONTROL_FORBIDDEN");
        }
        if (message.type === "unsubscribe") {
          await releaseFloor(claims.sessionId, { grantId: claims.grantId });
          if (demand) await demand.disconnect(claims.sessionId, demandConnection);
          demandConnection = null;
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
        const activeSession = hostSessions.get(message.sessionId);
        if (message.type !== "subscribe"
          || message.sessionId !== claims.sessionId
          || typeof message.language !== "string"
          || !language
          || (activeSession && !activeSession.settings.languages.includes(language))
          || (message.lastSeq !== undefined && (!Number.isSafeInteger(message.lastSeq) || message.lastSeq < 0))) {
          throw new Error("INVALID_SUBSCRIPTION");
        }
        if (!await runViewerAuthorization(message.sessionId, language)) throw new Error("GRANT_REVOKED");
        const participantSpeakingEnabled = await runParticipantSpeakingAuthorization(message.sessionId);
        if (demand && !demandConnection) demandConnection = await demand.connect(claims, message);
        if (demandConnection) webSocket.demandEpoch = demandConnection.epoch;
        if (webSocket.readyState !== WebSocket.OPEN) {
          if (demand) await demand.disconnect(claims.sessionId, demandConnection);
          return;
        }
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
          role: claims.role,
          capabilities: {
            liveEvents: true,
            participantSpeakingEnabled,
          },
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
        sendJson(webSocket, {
          type: "subscribed",
          sessionId: message.sessionId,
          language,
          capabilities: { participantSpeakingEnabled },
        });
        if (reauthorizeTimer) clearReauthorizeIntervalFn(reauthorizeTimer);
        reauthorizeGeneration += 1;
        const currentReauthorizeGeneration = reauthorizeGeneration;
        const reauthorizationDelay = viewerAuthorizationLeaseMilliseconds
          + viewerAuthorizationJitter(claims, viewerAuthorizationJitterMilliseconds);
        reauthorizeTimer = setReauthorizeIntervalFn(() => {
          if (currentReauthorizeGeneration === reauthorizeGeneration) void ensureViewerAuthorization({ force: true });
        }, reauthorizationDelay);
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
                const serialized = serializeJson({ type: "live-event", payload });
                const canContinue = deliverSerializedEvent(webSocket, payload, serialized);
                if (Number.isFinite(payload.seq)) replayedThroughSeq = Math.max(replayedThroughSeq, payload.seq);
                if (!canContinue) return;
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
          for (const { payload, serialized } of buffered) {
            if (payload.type === "caption" && Number.isFinite(payload.seq) && payload.seq <= replayedThroughSeq) continue;
            deliverSerializedEvent(webSocket, payload, serialized);
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
      if (demand && claims && demandConnection) {
        await demand.disconnect(claims.sessionId, demandConnection).catch(() => {
          metrics.increment("media_presence_release_failures_total");
        });
      }
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

            if (current.graceTimer) {
              clearTimeoutFn(current.graceTimer);
              current.graceTimer = null;
            }
            // Release before deleting ownership: the floor-null broadcast
            // needs the session's language list to reach the viewers.
            await releaseFloor(claims.sessionId, { reason: "session-ended" }).catch(() => undefined);
            hostSessions.delete(claims.sessionId);
            floorRevisions.delete(claims.sessionId);
            participantProfiles.deleteSession(claims.sessionId);
            viewerAuthorizationLeases.deleteSession(claims.sessionId);
            viewerAuthorizationBatcher.deleteSession(claims.sessionId);
            sessionAudioUsage.delete(claims.sessionId);
            await closePipelineOnce(current.pipeline).catch(() => undefined);
            await releaseGeminiSessionOnce(current);
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
      const state = hostSessions.get(sessionId);
      if (state?.hostOutput.clientKind === "browser"
        && event?.type === "caption"
        && event.sessionId === sessionId
        && event.language === language
        && state.settings.languages.includes(language)) {
        sendHostEvent(state.hostOutput, event, { isPublishedEvent: true });
      }
      await deliverEvent(sessionId, language, event);
    },
    async broadcastSourceEvent(event, context = {}) {
      if (!["source", "source-draft", "source-draft-clear"].includes(event?.type)
        || !UUID_PATTERN.test(String(event.sessionId ?? ""))) throw new Error("INVALID_SOURCE_EVENT");
      const sessionId = event.sessionId;
      const serialized = serializeJson({ type: "live-event", payload: event });
      const owner = hostSessions.get(sessionId);
      const canDeliver = () => owner && hostSessions.get(sessionId) === owner
        && context.pipelineGeneration === owner.pipelineGeneration
        && !owner.isDetaching && owner.pipeline.isPaused !== true
        && (context.mediaFence == null
          ? owner.demandEpoch === null
          : owner.demandEpoch === context.mediaFence.epoch && demand?.ownerId === context.mediaFence.ownerId);
      if (!canDeliver()) return;
      sendHostEvent(owner.hostOutput, event);
      // 2026-08-31 feat: 원문 구독은 언어별 번역 토픽과 분리하되 기존 참여자 권한을 재검증한다.
      // 인증만 한 소켓과 교체된 호스트에는 발송하지 않으며 snapshot의 source cursor가 재접속을 복구한다.
      await Promise.all([...(authenticatedSessionSockets.get(sessionId) ?? [])].map(async (socket) => {
        const metadata = viewerMetadata.get(socket);
        if (socket.readyState !== WebSocket.OPEN || metadata?.sessionId !== sessionId) return;
        if (!await metadata.ensureAuthorized()) return;
        if (viewerMetadata.get(socket) !== metadata || !canDeliver()) return;
        deliverSerializedEvent(socket, event, serialized);
      }));
    },
    async close() {
      if (isShuttingDown) return;
      isShuttingDown = true;
      demand?.close();
      shutdownAbortController.abort(new Error("GATEWAY_SHUTTING_DOWN"));
      clearInterval(tickTimer);
      clearInterval(heartbeatTimer);
      await Promise.all([...hostOperationTails.values()]);
      await Promise.all([...floorOperationTails.values()]);
      // 2026-07-19 fix: detach ownership before terminating sockets. Their close
      // handlers must not observe and close a pipeline already owned by shutdown.
      const ownedHostStates = [...hostSessions.values()];
      hostSessions.clear();
      failedHostSessions.clear();
      metrics.set("host_sessions", 0);
      for (const state of ownedHostStates) {
        stopHostLease(state);
        if (state.graceTimer) {
          clearTimeoutFn(state.graceTimer);
          state.graceTimer = null;
        }
        await closePipelineOnce(state.pipeline).catch(() => undefined);
        await releaseGeminiSessionOnce(state);
      }
      for (const pipeline of [...pipelinesPendingClose]) await closePipelineOnce(pipeline).catch(() => undefined);
      for (const client of webSockets.clients) {
        connectionCleanup.get(client)?.();
        client.terminate();
      }
      connectionCleanup.clear();
      sessionAudioUsage.clear();
      participantProfiles.clear();
      viewerAuthorizationLeases.clear();
      viewerAuthorizationBatcher.close();
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

function authenticatedViewerConnectionKey(claims, secret) {
  return createHmac("sha256", secret)
    .update("gateway-authenticated-viewer\0")
    .update(String(claims.sessionId))
    .update("\0")
    .update(String(claims.grantId))
    .update("\0")
    .update(String(claims.userId))
    .digest("hex");
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

function isSameHostSettings(previousSettings, message) {
  return previousSettings.sessionType === message.sessionType
    && previousSettings.outputMode === message.outputMode
    && previousSettings.voiceProvider === message.voiceProvider
    && previousSettings.maxViewers === message.maxViewers
    // glossaryPack is deliberately NOT compared: it never reaches a prompt or
    // adapter, and captionConfigFingerprint already covers real config drift —
    // comparing it only forced needless pipeline rebuilds on reattach.
    // Without these three, editing the desktop glossary / tone / domain and
    // restarting reused the running pipeline with the OLD values, so the edit
    // silently did nothing until a brand-new session.
    && (previousSettings.glossaryText ?? "") === (message.glossaryText ?? "")
    && (previousSettings.translationTone ?? "") === (message.translationTone ?? "")
    && (previousSettings.domainText ?? "") === (message.domainText ?? "")
    && (previousSettings.captionConfigFingerprint ?? "") === (message.captionConfigFingerprint ?? "")
    && previousSettings.languages.length === message.languages.length
    && previousSettings.languages.every((language, index) => language === message.languages[index]);
}

function removeViewer(topic, webSocket, topics) {
  if (!topic) return;
  const viewers = topics.get(topic);
  viewers?.delete(webSocket);
  if (viewers?.size === 0) topics.delete(topic);
}

function fingerprintGatewaySettings(settings) {
  const canonical = JSON.stringify({
    sessionType: settings.sessionType,
    outputMode: settings.outputMode,
    voiceProvider: settings.voiceProvider,
    languages: settings.languages,
    maxViewers: settings.maxViewers,
    glossaryPack: settings.glossaryPack,
    pinnedGlossaryFingerprint: settings.pinnedGlossaryFingerprint,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function gatewayMessage(code) {
  if (code === "GRANT_REVOKED") return "시청 권한이 만료되었거나 회수되었습니다.";
  if (code === "UNAUTHORIZED") return "게이트웨이 인증에 실패했습니다.";
  if (code === "TOKEN_EXPIRED") return "게이트웨이 인증이 만료되었습니다.";
  if (code === "VIEWER_MEDIA_FORBIDDEN") return "참여자는 음성을 전송할 수 없습니다.";
  if (code === "VIEWER_CONTROL_FORBIDDEN") return "참여자는 자막 구독 외 미디어 제어를 사용할 수 없습니다.";
  if (code === "SESSION_REVOKED" || code === "SESSION_STOPPED") return "라이브 세션이 종료되었거나 설정이 변경되었습니다.";
  if (code === "PIPELINE_STOP_FAILED") return "라이브 미디어 연결을 종료하지 못했습니다. 다시 시도해주세요.";
  if (code === "PIPELINE_RESTART_REQUIRED") return "음성 또는 원문 처리에 오류가 발생해 중지했습니다. 호스트가 다시 시작을 눌러주세요.";
  if (code === "PIPELINE_CLEANUP_FAILED") return "이전 음성 연결을 종료하지 못했습니다. 새 연결을 시작할 수 없습니다.";
  if (code === "SLOW_CONSUMER") return "오디오 재생이 네트워크 속도를 따라가지 못해 연결을 종료합니다.";
  if (code === "FLOOR_DENIED" || code === "SESSION_NOT_LIVE") return "지금은 발언권을 가져올 수 없습니다.";
  if (code === "FLOOR_RATE_LIMITED") return "발언 요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.";
  if (code === "GRANT_INVALID") return "발언 권한이 확인되지 않았습니다. 다시 입장해 주세요.";
  if (code === "FLOOR_UNAVAILABLE") return "이 게이트웨이에서는 발언 기능을 사용할 수 없습니다.";
  if (code === "SESSION_NOT_STARTED") return "라이브 세션이 아직 시작되지 않았습니다.";
  if (code === "INVALID_ACTIVATION_KEY") return "라이브 시작 요청 식별자가 올바르지 않습니다.";
  if (code === "GATEWAY_READINESS_CONFLICT" || code === "GATEWAY_READINESS_FAILED"
    || code === "INVALID_GATEWAY_READINESS_INPUT" || code === "INVALID_GATEWAY_READINESS_RESPONSE") {
    return "라이브 시작 상태가 변경되었습니다. 세션 정보를 새로고침해 주세요.";
  }
  if (code === "QUEUE_LATENCY_EXCEEDED") return "지연된 음성 작업을 건너뛰고 자동으로 재시작했습니다.";
  return "미디어 게이트웨이 요청을 처리할 수 없습니다.";
}
