import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { presentViewerSourceEvent } from "./viewer-source-ledger";
import type { SourceEvent } from "../../lib/live/source-contract";
import { projectCaptionLane } from "./translation/topic-presentation";
import { buildSpeakerPhotoUrl } from "../../../packages/caption-core/speaker-profile.js";
const sessionId = "11111111-1111-4111-8111-111111111111";
const profile = { id: sessionId, version: 1, displayName: "김민지", company: "NOVA", department: "연구", photoAssetId: "22222222-2222-4222-8222-222222222222" };
const source: SourceEvent = { type: "source", sessionId, sourceUtteranceId: sessionId, sourceSeq: 1, utteranceKey: "utterance-1", text: "안녕하세요", sourceLanguage: "ko", languageObservation: null, speaker: { role: "host", label: "Host" }, speakerProfile: profile, isFinal: true, sourceStartedAt: null, sourceEndedAt: "2026-09-05T00:00:00Z", emittedAt: "2026-09-05T00:00:00Z" };
test("source presentation honors immutable named profile over generic Host", () => {
  const rendered = presentViewerSourceEvent(source);
  assert.equal(rendered.speakerLabel, "김민지"); assert.equal(rendered.speakerProfile?.department, "연구");
  const next = presentViewerSourceEvent({ ...source, sourceSeq: 2, speakerProfile: { ...profile, version: 2, displayName: "새 이름" } });
  assert.equal(rendered.speakerProfile?.displayName, "김민지"); assert.equal(next.speakerProfile?.version, 2);
});
test("native caption projection retains snapshot and safe session photo scope", () => {
  const [caption] = projectCaptionLane([{ ...presentViewerSourceEvent(source), language: "ko", origin: "source", sourceLanguage: "ko" }], { id: "source", kind: "source", language: "ko", label: "원문" });
  assert.deepEqual(caption.speakerProfile, profile); assert.equal(caption.sessionId, sessionId);
  assert.equal(buildSpeakerPhotoUrl(sessionId, profile.photoAssetId), `/api/live-sessions/${sessionId}/speakers/photos/${profile.photoAssetId}`);
  assert.throws(() => buildSpeakerPhotoUrl(sessionId, "https://untrusted.example/avatar"));
});
test("legacy source remains labeled and display never consults mutable roster", () => {
  assert.equal(presentViewerSourceEvent({ ...source, speakerProfile: undefined }).speakerLabel, "Host");
  const reader = readFileSync(new URL("./ViewerReadingFeed.tsx", import.meta.url), "utf8");
  assert.match(reader, /profile=\{caption.speakerProfile\}/);
  assert.doesNotMatch(reader, /requestSpeakerRoster|fetch\(/);
});
