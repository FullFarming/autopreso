import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { buildParticipantActivity } from "@/lib/live/activity";
import { SummaryError } from "@/lib/live/summary";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { liveLanguageInputSchema } from "@/lib/security/live-input-validation";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const [{ hostId }, { id }] = await Promise.all([requireHost(request), context.params]);
    const sessionId = parseSessionId(id);
    const store = new SupabaseLiveAdmissionStore();
    let activeLanguages: string[] | null = null;
    try {
      activeLanguages = (await store.assertHostSession(sessionId, hostId)).languages;
    } catch (error: unknown) {
      if (!(error instanceof LiveAdmissionError) || error.code !== "LIVE_SESSION_NOT_FOUND") throw error;
      await store.assertHostSessionOwnership(sessionId, hostId);
    }
    const requestedLanguage = request.nextUrl.searchParams.get("language");
    const parsedLanguage = requestedLanguage === null
      ? { success: true as const, data: activeLanguages?.[0] }
      : liveLanguageInputSchema.safeParse(requestedLanguage);
    if (!parsedLanguage.success
      || !parsedLanguage.data
      || activeLanguages !== null && !activeLanguages.includes(parsedLanguage.data)) {
      return apiError("제공 중인 언어를 선택하세요.", "LANGUAGE_REQUIRED", 400);
    }
    return apiSuccess(await buildParticipantActivity(sessionId, hostId, parsedLanguage.data));
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    if (error instanceof LiveAdmissionError) return apiError(error.message, error.code, error.status);
    if (error instanceof SummaryError) return apiError(error.message, error.code, error.status);
    return apiError("참가자 활동을 읽을 수 없습니다.", "PARTICIPANT_ACTIVITY_READ_FAILED", 500);
  }
}
