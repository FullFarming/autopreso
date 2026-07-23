import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { LiveSessionError, toLiveFailure } from "@/lib/live/errors";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { LIVE_ADMISSION_PEPPER } from "@/lib/security/config";
import { hmacHex } from "@/lib/security/hmac";
import {
  createLiveInviteToken,
  LiveAdmissionError,
  resolveLiveInviteExpiry,
  SupabaseLiveAdmissionStore,
} from "@/lib/security/live-admission-store";
import { createLiveInviteInputSchema } from "@/lib/security/live-input-validation";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { hostId } = await requireHost(request);
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const parsed = createLiveInviteInputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError("초대 요청이 올바르지 않습니다.", "INVALID_REQUEST", 400);

    const store = new SupabaseLiveAdmissionStore();
    const session = await store.assertHostSession(sessionId, hostId);
    const inviteToken = createLiveInviteToken();
    const tokenHmac = await hmacHex(LIVE_ADMISSION_PEPPER, `invite\0${inviteToken}`);
    const expiresAt = resolveLiveInviteExpiry(session);
    if (session.admissionOpenUntil === null) {
      throw new LiveAdmissionError("입장 시간이 종료되었습니다.", "ADMISSION_CLOSED", 410);
    }
    await store.createInvite({
      sessionId,
      hostId,
      tokenHmac,
      expiresAt,
      admissionOpenUntil: session.admissionOpenUntil,
    });
    return apiSuccess({ inviteToken, expiresAt });
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
