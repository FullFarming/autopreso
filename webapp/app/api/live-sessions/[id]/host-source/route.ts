import { NextRequest } from "next/server";
import { z } from "zod";
import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { parseSessionId } from "@/lib/live/validation";
import { callMediaRuntimeRpc, isParticipantDemandEnabled, mediaRuntimeSchema, publicMediaRuntime } from "@/lib/live/media-runtime";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { assertStrictOrigin, CsrfError } from "@/lib/security/csrf";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { LIVE_ADMISSION_PEPPER } from "@/lib/security/config";
import { opaqueIdentifier } from "@/lib/security/hmac";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

const inputSchema = z.object({ sourceGeneration: z.string().uuid(), sourceReady: z.boolean() }).strict();
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    assertStrictOrigin(request);
    const { hostId } = await requireHost(request);
    const sessionId = parseSessionId((await context.params).id);
    const store = new SupabaseLiveAdmissionStore();
    await store.assertHostSessionOwnership(sessionId, hostId);
    const input = inputSchema.safeParse(await readBoundedJsonBody(request));
    if (!input.success) return apiError("마이크 준비 요청이 올바르지 않습니다.", "INVALID_REQUEST", 400, privateNoStoreHeaders());
    if (!isParticipantDemandEnabled()) return apiSuccess({ enabled: false }, { headers: privateNoStoreHeaders() });
    const scope = "host-media-source-session";
    const keyHash = await opaqueIdentifier(LIVE_ADMISSION_PEPPER, scope, `${sessionId}\u0000${hostId}`);
    if (!await store.consumeRateLimit({ scope, keyHash, limit: 30, windowSeconds: 60 })) {
      return apiError("요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", "MEDIA_SOURCE_RATE_LIMITED", 429, privateNoStoreHeaders());
    }
    const runtime = mediaRuntimeSchema.parse(await callMediaRuntimeRpc("heartbeat_live_host_source_v1", {
      p_session_id: sessionId, p_host_id: hostId,
      p_source_generation: input.data.sourceGeneration, p_source_ready: input.data.sourceReady,
    }));
    return apiSuccess(publicMediaRuntime(runtime), { headers: privateNoStoreHeaders() });
  } catch (error) {
    if (error instanceof CsrfError) return apiError(error.message, "CSRF_ORIGIN_FORBIDDEN", 403, privateNoStoreHeaders());
    if (error instanceof AuthenticationError) return apiError("호스트 인증이 필요합니다.", "HOST_AUTH_REQUIRED", 401, privateNoStoreHeaders());
    if (error instanceof BoundedJsonBodyError || error instanceof LiveAdmissionError) return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    return apiError("마이크 준비 상태를 저장할 수 없습니다.", "MEDIA_SOURCE_UNAVAILABLE", 503, privateNoStoreHeaders());
  }
}
