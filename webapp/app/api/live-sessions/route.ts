import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { isLiveCallEnabled } from "@/lib/live/feature-flag";
import { LiveSessionService } from "@/lib/live/service";
import { getLiveSessionStore } from "@/lib/live/store";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { createLiveSessionInputSchema } from "@/lib/security/live-input-validation";

/** Host session recovery: `?scope=mine` lists the authenticated host's
 *  active (preparing / live / paused) sessions for dashboard rehydration. */
export async function GET(request: NextRequest) {
  try {
    if (request.nextUrl.searchParams.get("scope") !== "mine") {
      return apiError("지원하지 않는 조회 범위입니다.", "INVALID_SCOPE", 400);
    }
    const { hostId } = await requireHost(request);
    const sessions = await new LiveSessionService(getLiveSessionStore()).listActive(hostId);
    return apiSuccess({
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        status: session.status,
        scheduledAt: session.scheduledAt,
        viewerCount: session.viewerCount,
        version: session.version,
      })),
    });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status);
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!isLiveCallEnabled()) return apiError("Live Call 기능이 비활성화되어 있습니다.", "LIVE_CALL_DISABLED", 403);
    const { hostId } = await requireHost(request);
    const parsed = createLiveSessionInputSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("요청 형식이 올바르지 않습니다.", "INVALID_REQUEST", 400);
    const input = parsed.data;
    const session = await new LiveSessionService(getLiveSessionStore()).create(hostId, {
      title: input.title,
      scheduledAt: input.scheduledAt,
      sessionType: input.sessionType,
      languages: input.languages,
      outputMode: input.outputMode,
      voiceProvider: input.voiceProvider,
      maxViewers: input.maxViewers,
      glossaryPack: input.glossaryPack,
    });
    return apiSuccess(session, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    if (error instanceof SyntaxError) return apiError("요청 형식이 올바르지 않습니다.", "INVALID_JSON", 400);
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status);
  }
}
