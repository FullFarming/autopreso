import { after, NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { buildParticipantRoster } from "@/lib/live/activity";
import { toLiveFailure } from "@/lib/live/errors";
import {
  claimMeetingSummaryGeneration,
  completeMeetingSummaryGeneration,
  failMeetingSummaryGeneration,
  fetchMeetingSessionContext,
  fetchSummaryUtterances,
  fetchTopicTranscript,
  generateMeetingSummary,
  readMeetingSummary,
  readMeetingSummaryGenerationStatus,
  resetMeetingSummaryGeneration,
  SummaryError,
  withSummaryReadDeadline,
} from "@/lib/live/summary";
import { parseSessionId } from "@/lib/live/validation";
import { scheduleLiveSheetSyncAfterCommit } from "@/lib/live-sheet-sync/runtime";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import {
  LiveAdmissionError,
  SupabaseLiveAdmissionStore,
  type LiveSessionLifecycle,
} from "@/lib/security/live-admission-store";
import { liveLanguageInputSchema } from "@/lib/security/live-input-validation";
import { enforceSummaryGenerationRateLimit } from "@/lib/security/live-rate-limit";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";
import { authorizeParticipantRecordRequest, isHostOwnershipMiss, AuthorizationError } from "@/lib/security/live-viewer-authorization";

function parseLanguage(value: string | null): string | null {
  const parsed = liveLanguageInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function summarySuccess<T>(data: T) {
  return apiSuccess(data, { headers: privateNoStoreHeaders() });
}

function summaryError(error: string, code: string, status: number) {
  return apiError(error, code, status, privateNoStoreHeaders());
}

function publicSummaryRecord(record: { summary: unknown; createdAt: string }) {
  return { summary: record.summary, createdAt: record.createdAt };
}

type SummaryReadState = Awaited<ReturnType<typeof readMeetingSummary>>;
type SummaryStatusState = Awaited<ReturnType<typeof readMeetingSummaryGenerationStatus>> | null;

function isTerminalSummarySession(lifecycle: LiveSessionLifecycle | null): lifecycle is LiveSessionLifecycle {
  return lifecycle !== null && (lifecycle.status === "stopped" || lifecycle.status === "failed");
}

/** Host-only: claim the one allowed meeting-summary generation for a language. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { hostId } = await requireHost(request);
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const store = new SupabaseLiveAdmissionStore();
    await store.assertHostSessionOwnership(sessionId, hostId);
    const lifecycle = await store.readSessionLifecycle(sessionId);
    if (!isTerminalSummarySession(lifecycle)) {
      throw new SummaryError("라이브콜 종료 후 요약을 생성할 수 있습니다.", "SUMMARY_SESSION_NOT_ENDED", 409);
    }
    await enforceSummaryGenerationRateLimit(hostId, sessionId, store);
    const body = await readBoundedJsonBody(request);
    const isRecordBody = Boolean(body) && typeof body === "object" && !Array.isArray(body);
    const language = parseLanguage(
      isRecordBody && typeof (body as { language?: unknown }).language === "string"
        ? (body as { language: string }).language
        : null,
    );
    if (!language) return summaryError("요약할 언어를 선택하세요.", "LANGUAGE_REQUIRED", 400);
    // Host recovery: an exhausted or permanently failed job is unreachable by
    // any claim, so the owning host may clear it once before claiming. The RPC
    // re-verifies ownership itself and reports false when nothing was stuck.
    const shouldReset = isRecordBody && (body as { reset?: unknown }).reset === true;
    if (shouldReset) await resetMeetingSummaryGeneration(sessionId, language, hostId);
    const claim = await claimMeetingSummaryGeneration(sessionId, language);
    if (claim.status === "ready") {
      const record = await withSummaryReadDeadline((signal) => readMeetingSummary(sessionId, language, fetch, { signal }));
      if (!record) throw new SummaryError("완료된 요약을 읽을 수 없습니다.", "SUMMARY_READY_MISSING", 502);
      return summarySuccess({
        summary: record.summary,
        utteranceCount: 0,
        generationStatus: "ready" as const,
      });
    }
    if (claim.status === "running") {
      return summaryError("요약을 생성하고 있습니다.", "SUMMARY_GENERATION_RUNNING", 409);
    }
    if (claim.status === "exhausted") {
      return summaryError("요약 생성 재시도 횟수를 모두 사용했습니다.", "SUMMARY_GENERATION_EXHAUSTED", 409);
    }
    if (claim.status === "permanent_failed") {
      return summaryError("요약을 생성할 수 없습니다.", "SUMMARY_GENERATION_PERMANENT_FAILED", 409);
    }
    if (claim.status !== "claimed") throw new SummaryError("요약 생성 상태가 올바르지 않습니다.", "SUMMARY_STATE_FAILED", 502);
    try {
      const [utterances, participants, topicSnapshot, sessionContext] = await withSummaryReadDeadline((signal) => Promise.all([
        fetchSummaryUtterances(sessionId, language, fetch, { signal }),
        buildParticipantRoster(sessionId, hostId, fetch, undefined, { signal }),
        fetchTopicTranscript(sessionId, language, { signal }),
        fetchMeetingSessionContext(sessionId, { signal }),
      ]));
      if (utterances.length === 0) {
        // Nothing was said: the job records NO_UTTERANCES (DB contract) but the
        // client is told this is an empty record, not a failure to retry.
        await failMeetingSummaryGeneration(sessionId, language, claim.generationToken, "NO_UTTERANCES");
        return summaryError("기록된 발언이 없어 요약을 만들 수 없습니다.", "SUMMARY_NO_UTTERANCES", 404);
      }
      const participantById = new Map(participants.map((participant) => [participant.participantId, participant]));
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
      const { summary, model } = await generateMeetingSummary({ sessionId, utterances: attributedUtterances, topicSnapshot, sessionContext }, language);
      const completed = await completeMeetingSummaryGeneration(
        sessionId, language, claim.generationToken, summary, model,
      );
      if (!completed) throw new SummaryError("요약 완료 상태를 저장할 수 없습니다.", "SUMMARY_COMPLETE_FAILED", 502);
      scheduleLiveSheetSyncAfterCommit(after);
      return summarySuccess({ summary, utteranceCount: utterances.length, generationStatus: "saved" as const });
    } catch (error: unknown) {
      const errorCode = error instanceof SummaryError ? error.code : "SUMMARY_FAILED";
      await failMeetingSummaryGeneration(sessionId, language, claim.generationToken, errorCode).catch(() => false);
      throw error;
    }
  } catch (error: unknown) {
    if (error instanceof BoundedJsonBodyError) return summaryError(error.message, error.code, error.status);
    if (error instanceof AuthenticationError) return summaryError(error.message, "HOST_AUTH_REQUIRED", 401);
    if (error instanceof LiveAdmissionError) return summaryError(error.message, error.code, error.status);
    if (error instanceof SummaryError) return summaryError(error.message, error.code, error.status);
    const failure = toLiveFailure(error);
    if (failure.body.code === "SECURITY_NOT_CONFIGURED") {
      return summaryError(failure.body.error, failure.body.code, failure.status);
    }
    return summaryError("요약을 생성할 수 없습니다.", "SUMMARY_FAILED", 500);
  }
}

/** Host or session participant: read the stored summary for one language. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const language = parseLanguage(request.nextUrl.searchParams.get("language"));
    if (!language) return summaryError("언어를 선택하세요.", "LANGUAGE_REQUIRED", 400);
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
    const { record, generation } = await withSummaryReadDeadline(async (signal): Promise<{
      record: SummaryReadState;
      generation: SummaryStatusState;
    }> => {
      const record = await readMeetingSummary(sessionId, language, fetch, { signal });
      if (record) return { record, generation: null };
      const generation = await readMeetingSummaryGenerationStatus(sessionId, language, fetch, { signal });
      if (generation.status !== "ready") return { record: null, generation };
      const completedRecord = await readMeetingSummary(sessionId, language, fetch, { signal });
      if (!completedRecord) throw new SummaryError("완료된 요약을 읽을 수 없습니다.", "SUMMARY_READY_MISSING", 502);
      return { record: completedRecord, generation };
    });
    if (!record) {
      if (!generation) throw new SummaryError("요약 생성 상태를 읽을 수 없습니다.", "SUMMARY_STATE_FAILED", 502);
      if (generation.status === "running") {
        return summaryError("요약을 생성하고 있습니다.", "SUMMARY_GENERATION_RUNNING", 409);
      }
      if (generation.status === "retryable_failed") {
        return summaryError("요약 생성 중 일시적인 오류가 발생했습니다.", "SUMMARY_GENERATION_RETRYABLE_FAILED", 409);
      }
      if (generation.status === "exhausted") {
        return summaryError("요약 생성 재시도 횟수를 모두 사용했습니다.", "SUMMARY_GENERATION_EXHAUSTED", 409);
      }
      if (generation.status === "permanent_failed") {
        return summaryError("요약을 생성할 수 없습니다.", "SUMMARY_GENERATION_PERMANENT_FAILED", 409);
      }
      if (generation.status === "empty") {
        return summaryError("기록된 발언이 없어 요약을 만들 수 없습니다.", "SUMMARY_NO_UTTERANCES", 404);
      }
      return summaryError("아직 요약이 준비되지 않았습니다.", "SUMMARY_NOT_READY", 404);
    }
    return summarySuccess(publicSummaryRecord(record));
  } catch (error: unknown) {
    if (error instanceof AuthenticationError || error instanceof AuthorizationError) {
      return summaryError("요약을 볼 권한이 없습니다.", "SUMMARY_FORBIDDEN", 403);
    }
    if (error instanceof LiveAdmissionError) return summaryError(error.message, error.code, error.status);
    if (error instanceof SummaryError) return summaryError(error.message, error.code, error.status);
    const failure = toLiveFailure(error);
    if (failure.body.code === "SECURITY_NOT_CONFIGURED") {
      return summaryError(failure.body.error, failure.body.code, failure.status);
    }
    return summaryError("요약을 읽을 수 없습니다.", "SUMMARY_READ_FAILED", 500);
  }
}
