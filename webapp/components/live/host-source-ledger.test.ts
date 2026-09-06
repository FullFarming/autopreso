import assert from "node:assert/strict";
import test from "node:test";
import { createHostSourceLedger, mergeHostSourceLedger, markHostSourceUnavailable, loadHostSourceSnapshot } from "./host-source-ledger";
import type { SourceEvent } from "../../lib/live/source-contract";

const sessionId = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";
const otherSessionId = "0192d0f4-9f72-7a36-91f5-6a76ef736f42";
function source(sourceSeq: number): SourceEvent {
  return { type: "source", sessionId, sourceUtteranceId: `11111111-1111-4111-8111-${String(sourceSeq).padStart(12, "0")}`,
    sourceSeq, utteranceKey: `source-${sourceSeq}`, text: `원문 ${sourceSeq}`, sourceLanguage: "ko", languageObservation: null,
    speaker: { role: "host", label: "호스트" }, isFinal: true,
    sourceStartedAt: null, sourceEndedAt: "2026-09-01T00:00:01.000Z", emittedAt: "2026-09-01T00:00:02.000Z" };
}

test("host source history fills earlier records without replacing a newer websocket source", () => {
  const live = mergeHostSourceLedger(createHostSourceLedger(sessionId), sessionId, [source(3)]);
  const restored = mergeHostSourceLedger(live, sessionId, [source(1), source(2)]);
  assert.deepEqual(restored.sources.map((value) => value.sourceSeq), [1, 2, 3]);
});

test("source unavailability survives late history success and later original events", () => {
  const failed = markHostSourceUnavailable(createHostSourceLedger(sessionId), sessionId);
  const restored = mergeHostSourceLedger(failed, sessionId, [source(1)]);
  assert.equal(restored.isUnavailable, true);
  assert.equal(restored.sources.length, 1);
  assert.equal(createHostSourceLedger(otherSessionId).isUnavailable, false);
});

test("retired meeting callbacks cannot mutate current host originals or availability", () => {
  const current = createHostSourceLedger(otherSessionId);
  assert.equal(mergeHostSourceLedger(current, sessionId, [source(1)]), current);
  assert.equal(markHostSourceUnavailable(current, sessionId), current);
  assert.throws(() => mergeHostSourceLedger(current, otherSessionId, [source(1)]), /다른 회의/u);
});

test("source identity collisions fail closed instead of replacing historical originals", () => {
  const current = mergeHostSourceLedger(createHostSourceLedger(sessionId), sessionId, [source(1)]);
  assert.throws(() => mergeHostSourceLedger(current, sessionId, [{ ...source(2), sourceSeq: 1 }]), /순서/u);
});

test("host history explicitly requests host authority and follows the source cursor", async () => {
  const urls: string[] = [];
  const result = await loadHostSourceSnapshot(sessionId, 0, new AbortController().signal, async (url) => {
    urls.push(String(url));
    const first = urls.length === 1;
    return Response.json({ ok: true, data: { sessionId, sources: [source(first ? 1 : 2)], lastSourceSeq: 2,
      hasNextPage: first, nextAfterSourceSeq: first ? 1 : null, recordsExpiresAt: null } });
  });
  assert.match(urls[0]!, /audience=host&afterSourceSeq=0&pageSize=500/u);
  assert.match(urls[1]!, /afterSourceSeq=1/u);
  assert.deepEqual(result.sources.map((value) => value.sourceSeq), [1, 2]);
});

test("host history rejects another meeting and a nonadvancing cursor without request loops", async () => {
  for (const data of [
    { sessionId: otherSessionId, sources: [], lastSourceSeq: 0, hasNextPage: false, nextAfterSourceSeq: null, recordsExpiresAt: null },
    { sessionId, sources: [source(1)], lastSourceSeq: 1, hasNextPage: true, nextAfterSourceSeq: 1, recordsExpiresAt: null },
  ]) {
    let calls = 0;
    await assert.rejects(loadHostSourceSnapshot(sessionId, 1, new AbortController().signal, async () => {
      calls += 1; return Response.json({ ok: true, data });
    }));
    assert.equal(calls, 1);
  }
});

test("known gaps are retained even when no original rows are available", async () => {
  const result = await loadHostSourceSnapshot(sessionId, 0, new AbortController().signal, async () => Response.json({ ok: true, data: {
    sessionId, sources: [], lastSourceSeq: 0, hasNextPage: false, nextAfterSourceSeq: null, recordsExpiresAt: null,
    recordingGaps: [{ id: "11111111-1111-4111-8111-111111111111", startedAt: "2026-09-01T00:00:01.000Z", endedAt: null, reason: "no_viewers" }],
  } }));
  assert.deepEqual(result.sources, []);
  assert.equal(result.hasRecordingGaps, true);
});
