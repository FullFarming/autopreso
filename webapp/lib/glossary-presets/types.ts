import type { CanonicalLanguageCode } from "../languageDetect";

export const BUILTIN_GLOSSARY_IDS = [
  "common_business",
  "ai_ax",
  "commercial_real_estate",
  "hospitality",
  "fnb_retail",
  "proper_nouns",
  "ko_ja_idioms",
] as const;

export type BuiltinGlossaryId = typeof BUILTIN_GLOSSARY_IDS[number];

export interface GlossaryDocumentTermV1 {
  readonly id: string;
  readonly source: string;
  readonly translations: Readonly<Record<string, string>>;
  readonly aliases: readonly string[];
  readonly pronunciation: string | null;
  readonly doNotTranslate: boolean;
  readonly forbiddenTranslations: readonly string[];
  readonly context: string | null;
  readonly examples: readonly string[];
  readonly tags: readonly string[];
  readonly priority: number;
  readonly provenance: Readonly<{ kind: "ai_extracted" | "import" | "legacy" | "manual"; label: string | null }>;
}

export interface GlossaryDocumentV1 {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly domain: string;
  readonly sourceLanguage: CanonicalLanguageCode;
  readonly targetLanguages: readonly CanonicalLanguageCode[];
  readonly terms: readonly GlossaryDocumentTermV1[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface GlossaryPreset {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly languagePair: Readonly<{ a: CanonicalLanguageCode; b: CanonicalLanguageCode }>;
  readonly targetLanguages: readonly CanonicalLanguageCode[];
  readonly version: number;
  readonly activeDocumentVersion: number | null;
  readonly activeDocumentFingerprint: string | null;
  readonly updatedAt: string;
}

export interface GlossaryDocumentVersion {
  readonly presetId: string;
  readonly version: number;
  readonly documentSchema: "glossary-document/v1";
  readonly fingerprint: string;
  readonly createdAt: string;
}

export interface GlossaryDocumentRecord extends GlossaryDocumentVersion {
  readonly document: GlossaryDocumentV1;
}

export interface SavedGlossaryDocumentVersion extends GlossaryDocumentVersion {
  readonly presetVersion: number;
}

export interface ActivatedGlossaryDocumentVersion {
  readonly presetId: string;
  readonly presetVersion: number;
  readonly activeDocumentVersion: number;
  readonly activeDocumentFingerprint: string;
  readonly updatedAt: string;
}
