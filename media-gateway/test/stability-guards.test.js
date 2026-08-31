import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

import { WebSocket } from "ws";

import { AUDIO_CONFIG } from "../src/config.js";
import { createGatewayServer } from "../src/gateway-server.js";

const INPUT_FRAME_BYTES = AUDIO_CONFIG.inputSampleRate * 2 * AUDIO_CONFIG.chunkMilliseconds / 1_000;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function signToken(secret, claims) {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

function hostToken(secret, sessionId = SESSION_ID) {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  return signToken(secret, {
    role: "HOST", sub: "host-1", sessionId, aud: "media-gateway",
    iat: nowSeconds, exp: nowSeconds + 900,
  });
}

async function nextJson(webSocket) {
  const [data] = await once(webSocket, "message");
  return JSON.parse(data.toString("utf8"));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("CONDITION_TIMEOUT");
}

function stubPipeline(settings) {
  return {
    settings,
    frames: [],
    isPaused: false,
    async start() {},
    async acceptAudio(frame) { this.frames.push(frame[0]); return true; },
    async tick() {},
    pause() { this.isPaused = true; },
    resume() { this.isPaused = false; },
    async endAudioStream() {},
    async close() {},
  };
}

test("paused host audio is dropped before it burns the two-hour byte budget", async (context) => {
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    hostAuthorizer: { async authorize() { return true; } },
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    // Budget: exactly two frames. If paused frames were still charged, the
    // post-resume frame below would trip SESSION_AUDIO_LIMIT_EXCEEDED.
    maxSessionAudioBytes: INPUT_FRAME_BYTES * 2,
    async pipelineFactory(settings) {
      const pipeline = stubPipeline(settings);
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const host = new WebSocket(`ws://127.0.0.1:${port}/live`);
  context.after(() => host.terminate());
  await once(host, "open");
  const errors = [];
  host.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.type === "error") errors.push(message.code);
  });

  let received = nextJson(host);
  host.send(JSON.stringify({ type: "authenticate", token: hostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(host);
  host.send(JSON.stringify({
    type: "start",
    version: 1,
    sessionId: SESSION_ID,
    sessionType: "presentation",
    outputMode: "captions",
    languages: ["ko", "en"],
  }));
  assert.equal((await received).type, "started");

  const frame = (value) => {
    const buffer = Buffer.alloc(INPUT_FRAME_BYTES);
    buffer[0] = value;
    return buffer;
  };

  host.send(frame(1));
  await waitFor(() => pipelines[0].frames.length === 1);

  received = nextJson(host);
  host.send(JSON.stringify({ type: "pause", sessionId: SESSION_ID }));
  assert.equal((await received).type, "paused");

  // Three paused frames: dropped at the gateway, not charged, not forwarded.
  host.send(frame(2));
  host.send(frame(3));
  host.send(frame(4));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(pipelines[0].frames, [1]);

  received = nextJson(host);
  host.send(JSON.stringify({ type: "resume", sessionId: SESSION_ID }));
  assert.equal((await received).type, "resumed");

  host.send(frame(5));
  await waitFor(() => pipelines[0].frames.length === 2);
  assert.deepEqual(pipelines[0].frames, [1, 5]);
  assert.deepEqual(errors, [], "paused frames must not consume the byte budget");

  // The budget itself still enforces: the third live frame exceeds two frames.
  host.send(frame(6));
  await waitFor(() => errors.length === 1);
  assert.deepEqual(errors, ["SESSION_AUDIO_LIMIT_EXCEEDED"]);
});

test("durable failure surfaces immediately without any automatic paid recovery attempt", async (context) => {
  const pipelines = [];
  let recoveryAttempts = 0;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    hostAuthorizer: { async authorize() { return true; } },
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    async pipelineFactory(settings, _previous, _onHostEvent, options = {}) {
      if (options.recoveryReason === "durable-caption") {
        recoveryAttempts += 1;
        throw new Error("RECONCILIATION_TEMPORARILY_UNAVAILABLE");
      }
      const pipeline = stubPipeline(settings);
      pipeline.options = options;
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const host = new WebSocket(`ws://127.0.0.1:${port}/live`);
  context.after(() => host.terminate());
  await once(host, "open");
  const errors = [];
  host.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.type === "error") errors.push(message.code);
  });

  let received = nextJson(host);
  host.send(JSON.stringify({ type: "authenticate", token: hostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(host);
  host.send(JSON.stringify({
    type: "start",
    version: 1,
    sessionId: SESSION_ID,
    sessionType: "presentation",
    outputMode: "captions",
    languages: ["ko", "en"],
  }));
  assert.equal((await received).type, "started");

  pipelines[0].options.onFatalError(new Error("DURABLE_CAPTION_PERSIST_FAILED"));

  await waitFor(() => errors.includes("PIPELINE_RESTART_REQUIRED"));
  assert.equal(recoveryAttempts, 0);
  await waitFor(() => host.readyState === WebSocket.CLOSED);
  // Socket closure cannot schedule another paid attempt.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(recoveryAttempts, 0);
});
