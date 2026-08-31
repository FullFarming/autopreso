import { LANGUAGE_CODES, LANGUAGE_LABELS, normalizeLanguageCode, type CanonicalLanguageCode } from "../../lib/languageDetect";

const LANGUAGE_NAMES: Record<CanonicalLanguageCode, { label: string; native: string }> = {
  en: { label: "영어", native: "English" },
  ko: { label: "한국어", native: "한국어" },
  ja: { label: "일본어", native: "日本語" },
  "zh-Hans": { label: "중국어 간체", native: "简体中文 普通话" },
  "zh-Hant": { label: "중국어 번체", native: "繁體中文 國語" },
  es: { label: "스페인어", native: "Español" },
  pt: { label: "포르투갈어", native: "Português" },
  fr: { label: "프랑스어", native: "Français" },
  de: { label: "독일어", native: "Deutsch" },
  ru: { label: "러시아어", native: "Русский" },
  hi: { label: "힌디어", native: "हिन्दी हिंदी" },
  id: { label: "인도네시아어", native: "Bahasa Indonesia" },
  vi: { label: "베트남어", native: "Tiếng Việt" },
  it: { label: "이탈리아어", native: "Italiano" },
};

export function getNativeLanguageLabel(code: string): string {
  const language = normalizeLanguageCode(code);
  return language ? LANGUAGE_NAMES[language].native : code;
}

export const PICKER_LANGUAGES = LANGUAGE_CODES.map((code) => ({
  code,
  label: LANGUAGE_NAMES[code].label,
  english: LANGUAGE_LABELS[code],
  native: LANGUAGE_NAMES[code].native,
}));

export function normalizeLanguageSearch(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en");
}

export function findLanguages(query: string, selected: readonly string[], excluded: readonly string[] = []) {
  const search = normalizeLanguageSearch(query);
  if (!search) return [];
  return PICKER_LANGUAGES.filter((language) => !selected.includes(language.code)
    && !excluded.includes(language.code)
    && [language.code, language.label, language.english, language.native]
      .some((value) => normalizeLanguageSearch(value).includes(search)));
}

export interface LanguageSelectionLimits {
  readonly minSelection: number;
  readonly maxSelection: number;
  readonly excludedLanguages?: readonly string[];
  readonly requiredLanguages?: readonly string[];
}

export function updateLanguageSelection(current: readonly string[], code: string, action: "add" | "remove", limits: LanguageSelectionLimits): string[] {
  const selected = withRequiredLanguages(current, limits.requiredLanguages ?? []);
  if (action === "remove") {
    return selected.length <= limits.minSelection || limits.requiredLanguages?.includes(code)
      ? selected : selected.filter((language) => language !== code);
  }
  if (selected.includes(code) || selected.length >= limits.maxSelection
    || limits.excludedLanguages?.includes(code)
    || !PICKER_LANGUAGES.some((language) => language.code === code)) return selected;
  return [...selected, code];
}

export function withRequiredLanguages(current: readonly string[], required: readonly string[]): string[] {
  return [...new Set([...current, ...required])];
}

export function removeSourceLanguage(current: readonly string[], sourceLanguage: string): string[] {
  return current.filter((language) => language !== sourceLanguage);
}
