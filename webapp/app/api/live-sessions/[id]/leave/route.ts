import { NextRequest } from "next/server";

import {
  AuthenticationError,
  getBearerToken,
  verifyViewerGrantToken,
  VIEWER_GRANT_COOKIE,
} from "@/lib/auth/live-auth";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: rawId } = await context.params;
    const sessionId = parseSessionId(rawId);
    const token = getBearerToken(request) ?? request.cookies.get(VIEWER_GRANT_COOKIE)?.value;
    const claims = await verifyViewerGrantToken(token);
    if (claims.sessionId !== sessionId) {
      return apiError("다른 라이브 세션의 입장권은 사용할 수 없습니다.", "VIEWER_FORBIDDEN", 403);
    }
    await new SupabaseLiveAdmissionStore().leaveViewer(sessionId, claims.grantId, claims.userId);
    const response = apiSuccess({ id: sessionId, status: "left" as const });
    response.cookies.set(VIEWER_GRANT_COOKIE, "", {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: `/api/live-sessions/${sessionId}`,
      expires: new Date(0),
    });
    return response;
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "VIEWER_AUTH_REQUIRED", 401);
    if (error instanceof LiveAdmissionError) return apiError(error.message, error.code, error.status);
    return apiError("라이브에서 나갈 수 없습니다.", "LEAVE_FAILED", 500);
  }
}
