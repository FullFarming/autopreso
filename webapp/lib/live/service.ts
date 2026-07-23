import type { GlossaryPack, LiveOutputMode, LiveSession, LiveSessionType, LiveSnapshot, LiveVoiceProvider } from "../live-contract";
import { LANGUAGE_CODES, toOpenAITranslationLanguageCode } from "../languageDetect";
import { LiveSessionError } from "./errors";
import type { LiveSessionStore } from "./store";
import { parseGlossaryPack, parseLanguages, parseMaxViewers, parseOutputMode, parseSessionType, parseVersion, parseVoiceProvider } from "./validation";

const SESSION_TTL_MILLISECONDS = 6 * 60 * 60 * 1_000;
const OPENAI_REALTIME_TRANSLATION_LANGUAGES = new Set(LANGUAGE_CODES.map(toOpenAITranslationLanguageCode));

export class LiveSessionService {
  private readonly store: LiveSessionStore;
  private readonly now: () => number;

  constructor(store: LiveSessionStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  async create(hostId: string, input: CreateServiceInput): Promise<LiveSession> {
    const { sessionType, outputMode, voiceProvider } = normalizeSessionSettings(input);
    const languages = parseLanguages(input.languages);
    assertOpenAIVoiceLanguages(voiceProvider, languages);
    const session: LiveSession = {
      id: crypto.randomUUID(),
      hostId,
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
      expiresAt: new Date(this.now() + SESSION_TTL_MILLISECONDS).toISOString(),
    };
    return this.store.create(session);
  }

  async update(hostId: string, sessionId: string, input: UpdateServiceInput): Promise<LiveSession> {
    const version = parseVersion(input.version);
    const current = await this.store.get(sessionId);
    if (!current || current.hostId !== hostId) throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    const { sessionType, outputMode, voiceProvider } = normalizeSessionSettings(input, current);
    const languages = input.languages === undefined ? current.languages : parseLanguages(input.languages);
    assertOpenAIVoiceLanguages(voiceProvider, languages);
    const maxViewers = input.maxViewers === undefined ? current.maxViewers : parseMaxViewers(input.maxViewers);
    if (maxViewers < current.viewerCount) {
      throw new LiveSessionError("현재 접속자 수보다 최대 시청자를 낮출 수 없습니다.", "MAX_VIEWERS_BELOW_CURRENT", 409);
    }
    const glossaryPack = input.glossaryPack === undefined ? current.glossaryPack : parseGlossaryPack(input.glossaryPack);
    const updated = await this.store.updateOwned(sessionId, hostId, version, {
      sessionType,
      outputMode,
      voiceProvider,
      languages,
      maxViewers,
      glossaryPack,
    });
    if (!updated) throw new LiveSessionError("다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도하세요.", "VERSION_CONFLICT", 409);
    return updated;
  }

  async stop(hostId: string, sessionId: string): Promise<void> {
    if (!await this.store.stopOwned(sessionId, hostId)) throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
  }

  async snapshot(sessionId: string, language: string): Promise<LiveSnapshot> {
    const snapshot = await this.store.getSnapshot(sessionId, language);
    if (!snapshot || snapshot.session.status === "stopped") throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    if (!snapshot.session.languages.includes(language)) throw new LiveSessionError("선택한 언어는 더 이상 제공되지 않습니다.", "LANGUAGE_REMOVED", 410);
    return snapshot;
  }
}

function assertOpenAIVoiceLanguages(voiceProvider: LiveVoiceProvider, languages: readonly string[]): void {
  if (voiceProvider !== "openai") return;
  const unsupportedLanguage = languages.find((language) => !OPENAI_REALTIME_TRANSLATION_LANGUAGES.has(
    toOpenAITranslationLanguageCode(language),
  ));
  if (unsupportedLanguage) {
    throw new LiveSessionError(
      `OpenAI 실시간 음성이 지원하지 않는 언어입니다: ${unsupportedLanguage}`,
      "OPENAI_VOICE_LANGUAGE_UNSUPPORTED",
      400,
    );
  }
}

interface LegacySessionSettingsInput {
  mode?: unknown;
  voiceOutputMode?: unknown;
}

interface CreateServiceInput extends LegacySessionSettingsInput {
  sessionType?: unknown;
  outputMode?: unknown;
  voiceProvider?: unknown;
  languages: unknown;
  maxViewers?: unknown;
  glossaryPack?: unknown;
}

interface UpdateServiceInput extends LegacySessionSettingsInput {
  version: unknown;
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

  const requestedVoiceProvider = input.voiceProvider === undefined
    ? current?.voiceProvider ?? "gemini"
    : parseVoiceProvider(input.voiceProvider);
  const hasAudioOutput = outputMode === "captions_audio" || outputMode === "audio";
  if (input.voiceProvider === "openai" && (sessionType !== "presentation" || !hasAudioOutput)) {
    throw new LiveSessionError(
      "OpenAI 음성 출력은 프레젠테이션의 음성 출력 모드에서만 사용할 수 있습니다.",
      "OPENAI_VOICE_OUTPUT_ONLY",
      400,
    );
  }
  const voiceProvider = sessionType === "presentation" && hasAudioOutput ? requestedVoiceProvider : "gemini";

  return { sessionType, outputMode, voiceProvider };
}
