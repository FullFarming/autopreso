import { z } from "zod";
import type { ViewerState } from "./viewer-controller-contract";

const recordsSessionSchema = z.object({
  session: z.object({
    id: z.string().uuid(), title: z.string(), scheduledAt: z.string().nullable(),
    status: z.enum(["stopped", "failed"]), endedAt: z.string().datetime({ offset: true }),
    sessionType: z.enum(["presentation", "meeting"]), outputMode: z.literal("captions"),
    languages: z.array(z.string()).min(1).max(3), maxViewers: z.number().int().positive(),
    participantSpeakingEnabled: z.literal(false), companyName: z.string().nullable().optional(),
  }),
  self: z.object({ email: z.string(), displayName: z.string(), company: z.string(),
    department: z.string(), jobTitle: z.string(), summaryConsent: z.boolean() }),
  recordsExpiresAt: z.string().datetime({ offset: true }),
});

export function parseViewerRecordsSession(value: unknown, sessionId: string): {
  viewer: ViewerState; recordsExpiresAt: string;
} {
  const result = recordsSessionSchema.parse(value);
  if (result.session.id !== sessionId) throw new Error("다른 회의의 기록입니다.");
  if (Date.parse(result.recordsExpiresAt) !== Date.parse(result.session.endedAt) + 6 * 60 * 60 * 1000) {
    throw new Error("기록 열람 기한을 확인할 수 없습니다.");
  }
  return { viewer: { session: { ...result.session, expiresAt: result.recordsExpiresAt }, self: result.self },
    recordsExpiresAt: result.recordsExpiresAt };
}

export function isRecordsAccessExpired(recordsExpiresAt: string | null, now: number): boolean {
  return recordsExpiresAt !== null && (!Number.isFinite(Date.parse(recordsExpiresAt)) || now >= Date.parse(recordsExpiresAt));
}
