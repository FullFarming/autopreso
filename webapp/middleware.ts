import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";
import { apiError } from "@/lib/security/api-response";
import {
  assertStrictOrigin,
  CsrfError,
  isPublicLiveAudioWorkletRequest,
  isPublicUnauthenticatedPath,
  isViewerSnapshotPath,
} from "@/lib/security/csrf";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function frameAncestors(pathname: string): string {
  const extensionOrigin = process.env.CHROME_EXTENSION_ORIGIN?.trim() ?? "";
  const isWatchSurface = pathname === "/watch" || pathname === "/m/watch";
  if (isWatchSurface && /^chrome-extension:\/\/[a-p]{32}$/u.test(extensionOrigin)) {
    return `frame-ancestors 'self' ${extensionOrigin}`;
  }
  return "frame-ancestors 'self'";
}

function secure(response: NextResponse, pathname: string): NextResponse {
  response.headers.set("content-security-policy", frameAncestors(pathname));
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "same-origin");
  return response;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (MUTATING_METHODS.has(request.method)) {
    try {
      assertStrictOrigin(request);
    } catch (error: unknown) {
      if (error instanceof CsrfError) return secure(apiError(error.message, "INVALID_ORIGIN", 403), pathname);
      return secure(apiError("요청 출처를 확인할 수 없습니다.", "INVALID_ORIGIN", 403), pathname);
    }
  }

  if (
    isPublicLiveAudioWorkletRequest(pathname, request.nextUrl.search, request.method)
    || isPublicUnauthenticatedPath(pathname)
    || isViewerSnapshotPath(pathname)
  ) {
    return secure(NextResponse.next(), pathname);
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const authenticated = await verifySessionToken(token);
  if (authenticated) return secure(NextResponse.next(), pathname);

  if (pathname.startsWith("/api/")) {
    return secure(apiError("로그인이 필요합니다.", "AUTH_REQUIRED", 401), pathname);
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return secure(NextResponse.redirect(loginUrl), pathname);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
