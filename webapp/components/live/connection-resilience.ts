export const RECONNECT_BASE_MILLISECONDS = 500;
export const RECONNECT_MAX_MILLISECONDS = 30_000;
export const LIVE_SOCKET_OPEN_TIMEOUT_MILLISECONDS = 5_000;
export const LIVE_SNAPSHOT_TIMEOUT_MILLISECONDS = 5_000;

interface SocketOpenTarget {
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListener): void;
  close(): void;
}

export function waitForSocketOpen(
  socket: SocketOpenTarget,
  timeoutMilliseconds: number = LIVE_SOCKET_OPEN_TIMEOUT_MILLISECONDS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let isSettled = false;
    const settle = (result: "open" | "error" | "timeout") => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeout);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      if (result === "open") {
        resolve();
        return;
      }
      socket.close();
      reject(new Error(result === "timeout"
        ? "The live socket open timed out."
        : "Unable to connect to the live gateway."));
    };
    const handleOpen: EventListener = () => settle("open");
    const handleError: EventListener = () => settle("error");
    const timeout = setTimeout(() => settle("timeout"), timeoutMilliseconds);
    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleError, { once: true });
  });
}

export async function withAbortTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMilliseconds: number = LIVE_SNAPSHOT_TIMEOUT_MILLISECONDS,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("The live snapshot request timed out.")), timeoutMilliseconds);
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

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
  return `Reconnecting · retrying in ${seconds}s`;
}
