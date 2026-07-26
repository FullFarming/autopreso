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
