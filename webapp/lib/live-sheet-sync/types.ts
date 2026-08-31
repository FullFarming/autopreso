import { z } from "zod";

import type { GoogleSheetsSafeErrorCode } from "../google-sheets/index";

const consentSchema = z.object({
  state: z.enum(["not_recorded", "accepted", "declined", "withdrawn"]),
  at: z.string().datetime({ offset: true }).nullable(),
}).strict();

const participantSchema = z.object({
  email: z.string().email().max(254).nullable(),
  company: z.string().max(200).nullable(),
  department: z.string().max(200).nullable(),
  jobTitle: z.string().max(200).nullable(),
  joinedAt: z.string().datetime({ offset: true }),
  privacy: consentSchema,
  summaryDelivery: consentSchema,
  marketing: consentSchema,
  deliveryStatus: z.enum(["not_requested", "eligible"]),
}).strict();

export const liveSheetProjectionSchema = z.object({
  sessionId: z.uuid(),
  projectionVersion: z.number().int().safe().min(1),
  sessionIndexRow: z.number().int().safe().min(1).max(10_000_000),
  sheetId: z.number().int().safe().min(1).max(2_147_483_647),
  tabTitle: z.string().min(1).max(10_000),
  shouldCreate: z.boolean(),
  previousParticipantCount: z.number().int().safe().min(0).max(10_000),
  session: z.object({
    date: z.string().date(),
    title: z.string().min(1).max(500),
    status: z.enum(["scheduled", "preparing", "live", "paused", "stopped", "failed"]),
    languages: z.array(z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z]{4})?$/u)).min(1).max(20),
    participantCount: z.number().int().safe().min(0).max(10_000),
    summaryState: z.enum(["not_started", "pending", "running", "ready", "failed"]),
    sheetSyncState: z.enum(["pending", "running", "completed", "failed"]),
    sheetLink: z.string().url().max(1_000),
  }).strict(),
  participants: z.array(participantSchema).max(10_000),
}).strict().superRefine((value, context) => {
  if (value.session.participantCount !== value.participants.length) {
    context.addIssue({ code: "custom", message: "참여자 수가 시트 투영과 일치하지 않습니다." });
  }
  for (const participant of value.participants) {
    for (const consent of [participant.privacy, participant.summaryDelivery, participant.marketing]) {
      if ((consent.state === "not_recorded") !== (consent.at === null)) {
        context.addIssue({ code: "custom", message: "동의 상태 시간이 올바르지 않습니다." });
      }
    }
  }
});

export type LiveSheetProjection = z.infer<typeof liveSheetProjectionSchema>;

export type SheetSyncReason =
  | "session_created"
  | "session_changed"
  | "session_ended"
  | "participant_changed"
  | "consent_changed"
  | "archive_deleted"
  | "archive_restored"
  | "manual_retry"
  | "migration_backfill";

export interface SheetSyncClaim {
  jobId: string;
  claimToken: string;
  sessionId: string;
  sessionIndexRow: number;
  sheetId: number;
  tabTitle: string;
  shouldCreate: boolean;
  projectionVersion: number;
  previousParticipantCount: number;
  workbookRefVersion: 1;
  reason: SheetSyncReason;
}

export interface SheetSyncStore {
  claimNext(): Promise<SheetSyncClaim | null>;
  readCanonicalProjection(claim: SheetSyncClaim): Promise<LiveSheetProjection>;
  complete(claim: SheetSyncClaim, result: { participantCount: number }): Promise<void>;
  fail(claim: SheetSyncClaim, code: GoogleSheetsSafeErrorCode): Promise<void>;
}
