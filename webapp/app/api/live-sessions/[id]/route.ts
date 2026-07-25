import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { LiveSessionError, toLiveFailure } from "@/lib/live/errors";
import { isLiveCallEnabled } from "@/lib/live/feature-flag";
import { generateSessionSummariesAfterEnd } from "@/lib/live/post-session-summary";
import { LiveSessionService } from "@/lib/live/service";
import { getLiveSessionStore } from "@/lib/live/store";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { updateLiveSessionInputSchema } from "@/lib/security/live-input-validation";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const [{ hostId }, params] = await Promise.all([requireHost(request), context.params]);
    const id = parseSessionId(params.id);
    const session = await getLiveSessionStore().get(id);
    if (!session || session.hostId !== hostId) {
      throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    }
    return apiSuccess(session);
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    if (!isLiveCallEnabled()) return apiError("Live Call 기능이 비활성화되어 있습니다.", "LIVE_CALL_DISABLED", 403);
    const [{ hostId }, params] = await Promise.all([requireHost(request), context.params]);
    const id = parseSessionId(params.id);
    const parsed = updateLiveSessionInputSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("요청 형식이 올바르지 않습니다.", "INVALID_REQUEST", 400);
    const input = parsed.data;
    const session = await new LiveSessionService(getLiveSessionStore()).update(hostId, id, {
      version: input.version,
      title: input.title,
      scheduledAt: input.scheduledAt,
      sessionType: input.sessionType,
      languages: input.languages,
      outputMode: input.outputMode,
      voiceProvider: input.voiceProvider,
      maxViewers: input.maxViewers,
      glossaryPack: input.glossaryPack,
    });
    return apiSuccess(session);
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    if (error instanceof SyntaxError) return apiError("요청 형식이 올바르지 않습니다.", "INVALID_JSON", 400);
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    if (!isLiveCallEnabled()) return apiError("Live Call 기능이 비활성화되어 있습니다.", "LIVE_CALL_DISABLED", 403);
    const [{ hostId }, params] = await Promise.all([requireHost(request), context.params]);
    const id = parseSessionId(params.id);
    const store = getLiveSessionStore();
    // Capture the active language list before terminate clears session state.
    const sessionBeforeEnd = await store.get(id);
    await new LiveSessionService(store).end(hostId, id);
    // Contract C7: auto-generate meeting summaries per active language.
    // Fire-and-forget with one retry — never blocks or fails the End response.
    if (sessionBeforeEnd && sessionBeforeEnd.hostId === hostId) {
      void generateSessionSummariesAfterEnd(id, hostId, sessionBeforeEnd.languages).catch((summaryError: unknown) => {
        console.error(`live post-session summary scheduling failed (${id})`, summaryError);
      });
    }
    return apiSuccess({ id, status: "stopped" as const });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status);
  }
}
