import type { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toGlossaryPresetFailure } from "@/lib/glossary-presets/errors";
import { glossaryPresetIdSchema, parsePositiveVersionText } from "@/lib/glossary-presets/schema";
import { getGlossaryPresetService } from "@/lib/glossary-presets/service";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { assertStrictOrigin, CsrfError } from "@/lib/security/csrf";
import {
  assertGlossaryJsonContentLength,
  assertGlossaryJsonContentType,
  HostGlossaryPresetValidationError,
  parseGlossaryDocumentImportBody,
} from "@/lib/security/host-glossary-preset-validation";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { hostId } = await requireHost(request);
    const parsedId = glossaryPresetIdSchema.safeParse((await context.params).id);
    if (!parsedId.success) return invalidInput();
    return apiSuccess(
      { versions: await getGlossaryPresetService().listVersions(hostId, parsedId.data) },
      { headers: privateNoStoreHeaders() },
    );
  } catch (error: unknown) { return handleFailure(error); }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    assertStrictOrigin(request);
    const { hostId } = await requireHost(request);
    const parsedId = glossaryPresetIdSchema.safeParse((await context.params).id);
    const presetVersionText = request.nextUrl.searchParams.get("presetVersion");
    const presetVersion = presetVersionText ? parsePositiveVersionText(presetVersionText) : null;
    if (!parsedId.success || !presetVersion) return invalidInput();
    assertGlossaryJsonContentType(request.headers);
    assertGlossaryJsonContentLength(request.headers);
    const document = parseGlossaryDocumentImportBody(await request.text());
    const version = await getGlossaryPresetService().saveVersion(hostId, parsedId.data, presetVersion, document);
    return apiSuccess({ version }, { status: 201, headers: privateNoStoreHeaders() });
  } catch (error: unknown) { return handleFailure(error); }
}

function invalidInput() {
  return apiError("용어집 입력이 올바르지 않습니다.", "INVALID_GLOSSARY_PRESET", 400, privateNoStoreHeaders());
}

function handleFailure(error: unknown) {
  if (error instanceof CsrfError) return apiError(error.message, "INVALID_ORIGIN", 403, privateNoStoreHeaders());
  if (error instanceof AuthenticationError) return apiError(error.message, "HOST_LOGIN_REQUIRED", 401, privateNoStoreHeaders());
  if (error instanceof HostGlossaryPresetValidationError) return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
  const failure = toGlossaryPresetFailure(error);
  return apiError(failure.message, failure.code, failure.status, privateNoStoreHeaders());
}
