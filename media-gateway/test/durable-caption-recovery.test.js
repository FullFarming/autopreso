import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

import { WebSocket } from "ws";

import { AUDIO_CONFIG } from "../src/config.js";
import { createGatewayServer } from "../src/gateway-server.js";
import { LiveMediaPipeline } from "../src/live-media-pipeline.js";
import { resolvePipelineInitialSequences } from "../src/server.js";

const INPUT_FRAME_BYTES = AUDIO_CONFIG.inputSampleRate * 2 * AUDIO_CONFIG.chunkMilliseconds / 1_000;

function signToken(secret, claims) {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

function hostToken(secret) {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  return signToken(secret, {
    role: "HOST", sub: "host-1", sessionId: "session-1", aud: "media-gateway",
    iat: nowSeconds, exp: nowSeconds + 900,
  });
}

function viewerToken(secret) {
  const now = Date.now();
  return signToken(secret, {
    role: "VIEWER", grantId: "grant-1", userId: "participant-1", sessionId: "session-1",
    issuedAt: now, expiresAt: now + 60_000,
  });
}

async function nextJson(webSocket) {
  const [data] = await once(webSocket, "message");
  return JSON.parse(data.toString("utf8"));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("CONDITION_TIMEOUT");
}

function pipelineDependencies() {
  const sessions = [];
  return {
    sessions,
    dependencies: {
      liveTranslate: {
        async open(options) {
          const session = {
            ...options,
            async sendAudio() {}, async audioStreamEnd() {}, async close() {},
          };
          sessions.push(session);
          return session;
        },
      },
      openaiLiveTranslate: { async open() { throw new Error("UNUSED"); } },
      textTranslate: { async translate() { throw new Error("UNUSED"); } },
      textToSpeech: { async *synthesizeStream() {} },
      publisher: {
        async publish(_sessionId, _language, event) {
          if (event.type === "caption") throw new Error("DURABLE_CAPTION_PERSIST_FAILED");
        },
        async markLive() {},
      },
    },
  };
}

test("a pipeline reports concurrent durable caption failures exactly once", async () => {
  const state = pipelineDependencies();
  const fatalErrors = [];
  const pipeline = new LiveMediaPipeline({
    sessionId: "fatal-once",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko", "en"],
    dependencies: state.dependencies,
    onFatalError: (error) => fatalErrors.push(error),
  });
  await pipeline.start();

  await Promise.allSettled(state.sessions.map((session) => session.onCaption({
    text: session.language === "ko" ? "저장 실패 자막" : "A caption that cannot persist",
    isFinal: true,
  })));

  assert.equal(fatalErrors.length, 1);
  assert.equal(fatalErrors[0].message, "DURABLE_CAPTION_PERSIST_FAILED");
  await pipeline.close();
});

test("durable failure swaps one pipeline while preserving socket, session, and speaking floor", async (context) => {
  const pipelines = [];
  let recoveryAttempts = 0;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    hostAuthorizer: { async authorize() { return true; } },
    viewerAuthorizer: { async authorize() { return true; } },
    floorTakeCooldownMilliseconds: 0,
    durableRecoveryRetryDelaysMilliseconds: [50],
    durableRecoveryAttemptTimeoutMilliseconds: 5,
    recoveryAudioSpoolMilliseconds: 800,
    floorController: {
      async take() { return { ok: true, participantId: "participant-1", displayName: "참여자" }; },
      async release() { return true; },
    },
    async pipelineFactory(settings, previous, onHostEvent, options = {}) {
      if (options.recoveryReason === "durable-caption") {
        recoveryAttempts += 1;
        if (recoveryAttempts === 1) {
          return new Promise((resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(options.signal.reason),
              { once: true },
            );
          });
        }
      }
      const pipeline = {
        settings,
        previous,
        options,
        closed: 0,
        paused: 0,
        frames: [],
        hostEvents: [],
        floorSpeakers: [],
        async start() {}, async tick() {}, async endAudioStream() {},
        async acceptAudio(frame) {
          this.frames.push(frame[0]);
          const event = { type: "caption", sessionId: settings.sessionId, language: "ko", seq: 6, text: "복구 후 자막", isFinal: true };
          this.hostEvents.push(event);
          onHostEvent(event);
        },
        pause() { this.paused += 1; },
        setFloorSpeaker(speaker) { this.floorSpeakers.push(speaker); },
        async close() { this.closed += 1; },
      };
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const host = new WebSocket(`ws://127.0.0.1:${port}/live`);
  const participant = new WebSocket(`ws://127.0.0.1:${port}/live`);
  context.after(() => host.terminate());
  context.after(() => participant.terminate());
  await Promise.all([once(host, "open"), once(participant, "open")]);

  let received = nextJson(host);
  host.send(JSON.stringify({ type: "authenticate", token: hostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(host);
  host.send(JSON.stringify({
    type: "start", sessionId: "session-1", version: 1,
    sessionType: "meeting", outputMode: "captions", languages: ["ko", "en"],
  }));
  assert.equal((await received).type, "started");

  received = nextJson(participant);
  participant.send(JSON.stringify({ type: "authenticate", token: viewerToken("viewer-secret") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(participant);
  participant.send(JSON.stringify({ type: "subscribe", sessionId: "session-1", language: "ko" }));
  assert.equal((await received).type, "subscribed");
  received = nextJson(participant);
  participant.send(JSON.stringify({ type: "speak-start", sessionId: "session-1" }));
  assert.equal((await received).type, "speak-started");

  const failure = new Error("DURABLE_CAPTION_PERSIST_FAILED");
  pipelines[0].options.onFatalError(failure);
  pipelines[0].options.onFatalError(new Error("DURABLE_CAPTION_LANE_FAILED"));
  for (let index = 0; index < 25; index += 1) {
    const frame = Buffer.alloc(INPUT_FRAME_BYTES);
    frame[0] = index;
    participant.send(frame);
  }
  await waitFor(() => pipelines.length === 2);
  await waitFor(() => pipelines[0].closed === 1);

  assert.equal(host.readyState, WebSocket.OPEN);
  assert.equal(participant.readyState, WebSocket.OPEN);
  assert.equal(pipelines.length, 2, "concurrent failures must coalesce into one replacement");
  assert.equal(recoveryAttempts, 2, "the one recovery flight retries replacement, not the failed final");
  assert.equal(pipelines[0].paused, 1, "the ambiguous pipeline is quarantined before reconciliation");
  assert.equal(pipelines[1].previous, pipelines[0]);
  assert.equal(pipelines[1].options.recoveryReason, "durable-caption");
  assert.equal(pipelines[1].settings.sessionId, "session-1");
  assert.equal(pipelines[1].floorSpeakers.at(-1)?.participantId, "participant-1");

  await waitFor(() => pipelines[1].frames.length === 20);
  assert.deepEqual(pipelines[0].frames, []);
  assert.deepEqual(
    pipelines[1].frames,
    Array.from({ length: 20 }, (_, index) => index + 5),
    "the rolling 800ms cap evicts oldest frames but preserves retained order",
  );
  assert.equal(pipelines[1].hostEvents.at(-1)?.text, "복구 후 자막");
});

test("removing the host session cancels a pending durable recovery retry", async () => {
  let recoveryAttempts = 0;
  let firstPipeline = null;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    hostAuthorizer: { async authorize() { return true; } },
    viewerAuthorizer: { async authorize() { return true; } },
    hostReconnectGraceMilliseconds: 0,
    durableRecoveryRetryDelaysMilliseconds: [10_000],
    async pipelineFactory(_settings, _previous, _onHostEvent, options = {}) {
      if (options.recoveryReason === "durable-caption") {
        recoveryAttempts += 1;
        throw new Error("RECONCILIATION_UNAVAILABLE");
      }
      firstPipeline = {
        options,
        async start() {}, async tick() {}, async acceptAudio() {}, async endAudioStream() {},
        pause() {}, async close() {},
      };
      return firstPipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const host = new WebSocket(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  await once(host, "open");
  let received = nextJson(host);
  host.send(JSON.stringify({ type: "authenticate", token: hostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(host);
  host.send(JSON.stringify({
    type: "start", sessionId: "session-1", version: 1,
    sessionType: "meeting", outputMode: "captions", languages: ["ko", "en"],
  }));
  assert.equal((await received).type, "started");

  firstPipeline.options.onFatalError(new Error("DURABLE_CAPTION_PERSIST_FAILED"));
  await waitFor(() => recoveryAttempts === 1);
  const closed = once(host, "close");
  host.close();
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(recoveryAttempts, 1, "session removal must cancel the scheduled retry");
  await gateway.close();
});

test("a reattaching host preempts a hung recovery attempt without losing the preserved session", async (context) => {
  let initialPipeline = null;
  let recoveryAttempts = 0;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    hostAuthorizer: { async authorize() { return true; } },
    viewerAuthorizer: { async authorize() { return true; } },
    hostReconnectGraceMilliseconds: 45_000,
    durableRecoveryRetryDelaysMilliseconds: [20_000],
    durableRecoveryAttemptTimeoutMilliseconds: 10_000,
    async pipelineFactory(_settings, _previous, _onHostEvent, options = {}) {
      if (options.recoveryReason === "durable-caption") {
        recoveryAttempts += 1;
        return new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      }
      initialPipeline = {
        options,
        async start() {}, async tick() {}, async acceptAudio() {}, async endAudioStream() {},
        pause() {}, async close() {},
      };
      return initialPipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const url = `ws://127.0.0.1:${gateway.server.address().port}/live`;
  const startMessage = {
    type: "start", sessionId: "session-1", version: 1,
    sessionType: "meeting", outputMode: "captions", languages: ["ko", "en"],
  };
  const first = new WebSocket(url);
  await once(first, "open");
  let received = nextJson(first);
  first.send(JSON.stringify({ type: "authenticate", token: hostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(first);
  first.send(JSON.stringify(startMessage));
  assert.equal((await received).type, "started");
  initialPipeline.options.onFatalError(new Error("DURABLE_CAPTION_PERSIST_FAILED"));
  await waitFor(() => recoveryAttempts === 1);
  const firstClosed = once(first, "close");
  first.terminate();
  await firstClosed;

  const second = new WebSocket(url);
  context.after(() => second.terminate());
  await once(second, "open");
  received = nextJson(second);
  second.send(JSON.stringify({ type: "authenticate", token: hostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(second);
  second.send(JSON.stringify(startMessage));
  assert.equal((await received).type, "started");
  assert.equal(initialPipeline.options.onFatalError instanceof Function, true);
});

test("recovery drops spooled audio that aged past the bounded window while the room was silent", async (context) => {
  let clock = Date.now();
  let rejectFirstRecovery;
  let recoveryAttempts = 0;
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    hostAuthorizer: { async authorize() { return true; } },
    viewerAuthorizer: { async authorize() { return true; } },
    now: () => clock,
    audioBurstMilliseconds: 30_000,
    recoveryAudioSpoolMilliseconds: 800,
    durableRecoveryRetryDelaysMilliseconds: [0],
    durableRecoveryAttemptTimeoutMilliseconds: 1_000,
    async pipelineFactory(_settings, _previous, _onHostEvent, options = {}) {
      if (options.recoveryReason === "durable-caption") {
        recoveryAttempts += 1;
        if (recoveryAttempts === 1) {
          return new Promise((resolve, reject) => { rejectFirstRecovery = reject; });
        }
      }
      const pipeline = {
        options,
        frames: [],
        async start() {}, async tick() {}, async endAudioStream() {},
        async acceptAudio(frame) { this.frames.push(frame[0]); },
        pause() {}, async close() {},
      };
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = new WebSocket(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  await once(host, "open");
  let received = nextJson(host);
  host.send(JSON.stringify({ type: "authenticate", token: hostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(host);
  host.send(JSON.stringify({
    type: "start", sessionId: "session-1", version: 1,
    sessionType: "meeting", outputMode: "captions", languages: ["ko", "en"],
  }));
  assert.equal((await received).type, "started");

  pipelines[0].options.onFatalError(new Error("DURABLE_CAPTION_PERSIST_FAILED"));
  await waitFor(() => recoveryAttempts === 1 && typeof rejectFirstRecovery === "function");
  for (let index = 0; index < 3; index += 1) {
    const frame = Buffer.alloc(INPUT_FRAME_BYTES);
    frame[0] = index;
    host.send(frame);
  }
  await waitFor(() => /durable_recovery_audio_frames_spooled_total 3/u.test(gateway.metrics.render()));
  clock += 1_000;
  rejectFirstRecovery(new Error("RECONCILIATION_TEMPORARILY_UNAVAILABLE"));
  await waitFor(() => pipelines.length === 2);
  assert.deepEqual(pipelines[1].frames, []);
  assert.match(gateway.metrics.render(), /durable_recovery_audio_frames_dropped_total 3/u);
});

test("durable recovery seeds only from reconciled persisted maxima", async () => {
  const message = { sessionId: "session-1", languages: ["ko", "en"] };
  const previousPipeline = { lastSequences: { ko: 9, en: 10 } };
  const reconciled = [];
  const publisher = {
    async fetchLastUtteranceSeqs() { return { ko: 7, en: 3 }; },
    async reconcileCaptionLane(sessionId, language) {
      reconciled.push([sessionId, language]);
      return language === "ko" ? 7 : 3;
    },
  };

  assert.deepEqual(await resolvePipelineInitialSequences({
    publisher, message, previousPipeline, recoveryReason: "durable-caption",
  }), { ko: 7, en: 3 });
  assert.deepEqual(reconciled, [["session-1", "ko"], ["session-1", "en"]]);
  assert.deepEqual(await resolvePipelineInitialSequences({
    publisher, message, previousPipeline,
  }), { ko: 9, en: 10 });
});

test("durable recovery fails closed when persisted maxima cannot be reconciled", async () => {
  await assert.rejects(
    resolvePipelineInitialSequences({
      publisher: { async reconcileCaptionLane() { throw new Error("REQUEST_TIMEOUT"); } },
      message: { sessionId: "session-1", languages: ["ko", "en"] },
      previousPipeline: { lastSequences: { ko: 9, en: 10 } },
      recoveryReason: "durable-caption",
    }),
    /DURABLE_CAPTION_RECOVERY_SEED_FAILED/,
  );
  await assert.rejects(
    resolvePipelineInitialSequences({
      publisher: { async reconcileCaptionLane(_sessionId, language) { return language === "ko" ? 4 : undefined; } },
      message: { sessionId: "session-1", languages: ["ko", "en"] },
      previousPipeline: { lastSequences: { ko: 9, en: 10 } },
      recoveryReason: "durable-caption",
    }),
    /DURABLE_CAPTION_RECOVERY_SEED_INVALID/,
  );

  const abortController = new AbortController();
  const hungReconciliation = resolvePipelineInitialSequences({
    publisher: {
      async reconcileCaptionLane(_sessionId, _language, { signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    },
    message: { sessionId: "session-1", languages: ["ko", "en"] },
    recoveryReason: "durable-caption",
    signal: abortController.signal,
  });
  abortController.abort(new Error("SESSION_ENDED"));
  await assert.rejects(hungReconciliation, /DURABLE_CAPTION_RECOVERY_SEED_FAILED/);
});
