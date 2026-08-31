import { after, type NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import { parseSessionId } from "@/lib/live/validation";
import { LiveSheetSyncError } from "@/lib/live-sheet-sync/errors";
import { createLiveSheetRetryService } from "@/lib/live-sheet-sync/runtime";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { assertStrictOrigin, CsrfError } from "@/lib/security/csrf";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    assertStrictOrigin(request);
    const { hostId } = await requireHost(request);
    const sessionId = parseSessionId((await context.params).id);
    const retry = await createLiveSheetRetryService(after).retryOwned(hostId, sessionId);
    return apiSuccess({ retry }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    if (error instanceof CsrfError) return failure(error.message, "INVALID_ORIGIN", 403);
    if (error instanceof AuthenticationError) return failure(error.message, "HOST_AUTH_REQUIRED", 401);
    if (error instanceof LiveSheetSyncError) return failure(error.message, error.code, error.status);
    return failure("시트 동기화 재시도를 요청할 수 없습니다.", "SHEET_SYNC_RETRY_FAILED", 500);
  }
}

function failure(error: string, code: string, status: number) {
  return apiError(error, code, status, privateNoStoreHeaders());
}
