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

export function getRequestIp(request: Pick<NextRequest, "headers">): string {
  const raw = request.headers.get("x-vercel-forwarded-for")
    ?? request.headers.get("x-forwarded-for")
    ?? request.headers.get("x-real-ip")
    ?? "";
  const candidate = raw.length <= 512 ? raw.split(",", 1)[0].trim() : "";
  return isIP(candidate) ? candidate : "unknown";
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
    throw new LiveAdmissionError("로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.", "LOGIN_RATE_LIMITED", 429);
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
    limit: 60,
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
