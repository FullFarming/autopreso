import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { deriveSessionAdmissionCode } from "@/lib/live/admission-code";
import { LiveSessionError, toLiveFailure } from "@/lib/live/errors";
import { isLiveCallEnabled } from "@/lib/live/feature-flag";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { LIVE_ADMISSION_PEPPER } from "@/lib/security/config";
import { hmacHex } from "@/lib/security/hmac";
import {
  createLiveInviteToken,
  LiveAdmissionError,
  resolveLiveAdmissionExpiry,
  resolveLiveInviteExpiry,
  SupabaseLiveAdmissionStore,
} from "@/lib/security/live-admission-store";
import { createLiveInviteInputSchema } from "@/lib/security/live-input-validation";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    if (!isLiveCallEnabled()) return apiError("Live Call 기능이 비활성화되어 있습니다.", "LIVE_CALL_DISABLED", 403);
    const { hostId } = await requireHost(request);
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const parsed = createLiveInviteInputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError("초대 요청이 올바르지 않습니다.", "INVALID_REQUEST", 400);

    const store = new SupabaseLiveAdmissionStore();
    const session = await store.assertHostSession(sessionId, hostId);
    const admissionGeneration = session.admissionState === "uninitialized"
      ? session.admissionGeneration + 1
      : session.admissionGeneration;
    const admissionCode = await deriveSessionAdmissionCode(
      sessionId,
      admissionGeneration,
      LIVE_ADMISSION_PEPPER,
    );
    const codeHmac = await hmacHex(LIVE_ADMISSION_PEPPER, `admission\0${admissionCode}`);
    const admissionExpiresAt = resolveLiveAdmissionExpiry(session);
    const version = await store.openAdmission({
      sessionId,
      hostId,
      codeHmac,
      openUntil: admissionExpiresAt,
      expectedVersion: session.version,
    });
    const inviteToken = createLiveInviteToken();
    const tokenHmac = await hmacHex(LIVE_ADMISSION_PEPPER, `invite\0${inviteToken}`);
    const expiresAt = resolveLiveInviteExpiry(session);
    await store.createInvite({
      sessionId,
      hostId,
      tokenHmac,
      expiresAt,
    });
    return apiSuccess({ inviteToken, admissionCode, expiresAt, version });
  } catch (error: unknown) {
    if (error instanceof LiveAdmissionError) return apiError(error.message, error.code, error.status);
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    if (error instanceof LiveSessionError) {
      const failure = toLiveFailure(error);
      return apiError(failure.body.error, failure.body.code, failure.status);
    }
    const failure = toLiveFailure(error);
    if (failure.body.code === "SECURITY_NOT_CONFIGURED") {
      return apiError(failure.body.error, failure.body.code, failure.status);
    }
    return apiError("초대 링크를 만들 수 없습니다.", "INVITE_CREATE_FAILED", 500);
  }
}
