import { performance } from "node:perf_hooks";

import { compileGlossaryDocumentV1 } from "./glossary-document.js";
import { createLocalTermRetriever } from "./local-term-retrieval.js";

const FIXED_WORKLOAD = "offline_glossary_quality_v1";
const FIXED_MODEL = "deterministic_local_retrieval_v1";
const MAXIMUM_CASES = 1_000;
const MAXIMUM_TEXT_CHARACTERS = 4_000;
const REQUIRED_ACCURACY = 0.95;
const MAXIMUM_P95_MILLISECONDS = 300;

export const glossaryQualityEvaluationContract = Object.freeze({
  workload: FIXED_WORKLOAD,
  model: FIXED_MODEL,
  requiredAccuracy: REQUIRED_ACCURACY,
  maximumAddedLatencyP95Milliseconds: MAXIMUM_P95_MILLISECONDS,
  maximumCases: MAXIMUM_CASES,
});

/**
 * @typedef {object} GlossaryQualityMetrics
 * @property {1} schemaVersion
 * @property {string} workload
 * @property {string} model
 * @property {"pass" | "fail"} result
 * @property {number} caseCount
 * @property {number} targetTermCount
 * @property {number} targetTermHitCount
 * @property {number} targetTermAccuracy
 * @property {number} prohibitedRenderingCount
 * @property {number} falseCorrectionCount
 * @property {number} falseCorrectionRate
 * @property {number} invariantFailureCount
 * @property {number} cacheRepeatMatchCount
 * @property {number} cacheRepeatMismatchCount
 * @property {number} maximumPromptCharacters
 * @property {number} addedLatencyP50Milliseconds
 * @property {number} addedLatencyP95Milliseconds
 */

/**
 * Runs a synthetic, offline glossary quality gate. The returned object is safe
 * for metrics because it contains fixed labels and numeric aggregates only.
 * @param {unknown} input
 * @returns {Readonly<GlossaryQualityMetrics>}
 * @throws {Error} when the fixture shape or glossary contract is invalid.
 */
export function evaluateGlossaryQuality(input) {
  try {
    const fixture = parseFixture(input);
    const compiledGlossary = compileGlossaryDocumentV1(fixture.glossary);
    const termById = new Map(compiledGlossary.terms.map((term) => [term.id, term]));
    validateCases(fixture.cases, termById);
    return runEvaluation(fixture.cases, compiledGlossary, termById);
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_GLOSSARY_QUALITY_FIXTURE") throw error;
    throw new Error("INVALID_GLOSSARY_QUALITY_FIXTURE");
  }
}

function parseFixture(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || input.schemaVersion !== 1 || !input.glossary
    || !Array.isArray(input.cases) || input.cases.length < 1
    || input.cases.length > MAXIMUM_CASES) {
    throw new Error("INVALID_GLOSSARY_QUALITY_FIXTURE");
  }
  return input;
}

function validateCases(cases, termById) {
  for (const qualityCase of cases) {
    if (!qualityCase || typeof qualityCase !== "object" || Array.isArray(qualityCase)
      || !isBoundedText(qualityCase.category, 80)
      || !isBoundedText(qualityCase.sourceText, MAXIMUM_TEXT_CHARACTERS)
      || !isBoundedText(qualityCase.providerDraft, MAXIMUM_TEXT_CHARACTERS)
      || !Array.isArray(qualityCase.expectedTermIds)
      || !Array.isArray(qualityCase.preserveTargetFragments)
      || qualityCase.expectedTermIds.some((termId) => !isBoundedText(termId, 80) || !termById.has(termId))
      || qualityCase.preserveTargetFragments.some((fragment) => !isBoundedText(fragment, 240))
      || (qualityCase.expectNoGlossary !== undefined && typeof qualityCase.expectNoGlossary !== "boolean")) {
      throw new Error("INVALID_GLOSSARY_QUALITY_FIXTURE");
    }
  }
}

function isBoundedText(value, maximumCharacters) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumCharacters;
}

function runEvaluation(cases, compiledGlossary, termById) {
  const retriever = createLocalTermRetriever("", {
    sessionId: `quality-eval-${compiledGlossary.fingerprint.slice(-32)}`,
    compiledGlossary,
  });
  const latencySamples = [];
  let targetTermCount = 0;
  let targetTermHitCount = 0;
  let prohibitedRenderingCount = 0;
  let falseCorrectionCount = 0;
  let invariantFailureCount = 0;
  let cacheRepeatMatchCount = 0;
  let cacheRepeatMismatchCount = 0;
  let maximumPromptCharacters = 0;

  try {
    for (const qualityCase of cases) {
      const startedAt = performance.now();
      const selection = retriever.retrieve({
        sourceText: qualityCase.sourceText,
        targetLanguage: "ko",
        isFinal: true,
      });
      const repairedSource = retriever.repair(qualityCase.sourceText, { language: "en", isFinal: true });
      const repairedTarget = retriever.repair(qualityCase.providerDraft, { language: "ko", isFinal: true });
      latencySamples.push(performance.now() - startedAt);
      maximumPromptCharacters = Math.max(maximumPromptCharacters, selection.length);

      const repeatedSelection = retriever.retrieve({
        sourceText: qualityCase.sourceText,
        targetLanguage: "ko",
        isFinal: true,
      });
      if (repeatedSelection === selection) cacheRepeatMatchCount += 1;
      else cacheRepeatMismatchCount += 1;

      for (const termId of qualityCase.expectedTermIds) {
        targetTermCount += 1;
        const term = termById.get(termId);
        const target = term.doNotTranslate ? term.source : term.translations.ko;
        const mapping = `${term.source} = ${target}`;
        if (containsNormalized(selection, mapping) && containsNormalized(repairedTarget, target)) {
          targetTermHitCount += 1;
        }
      }

      for (const term of compiledGlossary.terms) {
        for (const forbidden of term.forbiddenTranslations) {
          prohibitedRenderingCount += countNormalizedOccurrences(repairedTarget, forbidden);
        }
      }
      for (const fragment of qualityCase.preserveTargetFragments) {
        if (!containsNormalized(repairedTarget, fragment)) invariantFailureCount += 1;
      }
      if (qualityCase.expectNoGlossary === true
        && (selection !== "" || repairedSource !== qualityCase.sourceText || repairedTarget !== qualityCase.providerDraft)) {
        falseCorrectionCount += 1;
      }
    }
  } finally {
    retriever.release();
  }

  const targetTermAccuracy = targetTermCount === 0 ? 1 : targetTermHitCount / targetTermCount;
  const falseCorrectionRate = falseCorrectionCount / cases.length;
  const addedLatencyP50Milliseconds = percentile(latencySamples, 0.5);
  const addedLatencyP95Milliseconds = percentile(latencySamples, 0.95);
  const isPassing = targetTermAccuracy >= REQUIRED_ACCURACY
    && prohibitedRenderingCount === 0
    && falseCorrectionCount === 0
    && invariantFailureCount === 0
    && cacheRepeatMismatchCount === 0
    && addedLatencyP95Milliseconds <= MAXIMUM_P95_MILLISECONDS;

  return Object.freeze({
    schemaVersion: 1,
    workload: FIXED_WORKLOAD,
    model: FIXED_MODEL,
    result: isPassing ? "pass" : "fail",
    caseCount: cases.length,
    targetTermCount,
    targetTermHitCount,
    targetTermAccuracy,
    prohibitedRenderingCount,
    falseCorrectionCount,
    falseCorrectionRate,
    invariantFailureCount,
    cacheRepeatMatchCount,
    cacheRepeatMismatchCount,
    maximumPromptCharacters,
    addedLatencyP50Milliseconds,
    addedLatencyP95Milliseconds,
  });
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase();
}

function containsNormalized(value, expected) {
  return normalize(value).includes(normalize(expected));
}

function countNormalizedOccurrences(value, search) {
  const source = normalize(value);
  const needle = normalize(search);
  if (!needle) return 0;
  let count = 0;
  let offset = source.indexOf(needle);
  while (offset >= 0) {
    count += 1;
    offset = source.indexOf(needle, offset + needle.length);
  }
  return count;
}

function percentile(samples, ratio) {
  if (samples.length === 0) return 0;
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * ratio) - 1);
  return Number(ordered[index].toFixed(3));
}
