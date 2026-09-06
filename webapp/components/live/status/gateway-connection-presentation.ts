import type { GatewayConnectionState } from "@/lib/live/gateway-connection-state";

export type { GatewayConnectionState } from "@/lib/live/gateway-connection-state";

export interface GatewayConnectionPresentation {
  label: "실시간 연결";
  stateLabel: string;
  tone: "neutral" | "working" | "ok" | "warn" | "error";
}

export function getGatewayConnectionPresentation(state: GatewayConnectionState): GatewayConnectionPresentation {
  const statePresentation: Record<GatewayConnectionState, Omit<GatewayConnectionPresentation, "label">> = {
    idle: { stateLabel: "대기", tone: "neutral" },
    warming: { stateLabel: "준비 중", tone: "working" },
    connecting: { stateLabel: "연결 중", tone: "working" },
    connected: { stateLabel: "연결됨", tone: "ok" },
    reconnecting: { stateLabel: "다시 연결 중", tone: "warn" },
    error: { stateLabel: "연결 확인 필요", tone: "error" },
    paused: { stateLabel: "일시 정지", tone: "warn" },
    ended: { stateLabel: "종료됨", tone: "neutral" },
    failed: { stateLabel: "연결 종료", tone: "error" },
  };
  return { label: "실시간 연결", ...statePresentation[state] };
}
