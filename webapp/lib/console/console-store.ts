import type { ProfileRecord, ProfileRole, ProfileStatus } from "../auth/profile-store";
import { getSupabaseServerAccess, supabaseAdminHeaders } from "../security/supabase-server-access";
import { EngineSelectionError, normalizeEngineSelection } from "../../../packages/caption-core/caption-engine-catalog.js";
import type { EngineSelection } from "./engine-defaults";

export interface ConsoleProfileRow extends ProfileRecord { createdAt: string; lastLoginAt: string | null; approvedAt: string | null; voiceProvider?: "soniox" | "gemini"; voiceProviderRevision?: string }
export type ConsoleSummaryStatus = "failed" | "succeeded" | "running" | null;
export interface ConsoleSessionRow {
  id: string; title: string | null; hostId: string; hostEmail: string | null; mode: string; status: string; languages: string[];
  createdAt: string; endedAt: string | null; utteranceCount: number; participantCount: number; summaryStatus: ConsoleSummaryStatus;
}
export interface ConsoleSettings { legacyPasswordLoginEnabled: boolean; engine: unknown; engineUpdatedAt: string | null; engineUpdatedByEmail: string | null }
export interface ProfileMutationResult { id: string; status: ProfileStatus; role: ProfileRole }
export type VoiceProvider = "soniox" | "gemini";
/** `set_profile_voice_provider_v2`: the profile identity the route answers with plus the assignment it now holds. */
export interface VoiceProviderMutationResult extends ProfileMutationResult { hostId: string; provider: VoiceProvider; revision: string }
/** A session the per-user switch targets: `list_live_session_ids_for_host_admin_v1` returns that host's preparing/live, not archived. */
export interface ActiveSessionRow { id: string; status: string; languages: string[] }
/** Row returned by `set_live_session_engine_admin_v2`; `version` is the bumped value. */
export interface SessionEngineSwitchResult { id: string; status: string; version: number }
/** Per-deploy outcome counters (spec §9 감사); the route derives them from the per-session results. */
export interface EngineDeploySummary { switched: number; queued: number; failed: number }
/** The user a deploy targeted, recorded next to the counters so the audit row names who was switched. */
export interface EngineDeployTarget { profileId: string; hostId: string; voiceProvider: VoiceProvider; revision: string }

export class ConsoleStoreError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ConsoleStoreError";
    this.code = code;
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STATUSES = new Set<ProfileStatus>(["pending", "approved", "rejected", "disabled"]);
const ROLES = new Set<ProfileRole>(["host", "admin"]);
const SUMMARY_STATUSES = new Set<string>(["failed", "succeeded", "running"]);
const ASSIGNMENT_REVISION = /^[1-9][0-9]{0,18}$/u;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optionalString = (v: unknown): string | null => (typeof v === "string" ? v : null);
const rowInvalid = () => new ConsoleStoreError("콘솔 응답이 올바르지 않습니다.", "CONSOLE_ROW_INVALID", 502);

// PostgREST forwards `raise exception '<TOKEN>' using errcode = '<sqlstate>'` as
// `{ "message": "<TOKEN>", "code": "<sqlstate>" }` with a 4xx derived from the sqlstate.
// The HTTP status it picks is not the one the console wants (42501 → 403 for a
// last-admin guard), so the token, not the transport status, decides.
const KNOWN_FAILURES: Record<string, [string, number]> = {
  ACTOR_NOT_ADMIN: ["관리자 권한이 필요합니다.", 403],
  SELF_CHANGE_FORBIDDEN: ["자기 자신의 상태나 역할은 바꿀 수 없습니다.", 403],
  LAST_ADMIN_PROTECTED: ["마지막 관리자는 강등하거나 비활성화할 수 없습니다.", 409],
  INVALID_TRANSITION: ["허용되지 않은 상태 변경입니다.", 409],
  PROFILE_NOT_FOUND: ["사용자를 찾을 수 없습니다.", 404],
  INVALID_ROLE: ["역할 값이 올바르지 않습니다.", 400],
  ENGINE_INVALID: ["엔진 설정이 올바르지 않습니다.", 400],
  VOICE_PROVIDER_INVALID: ["엔진 제공자 값이 올바르지 않습니다.", 400],
  ASSIGNMENT_REVISION_INVALID: ["엔진 배정 리비전이 올바르지 않습니다.", 400],
};

function mapRpcFailure(body: unknown): ConsoleStoreError {
  const message = isRecord(body) && typeof body.message === "string" ? body.message : "";
  const hit = Object.keys(KNOWN_FAILURES).find((token) => message.startsWith(token));
  if (hit) return new ConsoleStoreError(KNOWN_FAILURES[hit][0], hit, KNOWN_FAILURES[hit][1]);
  return new ConsoleStoreError("콘솔 저장소를 사용할 수 없습니다.", "CONSOLE_STORE_UNAVAILABLE", 503);
}

function mapProfileRow(row: unknown): ConsoleProfileRow {
  if (!isRecord(row) || typeof row.id !== "string" || !UUID.test(row.id) || typeof row.email !== "string" || typeof row.host_id !== "string"
    || !STATUSES.has(row.status as ProfileStatus) || !ROLES.has(row.role as ProfileRole) || typeof row.created_at !== "string") {
    throw rowInvalid();
  }
  return {
    id: row.id, email: row.email, displayName: optionalString(row.display_name), status: row.status as ProfileStatus, role: row.role as ProfileRole,
    voiceProvider: row.voice_provider === "gemini" ? "gemini" : "soniox", voiceProviderRevision: String(row.voice_provider_revision ?? 1),
    hostId: row.host_id, createdAt: row.created_at, lastLoginAt: optionalString(row.last_login_at), approvedAt: optionalString(row.approved_at),
  };
}

function mapMutationRow(rows: unknown): ProfileMutationResult {
  if (!Array.isArray(rows) || rows.length !== 1) throw rowInvalid();
  const row: unknown = rows[0];
  if (!isRecord(row) || typeof row.id !== "string" || !UUID.test(row.id) || !STATUSES.has(row.status as ProfileStatus) || !ROLES.has(row.role as ProfileRole)) throw rowInvalid();
  return { id: row.id, status: row.status as ProfileStatus, role: row.role as ProfileRole };
}

function readVoiceAssignment(row: Record<string, unknown>): { provider: VoiceProvider; revision: string } {
  const { provider, revision } = row;
  if (provider !== "soniox" && provider !== "gemini") throw rowInvalid();
  const parsedRevision = String(revision);
  if (!ASSIGNMENT_REVISION.test(parsedRevision)) throw rowInvalid();
  return { provider, revision: parsedRevision };
}

function mapVoiceProviderMutationRow(rows: unknown): VoiceProviderMutationResult {
  const identity = mapMutationRow(rows);
  const row = (rows as unknown[])[0] as Record<string, unknown>;
  if (typeof row.host_id !== "string" || row.host_id.length === 0) throw rowInvalid();
  return { ...identity, hostId: row.host_id, ...readVoiceAssignment(row) };
}

// bigint aggregates arrive as JSON numbers from PostgREST; a numeric string is accepted too.
function readCount(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,15}$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw rowInvalid();
  return n;
}

function mapSessionRow(row: unknown): ConsoleSessionRow {
  if (!isRecord(row) || typeof row.id !== "string" || !UUID.test(row.id) || typeof row.host_id !== "string" || typeof row.mode !== "string"
    || typeof row.status !== "string" || typeof row.created_at !== "string") {
    throw rowInvalid();
  }
  const languages = Array.isArray(row.languages) ? row.languages.filter((v): v is string => typeof v === "string") : [];
  const summaryStatus = typeof row.summary_status === "string" && SUMMARY_STATUSES.has(row.summary_status) ? row.summary_status as ConsoleSummaryStatus : null;
  return {
    id: row.id, title: optionalString(row.title), hostId: row.host_id, hostEmail: optionalString(row.host_email), mode: row.mode, status: row.status, languages,
    createdAt: row.created_at, endedAt: optionalString(row.ended_at), utteranceCount: readCount(row.utterance_count), participantCount: readCount(row.participant_count), summaryStatus,
  };
}

function mapActiveSessionRow(row: unknown): ActiveSessionRow {
  if (!isRecord(row) || typeof row.id !== "string" || !UUID.test(row.id) || typeof row.status !== "string" || !Array.isArray(row.languages)) throw rowInvalid();
  return { id: row.id, status: row.status, languages: row.languages.filter((v): v is string => typeof v === "string") };
}

function mapSessionEngineSwitchRows(rows: unknown): SessionEngineSwitchResult | null {
  if (!Array.isArray(rows) || rows.length > 1) throw rowInvalid();
  if (rows.length === 0) return null;
  const row: unknown = rows[0];
  if (!isRecord(row) || typeof row.id !== "string" || !UUID.test(row.id) || typeof row.status !== "string"
    || typeof row.version !== "number" || !Number.isSafeInteger(row.version) || row.version < 1) {
    throw rowInvalid();
  }
  return { id: row.id, status: row.status, version: row.version };
}

// The catalog decides what an engine may be; a rejection never leaves the process as a request.
function normalizeEngineOrThrow(engine: EngineSelection): EngineSelection {
  try {
    return normalizeEngineSelection(engine) as EngineSelection;
  } catch (error) {
    if (error instanceof EngineSelectionError) throw new ConsoleStoreError(KNOWN_FAILURES.ENGINE_INVALID[0], "ENGINE_INVALID", 400);
    throw error;
  }
}

export class SupabaseConsoleStore {
  private readonly fetchFn: typeof fetch;
  private readonly getServerAccess: typeof getSupabaseServerAccess;

  constructor(deps: { fetchFn?: typeof fetch; getServerAccess?: typeof getSupabaseServerAccess } = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.getServerAccess = deps.getServerAccess ?? getSupabaseServerAccess;
  }

  // Same shape as SupabaseProfileStore.rpc (copied, not shared: that helper is private to its
  // store). `getServerAccess` runs outside the try so LiveSecurityConfigurationError (no
  // Supabase env) reaches callers untouched - consoleSettingsCache keys its fail-open on it.
  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { url, credential } = this.getServerAccess();
    let response: Response;
    try {
      response = await this.fetchFn(`${url}/rest/v1/rpc/${name}`, {
        method: "POST", cache: "no-store",
        headers: { ...supabaseAdminHeaders(credential), "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(args),
      });
    } catch { throw new ConsoleStoreError("콘솔 저장소에 연결할 수 없습니다.", "CONSOLE_STORE_UNAVAILABLE", 503); }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw mapRpcFailure(body);
    return body;
  }

  private async rpcAck(name: string, args: Record<string, unknown>): Promise<void> {
    const ok = await this.rpc(name, args);
    if (ok !== true) throw new ConsoleStoreError("콘솔 설정을 저장하지 못했습니다.", "CONSOLE_WRITE_FAILED", 503);
  }

  async listProfiles(input: { status?: ProfileStatus; limit?: number; before?: string } = {}): Promise<ConsoleProfileRow[]> {
    const rows = await this.rpc("list_profiles_admin_v2", { p_status: input.status ?? null, p_limit: input.limit ?? 50, p_before: input.before ?? null });
    if (!Array.isArray(rows)) throw rowInvalid();
    return rows.map(mapProfileRow);
  }

  async readHostVoiceAssignment(hostId: string): Promise<{ provider: VoiceProvider; revision: string }> {
    const rows = await this.rpc("read_host_voice_assignment_v1", { p_host_id: hostId });
    if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) throw rowInvalid();
    return readVoiceAssignment(rows[0]);
  }

  /**
   * D1: the operator's per-user assignment. The v2 RPC writes the profile (revision bumps only on a
   * change, one `profile_events.engine_defaults` row with `kind: "user_assignment"`) and returns the
   * profile identity plus its `host_id`, which the route needs to find the sessions to switch.
   */
  async setProfileVoiceProvider(input: { actorId: string; profileId: string; provider: VoiceProvider }): Promise<VoiceProviderMutationResult> {
    return mapVoiceProviderMutationRow(await this.rpc("set_profile_voice_provider_v2", {
      p_actor_id: input.actorId, p_profile_id: input.profileId, p_provider: input.provider,
    }));
  }

  async countPending(): Promise<number> {
    return readCount(await this.rpc("count_pending_profiles_v1", {}));
  }

  async setProfileStatus(input: { actorId: string; profileId: string; status: Exclude<ProfileStatus, "pending">; reason?: string }): Promise<ProfileMutationResult> {
    return mapMutationRow(await this.rpc("set_profile_status_v1", {
      p_actor_id: input.actorId, p_profile_id: input.profileId, p_status: input.status, p_reason: input.reason ?? null,
    }));
  }

  async setProfileRole(input: { actorId: string; profileId: string; role: ProfileRole }): Promise<ProfileMutationResult> {
    return mapMutationRow(await this.rpc("set_profile_role_v1", { p_actor_id: input.actorId, p_profile_id: input.profileId, p_role: input.role }));
  }

  async listSessions(input: { since?: string; limit?: number } = {}): Promise<ConsoleSessionRow[]> {
    const rows = await this.rpc("list_sessions_admin_v1", { p_since: input.since ?? null, p_limit: input.limit ?? 100 });
    if (!Array.isArray(rows)) throw rowInvalid();
    return rows.map(mapSessionRow);
  }

  async readSettings(): Promise<ConsoleSettings> {
    const rows = await this.rpc("read_console_settings_v1", {});
    // The migration seeds console_settings row 1, so an empty result means the schema is not there.
    if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) throw rowInvalid();
    const row = rows[0] as Record<string, unknown>;
    return {
      legacyPasswordLoginEnabled: row.legacy_password_login_enabled !== false,
      engine: row.engine ?? null,
      engineUpdatedAt: optionalString(row.engine_updated_at),
      engineUpdatedByEmail: optionalString(row.engine_updated_by_email),
    };
  }

  /** Sessions a per-user switch targets: that host's `status in ('preparing','live')`, not archive-deleted, oldest first. */
  async listActiveSessionsForHost(hostId: string): Promise<ActiveSessionRow[]> {
    const rows = await this.rpc("list_live_session_ids_for_host_admin_v1", { p_host_id: hostId });
    if (!Array.isArray(rows)) throw rowInvalid();
    return rows.map(mapActiveSessionRow);
  }

  /**
   * Switches one running session's engine as an admin (the host PATCH RPC locks
   * `preparing`). `assignmentRevision` is the profile's `voice_provider_revision` the
   * session record should now carry (`modelPreferences.assignmentRevision`); omitted, the
   * stored one stays. `null` means the RPC matched no row - the session stopped or was
   * archived between the list and the push - which the caller reports, not throws.
   */
  async setSessionEngineAsAdmin(input: { actorId: string; sessionId: string; engine: EngineSelection; assignmentRevision?: string }): Promise<SessionEngineSwitchResult | null> {
    const engine = normalizeEngineOrThrow(input.engine);
    if (input.assignmentRevision !== undefined && !ASSIGNMENT_REVISION.test(input.assignmentRevision)) {
      throw new ConsoleStoreError(KNOWN_FAILURES.ASSIGNMENT_REVISION_INVALID[0], "ASSIGNMENT_REVISION_INVALID", 400);
    }
    return mapSessionEngineSwitchRows(await this.rpc("set_live_session_engine_admin_v2", {
      p_actor_id: input.actorId, p_session_id: input.sessionId, p_engine: engine, p_assignment_revision: input.assignmentRevision ?? null,
    }));
  }

  /**
   * One audit row per deploy: `profile_events.engine_defaults` with the engine, the
   * `sessionsSwitched/Failed/Queued` counters and the user whose sessions were switched
   * (the RPC tags it `kind: "deploy"`). The assignment itself is logged by
   * `set_profile_voice_provider_v2` (`kind: "user_assignment"`); this row records what the
   * push did with it.
   */
  async recordEngineDeploy(input: { actorId: string; engine: EngineSelection; summary: EngineDeploySummary; target: EngineDeployTarget }): Promise<void> {
    const engine = normalizeEngineOrThrow(input.engine);
    await this.rpcAck("record_console_deploy_v1", {
      p_actor_id: input.actorId,
      p_payload: {
        engine, sessionsSwitched: input.summary.switched, sessionsFailed: input.summary.failed, sessionsQueued: input.summary.queued,
        targetProfileId: input.target.profileId, targetHostId: input.target.hostId, provider: input.target.voiceProvider, revision: input.target.revision,
      },
    });
  }

  async setLegacyPasswordLogin(input: { actorId: string; enabled: boolean }): Promise<void> {
    await this.rpcAck("set_legacy_password_login_v1", { p_actor_id: input.actorId, p_enabled: input.enabled === true });
  }
}

let defaultStore: SupabaseConsoleStore | null = null;
let overrideStore: SupabaseConsoleStore | null = null;
const swapListeners = new Set<() => void>();

/** Route handlers and the settings cache resolve the store through here so tests can swap it. */
export function getConsoleStore(): SupabaseConsoleStore {
  if (overrideStore) return overrideStore;
  defaultStore ??= new SupabaseConsoleStore();
  return defaultStore;
}

/** Test seam: `null` restores the real store. Listeners (the settings memo) drop their cached value. */
export function __setConsoleStoreForTests(store: SupabaseConsoleStore | null): void {
  overrideStore = store;
  for (const listener of swapListeners) listener();
}

/** Internal: lets a memo keyed on the store forget its value when the seam swaps the store. */
export function __onConsoleStoreSwapped(listener: () => void): void { swapListeners.add(listener); }
