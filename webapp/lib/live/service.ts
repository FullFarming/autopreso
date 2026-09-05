import type { GlossaryPack, LiveAgendaItem, LiveEventType, LiveOutputMode, LiveSession, LiveSessionGlossaryPin, LiveSessionGlossaryPins, LiveSessionSection, LiveSessionType, LiveSnapshot, LiveVoiceProvider } from "../live-contract";
import { validateEngineForLanguages } from "../../../packages/caption-core/caption-engine-catalog.js";
import { LiveSessionError } from "./errors";
import {
  defaultEngineSelection,
  readLiveModelPreferences,
  readNewLiveModelPreferences,
  type EngineSelection,
  type LiveModelPreferences,
} from "./model-preferences";
import type { LiveSessionStore } from "./store";
import {
  parseAgenda,
  parseEventType,
  parseGlossaryPack,
  parseLanguages,
  parseLiveGlossaryPinInput,
  parseLiveGlossaryPinsInput,
  parseMaxViewers,
  parsePublicMetadata,
  parseScheduledAt,
  parseSection,
  parseSectionTransitionKey,
  parseSessionType,
  parseSourceSeq,
  parseTitle,
  parseTicker,
  parseVersion,
} from "./validation";

const SESSION_ACCESS_WINDOW_MILLISECONDS = 6 * 60 * 60 * 1_000;
const MAX_SCHEDULE_AHEAD_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
export class LiveSessionService {
  private readonly store: LiveSessionStore;
  private readonly now: () => number;

  constructor(store: LiveSessionStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  async create(hostId: string, input: CreateServiceInput, options: CreateServiceOptions = {}): Promise<LiveSession> {
    const { sessionType, outputMode, voiceProvider } = normalizeSessionSettings(input);
    const participantSpeakingEnabled = parseParticipantSpeakingEnabled(input.participantSpeakingEnabled, false);
    assertParticipantSpeakingConfiguration(sessionType, participantSpeakingEnabled);
    const languages = parseLanguages(input.languages === undefined ? ["ko", "en"] : input.languages);
    const title = parseTitle(input.title ?? "Live Session");
    const scheduledAt = parseScheduledAt(input.scheduledAt);
    const eventMetadata = parseEventMetadata(input);
    const engine = resolveEngineAuthority(readRequestedEngine(input.modelPreferences), options, options.engineDefaults ?? defaultEngineSelection());
    assertEngineForLanguages(engine, languages);
    const modelPreferences: LiveModelPreferences = { engine, engineHistory: [], ...(options.assignmentRevision ? { assignmentRevision: options.assignmentRevision } : {}) };
    const scheduledTimestamp = scheduledAt === null ? this.now() : Date.parse(scheduledAt);
    if (scheduledTimestamp > this.now() + MAX_SCHEDULE_AHEAD_MILLISECONDS) {
      throw new LiveSessionError("라이브 일정은 30일 이내로 예약하세요.", "SCHEDULE_TOO_FAR", 400);
    }
    const session: LiveSession = {
      id: crypto.randomUUID(),
      hostId,
      title,
      scheduledAt,
      sessionType,
      outputMode,
      voiceProvider,
      maxViewers: input.maxViewers === undefined ? 200 : parseMaxViewers(input.maxViewers),
      participantSpeakingEnabled,
      glossaryPack: input.glossaryPack === undefined ? "general_cre" : parseGlossaryPack(input.glossaryPack),
      status: "preparing",
      languages,
      viewerCount: 0,
      version: 1,
      admissionOpenUntil: null,
      expiresAt: new Date(Math.max(this.now(), scheduledTimestamp) + SESSION_ACCESS_WINDOW_MILLISECONDS).toISOString(),
      endedAt: null,
      hasCoverImage: false,
      ...eventMetadata,
      modelPreferences,
      activeSection: "prepared_remarks",
      sectionStartedAt: null,
    };
    return this.store.create(session);
  }

  /** Contract C10: mark the uploaded cover object on the owned session. */
  async setCoverImage(
    hostId: string,
    sessionId: string,
    path: string,
    expectedCurrentPath: string | null,
  ): Promise<void> {
    const updated = await this.store.setCoverImageOwned(sessionId, hostId, path, expectedCurrentPath);
    if (updated) return;
    const current = await this.store.get(sessionId);
    if (!current || current.hostId !== hostId) {
      throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    }
    if (!new Set(["preparing", "live", "paused"]).has(current.status)) {
      throw new LiveSessionError("종료된 세션에는 커버를 올릴 수 없습니다.", "SESSION_ENDED", 409);
    }
    throw new LiveSessionError("다른 커버가 먼저 저장되었습니다. 다시 시도하세요.", "COVER_FINALIZE_CONFLICT", 409);
  }

  async update(hostId: string, sessionId: string, input: UpdateServiceInput, options: UpdateServiceOptions = {}): Promise<LiveSession> {
    const version = parseVersion(input.version);
    const current = await this.store.get(sessionId);
    if (!current || current.hostId !== hostId) throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    const { sessionType, outputMode, voiceProvider } = normalizeSessionSettings(input, current);
    const title = input.title === undefined ? current.title : parseTitle(input.title);
    const scheduledAt = input.scheduledAt === undefined ? current.scheduledAt : parseScheduledAt(input.scheduledAt);
    if (scheduledAt !== null && Date.parse(scheduledAt) > this.now() + MAX_SCHEDULE_AHEAD_MILLISECONDS) {
      throw new LiveSessionError("라이브 일정은 30일 이내로 예약하세요.", "SCHEDULE_TOO_FAR", 400);
    }
    const languages: [string, ...string[]] = input.languages === undefined
      ? [...current.languages]
      : parseLanguages(input.languages);
    const maxViewers = input.maxViewers === undefined ? current.maxViewers : parseMaxViewers(input.maxViewers);
    if (maxViewers < current.viewerCount) {
      throw new LiveSessionError("현재 접속자 수보다 최대 시청자를 낮출 수 없습니다.", "MAX_VIEWERS_BELOW_CURRENT", 409);
    }
    const glossaryPack = input.glossaryPack === undefined ? current.glossaryPack : parseGlossaryPack(input.glossaryPack);
    const participantSpeakingEnabled = parseParticipantSpeakingEnabled(
      input.participantSpeakingEnabled,
      current.participantSpeakingEnabled,
    );
    assertParticipantSpeakingConfiguration(sessionType, participantSpeakingEnabled);
    const eventMetadata = parseEventMetadata(input, current);
    // 2026-09-05 fix: 배정 변경은 다음 세션부터 적용한다. 편집과 재연결은 시작 시 엔진을 유지한다.
    const modelPreferences = readLiveModelPreferences(current.modelPreferences);
    assertEngineForLanguages(modelPreferences.engine, languages);
    const updated = await this.store.updateOwned(sessionId, hostId, version, {
      sessionType,
      outputMode,
      voiceProvider,
      title,
      scheduledAt,
      languages,
      maxViewers,
      participantSpeakingEnabled,
      glossaryPack,
      ...eventMetadata,
      modelPreferences,
    });
    if (!updated) throw new LiveSessionError("다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도하세요.", "VERSION_CONFLICT", 409);
    return updated;
  }

  /** The only transition that ends a Live Call. Desktop caption pause,
   *  channel restart, and controller refresh never call this boundary. */
  async end(hostId: string, sessionId: string): Promise<void> {
    if (!await this.store.terminateOwned(sessionId, hostId)) {
      throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    }
  }

  async restore(hostId: string, sessionId: string, expectedVersion: unknown): Promise<LiveSession> {
    const version = parseVersion(expectedVersion);
    const current = await this.store.getOwned(sessionId, hostId);
    if (!current || current.hostId !== hostId) throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    if (current.status === "stopped" || current.status === "failed") {
      throw new LiveSessionError("종료된 세션은 복원할 수 없습니다.", "SESSION_ENDED", 409);
    }
    if (current.version !== version) {
      throw new LiveSessionError("다른 변경이 먼저 저장되었습니다. 다시 확인해 주세요.", "VERSION_CONFLICT", 409);
    }
    const restored = await this.store.renewAccessOwned(sessionId, hostId, version);
    if (!restored || restored.status === "stopped" || restored.status === "failed") {
      throw new LiveSessionError("다른 변경이 먼저 저장되었습니다. 다시 확인해 주세요.", "VERSION_CONFLICT", 409);
    }
    return restored;
  }

  async start(hostId: string, sessionId: string, expectedVersion: unknown): Promise<LiveSession> {
    const version = parseVersion(expectedVersion);
    const started = await this.store.startOwned(sessionId, hostId, version);
    if (!started) {
      const current = await this.store.get(sessionId);
      if (!current || current.hostId !== hostId) {
        throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
      }
      if (current.status === "live") return current;
      if (current.status === "stopped" || current.status === "failed") {
        throw new LiveSessionError("종료된 세션은 시작할 수 없습니다.", "SESSION_NOT_STARTABLE", 409);
      }
      if (current.status === "paused") {
        throw new LiveSessionError("일시정지된 세션은 재개로 다시 시작하세요.", "SESSION_PAUSED", 409);
      }
      throw new LiveSessionError("다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도하세요.", "VERSION_CONFLICT", 409);
    }
    return started;
  }

  async prepareStart(hostId: string, sessionId: string, expectedVersion: unknown): Promise<LiveSession> {
    const version = parseVersion(expectedVersion);
    const current = await this.store.get(sessionId);
    if (!current || current.hostId !== hostId) {
      throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    }
    if (current.status === "live") return current;
    if (current.status === "stopped" || current.status === "failed") {
      throw new LiveSessionError("종료된 세션은 시작할 수 없습니다.", "SESSION_NOT_STARTABLE", 409);
    }
    if (current.status === "paused") {
      throw new LiveSessionError("일시정지된 세션은 재개로 다시 시작하세요.", "SESSION_PAUSED", 409);
    }
    if (current.version !== version) {
      throw new LiveSessionError("다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도하세요.", "VERSION_CONFLICT", 409);
    }
    return current;
  }

  /** Contract C4: live → paused. Idempotent when the session is already paused. */
  async pause(hostId: string, sessionId: string, expectedVersion: unknown): Promise<LiveSession> {
    return this.transition(hostId, sessionId, expectedVersion, "pause");
  }

  /** Contract C4: paused → live. Idempotent when the session is already live. */
  async resume(hostId: string, sessionId: string, expectedVersion: unknown): Promise<LiveSession> {
    return this.transition(hostId, sessionId, expectedVersion, "resume");
  }

  async transitionSection(
    hostId: string,
    sessionId: string,
    expectedVersion: unknown,
    section: unknown,
    transitionKey: unknown,
    sourceSeq?: unknown,
  ): Promise<LiveSession> {
    const version = parseVersion(expectedVersion);
    const nextSection = parseSection(section);
    const key = parseSectionTransitionKey(transitionKey);
    const seq = parseSourceSeq(sourceSeq);
    const transitioned = await this.store.transitionSectionOwned(sessionId, hostId, version, nextSection, key, seq);
    if (transitioned) return transitioned;
    const current = await this.store.get(sessionId);
    if (!current || current.hostId !== hostId) {
      throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    }
    if (current.activeSection === nextSection) return current;
    if (current.status !== "live" && current.status !== "paused") {
      throw new LiveSessionError("라이브 중인 세션만 구간을 전환할 수 있습니다.", "SESSION_SECTION_NOT_TRANSITIONABLE", 409);
    }
    throw new LiveSessionError("다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도하세요.", "VERSION_CONFLICT", 409);
  }

  async pinGlossaryVersion(hostId: string, sessionId: string, input: unknown): Promise<LiveSessionGlossaryPin> {
    const parsed = parseLiveGlossaryPinInput(input);
    return this.store.pinGlossaryVersionOwned(
      sessionId,
      hostId,
      parsed.expectedVersion,
      parsed.presetId,
      parsed.documentVersion,
    );
  }

  async replaceGlossaryPins(hostId: string, sessionId: string, input: unknown): Promise<LiveSessionGlossaryPins> {
    const parsed = parseLiveGlossaryPinsInput(input);
    return this.store.replaceGlossaryPinsOwned(
      sessionId,
      hostId,
      parsed.expectedVersion,
      parsed.glossaries,
    );
  }

  async getGlossaryPins(hostId: string, sessionId: string): Promise<LiveSessionGlossaryPins> {
    return this.store.getGlossaryPinsOwned(sessionId, hostId);
  }

  private async transition(
    hostId: string,
    sessionId: string,
    expectedVersion: unknown,
    action: "pause" | "resume",
  ): Promise<LiveSession> {
    const version = parseVersion(expectedVersion);
    const transitioned = action === "pause"
      ? await this.store.pauseOwned(sessionId, hostId, version)
      : await this.store.resumeOwned(sessionId, hostId, version);
    if (transitioned) return transitioned;
    const current = await this.store.get(sessionId);
    if (!current || current.hostId !== hostId) {
      throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    }
    const targetStatus = action === "pause" ? "paused" : "live";
    if (current.status === targetStatus) return current;
    const requiredStatus = action === "pause" ? "live" : "paused";
    if (current.status !== requiredStatus) {
      throw new LiveSessionError(
        action === "pause" ? "라이브 중인 세션만 일시정지할 수 있습니다." : "일시정지된 세션만 재개할 수 있습니다.",
        action === "pause" ? "SESSION_NOT_PAUSABLE" : "SESSION_NOT_RESUMABLE",
        409,
      );
    }
    throw new LiveSessionError("다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도하세요.", "VERSION_CONFLICT", 409);
  }

  /** Host session recovery: active sessions (preparing/live/paused) owned by the host. */
  async listActive(hostId: string, offset = 0): Promise<LiveSession[]> {
    return this.store.listOwnedActive(hostId, offset);
  }

  async snapshot(sessionId: string, language: string): Promise<LiveSnapshot> {
    const snapshot = await this.store.getSnapshot(sessionId, language);
    if (!snapshot || snapshot.session.status === "stopped") throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    if (!snapshot.session.languages.includes(language)) throw new LiveSessionError("선택한 언어는 더 이상 제공되지 않습니다.", "LANGUAGE_REMOVED", 410);
    return snapshot;
  }
}

interface LegacySessionSettingsInput {
  mode?: unknown;
  voiceOutputMode?: unknown;
}

/**
 * Spec §9 (2026-09-04): the admin console's global engine is the only Live Call
 * engine. Routes pass the resolved global default plus whether the caller is an
 * admin; the service is the authority, not the client.
 */
export interface EngineAuthorityOptions {
  /** `resolveEngineDefaultsOrFallback()`; absent only for direct callers (tests) - then the client's engine stands. */
  engineDefaults?: EngineSelection;
  assignmentRevision?: string;
  /** Admins (the console deploy path) may set an explicit engine. */
  isAdmin?: boolean;
}
export type CreateServiceOptions = EngineAuthorityOptions;
export type UpdateServiceOptions = EngineAuthorityOptions;

function readRequestedEngine(value: unknown): EngineSelection | undefined {
  return value === undefined ? undefined : readNewLiveModelPreferences(value).engine;
}

/**
 * - nothing requested -> `fallback` (the global default on create, the current engine on update)
 * - admin request -> honoured
 * - non-admin request -> REPLACED by the global default (not rejected: server authority)
 */
// Spec §9: only an admin's request is honoured. A non-admin's engine is
// replaced by the console's global engine, or — when no defaults resolved —
// by the catalog default; it is never the requested engine (Task 4 fix M3).
function resolveEngineAuthority(requested: EngineSelection | undefined, options: EngineAuthorityOptions, fallback: EngineSelection): EngineSelection {
  if (requested === undefined) return fallback;
  if (options.assignmentRevision !== undefined) return options.engineDefaults ?? fallback;
  if (options.isAdmin === true) return requested;
  return options.engineDefaults ?? defaultEngineSelection();
}

// Soniox two-way translation needs exactly two caption languages; refuse the
// combination here instead of dead-ending when the gateway opens the socket.
function assertEngineForLanguages(engine: EngineSelection, languages: readonly string[]): void {
  try {
    validateEngineForLanguages(engine, languages);
  } catch (error: unknown) {
    throw new LiveSessionError(error instanceof Error && error.message ? error.message : "자막 엔진 선택이 올바르지 않습니다.", "ENGINE_LANGUAGE_COUNT_INVALID", 400);
  }
}

interface CreateServiceInput extends LegacySessionSettingsInput {
  modelPreferences?: unknown;
  title?: unknown;
  scheduledAt?: unknown;
  sessionType?: unknown;
  outputMode?: unknown;
  voiceProvider?: unknown;
  languages?: unknown;
  maxViewers?: unknown;
  participantSpeakingEnabled?: unknown;
  glossaryPack?: unknown;
  companyName?: unknown;
  ticker?: unknown;
  fiscalPeriod?: unknown;
  eventType?: unknown;
  agenda?: unknown;
}

interface UpdateServiceInput extends LegacySessionSettingsInput {
  modelPreferences?: unknown;
  version: unknown;
  title?: unknown;
  scheduledAt?: unknown;
  sessionType?: unknown;
  outputMode?: unknown;
  voiceProvider?: unknown;
  languages?: unknown;
  maxViewers?: unknown;
  participantSpeakingEnabled?: unknown;
  glossaryPack?: unknown;
  companyName?: unknown;
  ticker?: unknown;
  fiscalPeriod?: unknown;
  eventType?: unknown;
  agenda?: unknown;
}

interface EventMetadataInput {
  companyName?: unknown;
  ticker?: unknown;
  fiscalPeriod?: unknown;
  eventType?: unknown;
  agenda?: unknown;
}

function parseParticipantSpeakingEnabled(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new LiveSessionError(
      "참여자 발언권 설정이 올바르지 않습니다.",
      "INVALID_PARTICIPANT_SPEAKING_SETTING",
      400,
    );
  }
  return value;
}

function assertParticipantSpeakingConfiguration(
  sessionType: LiveSessionType,
  participantSpeakingEnabled: boolean,
): void {
  if (participantSpeakingEnabled && sessionType !== "meeting") {
    throw new LiveSessionError(
      "참여자 발언권은 미팅 세션에서만 사용할 수 있습니다.",
      "INVALID_PARTICIPANT_SPEAKING_SETTING",
      400,
    );
  }
}

function parseEventMetadata(input: EventMetadataInput, current?: LiveSession): {
  companyName: string | null;
  ticker: string | null;
  fiscalPeriod: string | null;
  eventType: LiveEventType | null;
  agenda: LiveAgendaItem[];
} {
  return {
    companyName: input.companyName === undefined ? current?.companyName ?? null : parsePublicMetadata(input.companyName, 160, "INVALID_COMPANY_NAME"),
    ticker: input.ticker === undefined ? current?.ticker ?? null : parseTicker(input.ticker),
    fiscalPeriod: input.fiscalPeriod === undefined ? current?.fiscalPeriod ?? null : parsePublicMetadata(input.fiscalPeriod, 80, "INVALID_FISCAL_PERIOD"),
    eventType: input.eventType === undefined ? current?.eventType ?? null : parseEventType(input.eventType),
    agenda: input.agenda === undefined ? current?.agenda ?? [] : parseAgenda(input.agenda),
  };
}

function normalizeSessionSettings(
  input: Pick<CreateServiceInput, "sessionType" | "outputMode" | "voiceProvider" | "mode" | "voiceOutputMode">,
  current?: LiveSession,
): { sessionType: LiveSessionType; outputMode: LiveOutputMode; voiceProvider: LiveVoiceProvider } {
  const isLegacyTownhall = input.mode === "townhall";
  const sessionType = input.sessionType !== undefined
    ? parseSessionType(input.sessionType)
    : isLegacyTownhall
      ? "meeting"
      : input.mode !== undefined
        ? parseSessionType(input.mode)
        : current?.sessionType;
  if (!sessionType) throw new LiveSessionError("라이브 모드가 필요합니다.", "INVALID_LIVE_MODE", 400);

  assertLegacyOutputMode(input.outputMode ?? input.voiceOutputMode);
  assertLegacyVoiceProvider(input.voiceProvider);
  const outputMode: LiveOutputMode = "captions";
  const voiceProvider: LiveVoiceProvider = "gemini";

  return { sessionType, outputMode, voiceProvider };
}

function assertLegacyOutputMode(value: unknown): void {
  if (value === undefined || value === "captions" || value === "captions_audio" || value === "audio"
    || value === "fixed_voice" || value === "auto_voice") return;
  throw new LiveSessionError("지원하지 않는 음성 출력 모드입니다.", "INVALID_VOICE_OUTPUT_MODE", 400);
}

function assertLegacyVoiceProvider(value: unknown): void {
  if (value === undefined || value === "gemini" || value === "openai") return;
  throw new LiveSessionError("지원하지 않는 음성 공급자입니다.", "INVALID_VOICE_PROVIDER", 400);
}
