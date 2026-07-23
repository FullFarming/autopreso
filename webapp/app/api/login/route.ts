import { NextRequest } from "next/server";

import { SESSION_COOKIE, createSessionToken } from "@/lib/session";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { readHostLoginConfig } from "@/lib/security/host-login-config";
import { timingSafeEqual } from "@/lib/security/hmac";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { hostLoginInputSchema } from "@/lib/security/live-input-validation";
import { enforceHostLoginRateLimit } from "@/lib/security/live-rate-limit";
import { loginRateLimiter } from "@/lib/security/login-rate-limit";

const HOST_LOGIN_CONFIG = readHostLoginConfig();

export async function POST(request: NextRequest) {
  const parsed = hostLoginInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("로그인 정보가 올바르지 않습니다.", "INVALID_LOGIN_REQUEST", 400);
  const { id, password, name } = parsed.data;

  const currentLimit = loginRateLimiter.check(request.headers);
  if (!currentLimit.isAllowed) {
    return apiError(
      "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      "LOGIN_RATE_LIMITED",
      429,
      { "retry-after": String(currentLimit.retryAfterSeconds) },
    );
  }

  if (process.env.NODE_ENV === "production") {
    try {
      await enforceHostLoginRateLimit(request, new SupabaseLiveAdmissionStore());
    } catch (error: unknown) {
      if (error instanceof LiveAdmissionError && error.code === "LOGIN_RATE_LIMITED") {
        return apiError(error.message, error.code, error.status);
      }
      return apiError("로그인 보안 서비스를 사용할 수 없습니다.", "LOGIN_SECURITY_UNAVAILABLE", 503);
    }
  }

  const hasValidPassword = timingSafeEqual(
    password.padEnd(256, "\0"),
    HOST_LOGIN_CONFIG.password.padEnd(256, "\0"),
  );
  const hasValidCredentials = HOST_LOGIN_CONFIG.isEnabled
    && HOST_LOGIN_CONFIG.userIds.has(id)
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
  const response = apiSuccess({ userId: id });
  response.cookies.set("rnw_name", name, {
    sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 12,
  });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return response;
}
