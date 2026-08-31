import { NextRequest } from "next/server";

import { toLiveFailure } from "@/lib/live/errors";
import { LiveSessionService } from "@/lib/live/service";
import { getLiveSessionStore } from "@/lib/live/store";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { liveLanguageInputSchema } from "@/lib/security/live-input-validation";
import { LiveAdmissionError } from "@/lib/security/live-admission-store";
import { authorizeViewerRequest, AuthenticationError, AuthorizationError } from "@/lib/security/live-viewer-authorization";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: rawId } = await context.params;
    const id = parseSessionId(rawId);
    const parsedLanguage = liveLanguageInputSchema.safeParse(request.nextUrl.searchParams.get("language"));
    if (!parsedLanguage.success) return apiError("언어를 선택하세요.", "LANGUAGE_REQUIRED", 400, privateNoStoreHeaders());
    const language = parsedLanguage.data;
    await authorizeViewerRequest(request, id, language);
    return apiSuccess(
      await new LiveSessionService(getLiveSessionStore()).snapshot(id, language),
      { headers: privateNoStoreHeaders() },
    );
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "VIEWER_AUTH_REQUIRED", 401, privateNoStoreHeaders());
    if (error instanceof AuthorizationError) return apiError(error.message, "VIEWER_FORBIDDEN", 403, privateNoStoreHeaders());
    if (error instanceof LiveAdmissionError) return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
  }
}
