import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

import { WebSocket } from "ws";

import { AUDIO_CONFIG } from "../src/config.js";
import { createGatewayServer } from "../src/gateway-server.js";

const INPUT_FRAME_BYTES = AUDIO_CONFIG.inputSampleRate * 2 * AUDIO_CONFIG.chunkMilliseconds / 1_000;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function fixtureUuid(seed) {
  const digest = createHmac("sha256", "fixture-uuid").update(seed).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function signToken(secret, claims) {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

function signHostToken() {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  return signToken("gateway-secret", {
    role: "HOST", sub: "host-1", sessionId: SESSION_ID, aud: "media-gateway",
    iat: nowSeconds, exp: nowSeconds + 900,
  });
}

function signViewerToken(grantId) {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const grantUuid = fixtureUuid(grantId);
  return signToken("viewer-secret", {
    role: "VIEWER",
    sub: grantUuid,
    grantId: grantUuid,
    sessionId: SESSION_ID,
    aud: "live-gateway-viewer",
    jti: fixtureUuid(`ticket-${grantId}`),
    iat: nowSeconds,
    exp: nowSeconds + 60,
  });
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

async function createHarness(context, { participantSpeakingEnabled = false, gatewayOptions = {} } = {}) {
  const floorCalls = [];
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: {
      async authorize() { return true; },
      async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); },
      async authorizeSpeaking() {
        return typeof participantSpeakingEnabled === "function"
          ? participantSpeakingEnabled()
          : participantSpeakingEnabled;
      },
    },
    hostAuthorizer: { async authorize() { return true; } },
    floorController: {
      async take(...args) { floorCalls.push(["take", ...args]); return { ok: true }; },
      async release(...args) { floorCalls.push(["release", ...args]); return true; },
    },
    ...gatewayOptions,
    async pipelineFactory() {
      const pipeline = {
        frames: [],
        captures: [],
        floorSpeakers: [],
        async start() {}, async tick() {}, async endAudioStream() {}, async close() {},
        async acceptAudio(frame, capturedAt, floorSpeaker, source) {
          this.frames.push(frame);
          this.captures.push({ capturedAt, floorSpeaker, source });
        },
        setFloorSpeaker(speaker) { this.floorSpeakers.push(speaker); },
      };
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  return { gateway, floorCalls, pipelines, port: gateway.server.address().port };
}

async function startHost(port) {
  const host = new WebSocket(`ws://127.0.0.1:${port}/live`);
  await once(host, "open");
  let reply = nextJson(host);
  host.send(JSON.stringify({ type: "authenticate", token: signHostToken() }));
  assert.equal((await reply).role, "HOST");
  const messages = [];
  const started = new Promise((resolve) => {
    const onMessage = (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.type !== "started" && message.type !== "floor") return;
      messages.push(message);
      if (messages.length === 2) {
        host.off("message", onMessage);
        resolve();
      }
    };
    host.on("message", onMessage);
  });
  host.send(JSON.stringify({
    type: "start", sessionId: SESSION_ID, sessionType: "meeting",
    outputMode: "captions", version: 1, languages: ["ko"],
  }));
  await started;
  return host;
}

async function joinViewer(port, grantId) {
  const viewer = new WebSocket(`ws://127.0.0.1:${port}/live`);
  await once(viewer, "open");
  let reply = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "authenticate", token: signViewerToken(grantId) }));
  assert.equal((await reply).role, "VIEWER");
  reply = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, language: "ko" }));
  assert.equal((await reply).type, "subscribed");
  return viewer;
}

test("VIEWER floor request, release, and preempt messages fail closed without controller access", async (context) => {
  const { floorCalls, port } = await createHarness(context);
  for (const [index, type] of ["speak-start", "speak-end", "host-speak"].entries()) {
    const viewer = await joinViewer(port, `grant-${index}`);
    context.after(() => viewer.terminate());
    const reply = nextJson(viewer);
    viewer.send(JSON.stringify({ type }));
    assert.equal((await reply).code, "VIEWER_CONTROL_FORBIDDEN");
    await once(viewer, "close");
  }
  assert.deepEqual(floorCalls, []);
});

test("VIEWER PCM fails closed while HOST PCM remains the only media ingress", async (context) => {
  const { floorCalls, pipelines, port } = await createHarness(context);
  const host = await startHost(port);
  context.after(() => host.terminate());
  const viewer = await joinViewer(port, "grant-forged-pcm");
  context.after(() => viewer.terminate());

  const reply = nextJson(viewer);
  viewer.send(Buffer.alloc(INPUT_FRAME_BYTES));
  assert.equal((await reply).code, "VIEWER_MEDIA_FORBIDDEN");
  await once(viewer, "close");
  assert.equal(pipelines[0].frames.length, 0);

  host.send(Buffer.alloc(INPUT_FRAME_BYTES));
  for (let attempt = 0; attempt < 100 && pipelines[0].frames.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pipelines[0].frames.length, 1);
  assert.deepEqual(floorCalls, []);
});

test("caption subscribers still receive live events under the subscribe-only policy", async (context) => {
  const { gateway, floorCalls, port } = await createHarness(context);
  const viewer = await joinViewer(port, "grant-caption");
  context.after(() => viewer.terminate());
  const caption = nextJson(viewer);
  await gateway.broadcastEvent(SESSION_ID, "ko", {
    type: "caption", sessionId: SESSION_ID, language: "ko", seq: 1,
    text: "실시간 번역", isFinal: true,
  });
  assert.equal((await caption).payload.text, "실시간 번역");
  assert.deepEqual(floorCalls, []);
});

test("HOST floor reclaim acknowledgement remains available to web and desktop hosts", async (context) => {
  const { floorCalls, port } = await createHarness(context);
  const host = await startHost(port);
  context.after(() => host.terminate());
  const reply = nextJson(host);
  host.send(JSON.stringify({ type: "host-speak" }));
  assert.deepEqual(await reply, { type: "host-speak-started", sessionId: SESSION_ID });
  assert.deepEqual(floorCalls, []);
});

test("enabled participant speaking takes one floor, routes only its PCM, and releases back to host", async (context) => {
  const { floorCalls, pipelines, port } = await createHarness(context, { participantSpeakingEnabled: true });
  const host = await startHost(port);
  context.after(() => host.terminate());
  const speaker = await joinViewer(port, "grant-speaker");
  context.after(() => speaker.terminate());

  speaker.send(JSON.stringify({ type: "speak-start" }));
  const started = await waitForJson(speaker, (message) => message.type === "speak-started");
  assert.equal(started.audio.sampleRate, AUDIO_CONFIG.inputSampleRate);
  assert.deepEqual(floorCalls[0].slice(0, 3), ["take", SESSION_ID, fixtureUuid("grant-speaker")]);

  speaker.send(Buffer.alloc(INPUT_FRAME_BYTES));
  host.send(Buffer.alloc(INPUT_FRAME_BYTES));
  for (let attempt = 0; attempt < 100 && pipelines[0].frames.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pipelines[0].frames.length, 1, "host PCM is gated while the participant owns the floor");
  assert.equal(pipelines[0].captures[0].source, "participant");
  assert.equal(pipelines[0].captures[0].floorSpeaker.participantId, fixtureUuid("grant-speaker"));

  speaker.send(JSON.stringify({ type: "speak-end" }));
  assert.equal((await waitForJson(speaker, (message) => message.type === "speak-ended")).reason, "ended");
  assert.deepEqual(floorCalls[1].slice(0, 3), ["release", SESSION_ID, fixtureUuid("grant-speaker")]);
  host.send(Buffer.alloc(INPUT_FRAME_BYTES));
  for (let attempt = 0; attempt < 100 && pipelines[0].frames.length < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pipelines[0].captures[1].floorSpeaker, null);
});

test("enabled participant speaking preempts the prior holder and stray PCM stays receive-only", async (context) => {
  const { pipelines, port } = await createHarness(context, { participantSpeakingEnabled: true });
  const host = await startHost(port);
  context.after(() => host.terminate());
  const first = await joinViewer(port, "grant-first");
  const second = await joinViewer(port, "grant-second");
  context.after(() => first.terminate());
  context.after(() => second.terminate());

  first.send(JSON.stringify({ type: "speak-start" }));
  await waitForJson(first, (message) => message.type === "speak-started");
  const preempted = waitForJson(first, (message) => message.type === "speak-ended");
  second.send(JSON.stringify({ type: "speak-start" }));
  await waitForJson(second, (message) => message.type === "speak-started");
  assert.equal((await preempted).reason, "preempted");

  first.send(Buffer.alloc(INPUT_FRAME_BYTES));
  second.send(Buffer.alloc(INPUT_FRAME_BYTES));
  for (let attempt = 0; attempt < 100 && pipelines[0].frames.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(first.readyState, WebSocket.OPEN);
  assert.equal(pipelines[0].frames.length, 1);
  assert.equal(pipelines[0].captures[0].floorSpeaker.participantId, fixtureUuid("grant-second"));
});

test("periodic grant audit revokes an active floor when participant speaking is disabled", async (context) => {
  const capability = { enabled: true };
  const { pipelines, port } = await createHarness(context, {
    participantSpeakingEnabled: () => capability.enabled,
    gatewayOptions: {
      viewerAuthorizationLeaseMilliseconds: 50,
      viewerAuthorizationJitterMilliseconds: 0,
      viewerAuthorizationBatchWindowMilliseconds: 0,
    },
  });
  const host = await startHost(port);
  context.after(() => host.terminate());
  const speaker = await joinViewer(port, "grant-revoked");
  context.after(() => speaker.terminate());
  speaker.send(JSON.stringify({ type: "speak-start" }));
  await waitForJson(speaker, (message) => message.type === "speak-started");

  capability.enabled = false;
  const ended = await waitForJson(speaker, (message) => message.type === "speak-ended");
  assert.equal(ended.reason, "disabled");

  host.send(Buffer.alloc(INPUT_FRAME_BYTES));
  for (let attempt = 0; attempt < 100 && pipelines[0].frames.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pipelines[0].captures[0].source, null, "revocation reopens host PCM immediately");
  assert.equal(pipelines[0].floorSpeakers.at(-1), null);
});

test("periodic speaking re-auth is leased per session instead of per viewer", async (context) => {
  let speakingChecks = 0;
  const reauthorizeCallbacks = [];
  const { port } = await createHarness(context, {
    participantSpeakingEnabled: () => {
      speakingChecks += 1;
      return true;
    },
    gatewayOptions: {
      setReauthorizeIntervalFn: (callback) => {
        reauthorizeCallbacks.push(callback);
        return { fake: true };
      },
      clearReauthorizeIntervalFn: () => {},
    },
  });
  const host = await startHost(port);
  context.after(() => host.terminate());

  const viewerA = await joinViewer(port, "11111111-1111-4111-8111-0000000000a1");
  const viewerB = await joinViewer(port, "11111111-1111-4111-8111-0000000000b2");
  context.after(() => viewerA.terminate());
  context.after(() => viewerB.terminate());

  // Both viewers arm the speaking capability (direct, non-leased checks).
  for (const viewer of [viewerA, viewerB]) {
    const reply = nextJson(viewer);
    viewer.send(JSON.stringify({ type: "speak-start" }));
    await reply;
  }
  // Subscribe-time capability checks resolve asynchronously; settle before
  // snapshotting so the periodic delta below counts only leased rechecks.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const checksAfterSpeakStart = speakingChecks;
  assert.ok(checksAfterSpeakStart >= 2, "speak-start stays a direct, fresh check");

  // Fire every viewer's periodic re-auth within one lease window: the
  // session-level speaking answer must be fetched once, not once per viewer.
  await Promise.all(reauthorizeCallbacks.map((callback) => callback()));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    speakingChecks - checksAfterSpeakStart,
    1,
    "one leased speaking check should serve every viewer in the window",
  );
});
