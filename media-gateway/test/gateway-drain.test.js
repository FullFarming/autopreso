import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { createGatewayServer } from "../src/gateway-server.js";

const SESSION = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const tick = () => new Promise((resolve) => setTimeout(resolve, 8));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function waitFor(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.fail("gateway condition timed out"); }
function token(role) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ role, sub: OTHER, sessionId: SESSION,
    aud: role === "HOST" ? "media-gateway" : "live-gateway-viewer", iat: now, exp: now + 60,
    ...(role === "VIEWER" ? { grantId: OTHER, jti: randomUUID() } : {}),
  })).toString("base64url");
  return `${payload}.${createHmac("sha256", role === "HOST" ? "host-secret" : "viewer-secret").update(payload).digest("hex")}`;
}
async function setup(t, { acceptAudio = async () => {}, drain = async () => {}, ...overrides } = {}) {
  const calls = { audio: 0, drain: 0, close: 0, abort: 0, resume: 0, pause: 0, start: 0, floorTake: 0 };
  const timers = new Map();
  const gateway = createGatewayServer({ gatewaySecret: "host-secret", viewerSecret: "viewer-secret", hostReconnectGraceMilliseconds: 0,
    maxSessionAudioBytes: 1280,
    setTimeoutFn(callback, ms) { const id = setTimeout(callback, ms); timers.set(id, { callback, ms }); return id; },
    clearTimeoutFn(id) { timers.delete(id); clearTimeout(id); },
    hostAuthorizer: { async authorize() { return true; } },
    viewerAuthorizer: { async authorize() { return true; }, async authorizeSpeaking() { return true; },
      async authorizeBatch(rows) { return new Map(rows.map(({ key }) => [key, true])); } },
    floorController: { async take() { calls.floorTake++; return { ok: true, participantId: OTHER, displayName: "fixture" }; }, async release() {} },
    async pipelineFactory() { return { async start() { calls.start++; }, async tick() {},
      async acceptAudio(...args) { calls.audio++; await acceptAudio(...args); },
      async gracefulDrain(options) { assert.equal(options.timeoutMilliseconds, 10000); calls.drain++; await drain(); },
      async close() { calls.close++; }, abortMedia() { calls.abort++; },
      async pause() { calls.pause++; }, async resume() { calls.resume++; }, setFloorSpeaker() {} }; },
    ...overrides,
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const sockets = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); await gateway.close(); for (const id of timers.keys()) clearTimeout(id); });
  async function connect(role = "HOST") {
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.server.address().port}/live`), events = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()))); sockets.push(socket);
    await once(socket, "open"); socket.send(JSON.stringify({ type: "authenticate", token: token(role) }));
    await waitFor(() => events.some((event) => event.type === "authenticated"));
    return { socket, events, send(message) { socket.send(JSON.stringify(message)); } };
  }
  const host = await connect();
  host.send({ type: "start", sessionId: SESSION, version: 1, sessionType: "meeting", outputMode: "captions", languages: ["en"] });
  await waitFor(() => host.events.some((event) => event.type === "floor"));
  return { host, connect, calls, timers, gateway };
}

test("drain waits for admitted PCM and durable source, drops new frames before budget, and deduplicates requests", { timeout: 4000 }, async (t) => {
  const audio = deferred(), source = deferred();
  t.after(() => { audio.resolve(); source.resolve(); });
  const h = await setup(t, { acceptAudio: () => audio.promise, drain: () => source.promise });
  h.host.socket.send(Buffer.alloc(1280)); await waitFor(() => h.calls.audio === 1);
  h.host.send({ type: "drain", sessionId: SESSION });
  h.host.send({ type: "drain", sessionId: SESSION });
  h.host.socket.send(Buffer.alloc(1280)); await tick();
  assert.equal(h.host.socket.readyState, WebSocket.OPEN); assert.equal(h.calls.drain, 0);
  assert.equal(h.host.events.filter((event) => event.type === "drained").length, 0);
  audio.resolve(); await waitFor(() => h.calls.drain === 1);
  h.host.send({ type: "resume", sessionId: SESSION }); await tick(); assert.equal(h.calls.resume, 0);
  assert.equal(h.host.events.filter((event) => event.type === "drained").length, 0);
  source.resolve(); await waitFor(() => h.host.events.filter((event) => event.type === "drained").length === 2);
  h.host.send({ type: "drain", sessionId: SESSION }); await waitFor(() => h.host.events.filter((event) => event.type === "drained").length === 3);
  assert.equal(h.calls.drain, 1); assert.equal(h.calls.audio, 1);
  h.host.send({ type: "stop", sessionId: SESSION }); await waitFor(() => h.host.events.some((event) => event.type === "stopped"));
  assert.equal(h.calls.close, 1); assert.equal(h.calls.drain, 1);
});

test("a different authenticated socket or session cannot drain the current owner", { timeout: 3000 }, async (t) => {
  const h = await setup(t); const other = await h.connect();
  other.send({ type: "drain", sessionId: SESSION }); await waitFor(() => other.events.some((event) => event.type === "error"));
  assert.equal(h.calls.drain, 0); assert.equal(h.calls.close, 0);
  h.host.send({ type: "drain", sessionId: OTHER }); await waitFor(() => h.host.events.some((event) => event.type === "error"));
  assert.equal(h.calls.drain, 0); assert.equal(h.calls.abort, 0);
});

test("drain failure reports a safe error without a success ACK or automatic provider restart", { timeout: 3000 }, async (t) => {
  const h = await setup(t, { drain: async () => { throw new Error("private provider payload"); } });
  h.host.send({ type: "drain", sessionId: SESSION }); await waitFor(() => h.host.events.some((event) => event.code === "MEDIA_DRAIN_FAILED"));
  const error = h.host.events.find((event) => event.code === "MEDIA_DRAIN_FAILED");
  assert.equal(error.requiresManualRestart, true); assert.equal(error.sessionId, SESSION);
  assert.doesNotMatch(JSON.stringify(h.host.events), /private provider payload/u);
  assert.equal(h.host.events.some((event) => event.type === "drained"), false);
  assert.equal(h.calls.abort, 1); assert.equal(h.calls.close, 1);
  h.host.send({ type: "start", sessionId: SESSION, version: 1, sessionType: "meeting", languages: ["en"] });
  await waitFor(() => h.host.events.some((event) => event.code === "PIPELINE_RESTART_REQUIRED"));
  assert.equal(h.calls.start, 1);
});

test("the ten second drain deadline aborts and cleans the provider without a late ACK", { timeout: 3000 }, async (t) => {
  const source = deferred(); t.after(() => source.resolve());
  const h = await setup(t, { drain: () => source.promise });
  h.host.send({ type: "drain", sessionId: SESSION }); await waitFor(() => h.calls.drain === 1);
  for (const { callback, ms } of [...h.timers.values()]) if (ms === 10000) callback();
  await waitFor(() => h.host.events.some((event) => event.code === "MEDIA_DRAIN_TIMEOUT"));
  source.resolve(); await tick();
  assert.equal(h.calls.abort, 1); assert.equal(h.calls.close, 1);
  assert.equal(h.host.events.some((event) => event.type === "drained"), false);
});

test("participant PCM already accepted drains first and no new floor or audio resumes while draining", { timeout: 4000 }, async (t) => {
  const audio = deferred(), source = deferred(); t.after(() => { audio.resolve(); source.resolve(); });
  const h = await setup(t, { acceptAudio: () => audio.promise, drain: () => source.promise });
  const viewer = await h.connect("VIEWER");
  viewer.send({ type: "subscribe", sessionId: SESSION, language: "en" });
  await waitFor(() => viewer.events.some((event) => event.type === "subscribed"));
  viewer.send({ type: "speak-start", sessionId: SESSION }); await waitFor(() => viewer.events.some((event) => event.type === "speak-started"));
  viewer.socket.send(Buffer.alloc(1280)); await waitFor(() => h.calls.audio === 1);
  h.host.send({ type: "drain", sessionId: SESSION }); viewer.socket.send(Buffer.alloc(1280)); await tick();
  assert.equal(h.calls.drain, 0); assert.equal(viewer.socket.readyState, WebSocket.OPEN);
  viewer.send({ type: "speak-start", sessionId: SESSION }); h.host.send({ type: "host-speak", sessionId: SESSION });
  await tick(); assert.equal(h.calls.floorTake, 1);
  audio.resolve(); await waitFor(() => h.calls.drain === 1); source.resolve();
  await waitFor(() => h.host.events.some((event) => event.type === "drained"));
  assert.equal(h.calls.audio, 1);
});

test("an admitted audio failure cannot deadlock drain against the host cleanup lock", { timeout: 3000 }, async (t) => {
  const audio = deferred(); t.after(() => audio.resolve());
  const h = await setup(t, { acceptAudio: async () => { await audio.promise; throw new Error("synthetic audio failure"); } });
  h.host.socket.send(Buffer.alloc(1280)); await waitFor(() => h.calls.audio === 1);
  h.host.send({ type: "drain", sessionId: SESSION }); await tick(); audio.resolve();
  await waitFor(() => h.calls.close === 1);
  assert.equal(h.calls.drain, 0);
  assert.equal(h.host.events.some((event) => event.type === "drained"), false);
});
