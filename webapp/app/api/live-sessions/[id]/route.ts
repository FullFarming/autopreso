import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { LiveSessionError, toLiveFailure } from "@/lib/live/errors";
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
    const [{ hostId }, params] = await Promise.all([requireHost(request), context.params]);
    const id = parseSessionId(params.id);
    const parsed = updateLiveSessionInputSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("요청 형식이 올바르지 않습니다.", "INVALID_REQUEST", 400);
    const input = parsed.data;
    const session = await new LiveSessionService(getLiveSessionStore()).update(hostId, id, {
      version: input.version,
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
    const [{ hostId }, params] = await Promise.all([requireHost(request), context.params]);
    const id = parseSessionId(params.id);
    await new LiveSessionService(getLiveSessionStore()).stop(hostId, id);
    return apiSuccess({ id, status: "stopped" as const });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status);
  }
}
