import type { NextRequest } from "next/server";

import { getAllowedOrigins } from "./config";

export class CsrfError extends Error {}

const PUBLIC_UNAUTHENTICATED_PATHS = new Set([
  "/login",
  "/watch",
  "/m/watch",
  "/m/watch/demo",
  "/api/login",
  "/api/pair-login",
  "/api/pair-keys",
  "/api/live-sessions/join",
]);

export function isPublicUnauthenticatedPath(pathname: string): boolean {
  return PUBLIC_UNAUTHENTICATED_PATHS.has(pathname);
}

export function isViewerSnapshotPath(pathname: string): boolean {
  // Viewer-token-authenticated GET surfaces: each route verifies the signed
  // viewer grant itself. status/summary/transcript stay readable after the
  // session ends so participants can open the meeting minutes.
  return /^\/api\/live-sessions\/[^/]+\/(?:snapshot|status|summary|transcript)$/u.test(pathname);
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
