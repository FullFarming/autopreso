"use client";

import { useSystemLanguage, useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { formatHostGlossaryLabel, hostMessages } from "@/lib/system-language/host-messages";
import { inviteMessages } from "@/lib/system-language/invite-messages";
import { InviteQrDialog } from "./InviteQrDialog";
import { buildAdmissionJoinUrl } from "./admission-link";


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import WorkspaceViewport from "@/components/ui/WorkspaceViewport";

import type {
  ApiResponse,
  CaptionEvent,
  GlossaryPack,
  LiveEventType,
  LiveHostParticipantActivity,
  LiveOutputMode,
  LiveSession,
  LiveSessionType,
  LiveSpeechActivity,
  SpeakerAssignment,
} from "@/lib/live-contract";
import { LANGUAGE_CODES, LANGUAGE_LABELS } from "@/lib/languageDetect";
import { LIVE_CALL_ENABLED } from "@/lib/live/feature-flag";
import { mergeLanguageCaptionCache } from "@/lib/live/caption-feed";
import { createHostDemandControl } from "./host-demand-control";
import {
  LiveAudioRecoveryError,
  startLiveAudioClient,
  type LiveAudioClient,
  type LiveAudioRecoveryStatus,
  type LiveInputSource,
} from "./live-audio-client";
import MeetingMinutes from "./MeetingMinutes";
import { LanguagePicker } from "./LanguagePicker";
import { withRequiredLanguages } from "./language-picker";
import { resolveSpeakerColor } from "./SpeakerCaption";
import { getDefaultLiveSchedule, validateLiveSchedule } from "./live-session-schedule";
import {
  buildHostInviteShareText,
  mergePolledHostSession,
  resolveHostParticipantPresentation,
} from "./host-surface";
import { resolveHostSurface } from "./host-surface";
import { getCurrentHostInvite, shareHostInvitation, type HostInvitation } from "./invite-share";
import {
  appendRecoverableHostSessions,
  buildHostSessionIdentityPatch,
  canApplyHostRecovery,
  getHostSessionScheduleFields,
  resolveHostSessionRecovery,
} from "./host-session-recovery";
import type { HostAiHealthRows } from "./quality/HostAiHealthDisclosure";
import { HostLiveLaneSurface } from "./live-lanes";
import type { GatewayConnectionState } from "./status";
import {
  GatewayConnectionStatus,
  ScheduledGatewayCountdown,
  type ScheduledGatewayCountdownState,
} from "./status";
import type { TranslationLanePresentation } from "./translation";
import { useHostSummaryLifecycle } from "./useHostSummaryLifecycle";
import { ConnectedGlossarySessionChecklist, ConnectedGlossaryWorkspace, pinSessionGlossaries } from "./glossary";
import type { GlossarySessionPinSelection, GlossarySessionSelection } from "./glossary/glossary-presentation";
import {
  canCancelScheduledGatewayStart,
  createScheduledGatewayStartTransport,
  resolveScheduledGatewayStart,
  warmScheduledGateway,
} from "./scheduled-gateway-start";

const LANGUAGE_OPTIONS = LANGUAGE_CODES.map((code) => ({ code, label: LANGUAGE_LABELS[code] }));
const REQUIRED_SESSION_LANGUAGES = ["en", "ko"];

const SESSION_TYPE_OPTIONS: Array<{ value: LiveSessionType; title: string; stateLabel: string }> = [
  { value: "presentation", title: "발표", stateLabel: "1인 발표" },
  { value: "meeting", title: "회의", stateLabel: "발표자 구분" },
];

const EVENT_TYPE_OPTIONS: Array<{ value: LiveEventType; label: string }> = [
  { value: "other", label: "글로벌 타운홀 · 기타" },
  { value: "conference", label: "컨퍼런스 · 사업설명회" },
  { value: "investor_day", label: "투자자 설명회" },
  { value: "earnings_call", label: "실적발표 · 어닝콜" },
];

function parseAgendaText(value: string): string[] {
  return value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean).slice(0, 20);
}

function agendaTextFromSession(session: LiveSession): string {
  return (session.agenda ?? []).map((item) => item.label).join("\n");
}

function buildLiveSessionDomainText(session: Pick<LiveSession,
  "title" | "companyName" | "ticker" | "fiscalPeriod" | "eventType" | "agenda"
>): string {
  const eventLabel = EVENT_TYPE_OPTIONS.find((option) => option.value === session.eventType)?.label;
  const lines = [
    `Session: ${session.title}`,
    session.companyName ? `Company: ${session.companyName}` : "",
    session.ticker ? `Ticker: ${session.ticker}` : "",
    session.fiscalPeriod ? `Reporting period: ${session.fiscalPeriod}` : "",
    eventLabel ? `Event type: ${eventLabel}` : "",
    ...(session.agenda ?? []).map((item) => `Agenda ${item.ordinal}: ${item.label}`),
  ];
  return lines.filter(Boolean).join("\n").slice(0, 2_000);
}

// Live Call is captions-only. The host sends one microphone/USB-mixer stream;
// viewers receive translated text and records, with no synthesized sound lane.
const OUTPUT_OPTIONS: Array<{ value: LiveOutputMode; title: string; stateLabel: string }> = [
  { value: "captions", title: "자막", stateLabel: "실시간" },
];
const GEMINI_VOICE_PROVIDER = "gemini" as const;

function isValidViewerCapacity(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 200;
}

function getDeliveryMethod(sessionType: LiveSessionType): { title: string; status: string } {
  if (sessionType === "presentation") {
    return { title: "빠른 실시간 자막", status: "1인 발표" };
  }
  return { title: "발표자 구분 자막", status: "발화 단위" };
}

interface AdmissionState {
  code: string;
  openUntil: string;
}

interface InviteResult {
  admissionOpenUntil: string;
  inviteToken: string;
  admissionCode: string;
  expiresAt: string;
  version: number;
}

interface ParticipantActivity {
  participants: LiveHostParticipantActivity[];
  recentSpeeches: LiveSpeechActivity[];
}

interface GatewayCredentials {
  token: string;
  gatewayUrl: string;
  expiresAt: string;
}

interface ScheduledStartRuntime {
  sessionId: string;
  generation: number;
  hasWarmed: boolean;
  attemptedThrough: number;
  manualStartedAt: number | null;
  hasGatewayStartedAck: boolean;
  isCancelled: boolean;
  isFlightPending: boolean;
  pendingAction: "warm" | "start" | null;
  hasAttemptedReattach: boolean;
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
  preparing: "준비 중",
  ready: "정상",
  unavailable: "사용 불가",
};

function languageStatusMap(languages: string[], status: LanguageStatus): Record<string, LanguageStatus> {
  return Object.fromEntries(languages.map((language) => [language, status]));
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as ApiResponse<T>;
  if (!payload.ok) throw new Error(payload.error);
  return payload.data;
}

function formatTime(value: string | null): string {
  if (!value) return "종료됨";
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function formatSessionStatus(status: LiveSession["status"]): string {
  if (status === "live") return "진행 중";
  if (status === "preparing") return "준비 중";
  if (status === "paused") return "일시 정지";
  if (status === "stopped") return "종료됨";
  return "실패";
}

export function InviteQrCode({ value }: { value: string }) {
  const t = useSystemText(hostMessages);
  const [dataUrl, setDataUrl] = useState("");
  const [qrError, setQrError] = useState("");

  useEffect(() => {
    let isDisposed = false;
    setDataUrl("");
    setQrError("");
    void QRCode.toDataURL(value, {
      width: 176,
      margin: 4,
      errorCorrectionLevel: "M",
      color: { dark: "#0c0a09", light: "#ffffff" },
    }).then((nextDataUrl) => {
      if (!isDisposed) setDataUrl(nextDataUrl);
    }).catch(() => {
      if (!isDisposed) setQrError("QR 코드를 만들지 못했습니다. 초대 링크를 복사해 주세요.");
    });
    return () => { isDisposed = true; };
  }, [value]);

  return (
    <figure className="live-invite-qr" data-qr-value={value}>
      {dataUrl ? <img src={dataUrl} alt={t("NOVA 참여자 초대 QR 코드")} width={176} height={176} />
        : qrError ? <span role="alert">{t(qrError)}</span>
          : <span role="status">{t("QR 코드 생성 중…")}</span>}
      <figcaption>{t("QR을 스캔하거나 링크를 공유하세요 · 참여자는 각자 정보를 입력합니다")}</figcaption>
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

async function pinGlossariesToSession(activeSession: LiveSession, glossaries: readonly GlossarySessionPinSelection[]): Promise<LiveSession> {
  if (activeSession.status !== "preparing") throw new Error("준비 중인 세션에서만 용어집을 변경할 수 있습니다.");
  const pinned = await pinSessionGlossaries(fetch, activeSession.id, activeSession.version, glossaries);
  return { ...activeSession, version: pinned.version };
}

export default function LiveHostDashboard() {
  const t = useSystemText(hostMessages);
  const { language: systemLanguage } = useSystemLanguage();
  const inviteText = useSystemText(inviteMessages);
  const [title, setTitle] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [ticker, setTicker] = useState("");
  const [fiscalPeriod, setFiscalPeriod] = useState("");
  const [eventType, setEventType] = useState<LiveEventType>("other");
  const [agendaText, setAgendaText] = useState("");
  const [sessionDate, setSessionDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [scheduleNow, setScheduleNow] = useState<number | null>(null);
  const [sessionType, setSessionType] = useState<LiveSessionType>("presentation");
  const [outputMode, setOutputMode] = useState<LiveOutputMode>("captions");
  const [participantSpeakingEnabled, setParticipantSpeakingEnabled] = useState(false);
  const [maxViewers, setMaxViewers] = useState(200);
  const [glossaryPack, setGlossaryPack] = useState<GlossaryPack>("general_cre");
  const [isEditingSession, setIsEditingSession] = useState(false);
  const inputSource: LiveInputSource = "mic";
  const [selectedLanguages, setLanguages] = useState<string[]>([...REQUIRED_SESSION_LANGUAGES]);
  const languages = useMemo(() => withRequiredLanguages(selectedLanguages, REQUIRED_SESSION_LANGUAGES), [selectedLanguages]);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [speakers, setSpeakers] = useState<SpeakerAssignment[]>([]);
  const [endedSession, setEndedSession] = useState<{ id: string; languages: string[] } | null>(null);
  const [admission, setAdmission] = useState<AdmissionState | null>(null);
  const [invite, setInvite] = useState<HostInvitation | null>(null);
  const [inviteFeedback, setInviteFeedback] = useState("");
  const [isSharingInvite, setIsSharingInvite] = useState(false);
  const [isInviteQrOpen, setIsInviteQrOpen] = useState(false);
  const inviteSharePendingRef = useRef(false);
  const [participants, setParticipants] = useState<LiveHostParticipantActivity[]>([]);
  const [recentSpeeches, setRecentSpeeches] = useState<LiveSpeechActivity[]>([]);
  const [hostCaptionsByLanguage, setHostCaptionsByLanguage] = useState<Record<string, CaptionEvent[]>>({});
  const [selectedHostLaneId, setSelectedHostLaneId] = useState("source");
  const [isBusy, setIsBusy] = useState(false);
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState("준비됨");
  const [sessionSyncStatus, setSessionSyncStatus] = useState("동기화 대기 중");
  const [languageStatuses, setLanguageStatuses] = useState<Record<string, LanguageStatus>>({});
  const [error, setError] = useState("");
  const [recoverableSessions, setRecoverableSessions] = useState<RecoverableSession[]>([]);
  const [isRecoveryDismissed, setIsRecoveryDismissed] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [expiredRecoveryId, setExpiredRecoveryId] = useState<string | null>(null);
  const [recoveryRefreshKey, setRecoveryRefreshKey] = useState(0);
  const [recoveryNextOffset, setRecoveryNextOffset] = useState<number | null>(null);
  const [isLoadingMoreSessions, setIsLoadingMoreSessions] = useState(false);
  const recoveryPagePendingRef = useRef(false);
  const recoveryListGenerationRef = useRef(0);
  const [isAutomaticStartEnabled, setIsAutomaticStartEnabled] = useState(true);
  const [audioRecoveryStatus, setAudioRecoveryStatus] = useState<LiveAudioRecoveryStatus | null>(null);
  const [audioDeviceId, setAudioDeviceId] = useState("");
  const audioDeviceIdRef = useRef("");
  const [audioDevices, setAudioDevices] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [wasPageHidden, setWasPageHidden] = useState(false);
  const [isEndConfirmVisible, setIsEndConfirmVisible] = useState(false);
  const [isGlossaryWorkspaceOpen, setIsGlossaryWorkspaceOpen] = useState(false);
  const [selectedGlossaryVersionLabel, setSelectedGlossaryVersionLabel] = useState("공통 비즈니스 · 1개 선택");
  const [glossarySelections, setGlossarySelections] = useState<readonly GlossarySessionPinSelection[]>([
    { sourceKind: "builtin", sourceId: "common_business" },
  ]);
  const [isGlossaryPinPending, setIsGlossaryPinPending] = useState(false);
  const audioClientRef = useRef<LiveAudioClient | null>(null);
  const isPageActiveRef = useRef(true);
  const broadcastStartFlightRef = useRef<{ sessionId: string; promise: Promise<boolean> } | null>(null);
  const scheduledStartRuntimeRef = useRef<ScheduledStartRuntime | null>(null);
  const scheduledStartTransportRef = useRef<ReturnType<typeof createScheduledGatewayStartTransport> | null>(null);
  if (!scheduledStartTransportRef.current) scheduledStartTransportRef.current = createScheduledGatewayStartTransport(fetch, true);
  const scheduledStartGenerationRef = useRef(0);
  const [scheduledStartNow, setScheduledStartNow] = useState(() => Date.now());
  const [scheduledStartState, setScheduledStartState] = useState<ScheduledGatewayCountdownState>("countdown");
  const recoveryDiscoveryPromiseRef = useRef<Promise<{ sessions: RecoverableSession[]; nextOffset: number | null }> | null>(null);
  const recoveryAttemptSessionIdRef = useRef<string | null>(null);
  const manualRestartSessionIdRef = useRef<string | null>(null);
  const sessionId = session?.id ?? null;
  const currentSessionIdRef = useRef<string | null>(sessionId);
  currentSessionIdRef.current = sessionId;
  const hostCaptions = useMemo(() => Object.values(hostCaptionsByLanguage).flat(), [hostCaptionsByLanguage]);
  const {
    summary: hostSummary,
    summaryError: hostSummaryError,
    isSummaryEmpty: isHostSummaryEmpty,
    pollingState: hostSummaryPollingState,
    pollingStartedAt: hostSummaryPollingStartedAt,
    transcript: hostTranscript,
    topics: hostTranscriptTopics,
    isTranscriptLoaded: isHostTranscriptLoaded,
    transcriptError: hostTranscriptError,
    isRetrying: isHostSummaryRetrying,
    retry: retryHostSummary,
    reset: resetHostSummaryLifecycle,
  } = useHostSummaryLifecycle(endedSession);

  const languageLabel = useMemo<Map<string, string>>(() => new Map(LANGUAGE_OPTIONS.map((item) => [item.code, item.label])), []);
  const scheduleValidation = useMemo(() => scheduleNow === null
    ? { scheduledAt: "", error: "" }
    : validateLiveSchedule(sessionDate, startTime, scheduleNow), [scheduleNow, sessionDate, startTime]);
  const scheduledAt = scheduleValidation.scheduledAt;
  const restoreSessionIdentity = useCallback((saved: LiveSession) => {
    setTitle(saved.title);
    const schedule = getHostSessionScheduleFields(saved.scheduledAt);
    setSessionDate(schedule.sessionDate);
    setStartTime(schedule.startTime);
  }, []);

  const applyGlossarySelections = useCallback(async (selections: readonly GlossarySessionPinSelection[]): Promise<"pinned" | "pending"> => {
    const previousSelections = glossarySelections;
    setGlossarySelections(selections);
    setSelectedGlossaryVersionLabel(selections.length ? `${selections.length}개 선택` : "선택 안 함");
    if (!session) {
      return "pending";
    }
    if (selections.length === 0) {
      setError("세션에 사용할 용어집을 1개 이상 선택해 주세요.");
      setGlossarySelections(previousSelections);
      return "pending";
    }
    setIsGlossaryPinPending(true);
    try {
      const nextSession = await pinGlossariesToSession(session, selections);
      setSession((current) => current?.id === nextSession.id ? nextSession : current);
      return "pinned";
    } catch (reason: unknown) {
      setGlossarySelections(previousSelections);
      setSelectedGlossaryVersionLabel(previousSelections.length ? `${previousSelections.length}개 선택` : "선택 안 함");
      setError(reason instanceof Error ? reason.message : "세션 용어집을 적용하지 못했습니다.");
      return "pending";
    } finally {
      setIsGlossaryPinPending(false);
    }
  }, [glossarySelections, session]);

  const applyGlossarySelection = useCallback(async (selection: GlossarySessionSelection): Promise<"pinned" | "pending"> => {
    const retainedSelections = glossarySelections.filter((item) => !(item.sourceKind === "host" && item.sourceId === selection.presetId));
    if (retainedSelections.length >= 5) {
      setError("용어집은 최대 5개까지 선택할 수 있습니다.");
      return "pending";
    }
    const next = [
      ...retainedSelections,
      { sourceKind: "host" as const, sourceId: selection.presetId, documentVersion: selection.version },
    ];
    const result = await applyGlossarySelections(next);
    if (result === "pinned") setSelectedGlossaryVersionLabel(`${selection.presetName} · 활성 버전 ${selection.version} · 총 ${next.length}개`);
    return result;
  }, [applyGlossarySelections, glossarySelections]);

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

  useEffect(() => {
    setHostCaptionsByLanguage({});
    setSelectedHostLaneId("source");
    setIsInviteQrOpen(false);
  }, [sessionId]);

  const createSession = useCallback(async () => {
    if (languages.length > 3) {
      setError("추가 언어를 제거해 세션 언어를 3개 이하로 맞춰 주세요.");
      return;
    }
    if (!isValidViewerCapacity(maxViewers)) {
      setError("최대 참여자는 1명에서 200명 사이로 설정해 주세요.");
      return;
    }
    const currentSchedule = validateLiveSchedule(sessionDate, startTime, Date.now());
    if (currentSchedule.error) {
      setError(currentSchedule.error);
      return;
    }
    recoveryListGenerationRef.current += 1;
    recoveryAttemptSessionIdRef.current = null;
    setIsBusy(true);
    setError("");
    try {
      const next = await readResponse<LiveSession>(await fetch("/api/live-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          scheduledAt: currentSchedule.scheduledAt,
          sessionType,
          languages,
          outputMode,
          voiceProvider: GEMINI_VOICE_PROVIDER,
          maxViewers,
          glossaryPack,
          companyName: companyName.trim() || null,
          ticker: ticker.trim() || null,
          fiscalPeriod: fiscalPeriod.trim() || null,
          eventType,
          agenda: parseAgendaText(agendaText),
          participantSpeakingEnabled,
        }),
      }));
      let preparedSession = next;
      setIsAutomaticStartEnabled(true);
      currentSessionIdRef.current = next.id;
      setSession(next);
      if (glossarySelections.length) {
        preparedSession = await pinGlossariesToSession(next, glossarySelections);
        setSession(preparedSession);
        setSelectedGlossaryVersionLabel(`${glossarySelections.length}개 적용`);
      }
      setSessionType(preparedSession.sessionType);
      setOutputMode(preparedSession.outputMode);
      setMaxViewers(preparedSession.maxViewers);
      setGlossaryPack(preparedSession.glossaryPack);
      setCompanyName(preparedSession.companyName ?? "");
      setTicker(preparedSession.ticker ?? "");
      setFiscalPeriod(preparedSession.fiscalPeriod ?? "");
      setEventType(preparedSession.eventType ?? "other");
      setAgendaText(agendaTextFromSession(preparedSession));
      setParticipantSpeakingEnabled(preparedSession.participantSpeakingEnabled === true);
      setIsEditingSession(false);
      setAdmission(null);
      setInvite(null);
      setSpeakers([]);
      setLanguageStatuses(languageStatusMap(preparedSession.languages, "preparing"));
      const inviteResult = await readResponse<InviteResult>(
        await fetch(`/api/live-sessions/${preparedSession.id}/invites`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "create" }),
        }),
      );
      setInvite({
        sessionId: preparedSession.id,
        url: `${window.location.origin}/m/watch#invite=${encodeURIComponent(inviteResult.inviteToken)}`,
        admissionCode: inviteResult.admissionCode,
        expiresAt: inviteResult.admissionOpenUntil,
      });
      setAdmission({ code: inviteResult.admissionCode, openUntil: inviteResult.admissionOpenUntil });
      setSession((current) => current?.id === next.id
        ? { ...current, version: inviteResult.version, admissionOpenUntil: inviteResult.admissionOpenUntil }
        : current);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The live session could not be created.");
    } finally {
      setIsBusy(false);
    }
  }, [agendaText, companyName, eventType, fiscalPeriod, glossaryPack, glossarySelections, languages, maxViewers, outputMode, participantSpeakingEnabled, sessionDate, sessionType, startTime, ticker, title]);

  const stopBroadcast = useCallback(async () => {
    const client = audioClientRef.current;
    audioClientRef.current = null;
    if (client) await client.disconnect();
    setIsBroadcasting(false);
    setAudioRecoveryStatus(null);
    setGatewayStatus("준비됨");
  }, []);

  const restartBroadcast = useCallback(async () => {
    if (!audioClientRef.current || !isBroadcasting) return;
    setIsBusy(true);
    setError("");
    setGatewayStatus("자막 연결 갱신 중");
    try {
      await audioClientRef.current.restart();
      setGatewayStatus(audioClientRef.current.isWaitingForParticipants?.()
        ? "참여자 대기 · 대기 중 발언은 기록되지 않아요" : "연결됨 · 실시간 자막 송출 중");
    } catch (restartError) {
      setGatewayStatus("자막 연결 확인 필요 · 다시 시작해 주세요");
      setError(restartError instanceof Error ? restartError.message : "Unable to refresh the caption engine.");
    } finally {
      setIsBusy(false);
    }
  }, [isBroadcasting]);

  const applySession = useCallback(async () => {
    if (!session) return;
    if (languages.length > 3) {
      setError("추가 언어를 제거해 세션 언어를 3개 이하로 맞춰 주세요.");
      return;
    }
    if (!isValidViewerCapacity(maxViewers)) {
      setError("최대 참여자는 1명에서 200명 사이로 설정해 주세요.");
      return;
    }
    const previousSession = session;
    const previousStatuses = languageStatuses;
    let didFailClosed = false;
    setIsBusy(true);
    setError("");
    setLanguageStatuses(languageStatusMap(languages, "preparing"));
    try {
      const identityPatch = buildHostSessionIdentityPatch(session, { title, sessionDate, startTime }, Date.now());
      const next = await readResponse<LiveSession>(await fetch(`/api/live-sessions/${session.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...identityPatch,
          version: session.version,
          sessionType,
          languages,
          outputMode,
          voiceProvider: GEMINI_VOICE_PROVIDER,
          maxViewers,
          glossaryPack,
          companyName: companyName.trim() || null,
          ticker: ticker.trim() || null,
          fiscalPeriod: fiscalPeriod.trim() || null,
          eventType,
          agenda: parseAgendaText(agendaText),
          participantSpeakingEnabled,
        }),
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
            domainText: buildLiveSessionDomainText(next),
          });
        } catch (gatewayError) {
          let restoredSession: LiveSession | null = null;
          try {
            restoredSession = await readResponse<LiveSession>(await fetch(`/api/live-sessions/${session.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ...(identityPatch.title !== undefined ? { title: previousSession.title } : {}),
                ...(identityPatch.scheduledAt !== undefined ? { scheduledAt: previousSession.scheduledAt } : {}),
                version: next.version,
                sessionType: previousSession.sessionType,
                languages: previousSession.languages,
                outputMode: previousSession.outputMode,
                voiceProvider: GEMINI_VOICE_PROVIDER,
                maxViewers: previousSession.maxViewers,
                glossaryPack: previousSession.glossaryPack,
                companyName: previousSession.companyName ?? null,
                ticker: previousSession.ticker ?? null,
                fiscalPeriod: previousSession.fiscalPeriod ?? null,
                eventType: previousSession.eventType ?? null,
                agenda: (previousSession.agenda ?? []).map((item) => item.label),
                participantSpeakingEnabled: previousSession.participantSpeakingEnabled,
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
              domainText: buildLiveSessionDomainText(previousSession),
            });
            setSession(restoredSession);
            restoreSessionIdentity(restoredSession);
            setSessionType(previousSession.sessionType);
            setOutputMode(previousSession.outputMode);
            setMaxViewers(previousSession.maxViewers);
            setGlossaryPack(previousSession.glossaryPack);
            setCompanyName(previousSession.companyName ?? "");
            setTicker(previousSession.ticker ?? "");
            setFiscalPeriod(previousSession.fiscalPeriod ?? "");
            setEventType(previousSession.eventType ?? "other");
            setAgendaText(agendaTextFromSession(previousSession));
            setParticipantSpeakingEnabled(previousSession.participantSpeakingEnabled === true);
            setLanguages([...previousSession.languages]);
            setLanguageStatuses(previousStatuses);
            throw new Error(`The new settings could not be prepared, so the previous settings were restored. ${gatewayError instanceof Error ? gatewayError.message : ""}`.trim());
          } catch (compensationError) {
            if (compensationError instanceof Error && compensationError.message.startsWith("The new settings could not be prepared")) throw compensationError;
            await stopBroadcast();
            didFailClosed = true;
            const failedSession = restoredSession ?? next;
            setSession(failedSession);
            restoreSessionIdentity(failedSession);
            setSessionType(failedSession.sessionType);
            setOutputMode(failedSession.outputMode);
            setMaxViewers(failedSession.maxViewers);
            setGlossaryPack(failedSession.glossaryPack);
            setCompanyName(failedSession.companyName ?? "");
            setTicker(failedSession.ticker ?? "");
            setFiscalPeriod(failedSession.fiscalPeriod ?? "");
            setEventType(failedSession.eventType ?? "other");
            setAgendaText(agendaTextFromSession(failedSession));
            setParticipantSpeakingEnabled(failedSession.participantSpeakingEnabled === true);
            setLanguages([...failedSession.languages]);
            setLanguageStatuses(languageStatusMap(failedSession.languages, "unavailable"));
            throw new Error("Settings could not be restored, so broadcasting stopped. Check the session and start again.");
          }
        }
      }
      setSession(next);
      restoreSessionIdentity(next);
      if (identityPatch.scheduledAt !== undefined) {
        scheduledStartTransportRef.current?.clear(next.id);
        scheduledStartRuntimeRef.current = null;
        setScheduledStartNow(Date.now());
      }
      setSessionType(next.sessionType);
      setOutputMode(next.outputMode);
      setMaxViewers(next.maxViewers);
      setGlossaryPack(next.glossaryPack);
      setCompanyName(next.companyName ?? "");
      setTicker(next.ticker ?? "");
      setFiscalPeriod(next.fiscalPeriod ?? "");
      setEventType(next.eventType ?? "other");
      setAgendaText(agendaTextFromSession(next));
      setParticipantSpeakingEnabled(next.participantSpeakingEnabled === true);
      setIsEditingSession(false);
      if (!isBroadcasting) setLanguageStatuses(languageStatusMap(next.languages, "preparing"));
    } catch (requestError) {
      if (!didFailClosed) setLanguageStatuses(previousStatuses);
      setError(requestError instanceof Error ? requestError.message : "Unable to update settings.");
    } finally {
      setIsBusy(false);
    }
  }, [agendaText, companyName, eventType, fiscalPeriod, glossaryPack, isBroadcasting, languageStatuses, languages, maxViewers, outputMode, participantSpeakingEnabled, restoreSessionIdentity, session, sessionDate, sessionType, startTime, stopBroadcast, ticker, title]);

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
          sessionId: session.id,
          url: `${window.location.origin}/m/watch#invite=${encodeURIComponent(inviteResult.inviteToken)}`,
          admissionCode: inviteResult.admissionCode,
          expiresAt: inviteResult.admissionOpenUntil,
        });
        setAdmission({ code: inviteResult.admissionCode, openUntil: inviteResult.admissionOpenUntil });
        setSession((current) => current?.id === session.id
          ? { ...current, version: inviteResult.version, admissionOpenUntil: inviteResult.admissionOpenUntil }
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

  const shareInvite = useCallback(async (mode: "share" | "copy") => {
    if (inviteSharePendingRef.current || isBusy) return;
    const currentInvite = getCurrentHostInvite(invite, session, admission, Date.now());
    if (!currentInvite) {
      setError("초대가 만료되었거나 입장 정보가 변경되었습니다. 참여자 입장 상태를 확인해 주세요.");
      return;
    }
    inviteSharePendingRef.current = true;
    setIsSharingInvite(true);
    setInviteFeedback("");
    setError("");
    try {
      const result = await shareHostInvitation(mode, buildHostInviteShareText({
        url: currentInvite.url,
        admissionCode: currentInvite.admissionCode,
        expiresAtLabel: new Date(currentInvite.expiresAt).toLocaleString("ko-KR"),
      }), navigator);
      if (result === "copied") setInviteFeedback("초대 링크와 인증코드를 복사했습니다.");
      if (result === "copied-unsupported") setInviteFeedback("공유 기능을 지원하지 않아 초대 링크와 인증코드를 복사했습니다.");
      if (result === "shared") setInviteFeedback("초대 링크와 인증코드를 공유했습니다.");
    } catch {
      setError("초대를 공유하지 못했습니다. 복사 권한을 확인하거나 이메일로 초대를 이용해 주세요.");
    } finally {
      inviteSharePendingRef.current = false;
      setIsSharingInvite(false);
    }
  }, [admission, invite, isBusy, session]);

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
        sessionId: session.id,
        url: `${window.location.origin}/m/watch#invite=${encodeURIComponent(inviteResult.inviteToken)}`,
        admissionCode: inviteResult.admissionCode,
        expiresAt: inviteResult.admissionOpenUntil,
      });
      setAdmission({ code: inviteResult.admissionCode, openUntil: inviteResult.admissionOpenUntil });
      setSession((current) => current?.id === session.id
        ? { ...current, version: inviteResult.version, admissionOpenUntil: inviteResult.admissionOpenUntil }
        : current);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create the guest QR.");
    } finally {
      setIsBusy(false);
    }
  }, [session]);

  const currentInvite = getCurrentHostInvite(invite, session, admission, scheduleNow ?? 0);
  const inviteMailto = useMemo(() => {
    if (!currentInvite) return "";
    const subject = encodeURIComponent("NOVA 라이브 초대");
    const body = encodeURIComponent(buildHostInviteShareText({
      url: currentInvite.url,
      admissionCode: currentInvite.admissionCode,
      expiresAtLabel: new Date(currentInvite.expiresAt).toLocaleString("ko-KR"),
    }));
    return `mailto:?subject=${subject}&body=${body}`;
  }, [currentInvite]);
  const inviteActions = <div className="live-invite-actions" aria-busy={isSharingInvite}>
    <button type="button" className="glass-btn" disabled={!currentInvite || isBusy}
      onClick={() => setIsInviteQrOpen(true)}>{inviteText("QR 크게 보기")}</button>
    <button type="button" className="live-invite-copy" disabled={!currentInvite || isBusy || isSharingInvite}
      onClick={() => void shareInvite("copy")}>{t("링크·인증코드 복사")}</button>
    <button type="button" className="live-invite-native" disabled={!currentInvite || isBusy || isSharingInvite}
      onClick={() => void shareInvite("share")}>{t("공유")}</button>
    <a className="live-invite-mail" href={inviteMailto || undefined} aria-disabled={!currentInvite || isBusy || isSharingInvite}
      onClick={(event) => {
        if (isBusy || inviteSharePendingRef.current || !getCurrentHostInvite(invite, session, admission, Date.now())) {
          event.preventDefault();
          setError("현재 초대를 공유할 수 없습니다. 참여자 입장 상태를 확인해 주세요.");
        }
      }} aria-label={t("라이브 초대 이메일 작성")}>{t("이메일로 초대")}</a>
  </div>;

  /** Attaches the host audio client to the gateway for an already-live session. */
  const connectBroadcast = useCallback(async (
    activeSession: LiveSession,
    activation?: Readonly<{ activationKey: string | null; activationVersion: number }>,
    initialControl: "start" | "restart" = "start",
  ): Promise<boolean> => {
    const credentials = await requestGatewayCredentials(activeSession.id);
    setLanguageStatuses(languageStatusMap(activeSession.languages, "preparing"));
    const client = await startLiveAudioClient({
      sessionId: activeSession.id,
      sessionType: activeSession.sessionType,
      languages: activeSession.languages,
      outputMode: activeSession.outputMode,
      voiceProvider: GEMINI_VOICE_PROVIDER,
      maxViewers: activeSession.maxViewers,
      glossaryPack: activeSession.glossaryPack,
      domainText: buildLiveSessionDomainText(activeSession),
      activationKey: activation?.activationKey,
      initialControl,
      sessionStatus: activeSession.status,
      version: activation?.activationVersion ?? activeSession.version,
      inputSource,
      audioDeviceId: audioDeviceIdRef.current || undefined,
      credentials,
      refreshCredentials: () => requestGatewayCredentials(activeSession.id),
      refreshSettings: async () => {
        const fresh = await readResponse<LiveSession>(await fetch(`/api/live-sessions/${activeSession.id}`, {
          method: "GET", cache: "no-store", signal: AbortSignal.timeout(10_000),
        }));
        if (fresh.id !== activeSession.id || !["preparing", "live", "paused"].includes(fresh.status)) {
          throw new Error("현재 회의의 연결 설정을 확인하지 못했습니다.");
        }
        if (isPageActiveRef.current && currentSessionIdRef.current === fresh.id) {
          setSession((current) => current?.id === fresh.id ? mergePolledHostSession(current, fresh) : current);
        }
        return { version: fresh.version, sessionStatus: fresh.status, sessionType: fresh.sessionType, languages: fresh.languages,
          outputMode: fresh.outputMode, voiceProvider: GEMINI_VOICE_PROVIDER, maxViewers: fresh.maxViewers,
          glossaryPack: fresh.glossaryPack, domainText: buildLiveSessionDomainText(fresh) };
      },
      demandControl: createHostDemandControl(activeSession.id),
      onStatus: (status) => {
        setGatewayStatus(status.includes("참여자 대기") ? status : /reconnect|retry/iu.test(status)
          ? "다시 연결 중 · 기존 자막 유지"
          : /connect|broadcast|ready/iu.test(status)
            ? "연결됨 · 실시간 자막 송출 중"
            : "실시간 연결 상태 확인 중");
      },
      onError: setError,
      onManualRestartRequired: () => {
        if (isPageActiveRef.current && currentSessionIdRef.current === activeSession.id) manualRestartSessionIdRef.current = activeSession.id;
      },
      onReplaced: () => {
        // 다른 기기/탭이 HOST 자리를 가져감(4410). 클라이언트는 이미 스스로
        // 멈췄으므로 재접속하지 않고 수동 재시작 경로만 남긴다.
        audioClientRef.current = null;
        setIsBroadcasting(false);
        setAudioRecoveryStatus("replaced-by-other-host");
        setGatewayStatus("다른 기기에서 호스트로 접속했어요 · 이 기기 송출 중지");
      },
      onSpeakers: setSpeakers,
      onCaption: (caption) => setHostCaptionsByLanguage((current) =>
        mergeLanguageCaptionCache(current, caption.language, [caption])),
      onLanguageStatus: (language, status) => {
        setLanguageStatuses((current) => ({ ...current, [language]: status }));
      },
    });
    if (!isPageActiveRef.current || currentSessionIdRef.current !== activeSession.id) {
      await client.disconnect();
      return false;
    }
    audioClientRef.current = client;
    setIsBroadcasting(true);
    return true;
  }, [inputSource]);

  const connectBroadcastWithRecovery = useCallback(async (
    activeSession: LiveSession,
    activation?: Readonly<{ activationKey: string | null; activationVersion: number }>,
    initialControl: "start" | "restart" = "start",
  ): Promise<boolean> => {
    try {
      if (!await connectBroadcast(activeSession, activation, initialControl)) return false;
      setAudioRecoveryStatus(null);
      setGatewayStatus(audioClientRef.current?.isWaitingForParticipants?.()
        ? "참여자 대기 · 대기 중 발언은 기록되지 않아요"
        : "연결됨 · 실시간 자막 송출 중");
      return true;
    } catch (requestError) {
      if (requestError instanceof LiveAudioRecoveryError) {
        setAudioRecoveryStatus(requestError.status);
        setGatewayStatus(requestError.status === "microphone-permission-required"
          ? "마이크 권한 확인 필요"
          : "마이크 다시 연결 필요");
        return false;
      }
      throw requestError;
    }
  }, [connectBroadcast]);

  const startBroadcast = useCallback((isUserInitiated = false): Promise<boolean> => {
    let activeSession = session;
    if (!isPageActiveRef.current || !activeSession) return Promise.resolve(false);
    const isManualRestart = manualRestartSessionIdRef.current === activeSession.id;
    if (isManualRestart && !isUserInitiated) return Promise.resolve(false);
    if (isBroadcasting && activeSession.status === "live") return Promise.resolve(true);
    const currentFlight = broadcastStartFlightRef.current;
    if (currentFlight?.sessionId === activeSession.id) return currentFlight.promise;
    if (isGlossaryPinPending) {
      setError("세션 용어집 적용을 완료한 뒤 라이브를 시작해 주세요.");
      return Promise.resolve(false);
    }
    const promise = (async () => {
      setIsBusy(true);
      setError("");
      try {
        const transport = scheduledStartTransportRef.current;
        if (!transport) throw new Error("라이브 시작을 준비하지 못했습니다.");
        if (isManualRestart) {
          const fresh = await readResponse<LiveSession>(await fetch(`/api/live-sessions/${activeSession.id}`, {
            method: "GET", cache: "no-store", signal: AbortSignal.timeout(10_000),
          }));
          if (fresh.id !== activeSession.id || !["preparing", "live"].includes(fresh.status)) throw new Error("현재 회의의 재시작 상태를 확인하지 못했습니다.");
          activeSession = fresh;
          transport.clear(activeSession.id);
        }
        const intent = activeSession.status === "live"
          ? null
          : await transport.prepare(activeSession.id, activeSession.version);
        const activation = isManualRestart && activeSession.status === "live"
          ? { activationKey: null, activationVersion: activeSession.version }
          : intent
          ? { activationKey: intent.activationKey, activationVersion: intent.version }
          : transport.getFlight(activeSession.id) ?? (activeSession.status === "live"
            // 서버가 보관한 활성화 키로 재접속하면 게이트웨이가 파이프라인을
            // 웜 reattach한다(페이지 새로고침·웹↔Electron 인계 공통 경로).
            ? { activationKey: activeSession.activationKey ?? null, activationVersion: activeSession.version }
            : undefined);
        if (!isPageActiveRef.current || currentSessionIdRef.current !== activeSession.id) return false;
        const transportSession = intent ? { ...activeSession, status: intent.status, version: intent.version } : activeSession;
        const didReceiveStartedAck = await connectBroadcastWithRecovery(transportSession, activation, isManualRestart ? "restart" : "start");
        if (!didReceiveStartedAck) return false;
        if (isManualRestart) manualRestartSessionIdRef.current = null;

        setGatewayStatus(audioClientRef.current?.isWaitingForParticipants?.()
          ? "참여자 대기 · 대기 중 발언은 기록되지 않아요" : "라이브 상태 확인 중");
        try {
          const authoritative = await readResponse<LiveSession>(await fetch(`/api/live-sessions/${activeSession.id}`, {
            method: "GET",
            cache: "no-store",
          }));
          if (authoritative.id === activeSession.id && (authoritative.status === "live" || authoritative.status === "paused")) {
            setSession((current) => current?.id === authoritative.id ? mergePolledHostSession(current, authoritative) : current);
            transport.clear(activeSession.id);
          }
        } catch {
          // The existing same-origin status poll reattaches the UI after a lost acknowledgement.
        }
        return true;
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "라이브를 시작하지 못했습니다.");
        return false;
      } finally {
        setIsBusy(false);
      }
    })();
    broadcastStartFlightRef.current = { sessionId: activeSession.id, promise };
    void promise.finally(() => {
      if (broadcastStartFlightRef.current?.promise === promise) broadcastStartFlightRef.current = null;
    });
    return promise;
  }, [connectBroadcastWithRecovery, isBroadcasting, isGlossaryPinPending, session]);

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

  /** Contract C4: pause retains the authenticated gateway connection and
   *  provider pipeline; only capture and processing are suspended. */
  const pauseSession = useCallback(async () => {
    if (!session) return;
    const client = audioClientRef.current;
    let didPauseMedia = false;
    setIsBusy(true);
    setError("");
    try {
      if (client) {
        await client.pause();
        didPauseMedia = true;
      }
      const paused = await readResponse<LiveSession>(await fetch(`/api/live-sessions/${session.id}/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: session.version }),
      }));
      setSession(paused);
      setGatewayStatus("일시정지됨 · 연결 유지 중");
    } catch (requestError) {
      if (didPauseMedia && client) {
        try {
          await client.resume();
          setGatewayStatus("연결됨 · 실시간 자막 송출 중");
        } catch {
          setGatewayStatus("일시정지 유지 · 세션 상태 확인 필요");
        }
      } else if (client) {
        setGatewayStatus("음성 송출 중지됨 · 세션 상태 확인 필요");
      }
      setError(requestError instanceof Error ? requestError.message : "Unable to pause the live session.");
    } finally {
      setIsBusy(false);
    }
  }, [session]);

  const resumeSession = useCallback(async () => {
    if (!session) return;
    let resumedSession: LiveSession | null = null;
    setIsBusy(true);
    setError("");
    try {
      resumedSession = await readResponse<LiveSession>(await fetch(`/api/live-sessions/${session.id}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: session.version }),
      }));
      setSession(resumedSession);
      if (audioClientRef.current) await audioClientRef.current.resume();
      else await connectBroadcastWithRecovery(resumedSession);
      setGatewayStatus("연결됨 · 실시간 자막 송출 중");
    } catch (requestError) {
      if (resumedSession) {
        try {
          const repaused = await readResponse<LiveSession>(await fetch(`/api/live-sessions/${session.id}/pause`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ version: resumedSession.version }),
          }));
          setSession(repaused);
          await audioClientRef.current?.pause().catch(() => undefined);
          setGatewayStatus("일시정지됨 · 연결 유지 중");
        } catch {
          setGatewayStatus("재개 상태 확인 필요 · 음성 송출 중지됨");
        }
      }
      setError(requestError instanceof Error ? requestError.message : "Unable to resume the live session.");
    } finally {
      setIsBusy(false);
    }
  }, [connectBroadcastWithRecovery, session]);

  /** Host session recovery: rehydrate the dashboard from an existing active
   *  session instead of forcing a new one. */
  const recoverSession = useCallback(async (recoverableId: string, shouldRenewExpiredAccess = false) => {
    if (recoveryAttemptSessionIdRef.current === recoverableId) return;
    recoveryAttemptSessionIdRef.current = recoverableId;
    const generation = ++recoveryListGenerationRef.current;
    const isCurrentRecovery = () => canApplyHostRecovery(generation, recoveryListGenerationRef.current, isPageActiveRef.current);
    let didRestoreSession = false;
    setIsBusy(true);
    setError("");
    try {
      const saved = await readResponse<LiveSession>(await fetch(`/api/live-sessions/${recoverableId}`, {
        method: "GET",
        cache: "no-store",
      }));
      if (!isCurrentRecovery()) return;
      if (!["preparing", "live", "paused"].includes(saved.status)) throw new Error("종료된 세션은 다시 준비할 수 없습니다.");
      const isExpired = Date.parse(saved.expiresAt) <= Date.now();
      // 2026-08-31 fix: A second device displaying a QR must not extend access or
      // change the version used by the Electron host without an explicit action.
      if (isExpired && shouldRenewExpiredAccess !== true) {
        setExpiredRecoveryId(saved.id);
        setRecoverableSessions((current) => appendRecoverableHostSessions(current, [saved]));
        setIsRecoveryDismissed(false);
        throw new Error("입장 시간이 만료되었습니다. 다시 사용하려면 입장 시간을 연장해 주세요.");
      }
      const existing = isExpired
        ? await readResponse<LiveSession>(await fetch(`/api/live-sessions/${saved.id}/restore`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: saved.version }),
        })) : saved;
      if (!isCurrentRecovery()) return;
      if (!["preparing", "live", "paused"].includes(existing.status)) throw new Error("종료된 세션은 다시 준비할 수 없습니다.");
      setExpiredRecoveryId(null);
      didRestoreSession = true;
      setIsAutomaticStartEnabled(false);
      setScheduledStartState("cancelled");
      setIsBroadcasting(false);
      setAudioRecoveryStatus(null);
      setGatewayStatus("세션 복원됨 · 마이크 연결 대기");
      restoreSessionIdentity(existing);
      setSessionType(existing.sessionType);
      setOutputMode(existing.outputMode);
      setMaxViewers(existing.maxViewers);
      setGlossaryPack(existing.glossaryPack);
      setCompanyName(existing.companyName ?? "");
      setTicker(existing.ticker ?? "");
      setFiscalPeriod(existing.fiscalPeriod ?? "");
      setEventType(existing.eventType ?? "other");
      setAgendaText(agendaTextFromSession(existing));
      setParticipantSpeakingEnabled(existing.participantSpeakingEnabled === true);
      setLanguages([...existing.languages]);
      setIsEditingSession(false);
      setLanguageStatuses(languageStatusMap(existing.languages, "preparing"));
      currentSessionIdRef.current = existing.id;
      setSession(existing);
      setRecoverableSessions([]);
      setRecoveryNextOffset(null);
      recoveryPagePendingRef.current = false;
      setIsLoadingMoreSessions(false);
      setIsRecoveryDismissed(true);
      setInvite(null);
      setAdmission(null);
      // 2026-08-31 fix: 복귀는 기존 초대를 회전시키거나 닫힌 입장을 열지 않는다.
      if (existing.admissionOpenUntil) try {
        const inviteResult = await readResponse<{ admissionCode: string; admissionOpenUntil: string }>(
          await fetch(`/api/live-sessions/${existing.id}/invites`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "read-if-open" }),
          }),
        );
        if (!isCurrentRecovery()) return;
        setInvite({
          sessionId: existing.id,
          url: buildAdmissionJoinUrl(window.location.origin, inviteResult.admissionCode),
          admissionCode: inviteResult.admissionCode,
          expiresAt: inviteResult.admissionOpenUntil,
        });
        setAdmission({ code: inviteResult.admissionCode, openUntil: inviteResult.admissionOpenUntil });
        setInviteFeedback("기존 초대를 그대로 사용할 수 있습니다. QR을 스캔하면 인증 코드가 자동으로 입력됩니다.");
      } catch {
        if (!isCurrentRecovery()) return;
        setInviteFeedback("세션은 복원되었습니다. 입장 상태를 확인한 뒤 초대를 다시 발급할 수 있습니다.");
      } else setInviteFeedback("참여자 입장이 닫혀 있습니다. 입장 열기를 누르면 초대할 수 있습니다.");
    } catch (requestError) {
      if (!isCurrentRecovery()) return;
      if (!didRestoreSession) recoveryAttemptSessionIdRef.current = null;
      setError(requestError instanceof Error ? requestError.message : "Unable to resume the session.");
    } finally {
      if (isCurrentRecovery()) setIsBusy(false);
    }
  }, [restoreSessionIdentity]);

  /** Contract C8: opens the stage/countdown view in its own named window so
   *  Electron can intercept it and send it to the external display. */
  const openStageWindow = useCallback(() => {
    if (!session) return;
    const stageInvite = getCurrentHostInvite(invite, session, admission, Date.now());
    const hash = stageInvite
      ? `#invite=${encodeURIComponent(stageInvite.url)}&code=${encodeURIComponent(stageInvite.admissionCode)}&expiresAt=${encodeURIComponent(stageInvite.expiresAt)}`
      : "";
    window.open(`/stage/${session.id}${hash}`, "realtime-noel-stage");
  }, [admission, invite, session]);

  const stopSession = useCallback(async () => {
    if (!session) return;
    recoveryListGenerationRef.current += 1;
    recoveryAttemptSessionIdRef.current = null;
    setIsBusy(true);
    setError("");
    try {
      const client = audioClientRef.current;
      audioClientRef.current = null;
      if (client) await client.stop();
      await stopBroadcast();
      await readResponse<unknown>(await fetch(`/api/live-sessions/${session.id}`, { method: "DELETE" }));
      setIsEndConfirmVisible(false);
      resetHostSummaryLifecycle();
      setEndedSession({ id: session.id, languages: [...session.languages] });
      currentSessionIdRef.current = null;
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
  }, [resetHostSummaryLifecycle, session, stopBroadcast]);

  // StrictMode may replay this effect. Sharing the discovery promise prevents
  // a second active-session read or a duplicate automatic restore attempt.
  useEffect(() => {
    if (!LIVE_CALL_ENABLED) return;
    let isDisposed = false;
    const generation = recoveryListGenerationRef.current;
    const isCurrentDiscovery = () => !isDisposed && canApplyHostRecovery(generation, recoveryListGenerationRef.current, isPageActiveRef.current);
    if (!recoveryDiscoveryPromiseRef.current) {
      recoveryDiscoveryPromiseRef.current = (async () => {
        return await readResponse<{ sessions: RecoverableSession[]; nextOffset: number | null }>(
          await fetch("/api/live-sessions?scope=mine", { method: "GET", cache: "no-store" }),
        );
      })();
    }
    void recoveryDiscoveryPromiseRef.current.then((page) => {
      if (!isCurrentDiscovery()) return;
      setRecoveryError("");
      setRecoveryNextOffset(page.nextOffset);
      const decision = resolveHostSessionRecovery(page.sessions, page.nextOffset);
      if (decision.kind === "restore") {
        void recoverSession(decision.session.id);
        return;
      }
      if (decision.kind === "choose") setRecoverableSessions([...decision.sessions]);
    }).catch(() => {
      if (isCurrentDiscovery()) setRecoveryError("저장된 세션을 불러오지 못했습니다. 다시 불러와 주세요.");
    });
    return () => { isDisposed = true; };
  }, [recoverSession, recoveryRefreshKey]);

  const refreshSavedSessions = useCallback(() => {
    recoveryListGenerationRef.current += 1;
    recoveryAttemptSessionIdRef.current = null;
    recoveryPagePendingRef.current = false;
    recoveryDiscoveryPromiseRef.current = null;
    setIsLoadingMoreSessions(false);
    setRecoverableSessions([]);
    setRecoveryNextOffset(null);
    setRecoveryError("");
    setIsRecoveryDismissed(false);
    setRecoveryRefreshKey((current) => current + 1);
  }, []);

  const loadMoreSavedSessions = useCallback(async () => {
    if (recoveryNextOffset === null || recoveryPagePendingRef.current) return;
    const generation = recoveryListGenerationRef.current;
    recoveryPagePendingRef.current = true;
    setIsLoadingMoreSessions(true);
    setRecoveryError("");
    try {
      const page = await readResponse<{ sessions: RecoverableSession[]; nextOffset: number | null }>(
        await fetch(`/api/live-sessions?scope=mine&offset=${recoveryNextOffset}`, { method: "GET", cache: "no-store" }),
      );
      if (!canApplyHostRecovery(generation, recoveryListGenerationRef.current, isPageActiveRef.current)) return;
      setRecoverableSessions((current) => appendRecoverableHostSessions(current, page.sessions));
      setRecoveryNextOffset(page.nextOffset);
    } catch {
      if (canApplyHostRecovery(generation, recoveryListGenerationRef.current, isPageActiveRef.current)) setRecoveryError("다음 세션을 불러오지 못했습니다. 더 보기를 다시 눌러 주세요.");
    } finally {
      if (canApplyHostRecovery(generation, recoveryListGenerationRef.current, isPageActiveRef.current)) {
        recoveryPagePendingRef.current = false;
        setIsLoadingMoreSessions(false);
      }
    }
  }, [recoveryNextOffset]);

  const polledSessionStatus = session?.status ?? null;
  useEffect(() => {
    if (!sessionId) {
      setSessionSyncStatus("동기화 대기 중");
      return;
    }
    // 종료·실패한 세션은 더 폴링하지 않는다 — 이 가드가 없으면 다른 기기에서
    // 끝낸 세션을 이 탭이 영원히 5초마다 재조회했다.
    if (polledSessionStatus === "stopped" || polledSessionStatus === "failed") {
      setSessionSyncStatus("세션 종료됨");
      return;
    }
    let isDisposed = false;
    let isRequestPending = false;
    let requestController: AbortController | null = null;

    const refreshSessionState = async () => {
      if (isDisposed || isRequestPending) return;
      if (document.visibilityState === "hidden") return;
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
        setSession((current) => mergePolledHostSession(current, latest));
        setParticipants(activity.participants);
        setRecentSpeeches(activity.recentSpeeches);
        setSessionSyncStatus("자동 동기화됨");
      } catch (requestError) {
        if (!isDisposed && (!(requestError instanceof DOMException) || requestError.name !== "AbortError")) {
          setSessionSyncStatus("동기화 지연");
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
  }, [sessionId, polledSessionStatus]);

  const getScheduledStartRuntime = useCallback((activeSessionId: string): ScheduledStartRuntime => {
    const current = scheduledStartRuntimeRef.current;
    if (current?.sessionId === activeSessionId) return current;
    if (current) scheduledStartTransportRef.current?.clear(current.sessionId);
    const next: ScheduledStartRuntime = {
      sessionId: activeSessionId,
      generation: scheduledStartGenerationRef.current + 1,
      hasWarmed: false,
      attemptedThrough: -1,
      manualStartedAt: null,
      hasGatewayStartedAck: false,
      isCancelled: false,
      isFlightPending: false,
      pendingAction: null,
      hasAttemptedReattach: false,
    };
    scheduledStartGenerationRef.current = next.generation;
    scheduledStartRuntimeRef.current = next;
    return next;
  }, []);

  // 송출 중 화면 꺼짐 방지. Screen Wake Lock은 탭이 숨겨지면 OS가 자동
  // 해제하므로 visible 복귀 때마다 재요청하고, 백그라운드에 있었던 사실은
  // 복귀 후 배너로 알린다(숨겨진 동안의 경고는 사용자가 볼 수 없다).
  useEffect(() => {
    if (!isBroadcasting) return;
    let wakeLock: { release: () => Promise<void> } | null = null;
    let isActive = true;
    const wakeLockApi = (navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
    }).wakeLock;
    const requestWakeLock = async () => {
      if (!wakeLockApi || !isActive) return;
      try {
        wakeLock = await wakeLockApi.request("screen");
      } catch {
        // 배터리 절약 모드 등에서 거부될 수 있다 — 복귀 배너가 보조 안전망.
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") setWasPageHidden(true);
      else void requestWakeLock();
    };
    void requestWakeLock();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      isActive = false;
      document.removeEventListener("visibilitychange", handleVisibility);
      void wakeLock?.release().catch(() => undefined);
    };
  }, [isBroadcasting]);

  // 마이크 장치 목록. 라벨은 마이크 권한 승인 후에만 채워진다.
  const activeSessionId = session?.id ?? null;
  useEffect(() => {
    if (!activeSessionId) return;
    let isActive = true;
    const refreshDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!isActive) return;
        setAudioDevices(devices
          .filter((device) => device.kind === "audioinput")
          .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `마이크 ${index + 1}` })));
      } catch {
        // enumerateDevices 미지원 브라우저는 기본 마이크만 사용한다.
      }
    };
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      isActive = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
    };
  }, [activeSessionId]);

  const changeAudioDevice = useCallback(async (nextDeviceId: string) => {
    setAudioDeviceId(nextDeviceId);
    audioDeviceIdRef.current = nextDeviceId;
    // 송출 중 장치 변경은 명시적 재시작: 기존 스트림 종료 후 새 장치로 재연결.
    if (audioClientRef.current) {
      const client = audioClientRef.current;
      audioClientRef.current = null;
      setIsBroadcasting(false);
      await client.disconnect().catch(() => undefined);
      await startBroadcast(true);
    }
  }, [startBroadcast]);

  useEffect(() => {
    if (!session || session.status !== "preparing") return;
    const updateClock = () => setScheduledStartNow(Date.now());
    updateClock();
    const timer = window.setInterval(updateClock, 1_000);
    document.addEventListener("visibilitychange", updateClock);
    window.addEventListener("pageshow", updateClock);
    window.addEventListener("online", updateClock);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", updateClock);
      window.removeEventListener("pageshow", updateClock);
      window.removeEventListener("online", updateClock);
    };
  }, [session?.id, session?.status]);

  useEffect(() => {
    if (!isPageActiveRef.current || !isAutomaticStartEnabled || !session?.scheduledAt || !["preparing", "live"].includes(session.status)) return;
    const runtime = getScheduledStartRuntime(session.id);
    if (runtime.isCancelled) return;
    if (session.status === "live") {
      setScheduledStartState("confirming");
      if (isBroadcasting || runtime.hasGatewayStartedAck || runtime.hasAttemptedReattach || runtime.isFlightPending) return;
      runtime.hasAttemptedReattach = true;
      runtime.isFlightPending = true;
      runtime.pendingAction = "start";
      const generation = runtime.generation;
      void startBroadcast().then((didAttach) => {
        const latest = scheduledStartRuntimeRef.current;
        if (latest?.sessionId === session.id && latest.generation === generation && didAttach) latest.hasGatewayStartedAck = true;
      }).finally(() => {
        const latest = scheduledStartRuntimeRef.current;
        if (latest?.sessionId === session.id && latest.generation === generation) {
          latest.isFlightPending = false;
          latest.pendingAction = null;
        }
      });
      return;
    }

    const scheduledTime = Date.parse(session.scheduledAt);
    if (!Number.isFinite(scheduledTime)) return;
    if (runtime.isFlightPending) {
      setScheduledStartState(runtime.pendingAction === "warm" ? "warming" : "connecting");
      return;
    }
    const decision = resolveScheduledGatewayStart({
      now: scheduledStartNow,
      scheduledAt: scheduledTime,
      manualStartedAt: runtime.manualStartedAt,
      prewarmLeadMilliseconds: 0,
      hasWarmed: runtime.hasWarmed,
      attemptedThrough: runtime.attemptedThrough,
      hasGatewayStartedAck: runtime.hasGatewayStartedAck,
      isCancelled: runtime.isCancelled,
      sessionStatus: session.status,
    });
    if (decision.action === "warm") setScheduledStartState("warming");
    else if (decision.action === "start") setScheduledStartState("connecting");
    else if (decision.action === "confirming") setScheduledStartState("confirming");
    else if (decision.action === "action-required") setScheduledStartState("action-required");
    else if (decision.action === "cancelled") setScheduledStartState("cancelled");
    else setScheduledStartState("countdown");
    if (decision.action === "warm") {
      runtime.hasWarmed = true;
      runtime.isFlightPending = true;
      runtime.pendingAction = "warm";
      const generation = runtime.generation;
      setGatewayStatus("게이트웨이 준비 중");
      const gatewayUrl = process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL ?? "";
      void warmScheduledGateway(gatewayUrl).catch(() => {
        setGatewayStatus("예약 시작 대기 중");
      }).finally(() => {
        const latest = scheduledStartRuntimeRef.current;
        if (latest?.sessionId === session.id && latest.generation === generation) {
          latest.isFlightPending = false;
          latest.pendingAction = null;
          setScheduledStartNow(Date.now());
        }
      });
    }
    if (decision.action === "start") {
      runtime.attemptedThrough = decision.attemptIndex;
      runtime.isFlightPending = true;
      runtime.pendingAction = "start";
      const generation = runtime.generation;
      void startBroadcast().then((didReceiveStartedAck) => {
        const latest = scheduledStartRuntimeRef.current;
        if (latest?.sessionId === session.id && latest.generation === generation && didReceiveStartedAck) {
          latest.hasGatewayStartedAck = true;
          setScheduledStartState("confirming");
        }
      }).finally(() => {
        const latest = scheduledStartRuntimeRef.current;
        if (latest?.sessionId === session.id && latest.generation === generation) {
          latest.isFlightPending = false;
          latest.pendingAction = null;
          setScheduledStartNow(Date.now());
        }
      });
    }
  }, [getScheduledStartRuntime, isAutomaticStartEnabled, isBroadcasting, scheduledStartNow, session, startBroadcast]);

  const requestScheduledStart = useCallback(() => {
    if (!session || !isPageActiveRef.current || isBusy || !["preparing", "live"].includes(session.status)) return;
    if (isGlossaryPinPending) {
      setError("세션 용어집 적용을 완료한 뒤 라이브를 시작해 주세요.");
      return;
    }
    const runtime = getScheduledStartRuntime(session.id);
    if (runtime.isFlightPending) return;
    const generation = runtime.generation;
    runtime.manualStartedAt = Date.now();
    runtime.attemptedThrough = 0;
    runtime.hasGatewayStartedAck = false;
    runtime.hasAttemptedReattach = false;
    runtime.isCancelled = false;
    runtime.isFlightPending = true;
    runtime.pendingAction = "start";
    setIsAutomaticStartEnabled(true);
    setScheduledStartState("connecting");
    setScheduledStartNow(Date.now());
    const ownsAttempt = () => scheduledStartRuntimeRef.current === runtime && runtime.generation === generation;
    const isCurrentAttempt = () => ownsAttempt() && isPageActiveRef.current && currentSessionIdRef.current === session.id;
    // 2026-08-31 fix: 수동 시작은 예약 시각이나 예약 clock effect를 기다리지 않는다.
    void startBroadcast(true).then((didStart) => {
      if (!ownsAttempt()) return;
      runtime.hasGatewayStartedAck = didStart;
      runtime.isCancelled = !didStart;
      if (!isCurrentAttempt()) return;
      if (didStart) {
        setScheduledStartState("confirming");
      } else {
        setIsAutomaticStartEnabled(false);
        setScheduledStartState("action-required");
      }
    }).catch(() => {
      if (!ownsAttempt()) return;
      // 숨겨진 페이지의 늦은 실패도 clock effect의 유료 재시도를 막는다.
      runtime.isCancelled = true;
      if (!isCurrentAttempt()) return;
      setIsAutomaticStartEnabled(false);
      setScheduledStartState("action-required");
      setError("라이브를 시작하지 못했습니다.");
    }).finally(() => {
      // 페이지가 숨겨져도 같은 실행의 잠금은 해제해 복귀 후 수동 시작을 허용한다.
      if (!ownsAttempt()) return;
      runtime.isFlightPending = false;
      runtime.pendingAction = null;
      if (isCurrentAttempt()) setScheduledStartNow(Date.now());
    });
  }, [getScheduledStartRuntime, isBusy, isGlossaryPinPending, session, startBroadcast]);

  const cancelScheduledStart = useCallback(() => {
    if (!session) return;
    const runtime = getScheduledStartRuntime(session.id);
    if (!canCancelScheduledGatewayStart({
      isFlightPending: runtime.isFlightPending,
      hasGatewayStartedAck: runtime.hasGatewayStartedAck,
      sessionStatus: session.status,
    })) {
      setGatewayStatus("시작 처리 중 · 완료 후 세션 종료를 사용해 주세요");
      return;
    }
    runtime.isCancelled = true;
    runtime.generation = scheduledStartGenerationRef.current + 1;
    scheduledStartGenerationRef.current = runtime.generation;
    scheduledStartTransportRef.current?.clear(session.id);
    setScheduledStartState("cancelled");
  }, [getScheduledStartRuntime, session]);

  useEffect(() => {
    isPageActiveRef.current = true;
    const disconnect = () => {
      isPageActiveRef.current = false;
      recoveryListGenerationRef.current += 1;
      recoveryAttemptSessionIdRef.current = null;
      currentSessionIdRef.current = null;
      const client = audioClientRef.current;
      audioClientRef.current = null;
      if (client) void client.disconnect().catch(() => undefined);
    };
    const restorePage = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      isPageActiveRef.current = true;
      recoveryPagePendingRef.current = false;
      setIsBusy(false);
      setIsLoadingMoreSessions(false);
      setIsBroadcasting(false);
      setIsAutomaticStartEnabled(false);
      setGatewayStatus("세션 유지됨 · 마이크 연결 대기");
    };
    window.addEventListener("pagehide", disconnect);
    window.addEventListener("pageshow", restorePage);
    return () => {
      window.removeEventListener("pagehide", disconnect);
      window.removeEventListener("pageshow", restorePage);
      disconnect();
    };
  }, []);

  const hostSurface = resolveHostSurface({
    hasSession: Boolean(session),
    hasEndedSession: Boolean(endedSession),
    isEditingSession,
    sessionStatus: session?.status ?? null,
  });
  const selectedOutputLabel = OUTPUT_OPTIONS.find((option) => option.value === outputMode)?.title ?? outputMode;
  const glossarySelectionLabel = formatHostGlossaryLabel(selectedGlossaryVersionLabel, t);
  const deliveryMethod = getDeliveryMethod(sessionType);
  const audioRecoveryMessage = audioRecoveryStatus === "microphone-permission-required"
    ? "Allow microphone access, then reconnect. The Live session stays active."
    : audioRecoveryStatus === "audio-user-activation-required"
      ? "Reconnect from the browser to allow audio startup. The Live session stays active."
      : audioRecoveryStatus === "replaced-by-other-host"
        ? "다른 기기에서 호스트로 접속해 이 기기의 송출이 중지되었습니다. 여기서 다시 호스트하려면 자막 다시 연결을 누르세요."
        : "";
  const hasUnavailableTranslation = Object.values(languageStatuses).includes("unavailable");
  const aiHealthRows: HostAiHealthRows = [
    {
      id: "source", label: "원문 자막", state: isBroadcasting ? "healthy" : "degraded",
      stateLabel: isBroadcasting ? "정상" : "연결 필요",
      actionLabel: !isBroadcasting ? "자막 다시 연결" : undefined,
      onAction: !isBroadcasting ? () => { void startBroadcast(true); } : undefined,
    },
    {
      id: "translation", label: "번역", state: hasUnavailableTranslation ? "degraded" : isBroadcasting ? "healthy" : "working",
      stateLabel: hasUnavailableTranslation ? "일부 언어 지연" : isBroadcasting ? "정상" : "대기",
      actionLabel: hasUnavailableTranslation && isBroadcasting ? "번역 다시 시작" : undefined,
      onAction: hasUnavailableTranslation && isBroadcasting ? () => { void restartBroadcast(); } : undefined,
    },
    { id: "topic", label: "주제 분류", state: recentSpeeches.length ? "working" : "unavailable", stateLabel: recentSpeeches.length ? "진행 중" : "자막 대기" },
    { id: "recap", label: "회의 요약", state: "working", stateLabel: "종료 후 생성" },
  ];
  const hostConnectionState: GatewayConnectionState = session?.status === "failed" ? "failed"
    : session?.status === "stopped" ? "ended"
      : session?.status === "paused" ? "paused"
        : audioRecoveryStatus ? "error"
          : isBroadcasting && session?.status === "live" ? "connected"
            : session?.status === "preparing" && scheduledStartState === "warming" ? "warming"
              : session?.status === "preparing" && (scheduledStartState === "connecting" || scheduledStartState === "confirming") ? "connecting"
                : isBusy ? "warming" : session?.status === "live" ? "connecting" : "idle";

  if (!LIVE_CALL_ENABLED) {
    return (
      <main className="live-host-shell">
        <WorkspaceViewport>
        <div className="live-host-workspace">
          <section className="glass live-panel" aria-label={t("라이브 콜 비활성화")}>
            <h1>{t("라이브 콜이 비활성화되었습니다")}</h1>
            <p>{t("현재 배포에서는 라이브 콜을 사용할 수 없습니다. 기본 자막 기능은 계속 사용할 수 있습니다.")}</p>
          </section>
        </div>
        </WorkspaceViewport>
      </main>
    );
  }

  return (
    <main className="live-host-shell">
      <aside className="live-host-rail">
        <strong className="live-join-wordmark">NOVA</strong>
        <nav aria-label={t("호스트 작업 영역")}>
          <button type="button" className="is-current" aria-current="page">{t("라이브")}</button>
          <a href="/records">{t("라이브콜 기록")}</a>
          <button type="button" disabled>{t("설정")}</button>
        </nav>
        <p className="live-join-admin live-host-participant-link"><a href="/watch">{t("참가자로 입장")}</a></p>
        <footer className="live-join-credit">Realtime by Noel</footer>
      </aside>
      <WorkspaceViewport>
      <div className="live-host-workspace" data-host-surface={hostSurface}>
        <header className="live-host-page-heading">
          <div>
            <h1>{hostSurface === "ended" ? t("세션 완료") : session ? session.title : t("라이브 세션 만들기")}</h1>
            {session?.scheduledAt && <p>{new Date(session.scheduledAt).toLocaleString(systemLanguage, {
              month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
            })}</p>}
          </div>
          {session ? (
            <GatewayConnectionStatus state={hostConnectionState}
              detail={<p>{t(gatewayStatus)} · {t("{count}명 참여", { count: session.viewerCount })} · {t(formatSessionStatus(session.status))}</p>} />
          ) : (
            <div className="live-host-status" aria-live="polite"><span>{t("시작 전")}</span></div>
          )}
        </header>

      <div className="live-error" data-seed-status={error ? "error" : "idle"} role={error ? "alert" : "status"} hidden={!error}>{inviteText(t(error))}</div>

      {!session && hostSurface === "setup" && (
        <div className="live-action-row">
          {recoveryError && <p className="live-error" role="alert">{t(recoveryError)}</p>}
          <button type="button" className="glass-btn" disabled={isBusy} onClick={refreshSavedSessions}>
            {recoveryError ? t("다시 불러오기") : t("저장된 세션 보기")}
          </button>
        </div>
      )}

      {hostSurface === "setup" && !session && !isRecoveryDismissed && recoverableSessions.length > 0 && (
        <section className="glass live-panel live-recovery-panel" data-host-surface-panel="setup" aria-labelledby="recovery-heading">
          <div className="live-section-heading">
            <div><span>{t("복귀")}</span><h2 id="recovery-heading">{t("저장된 세션")}</h2></div>
            <button type="button" className="glass-btn" onClick={() => {
              recoveryListGenerationRef.current += 1;
              if (recoveryAttemptSessionIdRef.current) setIsBusy(false);
              recoveryAttemptSessionIdRef.current = null;
              setIsRecoveryDismissed(true);
            }}>{t("닫기")}</button>
          </div>
          <p className="live-help">{t("기존 일정과 참여자를 유지하고 이어서 준비할 수 있습니다.")}</p>
          <ul className="live-recovery-list">
            {recoverableSessions.map((recoverable) => (
              <li key={recoverable.id}>
                <div>
                  <strong>{recoverable.title}</strong>
                  <small>{t(formatSessionStatus(recoverable.status))} · {t("참여자 {count}명", { count: recoverable.viewerCount })}
                    {recoverable.scheduledAt ? ` · ${new Date(recoverable.scheduledAt).toLocaleString(systemLanguage)}` : ""}</small>
                </div>
                <button type="button" className="glass-btn" disabled={isBusy}
                  onClick={() => void recoverSession(recoverable.id, expiredRecoveryId === recoverable.id)}>
                  {expiredRecoveryId === recoverable.id ? inviteText("입장 시간 연장 후 복원") : recoverable.status === "preparing" ? t("계속 준비") : t("세션 열기")}
                </button>
              </li>
            ))}
          </ul>
          {recoveryNextOffset !== null && <button type="button" className="glass-btn" disabled={isBusy || isLoadingMoreSessions}
            onClick={() => void loadMoreSavedSessions()}>{isLoadingMoreSessions ? t("불러오는 중…") : t("더 보기")}</button>}
        </section>
      )}

      {hostSurface === "ended" && endedSession && (
        <section className="glass live-summary-panel" data-host-surface-panel="ended" aria-labelledby="summary-heading">
          <div className="live-section-heading">
            <div><span>{t("요약")}</span><h2 id="summary-heading">{t("회의 요약")}</h2></div>
          </div>
          <MeetingMinutes
            summary={hostSummary?.summary ?? null}
            summaryCreatedAt={hostSummary?.createdAt ?? null}
            transcript={hostTranscript}
            topics={hostTranscriptTopics}
            isTranscriptLoaded={isHostTranscriptLoaded}
            summaryError={hostSummaryError}
            transcriptError={hostTranscriptError}
            isLoading={isHostSummaryRetrying}
            isSummaryEmpty={isHostSummaryEmpty}
            minutesPollingState={hostSummaryPollingState}
            minutesPollingStartedAt={hostSummaryPollingStartedAt}
            onRetry={retryHostSummary}
          />
          <div className="live-summary-actions">
            <button type="button" className="accent-btn live-primary-action" data-host-primary="ended" onClick={() => {
              resetHostSummaryLifecycle();
              setEndedSession(null);
            }}>
              {t("새 세션 만들기")} </button>
          </div>
        </section>
      )}

      {hostSurface === "setup" && (
        <section className="live-wizard" data-seed-shell="live-host-setup" data-host-surface-panel="setup" aria-labelledby="wizard-heading">
          <div className="live-section-heading">
            <div><h2 id="wizard-heading">{t("세션 정보")}</h2></div>
          </div>
          <div className="live-wizard-body">
            <div className="live-schedule-grid">
              <label className="live-text-field live-title-field" data-seed-field="sessionTitle" htmlFor="live-session-title">
                <span>{t("세션 제목")}</span>
                <input id="live-session-title" name="sessionTitle" type="text" maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)}
                  placeholder={t("Q3 earnings call")} autoComplete="off" required />
              </label>
              <label className="live-text-field" data-seed-field="schedule" htmlFor="live-session-date">
                <span>{t("날짜")}</span>
                <input id="live-session-date" name="sessionDate" type="text" inputMode="numeric" pattern="\d{4}-\d{2}-\d{2}" placeholder="YYYY-MM-DD"
                  value={sessionDate} onChange={(event) => setSessionDate(event.target.value)}
                  aria-invalid={!session && Boolean(scheduleValidation.error)}
                  aria-describedby={!session && scheduleValidation.error ? "live-schedule-error" : undefined} required />
              </label>
              <label className="live-text-field" data-seed-field="schedule" htmlFor="live-session-start-time">
                <span>{t("시작 시간")}</span>
                <input id="live-session-start-time" name="startTime" type="text" inputMode="numeric" pattern="(?:[01]\d|2[0-3]):[0-5]\d" placeholder="HH:MM"
                  value={startTime} onChange={(event) => setStartTime(event.target.value)}
                  aria-invalid={!session && Boolean(scheduleValidation.error)}
                  aria-describedby={!session && scheduleValidation.error ? "live-schedule-error" : undefined} required />
              </label>
            </div>
            {!session && scheduleNow !== null && scheduleValidation.error && (
              <p id="live-schedule-error" className="live-error" role="alert">{t(scheduleValidation.error)}</p>
            )}
            <section className="live-context-panel" aria-labelledby="live-context-heading">
              <div className="live-field-label">
                <strong id="live-context-heading">{t("행사 컨텍스트")}</strong>
                <small>{companyName.trim() || ticker.trim() || agendaText.trim() ? t("입력됨") : t("선택")}</small>
              </div>
              <div className="live-schedule-grid">
                <label className="live-text-field" htmlFor="live-company-name">
                  <span>{t("회사·기관명")}</span>
                  <input id="live-company-name" name="companyName" type="text" maxLength={160} value={companyName}
                    onChange={(event) => setCompanyName(event.target.value)} placeholder={t("NOVA Corporation")} autoComplete="organization" />
                </label>
                <label className="live-text-field" htmlFor="live-event-type">
                  <span>{t("행사 유형")}</span>
                  <select id="live-event-type" name="eventType" value={eventType}
                    onChange={(event) => setEventType(event.target.value as LiveEventType)}>
                    {EVENT_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
                  </select>
                </label>
                <label className="live-text-field" htmlFor="live-ticker">
                  <span>{t("종목코드·약칭")} <small>{t("선택")}</small></span>
                  <input id="live-ticker" name="ticker" type="text" maxLength={12} value={ticker}
                    onChange={(event) => setTicker(event.target.value.toUpperCase())} placeholder="NOVA" autoComplete="off" />
                </label>
                <label className="live-text-field" htmlFor="live-fiscal-period">
                  <span>{t("보고 기간")} <small>{t("선택")}</small></span>
                  <input id="live-fiscal-period" name="fiscalPeriod" type="text" maxLength={80} value={fiscalPeriod}
                    onChange={(event) => setFiscalPeriod(event.target.value)} placeholder="2026 Q3" autoComplete="off" />
                </label>
                <label className="live-text-field live-title-field" htmlFor="live-agenda">
                  <span>{t("주요 안건")} <small>{t("한 줄에 하나씩, 최대 20개")}</small></span>
                  <textarea id="live-agenda" name="agenda" maxLength={2400} rows={4} value={agendaText}
                    onChange={(event) => setAgendaText(event.target.value)}
                    placeholder={t("글로벌 사업 현황\n신제품 출시 계획\n질의응답")} />
                </label>
              </div>
            </section>
            <div className="live-field-group">
              <LanguagePicker label={t("세션 언어")} value={languages} onChange={setLanguages} minSelection={1} maxSelection={3}
                requiredLanguages={REQUIRED_SESSION_LANGUAGES} isDisabled={isBusy} />
            </div>
            <details className="live-setup-advanced">
              <summary>{t("고급 설정")}</summary>
              <div className="live-setup-advanced-body">
                <div className="live-mode-grid live-mode-grid-two" role="radiogroup" aria-label={t("세션 형식")}>
                  {SESSION_TYPE_OPTIONS.map((option) => (
                    <button key={option.value} type="button" role="radio" aria-checked={sessionType === option.value}
                      className={`live-setting-row ${sessionType === option.value ? "is-selected" : ""}`}
                      onClick={() => {
                        setSessionType(option.value);
                        // 발언권은 미팅 세션 전용 계약 — 발표형으로 바꾸면
                        // 서버 400 대신 여기서 즉시 수신 전용으로 되돌린다.
                        if (option.value !== "meeting") setParticipantSpeakingEnabled(false);
                      }}>
                      <strong>{t(option.title)}</strong><small>{t(option.stateLabel)}</small>
                    </button>
                  ))}
                </div>
                <div className="live-field-group">
                  <strong>{t("호스트 오디오 입력")}</strong>
                  <p className="live-help">{t("마이크 또는 USB 행사장 믹서")}</p>
                </div>
                <label className="live-setting-row live-capability-switch">
                  <span><strong>{t("참여자 발언")}</strong><small>{sessionType !== "meeting"
                    ? t("미팅 세션에서만 켤 수 있어요")
                    : participantSpeakingEnabled ? t("허용 · 참여자가 발언권을 요청할 수 있어요") : t("수신 전용 · 참여자는 번역 자막 시청만 해요")}</small></span>
                  <input type="checkbox" role="switch" name="participantSpeakingEnabled" aria-label={t("참여자 발언")}
                    checked={participantSpeakingEnabled}
                    disabled={sessionType !== "meeting"}
                    onChange={(event) => setParticipantSpeakingEnabled(event.currentTarget.checked)} />
                </label>
              <div className="live-mode-grid" role="radiogroup" aria-label={t("참여자 출력")}>
                {OUTPUT_OPTIONS.map((option) => (
                  <button key={option.value} type="button" role="radio" aria-checked={outputMode === option.value}
                    className={`live-setting-row ${outputMode === option.value ? "is-selected" : ""}`}
                    onClick={() => setOutputMode(option.value)}>
                    <strong>{t(option.title)}</strong><small>{t(option.stateLabel)}</small>
                  </button>
                ))}
              </div>
              <section className="live-delivery-method-card" aria-labelledby="live-delivery-method-title">
                <div>
                  <span>{t("현재 제공 방식")}</span>
                  <strong id="live-delivery-method-title">{t(deliveryMethod.title)}</strong>
                  <small>{t(deliveryMethod.status)}</small>
                </div>
              </section>
              <div className="live-field-group">
                <label htmlFor="live-capacity">{t("최대 참여자 · 1명에서 200명까지")} <output htmlFor="live-capacity">{maxViewers}</output></label>
                <input id="live-capacity" name="maxViewers" type="range" min={1} max={200} step={1} value={maxViewers}
                  onChange={(event) => setMaxViewers(Number(event.target.value))} />
              </div>
              <div className="live-field-group">
                <ConnectedGlossarySessionChecklist selections={glossarySelections} targetLanguages={languages}
                  disabled={isBusy || isGlossaryPinPending || session?.status === "live"}
                  onChange={(selections) => { void applyGlossarySelections(selections); }} />
                <button type="button" className="glass-btn" aria-expanded={isGlossaryWorkspaceOpen}
                  aria-controls="host-glossary-workspace" onClick={() => setIsGlossaryWorkspaceOpen((current) => !current)}>
                  {t("용어집 관리")} </button>
                {isGlossaryWorkspaceOpen && <div id="host-glossary-workspace">
                  <ConnectedGlossaryWorkspace sessionSelectionLabel={`${t("세션 용어집")} · ${glossarySelectionLabel}`}
                    onSessionSelection={applyGlossarySelection} />
                </div>}
              </div>
              <div className="live-field-group">
                <strong>{t("스테이지 커버")}</strong>
                <input ref={coverInputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void uploadCoverImage(file);
                  }} />
                <button type="button" className="glass-btn" disabled={!session || isBusy}
                  onClick={() => coverInputRef.current?.click()}>
                  {session ? (session.hasCoverImage ? t("커버 교체") : t("커버 업로드")) : t("세션 생성 후 사용 가능")}
                </button>
                {session && <span className="live-invite-feedback" aria-live="polite">{t(coverFeedback)}</span>}
              </div>
              <dl className="live-review-list">
                <div><dt>{t("제목")}</dt><dd>{title.trim()}</dd></div>
                <div><dt>{t("회사")}</dt><dd>{companyName.trim() || t("미지정")}</dd></div>
                <div><dt>{t("행사")}</dt><dd>{t(EVENT_TYPE_OPTIONS.find((option) => option.value === eventType)?.label ?? "기타")}</dd></div>
                <div><dt>{t("안건")}</dt><dd>{parseAgendaText(agendaText).join(" · ") || t("미지정")}</dd></div>
                <div><dt>{t("일정")}</dt><dd>{sessionDate} · {startTime}</dd></div>
                <div><dt>{t("세션")}</dt><dd>{sessionType === "presentation" ? t("발표") : t("회의")}</dd></div>
                <div><dt>{t("출력")}</dt><dd>{t(selectedOutputLabel)}</dd></div>
                <div><dt>{t("정원")}</dt><dd>{maxViewers}</dd></div>
                <div><dt>{t("참여자 발언")}</dt><dd>{participantSpeakingEnabled ? t("허용") : t("수신 전용")}</dd></div>
                <div><dt>{t("언어")}</dt><dd>{languages.map((language) => t(languageLabel.get(language) ?? language)).join(" · ")}</dd></div>
                <div><dt>{t("용어집")}</dt><dd>{glossarySelectionLabel}</dd></div>
              </dl>
              </div>
            </details>
          </div>
          <aside className="live-host-preview" aria-labelledby="live-host-preview-heading">
            <div className="live-host-preview-card">
              <span>{t("미리보기")}</span>
              <h2 id="live-host-preview-heading">{title.trim() || t("제목 없음")}</h2>
              <dl data-seed-list="sessionPreview">
                <div><dt>{t("일정")}</dt><dd>{sessionDate} · {startTime}</dd></div>
                <div><dt>{t("형식")}</dt><dd>{t(SESSION_TYPE_OPTIONS.find((option) => option.value === sessionType)?.title ?? "")}</dd></div>
                <div><dt>{t("언어")}</dt><dd>{languages.map((language) => t(languageLabel.get(language) ?? language)).join(" · ")}</dd></div>
                <div><dt>{t("출력")}</dt><dd>{t(selectedOutputLabel)}</dd></div>
                <div><dt>{t("정원")}</dt><dd>{maxViewers}</dd></div>
                <div><dt>{t("참여자 발언")}</dt><dd>{participantSpeakingEnabled ? t("허용") : t("수신 전용")}</dd></div>
              </dl>
            </div>
          </aside>
          <div className="live-wizard-footer">
            {session && <button type="button" className="glass-btn" onClick={() => {
              setError("");
              restoreSessionIdentity(session);
              setSessionType(session.sessionType); setOutputMode(session.outputMode); setMaxViewers(session.maxViewers);
              setGlossaryPack(session.glossaryPack); setCompanyName(session.companyName ?? ""); setTicker(session.ticker ?? "");
              setFiscalPeriod(session.fiscalPeriod ?? ""); setEventType(session.eventType ?? "other");
              setAgendaText(agendaTextFromSession(session)); setLanguages([...session.languages]); setIsEditingSession(false);
              setParticipantSpeakingEnabled(session.participantSpeakingEnabled === true);
            }}>{t("취소")}</button>}
            <button type="button" className="accent-btn live-primary-action" data-host-primary="setup"
              disabled={isBusy || !title.trim() || (!session && !scheduledAt)}
              onClick={() => void (session ? applySession() : createSession())}>
              {isBusy ? t("생성 중…") : session ? t("변경 적용") : t("세션 만들기")}
            </button>
          </div>
        </section>
      )}

      {session && hostSurface === "invite" && (
        <section className="glass live-panel live-session-panel live-invite-surface" data-host-surface-panel="invite" aria-labelledby="invite-heading">
          <div className="live-section-heading">
            <div><span>{t("초대")}</span><h2 id="invite-heading">{t("참여자 입장")}</h2></div>
            <small aria-live="polite">{t(sessionSyncStatus)}</small>
          </div>
          <div className="live-invite-main">
          <p className="live-help" role="status">{t("세션이 저장되었습니다. 페이지를 나가거나 앱을 닫아도 유지됩니다.")}</p>
          {!isAutomaticStartEnabled && <p className="live-help">{t("마이크는 연결되지 않았습니다. 준비가 끝나면 라이브 시작을 눌러 주세요.")}</p>}
          <dl className="live-session-facts">
            <div><dt>{t("일정")}</dt><dd>{session.scheduledAt ? new Date(session.scheduledAt).toLocaleString(systemLanguage) : t("지금 시작")}</dd></div>
            <div><dt>{t("정원")}</dt><dd>{session.viewerCount} / {session.maxViewers}</dd></div>
            <div><dt>{t("형식")}</dt><dd>{session.sessionType === "presentation" ? t("발표") : t("회의")}</dd></div>
            <div><dt>{t("언어")}</dt><dd>{session.languages.map((language) => t(languageLabel.get(language) ?? language)).join(" · ")}</dd></div>
          </dl>
          {isAutomaticStartEnabled && <ScheduledGatewayCountdown
            remainingMilliseconds={Math.max(0, Date.parse(session.scheduledAt ?? "") - scheduledStartNow)}
            state={scheduledStartState}
            onRetry={requestScheduledStart}
            onCancel={cancelScheduledStart}
          />}
          <span className="live-invite-feedback" aria-live="polite">{inviteText(t(inviteFeedback))}</span>
          <div className="live-cover-upload">
            <div>
              <strong>{t("스테이지 커버 이미지")}</strong>
              <p>{session.hasCoverImage
                ? t("등록됨")
                : t("선택")}</p>
            </div>
            <input ref={coverInputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void uploadCoverImage(file);
              }} />
            <button type="button" className="glass-btn" disabled={isBusy}
              onClick={() => coverInputRef.current?.click()}>
              {session.hasCoverImage ? t("커버 교체") : t("커버 업로드")}
            </button>
            <span className="live-invite-feedback" aria-live="polite">{t(coverFeedback)}</span>
          </div>
          <div className="live-action-row live-surface-actions">
            {!invite && <button type="button" className="glass-btn" disabled={isBusy} onClick={() => void openAdmission()}>{t("참여자 입장 열기")}</button>}
            <a className="glass-btn" href="/watch" onClick={() => {
              recoveryListGenerationRef.current += 1;
              recoveryAttemptSessionIdRef.current = null;
            }}>{t("준비 나가기 · 세션 유지")}</a>
            <button type="button" className="glass-btn" onClick={openStageWindow}
              title={t("스테이지 화면 열기")}>
              {t("스테이지 열기")} </button>
            <button type="button" className="glass-btn" disabled={isBusy || isEditingSession}
              onClick={() => { restoreSessionIdentity(session); setIsEditingSession(true); }}>{t("설정 수정")}</button>
            <button type="button" className="accent-btn live-primary-action" data-host-primary="invite"
              disabled={isBusy} onClick={requestScheduledStart}>
              {t("라이브 시작")} </button>
          </div>
          </div>
          {currentInvite && (
            <div className="live-admission-code" aria-live="polite">
              <span>{t("참여자 QR")}</span>
              <div className="live-invite-share">
                <InviteQrCode value={currentInvite.url} />
                <div className="live-access-code">
                  <span>{t("6자리 인증 코드")}</span>
                  <strong>{currentInvite.admissionCode}</strong>
                  <small>{t("입장 유효 시간:")} {new Date(currentInvite.expiresAt).toLocaleString(systemLanguage)}</small>
                </div>
                {inviteActions}
              </div>
            </div>
          )}
          <div className="live-danger-zone" aria-label={t("세션 폐기 제어")}>
            <div>
              <strong>{t("세션 폐기")}</strong>
              <p>{t("참여자 입장을 닫고 준비된 라이브 세션을 제거합니다.")}</p>
            </div>
            {!isEndConfirmVisible ? (
              <button type="button" className="live-danger-button" disabled={isBusy}
                onClick={() => setIsEndConfirmVisible(true)}>
                {t("세션 폐기…")} </button>
            ) : (
              <div className="live-danger-confirm" role="group" aria-label={t("세션 폐기 확인")}>
                <span>{t("모든 참여자에게 이 세션을 폐기할까요?")}</span>
                <button type="button" className="glass-btn" disabled={isBusy}
                  onClick={() => setIsEndConfirmVisible(false)}>{t("취소")}</button>
                <button type="button" className="live-danger-button" disabled={isBusy}
                  onClick={() => void stopSession()}>{t("세션 폐기")}</button>
              </div>
            )}
          </div>
        </section>
      )}

      {session && hostSurface === "live" && (
        <HostLiveLaneSurface sessionStatus={session.status} connectionState={hostConnectionState}
          gatewayStatus={gatewayStatus} languages={session.languages} captions={hostCaptions}
          selectedLaneId={selectedHostLaneId}
          onSelectLane={(lane: TranslationLanePresentation) => setSelectedHostLaneId(lane.id)}
          isBroadcasting={isBroadcasting} isBusy={isBusy} audioRecoveryMessage={audioRecoveryMessage}
          isEndConfirmVisible={isEndConfirmVisible} recentSpeeches={recentSpeeches}
          aiHealthRows={aiHealthRows} formatTime={formatTime}
          onStart={() => { void startBroadcast(true); }} onPause={() => { void pauseSession(); }}
          onResume={() => { void resumeSession(); }} onRequestEnd={() => setIsEndConfirmVisible(true)}
          onCancelEnd={() => setIsEndConfirmVisible(false)} onEnd={() => { void stopSession(); }}
          inspectorChildren={<>
              <p className="live-help">{t("페이지를 나가도 세션은 유지됩니다. 브라우저를 닫으면 마이크 송출은 중단되며, 다시 접속해 연결할 수 있습니다.")}</p>
              {wasPageHidden && (
                <p className="live-host-hidden-notice" role="status">
                  {t("화면이 백그라운드에 있었어요. 자막 송출 상태를 확인하세요.")} <button type="button" onClick={() => setWasPageHidden(false)}>{t("확인")}</button>
                </p>
              )}
              <details open>
                <summary>{t("마이크")}</summary>
                <div className="live-host-inspector-body">
                  <label className="live-mic-picker">
                    <span>{t("입력 장치")}</span>
                    <select value={audioDeviceId}
                      onChange={(event) => { void changeAudioDevice(event.currentTarget.value); }}>
                      <option value="">{t("기본 마이크")}</option>
                      {audioDevices.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </details>
              <details open>
                <summary>{t("초대")}</summary>
                <div className="live-host-inspector-body">
                  {currentInvite && <InviteQrCode value={currentInvite.url} />}
                  {currentInvite && <div className="live-access-code"><span>{t("인증 코드")}</span><strong>{currentInvite.admissionCode}</strong></div>}
                  {inviteActions}
                  <span className="live-invite-feedback" aria-live="polite">{inviteText(t(inviteFeedback))}</span>
                </div>
              </details>
              <details open>
                <summary>{t("참여자 · {present}/{total}", { present: participants.filter((participant) => participant.isPresent).length, total: participants.length })}</summary>
                <div className="live-host-inspector-body">
                  {participants.length === 0 ? <p role="status">{t("참여자를 기다리고 있습니다.")}</p> : (
                    <ul className="live-participant-list">
                      {participants.map((participant) => {
                        const presentation = resolveHostParticipantPresentation(participant);
                        return (
                          <li key={participant.participantId} className="live-participant-row">
                            <div><strong>{presentation.identity}</strong><span>{participant.isPresent ? t("참여 중") : t("나감")}</span></div>
                            <dl>
                              <div><dt>{t("회사")}</dt><dd>{presentation.company}</dd></div>
                              <div><dt>{t("부서")}</dt><dd>{presentation.department}</dd></div>
                              <div><dt>{t("직급")}</dt><dd>{presentation.jobTitle}</dd></div>
                              <div><dt>{t("요약 이메일")}</dt><dd>{presentation.hasSummaryConsent ? t("신청함") : t("신청 안 함")}</dd></div>
                            </dl>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </details>
              <details>
                <summary>{t("언어 상태")}</summary>
                <div className="live-host-inspector-body live-language-statuses">
                  {session.languages.map((language) => (
                    <div key={language}><span className={`live-status-dot ${isBroadcasting && languageStatuses[language] === "ready" ? "is-live" : ""}`} aria-hidden="true" />
                      <strong>{t(languageLabel.get(language) ?? language)}</strong><small>
                        {isBroadcasting ? t(LANGUAGE_STATUS_LABELS[languageStatuses[language] ?? "preparing"]) : t("대기 중")}
                      </small></div>
                  ))}
                  <div className="live-speaker-legend">
                    {speakers.length === 0 ? <p>{t("회의에서 발표자를 식별하면 고정된 발표자 이름이 표시됩니다.")}</p> : speakers.map((speaker) => (
                      <div key={speaker.speakerId}>
                        <span className="live-speaker-dot" style={{ backgroundColor: resolveSpeakerColor(speaker) }} aria-hidden="true" />
                        <strong>{speaker.label}</strong>
                        <span className="live-speaker-line" style={{ backgroundColor: resolveSpeakerColor(speaker) }} aria-hidden="true" />
                        <small>{t("자막")}</small>
                      </div>
                    ))}
                  </div>
                </div>
              </details>
              <details>
                <summary>{t("화면과 스테이지")}</summary>
                <div className="live-host-inspector-body">
                  <button type="button" className="glass-btn" onClick={openStageWindow}>{t("스테이지 화면 열기")}</button>
                  <input ref={coverInputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void uploadCoverImage(file);
                    }} />
                  <button type="button" className="glass-btn" disabled={isBusy}
                    onClick={() => coverInputRef.current?.click()}>{session.hasCoverImage ? t("커버 교체") : t("커버 업로드")}</button>
                  <span className="live-invite-feedback" aria-live="polite">{t(coverFeedback)}</span>
                </div>
              </details>
              <details>
                <summary>{t("고급")}</summary>
                <div className="live-host-inspector-body">
                  {isBroadcasting && <button type="button" className="glass-btn" disabled={isBusy}
                    onClick={() => void restartBroadcast()}>{t("자막 다시 시작")}</button>}
                  <button type="button" className="glass-btn" disabled={isBusy || isEditingSession}
                    onClick={() => { restoreSessionIdentity(session); setIsEditingSession(true); }}>{t("설정 수정")}</button>
                  <span>{t(sessionSyncStatus)}</span>
                </div>
              </details>
          </>}
        />
      )}
      {(hostSurface === "invite" || hostSurface === "live") && <p className="live-privacy-note">{t("원본 오디오와 음성 특성은 저장하지 않습니다. 재연결을 위해 최신 확정 자막만 일시적으로 보관합니다.")}</p>}
      </div>
      </WorkspaceViewport>
      {isInviteQrOpen && session && <InviteQrDialog sessionTitle={session.title}
        invitation={currentInvite} onClose={() => setIsInviteQrOpen(false)} />}
    </main>
  );
}
