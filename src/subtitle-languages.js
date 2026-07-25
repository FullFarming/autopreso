// Single source of truth for the subtitle languages the app can translate
// into. The core trio (en/ko/ja) keeps its exact legacy detection behavior —
// their char patterns below are byte-identical to the old KOREAN_CHAR /
// JAPANESE_CHAR / ENGLISH_CHAR literals. Everything else layers on top as an
// OUTPUT language: script-based detection cannot tell two same-script languages
// apart (es vs en, zh vs ja without kana), so new SOURCE languages rely on the
// provider-reported languageCode (Gemini) or the single-configured-language
// script fallback (resolveConfiguredLanguageForScript).

export const SUBTITLE_LANGUAGES = Object.freeze([
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
]);

// Each configured language opens one provider WebSocket per audio source, so
// the selection is bounded to keep cost/latency sane.
export const MAX_TRANSLATION_LANGUAGES = 3;

const byCode = new Map(SUBTITLE_LANGUAGES.map((language) => [language.code, language]));
const byAlias = new Map();
for (const language of SUBTITLE_LANGUAGES) {
  byAlias.set(language.code.toLowerCase(), language.code);
  byAlias.set(language.label.toLowerCase(), language.code);
  for (const alias of language.aliases) byAlias.set(alias, language.code);
}

// Per-language character patterns. en keeps the legacy ASCII-only pattern so
// existing gates (output presence, echo detection) behave identically; the
// other Latin languages include accented ranges.
const CHAR_PATTERNS = {
  "latin-basic": /[A-Za-z]/,
  latin: /[A-Za-zÀ-ÖØ-öø-ÿĀ-ỹ]/,
  hangul: /[가-힣ㄱ-ㅎㅏ-ㅣ]/,
  japanese: /[ぁ-んァ-ヶーｱ-ﾝ一-龯々]/,
  han: /[一-龯々]/,
  cyrillic: /[А-яЁё]/,
  devanagari: /[\u0900-\u097f]/,
};

// Script GROUPS for source-language fallback: languages in the same group are
// indistinguishable by script alone.
const SCRIPT_GROUPS = {
  "latin-basic": "latin",
  latin: "latin",
  japanese: "cjk",
  han: "cjk",
  hangul: "hangul",
  cyrillic: "cyrillic",
  devanagari: "devanagari",
};

/** @param {string} code */
export function isSupportedSubtitleLanguage(code) {
  return Boolean(normalizeSubtitleLanguageCode(code));
}

/** @param {unknown} value */
export function normalizeSubtitleLanguageCode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  return byAlias.get(raw) ?? "";
}

/** @param {string} code */
export function subtitleLanguageLabel(code) {
  return byCode.get(normalizeSubtitleLanguageCode(code))?.label ?? String(code ?? "");
}

/** @param {string} code */
export function subtitleLanguageCharPattern(code) {
  const script = byCode.get(normalizeSubtitleLanguageCode(code))?.script ?? "latin-basic";
  return CHAR_PATTERNS[script] ?? CHAR_PATTERNS["latin-basic"];
}

// Map a script-detected language onto the configured target set. Spanish
// speech detects as "en" (Latin script); when es is the only configured Latin
// language the source must resolve to es or the role gate would suppress every
// subtitle. Ambiguity (two configured languages in the same script group)
// returns "" and the caller keeps its legacy behavior.
/** @param {string} detected @param {string[]} configured */
export function resolveConfiguredLanguageForScript(detected, configured = []) {
  const language = byCode.get(String(detected ?? ""));
  if (!language) return "";
  if (configured.includes(language.code)) return language.code;
  const group = SCRIPT_GROUPS[language.script];
  const candidates = configured.filter((code) => SCRIPT_GROUPS[byCode.get(code)?.script] === group);
  return candidates.length === 1 ? candidates[0] : "";
}

// Tokens (codes, labels, aliases) that may appear as a "en:" / "korean:" style
// prefix on a model line — used to build the strip regex.
export function subtitleLanguagePrefixTokens() {
  const tokens = [];
  for (const language of SUBTITLE_LANGUAGES) {
    tokens.push(language.code, language.label.toLowerCase(), ...language.aliases);
  }
  return [...new Set(tokens)];
}

// 2026-07-23 fix: gemini-3.5-live-translate-preview validates the target
// language lazily on the FIRST audio chunk, and regioned codes (ko-KR/en-US)
// are rejected with close 1007 "Request contains an invalid argument". The
// official supported list (ai.google.dev/gemini-api/docs/live-api/live-translate)
// uses bare BCP-47 codes; only Chinese scripts and Portuguese carry a suffix.
const GEMINI_LANGUAGE_CODES = Object.freeze({
  en: "en", ko: "ko", ja: "ja", "zh-Hans": "zh-Hans", "zh-Hant": "zh-Hant",
  es: "es", pt: "pt-BR", fr: "fr", de: "de", ru: "ru", hi: "hi",
  id: "id", vi: "vi", it: "it",
});

/** @param {unknown} value */
export function toGeminiLanguageCode(value) {
  const canonical = normalizeSubtitleLanguageCode(value);
  return GEMINI_LANGUAGE_CODES[canonical] ?? "";
}

/** OpenAI Realtime currently exposes one Mandarin/Chinese output code. */
export function toOpenAITranslationLanguageCode(value) {
  const canonical = normalizeSubtitleLanguageCode(value);
  if (canonical === "zh-Hans" || canonical === "zh-Hant") return "zh";
  return canonical;
}
