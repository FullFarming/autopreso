import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { parseSessionId } from "@/lib/live/validation";
import { getLiveRecordsStore } from "@/lib/live-records/runtime";
import { LiveRecordsError, LiveRecordsService } from "@/lib/live-records/service";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { hostId } = await requireHost(request);
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const service = new LiveRecordsService(getLiveRecordsStore());
    const purgeEligibility = await service.getPurgeEligibility(hostId, sessionId);
    return apiSuccess({ purgeEligibility }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      return apiError(error.message, "HOST_AUTH_REQUIRED", 401, privateNoStoreHeaders());
    }
    if (error instanceof LiveRecordsError) {
      return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    }
    const failure = toLiveFailure(error);
    if (failure.body.code !== "LIVE_FAILED") {
      return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
    }
    return apiError("라이브콜 기록 삭제 가능 여부를 확인할 수 없습니다.", "LIVE_RECORD_PURGE_ELIGIBILITY_FAILED", 500, privateNoStoreHeaders());
  }
}
