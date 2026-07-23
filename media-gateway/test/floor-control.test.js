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

function createFloorGateway({ floorController, pipelineHooks = {} } = {}) {
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    floorController,
    async pipelineFactory(settings) {
      const pipeline = {
        settings,
        frames: [],
        floorSpeakers: [],
        async start() {},
        async tick() {},
        async acceptAudio(frame) { this.frames.push(frame); },
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
  assert.deepEqual((await listenerFloor).payload.holder, { displayName: "김노엘" });
  assert.deepEqual((await hostFloor).holder, { displayName: "김노엘" });
  assert.deepEqual(takeCalls, [["session-1", "grant-speaker"]]);
  assert.deepEqual(pipelines[0].floorSpeakers, [{ grantId: "grant-speaker", displayName: "김노엘" }]);

  // Floor holder audio flows into the pipeline; host audio is dropped meanwhile.
  speaker.send(Buffer.alloc(INPUT_FRAME_BYTES));
  host.send(Buffer.alloc(INPUT_FRAME_BYTES));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(pipelines[0].frames.length, 1);

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
