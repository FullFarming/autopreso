import { NextRequest } from "next/server";
import { z } from "zod";
import { isParticipantDemandEnabled, publicMediaRuntime, requestMediaStart } from "@/lib/live/media-runtime";

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
import { startLiveSessionInputSchema as baseStartLiveSessionInputSchema } from "@/lib/security/live-input-validation";
import { enforceLiveStartRateLimit } from "@/lib/security/live-rate-limit";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

const startLiveSessionInputSchema = baseStartLiveSessionInputSchema.extend({ demandEnabled: z.boolean().optional() });

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    if (!isLiveCallEnabled()) {
      return apiError("Live Call 기능이 비활성화되어 있습니다.", "LIVE_CALL_DISABLED", 403, privateNoStoreHeaders());
    }
    assertStrictOrigin(request);
    const [{ hostId }, { id: rawId }] = await Promise.all([requireHost(request), context.params]);
    const sessionId = parseSessionId(rawId);
    const rateLimitStore = new SupabaseLiveAdmissionStore();
    await enforceLiveStartRateLimit(hostId, sessionId, rateLimitStore);
    const body = await readBoundedJsonBody(request);
    const parsed = startLiveSessionInputSchema.safeParse(body);
    if (!parsed.success) return apiError("시작 요청이 올바르지 않습니다.", "INVALID_REQUEST", 400, privateNoStoreHeaders());
    const session = await new LiveSessionService(getLiveSessionStore()).prepareStart(
      hostId,
      sessionId,
      parsed.data.version,
    );
    const runtime = parsed.data.demandEnabled === true && isParticipantDemandEnabled()
      ? await requestMediaStart(sessionId, hostId, session.version)
      : null;
    return apiSuccess({
      sessionId: session.id,
      status: session.status,
      version: session.version,
      activationKey: crypto.randomUUID(),
      runtime: publicMediaRuntime(runtime),
    }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    if (error instanceof CsrfError) return apiError(error.message, "CSRF_ORIGIN_FORBIDDEN", 403, privateNoStoreHeaders());
    if (error instanceof BoundedJsonBodyError) return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    if (error instanceof LiveAdmissionError) return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401, privateNoStoreHeaders());
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
  }
}
