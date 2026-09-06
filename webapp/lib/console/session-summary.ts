import type { ConsoleSessionRow } from "./console-store";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ConsoleSessionsSummary { today: number; live: number; utterances7d: number; summaryFailures: number }

/** Aggregates the console needs above the table, computed from the rows already fetched. */
export function summarizeConsoleSessions(sessions: readonly ConsoleSessionRow[], now: number): ConsoleSessionsSummary {
  const todayUtc = new Date(now).toISOString().slice(0, 10);
  const weekAgo = now - 7 * DAY_MS;
  let today = 0; let live = 0; let utterances7d = 0; let summaryFailures = 0;
  for (const session of sessions) {
    const createdAt = Date.parse(session.createdAt);
    if (Number.isFinite(createdAt) && new Date(createdAt).toISOString().slice(0, 10) === todayUtc) today += 1;
    if (session.status === "live") live += 1;
    if (Number.isFinite(createdAt) && createdAt >= weekAgo) utterances7d += session.utteranceCount;
    if (session.summaryStatus === "failed") summaryFailures += 1;
  }
  return { today, live, utterances7d, summaryFailures };
}

