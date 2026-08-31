"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { hostMessages } from "@/lib/system-language/host-messages";

import type { ReactNode } from "react";

import type { LiveSessionStatus, LiveSpeechActivity } from "@/lib/live-contract";
import { CaptionEntry, TranslationToolbar, TranslationViewport } from "../translation";
import { HostAiHealthDisclosure, type HostAiHealthRows } from "./HostAiHealthDisclosure";

interface HostLiveSurfaceProps {
  sessionStatus: LiveSessionStatus;
  gatewayStatus: string;
  isBroadcasting: boolean;
  isBusy: boolean;
  audioRecoveryMessage: string;
  isEndConfirmVisible: boolean;
  recentSpeeches: readonly LiveSpeechActivity[];
  aiHealthRows: HostAiHealthRows;
  inspectorChildren: ReactNode;
  formatTime: (value: string | null) => string;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onRequestEnd: () => void;
  onCancelEnd: () => void;
  onEnd: () => void;
}

export function HostLiveSurface({
  sessionStatus, gatewayStatus, isBroadcasting, isBusy, audioRecoveryMessage,
  isEndConfirmVisible, recentSpeeches, aiHealthRows, inspectorChildren, formatTime,
  onStart, onPause, onResume, onRequestEnd, onCancelEnd, onEnd,
}: HostLiveSurfaceProps) {
  const t = useSystemText(hostMessages);
  return (
    <section className="live-host-translation-surface" data-host-surface-panel="live" aria-labelledby="host-translation-heading">
      <TranslationToolbar ariaLabel={t("호스트 실시간 자막 제어")}>
        <strong id="host-translation-heading">{t("실시간 자막")}</strong>
        <span className="live-host-current-status" role="status" aria-live="polite">
          {sessionStatus === "paused" ? t("일시 정지") : sessionStatus === "live" ? t("진행 중") : t("연결 중")} · {t(gatewayStatus)}
        </span>
        <div className="live-host-immediate-controls">
          {sessionStatus === "paused" ? (
            <button type="button" className="accent-btn" data-host-primary="live" disabled={isBusy} onClick={onResume}>{t("자막 계속")}</button>
          ) : isBroadcasting ? (
            <button type="button" className="accent-btn" data-host-primary="live" disabled={isBusy} onClick={onPause}>{t("자막 일시 정지")}</button>
          ) : (
            <button type="button" className="accent-btn" data-host-primary="live" disabled={isBusy || Boolean(audioRecoveryMessage)} onClick={onStart}>{t("자막 다시 연결")}</button>
          )}
          <button type="button" className="live-danger-button" disabled={isBusy} onClick={onRequestEnd}>{t("세션 종료…")}</button>
        </div>
      </TranslationToolbar>
      {audioRecoveryMessage && (
        <div className="live-audio-recovery" role="status" aria-live="polite">
          <span>{t(audioRecoveryMessage)}</span>
          <button type="button" className="accent-btn live-audio-recovery-action" disabled={isBusy} onClick={onStart}>{t("마이크 다시 연결")}</button>
        </div>
      )}
      {isEndConfirmVisible && (
        <div className="live-danger-confirm live-host-end-confirm" role="group" aria-label={t("세션 종료 확인")}>
          <span>{t("모든 참여자의 세션을 종료할까요?")}</span>
          <button type="button" className="glass-btn" disabled={isBusy} onClick={onCancelEnd}>{t("닫기")}</button>
          <button type="button" className="live-danger-button" disabled={isBusy} onClick={onEnd}>{t("세션 종료")}</button>
        </div>
      )}
      <div className="live-host-translation-composition">
        <div className="live-host-translation-primary">
          <TranslationViewport state={sessionStatus === "paused" ? "paused" : isBroadcasting ? "live" : "disconnected"}
            statusLabel={isBroadcasting ? undefined : t(gatewayStatus)}
            finalAnnouncement={recentSpeeches.at(-1)?.text}
            emptyLabel={t("실시간 자막이 여기에 표시됩니다.")}
            isEmpty={recentSpeeches.length === 0} ariaLabel={t("호스트 실시간 자막")}>
            {recentSpeeches.map((speech) => (
              <CaptionEntry key={`${speech.participantId}-${speech.seq}`} text={speech.text}
                speakerLabel={speech.displayName} timestamp={formatTime(speech.endedAt)} isFinal />
            ))}
          </TranslationViewport>
        </div>
        <aside className="live-host-inspector" aria-label={t("라이브 세션 정보")}>
          <HostAiHealthDisclosure rows={aiHealthRows} />
          {inspectorChildren}
        </aside>
      </div>
    </section>
  );
}
