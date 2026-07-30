import type { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toGlossaryPresetFailure } from "@/lib/glossary-presets/errors";
import { getGlossaryPresetService } from "@/lib/glossary-presets/service";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { assertStrictOrigin, CsrfError } from "@/lib/security/csrf";
import { createGlossaryPresetInputSchema } from "@/lib/security/host-glossary-preset-validation";

export async function GET(request: NextRequest) {
  try {
    const { hostId } = await requireHost(request);
    const presets = await getGlossaryPresetService().list(hostId);
    return apiSuccess({ presets });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_LOGIN_REQUIRED", 401);
    const failure = toGlossaryPresetFailure(error);
    return apiError(failure.message, failure.code, failure.status);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertStrictOrigin(request);
    const { hostId } = await requireHost(request);
    const parsed = createGlossaryPresetInputSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("용어집 입력이 올바르지 않습니다.", "INVALID_GLOSSARY_PRESET", 400);
    const preset = await getGlossaryPresetService().create(hostId, parsed.data);
    return apiSuccess({ preset }, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof CsrfError) return apiError(error.message, "INVALID_ORIGIN", 403);
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_LOGIN_REQUIRED", 401);
    if (error instanceof SyntaxError) return apiError("용어집 입력이 올바르지 않습니다.", "INVALID_GLOSSARY_PRESET", 400);
    const failure = toGlossaryPresetFailure(error);
    return apiError(failure.message, failure.code, failure.status);
  }
}
