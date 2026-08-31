import { NextRequest } from "next/server";
import { AuthenticationError, requireHost, verifyViewerGrantToken, VIEWER_GRANT_COOKIE } from "@/lib/auth/live-auth";
import { parseSessionId } from "@/lib/live/validation";
import { publicMediaRuntime, readMediaRuntime } from "@/lib/live/media-runtime";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { isHostOwnershipMiss } from "@/lib/security/live-viewer-authorization";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const sessionId = parseSessionId((await context.params).id);
    const store = new SupabaseLiveAdmissionStore();
    try {
      const { hostId } = await requireHost(request);
      await store.assertHostSessionOwnership(sessionId, hostId);
    } catch (error) {
      if (!isHostOwnershipMiss(error)) throw error;
      const claims = await verifyViewerGrantToken(request.cookies.get(VIEWER_GRANT_COOKIE)?.value);
      if (claims.sessionId !== sessionId) return apiError("접근할 수 없는 회의입니다.", "MEDIA_FORBIDDEN", 403, privateNoStoreHeaders());
      await store.restoreAttendee({ grantId: claims.grantId, sessionId, userId: claims.userId });
    }
    return apiSuccess(publicMediaRuntime(await readMediaRuntime(sessionId)), { headers: privateNoStoreHeaders() });
  } catch (error) {
    if (error instanceof AuthenticationError) return apiError("회의 참여 인증이 필요합니다.", "MEDIA_AUTH_REQUIRED", 401, privateNoStoreHeaders());
    if (error instanceof LiveAdmissionError) return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    return apiError("실시간 연결 상태를 확인할 수 없습니다.", "MEDIA_RUNTIME_UNAVAILABLE", 503, privateNoStoreHeaders());
  }
}
