import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

import * as statusCache from "../auth/profile-status-cache";
import * as sessions from "../session";
import { assertStrictOrigin, isPublicUnauthenticatedPath } from "./csrf";
import { readHostLoginConfig } from "./host-login-config";
import { isProfileBackedHostId } from "./host-session-policy";
import { HostLoginRateLimitError, enforceHostLoginCredentialRateLimits, enforceHostLoginRateLimit } from "./live-rate-limit";
import { LiveAdmissionError } from "./live-admission-store";

const DAY = 86_400_000;
const START = Date.UTC(2026, 7, 31);
// An auth.users uuid: the `profiles.host_id` a non-bootstrap approved profile carries in its cookie.
const PROFILE_HOST_ID = "00000000-0000-4000-8000-000000000011";
const environmentKeys = ["ADMIN_USER_IDS", "ADMIN_PASSWORD", "ADMIN_PASSWORD_HASH", "LIVE_ALLOW_WEAK_TEST_LOGIN", "ALLOWED_ORIGINS"];

async function withSessionEnvironment(run: (setNow: (value: number) => void) => Promise<void>) {
  const previous = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  const previousNow = Date.now;
  let now = START;
  Date.now = () => now;
  process.env.ADMIN_USER_IDS = "operator,other-host";
  process.env.ADMIN_PASSWORD = "unit-test-host-password";
  process.env.ALLOWED_ORIGINS = "https://nova.test";
  delete process.env.ADMIN_PASSWORD_HASH;
  delete process.env.LIVE_ALLOW_WEAK_TEST_LOGIN;
  try { await run((value) => { now = value; }); }
  finally {
    Date.now = previousNow;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function sign(payload: string): string {
  const secret = process.env.SESSION_SECRET?.trim() ?? "realtime-noel-web-dev-secret-change-me";
  return `${btoa(payload)}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

test("host sessions expire after 30 days and removed IDs immediately lose all session authorization", async () => {
  await withSessionEnvironment(async (setNow) => {
    const token = await sessions.createSessionToken("operator");
    const claims = await sessions.readSessionToken(token);
    assert.equal(claims?.userId, "operator");
    assert.equal(claims?.expiresAt, START + 30 * DAY);
    assert.equal(await sessions.verifySessionToken(token), true);
    process.env.ADMIN_USER_IDS = "other-host";
    assert.equal(await sessions.verifySessionToken(token), false);
    process.env.ADMIN_USER_IDS = "operator";
    setNow(START + 30 * DAY);
    assert.equal(await sessions.verifySessionToken(token), false);
  });
});

test("a cookie for a profile-backed auth user id reads back without an ADMIN_USER_IDS entry; other unknown ids stay rejected", async () => {
  await withSessionEnvironment(async () => {
    assert.equal(isProfileBackedHostId(PROFILE_HOST_ID), true);
    assert.equal(isProfileBackedHostId(PROFILE_HOST_ID.toUpperCase()), true);
    assert.equal(isProfileBackedHostId("operator"), false);
    assert.equal(isProfileBackedHostId("00000000-0000-4000-8000-00000000001"), false);
    assert.equal(isProfileBackedHostId("00000000-0000-4000-0000-000000000011"), false);
    const token = await sessions.createSessionToken(PROFILE_HOST_ID);
    assert.equal((await sessions.readSessionToken(token))?.userId, PROFILE_HOST_ID);
    assert.equal(await sessions.verifySessionToken(token), true);
    const stranger = await sessions.createSessionToken("not-an-admin");
    assert.equal(await sessions.readSessionToken(stranger), null);
    assert.equal(await sessions.verifySessionToken(stranger), false);
  });
});

test("session route reports role and accepts a profile-backed host that is not in ADMIN_USER_IDS", async () => {
  await withSessionEnvironment(async () => {
    const route = loadRoute("auth/session");
    const profile = (status: "approved" | "pending", role: "admin" | "host") =>
      ({ id: PROFILE_HOST_ID, email: "a@b.io", displayName: null, status, role, hostId: PROFILE_HOST_ID });
    statusCache.__setProfileReaderForTests(async (hostId: string) => (hostId === PROFILE_HOST_ID ? profile("approved", "admin") : null));
    try {
      const token = await sessions.createSessionToken(PROFILE_HOST_ID);
      const response = await route.GET(request(token));
      assert.equal(response.status, 200);
      const body = response.body as { data: { userId: string; role: string } };
      assert.equal(body.data.userId, PROFILE_HOST_ID);
      assert.equal(body.data.role, "admin");
      const legacy = await route.GET(request(await sessions.createSessionToken("operator")));
      assert.equal(legacy.status, 200);
      assert.equal((legacy.body as { data: { role: string } }).data.role, "legacy");
      statusCache.__setProfileReaderForTests(async () => profile("pending", "host"));
      assert.equal((await route.GET(request(token))).status, 401);
      statusCache.__setProfileReaderForTests(async () => null);
      assert.equal((await route.GET(request(token))).status, 401, "a uuid subject with no profile row is not an allowlisted legacy host");
    } finally {
      statusCache.__setProfileReaderForTests(null);
    }
  });
});

test("refresh is infrequent and cannot move the original 90-day authentication deadline", async () => {
  await withSessionEnvironment(async (setNow) => {
    let token = await sessions.createSessionToken("operator");
    assert.equal(await sessions.refreshSessionToken(token), null);
    for (const day of [23, 46, 69, 83]) {
      setNow(START + day * DAY);
      const refreshed = await sessions.refreshSessionToken(token);
      if (refreshed) token = refreshed.token;
      const claims = await sessions.readSessionToken(token);
      assert.equal(claims?.authenticatedAt, START);
      assert.ok(claims && claims.expiresAt <= START + 90 * DAY);
    }
    setNow(START + 90 * DAY);
    assert.equal(await sessions.verifySessionToken(token), false);
    assert.equal(await sessions.refreshSessionToken(token), null);
  });
});

test("old 12-hour cookies migrate only while valid and preserve a bounded original authentication time", async () => {
  await withSessionEnvironment(async (setNow) => {
    const token = sign(`operator|${START + 12 * 3_600_000}`);
    assert.equal(await sessions.verifySessionToken(token), true);
    const refreshed = await sessions.refreshSessionToken(token);
    assert.ok(refreshed);
    assert.equal(refreshed.session.authenticatedAt, START);
    assert.equal(refreshed.session.expiresAt, START + 30 * DAY);
    setNow(START + 12 * 3_600_000);
    assert.equal(await sessions.refreshSessionToken(token), null);
  });
});

test("a token expiring between asynchronous verification and refresh cannot be revived", async () => {
  await withSessionEnvironment(async () => {
    const token = await sessions.createSessionToken("operator");
    let reads = 0;
    Date.now = () => START + 30 * DAY + (reads++ === 0 ? -1 : 0);
    assert.equal((await sessions.refreshSessionToken(token)) === null, true);
  });
});

test("even correctly signed malformed, future, oversized and unbounded claims fail closed", async () => {
  await withSessionEnvironment(async () => {
    for (const payload of [
      `operator|${START + 30 * DAY}|${START}|${START}|v3`,
      `operator|${START + 31 * DAY}|${START}|${START}|v2`,
      `operator|${START + 30 * DAY}|${START + 1}|${START}|v2`,
      `operator|${START + 30 * DAY}|${START}|${START + 1}|v2`,
      `operator|${START + 30 * DAY}|${START - 91 * DAY}|${START}|v2`,
      `operator|${START + 30 * DAY}|${START}|${START}|v2|extra`,
      `operator|${START + 13 * 3_600_000}`,
      `other|${START + DAY}`, `|${START + DAY}`, `operator|Infinity`,
      `operator|${START + DAY}|unexpected`, `${"a".repeat(600)}|${START + DAY}`,
    ]) assert.equal(await sessions.verifySessionToken(sign(payload)), false, "invalid signed claims must not authorize");
    const token = await sessions.createSessionToken("operator");
    assert.equal(await sessions.verifySessionToken(`${token}.extra`), false);
    assert.equal(await sessions.verifySessionToken(token.slice(0, -1)), false);
    assert.equal(await sessions.verifySessionToken(undefined), false);
    await assert.rejects(sessions.createSessionToken("operator|injected"));
  });
});

type CookieOptions = Record<string, unknown>;
class TestResponse {
  body: unknown;
  status: number;
  cookiesWritten: Array<{ name: string; value: string; options: CookieOptions }> = [];
  headers: Headers;
  cookies = { set: (name: string, value: string, options: CookieOptions) => { this.cookiesWritten.push({ name, value, options }); } };
  constructor(body: unknown, status = 200, headers?: HeadersInit) { this.body = body; this.status = status; this.headers = new Headers(headers); }
}

function loadRoute(name: "auth/session" | "logout" | "login", overrides: Record<string, unknown> = {}, environment = process.env) {
  const source = readFileSync(new URL(`../../app/api/${name}/route.ts`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const modules: Record<string, unknown> = {
    "@/lib/auth/bootstrap-admins": {},
    "@/lib/auth/profile-store": {},
    "@/lib/session": sessions,
    "@/lib/security/csrf": { assertStrictOrigin },
    "@/lib/security/host-login-config": { readHostLoginConfig },
    "@/lib/auth/profile-status-cache": { assertHostApproved: statusCache.assertHostApproved },
    "@/lib/console/engine-defaults": { consoleSettingsCache: { get: async () => ({ legacyPasswordLoginEnabled: true }), invalidate: () => undefined } },
    "@/lib/security/api-response": {
      apiSuccess: (data: unknown, init?: ResponseInit) => new TestResponse({ ok: true, data }, init?.status, init?.headers),
      apiError: (error: string, code: string, status: number, headers?: HeadersInit) => new TestResponse({ ok: false, error, code }, status, headers),
    },
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => new TestResponse(body, init?.status, init?.headers) } },
    ...overrides,
  };
  const context = { exports: {}, process: { env: environment }, Date, require: (id: string) => { assert.ok(id in modules, `unexpected route dependency ${id}`); return modules[id]; } };
  vm.runInNewContext(output, context);
  return context.exports as Record<"GET" | "POST", (input: ReturnType<typeof request>) => Promise<TestResponse>>;
}

function request(token?: string, origin: string | null = "https://nova.test") {
  return { headers: new Headers(origin ? { origin } : {}), cookies: { get: (name: string) => name === sessions.SESSION_COOKIE && token ? { value: token } : undefined } };
}

test("session GET never refreshes and successful GET/POST have private no-store responses without secrets", async () => {
  await withSessionEnvironment(async (setNow) => {
    const route = loadRoute("auth/session");
    const token = await sessions.createSessionToken("operator");
    setNow(START + 24 * DAY);
    const result = await route.GET(request(token));
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(JSON.stringify(result.body)), { ok: true, data: { userId: "operator", expiresAt: new Date(START + 30 * DAY).toISOString(), role: "legacy" } });
    assert.equal(result.cookiesWritten.length, 0);
    assert.match(result.headers.get("cache-control") ?? "", /no-store/);
    assert.doesNotMatch(JSON.stringify(result.body), /password|token|secret/i);
    const fresh = await route.POST(request(token));
    const cookie = fresh.cookiesWritten.find((value) => value.name === sessions.SESSION_COOKIE);
    assert.ok(cookie);
    assert.deepEqual(JSON.parse(JSON.stringify(cookie.options)), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 30 * 24 * 60 * 60 });
    assert.equal((fresh.body as { data: { expiresAt: string } }).data.expiresAt, new Date(START + 54 * DAY).toISOString());
    assert.equal((await route.POST(request(cookie.value))).cookiesWritten.length, 0);
  });
});

test("refresh rejects hostile and absent origins before authentication and does not clear cookies on errors", async () => {
  await withSessionEnvironment(async () => {
    const route = loadRoute("auth/session");
    const token = await sessions.createSessionToken("operator");
    for (const origin of [null, "https://nova.test.evil.test", "https://nova.test:444", "https://evil.test"]) {
      const result = await route.POST(request(token, origin));
      assert.equal(result.status, 403);
      assert.equal(result.cookiesWritten.length, 0);
    }
    for (const method of ["GET", "POST"] as const) {
      assert.equal((await route[method](request())).status, 401);
      process.env.ADMIN_USER_IDS = "other-host";
      const removed = await route[method](request(token));
      assert.equal(removed.status, 401);
      assert.equal(removed.cookiesWritten.length, 0);
      process.env.ADMIN_USER_IDS = "operator";
      process.env.ADMIN_PASSWORD_HASH = "invalid-test-hash";
      const unavailable = await route[method](request(token));
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.cookiesWritten.length, 0);
      delete process.env.ADMIN_PASSWORD_HASH;
    }
  });
});

test("logout requires a trusted origin and clears both host cookies without starting or ending any meeting", async () => {
  await withSessionEnvironment(async () => {
    const route = loadRoute("logout");
    assert.equal((await route.POST(request(undefined, null))).status, 403);
    const result = await route.POST(request());
    assert.equal(result.status, 200);
    assert.equal(result.cookiesWritten.length, 2);
    for (const cookie of result.cookiesWritten) {
      assert.equal(cookie.value, "");
      assert.equal(cookie.options.maxAge, 0);
      assert.equal(cookie.options.path, "/");
    }
  });
});

test("only exact self-authenticating session and logout paths bypass the generic middleware login response", () => {
  for (const path of ["/api/auth/session", "/api/logout"]) {
    assert.equal(isPublicUnauthenticatedPath(path), true);
    for (const suffix of ["/other", ".json", "-other", "/"]) assert.equal(isPublicUnauthenticatedPath(`${path}${suffix}`), false);
  }
  assert.equal(isPublicUnauthenticatedPath("/api/auth"), false);
});

test("login IP, account and global limits stay enforced with a bounded Retry-After for each denial", async () => {
  await withSessionEnvironment(async () => {
    const records: Array<{ scope: string; keyHash: string; limit: number; windowSeconds: number }> = [];
    let deniedScope = "host-login-ip";
    const store = { consumeRateLimit: async (input: (typeof records)[number]) => { records.push(input); return input.scope !== deniedScope; } };
    await assert.rejects(enforceHostLoginRateLimit(request(), store), (error: unknown) => error instanceof HostLoginRateLimitError && error.retryAfterSeconds === 900 && error.status === 429);
    assert.equal(records.length, 1);
    deniedScope = "host-login-account";
    await assert.rejects(enforceHostLoginCredentialRateLimits("operator", store), (error: unknown) => error instanceof HostLoginRateLimitError && error.retryAfterSeconds === 900 && error.status === 429);
    assert.equal(records.length, 3);
    deniedScope = "host-login-global";
    await assert.rejects(enforceHostLoginCredentialRateLimits("operator", store), (error: unknown) => error instanceof HostLoginRateLimitError && error.retryAfterSeconds === 300 && error.status === 429);
    assert.deepEqual(records.slice(0, 1).map(({ scope, limit, windowSeconds }) => [scope, limit, windowSeconds]), [
      ["host-login-ip", 5, 900],
    ]);
    for (const attemptRecords of [records.slice(1, 3), records.slice(3)]) {
      // 2026-08-31 fix: Account/global hashes resolve concurrently; exact bucket consumption matters, not arrival order.
      assert.deepEqual(attemptRecords.toSorted((left, right) => left.scope.localeCompare(right.scope))
        .map(({ scope, limit, windowSeconds }) => [scope, limit, windowSeconds]), [
        ["host-login-account", 10, 900], ["host-login-global", 120, 300],
      ]);
    }
    for (const record of records) assert.match(record.keyHash, /^[a-f0-9]{64}$/u);
  });
});

test("every actual login handler rate-limit response exposes Retry-After without issuing a cookie", async () => {
  await withSessionEnvironment(async () => {
    for (const denial of ["local-check", "local-failure", "ip", "account", "global"] as const) {
      const limit = { isAllowed: true, retryAfterSeconds: 0 };
      const modules = {
        "@/lib/security/bounded-json-body": { BoundedJsonBodyError: class extends Error {}, readBoundedJsonBody: async () => ({ id: "operator", password: ["unit", "test", "host", "password"].join("-"), name: "Host" }) },
        "@/lib/security/host-password": { verifyHostPassword: async () => true },
        "@/lib/security/hmac": { timingSafeEqual: () => denial !== "local-failure" },
        "@/lib/security/live-admission-store": { LiveAdmissionError, SupabaseLiveAdmissionStore: class {} },
        "@/lib/security/live-input-validation": { hostLoginInputSchema: { safeParse: (data: unknown) => ({ success: true, data }) } },
        "@/lib/security/live-rate-limit": {
          HostLoginRateLimitError,
          enforceHostLoginRateLimit: async () => { if (denial === "ip") throw new HostLoginRateLimitError(900); },
          enforceHostLoginCredentialRateLimits: async () => { if (denial === "account" || denial === "global") throw new HostLoginRateLimitError(denial === "account" ? 900 : 300); },
        },
        "@/lib/security/login-rate-limit": { loginRateLimiter: {
          check: () => denial === "local-check" ? { isAllowed: false, retryAfterSeconds: 42 } : limit,
          recordFailure: () => ({ isAllowed: false, retryAfterSeconds: 81 }), clear: () => undefined,
        } },
      };
      const result = await loadRoute("login", modules, { ...process.env, NODE_ENV: "production" }).POST(request());
      assert.equal(result.status, 429, denial);
      const expected = denial === "local-check" ? 42 : denial === "local-failure" ? 81 : denial === "global" ? 300 : 900;
      assert.equal(result.headers.get("retry-after"), String(expected), denial);
      assert.equal(result.cookiesWritten.length, 0);
      assert.equal((result.body as { code: string }).code, "LOGIN_RATE_LIMITED");
    }
  });
});

test("legacy password login: no bootstrap emails keeps the pre-console path, a linked profile reports admin, and an outage has a break-glass only for the bootstrap id with last-known approval", async () => {
  await withSessionEnvironment(async () => {
    type LastKnown = { status: string; role: string } | null | undefined;
    const ProfileStoreError = class extends Error {
      code: string; status: number;
      constructor(message: string, code: string, status: number) { super(message); this.code = code; this.status = status; }
    };
    const run = async (options: { emails: string[]; legacyHostId: string | null; id?: string; password?: boolean; ensure: () => Promise<{ status: string; role: string }>; lastKnown?: LastKnown }) => {
      let ensures = 0; let tokens = 0; let invalidated = 0; const warned: string[] = [];
      const route = loadRoute("login", {
        "@/lib/auth/bootstrap-admins": { readBootstrapAdminConfig: () => ({ legacyHostId: options.legacyHostId, emails: new Set(options.emails) }), warnBreakGlassLogin: (code: string) => { warned.push(code); } },
        "@/lib/auth/profile-store": { ProfileStoreError, SupabaseProfileStore: class { async ensureLegacyAdmin() { ensures++; return options.ensure(); } } },
        "@/lib/auth/profile-status-cache": { profileStatusCache: { invalidate: () => { invalidated++; }, lastKnown: () => options.lastKnown } },
        "@/lib/security/bounded-json-body": { BoundedJsonBodyError: class extends Error {}, readBoundedJsonBody: async () => ({ id: options.id ?? "operator", password: ["unit", "test", "host", "password"].join("-"), name: "Host" }) },
        "@/lib/security/host-password": { verifyHostPassword: async () => true },
        "@/lib/security/hmac": { timingSafeEqual: () => options.password !== false },
        "@/lib/security/live-admission-store": { LiveAdmissionError, SupabaseLiveAdmissionStore: class {} },
        "@/lib/security/live-input-validation": { hostLoginInputSchema: { safeParse: (data: unknown) => ({ success: true, data }) } },
        "@/lib/security/live-rate-limit": { HostLoginRateLimitError, enforceHostLoginRateLimit: async () => undefined, enforceHostLoginCredentialRateLimits: async () => undefined },
        "@/lib/security/login-rate-limit": { loginRateLimiter: { check: () => ({ isAllowed: true, retryAfterSeconds: 0 }), recordFailure: () => ({ isAllowed: true, retryAfterSeconds: 0 }), clear: () => undefined } },
        "@/lib/session": { ...sessions, createSessionToken: async (id: string) => { tokens++; return sessions.createSessionToken(id); } },
      });
      const result = await route.POST(request());
      const body = result.body as { code?: string; data?: { role?: string; userId?: string } };
      return { status: result.status, code: body.code, role: body.data?.role, ensures, tokens, invalidated, cookie: result.cookiesWritten.some((c) => c.name === sessions.SESSION_COOKIE), warned };
    };
    const linked = async () => ({ status: "approved", role: "admin" });
    const offline = async (): Promise<never> => { throw new Error("offline"); };
    const storeDown = async (): Promise<never> => { throw new ProfileStoreError("down", "PROFILE_STORE_UNAVAILABLE", 503); };
    const disabled = async (): Promise<never> => { throw new ProfileStoreError("disabled", "ADMIN_PROFILE_DISABLED", 403); };
    const approvedAdmin = { status: "approved", role: "admin" };

    // ADMIN_BOOTSTRAP_EMAILS unset: the pre-checkpoint legacy behaviour, no Supabase call, honest role.
    assert.deepEqual(await run({ emails: [], legacyHostId: "operator", ensure: linked }), { status: 200, code: undefined, role: "legacy", ensures: 0, tokens: 1, invalidated: 0, cookie: true, warned: [] });
    assert.deepEqual(await run({ emails: [], legacyHostId: "operator", id: "other-host", ensure: linked }), { status: 200, code: undefined, role: "legacy", ensures: 0, tokens: 1, invalidated: 0, cookie: true, warned: [] });
    // The password is verified before any bootstrap step, so a username alone never reaches the store.
    assert.deepEqual(await run({ emails: ["admin@example.test"], legacyHostId: "operator", password: false, ensure: linked, lastKnown: approvedAdmin }), { status: 401, code: "INVALID_CREDENTIALS", role: undefined, ensures: 0, tokens: 0, invalidated: 0, cookie: false, warned: [] });
    // Configured and reachable: the bootstrap admin is linked and reports admin.
    assert.deepEqual(await run({ emails: ["admin@example.test"], legacyHostId: "operator", ensure: linked }), { status: 200, code: undefined, role: "admin", ensures: 1, tokens: 1, invalidated: 1, cookie: true, warned: [] });
    // Configured but a second ADMIN_USER_IDS entry is not the bootstrap id: refused as before, even during an outage with cached approval.
    assert.deepEqual(await run({ emails: ["admin@example.test"], legacyHostId: "operator", id: "other-host", ensure: linked }), { status: 503, code: "ADMIN_BOOTSTRAP_CONFIG_REQUIRED", role: undefined, ensures: 0, tokens: 0, invalidated: 0, cookie: false, warned: [] });
    assert.deepEqual(await run({ emails: ["admin@example.test"], legacyHostId: "operator", id: "other-host", ensure: offline, lastKnown: approvedAdmin }), { status: 503, code: "ADMIN_BOOTSTRAP_CONFIG_REQUIRED", role: undefined, ensures: 0, tokens: 0, invalidated: 0, cookie: false, warned: [] });
    // Outage with nothing last-known about the bootstrap profile: 503 as today, no cookie.
    for (const ensure of [offline, storeDown]) {
      assert.deepEqual(await run({ emails: ["admin@example.test"], legacyHostId: "operator", ensure }), { status: 503, code: "ADMIN_BOOTSTRAP_UNAVAILABLE", role: undefined, ensures: 1, tokens: 0, invalidated: 0, cookie: false, warned: [] });
      assert.deepEqual(await run({ emails: ["admin@example.test"], legacyHostId: "operator", ensure, lastKnown: null }), { status: 503, code: "ADMIN_BOOTSTRAP_UNAVAILABLE", role: undefined, ensures: 1, tokens: 0, invalidated: 0, cookie: false, warned: [] });
      // Break-glass: the store is down, but the bootstrap id was linked and approved within the cache grace window.
      assert.deepEqual(await run({ emails: ["admin@example.test"], legacyHostId: "operator", ensure, lastKnown: approvedAdmin }), { status: 200, code: undefined, role: "admin", ensures: 1, tokens: 1, invalidated: 0, cookie: true, warned: ["ADMIN_BOOTSTRAP_BREAK_GLASS"] });
      // A last-known disabled or non-admin profile is refused, not rescued.
      assert.deepEqual(await run({ emails: ["admin@example.test"], legacyHostId: "operator", ensure, lastKnown: { status: "disabled", role: "admin" } }), { status: 403, code: "ADMIN_PROFILE_DISABLED", role: undefined, ensures: 1, tokens: 0, invalidated: 0, cookie: false, warned: [] });
      assert.deepEqual(await run({ emails: ["admin@example.test"], legacyHostId: "operator", ensure, lastKnown: { status: "approved", role: "host" } }), { status: 403, code: "ADMIN_PROFILE_DISABLED", role: undefined, ensures: 1, tokens: 0, invalidated: 0, cookie: false, warned: [] });
    }
    // A definitive store answer (disabled profile, 4xx) is never a break-glass candidate.
    assert.deepEqual(await run({ emails: ["admin@example.test"], legacyHostId: "operator", ensure: disabled, lastKnown: approvedAdmin }), { status: 403, code: "ADMIN_PROFILE_DISABLED", role: undefined, ensures: 1, tokens: 0, invalidated: 0, cookie: false, warned: [] });
  });
});

test("the legacy login route never logs itself; the break-glass warning lives in bootstrap-admins and names only the code", () => {
  const route = readFileSync(new URL("../../app/api/login/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /console\./u);
  assert.match(route, /warnBreakGlassLogin\("ADMIN_BOOTSTRAP_BREAK_GLASS"\)/u);
  assert.match(route, /profileStatusCache\.lastKnown\(id\)/u);
  const bootstrap = readFileSync(new URL("../auth/bootstrap-admins.ts", import.meta.url), "utf8");
  assert.match(bootstrap, /export function warnBreakGlassLogin\(code: string\): void \{\s*console\.warn\(`\[auth\] legacy break-glass login: \$\{code\}`\);\s*\}/u);
});
