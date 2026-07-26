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

function createFloorGateway({ floorController, pipelineHooks = {}, gatewayOptions = {} } = {}) {
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    floorController,
    ...gatewayOptions,
    async pipelineFactory(settings) {
      const pipeline = {
        settings,
        frames: [],
        captures: [],
        floorSpeakers: [],
        async start() {},
        async tick() {},
        async acceptAudio(frame, capturedAt, floorSpeaker, source) {
          this.frames.push(frame);
          this.captures.push({ capturedAt, floorSpeaker, source });
        },
        setFloorSpeaker(speaker) { this.floorSpeakers.push(speaker); },
        async endAudioStream() {},
        async close() {},
        ...pipelineHooks,
      };
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  return { gateway, pipelines };
}

async function startHost(port) {
  const host = new WebSocket(`ws://127.0.0.1:${port}/live`);
  await once(host, "open");
  let received = nextJson(host);
  host.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(host);
  host.send(JSON.stringify({
    type: "start",
    sessionId: "session-1",
    sessionType: "meeting",
    outputMode: "captions_audio",
    version: 1,
    languages: ["ko", "en"],
  }));
  assert.equal((await received).type, "started");
  return host;
}

async function joinViewer(port, grantId, language = "ko") {
  const viewer = new WebSocket(`ws://127.0.0.1:${port}/live`);
  await once(viewer, "open");
  let received = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "authenticate", token: signViewerToken("viewer-secret", grantId) }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "subscribe", sessionId: "session-1", language }));
  assert.equal((await received).type, "subscribed");
  return viewer;
}

test("speak-start takes the floor, notifies everyone, and routes speaker audio into the pipeline", async (context) => {
  const takeCalls = [];
  const releaseCalls = [];
  const { gateway, pipelines } = createFloorGateway({
    floorController: {
      async take(sessionId, grantId) {
        takeCalls.push([sessionId, grantId]);
        return { ok: true, displayName: "김노엘" };
      },
      async release(sessionId, grantId) {
        releaseCalls.push([sessionId, grantId]);
        return true;
      },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const host = await startHost(port);
  context.after(() => host.terminate());
  const speaker = await joinViewer(port, "grant-speaker");
  context.after(() => speaker.terminate());
  const listener = await joinViewer(port, "grant-listener", "en");
  context.after(() => listener.terminate());

  const speakerStarted = waitForJson(speaker, (message) => message.type === "speak-started");
  const listenerFloor = waitForJson(listener, (message) => message.type === "live-event" && message.payload.type === "floor");
  const hostFloor = waitForJson(host, (message) => message.type === "floor");
  speaker.send(JSON.stringify({ type: "speak-start" }));
  const started = await speakerStarted;
  assert.equal(started.displayName, "김노엘");
  assert.equal(started.audio.sampleRate, AUDIO_CONFIG.inputSampleRate);
  // Contract C5: the floor broadcast carries the holder's identity.
  assert.deepEqual((await listenerFloor).payload.holder, { participantId: "grant-speaker", name: "김노엘", department: "", jobTitle: "" });
  assert.deepEqual((await hostFloor).holder, { participantId: "grant-speaker", name: "김노엘", department: "", jobTitle: "" });
  assert.deepEqual(takeCalls, [["session-1", "grant-speaker"]]);
  assert.deepEqual(pipelines[0].floorSpeakers, [{ participantId: "grant-speaker", displayName: "김노엘", department: "", jobTitle: "" }]);

  // Floor holder audio flows into the pipeline; host audio is dropped meanwhile.
  speaker.send(Buffer.alloc(INPUT_FRAME_BYTES));
  host.send(Buffer.alloc(INPUT_FRAME_BYTES));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(pipelines[0].frames.length, 1);
  assert.equal(pipelines[0].captures[0].floorSpeaker.participantId, "grant-speaker");
  assert.equal(pipelines[0].captures[0].source, "participant");

  // Explicit speak-end releases the floor and broadcasts a null holder.
  const speakerEnded = waitForJson(speaker, (message) => message.type === "speak-ended");
  const listenerCleared = waitForJson(listener, (message) => message.type === "live-event" && message.payload.type === "floor" && message.payload.holder === null);
  speaker.send(JSON.stringify({ type: "speak-end" }));
  assert.equal((await speakerEnded).reason, "ended");
  await listenerCleared;
  assert.deepEqual(releaseCalls, [["session-1", "grant-speaker"]]);
  assert.deepEqual(pipelines[0].floorSpeakers.at(-1), null);

  // After release, host audio flows again.
  host.send(Buffer.alloc(INPUT_FRAME_BYTES));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(pipelines[0].frames.length, 2);
  assert.equal(pipelines[0].captures[1].floorSpeaker, null);
  assert.equal(pipelines[0].captures[1].source, null);
});

test("a second speaker preempts the current one and non-holders may not send audio", async (context) => {
  const { gateway } = createFloorGateway({
    floorController: {
      async take(sessionId, grantId) {
        return { ok: true, displayName: grantId === "grant-a" ? "발표자A" : "발표자B" };
      },
      async release() { return true; },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const host = await startHost(port);
  context.after(() => host.terminate());
  const speakerA = await joinViewer(port, "grant-a");
  context.after(() => speakerA.terminate());
  const speakerB = await joinViewer(port, "grant-b");
  context.after(() => speakerB.terminate());

  speakerA.send(JSON.stringify({ type: "speak-start" }));
  await waitForJson(speakerA, (message) => message.type === "speak-started");

  const preempted = waitForJson(speakerA, (message) => message.type === "speak-ended");
  speakerB.send(JSON.stringify({ type: "speak-start" }));
  await waitForJson(speakerB, (message) => message.type === "speak-started");
  assert.equal((await preempted).reason, "preempted");

  // speakerA lost the floor: stray frames are dropped without killing the
  // connection (they race the speak-ended notification).
  speakerA.send(Buffer.alloc(INPUT_FRAME_BYTES));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(speakerA.readyState, WebSocket.OPEN);
});

test("delayed floor identity cannot race a second take or host preemption into split ownership", async (context) => {
  let releaseFirstProfile;
  const firstProfileGate = new Promise((resolve) => { releaseFirstProfile = resolve; });
  const takeCalls = [];
  const releaseCalls = [];
  const { gateway, pipelines } = createFloorGateway({
    gatewayOptions: {
      floorTakeCooldownMilliseconds: 0,
      async fetchFloorParticipant(_sessionId, participantId) {
        if (participantId === "grant-a") await firstProfileGate;
        return { department: participantId };
      },
    },
    floorController: {
      async take(_sessionId, grantId) {
        takeCalls.push(grantId);
        return { ok: true, participantId: grantId, displayName: grantId };
      },
      async release(_sessionId, grantId) { releaseCalls.push(grantId); return true; },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const host = await startHost(port);
  const speakerA = await joinViewer(port, "grant-a");
  const speakerB = await joinViewer(port, "grant-b");
  context.after(() => host.terminate());
  context.after(() => speakerA.terminate());
  context.after(() => speakerB.terminate());

  speakerA.send(JSON.stringify({ type: "speak-start" }));
  while (takeCalls.length < 1) await new Promise((resolve) => setImmediate(resolve));
  speakerB.send(JSON.stringify({ type: "speak-start" }));
  host.send(JSON.stringify({ type: "host-speak" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(takeCalls, ["grant-a"], "the second take must wait for the first identity lookup");

  const aMessages = [];
  const bMessages = [];
  const hostMessages = [];
  speakerA.on("message", (data) => aMessages.push(JSON.parse(data.toString("utf8"))));
  speakerB.on("message", (data) => bMessages.push(JSON.parse(data.toString("utf8"))));
  host.on("message", (data) => hostMessages.push(JSON.parse(data.toString("utf8"))));
  releaseFirstProfile();
  for (let attempt = 0; attempt < 100
    && (!aMessages.some((message) => message.type === "speak-started")
      || !bMessages.some((message) => message.type === "speak-started")
      || !hostMessages.some((message) => message.type === "host-speak-started")); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(aMessages.some((message) => message.type === "speak-started"), true);
  assert.equal(bMessages.some((message) => message.type === "speak-started"), true);
  assert.equal(hostMessages.some((message) => message.type === "host-speak-started"), true);
  assert.deepEqual(takeCalls, ["grant-a", "grant-b"]);
  assert.deepEqual(releaseCalls, ["grant-b"], "host preemption releases the actual final DB holder");
  assert.equal(pipelines[0].floorSpeakers.at(-1), null, "gateway and DB finish with the host owning audio");
});

test("translation restart preserves the active speaker and live call identity", async (context) => {
  const releaseCalls = [];
  const { gateway, pipelines } = createFloorGateway({
    floorController: {
      async take() { return { ok: true, displayName: "Noel Kim" }; },
      async release(sessionId, grantId) {
        releaseCalls.push([sessionId, grantId]);
        return true;
      },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const host = await startHost(port);
  context.after(() => host.terminate());
  const speaker = await joinViewer(port, "grant-speaker");
  context.after(() => speaker.terminate());

  speaker.send(JSON.stringify({ type: "speak-start" }));
  await waitForJson(speaker, (message) => message.type === "speak-started");

  const restarted = waitForJson(host, (message) => message.type === "restarted");
  host.send(JSON.stringify({
    type: "restart",
    sessionId: "session-1",
    sessionType: "meeting",
    outputMode: "captions_audio",
    version: 1,
    languages: ["ko", "en"],
  }));
  assert.equal((await restarted).type, "restarted");
  assert.equal(pipelines.length, 2);
  assert.deepEqual(pipelines[1].floorSpeakers, [{ participantId: "grant-speaker", displayName: "Noel Kim", department: "", jobTitle: "" }]);
  assert.deepEqual(releaseCalls, []);

  speaker.send(Buffer.alloc(INPUT_FRAME_BYTES));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pipelines[1].frames.length, 1);
});

test("disconnecting floor holder releases the floor and a denied take does not disturb viewing", async (context) => {
  const releaseCalls = [];
  let allowTake = true;
  const { gateway, pipelines } = createFloorGateway({
    floorController: {
      async take() {
        if (!allowTake) return { ok: false, code: "SESSION_NOT_LIVE" };
        return { ok: true, displayName: "발표자" };
      },
      async release(sessionId, grantId) {
        releaseCalls.push([sessionId, grantId]);
        return true;
      },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const host = await startHost(port);
  context.after(() => host.terminate());
  const speaker = await joinViewer(port, "grant-speaker");
  const listener = await joinViewer(port, "grant-listener");
  context.after(() => listener.terminate());

  speaker.send(JSON.stringify({ type: "speak-start" }));
  await waitForJson(speaker, (message) => message.type === "speak-started");

  const cleared = waitForJson(listener, (message) => message.type === "live-event" && message.payload.type === "floor" && message.payload.holder === null);
  speaker.terminate();
  await cleared;
  assert.deepEqual(releaseCalls, [["session-1", "grant-speaker"]]);
  assert.deepEqual(pipelines[0].floorSpeakers.at(-1), null);

  // Denied take: the viewer stays connected and subscribed.
  allowTake = false;
  const denied = waitForJson(listener, (message) => message.type === "error" && message.code === "SESSION_NOT_LIVE");
  listener.send(JSON.stringify({ type: "speak-start" }));
  await denied;
  assert.equal(listener.readyState, WebSocket.OPEN);
});

test("one grant cannot repeatedly preempt a live speaker inside the cooldown", async (context) => {
  let timestamp = Date.now();
  let takeCount = 0;
  const { gateway } = createFloorGateway({
    gatewayOptions: {
      now: () => timestamp,
      floorTakeCooldownMilliseconds: 2_000,
    },
    floorController: {
      async take(sessionId, grantId) {
        takeCount += 1;
        return { ok: true, displayName: grantId };
      },
      async release() { return true; },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const host = await startHost(port);
  context.after(() => host.terminate());
  const first = await joinViewer(port, "grant-one");
  context.after(() => first.terminate());
  const nextFirstMessage = bufferJson(first);
  const second = await joinViewer(port, "grant-two");
  context.after(() => second.terminate());
  const nextSecondMessage = bufferJson(second);

  first.send(JSON.stringify({ type: "speak-start" }));
  await nextFirstMessage((message) => message.type === "speak-started");

  // grant-two grabs the floor from a live speaker.
  timestamp += 100;
  second.send(JSON.stringify({ type: "speak-start" }));
  await nextSecondMessage((message) => message.type === "speak-started");
  assert.equal((await nextFirstMessage((message) => message.type === "speak-ended")).reason, "preempted");

  // grant-one tries to grab it straight back while grant-two is still live.
  // Preemption stays rate limited so the floor cannot be volleyed.
  timestamp += 100;
  first.send(JSON.stringify({ type: "speak-start" }));
  const limited = await nextFirstMessage((message) => (
    message.type === "speak-started" || typeof message.code === "string"
  ));
  assert.equal(limited.code, "FLOOR_RATE_LIMITED");
  assert.equal(limited.message, "발언 요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.");
  assert.equal(takeCount, 2);
  assert.equal(first.readyState, WebSocket.OPEN);

  timestamp += 2_000;
  first.send(JSON.stringify({ type: "speak-start" }));
  await nextFirstMessage((message) => message.type === "speak-started");
  assert.equal(takeCount, 3);
});

test("a speaker the host preempted may retake the free floor without waiting out the preemption cooldown", async (context) => {
  let timestamp = Date.now();
  let takeCount = 0;
  const { gateway } = createFloorGateway({
    gatewayOptions: {
      now: () => timestamp,
      floorTakeCooldownMilliseconds: 2_000,
      floorResumeCooldownMilliseconds: 250,
    },
    floorController: {
      async take() {
        takeCount += 1;
        return { ok: true, displayName: "발표자" };
      },
      async release() { return true; },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const host = await startHost(port);
  context.after(() => host.terminate());
  const nextHostMessage = bufferJson(host);
  const speaker = await joinViewer(port, "grant-speaker");
  context.after(() => speaker.terminate());
  const nextSpeakerMessage = bufferJson(speaker);

  speaker.send(JSON.stringify({ type: "speak-start" }));
  await nextSpeakerMessage((message) => message.type === "speak-started");

  // The host takes over mid-sentence, which frees the floor entirely.
  host.send(JSON.stringify({ type: "host-speak" }));
  await nextHostMessage((message) => message.type === "host-speak-started");
  assert.equal((await nextSpeakerMessage((message) => message.type === "speak-ended")).reason, "host-preempt");

  // The participant answers back well inside the 2s preemption window. The
  // floor is unowned, so taking it preempts nobody and must not be refused.
  timestamp += 300;
  speaker.send(JSON.stringify({ type: "speak-start" }));
  const outcome = await nextSpeakerMessage((message) => (
    message.type === "speak-started" || typeof message.code === "string"
  ));
  assert.equal(outcome.code, undefined, `retaking a free floor was refused: ${outcome.code}`);
  assert.equal(outcome.type, "speak-started");
  assert.equal(takeCount, 2);
});

test("zeroing the floor take cooldown disables the resume cooldown with it", async (context) => {
  let takeCount = 0;
  const { gateway } = createFloorGateway({
    // The single knob callers already use to mean "no floor rate limiting".
    gatewayOptions: { floorTakeCooldownMilliseconds: 0 },
    floorController: {
      async take() {
        takeCount += 1;
        return { ok: true, displayName: "발표자" };
      },
      async release() { return true; },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const host = await startHost(port);
  context.after(() => host.terminate());
  const speaker = await joinViewer(port, "grant-speaker");
  context.after(() => speaker.terminate());
  const nextSpeakerMessage = bufferJson(speaker);

  speaker.send(JSON.stringify({ type: "speak-start" }));
  await nextSpeakerMessage((message) => message.type === "speak-started");
  speaker.send(JSON.stringify({ type: "speak-end" }));
  await nextSpeakerMessage((message) => message.type === "speak-ended");

  // Back-to-back on the real clock, far inside the 250ms default.
  speaker.send(JSON.stringify({ type: "speak-start" }));
  const outcome = await nextSpeakerMessage((message) => (
    message.type === "speak-started" || typeof message.code === "string"
  ));
  assert.equal(outcome.code, undefined, `retake was refused: ${outcome.code}`);
  assert.equal(takeCount, 2);
});

test("retaking a free floor still collapses spam inside the resume cooldown", async (context) => {
  let timestamp = Date.now();
  let takeCount = 0;
  const { gateway } = createFloorGateway({
    gatewayOptions: {
      now: () => timestamp,
      floorTakeCooldownMilliseconds: 2_000,
      floorResumeCooldownMilliseconds: 250,
    },
    floorController: {
      async take() {
        takeCount += 1;
        return { ok: true, displayName: "발표자" };
      },
      async release() { return true; },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const host = await startHost(port);
  context.after(() => host.terminate());
  const speaker = await joinViewer(port, "grant-speaker");
  context.after(() => speaker.terminate());

  speaker.send(JSON.stringify({ type: "speak-start" }));
  await waitForJson(speaker, (message) => message.type === "speak-started");
  speaker.send(JSON.stringify({ type: "speak-end" }));
  await waitForJson(speaker, (message) => message.type === "speak-ended");

  // Hammering Speak must not amplify into floorController.take writes.
  timestamp += 100;
  speaker.send(JSON.stringify({ type: "speak-start" }));
  const spam = await waitForJson(speaker, (message) => (
    message.type === "speak-started" || typeof message.code === "string"
  ));
  assert.equal(spam.code, "FLOOR_RATE_LIMITED");
  assert.equal(takeCount, 1);
  assert.equal(speaker.readyState, WebSocket.OPEN);
});

test("repeating speak-start while already holding the floor is an idempotent acknowledgement", async (context) => {
  let takeCount = 0;
  const releaseCalls = [];
  const { gateway, pipelines } = createFloorGateway({
    gatewayOptions: { floorTakeCooldownMilliseconds: 60_000 },
    floorController: {
      async take() {
        takeCount += 1;
        return { ok: true, displayName: "지속 발표자" };
      },
      async release(sessionId, grantId) {
        releaseCalls.push([sessionId, grantId]);
        return true;
      },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const host = await startHost(port);
  context.after(() => host.terminate());
  const speaker = await joinViewer(port, "grant-speaker");
  context.after(() => speaker.terminate());

  speaker.send(JSON.stringify({ type: "speak-start" }));
  await waitForJson(speaker, (message) => message.type === "speak-started");
  speaker.send(JSON.stringify({ type: "speak-start" }));
  const repeated = await waitForJson(speaker, (message) => message.type === "speak-started" || message.type === "error");

  assert.equal(repeated.type, "speak-started");
  assert.equal(repeated.displayName, "지속 발표자");
  assert.equal(takeCount, 1, "an active holder must not take or preempt its own floor again");
  assert.deepEqual(releaseCalls, []);
  assert.notDeepEqual(pipelines[0].floorSpeakers.at(-1), null);

  speaker.send(Buffer.alloc(INPUT_FRAME_BYTES));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pipelines[0].frames.length, 1, "the existing floor remains usable after the repeated request");
});

// waitForJson re-attaches `once` between messages, so back-to-back frames on
// one socket (floor:null immediately followed by the host-speak ack) can land
// in the re-attach gap and vanish. This buffers every frame instead.
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

test("host-speak reclaims the floor from a participant so host audio flows again", async (context) => {
  const releaseCalls = [];
  const { gateway, pipelines } = createFloorGateway({
    floorController: {
      async take() { return { ok: true, displayName: "김노엘" }; },
      async release(sessionId, grantId) {
        releaseCalls.push([sessionId, grantId]);
        return true;
      },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const host = await startHost(port);
  context.after(() => host.terminate());
  const nextHostMessage = bufferJson(host);
  const speaker = await joinViewer(port, "grant-speaker");
  context.after(() => speaker.terminate());
  const nextSpeakerMessage = bufferJson(speaker);

  speaker.send(JSON.stringify({ type: "speak-start" }));
  await nextSpeakerMessage((message) => message.type === "speak-started");

  // Host takes the floor back: participant gets speak-ended(host-preempt),
  // floor broadcast clears, and host audio reaches the pipeline again.
  host.send(JSON.stringify({ type: "host-speak" }));
  assert.equal((await nextSpeakerMessage((message) => message.type === "speak-ended")).reason, "host-preempt");
  assert.equal((await nextHostMessage((message) => message.type === "host-speak-started")).sessionId, "session-1");
  assert.deepEqual(releaseCalls, [["session-1", "grant-speaker"]]);
  assert.deepEqual(pipelines[0].floorSpeakers.at(-1), null);

  host.send(Buffer.alloc(INPUT_FRAME_BYTES));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(pipelines[0].frames.length, 1);

  // With no holder, host-speak is an idempotent ack.
  host.send(JSON.stringify({ type: "host-speak" }));
  assert.equal((await nextHostMessage((message) => message.type === "host-speak-started")).sessionId, "session-1");
});

// A holder whose client dies without sending speak-end used to stall the WHOLE
// meeting: host audio is dropped outright while any participant holds the floor,
// so once the holder's frames stopped, nothing reached the pipeline at all and
// captions froze with no automatic recovery. Only another Speak press, the host
// reclaiming, or the dead socket finally closing could unstick it.
test("a silent floor holder is released so host audio resumes without ending the session", async (context) => {
  const releaseCalls = [];
  // Tokens are signed with the real clock, so the injected clock must start
  // there or verifyLiveToken rejects them outright.
  let clock = Date.now();
  const { gateway, pipelines } = createFloorGateway({
    floorController: {
      async take() { return { ok: true, displayName: "김노엘" }; },
      async release(sessionId, grantId) { releaseCalls.push(grantId); return true; },
    },
    gatewayOptions: { now: () => clock, floorIdleReleaseMilliseconds: 8_000 },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const host = await startHost(port);
  context.after(() => host.terminate());
  const speaker = await joinViewer(port, "grant-idle");
  context.after(() => speaker.terminate());

  const frame = Buffer.alloc(AUDIO_CONFIG.inputSampleRate * 2 * AUDIO_CONFIG.chunkMilliseconds / 1_000);
  const until = async (condition) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("condition never became true");
  };
  host.send(frame);
  await until(() => pipelines[0].frames.length === 1);

  // Participant takes the floor: host audio is now deliberately discarded.
  speaker.send(JSON.stringify({ type: "speak-start" }));
  await waitForJson(speaker, (message) => message.type === "speak-started");
  const speakerEnded = waitForJson(speaker, (message) => message.type === "speak-ended");
  host.send(frame);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(pipelines[0].frames.length, 1, "host audio must be gated while a participant holds the floor");

  // The holder goes silent — its client is gone, but it never sent speak-end.
  clock += 9_000;
  const ended = await speakerEnded;
  assert.equal(ended.reason, "idle", "the holder must be told its turn ended so its UI resets");
  assert.deepEqual(releaseCalls, ["grant-idle"]);

  // The meeting recovers on its own: host audio flows again.
  host.send(frame);
  await until(() => pipelines[0].frames.length === 2);
  assert.match(gateway.metrics.render(), /floor_idle_releases_total/u);

  // And the session itself is untouched — no close, no teardown.
  assert.equal(pipelines.length, 1);
  assert.equal(host.readyState, WebSocket.OPEN);
  assert.equal(speaker.readyState, WebSocket.OPEN);
});
