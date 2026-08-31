import type { NextRequest } from "next/server";

import { SESSION_COOKIE, readSessionToken, refreshSessionToken } from "@/lib/session";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { assertStrictOrigin } from "@/lib/security/csrf";
import { readHostLoginConfig } from "@/lib/security/host-login-config";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store", vary: "Cookie" };

async function respondWithSession(request: NextRequest, shouldRefresh: boolean) {
  let config;
  try { config = readHostLoginConfig(); }
  catch { return apiError("로그인 보안 서비스를 사용할 수 없습니다.", "SESSION_SECURITY_UNAVAILABLE", 503, NO_STORE); }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await readSessionToken(token);
  if (!session || !config.isEnabled || !config.userIds.has(session.userId)) {
    return apiError("호스트 로그인이 필요합니다.", "AUTH_REQUIRED", 401, NO_STORE);
  }
  const renewed = shouldRefresh ? await refreshSessionToken(token) : null;
  const current = renewed?.session ?? session;
  if (current.expiresAt <= Date.now()) return apiError("호스트 로그인이 필요합니다.", "AUTH_REQUIRED", 401, NO_STORE);
  const response = apiSuccess({ userId: current.userId, expiresAt: new Date(current.expiresAt).toISOString() }, { headers: NO_STORE });
  if (renewed) {
    response.cookies.set(SESSION_COOKIE, renewed.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: Math.max(0, Math.floor((current.expiresAt - Date.now()) / 1_000)),
    });
  }
  return response;
}

export async function GET(request: NextRequest) {
  return respondWithSession(request, false);
}

export async function POST(request: NextRequest) {
  try { assertStrictOrigin(request); }
  catch { return apiError("허용되지 않은 요청 출처입니다.", "CSRF_REJECTED", 403, NO_STORE); }
  return respondWithSession(request, true);
}
