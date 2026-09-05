import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { findLanguages, removeSourceLanguage, updateLanguageSelection, withRequiredLanguages } from "./language-picker";

test("language search accepts Korean, English, codes and native names", () => {
  for (const query of ["한국어", "korean", "ＫＯ", "  ko  ", "한국어"]) {
    assert.deepEqual(findLanguages(query, []).map((language) => language.code), ["ko"]);
  }
  assert.deepEqual(findLanguages("日本語", []).map((language) => language.code), ["ja"]);
  assert.deepEqual(findLanguages("français", []).map((language) => language.code), ["fr"]);
  assert.deepEqual(findLanguages("zh-hant", []).map((language) => language.code), ["zh-Hant"]);
});

test("search stays collapsed without a query and excludes selected/source languages", () => {
  assert.deepEqual(findLanguages("   ", []), []);
  assert.deepEqual(findLanguages("korean", ["ko"]), []);
  assert.deepEqual(findLanguages("korean", [], ["ko"]), []);
  assert.deepEqual(findLanguages("<script>alert(1)</script>", []), []);
  assert.deepEqual(findLanguages("🎉".repeat(100), []), []);
});

test("repeated queued adds cannot duplicate a language or exceed the host limit", () => {
  const limits = { minSelection: 1, maxSelection: 3 };
  const original = ["en"];
  let current = updateLanguageSelection(original, "ko", "add", limits);
  current = updateLanguageSelection(current, "ko", "add", limits);
  current = updateLanguageSelection(current, "ja", "add", limits);
  current = updateLanguageSelection(current, "fr", "add", limits);
  assert.deepEqual(current, ["en", "ko", "ja"]);
  assert.deepEqual(original, ["en"]);
});

test("host's final selected language cannot be removed and unknown additions are rejected", () => {
  const limits = { minSelection: 1, maxSelection: 3 };
  assert.deepEqual(updateLanguageSelection(["en"], "en", "remove", limits), ["en"]);
  assert.deepEqual(updateLanguageSelection(["en", "ko"], "ko", "remove", limits), ["en"]);
  assert.deepEqual(updateLanguageSelection(["en"], "bogus", "add", limits), ["en"]);
  assert.deepEqual(updateLanguageSelection(["en"], "ko", "add", { ...limits, excludedLanguages: ["ko"] }), ["en"]);
});

test("glossary allows many targets but source changes remove a conflicting selection", () => {
  let current = ["en", "ja", "fr"];
  current = updateLanguageSelection(current, "de", "add", { minSelection: 1, maxSelection: 14, excludedLanguages: ["ko"] });
  assert.deepEqual(current, ["en", "ja", "fr", "de"]);
  assert.deepEqual(removeSourceLanguage(current, "en"), ["ja", "fr", "de"]);
  assert.deepEqual(removeSourceLanguage(["en"], "en"), []);
  assert.deepEqual(current, ["en", "ja", "fr", "de"]);
});

test("required caption languages remain selected and count toward the three-language limit", () => {
  const limits = { minSelection: 1, maxSelection: 3, requiredLanguages: ["en", "ko"] };
  assert.deepEqual(updateLanguageSelection(["en", "ko"], "ko", "remove", limits), ["en", "ko"]);
  assert.deepEqual(updateLanguageSelection(["en"], "ja", "add", limits), ["en", "ko", "ja"]);
  assert.deepEqual(updateLanguageSelection(["en", "ko", "ja"], "fr", "add", limits), ["en", "ko", "ja"]);
  assert.deepEqual(updateLanguageSelection(["en", "ko", "ja"], "ja", "remove", limits), ["en", "ko"]);
});

test("restoring legacy language choices does not silently discard them to fit the limit", () => {
  const restored = withRequiredLanguages(["ja", "fr", "de"], ["en", "ko"]);
  assert.deepEqual(restored, ["ja", "fr", "de", "en", "ko"]);
  assert.deepEqual(withRequiredLanguages(["en", "ko"], ["en", "ko"]), ["en", "ko"]);
});


test("host selection preserves exactly one Japanese lane or three selected languages", () => {
  const limits = { minSelection: 1, maxSelection: 3 };
  let selected = ["en", "ko"];
  selected = updateLanguageSelection(selected, "ja", "add", limits);
  selected = updateLanguageSelection(selected, "ko", "remove", limits);
  selected = updateLanguageSelection(selected, "en", "remove", limits);
  assert.deepEqual(selected, ["ja"]);
  selected = updateLanguageSelection(selected, "zh-Hans", "add", limits);
  selected = updateLanguageSelection(selected, "en", "add", limits);
  assert.deepEqual(selected, ["ja", "zh-Hans", "en"]);
  const host = readFileSync(new URL("./LiveHostDashboard.tsx", import.meta.url), "utf8");
  assert.match(host, /const languages = selectedLanguages;/);
  assert.doesNotMatch(host, /requiredLanguages=|withRequiredLanguages|REQUIRED_SESSION_LANGUAGES/);
});
