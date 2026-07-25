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

// --- diarized segmenter resilience (missing/conflicting speaker labels) ---

import { StableUtteranceSegmenter } from "../src/stable-utterance-segmenter.js";

function diarizedResult(words, { isFinal = false, stability = 0.96, languageCode = "ko-KR" } = {}) {
  return {
    isFinal,
    stability,
    languageCode,
    alternatives: [{
      words: words.map(([word, startMs, endMs, speakerLabel]) => ({
        word,
        startOffset: { seconds: Math.floor(startMs / 1_000), nanos: (startMs % 1_000) * 1_000_000 },
        endOffset: { seconds: Math.floor(endMs / 1_000), nanos: (endMs % 1_000) * 1_000_000 },
        ...(speakerLabel ? { speakerLabel } : {}),
      })),
    }],
  };
}

test("diarized final words without speaker labels fall back to the last known label instead of failing", () => {
  const segmenter = new StableUtteranceSegmenter();
  const first = segmenter.accept(diarizedResult([["안녕하세요", 0, 400, "1"]], { isFinal: true }));
  assert.deepEqual(first.map((utterance) => [utterance.speakerLabel, utterance.text]), [["1", "안녕하세요"]]);
  const second = segmenter.accept(diarizedResult([["회의를", 500, 900, ""], ["시작합니다", 900, 1_400, ""]], { isFinal: true }));
  assert.deepEqual(second.map((utterance) => [utterance.speakerLabel, utterance.text]), [["1", "회의를 시작합니다"]]);
});

test("diarized final words without any prior label default to speaker 1", () => {
  const segmenter = new StableUtteranceSegmenter();
  const emitted = segmenter.accept(diarizedResult([["hello", 0, 300, ""]], { isFinal: true }));
  assert.deepEqual(emitted.map((utterance) => [utterance.speakerLabel, utterance.text]), [["1", "hello"]]);
});

test("diarized relabeling of a pending word adopts the newest label instead of failing", () => {
  const segmenter = new StableUtteranceSegmenter();
  segmenter.accept(diarizedResult([["hello", 0, 300, "1"]], { stability: 0.9 }));
  const emitted = segmenter.accept(diarizedResult([["hello", 0, 300, "2"]], { isFinal: true }));
  assert.deepEqual(emitted.map((utterance) => [utterance.speakerLabel, utterance.text]), [["2", "hello"]]);
});

test("SentencePiece word tokens join into clean text instead of space-separated fragments", () => {
  const segmenter = new StableUtteranceSegmenter();
  const emitted = segmenter.accept(diarizedResult([
    ["▁", 0, 50, "1"],
    ["안녕하세요", 50, 400, "1"],
    ["▁오늘", 420, 600, "1"],
    ["▁", 600, 640, "1"],
    ["회", 640, 700, "1"],
    ["의", 700, 760, "1"],
    ["를", 760, 820, "1"],
    ["▁시작", 840, 1_000, "1"],
    ["하", 1_000, 1_060, "1"],
    ["겠습니다", 1_060, 1_400, "1"],
  ], { isFinal: true }));
  assert.deepEqual(emitted.map((utterance) => utterance.text), ["안녕하세요 오늘 회의를 시작하겠습니다"]);
});
