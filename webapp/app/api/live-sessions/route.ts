import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { LiveSessionService } from "@/lib/live/service";
import { getLiveSessionStore } from "@/lib/live/store";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { createLiveSessionInputSchema } from "@/lib/security/live-input-validation";

export async function POST(request: NextRequest) {
  try {
    const { hostId } = await requireHost(request);
    const parsed = createLiveSessionInputSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("요청 형식이 올바르지 않습니다.", "INVALID_REQUEST", 400);
    const input = parsed.data;
    const session = await new LiveSessionService(getLiveSessionStore()).create(hostId, {
      sessionType: input.sessionType,
      languages: input.languages,
      outputMode: input.outputMode,
      voiceProvider: input.voiceProvider,
      maxViewers: input.maxViewers,
      glossaryPack: input.glossaryPack,
    });
    return apiSuccess(session, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    if (error instanceof SyntaxError) return apiError("요청 형식이 올바르지 않습니다.", "INVALID_JSON", 400);
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status);
  }
}
