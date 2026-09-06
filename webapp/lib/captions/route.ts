import type { NextRequest } from "next/server";
import { AuthenticationError, requireHost } from "../auth/live-auth";
import { apiError, apiSuccess } from "../security/api-response";
import { BoundedJsonBodyError, readBoundedJsonBody } from "../security/bounded-json-body";
import { assertStrictOrigin, CsrfError } from "../security/csrf";
import { CaptionBrokerError } from "./broker";
import { getCaptionBroker } from "./runtime";

const HEADERS = { "cache-control": "private, no-store", vary: "Cookie" };
export function createCaptionHandler(operation: "start" | "renew" | "credentials" | "translate" | "stop") {
  return async function POST(request: NextRequest) {
    try {
      assertStrictOrigin(request);
      const { hostId } = await requireHost(request);
      const body = await readBoundedJsonBody(request, 131_072);
      const result = await getCaptionBroker()[operation](hostId, body);
      return apiSuccess(result, { headers: HEADERS });
    } catch (error: unknown) {
      if (error instanceof CsrfError) return apiError("허용되지 않은 요청 출처입니다.", "CSRF_REJECTED", 403, HEADERS);
      if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401, HEADERS);
      if (error instanceof BoundedJsonBodyError) return apiError(error.message, error.code, error.status, HEADERS);
      if (error instanceof CaptionBrokerError) return apiError(error.message, error.code, error.status,
        error.status === 429 ? { ...HEADERS, "retry-after": "60" } : HEADERS);
      return apiError("자막 서비스를 사용할 수 없습니다.", "CAPTION_SERVICE_UNAVAILABLE", 503, HEADERS);
    }
  };
}
