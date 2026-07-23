import assert from "node:assert/strict";
import test from "node:test";

import { MAX_TTS_INPUT_BYTES, segmentTextForStreamingTts } from "../src/tts-text-segmentation.js";

test("streaming TTS segments stay below the 5000-byte request limit without losing code points", () => {
  const text = `${"alpha ".repeat(900)}finished.`;
  const segments = segmentTextForStreamingTts(text);
  assert.equal(segments.join(""), text);
  assert.equal(segments.length > 1, true);
  assert.equal(segments.every((segment) => Buffer.byteLength(segment, "utf8") <= MAX_TTS_INPUT_BYTES), true);
  assert.equal(MAX_TTS_INPUT_BYTES < 5_000, true);
});

test("Korean and Japanese text prefer CJK sentence boundaries", () => {
  const koreanSentence = "안녕하세요. 오늘 회의에서는 실시간 통역 품질을 확인합니다。";
  const japaneseSentence = "こんにちは。今日は音声ストリーミングを確認します！";
  const text = `${koreanSentence.repeat(80)}${japaneseSentence.repeat(80)}`;
  const segments = segmentTextForStreamingTts(text, 240);
  assert.equal(segments.join(""), text);
  assert.equal(segments.every((segment) => Buffer.byteLength(segment, "utf8") <= 240), true);
  assert.equal(segments.slice(0, -1).every((segment) => /[.!?。！？；：、\s]$/u.test(segment)), true);
});

test("a byte boundary never splits an emoji or other Unicode code point", () => {
  const text = "🎙️".repeat(20);
  const segments = segmentTextForStreamingTts(text, 13);
  assert.equal(segments.join(""), text);
  assert.equal(segments.every((segment) => Buffer.byteLength(segment, "utf8") <= 13), true);
  assert.equal(segments.some((segment) => segment.includes("�")), false);
});
