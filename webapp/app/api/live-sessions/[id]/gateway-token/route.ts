import { NextRequest } from "next/server";

import { AuthenticationError, createGatewayToken, requireHost } from "@/lib/auth/live-auth";
import { LiveSessionError, toLiveFailure } from "@/lib/live/errors";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { assertStrictOrigin, CsrfError } from "@/lib/security/csrf";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { enforceGatewayTokenRateLimit } from "@/lib/security/live-rate-limit";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    assertStrictOrigin(request);
    const { hostId } = await requireHost(request);
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const store = new SupabaseLiveAdmissionStore();
    await store.assertHostSession(sessionId, hostId);
    await enforceGatewayTokenRateLimit(hostId, sessionId, store);
    const signed = await createGatewayToken(sessionId, hostId);
    return apiSuccess(
      { token: signed.token, expiresAt: new Date(signed.claims.exp * 1000).toISOString() },
      { headers: privateNoStoreHeaders() },
    );
  } catch (error: unknown) {
    if (error instanceof CsrfError) {
      return apiError(error.message, "CSRF_ORIGIN_FORBIDDEN", 403, privateNoStoreHeaders());
    }
    if (error instanceof LiveAdmissionError) {
      return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    }
    if (error instanceof AuthenticationError) {
      return apiError(error.message, "HOST_AUTH_REQUIRED", 401, privateNoStoreHeaders());
    }
    if (error instanceof LiveSessionError) {
      const failure = toLiveFailure(error);
      return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
    }
    const failure = toLiveFailure(error);
    if (failure.body.code === "SECURITY_NOT_CONFIGURED") {
      return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
    }
    return apiError("게이트웨이 토큰을 발급할 수 없습니다.", "GATEWAY_TOKEN_FAILED", 500, privateNoStoreHeaders());
  }
}
