import assert from "node:assert/strict";
import test from "node:test";

import {
  LiveAdmissionError,
  requireOpenLiveAdmissionExpiry,
  resolveLiveAdmissionExpiry,
  resolveLiveInviteExpiry,
  SupabaseLiveAdmissionStore,
} from "./live-admission-store";

const now = Date.UTC(2026, 6, 20);
const restoreSessionId = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";
const restoreGrantId = "0192d0f4-9f72-7a36-91f5-6a76ef736f42";

test("stage admission reads reject closed or expired admission", () => {
  const future = new Date(now + 60_000).toISOString();
  assert.equal(requireOpenLiveAdmissionExpiry({ admissionState: "open", admissionOpenUntil: future }, now), future);
  for (const admissionState of ["uninitialized", "paused", "ended"] as const) {
    assert.throws(() => requireOpenLiveAdmissionExpiry({ admissionState, admissionOpenUntil: future }, now),
      (error: unknown) => error instanceof LiveAdmissionError && error.code === "ADMISSION_CLOSED");
  }
  for (const admissionOpenUntil of [null, "invalid", new Date(now).toISOString()]) {
    assert.throws(() => requireOpenLiveAdmissionExpiry({ admissionState: "open", admissionOpenUntil }, now), LiveAdmissionError);
  }
});

test("a concurrent admission close rejects stale invitation updates without retrying", async () => {
  let attempts = 0;
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({ url: "https://approved-dev-ref.supabase.co", credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" } }),
    fetchFn: async (_url, init) => {
      attempts += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.p_expected_version, 3);
      return Response.json({ message: "VERSION_CONFLICT_OR_FORBIDDEN" }, { status: 400 });
    },
  });
  await assert.rejects(store.openAdmission({ sessionId: "session-1", hostId: "host-1", codeHmac: "a".repeat(64),
    openUntil: new Date(now + 60_000).toISOString(), expectedVersion: 3 }), LiveAdmissionError);
  assert.equal(attempts, 1);
});

function attendeeConsentInput(overrides: Partial<{
  summaryConsent: boolean;
  marketingConsent: boolean;
}> = {}) {
  return {
    privacyConsent: true as const,
    summaryConsent: false,
    marketingConsent: false,
    consentNoticeVersions: {
      privacy: "privacy-v1",
      summaryDelivery: "summary-v1",
      marketing: "marketing-v1",
    },
    ...overrides,
  };
}

function restoredAttendeeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    grant_id: restoreGrantId,
    participant_id: "participant-1",
    session_id: restoreSessionId,
    user_id: "user-1",
    display_name: "Noel Kim",
    email: "viewer@example.com",
    company: "Cushman",
    department: "Strategy",
    job_title: "Director",
    summary_consent_at: new Date(now).toISOString(),
    grant_expires_at: new Date(now + 60_000).toISOString(),
    session_expires_at: new Date(now + 60_000).toISOString(),
    session_type: "meeting",
    output_mode: "captions",
    voice_provider: "gemini",
    glossary_pack: "general_cre",
    languages: ["ko"],
    viewer_count: 1,
    max_viewers: 50,
    ...overrides,
  };
}

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
    participantSpeakingEnabled: false,
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
    participantSpeakingEnabled: false,
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
  assert.equal(session.participantSpeakingEnabled, false);
  assert.match(String(new URL(calls[0].path, "https://example.test").searchParams.get("select")), /voice_provider/u);
  assert.match(String(new URL(calls[0].path, "https://example.test").searchParams.get("select")), /participant_speaking_enabled/u);
  await store.createInvite({
    sessionId: "session-1",
    hostId: "host-1",
    tokenHmac: "a".repeat(64),
    expiresAt: admissionOpenUntil,
  });
  assert.equal(calls[1].body?.p_admission_open_until, undefined);
  assert.equal(calls[1].body?.p_expires_at, admissionOpenUntil);
});

test("participant speaking capability is projected only from an exact stored boolean and otherwise fails closed", async () => {
  let participantSpeakingEnabled: unknown = true;
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async () => Response.json([restoredAttendeeRow({
      participant_speaking_enabled: participantSpeakingEnabled,
    })]),
  });

  assert.equal((await store.restoreAttendee({
    grantId: restoreGrantId,
    sessionId: restoreSessionId,
    userId: "user-1",
  })).session.participantSpeakingEnabled, true);

  participantSpeakingEnabled = null;
  assert.equal((await store.restoreAttendee({
    grantId: restoreGrantId,
    sessionId: restoreSessionId,
    userId: "user-1",
  })).session.participantSpeakingEnabled, false);

  for (const hostile of ["true", 1, {}, []]) {
    participantSpeakingEnabled = hostile;
    await assert.rejects(
      store.restoreAttendee({ grantId: restoreGrantId, sessionId: restoreSessionId, userId: "user-1" }),
      (error: unknown) => error instanceof LiveAdmissionError && error.code === "INVALID_STORE_RESPONSE",
    );
  }
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
    fetchFn: async (url, init) => {
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
      if (parsed.pathname.endsWith("/read_participant_live_record_access_v1")) {
        const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const isExact = input.p_session_id === "session-1" && input.p_user_id === "user-1";
        const endedAt = Date.now() - 1_000;
        return Response.json(isExact ? [{
          ...restoredAttendeeRow(), session_id: "session-1", title: "Investor Call", scheduled_at: null,
          status: "stopped", ended_at: new Date(endedAt).toISOString(),
          records_expires_at: new Date(endedAt + 6 * 60 * 60 * 1_000).toISOString(),
        }] : []);
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
  assert.equal(requestedUrls.filter((url) => url.includes("read_participant_live_record_access_v1")).length, 2);
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
    grant_id: "grant-1", session_id: "session-1", user_id: "user-1", display_name: "Noel Kim",
    email: "viewer@example.com", company: null, summary_consent_at: null,
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
    email: "viewer@example.com", displayName: "Noel Kim", company: "", department: "Strategy", jobTitle: "Director",
    ...attendeeConsentInput(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  assert.equal((await store.redeemAttendee(input)).session.voiceProvider, "gemini");
  assert.equal((await store.redeemAttendee(input)).grant.participantId, "participant-1");
  responseBody = { ...baseRow, viewer_count: 200, max_viewers: 200 };
  assert.equal((await store.redeemAttendee(input)).session.maxViewers, 200);

  for (const malformed of [
    { ...baseRow, voice_provider: undefined },
    { ...baseRow, voice_provider: "unknown" },
    { ...baseRow, languages: [] },
    { ...baseRow, languages: ["ko", "ko"] },
    { ...baseRow, languages: ["ko", "en", "ja", "fr"] },
    { ...baseRow, max_viewers: 201 },
    { ...baseRow, viewer_count: 201, max_viewers: 200 },
  ]) {
    responseBody = malformed;
    await assert.rejects(
      store.redeemAttendee(input),
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

test("attendee redemption uses one atomic RPC and keeps full email outside the public grant", async () => {
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
      return Response.json({
        grant_id: "grant-1", participant_id: "participant-1", session_id: "session-1",
        user_id: "user-1", display_name: "Noel Kim", email: "viewer@example.com",
        company: "Cushman", department: "Strategy", job_title: "Director",
        summary_consent_at: new Date(now).toISOString(),
        grant_expires_at: new Date(now + 60_000).toISOString(),
        session_expires_at: new Date(now + 60_000).toISOString(),
        session_type: "meeting", output_mode: "captions", voice_provider: "gemini",
        glossary_pack: "general_cre", languages: ["ko"], viewer_count: 1, max_viewers: 50,
      });
    },
  });
  const redemption = await store.redeemAttendee({
    inviteTokenHmac: "a".repeat(64),
    userId: "user-1",
    deviceHash: "b".repeat(64),
    email: "viewer@example.com",
    displayName: "Noel Kim",
    company: "Cushman",
    department: "Strategy",
    jobTitle: "Director",
    ...attendeeConsentInput({ summaryConsent: true, marketingConsent: true }),
    expiresAt: new Date(now + 60_000).toISOString(),
  });

  assert.deepEqual(calls, [{
    path: "/rest/v1/rpc/redeem_live_attendee_v3",
    body: {
      p_invite_token_hmac: "a".repeat(64),
      p_code_hmac: null,
      p_user_id: "user-1",
      p_device_hash: "b".repeat(64),
      p_grant_expires_at: new Date(now + 60_000).toISOString(),
      p_email: "viewer@example.com",
      p_display_name: "Noel Kim",
      p_company: "Cushman",
      p_department: "Strategy",
      p_job_title: "Director",
      p_privacy_consent: true,
      p_summary_consent: true,
      p_marketing_consent: true,
      p_privacy_notice_version: "privacy-v1",
      p_summary_delivery_notice_version: "summary-v1",
      p_marketing_notice_version: "marketing-v1",
    },
  }]);
  assert.equal(redemption.grant.displayName, "Noel Kim");
  assert.equal("email" in redemption.grant, false);
  assert.deepEqual(redemption.self, {
    email: "viewer@example.com",
    displayName: "Noel Kim",
    company: "Cushman",
    department: "Strategy",
    jobTitle: "Director",
    summaryConsent: true,
  });
});

test("viewer restoration uses the read-only RPC and keeps canonical full email outside the public grant", async () => {
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
      return Response.json(restoredAttendeeRow());
    },
  });

  const restored = await store.restoreAttendee({
    grantId: restoreGrantId,
    sessionId: restoreSessionId,
    userId: "user-1",
  });

  assert.deepEqual(calls, [{
    path: "/rest/v1/rpc/restore_live_attendee_v2",
    body: {
      p_grant_id: restoreGrantId,
      p_session_id: restoreSessionId,
      p_user_id: "user-1",
    },
  }]);
  assert.equal(restored.self.email, "viewer@example.com");
  assert.equal(restored.grant.displayName, "Noel Kim");
  assert.equal(restored.self.displayName, "Noel Kim");
  assert.equal("email" in restored.grant, false);
});

test("viewer restoration rejects noncanonical email, unsafe display names, and revoked grants", async () => {
  let response: Response = Response.json(restoredAttendeeRow());
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async () => response,
  });
  const input = { grantId: restoreGrantId, sessionId: restoreSessionId, userId: "user-1" };

  for (const malformed of [
    restoredAttendeeRow({ email: " Viewer@Example.com " }),
    restoredAttendeeRow({ display_name: "" }),
    restoredAttendeeRow({ display_name: "D".repeat(41) }),
    restoredAttendeeRow({ display_name: "<b>Unsafe</b>" }),
    restoredAttendeeRow({ email: "not-an-email", display_name: "n***@an-email" }),
    restoredAttendeeRow({ session_id: "0192d0f4-9f72-7a36-91f5-6a76ef736f99" }),
    restoredAttendeeRow({ grant_id: "0192d0f4-9f72-7a36-91f5-6a76ef736f99" }),
    restoredAttendeeRow({ user_id: "user-2" }),
  ]) {
    response = Response.json(malformed);
    await assert.rejects(
      store.restoreAttendee(input),
      (error: unknown) => error instanceof LiveAdmissionError && error.code === "INVALID_STORE_RESPONSE",
    );
  }

  response = Response.json({ code: "P0001", message: "VIEWER_RESTORE_FORBIDDEN" }, { status: 400 });
  await assert.rejects(
    store.restoreAttendee(input),
    (error: unknown) => error instanceof LiveAdmissionError
      && error.code === "VIEWER_RESTORE_FORBIDDEN"
      && error.status === 401,
  );

  response = Response.json({ code: "PGRST500", message: "database unavailable" }, { status: 500 });
  await assert.rejects(
    store.restoreAttendee(input),
    (error: unknown) => error instanceof LiveAdmissionError
      && error.code === "LIVE_STORE_UNAVAILABLE"
      && error.status === 503,
  );

  const offlineStore = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async () => { throw new TypeError("network details must stay private"); },
  });
  await assert.rejects(
    offlineStore.restoreAttendee(input),
    (error: unknown) => error instanceof LiveAdmissionError
      && error.message === "라이브 인증 저장소에 연결할 수 없습니다."
      && error.code === "LIVE_STORE_UNAVAILABLE"
      && error.status === 503,
  );
});

test("duplicate attendee reconnect keeps one capacity count and monotonic consent from the atomic response", async () => {
  let requestCount = 0;
  const consentAt = new Date(now).toISOString();
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async (url) => {
      requestCount += 1;
      assert.equal(new URL(String(url)).pathname, "/rest/v1/rpc/redeem_live_attendee_v3");
      return Response.json({
        grant_id: "grant-1", participant_id: "participant-1", session_id: "session-1",
        user_id: "user-1", display_name: "Noel Kim", email: "viewer@example.com",
        company: null, department: null, job_title: null, summary_consent_at: consentAt,
        grant_expires_at: new Date(now + 60_000).toISOString(),
        session_expires_at: new Date(now + 60_000).toISOString(),
        session_type: "meeting", output_mode: "captions", voice_provider: "gemini",
        glossary_pack: "general_cre", languages: ["ko"], viewer_count: 1, max_viewers: 1,
      });
    },
  });
  const base = {
    codeHmac: "a".repeat(64),
    userId: "user-1",
    deviceHash: "b".repeat(64),
    email: "viewer@example.com",
    displayName: "Noel Kim",
    company: "",
    department: "",
    jobTitle: "",
    ...attendeeConsentInput(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  const first = await store.redeemAttendee({ ...base, ...attendeeConsentInput({ summaryConsent: true }) });
  const reconnect = await store.redeemAttendee({ ...base, ...attendeeConsentInput({ summaryConsent: false }) });

  assert.equal(requestCount, 2);
  assert.equal(first.grant.id, reconnect.grant.id);
  assert.equal(reconnect.viewerCount, 1);
  assert.equal(reconnect.self.summaryConsent, true);
});

test("QR and code attendee redemption share the atomic RPC and parse stable participant ids", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const responseRow = {
    grant_id: "grant-1", participant_id: "participant-1", session_id: "session-1",
    user_id: "user-1", display_name: "Noel Kim", email: "viewer@example.com",
    company: "Cushman", department: "Strategy", job_title: "Director", summary_consent_at: null,
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
    email: "viewer@example.com",
    displayName: "Noel Kim",
    company: "Cushman",
    department: "Strategy",
    jobTitle: "Director",
    ...attendeeConsentInput(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  const admission = await store.redeemAttendee({ ...identity, codeHmac: "a".repeat(64) });
  const invite = await store.redeemAttendee({ ...identity, inviteTokenHmac: "c".repeat(64) });
  assert.equal(admission.grant.participantId, "participant-1");
  assert.equal(invite.grant.department, "Strategy");
  assert.deepEqual(calls.map((call) => call.path), [
    "/rest/v1/rpc/redeem_live_attendee_v3",
    "/rest/v1/rpc/redeem_live_attendee_v3",
  ]);
  assert.equal(calls[0].body.p_department, "Strategy");
  assert.equal(calls[0].body.p_display_name, "Noel Kim");
  assert.equal(calls[1].body.p_job_title, "Director");
  assert.equal(calls[1].body.p_display_name, "Noel Kim");
  assert.deepEqual(calls.map((call) => [
    call.body.p_privacy_consent,
    call.body.p_summary_consent,
    call.body.p_marketing_consent,
    call.body.p_privacy_notice_version,
    call.body.p_summary_delivery_notice_version,
    call.body.p_marketing_notice_version,
  ]), [
    [true, false, false, "privacy-v1", "summary-v1", "marketing-v1"],
    [true, false, false, "privacy-v1", "summary-v1", "marketing-v1"],
  ]);
  assert.deepEqual(calls.map((call) => [call.body.p_invite_token_hmac, call.body.p_code_hmac]), [
    [null, "a".repeat(64)],
    ["c".repeat(64), null],
  ]);
});

test("QR and code redemption store omitted participant profile fields as null", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const responseRow = {
    grant_id: "grant-1", participant_id: "participant-1", session_id: "session-1",
    user_id: "user-1", display_name: "Noel Kim", email: "viewer@example.com",
    company: null, department: null, job_title: null, summary_consent_at: null,
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
    email: "viewer@example.com",
    displayName: "Noel Kim",
    company: "",
    department: "",
    jobTitle: "",
    ...attendeeConsentInput(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };

  const admission = await store.redeemAttendee({ ...identity, codeHmac: "a".repeat(64) });
  const invite = await store.redeemAttendee({ ...identity, inviteTokenHmac: "c".repeat(64) });

  assert.equal(admission.grant.department, "");
  assert.equal(admission.grant.jobTitle, "");
  assert.equal(invite.grant.department, "");
  assert.equal(invite.grant.jobTitle, "");
  assert.deepEqual(calls.map((call) => [call.path, call.body.p_display_name, call.body.p_department, call.body.p_job_title]), [
    ["/rest/v1/rpc/redeem_live_attendee_v3", "Noel Kim", null, null],
    ["/rest/v1/rpc/redeem_live_attendee_v3", "Noel Kim", null, null],
  ]);
});

test("invalid attendee profile and credential RPC failures map to a bounded 400 response", async () => {
  let providerMessage = "INVALID_ATTENDEE_PROFILE";
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({
      url: "https://approved-dev-ref.supabase.co",
      credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" },
    }),
    fetchFn: async () => Response.json(
      { code: "22023", message: providerMessage },
      { status: 400 },
    ),
  });
  for (providerMessage of ["INVALID_ATTENDEE_PROFILE", "INVALID_ATTENDEE_CREDENTIAL"]) {
    await assert.rejects(
      store.redeemAttendee({
        codeHmac: "a".repeat(64),
        userId: "user-1",
        deviceHash: "b".repeat(64),
        email: "viewer@example.com",
        displayName: "Noel Kim",
        company: "",
        department: "Strategy",
        jobTitle: "Director",
        ...attendeeConsentInput(),
        expiresAt: new Date(now + 60_000).toISOString(),
      }),
      (error: unknown) => error instanceof LiveAdmissionError
        && error.code === "INVALID_JOIN_REQUEST"
        && error.status === 400,
    );
  }
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
        display_name: "Noel Kim",
        email: "viewer@example.com",
        company: "Cushman",
        summary_consent_at: new Date(now).toISOString(),
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
  assert.equal(roster[0].email, "viewer@example.com");
  assert.equal(roster[0].company, "Cushman");
  assert.equal(roster[0].summaryConsentAt, new Date(now).toISOString());
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
      email: null,
      company: null,
      summary_consent_at: null,
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
  assert.equal(roster[0].email, null);
  assert.equal(roster[0].company, null);
  assert.equal(roster[0].summaryConsentAt, null);
});
