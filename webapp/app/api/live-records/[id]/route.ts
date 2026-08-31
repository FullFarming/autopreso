import { after, NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { toLiveFailure } from "@/lib/live/errors";
import { parseSessionId } from "@/lib/live/validation";
import { getLiveRecordsStore } from "@/lib/live-records/runtime";
import { LiveRecordsError, LiveRecordsService } from "@/lib/live-records/service";
import { scheduleLiveSheetSyncAfterCommit } from "@/lib/live-sheet-sync/runtime";
import { SummaryError } from "@/lib/live/summary";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { hostId } = await requireHost(request);
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const service = new LiveRecordsService(getLiveRecordsStore());
    const detail = await service.getDetail(hostId, sessionId, {
      language: request.nextUrl.searchParams.get("language"),
    });
    return apiSuccess({ detail }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    return liveRecordRouteError(error, "라이브콜 기록을 읽을 수 없습니다.", "LIVE_RECORD_READ_FAILED");
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { hostId } = await requireHost(_request);
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const service = new LiveRecordsService(getLiveRecordsStore());
    const archive = await service.softDelete(hostId, sessionId);
    scheduleLiveSheetSyncAfterCommit(after);
    return apiSuccess({ archive }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    return liveRecordRouteError(error, "라이브콜 기록을 삭제 처리할 수 없습니다.", "LIVE_RECORD_DELETE_FAILED");
  }
}

function liveRecordRouteError(error: unknown, fallback: string, code: string) {
  if (error instanceof AuthenticationError) {
    return apiError(error.message, "HOST_AUTH_REQUIRED", 401, privateNoStoreHeaders());
  }
  if (error instanceof LiveRecordsError) {
    return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
  }
  if (error instanceof SummaryError) {
    return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
  }
  const failure = toLiveFailure(error);
  if (failure.body.code !== "LIVE_FAILED") {
    return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
  }
  return apiError(fallback, code, 500, privateNoStoreHeaders());
}
