import assert from "node:assert/strict";
import test from "node:test";
import { buildSpeakerRosterUpdate, speakerRosterStatus, requestSpeakerRoster, SpeakerRosterRequestError, speakerRosterFailureState, type SpeakerRoster } from "./speaker-roster-client";
const id = "11111111-1111-4111-8111-111111111111";
const participantId = "22222222-2222-4222-8222-222222222222";
const roster: SpeakerRoster = { sessionId: id, revision: 3, appliedRevision: 2, activeOnsiteSpeakerId: id,
  speakers: [{ id, version: 1, displayName: "김민지", company: "회사", department: "개발", photoAssetId: null, participantId: null }] };
test("roster updates preserve revision and immutable metadata snapshot", () => {
  const update = buildSpeakerRosterUpdate(roster);
  assert.equal(update.expectedRevision, 3); assert.equal(update.speakers[0].department, "개발");
  assert.equal(roster.appliedRevision, 2); assert.notEqual(update.speakers, roster.speakers);
});
test("no inferred participant mapping and no duplicate mapping", () => {
  assert.equal(buildSpeakerRosterUpdate(roster).speakers[0].participantId, null);
  assert.throws(() => buildSpeakerRosterUpdate({ ...roster, speakers: [
    { ...roster.speakers[0], participantId }, { ...roster.speakers[0], id: participantId, participantId },
  ] }), /한 참여자/);
});
test("blank name, oversized organization, missing active speaker and excessive roster fail", () => {
  for (const patch of [{ displayName: " " }, { company: "x".repeat(81) }, { department: "x".repeat(81) }])
    assert.throws(() => buildSpeakerRosterUpdate({ ...roster, speakers: [{ ...roster.speakers[0], ...patch }] }));
  assert.throws(() => buildSpeakerRosterUpdate({ ...roster, activeOnsiteSpeakerId: participantId }));
  assert.throws(() => buildSpeakerRosterUpdate({ ...roster, speakers: Array.from({ length: 31 }, () => roster.speakers[0]) }));
});

test("pending save becomes applied only when authoritative revision catches up", () => {
  assert.equal(speakerRosterStatus(roster, false), "반영 중");
  assert.equal(speakerRosterStatus({ ...roster, appliedRevision: 3 }, false), "반영되었습니다.");
  assert.equal(speakerRosterStatus({ ...roster, revision: 4 }, false), "반영 중");
  assert.equal(speakerRosterStatus({ ...roster, appliedRevision: 3 }, true), "저장하지 않은 변경 사항");
});
test("503 roster reads surface an error rather than an applied result", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: false, error: "발언자 정보를 확인할 수 없습니다." }, { status: 503 });
  try { await assert.rejects(requestSpeakerRoster(id), /발언자 정보를 확인할 수 없습니다/); }
  finally { globalThis.fetch = original; }
});

test("authorization failure removes roster and open draft while transient failure preserves edits", () => {
  const state = { roster, draft: { ...roster.speakers[0], displayName: "수정 중" }, isDirty: true };
  for (const status of [401, 403, 404]) {
    assert.deepEqual(speakerRosterFailureState(new SpeakerRosterRequestError("접근 불가", status), state),
      { roster: null, draft: null, isDirty: false });
  }
  for (const failure of [new SpeakerRosterRequestError("잠시 후 다시 시도", 503), new Error("network")])
    assert.equal(speakerRosterFailureState(failure, state), state);
});
test("GET and PUT retain authorization status even when gateway returns non-JSON errors", async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [401, 403, 404, 503]) {
      globalThis.fetch = async () => new Response("Service unavailable", { status });
      for (const body of [undefined, buildSpeakerRosterUpdate(roster)]) {
        await assert.rejects(requestSpeakerRoster(id, body), (error: unknown) => {
          assert.ok(error instanceof SpeakerRosterRequestError);
          assert.equal(error.status, status);
          return true;
        });
      }
    }
  } finally { globalThis.fetch = original; }
});
