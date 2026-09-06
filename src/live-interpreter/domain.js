import {
  LIVE_INTERPRETER_LANGUAGE_OPTIONS,
  LIVE_INTERPRETER_LANGUAGE_RULES,
  LIVE_INTERPRETER_LANGUAGES,
  normalizeLiveInterpreterLanguageCode,
} from "../../public/subtitle-language-catalog.js";

export {
  LIVE_INTERPRETER_LANGUAGE_OPTIONS,
  LIVE_INTERPRETER_LANGUAGE_RULES,
  LIVE_INTERPRETER_LANGUAGES,
  normalizeLiveInterpreterLanguageCode,
};

export const LIVE_INTERPRETER_MODES = Object.freeze(["ONLINE", "IN_PERSON"]);
export const LIVE_INTERPRETER_LANES = Object.freeze(["INBOUND", "OUTBOUND", "USER", "OTHER"]);
export const LIVE_INTERPRETER_SAMPLE_RATE = 24_000;
export const MAX_INTERPRETER_TRANSCRIPT_CHARS = 4_000;
export const MAX_INTERPRETER_AUDIO_BYTES = 96_000;
export const MAX_INTERPRETER_AUDIO_DELTA_BASE64_CHARS = 128_000;

const LANE_SET = new Set(LIVE_INTERPRETER_LANES);
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** @param {unknown} value @param {number} [limit] */
export function sanitizeInterpreterText(value, limit = MAX_INTERPRETER_TRANSCRIPT_CHARS) {
  const boundedLimit = Number.isInteger(limit) && limit >= 0 ? limit : MAX_INTERPRETER_TRANSCRIPT_CHARS;
  return String(value ?? "")
    .normalize("NFC")
    .replace(CONTROL_CHARS, "")
    .replace(/[ \t]+/gu, " ")
    .trim()
    .slice(0, boundedLimit);
}

/** @param {unknown} value @param {number} [limit] */
export function sanitizeInterpreterDelta(value, limit = MAX_INTERPRETER_TRANSCRIPT_CHARS) {
  const boundedLimit = Number.isInteger(limit) && limit >= 0 ? limit : MAX_INTERPRETER_TRANSCRIPT_CHARS;
  return String(value ?? "").normalize("NFC").replace(CONTROL_CHARS, "").slice(0, boundedLimit);
}

/**
 * @param {{mode?: unknown, userLanguage?: unknown, otherLanguage?: unknown}} input
 * @returns {Record<string, {sourceLanguage: string, targetLanguage: string}>}
 */
export function buildLiveInterpreterLanes(input = {}) {
  const mode = String(input.mode ?? "");
  if (!LIVE_INTERPRETER_MODES.includes(mode)) {
    throw createLiveInterpreterError("INVALID_MODE", "지원하지 않는 통역 모드입니다.");
  }
  const userLanguage = assertSupportedLanguage(input.userLanguage);
  const otherLanguage = assertSupportedLanguage(input.otherLanguage);
  if (userLanguage === otherLanguage) {
    throw createLiveInterpreterError("LANGUAGES_MUST_DIFFER", "두 언어는 서로 달라야 합니다.");
  }
  if (mode === "ONLINE") {
    return {
      INBOUND: { sourceLanguage: otherLanguage, targetLanguage: userLanguage },
      OUTBOUND: { sourceLanguage: userLanguage, targetLanguage: otherLanguage },
    };
  }
  return {
    USER: { sourceLanguage: userLanguage, targetLanguage: otherLanguage },
    OTHER: { sourceLanguage: otherLanguage, targetLanguage: userLanguage },
  };
}

/** @param {unknown} value */
export function assertSupportedLanguage(value) {
  const language = normalizeLiveInterpreterLanguageCode(value);
  if (!language) {
    throw createLiveInterpreterError("UNSUPPORTED_LANGUAGE", "지원하지 않는 언어입니다.");
  }
  return language;
}

/** @param {unknown} value */
export function assertLiveInterpreterLane(value) {
  const lane = String(value ?? "");
  if (!LANE_SET.has(lane)) {
    throw createLiveInterpreterError("INVALID_LANE", "지원하지 않는 통역 레인입니다.");
  }
  return lane;
}

/** @param {unknown} value @param {number} [maxBytes] */
export function assertBoundedBase64Audio(value, maxBytes = MAX_INTERPRETER_AUDIO_BYTES) {
  const audioBase64 = typeof value === "string" ? value : "";
  if (!audioBase64 || audioBase64.length % 4 !== 0 || !BASE64.test(audioBase64)) {
    throw createLiveInterpreterError("INVALID_AUDIO_BASE64", "오디오 데이터가 올바른 base64 형식이 아닙니다.");
  }
  const byteLength = Buffer.byteLength(audioBase64, "base64");
  if (byteLength <= 0 || byteLength > maxBytes) {
    throw createLiveInterpreterError("AUDIO_SIZE_EXCEEDED", "오디오 데이터 크기가 허용 범위를 초과했습니다.");
  }
  return audioBase64;
}

/** @param {unknown} value */
export function sanitizeCommittedTranscriptRecord(value) {
  if (!isRecord(value)) throw createLiveInterpreterError("INVALID_RECORD", "통역 기록 형식이 올바르지 않습니다.");
  const id = sanitizeInterpreterText(value.id, 120);
  const sessionId = sanitizeInterpreterText(value.sessionId, 120);
  const lane = assertLiveInterpreterLane(value.lane);
  const sourceLanguage = assertSupportedLanguage(value.sourceLanguage);
  const targetLanguage = assertSupportedLanguage(value.targetLanguage);
  const sourceText = sanitizeInterpreterText(value.sourceText);
  const translatedText = sanitizeInterpreterText(value.translatedText);
  const createdAt = normalizeTimestamp(value.createdAt);
  if (!id || !sessionId || (!sourceText && !translatedText)) {
    throw createLiveInterpreterError("INVALID_RECORD", "통역 기록에 필수 값이 없습니다.");
  }
  return Object.freeze({
    id,
    sessionId,
    lane,
    sourceLanguage,
    targetLanguage,
    sourceText,
    translatedText,
    createdAt,
  });
}

/** @param {unknown} value */
function normalizeTimestamp(value) {
  const parsed = Date.parse(sanitizeInterpreterText(value, 80));
  if (!Number.isFinite(parsed)) throw createLiveInterpreterError("INVALID_RECORD", "통역 기록 시간이 올바르지 않습니다.");
  return new Date(parsed).toISOString();
}

/** @param {string} code @param {string} message */
export function createLiveInterpreterError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
