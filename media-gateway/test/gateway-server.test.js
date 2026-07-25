import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

import { WebSocket } from "ws";

import { createGatewayServer } from "../src/gateway-server.js";

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

async function connectHost(url) {
  const webSocket = new WebSocket(url);
  await once(webSocket, "open");
  const received = nextJson(webSocket);
  webSocket.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");
  return webSocket;
}

test("public /health aliases local /healthz with the same no-store JSON contract", async (context) => {
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() { throw new Error("UNUSED"); },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const address = gateway.server.address();

  for (const path of ["/health", "/healthz"]) {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: true });
  }
});

test("host can hot-swap a prepared pipeline and explicitly end an audio turn", async (context) => {
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory(settings) {
      const pipeline = {
        settings,
        sessionType: settings.sessionType,
        outputMode: settings.outputMode,
        maxViewers: settings.maxViewers,
        glossaryPack: settings.glossaryPack,
        closed: 0,
        ended: 0,
        async start() {},
        async tick() {},
        async acceptAudio() {},
        async endAudioStream() { this.ended += 1; },
        async close() { this.closed += 1; },
      };
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const address = gateway.server.address();
  const webSocket = new WebSocket(`ws://127.0.0.1:${address.port}/live`);
  context.after(() => webSocket.terminate());
  await once(webSocket, "open");

  let received = nextJson(webSocket);
  webSocket.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");

  received = nextJson(webSocket);
  webSocket.send(JSON.stringify({
    type: "start",
    sessionId: "session-1",
    sessionType: "presentation",
    outputMode: "captions_audio",
    maxViewers: 24,
    glossaryPack: "hotel",
    version: 1,
    languages: ["en"],
  }));
  const started = await received;
  assert.equal(started.type, "started");
  assert.equal(started.sessionType, "presentation");
  assert.equal(started.outputMode, "captions_audio");
  assert.equal(started.maxViewers, 24);
  assert.equal(started.glossaryPack, "hotel");

  received = nextJson(webSocket);
  webSocket.send(JSON.stringify({
    type: "update",
    sessionId: "session-1",
    sessionType: "meeting",
    outputMode: "audio",
    maxViewers: 16,
    glossaryPack: "fnb",
    version: 1,
    languages: ["ko", "en"],
  }));
  const updated = await received;
  assert.equal(updated.type, "updated");
  assert.equal(updated.outputMode, "audio");
  assert.equal(pipelines[0].closed, 1);

  received = nextJson(webSocket);
  webSocket.send(JSON.stringify({ type: "audioStreamEnd" }));
  assert.equal((await received).type, "audio-stream-ended");
  assert.equal(pipelines[1].ended, 1);
  assert.match(gateway.metrics.render(), /realtime_noel_host_sessions 1/);

  webSocket.close();
  await once(webSocket, "close");
});

test("host translation restart rebuilds the pipeline without ending the live call", async (context) => {
  const pipelines = [];
  const authorizationOptions = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: {
      async authorize(_claims, _settings, options) {
        authorizationOptions.push(options);
        return options.requireLive === true;
      },
    },
    async pipelineFactory(settings) {
      const pipeline = {
        settings,
        closed: 0,
        async start() {},
        async tick() {},
        async acceptAudio() {},
        async endAudioStream() {},
        async close() { this.closed += 1; },
      };
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());

  let received = nextJson(host);
  host.send(JSON.stringify({
    type: "start",
    sessionId: "session-1",
    sessionType: "meeting",
    outputMode: "captions",
    version: 2,
    languages: ["ko", "en"],
  }));
  assert.equal((await received).type, "started");

  received = nextJson(host);
  host.send(JSON.stringify({
    type: "restart",
    sessionId: "session-1",
    sessionType: "meeting",
    outputMode: "captions",
    version: 2,
    languages: ["ko", "en"],
  }));
  const restarted = await received;
  assert.equal(restarted.type, "restarted");
  assert.equal(restarted.sessionId, "session-1");
  assert.equal(pipelines.length, 2);
  assert.equal(pipelines[0].closed, 1);
  assert.equal(pipelines[1].closed, 0);
  assert.ok(authorizationOptions.every((options) => options.requireLive === true));
});

test("gateway starts translation only after the database session is live", async (context) => {
  const authorizationOptions = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: {
      async authorize(_claims, _settings, options) {
        authorizationOptions.push(options);
        return options.requireLive === true;
      },
    },
    async pipelineFactory(settings) {
      return {
        voiceOutputMode: settings.voiceOutputMode,
        async start() {},
        async tick() {},
        async acceptAudio() {},
        async endAudioStream() {},
        async close() {},
      };
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  const received = nextJson(host);
  host.send(JSON.stringify({
    type: "start",
    sessionId: "session-1",
    version: 2,
    mode: "presentation",
    voiceOutputMode: "captions",
    languages: ["en"],
  }));
  assert.equal((await received).type, "started");
  assert.equal(authorizationOptions.length >= 2, true);
  assert.equal(authorizationOptions[0].requireLive, true);
  assert.equal(authorizationOptions[0].compareVersion, true);
  assert.equal(authorizationOptions[1].requireLive, true);
  assert.equal(authorizationOptions[1].compareVersion, true);
});

test("a reconnecting host replaces ownership without closing the old pipeline twice", async (context) => {
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() {
      const pipeline = {
        closed: 0,
        async start() {},
        async tick() {},
        async acceptAudio() {},
        async endAudioStream() {},
        async close() { this.closed += 1; },
      };
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const address = gateway.server.address();
  const url = `ws://127.0.0.1:${address.port}/live`;
  const first = new WebSocket(url);
  const second = new WebSocket(url);
  context.after(() => first.terminate());
  context.after(() => second.terminate());
  await Promise.all([once(first, "open"), once(second, "open")]);

  let received = nextJson(first);
  first.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(first);
  first.send(JSON.stringify({ type: "start", sessionId: "session-1", mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  assert.equal((await received).type, "started");

  received = nextJson(second);
  second.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(second);
  second.send(JSON.stringify({ type: "start", sessionId: "session-1", mode: "meeting", voiceOutputMode: "captions", version: 1, languages: ["ko"] }));
  assert.equal((await received).type, "started");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pipelines.length, 2);
  assert.equal(pipelines[0].closed, 1);
  assert.equal(pipelines[1].closed, 0);
});

test("a failed replacement candidate is closed while the active host remains owned", async (context) => {
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() {
      const pipeline = {
        closed: 0,
        ended: 0,
        async start() { if (pipelines.length === 2) throw new Error("CANDIDATE_START_FAILED"); },
        async tick() {},
        async acceptAudio() {},
        async endAudioStream() { this.ended += 1; },
        async close() { this.closed += 1; },
      };
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const address = gateway.server.address();
  const first = new WebSocket(`ws://127.0.0.1:${address.port}/live`);
  const second = new WebSocket(`ws://127.0.0.1:${address.port}/live`);
  context.after(() => first.terminate());
  context.after(() => second.terminate());
  await Promise.all([once(first, "open"), once(second, "open")]);
  for (const socket of [first, second]) {
    const authenticated = nextJson(socket);
    socket.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret") }));
    assert.equal((await authenticated).type, "authenticated");
  }
  let received = nextJson(first);
  first.send(JSON.stringify({ type: "start", sessionId: "session-1", mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  assert.equal((await received).type, "started");
  received = nextJson(second);
  second.send(JSON.stringify({ type: "start", sessionId: "session-1", mode: "meeting", voiceOutputMode: "captions", version: 1, languages: ["ko"] }));
  assert.equal((await received).code, "CANDIDATE_START_FAILED");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.readyState, WebSocket.OPEN);
  received = nextJson(first);
  first.send(JSON.stringify({ type: "audioStreamEnd" }));
  assert.equal((await received).type, "audio-stream-ended");
  assert.equal(pipelines[0].closed, 0);
  assert.equal(pipelines[0].ended, 1);
  assert.equal(pipelines[1].closed, 1);
});

test("concurrent host starts serialize prepare and leave no orphan pipeline", async (context) => {
  const pipelines = [];
  const releases = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() {
      let release;
      const started = new Promise((resolve) => { release = resolve; });
      const pipeline = {
        closed: 0,
        async start() { await started; },
        async tick() {},
        async acceptAudio() {},
        async endAudioStream() {},
        async close() { this.closed += 1; },
      };
      pipelines.push(pipeline);
      releases.push(release);
      return pipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const address = gateway.server.address();
  const first = new WebSocket(`ws://127.0.0.1:${address.port}/live`);
  const second = new WebSocket(`ws://127.0.0.1:${address.port}/live`);
  context.after(() => first.terminate());
  context.after(() => second.terminate());
  await Promise.all([once(first, "open"), once(second, "open")]);
  for (const socket of [first, second]) {
    const authenticated = nextJson(socket);
    socket.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret") }));
    assert.equal((await authenticated).type, "authenticated");
  }
  const firstStarted = nextJson(first);
  const secondStarted = nextJson(second);
  first.send(JSON.stringify({ type: "start", sessionId: "session-1", mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  second.send(JSON.stringify({ type: "start", sessionId: "session-1", mode: "meeting", voiceOutputMode: "captions", version: 1, languages: ["ko"] }));
  while (pipelines.length < 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pipelines.length, 1);
  releases[0]();
  assert.equal((await firstStarted).type, "started");
  while (pipelines.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pipelines[0].closed, 0, "the active pipeline remains owned until the candidate starts");
  releases[1]();
  assert.equal((await secondStarted).type, "started");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pipelines.map((pipeline) => pipeline.closed), [1, 0]);
});

test("host operation queue rejects overflow without creating an orphan candidate", async (context) => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    maxQueuedHostOperations: 1,
    async pipelineFactory() {
      const index = pipelines.length;
      const pipeline = {
        closed: 0,
        async start() { if (index === 0) await firstGate; },
        async tick() {}, async acceptAudio() {}, async endAudioStream() {},
        async close() { this.closed += 1; },
      };
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const hosts = await Promise.all([0, 1, 2].map(() => connectHost(`ws://127.0.0.1:${port}/live`)));
  for (const host of hosts) context.after(() => host.terminate());
  const replies = hosts.map((host) => nextJson(host));
  for (const host of hosts) host.send(JSON.stringify({ type: "start", sessionId: "session-1", mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));

  assert.equal((await replies[2]).code, "HOST_OPERATION_QUEUE_FULL");
  assert.equal(pipelines.length, 1);
  releaseFirst();
  assert.equal((await replies[0]).type, "started");
  assert.equal((await replies[1]).type, "started");
  assert.equal(pipelines.length, 2);
  assert.deepEqual(pipelines.map((pipeline) => pipeline.closed), [1, 0]);
});

test("host start hard deadline closes a stalled candidate", async (context) => {
  const timers = [];
  let candidate;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    hostStartTimeoutMilliseconds: 1_234,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cancelled = true; },
    async pipelineFactory() {
      candidate = {
        closed: 0,
        async start() { return new Promise(() => {}); },
        async tick() {}, async acceptAudio() {}, async endAudioStream() {},
        async close() { this.closed += 1; },
      };
      return candidate;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  const reply = nextJson(host);
  host.send(JSON.stringify({ type: "start", sessionId: "session-1", mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  while (!candidate) await new Promise((resolve) => setImmediate(resolve));
  const startTimer = timers.find((timer) => timer.delay === 1_234 && !timer.cancelled);
  assert.ok(startTimer);
  startTimer.callback();

  assert.equal((await reply).code, "HOST_START_TIMEOUT");
  assert.equal(candidate.closed, 1);
});

test("host factory hard deadline closes a candidate that resolves after timeout", async (context) => {
  const timers = [];
  let releaseFactory;
  let candidate;
  const factoryGate = new Promise((resolve) => { releaseFactory = resolve; });
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    hostStartTimeoutMilliseconds: 2_345,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cancelled = true; },
    async pipelineFactory() {
      await factoryGate;
      candidate = {
        closed: 0,
        async start() {}, async tick() {}, async acceptAudio() {}, async endAudioStream() {},
        async close() { this.closed += 1; },
      };
      return candidate;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  const reply = nextJson(host);
  host.send(JSON.stringify({ type: "start", sessionId: "session-1", mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  let startTimer = timers.find((timer) => timer.delay === 2_345 && !timer.cancelled);
  while (!startTimer) {
    await new Promise((resolve) => setImmediate(resolve));
    startTimer = timers.find((timer) => timer.delay === 2_345 && !timer.cancelled);
  }
  startTimer.callback();
  assert.equal((await reply).code, "HOST_START_TIMEOUT");

  releaseFactory();
  while (!candidate) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(candidate.closed, 1);
});

test("shutdown aborts running and queued host operations without waiting for start", async () => {
  const candidates = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    maxQueuedHostOperations: 1,
    async pipelineFactory(_message, _previous, _event, { signal }) {
      const candidate = {
        closed: 0,
        signal,
        async start() { return new Promise(() => {}); },
        async tick() {}, async acceptAudio() {}, async endAudioStream() {},
        async close() { this.closed += 1; },
      };
      candidates.push(candidate);
      return candidate;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const { port } = gateway.server.address();
  const first = await connectHost(`ws://127.0.0.1:${port}/live`);
  const second = await connectHost(`ws://127.0.0.1:${port}/live`);
  first.send(JSON.stringify({ type: "start", sessionId: "session-1", mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  second.send(JSON.stringify({ type: "start", sessionId: "session-1", mode: "meeting", voiceOutputMode: "captions", version: 1, languages: ["ko"] }));
  while (candidates.length < 1) await new Promise((resolve) => setImmediate(resolve));

  await gateway.close();

  assert.equal(candidates.length, 1, "the queued operation must not create a candidate after shutdown");
  assert.equal(candidates[0].signal.aborted, true);
  assert.equal(candidates[0].closed, 1);
});

test("a failed pipeline close is shared concurrently and retried on shutdown", async () => {
  let releaseFirstClose;
  const firstCloseGate = new Promise((resolve) => { releaseFirstClose = resolve; });
  const pipeline = {
    closeCalls: 0,
    async start() {}, async tick() {}, async acceptAudio() {}, async endAudioStream() {},
    async close() {
      this.closeCalls += 1;
      if (this.closeCalls === 1) {
        await firstCloseGate;
        throw new Error("CLOSE_FAILED");
      }
    },
  };
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() { return pipeline; },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  let reply = nextJson(host);
  host.send(JSON.stringify({ type: "start", sessionId: "session-1", mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  assert.equal((await reply).type, "started");
  host.close();
  await once(host, "close");
  const closing = gateway.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pipeline.closeCalls, 1, "concurrent close paths must share one in-flight close");
  releaseFirstClose();
  await closing;
  assert.equal(pipeline.closeCalls, 2, "a failed close must remain retryable during shutdown");
});

test("gateway shutdown closes each owned host pipeline exactly once", async () => {
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() {
      const pipeline = {
        closed: 0,
        async start() {},
        async tick() {},
        async acceptAudio() {},
        async endAudioStream() {},
        async close() { this.closed += 1; },
      };
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  const host = new WebSocket(`ws://127.0.0.1:${address.port}/live`);
  await once(host, "open");

  let received = nextJson(host);
  host.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(host);
  host.send(JSON.stringify({ type: "start", sessionId: "session-1", mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  assert.equal((await received).type, "started");

  await gateway.close();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pipelines.length, 1);
  assert.equal(pipelines[0].closed, 1);
  assert.match(gateway.metrics.render(), /realtime_noel_connection_cleanups_total 1/);
});

test("gateway shutdown rejects an in-flight candidate before atomic swap", async () => {
  let releaseStart;
  let candidate;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() {
      candidate = {
        closed: 0,
        async start() { await startGate; },
        async tick() {},
        async acceptAudio() {},
        async endAudioStream() {},
        async close() { this.closed += 1; },
      };
      return candidate;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  const host = new WebSocket(`ws://127.0.0.1:${address.port}/live`);
  const messages = [];
  host.on("message", (data) => messages.push(JSON.parse(data.toString("utf8"))));
  await once(host, "open");
  host.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret") }));
  while (!messages.some((message) => message.type === "authenticated")) await new Promise((resolve) => setImmediate(resolve));
  host.send(JSON.stringify({ type: "start", sessionId: "session-1", mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  while (!candidate) await new Promise((resolve) => setImmediate(resolve));

  const closing = gateway.close();
  releaseStart();
  await closing;

  assert.equal(candidate.closed, 1);
  assert.equal(messages.some((message) => message.type === "started"), false);
});

test("heartbeat terminates a stale WebSocket and records liveness metrics", async (context) => {
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() { throw new Error("unused"); },
    heartbeatIntervalMilliseconds: 10,
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const address = gateway.server.address();
  const stale = new WebSocket(`ws://127.0.0.1:${address.port}/live`, { autoPong: false });
  context.after(() => stale.terminate());
  await once(stale, "open");
  await once(stale, "close");
  assert.match(gateway.metrics.render(), /realtime_noel_heartbeat_pings_total [1-9]/);
  assert.match(gateway.metrics.render(), /realtime_noel_stale_connections_terminated_total 1/);
});

test("HOST connection closes visibly when its signed token expires", async (context) => {
  const fixedNow = Date.UTC(2026, 6, 19);
  const timers = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() { throw new Error("unused"); },
    now: () => fixedNow,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cancelled = true; },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const address = gateway.server.address();
  const host = new WebSocket(`ws://127.0.0.1:${address.port}/live`);
  context.after(() => host.terminate());
  await once(host, "open");
  let received = nextJson(host);
  host.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret", { now: fixedNow, expiresInSeconds: 15 }) }));
  assert.equal((await received).type, "authenticated");
  const expiryTimer = timers.find((timer) => timer.delay === 15_000 && !timer.cancelled);
  assert.ok(expiryTimer);
  received = nextJson(host);
  expiryTimer.callback();
  assert.deepEqual(await received, { type: "error", code: "TOKEN_EXPIRED", message: "게이트웨이 인증이 만료되었습니다." });
  await once(host, "close");
});

test("VIEWER connection closes visibly at the signed grant expiry", async (context) => {
  const fixedNow = Date.UTC(2026, 6, 19);
  const timers = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() { throw new Error("unused"); },
    now: () => fixedNow,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cancelled = true; },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const address = gateway.server.address();
  const viewer = new WebSocket(`ws://127.0.0.1:${address.port}/live`);
  context.after(() => viewer.terminate());
  await once(viewer, "open");
  let received = nextJson(viewer);
  viewer.send(JSON.stringify({
    type: "authenticate",
    token: signViewerToken("viewer-secret", "viewer-expiry", { now: fixedNow, expiresInMilliseconds: 15_000 }),
  }));
  assert.equal((await received).type, "authenticated");
  const expiryTimer = timers.find((timer) => timer.delay === 15_000 && !timer.cancelled);
  assert.ok(expiryTimer);
  received = nextJson(viewer);
  expiryTimer.callback();
  assert.deepEqual(await received, { type: "error", code: "TOKEN_EXPIRED", message: "게이트웨이 인증이 만료되었습니다." });
  await once(viewer, "close");
});

test("VIEWER reauthorization is single-flight and a hung check times out", async (context) => {
  const timers = [];
  let intervalCallback;
  let authorizeCalls = 0;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: {
      async authorize() {
        authorizeCalls += 1;
        if (authorizeCalls === 1) return true;
        return new Promise(() => {});
      },
    },
    async pipelineFactory() { throw new Error("unused"); },
    viewerAuthorizeTimeoutMilliseconds: 2_500,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cancelled = true; },
    setReauthorizeIntervalFn(callback, delay) {
      assert.equal(delay, 2_500);
      intervalCallback = callback;
      return { interval: true };
    },
    clearReauthorizeIntervalFn() {},
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const address = gateway.server.address();
  const viewer = new WebSocket(`ws://127.0.0.1:${address.port}/live`);
  context.after(() => viewer.terminate());
  await once(viewer, "open");
  let received = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "authenticate", token: signViewerToken("viewer-secret", "single-flight") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "subscribe", sessionId: "session-1", language: "ko" }));
  assert.equal((await received).type, "subscribed");

  intervalCallback();
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authorizeCalls, 2);
  const authorizeTimeout = timers.find((timer) => timer.delay === 2_500 && !timer.cancelled);
  assert.ok(authorizeTimeout);
  received = nextJson(viewer);
  authorizeTimeout.callback();
  assert.equal((await received).code, "GRANT_REVOKED");
  await once(viewer, "close");
});

test("a slow Townhall viewer is failed visibly while another viewer still receives audio", async (context) => {
  let viewerCheck = 0;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() { throw new Error("unused"); },
    slowConsumerPredicate() { viewerCheck += 1; return viewerCheck === 1; },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const address = gateway.server.address();
  const url = `ws://127.0.0.1:${address.port}/live`;
  const slow = new WebSocket(url);
  const fast = new WebSocket(url);
  context.after(() => slow.terminate());
  context.after(() => fast.terminate());
  await Promise.all([once(slow, "open"), once(fast, "open")]);
  for (const [viewer, grantId] of [[slow, "slow"], [fast, "fast"]]) {
    let received = nextJson(viewer);
    viewer.send(JSON.stringify({ type: "authenticate", token: signViewerToken("viewer-secret", grantId) }));
    assert.equal((await received).type, "authenticated");
    received = nextJson(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "session-1", language: "ko" }));
    assert.equal((await received).type, "subscribed");
  }
  const slowError = nextJson(slow);
  const fastAudio = once(fast, "message");
  await gateway.broadcastAudio("session-1", "ko", Buffer.from([1, 2, 3, 4]));
  assert.equal((await slowError).code, "SLOW_CONSUMER");
  const [audio, isBinary] = await fastAudio;
  assert.equal(isBinary, true);
  assert.deepEqual(Buffer.from(audio), Buffer.from([1, 2, 3, 4]));
  assert.match(gateway.metrics.render(), /realtime_noel_slow_consumers_terminated_total 1/);
});

test("HOST start is denied before pipeline creation when the database configuration differs", async (context) => {
  let factoryCalls = 0;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { return false; } },
    async pipelineFactory() { factoryCalls += 1; throw new Error("must not run"); },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  const reply = nextJson(host);
  host.send(JSON.stringify({
    type: "start", sessionId: "session-1", version: 3,
    mode: "presentation", voiceOutputMode: "captions", languages: ["en"],
  }));
  assert.equal((await reply).code, "SESSION_REVOKED");
  assert.equal(factoryCalls, 0);
});

test("HOST configuration is checked again after provider startup before atomic ownership", async (context) => {
  let authorizeCalls = 0;
  const candidate = {
    closed: 0, voiceOutputMode: "captions",
    async start() {}, async tick() {}, async acceptAudio() {}, async endAudioStream() {},
    async close() { this.closed += 1; },
  };
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize() { authorizeCalls += 1; return authorizeCalls === 1; } },
    async pipelineFactory() { return candidate; },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  const reply = nextJson(host);
  host.send(JSON.stringify({
    type: "start", sessionId: "session-1", version: 3,
    mode: "presentation", voiceOutputMode: "captions", languages: ["en"],
  }));
  assert.equal((await reply).code, "SESSION_REVOKED");
  assert.equal(candidate.closed, 1);
});

test("HOST lease closes the pipeline within the five-second audit interval", async (context) => {
  let leaseCallback;
  let authorizeCalls = 0;
  const pipeline = {
    closed: 0, voiceOutputMode: "captions",
    async start() {}, async tick() {}, async acceptAudio() {}, async endAudioStream() {},
    async close() { this.closed += 1; },
  };
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: { async authorize(_claims, _settings, options) { authorizeCalls += 1; return options.compareVersion; } },
    setHostLeaseIntervalFn(callback, delay) { assert.equal(delay, 2_500); leaseCallback = callback; return { lease: true }; },
    clearHostLeaseIntervalFn() {},
    async pipelineFactory() { return pipeline; },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  let received = nextJson(host);
  host.send(JSON.stringify({
    type: "start", sessionId: "session-1", version: 1,
    mode: "presentation", voiceOutputMode: "captions", languages: ["en"],
  }));
  assert.equal((await received).type, "started");
  assert.equal(typeof leaseCallback, "function");
  received = nextJson(host);
  leaseCallback();
  assert.equal((await received).code, "SESSION_REVOKED");
  await once(host, "close");
  assert.equal(authorizeCalls, 3);
  // The client close event and the server's async close handler are independent
  // event-loop turns. Wait for server-side ownership cleanup instead of assuming
  // the pipeline has closed before the peer observes its socket close.
  for (let attempt = 0; attempt < 20 && pipeline.closed === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pipeline.closed, 1);
});

test("a hung HOST lease is aborted within the remaining half of the five-second bound", async (context) => {
  const timers = [];
  let leaseCallback;
  let authorizeCalls = 0;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: {
      async authorize(_claims, _settings, { compareVersion }) {
        authorizeCalls += 1;
        return compareVersion ? true : new Promise(() => {});
      },
    },
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cancelled = true; },
    setHostLeaseIntervalFn(callback, delay) { assert.equal(delay, 2_500); leaseCallback = callback; return { lease: true }; },
    clearHostLeaseIntervalFn() {},
    async pipelineFactory(settings) {
      return {
        voiceOutputMode: settings.voiceOutputMode,
        async start() {}, async tick() {}, async acceptAudio() {}, async endAudioStream() {}, async close() {},
      };
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  let received = nextJson(host);
  host.send(JSON.stringify({
    type: "start", sessionId: "session-1", version: 1,
    mode: "presentation", voiceOutputMode: "captions", languages: ["en"],
  }));
  assert.equal((await received).type, "started");
  leaseCallback();
  while (authorizeCalls < 3) await new Promise((resolve) => setImmediate(resolve));
  const leaseTimeout = timers.find((timer) => timer.delay === 2_500 && !timer.cancelled);
  assert.ok(leaseTimeout, "2.5초 주기와 2.5초 제한의 합이 최대 5초여야 합니다.");
  received = nextJson(host);
  leaseTimeout.callback();
  assert.equal((await received).code, "SESSION_REVOKED");
});

test("an aborted old HOST lease cannot close a successfully swapped pipeline", async (context) => {
  const leaseCallbacks = [];
  let authorizationCalls = 0;
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; } },
    hostAuthorizer: {
      async authorize(_claims, _settings, { signal, compareVersion }) {
        authorizationCalls += 1;
        if (compareVersion) return true;
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    },
    setHostLeaseIntervalFn(callback) { leaseCallbacks.push(callback); return { lease: true }; },
    clearHostLeaseIntervalFn() {},
    async pipelineFactory(settings) {
      const pipeline = {
        voiceOutputMode: settings.voiceOutputMode,
        closed: 0,
        async start() {}, async tick() {}, async acceptAudio() {}, async endAudioStream() {},
        async close() { this.closed += 1; },
      };
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  let received = nextJson(host);
  host.send(JSON.stringify({
    type: "start", sessionId: "session-1", version: 1,
    mode: "presentation", voiceOutputMode: "captions", languages: ["en"],
  }));
  assert.equal((await received).type, "started");
  leaseCallbacks[0]();
  while (authorizationCalls < 3) await new Promise((resolve) => setImmediate(resolve));

  received = nextJson(host);
  host.send(JSON.stringify({
    type: "update", sessionId: "session-1", version: 2,
    mode: "meeting", voiceOutputMode: "captions", languages: ["ko"],
  }));
  assert.equal((await received).type, "updated");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.readyState, WebSocket.OPEN);
  assert.deepEqual(pipelines.map((pipeline) => pipeline.closed), [1, 0]);
});

test("viewer delivery is local and revalidates a stale grant immediately before fanout", async (context) => {
  let clock = Date.UTC(2026, 6, 19);
  let authorizeCalls = 0;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    now: () => clock,
    viewerAuthorizer: { async authorize() { authorizeCalls += 1; return authorizeCalls < 2; } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() { throw new Error("unused"); },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const viewer = new WebSocket(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => viewer.terminate());
  await once(viewer, "open");
  let received = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "authenticate", token: signViewerToken("viewer-secret", "fanout", { now: clock }) }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "subscribe", sessionId: "session-1", language: "ko" }));
  assert.equal((await received).type, "subscribed");

  received = nextJson(viewer);
  await gateway.broadcastEvent("session-1", "ko", { type: "caption", seq: 1, text: "공유 자막" });
  assert.deepEqual(await received, {
    type: "live-event",
    payload: { type: "caption", seq: 1, text: "공유 자막" },
  });
  const legend = { type: "speaker-legend", speakers: [{ speakerId: "speaker-1", voiceStatus: "ready" }] };
  received = nextJson(viewer);
  await gateway.broadcastEvent("session-1", "ko", legend);
  assert.deepEqual(await received, { type: "live-event", payload: legend });

  clock += 5_000;
  received = nextJson(viewer);
  await gateway.broadcastEvent("session-1", "ko", { type: "caption", seq: 2, text: "차단" });
  assert.equal((await received).code, "GRANT_REVOKED");
  assert.equal(authorizeCalls, 2);
});
