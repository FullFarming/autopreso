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

test("QR invite remains valid until its session expiry without a six-digit admission window", () => {
  const session = {
    id: "session-1",
    title: "Investor Call",
    scheduledAt: null,
    status: "preparing" as const,
    sessionType: "meeting" as const,
    outputMode: "captions" as const,
    voiceProvider: "gemini" as const,
    glossaryPack: "general_cre" as const,
    languages: ["ko"],
    maxViewers: 50,
    version: 1,
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    admissionOpenUntil: new Date(now + 299_900).toISOString(),
    admissionGeneration: 1,
    admissionState: "open" as const,
  };
  assert.equal(resolveLiveInviteExpiry(session, now), session.expiresAt);
  assert.equal(resolveLiveInviteExpiry({ ...session, admissionOpenUntil: null }, now), session.expiresAt);
  assert.throws(
    () => resolveLiveInviteExpiry({ ...session, expiresAt: new Date(now).toISOString() }, now),
    (error: unknown) => error instanceof LiveAdmissionError && error.code === "ADMISSION_CLOSED",
  );
});

test("scheduled QR invite follows the scheduled session lifetime", () => {
  const session = {
    id: "session-1",
    title: "Scheduled Call",
    scheduledAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    status: "preparing" as const,
    sessionType: "meeting" as const,
    outputMode: "captions" as const,
    voiceProvider: "gemini" as const,
    glossaryPack: "general_cre" as const,
    languages: ["ko"],
    maxViewers: 50,
    version: 1,
    expiresAt: new Date(now + 8 * 60 * 60_000).toISOString(),
    admissionOpenUntil: new Date(now + 8 * 60 * 60_000).toISOString(),
    admissionGeneration: 1,
    admissionState: "open" as const,
  };
  assert.equal(resolveLiveInviteExpiry(session, now), session.expiresAt);
});

test("host session parsing exposes the stable admission generation and state", async () => {
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
          admission_generation: 1,
          admission_state: "open",
        }]);
      }
      return Response.json(true);
    },
  });
  const session = await store.assertHostSession("session-1", "host-1");
  assert.equal(session.admissionOpenUntil, admissionOpenUntil);
  assert.equal(session.admissionGeneration, 1);
  assert.equal(session.admissionState, "open");
  assert.equal(session.voiceProvider, "gemini");
  assert.match(String(new URL(calls[0].path, "https://example.test").searchParams.get("select")), /voice_provider/u);
  await store.createInvite({
    sessionId: "session-1",
    hostId: "host-1",
    tokenHmac: "a".repeat(64),
    expiresAt: admissionOpenUntil,
  });
  assert.equal(calls[1].body?.p_admission_open_until, undefined);
  assert.equal(calls[1].body?.p_expires_at, admissionOpenUntil);
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
      admission_generation: 0, admission_state: "uninitialized",
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

test("viewer leave binds session, grant, and anonymous user in one guarded RPC", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json(true);
    },
  });
  assert.equal(await store.leaveViewer("session-1", "grant-1", "user-1"), true);
  assert.deepEqual(calls, [{
    path: "/rest/v1/rpc/leave_live_session",
    body: {
      p_session_id: "session-1",
      p_grant_id: "grant-1",
      p_user_id: "user-1",
    },
  }]);
});

test("host and participant record authorization bind both identity and requested session", async () => {
  const requestedUrls: string[] = [];
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async (url) => {
      const value = String(url);
      requestedUrls.push(value);
      const parsed = new URL(value);
      if (parsed.pathname.endsWith("/live_sessions")) {
        return Response.json(parsed.searchParams.get("id") === "eq.session-1"
          ? [{
              id: "session-1",
              host_id: "host-1",
              title: "Investor Call",
              scheduled_at: null,
              status: "stopped",
              ended_at: new Date(now).toISOString(),
            }]
          : []);
      }
      if (parsed.pathname.endsWith("/live_recap_grants")) {
        const isExact = parsed.searchParams.get("session_id") === "eq.session-1"
          && parsed.searchParams.get("user_id") === "eq.user-1";
        return Response.json(isExact ? [{ session_id: "session-1" }] : []);
      }
      return Response.json([]);
    },
  });
  await store.assertHostSessionOwnership("session-1", "host-1");
  await assert.rejects(
    store.assertHostSessionOwnership("session-1", "other-host"),
    (error: unknown) => error instanceof LiveAdmissionError && error.code === "LIVE_SESSION_NOT_FOUND",
  );
  assert.equal(await store.assertParticipantAccess({
    sessionId: "session-1",
    userId: "user-1",
    recapOnly: true,
  }), "recap");
  await assert.rejects(
    store.assertParticipantAccess({ sessionId: "session-2", userId: "user-1", recapOnly: true }),
    (error: unknown) => error instanceof LiveAdmissionError && error.code === "RECAP_FORBIDDEN",
  );
  assert.equal(requestedUrls.some((url) => url.includes("session_id=eq.session-2")), true);
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

test("host session parsing fails closed on missing or unknown voice provider contracts", async () => {
  for (const override of [
    {},
    { voice_provider: "unknown" },
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
        admission_generation: 0, admission_state: "uninitialized",
        ...override,
      }]),
    });
    await assert.rejects(
      store.assertHostSession("session-1", "host-1"),
      (error: unknown) => error instanceof LiveAdmissionError && error.code === "INVALID_STORE_RESPONSE",
    );
  }
});

test("admission redemption normalizes a legacy OpenAI row to Gemini and rejects malformed boundaries", async () => {
  const baseRow = {
    grant_id: "grant-1", session_id: "session-1", user_id: "user-1", display_name: "Viewer",
    department: "Strategy", job_title: "Director", participant_id: "participant-1",
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
    displayName: "Viewer", department: "Strategy", jobTitle: "Director",
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  assert.equal((await store.redeemAdmission(input)).session.voiceProvider, "gemini");
  assert.equal((await store.redeemAdmission(input)).grant.participantId, "participant-1");

  for (const malformed of [
    { ...baseRow, voice_provider: undefined },
    { ...baseRow, voice_provider: "unknown" },
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

test("participant identity redemption uses v3 RPCs and parses stable participant ids", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const responseRow = {
    grant_id: "grant-1", participant_id: "participant-1", session_id: "session-1",
    user_id: "user-1", display_name: "Viewer", department: "Strategy", job_title: "Director",
    grant_expires_at: new Date(now + 60_000).toISOString(),
    session_expires_at: new Date(now + 60_000).toISOString(),
    session_type: "meeting", output_mode: "captions", voice_provider: "gemini",
    glossary_pack: "general_cre", languages: ["ko"], viewer_count: 1, max_viewers: 50,
  };
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json(responseRow);
    },
  });
  const identity = {
    userId: "user-1",
    deviceHash: "b".repeat(64),
    displayName: "Viewer",
    department: "Strategy",
    jobTitle: "Director",
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  const admission = await store.redeemAdmission({ ...identity, codeHmac: "a".repeat(64) });
  const invite = await store.redeemInvite({ ...identity, tokenHmac: "c".repeat(64) });
  assert.equal(admission.grant.participantId, "participant-1");
  assert.equal(invite.grant.department, "Strategy");
  assert.deepEqual(calls.map((call) => call.path), [
    "/rest/v1/rpc/redeem_live_admission_v3",
    "/rest/v1/rpc/redeem_live_invite_v3",
  ]);
  assert.equal(calls[0].body.p_department, "Strategy");
  assert.equal(calls[1].body.p_job_title, "Director");
});

test("QR and code redemption store omitted participant profile fields as null", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const responseRow = {
    grant_id: "grant-1", participant_id: "participant-1", session_id: "session-1",
    user_id: "user-1", display_name: "Viewer", department: null, job_title: null,
    grant_expires_at: new Date(now + 60_000).toISOString(),
    session_expires_at: new Date(now + 60_000).toISOString(),
    session_type: "meeting", output_mode: "captions", voice_provider: "gemini",
    glossary_pack: "general_cre", languages: ["ko"], viewer_count: 1, max_viewers: 50,
  };
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json(responseRow);
    },
  });
  const identity = {
    userId: "user-1",
    deviceHash: "b".repeat(64),
    displayName: "Viewer",
    department: "",
    jobTitle: "",
    expiresAt: new Date(now + 60_000).toISOString(),
  };

  const admission = await store.redeemAdmission({ ...identity, codeHmac: "a".repeat(64) });
  const invite = await store.redeemInvite({ ...identity, tokenHmac: "c".repeat(64) });

  assert.equal(admission.grant.department, "");
  assert.equal(admission.grant.jobTitle, "");
  assert.equal(invite.grant.department, "");
  assert.equal(invite.grant.jobTitle, "");
  assert.deepEqual(calls.map((call) => [call.path, call.body.p_department, call.body.p_job_title]), [
    ["/rest/v1/rpc/redeem_live_admission_v3", null, null],
    ["/rest/v1/rpc/redeem_live_invite_v3", null, null],
  ]);
});

test("invalid optional participant identity maps to a bounded 400 response", async () => {
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async () => Response.json(
      { code: "P0001", message: "INVALID_PARTICIPANT_IDENTITY" },
      { status: 400 },
    ),
  });
  await assert.rejects(
    store.redeemAdmission({
      codeHmac: "a".repeat(64),
      userId: "user-1",
      deviceHash: "b".repeat(64),
      displayName: "Viewer",
      department: "Strategy",
      jobTitle: "D".repeat(101),
      expiresAt: new Date(now + 60_000).toISOString(),
    }),
    (error: unknown) => error instanceof LiveAdmissionError
      && error.code === "INVALID_JOIN_REQUEST"
      && error.status === 400,
  );
});

test("host roster RPC validates retained participant activity", async () => {
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        p_session_id: "session-1",
        p_host_id: "host-1",
      });
      return Response.json([{
        participant_id: "participant-1",
        grant_id: "grant-1",
        user_id: "user-1",
        display_name: "Viewer",
        department: "Strategy",
        job_title: "Director",
        joined_at: new Date(now).toISOString(),
        last_seen_at: new Date(now + 1_000).toISOString(),
        left_at: null,
        last_spoke_at: new Date(now + 500).toISOString(),
        utterance_count: 2,
        speaking_seconds: "12.500",
        retention_expires_at: null,
      }]);
    },
  });
  const roster = await store.readParticipantRoster("session-1", "host-1");
  assert.equal(roster[0].participantId, "participant-1");
  assert.equal(roster[0].speakingSeconds, 12.5);
});

test("host roster maps nullable participant profile fields to response-safe empty strings", async () => {
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async () => Response.json([{
      participant_id: "participant-1",
      grant_id: "grant-1",
      user_id: "user-1",
      display_name: "Viewer",
      department: null,
      job_title: null,
      joined_at: new Date(now).toISOString(),
      last_seen_at: new Date(now + 1_000).toISOString(),
      left_at: null,
      last_spoke_at: null,
      utterance_count: 0,
      speaking_seconds: "0",
      retention_expires_at: null,
    }]),
  });
  const roster = await store.readParticipantRoster("session-1", "host-1");
  assert.equal(roster[0].department, "");
  assert.equal(roster[0].jobTitle, "");
});
