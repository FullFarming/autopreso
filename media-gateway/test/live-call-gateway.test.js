import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

import { WebSocket } from "ws";

import { AUDIO_CONFIG } from "../src/config.js";
import { createGatewayServer } from "../src/gateway-server.js";

const INPUT_FRAME_BYTES = AUDIO_CONFIG.inputSampleRate * 2 * AUDIO_CONFIG.chunkMilliseconds / 1_000;

function signHostToken(secret, { now = Date.now(), expiresInSeconds = 900 } = {}) {
  const nowSeconds = Math.floor(now / 1_000);
  const claims = { role: "HOST", sub: "host-1", sessionId: "session-1", aud: "media-gateway", iat: nowSeconds, exp: nowSeconds + expiresInSeconds };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

function signViewerToken(secret, grantId, { now = Date.now(), expiresInMilliseconds = 60_000 } = {}) {
  const claims = { role: "VIEWER", grantId, sessionId: "session-1", userId: grantId, issuedAt: now, expiresAt: now + expiresInMilliseconds };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

async function nextJson(webSocket) {
  const [data] = await once(webSocket, "message");
  return JSON.parse(data.toString("utf8"));
}

async function waitForJson(webSocket, predicate) {
  while (true) {
    const message = await nextJson(webSocket);
    if (predicate(message)) return message;
  }
}

function bufferJson(webSocket) {
  const queue = [];
  const waiters = [];
  webSocket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  return async function next(predicate) {
    while (true) {
      const message = queue.length > 0 ? queue.shift() : await new Promise((resolve) => waiters.push(resolve));
      if (predicate(message)) return message;
    }
  };
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition never became true: ${condition}`);
}

async function within(promise, label, milliseconds = 2_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const START_MESSAGE = {
  type: "start",
  sessionId: "session-1",
  sessionType: "meeting",
  outputMode: "captions_audio",
  version: 1,
  languages: ["ko", "en"],
};

function createLiveGateway({ gatewayOptions = {}, pipelineHooks = {} } = {}) {
  const pipelines = [];
  const timers = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cancelled = true; },
    ...gatewayOptions,
    async pipelineFactory(settings) {
      const pipeline = {
        settings,
        closed: 0,
        paused: 0,
        resumed: 0,
        frames: [],
        floorSpeakers: [],
        async start() {},
        async tick() {},
        async acceptAudio(frame) { this.frames.push(frame); },
        setFloorSpeaker(speaker) { this.floorSpeakers.push(speaker); },
        pause() { this.paused += 1; },
        resume() { this.resumed += 1; },
        async endAudioStream() {},
        async close() { this.closed += 1; },
        ...pipelineHooks,
      };
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  return { gateway, pipelines, timers };
}

async function connectHost(port, startMessage = START_MESSAGE) {
  const host = new WebSocket(`ws://127.0.0.1:${port}/live`);
  await once(host, "open");
  let received = nextJson(host);
  host.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(host);
  host.send(JSON.stringify(startMessage));
  assert.equal((await received).type, "started");
  return host;
}

async function joinViewer(port, grantId, { language = "ko", lastSeq } = {}) {
  const viewer = new WebSocket(`ws://127.0.0.1:${port}/live`);
  await once(viewer, "open");
  let received = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "authenticate", token: signViewerToken("viewer-secret", grantId) }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "subscribe", sessionId: "session-1", language, ...(lastSeq === undefined ? {} : { lastSeq }) }));
  assert.equal((await received).type, "subscribed");
  return viewer;
}

test("a hung caption replay cannot grow the live-event buffer without bound", async (context) => {
  // The replay never resolves, so the buffer would previously accumulate every
  // live event for the rest of the session.
  const { gateway } = createLiveGateway({
    gatewayOptions: {
      async replayUtterances() { await new Promise(() => {}); return []; },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const viewer = await joinViewer(port, "grant-overflow", { lastSeq: 0 });
  context.after(() => viewer.terminate());
  const received = [];
  viewer.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.type === "live-event") received.push(message.payload);
  });

  for (let seq = 1; seq <= 620; seq += 1) {
    await gateway.broadcastEvent("session-1", "ko", { type: "caption", seq, text: `line ${seq}`, isFinal: true });
  }
  await waitFor(() => received.length > 0);

  // Once the cap is passed the viewer starts receiving live events directly
  // instead of them piling up behind a replay that will never finish.
  assert.ok(received.length >= 100, `overflow must fall through to live delivery, got ${received.length}`);
  assert.match(gateway.metrics.render(), /replay_buffer_overflow_total/u);
});

test("a viewer can subscribe to the four-letter script subtags the host UI offers", async (context) => {
  // zh-Hans / zh-Hant are in the language registry and are selectable in the
  // host dashboard, so the subscribe validator must admit a 4-letter subtag.
  const { gateway } = createLiveGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  for (const language of ["zh-Hans", "zh-Hant"]) {
    const viewer = await joinViewer(port, `grant-${language}`, { language });
    context.after(() => viewer.terminate());
    assert.equal(gateway.subscriberCount("session-1", language), 1, `${language} must have a live topic`);
  }
});

test("a viewer cannot subscribe to a language outside the registry", async (context) => {
  const { gateway } = createLiveGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  for (const language of ["zh-Hanx", "e", "toolongsubtag", "ko-KOREA", "../ko", "ko;en"]) {
    const viewer = new WebSocket(`ws://127.0.0.1:${port}/live`);
    await once(viewer, "open");
    context.after(() => viewer.terminate());
    let received = nextJson(viewer);
    viewer.send(JSON.stringify({ type: "authenticate", token: signViewerToken("viewer-secret", `grant-bad-${language}`) }));
    assert.equal((await received).type, "authenticated");
    received = nextJson(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "session-1", language }));
    const reply = await received;
    assert.equal(reply.type, "error", `${language} must be rejected`);
    assert.equal(gateway.subscriberCount("session-1", language), 0);
  }
});

test("a reconnecting viewer replays exactly the missed captions before live events, without duplicates", async (context) => {
  let releaseReplay;
  const replayGate = new Promise((resolve) => { releaseReplay = resolve; });
  const replayCalls = [];
  const { gateway } = createLiveGateway({
    gatewayOptions: {
      async replayUtterances(sessionId, language, afterSeq, limit) {
        replayCalls.push([sessionId, language, afterSeq, limit]);
        await replayGate;
        return [
          { type: "caption", seq: 3, sessionId, language, text: "셋", isFinal: true },
          { type: "caption", seq: 4, sessionId, language, text: "넷", isFinal: true },
        ];
      },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const viewer = await joinViewer(port, "grant-replay", { lastSeq: 2 });
  context.after(() => viewer.terminate());
  const received = [];
  viewer.on("message", (data) => received.push(JSON.parse(data.toString("utf8"))));

  // Live events arriving while the replay is still fetching are queued: seq 4
  // duplicates a replayed row and must be dropped; seq 5 must follow.
  assert.equal(gateway.subscriberCount("session-1", "ko"), 1);
  await gateway.broadcastEvent("session-1", "ko", { type: "caption", seq: 4, text: "라이브 중복", isFinal: true });
  await gateway.broadcastEvent("session-1", "ko", { type: "caption", seq: 5, text: "다섯", isFinal: true });
  releaseReplay();
  await waitFor(() => received.length >= 3);

  assert.deepEqual(replayCalls, [["session-1", "ko", 2, 200]]);
  assert.deepEqual(received.map((message) => [message.payload.seq, message.payload.text, message.payload.replay ?? false]), [
    [3, "셋", true],
    [4, "넷", true],
    [5, "다섯", false],
  ]);
});

test("a reconnecting viewer with no gap receives no replay duplicates", async (context) => {
  const { gateway } = createLiveGateway({
    gatewayOptions: {
      async replayUtterances() { return []; },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const viewer = await joinViewer(port, "grant-nogap", { lastSeq: 9 });
  context.after(() => viewer.terminate());

  const live = nextJson(viewer);
  await gateway.broadcastEvent("session-1", "ko", { type: "caption", seq: 10, text: "이어서", isFinal: true });
  const message = await live;
  assert.equal(message.payload.seq, 10);
  assert.equal(message.payload.replay, undefined);
});

test("host disconnect keeps the pipeline, seq, and floor for the grace window and reattaches on reconnect", async (context) => {
  const releaseCalls = [];
  const { gateway, pipelines, timers } = createLiveGateway({
    gatewayOptions: {
      hostReconnectGraceMilliseconds: 45_000,
      floorController: {
        async take() { return { ok: true, displayName: "김노엘", participantId: "participant-1" }; },
        async release(...args) { releaseCalls.push(args); return true; },
      },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const host = await connectHost(port);
  const speaker = await joinViewer(port, "grant-speaker");
  context.after(() => speaker.terminate());
  speaker.send(JSON.stringify({ type: "speak-start" }));
  await waitForJson(speaker, (message) => message.type === "speak-started");

  host.close();
  await once(host, "close");
  await waitFor(() => timers.some((timer) => timer.delay === 45_000 && !timer.cancelled));

  // During grace: pipeline alive, floor not released, viewer still connected.
  assert.equal(pipelines[0].closed, 0);
  assert.deepEqual(releaseCalls, []);
  assert.equal(speaker.readyState, WebSocket.OPEN);

  // Same host reconnects with the same session settings: reattach, no new pipeline.
  const reconnected = await connectHost(port);
  context.after(() => reconnected.terminate());
  assert.equal(pipelines.length, 1, "reattach must not build a fresh pipeline");
  assert.equal(pipelines[0].closed, 0);
  assert.deepEqual(releaseCalls, [], "the speaking floor survives the reconnect");
  const graceTimer = timers.find((timer) => timer.delay === 45_000);
  assert.equal(graceTimer.cancelled, true, "reattach cancels the grace expiry");

  // The floor holder still owns the audio path into the same pipeline.
  speaker.send(Buffer.alloc(INPUT_FRAME_BYTES));
  await waitFor(() => pipelines[0].frames.length === 1);

  const ended = nextJson(reconnected);
  reconnected.send(JSON.stringify({ type: "audioStreamEnd" }));
  assert.equal((await ended).type, "audio-stream-ended");
});

test("grace expiry performs the full teardown including floor release", async (context) => {
  const releaseCalls = [];
  const { gateway, pipelines, timers } = createLiveGateway({
    gatewayOptions: {
      hostReconnectGraceMilliseconds: 45_000,
      floorController: {
        async take() { return { ok: true, displayName: "김노엘", participantId: "participant-1" }; },
        async release(...args) { releaseCalls.push(args); return true; },
      },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const host = await connectHost(port);
  const speaker = await joinViewer(port, "grant-speaker");
  context.after(() => speaker.terminate());
  const nextSpeakerMessage = bufferJson(speaker);
  speaker.send(JSON.stringify({ type: "speak-start" }));
  await nextSpeakerMessage((message) => message.type === "speak-started");

  const floorCleared = nextSpeakerMessage(
    (message) => message.type === "live-event" && message.payload.type === "floor" && message.payload.holder === null,
  );
  host.close();
  await once(host, "close");
  await waitFor(() => timers.some((timer) => timer.delay === 45_000 && !timer.cancelled));
  assert.equal(pipelines[0].closed, 0);

  timers.find((timer) => timer.delay === 45_000 && !timer.cancelled).callback();
  await waitFor(() => pipelines[0].closed === 1);
  assert.deepEqual(releaseCalls, [["session-1", "grant-speaker"]]);
  await floorCleared;

  // A late reconnect after expiry builds a fresh pipeline instead of reattaching.
  const late = await connectHost(port);
  context.after(() => late.terminate());
  assert.equal(pipelines.length, 2);
});

test("a lease revocation still tears the pipeline down immediately, bypassing the grace window", async (context) => {
  let leaseCallback;
  let authorizeCalls = 0;
  const { gateway, pipelines } = createLiveGateway({
    gatewayOptions: {
      hostReconnectGraceMilliseconds: 45_000,
      hostAuthorizer: {
        async authorize(_claims, _settings, options) {
          authorizeCalls += 1;
          return options.compareVersion; // the lease uses compareVersion: false
        },
      },
      setHostLeaseIntervalFn(callback) { leaseCallback = callback; return { lease: true }; },
      clearHostLeaseIntervalFn() {},
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(gateway.server.address().port);
  context.after(() => host.terminate());

  const revoked = nextJson(host);
  leaseCallback();
  assert.equal((await revoked).code, "SESSION_REVOKED");
  await once(host, "close");
  await waitFor(() => pipelines[0].closed === 1);
  assert.ok(authorizeCalls >= 3);
});

test("host pause/resume gates the pipeline and broadcasts session-status to viewers", async (context) => {
  const { gateway, pipelines } = createLiveGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const host = await connectHost(port);
  context.after(() => host.terminate());
  const viewer = await joinViewer(port, "grant-viewer");
  context.after(() => viewer.terminate());

  const pausedStatus = waitForJson(viewer, (message) => message.type === "live-event" && message.payload.type === "session-status");
  const pausedReply = waitForJson(host, (message) => message.type === "paused");
  host.send(JSON.stringify({ type: "pause" }));
  assert.equal((await pausedReply).sessionId, "session-1");
  assert.equal((await pausedStatus).payload.status, "paused");
  assert.equal(pipelines[0].paused, 1);
  assert.equal(pipelines[0].closed, 0, "pause keeps the pipeline");
  assert.equal(viewer.readyState, WebSocket.OPEN, "pause keeps viewer sockets");

  const liveStatus = waitForJson(viewer, (message) => message.type === "live-event" && message.payload.type === "session-status" && message.payload.status === "live");
  const resumedReply = waitForJson(host, (message) => message.type === "resumed");
  host.send(JSON.stringify({ type: "resume" }));
  await resumedReply;
  await liveStatus;
  assert.equal(pipelines[0].resumed, 1);
});

test("the floor broadcast carries participant identity from the directory, cached per participant", async (context) => {
  const lookups = [];
  const { gateway } = createLiveGateway({
    gatewayOptions: {
      floorTakeCooldownMilliseconds: 0,
      floorController: {
        async take() { return { ok: true, displayName: "김노엘", participantId: "participant-1" }; },
        async release() { return true; },
      },
      async fetchFloorParticipant(sessionId, participantId) {
        lookups.push([sessionId, participantId]);
        return { name: "김노엘", department: "전략기획실", jobTitle: "PM" };
      },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const host = await connectHost(port);
  context.after(() => host.terminate());
  const speaker = await joinViewer(port, "grant-speaker");
  context.after(() => speaker.terminate());

  let hostFloor = waitForJson(host, (message) => message.type === "floor" && message.holder !== null);
  speaker.send(JSON.stringify({ type: "speak-start" }));
  assert.deepEqual((await hostFloor).holder, {
    participantId: "participant-1",
    name: "김노엘",
    department: "전략기획실",
    jobTitle: "PM",
  });

  speaker.send(JSON.stringify({ type: "speak-end" }));
  await waitForJson(speaker, (message) => message.type === "speak-ended");
  hostFloor = waitForJson(host, (message) => message.type === "floor" && message.holder !== null);
  speaker.send(JSON.stringify({ type: "speak-start" }));
  await hostFloor;
  assert.deepEqual(lookups, [["session-1", "participant-1"]], "identity lookups are cached per session+participant");

  assert.match(gateway.metrics.render(), /realtime_noel_floor_broadcast_latency_ms_count 2/u);
});

test("truly concurrent speak-starts from two viewers resolve to exactly one holder", async (context) => {
  const takeGates = new Map();
  const { gateway, pipelines } = createLiveGateway({
    gatewayOptions: {
      floorTakeCooldownMilliseconds: 0,
      floorController: {
        async take(_sessionId, grantId) {
          await new Promise((resolve) => takeGates.set(grantId, resolve));
          return { ok: true, displayName: grantId === "grant-a" ? "발표자A" : "발표자B", participantId: grantId };
        },
        async release() { return true; },
      },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const host = await connectHost(port);
  context.after(() => host.terminate());
  const speakerA = await joinViewer(port, "grant-a");
  context.after(() => speakerA.terminate());
  const speakerB = await joinViewer(port, "grant-b");
  context.after(() => speakerB.terminate());
  const nextSpeakerA = bufferJson(speakerA);
  const nextSpeakerB = bufferJson(speakerB);

  // Both speak-starts are in flight at the same time before either resolves.
  speakerA.send(JSON.stringify({ type: "speak-start" }));
  speakerB.send(JSON.stringify({ type: "speak-start" }));
  await waitFor(() => takeGates.size === 2);

  const hostFloors = [];
  host.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.type === "floor") hostFloors.push(message.holder);
  });
  const aStarted = nextSpeakerA((message) => message.type === "speak-started" || message.type === "error");
  takeGates.get("grant-a")();
  assert.equal((await within(aStarted, "speaker A start")).type, "speak-started");
  const aPreempted = nextSpeakerA((message) => message.type === "speak-ended");
  const bStarted = nextSpeakerB((message) => message.type === "speak-started" || message.type === "error");
  takeGates.get("grant-b")();
  assert.equal((await within(bStarted, "speaker B start")).type, "speak-started");
  assert.equal((await within(aPreempted, "speaker A preemption")).reason, "preempted");

  await waitFor(() => hostFloors.length >= 2);
  assert.equal(hostFloors.at(-1).name, "발표자B", "the last resolved take owns the floor");
  assert.deepEqual(
    pipelines[0].floorSpeakers.at(-1),
    { participantId: "grant-b", displayName: "발표자B", department: "", jobTitle: "" },
  );

  // Only the final holder's audio reaches the pipeline.
  speakerA.send(Buffer.alloc(INPUT_FRAME_BYTES));
  speakerB.send(Buffer.alloc(INPUT_FRAME_BYTES));
  await waitFor(() => pipelines[0].frames.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pipelines[0].frames.length, 1);
});

test("host start pushes session-status live to already-subscribed viewers", async (context) => {
  const { gateway } = createLiveGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  // The viewer subscribes while the host is still preparing.
  const viewer = await joinViewer(port, "grant-early");
  context.after(() => viewer.terminate());

  const liveStatus = waitForJson(viewer, (message) => message.type === "live-event"
    && message.payload.type === "session-status"
    && message.payload.status === "live");
  const host = await connectHost(port);
  context.after(() => host.terminate());
  assert.equal((await liveStatus).payload.sessionId ?? "session-1", "session-1");
});
