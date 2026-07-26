export type ForegroundRecoveryEvent = "visibilitychange" | "pageshow" | "online";

export interface ForegroundRecoveryState {
  inFlight: Promise<void> | null;
}

export function shouldRequestForegroundRecovery(
  event: ForegroundRecoveryEvent,
  visibilityState: DocumentVisibilityState,
): boolean {
  if (event === "visibilitychange") return visibilityState === "visible";
  return visibilityState !== "hidden";
}

export function requestForegroundRecovery(
  state: ForegroundRecoveryState,
  event: ForegroundRecoveryEvent,
  visibilityState: DocumentVisibilityState,
  recover: () => void | Promise<void>,
): Promise<void> | null {
  if (!shouldRequestForegroundRecovery(event, visibilityState)) return null;
  if (state.inFlight) return state.inFlight;

  let recovery: Promise<void>;
  try {
    recovery = Promise.resolve(recover());
  } catch (error) {
    recovery = Promise.reject(error);
  }
  const tracked = recovery.finally(() => {
    if (state.inFlight === tracked) state.inFlight = null;
  });
  state.inFlight = tracked;
  return tracked;
}
