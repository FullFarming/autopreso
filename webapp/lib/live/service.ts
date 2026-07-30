import type { GlossaryPack, LiveOutputMode, LiveSession, LiveSessionType, LiveSnapshot, LiveVoiceProvider } from "../live-contract";
import { LiveSessionError } from "./errors";
import type { LiveSessionStore } from "./store";
import {
  parseGlossaryPack,
  parseLanguages,
  parseMaxViewers,
  parseOutputMode,
  parseScheduledAt,
  parseSessionType,
  parseTitle,
  parseVersion,
} from "./validation";

const SESSION_TTL_MILLISECONDS = 6 * 60 * 60 * 1_000;
const MAX_SCHEDULE_AHEAD_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const DUAL_CAPTION_LANGUAGES = ["ko", "en"] as const;
const MAX_SESSION_LANGUAGES = 3;

/** Contract C6: every Live session always carries both ko and en caption
 *  lanes, regardless of the host selection. When the union would exceed the
 *  3-language cap, host-selected extra languages are dropped from the end. */
export function withDualCaptionLanguages(languages: readonly string[]): [string, ...string[]] {
  const extras = languages.filter((language) => !DUAL_CAPTION_LANGUAGES.includes(language as typeof DUAL_CAPTION_LANGUAGES[number]));
  const keptExtras = extras.slice(0, MAX_SESSION_LANGUAGES - DUAL_CAPTION_LANGUAGES.length);
  const result: string[] = languages.filter((language) => !extras.includes(language) || keptExtras.includes(language));
  for (const required of DUAL_CAPTION_LANGUAGES) {
    if (!result.includes(required)) result.push(required);
  }
  return result as [string, ...string[]];
}

export class LiveSessionService {
  private readonly store: LiveSessionStore;
  private readonly now: () => number;

  constructor(store: LiveSessionStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  async create(hostId: string, input: CreateServiceInput): Promise<LiveSession> {
    const { sessionType, outputMode, voiceProvider } = normalizeSessionSettings(input);
    const languages = withDualCaptionLanguages(parseLanguages(input.languages));
    const title = parseTitle(input.title ?? "Live Session");
    const scheduledAt = parseScheduledAt(input.scheduledAt);
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
      maxViewers: input.maxViewers === undefined ? 50 : parseMaxViewers(input.maxViewers),
      glossaryPack: input.glossaryPack === undefined ? "general_cre" : parseGlossaryPack(input.glossaryPack),
      status: "preparing",
      languages,
      viewerCount: 0,
      version: 1,
      admissionOpenUntil: null,
      expiresAt: new Date(Math.max(this.now(), scheduledTimestamp) + SESSION_TTL_MILLISECONDS).toISOString(),
      endedAt: null,
      hasCoverImage: false,
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

  async update(hostId: string, sessionId: string, input: UpdateServiceInput): Promise<LiveSession> {
    const version = parseVersion(input.version);
    const current = await this.store.get(sessionId);
    if (!current || current.hostId !== hostId) throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    const { sessionType, outputMode, voiceProvider } = normalizeSessionSettings(input, current);
    const title = input.title === undefined ? current.title : parseTitle(input.title);
    const scheduledAt = input.scheduledAt === undefined ? current.scheduledAt : parseScheduledAt(input.scheduledAt);
    if (scheduledAt !== null && Date.parse(scheduledAt) > this.now() + MAX_SCHEDULE_AHEAD_MILLISECONDS) {
      throw new LiveSessionError("라이브 일정은 30일 이내로 예약하세요.", "SCHEDULE_TOO_FAR", 400);
    }
    const languages = input.languages === undefined
      ? withDualCaptionLanguages(current.languages)
      : withDualCaptionLanguages(parseLanguages(input.languages));
    const maxViewers = input.maxViewers === undefined ? current.maxViewers : parseMaxViewers(input.maxViewers);
    if (maxViewers < current.viewerCount) {
      throw new LiveSessionError("현재 접속자 수보다 최대 시청자를 낮출 수 없습니다.", "MAX_VIEWERS_BELOW_CURRENT", 409);
    }
    const glossaryPack = input.glossaryPack === undefined ? current.glossaryPack : parseGlossaryPack(input.glossaryPack);
    const updated = await this.store.updateOwned(sessionId, hostId, version, {
      sessionType,
      outputMode,
      voiceProvider,
      title,
      scheduledAt,
      languages,
      maxViewers,
      glossaryPack,
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

  /** Contract C4: live → paused. Idempotent when the session is already paused. */
  async pause(hostId: string, sessionId: string, expectedVersion: unknown): Promise<LiveSession> {
    return this.transition(hostId, sessionId, expectedVersion, "pause");
  }

  /** Contract C4: paused → live. Idempotent when the session is already live. */
  async resume(hostId: string, sessionId: string, expectedVersion: unknown): Promise<LiveSession> {
    return this.transition(hostId, sessionId, expectedVersion, "resume");
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
  async listActive(hostId: string): Promise<LiveSession[]> {
    return this.store.listOwnedActive(hostId);
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

interface CreateServiceInput extends LegacySessionSettingsInput {
  title?: unknown;
  scheduledAt?: unknown;
  sessionType?: unknown;
  outputMode?: unknown;
  voiceProvider?: unknown;
  languages: unknown;
  maxViewers?: unknown;
  glossaryPack?: unknown;
}

interface UpdateServiceInput extends LegacySessionSettingsInput {
  version: unknown;
  title?: unknown;
  scheduledAt?: unknown;
  sessionType?: unknown;
  outputMode?: unknown;
  voiceProvider?: unknown;
  languages?: unknown;
  maxViewers?: unknown;
  glossaryPack?: unknown;
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

  let outputMode: LiveOutputMode;
  if (input.outputMode !== undefined) outputMode = parseOutputMode(input.outputMode);
  else if (isLegacyTownhall) outputMode = "audio";
  else if (input.voiceOutputMode !== undefined) {
    if (input.voiceOutputMode === "captions") outputMode = "captions";
    else if (input.voiceOutputMode === "fixed_voice" || input.voiceOutputMode === "auto_voice") outputMode = "audio";
    else throw new LiveSessionError("지원하지 않는 음성 출력 모드입니다.", "INVALID_VOICE_OUTPUT_MODE", 400);
  } else outputMode = current?.outputMode ?? "captions";

  const voiceProvider: LiveVoiceProvider = "gemini";

  return { sessionType, outputMode, voiceProvider };
}
