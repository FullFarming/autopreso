import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { isLiveCallEnabled } from "@/lib/live/feature-flag";
import { LiveSessionService } from "@/lib/live/service";
import { getLiveSessionStore } from "@/lib/live/store";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { startLiveSessionInputSchema } from "@/lib/security/live-input-validation";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    if (!isLiveCallEnabled()) return apiError("Live Call 기능이 비활성화되어 있습니다.", "LIVE_CALL_DISABLED", 403);
    const [{ hostId }, { id: rawId }] = await Promise.all([requireHost(request), context.params]);
    const sessionId = parseSessionId(rawId);
    const parsed = startLiveSessionInputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError("시작 요청이 올바르지 않습니다.", "INVALID_REQUEST", 400);
    const session = await new LiveSessionService(getLiveSessionStore()).start(
      hostId,
      sessionId,
      parsed.data.version,
    );
    return apiSuccess(session);
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status);
  }
}
