"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { hostMessages } from "@/lib/system-language/host-messages";


import type { ReactNode } from "react";

import type { CaptionEvent, LiveSessionStatus } from "@/lib/live-contract";
import type { SourceEvent } from "@/lib/live/source-contract";
import { LANGUAGE_LABELS } from "@/lib/languageDetect";
import { GatewayConnectionStatus, type GatewayConnectionState } from "../status";
import {
  CaptionEntry,
  TranslationLaneTabs,
  TranslationToolbar,
  TranslationViewport,
  buildTranslationLanes,
  projectCaptionLane,
  type CaptionLaneInput,
  type TranslationLanePresentation,
} from "../translation";
import { HostAiHealthDisclosure, type HostAiHealthRows } from "../quality/HostAiHealthDisclosure";

interface HostLiveLaneSurfaceProps {
  sessionStatus: LiveSessionStatus;
  connectionState: GatewayConnectionState;
  gatewayStatus: string;
  languages: readonly string[];
  captions: readonly CaptionEvent[];
  sources: readonly SourceEvent[];
  sourceStatusMessage: string;
  selectedLaneId: string;
  aiHealthRows: HostAiHealthRows;
  inspectorChildren: ReactNode;
  isBroadcasting: boolean;
  isBusy: boolean;
  audioRecoveryMessage: string;
  isEndConfirmVisible: boolean;
  onSelectLane: (lane: TranslationLanePresentation) => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onRequestEnd: () => void;
  onCancelEnd: () => void;
  onEnd: () => void;
  formatTime: (value: string | null) => string;
}

export function HostLiveLaneSurface(props: HostLiveLaneSurfaceProps) {
  const t = useSystemText(hostMessages);
  const lanes = buildTranslationLanes("source", props.languages).map((lane) => ({ ...lane,
    label: t(lane.kind === "source" ? "원문" : LANGUAGE_LABELS[lane.language] ?? lane.label),
  }));
  const captionInputs: CaptionLaneInput[] = props.captions.map((caption, index) => ({
    id: caption.utteranceKey ?? `${caption.language}:${caption.seq}`,
    utteranceKey: caption.utteranceKey,
    language: caption.language,
    sourceLanguage: caption.sourceLanguage,
    translationCapture: caption.translationCapture,
    languageObservation: caption.languageObservation,
    origin: caption.origin,
    text: caption.text,
    sourceText: caption.sourceText,
    speakerLabel: caption.speaker?.name ?? caption.speaker?.label ?? t("발표자"),
    timestamp: props.formatTime(caption.emittedAt),
    isFinal: caption.isFinal,
    translationStatus: caption.translationStatus,
    isActive: index === props.captions.length - 1,
  }));
  const sourceInputs = props.sources.map((source) => ({
    id: source.sourceUtteranceId, text: source.text, isFinal: true,
    speakerLabel: source.speaker.label, timestamp: props.formatTime(source.sourceEndedAt),
  }));
  const renderLane = (lane: TranslationLanePresentation) => {
    const projected = lane.kind === "source" ? sourceInputs : projectCaptionLane(captionInputs, lane);
    return (
      <TranslationViewport state={props.sessionStatus === "paused" ? "paused" : props.isBroadcasting ? "live" : "disconnected"}
        statusLabel={lane.kind === "source" && props.sourceStatusMessage ? t(props.sourceStatusMessage) : props.isBroadcasting ? undefined : t(props.gatewayStatus)}
        finalAnnouncement={projected.at(-1)?.text}
        emptyLabel={t(lane.kind === "source" ? "저장된 원문이 아직 없습니다." : "이 언어의 자막이 아직 없습니다.")} isEmpty={projected.length === 0}
        ariaLabel={t("{language} 자막", { language: lane.label })}>
        {projected.map((caption) => <CaptionEntry key={caption.id} {...caption} />)}
      </TranslationViewport>
    );
  };

  return (
    <section className="live-host-translation-surface" data-host-surface-panel="live" aria-labelledby="host-translation-heading">
      <TranslationToolbar ariaLabel={t("호스트 실시간 자막 제어")}>
        <strong id="host-translation-heading">{t("실시간 자막")}</strong>
        <div className="live-host-immediate-controls">
          {props.sessionStatus === "paused" ? <button type="button" className="accent-btn" disabled={props.isBusy} onClick={props.onResume}>{t("자막 계속")}</button>
            : props.isBroadcasting ? <button type="button" className="accent-btn" disabled={props.isBusy} onClick={props.onPause}>{t("자막 일시 정지")}</button>
            : <button type="button" className="accent-btn" disabled={props.isBusy || Boolean(props.audioRecoveryMessage)} onClick={props.onStart}>{t("자막 다시 연결")}</button>}
          <button type="button" className="live-danger-button" disabled={props.isBusy} onClick={props.onRequestEnd}>{t("세션 종료…")}</button>
        </div>
        <GatewayConnectionStatus state={props.connectionState} detail={<p>{t(props.gatewayStatus)}</p>} />
      </TranslationToolbar>
      {props.audioRecoveryMessage && <div className="live-audio-recovery" role="status" aria-live="polite"><span>{t(props.audioRecoveryMessage)}</span><button type="button" className="accent-btn live-audio-recovery-action" disabled={props.isBusy} onClick={props.onStart}>{t("마이크 다시 연결")}</button></div>}
      {props.isEndConfirmVisible && <div className="live-danger-confirm live-host-end-confirm" role="group" aria-label={t("세션 종료 확인")}><span>{t("모든 참여자의 세션을 종료할까요?")}</span><button type="button" className="glass-btn" disabled={props.isBusy} onClick={props.onCancelEnd}>{t("닫기")}</button><button type="button" className="live-danger-button" disabled={props.isBusy} onClick={props.onEnd}>{t("세션 종료")}</button></div>}
      <div className="live-host-translation-composition">
        <div className="live-host-translation-primary"><TranslationLaneTabs lanes={lanes} selectedLaneId={props.selectedLaneId} onChange={props.onSelectLane} renderPanel={renderLane} ariaLabel={t("호스트 자막 언어")} /></div>
        <aside className="live-host-inspector" aria-label={t("라이브 세션 정보")}><HostAiHealthDisclosure rows={props.aiHealthRows} />{props.inspectorChildren}</aside>
      </div>
    </section>
  );
}
