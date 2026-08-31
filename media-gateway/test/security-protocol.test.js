import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { verifyLiveToken } from "../src/token-verifier.js";
import { ViewerTicketReplayGuard } from "../src/viewer-ticket-replay-guard.js";

function sign(claims, secret) {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

test("gateway tokens are audience-bound, time-limited, and tamper evident", () => {
  const now = Date.UTC(2026, 6, 19);
  const token = sign({ role: "HOST", sub: "host-1", sessionId: "s1", aud: "media-gateway", iat: now / 1_000, exp: now / 1_000 + 900 }, "gateway-secret");
  assert.equal(verifyLiveToken(token, { gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret", now: () => now }).sessionId, "s1");
  assert.throws(() => verifyLiveToken(`${token.slice(0, -1)}0`, { gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret", now: () => now }), /UNAUTHORIZED/);
  assert.throws(() => verifyLiveToken(token, { gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret", now: () => now + 900_000 }), /UNAUTHORIZED/);
});

test("viewer WebSocket tickets require the exact short-lived audience-bound claim contract and reject legacy grants", () => {
  const now = Date.UTC(2026, 7, 22);
  const issuedAt = Math.floor(now / 1_000);
  const claims = {
    role: "VIEWER",
    sub: "11111111-1111-4111-8111-111111111111",
    grantId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    aud: "live-gateway-viewer",
    jti: "44444444-4444-4444-8444-444444444444",
    iat: issuedAt,
    exp: issuedAt + 60,
  };
  const dependencies = { gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret", now: () => now };

  assert.deepEqual(verifyLiveToken(sign(claims, "viewer-secret"), dependencies), {
    ...claims,
    userId: claims.sub,
  });
  assert.throws(() => verifyLiveToken(sign({
    role: "VIEWER",
    grantId: claims.grantId,
    sessionId: claims.sessionId,
    userId: claims.sub,
    issuedAt: now,
    expiresAt: now + 21_600_000,
  }, "viewer-secret"), dependencies), /UNAUTHORIZED/u);
  assert.throws(() => verifyLiveToken(sign({ ...claims, aud: "media-gateway" }, "viewer-secret"), dependencies), /UNAUTHORIZED/u);
  assert.throws(() => verifyLiveToken(sign({ ...claims, exp: issuedAt + 61 }, "viewer-secret"), dependencies), /UNAUTHORIZED/u);
  assert.throws(() => verifyLiveToken(sign({ ...claims, sessionId: "session-1" }, "viewer-secret"), dependencies), /UNAUTHORIZED/u);
  assert.throws(() => verifyLiveToken(sign({ ...claims, extra: true }, "viewer-secret"), dependencies), /UNAUTHORIZED/u);
});

test("viewer WebSocket tickets expired before authentication are rejected", () => {
  const now = Date.UTC(2026, 7, 22);
  const issuedAt = Math.floor(now / 1_000) - 60;
  const token = sign({
    role: "VIEWER",
    sub: "11111111-1111-4111-8111-111111111111",
    grantId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    aud: "live-gateway-viewer",
    jti: "44444444-4444-4444-8444-444444444444",
    iat: issuedAt,
    exp: issuedAt + 60,
  }, "viewer-secret");

  assert.throws(() => verifyLiveToken(token, {
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    now: () => now,
  }), /UNAUTHORIZED/u);
});

test("signed non-object token payloads fail with the public unauthorized contract", () => {
  assert.throws(() => verifyLiveToken(sign(null, "viewer-secret"), {
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
  }), /^Error: UNAUTHORIZED$/u);
});

test("viewer ticket replay guard consumes once, expires entries, and fails closed at capacity", () => {
  let now = Date.UTC(2026, 7, 22);
  const guard = new ViewerTicketReplayGuard({ now: () => now, maxEntries: 1 });
  const first = { jti: "first-ticket-identifier", exp: Math.floor(now / 1_000) + 60 };

  assert.equal(guard.consume(first), true);
  assert.equal(guard.consume(first), false);
  assert.throws(() => guard.consume({
    jti: "second-ticket-identifier",
    exp: Math.floor(now / 1_000) + 60,
  }), /VIEWER_TICKET_CAPACITY/u);

  now += 61_000;
  assert.equal(guard.consume({
    jti: "second-ticket-identifier",
    exp: Math.floor(now / 1_000) + 60,
  }), true);
  assert.equal(guard.size, 1);
});
