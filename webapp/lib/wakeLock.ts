"use client";

// Screen Wake Lock while a session is running, so phones/tablets don't dim
// mid-meeting. Falls back to a no-op where navigator.wakeLock is unavailable
// (non-secure contexts, older browsers). Re-acquires after tab visibility
// changes — the UA silently releases the sentinel when the tab is hidden.

import { useEffect } from "react";

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void): void;
}

export function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const wakeLock: { request(type: "screen"): Promise<WakeLockSentinelLike> } | undefined =
      (navigator as any).wakeLock;
    if (!wakeLock) return; // fallback no-op

    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    async function acquire() {
      try {
        const next = await wakeLock!.request("screen");
        if (cancelled) {
          next.release().catch(() => undefined);
          return;
        }
        sentinel = next;
      } catch {
        // Permission denied / low battery — non-fatal, screen may dim.
      }
    }

    function handleVisibility() {
      if (document.visibilityState === "visible") void acquire();
    }

    void acquire();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      sentinel?.release().catch(() => undefined);
      sentinel = null;
    };
  }, [enabled]);
}
