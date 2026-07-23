import { NextRequest, NextResponse } from "next/server";

import { createViewerGrantToken, VIEWER_GRANT_COOKIE } from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { LIVE_ADMISSION_PEPPER } from "@/lib/security/config";
import { exactCorsHeaders } from "@/lib/security/cors";
import { hmacHex, opaqueIdentifier } from "@/lib/security/hmac";
import {
  LiveAdmissionError,
  SupabaseLiveAdmissionStore,
  verifySupabaseAnonymousUser,
} from "@/lib/security/live-admission-store";
import { joinLiveSessionInputSchema } from "@/lib/security/live-input-validation";
import { enforceJoinPreflightRateLimits, enforceSessionJoinRateLimit } from "@/lib/security/live-rate-limit";

function withCors(response: NextResponse, request: NextRequest): NextResponse {
  exactCorsHeaders(request).forEach((value, key) => response.headers.set(key, value));
  return response;
}

export function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  const headers = exactCorsHeaders(request);
  if (!origin || !headers.has("access-control-allow-origin")) {
    return new NextResponse(null, { status: 403, headers });
  }
  return new NextResponse(null, { status: 204, headers });
}

export async function POST(request: NextRequest) {
  try {
    const parsed = joinLiveSessionInputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return withCors(apiError("입장 정보가 올바르지 않습니다.", "INVALID_JOIN_REQUEST", 400), request);
    const body = parsed.data;

    const store = new SupabaseLiveAdmissionStore();
    const isInvite = body.inviteToken !== undefined;
    let credentialHmac: string;
    if (body.inviteToken !== undefined) {
      credentialHmac = await hmacHex(LIVE_ADMISSION_PEPPER, `invite\0${body.inviteToken}`);
    } else if (body.code !== undefined) {
      credentialHmac = await hmacHex(LIVE_ADMISSION_PEPPER, `admission\0${body.code}`);
    } else {
      throw new LiveAdmissionError("입장 정보가 올바르지 않습니다.", "INVALID_JOIN_REQUEST", 400);
    }
    // Invalid admission credentials still consume caller-controlled buckets.
    await enforceJoinPreflightRateLimits(request, body.deviceId, store);
    const sessionRateKey = isInvite
      ? await store.resolveInviteRateKey(credentialHmac)
      : await store.resolveAdmissionRateKey(credentialHmac);
    await enforceSessionJoinRateLimit(sessionRateKey, store);
    const { userId } = await verifySupabaseAnonymousUser(body.accessToken);
    const deviceHash = await opaqueIdentifier(LIVE_ADMISSION_PEPPER, "viewer-device", body.deviceId);
    const requestedExpiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const redemption = isInvite
      ? await store.redeemInvite({
          tokenHmac: credentialHmac,
          userId,
          deviceHash,
          displayName: body.displayName,
          expiresAt: requestedExpiresAt,
        })
      : await store.redeemAdmission({
          codeHmac: credentialHmac,
          userId,
          deviceHash,
          displayName: body.displayName,
          expiresAt: requestedExpiresAt,
        });
    const signed = await createViewerGrantToken({
      grantId: redemption.grant.id,
      sessionId: redemption.grant.sessionId,
      userId: redemption.grant.userId,
    });
    const response = apiSuccess({
      viewerToken: signed.token,
      grant: redemption.grant,
      session: redemption.session,
      viewerCount: redemption.viewerCount,
    });
    response.cookies.set(VIEWER_GRANT_COOKIE, signed.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/live-sessions",
      maxAge: 6 * 60 * 60,
    });
    return withCors(response, request);
  } catch (error: unknown) {
    if (error instanceof LiveAdmissionError) return withCors(apiError(error.message, error.code, error.status), request);
    const failure = toLiveFailure(error);
    if (failure.body.code === "SECURITY_NOT_CONFIGURED") {
      return withCors(apiError(failure.body.error, failure.body.code, failure.status), request);
    }
    return withCors(apiError("입장권을 발급할 수 없습니다.", "JOIN_FAILED", 500), request);
  }
}
