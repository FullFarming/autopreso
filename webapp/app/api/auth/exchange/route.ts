import { NextRequest } from "next/server";
import { z } from "zod";

import { SESSION_COOKIE, SESSION_TTL_SECONDS, createSessionToken } from "@/lib/session";
import { readBootstrapAdminConfig } from "@/lib/auth/bootstrap-admins";
import { DESKTOP_STATE_PATTERN, exchangeSupabaseLogin } from "@/lib/auth/exchange";
import { ProfileStoreError, SupabaseProfileStore } from "@/lib/auth/profile-store";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { assertStrictOrigin } from "@/lib/security/csrf";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { HostLoginRateLimitError, enforceHostLoginRateLimit } from "@/lib/security/live-rate-limit";
import { loginRateLimiter } from "@/lib/security/login-rate-limit";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store" };
const bodySchema = z.object({
  accessToken: z.string().min(20).max(4096),
  client: z.enum(["web", "desktop"]).optional(),
  state: z.string().regex(DESKTOP_STATE_PATTERN).optional(),
}).strict();

export async function POST(request: NextRequest) {
  try { assertStrictOrigin(request); }
  catch { return apiError("허용되지 않은 요청 출처입니다.", "CSRF_REJECTED", 403, NO_STORE); }
  const currentLimit = loginRateLimiter.check(request.headers);
  if (!currentLimit.isAllowed) return apiError("로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.", "LOGIN_RATE_LIMITED", 429, { ...NO_STORE, "retry-after": String(currentLimit.retryAfterSeconds) });
  if (process.env.NODE_ENV === "production") {
    try { const admissionStore = new SupabaseLiveAdmissionStore(); await enforceHostLoginRateLimit(request, admissionStore); }
    catch (error: unknown) {
      if (error instanceof LiveAdmissionError && error.code === "LOGIN_RATE_LIMITED") return apiError(error.message, error.code, error.status, { ...NO_STORE, "retry-after": String(error instanceof HostLoginRateLimitError ? error.retryAfterSeconds : 900) });
      return apiError("로그인 보안 서비스를 사용할 수 없습니다.", "LOGIN_SECURITY_UNAVAILABLE", 503, NO_STORE);
    }
  }
  let body: unknown;
  try { body = await readBoundedJsonBody(request); }
  catch (error: unknown) { return apiError("로그인 정보가 올바르지 않습니다.", "INVALID_LOGIN_REQUEST", error instanceof BoundedJsonBodyError ? error.status : 400, NO_STORE); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success || (parsed.data.client === "desktop" && !parsed.data.state)) return apiError("로그인 정보가 올바르지 않습니다.", "INVALID_LOGIN_REQUEST", 400, NO_STORE);
  let bootstrap;
  try { bootstrap = readBootstrapAdminConfig(); }
  catch { return apiError("관리자 초기 설정이 올바르지 않습니다.", "BOOTSTRAP_CONFIG_INVALID", 503, NO_STORE); }

  let outcome;
  try {
    outcome = await exchangeSupabaseLogin({ accessToken: parsed.data.accessToken, client: parsed.data.client ?? "web", state: parsed.data.state }, { store: new SupabaseProfileStore(), bootstrap });
  } catch (error: unknown) {
    if (error instanceof ProfileStoreError) {
      if (error.code === "AUTH_TOKEN_INVALID") loginRateLimiter.recordFailure(request.headers);
      return apiError(error.message, error.code, error.status, NO_STORE);
    }
    return apiError("로그인 정보가 올바르지 않습니다.", "INVALID_LOGIN_REQUEST", 400, NO_STORE);
  }
  if (outcome.kind === "forbidden") return apiError("이 계정은 현재 로그인할 수 없습니다.", outcome.code, 403, NO_STORE);
  loginRateLimiter.clear(request.headers);
  if (outcome.kind === "pending") return apiSuccess({ status: "pending", next: outcome.next }, { headers: NO_STORE });
  const response = apiSuccess({ status: "approved", next: outcome.next }, { headers: NO_STORE });
  if (outcome.kind === "approved" && parsed.data.client !== "desktop") {
    const token = await createSessionToken(outcome.profile.hostId);
    response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_TTL_SECONDS });
    response.cookies.set("rnw_name", outcome.profile.displayName ?? outcome.profile.email, { sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_TTL_SECONDS });
  }
  return response;
}
