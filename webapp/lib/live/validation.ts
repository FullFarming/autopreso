import type { GlossaryPack, LiveOutputMode, LiveSessionType, LiveVoiceProvider } from "../live-contract";
import { normalizeLanguageCode } from "../languageDetect";
import { LiveSessionError } from "./errors";

const SESSION_TYPES = new Set<LiveSessionType>(["presentation", "meeting"]);
const OUTPUT_MODES = new Set<LiveOutputMode>(["captions", "captions_audio", "audio"]);
const VOICE_PROVIDERS = new Set<LiveVoiceProvider>(["gemini", "openai"]);
const GLOSSARY_PACKS = new Set<GlossaryPack>(["general_cre", "hotel", "fnb"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new LiveSessionError("라이브 제목이 필요합니다.", "INVALID_TITLE", 400);
  }
  const title = value.normalize("NFC").replace(/\p{Cc}|\p{Cf}/gu, "").replace(/\s+/gu, " ").trim();
  if (Array.from(title).length < 1 || Array.from(title).length > 120 || /[<>]/u.test(title)) {
    throw new LiveSessionError("라이브 제목은 1자 이상 120자 이하로 입력하세요.", "INVALID_TITLE", 400);
  }
  return title;
}

export function parseScheduledAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new LiveSessionError("라이브 일정이 올바르지 않습니다.", "INVALID_SCHEDULED_AT", 400);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new LiveSessionError("라이브 일정이 올바르지 않습니다.", "INVALID_SCHEDULED_AT", 400);
  }
  return new Date(timestamp).toISOString();
}

export function parseSessionId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new LiveSessionError("세션 ID가 올바르지 않습니다.", "INVALID_SESSION_ID", 400);
  }
  return value;
}

export function parseSessionType(value: unknown): LiveSessionType {
  if (typeof value !== "string" || !SESSION_TYPES.has(value as LiveSessionType)) {
    throw new LiveSessionError("지원하지 않는 라이브 모드입니다.", "INVALID_LIVE_MODE", 400);
  }
  return value as LiveSessionType;
}

export function parseOutputMode(value: unknown): LiveOutputMode {
  if (typeof value !== "string" || !OUTPUT_MODES.has(value as LiveOutputMode)) {
    throw new LiveSessionError("지원하지 않는 음성 출력 모드입니다.", "INVALID_VOICE_OUTPUT_MODE", 400);
  }
  return value as LiveOutputMode;
}

export function parseVoiceProvider(value: unknown): LiveVoiceProvider {
  if (typeof value !== "string" || !VOICE_PROVIDERS.has(value as LiveVoiceProvider)) {
    throw new LiveSessionError("지원하지 않는 음성 출력 제공자입니다.", "INVALID_VOICE_PROVIDER", 400);
  }
  return value as LiveVoiceProvider;
}

export function parseMaxViewers(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 50) {
    throw new LiveSessionError("최대 시청자는 1명 이상 50명 이하여야 합니다.", "INVALID_MAX_VIEWERS", 400);
  }
  return Number(value);
}

export function parseGlossaryPack(value: unknown): GlossaryPack {
  if (typeof value !== "string" || !GLOSSARY_PACKS.has(value as GlossaryPack)) {
    throw new LiveSessionError("지원하지 않는 용어집입니다.", "INVALID_GLOSSARY_PACK", 400);
  }
  return value as GlossaryPack;
}

export function parseLanguages(value: unknown): [string, ...string[]] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new LiveSessionError("언어는 1개 이상 3개 이하로 선택하세요.", "INVALID_LANGUAGES", 400);
  }
  const languages = value.map(normalizeLanguageCode);
  if (languages.some((language) => !language) || new Set(languages).size !== languages.length) {
    throw new LiveSessionError("언어 선택이 올바르지 않습니다.", "INVALID_LANGUAGES", 400);
  }
  const first = languages.shift();
  if (!first) throw new LiveSessionError("언어 선택이 올바르지 않습니다.", "INVALID_LANGUAGES", 400);
  return [first, ...languages];
}

export function parseVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new LiveSessionError("세션 버전이 올바르지 않습니다.", "INVALID_VERSION", 400);
  }
  return Number(value);
}
