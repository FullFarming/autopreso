import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as zod from "zod";

import * as captionEngineCatalog from "../../../packages/caption-core/caption-engine-catalog.js";
import { createSessionToken } from "../session";
import { requireAdminFromCookieValue } from "../auth/require-admin";
import { __setProfileReaderForTests } from "../auth/profile-status-cache";
import * as liveAuth from "../auth/live-auth";
import type { ProfileRecord } from "../auth/profile-store";
import * as boundedJsonBody from "../security/bounded-json-body";
import * as csrf from "../security/csrf";
import * as liveTopicValidation from "../security/live-topic-validation";
import * as sessionSummary from "./session-summary";
import * as consoleStore from "./console-store";
import * as engineDefaults from "./engine-defaults";

const { DEFAULT_ENGINE_SELECTION } = captionEngineCatalog;
import { type ActiveSessionRow, type ConsoleSessionRow, type ConsoleSettings, ConsoleStoreError, type SessionEngineSwitchResult, type SupabaseConsoleStore, __setConsoleStoreForTests } from "./console-store";

const ADMIN_UUID = "00000000-0000-4000-8000-000000000011";
const TARGET_UUID = "00000000-0000-4000-8000-000000000022";
const TARGET_HOST_ID = "host-target";
const ORIGIN = "https://nova.test";
const ADMIN: ProfileRecord = { id: ADMIN_UUID, email: "admin@x.io", displayName: "Admin", status: "approved", role: "admin", hostId: ADMIN_UUID };

const routeSource = (name: string) => readFileSync(new URL(`../../app/api/${name}/route.ts`, import.meta.url), "utf8");

// --- (a) source pins ---------------------------------------------------------

test("every console route is force-dynamic, guards with requireAdmin, and checks the origin before mutating", () => {
  for (const [name, mutating] of [["console/users", "PATCH"], ["console/users/[id]/active-sessions", null], ["console/sessions", null], ["console/engine-defaults", "PUT"], ["console/settings", "PUT"]] as const) {
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
  // I3: the count endpoint derives the host id from the profile row, never from the query or body.
  const activeSessions = routeSource("console/users/[id]/active-sessions");
  assert.match(activeSessions, /readProfileById\(/u);
  assert.match(activeSessions, /listActiveSessionsForHost\(target\.hostId\)/u);
  assert.doesNotMatch(activeSessions, /searchParams|hostId: string \}|readBoundedJsonBody/u, "no client-supplied host id");
});

test("the legacy login route refuses when the console switch is off and live-config carries engineDefaults", () => {
  const login = routeSource("login");
  assert.match(login, /consoleSettingsCache\.get\(\)/u);
  assert.match(login, /"LEGACY_LOGIN_DISABLED", 403/u);
  assert.ok(login.indexOf("readHostLoginConfig()") < login.indexOf("LEGACY_LOGIN_DISABLED"), "the switch is consulted after the env config parses");
  assert.ok(login.indexOf("LEGACY_LOGIN_DISABLED") < login.indexOf("readBoundedJsonBody(request)"), "the switch is consulted before the body is read");
  const liveConfig = routeSource("live-config");
  assert.match(liveConfig, /engineDefaults/u);
  assert.match(liveConfig, /resolveHostEngineAssignment\(hostId\)/u);
});

// --- (b) handler tests through the same transpile-and-inject harness host-session.test.ts uses ----

class TestResponse {
  body: unknown;
  status: number;
  headers: Headers;
  cookies = { set: () => undefined };
  constructor(body: unknown, status = 200, headers?: HeadersInit) { this.body = body; this.status = status; this.headers = new Headers(headers); }
}

type Handler = (request: unknown, context?: unknown) => Promise<TestResponse>;

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

// Task 6b: the deploy loop is transpiled with a fake gateway push and a fake token mint so the
// route tests can drive mixed per-session outcomes without a network or the signing secret.
interface PushCall { gatewayUrl: string; sessionId: string; engine: unknown; token: string }
const pushCalls: PushCall[] = [];
const mintCalls: Array<{ hostId: string; sessionId: string }> = [];
let pushOutcome: (sessionId: string, attempt: number) => { result: "switched" | "queued" | "failed"; code?: string } = () => ({ result: "switched" });
let mintFails = false;
/** Cooldown waits the deploy asked for (I1 retry); the harness never really sleeps. */
const sleeps: number[] = [];
const pushAttempts = new Map<string, number>();
const TOKEN_FIXTURE_PREFIX = "tok-fixture-";
const engineDeploy = loadTranspiled(readFileSync(new URL("./engine-deploy.ts", import.meta.url), "utf8"), {
  "../../../packages/caption-core/caption-engine-catalog.js": captionEngineCatalog,
  "../auth/live-auth": {
    ...liveAuth,
    createAdminGatewayToken: async ({ hostId, sessionId }: { hostId: string; sessionId: string }) => {
      mintCalls.push({ hostId, sessionId });
      if (mintFails) throw new Error("no signing secret");
      return { token: `${TOKEN_FIXTURE_PREFIX}${sessionId}`, claims: {} };
    },
  },
  "../live/gateway-engine-push": {
    pushEngineToGateway: async (args: PushCall) => {
      pushCalls.push(args);
      const attempt = (pushAttempts.get(args.sessionId) ?? 0) + 1;
      pushAttempts.set(args.sessionId, attempt);
      return pushOutcome(args.sessionId, attempt);
    },
  },
  "./console-store": consoleStore,
});
type DeployArgs = Parameters<typeof import("./engine-deploy").deployEngineToHostSessions>[0];
const engineDeployForRoutes = {
  ...engineDeploy,
  deployEngineToHostSessions: (args: DeployArgs) => (engineDeploy.deployEngineToHostSessions as (a: DeployArgs) => unknown)({ ...args, sleep: async (ms: number) => { sleeps.push(ms); } }),
};

function loadRoute(name: string, overrides: Record<string, unknown> = {}): Record<"GET" | "PATCH" | "PUT" | "POST", Handler> {
  return loadTranspiled(routeSource(name), {
    "next/server": {},
    zod,
    "@/lib/auth/live-auth": liveAuth,
    "@/lib/console/console-route": consoleRoute,
    "@/lib/console/session-summary": sessionSummary,
    "@/lib/console/console-store": consoleStore,
    "@/lib/console/engine-defaults": engineDefaults,
    "@/lib/console/engine-deploy": engineDeployForRoutes,
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
  activeSessions: ActiveSessionRow[];
  /** Per-session answer of `setSessionEngineAsAdmin`; `null` = the RPC matched no row; an Error = the RPC threw. */
  switchResults: Record<string, SessionEngineSwitchResult | null | Error>;
  failWith: ConsoleStoreError | null;
  /** When set, `recordEngineDeploy` throws it (the audit row is best-effort; the switch results still answer). */
  auditFailure: ConsoleStoreError | null;
  /** What `set_profile_voice_provider_v3` reports: `false` = the stored provider already matched (I1 no-op). */
  voiceProviderChanged: boolean;
  /** `readProfileById` answer; `null` = unknown profile. */
  profile: { id: string; status: string; role: string; hostId: string; voiceProvider: string; voiceProviderRevision: string } | null;
}

function installFakeStore(overrides: Partial<Pick<FakeStore, "settings" | "sessions" | "activeSessions" | "switchResults">> = {}): FakeStore {
  const fake: FakeStore = {
    calls: [], failWith: null, auditFailure: null, voiceProviderChanged: true,
    profile: { id: TARGET_UUID, status: "approved", role: "host", hostId: TARGET_HOST_ID, voiceProvider: "soniox", voiceProviderRevision: "1" },
    settings: overrides.settings ?? { legacyPasswordLoginEnabled: true, engine: null, engineUpdatedAt: null, engineUpdatedByEmail: null },
    sessions: overrides.sessions ?? [],
    activeSessions: overrides.activeSessions ?? [],
    switchResults: overrides.switchResults ?? {},
  };
  const record = (method: string) => async (args: unknown) => {
    fake.calls.push({ method, args });
    if (fake.failWith) throw fake.failWith;
    if (method === "recordEngineDeploy" && fake.auditFailure) throw fake.auditFailure;
    switch (method) {
      case "listActiveSessionsForHost": return fake.activeSessions;
      case "setSessionEngineAsAdmin": {
        const { sessionId } = args as { sessionId: string };
        const answer = sessionId in fake.switchResults ? fake.switchResults[sessionId] : { id: sessionId, status: "live", version: 2 };
        if (answer instanceof Error) throw answer;
        return answer;
      }
      case "listProfiles": return [{ ...ADMIN, id: TARGET_UUID, hostId: TARGET_UUID, email: "b@x.io", role: "host", status: "pending", createdAt: "2026-09-02T00:00:00+00:00", lastLoginAt: null, approvedAt: null }];
      case "countPending": return 1;
      case "setProfileStatus": return { id: TARGET_UUID, status: (args as { status: string }).status, role: "host" };
      case "setProfileVoiceProvider": return { id: TARGET_UUID, status: "approved", role: "host", hostId: TARGET_HOST_ID, provider: (args as { provider: string }).provider, revision: fake.voiceProviderChanged ? "2" : "1", changed: fake.voiceProviderChanged };
      case "readProfileById": return fake.profile;
      case "setProfileRole": return { id: TARGET_UUID, status: "approved", role: (args as { role: string }).role };
      case "listSessions": return fake.sessions;
      case "readSettings": return fake.settings;
      default: return undefined;
    }
  };
  const store = Object.fromEntries(["listProfiles", "countPending", "setProfileStatus", "setProfileRole", "setProfileVoiceProvider", "listSessions", "readSettings", "setLegacyPasswordLogin", "listActiveSessionsForHost", "setSessionEngineAsAdmin", "recordEngineDeploy", "readProfileById"].map((m) => [m, record(m)]));
  __setConsoleStoreForTests(store as unknown as SupabaseConsoleStore);
  return fake;
}

async function withEnvironment(run: () => Promise<void>) {
  const previous = {
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS, SONIOX_API_KEY: process.env.SONIOX_API_KEY, GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    LIVE_GATEWAY_URL: process.env.LIVE_GATEWAY_URL, NEXT_PUBLIC_LIVE_GATEWAY_URL: process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL,
  };
  process.env.ALLOWED_ORIGINS = ORIGIN;
  process.env.LIVE_GATEWAY_URL = "wss://gateway.test/live";
  delete process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL;
  pushCalls.length = 0;
  mintCalls.length = 0;
  sleeps.length = 0;
  pushAttempts.clear();
  mintFails = false;
  pushOutcome = () => ({ result: "switched" });
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

test("GET /api/console/engine-defaults returns the key-availability catalog only (M3: no misleading global engine); PUT is retired with 410", async () => {
  await withEnvironment(async () => {
    process.env.GEMINI_API_KEY = "set";
    delete process.env.SONIOX_API_KEY;
    const stored = { stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" }, translation: { provider: "gemini", model: "gemini-3.7-flash" }, summary: { provider: "gemini", model: "gemini-3.7-flash" } };
    const fake = installFakeStore({ settings: { legacyPasswordLoginEnabled: true, engine: stored, engineUpdatedAt: "2026-09-03T00:00:00+00:00", engineUpdatedByEmail: "admin@x.io" } });
    const route = loadRoute("console/engine-defaults", adminModule());
    const result = await route.GET(request("/api/console/engine-defaults"));
    assert.equal(result.status, 200);
    const { data } = bodyOf(result);
    assert.deepEqual(Object.keys(data ?? {}), ["catalog"], "the retired engine_defaults value is not surfaced as if it decided anything");
    const catalog = data?.catalog as { stt: Array<{ provider: string; available: boolean; requiredApiKey: string }>; defaults: unknown };
    assert.deepEqual(catalog.defaults, DEFAULT_ENGINE_SELECTION);
    assert.equal(catalog.stt.find((e) => e.provider === "gemini")?.available, true);
    assert.equal(catalog.stt.find((e) => e.provider === "soniox")?.available, false);
    assert.doesNotMatch(JSON.stringify(data), /"set"/u, "the catalog carries booleans, never key values");
    assert.equal(fake.calls.length, 0, "the catalog needs no store read");

    // D1 retired the global engine: the value decides nothing, so a PUT is refused after the same guards
    // (origin, admin) and never reaches the store or a session.
    const put = (body: unknown, origin?: string | null) => route.PUT(request("/api/console/engine-defaults", { method: "PUT", body, origin }));
    const retired = await put({ engine: DEFAULT_ENGINE_SELECTION });
    assert.equal(retired.status, 410);
    assert.equal(bodyOf(retired).code, "ENGINE_DEFAULTS_RETIRED");
    assert.equal(retired.headers.get("cache-control"), "private, no-store");
    assert.equal((await put({})).status, 410, "no body validation: the endpoint is gone regardless of payload");
    const foreign = await put({ engine: DEFAULT_ENGINE_SELECTION }, "https://evil.test");
    assert.equal(bodyOf(foreign).code, "CSRF_REJECTED");
    const asHost = await loadRoute("console/engine-defaults", adminModule("host")).PUT(request("/api/console/engine-defaults", { method: "PUT", body: { engine: DEFAULT_ENGINE_SELECTION } }));
    assert.equal(asHost.status, 403);
    assert.deepEqual(fake.calls.map((c) => c.method).filter((m) => m !== "readSettings"), [], "a retired PUT writes nothing");
    assert.equal(pushCalls.length, 0);
  });
});

// --- Task 6b: the deploy push ------------------------------------------------------

const SESSION_A = "00000000-0000-4000-8000-0000000000a1";
const SESSION_B = "00000000-0000-4000-8000-0000000000a2";
const SESSION_C = "00000000-0000-4000-8000-0000000000a3";
const methodsOf = (fake: FakeStore, method: string) => fake.calls.filter((c) => c.method === method);

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
    "@/lib/auth/bootstrap-admins": {},
    "@/lib/auth/profile-store": {},
    "@/lib/auth/profile-status-cache": {},
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

test("live-config authenticates and fails closed rather than replacing a user's assignment", async () => {
  let failure = false;
  const route = loadRoute("live-config", {
    "@/lib/auth/live-auth": { ...liveAuth, requireHost: async () => ({ hostId: "user-a" }) },
    "@/lib/console/engine-defaults": { ...engineDefaults, resolveHostEngineAssignment: async (hostId: string) => {
      assert.equal(hostId, "user-a"); if (failure) throw new Error("offline");
      return { engine: DEFAULT_ENGINE_SELECTION, assignmentRevision: "4" };
    } },
  });
  const accepted = await route.GET(request("/api/live-config"));
  assert.equal(accepted.status,200);
  assert.equal(bodyOf(accepted).data?.assignmentRevision,"4");
  assert.equal(accepted.headers.get("cache-control"),"private, no-store");
  failure = true;
  const denied = await route.GET(request("/api/live-config"));
  assert.equal(denied.status,503); assert.equal(bodyOf(denied).code,"ENGINE_ASSIGNMENT_UNAVAILABLE");
  const anonymous = loadRoute("live-config", { "@/lib/auth/live-auth": { ...liveAuth, requireHost: async () => { throw new liveAuth.AuthenticationError("auth"); } } });
  assert.equal((await anonymous.GET(request("/api/live-config"))).status,401);
});

const assignRequest = (voiceProvider: string) => request("/api/console/users", { method: "PATCH", body: { profileId: TARGET_UUID, voiceProvider } });
const GEMINI_ASSIGNED = engineDefaults.engineSelectionForVoiceProvider("gemini");
const SONIOX_ASSIGNED = engineDefaults.engineSelectionForVoiceProvider("soniox");

test("PATCH voiceProvider writes the profile, then switches each of that user's running sessions: admin RPC with the revision, one push per session, mixed results, one audit row", async () => {
  await withEnvironment(async () => {
    const fake = installFakeStore({ activeSessions: [
      { id: SESSION_A, status: "live", languages: ["ko", "en"] },
      { id: SESSION_B, status: "preparing", languages: ["ja"] },
      { id: SESSION_C, status: "live", languages: ["ko", "en", "ja"] },
    ] });
    pushOutcome = (sessionId) => sessionId === SESSION_A ? { result: "switched" } : sessionId === SESSION_B ? { result: "queued" } : { result: "failed", code: "MEDIA_DRAINING" };
    const route = loadRoute("console/users", adminModule());
    const result = await route.PATCH(assignRequest("gemini"));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(bodyOf(result).data, {
      id: TARGET_UUID, status: "approved", role: "host", voiceProvider: "gemini",
      results: [
        { sessionId: SESSION_A, result: "switched" },
        { sessionId: SESSION_B, result: "queued" },
        { sessionId: SESSION_C, result: "failed", code: "MEDIA_DRAINING" },
      ],
      summary: { switched: 1, queued: 1, failed: 1 },
      changed: true,
    });
    // Order: profile write, that host's sessions (never the global list), one admin RPC per session carrying the profile revision, then the audit row.
    assert.deepEqual(fake.calls[0], { method: "setProfileVoiceProvider", args: { actorId: ADMIN_UUID, profileId: TARGET_UUID, provider: "gemini" } });
    assert.deepEqual(fake.calls[1], { method: "listActiveSessionsForHost", args: TARGET_HOST_ID });
    const switches = methodsOf(fake, "setSessionEngineAsAdmin").map((c) => c.args as { actorId: string; sessionId: string; engine: unknown; assignmentRevision: string });
    assert.deepEqual(switches.map((c) => c.sessionId).sort(), [SESSION_A, SESSION_B, SESSION_C]);
    for (const call of switches) {
      assert.equal(call.actorId, ADMIN_UUID);
      assert.equal(call.assignmentRevision, "2");
      assert.deepEqual(call.engine, GEMINI_ASSIGNED);
    }
    assert.deepEqual(pushCalls.map((c) => c.sessionId).sort(), [SESSION_A, SESSION_B, SESSION_C]);
    for (const call of pushCalls) {
      assert.equal(call.gatewayUrl, "wss://gateway.test/live");
      assert.deepEqual(call.engine, GEMINI_ASSIGNED);
      assert.equal(call.token, `${TOKEN_FIXTURE_PREFIX}${call.sessionId}`, "each push carries its own session-bound token");
    }
    // The token is minted for the acting admin's host id, bound to each session, and never appears in the response.
    assert.deepEqual(mintCalls.map((c) => c.hostId), [ADMIN_UUID, ADMIN_UUID, ADMIN_UUID]);
    assert.doesNotMatch(JSON.stringify(bodyOf(result)), new RegExp(TOKEN_FIXTURE_PREFIX, "u"));
    assert.deepEqual(fake.calls.at(-1), { method: "recordEngineDeploy", args: {
      actorId: ADMIN_UUID, engine: GEMINI_ASSIGNED, summary: { switched: 1, queued: 1, failed: 1 },
      target: { profileId: TARGET_UUID, hostId: TARGET_HOST_ID, voiceProvider: "gemini", revision: "2" },
    } });
    assert.equal(methodsOf(fake, "recordEngineDeploy").length, 1);
  });
});

test("PATCH voiceProvider with no running session still answers the full shape and records the zero-counter audit row", async () => {
  await withEnvironment(async () => {
    const fake = installFakeStore();
    const result = await loadRoute("console/users", adminModule()).PATCH(assignRequest("soniox"));
    assert.equal(result.status, 200);
    assert.deepEqual(bodyOf(result).data, { id: TARGET_UUID, status: "approved", role: "host", voiceProvider: "soniox", results: [], summary: { switched: 0, queued: 0, failed: 0 }, changed: true });
    assert.deepEqual(fake.calls.map((c) => c.method), ["setProfileVoiceProvider", "listActiveSessionsForHost", "recordEngineDeploy"]);
    assert.deepEqual((fake.calls.at(-1)?.args as { engine: unknown }).engine, SONIOX_ASSIGNED);
    assert.equal(pushCalls.length, 0);
  });
});

test("I2: an unreachable gateway is a queued row (the DB is written; the host lease re-pins on reconnect), never failed", async () => {
  await withEnvironment(async () => {
    const fake = installFakeStore({ activeSessions: [{ id: SESSION_A, status: "live", languages: ["ko", "en"] }, { id: SESSION_B, status: "live", languages: ["en"] }] });
    pushOutcome = () => ({ result: "failed", code: "GATEWAY_UNREACHABLE" });
    const result = await loadRoute("console/users", adminModule()).PATCH(assignRequest("gemini"));
    assert.equal(result.status, 200, "a gateway outage is a per-session result, not a request failure");
    const { data } = bodyOf(result);
    assert.deepEqual(data?.results, [{ sessionId: SESSION_A, result: "queued", code: "GATEWAY_UNREACHABLE" }, { sessionId: SESSION_B, result: "queued", code: "GATEWAY_UNREACHABLE" }]);
    assert.deepEqual(data?.summary, { switched: 0, queued: 2, failed: 0 });
    assert.equal(methodsOf(fake, "setProfileVoiceProvider").length, 1);
    assert.equal(methodsOf(fake, "setSessionEngineAsAdmin").length, 2, "both session records carry the new engine even though no gateway confirmed");
    assert.equal(pushCalls.length, 2, "a transport failure is not retried - only the cooldown 429 is");
    assert.deepEqual(sleeps, []);

    // No gateway configured at all: same DB writes, LIVE_GATEWAY_URL_MISSING queued rows, nothing pushed or minted.
    delete process.env.LIVE_GATEWAY_URL;
    pushCalls.length = 0; mintCalls.length = 0;
    const unconfigured = installFakeStore({ activeSessions: [{ id: SESSION_A, status: "live", languages: ["ko", "en"] }] });
    const missing = await loadRoute("console/users", adminModule()).PATCH(assignRequest("gemini"));
    assert.deepEqual(bodyOf(missing).data?.results, [{ sessionId: SESSION_A, result: "queued", code: "LIVE_GATEWAY_URL_MISSING" }]);
    assert.equal(methodsOf(unconfigured, "setSessionEngineAsAdmin").length, 1);
    assert.equal(pushCalls.length, 0);
    assert.equal(mintCalls.length, 0);
    // The public URL is the fallback when the server-only one is absent.
    process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL = "wss://public.test/live";
    installFakeStore({ activeSessions: [{ id: SESSION_A, status: "live", languages: ["ko", "en"] }] });
    await loadRoute("console/users", adminModule()).PATCH(assignRequest("gemini"));
    assert.equal(pushCalls[0]?.gatewayUrl, "wss://public.test/live");
  });
});

test("a session that stopped between the list and the switch is SESSION_NOT_ACTIVE, a throwing RPC keeps its code, and neither is pushed", async () => {
  await withEnvironment(async () => {
    installFakeStore({
      activeSessions: [{ id: SESSION_A, status: "live", languages: ["ko"] }, { id: SESSION_B, status: "live", languages: ["ko"] }, { id: SESSION_C, status: "live", languages: ["ko"] }],
      switchResults: { [SESSION_A]: null, [SESSION_B]: new ConsoleStoreError("nope", "ACTOR_NOT_ADMIN", 403), [SESSION_C]: new TypeError("fetch failed") },
    });
    const result = await loadRoute("console/users", adminModule()).PATCH(assignRequest("gemini"));
    assert.equal(result.status, 200);
    assert.deepEqual(bodyOf(result).data?.results, [
      { sessionId: SESSION_A, result: "failed", code: "SESSION_NOT_ACTIVE" },
      { sessionId: SESSION_B, result: "failed", code: "ACTOR_NOT_ADMIN" },
      { sessionId: SESSION_C, result: "failed", code: "SESSION_SWITCH_FAILED" },
    ]);
    assert.equal(pushCalls.length, 0);
    assert.equal(mintCalls.length, 0);
  });
});

test("the catalog language guard runs before any session write: 1-3 distinct languages pass for Soniox, more or duplicates fail that session only", async () => {
  await withEnvironment(async () => {
    const fake = installFakeStore({ activeSessions: [
      { id: SESSION_A, status: "live", languages: ["ko", "en", "ja"] },
      { id: SESSION_B, status: "live", languages: ["ko", "en", "ja", "zh"] },
      { id: SESSION_C, status: "live", languages: ["ko", "ko"] },
    ] });
    const result = await loadRoute("console/users", adminModule()).PATCH(assignRequest("soniox"));
    assert.deepEqual(bodyOf(result).data?.results, [
      { sessionId: SESSION_A, result: "switched" },
      { sessionId: SESSION_B, result: "failed", code: "ENGINE_LANGUAGE_COUNT_INVALID" },
      { sessionId: SESSION_C, result: "failed", code: "ENGINE_LANGUAGE_COUNT_INVALID" },
    ]);
    assert.deepEqual(bodyOf(result).data?.summary, { switched: 1, queued: 0, failed: 2 });
    assert.deepEqual(methodsOf(fake, "setSessionEngineAsAdmin").map((c) => (c.args as { sessionId: string }).sessionId), [SESSION_A], "refused sessions are never written");
    assert.deepEqual(pushCalls.map((c) => c.sessionId), [SESSION_A]);
    assert.deepEqual(pushCalls[0].engine, SONIOX_ASSIGNED);
  });
});

test("I1: PATCH with the provider the profile already holds writes nothing else - no session RPC, no push, no audit row - and answers changed: false", async () => {
  await withEnvironment(async () => {
    const fake = installFakeStore({ activeSessions: [{ id: SESSION_A, status: "live", languages: ["ko", "en"] }, { id: SESSION_B, status: "live", languages: ["ko"] }] });
    fake.voiceProviderChanged = false;
    const result = await loadRoute("console/users", adminModule()).PATCH(assignRequest("soniox"));
    assert.equal(result.status, 200);
    assert.deepEqual(bodyOf(result).data, { id: TARGET_UUID, status: "approved", role: "host", voiceProvider: "soniox", results: [], summary: { switched: 0, queued: 0, failed: 0 }, changed: false });
    assert.deepEqual(fake.calls.map((c) => c.method), ["setProfileVoiceProvider"], "the profile RPC is the only store call");
    assert.equal(pushCalls.length, 0);
    assert.equal(mintCalls.length, 0);
  });
});

test("I1: a 429 ENGINE_SWITCH_RATE_LIMITED push waits the gateway cooldown once and retries; success is switched, a second 429 is queued", async () => {
  await withEnvironment(async () => {
    installFakeStore({ activeSessions: [{ id: SESSION_A, status: "live", languages: ["ko", "en"] }, { id: SESSION_B, status: "live", languages: ["ko", "en"] }, { id: SESSION_C, status: "live", languages: ["ko"] }] });
    pushOutcome = (sessionId, attempt) => {
      if (sessionId === SESSION_A) return attempt === 1 ? { result: "failed", code: "ENGINE_SWITCH_RATE_LIMITED" } : { result: "switched" };
      if (sessionId === SESSION_B) return { result: "failed", code: "ENGINE_SWITCH_RATE_LIMITED" };
      return { result: "switched" };
    };
    const result = await loadRoute("console/users", adminModule()).PATCH(assignRequest("gemini"));
    const { data } = bodyOf(result);
    assert.deepEqual(data?.results, [
      { sessionId: SESSION_A, result: "switched" },
      { sessionId: SESSION_B, result: "queued", code: "ENGINE_SWITCH_RATE_LIMITED" },
      { sessionId: SESSION_C, result: "switched" },
    ]);
    assert.deepEqual(data?.summary, { switched: 2, queued: 1, failed: 0 });
    assert.deepEqual(Object.fromEntries(pushAttempts), { [SESSION_A]: 2, [SESSION_B]: 2, [SESSION_C]: 1 }, "exactly one retry per rate-limited session");
    assert.deepEqual(sleeps, [2200, 2200], "each retry waits the 2 s gateway cooldown plus margin");
    // The retry carries a fresh session-bound token; the same token is never reused after a wait.
    assert.equal(mintCalls.filter((c) => c.sessionId === SESSION_A).length, 2);
  });
});

test("I2: transport-class push outcomes are queued with their code; gateway verdicts on the request itself stay failed", async () => {
  await withEnvironment(async () => {
    const SESSION_D = "00000000-0000-4000-8000-0000000000a4", SESSION_E = "00000000-0000-4000-8000-0000000000a5";
    installFakeStore({ activeSessions: [SESSION_A, SESSION_B, SESSION_C, SESSION_D, SESSION_E].map((id) => ({ id, status: "live", languages: ["ko", "en"] })) });
    const outcomes: Record<string, { result: "switched" | "queued" | "failed"; code?: string }> = {
      [SESSION_A]: { result: "failed", code: "GATEWAY_TIMEOUT" },
      [SESSION_B]: { result: "failed", code: "GATEWAY_HTTP_503" },
      [SESSION_C]: { result: "failed", code: "GATEWAY_HTTP_400" },
      [SESSION_D]: { result: "failed", code: "MEDIA_DRAINING" },
      [SESSION_E]: { result: "failed", code: "GATEWAY_SHUTTING_DOWN" },
    };
    pushOutcome = (sessionId) => outcomes[sessionId];
    const result = await loadRoute("console/users", adminModule()).PATCH(assignRequest("gemini"));
    assert.deepEqual(bodyOf(result).data?.results, [
      { sessionId: SESSION_A, result: "queued", code: "GATEWAY_TIMEOUT" },
      { sessionId: SESSION_B, result: "queued", code: "GATEWAY_HTTP_503" },
      { sessionId: SESSION_C, result: "failed", code: "GATEWAY_HTTP_400" },
      { sessionId: SESSION_D, result: "failed", code: "MEDIA_DRAINING" },
      { sessionId: SESSION_E, result: "queued", code: "GATEWAY_SHUTTING_DOWN" },
    ]);
    assert.deepEqual(bodyOf(result).data?.summary, { switched: 0, queued: 3, failed: 2 });
    assert.deepEqual(sleeps, []);

    // No admin token can be minted (signing secret missing): the DB write stands, the row is queued.
    mintFails = true; pushCalls.length = 0;
    const fake = installFakeStore({ activeSessions: [{ id: SESSION_A, status: "live", languages: ["ko", "en"] }] });
    const unsigned = await loadRoute("console/users", adminModule()).PATCH(assignRequest("gemini"));
    assert.deepEqual(bodyOf(unsigned).data?.results, [{ sessionId: SESSION_A, result: "queued", code: "ADMIN_TOKEN_UNAVAILABLE" }]);
    assert.equal(methodsOf(fake, "setSessionEngineAsAdmin").length, 1);
    assert.equal(pushCalls.length, 0);
  });
});

test("I3: GET /api/console/users/[id]/active-sessions counts that profile's preparing/live sessions from the server-side host id", async () => {
  await withEnvironment(async () => {
    const fake = installFakeStore({ activeSessions: [{ id: SESSION_A, status: "live", languages: ["ko", "en"] }, { id: SESSION_B, status: "preparing", languages: ["ja"] }] });
    const route = loadRoute("console/users/[id]/active-sessions", adminModule());
    const get = (id: string) => route.GET(request(`/api/console/users/${id}/active-sessions`), { params: Promise.resolve({ id }) });
    const result = await get(TARGET_UUID);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(bodyOf(result).data, { count: 2, sessions: [{ id: SESSION_A, status: "live", languages: ["ko", "en"] }, { id: SESSION_B, status: "preparing", languages: ["ja"] }] });
    assert.deepEqual(fake.calls.map((c) => c.method), ["readProfileById", "listActiveSessionsForHost"]);
    assert.deepEqual(fake.calls[0].args, { actorId: ADMIN_UUID, profileId: TARGET_UUID });
    assert.equal(fake.calls[1].args, TARGET_HOST_ID, "the host id comes from the profile row");

    assert.equal((await get("not-a-uuid")).status, 400);
    fake.profile = null;
    const unknown = await get(TARGET_UUID);
    assert.equal(unknown.status, 404);
    assert.equal(bodyOf(unknown).code, "PROFILE_NOT_FOUND");
    const denied = await loadRoute("console/users/[id]/active-sessions", adminModule("host")).GET(request(`/api/console/users/${TARGET_UUID}/active-sessions`), { params: Promise.resolve({ id: TARGET_UUID }) });
    assert.equal(denied.status, 403);
    assert.equal(bodyOf(denied).code, "ADMIN_REQUIRED");
  });
});

test("the audit row is best-effort: a failing record_console_deploy never hides the switch results", async () => {
  await withEnvironment(async () => {
    const fake = installFakeStore({ activeSessions: [{ id: SESSION_A, status: "live", languages: ["ko", "en"] }] });
    fake.auditFailure = new ConsoleStoreError("down", "CONSOLE_STORE_UNAVAILABLE", 503);
    const result = await loadRoute("console/users", adminModule()).PATCH(assignRequest("gemini"));
    assert.equal(result.status, 200);
    assert.deepEqual(bodyOf(result).data?.results, [{ sessionId: SESSION_A, result: "switched" }]);
    assert.equal(methodsOf(fake, "recordEngineDeploy").length, 1, "the audit was attempted");
  });
});

test("only an admin can assign a known provider; a refused or failed profile write never lists or touches a session", async () => {
  await withEnvironment(async () => {
    const fake = installFakeStore({ activeSessions: [{ id: SESSION_A, status: "live", languages: ["ko", "en"] }] });
    const route = loadRoute("console/users", adminModule());
    const patch = (body: unknown) => route.PATCH(request("/api/console/users", { method: "PATCH", body }));
    for (const body of [{ profileId: TARGET_UUID, voiceProvider: "attacker" }, { profileId: TARGET_UUID, voiceProvider: "soniox", role: "admin" }, { profileId: TARGET_UUID, voiceProvider: "soniox", status: "approved" }]) {
      assert.equal((await patch(body)).status, 400, JSON.stringify(body));
    }
    const denied = await loadRoute("console/users", adminModule("host")).PATCH(assignRequest("gemini"));
    assert.equal(denied.status, 403);
    assert.equal(bodyOf(denied).code, "ADMIN_REQUIRED");
    assert.equal(fake.calls.length, 0);
    fake.failWith = new ConsoleStoreError("사용자를 찾을 수 없습니다.", "PROFILE_NOT_FOUND", 404);
    const missing = await patch({ profileId: TARGET_UUID, voiceProvider: "gemini" });
    assert.equal(missing.status, 404);
    assert.equal(bodyOf(missing).code, "PROFILE_NOT_FOUND");
    assert.deepEqual(fake.calls.map((c) => c.method), ["setProfileVoiceProvider"], "the failed write is the only store call");
    assert.equal(pushCalls.length, 0);
  });
});

test("legacy admin bootstrap happens only after valid credentials and issues no cookie on setup failure", async () => {
  const priorIds = process.env.ADMIN_USER_IDS; process.env.ADMIN_USER_IDS = "noel";
  __setProfileReaderForTests(async () => ({ ...ADMIN, hostId: "noel" }));
  let issuedToken = "";
  try {
  let valid = false; let bootstraps = 0; let tokens = 0; let bootstrapFails = false;
  const route = loadRoute("login", {
    "@/lib/session": { SESSION_COOKIE:"rnw_session",SESSION_TTL_SECONDS:3600,createSessionToken:async () => {tokens++;issuedToken=await createSessionToken("noel");return issuedToken;} },
    "@/lib/auth/bootstrap-admins": {readBootstrapAdminConfig:()=>({legacyHostId:"noel",emails:new Set(["admin@example.test"])})},
    "@/lib/auth/profile-store": {ProfileStoreError:class extends Error{},SupabaseProfileStore:class {async ensureLegacyAdmin(){bootstraps++;if(bootstrapFails)throw new Error("offline");return {role:"admin"};}}},
    "@/lib/auth/profile-status-cache": {profileStatusCache:{invalidate:()=>undefined}},
    "@/lib/security/host-login-config": {readHostLoginConfig:()=>({isEnabled:true,userIds:new Set(["noel"]),passwordHash:"fixture",password:""})},
    "@/lib/security/host-password": {verifyHostPassword:async()=>valid},
    "@/lib/security/hmac": {timingSafeEqual:()=>false},
    "@/lib/security/live-admission-store": {LiveAdmissionError:class extends Error{},SupabaseLiveAdmissionStore:class{}},
    "@/lib/security/live-input-validation": {hostLoginInputSchema:{safeParse:()=>({success:true,data:{id:"noel",password:"test-fixture",name:"Host"}})}},
    "@/lib/security/live-rate-limit": {HostLoginRateLimitError:class extends Error{},enforceHostLoginRateLimit:async()=>undefined,enforceHostLoginCredentialRateLimits:async()=>undefined},
    "@/lib/security/login-rate-limit": {loginRateLimiter:{check:()=>({isAllowed:true}),recordFailure:()=>({isAllowed:true}),clear:()=>undefined}},
    "@/lib/console/engine-defaults": {consoleSettingsCache:{get:async()=>({legacyPasswordLoginEnabled:true})}},
  });
  assert.equal((await route.POST(request("/api/login",{method:"POST",body:{}}))).status,401);
  assert.equal(bootstraps,0);assert.equal(tokens,0);
  valid=true;bootstrapFails=true;
  assert.equal((await route.POST(request("/api/login",{method:"POST",body:{}}))).status,503);
  assert.equal(bootstraps,1);assert.equal(tokens,0);
  bootstrapFails=false;
  const result=await route.POST(request("/api/login",{method:"POST",body:{}}));
  assert.equal(result.status,200);assert.equal(bodyOf(result).data?.role,"admin");
  assert.equal(tokens,1);
  const actor = await requireAdminFromCookieValue(issuedToken);
  assert.equal(actor.hostId,"noel");assert.equal(actor.profile.role,"admin");assert.equal(actor.profile.id,ADMIN_UUID);
  } finally { __setProfileReaderForTests(null);if(priorIds===undefined)delete process.env.ADMIN_USER_IDS;else process.env.ADMIN_USER_IDS=priorIds; }
});
