import { createHash, randomBytes } from "node:crypto";

import { getSupabasePublicAccess, getSupabaseServerAccess, supabaseAdminHeaders } from "../security/supabase-server-access";

export type ProfileStatus = "pending" | "approved" | "rejected" | "disabled";
export type ProfileRole = "host" | "admin";
export interface ProfileRecord { id: string; email: string; displayName: string | null; status: ProfileStatus; role: ProfileRole; hostId: string; }
export interface VerifiedAuthUser { id: string; email: string; emailConfirmed: boolean; displayName: string | null; }

export class ProfileStoreError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ProfileStoreError";
    this.code = code;
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STATUSES = new Set<ProfileStatus>(["pending", "approved", "rejected", "disabled"]);
const ROLES = new Set<ProfileRole>(["host", "admin"]);
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CODE_PATTERN = /^[0-9a-f]{64}$/u;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function mapProfileRow(row: unknown): ProfileRecord & { created: boolean } {
  if (!isRecord(row) || typeof row.id !== "string" || !UUID.test(row.id) || typeof row.email !== "string"
    || typeof row.host_id !== "string" || !STATUSES.has(row.status as ProfileStatus) || !ROLES.has(row.role as ProfileRole)) {
    throw new ProfileStoreError("프로필 응답이 올바르지 않습니다.", "PROFILE_ROW_INVALID", 502);
  }
  return {
    id: row.id, email: row.email, displayName: typeof row.display_name === "string" ? row.display_name : null,
    status: row.status as ProfileStatus, role: row.role as ProfileRole, hostId: row.host_id, created: row.created === true,
  };
}

export class SupabaseProfileStore {
  private readonly fetchFn: typeof fetch;
  private readonly getServerAccess: typeof getSupabaseServerAccess;
  private readonly getPublicAccess: typeof getSupabasePublicAccess;

  constructor(deps: { fetchFn?: typeof fetch; getServerAccess?: typeof getSupabaseServerAccess; getPublicAccess?: typeof getSupabasePublicAccess } = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.getServerAccess = deps.getServerAccess ?? getSupabaseServerAccess;
    this.getPublicAccess = deps.getPublicAccess ?? getSupabasePublicAccess;
  }

  async verifyAccessToken(accessToken: string): Promise<VerifiedAuthUser> {
    if (typeof accessToken !== "string" || accessToken.length < 20 || accessToken.length > 4096 || /\s/u.test(accessToken)) {
      throw new ProfileStoreError("인증 토큰이 올바르지 않습니다.", "AUTH_TOKEN_INVALID", 401);
    }
    const { url, publishableKey } = this.getPublicAccess();
    let response: Response;
    try {
      response = await this.fetchFn(`${url}/auth/v1/user`, {
        method: "GET", cache: "no-store",
        headers: { apikey: publishableKey, authorization: `Bearer ${accessToken}`, accept: "application/json" },
      });
    } catch { throw new ProfileStoreError("인증 서비스에 연결할 수 없습니다.", "AUTH_SERVICE_UNAVAILABLE", 503); }
    if (response.status === 401 || response.status === 403) throw new ProfileStoreError("인증 토큰이 올바르지 않습니다.", "AUTH_TOKEN_INVALID", 401);
    if (!response.ok) throw new ProfileStoreError("인증 서비스를 사용할 수 없습니다.", "AUTH_SERVICE_UNAVAILABLE", 503);
    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body) || typeof body.id !== "string" || !UUID.test(body.id)) throw new ProfileStoreError("인증 토큰이 올바르지 않습니다.", "AUTH_TOKEN_INVALID", 401);
    if (typeof body.email !== "string" || !body.email.includes("@")) throw new ProfileStoreError("이메일이 없는 계정은 사용할 수 없습니다.", "AUTH_EMAIL_MISSING", 403);
    const metadata = isRecord(body.user_metadata) ? body.user_metadata : {};
    const rawName = [metadata.full_name, metadata.name].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    return {
      id: body.id, email: body.email.trim().toLowerCase(),
      emailConfirmed: typeof body.email_confirmed_at === "string" || typeof body.confirmed_at === "string",
      displayName: rawName ? rawName.trim().slice(0, 80) : null,
    };
  }

  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { url, credential } = this.getServerAccess();
    let response: Response;
    try {
      response = await this.fetchFn(`${url}/rest/v1/rpc/${name}`, {
        method: "POST", cache: "no-store",
        headers: { ...supabaseAdminHeaders(credential), "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(args),
      });
    } catch { throw new ProfileStoreError("프로필 저장소에 연결할 수 없습니다.", "PROFILE_STORE_UNAVAILABLE", 503); }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new ProfileStoreError("프로필 저장소를 사용할 수 없습니다.", "PROFILE_STORE_UNAVAILABLE", 503);
    return body;
  }

  async upsertOnLogin(input: { user: VerifiedAuthUser; bootstrap: boolean; legacyHostId: string | null }): Promise<ProfileRecord & { created: boolean }> {
    const rows = await this.rpc("upsert_profile_on_login_v1", {
      p_user_id: input.user.id, p_email: input.user.email, p_display_name: input.user.displayName,
      p_bootstrap: input.bootstrap, p_legacy_host_id: input.bootstrap ? input.legacyHostId : null,
    });
    if (!Array.isArray(rows) || rows.length !== 1) throw new ProfileStoreError("프로필 응답이 올바르지 않습니다.", "PROFILE_ROW_INVALID", 502);
    return mapProfileRow(rows[0]);
  }

  async readByHostId(hostId: string): Promise<ProfileRecord | null> {
    const rows = await this.rpc("read_profile_by_host_id_v1", { p_host_id: hostId });
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const { created: _created, ...profile } = mapProfileRow({ ...(rows[0] as object), created: false });
    return profile;
  }

  async issueDesktopCode(input: { profileId: string; state: string; expiresAt: Date }): Promise<string> {
    if (!STATE_PATTERN.test(input.state)) throw new ProfileStoreError("로그인 상태 값이 올바르지 않습니다.", "DESKTOP_STATE_INVALID", 400);
    const code = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(Buffer.from(code, "hex")).digest("hex");
    const ok = await this.rpc("issue_desktop_login_code_v1", {
      p_code_hash: `\\x${hash}`, p_profile_id: input.profileId, p_state: input.state, p_expires_at: input.expiresAt.toISOString(),
    });
    if (ok !== true) throw new ProfileStoreError("데스크톱 로그인 코드를 만들지 못했습니다.", "DESKTOP_CODE_ISSUE_FAILED", 503);
    return code;
  }

  async consumeDesktopCode(input: { code: string; state: string }): Promise<{ profileId: string; hostId: string; status: ProfileStatus } | null> {
    if (!CODE_PATTERN.test(input.code) || !STATE_PATTERN.test(input.state)) throw new ProfileStoreError("데스크톱 로그인 코드가 올바르지 않습니다.", "DESKTOP_CODE_INVALID", 401);
    const hash = createHash("sha256").update(Buffer.from(input.code, "hex")).digest("hex");
    const rows = await this.rpc("consume_desktop_login_code_v1", { p_code_hash: `\\x${hash}`, p_state: input.state });
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    if (!isRecord(row) || typeof row.profile_id !== "string" || typeof row.host_id !== "string" || !STATUSES.has(row.status as ProfileStatus)) {
      throw new ProfileStoreError("프로필 응답이 올바르지 않습니다.", "PROFILE_ROW_INVALID", 502);
    }
    return { profileId: row.profile_id, hostId: row.host_id, status: row.status as ProfileStatus };
  }
}
