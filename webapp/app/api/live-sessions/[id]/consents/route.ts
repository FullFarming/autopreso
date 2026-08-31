import { after, NextRequest } from "next/server";

import { AuthenticationError } from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { parseSessionId } from "@/lib/live/validation";
import { getLiveRecordsStore } from "@/lib/live-records/runtime";
import { LiveRecordsError, LiveRecordsService } from "@/lib/live-records/service";
import { scheduleLiveSheetSyncAfterCommit } from "@/lib/live-sheet-sync/runtime";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { CsrfError, assertStrictOrigin } from "@/lib/security/csrf";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { enforceLiveConsentRateLimit } from "@/lib/security/live-rate-limit";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";
import { AuthorizationError, authorizeParticipantRecordRequest } from "@/lib/security/live-viewer-authorization";

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    assertStrictOrigin(request);
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const admissionStore = new SupabaseLiveAdmissionStore();
    const participant = await authorizeParticipantRecordRequest(request, sessionId, admissionStore);
    await enforceLiveConsentRateLimit(participant.userId, sessionId, admissionStore);
    const body = await readBoundedJsonBody(request);
    const service = new LiveRecordsService(getLiveRecordsStore());
    const consents = await service.updateParticipantConsents(sessionId, participant.userId, body);
    scheduleLiveSheetSyncAfterCommit(after);
    return apiSuccess({ consents }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    if (error instanceof CsrfError) {
      return apiError(error.message, "CSRF_ORIGIN_FORBIDDEN", 403, privateNoStoreHeaders());
    }
    if (error instanceof AuthenticationError) {
      return apiError("참여자 인증이 필요합니다.", "PARTICIPANT_AUTH_REQUIRED", 401, privateNoStoreHeaders());
    }
    if (error instanceof AuthorizationError) {
      return apiError("이 세션의 동의를 변경할 권한이 없습니다.", "CONSENT_FORBIDDEN", 403, privateNoStoreHeaders());
    }
    if (error instanceof BoundedJsonBodyError) {
      return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    }
    if (error instanceof LiveAdmissionError) {
      return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    }
    if (error instanceof LiveRecordsError) {
      return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    }
    const failure = toLiveFailure(error);
    if (failure.body.code !== "LIVE_FAILED") {
      return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
    }
    return apiError("동의 정보를 저장할 수 없습니다.", "CONSENT_UPDATE_FAILED", 500, privateNoStoreHeaders());
  }
}
