import assert from "node:assert/strict";
import test from "node:test";

import { createSourceLanguageState } from "../src/source-language-state.js";

test("a strong Korean source lock survives English terms and provider flips", () => {
  const state = createSourceLanguageState();
  assert.equal(state.observe({ providerLanguage: "ko-KR", transcript: "국내 상업용 부동산 시장입니다" }), "ko");
  assert.equal(state.observe({ providerLanguage: "en-US", transcript: "국내 CRE market Cushman & Wakefield 임대료입니다" }), "ko");
  assert.equal(state.observe({ providerLanguage: "en-US", transcript: "This later provider sample looks strongly English" }), "ko");
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

test("a Japanese provider hint disambiguates kanji-only text from Chinese", () => {
  const state = createSourceLanguageState();
  assert.equal(state.observe({ providerLanguage: "ja-JP", transcript: "東京都庁" }), "ja");
});

// The captions engine (src/subtitle-realtime.js) is the reference. These pin the
// thresholds to it, because the gateway drifted later on both languages and that
// drift is what changes which language a caption is attributed to.
test("thresholds match the captions engine rather than the gateway's old ones", () => {
  // KOREAN_MIX_MIN_CHARS is 3: three Hangul chars are enough, where the gateway
  // used to demand four.
  assert.equal(createSourceLanguageState().observe({ transcript: "회복세" }), "ko");

  // LANGUAGE_LOCK_MIN_SIGNAL_CHARS 4 at LANGUAGE_LOCK_MIN_CONFIDENCE 0.68: four
  // Latin chars suffice, where the gateway used to demand eight at 0.78.
  assert.equal(createSourceLanguageState().observe({ transcript: "Cost" }), "en");

  // Mixed Korean+English is judged ko/(ko+en), the way captions judges it, so a
  // Korean sentence carrying an English term still locks Korean.
  assert.equal(
    createSourceLanguageState().observe({ transcript: "이 자산의 caprate 전망은 회복세입니다" }),
    "ko",
  );

  // A capitalised English phrase locks English: the gateway-only proper-noun
  // carve-out pushed these down the weak path, which captions has no equivalent of.
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
