import assert from "node:assert/strict";
import test from "node:test";

import { createSourceLanguageState } from "../src/source-language-state.js";

test("caption-only strong script evidence may correct the current utterance language", () => {
  const state = createSourceLanguageState();
  assert.equal(state.observe({ providerLanguage: "ko-KR", transcript: "국내 상업용 부동산 시장입니다" }), "ko");
  assert.equal(state.observe({ providerLanguage: "en-US", transcript: "국내 CRE market Cushman & Wakefield 임대료입니다" }), "ko");
  assert.equal(state.observe({ providerLanguage: "en-US", transcript: "This later provider sample looks strongly English" }), "en");
});

test("the first strong script may correct a weak provider seed", () => {
  const state = createSourceLanguageState();
  assert.equal(state.observe({ providerLanguage: "en-US", transcript: "C&W" }), "en");
  assert.equal(state.observe({ providerLanguage: "en-US", transcript: "C&W의 국내 임대료를 설명하겠습니다" }), "ko");
});

test("reset permits the next utterance to switch from Korean to English", () => {
  const state = createSourceLanguageState();
  assert.equal(state.observe({ providerLanguage: "en-US", transcript: "한국어 문장으로 시작합니다" }), "ko");
  state.reset();
  assert.equal(state.observe({ providerLanguage: "ko-KR", transcript: "We will continue with the next agenda item" }), "en");
});

test("a short proper noun cannot flip an established source lock", () => {
  const state = createSourceLanguageState();
  assert.equal(state.observe({ providerLanguage: "ko-KR", transcript: "국내 호텔 시장을 설명합니다" }), "ko");
  assert.equal(state.observe({ providerLanguage: "en-US", transcript: "Cushman & Wakefield" }), "ko");
});

test("non-string provider evidence is rejected without coercion", () => {
  const state = createSourceLanguageState();
  assert.equal(state.observe({ providerLanguage: { toString() { throw new Error("must not run"); } }, transcript: {} }), "");
});

test("kanji-only text follows the caption-only Han-script decision", () => {
  const state = createSourceLanguageState();
  assert.equal(state.observe({ providerLanguage: "ja-JP", transcript: "東京都庁" }), "zh-Hans");
});

// The captions-only per-channel state is the reference. Its conservative strong
// lock protects short CRE names from being mistaken for a direction change.
test("thresholds match the captions-only per-channel language state", () => {
  assert.equal(createSourceLanguageState().observe({ transcript: "회복세" }), "ko");
  assert.equal(createSourceLanguageState().observe({ transcript: "Cost" }), "en");

  // Mixed Korean+English is judged ko/(ko+en), the way captions judges it, so a
  // Korean sentence carrying an English term still locks Korean.
  assert.equal(
    createSourceLanguageState().observe({ transcript: "이 자산의 caprate 전망은 회복세입니다" }),
    "ko",
  );

  // With no earlier lock a proper noun can seed a weak English decision, but it
  // cannot replace an established Korean utterance lock.
  assert.equal(createSourceLanguageState().observe({ transcript: "Cushman Wakefield Korea" }), "en");
});

test("ambiguous text abstains instead of defaulting to English", () => {
  // Captions returns "unknown" below its thresholds and displays nothing. The old
  // ladder guessed English, and a wrong lock silently blanks a lane through the
  // sourceLanguage === language suppression.
  assert.equal(createSourceLanguageState().observe({ transcript: "ok" }), "");
  assert.equal(createSourceLanguageState().observe({ transcript: "..." }), "");

  // Abstaining never overrides the provider's own languageCode, which Google
  // documents as the reliable half of the signal.
  assert.equal(createSourceLanguageState().observe({ providerLanguage: "ko", transcript: "ok" }), "ko");
});
