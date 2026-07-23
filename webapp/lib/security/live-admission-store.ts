import { randomBytes } from "node:crypto";

import { LANGUAGE_CODES } from "../languageDetect";

import { getSupabasePublicAccess, getSupabaseServerAccess, supabaseAdminHeaders } from "./supabase-server-access";

export interface LiveSessionSecurityView {
  id: string;
  sessionType: "presentation" | "meeting";
  outputMode: "captions" | "captions_audio" | "audio";
  voiceProvider: "gemini" | "openai";
  glossaryPack: "general_cre" | "hotel" | "fnb";
  languages: string[];
  maxViewers: number;
  version: number;
  expiresAt: string;
  admissionOpenUntil: string | null;
}

export interface ViewerGrantRecord {
  id: string;
  sessionId: string;
  userId: string;
  displayName: string;
  expiresAt: string;
}

type ViewerLiveSessionSecurityView = Omit<LiveSessionSecurityView, "admissionOpenUntil" | "version">;
const CANONICAL_LANGUAGE_CODES = new Set<string>(LANGUAGE_CODES);

export interface AdmissionRedemption {
  grant: ViewerGrantRecord;
  session: ViewerLiveSessionSecurityView;
  viewerCount: number;
}

export class LiveAdmissionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    message: string,
    code: string,
    status: number,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface RpcErrorBody {
  code?: string;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unwrapRpcRow(value: unknown): Record<string, unknown> {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!isRecord(candidate)) throw new LiveAdmissionError("라이브 인증 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  return candidate;
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value) {
    throw new LiveAdmissionError("라이브 인증 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  return value;
}

function parseLanguages(row: Record<string, unknown>): string[] {
  const languages = row.languages;
  if (!Array.isArray(languages)
    || languages.length < 1
    || languages.length > 3
    || !languages.every((language) => typeof language === "string" && CANONICAL_LANGUAGE_CODES.has(language))
    || new Set(languages).size !== languages.length) {
    throw new LiveAdmissionError("입장권 언어 설정이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  return languages;
}

function parseVoiceProvider(
  row: Record<string, unknown>,
  sessionType: LiveSessionSecurityView["sessionType"],
  outputMode: LiveSessionSecurityView["outputMode"],
): LiveSessionSecurityView["voiceProvider"] {
  const voiceProvider = requiredString(row, "voice_provider");
  if (voiceProvider !== "gemini" && voiceProvider !== "openai") {
    throw new LiveAdmissionError("음성 공급자 설정이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  if (voiceProvider === "openai" && (sessionType !== "presentation" || outputMode === "captions")) {
    throw new LiveAdmissionError("음성 공급자 설정이 세션 모드와 일치하지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  return voiceProvider;
}

function mapRpcError(status: number, body: RpcErrorBody): LiveAdmissionError {
  const providerCode = body.code ?? "";
  const providerMessage = body.message ?? "";
  if (providerCode === "LIVE_SESSION_NOT_FOUND" || providerMessage.includes("LIVE_SESSION_NOT_FOUND")) {
    return new LiveAdmissionError("라이브 세션을 찾을 수 없습니다.", "LIVE_SESSION_NOT_FOUND", 404);
  }
  if (["ADMISSION_CLOSED", "INVITE_CLOSED", "INVITE_NOT_FOUND", "INVITE_EXPIRED", "INVITE_REVOKED"].some(
    (code) => providerCode === code || providerMessage.includes(code),
  )) {
    return new LiveAdmissionError("입장 시간이 종료되었거나 인증번호가 올바르지 않습니다.", "ADMISSION_CLOSED", 410);
  }
  if (providerCode === "VIEWER_LIMIT_REACHED" || providerMessage.includes("VIEWER_LIMIT_REACHED")) {
    return new LiveAdmissionError("호스트가 정한 최대 시청자 수에 도달했습니다.", "VIEWER_LIMIT_REACHED", 409);
  }
  if (providerCode === "VERSION_CONFLICT_OR_FORBIDDEN" || providerMessage.includes("VERSION_CONFLICT_OR_FORBIDDEN")) {
    return new LiveAdmissionError("세션이 다른 요청에서 변경되었습니다. 새로고침 후 다시 시도해 주세요.", "VERSION_CONFLICT", 409);
  }
  if (providerCode === "FORBIDDEN" || providerMessage.includes("FORBIDDEN")) {
    return new LiveAdmissionError("이 세션을 관리할 권한이 없습니다.", "FORBIDDEN", 403);
  }
  if (providerCode === "RATE_LIMITED" || providerMessage.includes("RATE_LIMITED")) {
    return new LiveAdmissionError("요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", "RATE_LIMITED", 429);
  }
  if (["INVALID_DISPLAY_NAME", "INVALID_JOIN_INPUT"].some(
    (code) => providerCode === code || providerMessage.includes(code),
  )) {
    return new LiveAdmissionError("표시할 이름 또는 입장 정보가 올바르지 않습니다.", "INVALID_JOIN_REQUEST", 400);
  }
  if (status === 409 || providerCode === "23505") {
    return new LiveAdmissionError("인증번호가 충돌했습니다. 다시 시도해 주세요.", "ADMISSION_CODE_COLLISION", 409);
  }
  return new LiveAdmissionError("라이브 인증 저장소에 연결할 수 없습니다.", "LIVE_STORE_UNAVAILABLE", 503);
}

function parseAdmissionRedemption(body: unknown): AdmissionRedemption {
  const row = unwrapRpcRow(body);
  const languages = parseLanguages(row);
  const sessionType = requiredString(row, "session_type");
  if (sessionType !== "presentation" && sessionType !== "meeting") {
    throw new LiveAdmissionError("입장권 세션 모드가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  const outputMode = requiredString(row, "output_mode");
  if (outputMode !== "captions" && outputMode !== "captions_audio" && outputMode !== "audio") {
    throw new LiveAdmissionError("입장권 출력 모드가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  const voiceProvider = parseVoiceProvider(row, sessionType, outputMode);
  const glossaryPack = requiredString(row, "glossary_pack");
  if (glossaryPack !== "general_cre" && glossaryPack !== "hotel" && glossaryPack !== "fnb") {
    throw new LiveAdmissionError("입장권 용어집 설정이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  const viewerCount = row.viewer_count;
  const maxViewers = row.max_viewers;
  if (typeof maxViewers !== "number" || !Number.isInteger(maxViewers) || maxViewers < 1 || maxViewers > 50) {
    throw new LiveAdmissionError("시청자 정원 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  if (typeof viewerCount !== "number" || !Number.isInteger(viewerCount) || viewerCount < 0 || viewerCount > maxViewers) {
    throw new LiveAdmissionError("시청자 수 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  return {
    grant: {
      id: requiredString(row, "grant_id"),
      sessionId: requiredString(row, "session_id"),
      userId: requiredString(row, "user_id"),
      displayName: requiredString(row, "display_name"),
      expiresAt: requiredString(row, "grant_expires_at"),
    },
    session: {
      id: requiredString(row, "session_id"),
      sessionType,
      outputMode,
      voiceProvider,
      glossaryPack,
      languages,
      maxViewers,
      expiresAt: requiredString(row, "session_expires_at"),
    },
    viewerCount,
  };
}

export function createLiveInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function resolveLiveAdmissionExpiry(session: Pick<LiveSessionSecurityView, "expiresAt">, now: number = Date.now()): string {
  const sessionExpiresAt = Date.parse(session.expiresAt);
  if (!Number.isFinite(sessionExpiresAt)) {
    throw new LiveAdmissionError("라이브 세션 만료 정보가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  const expiresAt = Math.min(now + 6 * 60 * 60 * 1_000, sessionExpiresAt);
  if (expiresAt <= now) {
    throw new LiveAdmissionError("라이브 세션이 종료되었습니다.", "LIVE_SESSION_EXPIRED", 410);
  }
  return new Date(expiresAt).toISOString();
}

export function resolveLiveInviteExpiry(session: LiveSessionSecurityView, now: number = Date.now()): string {
  const sessionExpiresAt = Date.parse(session.expiresAt);
  const admissionExpiresAt = session.admissionOpenUntil === null
    ? Number.NaN
    : Date.parse(session.admissionOpenUntil);
  if (!Number.isFinite(sessionExpiresAt)) {
    throw new LiveAdmissionError("라이브 세션 만료 정보가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  if (!Number.isFinite(admissionExpiresAt) || admissionExpiresAt <= now) {
    throw new LiveAdmissionError("입장 시간이 종료되었습니다.", "ADMISSION_CLOSED", 410);
  }
  const expiresAt = Math.min(now + 6 * 60 * 60 * 1_000, sessionExpiresAt, admissionExpiresAt);
  if (expiresAt <= now) throw new LiveAdmissionError("입장 시간이 종료되었습니다.", "ADMISSION_CLOSED", 410);
  return new Date(expiresAt).toISOString();
}

export class SupabaseLiveAdmissionStore {
  private readonly fetchFn: typeof fetch;
  private readonly getServerAccess: typeof getSupabaseServerAccess;

  constructor(dependencies: {
    fetchFn?: typeof fetch;
    getServerAccess?: typeof getSupabaseServerAccess;
  } = {}) {
    this.fetchFn = dependencies.fetchFn ?? fetch;
    this.getServerAccess = dependencies.getServerAccess ?? getSupabaseServerAccess;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const { url, credential } = this.getServerAccess();
    const response = await this.fetchFn(`${url}/rest/v1/${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        ...supabaseAdminHeaders(credential),
        "content-type": "application/json",
        ...init.headers,
      },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const errorBody: RpcErrorBody = isRecord(body)
        ? {
            code: typeof body.code === "string" ? body.code : undefined,
            message: typeof body.message === "string" ? body.message : undefined,
          }
        : {};
      throw mapRpcError(response.status, errorBody);
    }
    return body;
  }

  async assertHostSession(sessionId: string, hostId: string): Promise<LiveSessionSecurityView> {
    const query = new URLSearchParams({
      select: "id,session_type,output_mode,voice_provider,glossary_pack,languages,max_viewers,version,expires_at,admission_open_until",
      id: `eq.${sessionId}`,
      host_id: `eq.${hostId}`,
      status: "neq.stopped",
      expires_at: `gt.${new Date().toISOString()}`,
      limit: "1",
    });
    const body = await this.request(`live_sessions?${query}`, { method: "GET" });
    if (!Array.isArray(body) || body.length === 0) {
      throw new LiveAdmissionError("라이브 세션을 찾을 수 없거나 관리 권한이 없습니다.", "LIVE_SESSION_NOT_FOUND", 404);
    }
    const row = unwrapRpcRow(body);
    const languages = parseLanguages(row);
    const sessionType = requiredString(row, "session_type");
    if (sessionType !== "presentation" && sessionType !== "meeting") {
      throw new LiveAdmissionError("라이브 세션 모드가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    const outputMode = requiredString(row, "output_mode");
    if (outputMode !== "captions" && outputMode !== "captions_audio" && outputMode !== "audio") {
      throw new LiveAdmissionError("라이브 세션 출력 모드가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    const voiceProvider = parseVoiceProvider(row, sessionType, outputMode);
    const glossaryPack = requiredString(row, "glossary_pack");
    if (glossaryPack !== "general_cre" && glossaryPack !== "hotel" && glossaryPack !== "fnb") {
      throw new LiveAdmissionError("라이브 세션 용어집 설정이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    const maxViewers = row.max_viewers;
    if (typeof maxViewers !== "number" || !Number.isInteger(maxViewers) || maxViewers < 1 || maxViewers > 50) {
      throw new LiveAdmissionError("라이브 세션 정원 설정이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    const version = row.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
      throw new LiveAdmissionError("라이브 세션 버전이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    const expiresAt = requiredString(row, "expires_at");
    if (!Number.isFinite(Date.parse(expiresAt))) {
      throw new LiveAdmissionError("라이브 세션 만료 정보가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    const admissionOpenUntil = row.admission_open_until;
    if (admissionOpenUntil !== null
      && (typeof admissionOpenUntil !== "string" || !Number.isFinite(Date.parse(admissionOpenUntil)))) {
      throw new LiveAdmissionError("입장창 만료 정보가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    return {
      id: requiredString(row, "id"),
      sessionType,
      outputMode,
      voiceProvider,
      glossaryPack,
      languages,
      maxViewers,
      version,
      expiresAt,
      admissionOpenUntil,
    };
  }

  async openAdmission(input: {
    sessionId: string;
    hostId: string;
    codeHmac: string;
    openUntil: string;
    expectedVersion: number;
  }): Promise<number> {
    const body = await this.request("rpc/open_live_admission", {
      method: "POST",
      body: JSON.stringify({
        p_session_id: input.sessionId,
        p_host_id: input.hostId,
        p_code_hmac: input.codeHmac,
        p_open_until: input.openUntil,
        p_expected_version: input.expectedVersion,
      }),
    });
    if (typeof body !== "number" || !Number.isSafeInteger(body) || body <= input.expectedVersion) {
      throw new LiveAdmissionError("입장창 버전 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    return body;
  }

  async closeAdmission(sessionId: string, hostId: string, expectedVersion: number): Promise<number> {
    const body = await this.request("rpc/close_live_admission", {
      method: "POST",
      body: JSON.stringify({
        p_session_id: sessionId,
        p_host_id: hostId,
        p_expected_version: expectedVersion,
      }),
    });
    if (typeof body !== "number" || !Number.isSafeInteger(body) || body <= expectedVersion) {
      throw new LiveAdmissionError("입장창 버전 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    return body;
  }

  async createInvite(input: {
    sessionId: string;
    hostId: string;
    tokenHmac: string;
    expiresAt: string;
    admissionOpenUntil: string;
  }): Promise<void> {
    await this.request("rpc/create_live_invite", {
      method: "POST",
      body: JSON.stringify({
        p_session_id: input.sessionId,
        p_host_id: input.hostId,
        p_token_hmac: input.tokenHmac,
        p_expires_at: input.expiresAt,
        p_admission_open_until: input.admissionOpenUntil,
      }),
    });
  }

  async resolveAdmissionRateKey(codeHmac: string): Promise<string> {
    const body = await this.request("rpc/resolve_live_admission_rate_key", {
      method: "POST",
      body: JSON.stringify({ p_code_hmac: codeHmac }),
    });
    if (typeof body !== "string" || !/^[0-9a-f]{64}$/u.test(body)) {
      throw new LiveAdmissionError("입장 요청 제한 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    return body;
  }

  async resolveInviteRateKey(tokenHmac: string): Promise<string> {
    const body = await this.request("rpc/resolve_live_invite_rate_key", {
      method: "POST",
      body: JSON.stringify({ p_token_hmac: tokenHmac }),
    });
    if (typeof body !== "string" || !/^[0-9a-f]{64}$/u.test(body)) {
      throw new LiveAdmissionError("입장 요청 제한 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    return body;
  }

  async redeemAdmission(input: {
    codeHmac: string;
    userId: string;
    deviceHash: string;
    displayName: string;
    expiresAt: string;
  }): Promise<AdmissionRedemption> {
    const body = await this.request("rpc/redeem_live_admission", {
      method: "POST",
      body: JSON.stringify({
        p_code_hmac: input.codeHmac,
        p_user_id: input.userId,
        p_device_hash: input.deviceHash,
        p_display_name: input.displayName,
        p_grant_expires_at: input.expiresAt,
      }),
    });
    return parseAdmissionRedemption(body);
  }

  async redeemInvite(input: {
    tokenHmac: string;
    userId: string;
    deviceHash: string;
    displayName: string;
    expiresAt: string;
  }): Promise<AdmissionRedemption> {
    const body = await this.request("rpc/redeem_live_invite", {
      method: "POST",
      body: JSON.stringify({
        p_token_hmac: input.tokenHmac,
        p_user_id: input.userId,
        p_device_hash: input.deviceHash,
        p_display_name: input.displayName,
        p_grant_expires_at: input.expiresAt,
      }),
    });
    return parseAdmissionRedemption(body);
  }

  async consumeRateLimit(input: {
    scope: string;
    keyHash: string;
    limit: number;
    windowSeconds: number;
  }): Promise<boolean> {
    const body = await this.request("rpc/consume_live_rate_limit", {
      method: "POST",
      body: JSON.stringify({
        p_scope: input.scope,
        p_key_hash: input.keyHash,
        p_limit: input.limit,
        p_window_seconds: input.windowSeconds,
      }),
    });
    if (typeof body === "boolean") return body;
    const row = unwrapRpcRow(body);
    if (typeof row.allowed !== "boolean") {
      throw new LiveAdmissionError("요청 제한 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    return row.allowed;
  }

  async assertViewerTopicActive(sessionId: string, grantId: string, userId: string, language: string): Promise<void> {
    const body = await this.request("rpc/authorize_live_viewer_topic", {
      method: "POST",
      body: JSON.stringify({
        p_session_id: sessionId,
        p_grant_id: grantId,
        p_user_id: userId,
        p_language: language,
      }),
    });
    if (body !== true) {
      throw new LiveAdmissionError("시청자 입장권이 만료되었거나 폐기되었습니다.", "VIEWER_GRANT_REVOKED", 401);
    }
  }
}

export async function verifySupabaseAnonymousUser(accessToken: string): Promise<{ userId: string }> {
  const { url, publishableKey } = getSupabasePublicAccess();
  const response = await fetch(`${url}/auth/v1/user`, {
    cache: "no-store",
    headers: { apikey: publishableKey, authorization: `Bearer ${accessToken}` },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body) || typeof body.id !== "string" || body.is_anonymous !== true) {
    throw new LiveAdmissionError("익명 시청자 인증이 필요합니다.", "ANONYMOUS_AUTH_REQUIRED", 401);
  }
  return { userId: body.id };
}
