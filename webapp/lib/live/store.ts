import type { CaptionEvent, LiveSession, LiveSnapshot, SpeakerAssignment } from "../live-contract";
import { LANGUAGE_CODES } from "../languageDetect";
import { supabaseAdminHeaders, type SupabaseAdminCredential } from "../security/supabase-server-access";
import { getLiveStoreConfig } from "./config";
import { coverImageVersionFromPath } from "./cover-image";
import { LiveSessionError } from "./errors";

const CANONICAL_LANGUAGE_CODES = new Set<string>(LANGUAGE_CODES);

export interface LiveSessionStore {
  create(session: LiveSession): Promise<LiveSession>;
  get(sessionId: string): Promise<LiveSession | null>;
  updateOwned(
    sessionId: string,
    hostId: string,
    expectedVersion: number,
    patch: Pick<LiveSession, "title" | "scheduledAt" | "sessionType" | "outputMode" | "voiceProvider" | "languages" | "maxViewers" | "glossaryPack">,
  ): Promise<LiveSession | null>;
  startOwned(sessionId: string, hostId: string, expectedVersion: number): Promise<LiveSession | null>;
  pauseOwned(sessionId: string, hostId: string, expectedVersion: number): Promise<LiveSession | null>;
  resumeOwned(sessionId: string, hostId: string, expectedVersion: number): Promise<LiveSession | null>;
  terminateOwned(sessionId: string, hostId: string): Promise<boolean>;
  /** Contract C10: record that a cover image object exists for the session. */
  setCoverImageOwned(sessionId: string, hostId: string, path: string): Promise<boolean>;
  listOwnedActive(hostId: string): Promise<LiveSession[]>;
  getSnapshot(sessionId: string, language: string): Promise<LiveSnapshot | null>;
}

const ACTIVE_SESSION_STATUSES: ReadonlyArray<LiveSession["status"]> = ["preparing", "live", "paused"];

export class MemoryLiveSessionStore implements LiveSessionStore {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly snapshots = new Map<string, { lastSeq: number; captions: CaptionEvent[]; speakers: SpeakerAssignment[] }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async create(session: LiveSession): Promise<LiveSession> {
    this.sessions.set(session.id, structuredClone(session));
    return structuredClone(session);
  }

  async get(sessionId: string): Promise<LiveSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session || Date.parse(session.expiresAt) <= this.now()) return null;
    return structuredClone(session);
  }

  async updateOwned(sessionId: string, hostId: string, expectedVersion: number, patch: Pick<LiveSession, "title" | "scheduledAt" | "sessionType" | "outputMode" | "voiceProvider" | "languages" | "maxViewers" | "glossaryPack">): Promise<LiveSession | null> {
    const current = this.sessions.get(sessionId);
    if (!current
      || current.hostId !== hostId
      || current.version !== expectedVersion
      || current.status === "stopped"
      || Date.parse(current.expiresAt) <= this.now()) return null;
    const updated = { ...current, ...structuredClone(patch), version: current.version + 1 };
    this.sessions.set(sessionId, updated);
    return structuredClone(updated);
  }

  async startOwned(sessionId: string, hostId: string, expectedVersion: number): Promise<LiveSession | null> {
    const current = this.sessions.get(sessionId);
    if (!current
      || current.hostId !== hostId
      || current.version !== expectedVersion
      || current.status !== "preparing"
      || Date.parse(current.expiresAt) <= this.now()) return null;
    const started: LiveSession = { ...current, status: "live", version: current.version + 1 };
    this.sessions.set(sessionId, started);
    return structuredClone(started);
  }

  async pauseOwned(sessionId: string, hostId: string, expectedVersion: number): Promise<LiveSession | null> {
    return this.transitionOwned(sessionId, hostId, expectedVersion, "live", "paused");
  }

  async resumeOwned(sessionId: string, hostId: string, expectedVersion: number): Promise<LiveSession | null> {
    return this.transitionOwned(sessionId, hostId, expectedVersion, "paused", "live");
  }

  private transitionOwned(
    sessionId: string,
    hostId: string,
    expectedVersion: number,
    fromStatus: LiveSession["status"],
    toStatus: LiveSession["status"],
  ): LiveSession | null {
    const current = this.sessions.get(sessionId);
    if (!current
      || current.hostId !== hostId
      || current.version !== expectedVersion
      || current.status !== fromStatus
      || Date.parse(current.expiresAt) <= this.now()) return null;
    const next: LiveSession = { ...current, status: toStatus, version: current.version + 1 };
    this.sessions.set(sessionId, next);
    return structuredClone(next);
  }

  async listOwnedActive(hostId: string): Promise<LiveSession[]> {
    return [...this.sessions.values()]
      .filter((session) => session.hostId === hostId
        && ACTIVE_SESSION_STATUSES.includes(session.status)
        && Date.parse(session.expiresAt) > this.now())
      .map((session) => structuredClone(session));
  }

  async setCoverImageOwned(sessionId: string, hostId: string, path: string): Promise<boolean> {
    const current = this.sessions.get(sessionId);
    if (!current
      || current.hostId !== hostId
      || current.status === "stopped"
      || Date.parse(current.expiresAt) <= this.now()
      || !path) return false;
    this.sessions.set(sessionId, { ...current, hasCoverImage: true, coverImageVersion: coverImageVersionFromPath(path) });
    return true;
  }

  async terminateOwned(sessionId: string, hostId: string): Promise<boolean> {
    const current = this.sessions.get(sessionId);
    if (!current || current.hostId !== hostId) return false;
    this.sessions.set(sessionId, {
      ...current,
      status: "stopped",
      version: current.version + 1,
      viewerCount: 0,
      admissionOpenUntil: null,
      endedAt: current.endedAt ?? new Date(this.now()).toISOString(),
    });
    for (const key of this.snapshots.keys()) if (key.startsWith(`${sessionId}:`)) this.snapshots.delete(key);
    return true;
  }

  async getSnapshot(sessionId: string, language: string): Promise<LiveSnapshot | null> {
    const session = this.sessions.get(sessionId);
    if (!session || Date.parse(session.expiresAt) <= this.now()) return null;
    const snapshot = this.snapshots.get(`${sessionId}:${language}`) ?? { lastSeq: 0, captions: [], speakers: [] };
    return { session: structuredClone(session), language, ...structuredClone(snapshot) };
  }
}

interface SupabaseSessionRow {
  id: string;
  host_id: string;
  title: string | null;
  scheduled_at: string | null;
  session_type?: LiveSession["sessionType"];
  output_mode?: LiveSession["outputMode"];
  voice_provider: LiveSession["voiceProvider"];
  max_viewers?: number;
  glossary_pack?: LiveSession["glossaryPack"];
  mode?: "presentation" | "meeting" | "townhall";
  voice_output_mode?: "captions" | "fixed_voice" | "auto_voice";
  status: LiveSession["status"];
  languages: string[];
  viewer_count: number;
  version: number;
  admission_open_until: string | null;
  expires_at: string;
  ended_at?: string | null;
  cover_image_path?: string | null;
}

export class SupabaseLiveSessionStore implements LiveSessionStore {
  private readonly baseUrl: string;
  private readonly credential: SupabaseAdminCredential;
  private readonly fetchFn: typeof fetch;

  constructor(
    baseUrl: string,
    credential: SupabaseAdminCredential,
    fetchFn: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl;
    this.credential = credential;
    this.fetchFn = fetchFn;
  }

  async create(session: LiveSession): Promise<LiveSession> {
    const rows = await this.request<SupabaseSessionRow[]>("/rest/v1/rpc/create_live_session", {
      method: "POST",
      body: JSON.stringify({
        p_session_id: session.id,
        p_host_id: session.hostId,
        p_title: session.title,
        p_scheduled_at: session.scheduledAt,
        p_session_type: session.sessionType,
        p_output_mode: session.outputMode,
        p_voice_provider: session.voiceProvider,
        p_languages: session.languages,
        p_max_viewers: session.maxViewers,
        p_glossary_pack: session.glossaryPack,
        p_expires_at: session.expiresAt,
      }),
    });
    if (!rows[0]) throw new LiveSessionError("세션을 만들지 못했습니다.", "SESSION_CREATE_FAILED", 502);
    return fromRow(rows[0]);
  }

  async get(sessionId: string): Promise<LiveSession | null> {
    const query = new URLSearchParams({
      id: `eq.${sessionId}`,
      expires_at: `gt.${new Date().toISOString()}`,
      limit: "1",
    });
    const rows = await this.request<SupabaseSessionRow[]>(`/rest/v1/live_sessions?${query}`, { method: "GET" });
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async updateOwned(sessionId: string, hostId: string, expectedVersion: number, patch: Pick<LiveSession, "title" | "scheduledAt" | "sessionType" | "outputMode" | "voiceProvider" | "languages" | "maxViewers" | "glossaryPack">): Promise<LiveSession | null> {
    const rows = await this.request<SupabaseSessionRow[]>("/rest/v1/rpc/update_live_session", {
      method: "POST",
      body: JSON.stringify({
        p_session_id: sessionId,
        p_host_id: hostId,
        p_expected_version: expectedVersion,
        p_title: patch.title,
        p_scheduled_at: patch.scheduledAt,
        p_session_type: patch.sessionType,
        p_output_mode: patch.outputMode,
        p_voice_provider: patch.voiceProvider,
        p_languages: patch.languages,
        p_max_viewers: patch.maxViewers,
        p_glossary_pack: patch.glossaryPack,
      }),
    });
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async startOwned(sessionId: string, hostId: string, expectedVersion: number): Promise<LiveSession | null> {
    let nextVersion: unknown;
    try {
      nextVersion = await this.request<unknown>("/rest/v1/rpc/start_live_session", {
        method: "POST",
        body: JSON.stringify({
          p_session_id: sessionId,
          p_host_id: hostId,
          p_expected_version: expectedVersion,
        }),
      });
    } catch (error: unknown) {
      // 2026-07-23 fix: Re-read an owned row after a guarded start conflict.
      // This distinguishes an idempotent concurrent retry from an unavailable store.
      const current = await this.get(sessionId);
      if (current?.hostId === hostId) return null;
      throw error;
    }
    if (!Number.isSafeInteger(nextVersion) || Number(nextVersion) <= expectedVersion) return null;
    return this.get(sessionId);
  }

  async pauseOwned(sessionId: string, hostId: string, expectedVersion: number): Promise<LiveSession | null> {
    return this.transitionOwned("pause_live_session", sessionId, hostId, expectedVersion);
  }

  async resumeOwned(sessionId: string, hostId: string, expectedVersion: number): Promise<LiveSession | null> {
    return this.transitionOwned("resume_live_session", sessionId, hostId, expectedVersion);
  }

  private async transitionOwned(
    rpcName: "pause_live_session" | "resume_live_session",
    sessionId: string,
    hostId: string,
    expectedVersion: number,
  ): Promise<LiveSession | null> {
    let nextVersion: unknown;
    try {
      nextVersion = await this.request<unknown>(`/rest/v1/rpc/${rpcName}`, {
        method: "POST",
        body: JSON.stringify({
          p_session_id: sessionId,
          p_host_id: hostId,
          p_expected_version: expectedVersion,
        }),
      });
    } catch (error: unknown) {
      // Mirror startOwned: re-read an owned row after a guarded conflict so a
      // concurrent retry surfaces as a version conflict, not a 503.
      const current = await this.get(sessionId);
      if (current?.hostId === hostId) return null;
      throw error;
    }
    if (!Number.isSafeInteger(nextVersion) || Number(nextVersion) <= expectedVersion) return null;
    return this.get(sessionId);
  }

  async listOwnedActive(hostId: string): Promise<LiveSession[]> {
    const query = new URLSearchParams({
      host_id: `eq.${hostId}`,
      status: `in.(${ACTIVE_SESSION_STATUSES.join(",")})`,
      expires_at: `gt.${new Date().toISOString()}`,
      order: "created_at.desc",
      limit: "20",
    });
    const rows = await this.request<SupabaseSessionRow[]>(`/rest/v1/live_sessions?${query}`, { method: "GET" });
    return rows.map(fromRow);
  }

  async setCoverImageOwned(sessionId: string, hostId: string, path: string): Promise<boolean> {
    if (!path) return false;
    const query = new URLSearchParams({
      id: `eq.${sessionId}`,
      host_id: `eq.${hostId}`,
      status: "neq.stopped",
      expires_at: `gt.${new Date().toISOString()}`,
    });
    const rows = await this.request<SupabaseSessionRow[]>(`/rest/v1/live_sessions?${query}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ cover_image_path: path }),
    });
    return rows.length > 0;
  }

  async terminateOwned(sessionId: string, hostId: string): Promise<boolean> {
    const result = await this.request<unknown>("/rest/v1/rpc/terminate_live_session", {
      method: "POST",
      body: JSON.stringify({ p_session_id: sessionId, p_host_id: hostId }),
    });
    return result === true;
  }

  async getSnapshot(sessionId: string, language: string): Promise<LiveSnapshot | null> {
    const [session, rows, speakerRows] = await Promise.all([
      this.get(sessionId),
      this.request<Array<{ last_seq: number; captions: CaptionEvent[]; speaker_legend: SpeakerAssignment[] }>>(`/rest/v1/live_snapshots?session_id=eq.${encodeURIComponent(sessionId)}&language=eq.${encodeURIComponent(language)}&limit=1`, { method: "GET" }),
      this.request<SpeakerAssignment[]>(`/rest/v1/session_speakers?session_id=eq.${encodeURIComponent(sessionId)}&select=speakerId:speaker_id,label,colorToken:color_token,voiceName:voice_name,voiceStatus:voice_status,lastSeenAt:last_seen_at`, { method: "GET" }),
    ]);
    if (!session) return null;
    return {
      session,
      language,
      lastSeq: rows[0]?.last_seq ?? 0,
      captions: rows[0]?.captions ?? [],
      speakers: rows[0]?.speaker_legend ?? speakerRows,
    };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        ...supabaseAdminHeaders(this.credential),
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) throw new LiveSessionError("세션 저장소에 연결하지 못했습니다.", "LIVE_STORE_UNAVAILABLE", 503);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}

function fromRow(row: SupabaseSessionRow): LiveSession {
  if (!Array.isArray(row.languages)
    || row.languages.length < 1
    || row.languages.length > 3
    || row.languages.some((language) => !CANONICAL_LANGUAGE_CODES.has(language))
    || new Set(row.languages).size !== row.languages.length) {
    throw new LiveSessionError("저장된 세션 언어가 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
  }
  const [firstLanguage, ...remainingLanguages] = row.languages;
  if (!firstLanguage) throw new LiveSessionError("저장된 세션 언어가 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
  if (row.voice_provider !== "gemini" && row.voice_provider !== "openai") {
    throw new LiveSessionError("저장된 음성 출력 제공자가 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
  }
  const title = row.title ?? "Live Session";
  if (typeof title !== "string"
    || Array.from(title).length < 1
    || Array.from(title).length > 120
    || /[<>]|\p{Cc}|\p{Cf}/u.test(title)) {
    throw new LiveSessionError("저장된 세션 제목이 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
  }
  const scheduledAt = row.scheduled_at ?? null;
  if (scheduledAt !== null
    && (typeof scheduledAt !== "string" || !Number.isFinite(Date.parse(scheduledAt)))) {
    throw new LiveSessionError("저장된 세션 일정이 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
  }
  const sessionType = row.session_type ?? normalizeLegacySessionType(row.mode);
  const outputMode = row.output_mode ?? normalizeLegacyOutputMode(row.mode, row.voice_output_mode);
  const voiceProvider = row.voice_provider;
  if (voiceProvider === "openai" && (sessionType !== "presentation" || outputMode === "captions")) {
    throw new LiveSessionError("저장된 음성 출력 설정이 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
  }
  return {
    id: row.id,
    hostId: row.host_id,
    title,
    scheduledAt,
    sessionType,
    outputMode,
    voiceProvider,
    maxViewers: row.max_viewers ?? 50,
    glossaryPack: row.glossary_pack ?? "general_cre",
    status: row.status,
    languages: [firstLanguage, ...remainingLanguages],
    viewerCount: row.viewer_count,
    version: row.version,
    admissionOpenUntil: row.admission_open_until,
    expiresAt: row.expires_at,
    endedAt: row.ended_at ?? null,
    hasCoverImage: Boolean(row.cover_image_path),
    coverImageVersion: coverImageVersionFromPath(row.cover_image_path),
  };
}

function normalizeLegacySessionType(mode: SupabaseSessionRow["mode"]): LiveSession["sessionType"] {
  return mode === "presentation" ? "presentation" : "meeting";
}

function normalizeLegacyOutputMode(
  mode: SupabaseSessionRow["mode"],
  voiceOutputMode: SupabaseSessionRow["voice_output_mode"],
): LiveSession["outputMode"] {
  if (mode === "townhall" || voiceOutputMode === "fixed_voice" || voiceOutputMode === "auto_voice") return "audio";
  return "captions";
}

let singleton: LiveSessionStore | null = null;

export function getLiveSessionStore(): LiveSessionStore {
  if (singleton) return singleton;
  const { baseUrl, credential } = getLiveStoreConfig();
  singleton = new SupabaseLiveSessionStore(baseUrl, credential);
  return singleton;
}
