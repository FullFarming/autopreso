import { normalizeLiveLanguage } from "./config.js";

const SHORT_SIGNAL_LIMIT = 2;
// Aligned with the captions engine (the reference): KOREAN_MIX_MIN_CHARS 3,
// LANGUAGE_LOCK_MIN_SIGNAL_CHARS 4, LANGUAGE_LOCK_MIN_CONFIDENCE 0.68.
// The gateway previously needed a 4th Hangul char and 8 Latin chars at 0.78,
// so it declared both languages LATER than captions did on identical speech.
const STRONG_HANGUL_CHARS = 3;
const STRONG_LATIN_CHARS = 4;
const STRONG_LATIN_RATIO = 0.68;
const STRONG_JAPANESE_CHARS = 4;
const LATIN_LANGUAGE_CODES = new Set(["en", "es", "fr", "de", "pt", "vi", "id", "it"]);

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

  // Pure Korean: no Latin to weigh it against.
  if (hangul >= STRONG_HANGUL_CHARS && latin === 0) {
    return { language: "ko", isStrong: true, signal };
  }
  // Mixed Korean+English, judged the way captions judges it: ko / (ko + en),
  // and only when there is no Japanese in the buffer.
  if (hangul >= STRONG_HANGUL_CHARS && latin > 0 && japanese === 0
    && hangul / (hangul + latin) >= 0.2) {
    return { language: "ko", isStrong: true, signal };
  }
  if (japanese >= STRONG_JAPANESE_CHARS && japanese / signal >= 0.35) {
    return { language: "ja", isStrong: true, signal };
  }
  if (han >= 4 && japanese === 0) return { language: "zh-Hans", isStrong: true, signal };
  if (cyrillic >= 4) return { language: "ru", isStrong: true, signal };
  if (devanagari >= 4) return { language: "hi", isStrong: true, signal };
  if (latin >= STRONG_LATIN_CHARS && latin / signal >= STRONG_LATIN_RATIO) {
    return { language: "en", isStrong: true, signal };
  }

  return { language: "", isStrong: false, signal };
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
