import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

import { WebSocket } from "ws";

import { createGatewayServer } from "../src/gateway-server.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_TWO_ID = "11111111-1111-4111-8111-111111111112";

function fixtureUuid(seed) {
  const digest = createHmac("sha256", "fixture-uuid").update(seed).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function signHostToken(secret, { now = Date.now(), expiresInSeconds = 900, sessionId = SESSION_ID } = {}) {
  const nowSeconds = Math.floor(now / 1_000);
  const claims = { role: "HOST", sub: "host-1", sessionId, aud: "media-gateway", iat: nowSeconds, exp: nowSeconds + expiresInSeconds };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

async function authenticateHostSocket(url, token, options = {}) {
  const webSocket = new WebSocket(url, options);
  await once(webSocket, "open");
  const authenticated = nextJsonMatching(webSocket, (message) => message.type === "authenticated");
  webSocket.send(JSON.stringify({ type: "authenticate", token }));
  assert.equal((await authenticated).role, "HOST");
  return webSocket;
}

async function startHostSocket(webSocket, sessionId, languages) {
  const started = nextJsonMatching(webSocket, (message) => message.type === "started");
  const floor = nextJsonMatching(webSocket, (message) => message.type === "floor");
  webSocket.send(JSON.stringify({
    type: "start",
    sessionId,
    version: 1,
    sessionType: "presentation",
    outputMode: "captions",
    languages,
  }));
  assert.equal((await started).sessionId, sessionId);
  assert.equal((await floor).sessionId, sessionId);
}

function signViewerToken(secret, grantId, { now = Date.now(), expiresInMilliseconds = 60_000 } = {}) {
  const nowSeconds = Math.floor(now / 1_000);
  const claims = {
    role: "VIEWER",
    sub: fixtureUuid(`viewer-${grantId}`),
    grantId: fixtureUuid(`grant-${grantId}`),
    sessionId: SESSION_ID,
    aud: "live-gateway-viewer",
    jti: randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + Math.ceil(expiresInMilliseconds / 1_000),
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

async function nextJson(webSocket) {
  const [data] = await once(webSocket, "message");
  return JSON.parse(data.toString("utf8"));
}

function nextJsonMatching(webSocket, predicate) {
  return new Promise((resolve) => {
    const onMessage = (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (!predicate(message)) return;
      webSocket.off("message", onMessage);
      resolve(message);
    };
    webSocket.on("message", onMessage);
  });
}

async function connectHost(url) {
  const webSocket = new WebSocket(url);
  await once(webSocket, "open");
  const received = nextJson(webSocket);
  webSocket.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");
  return webSocket;
}

async function waitForGatewayCondition(check) {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "gateway condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

for (const pendingStage of ["factory", "start"]) {
  test(`closing a host during pending ${pendingStage} aborts and closes the late candidate without ownership`, { timeout: 3_000 }, async (context) => {
    let release;
    let entered = false;
    let signal;
    const gate = new Promise((resolve) => { release = resolve; });
    const pipeline = {
      closed: 0,
      async start() { if (pendingStage === "start") { entered = true; await gate; } },
      async tick() {},
      async close() { this.closed += 1; },
    };
    const gateway = createGatewayServer({
      gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret", hostReconnectGraceMilliseconds: 0,
      hostAuthorizer: { async authorize() { return true; } },
      viewerAuthorizer: { async authorizeBatch(rows) { return new Map(rows.map(({ key }) => [key, true])); } },
      async pipelineFactory(_message, _previous, _onEvent, options) {
        signal = options.signal;
        if (pendingStage === "factory") { entered = true; await gate; }
        return pipeline;
      },
    });
    await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    context.after(async () => { release(); await gateway.close(); });
    const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
    context.after(() => host.terminate());
    host.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, version: 1,
      sessionType: "presentation", outputMode: "captions", languages: ["en"] }));
    await waitForGatewayCondition(() => entered);
    host.close();
    await waitForGatewayCondition(() => gateway.metrics.render().includes("realtime_noel_connection_cleanups_total 1"));
    assert.equal(signal.aborted, true, "the socket lifetime must cancel provider preparation immediately");
    release();
    await waitForGatewayCondition(() => pipeline.closed === 1);
    assert.doesNotMatch(gateway.metrics.render(), /realtime_noel_host_sessions [1-9]/u);
  });
}

test("a host closing during reattach authorization cannot steal the retained pipeline or cancel its grace expiry", { timeout: 3_000 }, async (context) => {
  let release;
  let entered = false;
  let signal;
  const gate = new Promise((resolve) => { release = resolve; });
  const pipeline = { closed: 0, async start() {}, async tick() {}, async close() { this.closed += 1; } };
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret", hostReconnectGraceMilliseconds: 300,
    hostAuthorizer: { async authorize(_claims, _settings, options) {
      if (options.compareVersion === false) { signal = options.signal; entered = true; await gate; }
      return true;
    } },
    viewerAuthorizer: { async authorizeBatch(rows) { return new Map(rows.map(({ key }) => [key, true])); } },
    async pipelineFactory() { return pipeline; },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => { release(); await gateway.close(); });
  const url = `ws://127.0.0.1:${gateway.server.address().port}/live`;
  const first = await connectHost(url);
  context.after(() => first.terminate());
  await startHostSocket(first, SESSION_ID, ["en"]);
  first.close();
  await waitForGatewayCondition(() => gateway.metrics.render().includes("realtime_noel_host_grace_detachments_total 1"));
  const second = await connectHost(url);
  context.after(() => second.terminate());
  second.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, version: 1,
    sessionType: "presentation", outputMode: "captions", languages: ["en"] }));
  await waitForGatewayCondition(() => entered);
  second.close();
  await waitForGatewayCondition(() => gateway.metrics.render().includes("realtime_noel_connection_cleanups_total 2"));
  assert.equal(signal.aborted, true);
  release();
  await waitForGatewayCondition(() => pipeline.closed === 1);
  assert.doesNotMatch(gateway.metrics.render(), /realtime_noel_host_reattaches_total [1-9]/u);
});

test("source fanout reaches each authorized subscribed viewer once across language switches and only the owned host", { timeout: 3_000 }, async (context) => {
  let clock = Date.now();
  let allowed = true;
  let factoryCalls = 0;
  let sourcePipeline;
  let pipelineGeneration;
  const gateway = createGatewayServer({
    now: () => clock, gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret",
    hostAuthorizer: { async authorize() { return true; } },
    viewerAuthorizer: { async authorizeBatch(rows) { return new Map(rows.map(({ key }) => [key, allowed])); } },
    async pipelineFactory(_settings, _previous, _emit, options) {
      pipelineGeneration = options.pipelineGeneration;
      factoryCalls += 1;
      sourcePipeline = { isPaused: false, async start() {}, async tick() {}, async close() {} };
      return sourcePipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(() => gateway.close());
  const url = `ws://127.0.0.1:${gateway.server.address().port}/live`;
  const owner = await connectHost(url);
  const unownedHost = await connectHost(url);
  context.after(() => owner.terminate());
  context.after(() => unownedHost.terminate());
  await startHostSocket(owner, SESSION_ID, ["ko", "en"]);
  const viewers = [];
  for (const [index, language] of ["ko", "en", null].entries()) {
    const viewer = new WebSocket(url);
    viewers.push(viewer);
    context.after(() => viewer.terminate());
    await once(viewer, "open");
    let reply = nextJson(viewer);
    viewer.send(JSON.stringify({ type: "authenticate", token: signViewerToken("viewer-secret", `source-${index}`, { now: clock }) }));
    await reply;
    if (language) {
      reply = nextJsonMatching(viewer, (message) => message.type === "subscribed");
      viewer.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, language }));
      await reply;
    }
  }
  const seen = new Map([owner, unownedHost, ...viewers].map((socket) => [socket, []]));
  for (const [socket, messages] of seen) socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  const emitSource = (event, metadata = {}) => gateway.broadcastSourceEvent(event, { pipelineGeneration, ...metadata });
  const source = { type: "source", sessionId: SESSION_ID, sourceUtteranceId: fixtureUuid("source-one"),
    sourceSeq: 1, utteranceKey: "source-one", text: "2026", sourceLanguage: "und", isFinal: true };
  for (const draft of [
    { type: "source-draft", sessionId: SESSION_ID, generation: fixtureUuid("draft"), revision: 1, text: "검토 중", sourceLanguage: "ko" },
    { type: "source-draft-clear", sessionId: SESSION_ID, generation: fixtureUuid("draft"), revision: 2 },
  ]) {
    await emitSource(draft);
    await waitForGatewayCondition(() => seen.get(viewers[1]).length === 1);
    assert.deepEqual(seen.get(viewers[0]), [{ type: "live-event", payload: draft }]);
    assert.deepEqual(seen.get(owner), [draft]);
    for (const messages of seen.values()) messages.length = 0;
  }
  await emitSource(source, { pipelineGeneration: fixtureUuid("stale-pipeline") });
  await gateway.broadcastSourceEvent(source);
  sourcePipeline.isPaused = true;
  await emitSource(source);
  sourcePipeline.isPaused = false;
  await emitSource(source, { mediaFence: { epoch: 99, ownerId: fixtureUuid("wrong-owner") } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok([...seen.values()].every((messages) => messages.length === 0), "paused and mismatched owner events cannot escape");
  await emitSource(source);
  await waitForGatewayCondition(() => seen.get(viewers[1]).length === 1);
  for (const viewer of viewers.slice(0, 2)) assert.deepEqual(seen.get(viewer), [{ type: "live-event", payload: source }]);
  assert.deepEqual(seen.get(owner), [source]);
  assert.deepEqual(seen.get(unownedHost), []);
  assert.deepEqual(seen.get(viewers[2]), []);
  const switched = nextJsonMatching(viewers[0], (message) => message.type === "subscribed");
  viewers[0].send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, language: "en" }));
  await switched;
  for (const messages of seen.values()) messages.length = 0;
  await emitSource({ ...source, sourceSeq: 2 });
  await waitForGatewayCondition(() => seen.get(viewers[1]).length === 1);
  assert.equal(seen.get(viewers[0]).length, 1, "language switching must not duplicate source delivery");
  for (const messages of seen.values()) messages.length = 0;
  await emitSource({ ...source, sessionId: SESSION_TWO_ID });
  assert.ok([...seen.values()].every((messages) => messages.length === 0));
  allowed = false;
  clock += 5_000;
  await emitSource({ ...source, sourceSeq: 3 });
  await waitForGatewayCondition(() => seen.get(viewers[0]).some((message) => message.code === "GRANT_REVOKED"));
  assert.ok(viewers.every((viewer) => !seen.get(viewer).some((message) => message.payload?.type === "source")));
  assert.equal(factoryCalls, 1, "reads and language changes cannot allocate providers");
});

test("demand mode cannot create a provider for a host without a connected viewer", { timeout: 2_000 }, async (context) => {
  let created = 0;
  const runtime = { sessionId: SESSION_ID, epoch: 1, state: "waking", hostSourceReady: true,
    connectedCount: 0, wakeDeadline: new Date(Date.now() + 45_000).toISOString() };
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret", hostStartTimeoutMilliseconds: 20,
    mediaDemandStore: { async read() { return runtime; }, async transition() { return runtime; } },
    viewerAuthorizer: { async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() { created += 1; throw new Error("UNEXPECTED_PROVIDER"); },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(() => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  const error = nextJsonMatching(host, (message) => message.type === "error");
  host.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, version: 1, sessionType: "presentation", outputMode: "captions", languages: ["en"] }));
  assert.equal((await error).code, "MEDIA_START_TIMEOUT");
  assert.equal(created, 0);
});

test("demand mode starts once for a connected viewer then idles without ending the meeting", { timeout: 2_000 }, async (context) => {
  let now = Date.now();
  let runtime = { sessionId: SESSION_ID, epoch: 1, state: "waking", hostSourceReady: true,
    connectedCount: 0, wakeDeadline: new Date(now + 45_000).toISOString(), idleAfter: null };
  const events = [];
  const gateway = createGatewayServer({
    now: () => now, gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret", mediaDemandPollMilliseconds: 5,
    mediaDemandStore: {
      async read() { return runtime; },
      async transition(_session, _epoch, _owner, action) {
        if (action === "connect") runtime = { ...runtime, connectedCount: 1 };
        if (action === "ready") runtime = { ...runtime, state: "active" };
        if (action === "disconnect") runtime = { ...runtime, connectedCount: 0, idleAfter: new Date(now + 30_000).toISOString() };
        events.push(action); return runtime;
      },
    },
    viewerAuthorizer: { async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory(_settings, _previous, _emit, options) {
      assert.equal(options.requireDurableSeed, true);
      return { async start() { events.push("provider-start"); }, async tick() {}, async acceptAudio() {},
        async gracefulDrain() { events.push("drain-finals"); }, async close() { events.push("provider-close"); },
        async completeTopicsOnSessionEnd() { events.push("meeting-ended"); } };
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(() => gateway.close());
  const url = `ws://127.0.0.1:${gateway.server.address().port}/live`;
  const viewer = new WebSocket(url); context.after(() => viewer.terminate()); await once(viewer, "open");
  let response = nextJsonMatching(viewer, (message) => message.type === "authenticated");
  viewer.send(JSON.stringify({ type: "authenticate", token: signViewerToken("viewer-secret", "demand-viewer") })); await response;
  response = nextJsonMatching(viewer, (message) => message.type === "subscribed");
  viewer.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, language: "en", epoch: 1, connectionId: randomUUID() })); await response;
  const host = await connectHost(url); context.after(() => host.terminate());
  await startHostSocket(host, SESSION_ID, ["en"]);
  assert.equal(events.filter((event) => event === "provider-start").length, 1);
  const idle = nextJsonMatching(host, (message) => message.type === "media-idle");
  viewer.close(); await once(viewer, "close");
  await new Promise((resolve) => setTimeout(resolve, 5)); now += 30_001;
  assert.equal((await idle).reason, "no_audience");
  assert.equal(events.includes("meeting-ended"), false);
  assert.ok(events.indexOf("drain-finals") < events.indexOf("provider-close"));
});

test("browser HOST receives every configured caption and session status without widening desktop mirroring", async (context) => {
  const hostEventEmitters = new Map();
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    securityPolicy: {
      allowedOrigins: new Set(["https://portal.example.com"]),
      allowTrustedNonBrowser: true,
      allowLoopbackWithoutOrigin: false,
      metricsToken: "",
    },
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory(settings, _previous, onHostEvent) {
      hostEventEmitters.set(settings.sessionId, onHostEvent);
      return {
        async start() {}, async tick() {}, async acceptAudio() {},
        async endAudioStream() {}, async pause() {}, async close() {},
      };
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const url = `ws://127.0.0.1:${gateway.server.address().port}/live`;

  const browserToken = signHostToken("gateway-secret", { sessionId: SESSION_ID });
  const browserHost = await authenticateHostSocket(url, browserToken, { origin: "https://portal.example.com" });
  context.after(() => browserHost.terminate());
  await startHostSocket(browserHost, SESSION_ID, ["ko", "en"]);

  const desktopToken = signHostToken("gateway-secret", { sessionId: SESSION_TWO_ID });
  const desktopHost = await authenticateHostSocket(url, desktopToken, {
    headers: {
      authorization: `Bearer ${desktopToken}`,
      "x-realtime-noel-client": "desktop-main",
    },
  });
  context.after(() => desktopHost.terminate());
  await startHostSocket(desktopHost, SESSION_TWO_ID, ["ko", "en"]);

  const browserMessages = [];
  const desktopMessages = [];
  browserHost.on("message", (data) => browserMessages.push(JSON.parse(data.toString("utf8"))));
  desktopHost.on("message", (data) => desktopMessages.push(JSON.parse(data.toString("utf8"))));

  const sourceCaption = nextJsonMatching(browserHost, (message) => message.type === "caption" && message.language === "ko");
  await gateway.broadcastEvent(SESSION_ID, "ko", {
    type: "caption", sessionId: SESSION_ID, language: "ko", seq: 1,
    utteranceKey: "utterance-1", text: "원문", isFinal: true,
  });
  await sourceCaption;
  const translatedCaption = nextJsonMatching(browserHost, (message) => message.type === "caption" && message.language === "en");
  await gateway.broadcastEvent(SESSION_ID, "en", {
    type: "caption", sessionId: SESSION_ID, language: "en", seq: 1,
    utteranceKey: "utterance-1", text: "Translation", isFinal: true,
  });
  await translatedCaption;
  await gateway.broadcastEvent(SESSION_ID, "ja", {
    type: "caption", sessionId: SESSION_ID, language: "ja", seq: 1,
    utteranceKey: "utterance-1", text: "未設定", isFinal: true,
  });
  await gateway.broadcastEvent(SESSION_TWO_ID, "ko", {
    type: "caption", sessionId: SESSION_TWO_ID, language: "ko", seq: 1,
    utteranceKey: "utterance-2", text: "desktop must not mirror host speech", isFinal: true,
  });
  const pausedStatus = nextJsonMatching(browserHost, (message) => message.type === "session-status" && message.status === "paused");
  browserHost.send(JSON.stringify({ type: "pause" }));
  await pausedStatus;

  assert.deepEqual(
    browserMessages.filter((message) => message.type === "caption").map(({ language, text }) => ({ language, text })),
    [{ language: "ko", text: "원문" }, { language: "en", text: "Translation" }],
  );
  assert.equal(browserMessages.some((message) => message.type === "session-status" && message.status === "paused"), true);
  assert.equal(desktopMessages.some((message) => message.type === "caption"), false);

  browserHost.terminate();
  await once(browserHost, "close");
  await new Promise((resolve) => setImmediate(resolve));
  const desktopReattach = await authenticateHostSocket(url, browserToken, {
    headers: {
      authorization: `Bearer ${browserToken}`,
      "x-realtime-noel-client": "desktop-main",
    },
  });
  context.after(() => desktopReattach.terminate());
  await startHostSocket(desktopReattach, SESSION_ID, ["ko", "en"]);
  const participantPartial = nextJsonMatching(
    desktopReattach,
    (message) => message.type === "caption" && message.text === "participant partial",
  );
  hostEventEmitters.get(SESSION_ID)({
    type: "caption", sessionId: SESSION_ID, language: "ko", seq: 1,
    utteranceKey: "participant-1", text: "participant partial", isFinal: false,
    speaker: { speakerId: "participant:1" }, translationStatus: "translated",
  });
  assert.equal((await participantPartial).text, "participant partial");
});

test("viewer cannot subscribe to a language outside the active host configuration", async (context) => {
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() {
      return {
        async start() {}, async tick() {}, async acceptAudio() {},
        async endAudioStream() {}, async close() {},
      };
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const url = `ws://127.0.0.1:${gateway.server.address().port}/live`;
  const host = await connectHost(url);
  context.after(() => host.terminate());
  await startHostSocket(host, SESSION_ID, ["ko"]);

  const viewer = new WebSocket(url);
  context.after(() => viewer.terminate());
  await once(viewer, "open");
  const authenticated = nextJsonMatching(viewer, (message) => message.type === "authenticated");
  viewer.send(JSON.stringify({ type: "authenticate", token: signViewerToken("viewer-secret", "grant-1") }));
  await authenticated;
  const rejected = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, language: "en" }));
  assert.equal((await rejected).code, "INVALID_SUBSCRIPTION");
  assert.equal(gateway.subscriberCount(SESSION_ID, "en"), 0);
});

test("public /health aliases local /healthz with the same no-store JSON contract", async (context) => {
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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

  for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const path of ["/health", "/healthz"]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method });
      assert.equal(response.status, 404, `${method} ${path} must not enter the health handler`);
      assert.equal(await response.text(), "");
    }
  }

  for (const path of [
    "/health?details=true",
    "/healthz?details=true",
    "/health/",
    "/healthz/",
    "/healthcheck",
    "/healthz-extra",
    "/%68ealth",
    "/health%3Fdetails=true",
  ]) {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    assert.equal(response.status, 404, `GET ${path} must not enter the health handler`);
    assert.equal(await response.text(), "");
  }
});

test("host can hot-swap a prepared pipeline and explicitly end an audio turn", async (context) => {
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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

  const startedMessage = nextJsonMatching(webSocket, (message) => message.type === "started");
  const startedFloor = nextJsonMatching(webSocket, (message) => message.type === "floor");
  webSocket.send(JSON.stringify({
    type: "start",
    sessionId: SESSION_ID,
    sessionType: "presentation",
    outputMode: "captions_audio",
    maxViewers: 24,
    glossaryPack: "hotel",
    version: 1,
    languages: ["en"],
  }));
  const started = await startedMessage;
  assert.equal(started.type, "started");
  assert.equal(started.sessionType, "presentation");
  assert.equal(started.outputMode, "captions");
  assert.equal(started.maxViewers, 24);
  assert.equal(started.glossaryPack, "hotel");
  assert.equal((await startedFloor).holder, null);

  const updatedMessage = nextJsonMatching(webSocket, (message) => message.type === "updated");
  const updatedFloor = nextJsonMatching(webSocket, (message) => message.type === "floor");
  webSocket.send(JSON.stringify({
    type: "update",
    sessionId: SESSION_ID,
    sessionType: "meeting",
    outputMode: "audio",
    maxViewers: 16,
    glossaryPack: "fnb",
    version: 1,
    languages: ["ko", "en"],
  }));
  const updated = await updatedMessage;
  assert.equal(updated.type, "updated");
  assert.equal(updated.outputMode, "captions");
  assert.equal((await updatedFloor).holder, null);
  assert.equal(pipelines[0].closed, 1);

  received = nextJsonMatching(webSocket, (message) => message.type === "audio-stream-ended");
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
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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

  const started = nextJsonMatching(host, (message) => message.type === "started");
  const startedFloor = nextJsonMatching(host, (message) => message.type === "floor");
  host.send(JSON.stringify({
    type: "start",
    sessionId: SESSION_ID,
    sessionType: "meeting",
    outputMode: "captions",
    version: 2,
    languages: ["ko", "en"],
  }));
  assert.equal((await started).type, "started");
  assert.equal((await startedFloor).holder, null);

  const restartedMessage = nextJsonMatching(host, (message) => message.type === "restarted");
  const restartedFloor = nextJsonMatching(host, (message) => message.type === "floor");
  host.send(JSON.stringify({
    type: "restart",
    sessionId: SESSION_ID,
    sessionType: "meeting",
    outputMode: "captions",
    version: 2,
    languages: ["ko", "en"],
  }));
  const restarted = await restartedMessage;
  assert.equal(restarted.type, "restarted");
  assert.equal(restarted.sessionId, SESSION_ID);
  assert.equal((await restartedFloor).holder, null);
  assert.equal(pipelines.length, 2);
  assert.equal(pipelines[0].closed, 1);
  assert.equal(pipelines[1].closed, 0);
  assert.ok(authorizationOptions.every((options) => options.requireLive === true));
});

test("gateway starts a preparing host candidate then commits readiness before ACK", async (context) => {
  const events = [];
  const activationKey = "11111111-1111-4111-8111-111111111111";
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: {
      async authorize(_claims, _settings, options) {
        events.push(["authorize", options]);
        return options.readinessStart === true
          ? { readinessMode: "activate", pinnedGlossaryFingerprint: `sha256:${"b".repeat(64)}` }
          : options.requireLive === true;
      },
      async activate(_claims, activation, { signal }) {
        events.push(["activate", activation, signal]);
        return { sessionId: SESSION_ID, status: "live", version: 3 };
      },
    },
    async pipelineFactory(settings) {
      return {
        voiceOutputMode: settings.voiceOutputMode,
        async start() { events.push(["candidate-start"]); },
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
    sessionId: SESSION_ID,
    version: 2,
    activationKey,
    mode: "presentation",
    voiceOutputMode: "captions",
    languages: ["en"],
  }));
  const reply = await received;
  assert.equal(reply.type, "started", JSON.stringify(reply));
  assert.equal(reply.version, 3);
  assert.equal(events[0][0], "authorize");
  assert.equal(events[0][1].readinessStart, true);
  assert.equal(events[1][0], "candidate-start");
  assert.equal(events[2][0], "activate");
  assert.equal(events[2][1].activationKey, activationKey);
  assert.match(events[2][1].gatewaySettingsFingerprint, /^sha256:[a-f0-9]{64}$/u);

  const replayed = nextJsonMatching(host, (message) => message.type === "started");
  host.send(JSON.stringify({
    type: "start", sessionId: SESSION_ID, version: 2, activationKey,
    mode: "presentation", voiceOutputMode: "captions", languages: ["en"],
  }));
  assert.equal((await replayed).version, 3);
  assert.equal(events.filter(([name]) => name === "candidate-start").length, 1);
  assert.equal(events.filter(([name]) => name === "activate").length, 1);
});

test("an explicit restart can activate a preparing session after provider failure without allowing automatic retries", async (context) => {
  let status = "preparing";
  let version = 2;
  const candidates = [];
  const activations = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: {
      async authorize(_claims, settings, options) {
        if (settings.version !== version || settings.languages.join(",") !== "en") return false;
        if (options.readinessStart) return { sessionStatus: status, readinessMode: status === "preparing" ? "activate" : "resume-live", pinnedGlossaryFingerprint: null };
        return status === "live";
      },
      async activate(_claims, activation) {
        activations.push(activation);
        status = "live";
        version += 1;
        return { sessionId: SESSION_ID, status, version };
      },
    },
    async pipelineFactory(_settings, _previous, _emit, options) {
      const candidate = {
        options, closed: 0,
        async start() { if (candidates[0] === this) throw new Error("PROVIDER_START_FAILED"); },
        async tick() {}, async close() { this.closed += 1; },
      };
      candidates.push(candidate);
      return candidate;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(() => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  const activationKey = fixtureUuid("preparing-explicit-restart");
  async function request(overrides = {}) {
    const reply = nextJsonMatching(host, (message) => ["error", "started", "restarted"].includes(message.type));
    host.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, version: 2, activationKey,
      sessionType: "presentation", outputMode: "captions", languages: ["en"], ...overrides }));
    return reply;
  }
  assert.equal((await request()).requiresManualRestart, true);
  assert.equal(status, "preparing");
  assert.equal(candidates[0].closed, 1);
  const freshActivationKey = fixtureUuid("fresh-http-start-intent");
  assert.equal((await request({ activationKey: freshActivationKey })).code, "PIPELINE_RESTART_REQUIRED");
  assert.equal((await request({ type: "restart", activationKey: undefined })).code, "SESSION_REVOKED");
  assert.equal((await request({ type: "restart", activationKey: "not-a-uuid" })).code, "INVALID_ACTIVATION_KEY");
  assert.equal((await request({ type: "restart", activationKey: [freshActivationKey] })).code, "INVALID_ACTIVATION_KEY");
  assert.equal((await request({ type: "restart", version: 1, activationKey: freshActivationKey })).code, "SESSION_REVOKED");
  assert.equal(candidates.length, 1);
  const restarted = await request({ type: "restart", activationKey: freshActivationKey });
  assert.equal(restarted.type, "restarted", JSON.stringify(restarted));
  assert.equal(restarted.version, 3);
  assert.equal(status, "live");
  assert.equal(candidates.length, 2);
  assert.equal(candidates[1].options.requireDurableSeed, true);
  assert.equal(candidates[1].options.recoveryReason, undefined, "preparing rooms cannot use the live-only reconciliation RPC");
  assert.equal(activations.length, 1);
  assert.equal(activations[0].activationKey, freshActivationKey);
});

test("readiness CAS failure closes the candidate exactly once without a started ACK", async (context) => {
  const candidate = {
    closed: 0,
    async start() {}, async tick() {}, async acceptAudio() {}, async endAudioStream() {},
    async close() { this.closed += 1; },
  };
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: {
      async authorize(_claims, _settings, options) {
        return options.readinessStart === true ? { readinessMode: "activate", pinnedGlossaryFingerprint: null } : false;
      },
      async activate() { throw new Error("GATEWAY_READINESS_CONFLICT"); },
    },
    async pipelineFactory() { return candidate; },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  const reply = nextJson(host);
  host.send(JSON.stringify({
    type: "start", sessionId: SESSION_ID, version: 2,
    activationKey: "11111111-1111-4111-8111-111111111111",
    sessionType: "meeting", outputMode: "captions", languages: ["ko"],
  }));
  assert.equal((await reply).code, "GATEWAY_READINESS_CONFLICT");
  assert.equal(candidate.closed, 1);
});

test("a live database session rebuilds a lost gateway pipeline without readiness CAS", async (context) => {
  let activateCalls = 0;
  let pipelineStarts = 0;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: {
      async authorize(_claims, _settings, options) {
        if (options.readinessStart) return { readinessMode: "resume-live", pinnedGlossaryFingerprint: null };
        return options.requireLive === true;
      },
      async activate() { activateCalls += 1; throw new Error("CAS_MUST_NOT_RUN"); },
    },
    async pipelineFactory() {
      return {
        async start() { pipelineStarts += 1; }, async tick() {}, async acceptAudio() {},
        async endAudioStream() {}, async close() {},
      };
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  const reply = nextJsonMatching(host, (message) => message.type === "started" || message.type === "error");
  host.send(JSON.stringify({
    type: "start", sessionId: SESSION_ID, version: 8,
    activationKey: "22222222-2222-4222-8222-222222222222",
    sessionType: "meeting", outputMode: "captions", languages: ["ko"],
  }));
  const started = await reply;
  assert.equal(started.type, "started", JSON.stringify(started));
  assert.equal(started.version, 8);
  assert.equal(pipelineStarts, 1);
  assert.equal(activateCalls, 0);
});

test("a reconnecting host replaces ownership without closing the old pipeline twice", async (context) => {
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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
  first.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  assert.equal((await received).type, "started");

  received = nextJson(second);
  second.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(second);
  second.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "meeting", voiceOutputMode: "captions", version: 1, languages: ["ko"] }));
  assert.equal((await received).type, "started");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pipelines.length, 2);
  assert.equal(pipelines[0].closed, 1);
  assert.equal(pipelines[1].closed, 0);
});

test("a grace-reattached host flushes canonical buffered captions from the preserved pipeline", { timeout: 5_000 }, async (context) => {
  let emitHostEvent;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return true; } },
    hostReconnectGraceMilliseconds: 45_000,
    async pipelineFactory(_settings, _previous, onHostEvent) {
      emitHostEvent = onHostEvent;
      return {
        async start() {}, async tick() {}, async acceptAudio() {}, async endAudioStream() {}, async close() {},
      };
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const url = `ws://127.0.0.1:${gateway.server.address().port}/live`;
  const first = await connectHost(url);
  let received = nextJson(first);
  first.send(JSON.stringify({
    type: "start", sessionId: SESSION_ID, version: 1,
    sessionType: "meeting", outputMode: "captions", languages: ["ko"],
  }));
  assert.equal((await received).type, "started");
  first.terminate();
  await once(first, "close");
  await new Promise((resolve) => setImmediate(resolve));

  emitHostEvent({ type: "caption", seq: 3, language: "ko", utteranceKey: "u-3", text: "초안", isFinal: false });
  emitHostEvent({ type: "caption", seq: 1, language: "ko", utteranceKey: "u-1", text: "첫 확정", isFinal: true });
  emitHostEvent({ type: "caption", seq: 3, language: "ko", utteranceKey: "u-3", text: "최신 초안", isFinal: false });
  emitHostEvent({ type: "caption", seq: 2, language: "ko", utteranceKey: "u-2", text: "둘째 확정", isFinal: true });
  emitHostEvent({ type: "caption", seq: 2, language: "ko", utteranceKey: "u-2", text: "늦은 초안", isFinal: false });

  const second = await connectHost(url);
  context.after(() => second.terminate());
  const flushedCaptions = new Promise((resolve) => {
    const captions = [];
    const onMessage = (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.type !== "caption") return;
      captions.push(message);
      if (captions.length === 3) {
        second.off("message", onMessage);
        resolve(captions);
      }
    };
    second.on("message", onMessage);
  });
  const reattachedStarted = nextJsonMatching(second, (message) => message.type === "started");
  const reattachedFloor = nextJsonMatching(second, (message) => message.type === "floor");
  second.send(JSON.stringify({
    type: "start", sessionId: SESSION_ID, version: 2,
    sessionType: "meeting", outputMode: "captions", languages: ["ko"],
  }));
  assert.equal((await reattachedStarted).type, "started");
  assert.equal((await reattachedFloor).holder, null);

  const buffered = await flushedCaptions;
  assert.deepEqual(buffered.map(({ seq, text, isFinal }) => ({ seq, text, isFinal })), [
    { seq: 1, text: "첫 확정", isFinal: true },
    { seq: 2, text: "둘째 확정", isFinal: true },
    { seq: 3, text: "최신 초안", isFinal: false },
  ]);

  const liveCaption = nextJsonMatching(second, (message) => message.type === "caption" && message.seq === 4);
  emitHostEvent({ type: "caption", seq: 4, language: "ko", text: "재연결 후 자막", isFinal: true });
  assert.equal((await liveCaption).text, "재연결 후 자막");
});

test("a replacement pipeline never inherits a detached pipeline's caption buffer", { timeout: 5_000 }, async (context) => {
  const emitters = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return true; } },
    hostReconnectGraceMilliseconds: 45_000,
    async pipelineFactory(_settings, _previous, onHostEvent) {
      emitters.push(onHostEvent);
      return {
        async start() {}, async tick() {}, async acceptAudio() {}, async endAudioStream() {}, async close() {},
      };
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const url = `ws://127.0.0.1:${gateway.server.address().port}/live`;
  const first = await connectHost(url);
  const firstStarted = nextJsonMatching(first, (message) => message.type === "started");
  const firstFloor = nextJsonMatching(first, (message) => message.type === "floor");
  first.send(JSON.stringify({
    type: "start", sessionId: SESSION_ID, version: 1,
    sessionType: "meeting", outputMode: "captions", languages: ["ko"],
  }));
  assert.equal((await firstStarted).type, "started");
  assert.equal((await firstFloor).holder, null);
  first.terminate();
  await once(first, "close");
  await new Promise((resolve) => setImmediate(resolve));
  emitters[0]({ type: "caption", seq: 1, language: "ko", text: "폐기할 이전 자막", isFinal: true });

  const replacement = await connectHost(url);
  context.after(() => replacement.terminate());
  const replacementStarted = nextJsonMatching(replacement, (message) => message.type === "started");
  const replacementFloor = nextJsonMatching(replacement, (message) => message.type === "floor");
  replacement.send(JSON.stringify({
    type: "start", sessionId: SESSION_ID, version: 2,
    sessionType: "presentation", outputMode: "captions", languages: ["en"],
  }));
  assert.equal((await replacementStarted).type, "started");
  assert.equal((await replacementFloor).holder, null);
  assert.equal(emitters.length, 2);

  const received = nextJsonMatching(replacement, (message) => message.type === "caption");
  emitters[1]({ type: "caption", seq: 1, language: "en", text: "new pipeline", isFinal: true });
  const caption = await received;
  assert.equal(caption.text, "new pipeline");
  assert.equal(caption.language, "en");
});

test("a failed replacement candidate is closed while the active host remains owned", async (context) => {
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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
  first.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  assert.equal((await received).type, "started");
  received = nextJson(second);
  second.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "meeting", voiceOutputMode: "captions", version: 1, languages: ["ko"] }));
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
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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
  first.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  second.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "meeting", voiceOutputMode: "captions", version: 1, languages: ["ko"] }));
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
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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
  for (const host of hosts) host.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));

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
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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
  host.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
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
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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
  host.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
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
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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
  first.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  second.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "meeting", voiceOutputMode: "captions", version: 1, languages: ["ko"] }));
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
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() { return pipeline; },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  let reply = nextJson(host);
  host.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
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
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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
  host.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  assert.equal((await received).type, "started");

  await gateway.close();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pipelines.length, 1);
  assert.equal(pipelines[0].closed, 1);
  assert.match(gateway.metrics.render(), /realtime_noel_connection_cleanups_total 1/);
});

test("host teardown releases Gemini session resources exactly once before later shutdown", async () => {
  const releasedSessionIds = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return true; } },
    hostReconnectGraceMilliseconds: 0,
    async releaseGeminiSession(sessionId) { releasedSessionIds.push(sessionId); },
    async pipelineFactory() {
      return {
        async start() {}, async tick() {}, async acceptAudio() {}, async endAudioStream() {}, async close() {},
      };
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  let reply = nextJson(host);
  host.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  assert.equal((await reply).type, "started");

  host.close();
  await once(host, "close");
  while (releasedSessionIds.length === 0) await new Promise((resolve) => setImmediate(resolve));
  await gateway.close();

  assert.deepEqual(releasedSessionIds, [SESSION_ID]);
});

test("Gemini session release failure is observed without blocking shutdown cleanup", async () => {
  let releaseCalls = 0;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return true; } },
    async releaseGeminiSession() {
      releaseCalls += 1;
      throw new Error("provider detail must not be logged");
    },
    async pipelineFactory() {
      return {
        closed: 0,
        async start() {}, async tick() {}, async acceptAudio() {}, async endAudioStream() {},
        async close() { this.closed += 1; },
      };
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  let reply = nextJson(host);
  host.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
  assert.equal((await reply).type, "started");

  await gateway.close();

  assert.equal(releaseCalls, 1);
  assert.match(gateway.metrics.render(), /realtime_noel_gemini_session_release_failures_total 1/);
  assert.doesNotMatch(gateway.metrics.render(), /provider detail/u);
});

test("gateway shutdown rejects an in-flight candidate before atomic swap", async () => {
  let releaseStart;
  let candidate;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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
  host.send(JSON.stringify({ type: "start", sessionId: SESSION_ID, mode: "presentation", voiceOutputMode: "captions", version: 1, languages: ["en"] }));
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
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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

test("VIEWER ticket expiry is only an admission deadline after authentication", async (context) => {
  let clock = Date.UTC(2026, 6, 19);
  const timers = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() {
      return {
        async start() {}, async tick() {}, async acceptAudio() {},
        async endAudioStream() {}, async close() {},
      };
    },
    now: () => clock,
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
  const url = `ws://127.0.0.1:${address.port}/live`;
  const host = await authenticateHostSocket(url, signHostToken("gateway-secret", { now: clock }));
  context.after(() => host.terminate());
  await startHostSocket(host, SESSION_ID, ["ko"]);

  const viewer = new WebSocket(url);
  context.after(() => viewer.terminate());
  await once(viewer, "open");
  let received = nextJson(viewer);
  viewer.send(JSON.stringify({
    type: "authenticate",
    token: signViewerToken("viewer-secret", "viewer-expiry", { now: clock, expiresInMilliseconds: 15_000 }),
  }));
  assert.equal((await received).type, "authenticated");
  assert.equal(timers.some((timer) => timer.delay === 15_000 && !timer.cancelled), false);

  clock += 16_000;
  received = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, language: "ko" }));
  assert.equal((await received).type, "subscribed");
  assert.equal(viewer.readyState, WebSocket.OPEN);
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
      async authorizeBatch(requests) {
        authorizeCalls += 1;
        if (authorizeCalls === 1) return new Map(requests.map(({ key }) => [key, true]));
        return new Promise(() => {});
      },
    },
    async pipelineFactory() { throw new Error("unused"); },
    viewerAuthorizeTimeoutMilliseconds: 2_500,
    viewerAuthorizationBatchWindowMilliseconds: 0,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cancelled = true; },
    setReauthorizeIntervalFn(callback, delay) {
      assert.ok(delay >= 4_000 && delay < 5_000, "grant-specific jitter must preserve the five-second revocation SLA");
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
  viewer.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, language: "ko" }));
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

test("VIEWER subscriptions receive captions and status without translated audio or audio backpressure", async (context) => {
  let slowConsumerChecks = 0;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() { throw new Error("unused"); },
    slowConsumerPredicate() { slowConsumerChecks += 1; return false; },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const address = gateway.server.address();
  const url = `ws://127.0.0.1:${address.port}/live`;
  const viewer = new WebSocket(url);
  context.after(() => viewer.terminate());
  await once(viewer, "open");
  let received = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "authenticate", token: signViewerToken("viewer-secret", "caption-only") }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, language: "ko" }));
  assert.equal((await received).type, "subscribed");

  const messages = [];
  let resolveEvents;
  const eventsReceived = new Promise((resolve) => { resolveEvents = resolve; });
  viewer.on("message", (data, isBinary) => {
    messages.push({ data, isBinary });
    if (messages.length === 2) resolveEvents();
  });
  await gateway.broadcastEvent(SESSION_ID, "ko", {
    type: "caption", sessionId: SESSION_ID, language: "ko", text: "번역 자막", isFinal: true,
  });
  await gateway.broadcastEvent(SESSION_ID, "ko", {
    type: "session-status", sessionId: SESSION_ID, status: "live",
  });
  await eventsReceived;
  assert.deepEqual(messages.map(({ data, isBinary }) => ({
    isBinary,
    type: isBinary ? null : JSON.parse(data.toString("utf8")).payload.type,
  })), [
    { isBinary: false, type: "caption" },
    { isBinary: false, type: "session-status" },
  ]);

  assert.equal(gateway.broadcastAudio, undefined, "translated audio has no gateway fanout surface");
  assert.equal(slowConsumerChecks, 2, "caption and status delivery run the JSON backpressure checks");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.some(({ isBinary }) => isBinary), false);
  assert.equal(viewer.readyState, WebSocket.OPEN);
  assert.doesNotMatch(gateway.metrics.render(), /realtime_noel_slow_consumers_terminated_total 1/u);
});

test("HOST start is denied before pipeline creation when the database configuration differs", async (context) => {
  let factoryCalls = 0;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return false; } },
    async pipelineFactory() { factoryCalls += 1; throw new Error("must not run"); },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  const reply = nextJson(host);
  host.send(JSON.stringify({
    type: "start", sessionId: SESSION_ID, version: 3,
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
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { authorizeCalls += 1; return authorizeCalls === 1; } },
    async pipelineFactory() { return candidate; },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  const reply = nextJson(host);
  host.send(JSON.stringify({
    type: "start", sessionId: SESSION_ID, version: 3,
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
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize(_claims, _settings, options) { authorizeCalls += 1; return options.compareVersion; } },
    setHostLeaseIntervalFn(callback, delay) { assert.equal(delay, 2_500); leaseCallback = callback; return { lease: true }; },
    clearHostLeaseIntervalFn() {},
    async pipelineFactory() { return pipeline; },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(`ws://127.0.0.1:${gateway.server.address().port}/live`);
  context.after(() => host.terminate());
  const started = nextJsonMatching(host, (message) => message.type === "started");
  const floorSnapshot = nextJsonMatching(host, (message) => message.type === "floor");
  host.send(JSON.stringify({
    type: "start", sessionId: SESSION_ID, version: 1,
    mode: "presentation", voiceOutputMode: "captions", languages: ["en"],
  }));
  assert.equal((await started).type, "started");
  assert.equal((await floorSnapshot).holder, null);
  assert.equal(typeof leaseCallback, "function");
  const revoked = nextJsonMatching(host, (message) => message.code === "SESSION_REVOKED");
  leaseCallback();
  assert.equal((await revoked).code, "SESSION_REVOKED");
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
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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
  const started = nextJsonMatching(host, (message) => message.type === "started");
  const floorSnapshot = nextJsonMatching(host, (message) => message.type === "floor");
  host.send(JSON.stringify({
    type: "start", sessionId: SESSION_ID, version: 1,
    mode: "presentation", voiceOutputMode: "captions", languages: ["en"],
  }));
  assert.equal((await started).type, "started");
  assert.equal((await floorSnapshot).holder, null);
  leaseCallback();
  while (authorizeCalls < 3) await new Promise((resolve) => setImmediate(resolve));
  const leaseTimeout = timers.find((timer) => timer.delay === 2_500 && !timer.cancelled);
  assert.ok(leaseTimeout, "2.5초 주기와 2.5초 제한의 합이 최대 5초여야 합니다.");
  const revoked = nextJsonMatching(host, (message) => message.code === "SESSION_REVOKED");
  leaseTimeout.callback();
  assert.equal((await revoked).code, "SESSION_REVOKED");
});

test("an aborted old HOST lease cannot close a successfully swapped pipeline", async (context) => {
  const leaseCallbacks = [];
  let authorizationCalls = 0;
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
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
  const started = nextJsonMatching(host, (message) => message.type === "started");
  const initialFloor = nextJsonMatching(host, (message) => message.type === "floor");
  host.send(JSON.stringify({
    type: "start", sessionId: SESSION_ID, version: 1,
    mode: "presentation", voiceOutputMode: "captions", languages: ["en"],
  }));
  assert.equal((await started).type, "started");
  assert.equal((await initialFloor).holder, null);
  leaseCallbacks[0]();
  while (authorizationCalls < 3) await new Promise((resolve) => setImmediate(resolve));

  const updated = nextJsonMatching(host, (message) => message.type === "updated");
  host.send(JSON.stringify({
    type: "update", sessionId: SESSION_ID, version: 2,
    mode: "meeting", voiceOutputMode: "captions", languages: ["ko"],
  }));
  assert.equal((await updated).type, "updated");
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
    viewerAuthorizer: {
      async authorize() { authorizeCalls += 1; return authorizeCalls < 2; },
      async authorizeBatch(requests) {
        authorizeCalls += 1;
        return new Map(requests.map(({ key }) => [key, authorizeCalls < 2]));
      },
    },
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
  viewer.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, language: "ko" }));
  assert.equal((await received).type, "subscribed");

  received = nextJson(viewer);
  await gateway.broadcastEvent(SESSION_ID, "ko", { type: "caption", seq: 1, text: "공유 자막" });
  assert.deepEqual(await received, {
    type: "live-event",
    payload: { type: "caption", seq: 1, text: "공유 자막" },
  });
  const legend = { type: "speaker-legend", speakers: [{ speakerId: "speaker-1", voiceStatus: "ready" }] };
  received = nextJson(viewer);
  await gateway.broadcastEvent(SESSION_ID, "ko", legend);
  assert.deepEqual(await received, { type: "live-event", payload: legend });

  clock += 5_000;
  received = nextJson(viewer);
  await gateway.broadcastEvent(SESSION_ID, "ko", { type: "caption", seq: 2, text: "차단" });
  assert.equal((await received).code, "GRANT_REVOKED");
  assert.equal(authorizeCalls, 2);
});

test("host handover with the SAME activation key reattaches warm; a different key restarts cold", { timeout: 5_000 }, async (context) => {
  const pipelines = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: {
      async authorize(_claims, _settings, options) {
        if (options.readinessStart) return { readinessMode: "resume-live", pinnedGlossaryFingerprint: null };
        return true;
      },
      // The gateway records state.activationKey only for readiness-capable
      // authorizers (production Supabase authorizer is one). resume-live never
      // invokes activate, so the stub only needs to exist.
      async activate() { throw new Error("CAS_MUST_NOT_RUN"); },
    },
    async pipelineFactory() {
      const pipeline = {
        closed: 0,
        async start() {}, async tick() {}, async acceptAudio() {},
        async endAudioStream() {}, async close() { this.closed += 1; },
      };
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const url = `ws://127.0.0.1:${gateway.server.address().port}/live`;
  const activationKey = "33333333-3333-4333-8333-333333333333";
  const settings = {
    sessionId: SESSION_ID, version: 4,
    sessionType: "presentation", outputMode: "captions", languages: ["ko", "en"],
  };

  // Web host activates the session with the server-owned activation key.
  const webHost = await connectHost(url);
  context.after(() => webHost.terminate());
  let reply = nextJsonMatching(webHost, (message) => message.type === "started" || message.type === "error");
  webHost.send(JSON.stringify({ type: "start", activationKey, ...settings }));
  assert.equal((await reply).type, "started");
  assert.equal(pipelines.length, 1);

  // Desktop takeover presents the SAME key it read from the session API: the
  // gateway reattaches the live pipeline and 4410s the web socket.
  const webHostClosed = once(webHost, "close");
  const desktopHost = await connectHost(url);
  context.after(() => desktopHost.terminate());
  reply = nextJsonMatching(desktopHost, (message) => message.type === "started" || message.type === "error");
  desktopHost.send(JSON.stringify({ type: "start", activationKey, ...settings, version: 5 }));
  assert.equal((await reply).type, "started");
  const [closeCode] = await webHostClosed;
  assert.equal(closeCode, 4410, "the replaced host learns it was taken over");
  assert.equal(pipelines.length, 1, "same-key handover must keep the live pipeline warm");
  assert.equal(pipelines[0].closed, 0);

  // A takeover with a DIFFERENT key cannot prove epoch identity: cold restart.
  const strangerHost = await connectHost(url);
  context.after(() => strangerHost.terminate());
  reply = nextJsonMatching(strangerHost, (message) => message.type === "started" || message.type === "error");
  strangerHost.send(JSON.stringify({
    type: "start", activationKey: "44444444-4444-4444-8444-444444444444", ...settings, version: 5,
  }));
  assert.equal((await reply).type, "started");
  assert.equal(pipelines.length, 2, "a mismatched key must build a fresh pipeline");
});
