import { CAPTION_LANGUAGE_CODES, normalizeCaptionLanguage } from "./languages.js";

const KOREAN_CHAR = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
const JAPANESE_CHAR = /[ぁ-んァ-ヶーｱ-ﾝ一-龯々]/;
const ENGLISH_CHAR = /[A-Za-z]/;
const EXTRA_SIGNAL_CHAR = /[À-ÖØ-öø-ÿĀ-ỹА-яЁёก-๛؀-ۿ]/;
const UNICODE_LETTER = /\p{Letter}/u;
const LATIN_OR_HANGUL_LETTER = /[\p{Script=Latin}\p{Script=Hangul}]/u;
const KOREAN_PARTICLE = /(?:은|는|이|가|을|를|의|과|와|에서|에게|으로|로|도|만)(?=$|[\s,.;:!?])/gu;
const KOREAN_SENTENCE_ENDING = /(?:입니다|습니다|합니다|됩니다|있습니다|없습니다|했습니다|합니다|해요|예요|이에요)(?=$|[\s,.;:!?])/gu;
const VIETNAMESE_COMMON_WORDS = new Set([
  "ở", "đây", "bạn", "có", "thể", "xem", "và", "chúng", "ta", "cũng",
  "được", "vâng", "không", "thử", "thì", "nhưng", "nó", "thế", "thôi",
]);
const UNSUPPORTED_LATIN_LANGUAGE_WORDS = [
  new Set(["aquí", "puede", "ver", "el", "la", "los", "las", "informe", "y", "podemos", "comenzar", "mercado", "hoy"]),
  new Set(["vous", "pouvez", "consulter", "le", "la", "les", "rapport", "et", "nous", "commencer", "marché", "aujourd'hui"]),
  new Set(["wir", "können", "heute", "der", "die", "das", "den", "markt", "prüfen", "und", "beginnen"]),
  new Set(["possiamo", "esaminare", "il", "lo", "la", "gli", "mercato", "e", "iniziare", "oggi"]),
  new Set(["podemos", "rever", "o", "os", "a", "as", "mercado", "e", "começar", "hoje"]),
  new Set(["kita", "dapat", "melihat", "laporan", "dan", "untuk", "bisa", "mulai", "pasar", "hari", "ini", "dengan"]),
];
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

// Gemini Live occasionally drifts into Vietnamese on an English target lane
// during long sessions. Both languages use Latin script, so the generic script
// gate cannot distinguish them. Require multiple Vietnamese function words,
// which rejects a Vietnamese sentence without rejecting an English sentence
// that contains one accented person or place name.
export function isLikelyVietnameseText(value) {
  const tokens = latinWordTokens(value);
  let matches = 0;
  for (const token of tokens) {
    if (!VIETNAMESE_COMMON_WORDS.has(token)) continue;
    matches += 1;
    if (matches >= 2) return true;
  }
  return false;
}

function latinWordTokens(value) {
  return String(value ?? "")
    .normalize("NFC")
    .toLocaleLowerCase()
    .match(/[\p{L}]+(?:['’][\p{L}]+)?/gu) ?? [];
}

function isLikelyUnsupportedLatinText(value) {
  const tokens = latinWordTokens(value);
  for (const lexicon of UNSUPPORTED_LATIN_LANGUAGE_WORDS) {
    let matches = 0;
    for (const token of tokens) {
      if (!lexicon.has(token)) continue;
      matches += 1;
      if (matches >= 3) return true;
    }
  }
  return false;
}

// An EN/KO room is allowed to carry Latin proper nouns and CRE acronyms inside
// Korean speech. Other Unicode scripts are unambiguous drift; Vietnamese needs
// a lexical check because it shares the Latin script with English.
export function hasUnsupportedEnglishKoreanText(value) {
  const text = String(value ?? "").normalize("NFC");
  for (const char of text) {
    if (UNICODE_LETTER.test(char) && !LATIN_OR_HANGUL_LETTER.test(char)) return true;
  }
  return isLikelyVietnameseText(text) || isLikelyUnsupportedLatinText(text);
}

// Mixed CRE sentences often contain more Latin characters than Hangul
// ("Cushman & Wakefield Korea의 ADR ... 지표입니다"). Korean particles and a
// sentence ending are stronger evidence than a raw character ratio, while a
// Korean company name embedded in an otherwise English sentence has neither.
export function hasKoreanGrammarEvidence(value) {
  const text = String(value ?? "").normalize("NFC");
  const hangulCount = (text.match(/[가-힣]/gu) ?? []).length;
  if (hangulCount < 3) return false;
  const endingCount = (text.match(KOREAN_SENTENCE_ENDING) ?? []).length;
  const particleCount = (text.match(KOREAN_PARTICLE) ?? []).length;
  return endingCount > 0 || particleCount >= 2;
}

export function isOutputInTargetLanguage(text, targetLanguage) {
  const value = String(text ?? "").normalize("NFC");
  const target = normalizeCaptionLanguage(targetLanguage);
  if ((target === "en" || target === "ko") && hasUnsupportedEnglishKoreanText(value)) return false;
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

const LATIN_LANGUAGES = new Set(["en", "es", "pt", "fr", "de", "it", "id", "vi"]);

// 2026-08-31 fix: source observations never select a target lane. Script checks
// are conservative evidence, not a calibrated language detector or probability.
export function resolveSourceLanguageObservation(value, providerLanguage) {
  const text = String(value ?? "").normalize("NFC").trim();
  const rawProvider = typeof providerLanguage === "string" ? providerLanguage.trim() : "";
  const providerLanguageCode = rawProvider.length <= 35 && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(rawProvider) ? rawProvider : null;
  const provider = normalizeCaptionLanguage(providerLanguageCode) || null;
  const observation = (state, languageCode, evidence, languages = []) => ({
    state, languageCode, providerLanguageCode, evidence, languages,
  });
  if (rawProvider && (!providerLanguageCode || (!provider && rawProvider.toLowerCase() !== "und"))) {
    return observation("unknown", "und", "conflict");
  }
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0 && /^[\p{N}\p{P}\p{Z}\p{Sm}\p{Sc}\s]+$/u.test(text)) {
    return observation("unknown", "und", "neutral");
  }
  const scripts = [];
  if (/\p{Script=Hangul}/u.test(text)) scripts.push("ko");
  if (/\p{Script=Latin}/u.test(text)) scripts.push("latin");
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) scripts.push("ja");
  else if (/\p{Script=Han}/u.test(text)) scripts.push("han");
  if (/\p{Script=Cyrillic}/u.test(text)) scripts.push("ru");
  if (/\p{Script=Devanagari}/u.test(text)) scripts.push("hi");
  const candidates = scripts.map((script) => script === "latin"
    ? (LATIN_LANGUAGES.has(provider) ? provider : "en")
    : script === "han" ? (["ja", "zh-Hans", "zh-Hant"].includes(provider) ? provider : "zh-Hans") : script);
  if (letters.some((letter) => !/[\p{Script_Extensions=Hangul}\p{Script_Extensions=Latin}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Han}\p{Script_Extensions=Cyrillic}\p{Script_Extensions=Devanagari}]/u.test(letter))) {
    return observation("unknown", "und", "conflict", candidates);
  }
  if (scripts.length > 1) return observation("mixed", "und", "script", [...new Set(candidates)]);
  if (scripts.length !== 1 || letters.length < 4) return observation("unknown", "und", "insufficient", candidates);
  const [script] = scripts;
  if (script === "latin") {
    const words = text.match(/[\p{Script=Latin}]+/gu) ?? [];
    if (words.length < 2 || words.every((word) => /^[A-Z][A-Za-z]*$/u.test(word))) {
      return observation("unknown", "und", "insufficient", candidates);
    }
    if (provider && (!LATIN_LANGUAGES.has(provider) || (provider === "en" && hasUnsupportedEnglishKoreanText(text)))) {
      return observation("unknown", "und", "conflict", candidates);
    }
    return provider ? observation("single", provider, "provider-and-script", [provider])
      : observation("unknown", "und", "insufficient", candidates);
  }
  const language = script === "han" ? (["ja", "zh-Hans", "zh-Hant"].includes(provider) ? provider : null) : script;
  if (!language) return observation("unknown", "und", "insufficient", candidates);
  if (provider && provider !== language) return observation("unknown", "und", "conflict", candidates);
  return observation("single", language, provider ? "provider-and-script" : "script", [language]);
}

export function canPassThroughSourceObservation(observation, targetLanguage) {
  return observation.evidence === "neutral"
    || (observation.state === "single" && observation.languageCode === normalizeCaptionLanguage(targetLanguage));
}

// 2026-08-31 fix: target characters alone cannot validate an echoed foreign
// clause. Only explicitly registered spellings may remain in Korean prose; this is a rejection guard,
// not a claim that accepted translations are semantically correct.
/** @param {unknown} value @param {unknown} targetLanguage @param {{protectedTerms?: readonly string[]}} [options] */
export function isFixedTargetOutputSupported(value, targetLanguage, { protectedTerms = [] } = {}) {
  const text = String(value ?? "").normalize("NFC").trim();
  const target = normalizeCaptionLanguage(targetLanguage);
  if (!text || !target) return false;
  if (target === "ko") {
    let remainder = text;
    const terms = Array.isArray(protectedTerms) ? [...new Set(protectedTerms
      .slice(0, 10_000)
      .filter((term) => typeof term === "string")
      .map((term) => term.normalize("NFC").trim()).filter((term) => term && term.length <= text.length))]
      .sort((left, right) => right.length - left.length) : [];
    for (const term of terms) {
      const literal = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      // Hangul particles may touch a registered name; Latin/digit/mark
      // adjacency would instead grant an unregistered compound or substring.
      const pattern = new RegExp(`(?<![\\p{Script=Latin}\\p{M}\\p{N}_])${literal}(?![\\p{Script=Latin}\\p{M}\\p{N}_])`, "gu");
      remainder = remainder.replace(pattern, " ");
    }
    if (!remainder.trim()) return remainder !== text;
    if (/\p{Script=Hangul}/u.test(remainder)) {
      return !/[^\p{Script=Hangul}\p{N}\p{P}\p{Z}\p{S}\s]/u.test(remainder);
    }
    return resolveSourceLanguageObservation(remainder, target).evidence === "neutral";
  }
  if (!isOutputInTargetLanguage(text, target)) return false;
  const hasLatin = /\p{Script=Latin}/u.test(text);
  if (LATIN_LANGUAGES.has(target) && hasLatin && !/[^\p{Script=Latin}\p{M}\p{N}\p{P}\p{Z}\p{S}\s]/u.test(text)) return true;
  const observation = resolveSourceLanguageObservation(text, target);
  if (observation.evidence === "neutral" || observation.state === "single") return true;
  return false;
}

export const languageGateContract = Object.freeze({
  koreanMixMinChars: 3,
  koreanMixMinRatio: 0.2,
  outputJudgeMinChars: 8,
  outputMinTargetChars: 3,
  supportedLanguages: CAPTION_LANGUAGE_CODES,
});
