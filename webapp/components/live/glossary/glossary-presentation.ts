export type GlossaryTermStatus = "approved" | "candidate";

export interface GlossaryTermPresentation {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly translations?: Readonly<Record<string, string>>;
  readonly doNotTranslate?: boolean;
  readonly aliases: readonly string[];
  readonly note?: string;
  readonly status: GlossaryTermStatus;
}

export interface GlossaryPresetPresentation {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly languagePairLabel: string;
  readonly languageTags: readonly string[];
  readonly activeVersion: number | null;
  readonly latestVersion: number;
  readonly termCount: number | null;
}

export interface GlossaryVersionPresentation {
  readonly id: string;
  readonly version: number;
  readonly createdAtLabel: string;
  readonly termCount: number | null;
  readonly state: "draft" | "active" | "superseded";
}

export interface GlossaryValidationIssue {
  readonly id: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly fieldId: string;
}

export interface GlossaryImportPreviewPresentation {
  readonly fileName: string;
  readonly approvedCount: number;
  readonly candidateCount: number;
  readonly ignoredCount: number;
}

export interface GlossarySessionSelection {
  readonly presetId: string;
  readonly presetName: string;
  readonly version: number;
}

export interface GlossarySessionPinSelection {
  readonly sourceKind: "builtin" | "host";
  readonly sourceId: string;
  readonly documentVersion?: number;
}

export interface GlossarySessionOption extends GlossarySessionPinSelection {
  readonly label: string;
  readonly description?: string;
  readonly group: "builtin" | "host";
  readonly sourceLanguage: string;
  readonly targetLanguages: readonly string[];
  readonly conflictKeys: readonly string[];
}

export interface GlossarySessionSelectionEvaluation {
  readonly isCompatible: boolean;
  readonly incompatibleIds: readonly string[];
  readonly hasConflict: boolean;
  readonly conflictKeys: readonly string[];
}

export type GlossarySessionSelectionToggleResult = Readonly<{
  ok: true;
  selections: readonly GlossarySessionPinSelection[];
  evaluation: GlossarySessionSelectionEvaluation;
}> | Readonly<{
  ok: false;
  code: "GLOSSARY_SELECTION_REQUIRED" | "GLOSSARY_SELECTION_LIMIT" | "INCOMPATIBLE_GLOSSARY_LANGUAGE" | "GLOSSARY_SELECTION_CONFLICT";
  selections: readonly GlossarySessionPinSelection[];
  evaluation: GlossarySessionSelectionEvaluation;
}>;

const MAX_GLOSSARY_SESSION_SELECTIONS = 5;

function glossarySelectionKey(selection: GlossarySessionPinSelection): string {
  return `${selection.sourceKind}:${selection.sourceId}`;
}

export function getGlossarySessionOptionAvailability(
  options: readonly GlossarySessionOption[],
  selections: readonly GlossarySessionPinSelection[],
  option: GlossarySessionOption,
  targetLanguages: readonly string[],
) {
  const selectedKeys = new Set(selections.map(glossarySelectionKey));
  const isSelected = selectedKeys.has(glossarySelectionKey(option));
  const selectedSourceLanguage = options.find((candidate) => selectedKeys.has(glossarySelectionKey(candidate)))?.sourceLanguage;
  const isTargetCompatible = option.targetLanguages.some((language) => targetLanguages.includes(language));
  const isSourceCompatible = selectedSourceLanguage === undefined || selectedSourceLanguage === option.sourceLanguage;
  return {
    isSelected,
    isTargetCompatible,
    isSourceCompatible,
    isDisabled: !isSelected && (!isTargetCompatible || !isSourceCompatible),
  };
}

export function evaluateGlossarySessionSelection(
  options: readonly GlossarySessionOption[],
  selections: readonly GlossarySessionPinSelection[],
  targetLanguages: readonly string[],
): GlossarySessionSelectionEvaluation {
  const selectedKeys = new Set(selections.map(glossarySelectionKey));
  const selectedOptions = options.filter((option) => selectedKeys.has(glossarySelectionKey(option)));
  const targetIncompatibleIds = selectedOptions
    .filter((option) => !option.targetLanguages.some((language) => targetLanguages.includes(language)))
    .map((option) => option.sourceId);
  const sourceLanguages = new Set(selectedOptions.map((option) => option.sourceLanguage));
  const incompatibleIds = sourceLanguages.size > 1
    ? [...new Set([...targetIncompatibleIds, ...selectedOptions.map((option) => option.sourceId)])]
    : targetIncompatibleIds;
  const conflictCounts = new Map<string, number>();
  selectedOptions.forEach((option) => option.conflictKeys.forEach((key) => {
    conflictCounts.set(key, (conflictCounts.get(key) ?? 0) + 1);
  }));
  const conflictKeys = [...conflictCounts]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();
  return {
    isCompatible: incompatibleIds.length === 0,
    incompatibleIds,
    hasConflict: conflictKeys.length > 0,
    conflictKeys,
  };
}

export function toggleGlossarySessionSelection(
  options: readonly GlossarySessionOption[],
  selections: readonly GlossarySessionPinSelection[],
  option: GlossarySessionOption,
  targetLanguages: readonly string[],
): GlossarySessionSelectionToggleResult {
  const key = glossarySelectionKey(option);
  const isSelected = selections.some((selection) => glossarySelectionKey(selection) === key);
  const next = isSelected
    ? selections.filter((selection) => glossarySelectionKey(selection) !== key)
    : [...selections, { sourceKind: option.sourceKind, sourceId: option.sourceId, ...(option.documentVersion ? { documentVersion: option.documentVersion } : {}) }];
  const currentEvaluation = evaluateGlossarySessionSelection(options, selections, targetLanguages);
  if (isSelected && selections.length === 1) {
    return { ok: false, code: "GLOSSARY_SELECTION_REQUIRED", selections, evaluation: currentEvaluation };
  }
  if (!isSelected && selections.length >= MAX_GLOSSARY_SESSION_SELECTIONS) {
    return { ok: false, code: "GLOSSARY_SELECTION_LIMIT", selections, evaluation: currentEvaluation };
  }
  const evaluation = evaluateGlossarySessionSelection(options, next, targetLanguages);
  if (!evaluation.isCompatible) {
    return { ok: false, code: "INCOMPATIBLE_GLOSSARY_LANGUAGE", selections, evaluation };
  }
  if (evaluation.hasConflict) {
    return { ok: false, code: "GLOSSARY_SELECTION_CONFLICT", selections, evaluation };
  }
  return { ok: true, selections: next, evaluation };
}

export interface GlossaryDraftEdits {
  readonly name: string;
  readonly domain: string;
  readonly terms: readonly Readonly<{
    id: string;
    source: string;
    target: string;
    translations?: Readonly<Record<string, string>>;
    doNotTranslate?: boolean;
    aliases: string;
  }>[];
}

export type GlossaryTermDraftField = "source" | "target" | "aliases" | "doNotTranslate" | `translation:${string}`;
export type GlossaryTermDrafts = Readonly<Record<string, Partial<Record<GlossaryTermDraftField, string>>>>;

export interface GlossaryTermWindowItem {
  readonly term: GlossaryTermPresentation;
  readonly index: number;
}

export const GLOSSARY_TERM_PAGE_SIZE = 50;

export function createGlossaryTermWindow(
  terms: readonly GlossaryTermPresentation[],
  query: string,
  start: number,
  drafts: GlossaryTermDrafts = {},
) {
  const normalizedQuery = query.normalize("NFC").trim().toLocaleLowerCase();
  const safeStart = Math.max(0, start);
  if (!normalizedQuery) {
    return {
      items: terms.slice(safeStart, safeStart + GLOSSARY_TERM_PAGE_SIZE).map((term, offset) => ({ term: applyTermDraft(term, drafts), index: safeStart + offset })),
      totalMatchCount: terms.length,
      visitedCount: 0,
      hasPrevious: safeStart > 0,
      hasNext: safeStart + GLOSSARY_TERM_PAGE_SIZE < terms.length,
    };
  }
  const items: GlossaryTermWindowItem[] = [];
  let totalMatchCount = 0;
  for (let index = 0; index < terms.length; index += 1) {
    const sourceTerm = terms[index];
    if (!sourceTerm) continue;
    const term = applyTermDraft(sourceTerm, drafts);
    if (!matchesGlossaryQuery(term, normalizedQuery)) continue;
    if (totalMatchCount >= safeStart && items.length < GLOSSARY_TERM_PAGE_SIZE) items.push({ term, index });
    totalMatchCount += 1;
  }
  return {
    items,
    totalMatchCount,
    visitedCount: terms.length,
    hasPrevious: safeStart > 0,
    hasNext: safeStart + GLOSSARY_TERM_PAGE_SIZE < totalMatchCount,
  };
}

export function applyGlossaryTermDraft(
  drafts: GlossaryTermDrafts,
  termId: string,
  field: GlossaryTermDraftField,
  value: string,
): GlossaryTermDrafts {
  return { ...drafts, [termId]: { ...drafts[termId], [field]: value } };
}

export function createGlossaryDraftEdits(
  terms: readonly GlossaryTermPresentation[],
  drafts: GlossaryTermDrafts,
): GlossaryDraftEdits["terms"] {
  return terms.map((term) => ({
    id: term.id,
    source: drafts[term.id]?.source ?? term.source,
    target: drafts[term.id]?.target ?? term.target,
    aliases: drafts[term.id]?.aliases ?? term.aliases.join(", "),
    ...(term.translations ? { translations: Object.fromEntries(Object.entries(term.translations).map(([language, value]) => [language, drafts[term.id]?.[`translation:${language}`] ?? value])) } : {}),
    ...(term.doNotTranslate !== undefined || drafts[term.id]?.doNotTranslate !== undefined ? { doNotTranslate: drafts[term.id]?.doNotTranslate === undefined ? Boolean(term.doNotTranslate) : drafts[term.id]?.doNotTranslate === "true" } : {}),
  }));
}

function matchesGlossaryQuery(term: GlossaryTermPresentation, query: string): boolean {
  return [term.source, term.target, ...Object.values(term.translations ?? {}), ...term.aliases].some((value) => value.normalize("NFC").toLocaleLowerCase().includes(query));
}

function applyTermDraft(term: GlossaryTermPresentation, drafts: GlossaryTermDrafts): GlossaryTermPresentation {
  const draft = drafts[term.id];
  if (!draft) return term;
  return {
    ...term,
    source: draft.source ?? term.source,
    target: draft.target ?? term.target,
    ...(term.translations ? { translations: Object.fromEntries(Object.entries(term.translations).map(([language, value]) => [language, draft[`translation:${language}`] ?? value])) } : {}),
    doNotTranslate: draft.doNotTranslate === undefined ? term.doNotTranslate : draft.doNotTranslate === "true",
    aliases: draft.aliases === undefined ? term.aliases : draft.aliases.split(",").map((alias) => alias.trim()).filter(Boolean),
  };
}

export function buildGlossaryValidationSummary(issues: readonly GlossaryValidationIssue[]) {
  const errors = issues.filter((issue) => issue.severity === "error");
  return {
    errorCount: errors.length,
    warningCount: issues.length - errors.length,
    firstErrorFieldId: errors[0]?.fieldId ?? null,
  };
}

export function selectGlossarySessionVersion(
  preset: GlossaryPresetPresentation,
  version: number,
): GlossarySessionSelection | null {
  if (preset.activeVersion !== version) return null;
  return { presetId: preset.id, presetName: preset.name, version };
}
