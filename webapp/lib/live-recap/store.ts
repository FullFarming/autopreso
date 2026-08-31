import { z } from "zod";
import { getSupabaseServerAccess, supabaseAdminHeaders } from "../security/supabase-server-access";
import { LiveRecordsError } from "../live-records/errors";
import { hostRecapRequestSchema, recapRecipientsSchema, recapRequestSchema, recordExportSnapshotSchema, recordingGapsSchema, type RecapRequestInput } from "./contract";
import type { LiveRecapStore } from "./service";

const MAX_RPC_BYTES = 16 * 1024 * 1024;
const RPC_TIMEOUT_MS = 15_000;
const RPC_ERRORS: Readonly<Record<string, { message: string; status: number }>> = {
  RECAP_EXPIRED: { message: "원문과 요약의 열람 기간이 끝났어요.", status: 410 },
  RECAP_ACCESS_EXPIRED: { message: "원문과 요약의 열람 기간이 끝났어요.", status: 410 },
  RECAP_FORBIDDEN: { message: "이 회의의 수신 신청을 확인할 권한이 없습니다.", status: 403 },
  RECAP_NOT_READY: { message: "회의 종료 후 수신을 신청할 수 있습니다.", status: 409 },
  RECAP_EMAIL_REQUIRED: { message: "등록된 이메일을 확인해 주세요.", status: 409 },
  RECAP_NOTICE_INVALID: { message: "수신 신청 안내를 다시 확인해 주세요.", status: 400 },
  INVALID_RECAP_REQUEST: { message: "수신 신청 안내를 다시 확인해 주세요.", status: 400 },
  RECAP_REQUEST_CONFLICT: { message: "수신 신청 상태가 변경됐어요. 다시 확인해 주세요.", status: 409 },
  LIVE_RECORD_NOT_FOUND: { message: "라이브콜 기록을 찾을 수 없습니다.", status: 404 },
  EXPORT_NOT_READY: { message: "회의 종료 후 전체 기록을 내보낼 수 있습니다.", status: 409 },
  LIVE_TRANSCRIPT_NOT_READY: { message: "회의 종료 후 전체 기록을 내보낼 수 있습니다.", status: 409 },
  EXPORT_TOO_LARGE: { message: "회의 기록이 내보내기 용량 제한을 초과했습니다. 일부만 저장하지 않았습니다.", status: 413 },
};

const participantRequestProjection = hostRecapRequestSchema.transform((request) => recapRequestSchema.parse({
  id: request.id, sessionId: request.sessionId, requestedAt: request.requestedAt, noticeVersion: request.noticeVersion,
  status: request.status, email: request.email, revision: request.revision,
}));

export class SupabaseLiveRecapStore implements LiveRecapStore {
  private readonly fetchFn: typeof fetch;
  private readonly getServerAccess: typeof getSupabaseServerAccess;

  constructor(deps: { fetchFn?: typeof fetch; getServerAccess?: typeof getSupabaseServerAccess } = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.getServerAccess = deps.getServerAccess ?? getSupabaseServerAccess;
  }

  async request(sessionId: string, userId: string, input: RecapRequestInput) {
    return this.rpc("request_live_recap_v1", {
      p_session_id: sessionId, p_user_id: userId, p_notice_version: input.noticeVersion,
      p_idempotency_key: input.idempotencyKey,
    }, participantRequestProjection);
  }

  async readRequest(sessionId: string, userId: string) {
    return this.rpc("read_live_recap_request_v1", { p_session_id: sessionId, p_user_id: userId }, participantRequestProjection.nullable());
  }

  async readRecipients(sessionId: string, hostId: string) {
    return this.rpc("read_owned_live_recap_requests_v1", { p_session_id: sessionId, p_host_id: hostId }, recapRecipientsSchema);
  }

  async readExportSnapshot(sessionId: string, hostId: string) {
    return this.rpc("read_owned_live_record_export_v1", { p_session_id: sessionId, p_host_id: hostId }, recordExportSnapshotSchema);
  }

  async readHostRecordingGaps(sessionId: string, hostId: string) {
    return this.rpc("read_owned_live_recording_gaps_v1", { p_session_id: sessionId, p_host_id: hostId }, recordingGapsSchema);
  }

  async readParticipantRecordingGaps(sessionId: string, userId: string) {
    return this.rpc("read_participant_live_recording_gaps_v1", { p_session_id: sessionId, p_user_id: userId }, recordingGapsSchema);
  }

  private async rpc<T>(name: string, body: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const access = this.getServerAccess();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const response = await this.fetchFn(`${access.url}/rest/v1/rpc/${name}`, {
        method: "POST", cache: "no-store", redirect: "error", signal: controller.signal,
        headers: { ...supabaseAdminHeaders(access.credential), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await readBoundedRpcJson(response);
      if (!response.ok) throw safeRpcError(payload);
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw unavailable();
      return parsed.data;
    } catch (error: unknown) {
      if (error instanceof LiveRecordsError) throw error;
      throw unavailable();
    } finally { clearTimeout(timeout); }
  }
}

async function readBoundedRpcJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_RPC_BYTES) throw exportTooLarge();
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RPC_BYTES) { await reader.cancel(); throw exportTooLarge(); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

function safeRpcError(payload: unknown): LiveRecordsError {
  const parsed = z.object({ message: z.string() }).safeParse(payload);
  const code = parsed.success ? parsed.data.message : "";
  const known = RPC_ERRORS[code];
  return known ? new LiveRecordsError(known.message, code, known.status) : unavailable();
}

function exportTooLarge(): LiveRecordsError {
  return new LiveRecordsError(RPC_ERRORS.EXPORT_TOO_LARGE.message, "EXPORT_TOO_LARGE", 413);
}

function unavailable(): LiveRecordsError {
  return new LiveRecordsError("회의 기록 요청을 처리하지 못했습니다. 다시 확인해 주세요.", "RECAP_STORE_UNAVAILABLE", 503);
}
