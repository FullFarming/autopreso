import assert from "node:assert/strict";
import test from "node:test";

import { SpeakerRegistry, SpeakerRemapError, remapRolloverSpeakers } from "../src/speaker-registry.js";

test("speaker color and Meeting audio voice remain stable for a session", () => {
  const registry = new SpeakerRegistry({ sessionType: "meeting", outputMode: "audio", now: () => 1_000 });
  const first = registry.getOrCreate("stt-2");
  const again = registry.getOrCreate("stt-2");
  const other = registry.getOrCreate("stt-1");
  assert.deepEqual(again, first);
  assert.notEqual(other.colorToken, first.colorToken);
  assert.notEqual(other.voiceName, first.voiceName);
  assert.equal(first.voiceStatus, "ready");
});

test("caption and caption-audio modes expose only voice readiness, never acoustic metadata", () => {
  const captions = new SpeakerRegistry({ sessionType: "meeting", outputMode: "captions" });
  assert.deepEqual(
    { voiceName: captions.getOrCreate("A").voiceName, voiceStatus: captions.getOrCreate("A").voiceStatus },
    { voiceName: null, voiceStatus: "disabled" },
  );

  const captionAudio = new SpeakerRegistry({ sessionType: "meeting", outputMode: "captions_audio" });
  const assigned = captionAudio.getOrCreate("A");
  captionAudio.alias("A-rollover", "A");
  assert.equal(captionAudio.getOrCreate("A-rollover").voiceName, assigned.voiceName);
  assert.equal(assigned.voiceStatus, "ready");
  assert.equal("acousticRange" in assigned, false);
});

test("rollover aliases do not consume a speaker slot or change the next identity", () => {
  const registry = new SpeakerRegistry({ mode: "meeting" });
  registry.getOrCreate("old-a");
  registry.alias("new-a", "old-a");
  const second = registry.getOrCreate("old-b");
  assert.equal(registry.list().length, 2);
  assert.equal(second.speakerId, "speaker-2");
});

test("rollover remaps labels through overlapping finalized words", () => {
  const mapping = remapRolloverSpeakers(
    [
      { word: "budget", startMs: 100, endMs: 250, speakerLabel: "old-a" },
      { word: "today", startMs: 260, endMs: 410, speakerLabel: "old-a" },
      { word: "agreed", startMs: 430, endMs: 600, speakerLabel: "old-b" },
    ],
    [
      { word: "budget", startMs: 101, endMs: 251, speakerLabel: "new-3" },
      { word: "today", startMs: 261, endMs: 411, speakerLabel: "new-3" },
      { word: "agreed", startMs: 431, endMs: 601, speakerLabel: "new-8" },
    ],
  );
  assert.deepEqual(Object.fromEntries(mapping), { "new-3": "old-a", "new-8": "old-b" });
});

test("rollover stops instead of guessing an ambiguous speaker mapping", () => {
  assert.throws(
    () => remapRolloverSpeakers(
      [
        { word: "yes", startMs: 100, endMs: 200, speakerLabel: "old-a" },
        { word: "yes", startMs: 100, endMs: 200, speakerLabel: "old-b" },
      ],
      [{ word: "yes", startMs: 100, endMs: 200, speakerLabel: "new-a" }],
    ),
    SpeakerRemapError,
  );
});
