// Browser/Node shared language data. Keep this module free of runtime globals,
// provider clients, storage, and UI state so every product surface can import
// the same canonical records without crossing a trust boundary.

const languageRecords = [
  { code: "en", label: "English", nativeLabel: "English", script: "latin-basic", aliases: ["english", "eng", "en-us", "en-gb"] },
  { code: "ko", label: "Korean", nativeLabel: "한국어", script: "hangul", aliases: ["korean", "kor", "ko-kr"] },
  { code: "ja", label: "Japanese", nativeLabel: "日本語", script: "japanese", aliases: ["japanese", "jpn", "jp", "ja-jp"] },
  { code: "zh-Hans", label: "Chinese (Simplified)", nativeLabel: "简体中文", script: "han", aliases: ["zh", "zh-cn", "cmn-hans-cn", "chinese", "chinese simplified", "zho", "cmn"] },
  { code: "zh-Hant", label: "Chinese (Traditional)", nativeLabel: "繁體中文", script: "han", aliases: ["zh-tw", "zh-hk", "cmn-hant-tw", "chinese traditional"] },
  { code: "es", label: "Spanish", nativeLabel: "Español", script: "latin", aliases: ["spanish", "spa"] },
  { code: "pt", label: "Portuguese", nativeLabel: "Português", script: "latin", aliases: ["portuguese", "por"] },
  { code: "fr", label: "French", nativeLabel: "Français", script: "latin", aliases: ["french", "fra"] },
  { code: "de", label: "German", nativeLabel: "Deutsch", script: "latin", aliases: ["german", "deu"] },
  { code: "ru", label: "Russian", nativeLabel: "Русский", script: "cyrillic", aliases: ["russian", "rus"] },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी", script: "devanagari", aliases: ["hindi", "hin"] },
  { code: "id", label: "Indonesian", nativeLabel: "Bahasa Indonesia", script: "latin", aliases: ["indonesian", "ind"] },
  { code: "vi", label: "Vietnamese", nativeLabel: "Tiếng Việt", script: "latin", aliases: ["vietnamese", "vie"] },
  { code: "it", label: "Italian", nativeLabel: "Italiano", script: "latin", aliases: ["italian", "ita"] },
];

export const SUBTITLE_LANGUAGES = Object.freeze(languageRecords.map((language) => Object.freeze({
  ...language,
  aliases: Object.freeze([...language.aliases]),
})));

// Live Interpreter deliberately exposes a narrower provider-facing contract.
// Chinese uses provider code `zh` but derives its labels/eligibility from the
// canonical Simplified Chinese record. There is intentionally no zh-Hant rule.
export const LIVE_INTERPRETER_LANGUAGE_RULES = Object.freeze([
  { code: "es", catalogCode: "es" },
  { code: "pt", catalogCode: "pt" },
  { code: "fr", catalogCode: "fr" },
  { code: "ja", catalogCode: "ja" },
  { code: "ru", catalogCode: "ru" },
  { code: "zh", catalogCode: "zh-Hans" },
  { code: "de", catalogCode: "de" },
  { code: "ko", catalogCode: "ko" },
  { code: "hi", catalogCode: "hi" },
  { code: "id", catalogCode: "id" },
  { code: "vi", catalogCode: "vi" },
  { code: "it", catalogCode: "it" },
  { code: "en", catalogCode: "en" },
].map((rule) => Object.freeze(rule)));

const catalogByCode = new Map(SUBTITLE_LANGUAGES.map((language) => [language.code, language]));
const interpreterRules = LIVE_INTERPRETER_LANGUAGE_RULES.filter((rule) => catalogByCode.has(rule.catalogCode));

export const LIVE_INTERPRETER_LANGUAGES = Object.freeze(interpreterRules.map(({ code }) => code));
export const LIVE_INTERPRETER_LANGUAGE_OPTIONS = Object.freeze(interpreterRules.map(({ code, catalogCode }) => {
  const language = catalogByCode.get(catalogCode);
  return Object.freeze({
    code,
    catalogCode,
    label: language.label,
    nativeLabel: language.nativeLabel,
  });
}));

const interpreterLanguageSet = new Set(LIVE_INTERPRETER_LANGUAGES);

/** @param {unknown} value */
export function normalizeLiveInterpreterLanguageCode(value) {
  const normalized = String(value ?? "").normalize("NFC").trim().toLowerCase();
  return interpreterLanguageSet.has(normalized) ? normalized : "";
}
