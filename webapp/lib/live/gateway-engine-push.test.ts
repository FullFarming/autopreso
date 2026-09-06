import assert from "node:assert/strict";
import test from "node:test";

import { ADMIN_GATEWAY_TOKEN_TTL_MS, createAdminGatewayToken, verifyGatewayToken } from "../auth/live-auth";
import { verifyAdminGatewayToken } from "../../../media-gateway/src/token-verifier.js";
import { LIVE_GATEWAY_TOKEN_SECRET } from "../security/config";
import { DEFAULT_ENGINE_SELECTION } from "../../../packages/caption-core/caption-engine-catalog.js";
import { getGatewayEngineEndpoint, pushEngineToGateway } from "./gateway-engine-push";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ENGINE = { ...DEFAULT_ENGINE_SELECTION, translation: { provider: "gemini", model: "gemini-3.7-flash" } };

test("admin gateway token is role ADMIN, session-bound, 60 s, and verified by the gateway but never as a HOST token", async () => {
  const now = Date.UTC(2026, 8, 5, 0, 0, 0);
  const { token, claims } = await createAdminGatewayToken({ hostId: "admin-1", sessionId: SESSION_ID, now });
  assert.deepEqual(claims, { role: "ADMIN", sub: "admin-1", sessionId: SESSION_ID, aud: "media-gateway", iat: now / 1000, exp: now / 1000 + 60 });
  assert.equal(ADMIN_GATEWAY_TOKEN_TTL_MS, 60_000);
  const verified = verifyAdminGatewayToken(token, { gatewaySecret: LIVE_GATEWAY_TOKEN_SECRET, now: () => now + 59_000, sessionId: SESSION_ID });
  assert.equal(verified.sub, "admin-1");
  assert.throws(() => verifyAdminGatewayToken(token, { gatewaySecret: LIVE_GATEWAY_TOKEN_SECRET, now: () => now + 60_000, sessionId: SESSION_ID }), /ADMIN_TOKEN_INVALID/u);
  assert.throws(() => verifyAdminGatewayToken(token, { gatewaySecret: LIVE_GATEWAY_TOKEN_SECRET, now: () => now, sessionId: "11111111-1111-4111-8111-111111111112" }), /ADMIN_TOKEN_INVALID/u);
  assert.throws(() => verifyAdminGatewayToken(token, { gatewaySecret: "other-secret", now: () => now, sessionId: SESSION_ID }), /ADMIN_TOKEN_INVALID/u);
  await assert.rejects(() => verifyGatewayToken(token, now), /올바르지/u);
  await assert.rejects(() => createAdminGatewayToken({ hostId: "", sessionId: SESSION_ID, now }));
});

test("engine endpoint derives the HTTP origin from the WS gateway URL and refuses anything else", () => {
  assert.equal(getGatewayEngineEndpoint("wss://gateway.example.run.app/live", SESSION_ID), `https://gateway.example.run.app/internal/sessions/${SESSION_ID}/engine`);
  assert.equal(getGatewayEngineEndpoint("ws://127.0.0.1:8080/live", SESSION_ID), `http://127.0.0.1:8080/internal/sessions/${SESSION_ID}/engine`);
  for (const value of ["https://gateway.example.run.app/live", "wss://user:pw@gateway.example.run.app/live", "wss://gateway.example.run.app/live?x=1", "wss://gateway.example.run.app/live#frag", "not a url"]) {
    assert.throws(() => getGatewayEngineEndpoint(value, SESSION_ID), /INVALID_LIVE_GATEWAY_URL/u, value);
  }
  assert.throws(() => getGatewayEngineEndpoint("wss://gateway.example.run.app/live", "../health"), /INVALID_SESSION_ID/u);
});

test("pushEngineToGateway returns the gateway verdict, sends the bearer token once, and never throws", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const respond = (status: number, body: unknown) => async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  const base = { gatewayUrl: "wss://gateway.example.run.app/live", sessionId: SESSION_ID, engine: ENGINE, token: ["fixture", "admin", "token"].join("-") };

  assert.deepEqual(await pushEngineToGateway({ ...base, fetchFn: respond(200, { result: "switched" }) }), { result: "switched" });
  assert.deepEqual(await pushEngineToGateway({ ...base, fetchFn: respond(200, { result: "queued" }) }), { result: "queued" });
  assert.deepEqual(await pushEngineToGateway({ ...base, fetchFn: respond(401, { result: "failed", code: "ADMIN_TOKEN_INVALID" }) }), { result: "failed", code: "ADMIN_TOKEN_INVALID" });
  assert.deepEqual(await pushEngineToGateway({ ...base, fetchFn: respond(409, { result: "failed", code: "STT_PROVIDER_UNAVAILABLE" }) }), { result: "failed", code: "STT_PROVIDER_UNAVAILABLE" });
  assert.deepEqual(await pushEngineToGateway({ ...base, fetchFn: respond(429, { result: "failed", code: "ENGINE_SWITCH_RATE_LIMITED" }) }), { result: "failed", code: "ENGINE_SWITCH_RATE_LIMITED" });
  assert.deepEqual(await pushEngineToGateway({ ...base, fetchFn: respond(502, null) }), { result: "failed", code: "GATEWAY_HTTP_502" });
  assert.deepEqual(await pushEngineToGateway({ ...base, fetchFn: respond(200, { result: "hacked", code: "x" }) }), { result: "failed", code: "INVALID_GATEWAY_RESPONSE" });
  assert.deepEqual(await pushEngineToGateway({ ...base, fetchFn: respond(200, { result: "failed", code: "not a code" }) }), { result: "failed", code: "INVALID_GATEWAY_RESPONSE" });
  assert.deepEqual(await pushEngineToGateway({ ...base, fetchFn: async () => { throw new TypeError("fetch failed"); } }), { result: "failed", code: "GATEWAY_UNREACHABLE" });
  assert.deepEqual(await pushEngineToGateway({ ...base, gatewayUrl: "https://gateway.example.run.app/live", fetchFn: respond(200, { result: "switched" }) }), { result: "failed", code: "INVALID_LIVE_GATEWAY_URL" });
  assert.deepEqual(await pushEngineToGateway({ ...base, token: "", fetchFn: respond(200, { result: "switched" }) }), { result: "failed", code: "ADMIN_TOKEN_MISSING" });

  const timedOut = await pushEngineToGateway({ ...base, timeoutMs: 5, fetchFn: (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
  }) });
  assert.deepEqual(timedOut, { result: "failed", code: "GATEWAY_TIMEOUT" });

  assert.equal(seen.length, 8, "the invalid URL and the missing token never reach the network");
  for (const { url, init } of seen) {
    assert.equal(url, `https://gateway.example.run.app/internal/sessions/${SESSION_ID}/engine`);
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "manual");
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer fixture-admin-token");
    assert.deepEqual(JSON.parse(String(init.body)), { engine: ENGINE });
  }
});
