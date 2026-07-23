import { NextRequest } from "next/server";

import { getBearerToken, requireHost, verifyViewerGrantToken, VIEWER_GRANT_COOKIE } from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { getLiveSessionStore } from "@/lib/live/store";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";

/** Session lifecycle status for the host or any participant of the session.
 *  Works after the session ends — the viewer uses this to tell "the host
 *  stopped the meeting" apart from "my grant was revoked". */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    let isAuthorized = false;
    try {
      await requireHost(request);
      isAuthorized = true;
    } catch {
      try {
        const token = getBearerToken(request) ?? request.cookies.get(VIEWER_GRANT_COOKIE)?.value;
        const claims = await verifyViewerGrantToken(token);
        isAuthorized = claims.sessionId === sessionId;
      } catch {
        isAuthorized = false;
      }
    }
    if (!isAuthorized) return apiError("세션 상태를 볼 권한이 없습니다.", "STATUS_FORBIDDEN", 403);
    const session = await getLiveSessionStore().get(sessionId);
    if (!session) return apiError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    return apiSuccess({ id: session.id, status: session.status, endedAt: session.status === "stopped" ? new Date().toISOString() : null });
  } catch (error: unknown) {
    const failure = toLiveFailure(error);
    if (failure.body.code === "SECURITY_NOT_CONFIGURED") {
      return apiError(failure.body.error, failure.body.code, failure.status);
    }
    return apiError("세션 상태를 확인할 수 없습니다.", "STATUS_READ_FAILED", 500);
  }
}
