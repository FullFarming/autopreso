import { z } from "zod";
import { recordingGapSchema } from "../live-recap/contract";
import { normalizeSpeakerProfile } from "../../../packages/caption-core/speaker-profile.js";

export const speakerProfileSnapshotSchema = z.unknown().transform((value, context) => {
  try { return normalizeSpeakerProfile(value); }
  catch { context.addIssue({ code: "custom", message: "발언자 정보가 올바르지 않습니다." }); return z.NEVER; }
});

const language = z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z]{4})?$/u).max(16);
const instant = z.iso.datetime({ offset: true });
const sequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const languageObservationSchema = z.object({
  state: z.enum(["single", "mixed", "unknown"]),
  languageCode: language,
  providerLanguageCode: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u).max(35).nullable(),
  evidence: z.enum(["provider-and-script", "script", "provider", "conflict", "neutral", "insufficient"]),
  languages: z.array(language).max(16),
}).strict().refine((value) => new Set(value.languages).size === value.languages.length
  && (value.state === "single"
    ? value.languageCode !== "und" && value.languages.length === 1 && value.languages[0] === value.languageCode
    : value.languageCode === "und"), "관측 언어 분류가 올바르지 않습니다.");

export const sourceEventSchema = z.object({
  speakerProfile: speakerProfileSnapshotSchema.optional(),
  speakerAttribution: z.literal("unresolved").optional(),
  type: z.literal("source"), sessionId: z.uuid(), sourceUtteranceId: z.uuid(), sourceSeq: sequence,
  utteranceKey: z.string().min(1).max(200).regex(/^[^<>\p{Cc}\p{Cf}]+$/u), text: z.string().min(1).max(16_000),
  sourceLanguage: language,
  // 2026-08-31 feat: 기존 원문에는 관측 근거가 없으므로 과거 판단을 추정하지 않는다.
  languageObservation: languageObservationSchema.nullable(),
  speaker: z.object({ role: z.enum(["host", "participant", "unknown"]), label: z.string().min(1).max(80) }).strict(),
  isFinal: z.literal(true), sourceStartedAt: instant.nullable(), sourceEndedAt: instant, emittedAt: instant,
}).strict().refine((value) => value.languageObservation === null
  || value.sourceLanguage === value.languageObservation.languageCode, "원문과 관측 언어가 일치하지 않습니다.");

export const sourceSnapshotSchema = z.object({
  sessionId: z.uuid(), sources: z.array(sourceEventSchema).max(500),
  lastSourceSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), hasNextPage: z.boolean(),
  nextAfterSourceSeq: sequence.nullable(), recordsExpiresAt: instant.nullable(),
  recordingGaps: z.array(recordingGapSchema).max(12_000).optional(),
}).strict().refine((value) => value.sources.every((source, index) => source.sessionId === value.sessionId
  && source.sourceSeq > (value.sources[index - 1]?.sourceSeq ?? 0) && source.sourceSeq <= value.lastSourceSeq)
  && (value.hasNextPage ? value.nextAfterSourceSeq === value.sources.at(-1)?.sourceSeq
    : value.nextAfterSourceSeq === null), "원문 기록 순서가 올바르지 않습니다.");

export type LanguageObservation = z.infer<typeof languageObservationSchema>;
export type SourceEvent = z.infer<typeof sourceEventSchema>;
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;

export const sourceDraftEventSchema = z.object({
  speakerProfile: speakerProfileSnapshotSchema.optional(),
  speakerAttribution: z.literal("unresolved").optional(),
  type: z.literal("source-draft"), sessionId: z.uuid(), generation: z.uuid(), revision: sequence,
  text: z.string().min(1).max(16_000), sourceLanguage: language, languageObservation: languageObservationSchema,
  speaker: z.object({ role: z.enum(["host", "participant", "unknown"]), label: z.string().min(1).max(80) }).strict(),
  emittedAt: instant,
}).strict().refine((value) => value.sourceLanguage === value.languageObservation.languageCode);
export const sourceDraftClearEventSchema = z.object({
  type: z.literal("source-draft-clear"), sessionId: z.uuid(), generation: z.uuid(), revision: sequence,
}).strict();
export type SourceDraftEvent = z.infer<typeof sourceDraftEventSchema>;
export type SourceDraftClearEvent = z.infer<typeof sourceDraftClearEventSchema>;
