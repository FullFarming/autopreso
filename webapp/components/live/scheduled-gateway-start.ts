import type { LiveSessionStatus } from "@/lib/live-contract";
import { getLiveGatewayHealthUrl, prewarmLiveGateway } from "./live-audio-client";

export const SCHEDULED_START_RETRY_OFFSETS = [0, 2_000, 5_000, 10_000, 20_000] as const;
export const SCHEDULED_GATEWAY_PREWARM_LEAD_MILLISECONDS = 3_600_000 as const;

export function resolveScheduledGatewayPrewarmLeadMilliseconds(value: string | undefined): 0 | 3_600_000 {
  // Registered Live Calls warm one hour before start by default. Operators can
  // explicitly opt out for a development deployment, but an omitted variable
  // must not silently skip the event-readiness contract.
  return value?.trim().toLowerCase() === "false" ? 0 : SCHEDULED_GATEWAY_PREWARM_LEAD_MILLISECONDS;
}

interface ScheduledGatewayStartInput {
  now: number;
  scheduledAt: number;
  manualStartedAt: number | null;
  prewarmLeadMilliseconds?: 0 | 3_600_000;
  hasWarmed: boolean;
  attemptedThrough: number;
  hasGatewayStartedAck: boolean;
  isCancelled: boolean;
  sessionStatus: LiveSessionStatus;
}

export type ScheduledGatewayStartDecision =
  | { action: "wait"; delayMilliseconds: number }
  | { action: "warm" }
  | { action: "start"; attemptIndex: number }
  | { action: "confirming" }
  | { action: "action-required" }
  | { action: "cancelled" }
  | { action: "complete" };

export function canCancelScheduledGatewayStart(input: {
  isFlightPending: boolean;
  hasGatewayStartedAck: boolean;
  sessionStatus: LiveSessionStatus;
}): boolean {
  return input.sessionStatus === "preparing" && !input.isFlightPending && !input.hasGatewayStartedAck;
}

export interface ScheduledGatewayStartIntent {
  sessionId: string;
  status: "preparing";
  version: number;
  activationKey: string;
}

interface StartIntentEnvelope {
  ok: boolean;
  data?: unknown;
  error?: unknown;
}

const ACTIVATION_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function parseStartIntent(
  value: unknown,
  expectedSessionId: string,
  expectedVersion: number,
): ScheduledGatewayStartIntent {
  if (!value || typeof value !== "object") throw new Error("라이브 시작 응답을 확인할 수 없습니다.");
  const envelope = value as StartIntentEnvelope;
  if (!envelope.ok || !envelope.data || typeof envelope.data !== "object") {
    throw new Error("라이브 시작을 준비하지 못했습니다.");
  }
  const data = envelope.data as Record<string, unknown>;
  if (Object.keys(data).filter((key) => key !== "runtime").sort().join(",") !== "activationKey,sessionId,status,version"
    || data.sessionId !== expectedSessionId || data.status !== "preparing"
    || data.version !== expectedVersion
    || typeof data.activationKey !== "string" || !ACTIVATION_KEY_PATTERN.test(data.activationKey)) {
    throw new Error("라이브 시작 응답을 확인할 수 없습니다.");
  }
  return {
    sessionId: expectedSessionId,
    status: "preparing",
    version: Number(data.version),
    activationKey: data.activationKey,
  };
}

export function createScheduledGatewayStartTransport(request: typeof fetch = fetch, demandEnabled = false) {
  const startFlights = new Map<string, {
    activationKey?: string;
    activationVersion: number;
    pending?: Promise<ScheduledGatewayStartIntent>;
  }>();
  return {
    async prepare(sessionId: string, version: number): Promise<ScheduledGatewayStartIntent> {
      if (!Number.isSafeInteger(version) || version < 1) throw new Error("라이브 시작 버전을 확인할 수 없습니다.");
      let flight = startFlights.get(sessionId);
      if (!flight) {
        flight = { activationVersion: version };
        startFlights.set(sessionId, flight);
      }
      if (flight.activationKey) {
        return { sessionId, status: "preparing", version: flight.activationVersion, activationKey: flight.activationKey };
      }
      if (flight.pending) return flight.pending;
      const pending = (async () => {
        const response = await request(`/api/live-sessions/${sessionId}/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: flight.activationVersion, ...(demandEnabled ? { demandEnabled: true } : {}) }),
        });
        const intent = parseStartIntent(await response.json(), sessionId, flight.activationVersion);
        flight.activationKey = intent.activationKey;
        return intent;
      })();
      flight.pending = pending;
      try {
        return await pending;
      } finally {
        if (flight.pending === pending) delete flight.pending;
      }
    },
    getFlight(sessionId: string): Readonly<{ activationKey: string; activationVersion: number }> | undefined {
      const flight = startFlights.get(sessionId);
      return flight?.activationKey ? { activationKey: flight.activationKey, activationVersion: flight.activationVersion } : undefined;
    },
    clear(sessionId: string): void {
      startFlights.delete(sessionId);
    },
  };
}

export function resolveScheduledGatewayStart(input: ScheduledGatewayStartInput): ScheduledGatewayStartDecision {
  if (["live", "paused", "stopped", "failed"].includes(input.sessionStatus)) return { action: "complete" };
  if (input.isCancelled) return { action: "cancelled" };
  if (input.hasGatewayStartedAck) return { action: "confirming" };

  const activationAt = input.manualStartedAt ?? input.scheduledAt;
  const prewarmLeadMilliseconds = input.prewarmLeadMilliseconds ?? 0;
  if (input.manualStartedAt === null && input.now < input.scheduledAt - prewarmLeadMilliseconds) {
    return { action: "wait", delayMilliseconds: input.scheduledAt - prewarmLeadMilliseconds - input.now };
  }
  if (input.manualStartedAt === null && prewarmLeadMilliseconds > 0
    && !input.hasWarmed && input.now < input.scheduledAt) {
    return { action: "warm" };
  }
  if (input.now < activationAt) return { action: "wait", delayMilliseconds: activationAt - input.now };

  const elapsed = input.now - activationAt;
  if (elapsed >= 30_000) return { action: "action-required" };
  let dueAttempt = 0;
  for (let index = 0; index < SCHEDULED_START_RETRY_OFFSETS.length; index += 1) {
    if (SCHEDULED_START_RETRY_OFFSETS[index] <= elapsed) dueAttempt = index;
  }
  if (dueAttempt > input.attemptedThrough) return { action: "start", attemptIndex: dueAttempt };
  const nextOffset = SCHEDULED_START_RETRY_OFFSETS[input.attemptedThrough + 1] ?? 30_000;
  return { action: "wait", delayMilliseconds: Math.max(1, activationAt + nextOffset - input.now) };
}

export function getScheduledGatewayHealthUrl(gatewayUrl: string): string {
  return getLiveGatewayHealthUrl(gatewayUrl);
}

export async function warmScheduledGateway(gatewayUrl: string): Promise<void> {
  return prewarmLiveGateway(gatewayUrl);
}
