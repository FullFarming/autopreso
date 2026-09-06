import type { LiveSessionStatus } from "../live-contract";

export type GatewayConnectionState =
  | "idle"
  | "warming"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "paused"
  | "error"
  | "ended"
  | "failed";

export type GatewayConnectionEvent =
  | { type: "host-start" }
  | { type: "warmup-complete" }
  | { type: "viewer-session"; status: LiveSessionStatus }
  | { type: "socket-opened"; sessionStatus: LiveSessionStatus }
  | { type: "socket-closed"; sessionStatus: LiveSessionStatus }
  | { type: "recoverable-error" }
  | { type: "terminal-failure" }
  | { type: "retry" }
  | { type: "status-opened" }
  | { type: "reset" };

export function shouldWarmGatewayForEvent(event: GatewayConnectionEvent): boolean {
  return event.type === "host-start";
}

export function shouldConnectGatewayForSessionStatus(status: LiveSessionStatus): boolean {
  return status === "live" || status === "paused";
}

export function transitionGatewayConnectionState(
  state: GatewayConnectionState,
  event: GatewayConnectionEvent,
): GatewayConnectionState {
  if (event.type === "reset") return "idle";
  if (state === "ended" || state === "failed") return state;

  if (event.type === "host-start") return state === "idle" ? "warming" : state;
  if (event.type === "warmup-complete") return state === "warming" ? "connecting" : state;
  if (event.type === "status-opened") return state;
  if (event.type === "recoverable-error") return "error";
  if (event.type === "terminal-failure") return "failed";
  if (event.type === "retry") return state === "error" ? "reconnecting" : state;

  if (event.type === "viewer-session") {
    if (event.status === "stopped") return "ended";
    if (event.status === "failed") return "failed";
    if (event.status === "preparing") return "idle";
    if (event.status === "paused") {
      return state === "idle" || state === "error" ? "connecting" : "paused";
    }
    if (event.status === "live") {
      if (state === "idle" || state === "error") return "connecting";
      return state === "paused" ? "connected" : state;
    }
  }

  if (event.type === "socket-opened") {
    if (state !== "connecting" && state !== "reconnecting") return state;
    if (event.sessionStatus === "paused") return "paused";
    if (event.sessionStatus === "live") return "connected";
    if (event.sessionStatus === "stopped") return "ended";
    if (event.sessionStatus === "failed") return "failed";
    return "idle";
  }

  if (event.type === "socket-closed") {
    if (event.sessionStatus === "stopped") return "ended";
    if (event.sessionStatus === "failed") return "failed";
    if (shouldConnectGatewayForSessionStatus(event.sessionStatus)
      && (state === "connecting" || state === "connected" || state === "paused" || state === "reconnecting")) {
      return "reconnecting";
    }
    return "idle";
  }

  return state;
}
