import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

import { WebSocket } from "ws";

import {
  ParticipantProfileCache,
  ViewerAuthorizationLeaseManager,
  createGatewayServer,
} from "../src/gateway-server.js";
import { ViewerAuthorizationBatcher } from "../src/viewer-authorization-batcher.js";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function fixtureUuid(value) {
  const digest = createHash("sha256").update(value).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function signViewerToken(secret, grantId, now = Date.now()) {
  const issuedAt = Math.floor(now / 1_000);
  const grantUuid = fixtureUuid(grantId);
  const claims = {
    role: "VIEWER",
    sub: grantUuid,
    grantId: grantUuid,
    sessionId: SESSION_ID,
    aud: "live-gateway-viewer",
    jti: `ticket-${createHash("sha256").update(grantId).digest("hex")}`,
    iat: issuedAt,
    exp: issuedAt + 60,
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

async function nextJson(webSocket) {
  const [data] = await once(webSocket, "message");
  return JSON.parse(data.toString("utf8"));
}

async function connectViewer(port, grantId) {
  const webSocket = new WebSocket(`ws://127.0.0.1:${port}/live`);
  await once(webSocket, "open");
  let received = nextJson(webSocket);
  webSocket.send(JSON.stringify({ type: "authenticate", token: signViewerToken("viewer-secret", grantId) }));
  assert.equal((await received).type, "authenticated");
  received = nextJson(webSocket);
  webSocket.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, language: "ko" }));
  assert.equal((await received).type, "subscribed");
  return webSocket;
}

test("viewer authorization leases dedupe a grant and cap a 50-viewer authorization herd", async () => {
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const releases = [];
  const manager = new ViewerAuthorizationLeaseManager({
    maxConcurrent: 4,
    now: () => 1_000,
    authorize: async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return true;
    },
  });
  const claims = Array.from({ length: 50 }, (_, index) => ({
    role: "VIEWER",
    sessionId: "session-1",
    grantId: `grant-${index}`,
    userId: `user-${index}`,
  }));
  const checks = claims.map((claim) => manager.authorize(claim, "session-1", "ko"));
  const duplicate = manager.authorize(claims[0], "session-1", "ko");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 4);
  assert.equal(maximumActive, 4);
  while (releases.length > 0 || active > 0) {
    releases.splice(0).forEach((release) => release());
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(await duplicate, true);
  assert.equal((await Promise.all(checks)).every(Boolean), true);
  assert.equal(calls, 50, "the duplicate socket must share its grant lease flight");
  assert.equal(maximumActive, 4);
});

test("viewer authorization leases drain 200 due grants through four bounded batches", async () => {
  let batchCalls = 0;
  const batcher = new ViewerAuthorizationBatcher({
    maxBatchSize: 50,
    async authorizeBatch(requests) {
      batchCalls += 1;
      return new Map(requests.map(({ key }) => [key, true]));
    },
  });
  const manager = new ViewerAuthorizationLeaseManager({
    authorize: async () => { throw new Error("per-grant fallback must remain unreachable"); },
    batchAuthorize: (request, options) => batcher.authorize(request, options),
    now: () => 1_000,
  });
  const checks = Array.from({ length: 200 }, (_, index) => manager.authorize({
    role: "VIEWER",
    sessionId: "session-1",
    grantId: `grant-${index}`,
    userId: `user-${index}`,
  }, "session-1", "ko"));

  assert.equal((await Promise.all(checks)).every(Boolean), true);
  assert.equal(batchCalls, 4);
});

test("viewer authorization leases fail closed on a session fence mismatch", async () => {
  let calls = 0;
  const manager = new ViewerAuthorizationLeaseManager({
    authorize: async () => { calls += 1; return true; },
    now: () => 1_000,
  });
  const claim = { role: "VIEWER", sessionId: "session-1", grantId: "grant-1", userId: "user-1" };
  assert.equal(await manager.authorize(claim, "session-2", "ko"), false);
  assert.equal(calls, 0);
});

test("viewer authorization leases evict least-recently-used grants at the hard capacity", async () => {
  let calls = 0;
  const manager = new ViewerAuthorizationLeaseManager({
    authorize: async () => { calls += 1; return true; },
    now: () => 1_000,
    maxEntries: 2,
  });
  const claim = (grantId) => ({ role: "VIEWER", sessionId: "session-1", grantId, userId: grantId });
  await manager.authorize(claim("grant-1"), "session-1", "ko");
  await manager.authorize(claim("grant-2"), "session-1", "ko");
  await manager.authorize(claim("grant-3"), "session-1", "ko");
  assert.equal(manager.size, 2);
  await manager.authorize(claim("grant-1"), "session-1", "ko");
  assert.equal(calls, 4);
  assert.equal(manager.size, 2);
});

test("participant profile cache bounds positive and negative entries and evicts one session exactly", () => {
  let clock = 1_000;
  const cache = new ParticipantProfileCache({ maxEntries: 10_000, ttlMilliseconds: 60_000, now: () => clock });
  for (let index = 0; index < 10_001; index += 1) {
    cache.set("session-1", `participant-${index}`, index % 2 === 0 ? { displayName: `Person ${index}` } : null);
  }
  cache.set("session-2", "participant-kept", { displayName: "Kept" });
  assert.equal(cache.size, 10_000);
  assert.equal(cache.get("session-1", "participant-0").hit, false);
  assert.equal(cache.get("session-2", "participant-kept").hit, true);
  cache.deleteSession("session-1");
  assert.equal(cache.size, 1);
  clock += 60_001;
  assert.equal(cache.get("session-2", "participant-kept").hit, false);
  assert.equal(cache.size, 0);
});

test("JSON fanout to 200 viewers serializes once, drops slow partials, and closes slow finals", async (context) => {
  let serializations = 0;
  let isSlow = false;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return true; } },
    async pipelineFactory() { throw new Error("unused"); },
    slowConsumerPredicate() { return isSlow; },
    serializeJson(value) { serializations += 1; return JSON.stringify(value); },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const viewers = await Promise.all(Array.from(
    { length: 200 },
    (_, index) => connectViewer(port, `grant-${index}`),
  ));
  context.after(() => viewers.forEach((viewer) => viewer.terminate()));

  serializations = 0;
  const messages = viewers.map((viewer) => nextJson(viewer));
  await gateway.broadcastEvent(SESSION_ID, "ko", { type: "caption", seq: 1, isFinal: true, text: "final" });
  assert.equal(serializations, 1);
  assert.equal((await Promise.all(messages)).every((message) => message.payload.text === "final"), true);

  isSlow = true;
  await gateway.broadcastEvent(SESSION_ID, "ko", { type: "caption", seq: 2, isFinal: false, text: "partial" });
  assert.match(gateway.metrics.render(), /json_partials_dropped_total 200/u);
  assert.equal(viewers.every((viewer) => viewer.readyState === WebSocket.OPEN), true);

  const errors = viewers.map((viewer) => nextJson(viewer));
  await gateway.broadcastEvent(SESSION_ID, "ko", { type: "caption", seq: 2, isFinal: true, text: "final-2" });
  assert.equal((await Promise.all(errors)).every((message) => message.code === "SLOW_CONSUMER"), true);
});
