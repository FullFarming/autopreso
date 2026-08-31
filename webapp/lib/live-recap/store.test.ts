import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseLiveRecapStore } from "./store";
import { LiveRecapService } from "./service";
import { RECAP_NOTICE_VERSION, type HostRecapRequest, type RecordExportSnapshot } from "./contract";

const sessionId = "11111111-1111-4111-8111-111111111111";
const participantId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const hostRequest: HostRecapRequest = {
  id: requestId, sessionId, participantId, requestedAt: "2026-08-31T00:00:00Z", noticeVersion: RECAP_NOTICE_VERSION,
  status: "requested", email: "viewer@example.test", revision: 1, displayName: "참가자", company: null,
  department: "", jobTitle: "", consentAcceptedAt: "2026-08-31T00:00:00Z", cancelledAt: null,
};
const access = () => ({ url: "https://approved-dev.supabase.co", credential: { key: "test-credential-not-real", kind: "secret" as const } });

test("request is one atomic purpose-specific RPC and self response strips host-only metadata", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const store = new SupabaseLiveRecapStore({ getServerAccess: access, fetchFn: async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json(hostRequest);
  } });
  const result = await store.request(sessionId, "server-user", { accepted: true, noticeVersion: RECAP_NOTICE_VERSION, idempotencyKey: requestId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://approved-dev.supabase.co/rest/v1/rpc/request_live_recap_v1");
  assert.deepEqual(calls[0].body, { p_session_id: sessionId, p_user_id: "server-user", p_notice_version: RECAP_NOTICE_VERSION, p_idempotency_key: requestId });
  assert.equal(Object.hasOwn(result, "participantId"), false);
  assert.equal(Object.hasOwn(result, "company"), false);
  assert.equal(result.requestedAt, hostRequest.requestedAt);
});

test("missing request remains null and does not generate a request or consent", async () => {
  const urls: string[] = [];
  const store = new SupabaseLiveRecapStore({ getServerAccess: access, fetchFn: async (url) => {
    urls.push(String(url)); return Response.json(null);
  } });
  assert.equal(await store.readRequest(sessionId, "user"), null);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /read_live_recap_request_v1$/u);
});

test("stored access expiry and host ownership denial remain explicit, provider error details are never leaked", async () => {
  for (const [message, status] of [["RECAP_EXPIRED", 410], ["LIVE_RECORD_NOT_FOUND", 404], ["EXPORT_TOO_LARGE", 413], ["LIVE_TRANSCRIPT_NOT_READY", 409]] as const) {
    const store = new SupabaseLiveRecapStore({ getServerAccess: access, fetchFn: async () => Response.json({ message }, { status: 400 }) });
    await assert.rejects(() => store.readExportSnapshot(sessionId, "host"), { code: message, status });
  }
  const store = new SupabaseLiveRecapStore({ getServerAccess: access, fetchFn: async () => Response.json({ message: "database contains secret@example.test" }, { status: 500 }) });
  await assert.rejects(() => store.readRecipients(sessionId, "host"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /secret@example/u);
    return true;
  });
});

test("recipient response rejects diagnostics and mismatched session rows", async () => {
  const injectedStore = new SupabaseLiveRecapStore({ getServerAccess: access, fetchFn: async () => Response.json({ requests: [{ ...hostRequest, providerSecret: "no" }] }) });
  await assert.rejects(() => injectedStore.readRecipients(sessionId, "host"), { code: "RECAP_STORE_UNAVAILABLE" });
  const wrongSessionStore = new SupabaseLiveRecapStore({ getServerAccess: access, fetchFn: async () => Response.json({ requests: [{ ...hostRequest, sessionId: participantId }] }) });
  await assert.rejects(() => new LiveRecapService(wrongSessionStore).readRecipients(sessionId, "host"), { code: "RECAP_INVALID_RESPONSE" });
});

test("export reads one complete database snapshot instead of mixing HTTP pages", async () => {
  const snapshot: RecordExportSnapshot = {
    snapshotId: requestId, generatedAt: "2026-08-31T01:00:00Z",
    session: { id: sessionId, title: "회의", status: "stopped", scheduledAt: null, endedAt: "2026-08-31T00:00:00Z", languages: ["ko"] },
    participants: [], utterances: [], recordingGaps: [], summaries: [], requests: [],
  };
  const calls: unknown[] = [];
  const store = new SupabaseLiveRecapStore({ getServerAccess: access, fetchFn: async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json(snapshot);
  } });
  assert.deepEqual(await new LiveRecapService(store).readExportSnapshot(sessionId, "authenticated-host"), snapshot);
  assert.deepEqual(calls, [{ url: "https://approved-dev.supabase.co/rest/v1/rpc/read_owned_live_record_export_v1", body: { p_session_id: sessionId, p_host_id: "authenticated-host" } }]);
});

test("oversized RPC response fails before reading an unbounded body", async () => {
  const store = new SupabaseLiveRecapStore({ getServerAccess: access, fetchFn: async () => new Response("{}", { headers: { "content-length": String(17 * 1024 * 1024) } }) });
  await assert.rejects(() => store.readExportSnapshot(sessionId, "host"), { code: "EXPORT_TOO_LARGE", status: 413 });
});

test("export rejects duplicate joins, out-of-order originals, and requests belonging to missing participants", async () => {
  const utterance = { id: participantId, seq: 1, speaker: "화자", language: "ko", startedAt: null,
    endedAt: "2026-08-31T00:00:00Z", text: "보존해야 할 원문", topicTitle: null };
  const base: RecordExportSnapshot = {
    snapshotId: requestId, generatedAt: "2026-08-31T01:00:00Z",
    session: { id: sessionId, title: "회의", status: "stopped", scheduledAt: null, endedAt: "2026-08-31T00:00:00Z", languages: ["ko"] },
    participants: [], utterances: [], recordingGaps: [], summaries: [], requests: [],
  };
  for (const snapshot of [
    { ...base, utterances: [utterance, utterance] },
    { ...base, utterances: [{ ...utterance, seq: 2 }, { ...utterance, id: requestId, seq: 1 }] },
    { ...base, requests: [hostRequest] },
    { ...base, session: { ...base.session, id: participantId } },
  ]) {
    const store = new SupabaseLiveRecapStore({ getServerAccess: access, fetchFn: async () => Response.json(snapshot) });
    await assert.rejects(() => new LiveRecapService(store).readExportSnapshot(sessionId, "host"), { code: "RECAP_INVALID_RESPONSE" });
  }
});

test("recording gap RPCs carry authenticated identity and preserve unknown end times while rejecting malformed intervals", async () => {
  const gap = { id: requestId, startedAt: "2026-08-31T00:00:00Z", endedAt: null, reason: "no_viewers" };
  const calls: Array<{ url: string; body: unknown }> = [];
  const store = new SupabaseLiveRecapStore({ getServerAccess: access, fetchFn: async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ recordingGaps: [gap] });
  } });
  assert.deepEqual(await store.readHostRecordingGaps(sessionId, "host"), { recordingGaps: [gap] });
  assert.deepEqual(await store.readParticipantRecordingGaps(sessionId, "participant"), { recordingGaps: [gap] });
  assert.deepEqual(calls, [
    { url: "https://approved-dev.supabase.co/rest/v1/rpc/read_owned_live_recording_gaps_v1", body: { p_session_id: sessionId, p_host_id: "host" } },
    { url: "https://approved-dev.supabase.co/rest/v1/rpc/read_participant_live_recording_gaps_v1", body: { p_session_id: sessionId, p_user_id: "participant" } },
  ]);
  for (const invalid of [{ ...gap, endedAt: "2026-08-30T00:00:00Z" }, { ...gap, reason: "unknown" }, { ...gap, transcript: "invented text" }]) {
    const invalidStore = new SupabaseLiveRecapStore({ getServerAccess: access, fetchFn: async () => Response.json({ recordingGaps: [invalid] }) });
    await assert.rejects(() => invalidStore.readParticipantRecordingGaps(sessionId, "participant"), { code: "RECAP_STORE_UNAVAILABLE" });
  }
  const expiredStore = new SupabaseLiveRecapStore({ getServerAccess: access, fetchFn: async () => Response.json({ message: "RECAP_EXPIRED" }, { status: 400 }) });
  await assert.rejects(() => expiredStore.readParticipantRecordingGaps(sessionId, "participant"), { code: "RECAP_EXPIRED", status: 410 });
});
