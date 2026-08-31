import type { GlossaryPack, LiveAgendaItem, LiveEventType, LiveOutputMode, LiveSessionGlossaryPinSelection, LiveSessionSection, LiveSessionType, LiveVoiceProvider } from "../live-contract";
import { GlossarySelectionValidationError, parseGlossarySelections } from "../security/glossary-selection-validation";
import { normalizeLanguageCode } from "../languageDetect";
import { LiveSessionError } from "./errors";

const SESSION_TYPES = new Set<LiveSessionType>(["presentation", "meeting"]);
const OUTPUT_MODES = new Set<LiveOutputMode>(["captions"]);
const VOICE_PROVIDERS = new Set<LiveVoiceProvider>(["gemini"]);
const GLOSSARY_PACKS = new Set<GlossaryPack>(["general_cre", "hotel", "fnb"]);
const EVENT_TYPES = new Set<LiveEventType>(["earnings_call", "investor_day", "conference", "other"]);
const SESSION_SECTIONS = new Set<LiveSessionSection>(["prepared_remarks", "qa", "other"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PII_LIKE_PATTERN = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/u;

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
  if (value === "captions_audio" || value === "audio") return "captions";
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
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 200) {
    throw new LiveSessionError("최대 시청자는 1명 이상 200명 이하여야 합니다.", "INVALID_MAX_VIEWERS", 400);
  }
  return Number(value);
}

export function parseGlossaryPack(value: unknown): GlossaryPack {
  if (typeof value !== "string" || !GLOSSARY_PACKS.has(value as GlossaryPack)) {
    throw new LiveSessionError("지원하지 않는 용어집입니다.", "INVALID_GLOSSARY_PACK", 400);
  }
  return value as GlossaryPack;
}

export function parsePublicMetadata(value: unknown, maximumLength: number, code: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new LiveSessionError("라이브 메타데이터가 올바르지 않습니다.", code, 400);
  const normalized = value.normalize("NFC").replace(/\p{Cc}/gu, " ").replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ").trim();
  if (Array.from(normalized).length < 1
    || Array.from(normalized).length > maximumLength
    || /[<>]/u.test(normalized)
    || PII_LIKE_PATTERN.test(normalized)) {
    throw new LiveSessionError("라이브 메타데이터가 올바르지 않습니다.", code, 400);
  }
  return normalized;
}

export function parseTicker(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new LiveSessionError("티커가 올바르지 않습니다.", "INVALID_TICKER", 400);
  const ticker = value.normalize("NFC").replace(/\s+/gu, "").toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/u.test(ticker)) {
    throw new LiveSessionError("티커가 올바르지 않습니다.", "INVALID_TICKER", 400);
  }
  return ticker;
}

export function parseEventType(value: unknown): LiveEventType | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !EVENT_TYPES.has(value as LiveEventType)) {
    throw new LiveSessionError("이벤트 유형이 올바르지 않습니다.", "INVALID_EVENT_TYPE", 400);
  }
  return value as LiveEventType;
}

export function parseAgenda(value: unknown): LiveAgendaItem[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new LiveSessionError("안건이 올바르지 않습니다.", "INVALID_AGENDA", 400);
  }
  return value.map((item, index) => ({
    ordinal: index + 1,
    label: requireAgendaLabel(parsePublicMetadata(item, 120, "INVALID_AGENDA")),
  }));
}

function requireAgendaLabel(value: string | null): string {
  if (value === null) throw new LiveSessionError("안건이 올바르지 않습니다.", "INVALID_AGENDA", 400);
  return value;
}

export function parseSection(value: unknown): LiveSessionSection {
  if (typeof value !== "string" || !SESSION_SECTIONS.has(value as LiveSessionSection)) {
    throw new LiveSessionError("세션 구간이 올바르지 않습니다.", "INVALID_SECTION", 400);
  }
  return value as LiveSessionSection;
}

export function parseSectionTransitionKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new LiveSessionError("세션 구간 전환 키가 올바르지 않습니다.", "INVALID_SECTION_TRANSITION_KEY", 400);
  }
  const normalized = value.normalize("NFC").replace(/\p{Cc}/gu, "").replace(/\p{Cf}/gu, "").trim();
  if (Array.from(normalized).length < 1 || Array.from(normalized).length > 256 || /[<>]/u.test(normalized)) {
    throw new LiveSessionError("세션 구간 전환 키가 올바르지 않습니다.", "INVALID_SECTION_TRANSITION_KEY", 400);
  }
  return normalized;
}

export function parseSourceSeq(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new LiveSessionError("세션 구간 전환 위치가 올바르지 않습니다.", "INVALID_SECTION_SOURCE_SEQ", 400);
  }
  return Number(value);
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

export interface LiveGlossaryPinInput {
  expectedVersion: number;
  presetId: string;
  documentVersion: number;
}

export interface LiveGlossaryPinsInput {
  expectedVersion: number;
  glossaries: LiveSessionGlossaryPinSelection[];
}

export function parseLiveGlossaryPinInput(value: unknown): LiveGlossaryPinInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidGlossaryPin();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3 || !["expectedVersion", "presetId", "documentVersion"].every((key) => Object.hasOwn(record, key))) {
    return invalidGlossaryPin();
  }
  if (!Number.isSafeInteger(record.expectedVersion) || Number(record.expectedVersion) < 1
    || !Number.isSafeInteger(record.documentVersion) || Number(record.documentVersion) < 1
    || Number(record.documentVersion) > 2_147_483_647
    || typeof record.presetId !== "string" || !UUID_PATTERN.test(record.presetId)) {
    return invalidGlossaryPin();
  }
  return {
    expectedVersion: Number(record.expectedVersion),
    presetId: record.presetId.toLowerCase(),
    documentVersion: Number(record.documentVersion),
  };
}

export function parseLiveGlossaryPinsInput(value: unknown): LiveGlossaryPinsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidGlossaryPin();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !Object.hasOwn(record, "expectedVersion") || !Object.hasOwn(record, "glossaries")) return invalidGlossaryPin();
  if (!Number.isSafeInteger(record.expectedVersion)
    || Number(record.expectedVersion) < 1
    || Number(record.expectedVersion) > 2_147_483_647) return invalidGlossaryPin();
  let glossaries: readonly LiveSessionGlossaryPinSelection[];
  try {
    glossaries = parseGlossarySelections(record.glossaries);
  } catch (error: unknown) {
    if (error instanceof GlossarySelectionValidationError) {
      throw new LiveSessionError(error.message, error.code, error.status);
    }
    throw error;
  }
  return {
    expectedVersion: Number(record.expectedVersion),
    glossaries: [...glossaries],
  };
}

function invalidGlossaryPin(): never {
  throw new LiveSessionError("세션 용어집 요청이 올바르지 않습니다.", "INVALID_GLOSSARY_PIN", 400);
}
