"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

import type {
  ApiResponse,
  GlossaryPack,
  LiveOutputMode,
  LiveSession,
  LiveSessionType,
  SpeakerAssignment,
} from "@/lib/live-contract";
import { LANGUAGE_CODES, LANGUAGE_LABELS } from "@/lib/languageDetect";
import { LIVE_CALL_ENABLED } from "@/lib/live/feature-flag";
import type { MeetingSummary } from "@/lib/live/summary";
import {
  startLiveAudioClient,
  type LiveAudioClient,
  type LiveInputSource,
} from "./live-audio-client";
import {
  formatElapsedTime,
  startSummaryPollLoop,
  type SummaryPollingState,
} from "./MeetingMinutes";
import MeetingSummaryCard from "./MeetingSummaryCard";
import { resolveSpeakerColor } from "./SpeakerCaption";
import { getDefaultLiveSchedule, validateLiveSchedule } from "./live-session-schedule";

const LANGUAGE_OPTIONS = LANGUAGE_CODES.map((code) => ({ code, label: LANGUAGE_LABELS[code] }));

const SESSION_TYPE_OPTIONS: Array<{ value: LiveSessionType; title: string; description: string }> = [
  { value: "presentation", title: "Presentation", description: "Deliver one presenter in each guest's selected language." },
  { value: "meeting", title: "Meeting", description: "Identify multiple speakers and deliver captions or translated audio." },
];

// Translated-audio delivery is HIDDEN for now, not removed. At this stage only
// translated captions cross to participants, get recorded on the host, and flow
// in real time -- so a host can no longer select an audio-bearing mode. The
// contract, the pipeline and the live_sessions CHECK still accept
// captions_audio/audio, which keeps the seq contract (audio events never consume
// a caption seq) and the TTS paths intact and testable for when audio returns.
const OUTPUT_OPTIONS: Array<{ value: LiveOutputMode; title: string; description: string }> = [
  { value: "captions", title: "Captions", description: "Show translated captions." },
];
const GEMINI_VOICE_PROVIDER = "gemini" as const;

function getDeliveryMethod(sessionType: LiveSessionType, outputMode: LiveOutputMode): { title: string; status: string; description: string } {
  if (sessionType === "presentation") {
    return outputMode === "captions"
      ? { title: "Fast live captions", status: "Optimized for one presenter", description: "Display captions in each selected language while the presenter speaks." }
      : { title: "Gemini translated audio", status: "Optimized for one presenter", description: "Deliver Gemini captions and translated audio together." };
  }
  return outputMode === "captions"
    ? { title: "Speaker-aware captions", status: "Shown after each turn", description: "Identify each speaker and display translated captions after the turn." }
    : { title: "Speaker-aware translated audio", status: "One AI voice per speaker", description: "Play translated audio after each turn. Long uninterrupted speech may add delay." };
}

const SESSION_LANGUAGE_HELP: Record<LiveSessionType, string> = {
  presentation: "English is the default translation language. A new language becomes available after preparation.",
  meeting: "Meeting provides speaker-aware captions for each selected language. Changes apply after preparation.",
};

const GLOSSARY_PACK_OPTIONS: Array<{ value: GlossaryPack; title: string; description: string }> = [
  { value: "general_cre", title: "CRE", description: "Commercial real estate terminology" },
  { value: "hotel", title: "Hotel", description: "Hotel investment and operations" },
  { value: "fnb", title: "F&B", description: "Retail leasing and food service" },
];

interface AdmissionState {
  code: string;
  openUntil: string;
}

interface InviteState {
  url: string;
  admissionCode: string;
  expiresAt: string;
}

interface InviteResult {
  inviteToken: string;
  admissionCode: string;
  expiresAt: string;
  version: number;
}

interface LiveParticipant {
  participantId: string;
  displayName: string;
  department: string;
  jobTitle: string;
  joinedAt: string;
  lastSeenAt: string;
  isPresent: boolean;
  utteranceCount: number;
  speakingSeconds: number;
  lastSpokeAt: string | null;
}

interface RecentSpeech {
  seq: number;
  participantId: string;
  displayName: string;
  department: string;
  jobTitle: string;
  text: string;
  startedAt: string;
  endedAt: string;
}

interface ParticipantActivity {
  participants: LiveParticipant[];
  recentSpeeches: RecentSpeech[];
}

interface GatewayCredentials {
  token: string;
  gatewayUrl: string;
  expiresAt: string;
}

interface RecoverableSession {
  id: string;
  title: string;
  status: LiveSession["status"];
  scheduledAt: string | null;
  viewerCount: number;
  version: number;
}

type LanguageStatus = "preparing" | "ready" | "unavailable";

const LANGUAGE_STATUS_LABELS: Record<LanguageStatus, string> = {
  preparing: "Preparing",
  ready: "Ready",
  unavailable: "Unavailable",
};

function languageStatusMap(languages: string[], status: LanguageStatus): Record<string, LanguageStatus> {
  return Object.fromEntries(languages.map((language) => [language, status]));
}

function getSpeakerVoiceStatus(speaker: SpeakerAssignment, outputMode: LiveOutputMode): string {
  if (outputMode === "captions") return "Captions only";
  if ("voiceStatus" in speaker) {
    if (speaker.voiceStatus === "analyzing") return "Analyzing voice";
    if (speaker.voiceStatus === "ready") return `Voice ready${speaker.voiceName ? ` · ${speaker.voiceName}` : ""}`;
    if (speaker.voiceStatus === "unavailable") return "Unavailable";
    if (speaker.voiceStatus === "disabled") return "Captions only";
  }
  if (speaker.voiceName) return `Voice ready · ${speaker.voiceName}`;
  return "Waiting for voice";
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as ApiResponse<T>;
  if (!payload.ok) throw new Error(payload.error);
  return payload.data;
}

function formatTime(value: string | null): string {
  if (!value) return "Closed";
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function formatSessionStatus(status: LiveSession["status"]): string {
  if (status === "live") return "Live";
  if (status === "preparing") return "Preparing";
  if (status === "paused") return "Paused";
  if (status === "stopped") return "Ended";
  return "Failed";
}

export function InviteQrCode({ value }: { value: string }) {
  const [dataUrl, setDataUrl] = useState("");
  const [qrError, setQrError] = useState("");

  useEffect(() => {
    let isDisposed = false;
    setDataUrl("");
    setQrError("");
    void QRCode.toDataURL(value, {
      width: 176,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0c0a09", light: "#ffffff" },
    }).then((nextDataUrl) => {
      if (!isDisposed) setDataUrl(nextDataUrl);
    }).catch(() => {
      if (!isDisposed) setQrError("The QR code could not be created. Copy the invite link instead.");
    });
    return () => { isDisposed = true; };
  }, [value]);

  return (
    <figure className="live-invite-qr" data-qr-value={value}>
      {dataUrl ? <img src={dataUrl} alt="NOVA guest invite QR code" width={176} height={176} />
        : qrError ? <span role="alert">{qrError}</span>
          : <span role="status">Creating QR code…</span>}
      <figcaption>Scan or share this link · every guest enters their own profile</figcaption>
    </figure>
  );
}

async function requestGatewayCredentials(sessionId: string): Promise<GatewayCredentials> {
  const token = await readResponse<{ token: string; expiresAt: string }>(
    await fetch(`/api/live-sessions/${sessionId}/gateway-token`, { method: "POST" }),
  );
  const gatewayUrl = process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL ?? "";
  if (!gatewayUrl) throw new Error("The media gateway address is not configured.");
  return { ...token, gatewayUrl };
}

export default function LiveHostDashboard() {
  const [title, setTitle] = useState("");
  const [sessionDate, setSessionDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [scheduleNow, setScheduleNow] = useState<number | null>(null);
  const [sessionType, setSessionType] = useState<LiveSessionType>("presentation");
  const [outputMode, setOutputMode] = useState<LiveOutputMode>("captions");
  const [maxViewers, setMaxViewers] = useState(50);
  const [glossaryPack, setGlossaryPack] = useState<GlossaryPack>("general_cre");
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3 | 4>(1);
  const [isEditingSession, setIsEditingSession] = useState(false);
  const [inputSource, setInputSource] = useState<LiveInputSource>("mic");
  const [languages, setLanguages] = useState<string[]>(["en"]);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [speakers, setSpeakers] = useState<SpeakerAssignment[]>([]);
  const [endedSession, setEndedSession] = useState<{ id: string; languages: string[] } | null>(null);
  const [hostSummary, setHostSummary] = useState<{ summary: MeetingSummary; createdAt: string } | null>(null);
  const [hostSummaryError, setHostSummaryError] = useState("");
  const [hostSummaryFailureCode, setHostSummaryFailureCode] = useState("");
  const [hostSummaryPollingState, setHostSummaryPollingState] = useState<SummaryPollingState>("idle");
  const [hostSummaryPollingStartedAt, setHostSummaryPollingStartedAt] = useState<number | null>(null);
  const [hostSummaryPollingRound, setHostSummaryPollingRound] = useState(0);
  const [hostSummaryClockMilliseconds, setHostSummaryClockMilliseconds] = useState(() => Date.now());
  const [isHostSummaryRetrying, setIsHostSummaryRetrying] = useState(false);
  const [admission, setAdmission] = useState<AdmissionState | null>(null);
  const [invite, setInvite] = useState<InviteState | null>(null);
  const [inviteFeedback, setInviteFeedback] = useState("");
  const [participants, setParticipants] = useState<LiveParticipant[]>([]);
  const [recentSpeeches, setRecentSpeeches] = useState<RecentSpeech[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState("Ready");
  const [sessionSyncStatus, setSessionSyncStatus] = useState("Waiting to sync");
  const [languageStatuses, setLanguageStatuses] = useState<Record<string, LanguageStatus>>({});
  const [error, setError] = useState("");
  const [recoverableSessions, setRecoverableSessions] = useState<RecoverableSession[]>([]);
  const [isRecoveryDismissed, setIsRecoveryDismissed] = useState(false);
  const [isEndConfirmVisible, setIsEndConfirmVisible] = useState(false);
  const audioClientRef = useRef<LiveAudioClient | null>(null);
  const hostSummaryRetryRef = useRef(false);
  const sessionId = session?.id ?? null;

  const languageLabel = useMemo<Map<string, string>>(() => new Map(LANGUAGE_OPTIONS.map((item) => [item.code, item.label])), []);
  const scheduleValidation = useMemo(() => scheduleNow === null
    ? { scheduledAt: "", error: "" }
    : validateLiveSchedule(sessionDate, startTime, scheduleNow), [scheduleNow, sessionDate, startTime]);
  const scheduledAt = scheduleValidation.scheduledAt;

  useEffect(() => {
    const initializeSchedule = () => {
      const now = new Date();
      const defaults = getDefaultLiveSchedule(now);
      setScheduleNow(now.getTime());
      setSessionDate((current) => current || defaults.sessionDate);
      setStartTime((current) => current || defaults.startTime);
    };
    initializeSchedule();
    const timer = window.setInterval(() => setScheduleNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const toggleLanguage = useCallback((language: string) => {
    setLanguages((current) => {
      if (current.includes(language)) return current.length === 1 ? current : current.filter((item) => item !== language);
      if (current.length >= 3) return current;
      return [...current, language];
    });
  }, []);

  const createSession = useCallback(async () => {
    const currentSchedule = validateLiveSchedule(sessionDate, startTime, Date.now());
    if (currentSchedule.error) {
      setError(currentSchedule.error);
      return;
    }
    setIsBusy(true);
    setError("");
    try {
      const next = await readResponse<LiveSession>(await fetch("/api/live-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, scheduledAt: currentSchedule.scheduledAt, sessionType, languages, outputMode, voiceProvider: GEMINI_VOICE_PROVIDER, maxViewers, glossaryPack }),
      }));
      setSessionType(next.sessionType);
      setOutputMode(next.outputMode);
      setMaxViewers(next.maxViewers);
      setGlossaryPack(next.glossaryPack);
      setIsEditingSession(false);
      setAdmission(null);
      setInvite(null);
      setSpeakers([]);
      setLanguageStatuses(languageStatusMap(next.languages, "preparing"));
      setSession(next);
      const inviteResult = await readResponse<InviteResult>(
        await fetch(`/api/live-sessions/${next.id}/invites`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "create" }),
        }),
      );
      setInvite({
        url: `${window.location.origin}/m/watch#invite=${encodeURIComponent(inviteResult.inviteToken)}`,
        admissionCode: inviteResult.admissionCode,
        expiresAt: inviteResult.expiresAt,
      });
      setAdmission({ code: inviteResult.admissionCode, openUntil: inviteResult.expiresAt });
      setSession((current) => current?.id === next.id
        ? { ...current, version: inviteResult.version, admissionOpenUntil: inviteResult.expiresAt }
        : current);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The live session could not be created.");
    } finally {
      setIsBusy(false);
    }
  }, [glossaryPack, languages, maxViewers, outputMode, sessionDate, sessionType, startTime, title]);

  const stopBroadcast = useCallback(async () => {
    const client = audioClientRef.current;
    audioClientRef.current = null;
    if (client) await client.stop();
    setIsBroadcasting(false);
    setGatewayStatus("Ready");
  }, []);

  const restartBroadcast = useCallback(async () => {
    if (!audioClientRef.current || !isBroadcasting) return;
    setIsBusy(true);
    setError("");
    setGatewayStatus("Refreshing caption engine");
    try {
      await audioClientRef.current.restart();
      setGatewayStatus("Connected · broadcasting");
    } catch (restartError) {
      setGatewayStatus("Refresh failed · session still connected");
      setError(restartError instanceof Error ? restartError.message : "Unable to refresh the caption engine.");
    } finally {
      setIsBusy(false);
    }
  }, [isBroadcasting]);

  const applySession = useCallback(async () => {
    if (!session) return;
    const previousSession = session;
    const previousStatuses = languageStatuses;
    let didFailClosed = false;
    setIsBusy(true);
    setError("");
    setLanguageStatuses(languageStatusMap(languages, "preparing"));
    try {
      const next = await readResponse<LiveSession>(await fetch(`/api/live-sessions/${session.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: session.version, sessionType, languages, outputMode, voiceProvider: GEMINI_VOICE_PROVIDER, maxViewers, glossaryPack }),
      }));
      if (isBroadcasting && audioClientRef.current) {
        try {
          await audioClientRef.current.update({
            version: next.version,
            sessionType,
            languages,
            outputMode,
            voiceProvider: GEMINI_VOICE_PROVIDER,
            maxViewers,
            glossaryPack,
          });
        } catch (gatewayError) {
          let restoredSession: LiveSession | null = null;
          try {
            restoredSession = await readResponse<LiveSession>(await fetch(`/api/live-sessions/${session.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                version: next.version,
                sessionType: previousSession.sessionType,
                languages: previousSession.languages,
                outputMode: previousSession.outputMode,
                voiceProvider: GEMINI_VOICE_PROVIDER,
                maxViewers: previousSession.maxViewers,
                glossaryPack: previousSession.glossaryPack,
              }),
            }));
            await audioClientRef.current.update({
              version: restoredSession.version,
              sessionType: previousSession.sessionType,
              languages: previousSession.languages,
              outputMode: previousSession.outputMode,
              voiceProvider: GEMINI_VOICE_PROVIDER,
              maxViewers: previousSession.maxViewers,
              glossaryPack: previousSession.glossaryPack,
            });
            setSession(restoredSession);
            setSessionType(previousSession.sessionType);
            setOutputMode(previousSession.outputMode);
            setMaxViewers(previousSession.maxViewers);
            setGlossaryPack(previousSession.glossaryPack);
            setLanguages([...previousSession.languages]);
            setLanguageStatuses(previousStatuses);
            throw new Error(`The new settings could not be prepared, so the previous settings were restored. ${gatewayError instanceof Error ? gatewayError.message : ""}`.trim());
          } catch (compensationError) {
            if (compensationError instanceof Error && compensationError.message.startsWith("The new settings could not be prepared")) throw compensationError;
            await stopBroadcast();
            didFailClosed = true;
            const failedSession = restoredSession ?? next;
            setSession(failedSession);
            setSessionType(failedSession.sessionType);
            setOutputMode(failedSession.outputMode);
            setMaxViewers(failedSession.maxViewers);
            setGlossaryPack(failedSession.glossaryPack);
            setLanguages([...failedSession.languages]);
            setLanguageStatuses(languageStatusMap(failedSession.languages, "unavailable"));
            throw new Error("Settings could not be restored, so broadcasting stopped. Check the session and start again.");
          }
        }
      }
      setSession(next);
      setSessionType(next.sessionType);
      setOutputMode(next.outputMode);
      setMaxViewers(next.maxViewers);
      setGlossaryPack(next.glossaryPack);
      setIsEditingSession(false);
      if (!isBroadcasting) setLanguageStatuses(languageStatusMap(next.languages, "preparing"));
    } catch (requestError) {
      if (!didFailClosed) setLanguageStatuses(previousStatuses);
      setError(requestError instanceof Error ? requestError.message : "Unable to update settings.");
    } finally {
      setIsBusy(false);
    }
  }, [glossaryPack, isBroadcasting, languageStatuses, languages, maxViewers, outputMode, session, sessionType, stopBroadcast]);

  const openAdmission = useCallback(async () => {
    if (!session) return;
    setIsBusy(true);
    setError("");
    try {
      const result = await readResponse<{ code: string; admissionOpenUntil: string; version: number }>(
        await fetch(`/api/live-sessions/${session.id}/admission`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "open", version: session.version }),
        }),
      );
      const openUntil = result.admissionOpenUntil;
      setAdmission({ code: result.code, openUntil });
      setSession((current) => current?.id === session.id
        ? { ...current, admissionOpenUntil: openUntil, version: result.version }
        : current);
      setInvite(null);
      setInviteFeedback("");
      try {
        const inviteResult = await readResponse<InviteResult>(
          await fetch(`/api/live-sessions/${session.id}/invites`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "create" }),
          }),
        );
        setInvite({
          url: `${window.location.origin}/m/watch#invite=${encodeURIComponent(inviteResult.inviteToken)}`,
          admissionCode: inviteResult.admissionCode,
          expiresAt: inviteResult.expiresAt,
        });
        setSession((current) => current?.id === session.id
          ? { ...current, version: inviteResult.version, admissionOpenUntil: inviteResult.expiresAt }
          : current);
      } catch (inviteError) {
        setInvite(null);
        setError("The guest window opened, but its QR invite could not be created.");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to open guest entry.");
    } finally {
      setIsBusy(false);
    }
  }, [session]);

  const closeAdmission = useCallback(async () => {
    if (!session) return;
    setIsBusy(true);
    setError("");
    try {
      const result = await readResponse<{ sessionId: string; admissionOpenUntil: null; version: number }>(
        await fetch(`/api/live-sessions/${session.id}/admission`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "close", version: session.version }),
        }),
      );
      setAdmission(null);
      setInvite(null);
      setSession((current) => current?.id === session.id
        ? { ...current, admissionOpenUntil: null, version: result.version }
        : current);
      setInviteFeedback("Guest entry is closed. The live session is still running.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to close guest entry.");
    } finally {
      setIsBusy(false);
    }
  }, [session]);

  const copyInviteLink = useCallback(async () => {
    if (!invite) return;
    setInviteFeedback("");
    try {
      if (!navigator.clipboard) throw new Error("This browser does not support secure link copying.");
      await navigator.clipboard.writeText(invite.url);
      setInviteFeedback("Invite link copied.");
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "Unable to copy the invite link.");
    }
  }, [invite]);

  const retryInvite = useCallback(async () => {
    if (!session) return;
    setIsBusy(true);
    setError("");
    try {
      const inviteResult = await readResponse<InviteResult>(
        await fetch(`/api/live-sessions/${session.id}/invites`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "create" }),
        }),
      );
      setInvite({
        url: `${window.location.origin}/m/watch#invite=${encodeURIComponent(inviteResult.inviteToken)}`,
        admissionCode: inviteResult.admissionCode,
        expiresAt: inviteResult.expiresAt,
      });
      setAdmission({ code: inviteResult.admissionCode, openUntil: inviteResult.expiresAt });
      setSession((current) => current?.id === session.id
        ? { ...current, version: inviteResult.version, admissionOpenUntil: inviteResult.expiresAt }
        : current);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create the guest QR.");
    } finally {
      setIsBusy(false);
    }
  }, [session]);

  const inviteMailto = useMemo(() => {
    if (!invite) return "";
    const subject = encodeURIComponent("NOVA Live invitation");
    const body = encodeURIComponent(`Join the Live session with this link:\n\n${invite.url}\n\nInvite expires: ${formatTime(invite.expiresAt)}`);
    return `mailto:?subject=${subject}&body=${body}`;
  }, [invite]);

  /** Attaches the host audio client to the gateway for an already-live session. */
  const connectBroadcast = useCallback(async (activeSession: LiveSession) => {
    const credentials = await requestGatewayCredentials(activeSession.id);
    setLanguageStatuses(languageStatusMap(languages, "preparing"));
    const client = await startLiveAudioClient({
      sessionId: activeSession.id,
      version: activeSession.version,
      sessionType,
      languages,
      outputMode,
      voiceProvider: GEMINI_VOICE_PROVIDER,
      maxViewers,
      glossaryPack,
      inputSource,
      credentials,
      refreshCredentials: () => requestGatewayCredentials(activeSession.id),
      onStatus: setGatewayStatus,
      onError: setError,
      onSpeakers: setSpeakers,
      onLanguageStatus: (language, status) => {
        setLanguageStatuses((current) => ({ ...current, [language]: status }));
      },
    });
    audioClientRef.current = client;
    setIsBroadcasting(true);
  }, [glossaryPack, inputSource, languages, maxViewers, outputMode, sessionType]);

  const startBroadcast = useCallback(async () => {
    if (!session || isBroadcasting) return;
    setIsBusy(true);
    setError("");
    try {
      const startedSession = session.status === "live"
        ? session
        : await readResponse<LiveSession>(await fetch(`/api/live-sessions/${session.id}/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: session.version }),
        }));
      setSession(startedSession);
      await connectBroadcast(startedSession);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to start the live broadcast.");
    } finally {
      setIsBusy(false);
    }
  }, [connectBroadcast, isBroadcasting, session]);

  /** Stage fast path: the dashboard is where Start/Pause/End happen, so it
   *  pushes every status change to the same-origin stage window over a
   *  BroadcastChannel. The stage keeps its 5s REST poll as the fallback. */
  useEffect(() => {
    if (!session || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("realtime-noel-stage");
    channel.postMessage({ type: "session-status", sessionId: session.id, status: session.status, coverImageVersion: session.coverImageVersion ?? null });
    return () => channel.close();
  }, [session]);

  /** Contract C10: optional stage/waiting-room cover image. A failed upload
   *  never blocks the session — the stage simply stays plain black. */
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const [coverFeedback, setCoverFeedback] = useState("");
  const uploadCoverImage = useCallback(async (file: File) => {
    if (!session) return;
    setCoverFeedback("Uploading cover…");
    try {
      const result = await readResponse<{ hasCoverImage: boolean; coverImageVersion: string }>(await fetch(`/api/live-sessions/${session.id}/cover`, {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      }));
      if (result.hasCoverImage) {
        setSession((current) => current ? { ...current, hasCoverImage: true, coverImageVersion: result.coverImageVersion } : current);
      }
      setCoverFeedback("Cover image is live on the stage and waiting room.");
    } catch (requestError) {
      setCoverFeedback(requestError instanceof Error ? requestError.message : "Unable to upload the cover image.");
    }
  }, [session]);

  /** Contract C4: pause is a real session state — the server transitions
   *  live → paused and viewers see it; the local audio client also stops. */
  const pauseSession = useCallback(async () => {
    if (!session) return;
    setIsBusy(true);
    setError("");
    try {
      await stopBroadcast();
      const paused = await readResponse<LiveSession>(await fetch(`/api/live-sessions/${session.id}/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: session.version }),
      }));
      setSession(paused);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to pause the live session.");
    } finally {
      setIsBusy(false);
    }
  }, [session, stopBroadcast]);

  const resumeSession = useCallback(async () => {
    if (!session) return;
    setIsBusy(true);
    setError("");
    try {
      const resumed = await readResponse<LiveSession>(await fetch(`/api/live-sessions/${session.id}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: session.version }),
      }));
      setSession(resumed);
      await connectBroadcast(resumed);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to resume the live session.");
    } finally {
      setIsBusy(false);
    }
  }, [connectBroadcast, session]);

  /** Host session recovery: rehydrate the dashboard from an existing active
   *  session instead of forcing a new one. */
  const recoverSession = useCallback(async (recoverableId: string) => {
    setIsBusy(true);
    setError("");
    try {
      const existing = await readResponse<LiveSession>(await fetch(`/api/live-sessions/${recoverableId}`, {
        method: "GET",
        cache: "no-store",
      }));
      setSession(existing);
      setTitle(existing.title);
      setSessionType(existing.sessionType);
      setOutputMode(existing.outputMode);
      setMaxViewers(existing.maxViewers);
      setGlossaryPack(existing.glossaryPack);
      setLanguages([...existing.languages]);
      setIsEditingSession(false);
      setLanguageStatuses(languageStatusMap(existing.languages, "preparing"));
      setRecoverableSessions([]);
      setIsRecoveryDismissed(true);
      // Recreate the invite/QR: the admission code is deterministic per
      // session, so the 6-digit code shown to guests does not change.
      const inviteResult = await readResponse<InviteResult>(
        await fetch(`/api/live-sessions/${existing.id}/invites`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "create" }),
        }),
      );
      setInvite({
        url: `${window.location.origin}/m/watch#invite=${encodeURIComponent(inviteResult.inviteToken)}`,
        admissionCode: inviteResult.admissionCode,
        expiresAt: inviteResult.expiresAt,
      });
      setAdmission({ code: inviteResult.admissionCode, openUntil: inviteResult.expiresAt });
      setSession((current) => current?.id === existing.id
        ? { ...current, version: inviteResult.version, admissionOpenUntil: inviteResult.expiresAt }
        : current);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to resume the session.");
    } finally {
      setIsBusy(false);
    }
  }, []);

  /** Contract C8: opens the stage/countdown view in its own named window so
   *  Electron can intercept it and send it to the external display. */
  const openStageWindow = useCallback(() => {
    if (!session) return;
    const hash = invite
      ? `#invite=${encodeURIComponent(invite.url)}&code=${encodeURIComponent(invite.admissionCode)}`
      : "";
    window.open(`/stage/${session.id}${hash}`, "realtime-noel-stage");
  }, [invite, session]);

  const stopSession = useCallback(async () => {
    if (!session) return;
    setIsBusy(true);
    setError("");
    try {
      await stopBroadcast();
      await readResponse<unknown>(await fetch(`/api/live-sessions/${session.id}`, { method: "DELETE" }));
      setIsEndConfirmVisible(false);
      setEndedSession({ id: session.id, languages: [...session.languages] });
      setHostSummary(null);
      setHostSummaryError("");
      setHostSummaryFailureCode("");
      setHostSummaryPollingState("polling");
      setHostSummaryPollingStartedAt(Date.now());
      setSession(null);
      setAdmission(null);
      setInvite(null);
      setSpeakers([]);
      setParticipants([]);
      setRecentSpeeches([]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to end the live session.");
    } finally {
      setIsBusy(false);
    }
  }, [session, stopBroadcast]);

  const loadHostSummary = useCallback(async (): Promise<boolean> => {
    const language = endedSession?.languages[0];
    if (!endedSession || !language) return false;
    try {
      const response = await fetch(
        `/api/live-sessions/${endedSession.id}/summary?language=${encodeURIComponent(language)}`,
        { method: "GET", cache: "no-store" },
      );
      const payload = await response.json() as ApiResponse<{ summary: MeetingSummary; createdAt: string }>;
      if (payload.ok) {
        setHostSummary(payload.data);
        setHostSummaryError("");
        setHostSummaryFailureCode("");
        setHostSummaryPollingState("idle");
        return false;
      }
      if (payload.code === "SUMMARY_NOT_READY" || payload.code === "SUMMARY_GENERATION_RUNNING") {
        setHostSummaryFailureCode("");
        setHostSummaryPollingState("polling");
        return true;
      }
      setHostSummaryError(payload.error || "Unable to load the AI summary. Try again.");
      setHostSummaryFailureCode(payload.code ?? "");
      setHostSummaryPollingState(payload.code === "SUMMARY_GENERATION_EXHAUSTED" ? "exhausted" : "failed");
      return false;
    } catch {
      setHostSummaryError("Unable to load the AI summary. Check your connection and retry.");
      setHostSummaryFailureCode("");
      setHostSummaryPollingState("failed");
      return false;
    }
  }, [endedSession]);

  const retryHostSummary = useCallback(async () => {
    const language = endedSession?.languages[0];
    if (hostSummaryRetryRef.current || !endedSession || !language
      || hostSummaryFailureCode !== "SUMMARY_GENERATION_RETRYABLE_FAILED") return;
    hostSummaryRetryRef.current = true;
    setIsHostSummaryRetrying(true);
    setHostSummaryError("");
    try {
      const response = await fetch(`/api/live-sessions/${endedSession.id}/summary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language }),
      });
      const payload = await response.json() as ApiResponse<unknown>;
      if (!payload.ok) {
        setHostSummaryFailureCode(payload.code ?? "");
        setHostSummaryPollingState(payload.code === "SUMMARY_GENERATION_EXHAUSTED" ? "exhausted" : "failed");
        setHostSummaryError(payload.error || "Unable to retry the AI summary. Check your connection and retry.");
        return;
      }
      setHostSummaryFailureCode("");
      setHostSummaryPollingState("polling");
      setHostSummaryPollingStartedAt(Date.now());
      setHostSummaryPollingRound((round) => round + 1);
    } catch (requestError) {
      setHostSummaryFailureCode("");
      setHostSummaryPollingState("failed");
      setHostSummaryError(requestError instanceof Error
        ? requestError.message
        : "Unable to retry the AI summary. Check your connection and retry.");
    } finally {
      hostSummaryRetryRef.current = false;
      setIsHostSummaryRetrying(false);
    }
  }, [endedSession, hostSummaryFailureCode]);

  useEffect(() => {
    if (!endedSession || hostSummary) return;
    let isDisposed = false;
    let stopPolling = () => {};
    setHostSummaryPollingState("polling");
    setHostSummaryPollingStartedAt((startedAt) => startedAt ?? Date.now());
    void loadHostSummary().then((shouldContinue) => {
      if (isDisposed || !shouldContinue) return;
      stopPolling = startSummaryPollLoop({
        poll: loadHostSummary,
        onExhausted: () => {
          setHostSummaryPollingState("exhausted");
          setHostSummaryFailureCode("SUMMARY_GENERATION_EXHAUSTED");
          setHostSummaryError("");
        },
        onError: () => {
          setHostSummaryPollingState("failed");
          setHostSummaryFailureCode("");
          setHostSummaryError("Unable to load the AI summary. Check your connection and retry.");
        },
      });
    });
    return () => {
      isDisposed = true;
      stopPolling();
    };
  }, [endedSession, hostSummary, hostSummaryPollingRound, loadHostSummary]);

  useEffect(() => {
    if (hostSummaryPollingState !== "polling") return;
    setHostSummaryClockMilliseconds(Date.now());
    const ticker = window.setInterval(() => setHostSummaryClockMilliseconds(Date.now()), 1_000);
    return () => window.clearInterval(ticker);
  }, [hostSummaryPollingState]);

  // Host session recovery: on mount, look for active sessions this host
  // still owns (e.g. after a page refresh) and offer to resume them.
  useEffect(() => {
    if (!LIVE_CALL_ENABLED) return;
    let isDisposed = false;
    void (async () => {
      try {
        const result = await readResponse<{ sessions: RecoverableSession[] }>(
          await fetch("/api/live-sessions?scope=mine", { method: "GET", cache: "no-store" }),
        );
        if (!isDisposed && result.sessions.length > 0) setRecoverableSessions(result.sessions);
      } catch {
        // Recovery is a convenience — failures never block creating a session.
      }
    })();
    return () => { isDisposed = true; };
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setSessionSyncStatus("Waiting to sync");
      return;
    }
    let isDisposed = false;
    let isRequestPending = false;
    let requestController: AbortController | null = null;

    const refreshSessionState = async () => {
      if (isDisposed || isRequestPending) return;
      isRequestPending = true;
      const controller = new AbortController();
      requestController = controller;
      try {
        const [latest, activity] = await Promise.all([
          readResponse<LiveSession>(await fetch(`/api/live-sessions/${sessionId}`, {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
          })),
          readResponse<ParticipantActivity>(await fetch(`/api/live-sessions/${sessionId}/participants`, {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
          })),
        ]);
        if (isDisposed) return;
        setSession((current) => current?.id === sessionId
          ? { ...current, viewerCount: latest.viewerCount, status: latest.status }
          : current);
        setParticipants(activity.participants);
        setRecentSpeeches(activity.recentSpeeches);
        setSessionSyncStatus("Synced automatically");
      } catch (requestError) {
        if (!isDisposed && (!(requestError instanceof DOMException) || requestError.name !== "AbortError")) {
          setSessionSyncStatus("Sync delayed");
        }
      } finally {
        isRequestPending = false;
      }
    };

    void refreshSessionState();
    const timer = window.setInterval(() => { void refreshSessionState(); }, 5_000);
    return () => {
      isDisposed = true;
      window.clearInterval(timer);
      requestController?.abort();
    };
  }, [sessionId]);

  useEffect(() => () => { void audioClientRef.current?.stop(); }, []);

  const isConfiguring = !session || isEditingSession;
  const selectedOutputLabel = OUTPUT_OPTIONS.find((option) => option.value === outputMode)?.title ?? outputMode;
  const deliveryMethod = getDeliveryMethod(sessionType, outputMode);
  const selectedGlossaryLabel = GLOSSARY_PACK_OPTIONS.find((option) => option.value === glossaryPack)?.title ?? glossaryPack;

  if (!LIVE_CALL_ENABLED) {
    return (
      <main className="live-host-shell">
        <div className="live-host-workspace">
          <section className="glass live-panel" aria-label="Live Call disabled">
            <h1>Live Call is disabled</h1>
            <p>The Live Call feature is turned off for this deployment. Base caption functionality is unaffected.</p>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="live-host-shell">
      <aside className="live-host-rail">
        <strong>NOVA</strong>
        <nav aria-label="Host workspace">
          <button type="button" className="is-current" aria-current="page">Live</button>
          <button type="button" disabled>Transcripts</button>
          <button type="button" disabled>Settings</button>
        </nav>
      </aside>
      <div className="live-host-workspace">
        <header className="live-host-page-heading">
          <div>
            <h1>{session ? session.title : "Create Live Session"}</h1>
            {session?.scheduledAt && <p>{new Date(session.scheduledAt).toLocaleString("en-US", {
              month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
            })}</p>}
          </div>
          <div className="live-host-status" aria-live="polite">
            <span className={`live-status-dot ${isBroadcasting ? "is-live" : ""}`} aria-hidden="true" />
            <span>{session ? `${session.viewerCount} joined · ${formatSessionStatus(session.status)}` : "Not started"}</span>
          </div>
        </header>

      {error && <div className="live-error" role="alert">{error}</div>}

      {!session && !isRecoveryDismissed && recoverableSessions.length > 0 && (
        <section className="glass live-panel live-recovery-panel" aria-labelledby="recovery-heading">
          <div className="live-section-heading">
            <div><span>RESUME</span><h2 id="recovery-heading">Active session found</h2></div>
            <button type="button" className="glass-btn" onClick={() => setIsRecoveryDismissed(true)}>Dismiss</button>
          </div>
          <p className="live-help">You still have an active live session. Resume it to keep the same invite code and participants.</p>
          <ul className="live-recovery-list">
            {recoverableSessions.map((recoverable) => (
              <li key={recoverable.id}>
                <div>
                  <strong>{recoverable.title}</strong>
                  <small>{formatSessionStatus(recoverable.status)} · {recoverable.viewerCount} joined
                    {recoverable.scheduledAt ? ` · ${new Date(recoverable.scheduledAt).toLocaleString("en")}` : ""}</small>
                </div>
                <button type="button" className="accent-btn" disabled={isBusy}
                  onClick={() => void recoverSession(recoverable.id)}>
                  Resume session
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {endedSession && !session && (
        <section className="glass live-summary-panel" aria-labelledby="summary-heading">
          <div className="live-section-heading">
            <div><span>RECAP</span><h2 id="summary-heading">Meeting summary</h2></div>
          </div>
          {hostSummary
            ? <MeetingSummaryCard summary={hostSummary.summary} createdAt={hostSummary.createdAt} />
            : (
              <div className="live-minutes-pending" aria-busy={hostSummaryPollingState === "polling"}>
                {hostSummaryPollingState === "polling" ? (
                  <div className="live-minutes-loading" role="status" aria-live="polite">
                    <span className="live-minutes-loading-dots" aria-hidden="true"><i /><i /><i /></span>
                    <strong>Creating AI summary</strong>
                    <span className="live-minutes-elapsed">Elapsed {formatElapsedTime(hostSummaryPollingStartedAt === null
                      ? 0
                      : hostSummaryClockMilliseconds - hostSummaryPollingStartedAt)}</span>
                  </div>
                ) : (
                  <>
                    <p role={hostSummaryPollingState === "failed" ? "alert" : "status"}>
                      {hostSummaryError || "Summary is taking longer than expected."}
                    </p>
                    {hostSummaryFailureCode === "SUMMARY_GENERATION_RETRYABLE_FAILED" ? (
                      <button type="button" disabled={isHostSummaryRetrying}
                        onClick={() => void retryHostSummary()}>
                        {isHostSummaryRetrying ? "Retrying…" : "Retry"}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            )}
          <div className="live-summary-actions">
            <button type="button" onClick={() => {
              setEndedSession(null);
              setHostSummary(null);
              setHostSummaryError("");
              setHostSummaryFailureCode("");
              setHostSummaryPollingState("idle");
              setHostSummaryPollingStartedAt(null);
            }}>
              Close
            </button>
          </div>
        </section>
      )}

      {isConfiguring && (
        <section className={`glass live-wizard ${wizardStep > 1 ? "is-advanced" : ""}`} aria-labelledby="wizard-heading">
          <div className="live-section-heading">
            <div><h2 id="wizard-heading">{wizardStep === 1 ? "Session details" : "Advanced settings"}</h2></div>
            {wizardStep > 1 && <small>{wizardStep}/4</small>}
          </div>
          <nav className="live-wizard-progress" aria-label="Live setup steps">
            {(["Details", "Output", "Audience", "Review"] as const).map((label, index) => {
              const step = (index + 1) as 1 | 2 | 3 | 4;
              return <button key={label} type="button" className={wizardStep === step ? "is-current" : ""}
                aria-current={wizardStep === step ? "step" : undefined} onClick={() => setWizardStep(step)}>
                <span>{step}</span>{label}
              </button>;
            })}
          </nav>
          <aside className="live-setup-mobile-access" aria-label="Mobile access preview">
            <h2>Mobile access</h2>
            {invite ? <InviteQrCode value={invite.url} /> : <div className="live-qr-placeholder" aria-hidden="true"><span>N</span></div>}
            <strong>{invite ? "QR ready for guests" : "QR appears after the session is created"}</strong>
            {invite && (
              <div className="live-access-code">
                <span>6-digit access code</span>
                <strong>{invite.admissionCode}</strong>
              </div>
            )}
            <p>Guests enter their name, department, and job title. The access code remains unchanged until this session ends.</p>
          </aside>

          {wizardStep === 1 && (
            <div className="live-wizard-body">
              <div className="live-schedule-grid">
                <label className="live-text-field live-title-field">
                  <span>Session title</span>
                  <input type="text" maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)}
                    placeholder="Q3 earnings call" autoComplete="off" required />
                </label>
                <label className="live-text-field">
                  <span>Date</span>
                  <input type="text" inputMode="numeric" pattern="\d{4}-\d{2}-\d{2}" placeholder="YYYY-MM-DD"
                    value={sessionDate} onChange={(event) => setSessionDate(event.target.value)}
                    aria-invalid={!session && Boolean(scheduleValidation.error)}
                    aria-describedby={!session && scheduleValidation.error ? "live-schedule-error" : undefined} required />
                </label>
                <label className="live-text-field">
                  <span>Start time</span>
                  <input type="text" inputMode="numeric" pattern="(?:[01]\d|2[0-3]):[0-5]\d" placeholder="HH:MM"
                    value={startTime} onChange={(event) => setStartTime(event.target.value)}
                    aria-invalid={!session && Boolean(scheduleValidation.error)}
                    aria-describedby={!session && scheduleValidation.error ? "live-schedule-error" : undefined} required />
                </label>
              </div>
              {!session && scheduleNow !== null && scheduleValidation.error && (
                <p id="live-schedule-error" className="live-error" role="alert">{scheduleValidation.error}</p>
              )}
              <div className="live-mode-grid live-mode-grid-two" role="radiogroup" aria-label="Session format">
                {SESSION_TYPE_OPTIONS.map((option) => (
                  <button key={option.value} type="button" role="radio" aria-checked={sessionType === option.value}
                    className={`live-mode-card ${sessionType === option.value ? "is-selected" : ""}`}
                    onClick={() => setSessionType(option.value)}>
                    <strong>{option.title}</strong><span>{option.description}</span>
                  </button>
                ))}
              </div>
              <div className="live-field-group">
                <strong>Audio source</strong>
                <div className="live-segmented" role="radiogroup" aria-label="Audio source">
                  {([['mic', 'Microphone'], ['system', 'System audio'], ['both', 'Both']] as Array<[LiveInputSource, string]>).map(([value, label]) => (
                    <button key={value} type="button" role="radio" aria-checked={inputSource === value}
                      className={inputSource === value ? "is-selected" : ""} onClick={() => setInputSource(value)} disabled={Boolean(session)}>
                      {label}
                    </button>
                  ))}
                </div>
                <p className="live-help">Microphone audio uses noise and echo control. System audio stays unmodified.</p>
              </div>
            </div>
          )}

          {wizardStep === 2 && (
            <div className="live-wizard-body">
              <div className="live-mode-grid" role="radiogroup" aria-label="Guest output">
                {OUTPUT_OPTIONS.map((option) => (
                  <button key={option.value} type="button" role="radio" aria-checked={outputMode === option.value}
                    className={`live-mode-card ${outputMode === option.value ? "is-selected" : ""}`}
                    onClick={() => setOutputMode(option.value)}>
                    <strong>{option.title}</strong><span>{option.description}</span>
                  </button>
                ))}
              </div>
              <section className="live-delivery-method-card" aria-labelledby="live-delivery-method-title" aria-describedby="live-delivery-method-description">
                <div>
                  <span>Current delivery</span>
                  <strong id="live-delivery-method-title">{deliveryMethod.title}</strong>
                  <small>{deliveryMethod.status}</small>
                </div>
                <p id="live-delivery-method-description">{deliveryMethod.description}</p>
              </section>
              <section className="live-delivery-method-card" aria-labelledby="live-caption-provider-title">
                <div>
                  <span>Caption engine</span>
                  <strong id="live-caption-provider-title">Gemini fixed</strong>
                  <small>All output modes</small>
                </div>
                <p>Gemini creates live translated captions and translated audio with the same session settings.</p>
              </section>
              {outputMode !== "captions" &&
                <p className="live-consent-note" role="note"><strong>Translated audio</strong> starts only after each guest chooses to play it.</p>
              }
            </div>
          )}

          {wizardStep === 3 && (
            <div className="live-wizard-body live-audience-settings">
              <div className="live-field-group">
                <label htmlFor="live-capacity">Maximum guests <output htmlFor="live-capacity">{maxViewers}</output></label>
                <input id="live-capacity" type="range" min={1} max={50} step={1} value={maxViewers}
                  onChange={(event) => setMaxViewers(Number(event.target.value))} />
                <small>Limit entry from 1 to 50 guests.</small>
              </div>
              <div className="live-field-group">
                <div className="live-field-label"><strong>Guest languages</strong><small>{languages.length}/3</small></div>
                <div className="live-language-grid">
                  {LANGUAGE_OPTIONS.map((language) => {
                    const isSelected = languages.includes(language.code);
                    return <button key={language.code} type="button" aria-pressed={isSelected}
                      disabled={!isSelected && languages.length >= 3} className={isSelected ? "is-selected" : ""}
                      onClick={() => toggleLanguage(language.code)}><span>{language.label}</span><small>{language.code.toUpperCase()}</small></button>;
                  })}
                </div>
                <p className="live-help">{SESSION_LANGUAGE_HELP[sessionType]}</p>
              </div>
              <div className="live-field-group">
                <div className="live-field-label">
                  <strong>Industry glossary</strong>
                  <small>{sessionType === "meeting" ? "Base phrases + selected pack" : "Available for Meeting"}</small>
                </div>
                <div className="live-glossary-grid" role="radiogroup" aria-label="Industry glossary" aria-describedby="live-glossary-help">
                  {GLOSSARY_PACK_OPTIONS.map((option) => <button key={option.value} type="button" role="radio"
                    aria-checked={glossaryPack === option.value} className={glossaryPack === option.value ? "is-selected" : ""}
                    disabled={sessionType === "presentation"}
                    onClick={() => setGlossaryPack(option.value)}><strong>{option.title}</strong><span>{option.description}</span></button>)}
                </div>
                <p id="live-glossary-help" className="live-help">{sessionType === "meeting"
                  ? "Apply base phrases and the selected industry glossary to speaker-aware meeting translations."
                  : "The presentation streaming model does not support glossary instructions. Choose Meeting to enable them."}</p>
              </div>
            </div>
          )}

          {wizardStep === 4 && (
            <div className="live-wizard-body">
              <dl className="live-review-list">
                <div><dt>Title</dt><dd>{title.trim()}</dd></div>
                <div><dt>Schedule</dt><dd>{sessionDate} · {startTime}</dd></div>
                <div><dt>Session</dt><dd>{sessionType === "presentation" ? "Presentation" : "Meeting"}</dd></div>
                <div><dt>Output</dt><dd>{selectedOutputLabel}</dd></div>
                <div><dt>Caption engine</dt><dd>Gemini fixed</dd></div>
                {outputMode !== "captions" && <div><dt>Audio engine</dt><dd>Gemini</dd></div>}
                <div><dt>Capacity</dt><dd>{maxViewers}</dd></div>
                <div><dt>Languages</dt><dd>{languages.map((language) => languageLabel.get(language) ?? language).join(" · ")}</dd></div>
                <div><dt>Glossary</dt><dd>{sessionType === "meeting" ? `Base phrases + ${selectedGlossaryLabel}` : "Not applied · Meeting only"}</dd></div>
              </dl>
              <div className="live-wizard-actions">
                {session && <button type="button" className="glass-btn" onClick={() => {
                  setSessionType(session.sessionType); setOutputMode(session.outputMode); setMaxViewers(session.maxViewers);
                  setGlossaryPack(session.glossaryPack); setLanguages([...session.languages]); setIsEditingSession(false);
                }}>Cancel</button>}
                <button type="button" className="accent-btn live-primary-action" disabled={isBusy || !title.trim() || (!session && !scheduledAt)}
                  onClick={() => void (session ? applySession() : createSession())}>
                  {isBusy ? "Creating…" : session ? "Apply changes" : "Create Live"}
                </button>
              </div>
            </div>
          )}

          <div className="live-wizard-footer">
            {wizardStep === 1 ? (
              <>
                <button type="button" className="glass-btn" onClick={() => setWizardStep(2)}>Advanced settings</button>
                <button type="button" className="accent-btn" disabled={isBusy || !title.trim() || (!session && !scheduledAt)}
                  onClick={() => void (session ? applySession() : createSession())}>
                  {isBusy ? "Creating…" : session ? "Apply changes" : "Create Session"}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="glass-btn" onClick={() => setWizardStep((wizardStep - 1) as 1 | 2 | 3 | 4)}>Back</button>
                {wizardStep < 4 && <button type="button" className="accent-btn"
                  onClick={() => setWizardStep((wizardStep + 1) as 1 | 2 | 3 | 4)}>Continue</button>}
              </>
            )}
          </div>
        </section>
      )}

      {session && (
        <section className="live-host-caption-stage" aria-labelledby="host-caption-heading">
          <div className="live-section-heading">
            <div><span>CAPTIONS</span><h2 id="host-caption-heading">Live captions</h2></div>
            <small>{isBroadcasting ? "Caption engine running" : "Caption input paused · Live Call remains connected"}</small>
          </div>
          <div className="live-host-caption-feed" aria-live="polite">
            {recentSpeeches.length === 0 ? (
              <p>Captions will appear here as speech is recognized.</p>
            ) : recentSpeeches.slice(-5).map((speech) => (
              <article key={`${speech.participantId}-${speech.seq}`}>
                <header>
                  <strong>{speech.displayName}</strong>
                  <span>{speech.department} · {speech.jobTitle}</span>
                  <time dateTime={speech.endedAt}>{formatTime(speech.endedAt)}</time>
                </header>
                <p>{speech.text}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {session && (
        <section className="glass live-panel live-session-panel" aria-labelledby="session-heading">
          <div className="live-section-heading">
            <div><span>LIVE</span><h2 id="session-heading">{title || "Host session"}</h2></div>
            <small aria-live="polite">{sessionSyncStatus}</small>
          </div>
          <>
              <dl className="live-session-facts">
                <div><dt>Scheduled</dt><dd>{session.scheduledAt ? new Date(session.scheduledAt).toLocaleString("en") : "Starts now"}</dd></div>
                <div><dt>Guests</dt><dd>{session.viewerCount} / {session.maxViewers}</dd></div>
                <div><dt>Status</dt><dd>{formatSessionStatus(session.status)}</dd></div>
                <div><dt>Format</dt><dd>{session.sessionType === "presentation" ? "Presentation" : "Meeting"}</dd></div>
                <div><dt>Output</dt><dd>{OUTPUT_OPTIONS.find((option) => option.value === session.outputMode)?.title ?? session.outputMode}</dd></div>
                <div><dt>Languages</dt><dd>{session.languages.map((language) => languageLabel.get(language) ?? language).join(" · ")}</dd></div>
                <div><dt>Guest access</dt><dd>Open until the session ends</dd></div>
                <div><dt>Session expires</dt><dd>{formatTime(session.expiresAt)}</dd></div>
              </dl>
              {invite && (
                <div className="live-admission-code" aria-live="polite">
                  <span>Guest QR</span>
                  <div className="live-invite-share">
                    <InviteQrCode value={invite.url} />
                    <div className="live-access-code">
                      <span>6-digit access code</span>
                      <strong>{invite.admissionCode}</strong>
                      <small>Valid until the host ends this session</small>
                    </div>
                    <div className="live-invite-actions">
                      <button type="button" className="live-invite-copy" onClick={() => void copyInviteLink()}
                        aria-label="Copy guest invite link">Copy link</button>
                      <a className="live-invite-mail" href={inviteMailto} aria-label="Write a Live invitation email">Invite by email</a>
                    </div>
                  </div>
                </div>
              )}
              <span className="live-invite-feedback" aria-live="polite">{inviteFeedback}</span>
              <div className="live-cover-upload">
                <div>
                  <strong>Stage cover image</strong>
                  <p>{session.hasCoverImage
                    ? "Shown behind the stage countdown and the guest waiting room."
                    : "Optional backdrop for the stage countdown and the guest waiting room. JPEG, PNG, or WebP up to 5MB."}</p>
                </div>
                <input ref={coverInputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void uploadCoverImage(file);
                  }} />
                <button type="button" className="glass-btn" disabled={isBusy}
                  onClick={() => coverInputRef.current?.click()}>
                  {session.hasCoverImage ? "Replace cover" : "Upload cover"}
                </button>
                <span className="live-invite-feedback" aria-live="polite">{coverFeedback}</span>
              </div>
              <div className="live-action-row">
                {!invite && <button type="button" className="accent-btn" disabled={isBusy} onClick={() => void retryInvite()}>Retry guest QR</button>}
                {isBroadcasting && <button type="button" className="glass-btn" disabled={isBusy}
                  title="Refresh the translation pipeline without ending the session"
                  onClick={() => void restartBroadcast()}>Restart caption engine</button>}
                {session.status === "paused" ? (
                  <button type="button" className="accent-btn" disabled={isBusy} onClick={() => void resumeSession()}>
                    Resume captions
                  </button>
                ) : session.status === "live" && isBroadcasting ? (
                  <button type="button" className="glass-btn" disabled={isBusy} onClick={() => void pauseSession()}>
                    Pause captions
                  </button>
                ) : (
                  <button type="button" className="accent-btn" disabled={isBusy} onClick={() => void startBroadcast()}>
                    {session.status === "live" ? "Reconnect captions" : "Start Live"}
                  </button>
                )}
                <button type="button" className="glass-btn" onClick={openStageWindow}
                  title="Open the stage/countdown view in a separate window">
                  Open stage view
                </button>
                <button type="button" className="glass-btn" disabled={isBusy || isEditingSession} onClick={() => { setWizardStep(1); setIsEditingSession(true); }}>Edit setup</button>
              </div>
              <div className="live-danger-zone" aria-label="Destructive session controls">
                <div>
                  <strong>End session</strong>
                  <p>Ends the live call for every participant and starts meeting-minutes generation. This cannot be undone.</p>
                </div>
                {!isEndConfirmVisible ? (
                  <button type="button" className="live-danger-button" disabled={isBusy}
                    onClick={() => setIsEndConfirmVisible(true)}>
                    End session…
                  </button>
                ) : (
                  <div className="live-danger-confirm" role="group" aria-label="Confirm ending the session">
                    <span>End this session for all participants?</span>
                    <button type="button" className="glass-btn" disabled={isBusy}
                      onClick={() => setIsEndConfirmVisible(false)}>
                      Cancel
                    </button>
                    <button type="button" className="live-danger-button" disabled={isBusy}
                      onClick={() => void stopSession()}>
                      Yes, end session
                    </button>
                  </div>
                )}
              </div>
            </>
        </section>
      )}

      {session && (
        <section className="live-participant-panel" aria-labelledby="participants-heading">
          <div className="live-section-heading">
            <div><span>ATTENDANCE</span><h2 id="participants-heading">Participants and speaking activity</h2></div>
            <small>{participants.filter((participant) => participant.isPresent).length} present · {participants.length} total</small>
          </div>
          <div className="live-participant-table-wrap">
            <table className="live-participant-table">
              <thead>
                <tr><th>Name</th><th>Department</th><th>Job title</th><th>Joined</th><th>Speaking activity</th><th>Status</th></tr>
              </thead>
              <tbody>
                {participants.length === 0 ? (
                  <tr><td colSpan={6}>Waiting for guests to join.</td></tr>
                ) : participants.map((participant) => (
                  <tr key={participant.participantId}>
                    <td>{participant.displayName}</td>
                    <td>{participant.department}</td>
                    <td>{participant.jobTitle}</td>
                    <td>{formatTime(participant.joinedAt)}</td>
                    <td>{participant.utteranceCount} turns · {Math.round(participant.speakingSeconds)} sec</td>
                    <td><span className={`live-presence ${participant.isPresent ? "is-present" : ""}`}>{participant.isPresent ? "Present" : "Left"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="glass live-panel live-monitor-panel" aria-labelledby="monitor-heading">
        <div className="live-section-heading">
          <div><span>MONITOR</span><h2 id="monitor-heading">Languages and speakers</h2></div>
          <small aria-live="polite">{isBroadcasting ? gatewayStatus : session ? "Ready to broadcast" : "Available after setup"}</small>
        </div>
        <div className="live-monitor-grid">
          <div className="live-language-statuses">
            {(session?.languages ?? languages).map((language) => (
              <div key={language}><span className={`live-status-dot ${isBroadcasting && languageStatuses[language] === "ready" ? "is-live" : ""}`} aria-hidden="true" />
                <strong>{languageLabel.get(language) ?? language}</strong><small>
                  {isBroadcasting ? LANGUAGE_STATUS_LABELS[languageStatuses[language] ?? "preparing"] : "Waiting"}
                </small></div>
            ))}
          </div>
          <div className="live-speaker-legend">
            {speakers.length === 0 ? <p>Stable speaker labels appear after Meeting identifies a speaker.</p> : speakers.map((speaker) => (
              <div key={speaker.speakerId}><span className="live-speaker-dot" style={{ backgroundColor: resolveSpeakerColor(speaker) }} aria-hidden="true" />
                <strong>{speaker.label}</strong>
                <span className="live-speaker-line" style={{ backgroundColor: resolveSpeakerColor(speaker) }} aria-hidden="true" />
                <small>Audio · {getSpeakerVoiceStatus(speaker, outputMode)}</small>
              </div>
            ))}
          </div>
        </div>
      </section>
      <p className="live-privacy-note">Original audio and voice characteristics are not stored. Only the latest final caption snapshot is retained temporarily for reconnection.</p>
      </div>
    </main>
  );
}
