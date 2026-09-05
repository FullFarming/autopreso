import { z } from "zod";
import { AuthenticationError, AuthorizationError, verifyViewerGrantToken, verifyRecapGrantToken,
  VIEWER_GRANT_COOKIE, RECAP_GRANT_COOKIE } from "../auth/live-auth";
import { LiveAdmissionError } from "../security/live-admission-store";
import { getSupabaseServerAccess, supabaseAdminHeaders } from "../security/supabase-server-access";
import { sourceSnapshotSchema } from "./source-contract";
import { HOST_ID_PATTERN } from "../security/host-session-policy";
import { readSessionToken, SESSION_COOKIE } from "../session";

export async function authenticateSourceSnapshotAudience(
  request: { cookies: { get(name: string): { value: string } | undefined } }, sessionId: string, audience: string | null,
): Promise<{ role: "host"; hostId: string } | { role: "participant"; userId: string; grantId: string | null }> {
  if (audience === "host") {
    const session = await readSessionToken(request.cookies.get(SESSION_COOKIE)?.value);
    if (!session) throw new AuthenticationError("호스트 로그인이 필요합니다.");
    return { role: "host", hostId: session.userId };
  }
  if (audience !== null && audience !== "participant") {
    throw new LiveAdmissionError("원문 페이지 요청이 올바르지 않습니다.", "INVALID_SOURCE_SNAPSHOT_INPUT", 400);
  }
  return { role: "participant", ...await authenticateSourceSnapshotRequest(request, sessionId) };
}

export async function authenticateSourceSnapshotRequest(
  request: { cookies: { get(name: string): { value: string } | undefined } }, sessionId: string,
): Promise<{ userId: string; grantId: string | null }> {
  const token = request.cookies.get(VIEWER_GRANT_COOKIE)?.value;
  if (token) {
    try {
      const claims = await verifyViewerGrantToken(token);
      if (claims.sessionId !== sessionId) throw new AuthorizationError("다른 라이브 세션의 입장권은 사용할 수 없습니다.");
      return { userId: claims.userId, grantId: claims.grantId };
    } catch (error: unknown) { if (!(error instanceof AuthenticationError)) throw error; }
  }
  const claims = await verifyRecapGrantToken(request.cookies.get(RECAP_GRANT_COOKIE)?.value);
  if (claims.sessionId !== sessionId) throw new AuthorizationError("다른 라이브 세션의 기록 권한은 사용할 수 없습니다.");
  return { userId: claims.userId, grantId: null };
}

export function parseSourceSnapshotQuery(params: URLSearchParams) {
  const cursor = params.get("afterSourceSeq") ?? "0";
  const size = params.get("pageSize") ?? "200";
  if (!/^(?:0|[1-9]\d{0,15})$/u.test(cursor) || !/^[1-9]\d{0,2}$/u.test(size)
    || !Number.isSafeInteger(Number(cursor)) || Number(size) > 500) {
    throw new LiveAdmissionError("원문 페이지 요청이 올바르지 않습니다.", "INVALID_SOURCE_SNAPSHOT_INPUT", 400);
  }
  return { afterSourceSeq: Number(cursor), pageSize: Number(size) };
}

const maxResponseBytes = 16 * 1024 * 1024;
const rpcFailures: Readonly<Record<string, { message: string; status: number }>> = {
  SOURCE_FORBIDDEN: { message: "이 회의의 원문을 볼 권한이 없습니다.", status: 403 },
  RECAP_EXPIRED: { message: "회의 종료 후 6시간의 열람 기간이 지났습니다.", status: 410 },
  RECAP_NOT_READY: { message: "회의 종료 기록이 아직 준비되지 않았습니다.", status: 409 },
  SOURCE_SNAPSHOT_TOO_LARGE: { message: "원문 페이지가 너무 큽니다. 페이지 크기를 줄여 주세요.", status: 413 },
  EXPORT_TOO_LARGE: { message: "원문 누락 구간 기록이 열람 용량 제한을 초과했습니다.", status: 413 },
  INVALID_SOURCE_SNAPSHOT_INPUT: { message: "원문 페이지 요청이 올바르지 않습니다.", status: 400 },
};
const unavailable = () => new LiveAdmissionError("원문 기록 응답을 확인하지 못했습니다.", "SOURCE_SNAPSHOT_UNAVAILABLE", 503);

export class SupabaseSourceSnapshotStore {
  private readonly fetchFn: typeof fetch;
  private readonly getServerAccess: typeof getSupabaseServerAccess;
  constructor(deps: { fetchFn?: typeof fetch; getServerAccess?: typeof getSupabaseServerAccess } = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.getServerAccess = deps.getServerAccess ?? getSupabaseServerAccess;
  }
  async read(sessionId: string, input: { userId: string; grantId: string | null; afterSourceSeq: number; pageSize: number }) {
    return this.readSnapshot(sessionId, input, "read_participant_live_source_snapshot_v1", {
      p_session_id: sessionId, p_user_id: input.userId, p_grant_id: input.grantId,
      p_after_source_seq: input.afterSourceSeq, p_limit: input.pageSize,
    });
  }
  async readHost(sessionId: string, input: { hostId: string; afterSourceSeq: number; pageSize: number }) {
    if (!HOST_ID_PATTERN.test(input.hostId)) throw new AuthorizationError("호스트 인증 정보가 올바르지 않습니다.");
    return this.readSnapshot(sessionId, input, "read_owned_live_source_snapshot_v1", {
      p_session_id: sessionId, p_host_id: input.hostId, p_after_source_seq: input.afterSourceSeq, p_limit: input.pageSize,
    });
  }
  private async readSnapshot(sessionId: string, input: { afterSourceSeq: number; pageSize: number }, rpc: string, body: Record<string, unknown>) {
    if (!z.uuid().safeParse(sessionId).success || !Number.isSafeInteger(input.afterSourceSeq) || input.afterSourceSeq < 0
      || !Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 500) {
      throw new LiveAdmissionError("원문 페이지 요청이 올바르지 않습니다.", "INVALID_SOURCE_SNAPSHOT_INPUT", 400);
    }
    const access = this.getServerAccess();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchFn(`${access.url}/rest/v1/rpc/${rpc}`, {
        method: "POST", cache: "no-store", redirect: "error", signal: controller.signal,
        headers: { ...supabaseAdminHeaders(access.credential), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.body || Number(response.headers.get("content-length")) > maxResponseBytes) throw unavailable();
      const reader = response.body.getReader(); const decoder = new TextDecoder();
      let bytes = 0; let text = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxResponseBytes) { await reader.cancel(); throw unavailable(); }
          text += decoder.decode(value, { stream: true });
        }
      } finally { reader.releaseLock(); }
      const payload: unknown = JSON.parse(text + decoder.decode());
      if (!response.ok) {
        const parsed = z.object({ message: z.string() }).safeParse(payload);
        const known = parsed.success ? rpcFailures[parsed.data.message] : undefined;
        if (known && parsed.success) throw new LiveAdmissionError(known.message, parsed.data.message, known.status);
        throw unavailable();
      }
      const parsed = sourceSnapshotSchema.safeParse(payload);
      if (!parsed.success || parsed.data.sessionId !== sessionId || parsed.data.sources.length > input.pageSize
        || parsed.data.sources.some((source) => source.sourceSeq <= input.afterSourceSeq)) throw unavailable();
      return parsed.data;
    } catch (error: unknown) {
      if (error instanceof LiveAdmissionError) throw error;
      throw unavailable();
    } finally { clearTimeout(timeout); }
  }
}
