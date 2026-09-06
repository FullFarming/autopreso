import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { parseSessionId } from "@/lib/live/validation";
import { getLiveRecordsStore } from "@/lib/live-records/runtime";
import { LiveRecordsError, LiveRecordsService } from "@/lib/live-records/service";
import { SupabaseLiveRecapStore } from "@/lib/live-recap/store";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { enforceAuthoritativeTranscriptReadRateLimit } from "@/lib/security/live-rate-limit";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { hostId } = await requireHost(request);
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const admissionStore = new SupabaseLiveAdmissionStore();
    await enforceAuthoritativeTranscriptReadRateLimit(hostId, sessionId, admissionStore);
    const service = new LiveRecordsService(getLiveRecordsStore());
    const transcript = await service.getAuthoritativeTranscript(hostId, sessionId, {
      afterSourceSeq: request.nextUrl.searchParams.get("afterSourceSeq"),
      pageSize: request.nextUrl.searchParams.get("pageSize"),
    });
    const { recordingGaps } = await new SupabaseLiveRecapStore().readHostRecordingGaps(sessionId, hostId);
    return apiSuccess({ transcript: { ...transcript, recordingGaps } }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      return apiError(error.message, "HOST_AUTH_REQUIRED", 401, privateNoStoreHeaders());
    }
    if (error instanceof LiveRecordsError) {
      return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    }
    if (error instanceof LiveAdmissionError) {
      return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    }
    const failure = toLiveFailure(error);
    if (failure.body.code !== "LIVE_FAILED") {
      return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
    }
    return apiError(
      "원문 기록을 읽을 수 없습니다.",
      "AUTHORITATIVE_TRANSCRIPT_READ_FAILED",
      500,
      privateNoStoreHeaders(),
    );
  }
}
