import type { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toGlossaryPresetFailure } from "@/lib/glossary-presets/errors";
import { glossaryPresetIdSchema, parseDuplicateDocumentBody } from "@/lib/glossary-presets/schema";
import { getGlossaryPresetService } from "@/lib/glossary-presets/service";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { assertStrictOrigin, CsrfError } from "@/lib/security/csrf";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    assertStrictOrigin(request);
    const { hostId } = await requireHost(request);
    const parsedId = glossaryPresetIdSchema.safeParse((await context.params).id);
    const body = parseDuplicateDocumentBody(await readBoundedJsonBody(request));
    if (!parsedId.success || !body) return invalidInput();
    const preset = await getGlossaryPresetService().duplicate(hostId, parsedId.data, body.documentVersion, body.name);
    return apiSuccess({ preset }, { status: 201, headers: privateNoStoreHeaders() });
  } catch (error: unknown) { return handleFailure(error); }
}

function invalidInput() { return apiError("용어집 입력이 올바르지 않습니다.", "INVALID_GLOSSARY_PRESET", 400, privateNoStoreHeaders()); }
function handleFailure(error: unknown) {
  if (error instanceof BoundedJsonBodyError) return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
  if (error instanceof CsrfError) return apiError(error.message, "INVALID_ORIGIN", 403, privateNoStoreHeaders());
  if (error instanceof AuthenticationError) return apiError(error.message, "HOST_LOGIN_REQUIRED", 401, privateNoStoreHeaders());
  const failure = toGlossaryPresetFailure(error);
  return apiError(failure.message, failure.code, failure.status, privateNoStoreHeaders());
}
