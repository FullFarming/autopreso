import assert from "node:assert/strict";
import test from "node:test";
import { createHostSessionClient } from "./host-session-client";

const now = Date.parse("2026-08-31T12:00:00Z");
const day = 86_400_000;
const reply = (days = 30) => new Response(JSON.stringify({ ok: true, data: { userId: "operator", expiresAt: new Date(now + days * day).toISOString() } }), { status: 200 });

test("host session reuse deduplicates focus checks and never posts credentials", async () => {
  const requests: Array<[string, string]> = [];
  const client = createHostSessionClient(async (url, options) => { requests.push([url, options.method!]); return reply(); }, () => now);
  const [first, second] = await Promise.all([client.synchronize(), client.synchronize()]);
  assert.equal(first.kind, "authenticated");
  assert.equal(second.kind, "authenticated");
  await client.synchronize();
  assert.deepEqual(requests, [["/api/auth/session", "GET"]]);
});

test("refresh is only performed inside seven days and skips unextendable absolute-expiry sessions", async () => {
  let time = now;
  const methods: string[] = [];
  const client = createHostSessionClient(async (_url, options) => { methods.push(options.method!); return reply(6); }, () => time);
  assert.equal((await client.synchronize()).kind, "authenticated");
  time += 300_001;
  assert.equal((await client.synchronize()).kind, "authenticated");
  assert.deepEqual(methods, ["GET", "POST", "GET"]);
});

test("logout settles an in-flight refresh before clearing cookies and blocks new refresh work", async () => {
  let releaseRefresh: (() => void) | undefined;
  let enteredRefresh: (() => void) | undefined;
  const started = new Promise<void>(resolve => { enteredRefresh = resolve; });
  const pending = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const requests: string[] = [];
  const client = createHostSessionClient(async (url, options) => {
    requests.push(`${options.method} ${url}`);
    if (url === "/api/logout") return new Response('{"ok":true}');
    if (options.method === "POST") { enteredRefresh!(); await pending; return reply(); }
    return reply(6);
  }, () => now);
  const refresh = client.synchronize();
  await started;
  const logout = client.logout();
  assert.equal((await client.synchronize()).kind, "signed-out");
  assert.equal(requests.includes("POST /api/logout"), false);
  releaseRefresh!();
  await Promise.all([refresh, logout]);
  assert.deepEqual(requests, ["GET /api/auth/session", "POST /api/auth/session", "POST /api/logout"]);
  assert.equal((await client.synchronize()).kind, "signed-out");
});

test("network failures keep cookies untouched and a user-triggered check can recover", async () => {
  let calls = 0;
  const client = createHostSessionClient(async () => { if (++calls === 1) throw new Error("offline"); return reply(); }, () => now);
  assert.equal((await client.synchronize()).kind, "unavailable");
  assert.equal((await client.synchronize()).kind, "authenticated");
  assert.equal(calls, 2);
});

test("invalid server metadata fails closed and a denied cookie cannot be refreshed", async () => {
  for (const data of [null, {}, { userId: "operator", expiresAt: "invalid" }, { userId: "operator", expiresAt: new Date(now - 1).toISOString() }]) {
    const client = createHostSessionClient(async () => new Response(JSON.stringify({ ok: true, data })), () => now);
    assert.equal((await client.synchronize()).kind, "unavailable");
  }
  let calls = 0;
  const client = createHostSessionClient(async () => { calls++; return new Response("{}", { status: 401 }); }, () => now);
  assert.equal((await client.synchronize()).kind, "signed-out");
  assert.equal(calls, 1);
});

test("failed logout is surfaced without restoring automatic session checks", async () => {
  const client = createHostSessionClient(async () => new Response("{}", { status: 503 }), () => now);
  await assert.rejects(client.logout(), /HOST_LOGOUT_UNAVAILABLE/u);
  assert.equal((await client.synchronize()).kind, "signed-out");
});
