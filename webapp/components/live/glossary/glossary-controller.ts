import type { GlossaryDocumentTermV1, GlossaryDocumentV1, GlossaryDocumentVersion, GlossaryPreset } from "@/lib/glossary-presets/types";
import type { ExtractedGlossaryCandidate } from "./glossary-client";
import type {
  GlossaryDraftEdits,
  GlossaryPresetPresentation,
  GlossaryTermPresentation,
  GlossaryValidationIssue,
  GlossaryVersionPresentation,
} from "./glossary-presentation";

export interface EditableGlossaryTerm {
  readonly term: GlossaryDocumentTermV1;
  readonly status: "approved" | "candidate";
}

export function presentPreset(preset: GlossaryPreset, latestVersion: number, termCount: number | null): GlossaryPresetPresentation {
  return {
    id: preset.id,
    name: preset.name,
    domain: preset.domain,
    languagePairLabel: `${preset.languagePair.a} → ${preset.languagePair.b}`,
    languageTags: [`원문 ${preset.languagePair.a}`, ...preset.targetLanguages],
    activeVersion: preset.activeDocumentVersion,
    latestVersion,
    termCount,
  };
}

export function presentTerm(editable: EditableGlossaryTerm, targetLanguage: string): GlossaryTermPresentation {
  return {
    id: editable.term.id,
    source: editable.term.source,
    target: editable.term.translations[targetLanguage] ?? "",
    aliases: editable.term.aliases,
    note: editable.status === "candidate" ? "PDF에서 추출한 AI 후보" : undefined,
    status: editable.status,
  };
}

export function presentVersions(
  versions: readonly GlossaryDocumentVersion[],
  activeVersion: number | null,
  loadedDocument: GlossaryDocumentV1 | null,
): GlossaryVersionPresentation[] {
  return [...versions].sort((left, right) => right.version - left.version).map((version) => ({
    id: `${version.presetId}-${version.version}`,
    version: version.version,
    createdAtLabel: formatDate(version.createdAt),
    termCount: loadedDocument?.version === version.version ? loadedDocument.terms.length : null,
    state: version.version === activeVersion ? "active" : version.version === Math.max(...versions.map((item) => item.version)) ? "draft" : "superseded",
  }));
}

export function extractedCandidatesToEditable(candidates: readonly ExtractedGlossaryCandidate[]): EditableGlossaryTerm[] {
  return candidates.map((candidate) => ({
    status: "candidate",
    term: {
      ...candidate,
      provenance: { kind: "ai_extracted", label: candidate.provenance.label ?? "PDF 후보" },
    },
  }));
}

export function createEmptyGlossaryDocument(now: string): GlossaryDocumentV1 {
  return {
    schemaVersion: 1,
    name: "새 용어집",
    domain: "",
    sourceLanguage: "ko",
    targetLanguages: ["en"],
    terms: [],
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

export function buildEditedGlossaryDocument(
  current: GlossaryDocumentV1,
  editableTerms: readonly EditableGlossaryTerm[],
  edits: GlossaryDraftEdits,
  now: string,
): { document: GlossaryDocumentV1 | null; issues: GlossaryValidationIssue[] } {
  const editsById = new Map(edits.terms.map((term) => [term.id, term]));
  const targetLanguage = current.targetLanguages[0];
  const issues: GlossaryValidationIssue[] = [];
  const approvedTerms = editableTerms.flatMap((item, index) => {
    if (item.status !== "approved") return [];
    const edit = editsById.get(item.term.id);
    const source = edit?.source.normalize("NFC").trim() ?? item.term.source;
    const target = edit?.target.normalize("NFC").trim() ?? (targetLanguage ? item.term.translations[targetLanguage] ?? "" : "");
    if (!source) issues.push({ id: `source-${item.term.id}`, severity: "error", message: "원문 용어를 입력해 주세요.", fieldId: `glossary-term-source-${index}` });
    if (!target) issues.push({ id: `target-${item.term.id}`, severity: "error", message: "번역어를 입력해 주세요.", fieldId: `glossary-term-target-${index}` });
    return [{
      ...item.term,
      source,
      aliases: (edit?.aliases ?? item.term.aliases.join(",")).split(",").map((alias) => alias.normalize("NFC").trim()).filter(Boolean),
      translations: targetLanguage ? { ...item.term.translations, [targetLanguage]: target } : item.term.translations,
    }];
  });
  const name = edits.name.normalize("NFC").trim();
  if (!name) issues.unshift({ id: "preset-name", severity: "error", message: "용어집 이름을 입력해 주세요.", fieldId: "glossary-preset-name" });
  if (issues.length > 0) return { document: null, issues };
  return {
    document: {
      ...current,
      name,
      domain: edits.domain.normalize("NFC").trim(),
      terms: approvedTerms,
      updatedAt: now,
      version: Math.max(1, current.version + 1),
    },
    issues: [],
  };
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "날짜 확인 필요";
  return new Date(timestamp).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}
