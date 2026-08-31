import type { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toGlossaryPresetFailure } from "@/lib/glossary-presets/errors";
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

export async function GET(request: NextRequest) {
  try {
    const { hostId } = await requireHost(request);
    const presets = await getGlossaryPresetService().list(hostId);
    return apiSuccess({ presets }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_LOGIN_REQUIRED", 401, privateNoStoreHeaders());
    const failure = toGlossaryPresetFailure(error);
    return apiError(failure.message, failure.code, failure.status, privateNoStoreHeaders());
  }
}

export async function POST(request: NextRequest) {
  try {
    assertStrictOrigin(request);
    const { hostId } = await requireHost(request);
    assertGlossaryJsonContentType(request.headers);
    assertGlossaryJsonContentLength(request.headers);
    const document = parseGlossaryDocumentImportBody(await request.text());
    const preset = await getGlossaryPresetService().create(hostId, document);
    return apiSuccess({ preset }, { status: 201, headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    if (error instanceof CsrfError) return apiError(error.message, "INVALID_ORIGIN", 403, privateNoStoreHeaders());
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_LOGIN_REQUIRED", 401, privateNoStoreHeaders());
    if (error instanceof HostGlossaryPresetValidationError) {
      return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    }
    const failure = toGlossaryPresetFailure(error);
    return apiError(failure.message, failure.code, failure.status, privateNoStoreHeaders());
  }
}
