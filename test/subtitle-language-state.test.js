import assert from "node:assert/strict";
import test from "node:test";

import { createSubtitleLanguageState } from "../src/subtitle-language-state.js";

test("strong transcript script overrides a contradictory provider languageCode", () => {
  const korean = createSubtitleLanguageState();
  const koreanResult = korean.observe({
    providerLanguage: "en",
    transcript: "이제 국내 호텔 시장을 살펴보겠습니다",
  });
  assert.equal(koreanResult.language, "ko");
  assert.equal(koreanResult.isStrong, true);

  const english = createSubtitleLanguageState();
  const englishResult = english.observe({
    providerLanguage: "ko",
    transcript: "We will now review the domestic hotel market",
  });
  assert.equal(englishResult.language, "en");
  assert.equal(englishResult.isStrong, true);
});

test("one or two signal characters retain the utterance lock but provider can seed an empty lock", () => {
  const state = createSubtitleLanguageState();
  assert.equal(state.observe({ providerLanguage: "en-US", transcript: "I" }).language, "en");
  assert.equal(state.observe({ providerLanguage: "ko", transcript: "가" }).language, "en");

  state.reset();
  assert.equal(state.observe({ providerLanguage: "ko-KR", transcript: "가" }).language, "ko");
});

test("provider language codes are allowlisted and Latin-family codes remain specific", () => {
  const invalid = createSubtitleLanguageState();
  assert.equal(invalid.observe({ providerLanguage: "en<script>", transcript: "I" }).language, "unknown");

  const spanish = createSubtitleLanguageState();
  assert.equal(
    spanish.observe({ providerLanguage: "es-MX", transcript: "Vamos a revisar el mercado hotelero" }).language,
    "es",
  );
});

test("a short proper noun does not replace an existing utterance lock", () => {
  const state = createSubtitleLanguageState();
  state.observe({ providerLanguage: "ko", transcript: "국내 상업용 부동산 시장입니다" });

  const result = state.observe({ providerLanguage: "en", transcript: "Cushman & Wakefield" });
  assert.equal(result.language, "ko");
  assert.equal(result.isStrong, false);
});

test("reset starts a new utterance and permits EN to KO to EN switching immediately", () => {
  const state = createSubtitleLanguageState();
  assert.equal(state.observe({ providerLanguage: "ko", transcript: "Good morning and welcome to the session" }).language, "en");

  state.reset();
  assert.equal(state.observe({ providerLanguage: "en", transcript: "이제 국내 시장을 살펴보겠습니다" }).language, "ko");

  state.reset();
  assert.equal(state.observe({ providerLanguage: "ko", transcript: "Let us continue with the next agenda item" }).language, "en");
});
