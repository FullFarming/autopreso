import { timingSafeEqual } from "node:crypto";

import { prewarmScheduledLiveGateway } from "@/lib/live/gateway-prewarm";
import { getLiveSessionStore } from "@/lib/live/store";
import { apiError, apiSuccess } from "@/lib/security/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(request: Request): boolean {
  const secret = String(process.env.CRON_SECRET ?? "");
  const authorization = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (secret.length < 32 || authorization.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(authorization), Buffer.from(expected));
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return apiError("예약 기동 권한이 없습니다.", "CRON_UNAUTHORIZED", 401);
  const gatewayUrl = String(process.env.LIVE_GATEWAY_URL ?? process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL ?? "").trim();
  if (!gatewayUrl) return apiError("라이브 게이트웨이 주소가 설정되지 않았습니다.", "LIVE_GATEWAY_URL_REQUIRED", 503);
  try {
    const result = await prewarmScheduledLiveGateway({
      store: getLiveSessionStore(),
      gatewayUrl,
    });
    return apiSuccess(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "LIVE_GATEWAY_PREWARM_FAILED";
    return apiError("예약 라이브 게이트웨이를 준비하지 못했습니다.", code, 503);
  }
}
