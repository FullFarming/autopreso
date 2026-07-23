import assert from "node:assert/strict";
import test from "node:test";

import {
  LiveAdmissionError,
  resolveLiveAdmissionExpiry,
  resolveLiveInviteExpiry,
  SupabaseLiveAdmissionStore,
} from "./live-admission-store";

const now = Date.UTC(2026, 6, 20);

test("admission expiry is bounded by the remaining session lifetime", () => {
  assert.equal(
    resolveLiveAdmissionExpiry({ expiresAt: new Date(now + 10 * 60_000).toISOString() }, now),
    new Date(now + 10 * 60_000).toISOString(),
  );
  assert.equal(
    resolveLiveAdmissionExpiry({ expiresAt: new Date(now + 8 * 60 * 60_000).toISOString() }, now),
    new Date(now + 6 * 60 * 60_000).toISOString(),
  );
  assert.throws(
    () => resolveLiveAdmissionExpiry({ expiresAt: new Date(now).toISOString() }, now),
    (error: unknown) => error instanceof LiveAdmissionError && error.code === "LIVE_SESSION_EXPIRED",
  );
});

test("invite expiry uses the exact admission generation and never exceeds the session", () => {
  const session = {
    id: "session-1",
    sessionType: "meeting" as const,
    outputMode: "captions" as const,
    voiceProvider: "gemini" as const,
    glossaryPack: "general_cre" as const,
    languages: ["ko"],
    maxViewers: 50,
    version: 1,
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    admissionOpenUntil: new Date(now + 299_900).toISOString(),
  };
  assert.equal(resolveLiveInviteExpiry(session, now), session.admissionOpenUntil);
  assert.throws(
    () => resolveLiveInviteExpiry({ ...session, admissionOpenUntil: null }, now),
    (error: unknown) => error instanceof LiveAdmissionError && error.code === "ADMISSION_CLOSED",
  );
  assert.throws(
    () => resolveLiveInviteExpiry({ ...session, admissionOpenUntil: new Date(now).toISOString() }, now),
    (error: unknown) => error instanceof LiveAdmissionError && error.code === "ADMISSION_CLOSED",
  );
});

test("invite expiry is capped at six hours even when the session remains open longer", () => {
  const session = {
    id: "session-1",
    sessionType: "meeting" as const,
    outputMode: "captions" as const,
    voiceProvider: "gemini" as const,
    glossaryPack: "general_cre" as const,
    languages: ["ko"],
    maxViewers: 50,
    version: 1,
    expiresAt: new Date(now + 8 * 60 * 60_000).toISOString(),
    admissionOpenUntil: new Date(now + 8 * 60 * 60_000).toISOString(),
  };
  assert.equal(resolveLiveInviteExpiry(session, now), new Date(now + 6 * 60 * 60_000).toISOString());
});

test("host session parsing and create RPC preserve the exact admission generation", async () => {
  const admissionOpenUntil = new Date(now + 5 * 60_000).toISOString();
  const calls: Array<{ path: string; body: Record<string, unknown> | null }> = [];
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async (url, init) => {
      const requestUrl = new URL(String(url));
      const path = `${requestUrl.pathname}${requestUrl.search}`;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (init?.method === "GET") {
        return Response.json([{
          id: "session-1", session_type: "meeting", output_mode: "captions",
          voice_provider: "gemini",
          glossary_pack: "general_cre", languages: ["ko"], max_viewers: 50, version: 3,
          expires_at: new Date(now + 60 * 60_000).toISOString(),
          admission_open_until: admissionOpenUntil,
        }]);
      }
      return Response.json(true);
    },
  });
  const session = await store.assertHostSession("session-1", "host-1");
  assert.equal(session.admissionOpenUntil, admissionOpenUntil);
  assert.equal(session.voiceProvider, "gemini");
  assert.match(String(new URL(calls[0].path, "https://example.test").searchParams.get("select")), /voice_provider/u);
  await store.createInvite({
    sessionId: "session-1",
    hostId: "host-1",
    tokenHmac: "a".repeat(64),
    expiresAt: admissionOpenUntil,
    admissionOpenUntil,
  });
  assert.equal(calls[1].body?.p_admission_open_until, admissionOpenUntil);
});

test("stored session parsing accepts only exact canonical language codes", async () => {
  let languages: string[] = ["zh-Hant", "it"];
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async () => Response.json([{
      id: "session-1", session_type: "presentation", output_mode: "captions",
      voice_provider: "gemini", glossary_pack: "general_cre", languages,
      max_viewers: 50, version: 1,
      expires_at: new Date(now + 60 * 60_000).toISOString(), admission_open_until: null,
    }]),
  });
  assert.deepEqual((await store.assertHostSession("session-1", "host-1")).languages, ["zh-Hant", "it"]);
  for (const invalid of [["zh"], ["en-US"], ["th"], ["en", "en"]]) {
    languages = invalid;
    await assert.rejects(
      store.assertHostSession("session-1", "host-1"),
      (error: unknown) => error instanceof LiveAdmissionError && error.code === "INVALID_STORE_RESPONSE",
    );
  }
});

test("snapshot reauthorization binds grant, live session, user, and canonical topic in one RPC", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let response: unknown = true;
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async (url, init) => {
      calls.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
      return Response.json(response);
    },
  });
  await store.assertViewerTopicActive("0192d0f4-9f72-7a36-91f5-6a76ef736f41", "0192d0f4-9f72-7a36-91f5-6a76ef736f42", "viewer-1", "zh-Hant");
  assert.deepEqual(calls, [{
    path: "/rest/v1/rpc/authorize_live_viewer_topic",
    body: {
      p_session_id: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      p_grant_id: "0192d0f4-9f72-7a36-91f5-6a76ef736f42",
      p_user_id: "viewer-1",
      p_language: "zh-Hant",
    },
  }]);
  for (const denied of [false, null, [{ allowed: true }]]) {
    response = denied;
    await assert.rejects(
      store.assertViewerTopicActive("0192d0f4-9f72-7a36-91f5-6a76ef736f41", "0192d0f4-9f72-7a36-91f5-6a76ef736f42", "viewer-1", "ko"),
      (error: unknown) => error instanceof LiveAdmissionError && error.code === "VIEWER_GRANT_REVOKED",
    );
  }
});

test("admission mutations require and advance the optimistic session version", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(calls.length + 3);
    },
  });
  assert.equal(await store.openAdmission({
    sessionId: "session-1",
    hostId: "host-1",
    codeHmac: "a".repeat(64),
    openUntil: new Date(now + 60_000).toISOString(),
    expectedVersion: 3,
  }), 4);
  assert.equal(await store.closeAdmission("session-1", "host-1", 4), 5);
  assert.equal(calls[0].p_expected_version, 3);
  assert.equal(calls[1].p_expected_version, 4);
});

test("host session parsing rejects a malformed admission timestamp", async () => {
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async () => Response.json([{
      id: "session-1", session_type: "meeting", output_mode: "captions",
      voice_provider: "gemini",
      glossary_pack: "general_cre", languages: ["ko"], max_viewers: 50, version: 1,
      expires_at: new Date(now + 60_000).toISOString(),
      admission_open_until: 123,
    }]),
  });
  await assert.rejects(
    store.assertHostSession("session-1", "host-1"),
    (error: unknown) => error instanceof LiveAdmissionError && error.code === "INVALID_STORE_RESPONSE",
  );
});

test("host session parsing fails closed on missing or impossible voice provider contracts", async () => {
  for (const override of [
    {},
    { voice_provider: "unknown" },
    { voice_provider: "openai", session_type: "meeting" },
    { voice_provider: "openai", session_type: "presentation", output_mode: "captions" },
  ]) {
    const store = new SupabaseLiveAdmissionStore({
      getServerAccess: () => ({
        url: "https://approved-dev-ref.supabase.co",
        credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
      }),
      fetchFn: async () => Response.json([{
        id: "session-1", session_type: "presentation", output_mode: "captions_audio",
        glossary_pack: "general_cre", languages: ["ko"], max_viewers: 50, version: 1,
        expires_at: new Date(now + 60_000).toISOString(), admission_open_until: null,
        ...override,
      }]),
    });
    await assert.rejects(
      store.assertHostSession("session-1", "host-1"),
      (error: unknown) => error instanceof LiveAdmissionError && error.code === "INVALID_STORE_RESPONSE",
    );
  }
});

test("admission redemption includes voice provider and rejects malformed language cost boundaries", async () => {
  const baseRow = {
    grant_id: "grant-1", session_id: "session-1", user_id: "user-1", display_name: "Viewer",
    grant_expires_at: new Date(now + 60_000).toISOString(),
    session_expires_at: new Date(now + 60_000).toISOString(),
    session_type: "presentation", output_mode: "captions_audio", glossary_pack: "general_cre",
    voice_provider: "openai", languages: ["ko"], viewer_count: 1, max_viewers: 50,
  };
  let responseBody: unknown = baseRow;
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async () => Response.json(responseBody),
  });
  const input = {
    codeHmac: "a".repeat(64), userId: "user-1", deviceHash: "b".repeat(64),
    displayName: "Viewer", expiresAt: new Date(now + 60_000).toISOString(),
  };
  assert.equal((await store.redeemAdmission(input)).session.voiceProvider, "openai");

  for (const malformed of [
    { ...baseRow, voice_provider: undefined },
    { ...baseRow, voice_provider: "openai", session_type: "meeting" },
    { ...baseRow, voice_provider: "openai", output_mode: "captions" },
    { ...baseRow, languages: [] },
    { ...baseRow, languages: ["ko", "ko"] },
    { ...baseRow, languages: ["ko", "en", "ja", "fr"] },
  ]) {
    responseBody = malformed;
    await assert.rejects(
      store.redeemAdmission(input),
      (error: unknown) => error instanceof LiveAdmissionError && error.code === "INVALID_STORE_RESPONSE",
    );
  }
});

test("closed or expired invite RPC errors map to the public admission-closed response", async () => {
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async () => Response.json(
      { code: "P0001", message: "INVITE_CLOSED" },
      { status: 400 },
    ),
  });
  await assert.rejects(
    store.resolveInviteRateKey("a".repeat(64)),
    (error: unknown) => error instanceof LiveAdmissionError
      && error.code === "ADMISSION_CLOSED"
      && error.status === 410,
  );
});
