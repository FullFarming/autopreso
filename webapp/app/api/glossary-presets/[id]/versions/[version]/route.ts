import type { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toGlossaryPresetFailure } from "@/lib/glossary-presets/errors";
import { glossaryPresetIdSchema, parsePositiveVersionText } from "@/lib/glossary-presets/schema";
import { getGlossaryPresetService } from "@/lib/glossary-presets/service";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

interface RouteContext { params: Promise<{ id: string; version: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { hostId } = await requireHost(request);
    const params = await context.params;
    const parsedId = glossaryPresetIdSchema.safeParse(params.id);
    const version = parsePositiveVersionText(params.version);
    if (!parsedId.success || !version) {
      return apiError("용어집 버전이 올바르지 않습니다.", "INVALID_GLOSSARY_PRESET", 400, privateNoStoreHeaders());
    }
    const record = await getGlossaryPresetService().exportVersion(hostId, parsedId.data, version);
    return apiSuccess(record, { headers: {
      ...privateNoStoreHeaders(),
      "Content-Disposition": `attachment; filename="glossary-${parsedId.data}-v${version}.json"`,
    } });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_LOGIN_REQUIRED", 401, privateNoStoreHeaders());
    const failure = toGlossaryPresetFailure(error);
    return apiError(failure.message, failure.code, failure.status, privateNoStoreHeaders());
  }
}
