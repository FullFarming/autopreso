import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

import { WebSocket } from "ws";

import { createGatewayServer, decodeHostAudioFrame } from "../src/gateway-server.js";

const SECURITY_POLICY = Object.freeze({
  allowedOrigins: new Set(["https://portal.example.com"]),
  allowTrustedNonBrowser: false,
  allowLoopbackWithoutOrigin: false,
  metricsToken: "metrics-token-that-is-at-least-32-chars",
});

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const VIEWER_ID = "11111111-1111-4111-8111-111111111111";
const GRANT_ID = "22222222-2222-4222-8222-222222222222";

function signHostToken(secret, now = Date.now(), sessionId = SESSION_ID) {
  const seconds = Math.floor(now / 1_000);
  const claims = { role: "HOST", sub: "host-1", sessionId, aud: "media-gateway", iat: seconds, exp: seconds + 900 };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

function signViewerToken(secret, now = Date.now(), jti = "44444444-4444-4444-8444-444444444444") {
  const nowSeconds = Math.floor(now / 1_000);
  const claims = {
    role: "VIEWER", sub: VIEWER_ID, grantId: GRANT_ID, sessionId: SESSION_ID,
    aud: "live-gateway-viewer", jti, iat: nowSeconds, exp: nowSeconds + 60,
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

function createTestGateway(options = {}) {
  const acceptedFrames = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    securityPolicy: SECURITY_POLICY,
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() {
      return {
        async start() {}, async tick() {}, async endAudioStream() {}, async close() {},
        async acceptAudio(frame, capturedAt, floorSpeaker, source) { acceptedFrames.push({ frame, capturedAt, floorSpeaker, source }); },
      };
    },
    ...options,
  });
  return { gateway, acceptedFrames };
}

async function startGatewayHost(gateway, now = Date.now()) {
  const address = gateway.server.address();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/live`, { origin: "https://portal.example.com" });
  await once(socket, "open");
  let reply = once(socket, "message");
  socket.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret", now) }));
  assert.equal(JSON.parse((await reply)[0].toString()).type, "authenticated");
  const startResponses = new Promise((resolve, reject) => {
    const responses = [];
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "error") {
        socket.off("message", onMessage);
        reject(new Error(`gateway start failed: ${message.code}`));
        return;
      }
      if (message.type !== "started" && message.type !== "floor") return;
      responses.push(message);
      if (responses.length === 2) {
        socket.off("message", onMessage);
        resolve(responses);
      }
    };
    socket.on("message", onMessage);
  });
  socket.send(JSON.stringify({
    type: "start", sessionId: SESSION_ID, sessionType: "meeting", outputMode: "captions",
    maxViewers: 1, glossaryPack: "general_cre", version: 1, languages: ["ko"],
  }));
  const responses = await startResponses;
  assert.deepEqual(responses.map((message) => message.type).sort(), ["floor", "started"]);
  return socket;
}

async function expectUpgradeRejected(gateway, origin) {
  const options = origin === undefined ? {} : { origin };
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.server.address().port}/live`, options);
  socket.on("error", () => undefined);
  await new Promise((resolve, reject) => {
    socket.once("open", () => {
      socket.terminate();
      reject(new Error(`upgrade unexpectedly accepted Origin: ${origin ?? "<missing>"}`));
    });
    socket.once("unexpected-response", (_request, response) => {
      try {
        assert.equal(response.statusCode, 403);
        response.destroy();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function connectAndAuthenticate(gateway, token, options = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.server.address().port}/live`, options);
  await once(socket, "open");
  const reply = once(socket, "message");
  socket.send(JSON.stringify({ type: "authenticate", token }));
  return { socket, authenticated: JSON.parse((await reply)[0].toString()) };
}

const START_MESSAGE = Object.freeze({
  type: "start", sessionId: SESSION_ID, sessionType: "meeting", outputMode: "captions",
  maxViewers: 1, glossaryPack: "general_cre", version: 1, languages: ["ko"],
});

test("a viewer WebSocket ticket is accepted exactly once across concurrent sockets", async (context) => {
  const { gateway } = createTestGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const url = `ws://127.0.0.1:${gateway.server.address().port}/live`;
  const first = new WebSocket(url, { origin: "https://portal.example.com" });
  const second = new WebSocket(url, { origin: "https://portal.example.com" });
  context.after(() => first.terminate());
  context.after(() => second.terminate());
  await Promise.all([once(first, "open"), once(second, "open")]);
  const firstReply = once(first, "message");
  const secondReply = once(second, "message");
  const token = signViewerToken("viewer-secret");

  first.send(JSON.stringify({ type: "authenticate", token }));
  second.send(JSON.stringify({ type: "authenticate", token }));

  const replies = await Promise.all([firstReply, secondReply]);
  const messages = replies.map(([data]) => JSON.parse(data.toString())).sort((left, right) => left.type.localeCompare(right.type));
  assert.deepEqual(messages.map(({ type }) => type), ["authenticated", "error"]);
  assert.equal(messages.find(({ type }) => type === "error").code, "UNAUTHORIZED");
});

test("a viewer authenticated before ticket expiry stays connected under database grant reauthorization", async (context) => {
  let clock = Date.UTC(2026, 7, 22);
  const { gateway } = createTestGateway({ now: () => clock });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { socket, authenticated } = await connectAndAuthenticate(
    gateway,
    signViewerToken("viewer-secret", clock, "55555555-5555-4555-8555-555555555555"),
    { origin: "https://portal.example.com" },
  );
  context.after(() => socket.terminate());
  assert.equal(authenticated.role, "VIEWER");

  clock += 61_000;
  const reply = once(socket, "message");
  socket.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, language: "ko" }));
  assert.equal(JSON.parse((await reply)[0].toString()).type, "subscribed");
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("an exact web Origin and valid HOST token can start the owned session", async (context) => {
  const { gateway } = createTestGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const socket = await startGatewayHost(gateway);
  context.after(() => socket.terminate());
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("browser upgrades reject missing, disallowed, suffix, trailing-slash, and port-mismatched Origins", async (context) => {
  const { gateway } = createTestGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());

  for (const origin of [
    undefined,
    "https://other.example.com",
    "https://portal.example.com.evil.test",
    "https://portal.example.com/",
    "https://portal.example.com:444",
  ]) {
    await expectUpgradeRejected(gateway, origin);
  }
});

test("a browser VIEWER token cannot start a host session", async (context) => {
  const { gateway } = createTestGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { socket, authenticated } = await connectAndAuthenticate(
    gateway,
    signViewerToken("viewer-secret"),
    { origin: "https://portal.example.com" },
  );
  context.after(() => socket.terminate());
  assert.equal(authenticated.role, "VIEWER");
  const reply = once(socket, "message");
  socket.send(JSON.stringify(START_MESSAGE));
  assert.equal(JSON.parse((await reply)[0].toString()).type, "error");
});

test("a HOST token cannot start a session it does not own", async (context) => {
  const { gateway } = createTestGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { socket, authenticated } = await connectAndAuthenticate(
    gateway,
    signHostToken("gateway-secret", Date.now(), "other-session"),
    { origin: "https://portal.example.com" },
  );
  context.after(() => socket.terminate());
  assert.equal(authenticated.role, "HOST");
  const reply = once(socket, "message");
  socket.send(JSON.stringify(START_MESSAGE));
  assert.equal(JSON.parse((await reply)[0].toString()).code, "INVALID_START");
});

test("host authorization rejects a stale session version before pipeline creation", async (context) => {
  const currentVersion = 2;
  let pipelineCreations = 0;
  const { gateway } = createTestGateway({
    hostAuthorizer: {
      async authorize(_claims, settings, options) {
        return options.compareVersion === true && settings.version === currentVersion;
      },
    },
    async pipelineFactory() {
      pipelineCreations += 1;
      throw new Error("stale versions must not reach pipeline creation");
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { socket } = await connectAndAuthenticate(
    gateway,
    signHostToken("gateway-secret"),
    { origin: "https://portal.example.com" },
  );
  context.after(() => socket.terminate());
  const reply = once(socket, "message");
  socket.send(JSON.stringify(START_MESSAGE));
  assert.equal(JSON.parse((await reply)[0].toString()).code, "SESSION_REVOKED");
  assert.equal(pipelineCreations, 0);
});

test("desktop-main keeps its trusted no-Origin HOST-token path", async (context) => {
  const securityPolicy = Object.freeze({
    ...SECURITY_POLICY,
    allowTrustedNonBrowser: true,
  });
  const { gateway } = createTestGateway({ securityPolicy });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const token = signHostToken("gateway-secret");
  const { socket, authenticated } = await connectAndAuthenticate(gateway, token, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-realtime-noel-client": "desktop-main",
    },
  });
  context.after(() => socket.terminate());
  assert.equal(authenticated.role, "HOST");
  const reply = once(socket, "message");
  socket.send(JSON.stringify(START_MESSAGE));
  assert.equal(JSON.parse((await reply)[0].toString()).type, "started");
});

test("WebSocket upgrade rejects a non-allowlisted Origin before authentication", async (context) => {
  const { gateway } = createTestGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.server.address().port}/live`, { origin: "https://portal.example.com.evil.test" });
  const [, response] = await once(socket, "unexpected-response");
  assert.equal(response.statusCode, 403);
  response.destroy();
});

test("metrics require an exact bearer token while health remains public", async (context) => {
  const { gateway } = createTestGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/metrics`)).status, 404);
  const response = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${SECURITY_POLICY.metricsToken}` } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /^\n$|realtime_noel_/u);
});

test("host input rejects a PCM frame that is not exactly 1280 bytes", async (context) => {
  const { gateway, acceptedFrames } = createTestGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const socket = await startGatewayHost(gateway);
  context.after(() => socket.terminate());
  const reply = once(socket, "message");
  socket.send(Buffer.alloc(1_278));
  assert.equal(JSON.parse((await reply)[0].toString()).code, "INVALID_AUDIO_FRAME");
  assert.equal(acceptedFrames.length, 0);
});

test("source-tagged host frames preserve source while legacy frames remain accepted", () => {
  const pcm = Buffer.alloc(1_280, 7);
  const tagged = Buffer.concat([Buffer.from([0x4e, 0x01, 0x02, 0x00]), pcm]);
  const decoded = decodeHostAudioFrame(tagged);
  assert.equal(decoded.source, "mic");
  assert.deepEqual(Buffer.from(decoded.pcm), pcm);
  assert.equal(decodeHostAudioFrame(pcm).source, null);
});

test("malformed source-tagged host frames fail closed without legacy fallback", () => {
  for (const header of [
    [0x00, 0x01, 0x01, 0x00],
    [0x4e, 0x02, 0x01, 0x00],
    [0x4e, 0x01, 0x03, 0x00],
    [0x4e, 0x01, 0x01, 0x01],
  ]) {
    assert.throws(() => decodeHostAudioFrame(Buffer.concat([Buffer.from(header), Buffer.alloc(1_280)])), /INVALID_AUDIO_FRAME/u);
  }
});

test("tagged host source reaches the pipeline without changing PCM", async (context) => {
  const { gateway, acceptedFrames } = createTestGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const socket = await startGatewayHost(gateway);
  context.after(() => socket.terminate());
  const pcm = Buffer.alloc(1_280, 9);
  socket.send(Buffer.concat([Buffer.from([0x4e, 0x01, 0x01, 0x00]), pcm]));
  for (let attempt = 0; attempt < 10 && acceptedFrames.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(acceptedFrames[0].source, "system");
  assert.deepEqual(Buffer.from(acceptedFrames[0].frame), pcm);
});

test("host audio cannot be submitted faster than the configured real-time burst", async (context) => {
  const { gateway, acceptedFrames } = createTestGateway({ audioBurstMilliseconds: 40 });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const socket = await startGatewayHost(gateway);
  context.after(() => socket.terminate());
  socket.send(Buffer.alloc(1_280));
  const reply = once(socket, "message");
  socket.send(Buffer.alloc(1_280));
  assert.equal(JSON.parse((await reply)[0].toString()).code, "AUDIO_RATE_LIMITED");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acceptedFrames.length, 1);
});

test("per-session byte budget survives the host pipeline and fails closed", async (context) => {
  const { gateway, acceptedFrames } = createTestGateway({ audioBurstMilliseconds: 80, maxSessionAudioBytes: 1_280 });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const socket = await startGatewayHost(gateway);
  context.after(() => socket.terminate());
  socket.send(Buffer.alloc(1_280));
  const reply = once(socket, "message");
  socket.send(Buffer.alloc(1_280));
  assert.equal(JSON.parse((await reply)[0].toString()).code, "SESSION_AUDIO_LIMIT_EXCEEDED");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acceptedFrames.length, 1);
});
