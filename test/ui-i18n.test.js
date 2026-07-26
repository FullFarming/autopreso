import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_UI_LANGUAGE,
  MENU_KEYS,
  MESSAGES,
  SUPPORTED_UI_LANGUAGES,
  UI_LANGUAGE_STORAGE_KEY,
  applyTranslations,
  getLanguage,
  normalizeLanguage,
  persistLanguage,
  readStoredLanguage,
  setLanguage,
  subscribe,
  t,
} from "../public/subtitle-i18n.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return /** @type {any} */ ({
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    entries: () => Object.fromEntries(map),
  });
}

function createElement(dataset) {
  return {
    dataset,
    textContent: "",
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
  };
}

const DATASET_KEY_BY_SELECTOR = {
  "[data-i18n]": "i18n",
  "[data-i18n-aria]": "i18nAria",
  "[data-i18n-title]": "i18nTitle",
  "[data-i18n-placeholder]": "i18nPlaceholder",
};

function createRoot(elements) {
  return {
    querySelectorAll(selector) {
      const key = DATASET_KEY_BY_SELECTOR[selector];
      assert.ok(key, `unexpected selector ${selector}`);
      return elements.filter((element) => element.dataset[key] !== undefined);
    },
  };
}

test.afterEach(() => { setLanguage(DEFAULT_UI_LANGUAGE); });

test("the UI dictionary covers every key in both supported languages", () => {
  assert.deepEqual(SUPPORTED_UI_LANGUAGES, ["en", "ko"]);
  assert.ok(SUPPORTED_UI_LANGUAGES.includes(DEFAULT_UI_LANGUAGE));
  const keySets = SUPPORTED_UI_LANGUAGES.map((language) => Object.keys(MESSAGES[language]).sort());
  assert.deepEqual(keySets[0], keySets[1], "en and ko must declare exactly the same keys");
  for (const language of SUPPORTED_UI_LANGUAGES) {
    for (const [key, value] of Object.entries(MESSAGES[language])) {
      assert.equal(typeof value, "string", `${language}.${key} must be a string`);
      assert.ok(value.length > 0, `${language}.${key} must not be empty`);
    }
  }
});

test("t resolves through the active language and falls back to the key", () => {
  setLanguage("ko");
  assert.equal(getLanguage(), "ko");
  assert.equal(t("nav.captions"), MESSAGES.ko["nav.captions"]);
  setLanguage("en");
  assert.equal(getLanguage(), "en");
  assert.equal(t("nav.captions"), MESSAGES.en["nav.captions"]);
  assert.equal(t("nav.captions"), "Captions");
  assert.equal(t("no.such.key"), "no.such.key");
});

test("t interpolates named placeholders", () => {
  setLanguage("en");
  assert.match(t("records.meetingCount", { count: 3 }), /3/u);
  assert.doesNotMatch(t("records.meetingCount", { count: 3 }), /\{count\}/u);
});

test("normalizeLanguage accepts only the supported set", () => {
  assert.equal(normalizeLanguage("en"), "en");
  assert.equal(normalizeLanguage("KO"), "ko");
  assert.equal(normalizeLanguage("ko-KR"), "ko");
  assert.equal(normalizeLanguage("ja"), null);
  assert.equal(normalizeLanguage(""), null);
  assert.equal(normalizeLanguage(undefined), null);
});

test("the language choice persists under the existing realtime-noel storage prefix", () => {
  assert.equal(UI_LANGUAGE_STORAGE_KEY, "realtime-noel-ui-language");
  const storage = createStorage();
  persistLanguage("en", storage);
  assert.deepEqual(storage.entries(), { "realtime-noel-ui-language": "en" });
  assert.equal(readStoredLanguage(storage), "en");
});

test("a missing or unusable stored language falls back to the default", () => {
  assert.equal(readStoredLanguage(createStorage()), DEFAULT_UI_LANGUAGE);
  assert.equal(readStoredLanguage(createStorage({ "realtime-noel-ui-language": "fr" })), DEFAULT_UI_LANGUAGE);
  assert.equal(readStoredLanguage(null), DEFAULT_UI_LANGUAGE);
  assert.equal(readStoredLanguage(/** @type {any} */ ({ getItem() { throw new Error("blocked"); } })), DEFAULT_UI_LANGUAGE);
  persistLanguage("en", null);
  persistLanguage("en", /** @type {any} */ ({ setItem() { throw new Error("blocked"); } }));
});

test("setLanguage notifies subscribers once per real change", () => {
  setLanguage("ko");
  const seen = [];
  const unsubscribe = subscribe((language) => seen.push(language));
  setLanguage("en");
  setLanguage("en");
  setLanguage("ko");
  unsubscribe();
  setLanguage("en");
  assert.deepEqual(seen, ["en", "ko"]);
  assert.equal(setLanguage("nope"), "en", "an unsupported language keeps the current one");
});

test("applyTranslations fills text, aria-label, title, and placeholder in one pass", () => {
  setLanguage("en");
  const text = createElement({ i18n: "nav.records" });
  const aria = createElement({ i18nAria: "theme.dark" });
  const title = createElement({ i18nTitle: "theme.light" });
  const placeholder = createElement({ i18nPlaceholder: "glossary.domainPlaceholder" });
  const root = createRoot([text, aria, title, placeholder]);

  applyTranslations(root);
  assert.equal(text.textContent, MESSAGES.en["nav.records"]);
  assert.equal(aria.getAttribute("aria-label"), MESSAGES.en["theme.dark"]);
  assert.equal(title.getAttribute("title"), MESSAGES.en["theme.light"]);
  assert.equal(placeholder.getAttribute("placeholder"), MESSAGES.en["glossary.domainPlaceholder"]);

  setLanguage("ko");
  applyTranslations(root);
  assert.equal(text.textContent, MESSAGES.ko["nav.records"]);
  assert.equal(aria.getAttribute("aria-label"), MESSAGES.ko["theme.dark"]);
});

test("applyTranslations tolerates a missing root and unknown keys", () => {
  applyTranslations(null);
  const unknown = createElement({ i18n: "totally.unknown" });
  applyTranslations(createRoot([unknown]));
  assert.equal(unknown.textContent, "", "an unknown key leaves the node untouched");
});

test("the application menu labels are translated for both languages", () => {
  assert.ok(MENU_KEYS.length >= 5);
  for (const language of SUPPORTED_UI_LANGUAGES) {
    for (const key of MENU_KEYS) {
      assert.equal(typeof MESSAGES[language][key], "string", `${language} is missing ${key}`);
    }
  }
});

test("the Live Call language policy explains automatic screen output and bilingual history", () => {
  assert.match(MESSAGES.en["live.captionLanguagePolicy"], /opposite the speaker/u);
  assert.match(MESSAGES.en["live.captionLanguagePolicy"], /both English and Korean/u);
  assert.match(MESSAGES.ko["live.captionLanguagePolicy"], /말한 언어의 반대 언어 한 줄/u);
  assert.match(MESSAGES.ko["live.captionLanguagePolicy"], /웹 기록: 영어·한국어 모두/u);
});

test("the i18n module stays free of load-time DOM and storage coupling", async () => {
  const source = await readFile(path.join(ROOT, "public/subtitle-i18n.js"), "utf8");
  assert.doesNotMatch(source, /innerHTML/u, "DOM is built with textContent/attributes only");
  // Only guarded, lazy access is allowed — a bare top-level `document.` or
  // `localStorage.` would break importing this module in the test runner.
  assert.doesNotMatch(source, /^\s*document\./mu);
  assert.doesNotMatch(source, /^\s*localStorage\./mu);
});
