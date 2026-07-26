import assert from "node:assert/strict";
import test from "node:test";

import { LiveMediaPipeline } from "../src/live-media-pipeline.js";

function makeDependencies() {
  const events = [];
  return {
    events,
    dependencies: {
      // Meeting captions run on Gemini Live Translate sessions (2026-07-24
      // provider split); these tests inject finals directly, so the session
      // only needs to exist.
      liveTranslate: { async open() { return { async sendAudio() {}, async audioStreamEnd() {}, async close() {} }; } },
      openaiLiveTranslate: { async open() { throw new Error("UNUSED"); } },
      speechToText: {
        async open() {
          return { async sendAudio() {}, async close() {}, async getFinalWords() { return []; } };
        },
      },
      textTranslate: { async translate({ text, language }) { return `${language}:${text}`; } },
      textToSpeech: { async *synthesizeStream() { yield new Uint8Array(6_000); } },
      publisher: {
        async publish(_sessionId, _language, event) { events.push(event); },
        async publishAudio() {},
      },
    },
  };
}

function makeMeetingPipeline(state, { now = () => 0 } = {}) {
  return new LiveMediaPipeline({
    sessionId: "s1",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko"],
    dependencies: state.dependencies,
    now,
  });
}

test("final utterances while a participant holds the floor are attributed to their display name", async () => {
  const state = makeDependencies();
  const pipeline = makeMeetingPipeline(state);
  await pipeline.start();

  pipeline.setFloorSpeaker({
    participantId: "participant-1",
    displayName: "김노엘",
    department: "전략기획실",
    jobTitle: "PM",
  });
  await pipeline.acceptFinalUtterance({
    speakerLabel: "1",
    text: "안녕하세요",
    sourceLanguage: "ko",
    sourceStartOffsetMs: 2_000,
    sourceEndOffsetMs: 6_000,
    sourceEndedAt: "2026-07-23T00:00:00Z",
  });

  const caption = state.events.find((event) => event.type === "caption");
  assert.ok(caption, "caption should be published");
  assert.equal(caption.speaker.label, "김노엘");
  assert.equal(typeof caption.speaker.speakerId, "string");
  assert.equal(caption.speakerRole, "participant");
  assert.equal(caption.speakerName, "김노엘");
  assert.equal(caption.speakerDepartment, "전략기획실");
  assert.equal(caption.speakerJobTitle, "PM");
  assert.equal(caption.sourceStartedAt, "2026-07-22T23:59:56.000Z");

  // The same participant keeps the same registry slot on later utterances.
  await pipeline.acceptFinalUtterance({
    speakerLabel: "2",
    text: "두 번째 발언",
    sourceLanguage: "ko",
    sourceEndedAt: "2026-07-23T00:00:01Z",
  });
  const captions = state.events.filter((event) => event.type === "caption");
  assert.equal(captions[1].speaker.speakerId, captions[0].speaker.speakerId);
});

test("attribution falls back to diarization after the floor is released past the grace window", async () => {
  const state = makeDependencies();
  let currentTime = 0;
  const pipeline = makeMeetingPipeline(state, { now: () => currentTime });
  await pipeline.start();

  pipeline.setFloorSpeaker({ participantId: "participant-1", displayName: "김노엘" });
  pipeline.setFloorSpeaker(null);

  // Within the grace window: still the participant (STT finals lag audio).
  currentTime = 1_000;
  await pipeline.acceptFinalUtterance({
    speakerLabel: "1",
    text: "마지막 발언",
    sourceLanguage: "ko",
    sourceEndedAt: "2026-07-23T00:00:00Z",
  });
  // Past the grace window: back to diarization labels.
  currentTime = 10_000;
  await pipeline.acceptFinalUtterance({
    speakerLabel: "1",
    text: "호스트 발언",
    sourceLanguage: "ko",
    sourceEndedAt: "2026-07-23T00:00:05Z",
  });

  const captions = state.events.filter((event) => event.type === "caption");
  assert.equal(captions[0].speaker.label, "김노엘");
  assert.equal(captions[1].speaker.label, "Speaker 2");
  assert.equal(captions[1].speakerRole, "host");
  assert.equal(captions[1].speakerName, "Host");
  assert.equal(captions[1].speakerDepartment, "");
  assert.equal(captions[1].speakerJobTitle, "");
});

test("a preempting speaker does not inherit the previous holder's lagging finals (capture-time fence)", async () => {
  const state = makeDependencies();
  // Clock aligned with the utterances' wall-clock timestamps so the fence can
  // compare capture time against the floor-switch time.
  const switchAt = Date.parse("2026-07-23T00:00:10.000Z");
  let currentTime = switchAt - 5_000;
  const pipeline = makeMeetingPipeline(state, { now: () => currentTime });
  await pipeline.start();

  pipeline.setFloorSpeaker({ participantId: "participant-a", displayName: "발표자A" });
  currentTime = switchAt;
  // B preempts A: setFloorSpeaker is called directly with the new holder.
  pipeline.setFloorSpeaker({ participantId: "participant-b", displayName: "발표자B" });

  // A lagging STT final whose source audio STARTED before the switch → A.
  currentTime = switchAt + 800;
  await pipeline.acceptFinalUtterance({
    speakerLabel: "1",
    text: "교체 직전 발언",
    sourceLanguage: "ko",
    sourceStartOffsetMs: 2_000,
    sourceEndOffsetMs: 5_500,
    sourceEndedAt: "2026-07-23T00:00:09.500Z", // started 00:00:06.000 < switch
  });

  // Audio captured after the switch → the new holder B.
  currentTime = switchAt + 1_500;
  await pipeline.acceptFinalUtterance({
    speakerLabel: "1",
    text: "새 발언자 발언",
    sourceLanguage: "ko",
    sourceStartOffsetMs: 6_000,
    sourceEndOffsetMs: 7_000,
    sourceEndedAt: "2026-07-23T00:00:12.000Z", // started 00:00:11.000 > switch
  });

  const captions = state.events.filter((event) => event.type === "caption");
  assert.equal(captions[0].speaker.label, "발표자A");
  assert.equal(captions[1].speaker.label, "발표자B");
});
