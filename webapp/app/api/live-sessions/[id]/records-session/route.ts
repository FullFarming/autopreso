import { NextRequest } from "next/server";

import { AuthenticationError, AuthorizationError } from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { authorizeParticipantRecordRequest } from "@/lib/security/live-viewer-authorization";
import { enforceParticipantRecordReadRateLimit } from "@/lib/security/live-rate-limit";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const store = new SupabaseLiveAdmissionStore();
    const participant = await authorizeParticipantRecordRequest(request, sessionId, store);
    await enforceParticipantRecordReadRateLimit(participant.userId, sessionId, store);
    const recovery = await store.readParticipantRecordAccess(sessionId, participant.userId);
    return apiSuccess(recovery, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      return apiError("회의 기록 인증이 필요합니다.", "RECAP_AUTH_REQUIRED", 401, privateNoStoreHeaders());
    }
    if (error instanceof AuthorizationError) {
      return apiError("이 회의 기록을 볼 권한이 없습니다.", "RECAP_FORBIDDEN", 403, privateNoStoreHeaders());
    }
    if (error instanceof LiveAdmissionError) {
      return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    }
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
  }
}
