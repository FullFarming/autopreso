import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatSystemText, isSystemLanguage, normalizeSystemLanguage, readStoredSystemLanguage, SYSTEM_LANGUAGE_STORAGE_KEY } from "../../lib/system-language";
import { commonMessages } from "../../lib/dictionaries/common";
import { demoMessages } from "../../app/m/watch/demo/demo-messages";

test("system language accepts only three exact interface locale codes", () => {
  for (const language of ["ko", "en", "ja"]) assert.equal(isSystemLanguage(language), true);
  for (const value of [null, undefined, "", "EN", "en-US", "zh", " ko ", "<script>", {}, 0]) {
    assert.equal(isSystemLanguage(value), false);
    assert.equal(normalizeSystemLanguage(value), "ko");
  }
  assert.equal(SYSTEM_LANGUAGE_STORAGE_KEY, "realtime-noel-ui-language");
});

test("stored interface language is independent from caption and session preferences", () => {
  const calls: string[] = [];
  const storage = { getItem: (key: string) => { calls.push(key); return "ja"; } };
  assert.equal(readStoredSystemLanguage(storage, "en"), "ja");
  assert.deepEqual(calls, [SYSTEM_LANGUAGE_STORAGE_KEY]);
  assert.equal(readStoredSystemLanguage({ getItem: () => null }, "en"), "en");
  assert.equal(readStoredSystemLanguage({ getItem: () => "fr" }, "en"), "en");
  assert.throws(() => readStoredSystemLanguage({ getItem: () => { throw new Error("blocked"); } }, "ko"), /blocked/u);
});

test("dictionary messages interpolate literal values and preserve missing placeholders", () => {
  const messages = { ko: { greeting: "안녕하세요, {name}. {count}개", onlyKorean: "기본 문구" }, en: { greeting: "Hello, {name}. {count} items" }, ja: { greeting: "こんにちは、{name}。{count}件" } };
  assert.equal(formatSystemText(messages, "en", "greeting", { name: "<b>Kim</b>", count: 0 }), "Hello, <b>Kim</b>. 0 items");
  assert.equal(formatSystemText(messages, "ja", "greeting"), "こんにちは、{name}。{count}件");
  assert.equal(formatSystemText(messages, "en", "onlyKorean"), "기본 문구");
  assert.equal(formatSystemText(messages, "en", "unknown"), "unknown");
  for (const locale of ["ko", "en", "ja"] as const) assert.deepEqual(Object.keys(commonMessages[locale]), Object.keys(commonMessages.ko));
  for (const locale of ["ko", "en", "ja"] as const) assert.deepEqual(Object.keys(demoMessages[locale]), Object.keys(demoMessages.ko));
  assert.equal(formatSystemText(demoMessages, "en", "회의 종료 {time} · 종료 후 6시간", { time: "14:00" }), "Meeting ended at 14:00 · available for six hours");
});

test("provider does not remount live children or call network and the menu preserves native names", () => {
  const provider = readFileSync(new URL("./SystemLanguageProvider.tsx", import.meta.url), "utf8");
  const button = readFileSync(new URL("./SystemLanguageButton.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("./SystemLanguageShell.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(provider, /\bfetch\s*\(|location\.reload|router\.refresh|key=\{language\}|innerHTML|textContent/u);
  assert.match(provider, /document\.documentElement\.lang/u);
  assert.match(provider, /addEventListener\("storage"/u);
  assert.match(provider, /const stored = localStorage\.getItem\(SYSTEM_LANGUAGE_STORAGE_KEY\)/u);
  assert.doesNotMatch(provider, /normalizeSystemLanguage\(event\.newValue\)/u);
  assert.match(button, /SYSTEM_LANGUAGE_LABELS\[option\]/u);
  assert.match(button, /role="menuitemradio"/u);
  assert.match(button, /aria-checked=/u);
  assert.match(button, /event\.key === "Escape"/u);
  assert.match(shell, /\/\^\\\/stage\\\//u);
});

test("localized accessible labels do not control participant layout", () => {
  const styles = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  assert.doesNotMatch(styles, /\[aria-label="(?:자막 언어|실시간 자막 제어|실시간 번역 도구)"\]/u);
  assert.match(styles, /\.viewer-notebook > \[role="toolbar"\]/u);
  assert.match(styles, /section:has\(> \[role="tablist"\]\)/u);
});
