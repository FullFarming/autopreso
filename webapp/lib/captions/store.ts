import { getSupabaseServerAccess, supabaseAdminHeaders } from "../security/supabase-server-access";
import type { EngineSelection } from "../live/model-preferences";
import { CaptionBrokerError } from "./broker";

export interface ManagedCaptionSession {
  engine: EngineSelection; assignmentRevision: string; languages: string[]; expiresAt: string;
}
export interface ManagedCaptionSessions {
  create(input: { sessionId: string; hostId: string; engine: EngineSelection; assignmentRevision: string; languages: string[] }): Promise<string>;
  read(sessionId: string, hostId: string): Promise<ManagedCaptionSession | null>;
  renew(sessionId: string, hostId: string): Promise<string | null>;
  stop(sessionId: string, hostId: string): Promise<boolean>;
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export class SupabaseManagedCaptionSessions implements ManagedCaptionSessions {
  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { url, credential } = getSupabaseServerAccess();
    let response: Response;
    try {
      response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
        headers: { ...supabaseAdminHeaders(credential), "content-type": "application/json" }, body: JSON.stringify(args) });
    } catch { throw new CaptionBrokerError("자막 세션 저장소에 연결할 수 없습니다.", "CAPTION_SESSION_STORE_UNAVAILABLE", 503); }
    if (!response.ok) throw new CaptionBrokerError("자막 세션 권한을 확인할 수 없습니다.", "CAPTION_SESSION_STORE_UNAVAILABLE", 503);
    return response.json();
  }
  async create(input: { sessionId: string; hostId: string; engine: EngineSelection; assignmentRevision: string; languages: string[] }): Promise<string> {
    const value = await this.rpc("create_managed_caption_session_v1", {
      p_session_id: input.sessionId, p_host_id: input.hostId, p_engine: input.engine,
      p_assignment_revision: input.assignmentRevision, p_languages: input.languages,
    });
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new CaptionBrokerError("자막 세션을 생성할 수 없습니다.", "CAPTION_SESSION_STORE_UNAVAILABLE", 503);
    return value;
  }
  async read(sessionId: string, hostId: string): Promise<ManagedCaptionSession | null> {
    const rows = await this.rpc("read_managed_caption_session_v1", { p_session_id: sessionId, p_host_id: hostId });
    if (!Array.isArray(rows) || rows.length > 1) throw new CaptionBrokerError("자막 세션 응답이 올바르지 않습니다.", "CAPTION_SESSION_STORE_UNAVAILABLE", 503);
    if (!rows.length) return null;
    const row = rows[0];
    if (!isRecord(row) || !isRecord(row.engine) || typeof row.assignment_revision !== "string" || !Array.isArray(row.languages)
      || !row.languages.every((value) => typeof value === "string") || typeof row.expires_at !== "string" || !Number.isFinite(Date.parse(row.expires_at))) {
      throw new CaptionBrokerError("자막 세션 응답이 올바르지 않습니다.", "CAPTION_SESSION_STORE_UNAVAILABLE", 503);
    }
    // The signed ticket comparison in the broker validates the stored engine before use.
    return { engine: row.engine as unknown as EngineSelection, assignmentRevision: row.assignment_revision, languages: row.languages, expiresAt: row.expires_at };
  }
  async renew(sessionId: string, hostId: string): Promise<string | null> {
    const value = await this.rpc("renew_managed_caption_session_v1", { p_session_id: sessionId, p_host_id: hostId });
    if (value === null) return null;
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new CaptionBrokerError("자막 세션 갱신 응답이 올바르지 않습니다.", "CAPTION_SESSION_STORE_UNAVAILABLE", 503);
    return value;
  }
  async stop(sessionId: string, hostId: string): Promise<boolean> {
    const value = await this.rpc("stop_managed_caption_session_v1", { p_session_id: sessionId, p_host_id: hostId });
    if (typeof value !== "boolean") throw new CaptionBrokerError("자막 종료 응답이 올바르지 않습니다.", "CAPTION_SESSION_STORE_UNAVAILABLE", 503);
    return value;
  }
}
