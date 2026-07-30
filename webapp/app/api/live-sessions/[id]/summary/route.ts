import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { buildParticipantActivity } from "@/lib/live/activity";
import { toLiveFailure } from "@/lib/live/errors";
import {
  claimMeetingSummaryGeneration,
  completeMeetingSummaryGeneration,
  failMeetingSummaryGeneration,
  fetchUtterances,
  generateMeetingSummary,
  readMeetingSummary,
  readMeetingSummaryGenerationStatus,
  SummaryError,
} from "@/lib/live/summary";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { liveLanguageInputSchema } from "@/lib/security/live-input-validation";
import { enforceSummaryGenerationRateLimit } from "@/lib/security/live-rate-limit";
import { authorizeParticipantRecordRequest, isHostOwnershipMiss, AuthorizationError } from "@/lib/security/live-viewer-authorization";

function parseLanguage(value: string | null): string | null {
  const parsed = liveLanguageInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Host-only: claim the one allowed meeting-summary generation for a language. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { hostId } = await requireHost(request);
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const store = new SupabaseLiveAdmissionStore();
    await store.assertHostSessionOwnership(sessionId, hostId);
    await enforceSummaryGenerationRateLimit(hostId, sessionId, store);
    const body: unknown = await request.json().catch(() => null);
    const language = parseLanguage(
      body && typeof body === "object" && !Array.isArray(body) && typeof (body as { language?: unknown }).language === "string"
        ? (body as { language: string }).language
        : null,
    );
    if (!language) return apiError("요약할 언어를 선택하세요.", "LANGUAGE_REQUIRED", 400);
    const claim = await claimMeetingSummaryGeneration(sessionId, language);
    if (claim.status === "ready") {
      const record = await readMeetingSummary(sessionId, language);
      if (!record) throw new SummaryError("완료된 요약을 읽을 수 없습니다.", "SUMMARY_READY_MISSING", 502);
      return apiSuccess({
        summary: record.summary,
        model: record.model,
        utteranceCount: 0,
        generationStatus: "ready" as const,
      });
    }
    if (claim.status === "running") {
      return apiError("요약을 생성하고 있습니다.", "SUMMARY_GENERATION_RUNNING", 409);
    }
    if (claim.status === "exhausted") {
      return apiError("요약 생성 재시도 횟수를 모두 사용했습니다.", "SUMMARY_GENERATION_EXHAUSTED", 409);
    }
    if (claim.status === "permanent_failed") {
      return apiError("요약을 생성할 수 없습니다.", "SUMMARY_GENERATION_PERMANENT_FAILED", 409);
    }
    if (claim.status !== "claimed") throw new SummaryError("요약 생성 상태가 올바르지 않습니다.", "SUMMARY_STATE_FAILED", 502);
    try {
      const [utterances, activity] = await Promise.all([
        fetchUtterances(sessionId, language),
        buildParticipantActivity(sessionId, hostId, language),
      ]);
      if (utterances.length === 0) {
        await failMeetingSummaryGeneration(sessionId, language, claim.generationToken, "NO_UTTERANCES");
        return apiError("요약할 발언 기록이 없습니다.", "NO_UTTERANCES", 404);
      }
      const participantById = new Map(activity.participants.map((participant) => [participant.participantId, participant]));
      const attributedUtterances = utterances.map((utterance) => {
        const participant = utterance.participantId ? participantById.get(utterance.participantId) : undefined;
        return participant
          ? {
              ...utterance,
              speakerName: participant.displayName,
              speakerDepartment: participant.department,
              speakerJobTitle: participant.jobTitle,
            }
          : utterance;
      });
      const { summary, model } = await generateMeetingSummary(attributedUtterances, language);
      const completed = await completeMeetingSummaryGeneration(
        sessionId, language, claim.generationToken, summary, model,
      );
      if (!completed) throw new SummaryError("요약 완료 상태를 저장할 수 없습니다.", "SUMMARY_COMPLETE_FAILED", 502);
      return apiSuccess({ summary, model, utteranceCount: utterances.length, generationStatus: "saved" as const });
    } catch (error: unknown) {
      const errorCode = error instanceof SummaryError ? error.code : "SUMMARY_FAILED";
      await failMeetingSummaryGeneration(sessionId, language, claim.generationToken, errorCode).catch(() => false);
      throw error;
    }
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    if (error instanceof LiveAdmissionError) return apiError(error.message, error.code, error.status);
    if (error instanceof SummaryError) return apiError(error.message, error.code, error.status);
    const failure = toLiveFailure(error);
    if (failure.body.code === "SECURITY_NOT_CONFIGURED") {
      return apiError(failure.body.error, failure.body.code, failure.status);
    }
    return apiError("요약을 생성할 수 없습니다.", "SUMMARY_FAILED", 500);
  }
}

/** Host or session participant: read the stored summary for one language. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const language = parseLanguage(request.nextUrl.searchParams.get("language"));
    if (!language) return apiError("언어를 선택하세요.", "LANGUAGE_REQUIRED", 400);
    const store = new SupabaseLiveAdmissionStore();
    try {
      const { hostId } = await requireHost(request);
      await store.assertHostSessionOwnership(sessionId, hostId);
    } catch (error: unknown) {
      // Also falls through when a valid host cookie simply is not THIS
      // session's owner, not only when there is no host session at all.
      if (!isHostOwnershipMiss(error)) throw error;
      await authorizeParticipantRecordRequest(request, sessionId, store);
    }
    const record = await readMeetingSummary(sessionId, language);
    if (!record) {
      const generation = await readMeetingSummaryGenerationStatus(sessionId, language);
      if (generation.status === "running") {
        return apiError("요약을 생성하고 있습니다.", "SUMMARY_GENERATION_RUNNING", 409);
      }
      if (generation.status === "retryable_failed") {
        return apiError("요약 생성 중 일시적인 오류가 발생했습니다.", "SUMMARY_GENERATION_RETRYABLE_FAILED", 409);
      }
      if (generation.status === "exhausted") {
        return apiError("요약 생성 재시도 횟수를 모두 사용했습니다.", "SUMMARY_GENERATION_EXHAUSTED", 409);
      }
      if (generation.status === "permanent_failed") {
        return apiError("요약을 생성할 수 없습니다.", "SUMMARY_GENERATION_PERMANENT_FAILED", 409);
      }
      if (generation.status === "ready") {
        const completedRecord = await readMeetingSummary(sessionId, language);
        if (!completedRecord) throw new SummaryError("완료된 요약을 읽을 수 없습니다.", "SUMMARY_READY_MISSING", 502);
        return apiSuccess(completedRecord);
      }
      return apiError("아직 요약이 준비되지 않았습니다.", "SUMMARY_NOT_READY", 404);
    }
    return apiSuccess(record);
  } catch (error: unknown) {
    if (error instanceof AuthenticationError || error instanceof AuthorizationError) {
      return apiError("요약을 볼 권한이 없습니다.", "SUMMARY_FORBIDDEN", 403);
    }
    if (error instanceof LiveAdmissionError) return apiError(error.message, error.code, error.status);
    if (error instanceof SummaryError) return apiError(error.message, error.code, error.status);
    const failure = toLiveFailure(error);
    if (failure.body.code === "SECURITY_NOT_CONFIGURED") {
      return apiError(failure.body.error, failure.body.code, failure.status);
    }
    return apiError("요약을 읽을 수 없습니다.", "SUMMARY_READ_FAILED", 500);
  }
}
