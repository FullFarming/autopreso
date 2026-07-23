import assert from "node:assert/strict";
import test from "node:test";

import { LiveMediaPipeline } from "../src/live-media-pipeline.js";

function makeDependencies() {
  const events = [];
  return {
    events,
    dependencies: {
      liveTranslate: { async open() { throw new Error("UNUSED"); } },
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

  pipeline.setFloorSpeaker({ grantId: "grant-1", displayName: "김노엘" });
  await pipeline.acceptFinalUtterance({
    speakerLabel: "1",
    text: "안녕하세요",
    sourceLanguage: "ko",
    sourceEndedAt: "2026-07-23T00:00:00Z",
  });

  const caption = state.events.find((event) => event.type === "caption");
  assert.ok(caption, "caption should be published");
  assert.equal(caption.speaker.label, "김노엘");
  assert.equal(typeof caption.speaker.speakerId, "string");

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

  pipeline.setFloorSpeaker({ grantId: "grant-1", displayName: "김노엘" });
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
});
