import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SYSTEM_LANGUAGE, SYSTEM_LANGUAGES, SYSTEM_LANGUAGE_LABELS,
  SYSTEM_LANGUAGE_STORAGE_KEY, normalizeSystemLanguage,
} from "../public/system-language.js";

test("system languages use Korean by default and native labels for three explicit choices", () => {
  assert.equal(DEFAULT_SYSTEM_LANGUAGE, "ko");
  assert.deepEqual(SYSTEM_LANGUAGES, ["ko", "en", "ja"]);
  assert.deepEqual(SYSTEM_LANGUAGE_LABELS, { ko: "한국어", en: "English", ja: "日本語" });
  assert.equal(SYSTEM_LANGUAGE_STORAGE_KEY, "realtime-noel-ui-language");
  assert.equal(Object.isFrozen(SYSTEM_LANGUAGES), true);
});

test("stored language accepts only exact supported values without guessing the OS or subtitle language", () => {
  for (const value of [null, undefined, {}, ["ja"], "fr", "ko-KR", "<script>", "__proto__", "en\n"]) {
    assert.equal(normalizeSystemLanguage(value), null);
  }
  for (const value of SYSTEM_LANGUAGES) assert.equal(normalizeSystemLanguage(value), value);
});
