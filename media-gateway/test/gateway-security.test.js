import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { GatewayConnectionLimiter } from "../src/gateway-connection-limiter.js";
import { GatewayMetrics } from "../src/metrics.js";
import {
  getOpaqueClientKey,
  isAllowedWebSocketUpgrade,
  isMetricsRequestAuthorized,
  readGatewaySecurityPolicy,
} from "../src/gateway-security.js";

function signToken(secret, claims) {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

function request(headers = {}, remoteAddress = "203.0.113.10") {
  return { headers, socket: { remoteAddress } };
}

const CLOUD_RUN_ENVIRONMENT = Object.freeze({
  K_SERVICE: "realtime-noel-media-gateway",
  K_REVISION: "realtime-noel-media-gateway-00023-8bk",
  K_CONFIGURATION: "realtime-noel-media-gateway",
  LIVE_GATEWAY_TRUST_GOOGLE_XFF_SUFFIX: "true",
});

test("production gateway policy fails closed on missing origins and metrics secret", () => {
  assert.throws(() => readGatewaySecurityPolicy({ NODE_ENV: "production" }), /ALLOWED_ORIGINS/u);
  assert.throws(() => readGatewaySecurityPolicy({
    NODE_ENV: "production",
    LIVE_GATEWAY_ALLOWED_ORIGINS: "https://portal.example.com",
    LIVE_GATEWAY_METRICS_TOKEN: "short",
  }), /32자/u);
});

test("gateway origin comparison is exact and rejects prefix, path, and port changes", () => {
  const policy = readGatewaySecurityPolicy({
    NODE_ENV: "production",
    LIVE_GATEWAY_ALLOWED_ORIGINS: "https://portal.example.com,chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    LIVE_GATEWAY_METRICS_TOKEN: "m".repeat(32),
  });
  const dependencies = { gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret" };
  assert.equal(isAllowedWebSocketUpgrade(request({ origin: "https://portal.example.com" }), policy, dependencies), true);
  assert.equal(isAllowedWebSocketUpgrade(request({ origin: "https://portal.example.com.evil.test" }), policy, dependencies), false);
  assert.equal(isAllowedWebSocketUpgrade(request({ origin: "https://portal.example.com:444" }), policy, dependencies), false);
  assert.equal(isAllowedWebSocketUpgrade(request({ origin: "https://portal.example.com/path" }), policy, dependencies), false);
  assert.equal(isAllowedWebSocketUpgrade(request({ origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }), policy, dependencies), true);
  assert.equal(isAllowedWebSocketUpgrade(request({}), policy, dependencies), false);
});

test("trusted desktop mode requires an explicit flag, marker, and valid short-lived HOST token", () => {
  const now = Date.UTC(2026, 6, 21);
  const hostToken = signToken("gateway-secret", {
    role: "HOST", sub: "host-1", sessionId: "session-1", aud: "media-gateway",
    iat: Math.floor(now / 1_000), exp: Math.floor(now / 1_000) + 60,
  });
  const headers = { authorization: `Bearer ${hostToken}`, "x-realtime-noel-client": "desktop-main" };
  const disabled = readGatewaySecurityPolicy({
    NODE_ENV: "production",
    LIVE_GATEWAY_ALLOWED_ORIGINS: "https://portal.example.com",
    LIVE_GATEWAY_METRICS_TOKEN: "m".repeat(32),
  });
  const enabled = readGatewaySecurityPolicy({
    NODE_ENV: "production",
    LIVE_GATEWAY_ALLOWED_ORIGINS: "https://portal.example.com",
    LIVE_GATEWAY_ALLOW_TRUSTED_NON_BROWSER: "true",
    LIVE_GATEWAY_METRICS_TOKEN: "m".repeat(32),
  });
  const dependencies = { gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret", now: () => now };
  assert.equal(isAllowedWebSocketUpgrade(request(headers), disabled, dependencies), false);
  assert.equal(isAllowedWebSocketUpgrade(request({ authorization: `Bearer ${hostToken}` }), enabled, dependencies), false);
  assert.equal(isAllowedWebSocketUpgrade(request(headers), enabled, dependencies), true);
  assert.equal(isAllowedWebSocketUpgrade(request({ ...headers, authorization: `Bearer ${hostToken}x` }), enabled, dependencies), false);
});

test("metrics authentication is exact and client bucket keys never contain the raw IP", () => {
  const token = "metrics-token-that-is-at-least-32-chars";
  assert.equal(isMetricsRequestAuthorized(request({ authorization: `Bearer ${token}` }), token), true);
  assert.equal(isMetricsRequestAuthorized(request({ authorization: `Bearer ${token}x` }), token), false);
  const key = getOpaqueClientKey(request({ "x-forwarded-for": "198.51.100.7" }), "gateway-secret");
  assert.match(key, /^[0-9a-f]{64}$/u);
  assert.equal(key.includes("198.51.100.7"), false);
});

test("connection bucket ignores attacker-controlled XFF prefixes and trusts only the Google proxy suffix", () => {
  const first = getOpaqueClientKey(request({
    "x-forwarded-for": "192.0.2.10, 198.51.100.7, 203.0.113.20",
  }, "10.0.0.4"), "gateway-secret", CLOUD_RUN_ENVIRONMENT);
  const spoofedPrefix = getOpaqueClientKey(request({
    "x-forwarded-for": "192.0.2.99, 198.51.100.7, 203.0.113.20",
  }, "10.0.0.4"), "gateway-secret", CLOUD_RUN_ENVIRONMENT);
  const differentClient = getOpaqueClientKey(request({
    "x-forwarded-for": "192.0.2.10, 198.51.100.8, 203.0.113.20",
  }, "10.0.0.4"), "gateway-secret", CLOUD_RUN_ENVIRONMENT);

  assert.equal(first, spoofedPrefix, "untrusted prefixes must not create fresh limiter buckets");
  assert.notEqual(first, differentClient, "the proxy-observed client IP must still separate callers");
});

test("connection bucket falls back to the peer when the trusted XFF suffix is incomplete or malformed", () => {
  const peerOnly = getOpaqueClientKey(request({}, "10.0.0.4"), "gateway-secret");
  const singleValue = getOpaqueClientKey(
    request({ "x-forwarded-for": "198.51.100.7" }, "10.0.0.4"),
    "gateway-secret",
    CLOUD_RUN_ENVIRONMENT,
  );
  const malformedSuffix = getOpaqueClientKey(request({
    "x-forwarded-for": "198.51.100.7, not-an-ip",
  }, "10.0.0.4"), "gateway-secret", CLOUD_RUN_ENVIRONMENT);

  assert.equal(singleValue, peerOnly);
  assert.equal(malformedSuffix, peerOnly);
});

test("connection bucket ignores forwarded headers unless the Google proxy contract is explicit", () => {
  const peerOnly = getOpaqueClientKey(request({}, "198.51.100.40"), "gateway-secret", {});
  const forwarded = request({
    "x-forwarded-for": "192.0.2.10, 198.51.100.7, 203.0.113.20",
  }, "198.51.100.40");
  const outsideCloudRun = getOpaqueClientKey(forwarded, "gateway-secret", {});
  const cloudRunWithoutExplicitProxy = getOpaqueClientKey(forwarded, "gateway-secret", {
    K_SERVICE: "gateway",
    K_REVISION: "gateway-1",
    K_CONFIGURATION: "gateway",
  });

  assert.equal(outsideCloudRun, peerOnly);
  assert.equal(cloudRunWithoutExplicitProxy, peerOnly);
});

test("connection limiter enforces total, per-client, and attempt-token limits with idempotent release", () => {
  let now = 0;
  const limiter = new GatewayConnectionLimiter({
    maxConnections: 2,
    maxConnectionsPerClient: 1,
    attemptsPerMinute: 2,
    maxClientBuckets: 2,
    now: () => now,
  });
  const releaseA = limiter.acquire("a");
  assert.equal(typeof releaseA, "function");
  assert.equal(limiter.acquire("a"), null);
  const releaseB = limiter.acquire("b");
  assert.equal(typeof releaseB, "function");
  assert.equal(limiter.acquire("c"), null);
  releaseA();
  releaseA();
  assert.equal(limiter.acquire("a"), null, "rejected simultaneous attempts still consume attempt tokens");
  now = 60_000;
  const nextA = limiter.acquire("a");
  assert.equal(typeof nextA, "function");
  nextA();
  releaseB();
});

test("metrics reject injected names and non-finite values", () => {
  const metrics = new GatewayMetrics();
  metrics.increment("connections_total");
  assert.throws(() => metrics.increment("bad\nmetric"), /INVALID_METRIC/u);
  assert.throws(() => metrics.set("host_sessions", Number.POSITIVE_INFINITY), /INVALID_METRIC/u);
  assert.equal(metrics.render(), "realtime_noel_connections_total 1\n");
});
