import { fitEventMetadataToByteBudget, readLiveModelPreferences, type LiveModelPreferences } from "./model-preferences";
import { hasValidTranslationCaptureProvenance, readTranslationCapture } from "./translation-capture";
import type { LanguageObservation, CaptionEvent, LiveAgendaItem, LiveEventType, LiveSession, LiveSessionGlossaryPin, LiveSessionGlossaryPinSelection, LiveSessionGlossaryPins, LiveSessionSection, LiveSnapshot, LiveTopicSnapshot, SpeakerAssignment } from "../live-contract";
import { BUILTIN_GLOSSARY_IDS } from "../glossary-presets/types";
import { LANGUAGE_CODES } from "../languageDetect";
import { supabaseAdminHeaders, type SupabaseAdminCredential } from "../security/supabase-server-access";
import { parseLiveTopic, parseLiveTopicMembership, parseLiveTopicSnapshot } from "../security/live-topic-validation";
import { getLiveStoreConfig } from "./config";
import { languageObservationSchema } from "./source-contract";
import { coverImagePath, coverImageVersionFromPath } from "./cover-image";
import { LiveSessionError } from "./errors";
import { normalizeSpeakerProfile } from "../../../packages/caption-core/speaker-profile.js";

const CANONICAL_LANGUAGE_CODES = new Set<string>(LANGUAGE_CODES);

export interface LiveSessionStore {
  create(session: LiveSession): Promise<LiveSession>;
  get(sessionId: string, options?: { signal?: AbortSignal }): Promise<LiveSession | null>;
  getOwned(sessionId: string, hostId: string, options?: { signal?: AbortSignal }): Promise<LiveSession | null>;
  renewAccessOwned(sessionId: string, hostId: string, expectedVersion: number): Promise<LiveSession | null>;
  updateOwned(
    sessionId: string,
    hostId: string,
    expectedVersion: number,
    patch: LiveSessionUpdatePatch,
  ): Promise<LiveSession | null>;
  startOwned(sessionId: string, hostId: string, expectedVersion: number): Promise<LiveSession | null>;
  pauseOwned(sessionId: string, hostId: string, expectedVersion: number): Promise<LiveSession | null>;
  resumeOwned(sessionId: string, hostId: string, expectedVersion: number): Promise<LiveSession | null>;
  transitionSectionOwned(
    sessionId: string,
    hostId: string,
    expectedVersion: number,
    section: LiveSessionSection,
    transitionKey: string,
    sourceSeq: number | null,
  ): Promise<LiveSession | null>;
  pinGlossaryVersionOwned(
    sessionId: string,
    hostId: string,
    expectedVersion: number,
    presetId: string,
    documentVersion: number,
  ): Promise<LiveSessionGlossaryPin>;
  replaceGlossaryPinsOwned(
    sessionId: string,
    hostId: string,
    expectedVersion: number,
    glossaries: readonly LiveSessionGlossaryPinSelection[],
  ): Promise<LiveSessionGlossaryPins>;
  getGlossaryPinsOwned(sessionId: string, hostId: string): Promise<LiveSessionGlossaryPins>;
  terminateOwned(sessionId: string, hostId: string): Promise<boolean>;
  /** Contract C10: record that a cover image object exists for the session. */
  setCoverImageOwned(sessionId: string, hostId: string, path: string, expectedCurrentPath: string | null): Promise<boolean>;
  listOwnedActive(hostId: string, offset?: number): Promise<LiveSession[]>;
  hasPreparingScheduledBetween(startAt: string, endAt: string): Promise<boolean>;
  getSnapshot(sessionId: string, language: string): Promise<LiveSnapshot | null>;
  getTopicSnapshot(sessionId: string, language: string, options?: { signal?: AbortSignal }): Promise<LiveTopicSnapshot>;
  getTopicTranscript(sessionId: string, options?: LiveTopicTranscriptReadOptions): Promise<LiveTopicSnapshot>;
}

export interface LiveTopicTranscriptReadOptions {
  signal?: AbortSignal;
  maxTopics?: number;
  maxTopicMemberships?: number;
}

const ACTIVE_SESSION_STATUSES: ReadonlyArray<LiveSession["status"]> = ["preparing", "live", "paused"];
const SECTION_TRANSITION_STATUSES: ReadonlyArray<LiveSession["status"]> = ["live", "paused"];
type LiveSessionUpdatePatch = Pick<LiveSession,
  "title" | "scheduledAt" | "sessionType" | "outputMode" | "voiceProvider" | "languages" | "maxViewers" | "glossaryPack"
  | "participantSpeakingEnabled"
  | "companyName" | "ticker" | "fiscalPeriod" | "eventType" | "agenda" | "modelPreferences"
>;

/** Keyset page size for complete snapshot history reconstruction. */
const SNAPSHOT_HISTORY_LIMIT = 200;
const TOPIC_TRANSCRIPT_PAGE_SIZE = 1_000;
const MAX_TOPIC_TRANSCRIPT_ROWS = 100_000;

interface UtteranceRow {
  translation_capture?: unknown;
  seq: number;
  authoritative_source_id?: string | null;
  languageObservation?: LanguageObservation;
  participant_id: string | null;
  speaker_label: string | null;
  speaker_name: string | null;
  speaker_profile?: unknown;
  speaker_attribution?: string | null;
  text: string;
  source_text: string | null;
  source_started_at?: string | null;
  source_language: string | null;
  origin: string | null;
  utterance_key: string | null;
  translation_status: "verbatim" | "translated" | "failed" | null;
  source_ended_at: string;
  emitted_at: string;
}

/** Mirrors the gateway's row -> CaptionEvent mapping (SupabaseLivePublisher
 *  .fetchUtterancesAfter). The viewer contract validates EVERY
 *  SpeakerAssignment field and silently drops captions whose speaker shape is
 *  partial, so replayed history has to carry the complete shape. */
function captionFromUtterance(sessionId: string, language: string, row: UtteranceRow): CaptionEvent {
  // SQL NULL is a legacy row, but a present invalid capture must never lose its provenance guard.
  const capture = row.translation_capture ?? undefined;
  if (!hasValidTranslationCaptureProvenance({ translationCapture: capture, translationStatus: row.translation_status,
    sourceText: row.source_text, sourceLanguage: row.source_language, sourceStartedAt: row.source_started_at,
    origin: row.origin, authoritativeSourceId: row.authoritative_source_id, languageObservation: row.languageObservation })) {
    throw new LiveSessionError("번역 기록의 출처 정보를 확인할 수 없습니다.", "INVALID_TRANSLATION_CAPTURE", 503);
  }
  const caption: CaptionEvent = {
    ...(row.speaker_profile == null ? {} : { speakerProfile: normalizeSpeakerProfile(row.speaker_profile) }),
    ...(row.speaker_attribution === "unresolved" ? { speakerAttribution: "unresolved" as const } : {}),
    type: "caption",
    seq: Number(row.seq),
    sessionId,
    language,
    speaker: row.participant_id || row.speaker_label || row.speaker_name
      ? {
        speakerId: String(row.participant_id ? `participant:${row.participant_id}` : row.speaker_label ?? row.speaker_name),
        label: row.speaker_name ?? row.speaker_label ?? "",
        colorToken: "speaker-teal",
        voiceName: null,
        voiceStatus: "disabled",
        lastSeenAt: row.emitted_at,
      }
      : null,
    text: row.text,
    isFinal: true,
    translationCapture: readTranslationCapture(capture),
    sourceText: row.source_text ?? null,
    sourceLanguage: row.source_language ?? null,
    ...(row.languageObservation ? { languageObservation: row.languageObservation } : {}),
    translationStatus: row.translation_status ?? (row.source_text ? "translated" : "verbatim"),
    sourceEndedAt: row.source_ended_at,
    emittedAt: row.emitted_at,
  };
  if (row.origin === "source") caption.origin = "source";
  if (row.utterance_key) caption.utteranceKey = row.utterance_key;
  return caption;
}

export class MemoryLiveSessionStore implements LiveSessionStore {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly glossaryPins = new Map<string, LiveSessionGlossaryPins>();
  private readonly snapshots = new Map<string, { lastSeq: number; captions: CaptionEvent[]; speakers: SpeakerAssignment[] }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async create(session: LiveSession): Promise<LiveSession> {
    const stored = withBudgetedPreferences(structuredClone(session));
    this.sessions.set(session.id, stored);
    return structuredClone(stored);
  }

  async get(sessionId: string, _options: { signal?: AbortSignal } = {}): Promise<LiveSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session || Date.parse(session.expiresAt) <= this.now()) return null;
    return structuredClone(session);
  }

  async getOwned(sessionId: string, hostId: string): Promise<LiveSession | null> {
    const session = this.sessions.get(sessionId);
    return session?.hostId === hostId ? structuredClone(session) : null;
  }

  async renewAccessOwned(sessionId: string, hostId: string, expectedVersion: number): Promise<LiveSession | null> {
    const current = this.sessions.get(sessionId);
    if (!current || current.hostId !== hostId || current.version !== expectedVersion
      || !ACTIVE_SESSION_STATUSES.includes(current.status)) return null;
    if (Date.parse(current.expiresAt) > this.now() + 15 * 60_000) return structuredClone(current);
    const renewed = { ...current, version: current.version + 1,
      expiresAt: new Date(Math.max(this.now(), Date.parse(current.scheduledAt ?? "") || 0) + 6 * 60 * 60_000).toISOString() };
    this.sessions.set(sessionId, renewed);
    return structuredClone(renewed);
  }

  async updateOwned(sessionId: string, hostId: string, expectedVersion: number, patch: LiveSessionUpdatePatch): Promise<LiveSession | null> {
    const current = this.sessions.get(sessionId);
    if (!current
      || current.hostId !== hostId
      || current.version !== expectedVersion
      || current.status === "stopped"
      || Date.parse(current.expiresAt) <= this.now()) return null;
    const updated = withBudgetedPreferences({ ...current, ...structuredClone(patch), version: current.version + 1 });
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

  async transitionSectionOwned(
    sessionId: string,
    hostId: string,
    expectedVersion: number,
    section: LiveSessionSection,
    _transitionKey: string,
    _sourceSeq: number | null,
  ): Promise<LiveSession | null> {
    const current = this.sessions.get(sessionId);
    if (!current
      || current.hostId !== hostId
      || !SECTION_TRANSITION_STATUSES.includes(current.status)
      || Date.parse(current.expiresAt) <= this.now()) return null;
    if (current.activeSection === section) return structuredClone(current);
    if (current.version !== expectedVersion) return null;
    const next: LiveSession = {
      ...current,
      activeSection: section,
      sectionStartedAt: new Date(this.now()).toISOString(),
      version: current.version + 1,
    };
    this.sessions.set(sessionId, next);
    return structuredClone(next);
  }

  async pinGlossaryVersionOwned(
    sessionId: string,
    hostId: string,
    expectedVersion: number,
    presetId: string,
    documentVersion: number,
  ): Promise<LiveSessionGlossaryPin> {
    const replaced = await this.replaceGlossaryPinsOwned(sessionId, hostId, expectedVersion, [{ sourceKind: "host", sourceId: presetId, documentVersion }]);
    const pin = replaced.glossaries[0];
    if (!pin) throw new LiveSessionError("세션 용어집 저장 응답이 올바르지 않습니다.", "INVALID_GLOSSARY_PIN_RESPONSE", 502);
    return {
      sessionId,
      version: replaced.version,
      pinnedGlossaryPresetId: pin.sourceId,
      pinnedGlossaryVersion: pin.documentVersion,
      pinnedGlossaryFingerprint: pin.fingerprint ?? "",
      updatedAt: replaced.updatedAt,
    };
  }

  async replaceGlossaryPinsOwned(
    sessionId: string,
    hostId: string,
    expectedVersion: number,
    glossaries: readonly LiveSessionGlossaryPinSelection[],
  ): Promise<LiveSessionGlossaryPins> {
    const current = this.sessions.get(sessionId);
    if (!current || current.hostId !== hostId) {
      throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    }
    if (current.version !== expectedVersion) {
      throw new LiveSessionError("다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도하세요.", "VERSION_CONFLICT", 409);
    }
    if (current.status !== "preparing") {
      throw new LiveSessionError("진행 중이거나 종료된 세션의 용어집은 변경할 수 없습니다.", "ACTIVE_SESSION_GLOSSARY_IMMUTABLE", 409);
    }
    if (glossaries.length < 1 || glossaries.length > 5) {
      throw new LiveSessionError("세션 용어집은 1개 이상 5개 이하로 선택하세요.", "INVALID_GLOSSARY_PIN", 400);
    }
    const updatedAt = new Date(this.now()).toISOString();
    const next = { ...current, version: current.version + 1 };
    this.sessions.set(sessionId, next);
    const result: LiveSessionGlossaryPins = {
      sessionId,
      version: next.version,
      glossaries: glossaries.map((glossary, index) => glossary.sourceKind === "builtin"
        ? {
          sourceKind: "builtin" as const,
          sourceId: glossary.sourceId,
          documentVersion: 1,
          ordinal: index + 1,
          fingerprint: null,
        }
        : {
          sourceKind: "host" as const,
          sourceId: glossary.sourceId,
          documentVersion: glossary.documentVersion,
          ordinal: index + 1,
          fingerprint: `sha256:${String(index).repeat(64).slice(0, 64)}`,
        }),
      updatedAt,
    };
    this.glossaryPins.set(sessionId, structuredClone(result));
    return result;
  }

  async getGlossaryPinsOwned(sessionId: string, hostId: string): Promise<LiveSessionGlossaryPins> {
    const current = await this.get(sessionId);
    if (!current || current.hostId !== hostId) {
      throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    }
    const pinned = this.glossaryPins.get(sessionId);
    return pinned
      ? structuredClone(pinned)
      : { sessionId, version: current.version, glossaries: [], updatedAt: new Date(this.now()).toISOString() };
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

  async listOwnedActive(hostId: string, offset = 0): Promise<LiveSession[]> {
    return [...this.sessions.values()]
      .filter((session) => session.hostId === hostId
        && ACTIVE_SESSION_STATUSES.includes(session.status))
      .slice(offset, offset + 101)
      .map((session) => structuredClone(session));
  }

  async hasPreparingScheduledBetween(startAt: string, endAt: string): Promise<boolean> {
    const start = Date.parse(startAt);
    const end = Date.parse(endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("INVALID_SCHEDULE_WINDOW");
    return [...this.sessions.values()].some((session) => session.status === "preparing"
      && session.scheduledAt !== null
      && Date.parse(session.scheduledAt) >= start
      && Date.parse(session.scheduledAt) <= end
      && Date.parse(session.expiresAt) > this.now());
  }

  async setCoverImageOwned(
    sessionId: string,
    hostId: string,
    path: string,
    expectedCurrentPath: string | null,
  ): Promise<boolean> {
    const current = this.sessions.get(sessionId);
    const currentPath = current?.coverImageVersion ? coverImagePath(sessionId, current.coverImageVersion) : null;
    if (!current
      || current.hostId !== hostId
      || !ACTIVE_SESSION_STATUSES.includes(current.status)
      || currentPath !== expectedCurrentPath
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
    return {
      session: structuredClone(session),
      language,
      ...structuredClone(snapshot),
      topics: [],
      topicMemberships: [],
    };
  }

  async getTopicSnapshot(sessionId: string, _language: string, _options: { signal?: AbortSignal } = {}): Promise<LiveTopicSnapshot> {
    return parseLiveTopicSnapshot({ topics: [], topicMemberships: [] }, sessionId);
  }

  async getTopicTranscript(_sessionId: string, _options: LiveTopicTranscriptReadOptions = {}): Promise<LiveTopicSnapshot> {
    return { topics: [], topicMemberships: [] };
  }
}

interface SupabaseSessionRow {
  id: string;
  host_id: string;
  title: string | null;
  scheduled_at: string | null;
  session_type?: LiveSession["sessionType"];
  output_mode?: "captions" | "captions_audio" | "audio";
  voice_provider: "gemini" | "openai";
  max_viewers?: number;
  participant_speaking_enabled?: boolean | null;
  glossary_pack?: LiveSession["glossaryPack"];
  mode?: "presentation" | "meeting" | "townhall";
  voice_output_mode?: "captions" | "fixed_voice" | "auto_voice";
  status: LiveSession["status"];
  languages: string[];
  viewer_count: number;
  version: number;
  admission_open_until: string | null;
  admission_state?: "uninitialized" | "open" | "paused" | "ended";
  expires_at: string;
  ended_at?: string | null;
  cover_image_path?: string | null;
  event_company_name?: string | null;
  event_reporting_period?: string | null;
  event_metadata?: Record<string, unknown> | null;
  gateway_activation_key?: string | null;
}

interface SupabaseSessionEventContextRow {
  session_id: string;
  event_company_name: string | null;
  event_reporting_period: string | null;
  event_metadata: Record<string, unknown> | null;
  active_section_key: LiveSessionSection | null;
  sections: unknown;
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
    const rows = await this.request<SupabaseSessionRow[]>("/rest/v1/rpc/create_live_session_with_event_v2", {
      method: "POST",
      body: JSON.stringify({
        p_session_id: session.id,
        p_host_id: session.hostId,
        p_session_type: session.sessionType,
        p_output_mode: "captions",
        p_languages: session.languages,
        p_max_viewers: session.maxViewers,
        p_participant_speaking_enabled: session.participantSpeakingEnabled,
        p_glossary_pack: session.glossaryPack,
        p_voice_provider: "gemini",
        p_title: session.title,
        p_scheduled_at: session.scheduledAt,
        p_expires_at: session.expiresAt,
        p_event_company_name: session.companyName ?? null,
        p_event_reporting_period: session.fiscalPeriod ?? null,
        p_event_metadata: fitEventMetadataToByteBudget(eventMetadataBody(session)),
      }),
    });
    if (!rows[0]) throw new LiveSessionError("세션을 만들지 못했습니다.", "SESSION_CREATE_FAILED", 502);
    return fromRow(rows[0]);
  }

  async get(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<LiveSession | null> {
    const query = new URLSearchParams({
      id: `eq.${sessionId}`,
      expires_at: `gt.${new Date().toISOString()}`,
      limit: "1",
    });
    const [rows, eventContext] = await Promise.all([
      this.request<SupabaseSessionRow[]>(`/rest/v1/live_sessions?${query}`, { method: "GET", signal: options.signal }),
      this.readEventContext(sessionId, options.signal),
    ]);
    return rows[0] ? applyEventContext(fromRow(rows[0]), eventContext) : null;
  }

  async getOwned(sessionId: string, hostId: string, options: { signal?: AbortSignal } = {}): Promise<LiveSession | null> {
    const query = new URLSearchParams({ id: `eq.${sessionId}`, host_id: `eq.${hostId}`, archive_deleted_at: "is.null", limit: "1" });
    const [rows, eventContext] = await Promise.all([
      this.request<SupabaseSessionRow[]>(`/rest/v1/live_sessions?${query}`, { method: "GET", signal: options.signal }),
      this.readEventContext(sessionId, options.signal),
    ]);
    return rows[0] ? applyEventContext(fromRow(rows[0]), eventContext) : null;
  }

  async renewAccessOwned(sessionId: string, hostId: string, expectedVersion: number): Promise<LiveSession | null> {
    let version: unknown;
    try {
      version = await this.request<unknown>("/rest/v1/rpc/renew_live_session_access_v1", {
        method: "POST",
        body: JSON.stringify({ p_session_id: sessionId, p_host_id: hostId, p_expected_version: expectedVersion }),
      });
    } catch (error) {
      const current = await this.getOwned(sessionId, hostId);
      if (!current || current.version !== expectedVersion || !ACTIVE_SESSION_STATUSES.includes(current.status)) return null;
      throw error;
    }
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < expectedVersion) {
      throw new LiveSessionError("세션 복원 응답이 올바르지 않습니다.", "INVALID_STORE_RESPONSE", 503);
    }
    return this.getOwned(sessionId, hostId);
  }

  async updateOwned(sessionId: string, hostId: string, expectedVersion: number, patch: LiveSessionUpdatePatch): Promise<LiveSession | null> {
    const metadataQuery = new URLSearchParams({ id: `eq.${sessionId}`, host_id: `eq.${hostId}`,
      version: `eq.${expectedVersion}`, status: "eq.preparing", archive_deleted_at: "is.null", select: "event_metadata", limit: "1" });
    const metadataRows = await this.request<Array<{ event_metadata: Record<string, unknown> }>>(
      `/rest/v1/live_sessions?${metadataQuery}`, { method: "GET" });
    if (!metadataRows[0]) return null;
    const existingMetadata = metadataRows[0].event_metadata;
    if (existingMetadata !== undefined && existingMetadata !== null && (typeof existingMetadata !== "object" || Array.isArray(existingMetadata))) {
      throw new LiveSessionError("저장된 이벤트 메타데이터가 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
    }

    // The service owns engine authority and history (Plan 2 Task 4); the store
    // writes what it is given and keeps the stored preferences when the patch
    // carries none, so unrelated edits never reset the engine.
    const modelPreferences = patch.modelPreferences === undefined
      ? parseStoredEventMetadata(existingMetadata).modelPreferences
      : readLiveModelPreferences(patch.modelPreferences);
    const rows = await this.request<SupabaseSessionRow[]>("/rest/v1/rpc/update_live_session_with_event_v2", {
      method: "POST",
      body: JSON.stringify({
        p_session_id: sessionId,
        p_host_id: hostId,
        p_expected_version: expectedVersion,
        p_session_type: patch.sessionType,
        p_output_mode: "captions",
        p_languages: patch.languages,
        p_max_viewers: patch.maxViewers,
        p_participant_speaking_enabled: patch.participantSpeakingEnabled,
        p_glossary_pack: patch.glossaryPack,
        p_voice_provider: "gemini",
        p_title: patch.title,
        p_scheduled_at: patch.scheduledAt,
        p_event_company_name: patch.companyName ?? null,
        p_event_reporting_period: patch.fiscalPeriod ?? null,
        // Budgeted on the merged body — foreign keys already on the row count too.
        p_event_metadata: fitEventMetadataToByteBudget({ ...existingMetadata, ...eventMetadataBody({ ...patch, modelPreferences }) }),
      }),
    });
    return rows[0] ? fromRow(rows[0]) : null;
  }

  private async readEventContext(sessionId: string, signal?: AbortSignal): Promise<SupabaseSessionEventContextRow | null> {
    const rows = await this.request<SupabaseSessionEventContextRow[]>("/rest/v1/rpc/read_live_session_event_context_v1", {
      method: "POST",
      signal,
      body: JSON.stringify({ p_session_id: sessionId }),
    });
    const row = rows[0] as Partial<SupabaseSessionEventContextRow> | undefined;
    return typeof row?.session_id === "string" ? row as SupabaseSessionEventContextRow : null;
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

  async transitionSectionOwned(
    sessionId: string,
    hostId: string,
    expectedVersion: number,
    section: LiveSessionSection,
    transitionKey: string,
    sourceSeq: number | null,
  ): Promise<LiveSession | null> {
    let rows: unknown;
    try {
      rows = await this.request<unknown>("/rest/v1/rpc/transition_live_session_section_v1", {
        method: "POST",
        body: JSON.stringify({
          p_session_id: sessionId,
          p_host_id: hostId,
          p_expected_session_version: expectedVersion,
          p_transition_key: transitionKey,
          p_section_key: section,
          p_source_seq: sourceSeq,
        }),
      });
    } catch (error: unknown) {
      const current = await this.get(sessionId);
      if (current?.hostId === hostId) return null;
      throw error;
    }
    if (!Array.isArray(rows) || rows.length !== 1) return null;
    return this.get(sessionId);
  }

  async pinGlossaryVersionOwned(
    sessionId: string,
    hostId: string,
    expectedVersion: number,
    presetId: string,
    documentVersion: number,
  ): Promise<LiveSessionGlossaryPin> {
    const replaced = await this.replaceGlossaryPinsOwned(sessionId, hostId, expectedVersion, [{ sourceKind: "host", sourceId: presetId, documentVersion }]);
    const pin = replaced.glossaries[0];
    if (!pin) return invalidGlossaryPinResponse();
    return {
      sessionId,
      version: replaced.version,
      pinnedGlossaryPresetId: pin.sourceId,
      pinnedGlossaryVersion: pin.documentVersion,
      pinnedGlossaryFingerprint: pin.fingerprint ?? "",
      updatedAt: replaced.updatedAt,
    };
  }

  async replaceGlossaryPinsOwned(
    sessionId: string,
    hostId: string,
    expectedVersion: number,
    glossaries: readonly LiveSessionGlossaryPinSelection[],
  ): Promise<LiveSessionGlossaryPins> {
    const response = await this.fetchFn(`${this.baseUrl}/rest/v1/rpc/replace_live_session_glossary_pins_v2`, {
      method: "POST",
      cache: "no-store",
      headers: {
        ...supabaseAdminHeaders(this.credential),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_session_id: sessionId,
        p_host_id: hostId,
        p_expected_session_version: expectedVersion,
        p_glossaries: glossaries.map((glossary) => ({
          source_kind: glossary.sourceKind,
          source_id: glossary.sourceId,
          document_version: glossary.documentVersion ?? 1,
        })),
      }),
    });
    if (!response.ok) throw await mapGlossaryPinStoreFailure(response, "replace");
    return parseGlossaryPinsRpcResponse(await response.json(), sessionId, expectedVersion, glossaries);
  }

  async getGlossaryPinsOwned(sessionId: string, hostId: string): Promise<LiveSessionGlossaryPins> {
    const current = await this.get(sessionId);
    if (!current || current.hostId !== hostId) {
      throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    }
    const response = await this.fetchFn(`${this.baseUrl}/rest/v1/rpc/read_live_session_pinned_glossaries_v2`, {
      method: "POST",
      cache: "no-store",
      headers: {
        ...supabaseAdminHeaders(this.credential),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_live_session_id: sessionId }),
    });
    if (!response.ok) throw await mapGlossaryPinStoreFailure(response, "read");
    return parseGlossaryReadRpcResponse(await response.json(), current);
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

  async listOwnedActive(hostId: string, offset = 0): Promise<LiveSession[]> {
    const query = new URLSearchParams({
      host_id: `eq.${hostId}`,
      status: `in.(${ACTIVE_SESSION_STATUSES.join(",")})`,
      archive_deleted_at: "is.null",
      order: "created_at.desc,id.desc",
      limit: "101", offset: String(offset),
    });
    const rows = await this.request<SupabaseSessionRow[]>(`/rest/v1/live_sessions?${query}`, { method: "GET" });
    // Recovery is a list: one row with unreadable stored state must not blank
    // the host's whole list (Task 4 fix I3). Skip it and log code + id only;
    // `get` / `getOwned` / `getSnapshot` still fail closed on the same row.
    const sessions: LiveSession[] = [];
    for (const row of rows) {
      try {
        sessions.push(fromRow(row));
      } catch (error: unknown) {
        if (!(error instanceof LiveSessionError) || error.code !== "INVALID_STORED_SESSION") throw error;
        const rowId = typeof (row as { id?: unknown })?.id === "string" ? (row as { id: string }).id : "<unknown>";
        console.error(`live session row skipped: ${error.code} id=${rowId}`);
      }
    }
    return sessions;
  }

  async hasPreparingScheduledBetween(startAt: string, endAt: string): Promise<boolean> {
    const start = Date.parse(startAt);
    const end = Date.parse(endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("INVALID_SCHEDULE_WINDOW");
    const startIso = new Date(start).toISOString();
    const endIso = new Date(end).toISOString();
    const query = new URLSearchParams({
      select: "id",
      status: "eq.preparing",
      and: `(scheduled_at.gte.${startIso},scheduled_at.lte.${endIso})`,
      expires_at: `gt.${new Date().toISOString()}`,
      limit: "1",
    });
    const rows = await this.request<Array<{ id: string }>>(`/rest/v1/live_sessions?${query}`, { method: "GET" });
    return rows.length > 0;
  }

  async setCoverImageOwned(
    sessionId: string,
    hostId: string,
    path: string,
    expectedCurrentPath: string | null,
  ): Promise<boolean> {
    if (!path) return false;
    const query = new URLSearchParams({
      id: `eq.${sessionId}`,
      host_id: `eq.${hostId}`,
      status: `in.(${ACTIVE_SESSION_STATUSES.join(",")})`,
      expires_at: `gt.${new Date().toISOString()}`,
      cover_image_path: expectedCurrentPath === null ? "is.null" : `eq.${expectedCurrentPath}`,
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
    const [session, rows, speakerRows, utteranceRows, topicSnapshot] = await Promise.all([
      this.get(sessionId),
      this.request<Array<{ last_seq: number; captions: CaptionEvent[]; speaker_legend: SpeakerAssignment[] }>>(`/rest/v1/live_snapshots?session_id=eq.${encodeURIComponent(sessionId)}&language=eq.${encodeURIComponent(language)}&limit=1`, { method: "GET" }),
      this.request<SpeakerAssignment[]>(`/rest/v1/session_speakers?session_id=eq.${encodeURIComponent(sessionId)}&select=speakerId:speaker_id,label,colorToken:color_token,voiceName:voice_name,voiceStatus:voice_status,lastSeenAt:last_seen_at`, { method: "GET" }),
      this.fetchUtteranceHistoryWindow(sessionId, language),
      this.getTopicSnapshot(sessionId, language),
    ]);
    if (!session) return null;
    // History comes from live_utterances, NOT from live_snapshots.captions:
    // that column stores a single-element array (the latest caption, replaced
    // on every conflict), so serving it made a viewer that joined, reconnected,
    // or switched language lose everything it had already shown. Falling back
    // to the snapshot row keeps sessions recorded before this change readable.
    const history = [...utteranceRows]
      .sort((left, right) => Number(left.seq) - Number(right.seq))
      .map((row) => captionFromUtterance(sessionId, language, row));
    const snapshotCaptions = rows[0]?.captions ?? [];
    const captions = history.length > 0 ? history : snapshotCaptions;
    if (captions.some(caption => !hasValidTranslationCaptureProvenance(caption))) {
      throw new LiveSessionError("번역 기록의 출처 정보를 확인할 수 없습니다.", "INVALID_TRANSLATION_CAPTURE", 503);
    }
    return {
      session,
      language,
      // lastSeq must cover whatever we actually served, or the gateway's
      // gap-replay would resend captions the viewer already has.
      lastSeq: history.length > 0
        ? Math.max(...history.map((caption) => caption.seq), 0)
        : Math.max(rows[0]?.last_seq ?? 0, ...snapshotCaptions.map((caption) => caption.seq), 0),
      captions,
      speakers: rows[0]?.speaker_legend ?? speakerRows,
      topics: topicSnapshot.topics,
      topicMemberships: topicSnapshot.topicMemberships,
    };
  }

  async getTopicSnapshot(sessionId: string, language: string, options: { signal?: AbortSignal } = {}): Promise<LiveTopicSnapshot> {
    const value = await this.request<unknown>("/rest/v1/rpc/read_live_topic_context", {
      method: "POST",
      signal: options.signal,
      body: JSON.stringify({ p_session_id: sessionId, p_language: language }),
    });
    try {
      return parseTopicContextRpc(value, sessionId);
    } catch {
      throw new LiveSessionError("저장된 라이브 주제 정보가 올바르지 않습니다.", "INVALID_STORED_TOPIC_CONTEXT", 500);
    }
  }

  async getTopicTranscript(sessionId: string, options: LiveTopicTranscriptReadOptions = {}): Promise<LiveTopicSnapshot> {
    const maxTopics = resolveTopicTranscriptLimit(options.maxTopics, MAX_TOPIC_TRANSCRIPT_ROWS);
    const maxTopicMemberships = resolveTopicTranscriptLimit(options.maxTopicMemberships, MAX_TOPIC_TRANSCRIPT_ROWS);
    try {
      const [topicRows, membershipRows] = await Promise.all([
        this.fetchTopicTranscriptRows(
          "live_topics",
          sessionId,
          "id,session_id,ordinal,title,summary,status,completion_reason,detector_health,started_at,completed_at,version",
          "ordinal.asc",
          maxTopics,
          options.signal,
        ),
        this.fetchTopicTranscriptRows(
          "live_topic_utterances",
          sessionId,
          "session_id,topic_id,utterance_key,position",
          "topic_id.asc,position.asc",
          maxTopicMemberships,
          options.signal,
        ),
      ]);
      return validateTopicTranscript(
        topicRows.map((row) => parseLiveTopic(topicFromRpc(row), sessionId)),
        membershipRows.map((row) => parseLiveTopicMembership(topicMembershipFromRpc(row), sessionId)),
      );
    } catch (error: unknown) {
      if (error instanceof LiveSessionError) throw error;
      throw new LiveSessionError("저장된 라이브 주제 기록이 올바르지 않습니다.", "INVALID_STORED_TOPIC_TRANSCRIPT", 500);
    }
  }

  private async fetchTopicTranscriptRows(
    table: "live_topics" | "live_topic_utterances",
    sessionId: string,
    select: string,
    order: string,
    maxRows: number,
    signal: AbortSignal | undefined,
  ): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let offset = 0; offset <= maxRows; offset += TOPIC_TRANSCRIPT_PAGE_SIZE) {
      const query = new URLSearchParams({
        session_id: `eq.${sessionId}`,
        select,
        order,
        limit: String(TOPIC_TRANSCRIPT_PAGE_SIZE),
        offset: String(offset),
      });
      const page = await this.request<unknown>(`/rest/v1/${table}?${query}`, { method: "GET", signal });
      if (!Array.isArray(page) || page.length > TOPIC_TRANSCRIPT_PAGE_SIZE) throw new Error("Invalid topic transcript page.");
      if (rows.length + page.length > maxRows) throw new Error("Topic transcript exceeds its bound.");
      rows.push(...page);
      if (page.length < TOPIC_TRANSCRIPT_PAGE_SIZE) return rows;
    }
    throw new Error("Topic transcript exceeds its bound.");
  }

  private async fetchUtteranceHistoryWindow(sessionId: string, language: string): Promise<UtteranceRow[]> {
    const query = new URLSearchParams({
      session_id: `eq.${sessionId}`,
      language: `eq.${language}`,
      select: "seq,participant_id,speaker_label,speaker_name,speaker_profile,speaker_attribution,text,source_text,source_language,source_started_at,origin,utterance_key,translation_status,source_ended_at,emitted_at,authoritative_source_id,translation_capture",
      // 2026-07-26 fix: Serve the oldest bounded window, then let the gateway
      // keyset-replay every later page. One giant snapshot exceeded 5 seconds.
      order: "seq.asc",
      limit: String(SNAPSHOT_HISTORY_LIMIT),
    });
    const rows = await this.request<UtteranceRow[]>(`/rest/v1/live_utterances?${query}`, { method: "GET" });
    const sourceIds = [...new Set(rows.flatMap((row) => row.authoritative_source_id ? [row.authoritative_source_id] : []))];
    if (sourceIds.length === 0) return rows;
    const values = await this.request<Array<{ source_utterance_id: string; language_observation: unknown }>>(
      "/rest/v1/rpc/read_live_caption_source_observations_v1", { method: "POST",
        body: JSON.stringify({ p_session_id: sessionId, p_source_ids: sourceIds }) });
    if (!Array.isArray(values) || values.length !== sourceIds.length) {
      throw new LiveSessionError("원문 언어 정보가 올바르지 않습니다.", "INVALID_SOURCE_OBSERVATION_RESPONSE", 503);
    }
    const observations = new Map<string, LanguageObservation | null>();
    for (const value of values) {
      const parsed = languageObservationSchema.nullable().safeParse(value.language_observation);
      if (!sourceIds.includes(value.source_utterance_id) || observations.has(value.source_utterance_id) || !parsed.success) {
        throw new LiveSessionError("원문 언어 정보가 올바르지 않습니다.", "INVALID_SOURCE_OBSERVATION_RESPONSE", 503);
      }
      observations.set(value.source_utterance_id, parsed.data);
    }
    return rows.map((row) => {
      const observation = row.authoritative_source_id ? observations.get(row.authoritative_source_id) : null;
      return observation ? { ...row, languageObservation: observation } : row;
    });
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

function resolveTopicTranscriptLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TOPIC_TRANSCRIPT_ROWS) {
    throw new LiveSessionError("저장된 라이브 주제 기록이 올바르지 않습니다.", "INVALID_STORED_TOPIC_TRANSCRIPT", 500);
  }
  return value;
}

function parseTopicContextRpc(value: unknown, sessionId: string): LiveTopicSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid topic context.");
  const record = value as Record<string, unknown>;
  const expectedKeys = new Set(["ok", "event", "topics", "topic_memberships", "memberships_added", "latest_source_seq"]);
  if (!hasExactKeys(record, expectedKeys)
    || record.ok !== true
    || record.event !== "topic-upsert"
    || !Array.isArray(record.memberships_added)
    || record.memberships_added.length !== 0
    || !Number.isSafeInteger(record.latest_source_seq)
    || Number(record.latest_source_seq) < 0
    || !Array.isArray(record.topics)
    || !Array.isArray(record.topic_memberships)) {
    throw new Error("Invalid topic context.");
  }
  return parseLiveTopicSnapshot({
    topics: record.topics.map(topicFromRpc),
    topicMemberships: record.topic_memberships.map(topicMembershipFromRpc),
  }, sessionId);
}

const GLOSSARY_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const HOST_GLOSSARY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BUILTIN_GLOSSARY_ID_SET = new Set<string>(BUILTIN_GLOSSARY_IDS);

function parseGlossaryPinsRpcResponse(
  value: unknown,
  sessionId: string,
  expectedVersion: number,
  expectedGlossaries: readonly LiveSessionGlossaryPinSelection[],
): LiveSessionGlossaryPins {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object" || Array.isArray(value[0])) {
    return invalidGlossaryPinResponse();
  }
  const row = value[0] as Record<string, unknown>;
  if (!hasExactKeys(row, new Set(["session_id", "version", "glossaries", "updated_at"]))
    || row.session_id !== sessionId
    || row.version !== expectedVersion + 1
    || !Array.isArray(row.glossaries)
    || row.glossaries.length !== expectedGlossaries.length
    || typeof row.updated_at !== "string"
    || !Number.isFinite(Date.parse(row.updated_at))) {
    return invalidGlossaryPinResponse();
  }
  const glossaries = row.glossaries.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const pin = value as Record<string, unknown>;
    const expected = expectedGlossaries[index];
    if (!hasExactKeys(pin, new Set(["source_kind", "source_id", "document_version", "ordinal", "fingerprint"]))
      || pin.source_kind !== expected.sourceKind
      || pin.source_id !== expected.sourceId
      || pin.document_version !== (expected.documentVersion ?? 1)
      || pin.ordinal !== index + 1
      || (expected.sourceKind === "host"
        ? typeof pin.fingerprint !== "string" || !GLOSSARY_FINGERPRINT_PATTERN.test(pin.fingerprint)
        : pin.fingerprint !== null)) return null;
    return {
      sourceKind: expected.sourceKind,
      sourceId: expected.sourceId,
      documentVersion: expected.documentVersion ?? 1,
      ordinal: index + 1,
      fingerprint: pin.fingerprint as string | null,
    };
  });
  if (glossaries.some((glossary) => glossary === null)) return invalidGlossaryPinResponse();
  return {
    sessionId,
    version: row.version,
    glossaries: glossaries as LiveSessionGlossaryPins["glossaries"],
    updatedAt: row.updated_at,
  };
}

function parseGlossaryReadRpcResponse(value: unknown, session: LiveSession): LiveSessionGlossaryPins {
  if (!Array.isArray(value) || value.length > 5) return invalidGlossaryPinResponse();
  const glossaries = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (!hasExactKeys(row, new Set([
      "session_id", "ordinal", "source_kind", "source_id", "document_version",
      "fingerprint", "glossary_document",
    ]))
      || row.session_id !== session.id
      || row.ordinal !== index + 1
      || (row.source_kind !== "builtin" && row.source_kind !== "host")
      || typeof row.source_id !== "string"
      || (row.source_kind === "builtin"
        ? !BUILTIN_GLOSSARY_ID_SET.has(row.source_id)
        : !HOST_GLOSSARY_ID_PATTERN.test(row.source_id))
      || !Number.isSafeInteger(row.document_version)
      || Number(row.document_version) < 1
      || Number(row.document_version) > 2_147_483_647
      || (row.source_kind === "builtin" && row.document_version !== 1)
      || (row.source_kind === "host"
        ? typeof row.fingerprint !== "string" || !GLOSSARY_FINGERPRINT_PATTERN.test(row.fingerprint)
        : row.fingerprint !== null)
      || (row.source_kind === "host"
        ? !row.glossary_document || typeof row.glossary_document !== "object" || Array.isArray(row.glossary_document)
        : row.glossary_document !== null)) return null;
    return {
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      documentVersion: Number(row.document_version),
      ordinal: index + 1,
      fingerprint: row.fingerprint as string | null,
    };
  });
  if (glossaries.some((glossary) => glossary === null)) return invalidGlossaryPinResponse();
  const identities = new Set(glossaries.map((glossary) => `${glossary?.sourceKind}\u0000${glossary?.sourceId}`));
  if (identities.size !== glossaries.length) return invalidGlossaryPinResponse();
  return {
    sessionId: session.id,
    version: session.version,
    glossaries: glossaries as LiveSessionGlossaryPins["glossaries"],
    updatedAt: new Date().toISOString(),
  };
}

function parseGlossaryPinRpcResponse(
  value: unknown,
  sessionId: string,
  expectedVersion: number,
  presetId: string,
  documentVersion: number,
): LiveSessionGlossaryPin {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object" || Array.isArray(value[0])) {
    return invalidGlossaryPinResponse();
  }
  const row = value[0] as Record<string, unknown>;
  if (!hasExactKeys(row, new Set([
    "session_id", "version", "pinned_glossary_preset_id", "pinned_glossary_version",
    "pinned_glossary_fingerprint", "updated_at",
  ]))
    || row.session_id !== sessionId
    || row.version !== expectedVersion + 1
    || row.pinned_glossary_preset_id !== presetId
    || row.pinned_glossary_version !== documentVersion
    || typeof row.pinned_glossary_fingerprint !== "string"
    || !GLOSSARY_FINGERPRINT_PATTERN.test(row.pinned_glossary_fingerprint)
    || typeof row.updated_at !== "string"
    || !Number.isFinite(Date.parse(row.updated_at))) {
    return invalidGlossaryPinResponse();
  }
  return {
    sessionId,
    version: row.version,
    pinnedGlossaryPresetId: presetId,
    pinnedGlossaryVersion: documentVersion,
    pinnedGlossaryFingerprint: row.pinned_glossary_fingerprint,
    updatedAt: row.updated_at,
  };
}

function invalidGlossaryPinResponse(): never {
  throw new LiveSessionError("세션 용어집 저장 응답이 올바르지 않습니다.", "INVALID_GLOSSARY_PIN_RESPONSE", 502);
}

const GLOSSARY_STORE_DIAGNOSTIC_CODES = new Set(["42883", "42P01", "42703", "42702", "PGRST202"]);

async function mapGlossaryPinStoreFailure(response: Response, operation: "replace" | "read"): Promise<LiveSessionError> {
  let message: unknown;
  let databaseCode: unknown;
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const error = payload as Record<string, unknown>;
      message = error.message;
      databaseCode = error.code;
    }
  } catch {
    message = undefined;
  }
  if (message === "ACTIVE_SESSION_GLOSSARY_IMMUTABLE") {
    return new LiveSessionError("진행 중이거나 종료된 세션의 용어집은 변경할 수 없습니다.", message, 409);
  }
  if (message === "LIVE_SESSION_VERSION_CONFLICT") {
    return new LiveSessionError("다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도하세요.", "VERSION_CONFLICT", 409);
  }
  if (message === "LIVE_SESSION_NOT_FOUND") {
    return new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
  }
  if (message === "GLOSSARY_DOCUMENT_VERSION_NOT_FOUND" || message === "ACTIVE_GLOSSARY_DOCUMENT_VERSION_NOT_FOUND") {
    return new LiveSessionError("용어집 버전을 찾을 수 없습니다.", message, 404);
  }
  if (message === "INVALID_LIVE_GLOSSARY_PIN_INPUT"
    || message === "INVALID_BUILTIN_GLOSSARY"
    || message === "DUPLICATE_LIVE_GLOSSARY_PIN") {
    return new LiveSessionError("세션 용어집 요청이 올바르지 않습니다.", "INVALID_GLOSSARY_SELECTION", 400);
  }
  if (message === "PINNED_GLOSSARY_VERSION_MISMATCH") {
    return new LiveSessionError("고정된 용어집 버전을 확인할 수 없습니다.", message, 409);
  }
  // 2026-08-31 fix: DB 함수 오류를 재현할 수 있게 제한된 코드만 기록한다. 원격 오류 문구에는 계정·사전·SQL 내용이 들어갈 수 있다.
  console.error("live glossary store request failed", {
    operation,
    status: response.status,
    code: typeof databaseCode === "string" && GLOSSARY_STORE_DIAGNOSTIC_CODES.has(databaseCode) ? databaseCode : "UNCLASSIFIED",
  });
  return new LiveSessionError("세션 용어집 저장소에 연결하지 못했습니다.", "LIVE_STORE_UNAVAILABLE", 503);
}

function validateTopicTranscript(
  topics: LiveTopicSnapshot["topics"],
  topicMemberships: LiveTopicSnapshot["topicMemberships"],
): LiveTopicSnapshot {
  const topicIds = new Set<string>();
  const ordinals = new Set<number>();
  let activeCount = 0;
  for (const topic of topics) {
    if (topicIds.has(topic.id) || ordinals.has(topic.ordinal)) throw new Error("Duplicate live transcript topic.");
    topicIds.add(topic.id);
    ordinals.add(topic.ordinal);
    if (topic.status === "active") activeCount += 1;
  }
  if (activeCount > 1) throw new Error("Multiple active transcript topics.");
  const utteranceKeys = new Set<string>();
  const topicPositions = new Set<string>();
  for (const membership of topicMemberships) {
    const topicPosition = `${membership.topicId}\u0000${membership.position}`;
    if (!topicIds.has(membership.topicId)
      || utteranceKeys.has(membership.utteranceKey)
      || topicPositions.has(topicPosition)) {
      throw new Error("Invalid live transcript membership.");
    }
    utteranceKeys.add(membership.utteranceKey);
    topicPositions.add(topicPosition);
  }
  return { topics, topicMemberships };
}

function topicFromRpc(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid topic.");
  const row = value as Record<string, unknown>;
  if (!hasExactKeys(row, new Set([
    "id", "session_id", "ordinal", "title", "summary", "status", "completion_reason",
    "detector_health", "started_at", "completed_at", "version",
  ]))) throw new Error("Invalid topic.");
  return {
    id: row.id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    title: row.title,
    summary: row.summary,
    status: row.status,
    completionReason: row.completion_reason,
    detectorHealth: row.detector_health,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    version: row.version,
  };
}

function topicMembershipFromRpc(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid topic membership.");
  const row = value as Record<string, unknown>;
  if (!hasExactKeys(row, new Set(["session_id", "topic_id", "utterance_key", "position"]))) {
    throw new Error("Invalid topic membership.");
  }
  return {
    sessionId: row.session_id,
    topicId: row.topic_id,
    utteranceKey: row.utterance_key,
    position: row.position,
  };
}

function hasExactKeys(record: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

/** Memory store mirror of the Supabase byte budget: the same body, the same trim, stored back on the session. */
function withBudgetedPreferences(session: LiveSession): LiveSession {
  const body = fitEventMetadataToByteBudget(eventMetadataBody(session));
  return { ...session, modelPreferences: body.modelPreferences as LiveModelPreferences };
}

function eventMetadataBody(metadata: Pick<LiveSession, "ticker" | "eventType" | "agenda" | "modelPreferences">): Record<string, unknown> {
  return {
    ticker: metadata.ticker ?? null,
    eventType: metadata.eventType ?? null,
    agenda: metadata.agenda ?? [],
    modelPreferences: readLiveModelPreferences(metadata.modelPreferences),
  };
}

function applyEventContext(session: LiveSession, context: SupabaseSessionEventContextRow | null): LiveSession {
  if (!context) return session;
  if (context.session_id !== session.id) {
    throw new LiveSessionError("저장된 이벤트 컨텍스트가 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
  }
  const eventMetadata = parseStoredEventMetadata(context.event_metadata);
  const activeSection = parseStoredSection(context.active_section_key);
  const activeStartedAt = parseActiveSectionStartedAt(context.sections, activeSection);
  return {
    ...session,
    companyName: parseStoredNullableText(context.event_company_name, 160, "event_company_name"),
    ticker: eventMetadata.ticker,
    fiscalPeriod: parseStoredNullableText(context.event_reporting_period, 80, "event_reporting_period"),
    eventType: eventMetadata.eventType,
    agenda: eventMetadata.agenda,
    modelPreferences: eventMetadata.modelPreferences,
    activeSection,
    sectionStartedAt: activeStartedAt,
  };
}

function parseActiveSectionStartedAt(sections: unknown, activeSection: LiveSessionSection): string | null {
  if (sections === undefined || sections === null) return null;
  if (!Array.isArray(sections)) {
    throw new LiveSessionError("저장된 이벤트 구간이 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
  }
  const active = sections.find((section) => {
    if (!section || typeof section !== "object" || Array.isArray(section)) return false;
    const record = section as Record<string, unknown>;
    return record.section_key === activeSection && record.status === "active";
  });
  if (active === undefined) return null;
  const startedAt = (active as Record<string, unknown>).started_at;
  return parseStoredNullableTimestamp(startedAt, "section.started_at");
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
  if (row.output_mode !== undefined
    && row.output_mode !== "captions"
    && row.output_mode !== "captions_audio"
    && row.output_mode !== "audio") {
    throw new LiveSessionError("저장된 출력 모드가 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
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
  const outputMode = normalizeStoredOutputMode();
  const voiceProvider: LiveSession["voiceProvider"] = "gemini";
  const participantSpeakingEnabled = row.participant_speaking_enabled ?? false;
  if (typeof participantSpeakingEnabled !== "boolean") {
    throw new LiveSessionError("저장된 참여자 발언권 설정이 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
  }
  const eventMetadata = parseStoredEventMetadata(row.event_metadata);
  // 인계(handover) 계약: 게이트웨이 readiness RPC가 기록한 활성화 키. 형식이
  // 어긋난 값은 클라이언트로 흘리지 않는다(reattach 실패만 유발).
  const storedActivationKey = row.gateway_activation_key ?? null;
  const activationKey = typeof storedActivationKey === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(storedActivationKey)
    ? storedActivationKey
    : null;
  return {
    activationKey,
    id: row.id,
    hostId: row.host_id,
    title,
    scheduledAt,
    sessionType,
    outputMode,
    voiceProvider,
    maxViewers: row.max_viewers ?? 200,
    participantSpeakingEnabled,
    glossaryPack: row.glossary_pack ?? "general_cre",
    status: row.status,
    languages: [firstLanguage, ...remainingLanguages],
    viewerCount: row.viewer_count,
    version: row.version,
    // 2026-08-31 fix: Closing entry retains its stored expiry; clients must
    // receive null for a paused admission so old QR/code actions disappear.
    admissionOpenUntil: row.admission_state === "open" ? row.admission_open_until : null,
    expiresAt: row.expires_at,
    endedAt: row.ended_at ?? null,
    hasCoverImage: Boolean(row.cover_image_path),
    coverImageVersion: coverImageVersionFromPath(row.cover_image_path),
    companyName: parseStoredNullableText(row.event_company_name, 160, "event_company_name"),
    ticker: eventMetadata.ticker,
    fiscalPeriod: parseStoredNullableText(row.event_reporting_period, 80, "event_reporting_period"),
    eventType: eventMetadata.eventType,
    agenda: eventMetadata.agenda,
    modelPreferences: eventMetadata.modelPreferences,
    activeSection: "prepared_remarks",
    sectionStartedAt: null,
  };
}

function parseStoredEventMetadata(value: unknown): {
  modelPreferences: LiveModelPreferences;
  ticker: string | null;
  eventType: LiveEventType | null;
  agenda: LiveAgendaItem[];
} {
  if (value === undefined || value === null) return { ticker: null, eventType: null, agenda: [], modelPreferences: readLiveModelPreferences(undefined) };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LiveSessionError("저장된 이벤트 메타데이터가 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
  }
  const record = value as Record<string, unknown>;
  let modelPreferences: LiveModelPreferences;
  try { modelPreferences = readLiveModelPreferences(record.modelPreferences); } catch {
    throw new LiveSessionError("저장된 모델 설정이 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
  }
  return {
    ticker: parseStoredTicker(record.ticker),
    eventType: parseStoredEventType(record.eventType),
    agenda: parseStoredAgenda(record.agenda),
    modelPreferences,
  };
}

function parseStoredNullableText(value: unknown, maximumLength: number, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string"
    || Array.from(value).length < 1
    || Array.from(value).length > maximumLength
    || /[<>]|\p{Cc}|\p{Cf}|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/u.test(value)) {
    throw new LiveSessionError(`저장된 ${field} 값이 올바르지 않습니다.`, "INVALID_STORED_SESSION", 500);
  }
  return value;
}

function parseStoredTicker(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[A-Z0-9.-]{1,12}$/u.test(value)) {
    throw new LiveSessionError("저장된 티커가 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
  }
  return value;
}

function parseStoredEventType(value: unknown): LiveEventType | null {
  if (value === undefined || value === null) return null;
  if (value !== "earnings_call" && value !== "investor_day" && value !== "conference" && value !== "other") {
    throw new LiveSessionError("저장된 이벤트 유형이 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
  }
  return value;
}

function parseStoredAgenda(value: unknown): LiveAgendaItem[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new LiveSessionError("저장된 안건이 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new LiveSessionError("저장된 안건이 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
    }
    const record = item as Record<string, unknown>;
    if (record.ordinal !== index + 1) {
      throw new LiveSessionError("저장된 안건 순서가 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
    }
    const label = parseStoredNullableText(record.label, 120, "agenda.label");
    if (label === null) {
      throw new LiveSessionError("저장된 안건이 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
    }
    return { ordinal: index + 1, label };
  });
}

function parseStoredSection(value: unknown): LiveSessionSection {
  if (value === undefined || value === null) return "prepared_remarks";
  if (value !== "prepared_remarks" && value !== "qa" && value !== "other") {
    throw new LiveSessionError("저장된 세션 구간이 올바르지 않습니다.", "INVALID_STORED_SESSION", 500);
  }
  return value;
}

function parseStoredNullableTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new LiveSessionError(`저장된 ${field} 값이 올바르지 않습니다.`, "INVALID_STORED_SESSION", 500);
  }
  return value;
}

function normalizeLegacySessionType(mode: SupabaseSessionRow["mode"]): LiveSession["sessionType"] {
  return mode === "presentation" ? "presentation" : "meeting";
}

function normalizeStoredOutputMode(): LiveSession["outputMode"] {
  return "captions";
}

let singleton: LiveSessionStore | null = null;

export function getLiveSessionStore(): LiveSessionStore {
  if (singleton) return singleton;
  const { baseUrl, credential } = getLiveStoreConfig();
  singleton = new SupabaseLiveSessionStore(baseUrl, credential);
  return singleton;
}
