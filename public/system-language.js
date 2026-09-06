export const SYSTEM_LANGUAGES = Object.freeze(["ko", "en", "ja"]);
export const DEFAULT_SYSTEM_LANGUAGE = "ko";
export const SYSTEM_LANGUAGE_STORAGE_KEY = "realtime-noel-ui-language";
export const SYSTEM_LANGUAGE_LABELS = Object.freeze({ ko: "한국어", en: "English", ja: "日本語" });

export function normalizeSystemLanguage(value) {
  return typeof value === "string" && SYSTEM_LANGUAGES.includes(value) ? value : null;
}
