import type { NextRequest } from "next/server";
import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { captionEngineAvailability, resolveHostEngineAssignment } from "@/lib/console/engine-defaults";
import { apiError, apiSuccess } from "@/lib/security/api-response";

export const dynamic = "force-dynamic";
const HEADERS = { "cache-control": "private, no-store", vary: "Cookie" };

export async function GET(request: NextRequest) {
  try {
    const { hostId } = await requireHost(request);
    const { engine, assignmentRevision } = await resolveHostEngineAssignment(hostId);
    return apiSuccess({
      gatewayUrl: process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL ?? "",
      engineDefaults: engine,
      assignmentRevision,
      captionEngines: captionEngineAvailability(),
    }, { headers: HEADERS });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401, HEADERS);
    return apiError("배정된 자막 엔진을 확인할 수 없습니다. 다시 시도해 주세요.", "ENGINE_ASSIGNMENT_UNAVAILABLE", 503, HEADERS);
  }
}
