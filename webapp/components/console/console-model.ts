// Pure helpers for the admin console panels. No React, no fetch: everything here is unit-tested
// with a fixed `now` in console-model.test.ts, and the panels only render what these return.

// Relative on purpose: the node test loader resolves no `@/` alias, and this is the module's only value import.
import { CONSOLE_ERROR_MESSAGE_KEYS } from "../../lib/system-language/console-messages";

export type ConsoleRange = "7d" | "30d" | "all";
export type ProfileFilter = "pending" | "approved" | "rejected" | "disabled";
export type RejectReason = "unverified" | "duplicate" | "other";

/** The subset of `ConsoleSessionRow` the summary and deploy-count helpers read. */
export interface ConsoleSessionSummaryRow {
  status: string;
  createdAt: string;
  utteranceCount: number;
  summaryStatus: "failed" | "succeeded" | "running" | null;
}
export interface ConsoleSessionsSummary { today: number; live: number; utterances7d: number; summaryFailures: number }

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_DAYS: Record<ConsoleRange, number | null> = { "7d": 7, "30d": 30, all: null };

export const rejectReasons: readonly RejectReason[] = Object.freeze(["unverified", "duplicate", "other"]);
export const REJECT_REASON_LABEL_KEYS: Readonly<Record<RejectReason, string>> = Object.freeze({
  unverified: "미확인 사용자", duplicate: "중복", other: "기타",
});

/** ISO lower bound for a range chip, or `null` when the chip means the whole history. */
export function formatRange(range: ConsoleRange, now: number): string | null {
  const days = RANGE_DAYS[range];
  return days === null ? null : new Date(now - days * DAY_MS).toISOString();
}

/** Mirrors the server's `summarizeConsoleSessions`; kept here so the cards can be recomputed from the rows on screen. */
export function summarizeSessions(rows: readonly ConsoleSessionSummaryRow[], now: number): ConsoleSessionsSummary {
  const todayUtc = new Date(now).toISOString().slice(0, 10);
  const weekAgo = now - 7 * DAY_MS;
  const summary: ConsoleSessionsSummary = { today: 0, live: 0, utterances7d: 0, summaryFailures: 0 };
  for (const row of rows) {
    const createdAt = Date.parse(row.createdAt);
    if (Number.isFinite(createdAt) && new Date(createdAt).toISOString().slice(0, 10) === todayUtc) summary.today += 1;
    if (row.status === "live") summary.live += 1;
    if (Number.isFinite(createdAt) && createdAt >= weekAgo) summary.utterances7d += row.utteranceCount;
    if (row.summaryStatus === "failed") summary.summaryFailures += 1;
  }
  return summary;
}

/** Sessions a switch touches immediately (spec §9): `preparing` and `live`. */
export function countActiveSessions(rows: readonly Pick<ConsoleSessionSummaryRow, "status">[]): number {
  return rows.reduce((count, row) => count + (row.status === "preparing" || row.status === "live" ? 1 : 0), 0);
}

/** D1: a per-user engine change switches only that host's running sessions - the number the confirm dialog quotes. */
export function countActiveSessionsForHost(rows: readonly { hostId: string; status: string }[], hostId: string): number {
  return countActiveSessions(rows.filter((row) => row.hostId === hostId));
}

/** Provider brand names are not translated; an unset assignment reads as the D2 default. */
export function voiceProviderLabel(provider: string | undefined): string {
  return provider === "gemini" ? "Gemini" : "Soniox";
}

export function statusLabelKey(status: string): string {
  if (status === "pending") return "대기";
  if (status === "approved") return "승인";
  if (status === "rejected") return "반려";
  return "비활성";
}

export function sessionStatusLabelKey(status: string): string {
  if (status === "preparing") return "준비 중";
  if (status === "live") return "진행 중";
  if (status === "paused") return "일시 정지";
  if (status === "failed") return "실패";
  return "종료됨";
}

export function summaryStatusLabelKey(status: ConsoleSessionSummaryRow["summaryStatus"]): string {
  if (status === "succeeded") return "요약 완료";
  if (status === "running") return "요약 중";
  if (status === "failed") return "요약 실패";
  return "요약 없음";
}

export function sessionModeLabelKey(mode: string): string {
  return mode === "meeting" ? "회의" : "발표";
}

const DEPLOY_RESULT_LABEL_KEYS: Readonly<Record<string, string>> = Object.freeze({ switched: "전환됨", queued: "대기열", failed: "실패" });

/** Per-session deploy outcome (spec §9). Anything the client does not recognise is shown as 실패 rather than a blank pill. */
export function deployResultLabelKey(result: string): string {
  return DEPLOY_RESULT_LABEL_KEYS[result] ?? "실패";
}

/** A known server code reads as console copy; an unknown gateway code stays verbatim so the operator can search for it. */
export function deployCodeLabelKey(code: string): string {
  return Object.hasOwn(CONSOLE_ERROR_MESSAGE_KEYS, code) ? CONSOLE_ERROR_MESSAGE_KEYS[code] : code;
}

export function emptyStateKey(filter: ProfileFilter): string {
  if (filter === "pending") return "대기 중인 가입이 없습니다.";
  if (filter === "approved") return "승인된 사용자가 없습니다.";
  if (filter === "rejected") return "반려된 사용자가 없습니다.";
  return "비활성화된 사용자가 없습니다.";
}

/** Reason text sent to `PATCH /api/console/users` (≤200 chars, the route's limit). */
export function buildRejectReason(reason: RejectReason, note: string): string {
  const trimmed = note.trim();
  return (trimmed ? `${reason}: ${trimmed}` : reason).slice(0, 200);
}

export function formatConsoleDate(value: string | null, locale: string): string {
  if (!value) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  // Every console time is Seoul wall time regardless of the viewer's zone, so the zone is spelled out.
  return new Intl.DateTimeFormat(locale, { timeZone: "Asia/Seoul", timeZoneName: "short", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(time));
}
