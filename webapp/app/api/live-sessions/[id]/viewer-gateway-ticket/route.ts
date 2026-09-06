import { NextRequest, NextResponse } from "next/server";
import { prepareViewerMediaConnection, publicMediaRuntime } from "@/lib/live/media-runtime";

import {
  AuthenticationError,
  createViewerGatewayTicket,
  verifyViewerGrantToken,
  VIEWER_GRANT_COOKIE,
} from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { isProductionRuntime } from "@/lib/security/config";
import { assertStrictOrigin, CsrfError } from "@/lib/security/csrf";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { enforceViewerGatewayTicketRateLimit } from "@/lib/security/live-rate-limit";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

function clearViewerCookie(response: NextResponse, sessionId: string): NextResponse {
  response.cookies.set(VIEWER_GRANT_COOKIE, "", {
    httpOnly: true,
    secure: isProductionRuntime(),
    sameSite: "lax",
    path: `/api/live-sessions/${sessionId}`,
    expires: new Date(0),
  });
  return response;
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let sessionId: string | null = null;
  try {
    assertStrictOrigin(request);
    const { id } = await context.params;
    sessionId = parseSessionId(id);
    const token = request.cookies.get(VIEWER_GRANT_COOKIE)?.value;
    const claims = await verifyViewerGrantToken(token);
    if (claims.sessionId !== sessionId) {
      return clearViewerCookie(
        apiError("다른 라이브 세션의 입장권은 사용할 수 없습니다.", "VIEWER_FORBIDDEN", 403, privateNoStoreHeaders()),
        sessionId,
      );
    }

    const store = new SupabaseLiveAdmissionStore();
    await enforceViewerGatewayTicketRateLimit({
      sessionId,
      grantId: claims.grantId,
    }, store);
    const restored = await store.restoreAttendee({
      grantId: claims.grantId,
      sessionId,
      userId: claims.userId,
    });
    const prepared = await prepareViewerMediaConnection(sessionId, restored.grant.id, restored.grant.userId);
    if (prepared?.status === "HOST_WAITING") {
      return apiSuccess({ status: "HOST_WAITING", runtime: publicMediaRuntime(prepared.runtime) }, {
        status: 202, headers: privateNoStoreHeaders(),
      });
    }
    const signed = await createViewerGatewayTicket({
      grantId: restored.grant.id,
      sessionId: restored.grant.sessionId,
      userId: restored.grant.userId,
    });
    return apiSuccess({
      ticket: signed.token,
      expiresAt: new Date(signed.claims.exp * 1_000).toISOString(),
      ...(prepared ? { connectionId: prepared.connectionId, epoch: prepared.runtime.epoch } : {}),
    }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    if (error instanceof CsrfError) {
      return apiError(error.message, "CSRF_ORIGIN_FORBIDDEN", 403, privateNoStoreHeaders());
    }
    if (error instanceof AuthenticationError) {
      const response = apiError(error.message, "VIEWER_AUTH_REQUIRED", 401, privateNoStoreHeaders());
      return sessionId ? clearViewerCookie(response, sessionId) : response;
    }
    if (error instanceof LiveAdmissionError) {
      const response = apiError(error.message, error.code, error.status, privateNoStoreHeaders());
      return sessionId && error.code === "VIEWER_RESTORE_FORBIDDEN"
        ? clearViewerCookie(response, sessionId)
        : response;
    }
    const failure = toLiveFailure(error);
    if (failure.body.code === "SECURITY_NOT_CONFIGURED") {
      return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
    }
    return apiError("게이트웨이 입장권을 발급할 수 없습니다.", "VIEWER_GATEWAY_TICKET_FAILED", 500, privateNoStoreHeaders());
  }
}
