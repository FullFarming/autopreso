import { normalizeLiveLanguage } from "./config.js";

const SHORT_SIGNAL_LIMIT = 2;
const STRONG_HANGUL_CHARS = 4;
const STRONG_LATIN_CHARS = 8;
const STRONG_JAPANESE_CHARS = 4;
const LATIN_LANGUAGE_CODES = new Set(["en", "es", "fr", "de", "pt", "vi", "id", "it"]);

function isLikelyProperNoun(text) {
  const tokens = String(text).match(/[A-Za-z][A-Za-z'.-]*/g) ?? [];
  if (tokens.length === 0 || tokens.length > 4) return false;
  return tokens.every((token) => /^[A-Z](?:[A-Za-z'.-]*|[A-Z]+)$/.test(token));
}

function analyzeTranscript(text) {
  const transcript = (typeof text === "string" ? text : "").trim();
  const hangul = (transcript.match(/[가-힣]/g) ?? []).length;
  const latin = (transcript.match(/[A-Za-z]/g) ?? []).length;
  const japanese = (transcript.match(/[ぁ-んァ-ヶ]/g) ?? []).length;
  const han = (transcript.match(/[一-龯々]/g) ?? []).length;
  const cyrillic = (transcript.match(/[А-яЁё]/g) ?? []).length;
  const devanagari = (transcript.match(/[\u0900-\u097f]/g) ?? []).length;
  const signal = hangul + latin + japanese + han + cyrillic + devanagari;
  if (signal === 0) return { language: "", isStrong: false, signal };

  if (hangul >= STRONG_HANGUL_CHARS && hangul / signal >= 0.2) {
    return { language: "ko", isStrong: true, signal };
  }
  if (japanese >= STRONG_JAPANESE_CHARS && japanese / signal >= 0.35) {
    return { language: "ja", isStrong: true, signal };
  }
  if (han >= 4 && japanese === 0) return { language: "zh-Hans", isStrong: true, signal };
  if (cyrillic >= 4) return { language: "ru", isStrong: true, signal };
  if (devanagari >= 4) return { language: "hi", isStrong: true, signal };
  if (latin >= STRONG_LATIN_CHARS && latin / signal >= 0.78 && !isLikelyProperNoun(transcript)) {
    return { language: "en", isStrong: true, signal };
  }

  const language = hangul >= latin && hangul >= japanese
    ? "ko"
    : japanese > latin
      ? "ja"
      : "en";
  return { language, isStrong: false, signal };
}

/**
 * Keeps one source-language decision for a caption sentence. A provider hint
 * may seed the decision while evidence is short, but the first strong script
 * sample may correct it. After that correction the decision is immutable until
 * a real turn, interruption, reconnect, or floor boundary resets the state.
 */
export function createSourceLanguageState() {
  let lockedLanguage = "";
  let hasStrongLock = false;

  return {
    observe({ providerLanguage = "", transcript = "" } = {}) {
      if (hasStrongLock) return lockedLanguage;

      const provider = typeof providerLanguage === "string" && providerLanguage.length <= 128
        ? normalizeLiveLanguage(providerLanguage)
        : "";
      const script = analyzeTranscript(transcript);

      if (script.isStrong) {
        const providerMatchesScript = (script.language === "en" && LATIN_LANGUAGE_CODES.has(provider))
          // Kanji-only Japanese is indistinguishable from Han-script Chinese
          // without provider evidence (for example, 東京都庁).
          || (script.language === "zh-Hans" && ["zh-Hans", "zh-Hant", "ja"].includes(provider))
          || provider === script.language;
        lockedLanguage = providerMatchesScript ? provider : script.language;
        hasStrongLock = true;
        return lockedLanguage;
      }

      if (lockedLanguage) return lockedLanguage;
      if (provider) {
        lockedLanguage = provider;
        return lockedLanguage;
      }
      if (script.signal > SHORT_SIGNAL_LIMIT) lockedLanguage = script.language;
      return lockedLanguage;
    },
    reset() {
      lockedLanguage = "";
      hasStrongLock = false;
    },
  };
}
