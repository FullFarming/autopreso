import { detectSourceLanguage } from "./language-gate.js";
import { normalizeCaptionLanguage } from "./languages.js";

const SOURCE_VOTE_WINDOW_MS = 4_000;
const SOURCE_HOLD_MS = 2_000;
const SOURCE_SOLO_FALLBACK_MS = 15_000;
const SOURCE_SOLO_FALLBACK_REPORTS = 8;
const SUSTAINED_ENGLISH_MIN_CHARS = 12;
const SOURCE_TAIL_JUDGE_CHARS = 80;

export const sourceConsensusContract = Object.freeze({
  voteWindowMilliseconds: SOURCE_VOTE_WINDOW_MS,
  holdMilliseconds: SOURCE_HOLD_MS,
  soloFallbackMilliseconds: SOURCE_SOLO_FALLBACK_MS,
  soloFallbackReports: SOURCE_SOLO_FALLBACK_REPORTS,
  sustainedEnglishMinimumCharacters: SUSTAINED_ENGLISH_MIN_CHARS,
  sourceTailJudgeCharacters: SOURCE_TAIL_JUDGE_CHARS,
});

/** Exact source-language arbiter used by captions-only, separated from its
 * cross-channel echo text registry so every runtime can share the decision. */
export function createSourceLanguageConsensus({
  now: nowFn = () => Date.now(),
  voteWindowMs = SOURCE_VOTE_WINDOW_MS,
  holdMs = SOURCE_HOLD_MS,
  soloFallbackMs = SOURCE_SOLO_FALLBACK_MS,
  soloFallbackReports = SOURCE_SOLO_FALLBACK_REPORTS,
} = {}) {
  const sourceReports = new Map();
  const registeredChannels = new Set();
  let authoritativeSource = "unknown";
  let authoritativeAt = 0;
  let authoritativeIsConsensus = false;
  let sourceReportSequence = 0;
  let soloChallenge = emptySoloChallenge();

  function reportSource(channelKey, language, sourceText = "", options = {}) {
    const normalizedLanguage = normalizeCaptionLanguage(language) || "unknown";
    if (!channelKey || normalizedLanguage === "unknown") return;
    const now = nowFn();
    const tail = String(sourceText).slice(-SOURCE_TAIL_JUDGE_CHARS);
    const latinCount = (tail.match(/[A-Za-z]/g) || []).length;
    const sustainedEnglish = latinCount >= SUSTAINED_ENGLISH_MIN_CHARS
      && detectSourceLanguage(tail) === "en";
    sourceReportSequence += 1;
    sourceReports.set(channelKey, {
      language: normalizedLanguage,
      sustainedEnglish,
      isStrong: options.isStrong === true,
      at: now,
      sequence: sourceReportSequence,
    });
    const fresh = [...sourceReports.values()].filter((report) => now - report.at < voteWindowMs);
    const languages = fresh.map((report) => report.language);
    if (authoritativeIsConsensus && normalizedLanguage === authoritativeSource) {
      soloChallenge = emptySoloChallenge();
    } else if (authoritativeIsConsensus && options.isStrong === true && normalizedLanguage !== authoritativeSource) {
      soloChallenge = soloChallenge.language === normalizedLanguage
        && now - soloChallenge.lastAt < voteWindowMs
        ? { ...soloChallenge, count: soloChallenge.count + 1, lastAt: now }
        : { language: normalizedLanguage, count: 1, firstAt: now, lastAt: now };
    }
    const canUseSoloFallback = authoritativeIsConsensus
      && soloChallenge.count >= soloFallbackReports
      && now - soloChallenge.firstAt >= soloFallbackMs
      && !fresh.some((report) => report.language === authoritativeSource);
    if (languages.length >= 2 && languages.every((entry) => entry === languages[0])) {
      authoritativeSource = languages[0];
      authoritativeAt = now;
      authoritativeIsConsensus = true;
      soloChallenge = emptySoloChallenge();
    } else if (canUseSoloFallback) {
      authoritativeSource = soloChallenge.language;
      authoritativeAt = now;
      authoritativeIsConsensus = false;
      soloChallenge = emptySoloChallenge();
    } else if (
      fresh.some((report) => report.sustainedEnglish)
      && fresh.length >= 2
      && !(authoritativeIsConsensus && now - authoritativeAt <= holdMs)
      && !(authoritativeSource !== "unknown" && now - authoritativeAt <= holdMs
        && fresh.some((report) => report.language === authoritativeSource && report.isStrong))
    ) {
      authoritativeSource = "en";
      authoritativeAt = now;
      authoritativeIsConsensus = false;
      soloChallenge = emptySoloChallenge();
    } else if (
      !authoritativeIsConsensus
      && authoritativeSource !== "unknown"
      && !fresh.some((report) => report.language === authoritativeSource)
      && now - authoritativeAt > holdMs
    ) {
      authoritativeSource = "unknown";
      authoritativeAt = 0;
      authoritativeIsConsensus = false;
      soloChallenge = emptySoloChallenge();
    }
  }

  function resolveSource(fallback = "unknown", options = {}) {
    const normalizedFallback = normalizeCaptionLanguage(fallback) || "unknown";
    if (options.isStrong === true && normalizedFallback !== "unknown" && normalizedFallback !== authoritativeSource) {
      const now = nowFn();
      if (authoritativeIsConsensus && authoritativeSource !== "unknown") return authoritativeSource;
      const ownReport = options.channelKey === undefined ? null : sourceReports.get(options.channelKey);
      const competingReports = [...sourceReports.entries()]
        .filter(([channelKey, report]) => channelKey !== options.channelKey
          && report.language === authoritativeSource
          && now - report.at < holdMs)
        .map(([, report]) => report);
      if (competingReports.some((report) => report.isStrong)) return authoritativeSource;
      const newestCompetingSequence = Math.max(0, ...competingReports.map((report) => report.sequence));
      if (!ownReport || ownReport.sequence > newestCompetingSequence) return normalizedFallback;
    }
    if (authoritativeSource === "unknown") return normalizedFallback;
    if (nowFn() - authoritativeAt > holdMs) return normalizedFallback;
    return authoritativeSource;
  }

  function resetSource(channelKey) {
    if (channelKey === undefined) {
      sourceReports.clear();
      authoritativeSource = "unknown";
      authoritativeAt = 0;
      authoritativeIsConsensus = false;
      soloChallenge = emptySoloChallenge();
      return;
    }
    sourceReports.delete(channelKey);
    const now = nowFn();
    const fresh = [...sourceReports.values()].filter((report) => now - report.at < voteWindowMs);
    if (fresh.some((report) => report.language === authoritativeSource)) return;
    if (!authoritativeIsConsensus && now - authoritativeAt > holdMs) {
      authoritativeSource = "unknown";
      authoritativeAt = 0;
      authoritativeIsConsensus = false;
      soloChallenge = emptySoloChallenge();
    }
  }

  return {
    reportSource,
    resolveSource,
    resetSource,
    report(channelKey, language, { isStrong = false, sourceText = "" } = {}) {
      reportSource(channelKey, language, sourceText, { isStrong });
      return resolveSource("unknown");
    },
    resolve: resolveSource,
    reset() {
      resetSource();
    },
    resetForSpeakerBoundary() {
      resetSource();
    },
    registerChannel(channelKey) {
      if (channelKey !== undefined) registeredChannels.add(channelKey);
    },
    unregisterChannel(channelKey) {
      registeredChannels.delete(channelKey);
      resetSource(channelKey);
    },
    clearChannel(channelKey) {
      resetSource(channelKey);
    },
  };
}

function emptySoloChallenge() {
  return { language: "unknown", count: 0, firstAt: 0, lastAt: 0 };
}
