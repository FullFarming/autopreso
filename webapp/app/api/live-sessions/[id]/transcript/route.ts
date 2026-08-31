import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { SummaryError } from "@/lib/live/summary";
import { readCachedLiveTranscript } from "@/lib/live/transcript-read";
import { parseSessionId } from "@/lib/live/validation";
import { LiveRecordsError } from "@/lib/live-records/errors";
import { SupabaseLiveRecapStore } from "@/lib/live-recap/store";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { liveLanguageInputSchema } from "@/lib/security/live-input-validation";
import { enforceParticipantRecordReadRateLimit } from "@/lib/security/live-rate-limit";
import { authorizeParticipantRecordRequest, isHostOwnershipMiss, AuthorizationError } from "@/lib/security/live-viewer-authorization";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

/** Full speaker-attributed utterance record of a session in one language.
 *  Host or any participant; readable after the session ends so the meeting
 *  minutes stay available. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const store = new SupabaseLiveAdmissionStore();
    if (request.nextUrl.searchParams.get("view") === "source") {
      const participant = await authorizeParticipantRecordRequest(request, sessionId, store);
      await enforceParticipantRecordReadRateLimit(participant.userId, sessionId, store);
      const cursor = request.nextUrl.searchParams.get("afterSourceSeq") ?? "0";
      const size = request.nextUrl.searchParams.get("pageSize") ?? "200";
      if (!/^(?:0|[1-9]\d{0,15})$/u.test(cursor) || !/^[1-9]\d{0,2}$/u.test(size)) {
        return apiError("원문 페이지 요청이 올바르지 않습니다.", "INVALID_RECAP_TRANSCRIPT_INPUT", 400, privateNoStoreHeaders());
      }
      const page = await store.readParticipantSourceTranscript(sessionId, participant.userId, {
        afterSourceSeq: Number(cursor), pageSize: Number(size),
      });
      const { recordingGaps } = await new SupabaseLiveRecapStore().readParticipantRecordingGaps(sessionId, participant.userId);
      return apiSuccess({ ...page, recordingGaps }, { headers: privateNoStoreHeaders() });
    }
    const parsedLanguage = liveLanguageInputSchema.safeParse(request.nextUrl.searchParams.get("language"));
    if (!parsedLanguage.success) return apiError("언어를 선택하세요.", "LANGUAGE_REQUIRED", 400, privateNoStoreHeaders());
    try {
      const { hostId } = await requireHost(request);
      await store.assertHostSessionOwnership(sessionId, hostId);
    } catch (error: unknown) {
      // Also falls through when a valid host cookie simply is not THIS
      // session's owner, not only when there is no host session at all.
      if (!isHostOwnershipMiss(error)) throw error;
      await authorizeParticipantRecordRequest(request, sessionId, store);
    }
    return apiSuccess(await readCachedLiveTranscript(sessionId, parsedLanguage.data), {
      headers: privateNoStoreHeaders(),
    });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError || error instanceof AuthorizationError) {
      return apiError("회의록을 볼 권한이 없습니다.", "TRANSCRIPT_FORBIDDEN", 403, privateNoStoreHeaders());
    }
    if (error instanceof LiveAdmissionError || error instanceof LiveRecordsError) return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    if (error instanceof SummaryError) return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    const failure = toLiveFailure(error);
    if (failure.body.code === "SECURITY_NOT_CONFIGURED") {
      return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
    }
    return apiError("회의록을 읽을 수 없습니다.", "TRANSCRIPT_READ_FAILED", 500, privateNoStoreHeaders());
  }
}
