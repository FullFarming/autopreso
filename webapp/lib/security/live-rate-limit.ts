import type { NextRequest } from "next/server";
import { isIP } from "node:net";

import { LIVE_ADMISSION_PEPPER } from "./config";
import { opaqueIdentifier } from "./hmac";
import { LiveAdmissionError } from "./live-admission-store";

export interface RateLimitStore {
  consumeRateLimit(input: {
    scope: string;
    keyHash: string;
    limit: number;
    windowSeconds: number;
  }): Promise<boolean>;
}

type HeaderReader = Pick<Headers, "get">;

export class HostLoginRateLimitError extends LiveAdmissionError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.", "LOGIN_RATE_LIMITED", 429);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function getRequestIp(
  request: { headers: HeaderReader },
  nodeEnvironment: string | undefined = process.env.NODE_ENV,
  isVercelRuntime: boolean = process.env.VERCEL === "1",
): string {
  const isProduction = nodeEnvironment === "production";
  const vercelForwardedFor = !isProduction || isVercelRuntime
    ? request.headers.get("x-vercel-forwarded-for")
    : null;
  const developmentForwardedFor = isProduction
    ? null
    : request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip");
  const raw = vercelForwardedFor ?? developmentForwardedFor ?? "";
  const candidate = raw.length <= 512 ? raw.split(",", 1)[0].trim() : "";
  return isIP(candidate) ? candidate : "unknown";
}

export async function enforceHostLoginCredentialRateLimits(
  accountId: string,
  store: RateLimitStore,
): Promise<void> {
  const buckets = [
    { scope: "host-login-account", value: accountId, limit: 10, windowSeconds: 15 * 60 },
    { scope: "host-login-global", value: "all-host-login-attempts", limit: 120, windowSeconds: 5 * 60 },
  ] as const;
  const decisions = await Promise.all(buckets.map(async ({ scope, value, limit, windowSeconds }) => {
    const keyHash = await opaqueIdentifier(LIVE_ADMISSION_PEPPER, scope, value);
    return store.consumeRateLimit({ scope, keyHash, limit, windowSeconds });
  }));
  if (decisions.some((allowed) => !allowed)) {
    // 2026-08-31 fix: 기존 RPC는 reset 시간을 반환하지 않아 거절한 창의 최대 길이를 안전한 재시도 간격으로 안내한다.
    throw new HostLoginRateLimitError(Math.max(...buckets.filter((_, index) => !decisions[index]).map((bucket) => bucket.windowSeconds)));
  }
}

export async function enforceHostLoginRateLimit(
  request: Pick<NextRequest, "headers">,
  store: RateLimitStore,
): Promise<void> {
  const keyHash = await opaqueIdentifier(LIVE_ADMISSION_PEPPER, "host-login-ip", getRequestIp(request));
  const allowed = await store.consumeRateLimit({
    scope: "host-login-ip",
    keyHash,
    limit: 5,
    windowSeconds: 15 * 60,
  });
  if (!allowed) {
    throw new HostLoginRateLimitError(15 * 60);
  }
}

export async function enforceViewerGatewayTicketRateLimit(
  input: { sessionId: string; grantId: string },
  store: RateLimitStore,
): Promise<void> {
  const buckets = [
    {
      scope: "viewer-gateway-ticket-grant",
      value: `${input.sessionId}\u0000${input.grantId}`,
      limit: 30,
      windowSeconds: 60,
    },
    {
      scope: "viewer-gateway-ticket-session",
      value: input.sessionId,
      limit: 1_200,
      windowSeconds: 60,
    },
  ] as const;
  const decisions = await Promise.all(buckets.map(async ({ scope, value, limit, windowSeconds }) => {
    const keyHash = await opaqueIdentifier(LIVE_ADMISSION_PEPPER, scope, value);
    return store.consumeRateLimit({ scope, keyHash, limit, windowSeconds });
  }));
  if (decisions.some((allowed) => !allowed)) {
    throw new LiveAdmissionError(
      "게이트웨이 연결 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      "VIEWER_GATEWAY_TICKET_RATE_LIMITED",
      429,
    );
  }
}

export async function enforceJoinPreflightRateLimits(
  request: Pick<NextRequest, "headers">,
  deviceId: string,
  store: RateLimitStore,
): Promise<void> {
  const rawKeys = [
    ["join-ip", getRequestIp(request), 12],
    ["join-device", deviceId, 8],
  ] as const;
  const decisions = await Promise.all(rawKeys.map(async ([scope, value, limit]) => {
    const keyHash = await opaqueIdentifier(LIVE_ADMISSION_PEPPER, scope, value);
    return store.consumeRateLimit({ scope, keyHash, limit, windowSeconds: 300 });
  }));
  if (decisions.some((allowed) => !allowed)) {
    throw new LiveAdmissionError("요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", "RATE_LIMITED", 429);
  }
}

export async function enforceSessionJoinRateLimit(
  sessionRateKey: string,
  store: RateLimitStore,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/u.test(sessionRateKey)) {
    throw new LiveAdmissionError("세션 요청 제한 키가 올바르지 않습니다.", "INVALID_RATE_LIMIT_KEY", 503);
  }
  const allowed = await store.consumeRateLimit({
    scope: "join-session",
    keyHash: sessionRateKey,
    // 정원 200명이 QR 스캔 직후 같은 5분 창에 몰릴 수 있다(60이면 61번째부터
    // 429). 재시도 여유를 포함해 정원의 1.5배로 잡는다.
    limit: 300,
    windowSeconds: 300,
  });
  if (!allowed) {
    throw new LiveAdmissionError("이 세션의 입장 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", "RATE_LIMITED", 429);
  }
}

export async function enforceAdmissionCodeAttemptRateLimit(
  store: RateLimitStore,
): Promise<void> {
  const keyHash = await opaqueIdentifier(
    LIVE_ADMISSION_PEPPER,
    "join-admission-global",
    "six-digit-code-attempt",
  );
  const allowed = await store.consumeRateLimit({
    scope: "join-admission-global",
    keyHash,
    limit: 300,
    windowSeconds: 300,
  });
  if (!allowed) {
    throw new LiveAdmissionError(
      "인증번호 입장 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      "RATE_LIMITED",
      429,
    );
  }
}

export async function enforceGatewayTokenRateLimit(
  hostId: string,
  sessionId: string,
  store: RateLimitStore,
): Promise<void> {
  const keyHash = await opaqueIdentifier(
    LIVE_ADMISSION_PEPPER,
    "gateway-token-host-session",
    `${hostId}\u0000${sessionId}`,
  );
  const allowed = await store.consumeRateLimit({
    scope: "gateway-token-host-session",
    keyHash,
    limit: 30,
    windowSeconds: 15 * 60,
  });
  if (!allowed) {
    throw new LiveAdmissionError(
      "게이트웨이 연결 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      "GATEWAY_TOKEN_RATE_LIMITED",
      429,
    );
  }
}

export async function enforceLiveStartRateLimit(
  hostId: string,
  sessionId: string,
  store: RateLimitStore,
): Promise<void> {
  const keyHash = await opaqueIdentifier(
    LIVE_ADMISSION_PEPPER,
    "live-start-host-session",
    `${hostId}\u0000${sessionId}`,
  );
  const allowed = await store.consumeRateLimit({
    scope: "live-start-host-session",
    keyHash,
    limit: 12,
    windowSeconds: 60,
  });
  if (!allowed) {
    throw new LiveAdmissionError(
      "라이브 시작 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      "LIVE_START_RATE_LIMITED",
      429,
    );
  }
}

export async function enforceGlossarySelectionRateLimit(
  hostId: string,
  sessionId: string,
  store: RateLimitStore,
): Promise<void> {
  const keyHash = await opaqueIdentifier(
    LIVE_ADMISSION_PEPPER,
    "glossary-selection-host-session",
    `${hostId}\u0000${sessionId}`,
  );
  const allowed = await store.consumeRateLimit({
    scope: "glossary-selection-host-session",
    keyHash,
    limit: 30,
    windowSeconds: 60,
  });
  if (!allowed) {
    throw new LiveAdmissionError(
      "용어집 변경 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      "GLOSSARY_SELECTION_RATE_LIMITED",
      429,
    );
  }
}

export async function enforceCoverUploadRateLimit(
  hostId: string,
  sessionId: string,
  store: RateLimitStore,
): Promise<void> {
  const keyHash = await opaqueIdentifier(
    LIVE_ADMISSION_PEPPER,
    "cover-upload-host-session",
    `${hostId}\u0000${sessionId}`,
  );
  const allowed = await store.consumeRateLimit({
    scope: "cover-upload-host-session",
    keyHash,
    limit: 12,
    windowSeconds: 60 * 60,
  });
  if (!allowed) {
    throw new LiveAdmissionError(
      "커버 업로드 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      "COVER_UPLOAD_RATE_LIMITED",
      429,
    );
  }
}

export async function enforceSummaryGenerationRateLimit(
  hostId: string,
  sessionId: string,
  store: RateLimitStore,
): Promise<void> {
  const keyHash = await opaqueIdentifier(
    LIVE_ADMISSION_PEPPER,
    "summary-host-session",
    `${hostId}\u0000${sessionId}`,
  );
  const allowed = await store.consumeRateLimit({
    scope: "summary-host-session",
    keyHash,
    limit: 10,
    windowSeconds: 60 * 60,
  });
  if (!allowed) {
    throw new LiveAdmissionError(
      "요약 생성 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      "SUMMARY_RATE_LIMITED",
      429,
    );
  }
}

export async function enforceAuthoritativeTranscriptReadRateLimit(
  hostId: string,
  sessionId: string,
  store: RateLimitStore,
): Promise<void> {
  const keyHash = await opaqueIdentifier(
    LIVE_ADMISSION_PEPPER,
    "authoritative-transcript-read-host-session",
    `${hostId}\u0000${sessionId}`,
  );
  const allowed = await store.consumeRateLimit({
    scope: "authoritative-transcript-read-host-session",
    keyHash,
    limit: 120,
    windowSeconds: 60,
  });
  if (!allowed) {
    throw new LiveAdmissionError(
      "원문 기록 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      "AUTHORITATIVE_TRANSCRIPT_RATE_LIMITED",
      429,
    );
  }
}

export async function enforceLiveConsentRateLimit(
  userId: string,
  sessionId: string,
  store: RateLimitStore,
): Promise<void> {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (!uuidPattern.test(userId) || !uuidPattern.test(sessionId)) {
    throw new LiveAdmissionError(
      "동의 변경 요청을 확인할 수 없습니다.",
      "INVALID_RATE_LIMIT_KEY",
      503,
    );
  }
  const keyHash = await opaqueIdentifier(
    LIVE_ADMISSION_PEPPER,
    "live-consent-participant-session",
    `${userId}\u0000${sessionId}`,
  );
  const allowed = await store.consumeRateLimit({
    scope: "live-consent-participant-session",
    keyHash,
    limit: 20,
    windowSeconds: 60 * 60,
  });
  if (!allowed) {
    throw new LiveAdmissionError(
      "동의 변경 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      "CONSENT_RATE_LIMITED",
      429,
    );
  }
}

export async function enforceParticipantRecordReadRateLimit(
  userId: string,
  sessionId: string,
  store: RateLimitStore,
): Promise<void> {
  const keyHash = await opaqueIdentifier(LIVE_ADMISSION_PEPPER, "participant-record-read", `${userId}\u0000${sessionId}`);
  const allowed = await store.consumeRateLimit({
    scope: "participant-record-read", keyHash, limit: 120, windowSeconds: 60,
  });
  if (!allowed) {
    throw new LiveAdmissionError("회의 기록 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", "RECAP_RATE_LIMITED", 429);
  }
}

export async function enforceGlossaryCandidateExtractionRateLimit(
  hostId: string,
  store: RateLimitStore,
): Promise<void> {
  const keyHash = await opaqueIdentifier(
    LIVE_ADMISSION_PEPPER,
    "glossary-pdf-extraction-host",
    hostId,
  );
  const allowed = await store.consumeRateLimit({
    scope: "glossary-pdf-extraction-host",
    keyHash,
    limit: 10,
    windowSeconds: 60 * 60,
  });
  if (!allowed) {
    throw new LiveAdmissionError(
      "PDF 용어 추출 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      "GLOSSARY_EXTRACTION_RATE_LIMITED",
      429,
    );
  }
}
