import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { LiveSecurityConfigurationError } from "../security/config";
import { LiveSessionService } from "./service";
import { getLiveStoreConfig } from "./config";
import { toLiveFailure } from "./errors";
import { MemoryLiveSessionStore, SupabaseLiveSessionStore } from "./store";
import { parseLanguages, parseSessionId } from "./validation";

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

test("session create validates one to three languages and expires after six hours", async () => {
  const now = Date.UTC(2026, 6, 19);
  const service = new LiveSessionService(new MemoryLiveSessionStore(() => now), () => now);
  const session = await service.create("host-1", { sessionType: "presentation", languages: ["en-US", "ko-KR"] });
  assert.deepEqual(session.languages, ["en", "ko"]);
  assert.equal(session.version, 1);
  assert.equal(session.outputMode, "captions");
  assert.equal(session.voiceProvider, "gemini");
  assert.equal(session.maxViewers, 50);
  assert.equal(session.glossaryPack, "general_cre");
  assert.equal(session.viewerCount, 0);
  assert.equal(session.expiresAt, new Date(now + 6 * 60 * 60 * 1_000).toISOString());
  await assert.rejects(() => service.create("host-1", { sessionType: "meeting", languages: [] }), /1개 이상/);
});

test("OpenAI voice is presentation-only and remains independent from Gemini captions", async () => {
  const service = new LiveSessionService(new MemoryLiveSessionStore());
  const presentation = await service.create("host-1", {
    sessionType: "presentation",
    outputMode: "captions_audio",
    voiceProvider: "openai",
    languages: ["ko"],
  });
  assert.equal(presentation.voiceProvider, "openai");
  await assert.rejects(
    service.create("host-1", {
      sessionType: "meeting",
      outputMode: "captions_audio",
      voiceProvider: "openai",
      languages: ["ko"],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "OPENAI_VOICE_OUTPUT_ONLY",
  );
  await assert.rejects(
    service.create("host-1", {
      sessionType: "presentation",
      outputMode: "audio",
      voiceProvider: "openai",
      languages: ["th"],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_LANGUAGES",
  );
  await assert.rejects(
    service.create("host-1", {
      sessionType: "presentation",
      outputMode: "captions",
      voiceProvider: "openai",
      languages: ["ko"],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "OPENAI_VOICE_OUTPUT_ONLY",
  );
});

test("changing an OpenAI presentation to meeting resets voice output provider to Gemini", async () => {
  const store = new MemoryLiveSessionStore();
  const service = new LiveSessionService(store);
  const created = await service.create("host-1", {
    sessionType: "presentation",
    outputMode: "audio",
    voiceProvider: "openai",
    languages: ["ko"],
  });
  const updated = await service.update("host-1", created.id, { version: 1, sessionType: "meeting" });
  assert.equal(updated.voiceProvider, "gemini");
  const second = await service.create("host-1", {
    sessionType: "presentation",
    outputMode: "audio",
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

test("session type, output, capacity, and glossary update atomically", async () => {
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
      outputMode: "captions_audio",
      languages: ["ko", "en"],
      maxViewers: 24,
      glossaryPack: "hotel",
      version: 2,
    },
  );
  const audioOnly = await service.update("host-1", created.id, { version: 2, outputMode: "audio" });
  assert.equal(audioOnly.outputMode, "audio");
});

test("legacy townhall input maps to meeting audio for one release", async () => {
  const service = new LiveSessionService(new MemoryLiveSessionStore());
  const session = await service.create("host-1", { mode: "townhall", languages: ["ko"], voiceOutputMode: "auto_voice" });
  assert.equal(session.sessionType, "meeting");
  assert.equal(session.outputMode, "audio");
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
    if (String(url).includes("session_speakers")) return Response.json([speaker]);
    if (String(url).includes("live_snapshots")) return Response.json([]);
    return Response.json([sessionRow]);
  });
  const snapshot = await store.getSnapshot("session-1", "ko");
  assert.equal(snapshot?.speakers[0]?.voiceStatus, "ready");
});

test("Supabase rows reject unknown or meeting-scoped OpenAI voice providers", async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const baseRow = {
    id: crypto.randomUUID(), host_id: "host-1", session_type: "presentation", output_mode: "audio",
    status: "live", languages: ["ko"], viewer_count: 0, max_viewers: 50, version: 1,
    glossary_pack: "general_cre", admission_open_until: null, expires_at: expiresAt,
  };
  for (const row of [
    { ...baseRow, voice_provider: undefined },
    { ...baseRow, voice_provider: "unknown" },
    { ...baseRow, session_type: "meeting", voice_provider: "openai" },
    { ...baseRow, output_mode: "captions", voice_provider: "openai" },
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
    voice_provider: "openai",
    admission_open_until: null,
    expires_at: expiresAt,
  };
  const store = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json([{ ...row, version: requests.length }]);
    },
  );
  await store.create({
    id: row.id,
    hostId: row.host_id,
    sessionType: "presentation",
    outputMode: "captions_audio",
    status: "preparing",
    languages: ["ko"],
    viewerCount: 0,
    maxViewers: 24,
    version: 1,
    glossaryPack: "hotel",
    voiceProvider: "openai",
    admissionOpenUntil: null,
    expiresAt,
  });
  await store.updateOwned(row.id, row.host_id, 1, {
    sessionType: "meeting",
    outputMode: "audio",
    languages: ["ko"],
    maxViewers: 20,
    glossaryPack: "fnb",
    voiceProvider: "gemini",
  });
  assert.match(requests[0]?.url ?? "", /\/rpc\/create_live_session$/u);
  assert.deepEqual(requests[0]?.body, {
    p_session_id: row.id,
    p_host_id: row.host_id,
    p_session_type: "presentation",
    p_output_mode: "captions_audio",
    p_languages: ["ko"],
    p_max_viewers: 24,
    p_glossary_pack: "hotel",
    p_voice_provider: "openai",
    p_expires_at: expiresAt,
  });
  assert.match(requests[1]?.url ?? "", /\/rpc\/update_live_session$/u);
  assert.equal(requests[1]?.body.p_expected_version, 1);
  assert.equal(requests[1]?.body.p_output_mode, "audio");
  assert.equal(requests[1]?.body.p_max_viewers, 20);
  assert.equal(requests[1]?.body.p_glossary_pack, "fnb");
  assert.equal(requests[1]?.body.p_voice_provider, "gemini");
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
    id: expiredSessionId, hostId: "host-1", sessionType: "presentation", outputMode: "captions",
    voiceProvider: "gemini", maxViewers: 50, glossaryPack: "general_cre",
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
  await assert.rejects(() => service.snapshot(created.id, "ko"), (error: unknown) => {
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

  assert.ok(getHandler.indexOf("requireHost(request)") < getHandler.indexOf("getLiveSessionStore().get(id)"));
  assert.ok(getHandler.indexOf("parseSessionId(params.id)") < getHandler.indexOf("getLiveSessionStore().get(id)"));
  assert.match(getHandler, /!session \|\| session\.hostId !== hostId/u);
  assert.match(getHandler, /"SESSION_NOT_FOUND", 404/u);
  assert.match(getHandler, /return apiSuccess\(session\)/u);
  assert.match(getHandler, /error instanceof AuthenticationError/u);
  assert.match(getHandler, /const failure = toLiveFailure\(error\)/u);
});
