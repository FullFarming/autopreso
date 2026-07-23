"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

import type {
  ApiResponse,
  GlossaryPack,
  LiveOutputMode,
  LiveSession,
  LiveSessionType,
  LiveVoiceProvider,
  SpeakerAssignment,
} from "@/lib/live-contract";
import { LANGUAGE_CODES, LANGUAGE_LABELS, toOpenAITranslationLanguageCode } from "@/lib/languageDetect";
import {
  startLiveAudioClient,
  type LiveAudioClient,
  type LiveInputSource,
} from "./live-audio-client";
import { resolveSpeakerColor } from "./SpeakerCaption";

const LANGUAGE_OPTIONS = LANGUAGE_CODES.map((code) => ({ code, label: LANGUAGE_LABELS[code] }));

const SESSION_TYPE_OPTIONS: Array<{ value: LiveSessionType; title: string; description: string }> = [
  { value: "presentation", title: "Presentation", description: "한 발표자의 음성을 선택한 언어로 빠르게 전달합니다." },
  { value: "meeting", title: "Meeting", description: "여러 화자를 구분하고 자막 또는 통역 음성을 함께 전달합니다." },
];

const OUTPUT_OPTIONS: Array<{ value: LiveOutputMode; title: string; description: string }> = [
  { value: "captions", title: "자막", description: "기본값 · 번역 자막만 표시하고 음성은 재생하지 않습니다." },
  { value: "captions_audio", title: "자막 + 통역 음성", description: "자막을 보면서 사용자 동의 후 AI 합성 통역 음성을 듣습니다." },
  { value: "audio", title: "통역 음성만", description: "Meeting의 오디오 프리셋 · 사용자 동의 후 합성 통역 음성만 재생합니다." },
];

const OPENAI_REALTIME_TRANSLATION_LANGUAGES = new Set([
  "en", "es", "pt", "fr", "ja", "ru", "zh", "de", "ko", "hi", "id", "vi", "it",
]);

function isOpenAIVoiceTarget(language: string): boolean {
  const normalized = toOpenAITranslationLanguageCode(language);
  return OPENAI_REALTIME_TRANSLATION_LANGUAGES.has(normalized);
}

function getDeliveryMethod(sessionType: LiveSessionType, outputMode: LiveOutputMode, voiceProvider: LiveVoiceProvider): { title: string; status: string; description: string } {
  if (sessionType === "presentation") {
    return outputMode === "captions"
      ? { title: "빠른 실시간 자막", status: "단일 발표자 최적화", description: "말하는 동안 선택한 언어의 자막을 빠르게 표시합니다." }
      : voiceProvider === "openai"
        ? { title: "OpenAI Realtime 통역 음성", status: "연속 음성 최적화", description: "Gemini 자막은 유지하면서 OpenAI의 낮은 지연 통역 음성을 출력합니다." }
        : { title: "Gemini 통역 음성", status: "단일 발표자 최적화", description: "Gemini 자막과 통역 음성을 함께 출력합니다." };
  }
  return outputMode === "captions"
    ? { title: "화자 구분 자막", status: "발화 종료 후 표시", description: "발화가 끝나면 화자를 구분해 번역 자막을 표시합니다." }
    : { title: "화자 구분 · 발화 종료 후 출력", status: "화자별 AI 음성", description: "발화가 끝난 뒤 통역 음성을 재생합니다. 장문 무정지 발화에서는 지연될 수 있습니다." };
}

const SESSION_LANGUAGE_HELP: Record<LiveSessionType, string> = {
  presentation: "Presentation의 기본 번역 언어는 English입니다. 언어를 바꾸면 준비가 끝난 뒤 교체됩니다.",
  meeting: "Meeting은 선택한 언어별 화자 구분 번역 자막을 제공합니다. 언어를 바꾸면 준비가 끝난 뒤 교체됩니다.",
};

const GLOSSARY_PACK_OPTIONS: Array<{ value: GlossaryPack; title: string; description: string }> = [
  { value: "general_cre", title: "CRE", description: "상업용 부동산 기본 용어" },
  { value: "hotel", title: "Hotel", description: "호텔 투자·운영 용어" },
  { value: "fnb", title: "F&B", description: "리테일 임대차·외식 용어" },
];

interface AdmissionState {
  code: string;
  openUntil: string;
}

interface InviteState {
  url: string;
  expiresAt: string;
}

interface GatewayCredentials {
  token: string;
  gatewayUrl: string;
  expiresAt: string;
}

type LanguageStatus = "preparing" | "ready" | "unavailable";

const LANGUAGE_STATUS_LABELS: Record<LanguageStatus, string> = {
  preparing: "준비 중",
  ready: "준비됨",
  unavailable: "사용 불가",
};

function languageStatusMap(languages: string[], status: LanguageStatus): Record<string, LanguageStatus> {
  return Object.fromEntries(languages.map((language) => [language, status]));
}

function getSpeakerVoiceStatus(speaker: SpeakerAssignment, outputMode: LiveOutputMode): string {
  if (outputMode === "captions") return "자막 전용";
  if ("voiceStatus" in speaker) {
    if (speaker.voiceStatus === "analyzing") return "자동 분석 중";
    if (speaker.voiceStatus === "ready") return `음색 배정 완료${speaker.voiceName ? ` · ${speaker.voiceName}` : ""}`;
    if (speaker.voiceStatus === "unavailable") return "사용 불가";
    if (speaker.voiceStatus === "disabled") return "자막 전용";
  }
  if (speaker.voiceName) return `음색 배정 완료 · ${speaker.voiceName}`;
  return "음색 배정 대기";
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as ApiResponse<T>;
  if (!payload.ok) throw new Error(payload.error);
  return payload.data;
}

function formatTime(value: string | null): string {
  if (!value) return "닫힘";
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function formatSessionStatus(status: LiveSession["status"]): string {
  if (status === "live") return "송출 중";
  if (status === "preparing") return "준비 중";
  if (status === "stopped") return "종료됨";
  return "오류";
}

function InviteQrCode({ value }: { value: string }) {
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
      if (!isDisposed) setQrError("QR 코드를 만들 수 없습니다. 링크 복사를 사용하세요.");
    });
    return () => { isDisposed = true; };
  }, [value]);

  return (
    <figure className="live-invite-qr" data-qr-value={value}>
      {dataUrl ? <img src={dataUrl} alt="Realtime Noel 시청자 초대 QR 코드" width={176} height={176} />
        : qrError ? <span role="alert">{qrError}</span>
          : <span role="status">QR 코드 만드는 중…</span>}
      <figcaption>휴대전화 카메라로 스캔해 참여</figcaption>
    </figure>
  );
}

async function requestGatewayCredentials(sessionId: string): Promise<GatewayCredentials> {
  const token = await readResponse<{ token: string; expiresAt: string }>(
    await fetch(`/api/live-sessions/${sessionId}/gateway-token`, { method: "POST" }),
  );
  const gatewayUrl = process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL ?? "";
  if (!gatewayUrl) throw new Error("미디어 게이트웨이 주소가 설정되지 않았습니다.");
  return { ...token, gatewayUrl };
}

export default function LiveHostDashboard() {
  const [sessionType, setSessionType] = useState<LiveSessionType>("presentation");
  const [outputMode, setOutputMode] = useState<LiveOutputMode>("captions");
  const [voiceProvider, setVoiceProvider] = useState<LiveVoiceProvider>("gemini");
  const [maxViewers, setMaxViewers] = useState(50);
  const [glossaryPack, setGlossaryPack] = useState<GlossaryPack>("general_cre");
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3 | 4>(1);
  const [isEditingSession, setIsEditingSession] = useState(false);
  const [inputSource, setInputSource] = useState<LiveInputSource>("mic");
  const [languages, setLanguages] = useState<string[]>(["en"]);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [speakers, setSpeakers] = useState<SpeakerAssignment[]>([]);
  const [admission, setAdmission] = useState<AdmissionState | null>(null);
  const [invite, setInvite] = useState<InviteState | null>(null);
  const [inviteFeedback, setInviteFeedback] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState("준비됨");
  const [sessionSyncStatus, setSessionSyncStatus] = useState("상태 동기화 대기");
  const [languageStatuses, setLanguageStatuses] = useState<Record<string, LanguageStatus>>({});
  const [error, setError] = useState("");
  const audioClientRef = useRef<LiveAudioClient | null>(null);
  const sessionId = session?.id ?? null;

  const languageLabel = useMemo<Map<string, string>>(() => new Map(LANGUAGE_OPTIONS.map((item) => [item.code, item.label])), []);
  const isOpenAIVoiceLanguageSupported = useMemo(() => languages.every(isOpenAIVoiceTarget), [languages]);

  useEffect(() => {
    if (voiceProvider === "openai" && (sessionType === "meeting" || !isOpenAIVoiceLanguageSupported)) {
      setVoiceProvider("gemini");
    }
  }, [isOpenAIVoiceLanguageSupported, sessionType, voiceProvider]);

  const toggleLanguage = useCallback((language: string) => {
    setLanguages((current) => {
      if (current.includes(language)) return current.length === 1 ? current : current.filter((item) => item !== language);
      if (current.length >= 3) return current;
      return [...current, language];
    });
  }, []);

  const createSession = useCallback(async () => {
    setIsBusy(true);
    setError("");
    try {
      const next = await readResponse<LiveSession>(await fetch("/api/live-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionType, languages, outputMode, voiceProvider, maxViewers, glossaryPack }),
      }));
      setSession(next);
      setSessionType(next.sessionType);
      setOutputMode(next.outputMode);
      setVoiceProvider(next.voiceProvider);
      setMaxViewers(next.maxViewers);
      setGlossaryPack(next.glossaryPack);
      setIsEditingSession(false);
      setAdmission(null);
      setInvite(null);
      setSpeakers([]);
      setLanguageStatuses(languageStatusMap(next.languages, "preparing"));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "라이브 세션을 시작할 수 없습니다.");
    } finally {
      setIsBusy(false);
    }
  }, [glossaryPack, languages, maxViewers, outputMode, sessionType, voiceProvider]);

  const stopBroadcast = useCallback(async () => {
    const client = audioClientRef.current;
    audioClientRef.current = null;
    if (client) await client.stop();
    setIsBroadcasting(false);
    setGatewayStatus("준비됨");
  }, []);

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
        body: JSON.stringify({ version: session.version, sessionType, languages, outputMode, voiceProvider, maxViewers, glossaryPack }),
      }));
      if (isBroadcasting && audioClientRef.current) {
        try {
          await audioClientRef.current.update({
            version: next.version,
            sessionType,
            languages,
            outputMode,
            voiceProvider,
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
                voiceProvider: previousSession.voiceProvider,
                maxViewers: previousSession.maxViewers,
                glossaryPack: previousSession.glossaryPack,
              }),
            }));
            await audioClientRef.current.update({
              version: restoredSession.version,
              sessionType: previousSession.sessionType,
              languages: previousSession.languages,
              outputMode: previousSession.outputMode,
              voiceProvider: previousSession.voiceProvider,
              maxViewers: previousSession.maxViewers,
              glossaryPack: previousSession.glossaryPack,
            });
            setSession(restoredSession);
            setSessionType(previousSession.sessionType);
            setOutputMode(previousSession.outputMode);
            setVoiceProvider(previousSession.voiceProvider);
            setMaxViewers(previousSession.maxViewers);
            setGlossaryPack(previousSession.glossaryPack);
            setLanguages([...previousSession.languages]);
            setLanguageStatuses(previousStatuses);
            throw new Error(`새 설정을 준비하지 못해 이전 설정으로 복구했습니다. ${gatewayError instanceof Error ? gatewayError.message : ""}`.trim());
          } catch (compensationError) {
            if (compensationError instanceof Error && compensationError.message.startsWith("새 설정을 준비하지 못해")) throw compensationError;
            await stopBroadcast();
            didFailClosed = true;
            const failedSession = restoredSession ?? next;
            setSession(failedSession);
            setSessionType(failedSession.sessionType);
            setOutputMode(failedSession.outputMode);
            setVoiceProvider(failedSession.voiceProvider);
            setMaxViewers(failedSession.maxViewers);
            setGlossaryPack(failedSession.glossaryPack);
            setLanguages([...failedSession.languages]);
            setLanguageStatuses(languageStatusMap(failedSession.languages, "unavailable"));
            throw new Error("설정 복구에 실패해 송출을 중단했습니다. 세션 상태를 확인한 뒤 다시 시작하세요.");
          }
        }
      }
      setSession(next);
      setSessionType(next.sessionType);
      setOutputMode(next.outputMode);
      setVoiceProvider(next.voiceProvider);
      setMaxViewers(next.maxViewers);
      setGlossaryPack(next.glossaryPack);
      setIsEditingSession(false);
      if (!isBroadcasting) setLanguageStatuses(languageStatusMap(next.languages, "preparing"));
    } catch (requestError) {
      if (!didFailClosed) setLanguageStatuses(previousStatuses);
      setError(requestError instanceof Error ? requestError.message : "설정을 변경할 수 없습니다.");
    } finally {
      setIsBusy(false);
    }
  }, [glossaryPack, isBroadcasting, languageStatuses, languages, maxViewers, outputMode, session, sessionType, stopBroadcast, voiceProvider]);

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
        const inviteResult = await readResponse<{ inviteToken: string; expiresAt: string }>(
          await fetch(`/api/live-sessions/${session.id}/invites`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "create" }),
          }),
        );
        setInvite({
          url: `${window.location.origin}/watch#invite=${encodeURIComponent(inviteResult.inviteToken)}`,
          expiresAt: inviteResult.expiresAt,
        });
      } catch (inviteError) {
        setInvite(null);
        setError("입장번호는 열렸지만 초대 링크를 만들지 못했습니다. 번호로 입장할 수 있습니다.");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "입장번호를 열 수 없습니다.");
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
      setInviteFeedback("입장창을 닫았습니다. 현재 송출 세션은 계속 유지됩니다.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "입장창을 닫을 수 없습니다.");
    } finally {
      setIsBusy(false);
    }
  }, [session]);

  const copyInviteLink = useCallback(async () => {
    if (!invite) return;
    setInviteFeedback("");
    try {
      if (!navigator.clipboard) throw new Error("이 브라우저는 안전한 링크 복사를 지원하지 않습니다.");
      await navigator.clipboard.writeText(invite.url);
      setInviteFeedback("초대 링크를 복사했습니다.");
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "초대 링크를 복사할 수 없습니다.");
    }
  }, [invite]);

  const inviteMailto = useMemo(() => {
    if (!invite) return "";
    const subject = encodeURIComponent("Realtime Noel Live 초대");
    const body = encodeURIComponent(`아래 링크로 Live에 참여하세요.\n\n${invite.url}\n\n초대 만료: ${formatTime(invite.expiresAt)}`);
    return `mailto:?subject=${subject}&body=${body}`;
  }, [invite]);

  const startBroadcast = useCallback(async () => {
    if (!session || isBroadcasting) return;
    setIsBusy(true);
    setError("");
    try {
      const credentials = await requestGatewayCredentials(session.id);
      setLanguageStatuses(languageStatusMap(languages, "preparing"));
      const client = await startLiveAudioClient({
        sessionId: session.id,
        version: session.version,
        sessionType,
        languages,
        outputMode,
        voiceProvider,
        maxViewers,
        glossaryPack,
        inputSource,
        credentials,
        refreshCredentials: () => requestGatewayCredentials(session.id),
        onStatus: setGatewayStatus,
        onError: setError,
        onSpeakers: setSpeakers,
        onLanguageStatus: (language, status) => {
          setLanguageStatuses((current) => ({ ...current, [language]: status }));
        },
      });
      audioClientRef.current = client;
      setIsBroadcasting(true);
      setSession((current) => current ? { ...current, status: "live" } : current);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "음성 송출을 시작할 수 없습니다.");
    } finally {
      setIsBusy(false);
    }
  }, [glossaryPack, inputSource, isBroadcasting, languages, maxViewers, outputMode, session, sessionType, voiceProvider]);

  const stopSession = useCallback(async () => {
    if (!session) return;
    setIsBusy(true);
    setError("");
    try {
      await stopBroadcast();
      await readResponse<unknown>(await fetch(`/api/live-sessions/${session.id}`, { method: "DELETE" }));
      setSession(null);
      setAdmission(null);
      setInvite(null);
      setSpeakers([]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "라이브 세션을 종료할 수 없습니다.");
    } finally {
      setIsBusy(false);
    }
  }, [session, stopBroadcast]);

  useEffect(() => {
    if (!sessionId) {
      setSessionSyncStatus("상태 동기화 대기");
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
        const latest = await readResponse<LiveSession>(await fetch(`/api/live-sessions/${sessionId}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        }));
        if (isDisposed) return;
        setSession((current) => current?.id === sessionId
          ? { ...current, viewerCount: latest.viewerCount, status: latest.status }
          : current);
        setSessionSyncStatus("상태 자동 동기화");
      } catch (requestError) {
        if (!isDisposed && (!(requestError instanceof DOMException) || requestError.name !== "AbortError")) {
          setSessionSyncStatus("상태 동기화 지연");
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
  const deliveryMethod = getDeliveryMethod(sessionType, outputMode, voiceProvider);
  const selectedGlossaryLabel = GLOSSARY_PACK_OPTIONS.find((option) => option.value === glossaryPack)?.title ?? glossaryPack;

  return (
    <main className="live-host-shell">
      <header className="live-host-header glass">
        <div>
          <span className="live-eyebrow">Realtime Noel · Live</span>
          <h1 className="display">한 번의 음성, 각자의 언어.</h1>
          <p>호스트가 최대 3개 언어를 준비하면 최대 50명이 웹·모바일·Chrome에서 같은 결과를 공유합니다.</p>
        </div>
        <div className="live-host-status" aria-live="polite">
          <span className={`live-status-dot ${session ? "is-live" : ""}`} aria-hidden="true" />
          <span>{session ? `${session.viewerCount}명 접속 · ${formatSessionStatus(session.status)}` : "시작 전"}</span>
        </div>
      </header>

      {error && <div className="live-error" role="alert">{error}</div>}

      {isConfiguring && (
        <section className="glass live-wizard" aria-labelledby="wizard-heading">
          <div className="live-section-heading">
            <div><span>SETUP</span><h2 id="wizard-heading">호스트 설정</h2></div>
            <small>{wizardStep}/4</small>
          </div>
          <nav className="live-wizard-progress" aria-label="라이브 설정 단계">
            {(["형식", "출력", "참여자", "확인"] as const).map((label, index) => {
              const step = (index + 1) as 1 | 2 | 3 | 4;
              return <button key={label} type="button" className={wizardStep === step ? "is-current" : ""}
                aria-current={wizardStep === step ? "step" : undefined} onClick={() => setWizardStep(step)}>
                <span>{step}</span>{label}
              </button>;
            })}
          </nav>

          {wizardStep === 1 && (
            <div className="live-wizard-body">
              <div className="live-mode-grid live-mode-grid-two" role="radiogroup" aria-label="세션 형식">
                {SESSION_TYPE_OPTIONS.map((option) => (
                  <button key={option.value} type="button" role="radio" aria-checked={sessionType === option.value}
                    className={`live-mode-card ${sessionType === option.value ? "is-selected" : ""}`}
                    onClick={() => setSessionType(option.value)}>
                    <strong>{option.title}</strong><span>{option.description}</span>
                  </button>
                ))}
              </div>
              <div className="live-field-group">
                <strong>입력 음성</strong>
                <div className="live-segmented" role="radiogroup" aria-label="입력 음성">
                  {([['mic', '마이크'], ['system', '시스템'], ['both', '둘 다']] as Array<[LiveInputSource, string]>).map(([value, label]) => (
                    <button key={value} type="button" role="radio" aria-checked={inputSource === value}
                      className={inputSource === value ? "is-selected" : ""} onClick={() => setInputSource(value)} disabled={Boolean(session)}>
                      {label}
                    </button>
                  ))}
                </div>
                <p className="live-help">마이크는 소음 억제·에코 제거를 적용하고, 시스템 음성은 원본을 유지합니다.</p>
              </div>
            </div>
          )}

          {wizardStep === 2 && (
            <div className="live-wizard-body">
              <div className="live-mode-grid" role="radiogroup" aria-label="시청자 출력 방식">
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
                  <span>현재 전달 방식</span>
                  <strong id="live-delivery-method-title">{deliveryMethod.title}</strong>
                  <small>{deliveryMethod.status}</small>
                </div>
                <p id="live-delivery-method-description">{deliveryMethod.description}</p>
              </section>
              <section className="live-delivery-method-card" aria-labelledby="live-caption-provider-title">
                <div>
                  <span>자막 엔진</span>
                  <strong id="live-caption-provider-title">Gemini 고정</strong>
                  <small>모든 출력 모드</small>
                </div>
                <p>음성 엔진을 바꿔도 실시간 번역 자막은 Gemini가 계속 생성합니다.</p>
              </section>
              {outputMode !== "captions" && (
                <div className="live-field-group">
                  <div className="live-field-label"><strong>통역 음성 엔진</strong><small>음성 출력에만 적용</small></div>
                  <div className="live-mode-grid live-mode-grid-two" role="radiogroup" aria-label="통역 음성 엔진" aria-describedby="live-voice-provider-help">
                    <button type="button" role="radio" aria-checked={voiceProvider === "gemini"}
                      className={`live-mode-card ${voiceProvider === "gemini" ? "is-selected" : ""}`}
                      onClick={() => setVoiceProvider("gemini")}>
                      <strong>Gemini 음성</strong><span>현재 방식 · Gemini 자막과 함께 통역 음성을 출력합니다.</span>
                    </button>
                    <button type="button" role="radio" aria-checked={voiceProvider === "openai"}
                      aria-describedby="live-voice-provider-help" disabled={sessionType === "meeting" || !isOpenAIVoiceLanguageSupported}
                      className={`live-mode-card ${voiceProvider === "openai" ? "is-selected" : ""}`}
                      onClick={() => setVoiceProvider("openai")}>
                      <strong>OpenAI Realtime</strong><span>Presentation에서 낮은 지연의 연속 통역 음성을 출력합니다.</span>
                    </button>
                  </div>
                  <p id="live-voice-provider-help" className="live-help">{sessionType === "meeting"
                    ? "Meeting은 화자별 고정 음색을 위해 Gemini 음성을 사용합니다."
                    : !isOpenAIVoiceLanguageSupported
                      ? "선택한 언어 중 OpenAI Realtime 통역 음성이 지원하지 않는 언어가 있어 Gemini 음성을 사용합니다."
                      : "OpenAI Realtime은 지원되는 13개 대상 언어에서 사용할 수 있습니다. 자막은 Gemini로 유지됩니다."}</p>
                </div>
              )}
              {outputMode !== "captions" &&
                <p className="live-consent-note" role="note"><strong>통역 음성</strong>은 시청자가 직접 재생을 누른 뒤에만 시작됩니다.</p>
              }
            </div>
          )}

          {wizardStep === 3 && (
            <div className="live-wizard-body live-audience-settings">
              <div className="live-field-group">
                <label htmlFor="live-capacity">최대 참여자 <output htmlFor="live-capacity">{maxViewers}명</output></label>
                <input id="live-capacity" type="range" min={1} max={50} step={1} value={maxViewers}
                  onChange={(event) => setMaxViewers(Number(event.target.value))} />
                <small>1명부터 최대 50명까지 입장을 제한합니다.</small>
              </div>
              <div className="live-field-group">
                <div className="live-field-label"><strong>시청 언어</strong><small>{languages.length}/3</small></div>
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
                  <strong>산업 용어팩</strong>
                  <small>{sessionType === "meeting" ? "기본 관용구 + 선택 팩 적용" : "Meeting에서 적용"}</small>
                </div>
                <div className="live-glossary-grid" role="radiogroup" aria-label="산업 용어팩" aria-describedby="live-glossary-help">
                  {GLOSSARY_PACK_OPTIONS.map((option) => <button key={option.value} type="button" role="radio"
                    aria-checked={glossaryPack === option.value} className={glossaryPack === option.value ? "is-selected" : ""}
                    disabled={sessionType === "presentation"}
                    onClick={() => setGlossaryPack(option.value)}><strong>{option.title}</strong><span>{option.description}</span></button>)}
                </div>
                <p id="live-glossary-help" className="live-help">{sessionType === "meeting"
                  ? "Meeting의 화자별 텍스트 번역에 기본 관용구와 선택한 산업 용어팩을 적용합니다."
                  : "Presentation의 실시간 음성 번역 모델은 용어집 지시를 지원하지 않습니다. Meeting을 선택하면 사용할 수 있습니다."}</p>
              </div>
            </div>
          )}

          {wizardStep === 4 && (
            <div className="live-wizard-body">
              <dl className="live-review-list">
                <div><dt>세션</dt><dd>{sessionType === "presentation" ? "Presentation" : "Meeting"}</dd></div>
                <div><dt>출력</dt><dd>{selectedOutputLabel}</dd></div>
                <div><dt>자막 엔진</dt><dd>Gemini 고정</dd></div>
                {outputMode !== "captions" && <div><dt>음성 엔진</dt><dd>{voiceProvider === "openai" ? "OpenAI Realtime" : "Gemini"}</dd></div>}
                <div><dt>정원</dt><dd>{maxViewers}명</dd></div>
                <div><dt>언어</dt><dd>{languages.map((language) => languageLabel.get(language) ?? language).join(" · ")}</dd></div>
                <div><dt>용어</dt><dd>{sessionType === "meeting" ? `기본 관용구 + ${selectedGlossaryLabel}` : "적용 안 됨 · Meeting 전용"}</dd></div>
              </dl>
              <div className="live-wizard-actions">
                {session && <button type="button" className="glass-btn" onClick={() => {
                  setSessionType(session.sessionType); setOutputMode(session.outputMode); setVoiceProvider(session.voiceProvider); setMaxViewers(session.maxViewers);
                  setGlossaryPack(session.glossaryPack); setLanguages([...session.languages]); setIsEditingSession(false);
                }}>취소</button>}
                <button type="button" className="accent-btn live-primary-action" disabled={isBusy}
                  onClick={() => void (session ? applySession() : createSession())}>
                  {isBusy ? "저장 중…" : session ? "변경 적용" : "세션 준비"}
                </button>
              </div>
            </div>
          )}

          <div className="live-wizard-footer">
            <button type="button" className="glass-btn" disabled={wizardStep === 1} onClick={() => setWizardStep((wizardStep - 1) as 1 | 2 | 3 | 4)}>이전</button>
            {wizardStep < 4 && <button type="button" className="accent-btn" onClick={() => setWizardStep((wizardStep + 1) as 1 | 2 | 3 | 4)}>다음</button>}
          </div>
        </section>
      )}

      {session && (
        <section className="glass live-panel live-session-panel" aria-labelledby="session-heading">
          <div className="live-section-heading">
            <div><span>LIVE</span><h2 id="session-heading">호스트 세션</h2></div>
            <small aria-live="polite">{sessionSyncStatus}</small>
          </div>
          <>
              <dl className="live-session-facts">
                <div><dt>접속자</dt><dd>{session.viewerCount} / {session.maxViewers}</dd></div>
                <div><dt>세션 상태</dt><dd>{formatSessionStatus(session.status)}</dd></div>
                <div><dt>형식</dt><dd>{session.sessionType === "presentation" ? "Presentation" : "Meeting"}</dd></div>
                <div><dt>출력</dt><dd>{OUTPUT_OPTIONS.find((option) => option.value === session.outputMode)?.title}</dd></div>
                <div><dt>언어</dt><dd>{session.languages.map((language) => languageLabel.get(language) ?? language).join(" · ")}</dd></div>
                <div><dt>입장 만료</dt><dd>{formatTime(admission?.openUntil ?? session.admissionOpenUntil)}</dd></div>
                <div><dt>세션 만료</dt><dd>{formatTime(session.expiresAt)}</dd></div>
              </dl>
              {admission && (
                <div className="live-admission-code" aria-live="polite">
                  <span>공유 인증번호</span><strong>{admission.code}</strong>
                  <small>입장 만료 {formatTime(admission.openUntil)} · 링크가 안 되면 이 번호를 사용하세요.</small>
                  {invite && (
                    <>
                      <small>초대 링크 만료 {formatTime(invite.expiresAt)}</small>
                      <div className="live-invite-share">
                        <InviteQrCode value={invite.url} />
                        <div className="live-invite-actions">
                          <button type="button" className="live-invite-copy" onClick={() => void copyInviteLink()}
                            aria-label="시청자 초대 링크 복사">링크 복사</button>
                          <a className="live-invite-mail" href={inviteMailto} aria-label="기본 메일 앱에서 Live 초대 작성">메일로 초대</a>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
              <span className="live-invite-feedback" aria-live="polite">{inviteFeedback}</span>
              <div className="live-action-row">
                <button type="button" className={isBroadcasting ? "live-danger-button" : "accent-btn"} disabled={isBusy}
                  onClick={() => void (isBroadcasting ? stopBroadcast() : startBroadcast())}>
                  {isBroadcasting ? "송출 멈춤" : "음성 송출"}
                </button>
                <button type="button" className={admission ? "glass-btn" : "accent-btn"} disabled={isBusy}
                  aria-label={admission ? "새 시청자 입장창 닫기" : "새 시청자 입장창 열기"}
                  onClick={() => void (admission ? closeAdmission() : openAdmission())}>
                  {admission ? "입장창 닫기" : "입장창 열기"}
                </button>
                <button type="button" className="glass-btn" disabled={isBusy || isEditingSession} onClick={() => { setWizardStep(1); setIsEditingSession(true); }}>설정 변경</button>
                <button type="button" className="live-danger-button" disabled={isBusy} onClick={stopSession}>종료</button>
              </div>
            </>
        </section>
      )}

      <section className="glass live-panel live-monitor-panel" aria-labelledby="monitor-heading">
        <div className="live-section-heading">
          <div><span>05</span><h2 id="monitor-heading">언어 상태와 화자 범례</h2></div>
          <small aria-live="polite">{isBroadcasting ? gatewayStatus : session ? "송출 준비" : "세션 시작 후 표시"}</small>
        </div>
        <div className="live-monitor-grid">
          <div className="live-language-statuses">
            {(session?.languages ?? languages).map((language) => (
              <div key={language}><span className={`live-status-dot ${isBroadcasting && languageStatuses[language] === "ready" ? "is-live" : ""}`} aria-hidden="true" />
                <strong>{languageLabel.get(language) ?? language}</strong><small>
                  {isBroadcasting ? LANGUAGE_STATUS_LABELS[languageStatuses[language] ?? "preparing"] : "대기"}
                </small></div>
            ))}
          </div>
          <div className="live-speaker-legend">
            {speakers.length === 0 ? <p>Meeting에서 화자가 인식되면 세션 고정 라벨이 표시됩니다.</p> : speakers.map((speaker) => (
              <div key={speaker.speakerId}><span className="live-speaker-dot" style={{ backgroundColor: resolveSpeakerColor(speaker) }} aria-hidden="true" />
                <strong>{speaker.label}</strong>
                <span className="live-speaker-line" style={{ backgroundColor: resolveSpeakerColor(speaker) }} aria-hidden="true" />
                <small>음성 · {getSpeakerVoiceStatus(speaker, outputMode)}</small>
              </div>
            ))}
          </div>
        </div>
      </section>
      <p className="live-privacy-note">원본 음성·음성 특징은 저장하지 않으며, 마지막 확정 자막 스냅샷만 재연결을 위해 임시 보관합니다.</p>
    </main>
  );
}
