"use client";

// Contract C8: host-only stage/countdown screen, opened directly by Electron
// as a full-screen Stage overlay on the selected external display.
// 16:9 cover frame; session title; HH:MM:SS countdown to scheduledAt; QR +
// 6-digit code; joined participant count. The countdown reaching zero never
// auto-starts the session — the host must press Go-Live in Electron.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ApiResponse, LiveParticipantActivity, LiveSession } from "@/lib/live-contract";
import { InviteQrCode } from "./LiveHostDashboard";

interface StageInvite {
  url: string;
  admissionCode: string;
}

function StageLoader({ label }: { label: string }) {
  return (
    <span className="live-stage-loader" role="status" aria-label={label}>
      <i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" />
    </span>
  );
}

function participantColorIndex(participantId: string): number {
  let hash = 0;
  for (const character of participantId) hash = ((hash << 5) - hash + (character.codePointAt(0) ?? 0)) | 0;
  return Math.abs(hash) % 5 + 1;
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
  const [participants, setParticipants] = useState<LiveParticipantActivity[]>([]);
  const [coverState, setCoverState] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
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
      try {
        const activity = await readResponse<{ participants: LiveParticipantActivity[] }>(
          await fetch(`/api/live-sessions/${sessionId}/participants`, { method: "GET", cache: "no-store" }),
        );
        setParticipants(activity.participants.filter((participant) => participant.isPresent));
      } catch {
        // Keep the last successful stack while participant polling recovers.
      }
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

  useEffect(() => {
    setCoverState(session?.hasCoverImage ? "loading" : "idle");
  }, [session?.coverImageVersion, session?.hasCoverImage]);

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
            <p className="live-stage-hint">Return to NOVA Settings, save Host Authorization, then start Live Call again.</p>
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
    return <main className="live-stage-shell"><StageLoader label="Loading stage" /></main>;
  }

  const isCountingDown = session.status === "preparing" && countdownMs !== null && countdownMs > 0;
  const isPrelive = session.status === "preparing";
  const isEnded = session.status === "stopped" || session.status === "failed";
  const stateLine = session.status === "live"
    ? "LIVE"
    : session.status === "paused"
      ? "Paused"
      : isEnded
        ? "END"
        : countdownMs !== null && countdownMs <= 0
          ? "Ready — waiting for host to start"
          : "Waiting for host";

  const visibleParticipants = participants.slice(0, 5);
  const joinedCount = Math.max(session.viewerCount, participants.length);
  const overflowCount = Math.max(0, joinedCount - visibleParticipants.length);
  const manualJoinUrl = new URL("/watch", window.location.origin).toString();
  const manualJoinLabel = manualJoinUrl.replace(/^https?:\/\//u, "").replace(/\/$/u, "");

  return (
    <main className="live-stage-shell" aria-label="Session stage">
      <div className="live-stage-frame">
        {session.hasCoverImage && coverState !== "failed" && (
          <img className={`live-stage-cover ${coverState === "loaded" ? "is-loaded" : ""} ${isPrelive ? "" : "is-dimmed"}`}
            src={`/api/live-sessions/${sessionId}/cover${session.coverImageVersion ? `?v=${session.coverImageVersion}` : ""}`}
            alt="" aria-hidden="true" onLoad={() => setCoverState("loaded")} onError={() => setCoverState("failed")} />
        )}
        {coverState === "loading" && <div className="live-stage-cover-loading"><StageLoader label="Loading cover" /></div>}
        <div className="live-stage-scrim" aria-hidden="true" />
        <div className="live-stage-grid">
          <section className="live-stage-session" aria-labelledby="live-stage-title">
            <span className="live-stage-eyebrow">Live Call</span>
            <h1 id="live-stage-title" className="live-stage-title">{session.title}</h1>
            {isCountingDown ? (
              <div className="live-stage-ring">
                <span className="live-loading-ring" aria-hidden="true" />
              <p className="live-stage-countdown" role="timer" aria-label="Time until the scheduled start">
                {formatCountdown(countdownMs)}
              </p>
              </div>
            ) : (
              <p className={`live-stage-state ${session.status === "live" ? "is-live" : ""} ${isEnded ? "is-ended" : ""}`} role="status">
                {session.status === "live" && <span className="live-status-dot is-live" aria-hidden="true" />}
                {stateLine}
              </p>
            )}
            {isCountingDown && <p className="live-stage-hint">Starts at {new Date(session.scheduledAt ?? "").toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })} · the host starts the session manually.</p>}
            <div className="live-stage-attendance" aria-label={`${joinedCount} joined`}>
              <div className="live-stage-avatar-stack">
                {visibleParticipants.map((participant) => (
                  <span key={participant.participantId} className={`live-stage-avatar color-${participantColorIndex(participant.participantId)}`}
                    aria-label={participant.displayName} title={participant.displayName}>
                    {Array.from(participant.displayName.trim())[0]?.toUpperCase() ?? ""}
                  </span>
                ))}
                {overflowCount > 0 && <span className="live-stage-avatar is-overflow" aria-label={`${overflowCount} more participants`}>+{overflowCount}</span>}
              </div>
              <span className="live-stage-count" aria-live="polite">{joinedCount} joined</span>
            </div>
          </section>
          {invite && (
            <aside className={`live-stage-access ${isPrelive ? "" : "is-faded-out"}`} aria-hidden={!isPrelive} aria-label="Guest access">
              <InviteQrCode value={invite.url} />
              <div className="live-stage-code">
                <span>6-digit access code</span>
                <strong>{invite.admissionCode}</strong>
              </div>
              <a className="live-stage-manual-url" href={manualJoinUrl} target="_blank" rel="noreferrer">
                <span>Join manually</span>
                <strong>{manualJoinLabel}</strong>
              </a>
            </aside>
          )}
        </div>
      </div>
    </main>
  );
}
