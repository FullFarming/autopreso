import { NextRequest } from "next/server";

import { AuthenticationError, getBearerToken, requireHost, verifyViewerGrantToken, VIEWER_GRANT_COOKIE } from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { fetchUtterances, SummaryError } from "@/lib/live/summary";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { liveLanguageInputSchema } from "@/lib/security/live-input-validation";

/** Full speaker-attributed utterance record of a session in one language.
 *  Host or any participant; readable after the session ends so the meeting
 *  minutes stay available. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const parsedLanguage = liveLanguageInputSchema.safeParse(request.nextUrl.searchParams.get("language"));
    if (!parsedLanguage.success) return apiError("언어를 선택하세요.", "LANGUAGE_REQUIRED", 400);
    let isAuthorized = false;
    try {
      await requireHost(request);
      isAuthorized = true;
    } catch {
      try {
        const token = getBearerToken(request) ?? request.cookies.get(VIEWER_GRANT_COOKIE)?.value;
        const claims = await verifyViewerGrantToken(token);
        isAuthorized = claims.sessionId === sessionId;
      } catch {
        isAuthorized = false;
      }
    }
    if (!isAuthorized) return apiError("회의록을 볼 권한이 없습니다.", "TRANSCRIPT_FORBIDDEN", 403);
    const utterances = await fetchUtterances(sessionId, parsedLanguage.data);
    return apiSuccess({
      language: parsedLanguage.data,
      utterances: utterances.map((utterance) => ({
        seq: utterance.seq,
        speaker: utterance.speakerName ?? utterance.speakerLabel ?? "발표자",
        text: utterance.text,
        emittedAt: utterance.emittedAt,
      })),
    });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError("회의록을 볼 권한이 없습니다.", "TRANSCRIPT_FORBIDDEN", 403);
    if (error instanceof SummaryError) return apiError(error.message, error.code, error.status);
    const failure = toLiveFailure(error);
    if (failure.body.code === "SECURITY_NOT_CONFIGURED") {
      return apiError(failure.body.error, failure.body.code, failure.status);
    }
    return apiError("회의록을 읽을 수 없습니다.", "TRANSCRIPT_READ_FAILED", 500);
  }
}
