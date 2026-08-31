import type { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { isLiveCallEnabled } from "@/lib/live/feature-flag";
import { LiveSessionService } from "@/lib/live/service";
import { getLiveSessionStore } from "@/lib/live/store";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { assertStrictOrigin, CsrfError } from "@/lib/security/csrf";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { enforceGlossarySelectionRateLimit } from "@/lib/security/live-rate-limit";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { hostId } = await requireHost(request);
    if (!isLiveCallEnabled()) return failure("Live Call 기능이 비활성화되어 있습니다.", "LIVE_CALL_DISABLED", 403);
    const sessionId = parseSessionId((await context.params).id);
    const glossaries = await new LiveSessionService(getLiveSessionStore()).getGlossaryPins(hostId, sessionId);
    return apiSuccess(glossaries, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return failure(error.message, "HOST_LOGIN_REQUIRED", 401);
    const mapped = toLiveFailure(error);
    return failure(mapped.body.error, mapped.body.code, mapped.status);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    assertStrictOrigin(request);
    const { hostId } = await requireHost(request);
    if (!isLiveCallEnabled()) return failure("Live Call 기능이 비활성화되어 있습니다.", "LIVE_CALL_DISABLED", 403);
    const sessionId = parseSessionId((await context.params).id);
    await enforceGlossarySelectionRateLimit(hostId, sessionId, new SupabaseLiveAdmissionStore());
    const input = await readBoundedJsonBody(request);
    const pins = await new LiveSessionService(getLiveSessionStore()).replaceGlossaryPins(hostId, sessionId, input);
    return apiSuccess(pins, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    if (error instanceof BoundedJsonBodyError) return failure(error.message, error.code, error.status);
    if (error instanceof CsrfError) return failure(error.message, "INVALID_ORIGIN", 403);
    if (error instanceof AuthenticationError) return failure(error.message, "HOST_LOGIN_REQUIRED", 401);
    if (error instanceof LiveAdmissionError) return failure(error.message, error.code, error.status);
    const mapped = toLiveFailure(error);
    return failure(mapped.body.error, mapped.body.code, mapped.status);
  }
}

function failure(error: string, code: string, status: number) {
  return apiError(error, code, status, privateNoStoreHeaders());
}
