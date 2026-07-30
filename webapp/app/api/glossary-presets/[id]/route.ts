import type { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toGlossaryPresetFailure } from "@/lib/glossary-presets/errors";
import {
  deleteGlossaryPresetBodySchema,
  glossaryPresetIdSchema,
  updateGlossaryPresetBodySchema,
} from "@/lib/security/host-glossary-preset-validation";
import { getGlossaryPresetService } from "@/lib/glossary-presets/service";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { assertStrictOrigin, CsrfError } from "@/lib/security/csrf";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    assertStrictOrigin(request);
    const { hostId } = await requireHost(request);
    const { id } = await context.params;
    const parsedId = glossaryPresetIdSchema.safeParse(id);
    const body = await request.json();
    const parsed = updateGlossaryPresetBodySchema.safeParse(body);
    if (!parsed.success || !parsedId.success) {
      return apiError("용어집 입력이 올바르지 않습니다.", "INVALID_GLOSSARY_PRESET", 400);
    }
    const { version, ...input } = parsed.data;
    const preset = await getGlossaryPresetService().update(hostId, parsedId.data, version, input);
    return apiSuccess({ preset });
  } catch (error: unknown) {
    return handleFailure(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    assertStrictOrigin(request);
    const { hostId } = await requireHost(request);
    const { id } = await context.params;
    const parsedId = glossaryPresetIdSchema.safeParse(id);
    const body = await request.json();
    const parsed = deleteGlossaryPresetBodySchema.safeParse(body);
    if (!parsed.success || !parsedId.success) {
      return apiError("용어집 입력이 올바르지 않습니다.", "INVALID_GLOSSARY_PRESET", 400);
    }
    await getGlossaryPresetService().delete(hostId, parsedId.data, parsed.data.version);
    return apiSuccess({ id: parsedId.data });
  } catch (error: unknown) {
    return handleFailure(error);
  }
}

function handleFailure(error: unknown) {
  if (error instanceof CsrfError) return apiError(error.message, "INVALID_ORIGIN", 403);
  if (error instanceof AuthenticationError) return apiError(error.message, "HOST_LOGIN_REQUIRED", 401);
  if (error instanceof SyntaxError) return apiError("용어집 입력이 올바르지 않습니다.", "INVALID_GLOSSARY_PRESET", 400);
  const failure = toGlossaryPresetFailure(error);
  return apiError(failure.message, failure.code, failure.status);
}
