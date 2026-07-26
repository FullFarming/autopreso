import assert from "node:assert/strict";
import test from "node:test";

import { shouldDisplayLiveCaption } from "../src/live-caption-display-policy.js";
// Node 24 strips the webapp's type-only imports at runtime. Keeping the path in
// a variable prevents the root JS checker from treating this cross-workspace
// integration test as a TypeScript source import.
const captionFeedModulePath = "../webapp/lib/live/caption-feed.ts";
const deterministicGatewayModulePath = "../media-gateway/scripts/local-live-call-e2e-gateway.mjs";
const {
  getCachedLanguageCaptions,
  isDisplayableCaption,
  mergeLanguageCaptionCache,
} = await import(captionFeedModulePath);
const { createDeterministicLocalPipeline } = await import(deterministicGatewayModulePath);

test("host and participant speech keep one opposite desktop line and both canonical web histories", async () => {
  const published = [];
  const pipeline = createDeterministicLocalPipeline({
    settings: {
      sessionId: "00000000-0000-4000-8000-000000000001",
      sessionType: "meeting",
      outputMode: "captions",
      languages: ["ko", "en"],
    },
    initialSequences: { ko: 0, en: 0 },
    publisher: {
      async publish(_sessionId, language, event) { published.push({ ...event, language }); },
    },
    onHostEvent: async () => {},
    now: () => Date.parse("2026-07-26T00:00:00.000Z") + published.length * 1_000,
  });

  await pipeline.acceptAudio(Uint8Array.of(1)); // host, Korean source
  pipeline.setFloorSpeaker({ participantId: "00000000-0000-4000-8000-000000000002", displayName: "Local Viewer" });
  await pipeline.acceptAudio(Uint8Array.of(2)); // participant, English source
  pipeline.setFloorSpeaker(null);
  await pipeline.acceptAudio(Uint8Array.of(3)); // host, Korean source
  pipeline.setFloorSpeaker({ participantId: "00000000-0000-4000-8000-000000000003", displayName: "Second Viewer" });
  await pipeline.acceptAudio(Uint8Array.of(4)); // participant, English source

  const utterances = new Map();
  for (const caption of published) {
    const events = utterances.get(caption.utteranceKey) ?? [];
    events.push(caption);
    utterances.set(caption.utteranceKey, events);
  }
  assert.equal(utterances.size, 4);

  let webCache = {};
  for (const events of utterances.values()) {
    assert.equal(events.length, 2, "each utterance must have one source and one translated lane");
    for (const historicalDisplayLanguage of ["ko", "en"]) {
      const desktop = events.filter((event) => shouldDisplayLiveCaption(event, historicalDisplayLanguage));
      assert.equal(desktop.length, 1, "desktop must render exactly one line");
      assert.notEqual(desktop[0].language, desktop[0].sourceLanguage);
      assert.notEqual(desktop[0].origin, "source");
    }
    assert.equal(events.filter(isDisplayableCaption).length, 2,
      "web must retain the source and translated forms of the same utterance");
    for (const event of events) {
      webCache = mergeLanguageCaptionCache(webCache, event.language, [event]);
    }
  }

  assert.deepEqual(webCache.ko.map((caption) => caption.seq), [1, 2, 3, 4]);
  assert.deepEqual(webCache.en.map((caption) => caption.seq), [1, 2, 3, 4]);
  assert.deepEqual(webCache.ko.map((caption) => caption.utteranceKey), webCache.en.map((caption) => caption.utteranceKey));
  assert.deepEqual(webCache.ko.map((caption) => caption.speaker?.speakerId ?? "host"), [
    "host",
    "participant:00000000-0000-4000-8000-000000000002",
    "host",
    "participant:00000000-0000-4000-8000-000000000003",
  ]);

  const koreanIdentity = webCache.ko;
  const englishIdentity = webCache.en;
  for (let switchIndex = 0; switchIndex < 20; switchIndex += 1) {
    const language = switchIndex % 2 === 0 ? "ko" : "en";
    assert.equal(
      getCachedLanguageCaptions(webCache, language),
      language === "ko" ? koreanIdentity : englishIdentity,
      "language switching must be a synchronous cache read",
    );
  }
});
