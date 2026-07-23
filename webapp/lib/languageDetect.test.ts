import assert from "node:assert/strict";
import test from "node:test";

import { createSpokenLanguageState, detectSourceLanguage, isTargetLanguageText, normalizeLanguageCode, resolveLanguageEvidence, toGeminiLanguageCode, toOpenAITranslationLanguageCode } from "./languageDetect";

test("source detection keeps English speech English when it contains a Korean name", () => {
  assert.equal(detectSourceLanguage("We met 김민수 at the Seoul office yesterday"), "en");
});

test("source detection keeps Korean speech Korean when it contains ADR and GOP", () => {
  assert.equal(detectSourceLanguage("오늘 ADR과 GOP를 함께 검토하겠습니다"), "ko");
  assert.equal(isTargetLanguageText("ADR과 GOP를 검토합니다", "ko"), true);
});

test("provider and script evidence hold contradictory short fragments until they are judgeable", () => {
  assert.equal(resolveLanguageEvidence("안", "en"), "unknown");
  assert.equal(resolveLanguageEvidence("안녕하십니까", "en"), "ko");
  assert.equal(resolveLanguageEvidence("Hel", "en"), "en");
});

test("spoken-language state switches EN to KO immediately on fresh script evidence", () => {
  const state = createSpokenLanguageState();
  assert.equal(state.rememberDelta("Good morning everyone", "en"), "en");
  assert.equal(state.rememberDelta("오늘 ADR과 GOP를 검토합니다", "ko"), "ko");
  assert.equal(state.resolved(), "ko");
});

test("spoken-language state switches KO to EN and ignores a contradictory provider code", () => {
  const state = createSpokenLanguageState();
  assert.equal(state.rememberSnapshot("오늘 회의를 시작합니다", "", "ko"), "ko");
  assert.equal(state.rememberSnapshot("We will now review the hotel pipeline", "오늘 회의를 시작합니다", "ko"), "en");
  assert.equal(state.resolved(), "en");
});

test("spoken-language state accumulates one-character deltas before switching EN to KO", () => {
  const state = createSpokenLanguageState();
  assert.equal(state.rememberDelta("Good morning", "en"), "en");
  assert.equal(state.rememberDelta("안"), "en");
  assert.equal(state.rememberDelta("녕", "en"), "en");
  assert.equal(state.rememberDelta("하"), "en");
  assert.equal(state.rememberDelta("세", "en"), "ko");
  assert.equal(state.rememberDelta("요", "ko"), "ko");
});

test("spoken-language state accumulates one-character deltas before switching KO to EN", () => {
  const state = createSpokenLanguageState();
  assert.equal(state.rememberDelta("안녕하세요", "ko"), "ko");
  assert.equal(state.rememberDelta("H"), "ko");
  assert.equal(state.rememberDelta("e"), "ko");
  assert.equal(state.rememberDelta("l"), "ko");
  assert.equal(state.rememberDelta("l"), "en");
  assert.equal(state.rememberDelta("o"), "en");
});

test("spoken-language state reset clears both the lock and pending character evidence", () => {
  const state = createSpokenLanguageState();
  assert.equal(state.rememberDelta("Good morning", "en"), "en");
  assert.equal(state.rememberDelta("안"), "en");
  assert.equal(state.rememberDelta("녕"), "en");
  state.reset();
  assert.equal(state.rememberDelta("하"), "unknown");
  assert.equal(state.rememberDelta("세"), "unknown");
  assert.equal(state.rememberDelta("요"), "unknown");
  assert.equal(state.rememberDelta("안"), "ko");
});

test("target gate accepts Korean output with English-heavy brand names and acronyms", () => {
  assert.equal(isTargetLanguageText("Cushman & Wakefield Korea의 ADR은 82%입니다", "ko"), true);
});

test("web language contract exposes fourteen canonical choices and provider mappings", () => {
  for (const code of ["en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "pt", "fr", "de", "ru", "hi", "id", "vi", "it"] as const) {
    assert.equal(normalizeLanguageCode(code), code);
  }
  assert.equal(normalizeLanguageCode("zh-CN"), "zh-Hans");
  assert.equal(normalizeLanguageCode("zh-TW"), "zh-Hant");
  for (const [alias, canonical] of [
    ["en-AU", "en"], ["en-CA", "en"], ["zh-SG", "zh-Hans"], ["zh-MO", "zh-Hant"],
    ["es-ES", "es"], ["es-MX", "es"], ["pt-BR", "pt"], ["pt-PT", "pt"],
    ["fr-FR", "fr"], ["fr-CA", "fr"], ["de-DE", "de"], ["ru-RU", "ru"],
    ["hi-IN", "hi"], ["id-ID", "id"], ["vi-VN", "vi"], ["it-IT", "it"],
  ] as const) {
    assert.equal(normalizeLanguageCode(`  ${alias.toUpperCase()}  `), canonical);
  }
  assert.equal(toGeminiLanguageCode("ko"), "ko-KR");
  assert.equal(toGeminiLanguageCode("zh-Hant"), "zh-Hant");
  assert.equal(toOpenAITranslationLanguageCode("zh-Hans"), "zh");
});

test("speaker boundary clears ambiguous fragments before the next speaker language", () => {
  const state = createSpokenLanguageState();
  assert.equal(state.rememberDelta("Good morning everyone", "en-US"), "en");
  assert.equal(state.rememberDelta("안"), "en");
  state.resetForSpeakerBoundary();
  assert.equal(state.rememberDelta("本日はよろしくお願いします", "ja-JP"), "ja");
});

test("four alternating speakers route into three distinct concurrent target channels", () => {
  const state = createSpokenLanguageState();
  const targets = ["en", "ko", "ja"] as const;
  const speakers = [
    { text: "오늘 호텔 시장을 설명합니다", provider: "ko-KR", language: "ko" },
    { text: "We now discuss the office market", provider: "en-US", language: "en" },
    { text: "本日はホテル投資について説明します", provider: "ja-JP", language: "ja" },
    { text: "我们现在讨论酒店投资市场", provider: "cmn-Hans-CN", language: "zh-Hans" },
  ] as const;
  const routes: string[][] = [];
  for (const speaker of speakers) {
    state.resetForSpeakerBoundary();
    const detected = state.rememberDelta(speaker.text, speaker.provider);
    assert.equal(detected, speaker.language);
    routes.push(targets.filter((target) => target !== detected));
  }
  assert.deepEqual(routes, [["en", "ja"], ["ko", "ja"], ["en", "ko"], ["en", "ko", "ja"]]);
});
