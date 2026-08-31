import {
  fingerprintGlossaryDocumentV1,
  parseGlossaryDocumentV1,
} from "../../../packages/caption-core/index.js";

import { LANGUAGE_CODES, type CanonicalLanguageCode } from "../languageDetect";
import {
  getSupabaseServerAccess,
  supabaseAdminHeaders,
  type SupabaseAdminCredential,
} from "../security/supabase-server-access";
import { GlossaryPresetError, type GlossaryPresetErrorCode } from "./errors";
import { MAX_GLOSSARY_PRESETS_PER_HOST } from "./schema";
import type {
  ActivatedGlossaryDocumentVersion,
  GlossaryDocumentRecord,
  GlossaryDocumentV1,
  GlossaryDocumentVersion,
  GlossaryPreset,
  SavedGlossaryDocumentVersion,
} from "./types";

interface StoreDependencies {
  baseUrl?: string;
  credential?: SupabaseAdminCredential;
  fetchFn?: typeof fetch;
}

export interface GlossaryPresetStore {
  list(hostId: string): Promise<GlossaryPreset[]>;
  create(hostId: string, document: GlossaryDocumentV1, fingerprint: string): Promise<GlossaryPreset>;
  listVersions(hostId: string, presetId: string): Promise<GlossaryDocumentVersion[]>;
  readVersion(hostId: string, presetId: string, version: number): Promise<GlossaryDocumentRecord | null>;
  saveVersion(
    hostId: string,
    presetId: string,
    expectedPresetVersion: number,
    document: GlossaryDocumentV1,
    fingerprint: string,
  ): Promise<SavedGlossaryDocumentVersion>;
  activateVersion(
    hostId: string,
    presetId: string,
    expectedPresetVersion: number,
    documentVersion: number,
  ): Promise<ActivatedGlossaryDocumentVersion>;
  delete(presetId: string, hostId: string, expectedPresetVersion: number): Promise<boolean>;
}

const RPC_ERROR_CODES = new Map<string, GlossaryPresetErrorCode>([
  ["GLOSSARY_PRESET_LIMIT_REACHED", "GLOSSARY_PRESET_LIMIT_REACHED"],
  ["GLOSSARY_VERSION_LIMIT_REACHED", "GLOSSARY_VERSION_LIMIT_REACHED"],
  ["GLOSSARY_PRESET_NAME_CONFLICT", "GLOSSARY_PRESET_NAME_CONFLICT"],
  ["GLOSSARY_PRESET_VERSION_CONFLICT", "GLOSSARY_PRESET_VERSION_CONFLICT"],
  ["GLOSSARY_PRESET_NOT_FOUND", "GLOSSARY_PRESET_NOT_FOUND"],
  ["GLOSSARY_PRESET_IN_USE", "GLOSSARY_PRESET_IN_USE"],
  ["GLOSSARY_DOCUMENT_VERSION_NOT_FOUND", "GLOSSARY_DOCUMENT_VERSION_NOT_FOUND"],
  ["GLOSSARY_DOCUMENT_FINGERPRINT_CONFLICT", "GLOSSARY_DOCUMENT_FINGERPRINT_CONFLICT"],
  ["INVALID_GLOSSARY_DOCUMENT_INPUT", "INVALID_GLOSSARY_DOCUMENT"],
]);
const LANGUAGE_CODE_SET = new Set<string>(LANGUAGE_CODES);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DOCUMENT_SCHEMA = "glossary-document/v1" as const;

export class SupabaseGlossaryPresetStore implements GlossaryPresetStore {
  private readonly baseUrl: string;
  private readonly credential: SupabaseAdminCredential;
  private readonly fetchFn: typeof fetch;

  constructor(dependencies: StoreDependencies = {}) {
    const access = dependencies.baseUrl && dependencies.credential
      ? { url: dependencies.baseUrl, credential: dependencies.credential }
      : getSupabaseServerAccess();
    this.baseUrl = access.url;
    this.credential = access.credential;
    this.fetchFn = dependencies.fetchFn ?? fetch;
  }

  async list(hostId: string): Promise<GlossaryPreset[]> {
    const body = await this.request("list_host_glossary_documents_v2", { p_host_id: hostId });
    if (!Array.isArray(body) || body.length > MAX_GLOSSARY_PRESETS_PER_HOST) throw unavailable();
    return body.map(parsePresetRow);
  }

  async create(hostId: string, document: GlossaryDocumentV1, fingerprint: string): Promise<GlossaryPreset> {
    const body = await this.request("create_host_glossary_document_preset_v2", {
      p_host_id: hostId,
      p_name: document.name,
      p_domain: document.domain,
      p_language_a: document.sourceLanguage,
      p_target_languages: document.targetLanguages,
      p_document: document,
      p_fingerprint: fingerprint,
    });
    return parseSingle(body, parsePresetRow);
  }

  async listVersions(hostId: string, presetId: string): Promise<GlossaryDocumentVersion[]> {
    const body = await this.request("list_host_glossary_document_versions_v1", {
      p_host_id: hostId,
      p_preset_id: presetId,
    });
    if (!Array.isArray(body) || body.length > 10_000) throw unavailable();
    return body.map((value) => parseVersionRow(value, presetId));
  }

  async readVersion(hostId: string, presetId: string, version: number): Promise<GlossaryDocumentRecord | null> {
    const body = await this.request("read_host_glossary_document_version_v1", {
      p_host_id: hostId,
      p_preset_id: presetId,
      p_version: version,
    });
    if (!Array.isArray(body)) throw unavailable();
    if (body.length === 0) return null;
    if (body.length !== 1) throw unavailable();
    return parseDocumentRecord(body[0], presetId);
  }

  async saveVersion(
    hostId: string,
    presetId: string,
    expectedPresetVersion: number,
    document: GlossaryDocumentV1,
    fingerprint: string,
  ): Promise<SavedGlossaryDocumentVersion> {
    const body = await this.request("save_host_glossary_document_version_v1", {
      p_host_id: hostId,
      p_preset_id: presetId,
      p_expected_preset_version: expectedPresetVersion,
      p_document: document,
      p_fingerprint: fingerprint,
    });
    return parseSingle(body, (value) => parseSavedVersionRow(value, hostId, presetId));
  }

  async activateVersion(
    hostId: string,
    presetId: string,
    expectedPresetVersion: number,
    documentVersion: number,
  ): Promise<ActivatedGlossaryDocumentVersion> {
    const body = await this.request("activate_host_glossary_document_version_v1", {
      p_host_id: hostId,
      p_preset_id: presetId,
      p_expected_preset_version: expectedPresetVersion,
      p_document_version: documentVersion,
    });
    return parseSingle(body, (value) => parseActivationRow(value, hostId, presetId));
  }

  async delete(presetId: string, hostId: string, expectedPresetVersion: number): Promise<boolean> {
    const body = await this.request("delete_host_glossary_preset", {
      p_id: presetId,
      p_host_id: hostId,
      p_expected_version: expectedPresetVersion,
    });
    if (typeof body !== "boolean") throw unavailable();
    return body;
  }

  private async request(rpcName: string, body: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/rest/v1/rpc/${rpcName}`, {
        method: "POST",
        cache: "no-store",
        headers: { ...supabaseAdminHeaders(this.credential), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw unavailable();
    }
    if (!response.ok) throw await mapRpcFailure(response);
    try {
      return await response.json() as unknown;
    } catch {
      throw unavailable();
    }
  }
}

function parsePresetRow(value: unknown): GlossaryPreset {
  const row = exactObject(value, [
    "id", "name", "domain", "language_a", "language_b", "target_languages", "version",
    "active_document_version", "active_document_fingerprint", "updated_at",
  ]);
  const languageA = row.language_a;
  const languageB = row.language_b;
  const targetLanguages = row.target_languages;
  const activeVersion = nullablePositiveInteger(row.active_document_version);
  const activeFingerprint = row.active_document_fingerprint;
  if (!isUuid(row.id) || !boundedText(row.name, 1, 80) || !boundedText(row.domain, 0, 600)
    || !isCanonicalLanguage(languageA) || !isCanonicalLanguage(languageB) || languageA === languageB
    || !isTargetLanguageList(targetLanguages, languageA) || targetLanguages[0] !== languageB
    || !isPositiveInteger(row.version) || activeVersion === undefined
    || !(activeFingerprint === null || isFingerprint(activeFingerprint))
    || (activeVersion === null) !== (activeFingerprint === null)
    || !isTimestamp(row.updated_at)) throw unavailable();
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    languagePair: { a: languageA, b: languageB },
    targetLanguages,
    version: row.version,
    activeDocumentVersion: activeVersion,
    activeDocumentFingerprint: activeFingerprint,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function parseVersionRow(value: unknown, expectedPresetId: string): GlossaryDocumentVersion {
  const row = exactObject(value, ["preset_id", "version", "document_schema", "fingerprint", "created_at"]);
  if (row.preset_id !== expectedPresetId || !isPositiveInteger(row.version)
    || row.document_schema !== DOCUMENT_SCHEMA || !isFingerprint(row.fingerprint) || !isTimestamp(row.created_at)) {
    throw unavailable();
  }
  return {
    presetId: row.preset_id,
    version: row.version,
    documentSchema: DOCUMENT_SCHEMA,
    fingerprint: row.fingerprint,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function parseDocumentRecord(value: unknown, expectedPresetId: string): GlossaryDocumentRecord {
  const row = exactObject(value, ["preset_id", "version", "document_schema", "fingerprint", "document", "created_at"]);
  const metadata = parseVersionRow({
    preset_id: row.preset_id,
    version: row.version,
    document_schema: row.document_schema,
    fingerprint: row.fingerprint,
    created_at: row.created_at,
  }, expectedPresetId);
  let document: GlossaryDocumentV1;
  try {
    document = parseGlossaryDocumentV1(row.document) as GlossaryDocumentV1;
    if (fingerprintGlossaryDocumentV1(document) !== metadata.fingerprint) throw unavailable();
  } catch {
    throw unavailable();
  }
  return { ...metadata, document };
}

function parseSavedVersionRow(value: unknown, expectedHostId: string, expectedPresetId: string): SavedGlossaryDocumentVersion {
  const row = exactObject(value, [
    "id", "preset_id", "host_id", "document_version", "fingerprint", "document_schema", "preset_version", "created_at",
  ]);
  if (!isUuid(row.id) || row.preset_id !== expectedPresetId || row.host_id !== expectedHostId
    || !isPositiveInteger(row.document_version) || !isPositiveInteger(row.preset_version)
    || !isFingerprint(row.fingerprint) || row.document_schema !== DOCUMENT_SCHEMA || !isTimestamp(row.created_at)) {
    throw unavailable();
  }
  return {
    presetId: row.preset_id,
    version: row.document_version,
    documentSchema: DOCUMENT_SCHEMA,
    fingerprint: row.fingerprint,
    presetVersion: row.preset_version,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function parseActivationRow(value: unknown, expectedHostId: string, expectedPresetId: string) {
  const row = exactObject(value, [
    "preset_id", "host_id", "version", "active_document_version", "active_document_fingerprint", "updated_at",
  ]);
  if (row.preset_id !== expectedPresetId || row.host_id !== expectedHostId || !isPositiveInteger(row.version)
    || !isPositiveInteger(row.active_document_version) || !isFingerprint(row.active_document_fingerprint)
    || !isTimestamp(row.updated_at)) throw unavailable();
  return {
    presetId: row.preset_id,
    presetVersion: row.version,
    activeDocumentVersion: row.active_document_version,
    activeDocumentFingerprint: row.active_document_fingerprint,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function parseSingle<T>(value: unknown, parser: (row: unknown) => T): T {
  if (!Array.isArray(value) || value.length !== 1) throw unavailable();
  return parser(value[0]);
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || Object.keys(row).some((key) => !keys.includes(key))) throw unavailable();
  return row;
}

function boundedText(value: unknown, minimum: number, maximum: number): value is string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || /[<>]|\p{Cc}|\p{Cf}/u.test(value)) return false;
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum && value === value.trim();
}

function isUuid(value: unknown): value is string { return typeof value === "string" && UUID_PATTERN.test(value); }
function isFingerprint(value: unknown): value is string { return typeof value === "string" && FINGERPRINT_PATTERN.test(value); }
function isPositiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }
function nullablePositiveInteger(value: unknown): number | null | undefined {
  return value === null ? null : isPositiveInteger(value) ? value : undefined;
}
function isTimestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function isCanonicalLanguage(value: unknown): value is CanonicalLanguageCode {
  return typeof value === "string" && LANGUAGE_CODE_SET.has(value);
}
function isTargetLanguageList(value: unknown, sourceLanguage: string): value is CanonicalLanguageCode[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 13
    && value.every((language) => isCanonicalLanguage(language) && language !== sourceLanguage)
    && new Set(value).size === value.length;
}

async function mapRpcFailure(response: Response): Promise<GlossaryPresetError> {
  let body: unknown;
  try { body = await response.json() as unknown; } catch { return unavailable(); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return unavailable();
  const values = Object.values(body as Record<string, unknown>).filter((value): value is string => typeof value === "string");
  for (const value of values) {
    const apiCode = RPC_ERROR_CODES.get(value);
    if (apiCode) return errorForCode(apiCode);
  }
  return unavailable();
}

function errorForCode(code: GlossaryPresetErrorCode): GlossaryPresetError {
  const definitions: Record<GlossaryPresetErrorCode, readonly [string, number]> = {
    INVALID_GLOSSARY_PRESET: ["용어집 입력이 올바르지 않습니다.", 400],
    INVALID_GLOSSARY_DOCUMENT: ["용어집 내용이 올바르지 않습니다.", 400],
    GLOSSARY_PRESET_LIMIT_REACHED: ["용어집은 최대 50개까지 저장할 수 있습니다.", 409],
    GLOSSARY_VERSION_LIMIT_REACHED: ["용어집 버전은 최대 200개까지 저장할 수 있습니다.", 409],
    GLOSSARY_PRESET_NAME_CONFLICT: ["같은 이름의 용어집이 이미 있습니다.", 409],
    GLOSSARY_PRESET_VERSION_CONFLICT: ["용어집이 다른 곳에서 변경되었습니다. 다시 불러오세요.", 409],
    GLOSSARY_PRESET_NOT_FOUND: ["용어집을 찾을 수 없습니다.", 404],
    GLOSSARY_PRESET_IN_USE: ["라이브 세션에서 사용 중인 용어집은 삭제할 수 없습니다.", 409],
    GLOSSARY_DOCUMENT_VERSION_NOT_FOUND: ["용어집 버전을 찾을 수 없습니다.", 404],
    GLOSSARY_DOCUMENT_FINGERPRINT_CONFLICT: ["같은 내용의 용어집 버전이 이미 있습니다.", 409],
    NETWORK_UNAVAILABLE: ["용어집 동기화 서버에 연결할 수 없습니다.", 503],
  };
  const [message, status] = definitions[code];
  return new GlossaryPresetError(message, code, status);
}

function unavailable(): GlossaryPresetError {
  return errorForCode("NETWORK_UNAVAILABLE");
}
