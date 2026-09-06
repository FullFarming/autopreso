import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { evaluateCaptionPolish as evaluateSharedCaptionPolish } from "../packages/caption-core/index.js";

test("the shared caption polish policy covers every supported mode and risk reason", () => {
  const matrix = [
    {
      name: "already translated by the text model",
      policy: "selective",
      input: {
        text: "The company presented.",
        sourceText: "쿠시먼이 발표했습니다.",
        targetLanguage: "en",
        hasUnresolvedTerm: true,
        hasPriorTextModelCall: true,
      },
      expected: { shouldPolish: false, reason: "model_translation" },
    },
    {
      name: "locally corrected term",
      policy: "selective",
      input: {
        text: "Cushman & Wakefield presented.",
        sourceText: "쿠쉬먼이 발표했습니다.",
        targetLanguage: "en",
        hasLocalCorrection: true,
      },
      expected: { shouldPolish: false, reason: "local_correction" },
    },
    {
      name: "unresolved source term",
      policy: "selective",
      input: {
        text: "The company presented.",
        sourceText: "쿠시먼이 발표했습니다.",
        targetLanguage: "en",
        hasUnresolvedTerm: true,
      },
      expected: { shouldPolish: true, reason: "term_unresolved" },
    },
    {
      name: "ordinary unconfigured caption",
      policy: "selective",
      input: {
        text: "일반 번역 문장입니다.",
        sourceText: "This is an ordinary translated sentence.",
        targetLanguage: "ko",
      },
      expected: { shouldPolish: false, reason: "ordinary" },
    },
    {
      name: "placeholder",
      policy: "selective",
      input: { text: "…", sourceText: "This sentence has enough content.", targetLanguage: "ko" },
      expected: { shouldPolish: true, reason: "placeholder" },
    },
    {
      name: "wrong target language",
      policy: "selective",
      input: { text: "Ở đây bạn có thể xem", sourceText: "여기서 보실 수 있어요.", targetLanguage: "en" },
      expected: { shouldPolish: true, reason: "wrong_language" },
    },
    {
      name: "translation anomaly",
      policy: "selective",
      input: { text: "�", sourceText: "This translation was corrupted.", targetLanguage: "en" },
      expected: { shouldPolish: true, reason: "translation_anomaly" },
    },
    {
      name: "off",
      policy: "off",
      input: { text: "…", sourceText: "A complete source sentence.", targetLanguage: "ko" },
      expected: { shouldPolish: false, reason: "policy_off" },
    },
    {
      name: "full",
      policy: "full",
      input: { text: "일반 문장입니다.", sourceText: "An ordinary line.", targetLanguage: "ko" },
      expected: { shouldPolish: true, reason: "policy_full" },
    },
  ];

  for (const fixture of matrix) {
    const shared = evaluateSharedCaptionPolish(fixture.policy, {
      ...fixture.input,
      ...fixture.sharedInput,
    });
    assert.deepEqual(shared, fixture.expected, `shared ${fixture.name}`);
  }
});

test("Caption Only and Live Call both skip configured ordinary finals under selective policy", () => {
  const ordinary = {
    text: "일반 번역 문장입니다.",
    sourceText: "This is an ordinary translated sentence.",
    targetLanguage: "ko",
  };
  const desktopSelective = evaluateSharedCaptionPolish("selective", ordinary);
  assert.deepEqual(desktopSelective, { shouldPolish: false, reason: "ordinary" });

  const configuredCases = [
    { name: "business", configured: { tone: "business" } },
    { name: "glossary", configured: { glossary: "operator = 운영사" } },
    { name: "domain", configured: { domain: "Commercial real estate" } },
  ];
  for (const { name, configured } of configuredCases) {
    const configuredOrdinary = { ...ordinary, ...configured };
    assert.deepEqual(
      evaluateSharedCaptionPolish("selective", configuredOrdinary),
      desktopSelective,
      `Live Call ${name} configuration must not force a model call for ordinary text`,
    );
  }
});

test("the shared policy rejects an unknown mode", () => {
  assert.throws(() => evaluateSharedCaptionPolish("surprise", {}), /INVALID_CAPTION_POLISH_POLICY/u);
});

test("Caption Only and Live Call both wire finals through the shared committed finalizer", async () => {
  const [desktop, liveCall] = await Promise.all([
    readFile(new URL("../src/subtitle-realtime.js", import.meta.url), "utf8"),
    readFile(new URL("../media-gateway/src/live-media-pipeline.js", import.meta.url), "utf8"),
  ]);
  assert.match(desktop, /createCommittedCaptionFinalizer/u);
  assert.match(liveCall, /createCommittedCaptionFinalizer/u);
  assert.doesNotMatch(liveCall, /function evaluateCaptionPolish/u);
});
