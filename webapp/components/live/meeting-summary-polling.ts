export type SummaryPollingState = "idle" | "polling" | "exhausted" | "failed";

const SUMMARY_POLL_BASE_DELAYS_MILLISECONDS = [2_000, 4_000, 8_000, 12_000, 16_000, 20_000] as const;

interface SummaryPollTimerApi {
  setTimeout: (callback: () => void, delayMilliseconds: number) => number;
  clearTimeout: (timer: number) => void;
}

interface SummaryPollLoopOptions {
  poll: () => Promise<boolean>;
  onExhausted: () => void;
  onError: (error: unknown) => void;
  random?: () => number;
  timerApi?: SummaryPollTimerApi;
}

export function getSummaryPollDelayMilliseconds(attempt: number, randomValue: number): number {
  const index = Math.min(SUMMARY_POLL_BASE_DELAYS_MILLISECONDS.length - 1, Math.max(0, Math.trunc(attempt)));
  const boundedRandomValue = Math.min(1, Math.max(0, randomValue));
  return Math.round(SUMMARY_POLL_BASE_DELAYS_MILLISECONDS[index] * (1 + boundedRandomValue * 0.25));
}

export function startSummaryPollLoop({
  poll, onExhausted, onError, random = Math.random,
  timerApi = {
    setTimeout: (callback, delayMilliseconds) => window.setTimeout(callback, delayMilliseconds),
    clearTimeout: (timer) => window.clearTimeout(timer),
  },
}: SummaryPollLoopOptions): () => void {
  let attempt = 0;
  let timer: number | null = null;
  let isDisposed = false;
  const scheduleNext = () => {
    if (isDisposed) return;
    if (attempt >= SUMMARY_POLL_BASE_DELAYS_MILLISECONDS.length) {
      onExhausted();
      return;
    }
    timer = timerApi.setTimeout(() => {
      timer = null;
      attempt += 1;
      void poll().then((shouldContinue) => {
        if (!isDisposed && shouldContinue) scheduleNext();
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
