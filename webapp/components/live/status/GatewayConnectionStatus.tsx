"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { hostMessages } from "@/lib/system-language/host-messages";

import type { ReactNode } from "react";

import {
  getGatewayConnectionPresentation,
  type GatewayConnectionState,
} from "./gateway-connection-presentation";
import styles from "./gateway-connection-status.module.css";

interface GatewayConnectionStatusProps {
  state: GatewayConnectionState;
  detail?: ReactNode;
}

export function GatewayConnectionStatus({ state, detail }: GatewayConnectionStatusProps) {
  const t = useSystemText(hostMessages);
  const presentation = getGatewayConnectionPresentation(state);
  return (
    <details className={styles.root} data-tone={presentation.tone}>
      <summary aria-label={`${t(presentation.label)}: ${t(presentation.stateLabel)}`}>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="4" />
          <path d="M4.7 4.7a7.5 7.5 0 0 0 0 10.6M15.3 4.7a7.5 7.5 0 0 1 0 10.6" />
        </svg>
        <span>{t(presentation.label)}</span>
        <strong role="status" aria-live="polite" aria-atomic="true">{t(presentation.stateLabel)}</strong>
      </summary>
      <div className={styles.detail}>
        {detail ?? <p>{state === "connected" ? t("자막을 실시간으로 받고 있습니다.") : t("기존 자막은 화면에 유지됩니다.")}</p>}
      </div>
    </details>
  );
}
