import { randomInt } from "node:crypto";

import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { LiveSessionError, toLiveFailure } from "@/lib/live/errors";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { LIVE_ADMISSION_PEPPER } from "@/lib/security/config";
import { hmacHex } from "@/lib/security/hmac";
import {
  LiveAdmissionError,
  resolveLiveAdmissionExpiry,
  SupabaseLiveAdmissionStore,
} from "@/lib/security/live-admission-store";
import { admissionActionInputSchema } from "@/lib/security/live-input-validation";

function admissionCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { hostId } = await requireHost(request);
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const parsed = admissionActionInputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError("입장창 요청이 올바르지 않습니다.", "INVALID_REQUEST", 400);
    }
    const { action, version } = parsed.data;
    const store = new SupabaseLiveAdmissionStore();
    const session = await store.assertHostSession(sessionId, hostId);

    if (action === "close") {
      const nextVersion = await store.closeAdmission(sessionId, hostId, version);
      return apiSuccess({ sessionId, admissionOpenUntil: null, version: nextVersion });
    }
    const code = admissionCode();
    const codeHmac = await hmacHex(LIVE_ADMISSION_PEPPER, `admission\0${code}`);
    const openUntil = resolveLiveAdmissionExpiry(session);
    const nextVersion = await store.openAdmission({
      sessionId,
      hostId,
      codeHmac,
      openUntil,
      expectedVersion: version,
    });
    return apiSuccess({ sessionId, code, admissionOpenUntil: openUntil, version: nextVersion });
  } catch (error: unknown) {
    if (error instanceof LiveAdmissionError) return apiError(error.message, error.code, error.status);
    if (error instanceof AuthenticationError) {
      return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    }
    if (error instanceof LiveSessionError) {
      const failure = toLiveFailure(error);
      return apiError(failure.body.error, failure.body.code, failure.status);
    }
    const failure = toLiveFailure(error);
    if (failure.body.code === "SECURITY_NOT_CONFIGURED") {
      return apiError(failure.body.error, failure.body.code, failure.status);
    }
    return apiError("입장창을 변경할 수 없습니다.", "ADMISSION_UPDATE_FAILED", 500);
  }
}
