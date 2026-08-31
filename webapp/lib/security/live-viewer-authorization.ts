import type { NextRequest } from "next/server";

import {
  AuthenticationError,
  AuthorizationError,
  RECAP_GRANT_COOKIE,
  verifyRecapGrantToken,
  verifyViewerGrantToken,
  VIEWER_GRANT_COOKIE,
  type ViewerGrantClaims,
} from "../auth/live-auth";
import { SupabaseLiveAdmissionStore } from "./live-admission-store";

export async function authorizeViewerRequest(
  request: Pick<NextRequest, "cookies">,
  expectedSessionId: string,
  expectedLanguage: string,
  store: SupabaseLiveAdmissionStore = new SupabaseLiveAdmissionStore(),
): Promise<ViewerGrantClaims> {
  const token = request.cookies.get(VIEWER_GRANT_COOKIE)?.value;
  const claims = await verifyViewerGrantToken(token);
  if (claims.sessionId !== expectedSessionId) {
    throw new AuthorizationError("다른 라이브 세션의 입장권은 사용할 수 없습니다.");
  }
  await store.assertViewerTopicActive(claims.sessionId, claims.grantId, claims.userId, expectedLanguage);
  return claims;
}

export async function authorizeParticipantRecordRequest(
  request: { cookies: Pick<NextRequest["cookies"], "get"> },
  expectedSessionId: string,
  store: SupabaseLiveAdmissionStore = new SupabaseLiveAdmissionStore(),
): Promise<{ userId: string; access: "viewer" | "recap" }> {
  const viewerToken = request.cookies.get(VIEWER_GRANT_COOKIE)?.value;
  if (viewerToken) {
    try {
      const claims = await verifyViewerGrantToken(viewerToken);
      if (claims.sessionId !== expectedSessionId) {
        throw new AuthorizationError("다른 라이브 세션의 입장권은 사용할 수 없습니다.");
      }
      const access = await store.assertParticipantAccess({
        sessionId: expectedSessionId,
        userId: claims.userId,
        grantId: claims.grantId,
      });
      return { userId: claims.userId, access };
    } catch (error: unknown) {
      // 2026-08-31 fix: 저장소 장애와 권한 철회를 로그아웃 오류로 덮어쓰지 않는다.
      if (!(error instanceof AuthenticationError)) throw error;
    }
  }
  const recapToken = request.cookies.get(RECAP_GRANT_COOKIE)?.value;
  const claims = await verifyRecapGrantToken(recapToken);
  if (claims.sessionId !== expectedSessionId) {
    throw new AuthorizationError("다른 라이브 세션의 회의록 권한은 사용할 수 없습니다.");
  }
  await store.assertParticipantAccess({
    sessionId: expectedSessionId,
    userId: claims.userId,
    recapOnly: true,
  });
  return { userId: claims.userId, access: "recap" };
}

/** True when a host-authenticated request is simply not the owner of THIS
 *  session, so the caller should fall through and try participant access.
 *
 *  `requireHost` throws `AuthenticationError` when there is no host session at
 *  all, but `assertHostSessionOwnership` throws
 *  `LiveAdmissionError("LIVE_SESSION_NOT_FOUND", 404)` when the cookie is valid
 *  and simply belongs to a different host. Routes that only caught the former
 *  returned 404 to a participant who happened to have a host cookie in the same
 *  browser — which is the normal case for the operator testing their own
 *  product — breaking /status polling, minutes, and transcript recovery.
 *
 *  Falling through is safe: `authorizeParticipantRecordRequest` independently
 *  verifies a viewer grant, so this grants no access on its own. */
export function isHostOwnershipMiss(error: unknown): boolean {
  if (error instanceof AuthenticationError) return true;
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "LIVE_SESSION_NOT_FOUND";
}

export { AuthenticationError, AuthorizationError };
