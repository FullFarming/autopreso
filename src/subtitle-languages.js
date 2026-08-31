// The catalog is served directly to browser surfaces and imported here by
// Node. Detection/provider behavior stays in this module; data lives once.
import { SUBTITLE_LANGUAGES } from "../public/subtitle-language-catalog.js";

export { SUBTITLE_LANGUAGES } from "../public/subtitle-language-catalog.js";

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

// Live Call publishes its own language set when the host configured one;
// an empty/absent list inherits the local subtitle languages so existing
// settings keep behaving exactly as before the split.
export function resolveLiveCallLanguages(subtitle = {}) {
  const explicit = subtitle?.liveCallTranslationLanguages;
  if (Array.isArray(explicit) && explicit.length >= 1) return explicit;
  return Array.isArray(subtitle?.translationLanguages) ? subtitle.translationLanguages : [];
}

/** @param {string} code */
export function isSupportedSubtitleLanguage(code) {
  return Boolean(normalizeSubtitleLanguageCode(code));
}

/** @param {unknown} value */
export function normalizeSubtitleLanguageCode(value) {
  const raw = String(value ?? "").normalize("NFC").trim().toLowerCase();
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

// 2026-08-27 fix: Transcribe Live and the downstream text translator share one
// canonical product-language vocabulary. Bare language codes avoid provider
// region mismatches; Chinese scripts and Portuguese retain the product's
// explicit variants.
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
