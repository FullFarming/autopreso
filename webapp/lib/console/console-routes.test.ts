import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as zod from "zod";

import * as captionEngineCatalog from "../../../packages/caption-core/caption-engine-catalog.js";
import * as liveAuth from "../auth/live-auth";
import type { ProfileRecord } from "../auth/profile-store";
import * as boundedJsonBody from "../security/bounded-json-body";
import * as csrf from "../security/csrf";
import * as liveTopicValidation from "../security/live-topic-validation";
import * as consoleStore from "./console-store";
import * as engineDefaults from "./engine-defaults";

const { DEFAULT_ENGINE_SELECTION } = captionEngineCatalog;
import { type ConsoleSessionRow, type ConsoleSettings, ConsoleStoreError, type SupabaseConsoleStore, __setConsoleStoreForTests } from "./console-store";

const ADMIN_UUID = "00000000-0000-4000-8000-000000000011";
const TARGET_UUID = "00000000-0000-4000-8000-000000000022";
const ORIGIN = "https://nova.test";
const ADMIN: ProfileRecord = { id: ADMIN_UUID, email: "admin@x.io", displayName: "Admin", status: "approved", role: "admin", hostId: ADMIN_UUID };

const routeSource = (name: string) => readFileSync(new URL(`../../app/api/${name}/route.ts`, import.meta.url), "utf8");

// --- (a) source pins ---------------------------------------------------------

test("every console route is force-dynamic, guards with requireAdmin, and checks the origin before mutating", () => {
  for (const [name, mutating] of [["console/users", "PATCH"], ["console/sessions", null], ["console/engine-defaults", "PUT"], ["console/settings", "PUT"]] as const) {
    const source = routeSource(name);
    assert.match(source, /import \{ requireAdmin \} from "@\/lib\/auth\/require-admin"/u, name);
    assert.match(source, /await requireAdmin\(request\)/u, name);
    assert.match(source, /export const dynamic = "force-dynamic"/u, name);
    assert.doesNotMatch(source, /console\.(log|info|warn|error)\(/u, name);
    if (mutating) {
      assert.match(source, new RegExp(`export async function ${mutating}\\(`, "u"), name);
      assert.match(source, /assertStrictOrigin\(request\)/u, name);
    }
  }
  assert.match(routeSource("console/users"), /\.refine\(/u, "PATCH users must accept exactly one of status/role");
});

test("the legacy login route refuses when the console switch is off and live-config carries engineDefaults", () => {
  const login = routeSource("login");
  assert.match(login, /consoleSettingsCache\.get\(\)/u);
  assert.match(login, /"LEGACY_LOGIN_DISABLED", 403/u);
  assert.ok(login.indexOf("readHostLoginConfig()") < login.indexOf("LEGACY_LOGIN_DISABLED"), "the switch is consulted after the env config parses");
  assert.ok(login.indexOf("LEGACY_LOGIN_DISABLED") < login.indexOf("readBoundedJsonBody(request)"), "the switch is consulted before the body is read");
  const liveConfig = routeSource("live-config");
  assert.match(liveConfig, /engineDefaults/u);
  assert.match(liveConfig, /resolveEngineDefaultsOrFallback\(\)/u);
});

// --- (b) handler tests through the same transpile-and-inject harness host-session.test.ts uses ----

class TestResponse {
  body: unknown;
  status: number;
  headers: Headers;
  cookies = { set: () => undefined };
  constructor(body: unknown, status = 200, headers?: HeadersInit) { this.body = body; this.status = status; this.headers = new Headers(headers); }
}

type Handler = (request: unknown) => Promise<TestResponse>;

// `lib/security/api-response.ts` imports the bare specifier `next/server`, which Node's ESM
// resolver cannot load outside Next (no exports map), so anything that touches it is
// transpiled here and given the same fake envelope host-session.test.ts uses.
const apiResponseModule = {
  apiSuccess: (data: unknown, init?: ResponseInit) => new TestResponse({ ok: true, data }, init?.status, init?.headers),
  apiError: (error: string, code: string, status: number, headers?: HeadersInit) => new TestResponse({ ok: false, error, code }, status, headers),
};

// Runs in this realm (a CommonJS wrapper, not a fresh context) so objects the routes build
// share the test's prototypes and `assert.deepEqual` can compare them to literals.
function loadTranspiled(source: string, modules: Record<string, unknown>): Record<string, unknown> {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  const require = (id: string) => { assert.ok(id in modules, `unexpected dependency ${id}`); return modules[id]; };
  const wrapper = vm.runInThisContext(`(function (exports, require) {${output}\n})`) as (e: typeof exports, r: typeof require) => void;
  wrapper(exports, require);
  return exports;
}

const consoleRoute = loadTranspiled(readFileSync(new URL("./console-route.ts", import.meta.url), "utf8"), {
  "next/server": {},
  "../../../packages/caption-core/caption-engine-catalog.js": captionEngineCatalog,
  "../auth/live-auth": liveAuth,
  "../security/api-response": apiResponseModule,
  "../security/bounded-json-body": boundedJsonBody,
  "../security/csrf": csrf,
  "../security/live-topic-validation": liveTopicValidation,
  "./console-store": consoleStore,
  "./engine-defaults": engineDefaults,
});

function loadRoute(name: string, overrides: Record<string, unknown> = {}): Record<"GET" | "PATCH" | "PUT" | "POST", Handler> {
  return loadTranspiled(routeSource(name), {
    "next/server": {},
    zod,
    "@/lib/auth/live-auth": liveAuth,
    "@/lib/console/console-route": consoleRoute,
    "@/lib/console/console-store": consoleStore,
    "@/lib/console/engine-defaults": engineDefaults,
    "@/lib/security/bounded-json-body": boundedJsonBody,
    "@/lib/security/csrf": csrf,
    "@/lib/security/live-topic-validation": liveTopicValidation,
    "@/lib/security/api-response": apiResponseModule,
    ...overrides,
  }) as Record<"GET" | "PATCH" | "PUT" | "POST", Handler>;
}

function request(path: string, init: { method?: string; body?: unknown; origin?: string | null } = {}) {
  const url = `${ORIGIN}${path}`;
  const headers = new Headers();
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const base = new Request(url, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  return Object.assign(base, { nextUrl: new URL(url), cookies: { get: () => undefined } });
}

const adminModule = (outcome: "admin" | "anonymous" | "host" = "admin") => ({
  "@/lib/auth/require-admin": {
    requireAdmin: async () => {
      if (outcome === "anonymous") throw new liveAuth.AuthenticationError("로그인이 필요합니다.");
      if (outcome === "host") throw new liveAuth.AuthorizationError("관리자 권한이 필요합니다.");
      return { hostId: ADMIN_UUID, profile: ADMIN };
    },
  },
});

interface FakeStore {
  calls: Array<{ method: string; args: unknown }>;
  settings: ConsoleSettings;
  sessions: ConsoleSessionRow[];
  failWith: ConsoleStoreError | null;
}

function installFakeStore(overrides: Partial<Pick<FakeStore, "settings" | "sessions">> = {}): FakeStore {
  const fake: FakeStore = {
    calls: [], failWith: null,
    settings: overrides.settings ?? { legacyPasswordLoginEnabled: true, engine: null, engineUpdatedAt: null, engineUpdatedByEmail: null },
    sessions: overrides.sessions ?? [],
  };
  const record = (method: string) => async (args: unknown) => {
    fake.calls.push({ method, args });
    if (fake.failWith) throw fake.failWith;
    switch (method) {
      case "listProfiles": return [{ ...ADMIN, id: TARGET_UUID, hostId: TARGET_UUID, email: "b@x.io", role: "host", status: "pending", createdAt: "2026-09-02T00:00:00+00:00", lastLoginAt: null, approvedAt: null }];
      case "countPending": return 1;
      case "setProfileStatus": return { id: TARGET_UUID, status: (args as { status: string }).status, role: "host" };
      case "setProfileRole": return { id: TARGET_UUID, status: "approved", role: (args as { role: string }).role };
      case "listSessions": return fake.sessions;
      case "readSettings": return fake.settings;
      default: return undefined;
    }
  };
  const store = Object.fromEntries(["listProfiles", "countPending", "setProfileStatus", "setProfileRole", "listSessions", "readSettings", "setEngineDefaults", "setLegacyPasswordLogin"].map((m) => [m, record(m)]));
  __setConsoleStoreForTests(store as unknown as SupabaseConsoleStore);
  return fake;
}

async function withEnvironment(run: () => Promise<void>) {
  const previous = { ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS, SONIOX_API_KEY: process.env.SONIOX_API_KEY, GEMINI_API_KEY: process.env.GEMINI_API_KEY };
  process.env.ALLOWED_ORIGINS = ORIGIN;
  try { await run(); } finally {
    __setConsoleStoreForTests(null);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

const bodyOf = (result: TestResponse) => JSON.parse(JSON.stringify(result.body)) as { ok: boolean; data?: Record<string, unknown>; code?: string };

test("GET /api/console/users lists by status with the pending count and rejects unknown filters", async () => {
  await withEnvironment(async () => {
    const fake = installFakeStore();
    const route = loadRoute("console/users", adminModule());
    const result = await route.GET(request("/api/console/users?status=pending"));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    const { data } = bodyOf(result);
    assert.equal((data?.profiles as unknown[]).length, 1);
    assert.equal(data?.pendingCount, 1);
    assert.deepEqual(fake.calls.find((c) => c.method === "listProfiles")?.args, { status: "pending", before: undefined });
    assert.equal((await route.GET(request("/api/console/users?status=bogus"))).status, 400);
    assert.equal((await route.GET(request("/api/console/users?before=yesterday"))).status, 400);
    const unauthenticated = await loadRoute("console/users", adminModule("anonymous")).GET(request("/api/console/users"));
    assert.equal(unauthenticated.status, 401);
    assert.equal(bodyOf(unauthenticated).code, "HOST_AUTH_REQUIRED");
    const forbidden = await loadRoute("console/users", adminModule("host")).GET(request("/api/console/users"));
    assert.equal(forbidden.status, 403);
    assert.equal(bodyOf(forbidden).code, "ADMIN_REQUIRED");
    assert.equal(forbidden.headers.get("cache-control"), "private, no-store");
  });
});

test("PATCH /api/console/users accepts exactly one of status/role, acts as the admin's profile id, and passes store errors through", async () => {
  await withEnvironment(async () => {
    const fake = installFakeStore();
    const route = loadRoute("console/users", adminModule());
    const patch = (body: unknown, origin?: string | null) => route.PATCH(request("/api/console/users", { method: "PATCH", body, origin }));

    const approved = await patch({ profileId: TARGET_UUID, status: "approved" });
    assert.equal(approved.status, 200);
    assert.deepEqual(bodyOf(approved).data, { id: TARGET_UUID, status: "approved", role: "host" });
    assert.deepEqual(fake.calls.at(-1), { method: "setProfileStatus", args: { actorId: ADMIN_UUID, profileId: TARGET_UUID, status: "approved", reason: undefined } });

    const promoted = await patch({ profileId: TARGET_UUID, role: "admin" });
    assert.deepEqual(bodyOf(promoted).data, { id: TARGET_UUID, status: "approved", role: "admin" });
    assert.deepEqual(fake.calls.at(-1), { method: "setProfileRole", args: { actorId: ADMIN_UUID, profileId: TARGET_UUID, role: "admin" } });

    const rejected = await patch({ profileId: TARGET_UUID, status: "rejected", reason: "  spam  " });
    assert.equal(rejected.status, 200);
    assert.equal((fake.calls.at(-1)?.args as { reason: string }).reason, "spam");

    for (const invalid of [
      { profileId: TARGET_UUID }, { profileId: TARGET_UUID, status: "approved", role: "admin" }, { profileId: "nope", status: "approved" },
      { profileId: TARGET_UUID, status: "pending" }, { profileId: TARGET_UUID, role: "root" }, { profileId: TARGET_UUID, status: "approved", extra: 1 },
      { profileId: TARGET_UUID, status: "rejected", reason: "x".repeat(201) },
    ]) {
      const result = await patch(invalid);
      assert.equal(result.status, 400, JSON.stringify(invalid));
      assert.equal(bodyOf(result).code, "INVALID_REQUEST");
    }
    const mutations = fake.calls.filter((c) => c.method.startsWith("set")).length;
    assert.equal(mutations, 3, "invalid bodies never reach the store");

    fake.failWith = new ConsoleStoreError("마지막 관리자", "LAST_ADMIN_PROTECTED", 409);
    const guarded = await patch({ profileId: TARGET_UUID, status: "disabled" });
    assert.equal(guarded.status, 409);
    assert.equal(bodyOf(guarded).code, "LAST_ADMIN_PROTECTED");
    fake.failWith = null;

    for (const origin of [null, "https://evil.test"]) {
      const refused = await patch({ profileId: TARGET_UUID, status: "approved" }, origin);
      assert.equal(refused.status, 403);
      assert.equal(bodyOf(refused).code, "CSRF_REJECTED");
      assert.equal(refused.headers.get("cache-control"), "private, no-store");
    }
    // The origin is checked before the cookie: a foreign page cannot probe whether a session exists.
    const foreignAnonymous = await loadRoute("console/users", adminModule("anonymous")).PATCH(request("/api/console/users", { method: "PATCH", body: { profileId: TARGET_UUID, status: "approved" }, origin: "https://evil.test" }));
    assert.equal(bodyOf(foreignAnonymous).code, "CSRF_REJECTED");
    assert.equal(fake.calls.filter((c) => c.method.startsWith("set")).length, 4, "refused origins never reach the store");
    const asHost = await loadRoute("console/users", adminModule("host")).PATCH(request("/api/console/users", { method: "PATCH", body: { profileId: TARGET_UUID, status: "approved" } }));
    assert.equal(asHost.status, 403);
    assert.equal(bodyOf(asHost).code, "ADMIN_REQUIRED");
  });
});

test("GET /api/console/sessions maps range to since and computes the summary from the rows", async () => {
  await withEnvironment(async () => {
    const now = Date.now();
    const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString();
    const row = (id: string, extra: Partial<ConsoleSessionRow>): ConsoleSessionRow => ({
      id, title: null, hostId: ADMIN_UUID, hostEmail: "admin@x.io", mode: "meeting", status: "ended", languages: ["ko", "en"],
      createdAt: iso(0), endedAt: null, utteranceCount: 0, participantCount: 0, summaryStatus: null, ...extra,
    });
    const fake = installFakeStore({ sessions: [
      row("00000000-0000-4000-8000-000000000101", { status: "live", utteranceCount: 10, createdAt: iso(60_000) }),
      row("00000000-0000-4000-8000-000000000102", { utteranceCount: 5, createdAt: iso(3 * 24 * 60 * 60 * 1000), summaryStatus: "failed" }),
      row("00000000-0000-4000-8000-000000000103", { utteranceCount: 100, createdAt: iso(20 * 24 * 60 * 60 * 1000), summaryStatus: "succeeded" }),
    ] });
    const route = loadRoute("console/sessions", adminModule());
    const result = await route.GET(request("/api/console/sessions?range=30d"));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    const { data } = bodyOf(result);
    assert.equal((data?.sessions as unknown[]).length, 3);
    const summary = data?.summary as Record<string, number>;
    assert.equal(summary.live, 1);
    assert.equal(summary.utterances7d, 15);
    assert.equal(summary.summaryFailures, 1);
    // The 60 s-old row is today unless the test runs across midnight UTC; the 3-day-old row never is.
    assert.ok(summary.today === 1 || summary.today === 0);
    const since = (fake.calls.at(-1)?.args as { since?: string }).since;
    assert.ok(since && Math.abs(Date.parse(since) - (now - 30 * 24 * 60 * 60 * 1000)) < 5_000, "30d maps to a since ~30 days ago");

    await route.GET(request("/api/console/sessions"));
    const defaultSince = (fake.calls.at(-1)?.args as { since?: string }).since;
    assert.ok(defaultSince && Math.abs(Date.parse(defaultSince) - (now - 7 * 24 * 60 * 60 * 1000)) < 5_000, "default range is 7d");
    await route.GET(request("/api/console/sessions?range=all"));
    assert.equal((fake.calls.at(-1)?.args as { since?: string }).since, undefined);
    assert.equal((await route.GET(request("/api/console/sessions?range=1y"))).status, 400);
    fake.failWith = new ConsoleStoreError("down", "CONSOLE_STORE_UNAVAILABLE", 503);
    const outage = await route.GET(request("/api/console/sessions"));
    assert.equal(outage.status, 503);
    assert.equal(bodyOf(outage).code, "CONSOLE_STORE_UNAVAILABLE");
  });
});

test("GET /api/console/engine-defaults returns the normalized selection with a key-availability catalog; PUT validates, stores, and invalidates the cache", async () => {
  await withEnvironment(async () => {
    process.env.GEMINI_API_KEY = "set";
    delete process.env.SONIOX_API_KEY;
    const stored = { stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" }, translation: { provider: "gemini", model: "gemini-3.7-flash" }, summary: { provider: "gemini", model: "gemini-3.7-flash" } };
    const fake = installFakeStore({ settings: { legacyPasswordLoginEnabled: true, engine: stored, engineUpdatedAt: "2026-09-03T00:00:00+00:00", engineUpdatedByEmail: "admin@x.io" } });
    const route = loadRoute("console/engine-defaults", adminModule());
    const result = await route.GET(request("/api/console/engine-defaults"));
    assert.equal(result.status, 200);
    const { data } = bodyOf(result);
    assert.deepEqual(data?.engine, stored);
    assert.equal(data?.updatedAt, "2026-09-03T00:00:00+00:00");
    assert.equal(data?.updatedByEmail, "admin@x.io");
    const catalog = data?.catalog as { stt: Array<{ provider: string; available: boolean; requiredApiKey: string }>; defaults: unknown };
    assert.deepEqual(catalog.defaults, DEFAULT_ENGINE_SELECTION);
    assert.equal(catalog.stt.find((e) => e.provider === "gemini")?.available, true);
    assert.equal(catalog.stt.find((e) => e.provider === "soniox")?.available, false);
    assert.doesNotMatch(JSON.stringify(data), /"set"/u, "the catalog carries booleans, never key values");

    // Garbage in the singleton falls back to the catalog default instead of failing the page.
    fake.settings = { ...fake.settings, engine: { stt: { provider: "gemini", model: "nope" } } };
    assert.deepEqual(bodyOf(await route.GET(request("/api/console/engine-defaults"))).data?.engine, DEFAULT_ENGINE_SELECTION);

    const put = (body: unknown) => route.PUT(request("/api/console/engine-defaults", { method: "PUT", body }));
    const invalidBodies: Array<[unknown, string]> = [
      [{}, "INVALID_REQUEST"], [{ engine: DEFAULT_ENGINE_SELECTION, extra: true }, "INVALID_REQUEST"],
      [{ engine: "gemini" }, "ENGINE_INVALID"], [{ engine: { stt: { provider: "gemini", model: "nope" } } }, "ENGINE_INVALID"],
      [{ engine: { stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "fr" } } }, "ENGINE_INVALID"],
    ];
    for (const [invalid, code] of invalidBodies) {
      const rejected = await put(invalid);
      assert.equal(rejected.status, 400, JSON.stringify(invalid));
      assert.equal(bodyOf(rejected).code, code, JSON.stringify(invalid));
    }
    assert.equal(fake.calls.filter((c) => c.method === "setEngineDefaults").length, 0);

    // The 60 s settings memo must not outlive a write: prime it, write, and read again.
    fake.settings = { ...fake.settings, engine: null };
    assert.deepEqual(await engineDefaults.resolveEngineDefaults(), DEFAULT_ENGINE_SELECTION);
    const partial = { translation: { provider: "gemini", model: "gemini-3.5-flash-lite" } };
    fake.settings = { ...fake.settings, engine: { ...DEFAULT_ENGINE_SELECTION, ...partial } };
    const saved = await put({ engine: partial });
    assert.equal(saved.status, 200);
    assert.deepEqual(bodyOf(saved).data?.engine, { ...DEFAULT_ENGINE_SELECTION, ...partial });
    assert.deepEqual(fake.calls.at(-1), { method: "setEngineDefaults", args: { actorId: ADMIN_UUID, engine: { ...DEFAULT_ENGINE_SELECTION, ...partial } } });
    assert.deepEqual(await engineDefaults.resolveEngineDefaults(), { ...DEFAULT_ENGINE_SELECTION, ...partial });
  });
});

test("GET/PUT /api/console/settings expose the legacy login switch and warn when it is turned off", async () => {
  await withEnvironment(async () => {
    const fake = installFakeStore();
    const route = loadRoute("console/settings", adminModule());
    assert.deepEqual(bodyOf(await route.GET(request("/api/console/settings"))).data, { legacyPasswordLoginEnabled: true });

    const put = (body: unknown) => route.PUT(request("/api/console/settings", { method: "PUT", body }));
    assert.deepEqual(await engineDefaults.consoleSettingsCache.get(), fake.settings);
    fake.settings = { ...fake.settings, legacyPasswordLoginEnabled: false };
    const off = await put({ legacyPasswordLoginEnabled: false });
    assert.equal(off.status, 200);
    assert.deepEqual(bodyOf(off).data, { legacyPasswordLoginEnabled: false, warning: "LEGACY_LOGIN_DISABLED_WARNING" });
    assert.deepEqual(fake.calls.at(-1), { method: "setLegacyPasswordLogin", args: { actorId: ADMIN_UUID, enabled: false } });
    assert.equal((await engineDefaults.consoleSettingsCache.get()).legacyPasswordLoginEnabled, false, "the login route's memo sees the write");

    const on = await put({ legacyPasswordLoginEnabled: true });
    assert.deepEqual(bodyOf(on).data, { legacyPasswordLoginEnabled: true });
    for (const invalid of [{}, { legacyPasswordLoginEnabled: "false" }, { legacyPasswordLoginEnabled: true, extra: 1 }]) {
      assert.equal((await put(invalid)).status, 400, JSON.stringify(invalid));
    }
    const noOrigin = await route.PUT(request("/api/console/settings", { method: "PUT", body: { legacyPasswordLoginEnabled: true }, origin: null }));
    assert.equal(noOrigin.status, 403);
    assert.equal(bodyOf(noOrigin).code, "CSRF_REJECTED");
  });
});

test("POST /api/login is refused with LEGACY_LOGIN_DISABLED when the switch is off and reaches the body when it is on", async () => {
  const load = (settings: () => Promise<{ legacyPasswordLoginEnabled: boolean }>) => loadRoute("login", {
    "@/lib/session": { SESSION_COOKIE: "rnw_session", SESSION_TTL_SECONDS: 1, createSessionToken: async () => "unused" },
    "@/lib/security/host-login-config": { readHostLoginConfig: () => ({ isEnabled: true, userIds: new Set(["operator"]), password: "pw-fixture", passwordHash: undefined }) },
    "@/lib/security/host-password": { verifyHostPassword: async () => false },
    "@/lib/security/hmac": { timingSafeEqual: () => false },
    "@/lib/security/live-admission-store": { LiveAdmissionError: class extends Error {}, SupabaseLiveAdmissionStore: class {} },
    "@/lib/security/live-input-validation": { hostLoginInputSchema: { safeParse: () => ({ success: false }) } },
    "@/lib/security/live-rate-limit": { HostLoginRateLimitError: class extends Error {}, enforceHostLoginRateLimit: async () => undefined, enforceHostLoginCredentialRateLimits: async () => undefined },
    "@/lib/security/login-rate-limit": { loginRateLimiter: { check: () => ({ isAllowed: true, retryAfterSeconds: 0 }), recordFailure: () => ({ isAllowed: true, retryAfterSeconds: 0 }), clear: () => undefined } },
    "@/lib/console/engine-defaults": { consoleSettingsCache: { get: settings, invalidate: () => undefined } },
  });
  const disabled = await load(async () => ({ legacyPasswordLoginEnabled: false })).POST(request("/api/login", { method: "POST", body: { id: "operator", password: "pw", name: "Host" } }));
  assert.equal(disabled.status, 403);
  assert.equal(bodyOf(disabled).code, "LEGACY_LOGIN_DISABLED");
  const enabled = await load(async () => ({ legacyPasswordLoginEnabled: true })).POST(request("/api/login", { method: "POST", body: {} }));
  assert.equal(enabled.status, 400, "with the switch on, the route proceeds to body validation as before");
  assert.equal(bodyOf(enabled).code, "INVALID_LOGIN_REQUEST");
  const outage = await load(async () => { throw new ConsoleStoreError("down", "CONSOLE_STORE_UNAVAILABLE", 503); }).POST(request("/api/login", { method: "POST", body: {} }));
  assert.equal(outage.status, 503, "a cold console outage never silently re-enables password login");
  assert.equal(bodyOf(outage).code, "LOGIN_SECURITY_UNAVAILABLE");
});

test("GET /api/live-config adds the normalized engine defaults next to gatewayUrl and degrades to the catalog default on a console outage", async () => {
  await withEnvironment(async () => {
    const fake = installFakeStore({ settings: { legacyPasswordLoginEnabled: true, engine: { translation: { provider: "gemini", model: "gemini-3.5-flash-lite" } }, engineUpdatedAt: null, engineUpdatedByEmail: null } });
    const previousGateway = process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL;
    process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL = "wss://gateway.test/live";
    try {
      const route = loadRoute("live-config");
      const { data } = bodyOf(await route.GET(request("/api/live-config")));
      assert.deepEqual(data, { gatewayUrl: "wss://gateway.test/live", engineDefaults: { ...DEFAULT_ENGINE_SELECTION, translation: { provider: "gemini", model: "gemini-3.5-flash-lite" } } });
      fake.failWith = new ConsoleStoreError("down", "CONSOLE_STORE_UNAVAILABLE", 503);
      engineDefaults.consoleSettingsCache.invalidate();
      const degraded = bodyOf(await route.GET(request("/api/live-config")));
      assert.equal(degraded.ok, true);
      assert.deepEqual(degraded.data?.engineDefaults, DEFAULT_ENGINE_SELECTION);
    } finally {
      if (previousGateway === undefined) delete process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL; else process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL = previousGateway;
    }
  });
});
