import { randomBytes } from "node:crypto";

import type { LiveAttendeeSelfProfile } from "../live-contract";
import { LANGUAGE_CODES } from "../languageDetect";

import { canonicalizeParticipantEmail } from "./participant-identity";
import { getSupabasePublicAccess, getSupabaseServerAccess, supabaseAdminHeaders } from "./supabase-server-access";

export interface LiveSessionSecurityView {
  id: string;
  title: string;
  scheduledAt: string | null;
  status: "preparing" | "live" | "paused";
  sessionType: "presentation" | "meeting";
  outputMode: "captions";
  voiceProvider: "gemini";
  glossaryPack: "general_cre" | "hotel" | "fnb";
  languages: string[];
  maxViewers: number;
  participantSpeakingEnabled: boolean;
  version: number;
  expiresAt: string;
  admissionOpenUntil: string | null;
  admissionGeneration: number;
  admissionState: "uninitialized" | "open" | "paused" | "ended";
}

export interface ViewerGrantRecord {
  id: string;
  sessionId: string;
  userId: string;
  displayName: string;
  department: string;
  jobTitle: string;
  participantId: string;
  expiresAt: string;
}

type ViewerLiveSessionSecurityView = Omit<
  LiveSessionSecurityView,
  "admissionOpenUntil" | "admissionGeneration" | "admissionState" | "version"
>;
const CANONICAL_LANGUAGE_CODES = new Set<string>(LANGUAGE_CODES);

export interface AdmissionRedemption {
  grant: ViewerGrantRecord;
  self: LiveAttendeeSelfProfile;
  session: ViewerLiveSessionSecurityView;
  viewerCount: number;
}

export interface LiveSessionLifecycle {
  id: string;
  hostId: string;
  title: string;
  scheduledAt: string | null;
  status: "preparing" | "live" | "paused" | "stopped" | "failed";
  endedAt: string | null;
}

export interface ParticipantRecordRecovery {
  session: {
    id: string;
    title: string;
    scheduledAt: string | null;
    status: "stopped" | "failed";
    endedAt: string;
    sessionType: "presentation" | "meeting";
    outputMode: "captions";
    voiceProvider: "gemini";
    glossaryPack: "general_cre" | "hotel" | "fnb";
    languages: string[];
    maxViewers: number;
    participantSpeakingEnabled: false;
  };
  self: LiveAttendeeSelfProfile;
  participantId: string;
  recordsExpiresAt: string;
}

export const PARTICIPANT_RECORD_ACCESS_MILLISECONDS = 6 * 60 * 60 * 1_000;

export interface ParticipantSourceTranscriptPage {
  view: "source";
  utterances: Array<{ seq: number; speaker: string; text: string; emittedAt: string; sourceLanguage: string }>;
  nextAfterSourceSeq: number | null;
  hasNextPage: boolean;
}

export interface LiveParticipantRosterRecord {
  participantId: string;
  grantId: string;
  userId: string;
  displayName: string;
  email: string | null;
  company: string | null;
  department: string;
  jobTitle: string;
  summaryConsentAt: string | null;
  joinedAt: string;
  lastSeenAt: string;
  leftAt: string | null;
  lastSpokeAt: string | null;
  utteranceCount: number;
  speakingSeconds: number;
  retentionExpiresAt: string | null;
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

function optionalString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    throw new LiveAdmissionError("라이브 인증 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  return value;
}

function readSafeDisplayName(row: Record<string, unknown>, key: string, message: string): string {
  const value = requiredString(row, key);
  if (value !== value.normalize("NFC").trim()
    || Array.from(value).length < 1
    || Array.from(value).length > 40
    || /[<>\p{Cc}\p{Cf}]/u.test(value)) {
    throw new LiveAdmissionError(message, "INVALID_STORE_RESPONSE", 503);
  }
  return value;
}

function nullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string" || !value) {
    throw new LiveAdmissionError("라이브 인증 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  return value;
}

function requiredTimestamp(row: Record<string, unknown>, key: string): string {
  const value = requiredString(row, key);
  if (!Number.isFinite(Date.parse(value))) {
    throw new LiveAdmissionError("라이브 인증 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  return value;
}

function optionalTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
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

function parseVoiceProvider(row: Record<string, unknown>): LiveSessionSecurityView["voiceProvider"] {
  const voiceProvider = requiredString(row, "voice_provider");
  if (voiceProvider !== "gemini" && voiceProvider !== "openai") {
    throw new LiveAdmissionError("음성 공급자 설정이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  // 2026-07-27 fix: 기존 DB 행의 OpenAI 값은 라이브 저장소와 동일하게 Gemini로 승격한다.
  // 신규 입력은 Gemini만 허용하므로 폐기된 공급자가 뷰어 계약으로 다시 노출되지 않는다.
  return "gemini";
}

function parseParticipantSpeakingEnabled(row: Record<string, unknown>): boolean {
  const value = row.participant_speaking_enabled;
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw new LiveAdmissionError("참여자 발언권 설정이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  return value;
}

function mapRpcError(status: number, body: RpcErrorBody): LiveAdmissionError {
  const providerCode = body.code ?? "";
  const providerMessage = body.message ?? "";
  if (providerCode === "RECAP_EXPIRED" || providerMessage === "RECAP_EXPIRED") {
    return new LiveAdmissionError("회의 종료 후 6시간의 열람 기간이 지났습니다.", "RECAP_EXPIRED", 410);
  }
  if (providerCode === "RECAP_NOT_READY" || providerMessage === "RECAP_NOT_READY") {
    return new LiveAdmissionError("회의 종료 후 기록을 볼 수 있습니다.", "RECAP_NOT_READY", 409);
  }
  if (providerCode === "RECAP_FORBIDDEN" || providerMessage === "RECAP_FORBIDDEN") {
    return new LiveAdmissionError("이 회의 기록을 볼 권한이 없습니다.", "RECAP_FORBIDDEN", 403);
  }
  if (providerCode === "LIVE_SESSION_NOT_FOUND" || providerMessage.includes("LIVE_SESSION_NOT_FOUND")) {
    return new LiveAdmissionError("라이브 세션을 찾을 수 없습니다.", "LIVE_SESSION_NOT_FOUND", 404);
  }
  if (["ADMISSION_CLOSED", "INVITE_CLOSED", "INVITE_NOT_FOUND", "INVITE_EXPIRED", "INVITE_REVOKED"].some(
    (code) => providerCode === code || providerMessage.includes(code),
  )) {
    return new LiveAdmissionError("QR 초대가 만료되었거나 종료되었습니다.", "ADMISSION_CLOSED", 410);
  }
  if (providerCode === "VIEWER_LIMIT_REACHED" || providerMessage.includes("VIEWER_LIMIT_REACHED")) {
    return new LiveAdmissionError("호스트가 정한 최대 시청자 수에 도달했습니다.", "VIEWER_LIMIT_REACHED", 409);
  }
  if (providerCode === "VIEWER_RESTORE_FORBIDDEN" || providerMessage.includes("VIEWER_RESTORE_FORBIDDEN")) {
    return new LiveAdmissionError(
      "시청자 인증이 만료되었거나 더 이상 유효하지 않습니다.",
      "VIEWER_RESTORE_FORBIDDEN",
      401,
    );
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
  if ([
    "INVALID_DISPLAY_NAME",
    "INVALID_JOIN_INPUT",
    "INVALID_PARTICIPANT_IDENTITY",
    "INVALID_ATTENDEE_PROFILE",
    "INVALID_ATTENDEE_CREDENTIAL",
  ].some(
    (code) => providerCode === code || providerMessage.includes(code),
  )) {
    return new LiveAdmissionError("표시할 이름 또는 입장 정보가 올바르지 않습니다.", "INVALID_JOIN_REQUEST", 400);
  }
  if (status === 409 || providerCode === "23505") {
    return new LiveAdmissionError("인증번호가 충돌했습니다. 다시 시도해 주세요.", "ADMISSION_CODE_COLLISION", 409);
  }
  return new LiveAdmissionError("라이브 인증 저장소에 연결할 수 없습니다.", "LIVE_STORE_UNAVAILABLE", 503);
}

function parseAdmissionRedemption(body: unknown, expectedEmail?: string, expectedDisplayName?: string): AdmissionRedemption {
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
  const voiceProvider = parseVoiceProvider(row);
  // glossary_pack is deprecated and slated for a column drop; tolerate its
  // absence instead of failing admission on a field nothing reads anymore.
  const glossaryPackValue = typeof row.glossary_pack === "string" ? row.glossary_pack : "general_cre";
  const glossaryPack = glossaryPackValue === "hotel" || glossaryPackValue === "fnb" ? glossaryPackValue : "general_cre";
  const viewerCount = row.viewer_count;
  const maxViewers = row.max_viewers;
  const participantSpeakingEnabled = parseParticipantSpeakingEnabled(row);
  if (typeof maxViewers !== "number" || !Number.isInteger(maxViewers) || maxViewers < 1 || maxViewers > 200) {
    throw new LiveAdmissionError("시청자 정원 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  if (typeof viewerCount !== "number" || !Number.isInteger(viewerCount) || viewerCount < 0 || viewerCount > maxViewers) {
    throw new LiveAdmissionError("시청자 수 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  const status = row.status ?? "live";
  if (status !== "preparing" && status !== "live" && status !== "paused") {
    throw new LiveAdmissionError("입장권 세션 상태가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  const title = row.title ?? "Live Session";
  if (typeof title !== "string" || Array.from(title).length < 1 || Array.from(title).length > 120) {
    throw new LiveAdmissionError("입장권 세션 제목이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  const scheduledAt = row.scheduled_at ?? null;
  if (scheduledAt !== null && (typeof scheduledAt !== "string" || !Number.isFinite(Date.parse(scheduledAt)))) {
    throw new LiveAdmissionError("입장권 세션 일정이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  const email = requiredString(row, "email");
  let canonicalEmail: string;
  try {
    canonicalEmail = canonicalizeParticipantEmail(email);
  } catch {
    throw new LiveAdmissionError("참여자 정보 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  const displayName = readSafeDisplayName(row, "display_name", "참여자 정보 응답이 올바르지 않습니다.");
  if (email !== canonicalEmail
    || (expectedEmail !== undefined && email !== expectedEmail)
    || (expectedDisplayName !== undefined && displayName !== expectedDisplayName)) {
    throw new LiveAdmissionError("참여자 정보 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  const summaryConsentAt = row.summary_consent_at;
  if (summaryConsentAt !== null
    && (typeof summaryConsentAt !== "string" || !Number.isFinite(Date.parse(summaryConsentAt)))) {
    throw new LiveAdmissionError("참여자 동의 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  const company = optionalString(row, "company");
  const department = optionalString(row, "department");
  const jobTitle = optionalString(row, "job_title");
  return {
    grant: {
      id: requiredString(row, "grant_id"),
      sessionId: requiredString(row, "session_id"),
      userId: requiredString(row, "user_id"),
      displayName,
      department,
      jobTitle,
      participantId: requiredString(row, "participant_id"),
      expiresAt: requiredString(row, "grant_expires_at"),
    },
    self: {
      email,
      displayName,
      company,
      department,
      jobTitle,
      summaryConsent: summaryConsentAt !== null,
    },
    session: {
      id: requiredString(row, "session_id"),
      title,
      scheduledAt,
      status,
      sessionType,
      outputMode: "captions",
      voiceProvider,
      glossaryPack,
      languages,
      maxViewers,
      participantSpeakingEnabled,
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
  if (!Number.isFinite(sessionExpiresAt)) {
    throw new LiveAdmissionError("라이브 세션 만료 정보가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
  }
  const expiresAt = sessionExpiresAt;
  if (expiresAt <= now) throw new LiveAdmissionError("입장 시간이 종료되었습니다.", "ADMISSION_CLOSED", 410);
  return new Date(expiresAt).toISOString();
}

export function requireOpenLiveAdmissionExpiry(
  session: Pick<LiveSessionSecurityView, "admissionState" | "admissionOpenUntil">,
  now: number = Date.now(),
): string {
  if (session.admissionState !== "open" || !session.admissionOpenUntil
    || !(Date.parse(session.admissionOpenUntil) > now)) {
    throw new LiveAdmissionError("참여자 입장이 닫혀 있습니다.", "ADMISSION_CLOSED", 410);
  }
  return session.admissionOpenUntil;
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
    let response: Response;
    try {
      response = await this.fetchFn(`${url}/rest/v1/${path}`, {
        ...init,
        cache: "no-store",
        headers: {
          ...supabaseAdminHeaders(credential),
          "content-type": "application/json",
          ...init.headers,
        },
      });
    } catch {
      throw new LiveAdmissionError(
        "라이브 인증 저장소에 연결할 수 없습니다.",
        "LIVE_STORE_UNAVAILABLE",
        503,
      );
    }
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
      select: "id,title,scheduled_at,status,session_type,output_mode,voice_provider,glossary_pack,languages,max_viewers,participant_speaking_enabled,version,expires_at,admission_open_until,admission_generation,admission_state",
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
    const voiceProvider = parseVoiceProvider(row);
    // Deprecated field — tolerate absence (column drop is planned).
    const glossaryPackValue = typeof row.glossary_pack === "string" ? row.glossary_pack : "general_cre";
    const glossaryPack = glossaryPackValue === "hotel" || glossaryPackValue === "fnb" ? glossaryPackValue : "general_cre";
    const maxViewers = row.max_viewers;
    const participantSpeakingEnabled = parseParticipantSpeakingEnabled(row);
    if (typeof maxViewers !== "number" || !Number.isInteger(maxViewers) || maxViewers < 1 || maxViewers > 200) {
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
    const admissionGeneration = row.admission_generation;
    if (typeof admissionGeneration !== "number"
      || !Number.isSafeInteger(admissionGeneration)
      || admissionGeneration < 0) {
      throw new LiveAdmissionError("인증번호 세대 정보가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    const admissionState = row.admission_state;
    if (admissionState !== "uninitialized"
      && admissionState !== "open"
      && admissionState !== "paused"
      && admissionState !== "ended") {
      throw new LiveAdmissionError("입장 상태가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    const title = row.title ?? "Live Session";
    if (typeof title !== "string" || Array.from(title).length < 1 || Array.from(title).length > 120) {
      throw new LiveAdmissionError("라이브 세션 제목이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    const scheduledAt = row.scheduled_at ?? null;
    if (scheduledAt !== null && (typeof scheduledAt !== "string" || !Number.isFinite(Date.parse(scheduledAt)))) {
      throw new LiveAdmissionError("라이브 세션 일정이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    const status = row.status ?? "preparing";
    if (status !== "preparing" && status !== "live" && status !== "paused") {
      throw new LiveAdmissionError("라이브 세션 상태가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    return {
      id: requiredString(row, "id"),
      title,
      scheduledAt,
      status,
      sessionType,
      outputMode: "captions",
      voiceProvider,
      glossaryPack,
      languages,
      maxViewers,
      participantSpeakingEnabled,
      version,
      expiresAt,
      admissionOpenUntil,
      admissionGeneration,
      admissionState,
    };
  }

  async readSessionLifecycle(sessionId: string): Promise<LiveSessionLifecycle | null> {
    const query = new URLSearchParams({
      select: "id,host_id,title,scheduled_at,status,ended_at",
      id: `eq.${sessionId}`,
      limit: "1",
    });
    const body = await this.request(`live_sessions?${query}`, { method: "GET" });
    if (!Array.isArray(body) || body.length === 0) return null;
    const row = unwrapRpcRow(body);
    const status = requiredString(row, "status");
    if (!["preparing", "live", "paused", "stopped", "failed"].includes(status)) {
      throw new LiveAdmissionError("라이브 세션 상태가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    const title = row.title ?? "Live Session";
    const scheduledAt = row.scheduled_at ?? null;
    const endedAt = row.ended_at ?? null;
    if (typeof title !== "string"
      || Array.from(title).length < 1
      || Array.from(title).length > 120
      || (scheduledAt !== null && (typeof scheduledAt !== "string" || !Number.isFinite(Date.parse(scheduledAt))))
      || (endedAt !== null && (typeof endedAt !== "string" || !Number.isFinite(Date.parse(endedAt))))) {
      throw new LiveAdmissionError("라이브 세션 정보가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    return {
      id: requiredString(row, "id"),
      hostId: requiredString(row, "host_id"),
      title,
      scheduledAt,
      status: status as LiveSessionLifecycle["status"],
      endedAt,
    };
  }

  async assertHostSessionOwnership(sessionId: string, hostId: string): Promise<void> {
    const session = await this.readSessionLifecycle(sessionId);
    if (!session || session.hostId !== hostId) {
      throw new LiveAdmissionError("라이브 세션을 찾을 수 없습니다.", "LIVE_SESSION_NOT_FOUND", 404);
    }
  }

  async assertParticipantAccess(input: {
    sessionId: string;
    userId: string;
    grantId?: string;
    recapOnly?: boolean;
  }): Promise<"viewer" | "recap"> {
    if (input.recapOnly) {
      await this.readParticipantRecordAccess(input.sessionId, input.userId);
      return "recap";
    }
    const lifecycle = await this.readSessionLifecycle(input.sessionId);
    if (!lifecycle) throw new LiveAdmissionError("회의록을 볼 권한이 없습니다.", "RECAP_FORBIDDEN", 403);
    // 2026-08-31 fix: 종료 후 남아 있는 live grant도 6시간 기록 권한을 우회하지 못한다.
    if (lifecycle.status === "stopped" || lifecycle.status === "failed") {
      await this.readParticipantRecordAccess(input.sessionId, input.userId);
      return "recap";
    }
    if (!input.recapOnly && input.grantId) {
      const viewerQuery = new URLSearchParams({
        select: "id",
        id: `eq.${input.grantId}`,
        session_id: `eq.${input.sessionId}`,
        user_id: `eq.${input.userId}`,
        revoked_at: "is.null",
        expires_at: `gt.${new Date().toISOString()}`,
        limit: "1",
      });
      const viewerRows = await this.request(`viewer_grants?${viewerQuery}`, { method: "GET" });
      if (Array.isArray(viewerRows) && viewerRows.length === 1) return "viewer";
    }
    throw new LiveAdmissionError("회의록을 볼 권한이 없습니다.", "RECAP_FORBIDDEN", 403);
  }

  async readParticipantRecordAccess(sessionId: string, userId: string): Promise<ParticipantRecordRecovery> {
    const body = await this.request("rpc/read_participant_live_record_access_v1", {
      method: "POST",
      body: JSON.stringify({ p_session_id: sessionId, p_user_id: userId }),
    });
    if (Array.isArray(body) && body.length === 0) {
      throw new LiveAdmissionError("이 회의 기록을 볼 권한이 없습니다.", "RECAP_FORBIDDEN", 403);
    }
    if (!Array.isArray(body) || body.length !== 1) {
      throw new LiveAdmissionError("회의 기록 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    const row = unwrapRpcRow(body);
    if (row.session_id !== sessionId || row.user_id !== userId) {
      throw new LiveAdmissionError("회의 기록 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    if (row.status !== "stopped" && row.status !== "failed") {
      throw new LiveAdmissionError("회의 종료 후 기록을 볼 수 있습니다.", "RECAP_NOT_READY", 409);
    }
    const endedAt = requiredTimestamp(row, "ended_at");
    const recordsExpiresAt = requiredTimestamp(row, "records_expires_at");
    if (Date.parse(recordsExpiresAt) !== Date.parse(endedAt) + PARTICIPANT_RECORD_ACCESS_MILLISECONDS) {
      throw new LiveAdmissionError("회의 기록 열람 기한이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    if (Date.parse(recordsExpiresAt) <= Date.now()) {
      throw new LiveAdmissionError("회의 종료 후 6시간의 열람 기간이 지났습니다.", "RECAP_EXPIRED", 410);
    }
    const sessionType = row.session_type;
    const glossaryPack = row.glossary_pack;
    const maxViewers = row.max_viewers;
    if ((sessionType !== "presentation" && sessionType !== "meeting")
      || (glossaryPack !== "general_cre" && glossaryPack !== "hotel" && glossaryPack !== "fnb")
      || row.output_mode !== "captions" || typeof maxViewers !== "number"
      || !Number.isSafeInteger(maxViewers) || maxViewers < 1 || maxViewers > 200) {
      throw new LiveAdmissionError("회의 기록 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    const email = optionalString(row, "email");
    if (email && canonicalizeParticipantEmail(email) !== email) {
      throw new LiveAdmissionError("참가자 이메일 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    return {
      session: {
        id: sessionId, title: requiredString(row, "title"), scheduledAt: optionalTimestamp(row.scheduled_at),
        status: row.status, endedAt, sessionType, outputMode: "captions", voiceProvider: parseVoiceProvider(row),
        glossaryPack, languages: parseLanguages(row), maxViewers, participantSpeakingEnabled: false,
      },
      self: {
        email, displayName: readSafeDisplayName(row, "display_name", "참가자 표시 정보가 올바르지 않습니다."),
        company: optionalString(row, "company"), department: optionalString(row, "department"),
        jobTitle: optionalString(row, "job_title"), summaryConsent: optionalTimestamp(row.summary_consent_at) !== null,
      },
      participantId: requiredString(row, "participant_id"), recordsExpiresAt,
    };
  }

  async readParticipantSourceTranscript(
    sessionId: string,
    userId: string,
    input: { afterSourceSeq: number; pageSize: number },
  ): Promise<ParticipantSourceTranscriptPage> {
    if (!Number.isSafeInteger(input.afterSourceSeq) || input.afterSourceSeq < 0
      || !Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 500) {
      throw new LiveAdmissionError("원문 페이지 요청이 올바르지 않습니다.", "INVALID_RECAP_TRANSCRIPT_INPUT", 400);
    }
    const body = await this.request("rpc/read_participant_live_source_transcript_v1", {
      method: "POST",
      body: JSON.stringify({ p_session_id: sessionId, p_user_id: userId,
        p_after_source_seq: input.afterSourceSeq, p_limit: input.pageSize + 1 }),
    });
    if (!Array.isArray(body) || body.length > input.pageSize + 1) {
      throw new LiveAdmissionError("원문 기록 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    let previousSeq = input.afterSourceSeq;
    let textCodepoints = 0;
    const utterances = body.map((value: unknown) => {
      if (!isRecord(value) || typeof value.source_seq !== "number"
        || !Number.isSafeInteger(value.source_seq) || value.source_seq <= previousSeq) {
        throw new LiveAdmissionError("원문 기록 순서가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
      }
      previousSeq = value.source_seq;
      const text = requiredString(value, "effective_text");
      textCodepoints += Array.from(text).length;
      if (textCodepoints > 2_000_000) {
        throw new LiveAdmissionError("원문 기록 페이지가 너무 큽니다.", "RECAP_TRANSCRIPT_PAGE_TOO_LARGE", 413);
      }
      return { seq: value.source_seq, speaker: requiredString(value, "speaker_label"), text,
        emittedAt: requiredTimestamp(value, "source_ended_at"), sourceLanguage: requiredString(value, "source_language") };
    });
    const hasNextPage = utterances.length > input.pageSize;
    const page = utterances.slice(0, input.pageSize);
    return { view: "source", utterances: page, hasNextPage,
      nextAfterSourceSeq: hasNextPage ? page.at(-1)?.seq ?? null : null };
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
  }): Promise<void> {
    await this.request("rpc/create_live_invite", {
      method: "POST",
      body: JSON.stringify({
        p_session_id: input.sessionId,
        p_host_id: input.hostId,
        p_token_hmac: input.tokenHmac,
        p_expires_at: input.expiresAt,
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

  async redeemAttendee(input: ({
    inviteTokenHmac: string;
    codeHmac?: never;
  } | {
    inviteTokenHmac?: never;
    codeHmac: string;
  }) & {
    userId: string;
    deviceHash: string;
    email: string;
    displayName: string;
    company: string;
    department: string;
    jobTitle: string;
    privacyConsent: true;
    summaryConsent: boolean;
    marketingConsent: boolean;
    consentNoticeVersions: {
      privacy: string;
      summaryDelivery: string;
      marketing: string;
    };
    expiresAt: string;
  }): Promise<AdmissionRedemption> {
    const body = await this.request("rpc/redeem_live_attendee_v3", {
      method: "POST",
      body: JSON.stringify({
        p_invite_token_hmac: "inviteTokenHmac" in input ? input.inviteTokenHmac : null,
        p_code_hmac: "codeHmac" in input ? input.codeHmac : null,
        p_user_id: input.userId,
        p_device_hash: input.deviceHash,
        p_grant_expires_at: input.expiresAt,
        p_email: input.email,
        p_display_name: input.displayName,
        p_company: input.company || null,
        p_department: input.department || null,
        p_job_title: input.jobTitle || null,
        p_privacy_consent: input.privacyConsent,
        p_summary_consent: input.summaryConsent,
        p_marketing_consent: input.marketingConsent,
        p_privacy_notice_version: input.consentNoticeVersions.privacy,
        p_summary_delivery_notice_version: input.consentNoticeVersions.summaryDelivery,
        p_marketing_notice_version: input.consentNoticeVersions.marketing,
      }),
    });
    return parseAdmissionRedemption(body, input.email, input.displayName);
  }

  async restoreAttendee(input: {
    grantId: string;
    sessionId: string;
    userId: string;
  }): Promise<AdmissionRedemption> {
    const body = await this.request("rpc/restore_live_attendee_v2", {
      method: "POST",
      body: JSON.stringify({
        p_grant_id: input.grantId,
        p_session_id: input.sessionId,
        p_user_id: input.userId,
      }),
    });
    const restored = parseAdmissionRedemption(body);
    if (restored.grant.id !== input.grantId
      || restored.grant.sessionId !== input.sessionId
      || restored.grant.userId !== input.userId) {
      throw new LiveAdmissionError("복구된 시청자 정보가 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    return restored;
  }

  async readParticipantRoster(sessionId: string, hostId: string): Promise<LiveParticipantRosterRecord[]> {
    const body = await this.request("rpc/read_live_participant_roster", {
      method: "POST",
      body: JSON.stringify({ p_session_id: sessionId, p_host_id: hostId }),
    });
    if (!Array.isArray(body)) {
      throw new LiveAdmissionError("참가자 목록 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    return body.map((value) => {
      if (!isRecord(value)) {
        throw new LiveAdmissionError("참가자 목록 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
      }
      const utteranceCount = value.utterance_count;
      const speakingSeconds = Number(value.speaking_seconds);
      const leftAt = optionalTimestamp(value.left_at);
      const lastSpokeAt = optionalTimestamp(value.last_spoke_at);
      const retentionExpiresAt = optionalTimestamp(value.retention_expires_at);
      const summaryConsentAt = optionalTimestamp(value.summary_consent_at);
      const email = nullableString(value, "email");
      const company = nullableString(value, "company");
      if (email) {
        try {
          canonicalizeParticipantEmail(email);
        } catch {
          throw new LiveAdmissionError("참가자 이메일 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
        }
      }
      if (typeof utteranceCount !== "number"
        || !Number.isSafeInteger(utteranceCount)
        || utteranceCount < 0
        || !Number.isFinite(speakingSeconds)
        || speakingSeconds < 0) {
        throw new LiveAdmissionError("참가자 목록 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
      }
      return {
        participantId: requiredString(value, "participant_id"),
        grantId: requiredString(value, "grant_id"),
        userId: requiredString(value, "user_id"),
        displayName: readSafeDisplayName(value, "display_name", "참가자 목록 응답이 올바르지 않습니다."),
        email,
        company,
        department: optionalString(value, "department"),
        jobTitle: optionalString(value, "job_title"),
        summaryConsentAt,
        joinedAt: requiredTimestamp(value, "joined_at"),
        lastSeenAt: requiredTimestamp(value, "last_seen_at"),
        leftAt,
        lastSpokeAt,
        utteranceCount,
        speakingSeconds,
        retentionExpiresAt,
      };
    });
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

  async leaveViewer(sessionId: string, grantId: string, userId: string): Promise<boolean> {
    const body = await this.request("rpc/leave_live_session", {
      method: "POST",
      body: JSON.stringify({
        p_session_id: sessionId,
        p_grant_id: grantId,
        p_user_id: userId,
      }),
    });
    if (typeof body !== "boolean") {
      throw new LiveAdmissionError("퇴장 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    return body;
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
