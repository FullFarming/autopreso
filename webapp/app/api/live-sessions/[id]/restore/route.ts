import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { isLiveCallEnabled } from "@/lib/live/feature-flag";
import { LiveSessionService } from "@/lib/live/service";
import { getLiveSessionStore } from "@/lib/live/store";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { assertStrictOrigin, CsrfError } from "@/lib/security/csrf";
import { restoreLiveSessionInputSchema } from "@/lib/security/live-input-validation";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    assertStrictOrigin(request);
    if (!isLiveCallEnabled()) return apiError("Live Call 기능이 비활성화되어 있습니다.", "LIVE_CALL_DISABLED", 403);
    const { hostId } = await requireHost(request);
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const parsed = restoreLiveSessionInputSchema.safeParse(await readBoundedJsonBody(request));
    if (!parsed.success) return apiError("세션 복원 요청이 올바르지 않습니다.", "INVALID_REQUEST", 400);
    const session = await new LiveSessionService(getLiveSessionStore()).restore(hostId, sessionId, parsed.data.version);
    return apiSuccess(session);
  } catch (error: unknown) {
    if (error instanceof CsrfError) return apiError(error.message, "INVALID_ORIGIN", 403);
    if (error instanceof BoundedJsonBodyError) return apiError(error.message, error.code, error.status);
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status);
  }
}
