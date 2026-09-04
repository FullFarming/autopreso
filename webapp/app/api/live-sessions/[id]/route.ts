import { after, NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { isAdminRequest } from "@/lib/auth/require-admin";
import { resolveEngineDefaultsOrFallback } from "@/lib/console/engine-defaults";
import { LiveSessionError, toLiveFailure } from "@/lib/live/errors";
import { isLiveCallEnabled } from "@/lib/live/feature-flag";
import { generateSessionSummariesAfterEnd } from "@/lib/live/post-session-summary";
import { LiveSessionService } from "@/lib/live/service";
import { SummaryError } from "@/lib/live/summary";
import { getLiveSessionStore } from "@/lib/live/store";
import { parseSessionId } from "@/lib/live/validation";
import { scheduleLiveSheetSyncAfterCommit } from "@/lib/live-sheet-sync/runtime";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { updateLiveSessionInputSchema } from "@/lib/security/live-input-validation";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function safeSummarySchedulingCode(error: unknown): string {
  return error instanceof SummaryError ? error.code : "SUMMARY_FAILED";
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const [{ hostId }, params] = await Promise.all([requireHost(request), context.params]);
    const id = parseSessionId(params.id);
    const session = await getLiveSessionStore().getOwned(id, hostId);
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
    const parsed = updateLiveSessionInputSchema.safeParse(await readBoundedJsonBody(request));
    if (!parsed.success) return apiError("요청 형식이 올바르지 않습니다.", "INVALID_REQUEST", 400);
    const input = parsed.data;
    // Spec §9: a non-admin's `modelPreferences.engine` is replaced by the global engine (server authority).
    const [engineDefaults, isAdmin] = input.modelPreferences === undefined
      ? ([undefined, false] as const)
      : await Promise.all([resolveEngineDefaultsOrFallback(), isAdminRequest(request)]);
    const session = await new LiveSessionService(getLiveSessionStore()).update(hostId, id, {
      version: input.version,
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
    return apiSuccess(session);
  } catch (error: unknown) {
    if (error instanceof BoundedJsonBodyError) return apiError(error.message, error.code, error.status);
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
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
    const sessionBeforeEnd = await store.getOwned(id, hostId);
    await new LiveSessionService(store).end(hostId, id);
    scheduleLiveSheetSyncAfterCommit(after);
    // Contract C7: auto-generate meeting summaries per active language.
    // Next keeps this work inside the request lifecycle without delaying End.
    if (sessionBeforeEnd && sessionBeforeEnd.hostId === hostId) {
      after(async () => {
        try {
          const summaryResult = await generateSessionSummariesAfterEnd(id, hostId, sessionBeforeEnd.languages);
          if (summaryResult.saved.length > 0) scheduleLiveSheetSyncAfterCommit(after);
        } catch (summaryError: unknown) {
          console.error(`live post-session summary scheduling failed ${safeSummarySchedulingCode(summaryError)}`);
        }
      });
    }
    return apiSuccess({ id, status: "stopped" as const });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status);
  }
}
