import { normalizeCommittedCreCaption } from "./cre-normalization.js";
import { applyGlossaryCorrections } from "./glossary-corrections.js";
import { isOutputInTargetLanguage } from "./language-gate.js";
import { normalizeCaptionLanguage } from "./languages.js";
import { createLocalTermRetriever } from "./local-term-retrieval.js";
import { evaluateCaptionPolish, isEllipsisPlaceholder, selectRelevantGlossary } from "./polish-policy.js";

function sameLanguageSourceFallback(sourceText, sourceLanguage, targetLanguage) {
  const source = String(sourceText ?? "").trim();
  const sourceCode = normalizeCaptionLanguage(sourceLanguage);
  const targetCode = normalizeCaptionLanguage(targetLanguage);
  if (source && sourceCode && sourceCode === targetCode && isOutputInTargetLanguage(source, targetCode)) {
    return source;
  }
  return "";
}

// 2026-07-29 fix: Caption Only와 Live Call의 최종 자막 품질이 갈라지지 않도록
// partial은 호출부에 남기고 committed caption만 이 단일 경로로 확정한다.
/**
 * @param {{
 *   sessionId?: string,
 *   compiledGlossary?: unknown,
 *   config?: {
 *     provider: string,
 *     glossary: string,
 *     tone: string,
 *     domain: string,
 *     polishPolicy: {mode: string},
 *   },
 *   polish?: ((request: {
 *     translatedText: string,
 *     sourceText: string,
 *     targetLanguage: string,
 *     tone: string,
 *     glossary: string,
 *     domain: string,
 *     polishProvider: "gemini",
 *   }) => Promise<unknown>) | null,
 * }} [options]
 */
export function createCommittedCaptionFinalizer({
  sessionId = "",
  compiledGlossary = undefined,
  config,
  polish = null,
} = {}) {
  if (!config || config.provider !== "gemini") throw new Error("GEMINI_CAPTION_CONFIG_REQUIRED");
  // A pinned document is loaded and fingerprint-verified by the server. Raw
  // host settings are a legacy-only input and must not compete with it.
  const legacyGlossary = compiledGlossary === undefined ? config.glossary : "";
  const termRetriever = createLocalTermRetriever(legacyGlossary, { sessionId, compiledGlossary });

  /** @param {{sourceText?: unknown, translatedText?: unknown, sourceLanguage?: unknown, targetLanguage?: unknown, hasPriorTextModelCall?: unknown}} [input] */
  async function finalize({ sourceText = "", translatedText = "", sourceLanguage = "", targetLanguage = "", hasPriorTextModelCall = false } = {}) {
    const rawSourceText = String(sourceText ?? "").normalize("NFC").trim();
    const rawTranslation = String(translatedText ?? "").normalize("NFC").trim();
    const sourceLanguageCode = String(sourceLanguage ?? "").trim();
    const targetLanguageCode = String(targetLanguage ?? "").trim();
    const draftForRecovery = rawTranslation || (rawSourceText.length >= 2 ? "…" : "");
    if (!draftForRecovery) return null;
    const repairedSourceText = termRetriever.repair(rawSourceText, {
      language: sourceLanguageCode,
      isFinal: true,
    });
    const repairedDraft = termRetriever.repair(draftForRecovery, {
      language: targetLanguageCode,
      isFinal: true,
    });
    const locallyCorrectedDraft = applyGlossaryCorrections(repairedDraft, {
      glossary: legacyGlossary,
      sourceText: repairedSourceText,
      targetLanguage: targetLanguageCode,
    });
    const hasLocalCorrection = repairedSourceText !== rawSourceText
      || repairedDraft !== rawTranslation
      || locallyCorrectedDraft !== repairedDraft;
    const termEvidence = termRetriever.assess({
      sourceText: repairedSourceText,
      translatedText: locallyCorrectedDraft,
      targetLanguage: targetLanguageCode,
    });
    const selectedGlossary = termEvidence.hasSourceTerm
      ? termEvidence.selectedGlossary
      : selectRelevantGlossary(legacyGlossary, {
        sourceText: repairedSourceText,
        translatedText: locallyCorrectedDraft,
      });
    const polishDecision = evaluateCaptionPolish(config.polishPolicy.mode, {
      text: locallyCorrectedDraft,
      sourceText: repairedSourceText,
      targetLanguage: targetLanguageCode,
      tone: config.tone,
      domain: config.domain,
      hasLocalCorrection,
      hasUnresolvedTerm: termEvidence.hasUnresolvedTerm,
      hasPriorTextModelCall: hasPriorTextModelCall === true,
    });
    let polishedText = locallyCorrectedDraft;
    if (polishDecision.shouldPolish && typeof polish === "function") {
      try {
        polishedText = String(await polish({
          translatedText: locallyCorrectedDraft,
          sourceText: repairedSourceText,
          targetLanguage: targetLanguageCode,
          tone: config.tone,
          glossary: selectedGlossary,
          domain: config.domain,
          polishProvider: "gemini",
        }) ?? "").trim() || locallyCorrectedDraft;
      } catch {
        polishedText = locallyCorrectedDraft;
      }
    }
    if (!rawTranslation
      && (isEllipsisPlaceholder(polishedText)
        || !isOutputInTargetLanguage(polishedText, targetLanguageCode))) {
      polishedText = sameLanguageSourceFallback(
        repairedSourceText,
        sourceLanguageCode,
        targetLanguageCode,
      );
      // A target-language error sentence is not a translation. Returning null
      // lets the gateway retain raw provenance and publish a health signal
      // without replacing the viewer's last valid caption.
      if (!polishedText) return null;
    }
    const correctedText = applyGlossaryCorrections(polishedText, {
      glossary: legacyGlossary,
      sourceText: repairedSourceText,
      targetLanguage: targetLanguageCode,
    });
    const text = normalizeCommittedCreCaption({
      text: correctedText,
      targetLanguage: targetLanguageCode,
      isFinal: true,
    });
    return Object.freeze({
      text,
      sourceText: repairedSourceText,
      rawSourceText,
      rawTranslation,
      selectedGlossary,
      polishDecision: Object.freeze({ ...polishDecision }),
    });
  }

  function release() {
    termRetriever.release();
  }

  return Object.freeze({ finalize, termRetriever, release });
}
