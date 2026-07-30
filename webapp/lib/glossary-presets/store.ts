import { LANGUAGE_CODES, type CanonicalLanguageCode } from "../languageDetect";
import {
  getSupabaseServerAccess,
  supabaseAdminHeaders,
  type SupabaseAdminCredential,
} from "../security/supabase-server-access";
import { GlossaryPresetError, type GlossaryPresetErrorCode } from "./errors";
import {
  MAX_GLOSSARY_PRESET_DOMAIN_CHARS,
  MAX_GLOSSARY_PRESET_GLOSSARY_CHARS,
  MAX_GLOSSARY_PRESET_NAME_CHARS,
  MAX_GLOSSARY_PRESETS_PER_HOST,
  type CreateGlossaryPresetInput,
} from "./schema";
import type { GlossaryPreset } from "./types";

interface GlossaryPresetRow {
  id: string;
  name: string;
  domain: string;
  glossary: string;
  language_a: string;
  language_b: string;
  version: number;
  updated_at: string;
}

interface StoreDependencies {
  baseUrl?: string;
  credential?: SupabaseAdminCredential;
  fetchFn?: typeof fetch;
}

export interface GlossaryPresetStore {
  list(hostId: string): Promise<GlossaryPreset[]>;
  create(hostId: string, input: CreateGlossaryPresetInput): Promise<GlossaryPreset>;
  update(
    id: string,
    hostId: string,
    expectedVersion: number,
    input: CreateGlossaryPresetInput,
  ): Promise<GlossaryPreset | null>;
  delete(id: string, hostId: string, expectedVersion: number): Promise<boolean>;
}

const RPC_ERROR_CODES = new Map<string, GlossaryPresetErrorCode>([
  ["GLOSSARY_PRESET_LIMIT_REACHED", "GLOSSARY_PRESET_LIMIT_REACHED"],
  ["GLOSSARY_PRESET_NAME_CONFLICT", "GLOSSARY_PRESET_NAME_CONFLICT"],
  ["GLOSSARY_PRESET_VERSION_CONFLICT", "GLOSSARY_PRESET_VERSION_CONFLICT"],
  ["GLOSSARY_PRESET_NOT_FOUND", "GLOSSARY_PRESET_NOT_FOUND"],
]);
const LANGUAGE_CODE_SET = new Set<string>(LANGUAGE_CODES);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
    const body = await this.request("list_host_glossary_presets", { p_host_id: hostId });
    if (!Array.isArray(body) || body.length > MAX_GLOSSARY_PRESETS_PER_HOST) throw unavailable();
    return body.map(parseGlossaryPresetRow);
  }

  async create(hostId: string, input: CreateGlossaryPresetInput): Promise<GlossaryPreset> {
    const body = await this.request("create_host_glossary_preset", mutationBody(hostId, input));
    return parseSinglePreset(body);
  }

  async update(
    id: string,
    hostId: string,
    expectedVersion: number,
    input: CreateGlossaryPresetInput,
  ): Promise<GlossaryPreset | null> {
    const body = await this.request("update_host_glossary_preset", {
      p_id: id,
      p_host_id: hostId,
      p_expected_version: expectedVersion,
      ...mutationFields(input),
    });
    if (body === null || body === false || (Array.isArray(body) && body.length === 0)) return null;
    return parseSinglePreset(body);
  }

  async delete(id: string, hostId: string, expectedVersion: number): Promise<boolean> {
    const body = await this.request("delete_host_glossary_preset", {
      p_id: id,
      p_host_id: hostId,
      p_expected_version: expectedVersion,
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
        headers: {
          ...supabaseAdminHeaders(this.credential),
          "content-type": "application/json",
        },
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

function mutationBody(hostId: string, input: CreateGlossaryPresetInput): Record<string, unknown> {
  return { p_host_id: hostId, ...mutationFields(input) };
}

function mutationFields(input: CreateGlossaryPresetInput): Record<string, unknown> {
  return {
    p_name: input.name,
    p_domain: input.domain,
    p_glossary: input.glossary,
    p_language_a: input.languagePair.a,
    p_language_b: input.languagePair.b,
  };
}

function parseSinglePreset(value: unknown): GlossaryPreset {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw unavailable();
    return parseGlossaryPresetRow(value[0]);
  }
  return parseGlossaryPresetRow(value);
}

function parseGlossaryPresetRow(value: unknown): GlossaryPreset {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const row = value as Partial<GlossaryPresetRow>;
  const languageA = row.language_a;
  const languageB = row.language_b;
  if (typeof row.id !== "string" || !UUID_PATTERN.test(row.id)
    || typeof row.name !== "string" || !hasCodePointLength(row.name, 1, MAX_GLOSSARY_PRESET_NAME_CHARS)
    || typeof row.domain !== "string" || !hasCodePointLength(row.domain, 0, MAX_GLOSSARY_PRESET_DOMAIN_CHARS)
    || typeof row.glossary !== "string" || !hasCodePointLength(row.glossary, 1, MAX_GLOSSARY_PRESET_GLOSSARY_CHARS)
    || !isCanonicalLanguage(languageA)
    || !isCanonicalLanguage(languageB) || languageA === languageB
    || !Number.isSafeInteger(row.version) || Number(row.version) < 1
    || typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at))) {
    throw unavailable();
  }
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    glossary: row.glossary,
    languagePair: { a: languageA, b: languageB },
    version: Number(row.version),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function hasCodePointLength(value: string, minimum: number, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

function isCanonicalLanguage(value: unknown): value is CanonicalLanguageCode {
  return typeof value === "string" && LANGUAGE_CODE_SET.has(value);
}

async function mapRpcFailure(response: Response): Promise<GlossaryPresetError> {
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 2_000);
  } catch {}
  for (const [databaseCode, apiCode] of RPC_ERROR_CODES) {
    if (detail.includes(databaseCode)) return errorForCode(apiCode);
  }
  return unavailable();
}

function errorForCode(code: GlossaryPresetErrorCode): GlossaryPresetError {
  if (code === "GLOSSARY_PRESET_LIMIT_REACHED") return new GlossaryPresetError("용어집은 최대 50개까지 저장할 수 있습니다.", code, 409);
  if (code === "GLOSSARY_PRESET_NAME_CONFLICT") return new GlossaryPresetError("같은 이름의 용어집이 이미 있습니다.", code, 409);
  if (code === "GLOSSARY_PRESET_VERSION_CONFLICT") return new GlossaryPresetError("용어집이 다른 곳에서 변경되었습니다. 다시 불러오세요.", code, 409);
  if (code === "GLOSSARY_PRESET_NOT_FOUND") return new GlossaryPresetError("용어집을 찾을 수 없습니다.", code, 404);
  return unavailable();
}

function unavailable(): GlossaryPresetError {
  return new GlossaryPresetError("용어집 동기화 서버에 연결할 수 없습니다.", "NETWORK_UNAVAILABLE", 503);
}
