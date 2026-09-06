import { NextRequest, NextResponse } from "next/server";

import {
  AuthenticationError,
  createRecapGrantToken,
  createViewerGrantToken,
  RECAP_GRANT_COOKIE,
  RECAP_GRANT_TTL_MS,
  verifyViewerGrantToken,
  VIEWER_GRANT_COOKIE,
} from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { isProductionRuntime } from "@/lib/security/config";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

function setViewerCookie(response: NextResponse, sessionId: string, value: string, maxAge?: number): NextResponse {
  response.cookies.set(VIEWER_GRANT_COOKIE, value, {
    httpOnly: true,
    secure: isProductionRuntime(),
    sameSite: "lax",
    path: `/api/live-sessions/${sessionId}`,
    ...(maxAge === undefined ? { expires: new Date(0) } : { maxAge }),
  });
  return response;
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let sessionId: string | null = null;
  try {
    const { id } = await context.params;
    sessionId = parseSessionId(id);
    const token = request.cookies.get(VIEWER_GRANT_COOKIE)?.value;
    const claims = await verifyViewerGrantToken(token);
    if (claims.sessionId !== sessionId) {
      return setViewerCookie(
        apiError("다른 라이브 세션의 입장권은 사용할 수 없습니다.", "VIEWER_FORBIDDEN", 403, privateNoStoreHeaders()),
        sessionId,
        "",
      );
    }

    const store = new SupabaseLiveAdmissionStore();
    const restored = await store.restoreAttendee({
      grantId: claims.grantId,
      sessionId,
      userId: claims.userId,
    });
    const signed = await createViewerGrantToken({
      grantId: restored.grant.id,
      sessionId: restored.grant.sessionId,
      userId: restored.grant.userId,
    });
    const response = setViewerCookie(apiSuccess({
      grant: restored.grant,
      self: restored.self,
      session: restored.session,
      viewerCount: restored.viewerCount,
    }, { headers: privateNoStoreHeaders() }), sessionId, signed.token, 6 * 60 * 60);
    const recap = await createRecapGrantToken({ sessionId, userId: restored.grant.userId });
    response.cookies.set(RECAP_GRANT_COOKIE, recap.token, {
      httpOnly: true, secure: isProductionRuntime(), sameSite: "lax",
      path: `/api/live-sessions/${sessionId}`, maxAge: RECAP_GRANT_TTL_MS / 1_000,
    });
    return response;
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      const response = apiError(error.message, "VIEWER_AUTH_REQUIRED", 401, privateNoStoreHeaders());
      return sessionId ? setViewerCookie(response, sessionId, "") : response;
    }
    if (error instanceof LiveAdmissionError) {
      const response = apiError(error.message, error.code, error.status, privateNoStoreHeaders());
      return sessionId && error.code === "VIEWER_RESTORE_FORBIDDEN"
        ? setViewerCookie(response, sessionId, "")
        : response;
    }
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
  }
}
