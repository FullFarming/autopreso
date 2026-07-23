export const RECONNECT_BASE_MILLISECONDS = 500;
export const RECONNECT_MAX_MILLISECONDS = 30_000;

export function getReconnectDelayMilliseconds(attempt: number): number {
  const boundedAttempt = Math.min(16, Math.max(0, Math.trunc(attempt)));
  const exponentialDelay = Math.min(
    RECONNECT_MAX_MILLISECONDS,
    RECONNECT_BASE_MILLISECONDS * (2 ** boundedAttempt),
  );
  const jitterMultiplier = 0.8 + (Math.random() * 0.4);
  return Math.min(RECONNECT_MAX_MILLISECONDS, Math.round(exponentialDelay * jitterMultiplier));
}

export function getReconnectStatus(delayMilliseconds: number): string {
  const seconds = delayMilliseconds < 1_000
    ? (delayMilliseconds / 1_000).toFixed(1)
    : Math.round(delayMilliseconds / 1_000).toString();
  return `재연결 중 · ${seconds}초 후 재시도`;
}
