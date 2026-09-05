"use client";

import { useId, useMemo, useState } from "react";
import { ParticipantSpeakButton } from "@/components/live/ParticipantSpeakButton";
import { ViewerSessionContext } from "@/components/live/LiveViewer";
import { SystemLanguageButton } from "@/components/system-language/SystemLanguageButton";
import { ViewerReadingFeed } from "@/components/live/ViewerReadingFeed";
import { ParticipantMeetingMinutes } from "@/components/live/ParticipantMeetingMinutes";
import type { ViewerRecapClient } from "@/components/live/ViewerRecapRequest";
import { RECAP_REQUEST_NOTICE_VERSION, type ViewerRecapRequest } from "@/components/live/recap-request-client";
import { ControlDrawer, TranslationLaneTabs, TranslationToolbar, buildTranslationLanes, projectCaptionLane, type CaptionLaneInput } from "@/components/live/translation";
import { mergeViewerSourceLedger, presentViewerSourceEvent } from "@/components/live/viewer-source-ledger";
import type { SourceEvent } from "@/lib/live/source-contract";
import type { MeetingSummary } from "@/lib/live/summary";
import { useSystemLanguage, useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { SYSTEM_LOCALES } from "@/lib/system-language";
import { demoMessages } from "./demo-messages";

const LANES = buildTranslationLanes(null, ["ko", "en"]).map((lane) => ({
  ...lane, label: lane.kind === "source" ? "원문" : lane.language === "ko" ? "한국어" : "English",
}));
const STATES = ["normal", "denied", "degraded", "disconnected", "empty", "ended", "request-error", "expired"] as const;
type PreviewState = typeof STATES[number];
const STATE_LABELS: Record<PreviewState, string> = { normal: "라이브 · 발언 가능", denied: "라이브 · 발언 불가", degraded: "번역 지연", disconnected: "연결 끊김", empty: "자막 대기", ended: "회의 종료", "request-error": "수신 신청 실패", expired: "6시간 만료" };
const SPEECH_STEPS = [
  { label: "1 · 한국어 발언", sourceLanguage: "ko", source: "2분기 매출은 전년 대비 24퍼센트 증가했습니다. 클라우드와 AI 서비스의 성장이 실적을 이끌었습니다.",
    ko: "2분기 매출은 전년 대비 24퍼센트 증가했습니다. 클라우드와 AI 서비스의 성장이 실적을 이끌었습니다.",
    en: "Second-quarter revenue increased by 24 percent year over year. Cloud and AI services led this growth." },
  { label: "2 · 영어 발언까지", sourceLanguage: "en", source: "We will continue investing in generative AI in the second half, focusing on customer experience and operational efficiency.",
    ko: "하반기에는 생성형 AI 투자를 이어갑니다. 고객 경험을 개선하고 운영 효율을 높이는 데 집중하겠습니다.",
    en: "We will continue investing in generative AI in the second half, focusing on customer experience and operational efficiency." },
  { label: "3 · 혼합 발언까지", sourceLanguage: "und", source: "생성형 AI 투자를 이어가고, we will share the priorities and timeline next quarter.",
    ko: "생성형 AI 투자를 이어가고, 투자 우선순위와 구체적인 일정은 다음 분기에 공유하겠습니다.",
    en: "We will continue investing in generative AI and share the priorities and timeline next quarter." },
];
const SOURCE = SPEECH_STEPS.map((step) => step.source);
const SUMMARY: MeetingSummary = {
  title: "2026년 2분기 실적 발표", overview: "클라우드와 AI 서비스 성장으로 매출이 전년 대비 24% 증가했습니다. 하반기에는 고객 경험과 운영 효율을 위한 생성형 AI 투자를 이어갑니다.",
  chapters: [{ title: "2분기 실적", summary: "클라우드와 AI 서비스가 매출 성장을 이끌었습니다." }, { title: "하반기 투자 계획", summary: "생성형 AI 투자를 이어가며 구체적인 일정은 다음 분기에 공유합니다." }],
  decisions: [], actionItems: [{ description: "다음 분기에 투자 우선순위와 일정 공유", owner: "경영진", due: "" }], speakerHighlights: [], participationStats: [],
};
const DEMO_SESSION_ID = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";

const SOURCE_EVENTS: SourceEvent[] = SPEECH_STEPS.map((step, index) => ({
  type: "source", sessionId: DEMO_SESSION_ID,
  sourceUtteranceId: `0192d0f4-9f72-7a36-91f5-${String(index + 1).padStart(12, "0")}`,
  sourceSeq: index + 1, utteranceKey: `demo-source:${index + 1}`, text: step.source,
  sourceLanguage: step.sourceLanguage, languageObservation: step.sourceLanguage === "und"
    ? { state: "mixed", languageCode: "und", providerLanguageCode: null, evidence: "script", languages: ["ko", "en"] }
    : { state: "single", languageCode: step.sourceLanguage, providerLanguageCode: step.sourceLanguage, evidence: "provider", languages: [step.sourceLanguage] },
  speaker: { role: "host", label: "김노바 · 대표이사" }, isFinal: true,
  sourceStartedAt: null, sourceEndedAt: `2026-08-31T13:4${index}:00+09:00`, emittedAt: `2026-08-31T13:4${index}:00+09:00`,
}));

export default function MobileWatchDemoPage() {
  const t = useSystemText(demoMessages);
  const { language } = useSystemLanguage();
  const meetingDate = new Intl.DateTimeFormat(SYSTEM_LOCALES[language], { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Seoul" }).format(new Date("2026-08-31T13:30:00+09:00"));
  const previewStateFieldId = useId();
  const speechStepFieldId = useId();
  const [speechStep, setSpeechStep] = useState(2);
  const [selectedLaneId, setSelectedLaneId] = useState("source");
  const [previewState, setPreviewState] = useState<PreviewState>("normal");
  const [isDraftFinal, setIsDraftFinal] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const isEnded = ["ended", "request-error", "expired"].includes(previewState);
  const selectedLane = LANES.find((lane) => lane.id === selectedLaneId) ?? LANES[0];
  const captions = useMemo(() => {
    if (previewState === "empty") return [];
    const visible = SPEECH_STEPS.slice(0, speechStep + 1);
    if (selectedLane.kind === "source") {
      const finalized = SOURCE_EVENTS.slice(0, isDraftFinal ? speechStep + 1 : speechStep);
      const records = mergeViewerSourceLedger([], finalized).map(presentViewerSourceEvent);
      if (isDraftFinal) return records;
      const draft = visible.at(-1)!;
      return [...records, { id: "demo-source-draft", text: draft.source, language: draft.sourceLanguage,
        speakerLabel: "김노바 · 대표이사", timestamp: `13:4${speechStep}`, isFinal: false }];
    }
    const inputs: CaptionLaneInput[] = visible.map((step, index) => ({
      id: `demo-${selectedLane.language}:${index + 1}`, utteranceKey: `demo-target:${index + 1}`,
      text: selectedLane.language === "ko" ? step.ko : step.en,
      language: selectedLane.language, sourceLanguage: step.sourceLanguage, sourceText: step.source,
      speakerLabel: "김노바 · 대표이사", timestamp: `13:4${index}`, isFinal: index < speechStep || isDraftFinal,
      translationStatus: step.sourceLanguage === selectedLane.language ? "verbatim" : "translated",
      ...(step.sourceLanguage === selectedLane.language ? { origin: "source" as const } : {}),
    }));
    return projectCaptionLane(inputs, selectedLane);
  }, [isDraftFinal, previewState, selectedLane, speechStep]);
  const recapClient = useMemo<ViewerRecapClient>(() => {
    let saved: ViewerRecapRequest | null = null;
    return {
      read: async () => saved,
      save: async (sessionId) => {
        if (previewState === "request-error") throw new Error("수신 신청을 저장하지 못했어요. 다시 시도해 주세요.");
        saved ??= { id: "demo-request", sessionId, requestedAt: new Date().toISOString(), noticeVersion: RECAP_REQUEST_NOTICE_VERSION, status: "requested", email: "participant@example.com", revision: 1 };
        return saved;
      },
    };
  }, [previewState]);
  return <main className="live-viewer-shell is-compact live-viewer-topic-demo" data-inline-system-language="true" data-preview="desktop mobile" data-reading-state={isEnded ? "ended" : "live"}>
    <div className="live-viewer-translation-layout viewer-notebook">
      <TranslationToolbar ariaLabel={t("실시간 자막 제어")}>
        <strong>NOVA</strong><span className="viewer-session-status">{t(isEnded ? "회의 종료" : "라이브")}</span>
        <SystemLanguageButton compact />
        <ControlDrawer iconOnly triggerLabel={t("더보기")} title={t("미리보기 제어")}>
          <ViewerSessionContext title="2026년 2분기 실적 발표" scheduledAt="2026-08-31T13:30:00+09:00" />
          <label className="live-topic-demo-state-selector" htmlFor={previewStateFieldId}><span>{t("미리보기 상태")}</span>
            <select id={previewStateFieldId} name="previewState" aria-label={t("미리보기 상태")} value={previewState} onChange={(event) => {
              const value = event.currentTarget.value;
              if (STATES.some((state) => state === value)) { setPreviewState(value as PreviewState); setIsSpeaking(false); }
            }}>{STATES.map((state) => <option key={state} value={state}>{t(STATE_LABELS[state])}</option>)}</select>
          </label>
          <label className="live-topic-demo-state-selector" htmlFor={speechStepFieldId}><span>{t("같은 화자의 발언 진행")}</span>
            <select id={speechStepFieldId} name="speechStep" aria-label={t("같은 화자의 발언 진행")} value={speechStep} onChange={(event) => {
              const step = Number(event.currentTarget.value);
              if (Number.isInteger(step) && step >= 0 && step < SPEECH_STEPS.length) { setSpeechStep(step); setIsDraftFinal(false); }
            }}>{SPEECH_STEPS.map((step, index) => <option key={step.sourceLanguage} value={index}>{t(step.label)}</option>)}</select>
          </label>
          <button className="viewer-text-button" type="button" onClick={() => setIsDraftFinal((current) => !current)}>{t(isDraftFinal ? "마지막 문장을 작성 중으로" : "마지막 문장 확정")}</button>
          <p>{t("시연용 화면입니다. 실제 신청이나 이메일 발송은 발생하지 않습니다.")}</p>
        </ControlDrawer>
      </TranslationToolbar>
      <header className="viewer-meeting-heading"><span className="viewer-muted">노바 테크놀로지</span><h1>2026년 2분기 실적 발표</h1>
        {isEnded ? <><p>{t("오늘 {time}까지 열람할 수 있어요", { time: "20:00" })}</p><p className="viewer-muted">{t("회의 종료 {time} · 종료 후 6시간", { time: "14:00" })}</p><p className="viewer-muted">{t("새로고침해도 열람 기한까지 기록을 이어서 볼 수 있어요.")}</p></> : <p className="viewer-muted">{t("{date} · 실시간 번역", { date: meetingDate })}</p>}
      </header>
      {isEnded ? <ParticipantMeetingMinutes key={previewState} sessionId={DEMO_SESSION_ID} email="participant@example.com" summary={SUMMARY}
        transcript={SOURCE.map((text, index) => ({ seq: index + 1, text, speaker: "김노바 · 대표이사", sourceLanguage: SPEECH_STEPS[index].sourceLanguage, emittedAt: `2026-08-31T13:4${index}:00+09:00` }))}
        topics={[]} recordingGaps={[{ id: "0192d0f4-9f72-7a36-91f5-6a76ef736f48", startedAt: "2026-08-31T13:30:00+09:00", endedAt: "2026-08-31T13:40:00+09:00", reason: "no_viewers" }]} isTranscriptLoaded summaryError="" transcriptError="" isLoading={false} isExpired={previewState === "expired"} onRetry={() => undefined} recapClient={recapClient} />
        : <>{previewState === "disconnected" && <p className="live-error" role="alert">{t("연결이 끊겼어요. 기존 자막을 유지하며 연결 상태를 확인하고 있어요.")}</p>}
          {previewState === "degraded" && <p role="status">{t("번역이 지연되고 있어요. 이전 문장은 계속 읽을 수 있어요.")}</p>}
          <div className="live-viewer-caption-region"><TranslationLaneTabs participantControls lanes={LANES} selectedLaneId={selectedLaneId} onChange={(lane) => setSelectedLaneId(lane.id)} ariaLabel={t("자막 언어")}
            renderPanel={() => <ViewerReadingFeed key={selectedLane.id} captions={captions} language={selectedLane.language} kind={selectedLane.kind} />} /></div>
          {previewState !== "denied" && <div className="viewer-microphone-slot"><ParticipantSpeakButton state={isSpeaking ? "speaking" : "idle"}
            disabled={previewState === "disconnected" && !isSpeaking}
            onClick={() => setIsSpeaking((current) => !current)} />
            {isSpeaking && <p role="status">{t("발언 상태 미리보기 · 실제 마이크는 사용하지 않아요.")}</p>}</div>}
        </>}
    </div>
  </main>;
}
