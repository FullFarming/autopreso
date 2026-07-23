import { NextRequest } from "next/server";

import { AuthenticationError, getBearerToken, requireHost, verifyViewerGrantToken, VIEWER_GRANT_COOKIE } from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import {
  fetchUtterances,
  generateMeetingSummary,
  readMeetingSummary,
  SummaryError,
  upsertMeetingSummary,
} from "@/lib/live/summary";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { liveLanguageInputSchema } from "@/lib/security/live-input-validation";

function parseLanguage(value: string | null): string | null {
  const parsed = liveLanguageInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Host-only: generate (or regenerate) the meeting summary for one language. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requireHost(request);
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const body: unknown = await request.json().catch(() => null);
    const language = parseLanguage(
      body && typeof body === "object" && !Array.isArray(body) && typeof (body as { language?: unknown }).language === "string"
        ? (body as { language: string }).language
        : null,
    );
    if (!language) return apiError("요약할 언어를 선택하세요.", "LANGUAGE_REQUIRED", 400);
    const utterances = await fetchUtterances(sessionId, language);
    if (utterances.length === 0) {
      return apiError("요약할 발언 기록이 없습니다.", "NO_UTTERANCES", 404);
    }
    const { summary, model } = await generateMeetingSummary(utterances, language);
    await upsertMeetingSummary(sessionId, language, summary, model);
    return apiSuccess({ summary, model, utteranceCount: utterances.length });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
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
    let isAuthorized = false;
    try {
      await requireHost(request);
      isAuthorized = true;
    } catch {
      const token = getBearerToken(request) ?? request.cookies.get(VIEWER_GRANT_COOKIE)?.value;
      const claims = await verifyViewerGrantToken(token);
      // 종료된 미팅의 요약도 봐야 하므로 활성 토픽 검사는 하지 않습니다.
      isAuthorized = claims.sessionId === sessionId;
    }
    if (!isAuthorized) return apiError("요약을 볼 권한이 없습니다.", "SUMMARY_FORBIDDEN", 403);
    const record = await readMeetingSummary(sessionId, language);
    if (!record) return apiError("아직 요약이 준비되지 않았습니다.", "SUMMARY_NOT_READY", 404);
    return apiSuccess(record);
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError("요약을 볼 권한이 없습니다.", "SUMMARY_FORBIDDEN", 403);
    if (error instanceof SummaryError) return apiError(error.message, error.code, error.status);
    const failure = toLiveFailure(error);
    if (failure.body.code === "SECURITY_NOT_CONFIGURED") {
      return apiError(failure.body.error, failure.body.code, failure.status);
    }
    return apiError("요약을 읽을 수 없습니다.", "SUMMARY_READ_FAILED", 500);
  }
}
