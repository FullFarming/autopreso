import { NextRequest } from "next/server";

import { SESSION_COOKIE, SESSION_TTL_SECONDS, createSessionToken } from "@/lib/session";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { readHostLoginConfig } from "@/lib/security/host-login-config";
import { verifyHostPassword } from "@/lib/security/host-password";
import { timingSafeEqual } from "@/lib/security/hmac";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { hostLoginInputSchema } from "@/lib/security/live-input-validation";
import { HostLoginRateLimitError, enforceHostLoginCredentialRateLimits, enforceHostLoginRateLimit } from "@/lib/security/live-rate-limit";
import { loginRateLimiter } from "@/lib/security/login-rate-limit";

export async function POST(request: NextRequest) {
  const currentLimit = loginRateLimiter.check(request.headers);
  if (!currentLimit.isAllowed) {
    return apiError(
      "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      "LOGIN_RATE_LIMITED",
      429,
      { "retry-after": String(currentLimit.retryAfterSeconds) },
    );
  }

  let admissionStore: SupabaseLiveAdmissionStore | null = null;
  if (process.env.NODE_ENV === "production") {
    try {
      admissionStore = new SupabaseLiveAdmissionStore();
      await enforceHostLoginRateLimit(request, admissionStore);
    } catch (error: unknown) {
      if (error instanceof LiveAdmissionError && error.code === "LOGIN_RATE_LIMITED") {
        return apiError(error.message, error.code, error.status, { "retry-after": String(error instanceof HostLoginRateLimitError ? error.retryAfterSeconds : 900) });
      }
      return apiError("로그인 보안 서비스를 사용할 수 없습니다.", "LOGIN_SECURITY_UNAVAILABLE", 503);
    }
  }

  // Read the env-backed config per request: a module-scope constant would
  // freeze a stale value for the lambda's lifetime, and a misconfigured env
  // would throw at import time and surface as an opaque 500 on every route.
  let hostLoginConfig;
  try {
    hostLoginConfig = readHostLoginConfig();
  } catch {
    return apiError("호스트 로그인 환경변수 설정이 올바르지 않습니다.", "HOST_LOGIN_CONFIG_INVALID", 503);
  }

  let body: unknown;
  try {
    body = await readBoundedJsonBody(request);
  } catch (error: unknown) {
    if (error instanceof BoundedJsonBodyError) {
      const isTooLarge = error.status === 413;
      return apiError(
        isTooLarge ? "로그인 요청 본문이 너무 큽니다." : "로그인 정보가 올바르지 않습니다.",
        isTooLarge ? "LOGIN_REQUEST_TOO_LARGE" : "INVALID_LOGIN_REQUEST",
        error.status,
      );
    }
    return apiError("로그인 정보가 올바르지 않습니다.", "INVALID_LOGIN_REQUEST", 400);
  }
  const parsed = hostLoginInputSchema.safeParse(body);
  if (!parsed.success) return apiError("로그인 정보가 올바르지 않습니다.", "INVALID_LOGIN_REQUEST", 400);
  const { id, password, name } = parsed.data;

  if (admissionStore) {
    try {
      await enforceHostLoginCredentialRateLimits(id, admissionStore);
    } catch (error: unknown) {
      if (error instanceof LiveAdmissionError && error.code === "LOGIN_RATE_LIMITED") {
        return apiError(error.message, error.code, error.status, { "retry-after": String(error instanceof HostLoginRateLimitError ? error.retryAfterSeconds : 900) });
      }
      return apiError("로그인 보안 서비스를 사용할 수 없습니다.", "LOGIN_SECURITY_UNAVAILABLE", 503);
    }
  }

  let hasValidPassword: boolean;
  try {
    hasValidPassword = hostLoginConfig.passwordHash !== undefined
      ? await verifyHostPassword(password, hostLoginConfig.passwordHash)
      : password.length === hostLoginConfig.password.length && timingSafeEqual(
        password.padEnd(256, "\0"),
        hostLoginConfig.password.padEnd(256, "\0"),
      );
  } catch {
    return apiError("로그인 보안 서비스를 사용할 수 없습니다.", "LOGIN_SECURITY_UNAVAILABLE", 503);
  }
  const hasValidCredentials = hostLoginConfig.isEnabled
    && hostLoginConfig.userIds.has(id)
    && hasValidPassword;
  if (!hasValidCredentials) {
    const nextLimit = loginRateLimiter.recordFailure(request.headers);
    if (!nextLimit.isAllowed) {
      return apiError(
        "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        "LOGIN_RATE_LIMITED",
        429,
        { "retry-after": String(nextLimit.retryAfterSeconds) },
      );
    }
    return apiError("아이디 또는 비밀번호가 올바르지 않습니다.", "INVALID_CREDENTIALS", 401);
  }

  loginRateLimiter.clear(request.headers);
  const token = await createSessionToken(id);
  const response = apiSuccess({ userId: id }, { headers: { "cache-control": "private, no-store" } });
  response.cookies.set("rnw_name", name, {
    sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_TTL_SECONDS,
  });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return response;
}
