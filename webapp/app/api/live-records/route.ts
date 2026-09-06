import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { LiveRecordsError, LiveRecordsService } from "@/lib/live-records/service";
import { getLiveRecordsStore } from "@/lib/live-records/runtime";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export async function GET(request: NextRequest) {
  try {
    const { hostId } = await requireHost(request);
    const service = new LiveRecordsService(getLiveRecordsStore());
    const page = await service.list(hostId, {
      page: request.nextUrl.searchParams.get("page"),
      pageSize: request.nextUrl.searchParams.get("pageSize"),
      search: request.nextUrl.searchParams.get("search"),
    });
    return apiSuccess({ page }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      return apiError(error.message, "HOST_AUTH_REQUIRED", 401, privateNoStoreHeaders());
    }
    if (error instanceof LiveRecordsError) {
      return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    }
    return apiError("라이브콜 기록 목록을 읽을 수 없습니다.", "LIVE_RECORDS_LIST_FAILED", 500, privateNoStoreHeaders());
  }
}
