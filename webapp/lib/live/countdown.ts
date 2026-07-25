/** Contract C8/C11: shared countdown math for the host stage view and the
 *  mobile viewer waiting room. Reaching zero never auto-starts a session —
 *  the UI only changes copy; the host must press Start. */

export function formatCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

/** Remaining milliseconds until the schedule, negative once past it, or
 *  null when the session has no (valid) scheduled time. */
export function countdownMsUntil(scheduledAt: string | null, nowMs: number): number | null {
  if (!scheduledAt) return null;
  const scheduled = Date.parse(scheduledAt);
  if (!Number.isFinite(scheduled)) return null;
  return scheduled - nowMs;
}
