import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createGatewayToken,
  createRecapGrantToken,
  createViewerGrantToken,
  verifyGatewayToken,
  verifyRecapGrantToken,
  verifyViewerGrantToken,
} from "../auth/live-auth";
import { LANGUAGE_CODES } from "../languageDetect";
import {
  assertStrictOrigin,
  canonicalRequestOrigin,
  CsrfError,
  isPublicUnauthenticatedPath,
  isViewerSnapshotPath,
} from "./csrf";
import { getSupabaseServerConfig, isKnownInsecureSecret, LiveSecurityConfigurationError } from "./config";
import { hmacHex } from "./hmac";
import { readHostLoginConfig } from "./host-login-config";
import { createLoginRateLimiter } from "./login-rate-limit";
import {
  admissionActionInputSchema,
  createLiveInviteInputSchema,
  createLiveSessionInputSchema,
  glossaryPackInputSchema,
  hostLoginInputSchema,
  joinLiveSessionInputSchema,
  outputModeInputSchema,
  voiceProviderInputSchema,
  sanitizeViewerDisplayName,
  sessionTypeInputSchema,
  updateLiveSessionInputSchema,
} from "./live-input-validation";
import { createLiveInviteToken, SupabaseLiveAdmissionStore } from "./live-admission-store";
import {
  enforceAdmissionCodeAttemptRateLimit,
  enforceGatewayTokenRateLimit,
  enforceSummaryGenerationRateLimit,
  enforceJoinPreflightRateLimits,
  enforceHostLoginRateLimit,
  enforceSessionJoinRateLimit,
  type RateLimitStore,
} from "./live-rate-limit";
import {
  getSupabasePublicAccess,
  getSupabaseServerAccess,
  supabaseAdminHeaders,
} from "./supabase-server-access";

function requestHeaders(values: Record<string, string>): { headers: Headers } {
  return { headers: new Headers(values) };
}

function legacySupabaseKey(role: "anon" | "service_role"): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role })).toString("base64url");
  return `${header}.${payload}.${"s".repeat(32)}`;
}

test("strict origin rejects prefix attacks, non-origin URLs, missing headers, and port changes", () => {
  process.env.ALLOWED_ORIGINS = "https://portal.example.com";
  assert.equal(assertStrictOrigin(requestHeaders({ origin: "https://portal.example.com" })), "https://portal.example.com");
  assert.equal(assertStrictOrigin(requestHeaders({ origin: "HTTPS://PORTAL.EXAMPLE.COM/" })), "https://portal.example.com");
  assert.throws(() => assertStrictOrigin(requestHeaders({ origin: "https://portal.example.com.evil.com" })), CsrfError);
  assert.throws(() => assertStrictOrigin(requestHeaders({ origin: "https://portal.example.com:444" })), CsrfError);
  assert.throws(() => assertStrictOrigin(requestHeaders({ origin: "https://portal.example.com/forged-path" })), CsrfError);
  assert.throws(() => assertStrictOrigin(requestHeaders({ origin: "https://portal.example.com?forged=true" })), CsrfError);
  assert.throws(() => assertStrictOrigin(requestHeaders({ origin: "https://user@portal.example.com" })), CsrfError);
  assert.throws(() => assertStrictOrigin(requestHeaders({})), CsrfError);
});

test("viewer routes are public only by exact path while mutating requests still require origin", () => {
  for (const pathname of ["/watch", "/m/watch", "/api/live-sessions/join"]) {
    assert.equal(isPublicUnauthenticatedPath(pathname), true);
  }
  for (const pathname of ["/watch/host", "/m/watch-extra", "/api/live-sessions/join/other"]) {
    assert.equal(isPublicUnauthenticatedPath(pathname), false);
  }
  assert.equal(isViewerSnapshotPath(`/api/live-sessions/${crypto.randomUUID()}/snapshot`), true);
  assert.equal(isViewerSnapshotPath(`/api/live-sessions/${crypto.randomUUID()}/leave`), true);
  assert.equal(isViewerSnapshotPath("/api/live-sessions/not/a/snapshot"), false);
  process.env.ALLOWED_ORIGINS = "https://portal.example.com";
  assert.throws(() => assertStrictOrigin(requestHeaders({ origin: "https://portal.example.com.evil.test" })), CsrfError);
  const middlewareSource = readFileSync(new URL("../../middleware.ts", import.meta.url), "utf8");
  assert.ok(middlewareSource.indexOf("assertStrictOrigin(request)") < middlewareSource.indexOf("isPublicUnauthenticatedPath(pathname)"));
  assert.match(middlewareSource, /new Set\(\["POST", "PUT", "PATCH", "DELETE"\]\)/u);
});

test("origin normalization supports only a configured stable Chrome extension id", () => {
  process.env.ALLOWED_ORIGINS = "https://portal.example.com";
  const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  process.env.CHROME_EXTENSION_ORIGIN = extensionOrigin;
  assert.equal(canonicalRequestOrigin(extensionOrigin), extensionOrigin);
  assert.equal(
    assertStrictOrigin(requestHeaders({ origin: extensionOrigin })),
    extensionOrigin,
  );
  assert.throws(
    () => assertStrictOrigin(requestHeaders({ origin: "chrome-extension://differentextension" })),
    CsrfError,
  );
});

test("viewer token rejects tampering and expiry", async () => {
  const now = Date.UTC(2026, 6, 19);
  const signed = await createViewerGrantToken({ grantId: "grant-1", sessionId: "session-1", userId: "user-1" }, now);
  assert.equal((await verifyViewerGrantToken(signed.token, now + 1)).sessionId, "session-1");
  await assert.rejects(() => verifyViewerGrantToken(`${signed.token.slice(0, -1)}0`, now + 1));
  await assert.rejects(() => verifyViewerGrantToken(signed.token, now + 6 * 60 * 60 * 1000));
});

test("recap credential is session-bound for thirty days and cannot act as a viewer grant", async () => {
  const now = Date.UTC(2026, 6, 23);
  const signed = await createRecapGrantToken({ sessionId: "session-1", userId: "user-1" }, now);
  const claims = await verifyRecapGrantToken(signed.token, now + 29 * 24 * 60 * 60 * 1000);
  assert.equal(claims.sessionId, "session-1");
  await assert.rejects(() => verifyViewerGrantToken(signed.token, now + 1));
  await assert.rejects(() => verifyRecapGrantToken(signed.token, now + 30 * 24 * 60 * 60 * 1000));
});

test("gateway token is session-bound and expires after fifteen minutes", async () => {
  const now = Date.UTC(2026, 6, 19);
  const signed = await createGatewayToken("session-2", "host-1", now);
  const claims = await verifyGatewayToken(signed.token, now + 14 * 60 * 1000);
  assert.equal(claims.sessionId, "session-2");
  await assert.rejects(() => verifyGatewayToken(signed.token, now + 15 * 60 * 1000));
});

test("gateway token issuance consumes one opaque host-session bucket", async () => {
  const calls: Array<{ scope: string; keyHash: string; limit: number; windowSeconds: number }> = [];
  const store: RateLimitStore = {
    async consumeRateLimit(input) {
      calls.push(input);
      return calls.length === 1;
    },
  };
  await enforceGatewayTokenRateLimit("host-1", "session-1", store);
  assert.equal(calls[0].scope, "gateway-token-host-session");
  assert.match(calls[0].keyHash, /^[0-9a-f]{64}$/u);
  assert.equal(calls[0].keyHash.includes("host-1"), false);
  assert.deepEqual({ limit: calls[0].limit, windowSeconds: calls[0].windowSeconds }, { limit: 30, windowSeconds: 900 });
  await assert.rejects(
    () => enforceGatewayTokenRateLimit("host-1", "session-1", store),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "GATEWAY_TOKEN_RATE_LIMITED",
  );
  const routeSource = readFileSync(new URL("../../app/api/live-sessions/[id]/gateway-token/route.ts", import.meta.url), "utf8");
  assert.ok(routeSource.indexOf("assertHostSession(sessionId, hostId)") < routeSource.indexOf("enforceGatewayTokenRateLimit(hostId, sessionId, store)"));
  assert.ok(routeSource.indexOf("enforceGatewayTokenRateLimit(hostId, sessionId, store)") < routeSource.indexOf("createGatewayToken(sessionId, hostId)"));
});

test("summary generation is rate limited by opaque host and session identity", async () => {
  const calls: Array<{ scope: string; keyHash: string; limit: number; windowSeconds: number }> = [];
  const store: RateLimitStore = {
    async consumeRateLimit(input) {
      calls.push(input);
      return true;
    },
  };
  await enforceSummaryGenerationRateLimit("host-1", "session-1", store);
  assert.deepEqual(calls.map(({ scope, limit, windowSeconds }) => ({ scope, limit, windowSeconds })), [{
    scope: "summary-host-session",
    limit: 10,
    windowSeconds: 3600,
  }]);
  assert.match(calls[0].keyHash, /^[0-9a-f]{64}$/u);
  assert.equal(calls[0].keyHash.includes("host-1"), false);
  assert.equal(calls[0].keyHash.includes("session-1"), false);
});

test("admission HMAC is deterministic and never stores the six digit code", async () => {
  const digest = await hmacHex("a-secure-test-pepper", "admission\u0000123456");
  assert.equal(digest.length, 64);
  assert.equal(digest.includes("123456"), false);
  assert.equal(digest, await hmacHex("a-secure-test-pepper", "admission\u0000123456"));
});

test("opaque invite tokens contain 32 random bytes and only their scoped HMAC reaches storage", async () => {
  const inviteToken = createLiveInviteToken();
  assert.match(inviteToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(Buffer.from(inviteToken, "base64url").byteLength, 32);
  const tokenHmac = await hmacHex("a-secure-test-pepper", `invite\u0000${inviteToken}`);
  assert.equal(tokenHmac.length, 64);
  assert.equal(tokenHmac.includes(inviteToken), false);

  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ path, body });
      if (path.endsWith("resolve_live_invite_rate_key")) return Response.json("b".repeat(64));
      if (path.endsWith("redeem_live_invite_v3")) {
        return Response.json({
          grant_id: "grant-1", session_id: "session-1", user_id: "user-1",
          grant_expires_at: "2026-07-20T06:00:00.000Z", session_expires_at: "2026-07-20T06:00:00.000Z",
          session_type: "meeting", output_mode: "captions", glossary_pack: "general_cre",
          voice_provider: "gemini",
          languages: ["ko"], viewer_count: 1, max_viewers: 50, display_name: "Viewer 1",
          department: "Strategy", job_title: "Director", participant_id: "participant-1",
        });
      }
      return Response.json(true);
    },
  });
  await store.createInvite({
    sessionId: "session-1", hostId: "host-1", tokenHmac,
    expiresAt: "2026-07-20T00:05:00.000Z",
  });
  assert.equal(await store.resolveInviteRateKey(tokenHmac), "b".repeat(64));
  const redemption = await store.redeemInvite({
    tokenHmac,
    userId: "user-1",
    deviceHash: "c".repeat(64),
    displayName: "Viewer 1",
    department: "Strategy",
    jobTitle: "Director",
    expiresAt: "2026-07-20T06:00:00.000Z",
  });
  assert.equal(redemption.grant.id, "grant-1");
  assert.equal(redemption.grant.displayName, "Viewer 1");
  assert.deepEqual(calls.map((call) => call.path), [
    "/rest/v1/rpc/create_live_invite",
    "/rest/v1/rpc/resolve_live_invite_rate_key",
    "/rest/v1/rpc/redeem_live_invite_v3",
  ]);
  assert.equal(calls.some((call) => JSON.stringify(call.body).includes(inviteToken)), false);
  assert.equal(calls.every((call) => JSON.stringify(call.body).includes(tokenHmac)), true);
  assert.equal(calls.at(-1)?.body.p_display_name, "Viewer 1");
});

test("join preflight consumes IP and device buckets without a guessed-code session bucket", async () => {
  const calls: Array<{ scope: string; keyHash: string }> = [];
  const store: RateLimitStore = {
    async consumeRateLimit(input) {
      calls.push({ scope: input.scope, keyHash: input.keyHash });
      return input.scope !== "join-device";
    },
  };
  await assert.rejects(
    () => enforceJoinPreflightRateLimits(
      requestHeaders({ "x-forwarded-for": "203.0.113.10, 10.0.0.2" }),
      "device-identifier-12345",
      store,
    ),
    (error: unknown) => error instanceof Error && error.message.includes("요청이 너무 많습니다"),
  );
  assert.deepEqual(calls.map((call) => call.scope).sort(), ["join-device", "join-ip"]);
  assert.equal(calls.some((call) => call.keyHash.includes("203.0.113.10") || call.keyHash.includes("device-identifier")), false);
});

test("a resolved session uses one fixed 64-hex session bucket", async () => {
  const calls: Array<{ scope: string; keyHash: string; limit: number; windowSeconds: number }> = [];
  const store: RateLimitStore = {
    async consumeRateLimit(input) {
      calls.push(input);
      return true;
    },
  };
  const sessionRateKey = "a".repeat(64);
  await enforceSessionJoinRateLimit(sessionRateKey, store);
  assert.deepEqual(calls, [{ scope: "join-session", keyHash: sessionRateKey, limit: 60, windowSeconds: 300 }]);
  await assert.rejects(() => enforceSessionJoinRateLimit("guessed-code-hmac", store), /요청 제한 키/);
});

test("six-digit attempts share a persistent global brute-force bucket", async () => {
  const calls: Array<{ scope: string; keyHash: string; limit: number; windowSeconds: number }> = [];
  const store: RateLimitStore = {
    async consumeRateLimit(input) {
      calls.push(input);
      return true;
    },
  };
  await enforceAdmissionCodeAttemptRateLimit(store);
  assert.deepEqual(
    { scope: calls[0].scope, limit: calls[0].limit, windowSeconds: calls[0].windowSeconds },
    { scope: "join-admission-global", limit: 300, windowSeconds: 300 },
  );
  assert.match(calls[0].keyHash, /^[0-9a-f]{64}$/u);
});

test("production host login consumes a persistent hashed IP bucket", async () => {
  const calls: Array<{ scope: string; keyHash: string; limit: number; windowSeconds: number }> = [];
  const store: RateLimitStore = {
    async consumeRateLimit(input) {
      calls.push(input);
      return true;
    },
  };
  await enforceHostLoginRateLimit(requestHeaders({ "x-vercel-forwarded-for": "203.0.113.19" }), store);
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0], keyHash: "<hashed>" }, {
    scope: "host-login-ip",
    keyHash: "<hashed>",
    limit: 5,
    windowSeconds: 900,
  });
  assert.match(calls[0].keyHash, /^[0-9a-f]{64}$/u);
  assert.equal(calls[0].keyHash.includes("203.0.113.19"), false);
});

test("live API schemas accept only the canonical contract and viewer bound", () => {
  for (const sessionType of ["presentation", "meeting"] as const) {
    assert.equal(sessionTypeInputSchema.safeParse(sessionType).success, true);
  }
  for (const outputMode of ["captions", "captions_audio", "audio"] as const) {
    assert.equal(outputModeInputSchema.safeParse(outputMode).success, true);
  }
  for (const voiceProvider of ["gemini", "openai"] as const) {
    assert.equal(voiceProviderInputSchema.safeParse(voiceProvider).success, true);
  }
  assert.equal(voiceProviderInputSchema.safeParse("google").success, false);
  for (const glossaryPack of ["general_cre", "hotel", "fnb"] as const) {
    assert.equal(glossaryPackInputSchema.safeParse(glossaryPack).success, true);
  }
  const canonical = createLiveSessionInputSchema.parse({
    sessionType: "meeting",
    outputMode: "captions_audio",
    glossaryPack: "hotel",
    voiceProvider: "gemini",
    languages: ["ko-KR"],
  });
  assert.equal(canonical.maxViewers, 50);
  assert.equal(createLiveSessionInputSchema.safeParse({ ...canonical, maxViewers: 1 }).success, true);
  assert.equal(createLiveSessionInputSchema.safeParse({ ...canonical, maxViewers: 51 }).success, false);
  assert.equal(updateLiveSessionInputSchema.safeParse({ version: 1 }).success, false);
  assert.equal(updateLiveSessionInputSchema.safeParse({ version: 1, maxViewers: 50 }).success, true);
  assert.equal(createLiveSessionInputSchema.safeParse({
    mode: "townhall",
    voiceOutputMode: "auto_voice",
    languages: ["ko-KR"],
  }).success, false);
  assert.equal(createLiveSessionInputSchema.safeParse({
    ...canonical,
    sessionType: "meeting",
    voiceProvider: "openai",
  }).success, false);
  assert.equal(createLiveSessionInputSchema.safeParse({
    ...canonical,
    outputMode: "captions",
    voiceProvider: "openai",
  }).success, false);
  assert.equal(updateLiveSessionInputSchema.safeParse({
    version: 1,
    sessionType: "meeting",
    voiceProvider: "openai",
  }).success, false);
  assert.equal(updateLiveSessionInputSchema.safeParse({
    version: 1,
    outputMode: "captions",
    voiceProvider: "openai",
  }).success, false);
});

test("live session language input normalizes aliases once and stores only distinct canonical codes", () => {
  const parsed = createLiveSessionInputSchema.parse({
    sessionType: "presentation",
    outputMode: "captions",
    voiceProvider: "gemini",
    glossaryPack: "general_cre",
    languages: ["en-US", "ko-KR", "zh-TW"],
  });
  assert.deepEqual(parsed.languages, ["en", "ko", "zh-Hant"]);
  for (const language of LANGUAGE_CODES) {
    assert.deepEqual(createLiveSessionInputSchema.parse({
      sessionType: "presentation",
      outputMode: "captions",
      voiceProvider: "gemini",
      glossaryPack: "general_cre",
      languages: [language],
    }).languages, [language]);
  }
  for (const languages of [
    ["en-US", "en"],
    ["th"],
    ["en", "ko", "ja", "fr"],
  ]) {
    assert.equal(createLiveSessionInputSchema.safeParse({
      sessionType: "presentation",
      outputMode: "captions",
      voiceProvider: "gemini",
      glossaryPack: "general_cre",
      languages,
    }).success, false);
  }
});

test("web ingress normalization matches every alias accepted by the database migration", () => {
  const aliases = [
    ["en-US", "en"], ["en-GB", "en"], ["en-AU", "en"], ["en-CA", "en"],
    ["ko-KR", "ko"], ["ja-JP", "ja"], ["zh", "zh-Hans"], ["zh-CN", "zh-Hans"],
    ["zh-SG", "zh-Hans"], ["cmn-Hans-CN", "zh-Hans"], ["zh-TW", "zh-Hant"],
    ["zh-HK", "zh-Hant"], ["zh-MO", "zh-Hant"], ["cmn-Hant-TW", "zh-Hant"],
    ["es-ES", "es"], ["es-MX", "es"], ["pt-BR", "pt"], ["pt-PT", "pt"],
    ["fr-FR", "fr"], ["fr-CA", "fr"], ["de-DE", "de"], ["ru-RU", "ru"],
    ["hi-IN", "hi"], ["id-ID", "id"], ["vi-VN", "vi"], ["it-IT", "it"],
  ] as const;
  for (const [alias, canonical] of aliases) {
    const parsed = createLiveSessionInputSchema.parse({
      sessionType: "presentation",
      outputMode: "captions",
      voiceProvider: "gemini",
      glossaryPack: "general_cre",
      languages: [alias],
    });
    assert.deepEqual(parsed.languages, [canonical], alias);
  }
});

test("viewer display names are NFC normalized and stripped of controls and HTML", () => {
  assert.equal(sanitizeViewerDisplayName("  Ga\u0301<script>alert(1)</script>\nGuest  "), "Gá alert(1) Guest");
  const valid = joinLiveSessionInputSchema.parse({
    inviteToken: "a".repeat(43),
    displayName: "  가 <b>Guest</b>\u0000 ",
    department: "  Stra\u0301tegy ",
    jobTitle: " Director ",
    deviceId: "device-identifier-12345",
    accessToken: "a".repeat(20),
  });
  assert.equal(valid.displayName, "가 Guest");
  assert.equal(valid.department, "Strátegy");
  assert.equal(valid.jobTitle, "Director");
  assert.equal(Array.from(valid.displayName).length <= 40, true);
  for (const displayName of ["<script></script>", "\u0000\u0001", "a".repeat(41)]) {
    assert.equal(joinLiveSessionInputSchema.safeParse({
      inviteToken: "a".repeat(43),
      displayName,
      department: "Strategy",
      jobTitle: "Director",
      deviceId: "device-identifier-12345",
      accessToken: "a".repeat(20),
    }).success, false);
  }
});

test("admission and join schemas fail closed on malformed or surplus external input", () => {
  assert.equal(admissionActionInputSchema.safeParse({ action: "open", version: 1 }).success, true);
  assert.equal(admissionActionInputSchema.safeParse({ action: "open" }).success, false);
  assert.equal(admissionActionInputSchema.safeParse({ action: "open", version: 1, duration: 600 }).success, false);
  assert.equal(createLiveInviteInputSchema.safeParse({ action: "create" }).success, true);
  assert.equal(createLiveInviteInputSchema.safeParse({ action: "open" }).success, false);
  assert.equal(createLiveInviteInputSchema.safeParse({ action: "create", origin: "https://untrusted.example" }).success, false);
  assert.equal(joinLiveSessionInputSchema.safeParse({
    admissionCode: "123456",
    displayName: "Viewer 1",
    department: "Strategy",
    jobTitle: "Director",
    deviceId: "device-identifier-12345",
    accessToken: "a".repeat(20),
  }).success, true);
  assert.equal(joinLiveSessionInputSchema.safeParse({
    admissionCode: "123456 OR 1=1",
    displayName: "Viewer 1",
    department: "Strategy",
    jobTitle: "Director",
    deviceId: "device-identifier-12345",
    accessToken: "a".repeat(20),
  }).success, false);
  assert.equal(joinLiveSessionInputSchema.safeParse({
    inviteToken: "a".repeat(43),
    displayName: "Viewer 1",
    department: "Strategy",
    jobTitle: "Director",
    deviceId: "device-identifier-12345",
    accessToken: "a".repeat(20),
  }).success, true);
  assert.equal(joinLiveSessionInputSchema.safeParse({
    admissionCode: "123456",
    inviteToken: "a".repeat(43),
    displayName: "Viewer 1",
    department: "Strategy",
    jobTitle: "Director",
    deviceId: "device-identifier-12345",
    accessToken: "a".repeat(20),
  }).success, false);
  assert.equal(joinLiveSessionInputSchema.safeParse({
    displayName: "Viewer 1",
    department: "Strategy",
    jobTitle: "Director",
    deviceId: "device-identifier-12345",
    accessToken: "a".repeat(20),
  }).success, false);
  assert.equal(joinLiveSessionInputSchema.safeParse({
    inviteToken: "a".repeat(44),
    displayName: "Viewer 1",
    department: "Strategy",
    jobTitle: "Director",
    deviceId: "device-identifier-12345",
    accessToken: "a".repeat(20),
  }).success, false);
  assert.equal(joinLiveSessionInputSchema.safeParse({
    inviteToken: "a".repeat(43),
    displayName: "Viewer 1",
    department: "Strategy",
    jobTitle: "Director",
    password: "viewer-password-is-not-accepted",
    deviceId: "device-identifier-12345",
    accessToken: "a".repeat(20),
  }).success, false);
  assert.equal(joinLiveSessionInputSchema.safeParse({
    inviteToken: "a".repeat(43),
    displayName: "Viewer 1",
    department: "",
    jobTitle: "Director",
    deviceId: "device-identifier-12345",
    accessToken: "a".repeat(20),
  }).success, false);
});

test("host login is env-only and weak credentials require an explicit non-production gate", () => {
  assert.deepEqual(
    readHostLoginConfig({ NODE_ENV: "development", ADMIN_PASSWORD: "short" }),
    { isEnabled: false, password: "", userIds: new Set<string>() },
  );
  const weak = readHostLoginConfig({
    NODE_ENV: "test",
    LIVE_ALLOW_WEAK_TEST_LOGIN: "true",
    LIVE_TEST_LOGIN_ID: "local-host",
    LIVE_TEST_LOGIN_PASSWORD: "local-password",
  });
  assert.equal(weak.isEnabled, true);
  assert.equal(weak.userIds.has("local-host"), true);
  assert.throws(() => readHostLoginConfig({
    NODE_ENV: "production",
    LIVE_ALLOW_WEAK_TEST_LOGIN: "true",
    LIVE_TEST_LOGIN_ID: "local-host",
    LIVE_TEST_LOGIN_PASSWORD: "local-password",
  }), /development\/test/u);
  assert.throws(() => readHostLoginConfig({
    NODE_ENV: "production",
    ADMIN_USER_IDS: "host",
    ADMIN_PASSWORD: "tiny",
  }), /강한 호스트 로그인/u);
  // Operator-chosen passwords of five or more characters are accepted so the
  // Vercel-configured ADMIN_PASSWORD does not silently 500 the login route.
  assert.equal(readHostLoginConfig({
    NODE_ENV: "production",
    ADMIN_USER_IDS: "host",
    ADMIN_PASSWORD: "n0el!",
  }).isEnabled, true);
  assert.equal(readHostLoginConfig({
    NODE_ENV: "production",
    ADMIN_USER_IDS: "host-a,host-b",
    ADMIN_PASSWORD: "s".repeat(32),
  }).userIds.has("host-b"), true);
  assert.equal(hostLoginInputSchema.safeParse({ id: "host", password: "secret", name: "<b>Noel</b>" }).success, true);
});

test("production rejects known example placeholders regardless of their length", () => {
  const knownPlaceholders = [
    "replace-with-32-or-more-random-characters",
    "local-live-secret-change-before-production",
    "changeme",
    "change-me",
    "placeholder",
    "your-secret-here",
  ];
  for (const password of knownPlaceholders) {
    assert.equal(isKnownInsecureSecret(password), true);
    assert.throws(() => readHostLoginConfig({
      NODE_ENV: "production",
      ADMIN_USER_IDS: "host",
      ADMIN_PASSWORD: password,
    }), /강한 호스트 로그인/u);
  }
  assert.equal(isKnownInsecureSecret("sufficiently-random-production-secret-123456789"), false);

  const example = Object.fromEntries(
    readFileSync(new URL("../../.env.example", import.meta.url), "utf8")
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  for (const name of [
    "ADMIN_PASSWORD",
    "SESSION_SECRET",
    "PAIR_SECRET",
    "LIVE_ADMISSION_PEPPER",
    "LIVE_VIEWER_TOKEN_SECRET",
    "LIVE_GATEWAY_TOKEN_SECRET",
  ]) {
    assert.equal(isKnownInsecureSecret(example[name] ?? ""), true, `${name} must remain an intentionally invalid example`);
  }
});

test("ADMIN_PASSWORD follows the 5+ char operator policy, not the 32-char HMAC secret gate", () => {
  const source = readFileSync(new URL("./config.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /readRequiredProductionSecret\("ADMIN_PASSWORD"\)/u);
  assert.match(source, /adminPassword\.length < 5/u);
  assert.match(source, /isKnownInsecureSecret\(adminPassword\)/u);
  // The HMAC-grade secrets keep the strong 32-char gate.
  assert.match(source, /readRequiredProductionSecret\("SESSION_SECRET"\)/u);
  assert.match(source, /readRequiredProductionSecret\("PAIR_SECRET"\)/u);
});

test("development Supabase connections require an exact allowlisted project ref", () => {
  const environment = {
    NODE_ENV: "development",
    LIVE_EXTERNAL_ENV: "development",
    LIVE_ALLOWED_SUPABASE_REF: "approved-dev-ref",
    NEXT_PUBLIC_SUPABASE_URL: "https://approved-dev-ref.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
  };
  assert.equal(getSupabaseServerConfig(environment).url, "https://approved-dev-ref.supabase.co");
  assert.throws(
    () => getSupabaseServerConfig({ ...environment, NEXT_PUBLIC_SUPABASE_URL: "https://production-ref.supabase.co" }),
    LiveSecurityConfigurationError,
  );
  assert.throws(
    () => getSupabaseServerConfig({ ...environment, NEXT_PUBLIC_SUPABASE_URL: "https://approved-dev-ref.supabase.co.evil.example" }),
    LiveSecurityConfigurationError,
  );
  assert.throws(
    () => getSupabaseServerConfig({ ...environment, LIVE_EXTERNAL_ENV: undefined }),
    LiveSecurityConfigurationError,
  );
});

test("new Supabase secret keys are sent only as apikey", () => {
  const secretKey = `sb_secret_${"a".repeat(24)}`;
  const publishableKey = `sb_publishable_${"b".repeat(24)}`;
  const environment = {
    LIVE_EXTERNAL_ENV: "development",
    LIVE_ALLOWED_SUPABASE_REF: "approved-dev-ref",
    SUPABASE_URL: "https://approved-dev-ref.supabase.co",
    NEXT_PUBLIC_SUPABASE_URL: "https://approved-dev-ref.supabase.co/",
    SUPABASE_SECRET_KEY: secretKey,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
  };
  const serverAccess = getSupabaseServerAccess(environment);
  assert.deepEqual(supabaseAdminHeaders(serverAccess.credential), { apikey: secretKey });
  assert.deepEqual(getSupabasePublicAccess(environment), {
    url: "https://approved-dev-ref.supabase.co",
    publishableKey,
  });
});

test("legacy service_role remains an explicit temporary Bearer fallback", () => {
  const legacyKey = legacySupabaseKey("service_role");
  const access = getSupabaseServerAccess({
    LIVE_EXTERNAL_ENV: "development",
    LIVE_ALLOWED_SUPABASE_REF: "approved-dev-ref",
    SUPABASE_URL: "https://approved-dev-ref.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: legacyKey,
  });
  assert.deepEqual(supabaseAdminHeaders(access.credential), {
    apikey: legacyKey,
    Authorization: `Bearer ${legacyKey}`,
  });
});

test("Supabase server access fails closed on missing secrets and boundary mismatch", () => {
  const baseEnvironment = {
    LIVE_EXTERNAL_ENV: "development",
    LIVE_ALLOWED_SUPABASE_REF: "approved-dev-ref",
    SUPABASE_URL: "https://approved-dev-ref.supabase.co",
  };
  assert.throws(() => getSupabaseServerAccess(baseEnvironment), LiveSecurityConfigurationError);
  assert.throws(() => getSupabaseServerAccess({
    ...baseEnvironment,
    SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"a".repeat(24)}`,
  }), LiveSecurityConfigurationError);
  assert.throws(() => getSupabaseServerAccess({
    ...baseEnvironment,
    NEXT_PUBLIC_SUPABASE_URL: "https://different-ref.supabase.co",
    SUPABASE_SECRET_KEY: `sb_secret_${"a".repeat(24)}`,
  }), LiveSecurityConfigurationError);
  assert.throws(() => getSupabaseServerAccess({
    ...baseEnvironment,
    LIVE_EXTERNAL_ENV: undefined,
    SUPABASE_SECRET_KEY: `sb_secret_${"a".repeat(24)}`,
  }), LiveSecurityConfigurationError);
  assert.throws(() => getSupabaseServerAccess({
    ...baseEnvironment,
    SUPABASE_URL: "https://approved-dev-ref.supabase.co.evil.example",
    SUPABASE_SECRET_KEY: `sb_secret_${"a".repeat(24)}`,
  }), LiveSecurityConfigurationError);
  assert.throws(() => getSupabasePublicAccess({
    ...baseEnvironment,
    SUPABASE_SECRET_KEY: `sb_secret_${"a".repeat(24)}`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: legacySupabaseKey("service_role"),
  }), LiveSecurityConfigurationError);
});

test("login failures are rate limited by trusted client IP in bounded memory", () => {
  const limiter = createLoginRateLimiter({ maxFailures: 3, windowMilliseconds: 60_000, maxBuckets: 2 });
  const first = new Headers({ "x-vercel-forwarded-for": "203.0.113.10" });
  assert.equal(limiter.check(first, 1_000).isAllowed, true);
  assert.equal(limiter.recordFailure(first, 1_000).isAllowed, true);
  assert.equal(limiter.recordFailure(first, 1_001).isAllowed, true);
  const blocked = limiter.recordFailure(first, 1_002);
  assert.equal(blocked.isAllowed, false);
  assert.equal(blocked.retryAfterSeconds, 60);
  assert.equal(limiter.check(first, 1_003).isAllowed, false);
  limiter.clear(first);
  assert.equal(limiter.check(first, 1_004).isAllowed, true);

  limiter.recordFailure(first, 2_000);
  limiter.recordFailure(new Headers({ "x-vercel-forwarded-for": "203.0.113.11" }), 2_000);
  limiter.recordFailure(new Headers({ "x-vercel-forwarded-for": "203.0.113.12" }), 2_000);
  assert.equal(limiter.check(first, 2_001).isAllowed, true);
});

test("login route applies the limiter without logging credentials", () => {
  const source = readFileSync(new URL("../../app/api/login/route.ts", import.meta.url), "utf8");
  assert.match(source, /loginRateLimiter\.check\(request\.headers\)/u);
  assert.match(source, /loginRateLimiter\.recordFailure\(request\.headers\)/u);
  assert.match(source, /enforceHostLoginRateLimit\(request/u);
  assert.match(source, /readHostLoginConfig\(\)/u);
  assert.match(source, /timingSafeEqual/u);
  assert.match(source, /"LOGIN_RATE_LIMITED"[\s\S]*?429/u);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)/u);
  assert.doesNotMatch(source, /createHash|rnw_link|linkHash/u);
  assert.doesNotMatch(source, /cw1234|\^admin/u);
  assert.doesNotMatch(source, /password === HOST_LOGIN_CONFIG\.password/u);
  // The env-backed config is read per request: a module-scope constant would
  // freeze a stale (or throwing) value for the lambda's lifetime, so a fixed
  // Vercel env var could never take effect without an opaque 500.
  assert.doesNotMatch(source, /^const HOST_LOGIN_CONFIG = readHostLoginConfig\(\)/mu);
  assert.match(source, /HOST_LOGIN_CONFIG_INVALID/u);
});

test("viewer admission routes never log names, codes, tokens, or captions", () => {
  const sources = [
    "../../app/api/live-sessions/join/route.ts",
    "../../app/api/live-sessions/[id]/admission/route.ts",
    "../../app/api/live-sessions/[id]/invites/route.ts",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
  for (const source of sources) {
    assert.doesNotMatch(source, /console\.(?:log|info|warn|error)/u);
  }
});

test("meeting record routes bind host ownership and participant recap access before service-role reads", () => {
  const summary = readFileSync(new URL("../../app/api/live-sessions/[id]/summary/route.ts", import.meta.url), "utf8");
  const transcript = readFileSync(new URL("../../app/api/live-sessions/[id]/transcript/route.ts", import.meta.url), "utf8");
  const status = readFileSync(new URL("../../app/api/live-sessions/[id]/status/route.ts", import.meta.url), "utf8");
  assert.ok(summary.indexOf("assertHostSessionOwnership") < summary.indexOf("fetchUtterances(sessionId"));
  assert.ok(summary.indexOf("enforceSummaryGenerationRateLimit(hostId") < summary.indexOf("generateMeetingSummary(attributedUtterances"));
  assert.ok(transcript.indexOf("assertHostSessionOwnership") < transcript.indexOf("fetchUtterances(sessionId"));
  assert.match(summary, /authorizeParticipantRecordRequest\(request, sessionId, store\)/u);
  assert.match(transcript, /authorizeParticipantRecordRequest\(request, sessionId, store\)/u);
  assert.match(status, /assertHostSessionOwnership\(sessionId, hostId\)/u);
  assert.match(status, /authorizeParticipantRecordRequest\(request, sessionId, store\)/u);
  assert.match(status, /httpOnly: true[\s\S]*secure: isProductionRuntime\(\)[\s\S]*sameSite: "lax"/u);
  assert.match(status, /path: `\/api\/live-sessions\/\$\{sessionId\}`/u);
  // All three must fall through to participant access when a valid host cookie
  // simply is not THIS session's owner. Catching only AuthenticationError meant
  // assertHostSessionOwnership's LiveAdmissionError(404) propagated, so a
  // participant browsing with a host cookie in the same browser got 404s on
  // status polling, minutes, and transcript recovery despite a valid grant.
  for (const source of [summary, transcript, status]) {
    assert.match(source, /if \(!isHostOwnershipMiss\(error\)\) throw error;/u);
    assert.doesNotMatch(source, /if \(!\(error instanceof AuthenticationError\)\) throw error;/u);
  }
  // The predicate must not grant access by itself — the participant check still runs.
  const authorization = readFileSync(new URL("./live-viewer-authorization.ts", import.meta.url), "utf8");
  assert.match(authorization, /export function isHostOwnershipMiss/u);
  assert.match(authorization, /=== "LIVE_SESSION_NOT_FOUND"/u);
});

test("host create, start, update, and end routes require a signed host session and owned store mutations", () => {
  const createRoute = readFileSync(new URL("../../app/api/live-sessions/route.ts", import.meta.url), "utf8");
  const sessionRoute = readFileSync(new URL("../../app/api/live-sessions/[id]/route.ts", import.meta.url), "utf8");
  const startRoute = readFileSync(new URL("../../app/api/live-sessions/[id]/start/route.ts", import.meta.url), "utf8");
  assert.ok(createRoute.indexOf("requireHost(request)") < createRoute.indexOf(".create(hostId"));
  assert.ok(startRoute.indexOf("requireHost(request)") < startRoute.indexOf(".start("));
  assert.ok(sessionRoute.indexOf("requireHost(request)") < sessionRoute.indexOf(".update(hostId"));
  assert.ok(sessionRoute.indexOf("requireHost(request)") < sessionRoute.indexOf(".end(hostId"));
});

test("snapshot reconnect validates canonical language before one atomic viewer topic authorization", () => {
  const source = readFileSync(new URL("../../app/api/live-sessions/[id]/snapshot/route.ts", import.meta.url), "utf8");
  const parseIndex = source.indexOf("liveLanguageInputSchema.safeParse");
  const authorizeIndex = source.indexOf("authorizeViewerRequest(request, id, language)");
  const snapshotIndex = source.indexOf(".snapshot(id, language)");
  assert.ok(parseIndex >= 0 && authorizeIndex > parseIndex && snapshotIndex > authorizeIndex);
  assert.match(source, /error instanceof LiveAdmissionError[\s\S]*?error\.code[\s\S]*?error\.status/u);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)/u);
});

test("persisted caption snapshots reject oversized, forged, and stale sequence events", () => {
  const source = readFileSync(
    new URL("../../../supabase/migrations/202607190002_live_voice_output.sql", import.meta.url),
    "utf8",
  );
  assert.match(source, /octet_length\(p_event::text\) > 32768/u);
  assert.match(source, /length\(btrim\(p_event ->> 'text'\)\) not between 1 and 8000/u);
  assert.match(source, /octet_length\(p_event ->> 'text'\) > 24000/u);
  assert.match(source, /\(p_event ->> 'seq'\) !~ '\^\[0-9\]\{1,19\}\$'/u);
  assert.match(source, /\(p_event ->> 'seq'\)::numeric > 9223372036854775807/u);
  assert.match(source, /p_event ->> 'sessionId' <> p_session_id::text/u);
  assert.match(source, /p_event ->> 'language' <> p_language/u);
  assert.match(source, /public\.live_snapshots\.last_seq < excluded\.last_seq/u);
});

test("live security and gateway metrics sources do not log private media or use content-derived metric names", () => {
  const apiSources = [
    "../../app/api/live-sessions/join/route.ts",
    "../../app/api/live-sessions/[id]/snapshot/route.ts",
    "../../middleware.ts",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
  const gatewaySource = readFileSync(new URL("../../../media-gateway/src/gateway-server.js", import.meta.url), "utf8");
  assert.doesNotMatch(apiSources, /console\.(?:log|info|warn|error)/u);
  assert.doesNotMatch(gatewaySource, /console\.(?:log|info|warn|error)/u);
  for (const call of gatewaySource.matchAll(/metrics\.(?:increment|set)\(([^,)]+)/gu)) {
    assert.match(call[1], /^"[a-z][a-z0-9_]*"$/u);
  }
  assert.equal([...gatewaySource.matchAll(/metrics\.(?:increment|set)\(/gu)].length > 0, true);
});

test("viewer sockets cannot inject caption or audio payloads and cap JSON message size", () => {
  const source = readFileSync(new URL("../../../media-gateway/src/gateway-server.js", import.meta.url), "utf8");
  assert.match(source, /new WebSocketServer\(\{ noServer: true, maxPayload: 64 \* 1_024 \}\)/u);
  // 발언권(floor) 보유자만 오디오 프레임을 올릴 수 있고, 비보유자 프레임은
  // 파이프라인에 닿기 전에 폐기됩니다. 보유자 프레임도 호스트와 같은
  // 크기 검증과 세션 오디오 예산을 통과해야 합니다.
  const viewerBinaryBranch = source.match(
    /const holder = floorHolders\.get\(claims\.sessionId\);[\s\S]*?metrics\.increment\("floor_audio_frames_total"\);/u,
  );
  assert.ok(viewerBinaryBranch, "viewer binary handling must be floor-gated");
  assert.match(viewerBinaryBranch[0], /if \(!holder \|\| holder\.webSocket !== webSocket\)/u);
  assert.match(viewerBinaryBranch[0], /data\.byteLength !== INPUT_FRAME_BYTES/u);
  assert.match(viewerBinaryBranch[0], /consumeAudioBudget\(claims\.sessionId, data\.byteLength\)/u);
  assert.match(source, /if \(message\.type !== "subscribe"[\s\S]*?throw new Error\("INVALID_SUBSCRIPTION"\)/u);
  assert.match(source, /message\.sessionId !== claims\.sessionId/u);
  // 구독 언어는 형태 정규식이 아니라 레지스트리로 검증합니다. 정규식은
  // 호스트 UI가 제공하는 zh-Hans/zh-Hant를 거부하거나, 반대로 ko-KR 같은
  // 지역 코드를 통과시켜 파이프라인이 발행하지 않는 토픽을 열어 버립니다.
  assert.match(source, /const language = normalizeLiveLanguage\(message\.language\)/u);
  assert.match(source, /\|\| !language\b/u);
  // 토픽·인가·리플레이는 모두 정규화된 값을 쓰며, 원본 클라이언트 문자열이
  // 토픽 키에 그대로 들어가지 않아야 합니다.
  assert.match(source, /topic = `\$\{message\.sessionId\}:\$\{language\}`/u);
  assert.match(source, /runViewerAuthorization\(message\.sessionId, language\)/u);
  assert.doesNotMatch(source, /:\$\{message\.language\}`/u);
});

test("invite links are consumed from a scrubbed URL fragment before join", () => {
  const source = readFileSync(new URL("../../components/live/LiveViewer.tsx", import.meta.url), "utf8");
  const fragmentRead = source.indexOf("window.location.hash");
  const fragmentScrub = source.indexOf("history.replaceState");
  const joinRequest = source.indexOf('fetch("/api/live-sessions/join"');
  assert.ok(fragmentRead >= 0 && fragmentScrub > fragmentRead && joinRequest > fragmentScrub);
  assert.doesNotMatch(source, /searchParams\.get\("invite"\)/u);
});

test("legacy pairing login is permanently disabled", () => {
  const source = readFileSync(new URL("../../app/api/pair-login/route.ts", import.meta.url), "utf8");
  assert.match(source, /PAIRING_DISABLED/u);
  assert.match(source, /410/u);
  assert.doesNotMatch(source, /verifyPairSig|createSessionToken|SESSION_COOKIE/u);
});

test("legacy pairing query parameters are discarded without an authentication request", () => {
  const source = readFileSync(new URL("../../app/(login)/login/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\("\/api\/pair-login"/u);
  for (const parameter of ["pair", "sig", "exp"]) {
    assert.match(source, new RegExp(`searchParams\\.delete\\("${parameter}"\\)`, "u"));
  }
  assert.match(source, /window\.history\.replaceState/u);
});
