import type { LiveSession, LiveSessionStatus } from "@/lib/live-contract";
import { validateLiveSchedule, type LiveScheduleFields } from "./live-session-schedule";

export function canApplyHostRecovery(capturedEpoch: number, currentEpoch: number, isPageActive: boolean): boolean {
  return isPageActive && capturedEpoch === currentEpoch;
}

export function getHostSessionScheduleFields(scheduledAt: string | null): LiveScheduleFields {
  if (!scheduledAt) return { sessionDate: "", startTime: "" };
  const scheduled = new Date(scheduledAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    sessionDate: `${scheduled.getFullYear()}-${pad(scheduled.getMonth() + 1)}-${pad(scheduled.getDate())}`,
    startTime: `${pad(scheduled.getHours())}:${pad(scheduled.getMinutes())}`,
  };
}

/** @throws 날짜·시간을 변경하면서 유효한 미래 일정을 입력하지 않은 경우. */
export function buildHostSessionIdentityPatch(
  saved: Pick<LiveSession, "title" | "scheduledAt">,
  fields: LiveScheduleFields & { title: string },
  now: number,
): Partial<Pick<LiveSession, "title" | "scheduledAt">> {
  const original = getHostSessionScheduleFields(saved.scheduledAt);
  const titlePatch = fields.title.trim() === saved.title ? {} : { title: fields.title.trim() };
  if (fields.sessionDate === original.sessionDate && fields.startTime === original.startTime) return titlePatch;
  const validation = validateLiveSchedule(fields.sessionDate, fields.startTime, now);
  if (validation.error) throw new Error("변경할 날짜와 시작 시간을 현재보다 이후로 입력해 주세요.");
  return { ...titlePatch, scheduledAt: validation.scheduledAt };
}

export interface RecoverableHostSession {
  id: string;
  title: string;
  status: LiveSessionStatus;
  scheduledAt: string | null;
  viewerCount: number;
  version: number;
}

export type HostSessionRecoveryDecision =
  | { kind: "idle" }
  | { kind: "restore"; session: RecoverableHostSession }
  | { kind: "choose"; sessions: readonly RecoverableHostSession[] };

export function appendRecoverableHostSessions<T extends RecoverableHostSession>(
  current: readonly T[], incoming: readonly T[],
): T[] {
  const sessions = new Map(current.map((session) => [session.id, session]));
  for (const session of incoming) {
    const existing = sessions.get(session.id);
    if (!existing || session.version >= existing.version) sessions.set(session.id, session);
  }
  return [...sessions.values()];
}

const RECOVERABLE_STATUSES = new Set<LiveSessionStatus>([
  "preparing",
  "live",
  "paused",
]);

export function resolveHostSessionRecovery(
  sessions: readonly RecoverableHostSession[],
  nextOffset: number | null = null,
): HostSessionRecoveryDecision {
  // Ownership and newest-first ordering belong to the recovery API.
  // This client boundary still rejects terminal rows if a stale response leaks one.
  const recoverableSessions = sessions.filter((session) => RECOVERABLE_STATUSES.has(session.status));

  if (recoverableSessions.length === 0) return { kind: "idle" };
  if (recoverableSessions.length === 1 && nextOffset === null) {
    return { kind: "restore", session: recoverableSessions[0] };
  }
  return { kind: "choose", sessions: recoverableSessions };
}
