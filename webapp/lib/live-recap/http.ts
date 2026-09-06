import { createHash } from "node:crypto";
import { AuthenticationError, AuthorizationError } from "../auth/live-auth";
import { LiveRecordsError } from "../live-records/errors";
import { LiveSessionError, toLiveFailure } from "../live/errors";
import { apiError } from "../security/api-response";
import { BoundedJsonBodyError } from "../security/bounded-json-body";
import { CsrfError } from "../security/csrf";
import { LiveAdmissionError, type SupabaseLiveAdmissionStore } from "../security/live-admission-store";
import { privateNoStoreHeaders } from "../security/live-topic-validation";
import { LiveRecapService } from "./service";
import { SupabaseLiveRecapStore } from "./store";

export function createLiveRecapService(): LiveRecapService {
  return new LiveRecapService(new SupabaseLiveRecapStore());
}

export function recapRouteError(error: unknown) {
  if (error instanceof CsrfError) return apiError(error.message, "CSRF_ORIGIN_FORBIDDEN", 403, privateNoStoreHeaders());
  if (error instanceof AuthenticationError) return apiError("인증을 확인해 주세요.", "AUTH_REQUIRED", 401, privateNoStoreHeaders());
  if (error instanceof AuthorizationError) return apiError("이 회의 기록에 접근할 권한이 없습니다.", "RECAP_FORBIDDEN", 403, privateNoStoreHeaders());
  if (error instanceof LiveRecordsError || error instanceof LiveAdmissionError || error instanceof LiveSessionError || error instanceof BoundedJsonBodyError) {
    return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
  }
  const failure = toLiveFailure(error);
  if (failure.body.code === "SECURITY_NOT_CONFIGURED") {
    return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
  }
  return apiError("회의 기록 요청을 처리하지 못했습니다. 다시 확인해 주세요.", "RECAP_REQUEST_FAILED", 500, privateNoStoreHeaders());
}

export async function enforceRecordExportRateLimit(hostId: string, store: SupabaseLiveAdmissionStore): Promise<void> {
  const keyHash = createHash("sha256").update(`live-record-export\0${hostId}`).digest("hex");
  const allowed = await store.consumeRateLimit({ scope: "live-record-export", keyHash, limit: 3, windowSeconds: 60 });
  if (!allowed) throw new LiveRecordsError("내보내기 요청이 많습니다. 잠시 후 다시 시도해 주세요.", "EXPORT_RATE_LIMITED", 429);
}

export function recordExportPrepared(hostId: string, sessionId: string, snapshotId: string, byteLength: number): void {
  const actorHash = createHash("sha256").update(hostId).digest("hex");
  console.info(JSON.stringify({ event: "live_record_export_prepared", actorHash, sessionId, snapshotId, byteLength }));
}
