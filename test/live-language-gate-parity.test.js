import assert from "node:assert/strict";
import test from "node:test";

import {
  detectSourceLanguage as gatewayDetect,
  isOutputInTargetLanguage,
  sourceLaneMatches,
} from "../media-gateway/src/language-gate.js";
import { detectSourceLanguage as desktopDetect } from "../src/subtitle-realtime.js";

// The desktop subtitle engine is the reference implementation for output-language
// decisions, and the gateway ships a port of it (media-gateway is a separate npm
// package and cannot import from the repo root). The gateway previously had only
// textPlausiblyInLanguage() — a bare Unicode-script presence test — plus a
// fail-open that published the UNTRANSLATED source on a target lane whenever
// translation threw or a language cooldown was active. On continuous English
// input that made the KO lane alternate Korean and raw English.
//
// This battery fails if the two copies drift. Same marker as the desktop:
// search "language gate parity".

const DETECTION_BATTERY = [
  // Plain single-language speech.
  "우리는 오늘 서울 오피스 시장을 살펴보겠습니다",
  "We will review the Seoul office market today",
  "今日はソウルのオフィス市場を見ていきます",
  // Korean carrying English acronyms and proper nouns — the case that must stay
  // Korean even though Latin characters outnumber Hangul.
  "ADR과 RevPAR, GOP 지표는 Cushman & Wakefield 기준입니다",
  "NOI 대비 CAPEX",
  // English contaminated by a stray Hangul token — must NOT resolve to Korean.
  // A single Korean place name inside English speech used to flip the source.
  "the 명동 asset traded at a premium",
  "we toured 명 last week",
  // Below the signal-character floor: undecidable.
  "OK",
  "ADR",
  "",
  "   ",
  "12,345",
  // Ties and low-confidence mixes.
  "abc 가나",
  "Seoul 서울 Tokyo 도쿄",
];

test("gateway source-language detection matches the desktop engine exactly", () => {
  for (const text of DETECTION_BATTERY) {
    assert.equal(
      gatewayDetect(text),
      desktopDetect(text),
      `divergence on: "${text}"`,
    );
  }
});

test("gateway detection honors the desktop's Korean count AND ratio thresholds", () => {
  // Fewer than 3 Hangul characters is contamination, not Korean speech.
  assert.equal(gatewayDetect("we visited 명동 and the 강남 office"), desktopDetect("we visited 명동 and the 강남 office"));
  // Enough Hangul, and a high enough ratio, is genuine Korean.
  assert.equal(gatewayDetect("강남 오피스 공실률은 안정적입니다"), "ko");
  // Long English with a couple of Hangul characters stays English.
  assert.equal(gatewayDetect("the tenant representation mandate for the 명동 tower was signed"), "en");
});

test("the output-language gate demands the target language be PRESENT, not dominant", () => {
  // A Korean caption legitimately carries English proper nouns and acronyms
  // whose Latin characters outnumber the Hangul; a dominance test wrongly
  // suppressed these, which is why the gate counts presence instead.
  assert.equal(isOutputInTargetLanguage("Cushman & Wakefield Korea의 ADR은 상승했습니다", "ko"), true);
  assert.equal(isOutputInTargetLanguage("KRW 300 billion 규모입니다", "ko"), true);
  // Raw English on a Korean lane has zero Hangul — this is the fail-open
  // passthrough that produced the 한글↔영어 flip-flop, and it must be rejected.
  assert.equal(isOutputInTargetLanguage("The deal closed at KRW 300 billion.", "ko"), false);
  assert.equal(isOutputInTargetLanguage("We will review the office market.", "ko"), false);
  // Korean text on an English lane is equally wrong.
  assert.equal(isOutputInTargetLanguage("오늘 오피스 시장을 살펴보겠습니다", "en"), false);
  // Correct English output on the English lane passes.
  assert.equal(isOutputInTargetLanguage("The deal closed at KRW 300 billion.", "en"), true);
  // Too short to judge → lenient, exactly like the desktop.
  assert.equal(isOutputInTargetLanguage("OK", "ko"), true);
  assert.equal(isOutputInTargetLanguage("네", "ko"), true);
  assert.equal(isOutputInTargetLanguage("", "ko"), true);
  // Non ko/en lanes use their own script.
  assert.equal(isOutputInTargetLanguage("ソウルのオフィス市場を見ていきます", "ja"), true);
  assert.equal(isOutputInTargetLanguage("The Seoul office market outlook", "ja"), false);
});

test("source-lane passthrough requires the text to agree with the STT language", () => {
  // Honest passthrough: English speech, English lane, English text.
  assert.equal(sourceLaneMatches("We will review the office market today", "en", "en"), true);
  // Korean speech on the Korean lane.
  assert.equal(sourceLaneMatches("서울 오피스 시장을 살펴보겠습니다", "ko", "ko"), true);
  // A different lane never passes through, however confident the STT is.
  assert.equal(sourceLaneMatches("We will review the office market today", "en", "ko"), false);
  // The contamination case: STT mislabels English-with-one-Korean-word as
  // Korean. textPlausiblyInLanguage said "there is Hangul, so it is Korean" and
  // published the English verbatim on the KO lane. Detection must overrule it.
  assert.equal(sourceLaneMatches("the 명동 asset traded at a premium", "ko", "ko"), false);
  // Short text is undecidable, so stay lenient and keep the STT's own label —
  // suppressing "네" or "OK" would blank the feed during back-channel speech.
  assert.equal(sourceLaneMatches("네", "ko", "ko"), true);
  assert.equal(sourceLaneMatches("OK", "en", "en"), true);
  // No STT language at all is never a source lane.
  assert.equal(sourceLaneMatches("anything at all here", "", "en"), false);
});
