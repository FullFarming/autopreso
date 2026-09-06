import { NextRequest } from "next/server";
import { z } from "zod";

import { SESSION_COOKIE, SESSION_TTL_SECONDS, createSessionToken } from "@/lib/session";
import { DESKTOP_STATE_PATTERN } from "@/lib/auth/exchange";
import { ProfileStoreError, SupabaseProfileStore } from "@/lib/auth/profile-store";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { assertStrictOrigin } from "@/lib/security/csrf";
import { loginRateLimiter } from "@/lib/security/login-rate-limit";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store" };
const bodySchema = z.object({ code: z.string().regex(/^[0-9a-f]{64}$/u), state: z.string().regex(DESKTOP_STATE_PATTERN) }).strict();

export async function POST(request: NextRequest) {
  try { assertStrictOrigin(request); }
  catch { return apiError("허용되지 않은 요청 출처입니다.", "CSRF_REJECTED", 403, NO_STORE); }
  const limit = loginRateLimiter.check(request.headers);
  if (!limit.isAllowed) return apiError("로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.", "LOGIN_RATE_LIMITED", 429, { ...NO_STORE, "retry-after": String(limit.retryAfterSeconds) });
  let body: unknown;
  try { body = await readBoundedJsonBody(request); }
  catch (error: unknown) { return apiError("로그인 정보가 올바르지 않습니다.", "INVALID_LOGIN_REQUEST", error instanceof BoundedJsonBodyError ? error.status : 400, NO_STORE); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) { loginRateLimiter.recordFailure(request.headers); return apiError("데스크톱 로그인 코드가 올바르지 않습니다.", "DESKTOP_CODE_INVALID", 401, NO_STORE); }
  let consumed;
  try { consumed = await new SupabaseProfileStore().consumeDesktopCode({ code: parsed.data.code, state: parsed.data.state }); }
  catch (error: unknown) {
    if (error instanceof ProfileStoreError) return apiError(error.message, error.code, error.status, NO_STORE);
    return apiError("프로필 저장소를 사용할 수 없습니다.", "PROFILE_STORE_UNAVAILABLE", 503, NO_STORE);
  }
  if (!consumed) { loginRateLimiter.recordFailure(request.headers); return apiError("데스크톱 로그인 코드가 올바르지 않습니다.", "DESKTOP_CODE_INVALID", 401, NO_STORE); }
  if (consumed.status !== "approved") return apiError("승인되지 않은 계정입니다.", "PROFILE_NOT_APPROVED", 403, NO_STORE);
  loginRateLimiter.clear(request.headers);
  const token = await createSessionToken(consumed.hostId);
  const response = apiSuccess({ userId: consumed.hostId }, { headers: NO_STORE });
  response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_TTL_SECONDS });
  return response;
}
