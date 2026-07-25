import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_TRANSLATION_LANGUAGES,
  SUBTITLE_LANGUAGES,
  isSupportedSubtitleLanguage,
  normalizeSubtitleLanguageCode,
  resolveConfiguredLanguageForScript,
  toGeminiLanguageCode,
  toOpenAITranslationLanguageCode,
  subtitleLanguageCharPattern,
  subtitleLanguageLabel,
} from "../src/subtitle-languages.js";

test("registry keeps the core en/ko/ja languages first", () => {
  assert.deepEqual(SUBTITLE_LANGUAGES.slice(0, 3).map((l) => l.code), ["en", "ko", "ja"]);
});

test("registry supports additional output languages", () => {
  for (const code of ["zh-Hans", "zh-Hant", "es", "fr", "de", "pt", "ru", "hi", "vi", "id", "it"]) {
    assert.equal(isSupportedSubtitleLanguage(code), true, `expected ${code} supported`);
  }
  assert.equal(isSupportedSubtitleLanguage("xx"), false);
});

test("normalizeSubtitleLanguageCode accepts codes, labels, and aliases", () => {
  assert.equal(normalizeSubtitleLanguageCode("en"), "en");
  assert.equal(normalizeSubtitleLanguageCode("English"), "en");
  assert.equal(normalizeSubtitleLanguageCode("korean"), "ko");
  assert.equal(normalizeSubtitleLanguageCode("japanese"), "ja");
  assert.equal(normalizeSubtitleLanguageCode("chinese"), "zh-Hans");
  assert.equal(normalizeSubtitleLanguageCode("spanish"), "es");
  assert.equal(normalizeSubtitleLanguageCode(" ZH "), "zh-Hans");
  assert.equal(normalizeSubtitleLanguageCode("zh-TW"), "zh-Hant");
  assert.equal(normalizeSubtitleLanguageCode("klingon"), "");
  assert.equal(normalizeSubtitleLanguageCode(""), "");
});

test("labels resolve for every supported language", () => {
  assert.equal(subtitleLanguageLabel("en"), "English");
  assert.equal(subtitleLanguageLabel("zh-Hant"), "Chinese (Traditional)");
  // Unknown codes echo back so prompts never break.
  assert.equal(subtitleLanguageLabel("xx"), "xx");
});

test("char patterns keep the exact legacy en/ko/ja behavior", () => {
  assert.equal(subtitleLanguageCharPattern("en").test("a"), true);
  assert.equal(subtitleLanguageCharPattern("en").test("é"), false); // legacy ENGLISH_CHAR
  assert.equal(subtitleLanguageCharPattern("ko").test("한"), true);
  assert.equal(subtitleLanguageCharPattern("ja").test("あ"), true);
  assert.equal(subtitleLanguageCharPattern("ja").test("漢"), true); // CJK counts toward ja
});

test("char patterns cover new scripts", () => {
  assert.equal(subtitleLanguageCharPattern("zh-Hans").test("中"), true);
  assert.equal(subtitleLanguageCharPattern("ru").test("д"), true);
  assert.equal(subtitleLanguageCharPattern("hi").test("ह"), true);
  assert.equal(subtitleLanguageCharPattern("es").test("ñ"), true);
  assert.equal(subtitleLanguageCharPattern("vi").test("ữ"), true);
});

test("resolveConfiguredLanguageForScript maps a detected language onto the configured set", () => {
  // Spanish speech is script-detected as "en" (Latin); with es as the only
  // configured Latin language, the source resolves to es.
  assert.equal(resolveConfiguredLanguageForScript("en", ["es", "ko"]), "es");
  // Detected language already configured → itself.
  assert.equal(resolveConfiguredLanguageForScript("en", ["en", "ko"]), "en");
  // Ambiguous (two Latin languages configured) → no resolution.
  assert.equal(resolveConfiguredLanguageForScript("en", ["es", "fr"]), "");
  // No script match → no resolution.
  assert.equal(resolveConfiguredLanguageForScript("ko", ["en", "ja"]), "");
  assert.equal(resolveConfiguredLanguageForScript("unknown", ["en", "ko"]), "");
});

test("translation language cap is exactly three", () => {
  assert.equal(MAX_TRANSLATION_LANGUAGES, 3);
});

test("provider mappings preserve both Chinese writing systems", () => {
  assert.equal(toGeminiLanguageCode("zh-Hans"), "zh-Hans");
  assert.equal(toGeminiLanguageCode("zh-Hant"), "zh-Hant");
  assert.equal(toGeminiLanguageCode("ko"), "ko");
  assert.equal(toOpenAITranslationLanguageCode("zh-Hans"), "zh");
  assert.equal(toOpenAITranslationLanguageCode("zh-Hant"), "zh");
  assert.equal(toOpenAITranslationLanguageCode("it"), "it");
});
