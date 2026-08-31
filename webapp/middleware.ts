import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";
import { apiError } from "@/lib/security/api-response";
import {
  assertStrictOrigin,
  CsrfError,
  isPublicLiveAudioWorkletRequest,
  isPublicMetadataRequest,
  isPublicUnauthenticatedPath,
  isViewerSnapshotPath,
} from "@/lib/security/csrf";
import { securityHeadersForRequest } from "@/lib/security/security-headers";
import { isDevelopmentRecordDemoRequest } from "@/lib/security/development-record-demo";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function createNonce(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function secure(response: NextResponse, pathname: string, nonce: string): NextResponse {
  const headers = securityHeadersForRequest({ nonce, pathname });
  for (const [name, value] of headers) response.headers.set(name, value);
  return response;
}

function nextWithSecurity(request: NextRequest, pathname: string, nonce: string): NextResponse {
  const requestHeaders = new Headers(request.headers);
  const contentSecurityPolicy = securityHeadersForRequest({ nonce, pathname }).get("content-security-policy");
  requestHeaders.set("x-nonce", nonce);
  if (contentSecurityPolicy) requestHeaders.set("content-security-policy", contentSecurityPolicy);
  return secure(NextResponse.next({ request: { headers: requestHeaders } }), pathname, nonce);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const nonce = createNonce();
  if (MUTATING_METHODS.has(request.method)) {
    try {
      assertStrictOrigin(request);
    } catch (error: unknown) {
      if (error instanceof CsrfError) return secure(apiError(error.message, "INVALID_ORIGIN", 403), pathname, nonce);
      return secure(apiError("요청 출처를 확인할 수 없습니다.", "INVALID_ORIGIN", 403), pathname, nonce);
    }
  }

  if (
    isPublicLiveAudioWorkletRequest(pathname, request.nextUrl.search, request.method)
    || isPublicMetadataRequest(pathname, request.nextUrl.search, request.method)
    || isPublicUnauthenticatedPath(pathname)
    || isViewerSnapshotPath(pathname, request.method)
    || isDevelopmentRecordDemoRequest(pathname, request.method, process.env.NODE_ENV)
  ) {
    return nextWithSecurity(request, pathname, nonce);
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const authenticated = await verifySessionToken(token);
  if (authenticated) return nextWithSecurity(request, pathname, nonce);

  if (pathname.startsWith("/api/")) {
    return secure(apiError("로그인이 필요합니다.", "AUTH_REQUIRED", 401), pathname, nonce);
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return secure(NextResponse.redirect(loginUrl), pathname, nonce);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/[A-Za-z0-9][A-Za-z0-9._-]*\\.woff2?$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
