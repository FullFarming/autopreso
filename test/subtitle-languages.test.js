import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  LIVE_INTERPRETER_LANGUAGE_OPTIONS,
  LIVE_INTERPRETER_LANGUAGE_RULES,
  LIVE_INTERPRETER_LANGUAGES as BROWSER_INTERPRETER_LANGUAGES,
  SUBTITLE_LANGUAGES as BROWSER_SUBTITLE_LANGUAGES,
  normalizeLiveInterpreterLanguageCode,
} from "../public/subtitle-language-catalog.js";

import {
  MAX_TRANSLATION_LANGUAGES,
  SUBTITLE_LANGUAGES,
  isSupportedSubtitleLanguage,
  normalizeSubtitleLanguageCode,
  resolveConfiguredLanguageForScript,
  toGeminiLanguageCode,
  subtitleLanguageCharPattern,
  subtitleLanguageLabel,
} from "../src/subtitle-languages.js";

test("browser catalog is the same immutable 14-language source re-exported by Node", () => {
  assert.equal(SUBTITLE_LANGUAGES, BROWSER_SUBTITLE_LANGUAGES);
  assert.equal(Object.isFrozen(SUBTITLE_LANGUAGES), true);
  assert.deepEqual(SUBTITLE_LANGUAGES.map(({ code }) => code), [
    "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "pt", "fr", "de", "ru", "hi", "id", "vi", "it",
  ]);
  for (const language of SUBTITLE_LANGUAGES) {
    assert.equal(Object.isFrozen(language), true);
    assert.equal(Object.isFrozen(language.aliases), true);
  }
});

test("catalog preserves canonical aliases, scripts, and every Gemini mapping", () => {
  assert.deepEqual(
    SUBTITLE_LANGUAGES.map(({ code, script, aliases }) => ({ code, script, aliases: [...aliases] })),
    [
      { code: "en", script: "latin-basic", aliases: ["english", "eng", "en-us", "en-gb"] },
      { code: "ko", script: "hangul", aliases: ["korean", "kor", "ko-kr"] },
      { code: "ja", script: "japanese", aliases: ["japanese", "jpn", "jp", "ja-jp"] },
      { code: "zh-Hans", script: "han", aliases: ["zh", "zh-cn", "cmn-hans-cn", "chinese", "chinese simplified", "zho", "cmn"] },
      { code: "zh-Hant", script: "han", aliases: ["zh-tw", "zh-hk", "cmn-hant-tw", "chinese traditional"] },
      { code: "es", script: "latin", aliases: ["spanish", "spa"] },
      { code: "pt", script: "latin", aliases: ["portuguese", "por"] },
      { code: "fr", script: "latin", aliases: ["french", "fra"] },
      { code: "de", script: "latin", aliases: ["german", "deu"] },
      { code: "ru", script: "cyrillic", aliases: ["russian", "rus"] },
      { code: "hi", script: "devanagari", aliases: ["hindi", "hin"] },
      { code: "id", script: "latin", aliases: ["indonesian", "ind"] },
      { code: "vi", script: "latin", aliases: ["vietnamese", "vie"] },
      { code: "it", script: "latin", aliases: ["italian", "ita"] },
    ],
  );
  assert.deepEqual(
    Object.fromEntries(SUBTITLE_LANGUAGES.map(({ code }) => [code, toGeminiLanguageCode(code)])),
    {
      en: "en", ko: "ko", ja: "ja", "zh-Hans": "zh-Hans", "zh-Hant": "zh-Hant",
      es: "es", pt: "pt-BR", fr: "fr", de: "de", ru: "ru", hi: "hi", id: "id", vi: "vi", it: "it",
    },
  );
});

test("Interpreter targets derive from explicit catalog rules without widening the 13-code allowlist", () => {
  assert.deepEqual([...BROWSER_INTERPRETER_LANGUAGES], [
    "es", "pt", "fr", "ja", "ru", "zh", "de", "ko", "hi", "id", "vi", "it", "en",
  ]);
  const catalogCodes = new Set(SUBTITLE_LANGUAGES.map(({ code }) => code));
  assert.equal(LIVE_INTERPRETER_LANGUAGE_RULES.every(({ catalogCode }) => catalogCodes.has(catalogCode)), true);
  assert.equal(LIVE_INTERPRETER_LANGUAGE_RULES.find(({ code }) => code === "zh")?.catalogCode, "zh-Hans");
  assert.deepEqual(LIVE_INTERPRETER_LANGUAGE_OPTIONS.map(({ code }) => code), [...BROWSER_INTERPRETER_LANGUAGES]);
  for (const rejected of ["zh-Hans", "zh-Hant", "english", "en-US", "xx", "", null]) {
    assert.equal(normalizeLiveInterpreterLanguageCode(rejected), "", String(rejected));
  }
  assert.equal(normalizeLiveInterpreterLanguageCode(" EN\u0000 "), "");
  assert.equal(normalizeLiveInterpreterLanguageCode(" EN "), "en");
});

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
  assert.equal(normalizeSubtitleLanguageCode(" EN\u0000 "), "");
  assert.equal(normalizeSubtitleLanguageCode("klingon"), "");
  assert.equal(normalizeSubtitleLanguageCode(""), "");
});

test("browser catalog stays a pure ESM data module", async () => {
  const source = await readFile(new URL("../public/subtitle-language-catalog.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:|\bprocess\b|\bBuffer\b|\bwindow\b|\bdocument\b|localStorage|sessionStorage|indexedDB/u);
  assert.doesNotMatch(source, /fetch\s*\(|WebSocket|XMLHttpRequest/u);
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

test("Gemini provider mappings preserve both Chinese writing systems", () => {
  assert.equal(toGeminiLanguageCode("zh-Hans"), "zh-Hans");
  assert.equal(toGeminiLanguageCode("zh-Hant"), "zh-Hant");
  assert.equal(toGeminiLanguageCode("ko"), "ko");
});
