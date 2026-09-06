import type {
  ActivatedGlossaryDocumentVersion,
  GlossaryDocumentRecord,
  GlossaryDocumentTermV1,
  GlossaryDocumentV1,
  GlossaryDocumentVersion,
  GlossaryPreset,
  SavedGlossaryDocumentVersion,
} from "@/lib/glossary-presets/types";
import type { GlossarySessionPinSelection } from "./glossary-presentation";

export type GlossaryFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ExtractedGlossaryCandidate extends Omit<GlossaryDocumentTermV1, "provenance"> {
  readonly provenance: Readonly<{ kind: "ai_extracted"; label: string | null }>;
}

export interface GlossaryExtractionMetadata {
  readonly sourceLanguage: string;
  readonly targetLanguages: readonly string[];
  readonly domain: string;
}

export interface PinnedSessionGlossary {
  readonly sessionId: string;
  readonly version: number;
  readonly pinnedGlossaryPresetId: string;
  readonly pinnedGlossaryVersion: number;
  readonly pinnedGlossaryFingerprint: string;
  readonly updatedAt: string;
}

export interface PinnedSessionGlossaryItem {
  readonly sourceKind: "host" | "builtin";
  readonly sourceId: string;
  readonly documentVersion: number;
  readonly ordinal: number;
  readonly fingerprint: string | null;
}

export interface PinnedSessionGlossaries {
  readonly sessionId: string;
  readonly version: number;
  readonly glossaries: readonly PinnedSessionGlossaryItem[];
  readonly updatedAt: string;
}

export class GlossaryClientError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "GlossaryClientError";
    this.code = code;
  }
}

export async function listGlossaryPresets(fetcher: GlossaryFetcher = fetch): Promise<GlossaryPreset[]> {
  const data = await requestData(fetcher, "/api/glossary-presets", undefined, hasOnlyPresets);
  return data.presets;
}

export async function listGlossaryVersions(fetcher: GlossaryFetcher, presetId: string): Promise<GlossaryDocumentVersion[]> {
  const data = await requestData(fetcher, `${presetPath(presetId)}/versions`, undefined, hasOnlyVersions);
  return data.versions;
}

export async function readGlossaryVersion(
  fetcher: GlossaryFetcher,
  presetId: string,
  version: number,
): Promise<GlossaryDocumentRecord> {
  return requestData(fetcher, `${presetPath(presetId)}/versions/${version}`, undefined, isDocumentRecord);
}

export async function validateGlossaryImport(fetcher: GlossaryFetcher, rawDocument: string): Promise<GlossaryDocumentV1> {
  const data = await requestData(fetcher, "/api/glossary-presets/import?validateOnly=true", jsonInit("POST", rawDocument), hasValidatedDocument);
  return data.document;
}

export async function createGlossaryPreset(fetcher: GlossaryFetcher, document: GlossaryDocumentV1): Promise<GlossaryPreset> {
  const data = await requestData(fetcher, "/api/glossary-presets", jsonInit("POST", JSON.stringify(document)), hasOnlyPreset);
  return data.preset;
}

export async function saveGlossaryVersion(
  fetcher: GlossaryFetcher,
  presetId: string,
  presetVersion: number,
  document: GlossaryDocumentV1,
): Promise<SavedGlossaryDocumentVersion> {
  const data = await requestData(fetcher, `${presetPath(presetId)}/versions?presetVersion=${presetVersion}`,
    jsonInit("POST", JSON.stringify(document)), hasOnlySavedVersion);
  return data.version;
}

export async function activateGlossaryVersion(
  fetcher: GlossaryFetcher,
  presetId: string,
  documentVersion: number,
  presetVersion: number,
): Promise<ActivatedGlossaryDocumentVersion> {
  const data = await requestData(fetcher, `${presetPath(presetId)}/activate`, jsonInit("POST", JSON.stringify({ presetVersion, documentVersion })), hasOnlyActivation);
  return data.activation;
}

export async function duplicateGlossaryPreset(
  fetcher: GlossaryFetcher,
  presetId: string,
  documentVersion: number,
  name: string,
): Promise<GlossaryPreset> {
  const data = await requestData(fetcher, `${presetPath(presetId)}/duplicate`, jsonInit("POST", JSON.stringify({ documentVersion, name })), hasOnlyPreset);
  return data.preset;
}

export async function extractGlossaryCandidates(
  fetcher: GlossaryFetcher,
  file: File,
  metadata: GlossaryExtractionMetadata,
): Promise<ExtractedGlossaryCandidate[]> {
  const body = new FormData();
  body.append("file", file);
  body.append("sourceLanguage", metadata.sourceLanguage);
  body.append("domain", metadata.domain);
  metadata.targetLanguages.forEach((language) => body.append("targetLanguages", language));
  const data = await requestData(fetcher, "/api/glossary-presets/extract", { method: "POST", body }, hasOnlyCandidates);
  return data.candidates;
}

export async function pinSessionGlossary(
  fetcher: GlossaryFetcher,
  sessionId: string,
  expectedVersion: number,
  presetId: string,
  documentVersion: number,
): Promise<PinnedSessionGlossary> {
  const pinned = await pinSessionGlossaries(fetcher, sessionId, expectedVersion, [{ sourceKind: "host", sourceId: presetId, documentVersion }]);
  const first = pinned.glossaries[0];
  if (!first || first.sourceKind !== "host" || first.fingerprint === null) return invalidResponse();
  return {
    sessionId: pinned.sessionId,
    version: pinned.version,
    pinnedGlossaryPresetId: first.sourceId,
    pinnedGlossaryVersion: first.documentVersion,
    pinnedGlossaryFingerprint: first.fingerprint,
    updatedAt: pinned.updatedAt,
  };
}

export async function pinSessionGlossaries(
  fetcher: GlossaryFetcher,
  sessionId: string,
  expectedVersion: number,
  glossaries: readonly GlossarySessionPinSelection[],
): Promise<PinnedSessionGlossaries> {
  const pinned = await requestData(fetcher, `/api/live-sessions/${encodeURIComponent(sessionId)}/glossary`, jsonInit("POST", JSON.stringify({
    expectedVersion,
    glossaries: glossaries.map((glossary) => ({
      sourceKind: glossary.sourceKind,
      sourceId: glossary.sourceId,
      ...(glossary.sourceKind === "host" ? { documentVersion: glossary.documentVersion } : {}),
    })),
  })), isPinnedSessionGlossaries);
  if (pinned.sessionId !== sessionId || pinned.version <= expectedVersion || pinned.glossaries.length !== glossaries.length) return invalidResponse();
  for (let index = 0; index < glossaries.length; index += 1) {
    if (pinned.glossaries[index]?.sourceKind !== glossaries[index]?.sourceKind
      || pinned.glossaries[index]?.sourceId !== glossaries[index]?.sourceId
      || (glossaries[index]?.sourceKind === "host" && pinned.glossaries[index]?.documentVersion !== glossaries[index]?.documentVersion)
      || pinned.glossaries[index]?.ordinal !== index + 1) return invalidResponse();
  }
  return pinned;
}

async function requestData<T>(
  fetcher: GlossaryFetcher,
  input: string,
  init: RequestInit | undefined,
  validate: (value: unknown) => value is T,
): Promise<T> {
  let payload: unknown;
  try {
    const response = await fetcher(input, init);
    payload = await response.json();
  } catch {
    throw new GlossaryClientError("용어집에 연결할 수 없습니다. 다시 시도해 주세요.", "NETWORK_ERROR");
  }
  if (!isRecord(payload) || typeof payload.ok !== "boolean") return invalidResponse();
  if (payload.ok === false) {
    if (!hasExactKeys(payload, ["ok", "error", "code"]) || typeof payload.error !== "string" || typeof payload.code !== "string") return invalidResponse();
    throw new GlossaryClientError(safeErrorMessage(payload.code), payload.code);
  }
  if (!hasExactKeys(payload, ["ok", "data"]) || !validate(payload.data)) return invalidResponse();
  return payload.data;
}

function safeErrorMessage(code: string): string {
  if (code.includes("CONFLICT")) return "용어집이 다른 곳에서 변경되었습니다. 목록을 새로 불러온 뒤 다시 시도해 주세요.";
  if (code.includes("RATE_LIMIT")) return "요청이 많습니다. 잠시 후 다시 시도해 주세요.";
  if (code.includes("INVALID") || code.includes("TOO_LARGE")) return "용어집 파일과 입력 내용을 확인해 주세요.";
  return "용어집을 처리할 수 없습니다. 다시 시도해 주세요.";
}

function invalidResponse(): never {
  throw new GlossaryClientError("용어집 응답을 확인할 수 없습니다. 다시 시도해 주세요.", "INVALID_RESPONSE");
}

function jsonInit(method: "POST", body: string): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body };
}

function presetPath(id: string): string {
  return `/api/glossary-presets/${encodeURIComponent(id)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isPreset(value: unknown): value is GlossaryPreset {
  return isRecord(value) && hasExactKeys(value, ["id", "name", "domain", "languagePair", "targetLanguages", "version", "activeDocumentVersion", "activeDocumentFingerprint", "updatedAt"])
    && typeof value.id === "string" && typeof value.name === "string" && typeof value.domain === "string"
    && isRecord(value.languagePair) && hasExactKeys(value.languagePair, ["a", "b"])
    && typeof value.languagePair.a === "string" && typeof value.languagePair.b === "string"
    && Array.isArray(value.targetLanguages) && value.targetLanguages.length >= 1
    && value.targetLanguages.every((language) => typeof language === "string")
    && isPositiveInteger(value.version)
    && (value.activeDocumentVersion === null || isPositiveInteger(value.activeDocumentVersion))
    && (value.activeDocumentFingerprint === null || typeof value.activeDocumentFingerprint === "string")
    && typeof value.updatedAt === "string";
}

function isVersion(value: unknown): value is GlossaryDocumentVersion {
  return isRecord(value) && hasExactKeys(value, ["presetId", "version", "documentSchema", "fingerprint", "createdAt"])
    && typeof value.presetId === "string" && isPositiveInteger(value.version)
    && value.documentSchema === "glossary-document/v1" && typeof value.fingerprint === "string" && typeof value.createdAt === "string";
}

function isTerm(value: unknown): value is GlossaryDocumentTermV1 {
  return isRecord(value) && typeof value.id === "string" && typeof value.source === "string"
    && isRecord(value.translations) && Object.values(value.translations).every((item) => typeof item === "string")
    && isStringArray(value.aliases) && (value.pronunciation === null || typeof value.pronunciation === "string")
    && typeof value.doNotTranslate === "boolean" && isStringArray(value.forbiddenTranslations)
    && (value.context === null || typeof value.context === "string") && isStringArray(value.examples)
    && isStringArray(value.tags) && Number.isSafeInteger(value.priority) && isRecord(value.provenance)
    && (value.provenance.kind === "ai_extracted" || value.provenance.kind === "import" || value.provenance.kind === "legacy" || value.provenance.kind === "manual")
    && (value.provenance.label === null || typeof value.provenance.label === "string");
}

function isDocument(value: unknown): value is GlossaryDocumentV1 {
  return isRecord(value) && hasExactKeys(value, ["schemaVersion", "name", "domain", "sourceLanguage", "targetLanguages", "terms", "createdAt", "updatedAt", "version"])
    && value.schemaVersion === 1 && typeof value.name === "string" && typeof value.domain === "string"
    && typeof value.sourceLanguage === "string" && isStringArray(value.targetLanguages)
    && Array.isArray(value.terms) && value.terms.every(isTerm) && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string" && isPositiveInteger(value.version);
}

function isDocumentRecord(value: unknown): value is GlossaryDocumentRecord {
  return isRecord(value) && hasExactKeys(value, ["presetId", "version", "documentSchema", "fingerprint", "createdAt", "document"])
    && isVersion({ presetId: value.presetId, version: value.version, documentSchema: value.documentSchema, fingerprint: value.fingerprint, createdAt: value.createdAt })
    && isDocument(value.document);
}

function hasOnlyPresets(value: unknown): value is { presets: GlossaryPreset[] } {
  return isRecord(value) && hasExactKeys(value, ["presets"]) && Array.isArray(value.presets) && value.presets.every(isPreset);
}
function hasOnlyVersions(value: unknown): value is { versions: GlossaryDocumentVersion[] } {
  return isRecord(value) && hasExactKeys(value, ["versions"]) && Array.isArray(value.versions) && value.versions.every(isVersion);
}
function hasOnlyPreset(value: unknown): value is { preset: GlossaryPreset } {
  return isRecord(value) && hasExactKeys(value, ["preset"]) && isPreset(value.preset);
}
function hasValidatedDocument(value: unknown): value is { fingerprint: string; document: GlossaryDocumentV1 } {
  return isRecord(value) && hasExactKeys(value, ["fingerprint", "document"]) && typeof value.fingerprint === "string" && isDocument(value.document);
}
function hasOnlySavedVersion(value: unknown): value is { version: SavedGlossaryDocumentVersion } {
  return isRecord(value) && hasExactKeys(value, ["version"]) && isRecord(value.version)
    && hasExactKeys(value.version, ["presetId", "version", "documentSchema", "fingerprint", "createdAt", "presetVersion"])
    && isVersion({ presetId: value.version.presetId, version: value.version.version, documentSchema: value.version.documentSchema, fingerprint: value.version.fingerprint, createdAt: value.version.createdAt })
    && isPositiveInteger(value.version.presetVersion);
}
function hasOnlyActivation(value: unknown): value is { activation: ActivatedGlossaryDocumentVersion } {
  return isRecord(value) && hasExactKeys(value, ["activation"]) && isRecord(value.activation)
    && hasExactKeys(value.activation, ["presetId", "presetVersion", "activeDocumentVersion", "activeDocumentFingerprint", "updatedAt"])
    && typeof value.activation.presetId === "string" && isPositiveInteger(value.activation.presetVersion)
    && isPositiveInteger(value.activation.activeDocumentVersion) && typeof value.activation.activeDocumentFingerprint === "string"
    && typeof value.activation.updatedAt === "string";
}
function hasOnlyCandidates(value: unknown): value is { candidates: ExtractedGlossaryCandidate[] } {
  return isRecord(value) && hasExactKeys(value, ["candidates"]) && Array.isArray(value.candidates)
    && value.candidates.every((candidate) => isTerm(candidate) && candidate.provenance.kind === "ai_extracted");
}
function isPinnedSessionGlossary(value: unknown): value is PinnedSessionGlossary {
  return isRecord(value) && hasExactKeys(value, ["sessionId", "version", "pinnedGlossaryPresetId", "pinnedGlossaryVersion", "pinnedGlossaryFingerprint", "updatedAt"])
    && typeof value.sessionId === "string" && isPositiveInteger(value.version)
    && typeof value.pinnedGlossaryPresetId === "string" && isPositiveInteger(value.pinnedGlossaryVersion)
    && typeof value.pinnedGlossaryFingerprint === "string" && typeof value.updatedAt === "string";
}
function isPinnedSessionGlossaryItem(value: unknown): value is PinnedSessionGlossaryItem {
  return isRecord(value) && hasExactKeys(value, ["sourceKind", "sourceId", "documentVersion", "ordinal", "fingerprint"])
    && (value.sourceKind === "host" || value.sourceKind === "builtin")
    && typeof value.sourceId === "string" && isPositiveInteger(value.documentVersion)
    && isPositiveInteger(value.ordinal) && (value.fingerprint === null || typeof value.fingerprint === "string");
}
function isPinnedSessionGlossaries(value: unknown): value is PinnedSessionGlossaries {
  return isRecord(value) && hasExactKeys(value, ["sessionId", "version", "glossaries", "updatedAt"])
    && typeof value.sessionId === "string" && isPositiveInteger(value.version)
    && Array.isArray(value.glossaries) && value.glossaries.every(isPinnedSessionGlossaryItem)
    && typeof value.updatedAt === "string";
}
function isPositiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
