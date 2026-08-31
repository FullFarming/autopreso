import assert from "node:assert/strict";
import test from "node:test";

import {
  GLOSSARY_TERM_PAGE_SIZE,
  applyGlossaryTermDraft,
  buildGlossaryValidationSummary,
  createGlossaryDraftEdits,
  createGlossaryTermWindow,
  evaluateGlossarySessionSelection,
  getGlossarySessionOptionAvailability,
  selectGlossarySessionVersion,
  toggleGlossarySessionSelection,
  type GlossarySessionOption,
  type GlossaryPresetPresentation,
  type GlossaryTermPresentation,
  type GlossaryValidationIssue,
} from "./glossary-presentation";

const sessionOptions: GlossarySessionOption[] = [
  { sourceKind: "builtin", sourceId: "common_business", label: "공통 비즈니스", group: "builtin", sourceLanguage: "ko", targetLanguages: ["en", "ja"], conflictKeys: [] },
  { sourceKind: "builtin", sourceId: "commercial_real_estate", label: "상업용 부동산", group: "builtin", sourceLanguage: "ko", targetLanguages: ["en"], conflictKeys: ["operator"] },
  { sourceKind: "builtin", sourceId: "hospitality", label: "호텔·호스피탈리티", group: "builtin", sourceLanguage: "ko", targetLanguages: ["en"], conflictKeys: ["operator"] },
  { sourceKind: "builtin", sourceId: "fnb_retail", label: "F&B·리테일", group: "builtin", sourceLanguage: "ko", targetLanguages: ["en"], conflictKeys: [] },
  { sourceKind: "builtin", sourceId: "proper_nouns", label: "고유명사", group: "builtin", sourceLanguage: "ko", targetLanguages: ["en", "ja"], conflictKeys: [] },
  { sourceKind: "builtin", sourceId: "ko_ja_idioms", label: "한·일 관용표현", group: "builtin", sourceLanguage: "ko", targetLanguages: ["ja"], conflictKeys: [] },
];

const preset: GlossaryPresetPresentation = {
  id: "preset-cre",
  name: "CRE 실적 발표",
  domain: "상업용 부동산",
  languageTags: ["원문 ko", "en"],
  languagePairLabel: "한국어 → English",
  activeVersion: 2,
  latestVersion: 3,
  termCount: 48,
};

test("validation summary counts blocking errors and routes to the first invalid field", () => {
  const issues: GlossaryValidationIssue[] = [
    { id: "warning-1", severity: "warning", message: "별칭이 깁니다.", fieldId: "term-alias-2" },
    { id: "error-1", severity: "error", message: "번역어를 입력해 주세요.", fieldId: "term-target-4" },
    { id: "error-2", severity: "error", message: "중복 용어입니다.", fieldId: "term-source-7" },
  ];

  assert.deepEqual(buildGlossaryValidationSummary(issues), {
    errorCount: 2,
    warningCount: 1,
    firstErrorFieldId: "term-target-4",
  });
});

test("session selection requires an explicitly active preset version", () => {
  assert.deepEqual(selectGlossarySessionVersion(preset, 2), {
    presetId: "preset-cre",
    presetName: "CRE 실적 발표",
    version: 2,
  });
  assert.equal(selectGlossarySessionVersion(preset, 3), null);
  assert.equal(selectGlossarySessionVersion({ ...preset, activeVersion: null }, 1), null);
});

test("session checklist enforces five selections immutably and reports language incompatibility", () => {
  const five = sessionOptions.slice(0, 5).map((option) => ({ sourceKind: option.sourceKind, sourceId: option.sourceId }));
  const capped = toggleGlossarySessionSelection(sessionOptions, five, sessionOptions[5]!, ["en"]);
  assert.equal(capped.ok, false);
  assert.equal(capped.code, "GLOSSARY_SELECTION_LIMIT");
  assert.deepEqual(capped.selections, five);

  const incompatible = toggleGlossarySessionSelection(sessionOptions, [], sessionOptions[5]!, ["en"]);
  assert.equal(incompatible.ok, false);
  assert.equal(incompatible.code, "INCOMPATIBLE_GLOSSARY_LANGUAGE");
  assert.deepEqual(incompatible.selections, []);
});

test("session checklist keeps the required final selection", () => {
  const selected = [{ sourceKind: "builtin" as const, sourceId: "common_business" }];
  const result = toggleGlossarySessionSelection(sessionOptions, selected, sessionOptions[0]!, ["en"]);
  assert.equal(result.ok, false);
  assert.equal(result.code, "GLOSSARY_SELECTION_REQUIRED");
  assert.deepEqual(result.selections, selected);
});

test("host preset source language is never treated as a compatible target", () => {
  const englishToKorean: GlossarySessionOption = {
    sourceKind: "host",
    sourceId: "preset-en-ko",
    documentVersion: 2,
    label: "영한 용어집",
    group: "host",
    sourceLanguage: "en",
    targetLanguages: ["ko"],
    conflictKeys: [],
  };
  const result = toggleGlossarySessionSelection([englishToKorean], [], englishToKorean, ["en"]);
  assert.equal(result.ok, false);
  assert.equal(result.code, "INCOMPATIBLE_GLOSSARY_LANGUAGE");
});

test("session checklist blocks glossary sources that cannot be merged", () => {
  const englishSource: GlossarySessionOption = {
    sourceKind: "host",
    sourceId: "preset-en-ja",
    documentVersion: 3,
    label: "영일 용어집",
    group: "host",
    sourceLanguage: "en",
    targetLanguages: ["ja"],
    conflictKeys: [],
  };
  const result = toggleGlossarySessionSelection(
    [...sessionOptions, englishSource],
    [{ sourceKind: "builtin", sourceId: "fnb_retail" }],
    englishSource,
    ["ja"],
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "INCOMPATIBLE_GLOSSARY_LANGUAGE");
});

test("session checklist disables a different source language without trapping selected items", () => {
  const englishSource: GlossarySessionOption = {
    sourceKind: "host",
    sourceId: "preset-en-ja",
    documentVersion: 3,
    label: "영일 용어집",
    group: "host",
    sourceLanguage: "en",
    targetLanguages: ["ja"],
    conflictKeys: [],
  };
  const options = [...sessionOptions, englishSource];
  const koreanSelection = [{ sourceKind: "builtin" as const, sourceId: "fnb_retail" }];
  assert.deepEqual(getGlossarySessionOptionAvailability(options, koreanSelection, englishSource, ["ja"]), {
    isSelected: false,
    isTargetCompatible: true,
    isSourceCompatible: false,
    isDisabled: true,
  });
  assert.equal(getGlossarySessionOptionAvailability(options, koreanSelection, sessionOptions[3]!, ["ja"]).isDisabled, false);
});

test("session checklist surfaces unresolved equal-priority conflicts before application", () => {
  const selected = sessionOptions.slice(1, 3).map((option) => ({ sourceKind: option.sourceKind, sourceId: option.sourceId }));
  const result = evaluateGlossarySessionSelection(sessionOptions, selected, ["en"]);
  assert.equal(result.isCompatible, true);
  assert.deepEqual(result.conflictKeys, ["operator"]);
  assert.equal(result.hasConflict, true);
});

test("10k terms keep the initial DOM window at 50 rows and search visits each term once", () => {
  const terms: GlossaryTermPresentation[] = Array.from({ length: 10_000 }, (_, index) => ({
    id: `term-${index}`,
    source: index % 100 === 0 ? `순영업소득 ${index}` : `원문 ${index}`,
    target: `Target ${index}`,
    aliases: [`Alias ${index}`],
    status: "approved",
  }));

  const initial = createGlossaryTermWindow(terms, "", 0);
  assert.equal(initial.items.length, GLOSSARY_TERM_PAGE_SIZE);
  assert.equal(initial.totalMatchCount, 10_000);
  assert.equal(initial.visitedCount, 0);

  const searched = createGlossaryTermWindow(terms, "순영업소득", 0);
  assert.equal(searched.visitedCount, 10_000);
  assert.equal(searched.totalMatchCount, 100);
  assert.equal(searched.items.length, GLOSSARY_TERM_PAGE_SIZE);
  assert.equal(new Set(searched.items.map((item) => item.term.id)).size, GLOSSARY_TERM_PAGE_SIZE);
});

test("bounded pagination and immutable drafts preserve edits outside the visible window", () => {
  const terms: GlossaryTermPresentation[] = Array.from({ length: 120 }, (_, index) => ({
    id: `term-${index}`,
    source: `원문 ${index}`,
    target: `Target ${index}`,
    aliases: [],
    status: "approved",
  }));
  const firstDrafts = applyGlossaryTermDraft({}, "term-2", "source", "수정된 원문");
  const nextDrafts = applyGlossaryTermDraft(firstDrafts, "term-88", "target", "Edited target");
  const finalEdits = createGlossaryDraftEdits(terms, nextDrafts);
  const lastPage = createGlossaryTermWindow(terms, "", 100);
  const editedSearch = createGlossaryTermWindow(terms, "edited target", 0, nextDrafts);

  assert.equal(lastPage.items.length, 20);
  assert.equal(lastPage.items[0]?.index, 100);
  assert.equal(finalEdits[2]?.source, "수정된 원문");
  assert.equal(finalEdits[88]?.target, "Edited target");
  assert.equal(editedSearch.items[0]?.term.id, "term-88");
  assert.equal(firstDrafts["term-88"], undefined);
  assert.notEqual(nextDrafts, firstDrafts);
});
