import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/require-admin";
import { consoleFailure, invalidConsoleRequest } from "@/lib/console/console-route";
import { getConsoleStore, type ConsoleSessionRow } from "@/lib/console/console-store";
import { apiSuccess } from "@/lib/security/api-response";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const rangeSchema = z.enum(["7d", "30d", "all"]).default("7d");
const RANGE_DAYS: Record<z.infer<typeof rangeSchema>, number | null> = { "7d": 7, "30d": 30, all: null };

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

/** `GET /api/console/sessions?range=7d|30d|all` → `{ sessions: ConsoleSessionRow[], summary }`. */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
    const parsed = rangeSchema.safeParse(request.nextUrl.searchParams.get("range") ?? undefined);
    if (!parsed.success) return invalidConsoleRequest("세션 조회 범위가 올바르지 않습니다.");
    const now = Date.now();
    const days = RANGE_DAYS[parsed.data];
    const sessions = await getConsoleStore().listSessions({ since: days === null ? undefined : new Date(now - days * DAY_MS).toISOString() });
    return apiSuccess({ sessions, summary: summarizeConsoleSessions(sessions, now) }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    return consoleFailure(error, "세션 목록을 읽을 수 없습니다.", "CONSOLE_SESSIONS_LIST_FAILED");
  }
}
