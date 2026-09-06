import type {
  GlossaryImportPreviewPresentation,
  GlossaryPresetPresentation,
  GlossaryTermPresentation,
  GlossaryValidationIssue,
  GlossaryVersionPresentation,
} from "./glossary-presentation";

export const GLOSSARY_PREVIEW_PRESETS = [
  { id: "cre-earnings", name: "CRE 실적 발표", domain: "상업용 부동산", languagePairLabel: "한국어 → English", languageTags: ["원문 ko", "en"], activeVersion: 2, latestVersion: 3, termCount: 48 },
  { id: "hotel-investment", name: "호텔 투자", domain: "호텔 투자와 운영", languagePairLabel: "English → 한국어", languageTags: ["원문 en", "ko"], activeVersion: 1, latestVersion: 1, termCount: 32 },
] as const satisfies readonly GlossaryPresetPresentation[];

export const GLOSSARY_PREVIEW_TERMS: readonly GlossaryTermPresentation[] = [
  { id: "term-cap-rate", source: "캡레이트", target: "Cap Rate", aliases: ["cap rate"], status: "approved" },
  { id: "term-noi", source: "순영업소득", target: "NOI", aliases: ["Net Operating Income"], status: "approved" },
  { id: "candidate-kushi", source: "쿠시", target: "Cushman & Wakefield", aliases: [], note: "최근 세션에서 추출", status: "candidate" },
];

export const GLOSSARY_PREVIEW_VERSIONS: readonly GlossaryVersionPresentation[] = [
  { id: "version-3", version: 3, createdAtLabel: "오늘 14:20", termCount: 48, state: "draft" },
  { id: "version-2", version: 2, createdAtLabel: "7월 26일", termCount: 45, state: "active" },
  { id: "version-1", version: 1, createdAtLabel: "7월 20일", termCount: 38, state: "superseded" },
];

export const GLOSSARY_PREVIEW_ISSUES: readonly GlossaryValidationIssue[] = [];

export const GLOSSARY_IMPORT_PREVIEW: GlossaryImportPreviewPresentation = {
  fileName: "earnings-call-glossary.json",
  approvedCount: 42,
  candidateCount: 6,
  ignoredCount: 2,
};
