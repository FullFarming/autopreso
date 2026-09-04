import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { LiveSecurityConfigurationError } from "../security/config";
import { LiveSessionService } from "./service";
import { getLiveStoreConfig } from "./config";
import { toLiveFailure } from "./errors";
import { MemoryLiveSessionStore, SupabaseLiveSessionStore } from "./store";
import { createLiveTopicState, mergeLiveTopicSnapshot, projectTopicMemberships } from "./topic-state";
import { parseLanguages, parseLiveGlossaryPinInput, parseLiveGlossaryPinsInput, parseScheduledAt, parseSessionId, parseTitle } from "./validation";
import { coverImagePath } from "./cover-image";
import { enforceCoverUploadRateLimit, type RateLimitStore } from "../security/live-rate-limit";
import { createCoverSignedDownloadUrl, createCoverSignedUploadUrl } from "./cover-storage";
import {
  createGlossaryPresetInputSchema,
  deleteGlossaryPresetBodySchema,
  glossaryPresetIdSchema,
  updateGlossaryPresetBodySchema,
} from "../glossary-presets/schema";
import { GlossaryPresetService } from "../glossary-presets/service";
import { GlossaryPresetError, toGlossaryPresetFailure } from "../glossary-presets/errors";
import {
  SupabaseGlossaryPresetStore,
  type GlossaryPresetStore,
} from "../glossary-presets/store";
import type { CreateGlossaryPresetInput } from "../glossary-presets/schema";
import type { GlossaryPreset } from "../glossary-presets/types";
import { fingerprintGlossaryDocumentV1 } from "../../../packages/caption-core/index.js";
import { DEFAULT_ENGINE_SELECTION } from "../../../packages/caption-core/caption-engine-catalog.js";
import { readStoredEngineDefaults } from "../console/engine-defaults";
import { readLiveModelPreferences } from "./model-preferences";

// Spec §9: the console's global engine is the ONLY Live Call engine. The detailed
// authority matrix (admin vs host, legacy input, history) lives in model-preferences.test.ts.
test("create stores the console engine defaults as `modelPreferences.engine` for hosts, whatever the client sent", async () => {
  const store = new MemoryLiveSessionStore();
  const service = new LiveSessionService(store);
  const engineDefaults = readStoredEngineDefaults({ stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" }, translation: { provider: "gemini", model: "gemini-3.7-flash" }, summary: { provider: "gemini", model: "gemini-3.7-flash" } });
  const seeded = await service.create("host-1", { sessionType: "meeting", languages: ["ko"] }, { engineDefaults });
  assert.deepEqual(seeded.modelPreferences, { engine: engineDefaults, engineHistory: [] });
  const explicit = await service.create("host-1", { sessionType: "meeting", languages: ["ko"], modelPreferences: { engine: DEFAULT_ENGINE_SELECTION } }, { engineDefaults });
  assert.deepEqual(explicit.modelPreferences, { engine: engineDefaults, engineHistory: [] }, "a host's own engine is replaced by the global default (server authority, not an error)");
  const soniox = readStoredEngineDefaults({ stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" }, translation: { provider: "soniox", model: "stt-rt-v5" }, summary: { provider: "gemini", model: "gemini-3.7-flash" } });
  const fromSoniox = await service.create("host-1", { sessionType: "meeting", languages: ["ko"] }, { engineDefaults: soniox });
  assert.deepEqual(fromSoniox.modelPreferences, { engine: soniox, engineHistory: [] }, "a Soniox global engine travels as-is; the gateway builds the provider from it");
  const unseeded = await service.create("host-1", { sessionType: "meeting", languages: ["ko"] });
  assert.deepEqual(unseeded.modelPreferences, readLiveModelPreferences(undefined), "no options keeps the catalog default");
});

test("participant speaking is disabled by default and only the owning host can enable it", async () => {
  const now = Date.UTC(2026, 7, 22, 0, 0, 0);
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const created = await service.create("host-1", {
    sessionType: "meeting",
    languages: ["ko"],
  });
  assert.equal(created.participantSpeakingEnabled, false);

  const enabled = await service.update("host-1", created.id, {
    version: created.version,
    participantSpeakingEnabled: true,
  });
  assert.equal(enabled.participantSpeakingEnabled, true);
  await assert.rejects(
    service.update("other-host", created.id, {
      version: enabled.version,
      participantSpeakingEnabled: false,
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_FOUND",
  );
  await assert.rejects(
    service.update("host-1", created.id, {
      version: enabled.version,
      participantSpeakingEnabled: "true",
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_PARTICIPANT_SPEAKING_SETTING",
  );

  await assert.rejects(
    service.create("host-1", {
      sessionType: "presentation",
      languages: ["ko"],
      participantSpeakingEnabled: true,
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_PARTICIPANT_SPEAKING_SETTING",
  );
  await assert.rejects(
    service.update("host-1", created.id, {
      version: enabled.version,
      sessionType: "presentation",
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_PARTICIPANT_SPEAKING_SETTING",
  );
});

test("cover storage consumes the documented signed-upload response shape and returns the exact project origin", async () => {
  const environmentKeys = [
    "LIVE_EXTERNAL_ENV",
    "LIVE_ALLOWED_SUPABASE_REF",
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ] as const;
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.LIVE_EXTERNAL_ENV = "development";
  process.env.LIVE_ALLOWED_SUPABASE_REF = "approved-dev-ref";
  process.env.SUPABASE_URL = "https://approved-dev-ref.supabase.co";
  process.env.SUPABASE_SECRET_KEY = `sb_secret_${"a".repeat(24)}`;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const objectPath = `${crypto.randomUUID()}/pending/${"a".repeat(32)}.jpg`;
  try {
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), `https://approved-dev-ref.supabase.co/storage/v1/object/upload/sign/live-covers/${objectPath}`);
      assert.equal(init?.method, "POST");
      assert.equal(init?.body, "{}");
      return Response.json({
        url: `/object/upload/sign/live-covers/${objectPath}?token=signed-token`,
      });
    }) as typeof fetch;
    assert.deepEqual(await createCoverSignedUploadUrl(objectPath, fetchFn), {
      uploadUrl: `https://approved-dev-ref.supabase.co/storage/v1/object/upload/sign/live-covers/${objectPath}?token=signed-token`,
      storageOrigin: "https://approved-dev-ref.supabase.co",
    });
  } finally {
    for (const key of environmentKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("private cover download expands the documented relative signedURL without proxying bytes", async () => {
  const environmentKeys = [
    "LIVE_EXTERNAL_ENV",
    "LIVE_ALLOWED_SUPABASE_REF",
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ] as const;
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.LIVE_EXTERNAL_ENV = "development";
  process.env.LIVE_ALLOWED_SUPABASE_REF = "approved-dev-ref";
  process.env.SUPABASE_URL = "https://approved-dev-ref.supabase.co";
  process.env.SUPABASE_SECRET_KEY = `sb_secret_${"a".repeat(24)}`;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const objectPath = `${crypto.randomUUID()}/cover-${"a".repeat(32)}`;
  try {
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), `https://approved-dev-ref.supabase.co/storage/v1/object/sign/live-covers/${objectPath}`);
      assert.equal(init?.body, JSON.stringify({ expiresIn: 300 }));
      return Response.json({
        signedURL: `/object/sign/live-covers/${objectPath}?token=download-token`,
      });
    }) as typeof fetch;
    assert.equal(
      await createCoverSignedDownloadUrl(objectPath, 300, fetchFn),
      `https://approved-dev-ref.supabase.co/storage/v1/object/sign/live-covers/${objectPath}?token=download-token`,
    );
  } finally {
    for (const key of environmentKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("cover prepare limiter uses one opaque host-session bucket and returns 429", async () => {
  const calls: Array<{ scope: string; keyHash: string; limit: number; windowSeconds: number }> = [];
  const store: RateLimitStore = {
    async consumeRateLimit(input) {
      calls.push(input);
      return calls.length === 1;
    },
  };
  await enforceCoverUploadRateLimit("host-1", "session-1", store);
  assert.deepEqual({ ...calls[0], keyHash: "<hashed>" }, {
    scope: "cover-upload-host-session",
    keyHash: "<hashed>",
    limit: 12,
    windowSeconds: 3600,
  });
  assert.match(calls[0].keyHash, /^[0-9a-f]{64}$/u);
  assert.equal(calls[0].keyHash.includes("host-1"), false);
  assert.equal(calls[0].keyHash.includes("session-1"), false);
  await assert.rejects(
    enforceCoverUploadRateLimit("host-1", "session-1", store),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "COVER_UPLOAD_RATE_LIMITED"
      && "status" in error
      && error.status === 429,
  );
});

test("cover compare-and-set permits one concurrent replacement and rejects failed sessions", async () => {
  const now = Date.UTC(2026, 6, 27);
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const session = await service.create("host-1", { sessionType: "meeting", languages: ["ko", "en"] });
  const firstPath = coverImagePath(session.id, "a".repeat(32));
  assert.equal(await store.setCoverImageOwned(session.id, "host-1", firstPath, null), true);

  const contenders = [
    coverImagePath(session.id, "b".repeat(32)),
    coverImagePath(session.id, "c".repeat(32)),
  ];
  const results = await Promise.all(contenders.map((path) => (
    store.setCoverImageOwned(session.id, "host-1", path, firstPath)
  )));
  assert.deepEqual(results.sort(), [false, true]);
  await assert.rejects(
    service.setCoverImage("host-1", session.id, coverImagePath(session.id, "e".repeat(32)), firstPath),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "COVER_FINALIZE_CONFLICT",
  );

  const failedId = crypto.randomUUID();
  await store.create({ ...session, id: failedId, status: "failed", hasCoverImage: false, coverImageVersion: null });
  assert.equal(await store.setCoverImageOwned(failedId, "host-1", coverImagePath(failedId, "d".repeat(32)), null), false);
  await assert.rejects(
    service.setCoverImage("host-1", failedId, coverImagePath(failedId, "e".repeat(32)), null),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_ENDED",
  );
  await assert.rejects(
    service.setCoverImage("host-1", crypto.randomUUID(), coverImagePath(failedId, "f".repeat(32)), null),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_FOUND",
  );
});

test("Supabase cover compare-and-set filters active status and the exact previous path", async () => {
  const requestUrls: string[] = [];
  const store = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    async (input) => {
      requestUrls.push(String(input));
      return Response.json([]);
    },
  );
  const sessionId = crypto.randomUUID();
  const oldPath = coverImagePath(sessionId, "a".repeat(32));
  await store.setCoverImageOwned(sessionId, "host-1", coverImagePath(sessionId, "b".repeat(32)), null);
  await store.setCoverImageOwned(sessionId, "host-1", coverImagePath(sessionId, "c".repeat(32)), oldPath);
  const first = new URL(requestUrls[0]);
  const second = new URL(requestUrls[1]);
  assert.equal(first.searchParams.get("status"), "in.(preparing,live,paused)");
  assert.equal(first.searchParams.get("cover_image_path"), "is.null");
  assert.equal(second.searchParams.get("cover_image_path"), `eq.${oldPath}`);
});

test("session ids reject malformed external path input", () => {
  assert.equal(parseSessionId("0192d0f4-9f72-7a36-91f5-6a76ef736f41"), "0192d0f4-9f72-7a36-91f5-6a76ef736f41");
  assert.throws(() => parseSessionId("not-a-uuid"), /올바르지/);
});

test("service language parsing canonicalizes ingress aliases and rejects canonical duplicates", () => {
  assert.deepEqual(parseLanguages(["en-US", "ko-KR", "zh-CN"]), ["en", "ko", "zh-Hans"]);
  assert.throws(() => parseLanguages(["en-US", "en"]), /올바르지/u);
  assert.throws(() => parseLanguages(["th"]), /올바르지/u);
  assert.throws(() => parseLanguages(["en", "ko", "ja", "fr"]), /1개 이상 3개 이하/u);
});

test("session metadata normalizes safe titles and ISO schedules", () => {
  assert.equal(parseTitle("  Global   Earnings Call  "), "Global Earnings Call");
  assert.equal(parseTitle("회의"), "회의");
  assert.throws(() => parseTitle("<script>"), /120자/u);
  assert.equal(parseScheduledAt("2026-07-24T09:00:00+09:00"), "2026-07-24T00:00:00.000Z");
  assert.throws(() => parseScheduledAt("2026-07-24 09:00"), /올바르지/u);
});

test("session create validates one to three languages and expires after six hours", async () => {
  const now = Date.UTC(2026, 6, 19);
  const service = new LiveSessionService(new MemoryLiveSessionStore(() => now), () => now);
  const session = await service.create("host-1", { sessionType: "presentation", languages: ["en-US", "ko-KR"] });
  assert.deepEqual(session.languages, ["en", "ko"]);
  assert.equal(session.version, 1);
  assert.equal(session.outputMode, "captions");
  assert.equal(session.voiceProvider, "gemini");
  assert.equal(session.maxViewers, 200);
  assert.equal(session.glossaryPack, "general_cre");
  assert.equal(session.viewerCount, 0);
  assert.equal(session.title, "Live Session");
  assert.equal(session.scheduledAt, null);
  assert.equal(session.expiresAt, new Date(now + 6 * 60 * 60 * 1_000).toISOString());
  await assert.rejects(() => service.create("host-1", { sessionType: "meeting", languages: [] }), /1개 이상/);
});

test("session create and update normalize optional earnings-call metadata and ordered agenda", async () => {
  const now = Date.UTC(2026, 7, 15);
  const service = new LiveSessionService(new MemoryLiveSessionStore(() => now), () => now);
  const created = await service.create("host-1", {
    title: "  Q2   Earnings  ",
    sessionType: "meeting",
    languages: ["ko"],
    companyName: "  Cushman   & Wakefield  ",
    ticker: " cwk ",
    fiscalPeriod: "  Q2   2026 ",
    eventType: "earnings_call",
    agenda: [" Prepared remarks ", "Q&A"],
  });

  assert.equal(created.companyName, "Cushman & Wakefield");
  assert.equal(created.ticker, "CWK");
  assert.equal(created.fiscalPeriod, "Q2 2026");
  assert.equal(created.eventType, "earnings_call");
  assert.deepEqual(created.agenda, [
    { ordinal: 1, label: "Prepared remarks" },
    { ordinal: 2, label: "Q&A" },
  ]);
  assert.equal(created.activeSection, "prepared_remarks");
  assert.equal(created.sectionStartedAt, null);

  const updated = await service.update("host-1", created.id, {
    version: created.version,
    companyName: null,
    ticker: "c-w.k",
    fiscalPeriod: "FY 2026",
    eventType: "other",
    agenda: [],
  });
  assert.equal(updated.companyName, null);
  assert.equal(updated.ticker, "C-W.K");
  assert.equal(updated.fiscalPeriod, "FY 2026");
  assert.equal(updated.eventType, "other");
  assert.deepEqual(updated.agenda, []);
});

test("live glossary pin input is exact and rejects malformed identifiers or versions", () => {
  const presetId = crypto.randomUUID();
  assert.deepEqual(parseLiveGlossaryPinInput({
    expectedVersion: 3,
    presetId,
    documentVersion: 2,
  }), { expectedVersion: 3, presetId, documentVersion: 2 });
  for (const input of [
    null,
    {},
    { expectedVersion: 3, presetId, documentVersion: 2, model: "latest" },
    { expectedVersion: 0, presetId, documentVersion: 2 },
    { expectedVersion: 3, presetId: "not-a-uuid", documentVersion: 2 },
    { expectedVersion: 3, presetId, documentVersion: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(
      () => parseLiveGlossaryPinInput(input),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_GLOSSARY_PIN",
    );
  }
});

test("multi glossary selection normalizes builtin versions and rejects duplicates or unknown catalogs", () => {
  const presetId = crypto.randomUUID();
  assert.deepEqual(parseLiveGlossaryPinsInput({
    expectedVersion: 3,
    glossaries: [
      { sourceKind: "builtin", sourceId: "ai_ax" },
      { sourceKind: "builtin", sourceId: "hospitality" },
      { sourceKind: "host", sourceId: presetId, documentVersion: 4 },
    ],
  }), {
    expectedVersion: 3,
    glossaries: [
      { sourceKind: "builtin", sourceId: "ai_ax", documentVersion: 1 },
      { sourceKind: "builtin", sourceId: "hospitality", documentVersion: 1 },
      { sourceKind: "host", sourceId: presetId, documentVersion: 4 },
    ],
  });
  for (const glossaries of [
    [{ sourceKind: "builtin", sourceId: "general_cre" }],
    [{ sourceKind: "builtin", sourceId: "ai_ax", documentVersion: 1 }],
    [{ sourceKind: "host", sourceId: presetId }],
    [{ sourceKind: "host", sourceId: presetId, documentVersion: 1 }, { sourceKind: "host", sourceId: presetId, documentVersion: 2 }],
    Array.from({ length: 6 }, (_, index) => ({ sourceKind: "builtin", sourceId: index === 0 ? "ai_ax" : `unknown-${index}` })),
  ]) {
    assert.throws(
      () => parseLiveGlossaryPinsInput({ expectedVersion: 3, glossaries }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_GLOSSARY_SELECTION",
    );
  }
  assert.throws(
    () => parseLiveGlossaryPinsInput({ expectedVersion: 3, presetId, documentVersion: 4 }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_GLOSSARY_PIN",
    "공개 다중선택 API는 legacy singular 입력을 허용하면 안 됩니다.",
  );
  assert.throws(
    () => parseLiveGlossaryPinsInput({
      expectedVersion: 2_147_483_648,
      glossaries: [{ sourceKind: "builtin", sourceId: "ai_ax" }],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_GLOSSARY_PIN",
    "세션 버전은 PostgreSQL integer 상한을 넘으면 안 됩니다.",
  );
});

test("service atomically replaces and reads ordered builtin plus host glossary pins", async () => {
  const now = Date.UTC(2026, 7, 27);
  const service = new LiveSessionService(new MemoryLiveSessionStore(() => now), () => now);
  const session = await service.create("host@example.com", { sessionType: "meeting", languages: ["ko"] });
  const presetId = crypto.randomUUID();
  const replaced = await service.replaceGlossaryPins("host@example.com", session.id, {
    expectedVersion: session.version,
    glossaries: [
      { sourceKind: "builtin", sourceId: "commercial_real_estate" },
      { sourceKind: "host", sourceId: presetId, documentVersion: 7 },
    ],
  });
  assert.deepEqual(replaced.glossaries, [
    { sourceKind: "builtin", sourceId: "commercial_real_estate", documentVersion: 1, ordinal: 1, fingerprint: null },
    { sourceKind: "host", sourceId: presetId, documentVersion: 7, ordinal: 2, fingerprint: `sha256:${"1".repeat(64)}` },
  ]);
  assert.deepEqual(await service.getGlossaryPins("host@example.com", session.id), replaced);
  await assert.rejects(
    () => service.replaceGlossaryPins("host@example.com", session.id, {
      expectedVersion: session.version,
      glossaries: [{ sourceKind: "builtin", sourceId: "ai_ax" }],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "VERSION_CONFLICT",
  );
});

test("service pins an owned preparing session with one version-guarded store transition", async () => {
  const service = new LiveSessionService(new MemoryLiveSessionStore(() => Date.UTC(2026, 7, 15)), () => Date.UTC(2026, 7, 15));
  const session = await service.create("host@example.com", { sessionType: "meeting", languages: ["ko"] });
  const presetId = crypto.randomUUID();
  const pinned = await service.pinGlossaryVersion("host@example.com", session.id, {
    expectedVersion: session.version,
    presetId,
    documentVersion: 4,
  });

  assert.deepEqual(pinned, {
    sessionId: session.id,
    version: session.version + 1,
    pinnedGlossaryPresetId: presetId,
    pinnedGlossaryVersion: 4,
    pinnedGlossaryFingerprint: `sha256:${"0".repeat(64)}`,
    updatedAt: new Date(Date.UTC(2026, 7, 15)).toISOString(),
  });
  await assert.rejects(
    () => service.pinGlossaryVersion("host@example.com", session.id, {
      expectedVersion: session.version,
      presetId,
      documentVersion: 4,
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "VERSION_CONFLICT",
  );
});

test("Supabase multi glossary pins use one exact v2 RPC and fail-closed response parsing", async () => {
  const sessionId = crypto.randomUUID();
  const presetId = crypto.randomUUID();
  const updatedAt = "2026-08-15T00:00:00.000Z";
  const calls: Array<{ url: string; body: unknown }> = [];
  const store = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"p".repeat(24)}`, kind: "secret" },
    (async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json([{
        session_id: sessionId,
        version: 8,
        glossaries: [
          { ordinal: 1, source_kind: "builtin", source_id: "ai_ax", document_version: 1, fingerprint: null },
          { ordinal: 2, source_kind: "host", source_id: presetId, document_version: 2, fingerprint: `sha256:${"a".repeat(64)}` },
        ],
        updated_at: updatedAt,
      }]);
    }) as typeof fetch,
  );

  assert.deepEqual(await store.replaceGlossaryPinsOwned(sessionId, "host@example.com", 7, [
    { sourceKind: "builtin", sourceId: "ai_ax", documentVersion: 1 },
    { sourceKind: "host", sourceId: presetId, documentVersion: 2 },
  ]), {
    sessionId,
    version: 8,
    glossaries: [
      { ordinal: 1, sourceKind: "builtin", sourceId: "ai_ax", documentVersion: 1, fingerprint: null },
      { ordinal: 2, sourceKind: "host", sourceId: presetId, documentVersion: 2, fingerprint: `sha256:${"a".repeat(64)}` },
    ],
    updatedAt,
  });
  assert.deepEqual(calls, [{
    url: "https://dev-ref.supabase.co/rest/v1/rpc/replace_live_session_glossary_pins_v2",
    body: {
      p_session_id: sessionId,
      p_host_id: "host@example.com",
      p_expected_session_version: 7,
      p_glossaries: [
        { source_kind: "builtin", source_id: "ai_ax", document_version: 1 },
        { source_kind: "host", source_id: presetId, document_version: 2 },
      ],
    },
  }]);

  const invalidStore = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"q".repeat(24)}`, kind: "secret" },
    (async () => Response.json([{ session_id: sessionId, version: 8, leaked: "unexpected" }])) as typeof fetch,
  );
  await assert.rejects(
    () => invalidStore.replaceGlossaryPinsOwned(sessionId, "host@example.com", 7, [{ sourceKind: "builtin", sourceId: "ai_ax" }]),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_GLOSSARY_PIN_RESPONSE",
  );
});

test("Supabase glossary pin maps allowlisted database failures without leaking raw errors", async () => {
  const sessionId = crypto.randomUUID();
  const presetId = crypto.randomUUID();
  for (const [databaseMessage, expectedCode] of [
    ["ACTIVE_SESSION_GLOSSARY_IMMUTABLE", "ACTIVE_SESSION_GLOSSARY_IMMUTABLE"],
    ["LIVE_SESSION_VERSION_CONFLICT", "VERSION_CONFLICT"],
    ["LIVE_SESSION_NOT_FOUND", "SESSION_NOT_FOUND"],
    ["GLOSSARY_DOCUMENT_VERSION_NOT_FOUND", "GLOSSARY_DOCUMENT_VERSION_NOT_FOUND"],
  ] as const) {
    const store = new SupabaseLiveSessionStore(
      "https://dev-ref.supabase.co",
      { key: `sb_secret_${"r".repeat(24)}`, kind: "secret" },
      (async () => Response.json({ message: databaseMessage, details: "private@example.com" }, { status: 400 })) as typeof fetch,
    );
    await assert.rejects(
      () => store.pinGlossaryVersionOwned(sessionId, "host@example.com", 1, presetId, 1),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === expectedCode
        && !error.message.includes("private@example.com"),
    );
  }
});

test("section transitions are owner-only version-guarded and idempotent for duplicate section intents", async () => {
  const now = Date.UTC(2026, 7, 15, 0, 0, 0);
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const created = await service.create("host-1", { sessionType: "meeting", languages: ["ko"] });
  const started = await service.start("host-1", created.id, created.version);

  const qa = await service.transitionSection("host-1", started.id, started.version, "qa", "section:qa:1", 10);
  assert.equal(qa.activeSection, "qa");
  assert.equal(qa.version, started.version + 1);
  assert.equal(qa.sectionStartedAt, new Date(now).toISOString());
  const duplicate = await service.transitionSection("host-1", started.id, started.version, "qa", "section:qa:1", 10);
  assert.equal(duplicate.activeSection, "qa");
  assert.equal(duplicate.version, qa.version);
  await assert.rejects(
    () => service.transitionSection("other-host", started.id, qa.version, "other", "section:other:1", 11),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_FOUND",
  );
  await assert.rejects(
    () => service.transitionSection("host-1", started.id, started.version, "prepared_remarks", "section:prepared:1", 12),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "VERSION_CONFLICT",
  );
});

test("scheduled session expires six hours after schedule and rejects more than 30 days ahead", async () => {
  const now = Date.UTC(2026, 6, 23);
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const scheduledAt = new Date(now + 7 * 24 * 60 * 60 * 1_000).toISOString();
  const session = await service.create("host-1", {
    title: "Investor Briefing",
    scheduledAt,
    sessionType: "meeting",
    languages: ["ko", "en"],
  });
  assert.equal(session.title, "Investor Briefing");
  assert.equal(session.scheduledAt, scheduledAt);
  assert.equal(session.expiresAt, new Date(Date.parse(scheduledAt) + 6 * 60 * 60 * 1_000).toISOString());
  await assert.rejects(
    service.create("host-1", {
      title: "Too far",
      scheduledAt: new Date(now + 31 * 24 * 60 * 60 * 1_000).toISOString(),
      sessionType: "meeting",
      languages: ["ko"],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SCHEDULE_TOO_FAR",
  );
});

test("retired voice inputs normalize every new session to captions-only", async () => {
  const service = new LiveSessionService(new MemoryLiveSessionStore());
  const presentation = await service.create("host-1", {
    sessionType: "presentation",
    outputMode: "captions",
    voiceProvider: "openai",
    languages: ["ko"],
  });
  assert.equal(presentation.voiceProvider, "gemini");
  assert.equal(presentation.outputMode, "captions");
  const meeting = await service.create("host-1", {
    sessionType: "meeting",
    outputMode: "captions",
    voiceProvider: "openai",
    languages: ["ko"],
  });
  assert.equal(meeting.voiceProvider, "gemini");
  assert.equal(meeting.outputMode, "captions");
  await assert.rejects(
    service.create("host-1", {
      sessionType: "presentation",
      outputMode: "audio",
      voiceProvider: "openai",
      languages: ["th"],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_LANGUAGES",
  );
  const captions = await service.create("host-1", {
    sessionType: "presentation",
    outputMode: "captions",
    voiceProvider: "openai",
    languages: ["ko"],
  });
  assert.equal(captions.voiceProvider, "gemini");
});

test("updating a legacy audio session preserves only the caption compatibility projection", async () => {
  const store = new MemoryLiveSessionStore();
  const service = new LiveSessionService(store);
  const created = await service.create("host-1", {
    sessionType: "presentation",
    outputMode: "captions",
    voiceProvider: "openai",
    languages: ["ko"],
  });
  const updated = await service.update("host-1", created.id, { version: 1, sessionType: "meeting" });
  assert.equal(updated.voiceProvider, "gemini");
  assert.equal(updated.outputMode, "captions");
  const second = await service.create("host-1", {
    sessionType: "presentation",
    outputMode: "captions",
    voiceProvider: "openai",
    languages: ["ko"],
  });
  const captionsOnly = await service.update("host-1", second.id, { version: 1, outputMode: "captions" });
  assert.equal(captionsOnly.voiceProvider, "gemini");
});

test("session update uses optimistic versioning and preserves host ownership", async () => {
  const now = Date.UTC(2026, 6, 19);
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const created = await service.create("host-1", { sessionType: "presentation", languages: ["en"] });
  const updated = await service.update("host-1", created.id, { version: 1, sessionType: "meeting", languages: ["ko"] });
  assert.equal(updated.version, 2);
  assert.equal(updated.outputMode, "captions");
  await assert.rejects(() => service.update("host-1", created.id, { version: 1, languages: ["ja"] }), (error: unknown) => {
    return error instanceof Error && "code" in error && error.code === "VERSION_CONFLICT";
  });
  await assert.rejects(() => service.update("other-host", created.id, { version: 2, languages: ["ja"] }), /찾을 수 없습니다/);
});

test("host start intent is owner-bound and does not commit live before gateway acknowledgement", async () => {
  const store = new MemoryLiveSessionStore();
  const service = new LiveSessionService(store);
  const created = await service.create("host-1", {
    title: "Live Translation",
    sessionType: "meeting",
    languages: ["ko", "en"],
  });
  const intent = await service.prepareStart("host-1", created.id, created.version);
  assert.equal(intent.status, "preparing");
  assert.equal(intent.version, created.version);
  assert.equal((await store.get(created.id))?.status, "preparing");
  await assert.rejects(
    service.prepareStart("other-host", created.id, created.version),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_FOUND",
  );
});

test("host start commit uses one guarded preparing-to-live transition", async () => {
  const store = new MemoryLiveSessionStore();
  const service = new LiveSessionService(store);
  const created = await service.create("host-1", {
    title: "Live Translation",
    sessionType: "meeting",
    languages: ["ko", "en"],
  });
  const started = await service.start("host-1", created.id, created.version);
  assert.equal(started.status, "live");
  assert.equal(started.version, created.version + 1);
  assert.deepEqual(await service.start("host-1", created.id, created.version), started);
  await assert.rejects(
    service.start("other-host", created.id, started.version),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_FOUND",
  );
});

test("manual start before the scheduled time preserves the pinned intent and waits for gateway readiness", async () => {
  const now = Date.UTC(2026, 7, 31, 0, 0, 0);
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const scheduledAt = new Date(now + 60 * 60_000).toISOString();
  const created = await service.create("host-1", {
    sessionType: "meeting", languages: ["ko", "en"], scheduledAt,
  });
  const pins = await service.replaceGlossaryPins("host-1", created.id, {
    expectedVersion: created.version,
    glossaries: [{ sourceKind: "builtin", sourceId: "commercial_real_estate" }],
  });
  const before = await store.get(created.id);

  const intent = await service.prepareStart("host-1", created.id, pins.version);

  assert.equal(intent.status, "preparing");
  assert.equal(intent.version, pins.version);
  assert.equal(intent.scheduledAt, scheduledAt);
  assert.equal(intent.expiresAt, created.expiresAt);
  assert.deepEqual(intent, before);
  assert.deepEqual(await store.get(created.id), before);
  assert.deepEqual(await service.getGlossaryPins("host-1", created.id), pins);
});

test("an early manual start cannot bypass ownership, pin version, paused or terminal state", async () => {
  const now = Date.UTC(2026, 7, 31, 0, 0, 0);
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const created = await service.create("host-1", {
    sessionType: "meeting", languages: ["ko"],
    scheduledAt: new Date(now + 60 * 60_000).toISOString(),
  });
  const pins = await service.replaceGlossaryPins("host-1", created.id, {
    expectedVersion: created.version,
    glossaries: [{ sourceKind: "builtin", sourceId: "commercial_real_estate" }],
  });
  const before = await store.get(created.id);
  for (const [hostId, version, expectedCode] of [
    ["other-host", pins.version, "SESSION_NOT_FOUND"],
    ["host-1", created.version, "VERSION_CONFLICT"],
    ["host-1", 0, "INVALID_VERSION"],
  ] as const) {
    await assert.rejects(service.prepareStart(hostId, created.id, version), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === expectedCode);
    assert.deepEqual(await store.get(created.id), before);
  }
  const started = await service.start("host-1", created.id, pins.version);
  const paused = await service.pause("host-1", created.id, started.version);
  await assert.rejects(service.prepareStart("host-1", created.id, paused.version), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "SESSION_PAUSED");
  await service.end("host-1", created.id);
  await assert.rejects(service.prepareStart("host-1", created.id, paused.version), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "SESSION_NOT_STARTABLE");
});

test("concurrent early manual intents stay read-only and the readiness commit wins one version CAS", async () => {
  const now = Date.UTC(2026, 7, 31, 0, 0, 0);
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const created = await service.create("host-1", {
    sessionType: "meeting", languages: ["ko"],
    scheduledAt: new Date(now + 60 * 60_000).toISOString(),
  });
  const intents = await Promise.all([
    service.prepareStart("host-1", created.id, created.version),
    service.prepareStart("host-1", created.id, created.version),
  ]);
  assert.deepEqual(intents, [created, created]);
  assert.deepEqual(await store.get(created.id), created);
  assert.equal(await store.startOwned(created.id, "other-host", created.version), null);
  const commits = await Promise.all([
    store.startOwned(created.id, "host-1", created.version),
    store.startOwned(created.id, "host-1", created.version),
  ]);
  const winners = commits.filter((session) => session !== null);
  assert.equal(winners.length, 1);
  assert.deepEqual(await store.get(created.id), {
    ...created, status: "live", version: created.version + 1,
  });
  assert.deepEqual(await service.start("host-1", created.id, created.version), winners[0]);
});

test("manual preparation does not pull future sessions into the automatic prewarm clock window", async () => {
  let now = Date.UTC(2026, 7, 31, 0, 0, 0);
  const scheduledTimestamp = now + 60 * 60_000;
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const created = await service.create("host-1", {
    sessionType: "meeting", languages: ["ko"],
    scheduledAt: new Date(scheduledTimestamp).toISOString(),
  });
  const isScheduledWithinNextMinute = () => store.hasPreparingScheduledBetween(
    new Date(now).toISOString(), new Date(now + 60_000).toISOString(),
  );
  assert.equal(await isScheduledWithinNextMinute(), false);
  await service.prepareStart("host-1", created.id, created.version);
  assert.equal(await isScheduledWithinNextMinute(), false);
  now = scheduledTimestamp - 60_000;
  assert.equal(await isScheduledWithinNextMinute(), true);
  assert.deepEqual(await store.get(created.id), created);
  await service.start("host-1", created.id, created.version);
  assert.equal(await isScheduledWithinNextMinute(), false);
});

test("session languages always include both ko and en caption lanes", async () => {
  const service = new LiveSessionService(new MemoryLiveSessionStore());
  const koOnly = await service.create("host-1", { sessionType: "meeting", languages: ["ko"] });
  assert.deepEqual(koOnly.languages, ["ko", "en"]);
  const jaOnly = await service.create("host-1", { sessionType: "meeting", languages: ["ja"] });
  assert.deepEqual(jaOnly.languages, ["ja", "ko", "en"]);
  // The union never exceeds the 3-language cap: extras beyond capacity drop.
  const crowded = await service.create("host-1", { sessionType: "meeting", languages: ["ja", "fr", "ko"] });
  assert.deepEqual(crowded.languages, ["ja", "ko", "en"]);
  const updated = await service.update("host-1", koOnly.id, { version: 1, languages: ["ja"] });
  assert.deepEqual(updated.languages, ["ja", "ko", "en"]);
});

test("pause and resume are guarded versioned transitions between live and paused", async () => {
  const store = new MemoryLiveSessionStore();
  const service = new LiveSessionService(store);
  const created = await service.create("host-1", { sessionType: "meeting", languages: ["ko", "en"] });

  await assert.rejects(
    service.pause("host-1", created.id, created.version),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_PAUSABLE",
  );

  const started = await service.start("host-1", created.id, created.version);
  const paused = await service.pause("host-1", created.id, started.version);
  assert.equal(paused.status, "paused");
  assert.equal(paused.version, started.version + 1);
  // Idempotent retry with the stale version returns the paused session.
  assert.deepEqual(await service.pause("host-1", created.id, started.version), paused);
  await assert.rejects(
    service.pause("other-host", created.id, paused.version),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_FOUND",
  );
  await assert.rejects(
    service.start("host-1", created.id, paused.version),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_PAUSED",
  );

  const resumed = await service.resume("host-1", created.id, paused.version);
  assert.equal(resumed.status, "live");
  assert.equal(resumed.version, paused.version + 1);
  assert.deepEqual(await service.resume("host-1", created.id, paused.version), resumed);
  // Resuming an already-live session stays idempotent instead of failing.
  assert.deepEqual(await service.resume("host-1", created.id, resumed.version), resumed);

  await service.end("host-1", created.id);
  await assert.rejects(
    service.pause("host-1", created.id, resumed.version + 1),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_PAUSABLE",
  );
});

test("host recovery lists only the host's active sessions", async () => {
  const store = new MemoryLiveSessionStore();
  const service = new LiveSessionService(store);
  const preparing = await service.create("host-1", { sessionType: "meeting", languages: ["ko", "en"], title: "Preparing" });
  const live = await service.create("host-1", { sessionType: "meeting", languages: ["ko", "en"], title: "Live" });
  await service.start("host-1", live.id, live.version);
  const pausedSession = await service.create("host-1", { sessionType: "meeting", languages: ["ko", "en"], title: "Paused" });
  const pausedStarted = await service.start("host-1", pausedSession.id, pausedSession.version);
  await service.pause("host-1", pausedSession.id, pausedStarted.version);
  const ended = await service.create("host-1", { sessionType: "meeting", languages: ["ko", "en"], title: "Ended" });
  await service.end("host-1", ended.id);
  await service.create("host-2", { sessionType: "meeting", languages: ["ko", "en"], title: "Other host" });

  const mine = await service.listActive("host-1");
  assert.deepEqual(
    mine.map((session) => [session.title, session.status]).sort(),
    [["Live", "live"], ["Paused", "paused"], ["Preparing", "preparing"]],
  );
  assert.ok(mine.every((session) => session.hostId === "host-1"));
  assert.deepEqual([preparing.id, live.id, pausedSession.id].sort(), mine.map((session) => session.id).sort());
});

test("only explicit host end terminates a live session", async () => {
  const store = new MemoryLiveSessionStore();
  const service = new LiveSessionService(store);
  const created = await service.create("host-1", {
    title: "Persistent live call",
    sessionType: "meeting",
    languages: ["ko", "en"],
  });
  const started = await service.start("host-1", created.id, created.version);

  // Desktop caption pause/restart does not cross the LiveSessionService
  // boundary, so the session, participants, invite credentials, and transcript
  // remain attached to the same session id.
  assert.equal((await store.get(started.id))?.status, "live");
  await assert.rejects(
    service.end("other-host", started.id),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_FOUND",
  );
  assert.equal((await store.get(started.id))?.status, "live");

  await service.end("host-1", started.id);
  const ended = await store.get(started.id);
  assert.equal(ended?.status, "stopped");
  assert.ok(ended?.endedAt);
});

test("session type, capacity, and glossary update atomically while retired output inputs normalize", async () => {
  const now = Date.UTC(2026, 6, 19);
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const created = await service.create("host-1", { sessionType: "meeting", languages: ["ko"] });
  const updated = await service.update("host-1", created.id, {
    version: 1,
    sessionType: "meeting",
    outputMode: "captions_audio",
    languages: ["ko", "en"],
    maxViewers: 24,
    glossaryPack: "hotel",
  });
  assert.deepEqual(
    {
      sessionType: updated.sessionType,
      outputMode: updated.outputMode,
      languages: updated.languages,
      maxViewers: updated.maxViewers,
      glossaryPack: updated.glossaryPack,
      version: updated.version,
    },
    {
      sessionType: "meeting",
      outputMode: "captions",
      languages: ["ko", "en"],
      maxViewers: 24,
      glossaryPack: "hotel",
      version: 2,
    },
  );
  const audioOnly = await service.update("host-1", created.id, { version: 2, outputMode: "audio" });
  assert.equal(audioOnly.outputMode, "captions");
});

test("legacy townhall input maps to a captions-only meeting", async () => {
  const service = new LiveSessionService(new MemoryLiveSessionStore());
  const session = await service.create("host-1", { mode: "townhall", languages: ["ko"], voiceOutputMode: "auto_voice" });
  assert.equal(session.sessionType, "meeting");
  assert.equal(session.outputMode, "captions");
});

test("Supabase snapshot maps persisted speaker voice status", async () => {
  const sessionRow = {
    id: "session-1", host_id: "host-1", mode: "townhall", voice_output_mode: "auto_voice",
    status: "live", languages: ["ko"], viewer_count: 1, version: 1, voice_provider: "gemini",
    admission_open_until: null, expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const speaker = {
    speakerId: "speaker-1", label: "Speaker 1", colorToken: "speaker-1",
    voiceName: "Achernar", voiceStatus: "ready", lastSeenAt: new Date().toISOString(),
  };
  const secretKey = `sb_secret_${"a".repeat(24)}`;
  const store = new SupabaseLiveSessionStore("https://dev-ref.supabase.co", { key: secretKey, kind: "secret" }, async (url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), secretKey);
    assert.equal(headers.has("authorization"), false);
    if (String(url).includes("read_live_topic_context")) return Response.json({ ok: true, event: "topic-upsert", topics: [], topic_memberships: [], memberships_added: [], latest_source_seq: 0 });
    if (String(url).includes("session_speakers")) return Response.json([speaker]);
    if (String(url).includes("live_snapshots")) return Response.json([]);
    return Response.json([sessionRow]);
  });
  const snapshot = await store.getSnapshot(sessionRow.id, "ko");
  assert.equal(snapshot?.speakers[0]?.voiceStatus, "ready");
});

test("getSnapshot rehydrates the full caption history from live_utterances", async () => {
  // live_snapshots.captions holds only the LATEST caption by design
  // (jsonb_build_array of one event, replaced on conflict). The durable record
  // is live_utterances. A viewer that joins, reconnects, or switches language
  // clears its in-memory captions and repopulates from this snapshot, so if the
  // snapshot serves one caption the entire visible history is destroyed — which
  // is exactly what participants saw when toggling EN -> KO -> EN.
  const sessionRow = {
    id: crypto.randomUUID(), host_id: "host-1", session_type: "meeting", output_mode: "captions",
    max_viewers: 50, glossary_pack: "general_cre", title: "Townhall",
    status: "live", languages: ["ko", "en"], viewer_count: 1, version: 1, voice_provider: "gemini",
    admission_open_until: null, expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const emittedAt = new Date().toISOString();
  const utteranceRows = [3, 2, 1].map((seq) => ({
    seq,
    participant_id: "participant-1",
    speaker_label: "speaker-1",
    speaker_name: "Noel Kim",
    text: `번역된 문장 ${seq}`,
    source_text: `source sentence ${seq}`,
    source_language: "en",
    translation_status: seq === 1 ? "failed" : "translated",
    source_ended_at: emittedAt,
    emitted_at: emittedAt,
  }));
  const secretKey = `sb_secret_${"b".repeat(24)}`;
  const topicId = crypto.randomUUID();
  let utterancesQuery = "";
  const store = new SupabaseLiveSessionStore("https://dev-ref.supabase.co", { key: secretKey, kind: "secret" }, async (url) => {
    const target = String(url);
    if (target.includes("read_live_topic_context")) return Response.json({
      ok: true,
      event: "topic-upsert",
      topics: [{
        id: topicId, session_id: sessionRow.id, ordinal: 1, title: "Revenue outlook", summary: null,
        status: "active", completion_reason: null, detector_health: "healthy", started_at: emittedAt,
        completed_at: null, version: 1,
      }],
      topic_memberships: [{ session_id: sessionRow.id, topic_id: topicId, utterance_key: "gateway:source:1", position: 1 }],
      memberships_added: [],
      latest_source_seq: 3,
    });
    if (target.includes("session_speakers")) return Response.json([]);
    if (target.includes("live_utterances")) {
      utterancesQuery = target;
      return Response.json(utteranceRows);
    }
    if (target.includes("live_snapshots")) {
      return Response.json([{ last_seq: 3, captions: [], speaker_legend: [] }]);
    }
    return Response.json([sessionRow]);
  });

  const snapshot = await store.getSnapshot(sessionRow.id, "ko");

  assert.equal(snapshot?.captions.length, 3, "the whole history must be replayed, not just the latest caption");
  assert.deepEqual(snapshot?.captions.map((caption) => caption.seq), [1, 2, 3]);
  assert.equal(snapshot?.lastSeq, 3);
  assert.equal(snapshot?.topics[0]?.title, "Revenue outlook");
  assert.equal(snapshot?.topicMemberships[0]?.utteranceKey, "gateway:source:1");
  // Only this language's rows, oldest-first, so seq ordering is preserved.
  assert.match(utterancesQuery, /language=eq\.ko/u);
  // The oldest bounded window is followed by gateway keyset replay, avoiding
  // both a five-second giant snapshot and a gap before the live edge.
  assert.match(utterancesQuery, /order=seq\.asc/u);
  // The viewer contract validates every SpeakerAssignment field and silently
  // drops captions whose speaker shape is partial.
  const speaker = snapshot?.captions[0]?.speaker;
  assert.equal(speaker?.speakerId, "participant:participant-1");
  assert.equal(speaker?.label, "Noel Kim");
  assert.equal(typeof speaker?.colorToken, "string");
  assert.equal(speaker?.voiceStatus, "disabled");
  assert.equal(speaker?.voiceName, null);
  assert.equal(typeof speaker?.lastSeenAt, "string");
  // 원문보기 disclosure has to survive rehydration too.
  assert.equal(snapshot?.captions[0]?.sourceText, "source sentence 1");
  assert.equal(snapshot?.captions[0]?.translationStatus, "failed");
  assert.equal(snapshot?.captions[0]?.isFinal, true);
  assert.match(utterancesQuery, /participant_id/u);
  assert.match(utterancesQuery, /translation_status/u);
});

test("getSnapshot preserves source-lane provenance from live_utterances", async () => {
  const sessionRow = {
    id: crypto.randomUUID(), host_id: "host-1", session_type: "meeting", output_mode: "captions",
    max_viewers: 50, glossary_pack: "general_cre", title: "Townhall", status: "live",
    languages: ["ko", "en"], viewer_count: 1, version: 1, voice_provider: "gemini",
    admission_open_until: null, expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const emittedAt = new Date().toISOString();
  const store = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"b".repeat(24)}`, kind: "secret" },
    async (url) => {
      const target = String(url);
      if (target.includes("read_live_topic_context")) return Response.json({ ok: true, event: "topic-upsert", topics: [], topic_memberships: [], memberships_added: [], latest_source_seq: 0 });
      if (target.includes("session_speakers")) return Response.json([]);
      if (target.includes("live_utterances")) return Response.json([{
        seq: 1, speaker_label: null, speaker_name: null, text: "원문입니다.",
        source_text: null, source_language: "ko", origin: "source",
        utterance_key: "session-1:input:1", source_ended_at: emittedAt, emitted_at: emittedAt,
      }]);
      if (target.includes("live_snapshots")) return Response.json([]);
      return Response.json([sessionRow]);
    },
  );
  const snapshot = await store.getSnapshot("session-1", "ko");
  assert.equal(snapshot?.captions[0]?.origin, "source");
  assert.equal(snapshot?.captions[0]?.utteranceKey, "session-1:input:1");
});

test("getSnapshot serves a bounded oldest window whose lastSeq resumes gateway paging", async () => {
  const sessionRow = {
    id: crypto.randomUUID(), host_id: "host-1", session_type: "meeting", output_mode: "captions",
    max_viewers: 50, glossary_pack: "general_cre", title: "Long call", status: "live",
    languages: ["ko"], viewer_count: 1, version: 1, voice_provider: "gemini",
    admission_open_until: null, expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const emittedAt = new Date().toISOString();
  const topicId = crypto.randomUUID();
  const allRows = Array.from({ length: 200 }, (_, index) => ({
    seq: index + 1, speaker_label: null, speaker_name: null, text: `line ${index + 1}`,
    source_text: "source", source_language: "en", origin: null, utterance_key: `u-${index + 1}`,
    source_ended_at: emittedAt, emitted_at: emittedAt,
  }));
  const utteranceQueries: string[] = [];
  const store = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"b".repeat(24)}`, kind: "secret" },
    async (url) => {
      const target = String(url);
      if (target.includes("read_live_topic_context")) return Response.json({
        ok: true,
        event: "topic-upsert",
        topics: [{
          id: topicId, session_id: sessionRow.id, ordinal: 1, title: "Long call", summary: null,
          status: "active", completion_reason: null, detector_health: "healthy",
          started_at: emittedAt, completed_at: null, version: 1,
        }],
        topic_memberships: allRows.map((row, index) => ({
          session_id: sessionRow.id,
          topic_id: topicId,
          utterance_key: row.utterance_key,
          position: index + 1,
        })),
        memberships_added: [],
        latest_source_seq: 200,
      });
      if (target.includes("session_speakers")) return Response.json([]);
      if (target.includes("live_snapshots")) return Response.json([{ last_seq: 450, captions: [], speaker_legend: [] }]);
      if (target.includes("live_utterances")) {
        utteranceQueries.push(target);
        return Response.json(allRows);
      }
      return Response.json([sessionRow]);
    },
  );
  const snapshot = await store.getSnapshot(sessionRow.id, "ko");
  assert.equal(snapshot?.captions.length, 200);
  assert.equal(snapshot?.lastSeq, 200, "the snapshot-row live edge must not skip gateway replay pages");
  assert.equal(utteranceQueries.length, 1);
  assert.match(utteranceQueries[0], /order=seq\.asc/u);
  assert.ok(snapshot);
  const topicState = mergeLiveTopicSnapshot(createLiveTopicState(sessionRow.id), {
    topics: snapshot.topics,
    topicMemberships: snapshot.topicMemberships,
  });
  const projected = projectTopicMemberships(snapshot.captions, topicState.topicMemberships);
  assert.equal(projected.filter((caption) => caption.topicId === undefined).length, 0);
});

test("topic context RPC is exact, session-fenced, and fail-closed", async () => {
  const sessionId = crypto.randomUUID();
  const topicId = crypto.randomUUID();
  const valid = {
    ok: true,
    event: "topic-upsert",
    topics: [{
      id: topicId, session_id: sessionId, ordinal: 1, title: "AI investment", summary: null,
      status: "active", completion_reason: null, detector_health: "healthy",
      started_at: "2026-08-15T00:00:00.000Z", completed_at: null, version: 1,
    }],
    topic_memberships: [{ session_id: sessionId, topic_id: topicId, utterance_key: "gateway:source:1", position: 1 }],
    memberships_added: [],
    latest_source_seq: 1,
  };
  let rpcBody = "";
  const store = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"b".repeat(24)}`, kind: "secret" },
    async (_url, init) => {
      rpcBody = String(init?.body);
      return Response.json(valid);
    },
  );
  assert.deepEqual(await store.getTopicSnapshot(sessionId, "ko"), {
    topics: [{
      id: topicId, sessionId, ordinal: 1, title: "AI investment", summary: null,
      status: "active", completionReason: null, detectorHealth: "healthy",
      startedAt: "2026-08-15T00:00:00.000Z", completedAt: null, version: 1,
    }],
    topicMemberships: [{ sessionId, topicId, utteranceKey: "gateway:source:1", position: 1 }],
  });
  assert.deepEqual(JSON.parse(rpcBody), { p_session_id: sessionId, p_language: "ko" });

  for (const invalid of [
    { ...valid, debug: "private" },
    { ...valid, topics: [{ ...valid.topics[0], session_id: crypto.randomUUID() }] },
    { ...valid, topic_memberships: [{ ...valid.topic_memberships[0], topicId }] },
  ]) {
    const invalidStore = new SupabaseLiveSessionStore(
      "https://dev-ref.supabase.co",
      { key: `sb_secret_${"b".repeat(24)}`, kind: "secret" },
      async () => Response.json(invalid),
    );
    await assert.rejects(() => invalidStore.getTopicSnapshot(sessionId, "ko"), /주제/u);
  }
});

test("transcript topics page beyond the realtime snapshot ceiling and reject private or cross-session rows", async () => {
  const sessionId = crypto.randomUUID();
  const topicId = crypto.randomUUID();
  const startedAt = "2026-08-15T00:00:00.000Z";
  const topicRow = {
    id: topicId, session_id: sessionId, ordinal: 1, title: "Revenue outlook", summary: null,
    status: "active", completion_reason: null, detector_health: "healthy",
    started_at: startedAt, completed_at: null, version: 1,
  };
  const membershipRows = Array.from({ length: 1_001 }, (_, index) => ({
    session_id: sessionId,
    topic_id: topicId,
    utterance_key: `gateway:source:${index + 1}`,
    position: index + 1,
  }));
  const queries: string[] = [];
  const store = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"b".repeat(24)}`, kind: "secret" },
    async (url) => {
      const target = String(url);
      queries.push(target);
      if (target.includes("live_topic_utterances")) {
        const offset = Number(new URL(target).searchParams.get("offset") ?? 0);
        return Response.json(membershipRows.slice(offset, offset + 1_000));
      }
      return Response.json([topicRow]);
    },
  );

  const transcript = await store.getTopicTranscript(sessionId);
  assert.equal(transcript.topics.length, 1);
  assert.equal(transcript.topicMemberships.length, 1_001);
  assert.equal(transcript.topicMemberships[1_000]?.utteranceKey, "gateway:source:1001");
  assert.equal(queries.filter((query) => query.includes("live_topic_utterances")).length, 2);
  assert.ok(queries.every((query) => query.includes(`session_id=eq.${sessionId}`)));
  assert.ok(queries.some((query) => query.includes("offset=1000")));

  for (const invalidFetch of [
    async (url: string | URL | Request) => String(url).includes("live_topic_utterances")
      ? Response.json([])
      : Response.json([{ ...topicRow, email: "private@example.com" }]),
    async (url: string | URL | Request) => String(url).includes("live_topic_utterances")
      ? Response.json([{ ...membershipRows[0], session_id: crypto.randomUUID() }])
      : Response.json([topicRow]),
  ]) {
    const invalidStore = new SupabaseLiveSessionStore(
      "https://dev-ref.supabase.co",
      { key: `sb_secret_${"b".repeat(24)}`, kind: "secret" },
      invalidFetch,
    );
    await assert.rejects(() => invalidStore.getTopicTranscript(sessionId), /주제/u);
  }

  assert.deepEqual(await new MemoryLiveSessionStore().getTopicTranscript(sessionId), {
    topics: [],
    topicMemberships: [],
  });
});

test("Supabase rows reject invalid providers and normalize stale OpenAI rows to Gemini", async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const baseRow = {
    id: crypto.randomUUID(), host_id: "host-1", session_type: "presentation", output_mode: "audio",
    status: "live", languages: ["ko"], viewer_count: 0, max_viewers: 50, version: 1,
    glossary_pack: "general_cre", admission_open_until: null, expires_at: expiresAt,
  };
  for (const row of [
    { ...baseRow, voice_provider: undefined },
    { ...baseRow, voice_provider: "unknown" },
    { ...baseRow, voice_provider: "gemini", participant_speaking_enabled: "true" },
  ]) {
    const store = new SupabaseLiveSessionStore(
      "https://dev-ref.supabase.co",
      { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
      async () => Response.json([row]),
    );
    await assert.rejects(
      store.get(baseRow.id),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_STORED_SESSION",
    );
  }
  for (const row of [
    { ...baseRow, session_type: "meeting", voice_provider: "openai" },
    { ...baseRow, output_mode: "captions", voice_provider: "openai" },
  ]) {
    const store = new SupabaseLiveSessionStore(
      "https://dev-ref.supabase.co",
      { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
      async () => Response.json([row]),
    );
    const session = await store.get(baseRow.id);
    assert.equal(session?.voiceProvider, "gemini");
    assert.equal(session?.outputMode, "captions");
    assert.equal(session?.participantSpeakingEnabled, false);
  }
});

test("Supabase session rows fail closed on noncanonical, duplicate, or oversized language sets", async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const baseRow = {
    id: crypto.randomUUID(), host_id: "host-1", session_type: "presentation", output_mode: "captions",
    voice_provider: "gemini", status: "live", viewer_count: 0, max_viewers: 50, version: 1,
    glossary_pack: "general_cre", admission_open_until: null, expires_at: expiresAt,
  };
  for (const languages of [[], ["en-US"], ["th"], ["en", "en"], ["en", "ko", "ja", "fr"]]) {
    const store = new SupabaseLiveSessionStore(
      "https://dev-ref.supabase.co",
      { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
      async () => Response.json([{ ...baseRow, languages }]),
    );
    await assert.rejects(
      store.get(baseRow.id),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_STORED_SESSION",
    );
  }
});

test("Supabase session writes use atomic canonical RPC contracts", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const row = {
    id: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
    host_id: "host-1",
    session_type: "presentation",
    output_mode: "captions_audio",
    status: "preparing",
    languages: ["ko"],
    viewer_count: 0,
    max_viewers: 24,
    version: 1,
    glossary_pack: "hotel",
    voice_provider: "gemini",
    participant_speaking_enabled: false,
    admission_open_until: null,
    expires_at: expiresAt,
  };
  const store = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    async (url, init) => {
      if (String(url).includes("select=event_metadata")) return Response.json([{ event_metadata: {} }]);
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json([{ ...row, version: requests.length }]);
    },
  );
  await store.create({
    id: row.id,
    hostId: row.host_id,
    title: "Investor Call",
    scheduledAt: null,
    sessionType: "presentation",
    outputMode: "captions",
    status: "preparing",
    languages: ["ko"],
    viewerCount: 0,
    maxViewers: 24,
    version: 1,
    glossaryPack: "hotel",
    voiceProvider: "gemini",
    participantSpeakingEnabled: false,
    admissionOpenUntil: null,
    expiresAt,
  });
  await store.updateOwned(row.id, row.host_id, 1, {
    title: "Investor Call",
    scheduledAt: null,
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko"],
    maxViewers: 20,
    glossaryPack: "fnb",
    voiceProvider: "gemini",
    participantSpeakingEnabled: true,
  });
  assert.match(requests[0]?.url ?? "", /\/rpc\/create_live_session_with_event_v2$/u);
  assert.deepEqual(requests[0]?.body, {
    p_session_id: row.id,
    p_host_id: row.host_id,
    p_title: "Investor Call",
    p_scheduled_at: null,
    p_session_type: "presentation",
    p_output_mode: "captions",
    p_languages: ["ko"],
    p_max_viewers: 24,
    p_glossary_pack: "hotel",
    p_voice_provider: "gemini",
    p_participant_speaking_enabled: false,
    p_expires_at: expiresAt,
    p_event_company_name: null,
    p_event_reporting_period: null,
    p_event_metadata: {
      modelPreferences: { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [] },
      ticker: null,
      eventType: null,
      agenda: [],
    },
  });
  assert.match(requests[1]?.url ?? "", /\/rpc\/update_live_session_with_event_v2$/u);
  assert.equal(requests[1]?.body.p_expected_version, 1);
  assert.equal(requests[1]?.body.p_title, "Investor Call");
  assert.equal(requests[1]?.body.p_scheduled_at, null);
  assert.equal(requests[1]?.body.p_output_mode, "captions");
  assert.equal(requests[1]?.body.p_max_viewers, 20);
  assert.equal(requests[1]?.body.p_glossary_pack, "fnb");
  assert.equal(requests[1]?.body.p_voice_provider, "gemini");
  assert.equal(requests[1]?.body.p_participant_speaking_enabled, true);
  assert.equal(requests[1]?.body.p_event_company_name, null);
  assert.equal(requests[1]?.body.p_event_reporting_period, null);
  assert.deepEqual(requests[1]?.body.p_event_metadata, {
    modelPreferences: { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [] },
    ticker: null,
    eventType: null,
    agenda: [],
  });
});

test("Supabase session store sends earnings-call metadata and section transition RPC shapes", async () => {
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const expiresAt = "2026-08-15T06:00:00.000Z";
  const row = {
    id: crypto.randomUUID(),
    host_id: "host-1",
    title: "Investor Call",
    scheduled_at: null,
    session_type: "meeting",
    output_mode: "captions",
    status: "live",
    languages: ["ko"],
    viewer_count: 0,
    max_viewers: 50,
    version: 1,
    glossary_pack: "general_cre",
    voice_provider: "gemini",
    participant_speaking_enabled: false,
    admission_open_until: null,
    expires_at: expiresAt,
    event_company_name: "Cushman & Wakefield",
    event_reporting_period: "Q2 2026",
    event_metadata: {
      ticker: "CWK",
      eventType: "earnings_call",
      agenda: [{ ordinal: 1, label: "Prepared remarks" }],
    },
  };
  const store = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    async (url, init) => {
      if (String(url).includes("select=event_metadata")) return Response.json([{ event_metadata: {} }]);
      requests.push({
        url: String(url),
        method: String(init?.method ?? "GET").toUpperCase(),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      if (String(url).endsWith("/rest/v1/rpc/create_live_session_with_event_v2")) return Response.json([{ ...row, version: 1 }]);
      if (String(url).endsWith("/rest/v1/rpc/update_live_session_with_event_v2")) {
        return Response.json([{
          ...row,
          version: 2,
          event_company_name: null,
          event_metadata: { ticker: "CWK", eventType: "other", agenda: [] },
        }]);
      }
      if (String(url).endsWith("/rest/v1/rpc/transition_live_session_section_v1")) {
        return Response.json([{
          session_id: row.id,
          section_id: crypto.randomUUID(),
          section_key: "qa",
          status: "active",
          ordinal: 1,
          version: 1,
          started_at: "2026-08-15T00:05:00.000Z",
          completed_at: null,
        }]);
      }
      if (String(url).endsWith("/rest/v1/rpc/read_live_session_event_context_v1")) {
        return Response.json([{
          session_id: row.id,
          event_company_name: null,
          event_reporting_period: "Q2 2026",
          event_metadata: { ticker: "CWK", eventType: "other", agenda: [] },
          active_section_key: "qa",
          sections: [{
            section_key: "qa",
            status: "active",
            started_at: "2026-08-15T00:05:00.000Z",
          }],
        }]);
      }
      if (String(url).includes("/rest/v1/live_sessions?")) return Response.json([{ ...row, version: 2 }]);
      return Response.json([]);
    },
  );

  await store.create({
    id: row.id,
    hostId: row.host_id,
    title: row.title,
    scheduledAt: null,
    sessionType: "meeting",
    outputMode: "captions",
    status: "live",
    languages: ["ko"],
    viewerCount: 0,
    maxViewers: 50,
    version: 1,
    glossaryPack: "general_cre",
    voiceProvider: "gemini",
    participantSpeakingEnabled: false,
    admissionOpenUntil: null,
    expiresAt,
    companyName: "Cushman & Wakefield",
    ticker: "CWK",
    fiscalPeriod: "Q2 2026",
    eventType: "earnings_call",
    agenda: [{ ordinal: 1, label: "Prepared remarks" }],
    activeSection: "prepared_remarks",
    sectionStartedAt: null,
  });
  await store.updateOwned(row.id, row.host_id, 1, {
    title: row.title,
    scheduledAt: null,
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko"],
    maxViewers: 50,
    glossaryPack: "general_cre",
    voiceProvider: "gemini",
    participantSpeakingEnabled: true,
    companyName: null,
    ticker: "CWK",
    fiscalPeriod: "Q2 2026",
    eventType: "other",
    agenda: [],
  });
  const transitioned = await store.transitionSectionOwned(row.id, row.host_id, 2, "qa", "section:qa:1", 42);

  assert.match(requests[0]?.url ?? "", /\/rpc\/create_live_session_with_event_v2$/u);
  assert.deepEqual(requests[0]?.body, {
    p_session_id: row.id,
    p_host_id: row.host_id,
    p_title: "Investor Call",
    p_scheduled_at: null,
    p_session_type: "meeting",
    p_output_mode: "captions",
    p_voice_provider: "gemini",
    p_languages: ["ko"],
    p_max_viewers: 50,
    p_participant_speaking_enabled: false,
    p_glossary_pack: "general_cre",
    p_expires_at: expiresAt,
    p_event_company_name: "Cushman & Wakefield",
    p_event_reporting_period: "Q2 2026",
    p_event_metadata: {
      modelPreferences: { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [] },
      ticker: "CWK",
      eventType: "earnings_call",
      agenda: [{ ordinal: 1, label: "Prepared remarks" }],
    },
  });
  assert.match(requests[1]?.url ?? "", /\/rpc\/update_live_session_with_event_v2$/u);
  assert.equal(requests[1]?.body.p_event_company_name, null);
  assert.equal(requests[1]?.body.p_participant_speaking_enabled, true);
  assert.equal(requests[1]?.body.p_event_reporting_period, "Q2 2026");
  assert.deepEqual(requests[1]?.body.p_event_metadata, {
    modelPreferences: { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [] },
    ticker: "CWK",
    eventType: "other",
    agenda: [],
  });
  assert.match(requests[2]?.url ?? "", /\/rpc\/transition_live_session_section_v1$/u);
  assert.deepEqual(requests[2]?.body, {
    p_session_id: row.id,
    p_host_id: row.host_id,
    p_expected_session_version: 2,
    p_transition_key: "section:qa:1",
    p_section_key: "qa",
    p_source_seq: 42,
  });
  assert.equal(transitioned?.ticker, "CWK");
  assert.equal(requests.some((request) => request.method === "PATCH" && request.url.includes("/rest/v1/live_sessions?")), false);
});

test("live store config uses the exact development project boundary", () => {
  const secretKey = `sb_secret_${"a".repeat(24)}`;
  const config = getLiveStoreConfig({
    LIVE_EXTERNAL_ENV: "development",
    LIVE_ALLOWED_SUPABASE_REF: "approved-dev-ref",
    SUPABASE_URL: "https://approved-dev-ref.supabase.co",
    SUPABASE_SECRET_KEY: secretKey,
  });
  assert.deepEqual(config, {
    baseUrl: "https://approved-dev-ref.supabase.co",
    credential: { key: secretKey, kind: "secret" },
  });
  assert.throws(() => getLiveStoreConfig({
    LIVE_EXTERNAL_ENV: "development",
    LIVE_ALLOWED_SUPABASE_REF: "approved-dev-ref",
    SUPABASE_URL: "https://different-ref.supabase.co",
    SUPABASE_SECRET_KEY: secretKey,
  }));
});

test("expired sessions reject host updates even before database cleanup", async () => {
  const store = new MemoryLiveSessionStore();
  const expiredSessionId = crypto.randomUUID();
  await store.create({
    id: expiredSessionId, hostId: "host-1", title: "Expired", scheduledAt: null,
    sessionType: "presentation", outputMode: "captions",
    voiceProvider: "gemini", maxViewers: 50, glossaryPack: "general_cre",
    participantSpeakingEnabled: false,
    status: "live", languages: ["en"], viewerCount: 0, version: 1,
    admissionOpenUntil: null, expiresAt: new Date(0).toISOString(),
  });
  const service = new LiveSessionService(store);
  await assert.rejects(
    service.update("host-1", expiredSessionId, { version: 1, languages: ["ko"] }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_FOUND",
  );
});

test("removed language snapshots fail explicitly", async () => {
  const now = Date.UTC(2026, 6, 19);
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const created = await service.create("host-1", { sessionType: "meeting", languages: ["en"] });
  await assert.rejects(() => service.snapshot(created.id, "ja"), (error: unknown) => {
    return error instanceof Error && "code" in error && error.code === "LANGUAGE_REMOVED";
  });
});

test("live APIs map missing server configuration to one safe actionable failure", () => {
  const failure = toLiveFailure(new LiveSecurityConfigurationError("SUPABASE_SECRET_KEY must never reach clients"));

  assert.deepEqual(failure, {
    status: 503,
    body: {
      ok: false,
      error: "라이브 서버 연결이 아직 설정되지 않았습니다.",
      code: "SECURITY_NOT_CONFIGURED",
    },
  });
  assert.equal(JSON.stringify(failure).includes("SUPABASE_SECRET_KEY"), false);
});

test("host session GET validates authentication, id, ownership, and safe error mapping", () => {
  const route = readFileSync(new URL("../../app/api/live-sessions/[id]/route.ts", import.meta.url), "utf8");
  const getStart = route.indexOf("export async function GET");
  const patchStart = route.indexOf("export async function PATCH");
  assert.notEqual(getStart, -1);
  assert.notEqual(patchStart, -1);
  const getHandler = route.slice(getStart, patchStart);

  assert.ok(getHandler.indexOf("requireHost(request)") < getHandler.indexOf("getLiveSessionStore().getOwned(id, hostId)"));
  assert.ok(getHandler.indexOf("parseSessionId(params.id)") < getHandler.indexOf("getLiveSessionStore().getOwned(id, hostId)"));
  assert.match(getHandler, /!session \|\| session\.hostId !== hostId/u);
  assert.match(getHandler, /"SESSION_NOT_FOUND", 404/u);
  assert.match(getHandler, /return apiSuccess\(session\)/u);
  assert.match(getHandler, /error instanceof AuthenticationError/u);
  assert.match(getHandler, /const failure = toLiveFailure\(error\)/u);
});

test("custom glossary preset inputs enforce all product ceilings and canonical language pairs", () => {
  const valid = {
    name: "CRE Board",
    domain: "Commercial real estate",
    glossary: "공실률 = vacancy rate",
    languagePair: { a: "en", b: "ko" },
  };
  assert.equal(createGlossaryPresetInputSchema.safeParse(valid).success, true);
  assert.equal(createGlossaryPresetInputSchema.safeParse({ ...valid, name: "x".repeat(81) }).success, false);
  assert.equal(createGlossaryPresetInputSchema.safeParse({ ...valid, domain: "x".repeat(601) }).success, false);
  assert.equal(createGlossaryPresetInputSchema.safeParse({ ...valid, glossary: "x".repeat(16_001) }).success, false);
  assert.equal(createGlossaryPresetInputSchema.safeParse({ ...valid, languagePair: { a: "en", b: "en" } }).success, false);
  assert.equal(createGlossaryPresetInputSchema.safeParse({ ...valid, languagePair: { a: "en", b: "xx" } }).success, false);
  assert.equal(glossaryPresetIdSchema.safeParse(crypto.randomUUID()).success, true);
  assert.equal(updateGlossaryPresetBodySchema.safeParse({ version: 1, ...valid }).success, true);
  assert.equal(deleteGlossaryPresetBodySchema.safeParse({ version: 1 }).success, true);
});

function glossaryDocumentFixture(name = "CRE Board") {
  return {
    schemaVersion: 1 as const,
    name,
    domain: "Commercial real estate",
    sourceLanguage: "en" as const,
    targetLanguages: ["ko" as const],
    terms: [{
      id: "vacancy-rate",
      source: "vacancy rate",
      translations: { ko: "공실률" },
      aliases: [],
      pronunciation: null,
      doNotTranslate: false,
      forbiddenTranslations: [],
      context: null,
      examples: [],
      tags: [],
      priority: 50,
      provenance: { kind: "manual" as const, label: "host" },
    }],
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    version: 1,
  };
}

test("Supabase glossary store uses exact owner-bound v2 RPC shapes and atomic create", async () => {
  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const document = glossaryDocumentFixture();
  const fingerprint = fingerprintGlossaryDocumentV1(document);
  const row = {
    id,
    name: "CRE Board",
    domain: "Commercial real estate",
    language_a: "en",
    language_b: "ko",
    target_languages: ["ko"],
    version: 1,
    active_document_version: 1,
    active_document_fingerprint: fingerprint,
    updated_at: "2026-08-15T01:00:00.000Z",
  };
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const versionRow = { preset_id: id, version: 1, document_schema: "glossary-document/v1", fingerprint, created_at: row.updated_at };
  const replies: unknown[] = [
    [row], [row], [versionRow], [{ ...versionRow, document }],
    [{ id: versionId, preset_id: id, host_id: "host-1", document_version: 2, fingerprint,
      document_schema: "glossary-document/v1", preset_version: 2, created_at: row.updated_at }],
    [{ preset_id: id, host_id: "host-1", version: 3, active_document_version: 2,
      active_document_fingerprint: fingerprint, updated_at: row.updated_at }], true,
  ];
  const store = new SupabaseGlossaryPresetStore({
    baseUrl: "https://approved-dev-ref.supabase.co",
    credential: { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return Response.json(replies.shift());
    }) as typeof fetch,
  });
  assert.equal((await store.list("host-1"))[0]?.id, id);
  assert.equal((await store.create("host-1", document, fingerprint)).id, id);
  assert.equal((await store.listVersions("host-1", id))[0]?.fingerprint, fingerprint);
  assert.equal((await store.readVersion("host-1", id, 1))?.document.name, document.name);
  assert.equal((await store.saveVersion("host-1", id, 1, document, fingerprint)).presetVersion, 2);
  assert.equal((await store.activateVersion("host-1", id, 2, 2)).activeDocumentVersion, 2);
  assert.equal(await store.delete(id, "host-1", 3), true);

  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/rest/v1/rpc/list_host_glossary_documents_v2",
    "/rest/v1/rpc/create_host_glossary_document_preset_v2",
    "/rest/v1/rpc/list_host_glossary_document_versions_v1",
    "/rest/v1/rpc/read_host_glossary_document_version_v1",
    "/rest/v1/rpc/save_host_glossary_document_version_v1",
    "/rest/v1/rpc/activate_host_glossary_document_version_v1",
    "/rest/v1/rpc/delete_host_glossary_preset",
  ]);
  assert.deepEqual(calls[1]?.body, {
    p_host_id: "host-1",
    p_name: row.name,
    p_domain: row.domain,
    p_language_a: "en",
    p_target_languages: ["ko"],
    p_document: document,
    p_fingerprint: fingerprint,
  });
  assert.equal(calls[4]?.body.p_expected_preset_version, 1);
  assert.equal(calls[5]?.body.p_expected_preset_version, 2);
  assert.equal(calls[6]?.body.p_expected_version, 3);
});

test("Supabase glossary store fails closed on unknown, noncanonical, or cross-preset rows", async () => {
  const validRow = {
    id: crypto.randomUUID(),
    name: "CRE Board",
    domain: "Commercial real estate",
    language_a: "en",
    language_b: "ko",
    target_languages: ["ko"],
    version: 1,
    active_document_version: null,
    active_document_fingerprint: null,
    updated_at: "2026-08-15T01:00:00.000Z",
  };
  for (const invalidRow of [
    { ...validRow, language_a: "en-US" },
    { ...validRow, target_languages: ["en", "ko"] },
    { ...validRow, target_languages: ["ja"] },
    { ...validRow, private_email: "private@example.com" },
    { ...validRow, active_document_version: 1 },
  ]) {
    const store = new SupabaseGlossaryPresetStore({
      baseUrl: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
      fetchFn: (async () => Response.json([invalidRow])) as typeof fetch,
    });
    await assert.rejects(
      store.list("host-1"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "NETWORK_UNAVAILABLE",
    );
  }
});

test("glossary version RPC parsers reject unknown keys, cross-preset rows, and fingerprint drift", async () => {
  const presetId = crypto.randomUUID();
  const document = glossaryDocumentFixture();
  const fingerprint = fingerprintGlossaryDocumentV1(document);
  const cases: Array<{ operation: (store: SupabaseGlossaryPresetStore) => Promise<unknown>; response: unknown }> = [
    {
      operation: (store) => store.listVersions("host-1", presetId),
      response: [{ preset_id: crypto.randomUUID(), version: 1, document_schema: "glossary-document/v1",
        fingerprint, created_at: document.createdAt }],
    },
    {
      operation: (store) => store.readVersion("host-1", presetId, 1),
      response: [{ preset_id: presetId, version: 1, document_schema: "glossary-document/v1",
        fingerprint: `sha256:${"0".repeat(64)}`, document, created_at: document.createdAt }],
    },
    {
      operation: (store) => store.saveVersion("host-1", presetId, 1, document, fingerprint),
      response: [{ id: crypto.randomUUID(), preset_id: presetId, host_id: "host-1", document_version: 2,
        fingerprint, document_schema: "glossary-document/v1", preset_version: 2,
        created_at: document.createdAt, private_email: "private@example.com" }],
    },
  ];
  for (const entry of cases) {
    const store = new SupabaseGlossaryPresetStore({
      baseUrl: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
      fetchFn: (async () => Response.json(entry.response)) as typeof fetch,
    });
    await assert.rejects(
      entry.operation(store),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "NETWORK_UNAVAILABLE",
    );
  }
});

test("Supabase glossary store preserves every database conflict code", async () => {
  for (const code of [
    "GLOSSARY_PRESET_LIMIT_REACHED",
    "GLOSSARY_VERSION_LIMIT_REACHED",
    "GLOSSARY_PRESET_NAME_CONFLICT",
    "GLOSSARY_PRESET_VERSION_CONFLICT",
    "GLOSSARY_PRESET_NOT_FOUND",
    "GLOSSARY_PRESET_IN_USE",
    "GLOSSARY_DOCUMENT_VERSION_NOT_FOUND",
    "GLOSSARY_DOCUMENT_FINGERPRINT_CONFLICT",
  ] as const) {
    const store = new SupabaseGlossaryPresetStore({
      baseUrl: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
      fetchFn: (async () => new Response(JSON.stringify({ message: code }), { status: 409 })) as typeof fetch,
    });
    await assert.rejects(
      store.list("host-1"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === code,
    );
  }
});

test("glossary version history cap is a stable Korean conflict through the version-save route", async () => {
  const store = new SupabaseGlossaryPresetStore({
    baseUrl: "https://approved-dev-ref.supabase.co",
    credential: { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    fetchFn: (async () => new Response(JSON.stringify({ message: "GLOSSARY_VERSION_LIMIT_REACHED" }), { status: 409 })) as typeof fetch,
  });
  let caught: unknown;
  try {
    await store.saveVersion("host-1", crypto.randomUUID(), 200, glossaryDocumentFixture(), `sha256:${"a".repeat(64)}`);
  } catch (error: unknown) {
    caught = error;
  }
  assert.deepEqual(toGlossaryPresetFailure(caught), {
    message: "용어집 버전은 최대 200개까지 저장할 수 있습니다.",
    code: "GLOSSARY_VERSION_LIMIT_REACHED",
    status: 409,
  });
  const route = readFileSync(new URL("../../app/api/glossary-presets/[id]/versions/route.ts", import.meta.url), "utf8");
  assert.match(route, /toGlossaryPresetFailure\(error\)/u);
  assert.match(route, /apiError\(failure\.message, failure\.code, failure\.status, privateNoStoreHeaders\(\)\)/u);
});

test("glossary service validates before persistence and duplicates through owner read plus one atomic create", async () => {
  const id = crypto.randomUUID();
  const document = glossaryDocumentFixture("Existing");
  const fingerprint = fingerprintGlossaryDocumentV1(document);
  const preset: GlossaryPreset = {
    id,
    name: "Existing",
    domain: "",
    languagePair: { a: "en", b: "ko" },
    targetLanguages: ["ko"],
    version: 2,
    activeDocumentVersion: 1,
    activeDocumentFingerprint: fingerprint,
    updatedAt: "2026-08-15T01:00:00.000Z",
  };
  const calls: string[] = [];
  const store: GlossaryPresetStore = {
    list: async () => [preset],
    create: async (_hostId, created, createdFingerprint) => {
      calls.push(`create:${created.name}:${createdFingerprint}`);
      return { ...preset, name: created.name, activeDocumentFingerprint: createdFingerprint };
    },
    listVersions: async () => [],
    readVersion: async (_hostId, presetId, version) => {
      calls.push(`read:${presetId}:${version}`);
      return { presetId, version, documentSchema: "glossary-document/v1", fingerprint,
        createdAt: document.createdAt, document };
    },
    saveVersion: async () => { throw new Error("unused"); },
    activateVersion: async () => ({ presetId: id, presetVersion: 3, activeDocumentVersion: 1,
      activeDocumentFingerprint: fingerprint, updatedAt: preset.updatedAt }),
    delete: async () => true,
  };
  const service = new GlossaryPresetService(store, () => Date.parse("2026-08-15T02:00:00.000Z"));
  const nullLabelDocument = {
    ...document,
    terms: document.terms.map((term) => ({ ...term, provenance: { ...term.provenance, label: null } })),
  };
  assert.equal(service.validate(nullLabelDocument).document.terms[0]?.provenance.label, null);
  await assert.rejects(
    service.create("host-1", { ...document, debug: "private" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_GLOSSARY_DOCUMENT",
  );
  assert.deepEqual(calls, [], "invalid documents must not reach storage");
  const duplicated = await service.duplicate("host-1", id, 1, "복제본");
  assert.equal(duplicated.name, "복제본");
  assert.equal(calls.length, 2);
  assert.match(calls[0] ?? "", /^read:/u);
  assert.match(calls[1] ?? "", /^create:복제본:sha256:/u);
});

test("glossary create, save, and activation retries are idempotent only for the same persisted fingerprint", async () => {
  const presetId = crypto.randomUUID();
  const document = glossaryDocumentFixture();
  const fingerprint = fingerprintGlossaryDocumentV1(document);
  const preset: GlossaryPreset = {
    id: presetId,
    name: document.name,
    domain: document.domain,
    languagePair: { a: "en", b: "ko" },
    targetLanguages: ["ko"],
    version: 4,
    activeDocumentVersion: 2,
    activeDocumentFingerprint: fingerprint,
    updatedAt: document.updatedAt,
  };
  const storedVersion = {
    presetId,
    version: 2,
    documentSchema: "glossary-document/v1" as const,
    fingerprint,
    createdAt: document.createdAt,
  };
  const store: GlossaryPresetStore = {
    list: async () => [preset],
    create: async () => { throw new GlossaryPresetError("conflict", "GLOSSARY_PRESET_NAME_CONFLICT", 409); },
    listVersions: async () => [storedVersion],
    readVersion: async () => null,
    saveVersion: async () => { throw new GlossaryPresetError("conflict", "GLOSSARY_PRESET_VERSION_CONFLICT", 409); },
    activateVersion: async () => { throw new GlossaryPresetError("conflict", "GLOSSARY_PRESET_VERSION_CONFLICT", 409); },
    delete: async () => true,
  };
  const service = new GlossaryPresetService(store);
  assert.equal((await service.create("host-1", document)).id, presetId);
  assert.deepEqual(await service.saveVersion("host-1", presetId, 3, document), {
    ...storedVersion,
    presetVersion: 4,
  });
  assert.equal((await service.activateVersion("host-1", presetId, 3, 2)).presetVersion, 4);

  const differentPreset = { ...preset, activeDocumentFingerprint: `sha256:${"0".repeat(64)}` };
  await assert.rejects(
    new GlossaryPresetService({ ...store, list: async () => [differentPreset] }).create("host-1", document),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "GLOSSARY_PRESET_NAME_CONFLICT",
  );
});

test("glossary document routes enforce origin before auth on mutations and private no-store envelopes", () => {
  const collection = readFileSync(new URL("../../app/api/glossary-presets/route.ts", import.meta.url), "utf8");
  const item = readFileSync(new URL("../../app/api/glossary-presets/[id]/route.ts", import.meta.url), "utf8");
  const routes = [
    collection,
    item,
    readFileSync(new URL("../../app/api/glossary-presets/import/route.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../../app/api/glossary-presets/[id]/versions/route.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../../app/api/glossary-presets/[id]/versions/[version]/route.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../../app/api/glossary-presets/[id]/activate/route.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../../app/api/glossary-presets/[id]/duplicate/route.ts", import.meta.url), "utf8"),
  ];
  for (const source of routes) {
    assert.match(source, /apiSuccess/u);
    assert.match(source, /apiError/u);
    assert.match(source, /AuthenticationError/u);
    assert.match(source, /privateNoStoreHeaders\(\)/u);
    assert.doesNotMatch(source, /console\.(?:log|info|warn|error)/u);
  }
  for (const source of routes.filter((candidate) => candidate.includes("assertStrictOrigin(request)"))) {
    const mutation = source.slice(source.indexOf("assertStrictOrigin(request)"));
    assert.ok(mutation.indexOf("assertStrictOrigin(request)") < mutation.indexOf("requireHost(request)"));
  }
  assert.match(collection, /parseGlossaryDocumentImportBody/u);
  for (const source of [collection, routes[2] ?? "", routes[3] ?? ""]) {
    const contentTypeIndex = source.indexOf("assertGlossaryJsonContentType(request.headers)");
    const contentLengthIndex = source.indexOf("assertGlossaryJsonContentLength(request.headers)");
    const bodyReadIndex = source.indexOf("request.text()");
    assert.ok(contentTypeIndex >= 0 && contentTypeIndex < contentLengthIndex);
    assert.ok(contentLengthIndex < bodyReadIndex);
  }
  assert.match(routes[2] ?? "", /validateOnly/u);
  assert.match(routes[4] ?? "", /attachment; filename="glossary-\$\{parsedId\.data\}-v\$\{version\}\.json"/u);
});


test("Supabase scheduled prewarm query combines both schedule bounds with an explicit AND", async () => {
  let requestedUrl = "";
  const store = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    async (input) => {
      requestedUrl = String(input);
      return Response.json([]);
    },
  );
  const startAt = "2026-08-29T00:50:00.000Z";
  const endAt = "2026-08-29T02:00:00.000Z";
  assert.equal(await store.hasPreparingScheduledBetween(startAt, endAt), false);
  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get("status"), "eq.preparing");
  assert.equal(url.searchParams.get("and"), `(scheduled_at.gte.${startAt},scheduled_at.lte.${endAt})`);
  assert.equal(url.searchParams.getAll("scheduled_at").length, 0);
  assert.equal(url.searchParams.get("limit"), "1");
});

test("host session polling reports admission closed when the DB retains a future expiry in paused state", async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const baseRow = {
    id: crypto.randomUUID(), host_id: "host-1", title: "Investor Call", scheduled_at: null,
    session_type: "presentation", output_mode: "captions", voice_provider: "gemini", status: "live",
    languages: ["ko"], viewer_count: 0, version: 2, admission_open_until: expiresAt, expires_at: expiresAt,
  };
  for (const admissionState of ["open", "paused", "ended", "uninitialized", undefined, "invalid"]) {
    const store = new SupabaseLiveSessionStore("https://dev-ref.supabase.co",
      { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
      async (url) => Response.json(String(url).includes("live_sessions?")
        ? [{ ...baseRow, admission_state: admissionState }] : []));
    const session = await store.get(baseRow.id);
    assert.ok(session);
    assert.equal(session.admissionOpenUntil, admissionState === "open" ? expiresAt : null, String(admissionState));
    assert.equal(session.status, "live", "closing admission must not end the active session");
  }
});

test("Supabase rows expose the server-owned gateway activation key to the host projection", async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const activationKey = crypto.randomUUID();
  const baseRow = {
    id: crypto.randomUUID(), host_id: "host-1", session_type: "presentation", output_mode: "captions",
    voice_provider: "gemini", status: "live", languages: ["ko"], viewer_count: 0, max_viewers: 50,
    version: 2, glossary_pack: "general_cre", admission_open_until: null, expires_at: expiresAt,
  };
  const withKey = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    async () => Response.json([{ ...baseRow, gateway_activation_key: activationKey }]),
  );
  assert.equal((await withKey.get(baseRow.id))?.activationKey, activationKey);

  // Sessions activated before the column existed (or not yet activated) stay null.
  const withoutKey = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    async () => Response.json([baseRow]),
  );
  assert.equal((await withoutKey.get(baseRow.id))?.activationKey, null);

  // A malformed stored key is dropped, never surfaced to clients.
  const withBadKey = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    async () => Response.json([{ ...baseRow, gateway_activation_key: "<not-a-uuid>" }]),
  );
  assert.equal((await withBadKey.get(baseRow.id))?.activationKey, null);
});
