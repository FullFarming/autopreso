"use client";

// Contract C8: host-only stage/countdown screen, opened directly by Electron
// as a full-screen Stage overlay on the selected external display.
// Pure black; session title; HH:MM:SS countdown to scheduledAt; QR + 6-digit
// code; joined participant count. The countdown reaching zero never
// auto-starts the session — the host must press Go-Live in Electron.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ApiResponse, LiveSession } from "@/lib/live-contract";
import { InviteQrCode } from "./LiveHostDashboard";

interface StageInvite {
  url: string;
  admissionCode: string;
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as ApiResponse<T>;
  if (!payload.ok) throw new Error(payload.error);
  return payload.data;
}

function readInviteFromHash(): StageInvite | null {
  const fragment = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(fragment);
  const url = params.get("invite");
  const admissionCode = params.get("code");
  if (!url || !admissionCode || !/^\d{6}$/u.test(admissionCode)) return null;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
  } catch {
    return null;
  }
  return { url, admissionCode };
}

import { formatCountdown } from "@/lib/live/countdown";
export { formatCountdown };

export default function LiveStageView({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<LiveSession | null>(null);
  const [invite, setInvite] = useState<StageInvite | null>(null);
  const [error, setError] = useState<"" | "auth" | "generic">("");
  const [now, setNow] = useState(() => Date.now());

  // Host authorization: the session GET requires the host cookie; anyone
  // else sees the auth error state. Other failures (network, 500) must NOT
  // masquerade as an authorization problem — they get the generic state.
  const refreshSession = useCallback(async () => {
    try {
      const response = await fetch(`/api/live-sessions/${sessionId}`, {
        method: "GET",
        cache: "no-store",
      });
      if (response.status === 401 || response.status === 403) {
        setError("auth");
        return;
      }
      const latest = await readResponse<LiveSession>(response);
      setSession(latest);
      setError("");
    } catch {
      setError("generic");
    }
  }, [sessionId]);

  useEffect(() => {
    setInvite(readInviteFromHash());
    void refreshSession();
    const poll = window.setInterval(() => { void refreshSession(); }, 5_000);
    return () => window.clearInterval(poll);
  }, [refreshSession]);

  // Fast path: the dashboard broadcasts status changes over a same-origin
  // BroadcastChannel, so Start flips this screen instantly instead of after
  // the next 5s poll. The poll above stays as the fallback source of truth.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("realtime-noel-stage");
    channel.onmessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const message = data as { type?: unknown; sessionId?: unknown; status?: unknown };
      if (message.type !== "session-status" || message.sessionId !== sessionId) return;
      void refreshSession();
    };
    return () => channel.close();
  }, [refreshSession, sessionId]);

  // When the dashboard did not hand over the invite via the URL hash,
  // request one. The 6-digit admission code is deterministic per session,
  // so this never changes the code guests already have.
  useEffect(() => {
    if (invite || !session || session.status === "stopped" || session.status === "failed") return;
    let isDisposed = false;
    void (async () => {
      try {
        const result = await readResponse<{ inviteToken: string; admissionCode: string }>(
          await fetch(`/api/live-sessions/${sessionId}/invites`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "create" }),
          }),
        );
        if (!isDisposed) {
          setInvite({
            url: `${window.location.origin}/m/watch#invite=${encodeURIComponent(result.inviteToken)}`,
            admissionCode: result.admissionCode,
          });
        }
      } catch {
        // The stage still works without a QR; the dashboard shows one.
      }
    })();
    return () => { isDisposed = true; };
  }, [invite, session, sessionId]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(tick);
  }, []);

  const countdownMs = useMemo(() => {
    if (!session?.scheduledAt) return null;
    const scheduled = Date.parse(session.scheduledAt);
    if (!Number.isFinite(scheduled)) return null;
    return scheduled - now;
  }, [now, session?.scheduledAt]);

  if (error && !session) {
    return (
      <main className="live-stage-shell" aria-label="Session stage">
        {error === "auth" ? (
          <>
            <p className="live-stage-error" role="alert">Host authorization is required for this Stage overlay.</p>
            <p className="live-stage-hint">Return to Realtime Noel Settings, save Host Authorization, then start Live Call again.</p>
          </>
        ) : (
          <>
            <p className="live-stage-error" role="alert">Unable to load the session.</p>
            <p className="live-stage-hint">Check the network connection — the stage retries automatically.</p>
          </>
        )}
      </main>
    );
  }

  if (!session) {
    return <main className="live-stage-shell"><p className="live-stage-hint" role="status">Loading stage…</p></main>;
  }

  const isCountingDown = session.status === "preparing" && countdownMs !== null && countdownMs > 0;
  const isPrelive = session.status === "preparing";
  const stateLine = session.status === "live"
    ? "LIVE"
    : session.status === "paused"
      ? "Paused"
      : session.status === "stopped" || session.status === "failed"
        ? "Session ended"
        : countdownMs !== null && countdownMs <= 0
          ? "Ready — waiting for host to start"
          : "Waiting for host";

  // Contract C10: cover image behind a darkening scrim. The pre-live layers
  // (countdown ring, QR, hint) stay mounted and fade out when the host
  // starts, so the transition reads as a broadcast opening, not a reload.
  return (
    <main className="live-stage-shell" aria-label="Session stage">
      {session.hasCoverImage && (
        <>
          <img className={`live-stage-cover ${isPrelive ? "" : "is-dimmed"}`}
            src={`/api/live-sessions/${sessionId}/cover${session.coverImageVersion ? `?v=${session.coverImageVersion}` : ""}`}
            alt="" aria-hidden="true" />
          <div className="live-stage-scrim" aria-hidden="true" />
        </>
      )}
      <div className="live-stage-content">
        <h1 className="live-stage-title">{session.title}</h1>
        {isPrelive ? (
          <div className="live-stage-ring">
            <span className="live-loading-ring" aria-hidden="true" />
            {isCountingDown ? (
              <p className="live-stage-countdown" role="timer" aria-label="Time until the scheduled start">
                {formatCountdown(countdownMs)}
              </p>
            ) : (
              <p className="live-stage-state" role="status">{stateLine}</p>
            )}
          </div>
        ) : (
          <p className={`live-stage-state ${session.status === "live" ? "is-live" : ""}`} role="status">
            {session.status === "live" && <span className="live-status-dot is-live" aria-hidden="true" />}
            {stateLine}
          </p>
        )}
        {isCountingDown && <p className="live-stage-hint">Starts at {new Date(session.scheduledAt ?? "").toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })} · the host starts the session manually.</p>}
        {invite && (
          <div className={`live-stage-access ${isPrelive ? "" : "is-faded-out"}`} aria-hidden={!isPrelive}>
            <InviteQrCode value={invite.url} />
            <div className="live-stage-code">
              <span>6-digit access code</span>
              <strong>{invite.admissionCode}</strong>
            </div>
          </div>
        )}
        <p className="live-stage-count" aria-live="polite">{session.viewerCount} joined</p>
      </div>
    </main>
  );
}
