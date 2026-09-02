"use client";

import { useSystemText, useSystemLanguage } from "@/components/system-language/SystemLanguageProvider";
import { formatViewerSystemStatus, viewerMessages } from "@/lib/system-language/viewer-messages";
import { formatSystemText, SYSTEM_LOCALES, type SystemLanguage } from "@/lib/system-language";


import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { RecordingGap } from "@/lib/live-recap/contract";
import { Stop } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";

import { ParticipantSpeakButton } from "./ParticipantSpeakButton";
import { LANGUAGE_LABELS } from "@/lib/languageDetect";
import type {
  CaptionEvent,
  LiveBroadcastEvent,
  LiveFloorHolder,
  LiveOutputMode,
  LiveSession,
  LiveSessionStatus,
  LiveSessionType,
  LiveSnapshot,
  LiveTopicPublicMetadata,
  SpeakerAssignment,
} from "@/lib/live-contract";
import {
  getReconnectDelayMilliseconds,
  getReconnectStatus,
  waitForSocketOpen,
  withAbortTimeout,
} from "./connection-resilience";
import type { MeetingSummary } from "@/lib/live/summary";
import { type TranscriptEntry } from "./MeetingMinutes";
import { ParticipantMeetingMinutes } from "./ParticipantMeetingMinutes";
import { ViewerReadingFeed } from "./ViewerReadingFeed";
import { createViewerSourceDraftState, reduceViewerSourceDraft, loadViewerSourceSnapshot, mergeViewerSourceLedger, presentViewerSourceEvent } from "./viewer-source-ledger";
import type { SourceEvent } from "../../lib/live/source-contract";
import { loadViewerSourceRecord } from "./viewer-source-record";
import { isRecordsAccessExpired, parseViewerRecordsSession } from "./viewer-records-recovery";
import { formatMinuteTime } from "./meeting-minutes-model";
import { startSummaryPollLoop, type SummaryPollingState } from "./meeting-summary-polling";
import {
  getCachedLanguageCaptions,
  isDisplayableCaption,
  LanguageSnapshotRegistry,
  loadLanguageSnapshotOnce,
  mergeLanguageCaptionCache,
} from "@/lib/live/caption-feed";
import { countdownMsUntil, formatCountdown } from "@/lib/live/countdown";
import {
  requestForegroundRecovery,
  type ForegroundRecoveryEvent,
  type ForegroundRecoveryState,
} from "./foreground-recovery";
import { buildViewerSurfaceUrl, getViewerSurfaceRedirect } from "./viewer-surface-routing";
import { parseAdmissionLinkHash } from "./admission-link";
import { applyLiveTopicUpsert, createLiveTopicState, mergeLiveTopicSnapshot, type LiveTopicState } from "@/lib/live/topic-state";
import {
  clearViewerRecoveryContext,
  readViewerRecoveryContext,
  resolveViewerRecoverySelection,
  writeViewerRecoveryContext,
} from "./viewer-session-recovery";
import {
  CaptionEntry,
  ControlDrawer,
  TranslationToolbar,
  TranslationViewport,
  buildTranslationLanes,
  projectCaptionLane,
  type CaptionLaneInput,
  type TranslationLanePresentation,
} from "./translation";
import { resolveViewerSpeakerColor } from "./SpeakerCaption";
import { ViewerLiveSurface } from "./quality/ViewerLiveSurface";
import { type EarningsEventPresentation } from "./earnings";
import {
  ApiRequestError,
  getJoinErrorMessage,
  isRecord,
  isRecordingStatus,
  isViewerJoinData,
  mergeViewerSnapshot,
  normalizeEmail,
  normalizeProfileField,
  parseBroadcastEvent,
  readApi,
  settleRequest,
  type ViewerJoinData,
  type ViewerState,
} from "./viewer-controller-contract";
import { useViewerRecovery } from "./useViewerRecovery";
import { getSafeSummaryErrorMessage, getSafeTranscriptErrorMessage, isSummaryEmptyCode } from "./useHostSummaryLifecycle";
import {
  connectViewerGatewayOnce,
  createViewerGatewayConnectionGate,
  isCurrentViewerGatewayRequest,
  isViewerGatewayTicketData,
  resetViewerGatewayConnectionGate,
  resolveViewerGatewayStatusDecision,
  shouldConnectViewerGateway,
  type ViewerGatewayStatusDecision,
  type ViewerGatewayTicketData,
} from "./viewer-gateway-lifecycle";
import { GatewayConnectionStatus } from "./status";
import { ParticipantConsentFields, PARTICIPANT_CONSENT_NOTICES } from "./consent";
import { transitionGatewayConnectionState } from "@/lib/live/gateway-connection-state";
import {
  prepareSpeakCapture,
  SpeakCaptureError,
  type PreparedSpeakCapture,
  type SpeakSession,
} from "./speak-client";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const LIVE_GATEWAY_URL = process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL ?? "";
const DEVICE_STORAGE_KEY = "rnw-live-viewer-device-v1";
const LEGACY_VIEWER_AUTH_STORAGE_KEY = "rnw-live-viewer-auth-v1";
/** Caption text-size range, as a multiplier on the base caption size. 1 is the
 *  designed default; the ceiling keeps roughly two lines of Korean readable on a
 *  375px viewport rather than allowing an unusable zoom. */
const CAPTION_SCALE_MIN = 1;
const CAPTION_SCALE_MAX = 2;

function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code;
}

class ViewerGatewayWaitingError extends Error {}

async function requestViewerGatewayTicket(sessionId: string): Promise<ViewerGatewayTicketData> {
  const result = await readApi<unknown>(await fetch(
    `/api/live-sessions/${sessionId}/viewer-gateway-ticket`,
    { method: "POST" },
  ));
  if (isRecord(result) && result.status === "HOST_WAITING") throw new ViewerGatewayWaitingError("호스트 연결을 기다리고 있어요.");
  if (!isViewerGatewayTicketData(result)) throw new Error("The live gateway ticket response is invalid.");
  return result;
}

function isSpeakFlowIdle(readState: () => string): boolean {
  return readState() === "idle";
}

function makeDeviceId(): string {
  const current = localStorage.getItem(DEVICE_STORAGE_KEY);
  if (current) return current;
  const next = crypto.randomUUID();
  localStorage.setItem(DEVICE_STORAGE_KEY, next);
  return next;
}

function captionConnectionLabel(status: LiveSessionStatus | "ready"): string {
  if (status === "live" || status === "ready") return "실시간";
  if (status === "preparing") return "자막 준비 중";
  if (status === "paused") return "호스트가 일시 정지함";
  if (status === "stopped") return "라이브 종료";
  return "연결 확인 필요";
}

function isRecordingStatusEvent(value: unknown): boolean {
  return isRecordingStatus(value);
}

export function formatProfileMetadata(...parts: Array<string | null | undefined>): string {
  return parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part)).join(" · ");
}

export function ViewerStage({ captions, status, sessionStatus = "live" }: {
  captions: CaptionEvent[];
  status: string;
  sessionStatus?: LiveSessionStatus;
}) {
  const t = useSystemText(viewerMessages);
  const displayCaptions = useMemo(() => captions.filter(isDisplayableCaption), [captions]);
  const latestFinal = displayCaptions.findLast((caption) => caption.isFinal);
  const lifecycleLabel = sessionStatus === "live"
    ? "실시간"
    : sessionStatus === "paused" ? "호스트가 일시 정지함" : "라이브를 사용할 수 없음";
  return (
    <div className="live-viewer-stage">
      <div className="live-viewer-stage-header">
        <span className="live-eyebrow">{t("실시간 번역")}</span>
        <span className="live-connection-state" role="status" aria-live="polite">
          <span className={`live-status-dot ${sessionStatus === "live" ? "is-live" : ""}`} aria-hidden="true" />
          {t(lifecycleLabel)}
          <span className="sr-only"> {t("· 연결 상태:")} {formatViewerSystemStatus(status, t)}</span>
        </span>
      </div>
      <TranslationViewport
        state={sessionStatus === "paused" ? "paused" : sessionStatus === "live" ? "live" : "disconnected"}
        statusLabel={sessionStatus === "live" ? undefined : t(lifecycleLabel)}
        captionFirstPreview={displayCaptions.at(-1)?.text ?? ""}
        previewLabel={t("현재 자막")}
        finalAnnouncement={latestFinal?.text}
        listLabel={t("실시간 번역 자막 목록")}
      >
        {displayCaptions.map((caption, index) => (
          <CaptionEntry
            key={`${caption.language}-${caption.seq}`}
            text={caption.text}
            speakerLabel={caption.speaker?.name?.trim() || caption.speaker?.label?.trim() || t("호스트")}
            timestamp={new Date(caption.emittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            isFinal={caption.isFinal}
            translationStatus={caption.translationStatus}
            sourceText={caption.sourceText}
            isActive={index === displayCaptions.length - 1}
          />
        ))}
      </TranslationViewport>
    </div>
  );
}

export function formatSessionSchedule(scheduledAt: string | null, systemLanguage: SystemLanguage = "ko"): string {
  if (!scheduledAt) return formatSystemText(viewerMessages, systemLanguage, "지금 시작");
  const timestamp = Date.parse(scheduledAt);
  if (!Number.isFinite(timestamp)) return formatSystemText(viewerMessages, systemLanguage, "지금 시작");
  // 2026-07-24 fix: Use the product's fixed KST session clock. Locale formatters
  // emit engine-specific punctuation and previously broke WebKit hydration.
  const date = new Date(timestamp + 9 * 60 * 60 * 1_000);
  const hours = date.getUTCHours();
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const clock = `${String(hours).padStart(2, "0")}:${minutes}`;
  if (systemLanguage === "en") return `${date.getUTCMonth() + 1}/${date.getUTCDate()} · ${clock} KST`;
  if (systemLanguage === "ja") return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 · ${clock}`;
  return `${date.getUTCMonth() + 1}월 ${date.getUTCDate()}일 · ${clock}`;
}

export function ViewerSessionContext({ title, scheduledAt }: { title: string; scheduledAt: string | null }) {
  const t = useSystemText(viewerMessages);
  const { language: systemLanguage } = useSystemLanguage();
  return (
    <section className="live-viewer-session-context" aria-label={t("세션 정보")}>
      <h1>{title}</h1>
      <p>{formatSessionSchedule(scheduledAt, systemLanguage)}</p>
    </section>
  );
}

function captionLaneInput(caption: CaptionEvent, index: number, total: number): CaptionLaneInput {
  return {
    id: caption.utteranceKey ?? `${caption.language}:${caption.seq}`,
    utteranceKey: caption.utteranceKey,
    language: caption.language,
    sourceLanguage: caption.sourceLanguage,
    languageObservation: caption.languageObservation,
    origin: caption.origin,
    text: caption.text,
    speakerLabel: caption.speaker?.name?.trim() || caption.speaker?.label?.trim() || "",
    // 5B: the contract already ships a per-speaker colorToken; the viewer used
    // to drop it. Name text carries identity, color only reinforces it.
    speakerColor: resolveViewerSpeakerColor(caption.speaker),
    timestamp: formatMinuteTime(caption.emittedAt),
    isFinal: caption.isFinal,
    translationStatus: caption.translationStatus,
    sourceText: caption.sourceText,
    isActive: index === total - 1,
  };
}

function VoiceLevelCanvas({ level, compact = false }: { level: number; compact?: boolean }) {
  const t = useSystemText(viewerMessages);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const displayedLevelRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = compact ? 52 : 296;
    const height = compact ? 24 : 96;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * pixelRatio;
    canvas.height = height * pixelRatio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const style = getComputedStyle(canvas);
    const activeColor = style.getPropertyValue("--nova-system-default").trim();
    const restingColor = style.getPropertyValue("--nova-fg-primary").trim();
    const isReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    displayedLevelRef.current = isReducedMotion
      ? level
      : displayedLevelRef.current * 0.68 + level * 0.32;
    const energy = Math.max(0.06, Math.min(1, displayedLevelRef.current * 4.2));
    const barCount = compact ? 7 : 25;
    const gap = compact ? 3 : 5;
    const barWidth = compact ? 3 : 6;
    const totalWidth = barCount * barWidth + (barCount - 1) * gap;
    const startX = (width - totalWidth) / 2;
    context.clearRect(0, 0, width, height);
    for (let index = 0; index < barCount; index += 1) {
      const distance = Math.abs(index - (barCount - 1) / 2) / (barCount / 2);
      const envelope = 1 - distance * 0.56;
      const cadence = 0.56 + ((index * 7) % 11) / 20;
      const barHeight = Math.max(3, height * energy * envelope * cadence);
      const x = startX + index * (barWidth + gap);
      const y = (height - barHeight) / 2;
      context.fillStyle = index % 4 === 0 ? activeColor : restingColor;
      context.beginPath();
      context.roundRect(x, y, barWidth, barHeight, barWidth / 2);
      context.fill();
    }
  }, [compact, level]);

  return <canvas ref={canvasRef} className={`live-voice-level ${compact ? "is-compact" : ""}`}
    role="img" aria-label={t("현재 목소리 세기")} />;
}

export default function LiveViewer({ compact = false }: { compact?: boolean }) {
  const t = useSystemText(viewerMessages);
  const { language: systemLanguage } = useSystemLanguage();
  const systemLocale = SYSTEM_LOCALES[systemLanguage];
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [company, setCompany] = useState("");
  const [department, setDepartment] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [privacyConsent, setPrivacyConsent] = useState(false);
  const [summaryDeliveryConsent, setSummaryDeliveryConsent] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [admissionCode, setAdmissionCode] = useState("");
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [language, setLanguage] = useState("");
  const languageRef = useRef("");
  const [sourceLedger, setSourceLedger] = useState<SourceEvent[]>([]);
  const [sourceDraftState, setSourceDraftState] = useState(createViewerSourceDraftState);
  const sourceLedgerRef = useRef<SourceEvent[]>([]);
  const sourceSnapshotAbortRef = useRef<AbortController | null>(null);
  const isSourceHydratedRef = useRef(false);
  const [sourceError, setSourceError] = useState("");
  const [isSourceLoading, setIsSourceLoading] = useState(false);
  const captionsByLanguageRef = useRef<Record<string, CaptionEvent[]>>({});
  const [captionsByLanguage, setCaptionsByLanguage] = useState(captionsByLanguageRef.current);
  const replaceCaptionCache = useCallback((nextCache: Record<string, CaptionEvent[]>) => {
    // 2026-08-31 fix: 원문은 모든 언어의 캐시를 읽으므로 비선택 언어의 늦은 응답도 화면을 갱신해야 한다.
    captionsByLanguageRef.current = nextCache;
    setCaptionsByLanguage(nextCache);
  }, []);
  const [topicState, setTopicState] = useState<LiveTopicState | null>(null);
  const [unavailableLanguages, setUnavailableLanguages] = useState<string[]>([]);
  const [incompleteLanguages, setIncompleteLanguages] = useState<string[]>([]);
  const [selectedLaneId, setSelectedLaneId] = useState("source");
  const selectedLaneIdRef = useRef("source");
  const [expandedTopicIds, setExpandedTopicIds] = useState<string[]>([]);
  const expandedTopicIdsRef = useRef<string[]>([]);
  const anchorUtteranceKeyRef = useRef("");
  const anchorsByLaneRef = useRef<Record<string, string>>({});
  const pendingRecoveryAnchorRef = useRef("");
  const [status, setStatus] = useState("연결되지 않음");
  const [sessionStatus, setSessionStatus] = useState<LiveSessionStatus>("live");
  const sessionStatusRef = useRef<LiveSessionStatus>("live");
  const [gatewayConnectionState, dispatchGatewayConnection] = useReducer(transitionGatewayConnectionState, "idle");
  const updateSessionStatus = useCallback((nextStatus: LiveSessionStatus) => {
    sessionStatusRef.current = nextStatus;
    if (nextStatus !== "live") setSourceDraftState((current) => ({ ...current, draft: null }));
    setSessionStatus(nextStatus);
    dispatchGatewayConnection({ type: "viewer-session", status: nextStatus });
  }, []);
  const [isWaitingCoverUnavailable, setIsWaitingCoverUnavailable] = useState(false);
  const [joinEndedNotice, setJoinEndedNotice] = useState(false);
  const [isSessionEnded, setIsSessionEnded] = useState(false);
  const [recordsExpiresAt, setRecordsExpiresAt] = useState<string | null>(null);
  const [isRecordsExpired, setIsRecordsExpired] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [summaryRecord, setSummaryRecord] = useState<{ summary: MeetingSummary; createdAt: string } | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [recordingGaps, setRecordingGaps] = useState<RecordingGap[]>([]);
  const [transcriptTopics, setTranscriptTopics] = useState<LiveTopicPublicMetadata[]>([]);
  const [minutesEvent, setMinutesEvent] = useState<EarningsEventPresentation | null>(null);
  const [isTranscriptLoaded, setIsTranscriptLoaded] = useState(false);
  const [summaryError, setSummaryError] = useState("");
  // Nothing was said in this meeting: an empty record, never an error.
  const [isSummaryEmpty, setIsSummaryEmpty] = useState(false);
  const [transcriptError, setTranscriptError] = useState("");
  const [isMinutesLoading, setIsMinutesLoading] = useState(false);
  const [minutesPollingState, setMinutesPollingState] = useState<SummaryPollingState>("idle");
  const [minutesPollingStartedAt, setMinutesPollingStartedAt] = useState<number | null>(null);
  const [minutesPollingRound, setMinutesPollingRound] = useState(0);
  const minutesLoadGenerationRef = useRef(0);
  const isSessionEndedRef = useRef(false);
  const markSessionEndedRef = useRef<() => void>(() => {});
  const markSessionFailedRef = useRef<() => void>(() => {});
  const [floorHolder, setFloorHolder] = useState<LiveFloorHolder | null>(null);
  const [speakState, setSpeakState] = useState<"idle" | "starting" | "speaking">("idle");
  const [speakLevel, setSpeakLevel] = useState(0);
  const [activeSpeakerName, setActiveSpeakerName] = useState("");
  const speakStateRef = useRef<"idle" | "starting" | "speaking">("idle");
  const speakSocketRef = useRef<WebSocket | null>(null);
  const speakSessionRef = useRef<SpeakSession | null>(null);
  const preparedSpeakCaptureRef = useRef<PreparedSpeakCapture | null>(null);
  const speakStartTimerRef = useRef<number | null>(null);
  const speakStopButtonRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [pendingInviteToken, setPendingInviteToken] = useState("");
  const [hasLeftSession, setHasLeftSession] = useState(false);
  // Caption text size is a continuous scale on a CSS custom property, not a
  // three-step class cycle. The old `.is-text-large`/`.is-text-largest`
  // classes only had CSS under `.is-compact`, so the control silently did
  // nothing on the desktop /watch route.
  const [captionScale, setCaptionScale] = useState(1);
  // Contract C11: waiting-room countdown clock. Ticks only while the session
  // is still preparing; reaching zero never auto-starts anything.
  const [waitingClockMs, setWaitingClockMs] = useState(() => Date.now());
  const [gatewayLifecycleRevision, setGatewayLifecycleRevision] = useState(0);
  const [runtimePermission, setRuntimePermission] = useState<boolean | null>(null);
  const requestedLanguageRef = useRef("");
  const foregroundRecoveryStateRef = useRef<ForegroundRecoveryState>({ inFlight: null });
  const clearViewerPrivateState = useCallback(() => {
    clearViewerRecoveryContext(localStorage);
    localStorage.removeItem(LEGACY_VIEWER_AUTH_STORAGE_KEY);
    setEmail("");
    setCompany("");
    setDepartment("");
    setJobTitle("");
    setPrivacyConsent(false);
    setSummaryDeliveryConsent(false);
    setMarketingConsent(false);
    setAdmissionCode("");
    setTopicState(null);
    setFloorHolder(null);
    setRuntimePermission(null); setRecordsExpiresAt(null); setIsRecordsExpired(false); setIsSessionEnded(false); isSessionEndedRef.current = false;
    setTranscript([]); setRecordingGaps([]); setTranscriptTopics([]); setSummaryRecord(null);
    selectedLaneIdRef.current = "source";
    setSelectedLaneId("source");
    expandedTopicIdsRef.current = [];
    setExpandedTopicIds([]);
    sourceSnapshotAbortRef.current?.abort();
    sourceSnapshotAbortRef.current = null;
    replaceCaptionCache({});
    sourceLedgerRef.current = [];
    setSourceLedger([]);
    setSourceDraftState(createViewerSourceDraftState());
    setSourceError("");
    setIsSourceLoading(false);
    setIncompleteLanguages([]);
    isSourceHydratedRef.current = false;
    anchorUtteranceKeyRef.current = "";
    anchorsByLaneRef.current = {};
    pendingRecoveryAnchorRef.current = "";
    viewerSessionIdRef.current = null;
    gatewayReconnectAwaitingStatusRef.current = false;
    dispatchGatewayConnection({ type: "reset" });
  }, [replaceCaptionCache]);

  useEffect(() => {
    localStorage.removeItem(LEGACY_VIEWER_AUTH_STORAGE_KEY);
    const target = getViewerSurfaceRedirect(
      window.location.pathname,
      window.navigator.userAgent,
      window.navigator.maxTouchPoints,
    );
    if (!target) return;
    // The opaque QR credential stays in the fragment until the destination
    // surface consumes it. Replacing only the path avoids a history loop.
    window.location.replace(buildViewerSurfaceUrl(target, window.location.search, window.location.hash));
  }, []);

  useEffect(() => {
    if (!viewer || isSessionEnded || sessionStatus !== "preparing") return;
    setWaitingClockMs(Date.now()); // the mount-time clock may be minutes old by the time the user joins
    const tick = window.setInterval(() => setWaitingClockMs(Date.now()), 1_000);
    return () => window.clearInterval(tick);
  }, [viewer, isSessionEnded, sessionStatus]);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const gatewaySocketRef = useRef<WebSocket | null>(null);
  const gatewayPendingSocketRef = useRef<WebSocket | null>(null);
  const gatewayReconnectTimerRef = useRef<number | null>(null);
  const gatewayProactiveTimerRef = useRef<number | null>(null);
  const gatewayConnectionGenerationRef = useRef(0);
  const gatewayConnectionGateRef = useRef(createViewerGatewayConnectionGate());
  const gatewayReconnectAwaitingStatusRef = useRef(false);
  const viewerSessionIdRef = useRef<string | null>(null);
  // Contract C1/C2: caption sequences are monotonic per (session, language)
  // starting at 1. Track lastSeq per language so a reconnect or language
  // toggle can ask the gateway to replay exactly the missed gap.
  const lastSeqByLanguageRef = useRef<Record<string, number>>({});
  // Every language records continuously, so switching EN<->KO must show that
  // language's transcript IMMEDIATELY. Clearing to [] and waiting on the
  // snapshot fetch made the pane blank for the length of a network round trip,
  // which read as "the record was lost and is being rebuilt". The cache keeps
  // what this viewer has already received per language; the snapshot then tops
  // it up rather than being the only source.
  const captionCacheSessionIdRef = useRef("");
  const snapshotRegistryRef = useRef(new LanguageSnapshotRegistry());
  const getLastSeq = useCallback((forLanguage: string): number => lastSeqByLanguageRef.current[forLanguage] ?? 0, []);
  const setLastSeq = useCallback((forLanguage: string, seq: number) => {
    const current = lastSeqByLanguageRef.current[forLanguage] ?? 0;
    if (seq > current) lastSeqByLanguageRef.current[forLanguage] = seq;
  }, []);
  const handleEventRef = useRef<(event: LiveBroadcastEvent) => void>(() => {});
  const setCaptionSnapshot = useCallback((snapshot: LiveSnapshot) => {
    // A delayed snapshot from a previous QR/session cannot repopulate the
    // freshly-cleared cache when both sessions happen to use the same language.
    if (captionCacheSessionIdRef.current !== snapshot.session.id) return;
    // Merge ON TOP of whatever this viewer already had for the language, so a
    // snapshot bounded to the newest N never discards older lines the viewer
    // still holds.
    const nextCache = mergeLanguageCaptionCache(
      captionsByLanguageRef.current,
      snapshot.language,
      snapshot.captions.filter((caption) => caption.isFinal),
    );
    replaceCaptionCache(nextCache);
    setTopicState((current) => {
      const base = current?.sessionId === snapshot.session.id
        ? current
        : createLiveTopicState(snapshot.session.id);
      try {
        return mergeLiveTopicSnapshot(base, {
          topics: snapshot.topics,
          topicMemberships: snapshot.topicMemberships,
        });
      } catch {
        window.queueMicrotask(() => setError("주제 정보를 확인할 수 없습니다. 실시간 자막은 계속 표시됩니다."));
        return base;
      }
    });
    // 2026-07-26 fix: A slow snapshot may warm only its own language cache.
    // It must not replace captions or lifecycle state selected while
    // that request was in flight.
    setLastSeq(snapshot.language, snapshot.lastSeq);
    if (snapshot.language !== languageRef.current) return;
    updateSessionStatus(snapshot.session.status);
  }, [replaceCaptionCache, setLastSeq, updateSessionStatus]);
  const mergeSourceEvents = useCallback((events: readonly SourceEvent[]) => {
    const next = mergeViewerSourceLedger(sourceLedgerRef.current, events);
    sourceLedgerRef.current = next;
    setSourceLedger(next);
  }, []);
  const synchronizeSourceLedger = useCallback(async (sessionId: string, afterSourceSeq: number) => {
    sourceSnapshotAbortRef.current?.abort();
    const controller = new AbortController();
    sourceSnapshotAbortRef.current = controller;
    setIsSourceLoading(true);
    try {
      const events = await withAbortTimeout(async (timeoutSignal) => {
        const cancel = () => controller.abort(timeoutSignal.reason);
        timeoutSignal.addEventListener("abort", cancel, { once: true });
        try { return await loadViewerSourceSnapshot(sessionId, afterSourceSeq, controller.signal); }
        finally { timeoutSignal.removeEventListener("abort", cancel); }
      });
      if (controller.signal.aborted || sessionId !== viewerSessionIdRef.current) return;
      mergeSourceEvents(events);
      isSourceHydratedRef.current = true;
      setSourceError("");
    } catch {
      if (sourceSnapshotAbortRef.current === controller && sessionId === viewerSessionIdRef.current) {
        setSourceError("원문 기록을 불러오지 못했어요. 기존 원문은 유지됩니다.");
      }
    } finally {
      if (sourceSnapshotAbortRef.current === controller) {
        sourceSnapshotAbortRef.current = null;
        setIsSourceLoading(false);
      }
    }
  }, [mergeSourceEvents]);

  const loadMinutes = useCallback(async (
    requestedLanguage: string = languageRef.current,
    resource: "both" | "summary" | "transcript" = "both",
  ): Promise<boolean> => {
    if (!viewer || !requestedLanguage || isRecordsExpired) return false;
    const generation = minutesLoadGenerationRef.current + 1;
    minutesLoadGenerationRef.current = generation;
    setIsMinutesLoading(true);
    const language = encodeURIComponent(requestedLanguage);
    const fetchMinutesResource = async <T,>(path: string): Promise<T> => readApi<T>(await fetch(path));
    try {
      const [summaryResult, transcriptResult] = await Promise.all([
        resource === "transcript" ? Promise.resolve(null) : settleRequest(fetchMinutesResource<{ summary: MeetingSummary; createdAt: string }>(
          `/api/live-sessions/${viewer.session.id}/summary?language=${language}`,
        )),
        resource === "summary" ? Promise.resolve(null) : settleRequest(loadViewerSourceRecord(viewer.session.id)),
      ]);
      // A late EN response must never replace the KO record selected while it
      // was in flight. The same generation guard covers manual retries.
      if (generation !== minutesLoadGenerationRef.current || requestedLanguage !== languageRef.current) return false;
      let shouldContinuePolling = false;
      let hasFatalSummaryError = false;
      if (summaryResult?.ok) {
        setSummaryRecord(summaryResult.value);
        setSummaryError("");
        setIsSummaryEmpty(false);
      } else if (summaryResult && summaryResult.error instanceof ApiRequestError
        && summaryResult.error.code === "SUMMARY_NOT_READY") {
        setSummaryRecord(null);
        setSummaryError("");
        setIsSummaryEmpty(false);
        shouldContinuePolling = true;
      } else if (summaryResult && summaryResult.error instanceof ApiRequestError
        && isSummaryEmptyCode(summaryResult.error.code)) {
        setSummaryRecord(null);
        setSummaryError("");
        setIsSummaryEmpty(true);
      } else if (summaryResult) {
        setSummaryRecord(null);
        setSummaryError(getSafeSummaryErrorMessage(
          summaryResult.error instanceof ApiRequestError ? summaryResult.error.code : undefined,
        ));
        setMinutesPollingState("failed");
        hasFatalSummaryError = true;
      }
      if (transcriptResult?.ok) {
        setTranscript(transcriptResult.value.utterances);
        setRecordingGaps(transcriptResult.value.recordingGaps);
        setTranscriptTopics([]);
        setMinutesEvent(null);
        setIsTranscriptLoaded(true);
        setTranscriptError("");
      } else if (transcriptResult) {
        setTranscript([]); setRecordingGaps([]);
        setTranscriptTopics([]);
        setMinutesEvent(null);
        setIsTranscriptLoaded(false);
        setTranscriptError(getSafeTranscriptErrorMessage(
          transcriptResult.error instanceof ApiRequestError ? transcriptResult.error.code : undefined,
        ));
        if (!hasFatalSummaryError) shouldContinuePolling = true;
      }
      return shouldContinuePolling;
    } finally {
      if (generation === minutesLoadGenerationRef.current) setIsMinutesLoading(false);
    }
  }, [viewer, isRecordsExpired]);

  // Contract C7: summaries are generated automatically after End. While the
  // record is not ready (SUMMARY_NOT_READY), share the host's bounded polling
  // cadence (2s → 20s plus up to 25% jitter, capped at 25s).
  useEffect(() => {
    if (!isSessionEnded || isRecordsExpired) return;
    if ((summaryRecord || isSummaryEmpty) && isTranscriptLoaded) {
      setMinutesPollingState("idle");
      return;
    }
    if (summaryError) {
      setMinutesPollingState("failed");
      return;
    }
    setMinutesPollingState("polling");
    setMinutesPollingStartedAt((startedAt) => startedAt ?? Date.now());
    return startSummaryPollLoop({
      poll: () => {
        const missingResource = summaryRecord || isSummaryEmpty ? "transcript" : isTranscriptLoaded ? "summary" : "both";
        return loadMinutes(languageRef.current, missingResource);
      },
      onExhausted: () => setMinutesPollingState("exhausted"),
      onError: () => {
        setMinutesPollingState("failed");
        setSummaryError(getSafeSummaryErrorMessage(undefined));
      },
    });
  }, [isSessionEnded, isRecordsExpired, isSummaryEmpty, isTranscriptLoaded, loadMinutes, minutesPollingRound, summaryError, summaryRecord]);

  // 호스트가 라이브를 종료하면 뷰어는 에러가 아니라 회의록 화면으로 전환합니다.
  markSessionEndedRef.current = () => {
    if (isSessionEndedRef.current) return;
    isSessionEndedRef.current = true;
    setIsSessionEnded(true);
    setError("");
    setStatus("라이브 종료");
    updateSessionStatus("stopped");
    setMinutesPollingState("polling");
    setMinutesPollingStartedAt(Date.now());
    stopGatewayLifecycle();
    void loadMinutes(languageRef.current);
  };

  markSessionFailedRef.current = () => {
    updateSessionStatus("failed");
    setError("");
    setStatus("라이브 세션 종료 · 기존 자막 유지");
    stopGatewayLifecycle();
  };

  const resolveViewerGatewayStatus = useCallback(async (
    currentViewer: ViewerState,
    expectedGeneration: number,
  ): Promise<ViewerGatewayStatusDecision | "stale"> => {
    const sessionId = currentViewer.session.id;
    if (!isCurrentViewerGatewayRequest(
      expectedGeneration,
      gatewayConnectionGenerationRef.current,
      sessionId,
      viewerSessionIdRef.current,
    )) return "stale";
    try {
      const result = await readApi<{ status: string }>(await fetch(
        `/api/live-sessions/${sessionId}/status`,
        { cache: "no-store" },
      ));
      if (!isCurrentViewerGatewayRequest(
        expectedGeneration,
        gatewayConnectionGenerationRef.current,
        sessionId,
        viewerSessionIdRef.current,
      )) return "stale";
      const decision = resolveViewerGatewayStatusDecision(result.status);
      if (decision === "ended") {
        markSessionEndedRef.current();
        return decision;
      }
      if (decision === "failed") {
        markSessionFailedRef.current();
        return decision;
      }
      if (result.status === "live" || result.status === "paused" || result.status === "preparing") {
        updateSessionStatus(result.status);
      }
      return decision;
    } catch {
      if (!isCurrentViewerGatewayRequest(
        expectedGeneration,
        gatewayConnectionGenerationRef.current,
        sessionId,
        viewerSessionIdRef.current,
      )) return "stale";
      return "wait";
    }
  }, [updateSessionStatus]);

  // Lifecycle fallback poll: gateway broadcasts can be missed across
  // reconnects, which stranded viewers on the waiting screen after Go-Live
  // and left them without an "ended" notice after the host stopped. The REST
  // status route is participant-authorized and works post-stop.
  // While waiting for go-live the poll tightens to 2.5s so viewers who missed
  // the gateway's session-status push still enter within a couple of seconds.
  useEffect(() => {
    if (!viewer || sessionStatus === "failed") return;
    // Stop once the session has ended. `viewer` is deliberately kept after the
    // end so the minutes screen can read it, so without this guard the poll ran
    // forever — and every tick re-issued the 30-day recap cookie and burned a
    // service-role read. A participant leaving the minutes tab open overnight
    // made thousands of pointless requests.
    if (isSessionEnded) return;
    const poll = window.setInterval(() => {
      // 백그라운드 탭은 폴링을 건너뛴다. 대기실 200명 × 2.5s가 이 폴의 최대
      // 트래픽원인데, 숨겨진 탭은 복귀 시 foreground-recovery가 즉시 상태를
      // 복원하므로 놓치는 것이 없다.
      if (document.visibilityState === "hidden") return;
      void (async () => {
        try {
          const result = await readApi<{ status: string }>(await fetch(
            `/api/live-sessions/${viewer.session.id}/status`,
            { cache: "no-store" },
          ));
          if (viewerSessionIdRef.current !== viewer.session.id) return;
          if (result.status === "stopped") {
            markSessionEndedRef.current();
            return;
          }
          if (result.status === "failed") {
            markSessionFailedRef.current();
            return;
          }
          if (result.status === "live" || result.status === "paused" || result.status === "preparing") {
            if (sessionStatusRef.current !== result.status) updateSessionStatus(result.status);
            if (gatewayReconnectAwaitingStatusRef.current
              && resolveViewerGatewayStatusDecision(result.status) === "reconnect") {
              gatewayReconnectAwaitingStatusRef.current = false;
              setGatewayLifecycleRevision((revision) => revision + 1);
            }
          }
        } catch {
          // Transient failures fall back to the next tick; the gateway path
          // remains the primary signal.
        }
      })();
    }, sessionStatus === "preparing" ? 2_500 : 10_000);
    return () => window.clearInterval(poll);
  }, [viewer, sessionStatus, isSessionEnded, updateSessionStatus]);

  const sessionType = viewer?.session.sessionType ?? "presentation";
  const outputMode = viewer?.session.outputMode ?? "captions";
  const languages = viewer?.session.languages ?? [];

  const disconnectGateway = useCallback(() => {
    dispatchGatewayConnection({ type: "socket-closed", sessionStatus: sessionStatusRef.current });
    gatewayConnectionGenerationRef.current += 1;
    sourceSnapshotAbortRef.current?.abort();
    sourceSnapshotAbortRef.current = null;
    setIsSourceLoading(false);
    setSourceDraftState(createViewerSourceDraftState());
    if (gatewayReconnectTimerRef.current !== null) window.clearTimeout(gatewayReconnectTimerRef.current);
    if (gatewayProactiveTimerRef.current !== null) window.clearTimeout(gatewayProactiveTimerRef.current);
    gatewayReconnectTimerRef.current = null;
    gatewayProactiveTimerRef.current = null;
    const socket = gatewaySocketRef.current;
    gatewaySocketRef.current = null;
    const pendingSocket = gatewayPendingSocketRef.current;
    gatewayPendingSocketRef.current = null;
    pendingSocket?.close(1000, "language changed");
    // The speaking floor uses a dedicated socket so language changes can swap
    // caption subscriptions without interrupting the participant's live turn.
    // `unsubscribe` releases by grant, not by socket, so skip it while active.
    if (speakStateRef.current === "idle" && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "unsubscribe" }));
    }
    socket?.close(1000, "language changed");
  }, []);

  const stopSpeakCapture = useCallback(() => {
    const session = speakSessionRef.current;
    speakSessionRef.current = null;
    const prepared = preparedSpeakCaptureRef.current;
    preparedSpeakCaptureRef.current = null;
    setSpeakLevel(0);
    const stopping = session?.stop() ?? prepared?.stop();
    if (stopping) void stopping.catch(() => console.warn("[live-speak] capture cleanup failed"));
  }, []);

  const endSpeaking = useCallback((sendEnd: boolean, reason?: "preempted" | "disconnected") => {
    if (speakStartTimerRef.current !== null) window.clearTimeout(speakStartTimerRef.current);
    speakStartTimerRef.current = null;
    speakStateRef.current = "idle";
    setSpeakState("idle");
    setActiveSpeakerName("");
    const socket = speakSocketRef.current;
    speakSocketRef.current = null;
    try {
      if (sendEnd && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "speak-end" }));
      }
      socket?.close(1000, "speaking ended");
    } finally {
      stopSpeakCapture();
    }
    if (reason === "preempted") setError("다른 참여자에게 발언이 넘어갔습니다.");
    if (reason === "disconnected") setError("연결이 끊겨 발언이 종료되었습니다. 다시 눌러 주세요.");
  }, [stopSpeakCapture]);

  const toggleSpeak = useCallback(async () => {
    if (!viewer || viewer.session.participantSpeakingEnabled !== true || sessionStatusRef.current !== "live") return;
    if (speakStateRef.current !== "idle") {
      endSpeaking(true);
      return;
    }
    if (gatewaySocketRef.current?.readyState !== WebSocket.OPEN || !LIVE_GATEWAY_URL) {
      setError("실시간 연결 후 발언을 시작해 주세요.");
      return;
    }
    setError("");
    speakStateRef.current = "starting";
    setSpeakState("starting");
    try {
      const prepared = await prepareSpeakCapture();
      if (speakStateRef.current !== "starting") {
        await prepared.stop();
        return;
      }
      preparedSpeakCaptureRef.current = prepared;
      const ticketData = await requestViewerGatewayTicket(viewer.session.id);
      const { ticket } = ticketData;
      if (speakStateRef.current !== "starting") {
        if (preparedSpeakCaptureRef.current === prepared) {
          preparedSpeakCaptureRef.current = null;
          await prepared.stop();
        }
        return;
      }
      const socket = new WebSocket(LIVE_GATEWAY_URL);
      speakSocketRef.current = socket;
      socket.binaryType = "arraybuffer";
      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") return;
        try {
          const event: unknown = JSON.parse(message.data);
          if (!isRecord(event)) return;
          if (event.type === "authenticated") {
            socket.send(JSON.stringify({
              type: "subscribe",
              sessionId: viewer.session.id,
              ...(ticketData.connectionId ? { connectionId: ticketData.connectionId, epoch: ticketData.epoch } : {}),
              language: languageRef.current,
              lastSeq: getLastSeq(languageRef.current),
            }));
            return;
          }
          if (event.type === "subscribed") {
            socket.send(JSON.stringify({ type: "speak-start" }));
            return;
          }
          if (event.type === "live-event") {
            const liveEvent = parseBroadcastEvent(event.payload ?? event.event);
            if (liveEvent && !["source", "source-draft", "source-draft-clear"].includes(liveEvent.type)) handleEventRef.current(liveEvent);
            return;
          }
          if (event.type === "speak-started") {
            if (speakStartTimerRef.current !== null) window.clearTimeout(speakStartTimerRef.current);
            speakStartTimerRef.current = null;
            setActiveSpeakerName(typeof event.displayName === "string" ? event.displayName : viewer.self.email);
            const activePrepared = preparedSpeakCaptureRef.current;
            if (!activePrepared || speakStateRef.current !== "starting") {
              endSpeaking(true);
              return;
            }
            void activePrepared.start(socket, { onLevel: setSpeakLevel }).then((session) => {
              if (preparedSpeakCaptureRef.current === activePrepared) preparedSpeakCaptureRef.current = null;
              if (speakStateRef.current !== "starting") {
                void session.stop();
                return;
              }
              speakSessionRef.current = session;
              speakStateRef.current = "speaking";
              setSpeakState("speaking");
            }).catch((captureError: unknown) => {
              if (preparedSpeakCaptureRef.current === activePrepared) preparedSpeakCaptureRef.current = null;
              if (speakStateRef.current !== "starting") return;
              setError(captureError instanceof SpeakCaptureError
                ? captureError.message
                : "마이크를 시작하지 못했습니다. 다시 눌러 주세요.");
              endSpeaking(true);
            });
            return;
          }
          if (event.type === "speak-ended") {
            endSpeaking(false, event.reason === "preempted" ? "preempted" : undefined);
            return;
          }
          if (event.type === "error") {
            setError(event.code === "FLOOR_RATE_LIMITED"
              ? "잠시 후 다시 발언을 눌러 주세요."
              : "발언을 시작하지 못했습니다. 다시 눌러 주세요.");
            endSpeaking(false);
          }
        } catch {
          setError("발언 연결을 확인할 수 없습니다. 다시 눌러 주세요.");
          endSpeaking(false);
        }
      });
      socket.addEventListener("close", () => {
        if (speakSocketRef.current === socket && speakStateRef.current !== "idle") {
          endSpeaking(false, "disconnected");
        }
      });
      await waitForSocketOpen(socket);
      if (speakSocketRef.current !== socket || speakStateRef.current !== "starting") {
        socket.close(1000, "speaking cancelled");
        return;
      }
      socket.send(JSON.stringify({ type: "authenticate", token: ticket }));
      speakStartTimerRef.current = window.setTimeout(() => {
        if (speakStateRef.current !== "idle") {
          setError("발언 연결이 지연되고 있습니다. 다시 눌러 주세요.");
          endSpeaking(true);
        }
      }, 8_000);
    } catch (captureError: unknown) {
      // 2026-08-22 fix: The user can cancel while either awaited setup step is
      // pending. Read through a callback so TypeScript does not reuse its
      // pre-await narrowing.
      if (isSpeakFlowIdle(() => speakStateRef.current)) return;
      setError(captureError instanceof SpeakCaptureError
        ? captureError.message
        : "마이크를 준비하지 못했습니다. 다시 눌러 주세요.");
      endSpeaking(false);
    }
  }, [endSpeaking, getLastSeq, viewer]);

  const connectGateway = useCallback(async (currentViewer: ViewerState, nextLanguage: string) => {
    if (!LIVE_GATEWAY_URL) throw new Error("The live gateway is not configured.");
    const generation = gatewayConnectionGenerationRef.current;
    let reconnectAttempt = 0;
    let connectionPromise: Promise<void> | null = null;
    let hasConnected = false;

    const reportConnectionError = (connectionError: unknown) => {
      if (connectionError instanceof ViewerGatewayWaitingError) {
        setRuntimePermission(false); waitForAuthoritativeStatus(); setError("");
        setStatus("호스트 연결을 기다리고 있어요.");
        return;
      }
      dispatchGatewayConnection({ type: "recoverable-error" });
      setError("실시간 자막에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    };

    const waitForAuthoritativeStatus = () => {
      gatewayReconnectAwaitingStatusRef.current = true;
      resetViewerGatewayConnectionGate(gatewayConnectionGateRef.current);
      disconnectGateway();
      setStatus("세션 상태 확인 중 · 기존 자막 유지");
    };

    const scheduleReconnect = () => {
      if (generation !== gatewayConnectionGenerationRef.current
        || gatewayReconnectTimerRef.current !== null
        || connectionPromise !== null) return;
      const delayMilliseconds = getReconnectDelayMilliseconds(reconnectAttempt);
      reconnectAttempt += 1;
      dispatchGatewayConnection({ type: "retry" });
      setStatus(getReconnectStatus(delayMilliseconds));
      gatewayReconnectTimerRef.current = window.setTimeout(() => {
        gatewayReconnectTimerRef.current = null;
        void resolveViewerGatewayStatus(currentViewer, generation)
          .then((decision) => {
            if (decision === "ended" || decision === "failed" || decision === "stale") return;
            if (decision === "wait") {
              waitForAuthoritativeStatus();
              return;
            }
            if (decision === "reconnect" && isCurrentViewerGatewayRequest(
              generation,
              gatewayConnectionGenerationRef.current,
              currentViewer.session.id,
              viewerSessionIdRef.current,
            )) {
              void installConnection().catch((connectionError: unknown) => {
                reportConnectionError(connectionError);
                scheduleReconnect();
              });
            }
          })
          .catch(() => waitForAuthoritativeStatus());
      }, delayMilliseconds);
    };

    const openConnection = async (): Promise<void> => {
      const afterSourceSeq = isSourceHydratedRef.current ? sourceLedgerRef.current.at(-1)?.sourceSeq ?? 0 : 0;
      const ticketData = await requestViewerGatewayTicket(currentViewer.session.id);
      const { ticket } = ticketData;
      if (!isCurrentViewerGatewayRequest(
        generation,
        gatewayConnectionGenerationRef.current,
        currentViewer.session.id,
        viewerSessionIdRef.current,
      )) return;
      const candidate = new WebSocket(LIVE_GATEWAY_URL);
      gatewayPendingSocketRef.current = candidate;
      try {
        await waitForSocketOpen(candidate);
        const subscribed = new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            candidate.close();
            reject(new Error("The live connection timed out."));
          }, 5_000);
          candidate.addEventListener("error", () => {
            window.clearTimeout(timeout);
            reject(new Error("Unable to connect to the live gateway."));
          }, { once: true });
          candidate.addEventListener("message", (message) => {
            if (typeof message.data !== "string" || generation !== gatewayConnectionGenerationRef.current) return;
            try {
              const event: unknown = JSON.parse(message.data);
              if (!isRecord(event)) return;
              if (event.type === "authenticated") {
                // Contract C2: lastSeq lets the gateway replay the missed gap
                // (replay:true caption events reuse the same dedupe path).
                candidate.send(JSON.stringify({
                  type: "subscribe",
                  sessionId: currentViewer.session.id,
                  language: nextLanguage,
                  ...(ticketData.connectionId ? { connectionId: ticketData.connectionId, epoch: ticketData.epoch } : {}),
                  lastSeq: getLastSeq(nextLanguage),
                }));
              }
              if (event.type === "media-idle" && event.sessionId === currentViewer.session.id
                && (ticketData.epoch === undefined || event.epoch === ticketData.epoch)) {
                setRuntimePermission(false);
                setSourceDraftState((current) => ({ ...current, draft: null }));
                waitForAuthoritativeStatus();
                setStatus("호스트 연결을 기다리고 있어요.");
                return;
              }
              if (event.type === "subscribed") {
                window.clearTimeout(timeout);
                resolve();
              }
              if (event.type === "live-event") {
                const liveEvent = parseBroadcastEvent(event.payload ?? event.event);
                if (liveEvent) handleEventRef.current(liveEvent);
              }
              if (event.type === "error") setError("실시간 자막 연결을 확인하고 있습니다. 원문 자막은 계속 유지됩니다.");
            } catch {
              setError("실시간 자막 메시지를 확인할 수 없습니다. 다시 연결해 주세요.");
            }
          });
        });
        candidate.send(JSON.stringify({ type: "authenticate", token: ticket }));
        await subscribed;
        if (candidate.readyState !== WebSocket.OPEN) throw new Error("The live connection closed unexpectedly.");
        if (generation !== gatewayConnectionGenerationRef.current) {
          if (gatewayPendingSocketRef.current === candidate) gatewayPendingSocketRef.current = null;
          candidate.close(1000, "stale connection");
          return;
        }
        void synchronizeSourceLedger(currentViewer.session.id, afterSourceSeq);
        // 2026-08-22 비용 가드: 재접속 시 이미 이 언어의 히스토리를 들고 있으면
        // 게이트웨이가 lastSeq부터 replay로 공백을 메우므로 REST 스냅샷
        // (Supabase 7회 왕복)을 건너뛴다. 히스토리가 전무할 때만 fallback.
        if (hasConnected && getLastSeq(nextLanguage) === 0) {
          try {
            // 2026-07-26 fix: Snapshot is a reconnect fallback, not a connection gate.
            // A timed-out history read must not close a socket that already
            // authenticated, subscribed, and can receive buffered replay.
            const snapshot = await withAbortTimeout(async (signal) => readApi<LiveSnapshot>(await fetch(
              `/api/live-sessions/${currentViewer.session.id}/snapshot?language=${encodeURIComponent(nextLanguage)}`,
              { signal },
            )));
            if (snapshot.lastSeq >= getLastSeq(nextLanguage)) {
              setCaptionSnapshot(snapshot);
              snapshotRegistryRef.current.finish(currentViewer.session.id, nextLanguage, true);
            }
            if (languageRef.current === nextLanguage) {
              setViewer((activeViewer) => activeViewer ? mergeViewerSnapshot(activeViewer, snapshot) : activeViewer);
            }
          } catch {
            // 2026-07-26 fix: The gateway replay path remains live and closes the missed gap.
          }
        }
        hasConnected = true;
        const previous = gatewaySocketRef.current;
        if (gatewayPendingSocketRef.current === candidate) gatewayPendingSocketRef.current = null;
        gatewaySocketRef.current = candidate;
        previous?.close(1000, "connection refreshed");
        dispatchGatewayConnection({ type: "socket-opened", sessionStatus: sessionStatusRef.current });
        setStatus("연결됨 · 실시간 자막 수신 중");
        // A transient pre-connect failure must not keep the error banner up
        // once the live pipeline is actually flowing.
        setError("");
        const connectedAt = Date.now();
        candidate.addEventListener("close", (event) => {
          if (generation !== gatewayConnectionGenerationRef.current || gatewaySocketRef.current !== candidate) return;
          gatewaySocketRef.current = null;
          dispatchGatewayConnection({ type: "socket-closed", sessionStatus: sessionStatusRef.current });
          if (gatewayProactiveTimerRef.current !== null) {
            window.clearTimeout(gatewayProactiveTimerRef.current);
            gatewayProactiveTimerRef.current = null;
          }
          if (event.code === 4401 || event.code === 4403) {
            // 권한 만료가 아니라 호스트가 종료한 경우라면 회의록 화면으로 넘어갑니다.
            void resolveViewerGatewayStatus(currentViewer, generation).then((decision) => {
              if (decision === "ended" || decision === "failed" || decision === "stale") return;
              if (decision === "wait") {
                waitForAuthoritativeStatus();
                return;
              }
              setStatus("시청 권한이 만료되었습니다");
              setError("시청 권한이 만료되었습니다. 호스트의 QR 코드를 다시 스캔해 주세요.");
            }).catch(() => waitForAuthoritativeStatus());
            return;
          }
          if (Date.now() - connectedAt >= 30_000) reconnectAttempt = 0;
          const isSlowConsumer = event.code === 4408 || event.reason.includes("SLOW_CONSUMER");
          void resolveViewerGatewayStatus(currentViewer, generation).then((decision) => {
            if (decision === "ended" || decision === "failed" || decision === "stale") return;
            if (decision === "reconnect") {
              if (isSlowConsumer) setStatus("자막 복구 중 · 다시 연결 중");
              scheduleReconnect();
              return;
            }
            waitForAuthoritativeStatus();
          }).catch(() => waitForAuthoritativeStatus());
        });
        if (gatewayProactiveTimerRef.current !== null) window.clearTimeout(gatewayProactiveTimerRef.current);
        gatewayProactiveTimerRef.current = window.setTimeout(() => {
          gatewayProactiveTimerRef.current = null;
          scheduleReconnect();
        }, 50 * 60 * 1_000);
      } catch (connectionError) {
        if (gatewayPendingSocketRef.current === candidate) gatewayPendingSocketRef.current = null;
        candidate.close();
        throw connectionError;
      }
    };

    const installConnection = async (): Promise<void> => {
      if (connectionPromise) return connectionPromise;
      connectionPromise = openConnection();
      try {
        await connectionPromise;
      } finally {
        connectionPromise = null;
      }
    };

    try {
      await installConnection();
    } catch (connectionError) {
      if (connectionError instanceof ViewerGatewayWaitingError) {
        setRuntimePermission(false); waitForAuthoritativeStatus(); setError("");
        setStatus("호스트 연결을 기다리고 있어요.");
        return;
      }
      reportConnectionError(connectionError);
      scheduleReconnect();
    }
  }, [disconnectGateway, getLastSeq, resolveViewerGatewayStatus, setCaptionSnapshot, synchronizeSourceLedger]);

  const handleEvent = useCallback((event: LiveBroadcastEvent) => {
    if (event.sessionId !== viewerSessionIdRef.current) return;
    if (event.type === "source-draft" || event.type === "source-draft-clear") {
      if (event.type === "source-draft" && sessionStatusRef.current !== "live") return;
      setSourceDraftState((current) => reduceViewerSourceDraft(current, event));
      return;
    }
    if (event.type === "source") {
      try { mergeSourceEvents([event]); }
      catch { setSourceError("원문 기록의 순서를 확인할 수 없습니다. 다시 불러와 주세요."); }
      return;
    }
    if (event.type === "caption") {
      // A caption can only come from a running host pipeline: if the viewer
      // missed the session-status broadcast (reconnect gap), leave the
      // waiting screen anyway instead of hiding live captions behind it.
      if (sessionStatusRef.current === "preparing") updateSessionStatus("live");
      // Resume bookkeeping is COMMITTED-only (contract C1). Interim captions
      // carry the seq their committed line is ABOUT to take, so running the
      // strict-greater guard over them would raise lastSeq to N and then drop
      // the real final at N — blanking the feed. Interim captions need no seq
      // guard anyway: mergeCaptionTimeline replaces the partial in its lane.
      if (event.isFinal) {
        // Per-language strict-greater guard; seq starts at 1, so 0 means
        // "nothing received yet" and the first caption always passes.
        if (event.seq <= getLastSeq(event.language)) return;
        setLastSeq(event.language, event.seq);
      }
      const nextCache = mergeLanguageCaptionCache(captionsByLanguageRef.current, event.language, [event]);
      replaceCaptionCache(nextCache);
      return;
    }
    if (event.type === "recording-status") {
      if (event.language === languageRef.current) {
        setError("실시간 자막 연결을 확인하고 있습니다. 원문 자막은 계속 유지됩니다.");
      }
      return;
    }
    if (event.type === "topic-upsert") {
      setTopicState((current) => {
        const base = current?.sessionId === event.sessionId ? current : createLiveTopicState(event.sessionId);
        try {
          return applyLiveTopicUpsert(base, event);
        } catch {
          window.queueMicrotask(() => setError("주제 정보를 확인할 수 없습니다. 실시간 자막은 계속 표시됩니다."));
          return base;
        }
      });
      return;
    }
    if (event.type === "floor") {
      setFloorHolder(event.holder);
      return;
    }
    if (event.type === "session-status") {
      updateSessionStatus(event.status);
      setStatus(captionConnectionLabel(event.status));
      // Going live supersedes any stale pre-live warning banner.
      if (event.status === "live") setError("");
      if (event.status === "stopped") markSessionEndedRef.current();
      if (event.status === "failed") markSessionFailedRef.current();
    }
    // Translation failures are operator health, not participant-facing copy.
    // Keep the viewer's last Live/Preparing state while the controller handles
    // recovery; a later ready/preparing event may update this status normally.
    if (event.type === "language-status") {
      if (event.code === "SOURCE_REPLAY_INCOMPLETE") {
        setIncompleteLanguages((current) => [...new Set([...current, event.language])]);
      }
      setUnavailableLanguages((current) => event.status === "unavailable"
        ? [...new Set([...current, event.language])]
        : current.filter((language) => language !== event.language));
      if (event.language === languageRef.current && event.status !== "unavailable") {
        setStatus(captionConnectionLabel(event.status));
      }
    }
    if (event.type === "language-removed") {
      setUnavailableLanguages((current) => current.filter((language) => language !== event.language));
      setViewer((current) => current ? {
        ...current,
        session: { ...current.session, languages: current.session.languages.filter((item) => item !== event.language) },
      } : current);
      if (event.language === languageRef.current) {
        const remainingLanguage = languages.find((item) => item !== event.language) ?? "";
        languageRef.current = remainingLanguage;
        setLanguage(remainingLanguage);
        selectedLaneIdRef.current = "source";
        setSelectedLaneId("source");
        anchorUtteranceKeyRef.current = anchorsByLaneRef.current.source ?? "";
        pendingRecoveryAnchorRef.current = anchorUtteranceKeyRef.current;
        if (remainingLanguage && viewerSessionIdRef.current) writeViewerRecoveryContext(localStorage, {
          sessionId: viewerSessionIdRef.current,
          language: remainingLanguage,
          preferredTargetLanguage: remainingLanguage,
          selectedLaneId: "source",
          expandedTopicIds: expandedTopicIdsRef.current,
          anchorUtteranceKey: anchorUtteranceKeyRef.current,
          anchorsByLane: anchorsByLaneRef.current,
        });
        setError("호스트가 이 번역 언어를 종료했습니다. 원문으로 전환했습니다.");
      }
    }
    if (event.type === "error") {
      setError("라이브 자막 연결에 문제가 있습니다. 잠시 후 다시 확인해 주세요.");
    }
  }, [getLastSeq, languages, mergeSourceEvents, replaceCaptionCache, setLastSeq, updateSessionStatus]);
  handleEventRef.current = handleEvent;

  const subscribe = useCallback(async (
    nextLanguage: string,
    currentViewer: ViewerState,
    expectedConnectionGeneration?: number,
  ) => {
    // 2026-07-26 fix: Attach first. The gateway buffers live events while replaying from lastSeq,
    // so the socket closes the snapshot race instead of opening one.
    // Foreground recovery closes the half-open socket synchronously before this
    // await. Leaving, changing language, or ending the session increments the
    // generation and prevents that old recovery from resurrecting a connection.
    if (expectedConnectionGeneration !== undefined
      && expectedConnectionGeneration !== gatewayConnectionGenerationRef.current) return;
    disconnectGateway();
    // 2026-07-26 fix: Sequence numbers restart per session. A viewer who leaves and joins a
    // different QR session in the same tab must not inherit either captions or
    // resume cursors from the previous call.
    if (captionCacheSessionIdRef.current !== currentViewer.session.id) {
      captionCacheSessionIdRef.current = currentViewer.session.id;
      replaceCaptionCache({});
      sourceLedgerRef.current = [];
      setSourceLedger([]);
      isSourceHydratedRef.current = false;
      setSourceError("");
      setIncompleteLanguages([]);
      lastSeqByLanguageRef.current = {};
      snapshotRegistryRef.current.reset(currentViewer.session.id);
    }
    languageRef.current = nextLanguage;
    // Show this language's known transcript at once — never a blank pane.
    // Per-language lastSeq memory is kept across language switches so the
    // gateway can replay only the true gap when this language is revisited.
    setStatus(getCachedLanguageCaptions(captionsByLanguageRef.current, nextLanguage).length
      ? "Connecting · captions restored"
      : "Connecting · live captions");

    await connectGateway(currentViewer, nextLanguage);

    // 2026-07-26 fix: Frequent EN↔KO switching is a local cache selection.
    // The gateway still resubscribes with lastSeq for live replay, while each
    // language's full HTTP history is fetched only until its first success.
    let snapshot: LiveSnapshot | null = null;
    try {
      snapshot = await loadLanguageSnapshotOnce(
        snapshotRegistryRef.current,
        currentViewer.session.id,
        nextLanguage,
        () => withAbortTimeout(async (signal) => readApi<LiveSnapshot>(await fetch(
          `/api/live-sessions/${currentViewer.session.id}/snapshot?language=${encodeURIComponent(nextLanguage)}`,
          { signal },
        ))),
      );
    } catch {
      // 2026-07-26 fix: The attached socket and its server-side replay buffer are authoritative.
      // Snapshot is only a bounded history/status accelerator; timing it out
      // must not tear down a healthy live stream or blank the restored cache.
    }
    if (snapshot) {
      setCaptionSnapshot(snapshot);
      const refreshedViewer = mergeViewerSnapshot(currentViewer, snapshot);
      if (languageRef.current === nextLanguage) setViewer(refreshedViewer);
    }
  }, [connectGateway, disconnectGateway, replaceCaptionCache, setCaptionSnapshot]);

  const stopGatewayLifecycle = useCallback(() => {
    resetViewerGatewayConnectionGate(gatewayConnectionGateRef.current);
    disconnectGateway();
  }, [disconnectGateway]);

  const restoreViewerSession = useCallback(async () => {
    const stored = readViewerRecoveryContext(localStorage);
    if (!stored) {
      clearViewerRecoveryContext(localStorage);
      return;
    }
    setRecoveryError("");
    try {
      let result: ViewerState;
      try {
        const live = await readApi<unknown>(await fetch(
          `/api/live-sessions/${stored.sessionId}/viewer-session`,
          { method: "GET", cache: "no-store" },
        ));
        if (!isViewerJoinData(live)) throw new Error("세션 정보를 확인할 수 없습니다.");
        result = live;
      } catch (error) {
        if (!(error instanceof ApiRequestError) || ![401, 403, 409, 410].includes(error.status)) throw error;
        const records = parseViewerRecordsSession(await readApi<unknown>(await fetch(
          `/api/live-sessions/${stored.sessionId}/records-session`, { cache: "no-store" },
        )), stored.sessionId);
        result = records.viewer;
        setRecordsExpiresAt(records.recordsExpiresAt);
        setIsRecordsExpired(isRecordsAccessExpired(records.recordsExpiresAt, Date.now()));
        isSessionEndedRef.current = true;
        setIsSessionEnded(true);
      }
      if (result.session.id !== stored.sessionId) throw new Error("복구된 회의가 일치하지 않습니다.");
      const restoredSelection = resolveViewerRecoverySelection(stored, result.session.languages);
      const restoredLanguage = restoredSelection.language;
      const restoredLaneId = restoredSelection.selectedLaneId;
      if (!restoredLanguage) throw new Error("No viewing language is available.");
      setEmail(result.self.email);
      setDisplayName(result.self.displayName);
      setCompany(result.self.company);
      setDepartment(result.self.department);
      setJobTitle(result.self.jobTitle);
      setPrivacyConsent(true);
      setSummaryDeliveryConsent(result.self.summaryConsent);
      viewerSessionIdRef.current = result.session.id;
      updateSessionStatus(result.session.status ?? "live");
      setStatus(captionConnectionLabel(result.session.status ?? "live"));
      setViewer(result);
      setLanguage(restoredLanguage);
      languageRef.current = restoredLanguage;
      selectedLaneIdRef.current = restoredLaneId;
      setSelectedLaneId(restoredLaneId);
      expandedTopicIdsRef.current = stored.expandedTopicIds;
      setExpandedTopicIds(stored.expandedTopicIds);
      anchorsByLaneRef.current = stored.anchorsByLane;
      anchorUtteranceKeyRef.current = restoredSelection.anchorUtteranceKey;
      pendingRecoveryAnchorRef.current = restoredSelection.anchorUtteranceKey;
      writeViewerRecoveryContext(localStorage, {
        sessionId: result.session.id,
        language: restoredLanguage,
        preferredTargetLanguage: restoredLanguage,
        selectedLaneId: restoredLaneId,
        expandedTopicIds: stored.expandedTopicIds,
        anchorUtteranceKey: restoredSelection.anchorUtteranceKey,
        anchorsByLane: stored.anchorsByLane,
      });
    } catch (error) {
      stopGatewayLifecycle();
      const code = error instanceof ApiRequestError ? error.code : "";
      const isDenied = /EXPIRED|FORBIDDEN|NOT_FOUND|REVOKED|AUTH_REQUIRED|INVALID_TOKEN/u.test(code);
      if (isDenied) {
        clearViewerPrivateState(); setViewer(null); setLanguage(""); languageRef.current = "";
      }
      setRecoveryError(isDenied ? "기록 열람 기간이 끝났거나 접근 권한이 없습니다." : "기록을 불러오지 못했어요. 새로고침하거나 다시 시도해 주세요.");
    }
  }, [clearViewerPrivateState, stopGatewayLifecycle, updateSessionStatus]);

  useEffect(() => {
    if (!isSessionEnded || !viewer || recordsExpiresAt) return;
    const sessionId = viewer.session.id;
    let isCancelled = false;
    void (async () => {
      try {
        const records = parseViewerRecordsSession(await readApi<unknown>(await fetch(
          `/api/live-sessions/${sessionId}/records-session`, { cache: "no-store" },
        )), sessionId);
        if (isCancelled) return;
        setViewer(records.viewer); setRecordsExpiresAt(records.recordsExpiresAt);
      } catch { if (!isCancelled) setError("기록 열람 기한을 확인하지 못했어요. 새로고침해 주세요."); }
    })();
    return () => { isCancelled = true; };
  }, [isSessionEnded, viewer?.session.id, recordsExpiresAt]);

  useEffect(() => {
    if (!recordsExpiresAt) return;
    const expire = () => {
      if (!isRecordsAccessExpired(recordsExpiresAt, Date.now())) return;
      setIsRecordsExpired(true); minutesLoadGenerationRef.current += 1;
      setTranscript([]); setRecordingGaps([]); setTranscriptTopics([]); setSummaryRecord(null); setMinutesPollingState("idle");
    };
    expire();
    const timer = window.setTimeout(expire, Math.max(0, Date.parse(recordsExpiresAt) - Date.now()));
    window.addEventListener("focus", expire);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", expire); };
  }, [recordsExpiresAt]);

  useEffect(() => {
    if (!viewer || isSessionEnded) return;
    const sessionId = viewer.session.id;
    let isCancelled = false;
    let inFlight = false;
    const refreshRuntime = async () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const runtime = await readApi<unknown>(await fetch(`/api/live-sessions/${sessionId}/runtime`, { cache: "no-store" }));
        if (isCancelled || viewerSessionIdRef.current !== sessionId) return;
        if (!isRecord(runtime) || typeof runtime.enabled !== "boolean") throw new Error("잘못된 연결 상태입니다.");
        if (!runtime.enabled) { setRuntimePermission(null); return; }
        if (runtime.sessionId !== sessionId || typeof runtime.canPrepareConnection !== "boolean") throw new Error("잘못된 연결 권한입니다.");
        setRuntimePermission(runtime.canPrepareConnection);
        if (!runtime.canPrepareConnection) setStatus("호스트 연결을 기다리고 있어요.");
        else if (gatewayReconnectAwaitingStatusRef.current) {
          gatewayReconnectAwaitingStatusRef.current = false;
          setGatewayLifecycleRevision((revision) => revision + 1);
        }
      } catch { if (!isCancelled) setError("실시간 연결 상태를 확인하지 못했어요. 잠시 후 다시 확인합니다."); }
      finally { inFlight = false; }
    };
    void refreshRuntime();
    const timer = window.setInterval(() => void refreshRuntime(), 5_000);
    return () => { isCancelled = true; window.clearInterval(timer); };
  }, [viewer?.session.id, isSessionEnded]);

  const { isRestoringViewer } = useViewerRecovery(restoreViewerSession);

  useEffect(() => {
    if (!viewer || !language || runtimePermission === false || !(shouldConnectViewerGateway(sessionStatus, isSessionEnded) || (runtimePermission === true && sessionStatus === "preparing" && !isSessionEnded))) return;

    const recover = (event: ForegroundRecoveryEvent) => {
      const operation = requestForegroundRecovery(
        foregroundRecoveryStateRef.current,
        event,
        document.visibilityState,
        () => {
          // Do this before any await: a mobile browser may retain a half-open
          // WebSocket after suspension and never deliver its close event.
          resetViewerGatewayConnectionGate(gatewayConnectionGateRef.current);
          disconnectGateway();
          const recoveryGeneration = gatewayConnectionGenerationRef.current;
          return resolveViewerGatewayStatus(viewer, recoveryGeneration).then((decision) => {
            if (decision !== "reconnect") {
              if (decision === "wait") gatewayReconnectAwaitingStatusRef.current = true;
              return;
            }
            const recoveryLanguage = languageRef.current;
            return connectViewerGatewayOnce(
              gatewayConnectionGateRef.current,
              `${viewer.session.id}:${recoveryLanguage}`,
              () => subscribe(recoveryLanguage, viewer, recoveryGeneration),
            );
          });
        },
      );
      void operation?.catch(() => {
        // connectGateway owns actionable status/error copy and bounded retries.
      });
    };
    const handleVisibilityChange = () => recover("visibilitychange");
    const handlePageShow = () => recover("pageshow");
    const handleOnline = () => recover("online");
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("online", handleOnline);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("online", handleOnline);
    };
  }, [disconnectGateway, runtimePermission, isSessionEnded, language, resolveViewerGatewayStatus, sessionStatus, subscribe, viewer]);

  useEffect(() => {
    if (!viewer || !language) return;
    if (runtimePermission === false || !(shouldConnectViewerGateway(sessionStatus, isSessionEnded) || (runtimePermission === true && sessionStatus === "preparing" && !isSessionEnded))) {
      stopGatewayLifecycle();
      if (sessionStatus === "stopped") markSessionEndedRef.current();
      if (sessionStatus === "failed") markSessionFailedRef.current();
      return;
    }
    const connectionKey = `${viewer.session.id}:${language}`;
    gatewayReconnectAwaitingStatusRef.current = false;
    void connectViewerGatewayOnce(
      gatewayConnectionGateRef.current,
      connectionKey,
      () => subscribe(language, viewer),
    ).catch(() => {
      setError("실시간 자막에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    });
  }, [gatewayLifecycleRevision, runtimePermission, isSessionEnded, language, sessionStatus, stopGatewayLifecycle, subscribe, viewer]);

  const join = useCallback(async () => {
    const normalizedEmail = normalizeEmail(email);
    const normalizedDisplayName = normalizeProfileField(displayName);
    const normalizedCompany = normalizeProfileField(company);
    const normalizedDepartment = normalizeProfileField(department);
    const normalizedJobTitle = normalizeProfileField(jobTitle);
    const normalizedAdmissionCode = admissionCode.replace(/\D/gu, "").slice(0, 6);
    if (!/^\S+@\S+\.\S+$/u.test(normalizedEmail)) {
      setError("올바른 이메일 주소를 입력해 주세요.");
      return;
    }
    if (!normalizedDisplayName) {
      setError("이름을 입력해 주세요.");
      return;
    }
    if (normalizedDisplayName.length > 40) {
      setError("이름은 40자 이하로 입력해 주세요.");
      return;
    }
    if (normalizedCompany.length > 100) {
      setError("회사명은 100자 이하로 입력해 주세요.");
      return;
    }
    if (normalizedDepartment.length > 80) {
      setError("부서는 80자 이하로 입력해 주세요.");
      return;
    }
    if (normalizedJobTitle.length > 100) {
      setError("직급은 100자 이하로 입력해 주세요.");
      return;
    }
    const isInviteJoin = Boolean(pendingInviteToken);
    if (!isInviteJoin && normalizedAdmissionCode.length !== 6) {
      setError("호스트가 공유한 6자리 인증코드를 입력해 주세요.");
      return;
    }
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      setError("참여자 연결이 설정되지 않았습니다.");
      return;
    }
    setIsBusy(true);
    setError("");
    let hasRedeemedGrant = false;
    try {
      const supabase = supabaseRef.current ?? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
      });
      supabaseRef.current = supabase;
      const existing = await supabase.auth.getSession();
      let accessToken = existing.data.session?.access_token ?? "";
      if (!accessToken) {
        const signedIn = await supabase.auth.signInAnonymously();
        if (signedIn.error || !signedIn.data.session) throw new Error("Unable to start guest access.");
        accessToken = signedIn.data.session.access_token;
      }
      const result = await readApi<unknown>(await fetch("/api/live-sessions/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(isInviteJoin ? { inviteToken: pendingInviteToken } : { accessCode: normalizedAdmissionCode }),
          email: normalizedEmail,
          displayName: normalizedDisplayName,
          company: normalizedCompany,
          department: normalizedDepartment,
          jobTitle: normalizedJobTitle,
          privacyConsent,
          summaryConsent: summaryDeliveryConsent,
          marketingConsent,
          consentNoticeVersions: {
            privacy: PARTICIPANT_CONSENT_NOTICES.privacy.version,
            summaryDelivery: PARTICIPANT_CONSENT_NOTICES.summaryDelivery.version,
            marketing: PARTICIPANT_CONSENT_NOTICES.marketing.version,
          },
          deviceId: makeDeviceId(),
          accessToken,
        }),
      }));
      if (!isViewerJoinData(result)) throw new Error("The guest join response is invalid.");
      hasRedeemedGrant = true;
      setEmail(result.self.email);
      setDisplayName(result.self.displayName);
      setCompany(result.self.company);
      setDepartment(result.self.department);
      setJobTitle(result.self.jobTitle);
      setPrivacyConsent(true);
      setSummaryDeliveryConsent(result.self.summaryConsent);
      const nextViewer = result;
      viewerSessionIdRef.current = result.session.id;
      const requestedLanguage = requestedLanguageRef.current
        || new URLSearchParams(window.location.search).get("language");
      const firstLanguage = requestedLanguage && result.session.languages.includes(requestedLanguage)
        ? requestedLanguage
        : result.session.languages[0];
      if (!firstLanguage) throw new Error("No viewing language is available.");
      updateSessionStatus(result.session.status ?? "live");
      setStatus(captionConnectionLabel(result.session.status ?? "live"));
      setViewer(nextViewer);
      setLanguage(firstLanguage);
      languageRef.current = firstLanguage;
      const firstLaneId = `translation:${firstLanguage}`;
      selectedLaneIdRef.current = firstLaneId;
      setSelectedLaneId(firstLaneId);
      expandedTopicIdsRef.current = [];
      setExpandedTopicIds([]);
      anchorUtteranceKeyRef.current = "";
      writeViewerRecoveryContext(localStorage, {
        sessionId: result.session.id,
        language: firstLanguage,
        preferredTargetLanguage: firstLanguage,
        selectedLaneId: firstLaneId,
        expandedTopicIds: [],
        anchorUtteranceKey: "",
        anchorsByLane: {},
      });
    } catch (joinError) {
      if (joinError instanceof ApiRequestError) {
        // A closed admission almost always means the host ended the session:
        // show a proper ended screen instead of a generic join error.
        if (joinError.code === "ADMISSION_CLOSED") {
          setJoinEndedNotice(true);
          return;
        }
        setError(getJoinErrorMessage(joinError));
      } else if (!hasRedeemedGrant) {
        setError("QR 초대가 유효하지 않거나 만료되었습니다.");
      } else {
        setError(getJoinErrorMessage(joinError));
      }
    } finally {
      setIsBusy(false);
    }
  }, [admissionCode, company, department, displayName, email, jobTitle, marketingConsent, pendingInviteToken, privacyConsent, summaryDeliveryConsent, updateSessionStatus]);

  useEffect(() => {
    if (getViewerSurfaceRedirect(
      window.location.pathname,
      window.navigator.userAgent,
      window.navigator.maxTouchPoints,
    )) return;
    const params = new URLSearchParams(window.location.search);
    requestedLanguageRef.current = params.get("language") ?? "";
    const admissionLink = parseAdmissionLinkHash(window.location.hash);
    if (window.location.hash !== admissionLink.canonicalHash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${admissionLink.canonicalHash}`);
    }
    if (admissionLink.kind === "invalid") {
      setError("This QR invite is invalid or has expired.");
      return;
    }
    if (admissionLink.kind === "invite") setPendingInviteToken(admissionLink.inviteToken);
    if (admissionLink.kind === "code") setAdmissionCode((current) => current || admissionLink.accessCode);
  }, []);

  const changeLanguage = useCallback(async (nextLanguage: string) => {
    if (!viewer) return;
    const nextLaneId = `translation:${nextLanguage}`;
    selectedLaneIdRef.current = nextLaneId;
    setSelectedLaneId(nextLaneId);
    anchorUtteranceKeyRef.current = anchorsByLaneRef.current[nextLaneId] ?? "";
    pendingRecoveryAnchorRef.current = anchorUtteranceKeyRef.current;
    writeViewerRecoveryContext(localStorage, {
      sessionId: viewer.session.id,
      language: nextLanguage,
      preferredTargetLanguage: nextLanguage,
      selectedLaneId: nextLaneId,
      expandedTopicIds: expandedTopicIdsRef.current,
      anchorUtteranceKey: anchorUtteranceKeyRef.current,
      anchorsByLane: anchorsByLaneRef.current,
    });
    if (nextLanguage === language) return;
    languageRef.current = nextLanguage;
    setLanguage(nextLanguage);
    setError("");
    if (isSessionEnded) {
      setSummaryRecord(null);
      setTranscript([]); setRecordingGaps([]);
      setTranscriptTopics([]);
      setMinutesEvent(null);
      setIsTranscriptLoaded(false);
      setSummaryError("");
      setTranscriptError("");
      setMinutesPollingState("polling");
      setMinutesPollingStartedAt(Date.now());
      setMinutesPollingRound((round) => round + 1);
      void loadMinutes(nextLanguage);
      return;
    }
  }, [isSessionEnded, language, loadMinutes, viewer]);

  const leaveMeeting = useCallback(async () => {
    const currentViewer = viewer;
    if (currentViewer) {
      try {
        await readApi<unknown>(await fetch(`/api/live-sessions/${currentViewer.session.id}/leave`, {
          method: "POST",
        }));
      } catch {
        setStatus("세션에서 나감");
      }
    }
    endSpeaking(true);
    stopGatewayLifecycle();
    clearViewerPrivateState();
    setViewer(null);
    setHasLeftSession(true);
    setError("");
  }, [clearViewerPrivateState, endSpeaking, stopGatewayLifecycle, viewer]);

  useEffect(() => () => stopGatewayLifecycle(), [stopGatewayLifecycle]);

  useEffect(() => () => endSpeaking(true), [endSpeaking]);

  useEffect(() => {
    if (speakState === "idle") return;
    speakStopButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        event.preventDefault();
        speakStopButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      endSpeaking(true);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [endSpeaking, speakState]);

  useEffect(() => {
    if (speakStateRef.current === "idle") return;
    if (!viewer || isSessionEnded || sessionStatus !== "live"
      || viewer.session.participantSpeakingEnabled !== true) {
      endSpeaking(true);
    }
  }, [endSpeaking, isSessionEnded, sessionStatus, viewer]);

  useEffect(() => {
    if (!viewer || window.parent === window) return;
    window.parent.postMessage({
      type: "realtime-noel-viewer-state",
      sessionType,
      outputMode,
    }, "*");
  }, [outputMode, sessionType, viewer]);

  const translationLanes = useMemo(() => buildTranslationLanes(null, languages).map((lane) => ({
    ...lane,
    label: lane.kind === "source" ? "원문" : languageLabel(lane.language),
  })), [languages]);
  const selectedLane = translationLanes.find((lane) => lane.id === selectedLaneId) ?? translationLanes[0] ?? null;
  const selectedLaneInputs = useMemo<CaptionLaneInput[]>(() => {
    if (!selectedLane || selectedLane.kind === "source") return [];
    const events = captionsByLanguage[selectedLane.language] ?? [];
    return events.map((caption, index) => captionLaneInput(caption, index, events.length));
  }, [captionsByLanguage, selectedLane]);
  const targetLaneCaptions = useMemo(() => selectedLane?.kind === "translation"
    ? projectCaptionLane(selectedLaneInputs, selectedLane) : [], [selectedLaneInputs, selectedLane]);
  const sourceFinalCaptions = useMemo(() => sourceLedger.map(presentViewerSourceEvent), [sourceLedger]);
  const sourceLaneCaptions = useMemo(() => {
    const draft = sourceDraftState.draft;
    if (!draft) return sourceFinalCaptions;
    return [...sourceFinalCaptions, {
      id: `source-draft:${draft.generation}`, text: draft.text, language: draft.sourceLanguage,
      speakerLabel: draft.speaker.label, timestamp: formatMinuteTime(draft.emittedAt), isFinal: false,
    }];
  }, [sourceFinalCaptions, sourceDraftState.draft]);
  const selectedLaneCaptions = selectedLane?.kind === "source" ? sourceLaneCaptions : targetLaneCaptions;

  useEffect(() => {
    const pendingAnchor = pendingRecoveryAnchorRef.current;
    if (!pendingAnchor) return;
    const target = Array.from(document.querySelectorAll<HTMLElement>("[role=tabpanel]:not([hidden]) [data-utterance-key]"))
      .find((element) => element.dataset.utteranceKey === pendingAnchor);
    if (!target) return;
    target.scrollIntoView({ block: "nearest" });
    pendingRecoveryAnchorRef.current = "";
  }, [selectedLaneCaptions]);

  const rememberReadingAnchor = useCallback((utteranceKey: string) => {
    const sessionId = viewerSessionIdRef.current;
    const laneId = selectedLaneIdRef.current;
    if (!sessionId || anchorsByLaneRef.current[laneId] === utteranceKey) return;
    anchorsByLaneRef.current = { ...anchorsByLaneRef.current, [laneId]: utteranceKey };
    anchorUtteranceKeyRef.current = utteranceKey;
    writeViewerRecoveryContext(localStorage, {
      sessionId,
      language: languageRef.current,
      preferredTargetLanguage: languageRef.current,
      selectedLaneId: laneId,
      expandedTopicIds: expandedTopicIdsRef.current,
      anchorUtteranceKey: utteranceKey,
      anchorsByLane: anchorsByLaneRef.current,
    });
  }, []);

  const selectTranslationLane = useCallback((lane: TranslationLanePresentation) => {
    if (!viewer) return;
    selectedLaneIdRef.current = lane.id;
    setSelectedLaneId(lane.id);
    anchorUtteranceKeyRef.current = anchorsByLaneRef.current[lane.id] ?? "";
    pendingRecoveryAnchorRef.current = anchorUtteranceKeyRef.current;
    if (lane.kind === "translation") {
      void changeLanguage(lane.language);
      return;
    }
    writeViewerRecoveryContext(localStorage, {
      sessionId: viewer.session.id,
      language,
      preferredTargetLanguage: language,
      selectedLaneId: lane.id,
      expandedTopicIds: expandedTopicIdsRef.current,
      anchorUtteranceKey: anchorUtteranceKeyRef.current,
      anchorsByLane: anchorsByLaneRef.current,
    });
  }, [changeLanguage, language, viewer]);

  const updateExpandedTopic = useCallback((topicId: string, isExpanded: boolean) => {
    if (!viewer) return;
    const next = isExpanded
      ? [...new Set([...expandedTopicIdsRef.current, topicId])]
      : expandedTopicIdsRef.current.filter((value) => value !== topicId);
    expandedTopicIdsRef.current = next;
    setExpandedTopicIds(next);
    writeViewerRecoveryContext(localStorage, {
      sessionId: viewer.session.id,
      language,
      preferredTargetLanguage: language,
      selectedLaneId: selectedLaneIdRef.current,
      expandedTopicIds: next,
      anchorUtteranceKey: anchorUtteranceKeyRef.current,
      anchorsByLane: anchorsByLaneRef.current,
    });
  }, [language, viewer]);

  const renderTopicLane = useCallback((lane: TranslationLanePresentation) => (
    <>
      {lane.kind === "source" && sourceError && <div role="alert">
        <p>{t(sourceError)}</p>
        <button type="button" disabled={isSourceLoading} onClick={() => {
          if (viewerSessionIdRef.current && !sourceSnapshotAbortRef.current) void synchronizeSourceLedger(viewerSessionIdRef.current, 0);
        }}>{t("원문 다시 불러오기")}</button>
      </div>}
      <ViewerReadingFeed key={lane.id} captions={selectedLaneCaptions} language={lane.language} kind={lane.kind}
        onReadingAnchorChange={rememberReadingAnchor} />
    </>
  ), [isSourceLoading, rememberReadingAnchor, selectedLaneCaptions, sourceError, synchronizeSourceLedger]);

  if (isRestoringViewer) {
    return (
      <main className={`live-viewer-shell live-viewer-restoring ${compact ? "is-compact" : ""}`}>
        <p role="status" aria-live="polite">{t("라이브 세션으로 돌아가는 중입니다.")}</p>
      </main>
    );
  }

  if (recoveryError && !viewer) {
    return <main className="live-viewer-shell viewer-recovery-error"><p role="alert">{t(recoveryError)}</p>
      <button type="button" onClick={() => void restoreViewerSession()}>{t("다시 불러오기")}</button>
      <button type="button" onClick={() => { clearViewerPrivateState(); setRecoveryError(""); }}>{t("다른 회의 참여")}</button>
    </main>;
  }

  if (hasLeftSession) {
    return (
      <main className={`live-viewer-shell live-viewer-closed ${compact ? "is-compact" : ""}`}>
        <p>{t("세션에서 나갔습니다.")}</p>
        {/* Leaving must not be a dead end. A participant who drops mid-call
            returns to this same URL, and re-entering the host's access code
            restores their seat and record. Clearing hasLeftSession with viewer
            still null falls through to the join card, which already supports
            both the invite link and the 6-digit code. This also rescues a
            failed POST /leave, which previously stranded the user here with a
            grant the server never released. */}
        <button type="button" className="live-primary-action" onClick={() => {
          setHasLeftSession(false);
          setError("");
          setStatus("다시 참여하려면 인증 코드를 입력하세요");
        }}>
          {t("다시 참여")}
        </button>
      </main>
    );
  }

  if (joinEndedNotice && !viewer) {
    // Dedicated ended screen for new entrants who reach a finished session.
    return (
      <main className={`live-viewer-shell live-viewer-closed ${compact ? "is-compact" : ""}`}>
        <section className="live-session-ended-screen" role="status">
          <span className="live-minutes-ended-dot" aria-hidden="true" />
          <strong>{t("라이브 세션이 종료되었습니다")}</strong>
          <p>{t("호스트가 세션을 종료했습니다. 다음 세션의 새 초대 링크를 호스트에게 요청해 주세요.")}</p>
          <button type="button" onClick={() => { setJoinEndedNotice(false); setError(""); }}>{t("돌아가기")}</button>
        </section>
      </main>
    );
  }

  if (!viewer) {
    const hasValidProfile = /^\S+@\S+\.\S+$/u.test(normalizeEmail(email)) && normalizeProfileField(displayName).length > 0;
    const isInviteJoin = Boolean(pendingInviteToken);
    const canJoin = hasValidProfile && privacyConsent && (isInviteJoin || admissionCode.replace(/\D/gu, "").length === 6);
    return (
      <main className={`live-viewer-shell is-join ${compact ? "is-compact" : ""}`}>
        {/* Split lobby: identity panel + join card. Participants arriving by
            QR/invite land here as their MAIN screen — the name field leads. */}
        <div className="live-join-lobby">
        <section className="live-join-context" aria-label={t("라이브 콜 안내")}>
          <header className="live-join-brand"><span className="live-join-wordmark">NOVA</span></header>
          <div className="live-join-context-body">
            <h1 className="live-join-heading">{t("라이브 콜")}</h1>
            <p className="live-join-lede">{t("실시간 번역 자막과 함께하는 라이브 세션입니다. 이름을 입력하면 바로 참여할 수 있어요.")}</p>
          </div>
          {/* Role switch: hosts land on the participant join screen too, so the
              admin route must be visible here instead of a memorized URL. */}
          <p className="live-join-admin">
            {t("호스트이신가요?")} <a href="/login">{t("관리자로 로그인")}</a>
          </p>
          <footer className="live-join-credit">Realtime by Noel</footer>
        </section>
        <section className="live-join-card" aria-label={t("참여 정보 입력")}>
            {isInviteJoin && (
              <p className="live-join-invite-chip" role="status">
                <span className="live-status-dot is-live" aria-hidden="true" />
                {t("초대 링크가 확인되었어요 · 인증 코드 없이 입장합니다")}
              </p>
            )}
            <label htmlFor="live-display-name">{t("이름")}</label>
            <input id="live-display-name" name="displayName" className="live-name-input live-join-name-hero" autoComplete="name" maxLength={40} value={displayName}
              onChange={(event) => { setDisplayName(event.target.value); setError(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") void join(); }}
              placeholder={t("자막에 표시될 이름")} required />
            <label htmlFor="live-email">{t("이메일")}</label>
            <input id="live-email" name="email" className="live-name-input" type="email" autoComplete="email" maxLength={254} value={email}
              onChange={(event) => { setEmail(event.target.value); setError(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") void join(); }}
              placeholder="name@company.com" required />
            <details className="live-join-optional-profile">
              <summary>{t("선택 정보")}</summary>
              <div>
                <label htmlFor="live-company">{t("회사")}</label>
                <input id="live-company" name="company" className="live-name-input" autoComplete="organization" maxLength={100} value={company}
                  onChange={(event) => { setCompany(event.target.value); setError(""); }} />
                <label htmlFor="live-department">{t("부서")}</label>
                <input id="live-department" name="department" className="live-name-input" autoComplete="organization-title" maxLength={80} value={department}
                  onChange={(event) => { setDepartment(event.target.value); setError(""); }} />
                <label htmlFor="live-job-title">{t("직급")}</label>
                <input id="live-job-title" name="jobTitle" className="live-name-input" autoComplete="organization-title" maxLength={100} value={jobTitle}
                  onChange={(event) => { setJobTitle(event.target.value); setError(""); }} />
              </div>
            </details>
            {!isInviteJoin && (
              <>
                <label htmlFor="live-access-code">{t("6자리 인증 코드")}</label>
                <input id="live-access-code" name="accessCode" className="live-code-input" autoComplete="one-time-code" inputMode="numeric"
                  pattern="[0-9]{6}" maxLength={6} value={admissionCode}
                  onChange={(event) => { setAdmissionCode(event.target.value.replace(/\D/gu, "").slice(0, 6)); setError(""); }}
                  onKeyDown={(event) => { if (event.key === "Enter") void join(); }}
                  placeholder="000000" required />
              </>
            )}
            <ParticipantConsentFields notices={PARTICIPANT_CONSENT_NOTICES}
              privacyConsent={privacyConsent} summaryDeliveryConsent={summaryDeliveryConsent}
              marketingConsent={marketingConsent} onPrivacyConsentChange={setPrivacyConsent}
              onSummaryDeliveryConsentChange={setSummaryDeliveryConsent}
              onMarketingConsentChange={setMarketingConsent} />
            <button type="button" className="live-primary-action"
              disabled={isBusy || !canJoin}
              onClick={() => void join()}>
              {isBusy ? t("참여 중…") : t("라이브 참여")}
            </button>
            {error && <div className="live-error" role="alert">{t(error)}</div>}
          </section>
        </div>
      </main>
    );
  }

  const floorHolderLabel = floorHolder?.name?.trim() || floorHolder?.displayName?.trim() || "";
  const speakingIdentity = activeSpeakerName || floorHolderLabel || viewer.self.displayName || viewer.self.email;
  const speakingMetadata = formatProfileMetadata(viewer.self.company, viewer.self.department, viewer.self.jobTitle);
  const canUseSpeakingFloor = viewer.session.participantSpeakingEnabled === true
    && !isSessionEnded && sessionStatus === "live";

  return (
    <main className={`live-viewer-shell ${compact ? "is-compact" : ""}`}
      data-viewer-surface="caption-first" data-reading-state={isSessionEnded ? "ended" : "live"} data-compact={compact || undefined}
      style={{ "--live-caption-scale": captionScale } as CSSProperties}>
      <div className="live-viewer-translation-layout viewer-notebook">
        <TranslationToolbar ariaLabel={t("실시간 자막 제어")}>
          <strong>NOVA</strong>
          <span className="viewer-session-status">{isSessionEnded ? t("회의 종료") : t("라이브")}</span>
          <ControlDrawer triggerLabel={t("더보기")} title={t("세션 제어")}>
            <ViewerSessionContext title={viewer.session.title} scheduledAt={viewer.session.scheduledAt} />
            <label className="live-viewer-text-scale" htmlFor="live-caption-scale">
              <span>{t("자막 글자 크기")}</span>
              <input id="live-caption-scale" name="captionScale" type="range"
                min={CAPTION_SCALE_MIN} max={CAPTION_SCALE_MAX} step={0.1}
                value={captionScale}
                onChange={(event) => setCaptionScale(Number(event.currentTarget.value))} />
            </label>
            {viewer.viewerCount !== undefined && <p>{t("{current}/{maximum}명 참여", { current: viewer.viewerCount, maximum: viewer.session.maxViewers })}</p>}
            <button type="button" className="live-leave-button" onClick={() => void leaveMeeting()}>{t("세션 나가기")}</button>
          </ControlDrawer>
          <GatewayConnectionStatus state={gatewayConnectionState}
            detail={<p>{formatViewerSystemStatus(status, t)} {t("· 기존 자막은 화면에 유지됩니다.")}</p>} />
        </TranslationToolbar>
      {speakState !== "idle" && canUseSpeakingFloor && (
        <div className="live-speak-scrim" role="presentation">
          <section className="live-speak-sheet" role="dialog" aria-modal="true" data-registered-identity={viewer.self.email}
            aria-labelledby="live-speak-title" aria-describedby="live-speak-state">
            <div className="live-speak-sheet-handle" aria-hidden="true" />
            <header>
              <div>
                <strong id="live-speak-title">{speakingIdentity}</strong>
                {speakingMetadata && <span>{speakingMetadata}</span>}
              </div>
              <span>{t("발언권 1명")}</span>
            </header>
            <VoiceLevelCanvas level={speakLevel} />
            <p id="live-speak-state" role="status" aria-live="polite">
              {speakState === "speaking" ? t("발언 중") : t("발언 연결 중")}
            </p>
            <button ref={speakStopButtonRef} type="button" className="live-speak-stop"
              aria-label={t("발언 종료")} onClick={() => endSpeaking(true)}>
              <span><Stop size={24} weight="fill" aria-hidden="true" /></span>
            </button>
          </section>
        </div>
      )}
      {error && <div className="live-error" role="alert">{t(error)}</div>}
      <header className="viewer-meeting-heading">
        <h1>{viewer.session.title}</h1>
        {viewer.session.companyName && <p>{viewer.session.companyName}</p>}
        {isSessionEnded && <div className="viewer-access-notice">
          {recordsExpiresAt ? <><p>{t("열람 가능 기한")} <time dateTime={recordsExpiresAt}>{new Date(recordsExpiresAt).toLocaleString(systemLocale, { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</time></p>
            <p>{viewer.session.endedAt ? t("{time} 종료 · 종료 후 6시간", { time: formatMinuteTime(viewer.session.endedAt) }) : t("종료 후 6시간")}</p></> : <p>{t("기록 열람 기한을 확인하고 있어요.")}</p>}
          <p>{t("새로고침해도 열람 기한까지 기록을 이어서 볼 수 있어요.")}</p>
        </div>}
      </header>
      {isSessionEnded ? (
        <div className="live-ended-view">
          <ParticipantMeetingMinutes sessionId={viewer.session.id} email={viewer.self.email}
            summary={summaryRecord?.summary ?? null} transcript={transcript} topics={transcriptTopics} recordingGaps={recordingGaps}
            isTranscriptLoaded={isTranscriptLoaded} summaryError={summaryError} transcriptError={transcriptError}
            isSummaryEmpty={isSummaryEmpty}
            isLoading={isMinutesLoading || minutesPollingState === "polling"} isExpired={isRecordsExpired}
            onRetry={() => {
              setSummaryError(""); setTranscriptError(""); setMinutesPollingState("polling");
              setMinutesPollingStartedAt(Date.now()); setMinutesPollingRound((round) => round + 1);
              void loadMinutes(languageRef.current, summaryRecord ? "transcript" : isTranscriptLoaded ? "summary" : "both");
            }} />
        </div>
      ) : sessionStatus === "preparing" ? (
        <section className="live-waiting-screen" aria-label={t("호스트 시작 대기")}>
          {/* The join redemption payload does not carry hasCoverImage, so the
              waiting room always attempts the cover (public-by-UUID route)
              and simply hides it when the session has none. */}
          {!isWaitingCoverUnavailable && (
            <>
              <img className="live-waiting-cover"
                src={`/api/live-sessions/${viewer.session.id}/cover${viewer.session.coverImageVersion ? `?v=${viewer.session.coverImageVersion}` : ""}`}
                alt="" aria-hidden="true"
                onError={() => setIsWaitingCoverUnavailable(true)} />
              <div className="live-waiting-scrim" aria-hidden="true" />
            </>
          )}
          <h2>{viewer.session.title}</h2>
          <p className="live-waiting-schedule">{formatSessionSchedule(viewer.session.scheduledAt, systemLanguage)}</p>
          {(() => {
            const remainingMs = countdownMsUntil(viewer.session.scheduledAt, waitingClockMs);
            return remainingMs !== null && remainingMs > 0 ? (
              <div className="live-waiting-ring" aria-hidden="false">
                <span className="live-loading-ring" aria-hidden="true" />
                <p className="live-waiting-countdown" role="timer" aria-label={t("예정 시작까지 남은 시간")}>
                  {formatCountdown(remainingMs)}
                </p>
              </div>
            ) : (
              <span className="live-waiting-pulse" aria-hidden="true" />
            );
          })()}
          <strong role="status">{t("호스트 시작을 기다리는 중")}</strong>
          <p>{t("호스트가 시작하면 자막이 자동으로 표시됩니다.")}</p>
          <button type="button" className="live-leave-button" onClick={() => void leaveMeeting()}>{t("나가기")}</button>
        </section>
      ) : (
        <>
          {sessionStatus === "failed" && (
            <div className="live-error" role="status" aria-live="polite">
              {t("라이브 세션에 문제가 발생해 종료되었습니다. 기존 자막은 계속 볼 수 있습니다.")}
            </div>
          )}
          <div id="live-viewer-caption-region" className="live-viewer-caption-region">
            <ViewerLiveSurface sessionStatus={sessionStatus} selectedLane={selectedLane}
              unavailableLanguages={unavailableLanguages} incompleteLanguages={incompleteLanguages} lanes={translationLanes}
              selectedLaneId={selectedLaneId} onSelectLane={selectTranslationLane}
              renderPanel={renderTopicLane} />
          </div>
          <div className="viewer-microphone-slot">
            {canUseSpeakingFloor && <ParticipantSpeakButton state={speakState}
              disabled={speakState === "idle" && gatewayConnectionState !== "connected"}
              onClick={() => void toggleSpeak()} />}
          </div>
        </>
      )}
      </div>
    </main>
  );
}
