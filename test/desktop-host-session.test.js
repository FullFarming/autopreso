import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopHostSession, classifyDesktopLoginNavigation } from "../electron/desktop-host-session.js";

const origin = "https://workspace.example.test";
const sessionData = { userId: "host-test", expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() };
const signedIn = () => Response.json({ ok: true, data: sessionData });

test("parallel session reads share one cookie request and never submit a password", async () => {
  const calls = [];
  const manager = createDesktopHostSession({ baseUrl: origin, fetcher: async (url, options) => {
    calls.push({ url, options });
    return signedIn();
  } });
  const result = await Promise.all(Array.from({ length: 12 }, () => manager.ensureSession()));
  assert.equal(calls.length, 1);
  assert.ok(result.every((value) => value.ok));
  assert.equal(calls[0].url, `${origin}/api/auth/session`);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].options.body, undefined);
  await manager.ensureSession();
  assert.equal(calls.length, 1);
});

test("server Retry-After suppresses repeated requests, including forced login checks", async () => {
  let now = 1_000;
  let calls = 0;
  const manager = createDesktopHostSession({ baseUrl: origin, now: () => now, fetcher: async () => {
    calls++;
    return Response.json({ ok: false, code: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": "120" } });
  } });
  assert.equal((await manager.ensureSession()).retryAfterSeconds, 120);
  now += 10_000;
  assert.equal((await manager.ensureSession({ force: true })).retryAfterSeconds, 110);
  assert.equal(calls, 1);
  now += 111_000;
  await manager.ensureSession();
  assert.equal(calls, 2);
});

test("401 is explicit and repeated actions do not create a login loop", async () => {
  let calls = 0;
  const manager = createDesktopHostSession({ baseUrl: origin, fetcher: async () => {
    calls++;
    return Response.json({ ok: false }, { status: 401 });
  } });
  assert.equal((await manager.ensureSession()).code, "HOST_LOGIN_REQUIRED");
  assert.equal((await manager.ensureSession()).code, "HOST_LOGIN_REQUIRED");
  assert.equal(calls, 1);
  assert.equal((await manager.ensureSession({ force: true })).code, "HOST_LOGIN_REQUIRED");
  assert.equal(calls, 2);
});

test("expired or malformed successful responses never authorize the desktop", async () => {
  for (const data of [{ userId: "", expiresAt: sessionData.expiresAt }, { userId: "host-test", expiresAt: "invalid" }, { userId: "host-test", expiresAt: "2020-01-01T00:00:00Z" }]) {
    const manager = createDesktopHostSession({ baseUrl: origin, fetcher: async () => Response.json({ ok: true, data }) });
    assert.equal((await manager.ensureSession()).code, "INVALID_SESSION_RESPONSE");
  }
});

test("logout waits for an in-flight refresh before clearing cookies and cannot resurrect cached authentication", async () => {
  const requests = [];
  let cookie = "initial";
  /** @type {(() => void) | undefined} */
  let releaseRefresh;
  /** @type {(() => void) | undefined} */
  let markRefreshStarted;
  const refreshBarrier = new Promise((resolve) => { releaseRefresh = () => resolve(undefined); });
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = () => resolve(undefined); });
  const manager = createDesktopHostSession({ baseUrl: origin, fetcher: async (url, options) => {
    requests.push({ url, method: options.method });
    if (options.method === "POST" && url.endsWith("/api/auth/session")) {
      assert.ok(markRefreshStarted);
      markRefreshStarted();
      await refreshBarrier;
      cookie = "refreshed";
    }
    if (url.endsWith("/api/logout")) { cookie = ""; return Response.json({ ok: true }); }
    return Response.json({ ok: true, data: { ...sessionData, expiresAt: new Date(Date.now() + 6 * 86400000).toISOString() } });
  } });
  const refresh = manager.ensureSession({ refresh: true });
  await refreshStarted;
  const logout = manager.logout();
  assert.equal(requests.some((request) => request.url.endsWith("/api/logout")), false);
  assert.equal((await manager.ensureSession({ force: true })).code, "HOST_LOGOUT_IN_PROGRESS");
  assert.equal(cookie, "initial");
  assert.ok(releaseRefresh);
  releaseRefresh();
  await refresh;
  assert.equal((await logout).ok, true);
  assert.equal(requests.at(-1).url, `${origin}/api/logout`);
  assert.equal(cookie, "");
  assert.equal(manager.getSnapshot().code, "HOST_LOGIN_REQUIRED");
});

test("logout failure is reported and no hidden retry runs", async () => {
  let requests = 0;
  const manager = createDesktopHostSession({ baseUrl: origin, fetcher: async () => { requests++; throw new Error("private details"); } });
  assert.deepEqual(await manager.logout(), { ok: false, code: "NETWORK_UNAVAILABLE" });
  assert.equal(requests, 1);
});

test("only the exact trusted origin and login/admin paths may finish a login", () => {
  assert.equal(classifyDesktopLoginNavigation(`${origin}/login`, origin), "login");
  assert.equal(classifyDesktopLoginNavigation(`${origin}/admin`, origin), "authenticated");
  assert.equal(classifyDesktopLoginNavigation(`${origin}/admin/`, origin), "authenticated");
  for (const url of [`${origin}.evil.test/admin`, `https://user:secret@workspace.example.test/admin`, `${origin}/admin-fake`, `${origin}/stage`, `http://workspace.example.test/admin`, "javascript:alert(1)", "file:///tmp/login.html"]) {
    assert.equal(classifyDesktopLoginNavigation(url, origin), "blocked");
  }
});

test("an absolute session lifetime cap does not cause repeated renewal writes", async () => {
  let now = Date.now();
  const data = { userId: "host-cap", expiresAt: new Date(now + 6 * 86_400_000).toISOString() };
  const calls = [];
  const manager = createDesktopHostSession({ baseUrl: origin, now: () => now, fetcher: async (_url, options) => {
    calls.push(options.method);
    return Response.json({ ok: true, data });
  } });
  await manager.ensureSession();
  now += 61_000;
  await manager.ensureSession();
  await manager.ensureSession({ force: true });
  assert.deepEqual(calls, ["GET", "POST", "GET", "GET"]);
});
