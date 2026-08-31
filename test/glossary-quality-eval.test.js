import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  evaluateGlossaryQuality,
  glossaryQualityEvaluationContract,
} from "../packages/caption-core/glossary-quality-eval.js";

const fixtureUrl = new URL("./fixtures/glossary-quality-golden-v1.json", import.meta.url);

async function loadFixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

test("synthetic golden set covers the approved professional and language risks", async () => {
  const fixture = await loadFixture();
  const categories = new Set(fixture.cases.map((qualityCase) => qualityCase.category));

  for (const category of [
    "finance",
    "cre",
    "proper-name",
    "acronym",
    "numbers",
    "negation",
    "mixed-language",
    "accent",
    "near-match",
  ]) {
    assert.equal(categories.has(category), true, `missing ${category} cases`);
  }
  assert.ok(fixture.cases.length >= 30);
  assert.ok(fixture.glossary.terms.length >= 20);
});

test("offline glossary evaluation meets accuracy, safety, latency, and cache thresholds", async () => {
  const fixture = await loadFixture();
  const metrics = evaluateGlossaryQuality(fixture);

  assert.equal(metrics.schemaVersion, 1);
  assert.equal(metrics.workload, glossaryQualityEvaluationContract.workload);
  assert.equal(metrics.model, glossaryQualityEvaluationContract.model);
  assert.equal(metrics.result, "pass");
  assert.ok(metrics.targetTermAccuracy >= 0.95, JSON.stringify(metrics));
  assert.equal(metrics.prohibitedRenderingCount, 0);
  assert.equal(metrics.falseCorrectionCount, 0);
  assert.equal(metrics.invariantFailureCount, 0);
  assert.equal(metrics.cacheRepeatMismatchCount, 0);
  assert.equal(metrics.cacheRepeatMatchCount, fixture.cases.length);
  assert.ok(metrics.addedLatencyP95Milliseconds <= 300, JSON.stringify(metrics));
  assert.ok(metrics.maximumPromptCharacters <= 2_000);
});

test("evaluation output is fixed-label numeric telemetry without transcripts, prompts, or PII", async () => {
  const fixture = await loadFixture();
  const metrics = evaluateGlossaryQuality(fixture);
  const serialized = JSON.stringify(metrics);

  assert.deepEqual(Object.keys(metrics).sort(), [
    "addedLatencyP50Milliseconds",
    "addedLatencyP95Milliseconds",
    "cacheRepeatMatchCount",
    "cacheRepeatMismatchCount",
    "caseCount",
    "falseCorrectionCount",
    "falseCorrectionRate",
    "invariantFailureCount",
    "maximumPromptCharacters",
    "model",
    "prohibitedRenderingCount",
    "result",
    "schemaVersion",
    "targetTermAccuracy",
    "targetTermCount",
    "targetTermHitCount",
    "workload"
  ].sort());
  assert.doesNotMatch(serialized, /qa\.fixture@example\.invalid|raw-marker-7H2K/u);
  assert.doesNotMatch(serialized, /sourceText|providerDraft|rawPrompt|promptText|transcript|email|session|token/iu);
  for (const qualityCase of fixture.cases) {
    assert.equal(serialized.includes(qualityCase.sourceText), false);
    assert.equal(serialized.includes(qualityCase.providerDraft), false);
  }
});

test("invalid or empty evaluation fixtures fail closed", () => {
  for (const invalid of [null, {}, { schemaVersion: 2 }, { schemaVersion: 1, glossary: {}, cases: [] }]) {
    assert.throws(() => evaluateGlossaryQuality(invalid), /INVALID_GLOSSARY_QUALITY_FIXTURE/u);
  }
});
