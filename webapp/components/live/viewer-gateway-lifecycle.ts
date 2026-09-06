export type ViewerGatewaySessionStatus = "preparing" | "live" | "paused" | "stopped" | "failed";
export type ViewerGatewayStatusDecision = "reconnect" | "wait" | "ended" | "failed";

export interface ViewerGatewayConnectionGate {
  connectedKey: string | null;
  connectionKey: string | null;
  inFlight: Promise<void> | null;
  generation: number;
}

export interface ViewerGatewayTicketData {
  ticket: string;
  expiresAt: string;
  connectionId?: string;
  epoch?: number;
}

export function isViewerGatewayTicketData(value: unknown): value is ViewerGatewayTicketData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ticketData = value as Record<string, unknown>;
  const keys = Object.keys(ticketData);
  if (keys.some((key) => !["ticket", "expiresAt", "connectionId", "epoch"].includes(key))) return false;
  const hasDemand = "connectionId" in ticketData || "epoch" in ticketData;
  if (hasDemand && (typeof ticketData.connectionId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(ticketData.connectionId)
    || !Number.isSafeInteger(ticketData.epoch) || Number(ticketData.epoch) < 1)) return false;
  if (typeof ticketData.ticket !== "string" || ticketData.ticket.length < 1 || ticketData.ticket.length > 4_096) return false;
  if (typeof ticketData.expiresAt !== "string" || ticketData.expiresAt.length > 64) return false;
  return Number.isFinite(Date.parse(ticketData.expiresAt));
}

export function createViewerGatewayConnectionGate(): ViewerGatewayConnectionGate {
  return { connectedKey: null, connectionKey: null, inFlight: null, generation: 0 };
}

export function shouldConnectViewerGateway(
  status: ViewerGatewaySessionStatus,
  isSessionEnded: boolean,
): boolean {
  return !isSessionEnded && (status === "live" || status === "paused");
}

export function resolveViewerGatewayStatusDecision(
  status: string | undefined,
): ViewerGatewayStatusDecision {
  if (status === "stopped") return "ended";
  if (status === "failed") return "failed";
  if (status === "live" || status === "paused") return "reconnect";
  return "wait";
}

export function isCurrentViewerGatewayRequest(
  expectedGeneration: number,
  currentGeneration: number,
  expectedSessionId: string,
  activeSessionId: string | null,
): boolean {
  return expectedGeneration === currentGeneration && expectedSessionId === activeSessionId;
}

export function resetViewerGatewayConnectionGate(gate: ViewerGatewayConnectionGate): void {
  gate.generation += 1;
  gate.connectedKey = null;
  gate.connectionKey = null;
  gate.inFlight = null;
}

export function connectViewerGatewayOnce(
  gate: ViewerGatewayConnectionGate,
  connectionKey: string,
  connect: () => Promise<void>,
): Promise<void> {
  if (gate.connectedKey === connectionKey) return Promise.resolve();
  if (gate.inFlight && gate.connectionKey === connectionKey) return gate.inFlight;

  const generation = gate.generation + 1;
  gate.generation = generation;
  gate.connectedKey = null;
  gate.connectionKey = connectionKey;
  let connection: Promise<void>;
  try {
    connection = connect();
  } catch (error: unknown) {
    connection = Promise.reject(error);
  }
  const tracked = connection
    .then(() => {
      if (gate.generation === generation) gate.connectedKey = connectionKey;
    })
    .finally(() => {
      if (gate.generation === generation && gate.inFlight === tracked) gate.inFlight = null;
    });
  gate.inFlight = tracked;
  return tracked;
}
