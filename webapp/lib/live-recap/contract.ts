import { z } from "zod";

export const RECAP_NOTICE_VERSION = "summary-original-email-v2";
export const RECAP_NOTICE_TEXT = "버튼을 누르면 이 회의의 요약·원문 이메일 수신에 동의해요. 마케팅 수신 동의는 포함되지 않아요.";
export const EXPORT_LIMITS = { participants: 10_000, utterances: 12_000, recordingGaps: 12_000, requests: 10_000, summaries: 14 } as const;

const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp");
const nullableText = z.string().nullable();

export const recordingGapSchema = z.object({
  id: z.uuid(), startedAt: timestamp, endedAt: timestamp.nullable(),
  reason: z.enum(["no_viewers", "host_unavailable", "media_failed", "source_recording_failed"]),
}).strict().refine((gap) => gap.endedAt === null || Date.parse(gap.endedAt) >= Date.parse(gap.startedAt), "Invalid gap interval");
export const recordingGapsSchema = z.object({
  recordingGaps: z.array(recordingGapSchema).max(EXPORT_LIMITS.recordingGaps),
}).strict();

export const recapRequestInputSchema = z.object({
  accepted: z.literal(true),
  noticeVersion: z.literal(RECAP_NOTICE_VERSION),
  idempotencyKey: z.uuid(),
}).strict();

export const recapRequestSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  requestedAt: timestamp,
  noticeVersion: z.literal(RECAP_NOTICE_VERSION),
  status: z.enum(["requested", "cancelled"]),
  email: z.string().min(1).max(320),
  revision: z.number().int().positive(),
}).strict();

export const hostRecapRequestSchema = recapRequestSchema.extend({
  participantId: z.uuid(),
  displayName: z.string(),
  company: nullableText,
  department: z.string(),
  jobTitle: z.string(),
  consentAcceptedAt: timestamp,
  cancelledAt: timestamp.nullable(),
}).strict();

export const recapRecipientsSchema = z.object({
  requests: z.array(hostRecapRequestSchema).max(EXPORT_LIMITS.requests),
}).strict();

export const recordExportSnapshotSchema = z.object({
  snapshotId: z.uuid(),
  generatedAt: timestamp,
  session: z.object({
    id: z.uuid(), title: z.string(), status: z.enum(["preparing", "live", "paused", "stopped", "failed"]),
    scheduledAt: timestamp.nullable(), endedAt: timestamp.nullable(), languages: z.array(z.string()).max(14),
  }).strict(),
  participants: z.array(z.object({
    id: z.uuid(), displayName: z.string(), email: nullableText, company: nullableText,
    department: z.string(), jobTitle: z.string(), joinedAt: timestamp,
  }).strict()).max(EXPORT_LIMITS.participants),
  utterances: z.array(z.object({
    id: z.uuid(), seq: z.number().int().positive(), speaker: z.string(), language: z.string(),
    startedAt: timestamp.nullable(), endedAt: timestamp, text: z.string(), topicTitle: nullableText,
  }).strict()).max(EXPORT_LIMITS.utterances),
  recordingGaps: z.array(recordingGapSchema).max(EXPORT_LIMITS.recordingGaps),
  summaries: z.array(z.object({
    language: z.string(), status: z.string(), createdAt: timestamp.nullable(),
    summary: z.record(z.string(), z.unknown()).nullable(),
  }).strict()).max(EXPORT_LIMITS.summaries),
  requests: z.array(hostRecapRequestSchema).max(EXPORT_LIMITS.requests),
}).strict();

export type RecapRequestInput = z.infer<typeof recapRequestInputSchema>;
export type RecapRequest = z.infer<typeof recapRequestSchema>;
export type HostRecapRequest = z.infer<typeof hostRecapRequestSchema>;
export type RecordExportSnapshot = z.infer<typeof recordExportSnapshotSchema>;
export type RecordingGap = z.infer<typeof recordingGapSchema>;
