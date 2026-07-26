import { CAPTION_LANGUAGE_CODES, normalizeCaptionLanguage } from "./languages.js";

const KOREAN_CHAR = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
const JAPANESE_CHAR = /[ぁ-んァ-ヶーｱ-ﾝ一-龯々]/;
const ENGLISH_CHAR = /[A-Za-z]/;
const EXTRA_SIGNAL_CHAR = /[À-ÖØ-öø-ÿĀ-ỹА-яЁёก-๛؀-ۿ]/;
const SCRIPT_PATTERNS = {
  en: /[A-Za-z]/, ko: /[가-힣ㄱ-ㅎㅏ-ㅣ]/, ja: /[ぁ-んァ-ヶーｱ-ﾝ一-龯々]/,
  "zh-Hans": /[一-龯々]/, "zh-Hant": /[一-龯々]/, es: /[A-Za-zÀ-ÖØ-öø-ÿĀ-ỹ]/,
  pt: /[A-Za-zÀ-ÖØ-öø-ÿĀ-ỹ]/, fr: /[A-Za-zÀ-ÖØ-öø-ÿĀ-ỹ]/, de: /[A-Za-zÀ-ÖØ-öø-ÿĀ-ỹ]/,
  it: /[A-Za-zÀ-ÖØ-öø-ÿĀ-ỹ]/, id: /[A-Za-z]/, vi: /[A-Za-zÀ-ÖØ-öø-ÿĀ-ỹ]/,
  ru: /[А-яЁё]/, hi: /[ऀ-ॿ]/,
};

export function countLanguageSignalChars(value) {
  let count = 0;
  for (const char of String(value ?? "")) {
    if (KOREAN_CHAR.test(char) || JAPANESE_CHAR.test(char) || ENGLISH_CHAR.test(char) || EXTRA_SIGNAL_CHAR.test(char)) count += 1;
  }
  return count;
}

export function countLanguageCharsFor(value, language) {
  const pattern = SCRIPT_PATTERNS[normalizeCaptionLanguage(language)] ?? SCRIPT_PATTERNS.en;
  let count = 0;
  for (const char of String(value ?? "")) if (pattern.test(char)) count += 1;
  return count;
}

export function detectSourceLanguage(value, options = {}) {
  return detectLanguage(value, { preferKoreanWhenMixedWithEnglish: true, ...options });
}

export function detectLanguage(value, options = {}) {
  const counts = { ko: 0, ja: 0, en: 0 };
  for (const char of String(value ?? "")) {
    if (KOREAN_CHAR.test(char)) counts.ko += 1;
    else if (JAPANESE_CHAR.test(char)) counts.ja += 1;
    else if (ENGLISH_CHAR.test(char)) counts.en += 1;
  }
  const signalCount = counts.ko + counts.ja + counts.en;
  if (signalCount < (options.minimumSignalChars ?? 4)) return "unknown";
  if (options.preferKoreanWhenMixedWithEnglish && counts.ko > 0 && counts.en > 0 && counts.ja === 0) {
    if (counts.ko >= 3 && counts.ko / (counts.ko + counts.en) >= 0.2) return "ko";
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries[0][1] === entries[1][1]) return "unknown";
  if (entries[0][1] / signalCount < (options.minimumConfidence ?? 0.68)) return "unknown";
  return entries[0][0];
}

export function isOutputInTargetLanguage(text, targetLanguage) {
  const value = String(text ?? "");
  return countLanguageSignalChars(value) < 8 || countLanguageCharsFor(value, targetLanguage) >= 3;
}

/** @param {{textPlausiblyInLanguage?: (text: unknown, language: unknown) => boolean}} [options] */
export function sourceLaneMatches(text, sttLanguage, laneLanguage, options = {}) {
  const { textPlausiblyInLanguage } = options;
  const stt = normalizeCaptionLanguage(sttLanguage);
  const lane = normalizeCaptionLanguage(laneLanguage);
  if (!stt || !lane || stt !== lane) return false;
  const detected = detectSourceLanguage(text);
  if (detected === "unknown") return typeof textPlausiblyInLanguage === "function" && textPlausiblyInLanguage(text, lane);
  if (!["ko", "ja", "en"].includes(lane)) return typeof textPlausiblyInLanguage === "function" && textPlausiblyInLanguage(text, lane);
  return detected === lane;
}

export const languageGateContract = Object.freeze({
  koreanMixMinChars: 3,
  koreanMixMinRatio: 0.2,
  outputJudgeMinChars: 8,
  outputMinTargetChars: 3,
  supportedLanguages: CAPTION_LANGUAGE_CODES,
});
