import type { NextRequest } from "next/server";

import { getAllowedOrigins } from "./config";

export class CsrfError extends Error {}

const PUBLIC_UNAUTHENTICATED_PATHS = new Set([
  "/",
  "/login",
  "/watch",
  "/m/watch",
  "/m/watch/demo",
  "/api/login",
  // 2026-08-31 fix: 상태 조회는 라우트가 쿠키를 검증하며, 로그아웃은 만료된 쿠키도 지워야 한다. POST 출처 검사는 유지한다.
  "/api/auth/session",
  "/api/logout",
  "/api/pair-login",
  "/api/pair-keys",
  "/api/live-sessions/join",
  // 2026-09-02 auth: Supabase login finishes on these pages/routes before any app cookie exists.
  "/auth/callback",
  "/pending",
  "/api/auth/exchange",
  "/api/auth/desktop-exchange",
]);
const PUBLIC_LIVE_AUDIO_WORKLET_PATH = "/live-audio-worklet.js";
const PUBLIC_METADATA_PATHS = new Set(["/robots.txt", "/llms.txt"]);
const PUBLIC_STATIC_METHODS = new Set(["GET", "HEAD"]);

export function isPublicUnauthenticatedPath(pathname: string): boolean {
  return PUBLIC_UNAUTHENTICATED_PATHS.has(pathname);
}

export function isPublicLiveAudioWorkletRequest(pathname: string, search: string, method: string): boolean {
  return pathname === PUBLIC_LIVE_AUDIO_WORKLET_PATH
    && search === ""
    && PUBLIC_STATIC_METHODS.has(method);
}

export function isPublicMetadataRequest(pathname: string, search: string, method: string): boolean {
  return PUBLIC_METADATA_PATHS.has(pathname)
    && search === ""
    && PUBLIC_STATIC_METHODS.has(method);
}

export function isViewerSnapshotPath(pathname: string, method: string): boolean {
  const match = /^\/api\/live-sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(snapshot|source-snapshot|status|summary|transcript|leave|cover|viewer-session|records-session|recap-request|viewer-gateway-ticket|runtime|consents)$/iu.exec(pathname);
  if (!match) return false;
  const route = match[1];
  if (route === "source-snapshot" || route === "viewer-session" || route === "records-session" || route === "runtime") return method === "GET";
  if (route === "recap-request") return method === "GET" || method === "POST";
  if (route === "viewer-gateway-ticket") return method === "POST";
  if (route === "leave") return method === "POST";
  if (route === "consents") return method === "PUT";
  return PUBLIC_STATIC_METHODS.has(method);
}

export function canonicalRequestOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "chrome-extension:") {
      return null;
    }
    const hasRootPath = parsed.pathname === "/" || (parsed.protocol === "chrome-extension:" && parsed.pathname === "");
    if (!hasRootPath || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.protocol === "chrome-extension:" ? `chrome-extension://${parsed.host}` : parsed.origin;
  } catch {
    return null;
  }
}

export function assertStrictOrigin(request: Pick<NextRequest, "headers">): string {
  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin) throw new CsrfError("요청 출처를 확인할 수 없습니다.");
  const origin = canonicalRequestOrigin(rawOrigin);
  if (!origin || !getAllowedOrigins().has(origin)) {
    throw new CsrfError("허용되지 않은 요청 출처입니다.");
  }
  return origin;
}
