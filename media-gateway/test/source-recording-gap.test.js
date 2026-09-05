import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseLivePublisher } from "../src/supabase-adapters.js";

const sessionId = "00000000-0000-4000-8000-000000000001";
const segmentId = "00000000-0000-4000-8000-000000000002";
const ownerId = "00000000-0000-4000-8000-000000000003";
const sourceStartedAt = "2026-09-01T00:00:01.000Z";
const sourceEndedAt = "2026-09-01T00:00:02.000Z";
const input = { sessionId, segmentId, sourceStartedAt, sourceEndedAt };
const row = { id: segmentId, sessionId, startedAt: sourceStartedAt, endedAt: sourceEndedAt,
  reason: "source_recording_failed", idempotent: false };

test("source gap publisher stores only observed segment bounds with the existing media fence", async () => {
  const requests = [];
  const publisher = new SupabaseLivePublisher({ baseUrl: "https://fixture.invalid", serviceRoleKey: "fixture", eventFanout() {},
    async fetchFn(url, options) { requests.push({ url, body: JSON.parse(options.body) }); return Response.json(row); } });
  assert.deepEqual(await publisher.withMediaFence({ epoch: 3, ownerId }).persistSourceRecordingGap(input), row);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/rpc\/record_live_source_gap_v1$/u);
  assert.deepEqual(requests[0].body, { p_session_id: sessionId, p_segment_id: segmentId, p_started_at: sourceStartedAt,
    p_ended_at: sourceEndedAt, p_epoch: 3, p_owner_id: ownerId });
});

test("source gap publisher rejects invented bounds and does not retry an ambiguous failed write", async () => {
  let writes = 0;
  const publisher = new SupabaseLivePublisher({ baseUrl: "https://fixture.invalid", serviceRoleKey: "fixture", eventFanout() {},
    async fetchFn() { writes += 1; return new Response("", { status: 503 }); } });
  for (const invalid of [{ ...input, sourceEndedAt: null }, { ...input, sourceStartedAt: "not-a-time" },
    { ...input, sourceEndedAt: "2026-09-01T02:00:00.000Z" }, { ...input, segmentId: "fake" }]) {
    await assert.rejects(publisher.persistSourceRecordingGap(invalid), /SOURCE_GAP/u);
  }
  assert.equal(writes, 0);
  await assert.rejects(publisher.persistSourceRecordingGap(input), /SOURCE_GAP_PERSIST_FAILED/u);
  assert.equal(writes, 1);
});
