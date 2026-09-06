import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiRequestError, readApi } from "./viewer-controller-contract";
import { isRecordsAccessExpired, parseViewerRecordsSession } from "./viewer-records-recovery";
import { loadViewerSourceRecord } from "./viewer-source-record";
import { readRecapRequest, saveRecapRequest } from "./recap-request-client";

const sessionId = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";
const endedAt = "2026-08-31T05:00:00.000Z";
const recordsExpiresAt = "2026-08-31T11:00:00.000Z";
const record = { session: { id: sessionId, title: "회의", scheduledAt: null, status: "stopped", endedAt,
  sessionType: "meeting", outputMode: "captions", languages: ["ko"], maxViewers: 50, participantSpeakingEnabled: false },
  self: { email: "guest@example.com", displayName: "참가자", company: "", department: "", jobTitle: "", summaryConsent: false }, recordsExpiresAt };

test("ended recovery carries no live grant and never extends the six-hour deadline", () => {
  const result = parseViewerRecordsSession(record, sessionId);
  assert.equal(result.viewer.grant, undefined);
  assert.equal(result.viewer.session.participantSpeakingEnabled, false);
  assert.equal(result.recordsExpiresAt, recordsExpiresAt);
  assert.equal(isRecordsAccessExpired(recordsExpiresAt, Date.parse(recordsExpiresAt) - 1), false);
  assert.equal(isRecordsAccessExpired(recordsExpiresAt, Date.parse(recordsExpiresAt)), true);
  assert.throws(() => parseViewerRecordsSession({ ...record, recordsExpiresAt: "2026-08-31T12:00:00.000Z" }, sessionId));
  assert.throws(() => parseViewerRecordsSession(record, "0192d0f4-9f72-7a36-91f5-6a76ef736f42"));
  assert.throws(() => parseViewerRecordsSession({ ...record, session: { ...record.session, status: "live", participantSpeakingEnabled: true } }, sessionId));
});

test("source reader completes pagination and never substitutes translated records", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    const seq = calls.length;
    return Response.json({ ok: true, data: { view: "source", recordingGaps: [], utterances: [{ seq, speaker: "발표자", text: `원문 ${seq}`, emittedAt: endedAt, sourceLanguage: "ko" }], hasNextPage: seq === 1, nextAfterSourceSeq: seq === 1 ? 1 : null } });
  };
  assert.deepEqual((await loadViewerSourceRecord(sessionId, fetcher)).utterances.map((entry) => entry.text), ["원문 1", "원문 2"]);
  assert.match(calls[1], /afterSourceSeq=1/u);
  const stalled: typeof fetch = async () => Response.json({ ok: true, data: { view: "source", recordingGaps: [], utterances: [], hasNextPage: true, nextAfterSourceSeq: 0 } });
  await assert.rejects(loadViewerSourceRecord(sessionId, stalled), /페이지 순서/u);
  const translated: typeof fetch = async () => Response.json({ ok: true, data: { utterances: [{ text: "translation" }] } });
  await assert.rejects(loadViewerSourceRecord(sessionId, translated));
});

test("recap click writes only the new purpose and explicit acceptance, while reload only reads", async () => {
  const calls: RequestInit[] = [];
  const request = { id: "request-1", sessionId, requestedAt: endedAt, noticeVersion: "summary-original-email-v2", status: "requested", email: "guest@example.com", revision: 1 };
  const fetcher: typeof fetch = async (_url, init) => { calls.push(init ?? {}); return Response.json({ ok: true, data: { request } }); };
  await readRecapRequest(sessionId, fetcher);
  assert.equal(calls[0].method, undefined);
  await saveRecapRequest(sessionId, "123", fetcher);
  assert.deepEqual(JSON.parse(String(calls[1].body)), { noticeVersion: "summary-original-email-v2", accepted: true, idempotencyKey: "123" });
  assert.doesNotMatch(String(calls[1].body), /"(?:marketing|email|participantId)"\s*:/u);
  const rejected: typeof fetch = async () => Response.json({ ok: false, code: "SAVE_FAILED" }, { status: 500 });
  await assert.rejects(saveRecapRequest(sessionId, "123", rejected));
});


test("recap response from another meeting or an unconfirmed request cannot show completion", async () => {
  const request = { id: "request-1", sessionId: "other-session", requestedAt: endedAt, noticeVersion: "summary-original-email-v2", status: "requested", email: "other@example.com", revision: 1 };
  const foreign: typeof fetch = async () => Response.json({ ok: true, data: { request } });
  await assert.rejects(readRecapRequest(sessionId, foreign), /다른 회의/u);
  const empty: typeof fetch = async () => Response.json({ ok: true, data: { request: null } });
  assert.equal(await readRecapRequest(sessionId, empty), null);
  await assert.rejects(saveRecapRequest(sessionId, "same-key", empty), /저장하지 못했어요/u);
});


test("server failures preserve their status for recovery and never become a successful viewer session", async () => {
  await assert.rejects(readApi(Response.json({ ok: false, error: "unavailable", code: "STORE_UNAVAILABLE" }, { status: 503 })),
    (error: unknown) => error instanceof ApiRequestError && error.status === 503);
  await assert.rejects(readApi(Response.json({ ok: true, data: record }, { status: 503 })),
    (error: unknown) => error instanceof ApiRequestError && error.status === 503);
});


test("a source record with zero utterances retains gaps and unknown end times", async () => {
  const gap = { id: "0192d0f4-9f72-7a36-91f5-6a76ef736f48", startedAt: endedAt, endedAt: null, reason: "no_viewers" };
  const fetcher: typeof fetch = async () => Response.json({ ok: true, data: { view: "source", recordingGaps: [gap], utterances: [], hasNextPage: false, nextAfterSourceSeq: null } });
  const record = await loadViewerSourceRecord(sessionId, fetcher);
  assert.deepEqual(record.utterances, []);
  assert.deepEqual(record.recordingGaps, [gap]);
});
