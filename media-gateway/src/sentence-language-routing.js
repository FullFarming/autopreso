import { resolveSourceLanguageObservation } from '../../packages/caption-core/language-gate.js';
import { normalizeCaptionLanguage } from '../../packages/caption-core/languages.js';

// 2026-09-05 fix: Interim language tags may be revised mid-utterance. Hold only
// the routing decision; final text and mixed/unknown evidence remain untouched.
export function createSentenceLanguageRouting() {
  let key = null;
  let sourceHint = null;
  function reset() { key = null; sourceHint = null; }
  return {
    observe(text, providerLanguage, sentenceKey = null) {
      if (sentenceKey !== null && sentenceKey !== key) { reset(); key = sentenceKey; }
      const observation = resolveSourceLanguageObservation(text, providerLanguage);
      const suppressSource = Boolean(sourceHint && observation.state === 'single' && observation.languageCode !== sourceHint);
      if (!sourceHint && observation.state === 'single') sourceHint = observation.languageCode;
      return { observation, sourceHint, suppressSource };
    },
    resolveHint(providerLanguage) { return sourceHint ?? (normalizeCaptionLanguage(providerLanguage) || null); },
    complete(sentenceKey = null) { if (sentenceKey === null || sentenceKey === key) reset(); },
    reset,
  };
}
