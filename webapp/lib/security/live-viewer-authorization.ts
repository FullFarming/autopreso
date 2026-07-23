import type { NextRequest } from "next/server";

import {
  AuthenticationError,
  AuthorizationError,
  getBearerToken,
  verifyViewerGrantToken,
  VIEWER_GRANT_COOKIE,
  type ViewerGrantClaims,
} from "../auth/live-auth";
import { SupabaseLiveAdmissionStore } from "./live-admission-store";

export async function authorizeViewerRequest(
  request: Pick<NextRequest, "headers" | "cookies">,
  expectedSessionId: string,
  expectedLanguage: string,
  store: SupabaseLiveAdmissionStore = new SupabaseLiveAdmissionStore(),
): Promise<ViewerGrantClaims> {
  const token = getBearerToken(request) ?? request.cookies.get(VIEWER_GRANT_COOKIE)?.value;
  const claims = await verifyViewerGrantToken(token);
  if (claims.sessionId !== expectedSessionId) {
    throw new AuthorizationError("다른 라이브 세션의 입장권은 사용할 수 없습니다.");
  }
  await store.assertViewerTopicActive(claims.sessionId, claims.grantId, claims.userId, expectedLanguage);
  return claims;
}

export { AuthenticationError, AuthorizationError };
