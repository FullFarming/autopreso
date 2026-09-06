import assert from "node:assert/strict";
import test from "node:test";

import { createRecapGrantToken, createViewerGrantToken, RECAP_GRANT_COOKIE, VIEWER_GRANT_COOKIE } from "../auth/live-auth";
import { isViewerSnapshotPath } from "./csrf";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "./live-admission-store";
import { authorizeParticipantRecordRequest } from "./live-viewer-authorization";

const sessionId = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";
const userId = "0192d0f4-9f72-7a36-91f5-6a76ef736f42";
const grantId = "0192d0f4-9f72-7a36-91f5-6a76ef736f43";
const sixHours = 6 * 60 * 60 * 1_000;

function recordRow(endedAt = Date.now() - 1_000): Record<string, unknown> {
  return {
    session_id: sessionId, user_id: userId, participant_id: "participant-1",
    title: "회의 기록", scheduled_at: null, status: "stopped", ended_at: new Date(endedAt).toISOString(),
    records_expires_at: new Date(endedAt + sixHours).toISOString(), session_type: "meeting",
    output_mode: "captions", voice_provider: "gemini", glossary_pack: "general_cre", languages: ["ko", "en"],
    max_viewers: 50, display_name: "김민수", email: "participant@example.com", company: "회사",
    department: "개발", job_title: "팀원", summary_consent_at: null,
  };
}

function createStore(options: { row?: Record<string, unknown>; rpcError?: string; unavailable?: boolean; sourceRows?: unknown[] } = {}) {
  const calls: string[] = [];
  const row = options.row ?? recordRow();
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({ url: "https://approved-dev-ref.supabase.co", credential: { key: `sb_secret_${"s".repeat(24)}`, kind: "secret" } }),
    fetchFn: async (url, init) => {
      const parsed = new URL(String(url));
      calls.push(parsed.pathname);
      if (options.unavailable) throw new Error("offline");
      if (parsed.pathname.endsWith("/live_sessions")) {
        return Response.json([{ id: sessionId, host_id: "host-1", title: row.title,
          scheduled_at: null, status: row.status, ended_at: row.ended_at }]);
      }
      if (parsed.pathname.endsWith("/read_participant_live_record_access_v1")) {
        assert.deepEqual(JSON.parse(String(init?.body)), { p_session_id: sessionId, p_user_id: userId });
        return options.rpcError ? Response.json({ message: options.rpcError }, { status: 400 }) : Response.json([row]);
      }
      if (parsed.pathname.endsWith("/viewer_grants")) return Response.json([{ id: grantId }]);
      if (parsed.pathname.endsWith("/read_participant_live_source_transcript_v1")) {
        const input = JSON.parse(String(init?.body));
        assert.equal(input.p_session_id, sessionId);
        assert.equal(input.p_user_id, userId);
        return Response.json(options.sourceRows ?? []);
      }
      return Response.json([]);
    },
  });
  return { store, calls };
}

function cookies(values: Record<string, string>) {
  return { cookies: { get: (name: string) => values[name] ? { name, value: values[name] } : undefined } };
}

test("terminal record access enforces endedAt plus six hours even with a valid live grant", async () => {
  const { store, calls } = createStore({ row: recordRow(Date.now() - sixHours), rpcError: "RECAP_EXPIRED" });
  await assert.rejects(store.assertParticipantAccess({ sessionId, userId, grantId }),
    (error: unknown) => error instanceof LiveAdmissionError && error.code === "RECAP_EXPIRED" && error.status === 410);
  assert.equal(calls.some((path) => path.endsWith("/viewer_grants")), false);
});

test("record recovery uses persistent membership without surviving live grants", async () => {
  const { store, calls } = createStore();
  const token = await createRecapGrantToken({ sessionId, userId });
  assert.deepEqual(await authorizeParticipantRecordRequest(cookies({ [RECAP_GRANT_COOKIE]: token.token }), sessionId, store),
    { userId, access: "recap" });
  assert.equal(calls.some((path) => /viewer_grants|restore_live_attendee|gateway|presence/u.test(path)), false);
});

test("a storage outage is not replaced with an authentication failure or another credential attempt", async () => {
  const { store, calls } = createStore({ unavailable: true });
  const token = await createViewerGrantToken({ sessionId, userId, grantId });
  await assert.rejects(authorizeParticipantRecordRequest(cookies({ [VIEWER_GRANT_COOKIE]: token.token }), sessionId, store),
    (error: unknown) => error instanceof LiveAdmissionError && error.status === 503);
  assert.equal(calls.length, 1);
});

test("expired live credential can recover with the admission-time read-only credential", async () => {
  const { store } = createStore();
  const live = await createViewerGrantToken({ sessionId, userId, grantId }, Date.now() - sixHours - 1_000);
  const recap = await createRecapGrantToken({ sessionId, userId });
  assert.equal((await authorizeParticipantRecordRequest(cookies({
    [VIEWER_GRANT_COOKIE]: live.token, [RECAP_GRANT_COOKIE]: recap.token,
  }), sessionId, store)).access, "recap");
});

test("a read-only credential cannot recover an active live session or cross a session boundary", async () => {
  const { store, calls } = createStore({ row: { ...recordRow(), status: "live", ended_at: null } });
  const token = await createRecapGrantToken({ sessionId, userId });
  await assert.rejects(authorizeParticipantRecordRequest(cookies({ [RECAP_GRANT_COOKIE]: token.token }), sessionId, store),
    (error: unknown) => error instanceof LiveAdmissionError && error.code === "RECAP_NOT_READY");
  const count = calls.length;
  await assert.rejects(authorizeParticipantRecordRequest(cookies({ [RECAP_GRANT_COOKIE]: token.token }), "other-session", store));
  assert.equal(calls.length, count);
});

test("new participant routes admit only the intended methods without host cookies", () => {
  const base = `/api/live-sessions/${sessionId}`;
  assert.equal(isViewerSnapshotPath(`${base}/records-session`, "GET"), true);
  assert.equal(isViewerSnapshotPath(`${base}/records-session`, "POST"), false);
  assert.equal(isViewerSnapshotPath(`${base}/recap-request`, "GET"), true);
  assert.equal(isViewerSnapshotPath(`${base}/recap-request`, "POST"), true);
  assert.equal(isViewerSnapshotPath(`${base}/recap-request`, "DELETE"), false);
});

test("participant runtime polling reaches its own viewer authorization while control-plane writes remain host-only", () => {
  const base = `/api/live-sessions/${sessionId}`;
  assert.equal(isViewerSnapshotPath(`${base}/runtime`, "GET"), true);
  for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.equal(isViewerSnapshotPath(`${base}/runtime`, method), false, method);
  }
  assert.equal(isViewerSnapshotPath(`${base}/host-source`, "POST"), false);
  assert.equal(isViewerSnapshotPath(`${base}/runtime/other`, "GET"), false);
  assert.equal(isViewerSnapshotPath("/api/live-sessions/not-a-session/runtime", "GET"), false);
});

test("record recovery rejects extended deadlines and mismatched membership responses", async () => {
  for (const row of [
    { ...recordRow(), records_expires_at: new Date(Date.now() + sixHours * 2).toISOString() },
    { ...recordRow(), user_id: "different-user" },
    { ...recordRow(), ended_at: null },
  ]) {
    await assert.rejects(createStore({ row }).store.readParticipantRecordAccess(sessionId, userId),
      (error: unknown) => error instanceof LiveAdmissionError && error.status === 503);
  }
  const expired = recordRow(Date.now() - sixHours);
  await assert.rejects(createStore({ row: expired }).store.readParticipantRecordAccess(sessionId, userId),
    (error: unknown) => error instanceof LiveAdmissionError && error.status === 410);
});

test("participant source reads page real originals and omit private provider and identity metadata", async () => {
  const row = { source_utterance_id: "source-1", source_seq: 1, effective_text: "Original speech.",
    source_language: "en", speaker_label: "진행자", source_started_at: new Date().toISOString(),
    source_ended_at: new Date().toISOString(), raw_text: "private raw", speaker_name: "private identity", stt_model: "private provider" };
  const { store } = createStore({ sourceRows: [row, { ...row, source_utterance_id: "source-2", source_seq: 2 }] });
  const page = await store.readParticipantSourceTranscript(sessionId, userId, { afterSourceSeq: 0, pageSize: 1 });
  assert.equal(page.utterances.length, 1);
  assert.equal(page.utterances[0]?.text, "Original speech.");
  assert.equal(page.nextAfterSourceSeq, 1);
  assert.equal(page.hasNextPage, true);
  assert.doesNotMatch(JSON.stringify(page), /raw_text|speaker_name|stt_model|private/);
});

test("source pagination rejects unsafe cursors and malformed or unsorted response rows", async () => {
  const { store, calls } = createStore();
  for (const afterSourceSeq of [-1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(store.readParticipantSourceTranscript(sessionId, userId, { afterSourceSeq, pageSize: 200 }),
      (error: unknown) => error instanceof LiveAdmissionError && error.status === 400);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(createStore({ sourceRows: [{ source_seq: 0 }] }).store.readParticipantSourceTranscript(
    sessionId, userId, { afterSourceSeq: 0, pageSize: 200 },
  ), (error: unknown) => error instanceof LiveAdmissionError && error.status === 503);
});
