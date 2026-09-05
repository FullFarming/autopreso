import assert from "node:assert/strict";
import test from "node:test";
import { getRecordSpeakerPresentation } from "./record-speaker-presentation";
import { groupTranscriptReading } from "../transcript-reading-model";

const sessionId = "00000000-0000-4000-8000-000000000001";
const profile = { id: "00000000-0000-4000-8000-000000000002", version: 1, displayName: "김서연", company: "노바", department: "재무팀", photoAssetId: "00000000-0000-4000-8000-000000000003" };
const source = { sourceUtteranceId: "utterance-1", speakerRole: "host" as const, speakerLabel: "진행자", speakerName: "현재 이름", participantId: null, speakerDepartment: null, speakerProfile: profile };

test("record identity uses immutable row snapshot and a same-session photo endpoint", () => {
  const actual = getRecordSpeakerPresentation(sessionId, source);
  assert.equal(actual.displayName, "김서연");
  assert.equal(actual.organization, "노바 · 재무팀");
  assert.equal(actual.initials, "김서");
  assert.equal(actual.photoUrl, `/api/live-sessions/${sessionId}/speakers/photos/${profile.photoAssetId}`);
  assert.equal(getRecordSpeakerPresentation(sessionId, { ...source, speakerName: "새 이름" }).displayName, "김서연");
});

test("profile versions remain separate reading turns even for the same participant", () => {
  const next = { ...source, sourceUtteranceId: "utterance-2", speakerProfile: { ...profile, version: 2, displayName: "서연 Kim", department: "경영팀" } };
  const entries = [source, next].map((item, index) => ({
    id: item.sourceUtteranceId, seq: index + 1, speakerKey: getRecordSpeakerPresentation(sessionId, item).key,
    speaker: getRecordSpeakerPresentation(sessionId, item).displayName,
    startedAt: "2026-09-05T01:00:00Z", endedAt: "2026-09-05T01:00:01Z", text: "발언",
  }));
  assert.equal(groupTranscriptReading(entries).length, 2);
  assert.notEqual(entries[0].speakerKey, entries[1].speakerKey);
});

test("unresolved rows never borrow a host name or snapshot, and invalid photo IDs never become URLs", () => {
  const unresolved = getRecordSpeakerPresentation(sessionId, { ...source, speakerAttribution: "unresolved" });
  assert.equal(unresolved.displayName, "");
  assert.equal(unresolved.photoUrl, null);
  assert.equal(unresolved.organization, "");
  assert.equal(unresolved.key, "unknown:utterance-1");
  assert.equal(getRecordSpeakerPresentation(sessionId, { ...source, speakerProfile: { ...profile, photoAssetId: "https://evil.example/photo" } }).photoUrl, null);
});

test("legacy record identities use only recorded names and isolate unknown speakers", () => {
  const legacy = { ...source, speakerProfile: undefined, speakerDepartment: "저장된 부서" };
  assert.equal(getRecordSpeakerPresentation(sessionId, legacy).displayName, "현재 이름");
  assert.equal(getRecordSpeakerPresentation(sessionId, legacy).organization, "저장된 부서");
  const unknown = getRecordSpeakerPresentation(sessionId, { ...legacy, speakerRole: "unknown", speakerName: null, speakerLabel: null });
  assert.equal(unknown.key, "unknown:utterance-1");
  assert.equal(unknown.photoUrl, null);
});
