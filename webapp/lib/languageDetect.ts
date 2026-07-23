export const LANGUAGE_CODES = [
  "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "pt", "fr", "de", "ru", "hi", "id", "vi", "it",
] as const;

export type CanonicalLanguageCode = (typeof LANGUAGE_CODES)[number];
/** String-compatible during the additive migration; normalize at provider/storage boundaries. */
export type LanguageCode = string;
export type DetectedLanguage = CanonicalLanguageCode | "unknown";

export const LANGUAGE_LOCK_MIN_SIGNAL_CHARS = 4;
export const LANGUAGE_LOCK_MIN_CONFIDENCE = 0.68;
export const OUTPUT_LANGUAGE_JUDGE_MIN_CHARS = 8;
export const OUTPUT_LANGUAGE_MIN_CONFIDENCE = 0.55;
const KOREAN_MIX_MIN_CHARS = 3;
const KOREAN_MIX_MIN_RATIO = 0.2;
const LATIN_CODES = new Set<string>(["en", "es", "pt", "fr", "de", "id", "vi", "it"]);

export const LANGUAGE_LABELS: Record<string, string> = {
  en: "English", ko: "Korean", ja: "Japanese", "zh-Hans": "Chinese (Simplified)",
  "zh-Hant": "Chinese (Traditional)", es: "Spanish", pt: "Portuguese", fr: "French",
  de: "German", ru: "Russian", hi: "Hindi", id: "Indonesian", vi: "Vietnamese", it: "Italian",
};

const ALIASES = new Map<string, CanonicalLanguageCode>([
  ...LANGUAGE_CODES.map((code) => [code.toLowerCase(), code] as const),
  ["english", "en"], ["korean", "ko"], ["japanese", "ja"], ["zh", "zh-Hans"],
  ["en-us", "en"], ["en-gb", "en"], ["en-au", "en"], ["en-ca", "en"],
  ["ko-kr", "ko"], ["ja-jp", "ja"],
  ["zh-cn", "zh-Hans"], ["zh-sg", "zh-Hans"], ["cmn-hans-cn", "zh-Hans"], ["chinese", "zh-Hans"],
  ["zh-tw", "zh-Hant"], ["zh-hk", "zh-Hant"], ["zh-mo", "zh-Hant"], ["cmn-hant-tw", "zh-Hant"],
  ["es-es", "es"], ["es-mx", "es"], ["pt-br", "pt"], ["pt-pt", "pt"],
  ["fr-fr", "fr"], ["fr-ca", "fr"], ["de-de", "de"], ["ru-ru", "ru"],
  ["hi-in", "hi"], ["id-id", "id"], ["vi-vn", "vi"], ["it-it", "it"],
]);

const KOREAN_CHAR = /[가-힣ㄱ-ㅎㅏ-ㅣ]/u;
const KANA_CHAR = /[ぁ-んァ-ヶーｱ-ﾝ]/u;
const HAN_CHAR = /[一-龯々]/u;
const LATIN_CHAR = /[A-Za-zÀ-ÖØ-öø-ÿĀ-ỹ]/u;
const CYRILLIC_CHAR = /[А-яЁё]/u;
const DEVANAGARI_CHAR = /[\u0900-\u097f]/u;

function scriptPattern(language: LanguageCode): RegExp {
  if (language === "ko") return KOREAN_CHAR;
  if (language === "ja") return /[ぁ-んァ-ヶーｱ-ﾝ一-龯々]/u;
  if (language === "zh-Hans" || language === "zh-Hant") return HAN_CHAR;
  if (language === "ru") return CYRILLIC_CHAR;
  if (language === "hi") return DEVANAGARI_CHAR;
  return LATIN_CHAR;
}

export function countLanguageSignalChars(value: unknown): number {
  let count = 0;
  for (const char of String(value ?? "")) {
    if (KOREAN_CHAR.test(char) || KANA_CHAR.test(char) || HAN_CHAR.test(char) || LATIN_CHAR.test(char)
      || CYRILLIC_CHAR.test(char) || DEVANAGARI_CHAR.test(char)) count += 1;
  }
  return count;
}

export function countLanguageCharsFor(value: unknown, language: LanguageCode): number {
  const pattern = scriptPattern(language);
  let count = 0;
  for (const char of String(value ?? "")) if (pattern.test(char)) count += 1;
  return count;
}

export function isTargetLanguageText(value: unknown, targetLanguage: LanguageCode): boolean {
  const signalChars = countLanguageSignalChars(value);
  const detected = detectLanguage(value, { minimumSignalChars: 1, minimumConfidence: OUTPUT_LANGUAGE_MIN_CONFIDENCE });
  if (signalChars < OUTPUT_LANGUAGE_JUDGE_MIN_CHARS) {
    return detected === "unknown" || detected === targetLanguage || sharesScript(detected, targetLanguage);
  }
  return detected === targetLanguage || sharesScript(detected, targetLanguage)
    || countLanguageCharsFor(value, targetLanguage) >= 3;
}

function sharesScript(a: DetectedLanguage, b: LanguageCode): boolean {
  if (a === "unknown") return false;
  if (LATIN_CODES.has(a) && LATIN_CODES.has(b)) return true;
  return (a === "zh-Hans" || a === "zh-Hant") && (b === "zh-Hans" || b === "zh-Hant");
}

export function detectLanguage(
  value: unknown,
  options: { minimumSignalChars?: number; minimumConfidence?: number; preferKoreanWhenMixedWithEnglish?: boolean } = {},
): DetectedLanguage {
  const counts: Record<"ko" | "ja" | "zh-Hans" | "en" | "ru" | "hi", number> = {
    ko: 0, ja: 0, "zh-Hans": 0, en: 0, ru: 0, hi: 0,
  };
  let han = 0;
  for (const char of String(value ?? "")) {
    if (KOREAN_CHAR.test(char)) counts.ko += 1;
    else if (KANA_CHAR.test(char)) counts.ja += 1;
    else if (HAN_CHAR.test(char)) han += 1;
    else if (CYRILLIC_CHAR.test(char)) counts.ru += 1;
    else if (DEVANAGARI_CHAR.test(char)) counts.hi += 1;
    else if (LATIN_CHAR.test(char)) counts.en += 1;
  }
  if (counts.ja > 0) counts.ja += han;
  else counts["zh-Hans"] = han;
  const signalCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (signalCount < (options.minimumSignalChars ?? LANGUAGE_LOCK_MIN_SIGNAL_CHARS)) return "unknown";
  if (options.preferKoreanWhenMixedWithEnglish && counts.ko > 0 && counts.en > 0 && counts.ja === 0) {
    const ratio = counts.ko / (counts.ko + counts.en);
    if (counts.ko >= KOREAN_MIX_MIN_CHARS && ratio >= KOREAN_MIX_MIN_RATIO) return "ko";
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries[0][1] === entries[1][1]) return "unknown";
  if (entries[0][1] / signalCount < (options.minimumConfidence ?? LANGUAGE_LOCK_MIN_CONFIDENCE)) return "unknown";
  return entries[0][0] as DetectedLanguage;
}

export function detectSourceLanguage(
  value: unknown,
  options: { minimumSignalChars?: number; minimumConfidence?: number } = {},
): DetectedLanguage {
  return detectLanguage(value, { preferKoreanWhenMixedWithEnglish: true, ...options });
}

export function normalizeLanguageCode(value: unknown): CanonicalLanguageCode | "" {
  return ALIASES.get(String(value ?? "").trim().toLowerCase()) ?? "";
}

export function normalizeProviderLanguageCode(value: unknown): CanonicalLanguageCode | "" {
  const raw = String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
  return normalizeLanguageCode(raw) || normalizeLanguageCode(raw.split("-")[0]);
}

export function toGeminiLanguageCode(language: LanguageCode): string {
  const codes: Record<CanonicalLanguageCode, string> = {
    en: "en-US", ko: "ko-KR", ja: "ja-JP", "zh-Hans": "zh-Hans", "zh-Hant": "zh-Hant",
    es: "es-ES", pt: "pt-BR", fr: "fr-FR", de: "de-DE", ru: "ru-RU", hi: "hi-IN",
    id: "id-ID", vi: "vi-VN", it: "it-IT",
  };
  const canonical = normalizeLanguageCode(language);
  return canonical ? codes[canonical] : "";
}

export function toOpenAITranslationLanguageCode(language: LanguageCode): string {
  const canonical = normalizeLanguageCode(language);
  return canonical === "zh-Hans" || canonical === "zh-Hant" ? "zh" : canonical;
}

export function resolveLanguageEvidence(
  text: unknown,
  providerCode?: unknown,
  previousLanguage: DetectedLanguage = "unknown",
): DetectedLanguage {
  const providerLanguage = normalizeProviderLanguageCode(providerCode);
  const signalChars = countLanguageSignalChars(text);
  const scriptLanguage = detectSourceLanguage(text);
  if (signalChars >= LANGUAGE_LOCK_MIN_SIGNAL_CHARS && scriptLanguage !== "unknown") {
    if (providerLanguage && sharesScript(scriptLanguage, providerLanguage)) return providerLanguage;
    return scriptLanguage;
  }
  const relaxed = detectSourceLanguage(text, { minimumSignalChars: 1, minimumConfidence: OUTPUT_LANGUAGE_MIN_CONFIDENCE });
  if (providerLanguage && (providerLanguage === relaxed || sharesScript(relaxed, providerLanguage))) return providerLanguage;
  if (signalChars === 0 && providerLanguage) return providerLanguage;
  return previousLanguage;
}

export function createSpokenLanguageState() {
  let language: DetectedLanguage = "unknown";
  let deltaBuffer = "";
  return {
    resolved(fallbackText: unknown = ""): DetectedLanguage {
      return language === "unknown" ? detectSourceLanguage(fallbackText) : language;
    },
    rememberDelta(delta: unknown, providerCode?: unknown): DetectedLanguage {
      deltaBuffer = `${deltaBuffer}${String(delta ?? "")}`;
      if (language !== "unknown" && countLanguageSignalChars(deltaBuffer) <= 2) return language;
      const fresh = resolveLanguageEvidence(deltaBuffer, providerCode, "unknown");
      if (fresh !== "unknown") { language = fresh; deltaBuffer = ""; }
      return language;
    },
    rememberSnapshot(transcript: unknown, previousTranscript: unknown = "", providerCode?: unknown): DetectedLanguage {
      const next = String(transcript ?? "");
      const previous = String(previousTranscript ?? "");
      const recent = previous && next.startsWith(previous) ? next.slice(previous.length) : next;
      if (!recent.trim()) return language;
      const resolved = resolveLanguageEvidence(recent, providerCode, language);
      if (resolved !== "unknown") language = resolved;
      deltaBuffer = "";
      return language;
    },
    resetForSpeakerBoundary() {
      language = "unknown";
      deltaBuffer = "";
    },
    reset() {
      language = "unknown";
      deltaBuffer = "";
    },
  };
}
