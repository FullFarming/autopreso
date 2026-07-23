import assert from "node:assert/strict";
import test from "node:test";

import { StableTranscriptSegmenter } from "../src/stable-utterance-segmenter.js";

function result(transcript, { isFinal = false, stability = 0.96, endMs = 1_000 } = {}) {
  return {
    isFinal,
    stability,
    languageCode: "en-US",
    resultEndTime: { seconds: Math.floor(endMs / 1_000), nanos: (endMs % 1_000) * 1_000_000 },
    alternatives: [{ transcript }],
  };
}

test("nondiarized stable transcript emits only common incremental prefixes and final remainder", () => {
  const segmenter = new StableTranscriptSegmenter();
  assert.deepEqual(segmenter.accept(result("we are reviewing the market", { endMs: 1_400 })), []);
  const first = segmenter.accept(result("we are reviewing the market today", { endMs: 1_800 }));
  const second = segmenter.accept(result("we are reviewing the market today.", { endMs: 2_100 }));
  const finalRemainder = segmenter.accept(result("we are reviewing the market today.", { isFinal: true, endMs: 2_200 }));
  const nextFinal = segmenter.accept(result("Next point.", { isFinal: true, endMs: 3_000 }));

  assert.deepEqual([...first, ...second, ...finalRemainder, ...nextFinal].map((utterance) => utterance.text), [
    "we are reviewing the",
    "market today.",
    "Next point.",
  ]);
  assert.deepEqual([...first, ...second, ...finalRemainder, ...nextFinal].map((utterance) => utterance.speakerLabel), ["1", "1", "1"]);
  assert.deepEqual([...first, ...second, ...finalRemainder, ...nextFinal].map((utterance) => utterance.sourceEndOffsetMs), [1_800, 2_200, 3_000]);
});

test("nondiarized stable transcript discards one conflicting final and continues at the next boundary", () => {
  let continuityDiscardCount = 0;
  const segmenter = new StableTranscriptSegmenter({
    minimumCommonTokens: 2,
    onContinuityDiscard() { continuityDiscardCount += 1; },
  });
  segmenter.accept(result("the market is rising"));
  const emitted = segmenter.accept(result("the market is rising today"));
  assert.deepEqual(emitted.map((utterance) => utterance.text), ["the market is"]);
  assert.deepEqual(segmenter.accept(result("the market was falling", { isFinal: true, endMs: 2_000 })), []);
  assert.equal(continuityDiscardCount, 1);
  assert.deepEqual(
    segmenter.accept(result("Next section starts now.", { isFinal: true, endMs: 3_000 })).map((utterance) => utterance.text),
    ["Next section starts now."],
  );
});
