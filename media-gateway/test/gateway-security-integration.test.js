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

function signHostToken(secret, now = Date.now()) {
  const seconds = Math.floor(now / 1_000);
  const claims = { role: "HOST", sub: "host-1", sessionId: "session-1", aud: "media-gateway", iat: seconds, exp: seconds + 900 };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

function createTestGateway(options = {}) {
  const acceptedFrames = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    securityPolicy: SECURITY_POLICY,
    viewerAuthorizer: { async authorize() { return true; } },
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
  reply = once(socket, "message");
  socket.send(JSON.stringify({
    type: "start", sessionId: "session-1", sessionType: "meeting", outputMode: "captions",
    maxViewers: 1, glossaryPack: "general_cre", version: 1, languages: ["ko"],
  }));
  assert.equal(JSON.parse((await reply)[0].toString()).type, "started");
  return socket;
}

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
