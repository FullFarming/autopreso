"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { hostMessages } from "@/lib/system-language/host-messages";

import styles from "./scheduled-gateway-countdown.module.css";

export type ScheduledGatewayCountdownState =
  | "countdown"
  | "warming"
  | "connecting"
  | "confirming"
  | "action-required"
  | "cancelled";

interface ScheduledGatewayCountdownProps {
  remainingMilliseconds: number;
  state: ScheduledGatewayCountdownState;
  onRetry: () => void;
  onCancel: () => void;
}

function formatRemaining(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

const STATE_LABELS: Record<ScheduledGatewayCountdownState, string> = {
  countdown: "예약 시작 대기",
  warming: "게이트웨이 준비 중",
  connecting: "라이브 연결 중",
  confirming: "라이브 상태 확인 중",
  "action-required": "자동 시작을 완료하지 못했습니다",
  cancelled: "자동 시작 취소됨",
};

export function ScheduledGatewayCountdown({ remainingMilliseconds, state, onRetry, onCancel }: ScheduledGatewayCountdownProps) {
  const t = useSystemText(hostMessages);
  return (
    <section className={styles.root} aria-label={t("예약 라이브 시작 상태")} data-state={state}>
      <div>
        <span>{t(STATE_LABELS[state])}</span>
        {(state === "countdown" || state === "warming") && <strong role="timer" aria-label={t("예정 시작까지 남은 시간")}>{formatRemaining(remainingMilliseconds)}</strong>}
      </div>
      <p aria-live="polite" aria-atomic="true">
        {state === "action-required" ? t("연결을 확인한 뒤 다시 시도하거나 자동 시작을 취소해 주세요.") : t(STATE_LABELS[state])}
      </p>
      {state === "action-required" && (
        <div className={styles.actions}>
          <button type="button" onClick={onRetry}>{t("다시 시도")}</button>
          <button type="button" onClick={onCancel}>{t("자동 시작 취소")}</button>
        </div>
      )}
    </section>
  );
}
