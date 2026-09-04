import { after, NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { isAdminRequest } from "@/lib/auth/require-admin";
import { resolveEngineDefaultsOrFallback } from "@/lib/console/engine-defaults";
import { toLiveFailure } from "@/lib/live/errors";
import { isLiveCallEnabled } from "@/lib/live/feature-flag";
import { LiveSessionService } from "@/lib/live/service";
import { getLiveSessionStore } from "@/lib/live/store";
import { scheduleLiveSheetSyncAfterCommit } from "@/lib/live-sheet-sync/runtime";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { createLiveSessionInputSchema, liveSessionRecoveryQuerySchema } from "@/lib/security/live-input-validation";

/** Host session recovery: `?scope=mine` lists the authenticated host's
 *  active (preparing / live / paused) sessions for dashboard rehydration. */
export async function GET(request: NextRequest) {
  try {
    if (request.nextUrl.searchParams.get("scope") !== "mine") {
      return apiError("지원하지 않는 조회 범위입니다.", "INVALID_SCOPE", 400);
    }
    const { hostId } = await requireHost(request);
    const searchParams = request.nextUrl.searchParams;
    const parsed = liveSessionRecoveryQuerySchema.safeParse(Object.fromEntries(searchParams));
    if (!parsed.success || [...searchParams.keys()].some((key) => searchParams.getAll(key).length !== 1)) {
      return apiError("세션 목록 조회 범위가 올바르지 않습니다.", "INVALID_RECOVERY_PAGE", 400);
    }
    const { offset } = parsed.data;
    const sessions = await new LiveSessionService(getLiveSessionStore()).listActive(hostId, offset);
    return apiSuccess({
      sessions: sessions.slice(0, 100).map((session) => ({
        id: session.id,
        title: session.title,
        status: session.status,
        scheduledAt: session.scheduledAt,
        viewerCount: session.viewerCount,
        version: session.version,
      })),
      nextOffset: sessions.length > 100 ? offset + 100 : null,
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
    const parsed = createLiveSessionInputSchema.safeParse(await readBoundedJsonBody(request));
    if (!parsed.success) return apiError("요청 형식이 올바르지 않습니다.", "INVALID_REQUEST", 400);
    const input = parsed.data;
    // Spec §9: the global engine is the only Live Call engine; a non-admin's
    // `modelPreferences.engine` is replaced by it inside the service.
    const [engineDefaults, isAdmin] = await Promise.all([resolveEngineDefaultsOrFallback(), isAdminRequest(request)]);
    const session = await new LiveSessionService(getLiveSessionStore()).create(hostId, {
      title: input.title,
      scheduledAt: input.scheduledAt,
      sessionType: input.sessionType,
      languages: input.languages,
      outputMode: input.outputMode,
      voiceProvider: input.voiceProvider,
      maxViewers: input.maxViewers,
      participantSpeakingEnabled: input.participantSpeakingEnabled,
      glossaryPack: input.glossaryPack,
      companyName: input.companyName,
      ticker: input.ticker,
      fiscalPeriod: input.fiscalPeriod,
      eventType: input.eventType,
      agenda: input.agenda,
      modelPreferences: input.modelPreferences,
    }, { engineDefaults, isAdmin });
    scheduleLiveSheetSyncAfterCommit(after);
    return apiSuccess(session, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof BoundedJsonBodyError) return apiError(error.message, error.code, error.status);
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status);
  }
}
