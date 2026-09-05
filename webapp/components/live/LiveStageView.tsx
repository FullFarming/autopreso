"use client";

// Contract C8: host-only stage/countdown screen, opened directly by Electron
// as a full-screen Stage overlay on the selected external display.
// 16:9 cover frame; session title; HH:MM:SS countdown to scheduledAt; QR +
// 6-digit code; joined participant count. The countdown reaching zero never
// auto-starts the session — the host must press Go-Live in Electron.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ApiResponse,
  LiveParticipantActivity,
  LiveSession,
  LiveSpeechActivity,
} from "@/lib/live-contract";
import { InviteQrCode } from "./LiveHostDashboard";
import { buildAdmissionJoinUrl } from "./admission-link";
import { CaptionEntry, TranslationViewport } from "./translation";
import { getCurrentStageInvite, hasOpenStageAdmission, type HostInvitation } from "./invite-share";

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

import { formatCountdown } from "@/lib/live/countdown";
export { formatCountdown };

export default function LiveStageView({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<LiveSession | null>(null);
  const [invite, setInvite] = useState<HostInvitation | null>(null);
  const latestSessionRef = useRef<LiveSession | null>(null);
  const refreshGenerationRef = useRef(0);
  const [inviteError, setInviteError] = useState(false);
  const [inviteRetryKey, setInviteRetryKey] = useState(0);
  const [participants, setParticipants] = useState<LiveParticipantActivity[]>([]);
  const [recentSpeeches, setRecentSpeeches] = useState<LiveSpeechActivity[]>([]);
  const [coverState, setCoverState] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const [error, setError] = useState<"" | "auth" | "generic">("");
  const [now, setNow] = useState(() => Date.now());

  const clearHostState = useCallback(() => {
    latestSessionRef.current = null;
    setSession(null);
    setInvite(null);
    setParticipants([]);
    setRecentSpeeches([]);
    setInviteError(false);
  }, []);

  const refreshSession = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    const isCurrent = () => generation === refreshGenerationRef.current;
    try {
      const response = await fetch(`/api/live-sessions/${sessionId}`, {
        method: "GET", cache: "no-store",
      });
      if (!isCurrent()) return;
      if ([401, 403, 404].includes(response.status)) {
        clearHostState();
        setError("auth");
        return;
      }
      const latest = await readResponse<LiveSession>(response);
      if (!isCurrent()) return;
      if (latestSessionRef.current?.id === latest.id && latestSessionRef.current.version > latest.version) return;
      latestSessionRef.current = latest;
      setSession(latest);
      setError("");
      if (["stopped", "failed"].includes(latest.status)) {
        setInvite(null);
        setParticipants([]);
        setRecentSpeeches([]);
        return;
      }
      try {
        const activityResponse = await fetch(`/api/live-sessions/${sessionId}/participants`, {
          method: "GET", cache: "no-store",
        });
        if (!isCurrent()) return;
        if ([401, 403, 404].includes(activityResponse.status)) {
          clearHostState();
          setError("auth");
          return;
        }
        const activity = await readResponse<{
          participants: LiveParticipantActivity[];
          recentSpeeches: LiveSpeechActivity[];
        }>(activityResponse);
        if (!isCurrent()) return;
        setParticipants(activity.participants.filter((participant) => participant.isPresent));
        setRecentSpeeches(activity.recentSpeeches);
      } catch {
        if (!isCurrent()) return;
        setParticipants([]);
        setRecentSpeeches([]);
      }
    } catch {
      if (!isCurrent()) return;
      clearHostState();
      setError("generic");
    }
  }, [clearHostState, sessionId]);

  useEffect(() => {
    clearHostState();
    let isDisposed = false;
    let poll: number | undefined;
    const refreshAndSchedule = async () => {
      await refreshSession();
      if (!isDisposed) poll = window.setTimeout(() => { void refreshAndSchedule(); }, 5_000);
    };
    void refreshAndSchedule();
    return () => {
      isDisposed = true;
      refreshGenerationRef.current += 1;
      window.clearTimeout(poll);
    };
  }, [clearHostState, refreshSession, sessionId]);

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

  // Stage reads the code without minting an invite: minting would rotate the
  // single persisted token and invalidate the dashboard's shared invitation.
  useEffect(() => {
    const activeSession = latestSessionRef.current;
    if (!activeSession || error || !hasOpenStageAdmission(activeSession, Date.now())
      || getCurrentStageInvite(invite, activeSession, Date.now())) return;
    const admissionOpenUntil = activeSession.admissionOpenUntil;
    setInviteError(false);
    let isDisposed = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/live-sessions/${sessionId}/invites`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "read-if-open" }),
            signal: controller.signal,
          });
        if (isDisposed) return;
        if ([401, 403, 404].includes(response.status)) {
          refreshGenerationRef.current += 1;
          clearHostState();
          setError("auth");
          return;
        }
        const result = await readResponse<{ admissionCode: string; admissionOpenUntil: string }>(response);
        const candidate = {
          sessionId,
          url: buildAdmissionJoinUrl(window.location.origin, result.admissionCode),
          admissionCode: result.admissionCode,
          expiresAt: result.admissionOpenUntil,
        };
        if (!isDisposed && Date.parse(result.admissionOpenUntil) === Date.parse(admissionOpenUntil ?? "")
          && getCurrentStageInvite(candidate, latestSessionRef.current, Date.now())) {
          setInvite(candidate);
        }
      } catch {
        if (!isDisposed && !controller.signal.aborted) setInviteError(true);
      }
    })();
    return () => { isDisposed = true; controller.abort(); };
  }, [clearHostState, error, invite, session, sessionId, inviteRetryKey]);

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

  if (error) {
    return (
      <main className="live-stage-shell" aria-label="Session stage">
        {error === "auth" ? (
          <>
            <p className="live-stage-error" role="alert">이 회의를 준비한 호스트 계정으로 로그인해 주세요.</p>
            <p className="live-stage-hint">같은 계정으로 로그인한 뒤 QR·진행 화면에서 회의를 선택해 주세요.</p>
            <a className="live-link-button" href="/login">호스트 로그인</a>
          </>
        ) : (
          <>
            <p className="live-stage-error" role="alert">회의를 불러오지 못했습니다.</p>
            <p className="live-stage-hint">연결을 확인해 주세요. 잠시 후 다시 확인합니다.</p>
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
  const currentInvite = error ? null : getCurrentStageInvite(invite, session, now);
  const stateLine = countdownMs !== null && countdownMs <= 0
    ? "Ready — waiting for host to start"
    : "Waiting for host";

  const visibleParticipants = participants.slice(0, 5);
  const joinedCount = Math.max(session.viewerCount, participants.length);
  const overflowCount = Math.max(0, joinedCount - visibleParticipants.length);
  const manualJoinLabel = new URL("/watch", window.location.origin).toString()
    .replace(/^https?:\/\//u, "")
    .replace(/\/$/u, "");
  const attendance = (
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
  );

  return (
    <main className="live-stage-shell" aria-label="Session stage">
      <nav className="live-stage-companion-navigation" aria-label="QR·진행 화면">
        <a className="live-link-button" href="/host-screen" target="_blank" rel="noopener">회의 목록</a>
        <span>음성은 데스크톱에서 송출됩니다.</span>
      </nav>
      {!isEnded && !currentInvite && (
        <div className="live-stage-invite-notice" role="status">
          {inviteError ? <><span>QR을 불러오지 못했습니다.</span><button type="button" className="live-button-secondary" onClick={() => setInviteRetryKey((value) => value + 1)}>다시 불러오기</button></>
            : <span>{hasOpenStageAdmission(session, now) ? "QR을 불러오는 중…" : "참여자 입장이 닫혀 있습니다. 데스크톱에서 입장을 열어 주세요."}</span>}
        </div>
      )}
      <div className="live-stage-frame">
        {!isEnded && session.hasCoverImage && coverState !== "failed" && (
          <img className={`live-stage-cover ${coverState === "loaded" ? "is-loaded" : ""} ${isPrelive ? "" : "is-dimmed"}`}
            src={`/api/live-sessions/${sessionId}/cover${session.coverImageVersion ? `?v=${session.coverImageVersion}` : ""}`}
            alt="" aria-hidden="true" onLoad={() => setCoverState("loaded")} onError={() => setCoverState("failed")} />
        )}
        {!isEnded && coverState === "loading" && <div className="live-stage-cover-loading"><StageLoader label="Loading cover" /></div>}
        <div className="live-stage-scrim" aria-hidden="true" />
        {isEnded ? (
          <section className="live-stage-complete" aria-labelledby="live-stage-title">
            <span className="live-stage-eyebrow">Session complete</span>
            <h1 id="live-stage-title" className="live-stage-title">{session.title}</h1>
            <p className="live-stage-state is-ended" role="status">The Live Call has ended</p>
          </section>
        ) : isPrelive ? (
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
              ) : <p className="live-stage-state" role="status">{stateLine}</p>}
              {isCountingDown && <p className="live-stage-hint">Starts at {new Date(session.scheduledAt ?? "").toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })} · the host starts the session manually.</p>}
              {attendance}
            </section>
            {isPrelive && currentInvite && (
              <aside className="live-stage-access" aria-label="Guest access">
                <InviteQrCode value={currentInvite.url} />
                <div className="live-stage-code">
                  <span>6-digit access code</span>
                  <strong>{currentInvite.admissionCode}</strong>
                </div>
                <div className="live-stage-manual-url">
                  <span>Join manually</span>
                  <strong>{manualJoinLabel}</strong>
                </div>
              </aside>
            )}
          </div>
        ) : (
          <div className="live-stage-translation" data-stage-surface="caption-first">
            <header className="live-stage-translation-header">
              <div><span className="live-stage-eyebrow">Live Call</span><h1 id="live-stage-title" className="live-stage-title">{session.title}</h1></div>
              <p className="live-stage-state is-live" role="status">{session.status === "paused" ? "Paused" : "Live"}</p>
              {attendance}
              {!isEnded && currentInvite && (
                <aside className="live-stage-access is-live" aria-label="Guest access">
                  <InviteQrCode value={currentInvite.url} />
                  <div className="live-stage-code">
                    <span>Access code</span>
                    <strong>{currentInvite.admissionCode}</strong>
                  </div>
                </aside>
              )}
            </header>
            <TranslationViewport
              state={session.status === "paused" ? "paused" : "live"}
              statusLabel={session.status === "paused" ? "Captions paused" : undefined}
              statusDescription={`${joinedCount} joined`}
              captionFirstPreview={recentSpeeches.at(-1)?.text ?? ""}
              previewLabel="Stage caption preview"
              finalAnnouncement={recentSpeeches.at(-1)?.text}
              emptyLabel="Translations will appear here"
              ariaLabel="Stage translations"
              listLabel="Stage caption list"
              density="comfortable"
            >
              {recentSpeeches.map((speech) => (
                <CaptionEntry key={`${speech.participantId ?? "host"}-${speech.seq}`}
                  text={speech.text} speakerLabel={speech.displayName} speakerProfile={speech.speakerProfile} sessionId={sessionId} isFinal />
              ))}
            </TranslationViewport>
          </div>
        )}
      </div>
    </main>
  );
}
