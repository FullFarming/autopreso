import { LIVE_TRANSLATION_LANGUAGES, normalizeLiveLanguage, textPlausiblyInLanguage } from "./config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Output-language gating — PORT of the desktop subtitle engine's language
// decisions (src/subtitle-realtime.js: detectSourceLanguage, detectLanguage,
// countLanguageSignalChars, countLanguageCharsFor, shouldDisplay). The desktop
// engine is the reference: media-gateway is a separate npm package with its own
// Dockerfile and cannot import from the repo root, so the logic is duplicated
// on purpose and pinned by test/live-language-gate-parity.test.js at the repo
// root. Change the two copies together.
//
// What this replaces: the gateway used to decide everything with
// textPlausiblyInLanguage() — a bare "does this script appear at all" test —
// and then FAIL OPEN, publishing the untranslated source on a target lane
// whenever translation threw or a language cooldown was active. With continuous
// English input the Korean lane therefore alternated real Korean translations
// and raw English. The desktop never does this: it SUPPRESSES output that is
// not in the lane's language instead of passing the source through.
//
// Deliberately NOT ported: the desktop's cross-channel consensus arbiter
// (SOURCE_VOTE_WINDOW_MS / SOURCE_HOLD_MS / sustained-English tie-break). That
// machinery exists because the desktop runs one Gemini Live channel PER target
// language, each independently reporting a source language, so their votes have
// to be reconciled. The gateway has a single STT that produces one
// sourceLanguage for all lanes — there are no sibling votes to arbitrate. The
// part of that subsystem that DOES apply here is the Korean-preference
// count+ratio gate inside detectSourceLanguage, which is ported below.
// ─────────────────────────────────────────────────────────────────────────────

const KOREAN_CHAR = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
const JAPANESE_CHAR = /[ぁ-んァ-ヶーｱ-ﾝ一-龯々]/;
const ENGLISH_CHAR = /[A-Za-z]/;
const EXTRA_SIGNAL_CHAR = /[À-ÖØ-öø-ÿĀ-ỹА-яЁёก-๛؀-ۿ]/;

const LANGUAGE_LOCK_MIN_SIGNAL_CHARS = 4;
const LANGUAGE_LOCK_MIN_CONFIDENCE = 0.68;
// Korean-preference gate for MIXED Korean+English text. Hangul is the
// unambiguously-detectable script so it is trusted — but only when there is
// ENOUGH of it to mean Korean is actually being spoken, not a stray Hangul
// character (a place name, an STT mis-transcription) contaminating otherwise
// English speech. Requires both a minimum COUNT and a minimum RATIO.
const KOREAN_MIX_MIN_CHARS = 3;
const KOREAN_MIX_MIN_RATIO = 0.2;
// Output display gate: text with at least this many signal characters is long
// enough to judge; below it the lenient "too short to tell" rule applies.
const OUTPUT_LANGUAGE_JUDGE_MIN_CHARS = 8;
// Presence, not dominance: a Korean caption legitimately carries English proper
// nouns and acronyms whose Latin characters OUTNUMBER the Hangul.
const OUTPUT_LANGUAGE_MIN_TARGET_CHARS = 3;

const SCRIPT_PATTERNS = {
  "latin-basic": /[A-Za-z]/,
  latin: /[A-Za-zÀ-ÖØ-öø-ÿĀ-ỹ]/,
  hangul: /[가-힣ㄱ-ㅎㅏ-ㅣ]/,
  japanese: /[ぁ-んァ-ヶーｱ-ﾝ一-龯々]/,
  han: /[一-龯々]/,
  cyrillic: /[А-яЁё]/,
  devanagari: /[ऀ-ॿ]/,
};

/** Script per gateway caption language (LIVE_TRANSLATION_LANGUAGES). */
const LANGUAGE_SCRIPTS = {
  en: "latin-basic",
  ko: "hangul",
  ja: "japanese",
  "zh-Hans": "han",
  "zh-Hant": "han",
  es: "latin",
  pt: "latin",
  fr: "latin",
  de: "latin",
  it: "latin",
  id: "latin-basic",
  vi: "latin",
  ru: "cyrillic",
  hi: "devanagari",
};

export function languageCharPattern(code) {
  const script = LANGUAGE_SCRIPTS[normalizeLiveLanguage(code)] ?? "latin-basic";
  return SCRIPT_PATTERNS[script] ?? SCRIPT_PATTERNS["latin-basic"];
}

export function countLanguageSignalChars(value) {
  let count = 0;
  for (const char of String(value ?? "")) {
    if (KOREAN_CHAR.test(char) || JAPANESE_CHAR.test(char) || ENGLISH_CHAR.test(char) || EXTRA_SIGNAL_CHAR.test(char)) count += 1;
  }
  return count;
}

/** Characters belonging to one language's script — used by the output gate to
 *  confirm the target language is PRESENT even when English proper nouns
 *  inflate the Latin count of a Korean/Japanese translation. */
export function countLanguageCharsFor(value, language) {
  const pattern = languageCharPattern(language);
  let count = 0;
  for (const char of String(value ?? "")) {
    if (pattern.test(char)) count += 1;
  }
  return count;
}

export function detectSourceLanguage(value, options = {}) {
  return detectLanguage(value, { preferKoreanWhenMixedWithEnglish: true, ...options });
}

function detectLanguage(value, options = {}) {
  const text = String(value ?? "");
  const counts = { ko: 0, ja: 0, en: 0 };
  for (const char of text) {
    if (KOREAN_CHAR.test(char)) counts.ko += 1;
    else if (JAPANESE_CHAR.test(char)) counts.ja += 1;
    else if (ENGLISH_CHAR.test(char)) counts.en += 1;
  }
  const signalCount = counts.ko + counts.ja + counts.en;
  const minimumSignalChars = options.minimumSignalChars ?? LANGUAGE_LOCK_MIN_SIGNAL_CHARS;
  if (signalCount < minimumSignalChars) return "unknown";
  if (options.preferKoreanWhenMixedWithEnglish && counts.ko > 0 && counts.en > 0 && counts.ja === 0) {
    // Trust Hangul as the direction signal ONLY when there is enough of it to
    // mean Korean is actually being spoken — a meaningful COUNT and RATIO.
    const koRatio = counts.ko / (counts.ko + counts.en);
    if (counts.ko >= KOREAN_MIX_MIN_CHARS && koRatio >= KOREAN_MIX_MIN_RATIO) return "ko";
    // Otherwise fall through to dominance/confidence: English-dominant → en.
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [dominantLanguage, dominantCount] = entries[0];
  if (dominantCount === entries[1][1]) return "unknown";
  const confidence = dominantCount / signalCount;
  if (confidence < (options.minimumConfidence ?? LANGUAGE_LOCK_MIN_CONFIDENCE)) return "unknown";
  return dominantLanguage;
}

/**
 * The desktop's shouldDisplay() output-language gate: is this text actually in
 * the lane's language? Short text is too small to judge, so it is allowed
 * through (suppressing "네" or "OK" would blank the feed during back-channel
 * speech). Longer text must carry at least a few characters of the target
 * language, which rejects a raw same-language echo while still accepting a
 * genuine translation full of foreign proper nouns.
 */
export function isOutputInTargetLanguage(text, targetLanguage) {
  const value = String(text ?? "");
  if (countLanguageSignalChars(value) < OUTPUT_LANGUAGE_JUDGE_MIN_CHARS) return true;
  return countLanguageCharsFor(value, targetLanguage) >= OUTPUT_LANGUAGE_MIN_TARGET_CHARS;
}

/**
 * Should this lane publish the STT text VERBATIM (contract C6 dual-language
 * passthrough) rather than translating it?
 *
 * Only when the STT's detected language IS this lane, AND the text itself
 * agrees. The agreement check used to be textPlausiblyInLanguage(), which
 * answers "does this script appear at all" — so English carrying one Korean
 * place name counted as Korean and was published untranslated on the KO lane.
 * detectSourceLanguage applies the count+ratio gate instead. Text too short to
 * classify falls back to the script test so back-channel replies still pass.
 */
export function sourceLaneMatches(text, sttLanguage, laneLanguage) {
  const stt = normalizeLiveLanguage(sttLanguage);
  const lane = normalizeLiveLanguage(laneLanguage);
  if (!stt || !lane || stt !== lane) return false;
  const detected = detectSourceLanguage(text);
  if (detected === "unknown") return textPlausiblyInLanguage(text, lane);
  // Detection only distinguishes ko/ja/en; for any other lane its verdict is
  // not authoritative, so keep the script test as the decider there.
  if (!["ko", "ja", "en"].includes(lane)) return textPlausiblyInLanguage(text, lane);
  return detected === lane;
}

export const languageGateContract = Object.freeze({
  koreanMixMinChars: KOREAN_MIX_MIN_CHARS,
  koreanMixMinRatio: KOREAN_MIX_MIN_RATIO,
  outputJudgeMinChars: OUTPUT_LANGUAGE_JUDGE_MIN_CHARS,
  outputMinTargetChars: OUTPUT_LANGUAGE_MIN_TARGET_CHARS,
  supportedLanguages: LIVE_TRANSLATION_LANGUAGES,
});
