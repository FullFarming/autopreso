import { normalizeCaptionLanguage } from "./languages.js";
import {
  hasKoreanGrammarEvidence,
  hasUnsupportedEnglishKoreanText,
} from "./language-gate.js";

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

function analyzeTranscript(text, { useKoreanGrammarEvidence = false } = {}) {
  const transcript = String(text ?? "").trim();
  const hangul = (transcript.match(/[가-힣]/g) ?? []).length;
  const latin = (transcript.match(/[A-Za-z]/g) ?? []).length;
  const japanese = (transcript.match(/[ぁ-んァ-ヶ]/g) ?? []).length;
  const han = (transcript.match(/[一-龯々]/g) ?? []).length;
  const cyrillic = (transcript.match(/[А-яЁё]/g) ?? []).length;
  const devanagari = (transcript.match(/[\u0900-\u097f]/g) ?? []).length;
  const signal = hangul + latin + japanese + han + cyrillic + devanagari;
  if (signal === 0) return { language: "unknown", confidence: 0, isStrong: false, signal };

  const hangulRatio = hangul / signal;
  if (useKoreanGrammarEvidence && hasKoreanGrammarEvidence(transcript)) {
    return { language: "ko", confidence: 0.97, isStrong: true, signal };
  }
  if (hangul >= STRONG_HANGUL_CHARS && hangulRatio >= 0.2) return { language: "ko", confidence: 0.96, isStrong: true, signal };
  if (japanese >= STRONG_JAPANESE_CHARS && japanese / signal >= 0.35) return { language: "ja", confidence: 0.94, isStrong: true, signal };
  if (han >= 4 && japanese === 0) return { language: "zh-Hans", confidence: 0.9, isStrong: true, signal };
  if (cyrillic >= 4) return { language: "ru", confidence: 0.94, isStrong: true, signal };
  if (devanagari >= 4) return { language: "hi", confidence: 0.94, isStrong: true, signal };
  if (latin >= STRONG_LATIN_CHARS && latin / signal >= 0.78 && !isLikelyProperNoun(transcript)) {
    return { language: "en", confidence: 0.92, isStrong: true, signal };
  }

  const language = hangul >= latin && hangul >= japanese ? "ko" : japanese > latin ? "ja" : "en";
  return { language, confidence: 0.45, isStrong: false, signal };
}

export function createCaptionLanguageState({ allowedLanguages = [] } = {}) {
  const allowed = new Set(
    (Array.isArray(allowedLanguages) ? allowedLanguages : [])
      .map((language) => normalizeCaptionLanguage(language))
      .filter(Boolean),
  );
  let lockedLanguage = "unknown";
  let lockedConfidence = 0;
  let rejectedUnsupportedTranscript = false;
  const isEnglishKoreanOnly = allowed.size === 2 && allowed.has("en") && allowed.has("ko");

  function isAllowed(language) {
    return language === "unknown" || allowed.size === 0 || allowed.has(language);
  }

  function rejectUnsupported(transcript, script) {
    return (isEnglishKoreanOnly && hasUnsupportedEnglishKoreanText(transcript))
      || (script.language !== "unknown" && script.isStrong && !isAllowed(script.language));
  }

  function reject() {
    rejectedUnsupportedTranscript = true;
    lockedLanguage = "unknown";
    lockedConfidence = 0;
  }

  return {
    apply(providerLanguage = "") {
      const provider = normalizeCaptionLanguage(providerLanguage) || "unknown";
      return isAllowed(provider) ? provider : "unknown";
    },
    observe({ providerLanguage = "", transcript = "" } = {}) {
      const provider = normalizeCaptionLanguage(providerLanguage) || "unknown";
      const script = analyzeTranscript(transcript, { useKoreanGrammarEvidence: isEnglishKoreanOnly });
      const providerIsDisallowed = allowed.size > 0 && provider !== "unknown" && !allowed.has(provider);
      const canOverrideDisallowedProvider = providerIsDisallowed
        && !hasUnsupportedEnglishKoreanText(transcript)
        && script.isStrong
        && script.language === "ko"
        && allowed.has("ko");
      // 2026-07-27 security: Explicit metadata outside the configured room is
      // never allowed into the lock. Unambiguous Hangul may replace stale
      // metadata with the configured KO lane; Latin cannot do the same because
      // it cannot safely distinguish English from vi/es/fr.
      if ((providerIsDisallowed && !canOverrideDisallowedProvider) || rejectUnsupported(transcript, script)) {
        reject();
        return { ...script, language: "unknown", confidence: 0, isStrong: false, providerLanguage: provider };
      }
      rejectedUnsupportedTranscript = false;
      const allowedProvider = providerIsDisallowed ? "unknown" : provider;
      if (script.isStrong) {
        const providerMatchesScript = (script.language === "en" && LATIN_LANGUAGE_CODES.has(allowedProvider))
          || (script.language === "zh-Hans" && ["zh-Hans", "zh-Hant"].includes(allowedProvider));
        lockedLanguage = providerMatchesScript ? allowedProvider : script.language;
        lockedConfidence = script.confidence;
        return { ...script, language: lockedLanguage, providerLanguage: allowedProvider };
      }
      if (lockedLanguage !== "unknown") {
        return { language: lockedLanguage, confidence: lockedConfidence, isStrong: false, providerLanguage: provider, signal: script.signal };
      }
      if (allowedProvider !== "unknown") {
        lockedLanguage = allowedProvider;
        lockedConfidence = script.signal <= SHORT_SIGNAL_LIMIT ? 0.58 : 0.62;
        return { language: lockedLanguage, confidence: lockedConfidence, isStrong: false, providerLanguage: allowedProvider, signal: script.signal };
      }
      if (script.language !== "unknown" && script.signal > SHORT_SIGNAL_LIMIT) {
        if (isAllowed(script.language)) {
          lockedLanguage = script.language;
          lockedConfidence = script.confidence;
        }
      }
      return { ...script, language: lockedLanguage, confidence: lockedConfidence, providerLanguage: allowedProvider };
    },
    resolved(fallbackText = "") {
      const fallback = analyzeTranscript(fallbackText, { useKoreanGrammarEvidence: isEnglishKoreanOnly });
      if (rejectUnsupported(fallbackText, fallback)) return "unknown";
      if (lockedLanguage !== "unknown") return lockedLanguage;
      if (rejectedUnsupportedTranscript) return "unknown";
      return fallback.signal > SHORT_SIGNAL_LIMIT && isAllowed(fallback.language) ? fallback.language : "unknown";
    },
    reset() {
      lockedLanguage = "unknown";
      lockedConfidence = 0;
      rejectedUnsupportedTranscript = false;
    },
    resetForSpeakerBoundary() {
      lockedLanguage = "unknown";
      lockedConfidence = 0;
      rejectedUnsupportedTranscript = false;
    },
  };
}
