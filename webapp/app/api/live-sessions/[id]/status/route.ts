import { NextRequest } from "next/server";

import {
  AuthenticationError,
  requireHost,
} from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { authorizeParticipantRecordRequest, isHostOwnershipMiss, AuthorizationError } from "@/lib/security/live-viewer-authorization";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

/** Session lifecycle status for the host or any participant of the session.
 *  Works after the session ends — the viewer uses this to tell "the host
 *  stopped the meeting" apart from "my grant was revoked". */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const store = new SupabaseLiveAdmissionStore();
    let participant: { userId: string; access: "viewer" | "recap" } | null = null;
    try {
      const { hostId } = await requireHost(request);
      await store.assertHostSessionOwnership(sessionId, hostId);
    } catch (error: unknown) {
      // Also falls through when a valid host cookie simply is not THIS
      // session's owner, not only when there is no host session at all.
      if (!isHostOwnershipMiss(error)) throw error;
      participant = await authorizeParticipantRecordRequest(request, sessionId, store);
    }
    const session = await store.readSessionLifecycle(sessionId);
    if (!session) return apiError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404, privateNoStoreHeaders());
    const response = apiSuccess({
      id: session.id,
      title: session.title,
      scheduledAt: session.scheduledAt,
      status: session.status,
      endedAt: session.status === "stopped" || session.status === "failed" ? session.endedAt : null,
      recordsExpiresAt: participant && session.endedAt
        && (session.status === "stopped" || session.status === "failed")
        ? new Date(Date.parse(session.endedAt) + 6 * 60 * 60 * 1_000).toISOString()
        : null,
    }, { headers: privateNoStoreHeaders() });
    return response;
  } catch (error: unknown) {
    if (error instanceof AuthenticationError || error instanceof AuthorizationError) {
      return apiError("세션 상태를 볼 권한이 없습니다.", "STATUS_FORBIDDEN", 403, privateNoStoreHeaders());
    }
    if (error instanceof LiveAdmissionError) return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    const failure = toLiveFailure(error);
    if (failure.body.code === "SECURITY_NOT_CONFIGURED") {
      return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
    }
    return apiError("세션 상태를 확인할 수 없습니다.", "STATUS_READ_FAILED", 500, privateNoStoreHeaders());
  }
}
