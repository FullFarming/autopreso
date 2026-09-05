export type SummaryPollResult = boolean | "pending";

export type SummaryPollingState = "idle" | "polling" | "exhausted" | "failed";

/**
 * Why a loop stopped on its own: six consecutive read failures, or a job that
 * kept answering "pending" past the wall-clock cap (a RUNNING lease that never
 * resolves would otherwise be polled forever, 20-25 s apart).
 */
export type SummaryPollExhaustedReason = "SUMMARY_READ_EXHAUSTED" | "SUMMARY_GENERATION_STALLED";

const SUMMARY_POLL_BASE_DELAYS_MILLISECONDS = [2_000, 4_000, 8_000, 12_000, 16_000, 20_000] as const;
export const MAX_POLLING_WALL_CLOCK_MS = 30 * 60_000;

interface SummaryPollTimerApi {
  setTimeout: (callback: () => void, delayMilliseconds: number) => number;
  clearTimeout: (timer: number) => void;
}

interface SummaryPollLoopOptions {
  poll: () => Promise<SummaryPollResult>;
  onExhausted: (reason: SummaryPollExhaustedReason) => void;
  onError: (error: unknown) => void;
  isHidden?: () => boolean;
  random?: () => number;
  now?: () => number;
  timerApi?: SummaryPollTimerApi;
}

export function getSummaryPollDelayMilliseconds(attempt: number, randomValue: number): number {
  const index = Math.min(SUMMARY_POLL_BASE_DELAYS_MILLISECONDS.length - 1, Math.max(0, Math.trunc(attempt)));
  const boundedRandomValue = Math.min(1, Math.max(0, randomValue));
  return Math.round(SUMMARY_POLL_BASE_DELAYS_MILLISECONDS[index] * (1 + boundedRandomValue * 0.25));
}

export function startSummaryPollLoop({
  poll, onExhausted, onError, random = Math.random, now = Date.now,
  isHidden = () => typeof document !== "undefined" && document.hidden,
  timerApi = {
    setTimeout: (callback, delayMilliseconds) => window.setTimeout(callback, delayMilliseconds),
    clearTimeout: (timer) => window.clearTimeout(timer),
  },
}: SummaryPollLoopOptions): () => void {
  let attempt = 0;
  let consecutiveReadFailures = 0;
  let timer: number | null = null;
  let isDisposed = false;
  const startedAt = now();
  const scheduleNext = () => {
    if (isDisposed) return;
    if (consecutiveReadFailures >= SUMMARY_POLL_BASE_DELAYS_MILLISECONDS.length) {
      onExhausted("SUMMARY_READ_EXHAUSTED");
      return;
    }
    if (now() - startedAt >= MAX_POLLING_WALL_CLOCK_MS) {
      onExhausted("SUMMARY_GENERATION_STALLED");
      return;
    }
    timer = timerApi.setTimeout(() => {
      timer = null;
      if (isHidden()) { scheduleNext(); return; }
      attempt += 1;
      void poll().then((shouldContinue) => {
        if (!isDisposed && shouldContinue) {
          consecutiveReadFailures = shouldContinue === "pending" ? 0 : consecutiveReadFailures + 1;
          scheduleNext();
        }
      }).catch((error: unknown) => {
        if (!isDisposed) onError(error);
      });
    }, getSummaryPollDelayMilliseconds(attempt, random()));
  };
  scheduleNext();
  return () => {
    isDisposed = true;
    if (timer !== null) timerApi.clearTimeout(timer);
    timer = null;
  };
}
