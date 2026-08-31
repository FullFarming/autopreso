import { z } from "zod";

export const MEETING_COACH_SCHEMA_VERSION = 1;
export const MEETING_TYPE_APAC_IT_CALL = "APAC_IT_CALL";
export const DEFAULT_OPENAI_MEETING_COACH_MODEL = "gemini-3.7-flash";

export const SIZE_CAPS = Object.freeze({
  id: 120,
  title: 160,
  shortText: 500,
  longText: 4_000,
  userRequest: 2_000,
  prompt: 48_000,
  listItems: 40,
  recentTurns: 12,
  prepMessages: 80,
  prepMessage: 4_000,
});

export const APAC_IT_CALL_TEMPLATE = Object.freeze({
  meetingType: MEETING_TYPE_APAC_IT_CALL,
  label: "APAC IT Call",
  requiredTopics: Object.freeze([
    "laptop counts",
    "pending returns",
    "repairs",
    "replacements",
    "incidents",
    "global items",
    "unresolved questions",
  ]),
  composerActions: Object.freeze(["TRANSLATE", "DRAFT", "SHORTEN", "POLITE"]),
});

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

/**
 * @param {unknown} value
 * @param {number} [limit]
 */
export function normalizeText(value, limit = SIZE_CAPS.longText) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(CONTROL_CHARS, "")
    .replace(/[ \t]+/gu, " ")
    .trim()
    .slice(0, limit);
}

/** @param {unknown} value @param {string} [fallback] */
export function normalizeId(value, fallback = "") {
  return normalizeText(value, SIZE_CAPS.id) || fallback;
}

/** @param {unknown} value @param {string} [fallback] */
export function normalizeIsoTimestamp(value, fallback = new Date().toISOString()) {
  const text = normalizeText(value, 80);
  if (!text) return fallback;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

/** @param {number} [limit] */
const nonEmptyText = (limit = SIZE_CAPS.shortText) => z.preprocess(
  (value) => normalizeText(value, limit),
  z.string().min(1),
);

/** @param {number} [limit] */
const optionalText = (limit = SIZE_CAPS.shortText) => z.preprocess(
  (value) => {
    const text = normalizeText(value, limit);
    return text || undefined;
  },
  z.string().optional(),
);

const idText = z.preprocess((value) => normalizeId(value), z.string().min(1).max(SIZE_CAPS.id));
const timestampText = z.preprocess((value) => normalizeIsoTimestamp(value), z.string().datetime());

export const VerifiedFactSchema = z.object({
  id: idText,
  topic: nonEmptyText(120),
  label: nonEmptyText(160),
  value: nonEmptyText(1_000),
  sourceNote: nonEmptyText(1_500),
  updatedAt: timestampText,
});

export const KnownUnknownSchema = z.object({
  topic: nonEmptyText(160),
  followUpOwner: optionalText(160),
  expectedBy: optionalText(120),
});

export const LikelyQuestionSchema = z.object({
  question: nonEmptyText(600),
  preparedEnglish: nonEmptyText(1_200),
  koreanMeaning: nonEmptyText(1_200),
});

export const TerminologySchema = z.object({
  source: nonEmptyText(160),
  preferredEnglish: optionalText(160),
  preferredKorean: optionalText(160),
}).refine((item) => item.preferredEnglish || item.preferredKorean, {
  message: "Terminology needs an English or Korean preference.",
});

export const SafeFallbackSchema = z.object({
  kind: z.enum(["general", "numberUnknown", "ownerUnknown", "timingUnknown"]),
  english: nonEmptyText(600),
  korean: nonEmptyText(600),
});

export const ContradictionWarningSchema = z.object({
  id: idText,
  message: nonEmptyText(800),
  acknowledged: z.boolean().default(false),
});

export const MeetingBriefSchema = z.object({
  schemaVersion: z.literal(MEETING_COACH_SCHEMA_VERSION),
  id: idText,
  title: nonEmptyText(SIZE_CAPS.title),
  counterparty: optionalText(300),
  contextNotes: optionalText(SIZE_CAPS.longText),
  meetingType: z.literal(MEETING_TYPE_APAC_IT_CALL),
  status: z.enum(["DRAFT", "FROZEN"]),
  version: z.number().int().positive(),
  agenda: z.array(nonEmptyText(300)).max(SIZE_CAPS.listItems),
  verifiedFacts: z.array(VerifiedFactSchema).max(SIZE_CAPS.listItems),
  knownUnknowns: z.array(KnownUnknownSchema).max(SIZE_CAPS.listItems),
  likelyQuestions: z.array(LikelyQuestionSchema).max(SIZE_CAPS.listItems),
  terminology: z.array(TerminologySchema).max(SIZE_CAPS.listItems),
  safeFallbacks: z.array(SafeFallbackSchema).min(1).max(8),
  contradictionWarnings: z.array(ContradictionWarningSchema).max(SIZE_CAPS.listItems).default([]),
  createdAt: timestampText,
  updatedAt: timestampText,
  frozenAt: optionalText(80),
});

export const FinalizedTurnSchema = z.object({
  id: idText,
  sourceSessionId: optionalText(SIZE_CAPS.id),
  seq: z.number().int().nonnegative(),
  speaker: optionalText(160),
  lane: z.enum(["LOCAL_MIC", "SYSTEM_AUDIO", "MANUAL"]).default("SYSTEM_AUDIO"),
  isFinal: z.literal(true),
  text: nonEmptyText(1_500),
  english: optionalText(1_500),
  korean: optionalText(1_500),
  startedAt: timestampText,
  endedAt: timestampText,
});

export const CoachSessionSchema = z.object({
  schemaVersion: z.literal(MEETING_COACH_SCHEMA_VERSION),
  id: idText,
  briefId: idText,
  briefVersion: z.number().int().positive(),
  sourceSessionId: idText,
  state: z.enum(["PREPARED", "ARMED", "LIVE", "ENDED"]),
  currentQuestionTurnId: optionalText(SIZE_CAPS.id),
  createdAt: timestampText,
  startedAt: optionalText(80),
  endedAt: optionalText(80),
  acceptedTurnIds: z.array(idText).max(10_000).default([]),
  lastTurnSeq: z.number().int().nonnegative().default(0),
});

export const CoachSuggestionSchema = z.object({
  schemaVersion: z.literal(MEETING_COACH_SCHEMA_VERSION),
  id: idText,
  coachSessionId: idText,
  requestId: idText,
  briefVersion: z.number().int().positive(),
  sourceTurnId: optionalText(SIZE_CAPS.id),
  requestKind: z.enum(["AUTO_QUESTION", "TRANSLATE", "DRAFT", "SHORTEN", "POLITE"]),
  status: z.enum(["GENERATING", "READY_GROUNDED", "READY_VERIFY", "STALE", "ERROR"]),
  english: z.string(),
  korean: z.string(),
  evidenceRefs: z.array(idText).max(SIZE_CAPS.listItems),
  createdAt: timestampText,
  errorCode: optionalText(80),
});

export const UsedRecommendationSchema = z.object({
  schemaVersion: z.literal(MEETING_COACH_SCHEMA_VERSION),
  id: idText,
  coachSessionId: idText,
  sourceTurnId: idText,
  suggestionId: idText,
  requestId: idText,
  briefVersion: z.number().int().positive(),
  english: nonEmptyText(1_500),
  korean: optionalText(1_500),
  evidenceRefs: z.array(idText).max(SIZE_CAPS.listItems),
  usedAt: timestampText,
});

export const UseRecommendationRequestSchema = z.object({
  sourceTurnId: idText,
});

export const PrepMessageSchema = z.object({
  id: idText,
  role: z.enum(["USER", "ASSISTANT"]),
  text: nonEmptyText(SIZE_CAPS.prepMessage),
  createdAt: timestampText,
});

/**
 * @param {{
 *   id?: string,
 *   title?: string,
 *   counterparty?: string,
 *   contextNotes?: string,
 *   agenda?: unknown[],
 *   verifiedFacts?: unknown[],
 *   knownUnknowns?: unknown[],
 *   likelyQuestions?: unknown[],
 *   terminology?: unknown[],
 *   safeFallbacks?: unknown[],
 *   contradictionWarnings?: unknown[],
 *   now?: string,
 * }} [options]
 */
export function createApacMeetingBriefDraft({
  id = `brief-${Date.now()}`,
  title = "",
  counterparty,
  contextNotes,
  agenda = [],
  verifiedFacts = [],
  knownUnknowns = [],
  likelyQuestions = [],
  terminology = [],
  safeFallbacks,
  contradictionWarnings = [],
  now = new Date().toISOString(),
} = {}) {
  const fallbackList = safeFallbacks ?? [
    {
      kind: "general",
      english: "I don't have the confirmed detail with me. I'll verify it and follow up after the call.",
      korean: "확정된 내용을 지금 바로 가지고 있지 않습니다. 확인 후 회의 후에 공유하겠습니다.",
    },
    {
      kind: "numberUnknown",
      english: "I don't have the confirmed number with me. I'll verify it and follow up after the call.",
      korean: "확정된 숫자를 지금 바로 가지고 있지 않습니다. 확인 후 회의 후에 공유하겠습니다.",
    },
  ];
  return MeetingBriefSchema.parse({
    schemaVersion: MEETING_COACH_SCHEMA_VERSION,
    id,
    title: title || "APAC IT Call",
    counterparty,
    contextNotes,
    meetingType: MEETING_TYPE_APAC_IT_CALL,
    status: "DRAFT",
    version: 1,
    agenda,
    verifiedFacts,
    knownUnknowns,
    likelyQuestions,
    terminology,
    safeFallbacks: fallbackList,
    contradictionWarnings,
    createdAt: now,
    updatedAt: now,
  });
}

/** @param {unknown} draft @param {{now?: string}} [options] */
export function freezeMeetingBrief(draft, { now = new Date().toISOString() } = {}) {
  const brief = MeetingBriefSchema.parse(draft);
  if (brief.status === "FROZEN") return brief;
  if (brief.agenda.length === 0) {
    throw Object.assign(new Error("회의 브리프를 확정하려면 안건이 하나 이상 필요합니다."), { code: "AGENDA_REQUIRED" });
  }
  if (brief.safeFallbacks.length === 0) {
    throw Object.assign(new Error("회의 브리프를 확정하려면 안전 답변이 하나 이상 필요합니다."), { code: "SAFE_FALLBACK_REQUIRED" });
  }
  const unacknowledged = brief.contradictionWarnings.filter((warning) => !warning.acknowledged);
  if (unacknowledged.length > 0) {
    throw Object.assign(new Error("회의 브리프의 모든 상충 정보 경고를 확인해 주세요."), { code: "CONTRADICTION_ACK_REQUIRED" });
  }
  return MeetingBriefSchema.parse({
    ...brief,
    status: "FROZEN",
    version: brief.version + 1,
    updatedAt: now,
    frozenAt: now,
  });
}
