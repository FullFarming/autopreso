import type { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toGlossaryPresetFailure } from "@/lib/glossary-presets/errors";
import { glossaryPresetIdSchema, parseDeleteDocumentBody } from "@/lib/glossary-presets/schema";
import { getGlossaryPresetService } from "@/lib/glossary-presets/service";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { assertStrictOrigin, CsrfError } from "@/lib/security/csrf";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest) {
  try {
    assertStrictOrigin(request);
    await requireHost(request);
    return apiError("용어집 메타데이터는 문서 버전으로 변경해 주세요.", "METHOD_NOT_ALLOWED", 405, privateNoStoreHeaders());
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
    const parsed = parseDeleteDocumentBody(await readBoundedJsonBody(request));
    if (!parsed || !parsedId.success) {
      return apiError("용어집 입력이 올바르지 않습니다.", "INVALID_GLOSSARY_PRESET", 400, privateNoStoreHeaders());
    }
    await getGlossaryPresetService().delete(hostId, parsedId.data, parsed.presetVersion);
    return apiSuccess({ id: parsedId.data }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    return handleFailure(error);
  }
}

function handleFailure(error: unknown) {
  if (error instanceof BoundedJsonBodyError) return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
  if (error instanceof CsrfError) return apiError(error.message, "INVALID_ORIGIN", 403, privateNoStoreHeaders());
  if (error instanceof AuthenticationError) return apiError(error.message, "HOST_LOGIN_REQUIRED", 401, privateNoStoreHeaders());
  const failure = toGlossaryPresetFailure(error);
  return apiError(failure.message, failure.code, failure.status, privateNoStoreHeaders());
}
