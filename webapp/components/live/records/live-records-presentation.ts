export interface LiveRecordTopicSummary {
  id: string;
  title: string;
  startedAt?: string;
  captionCount?: number;
}

export type RecordStatusState = "live" | "ok" | "pending" | "error" | "muted";

export interface RecordStatusPresentation {
  label: string;
  state: RecordStatusState;
}

const RECORD_STATUS: Readonly<Record<string, RecordStatusPresentation>> = {
  preparing: { label: "준비 중", state: "pending" },
  live: { label: "진행 중", state: "live" },
  paused: { label: "일시 정지", state: "pending" },
  stopped: { label: "종료", state: "ok" },
  failed: { label: "확인 필요", state: "error" },
};

const SUMMARY_STATUS: Readonly<Record<string, RecordStatusPresentation>> = {
  ready: { label: "요약 완료", state: "ok" },
  running: { label: "요약 중", state: "pending" },
  missing: { label: "요약 없음", state: "muted" },
  retryable_failed: { label: "요약 확인 필요", state: "error" },
  exhausted: { label: "요약 확인 필요", state: "error" },
  permanent_failed: { label: "요약 확인 필요", state: "error" },
};

export function getRecordStatusPresentation(status: string): RecordStatusPresentation {
  return RECORD_STATUS[status] ?? { label: "상태 확인", state: "muted" };
}

export function getSummaryStatusPresentation(status: string): RecordStatusPresentation {
  return SUMMARY_STATUS[status] ?? { label: "요약 확인", state: "muted" };
}

export function formatRecordDate(value: string | null): string {
  if (!value) return "일정 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "일정 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function normalizeRecordSearch(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

export function getVisibleRecordTopics<T>(topics: readonly T[], limit: number): readonly T[] {
  return topics.slice(0, Math.max(0, limit));
}
