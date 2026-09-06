import type { LiveSessionStore } from "./store";

export const LIVE_GATEWAY_PREWARM_LEAD_MILLISECONDS = 60 * 60_000;
export const LIVE_GATEWAY_PREWARM_LATE_GRACE_MILLISECONDS = 10 * 60_000;
export const LIVE_GATEWAY_PREWARM_TIMEOUT_MILLISECONDS = 20_000;

export interface ScheduledGatewayPrewarmResult {
  warmed: boolean;
  status: number | null;
}

export function getServerLiveGatewayHealthUrl(gatewayUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(gatewayUrl);
  } catch {
    throw new Error("INVALID_LIVE_GATEWAY_URL");
  }
  if (parsed.protocol !== "wss:" || parsed.pathname !== "/live" || parsed.port
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("INVALID_LIVE_GATEWAY_URL");
  }
  parsed.protocol = "https:";
  parsed.pathname = "/health";
  return parsed.toString();
}

export async function prewarmScheduledLiveGateway({
  store,
  gatewayUrl,
  now = Date.now,
  request = fetch,
}: {
  store: LiveSessionStore;
  gatewayUrl: string;
  now?: () => number;
  request?: typeof fetch;
}): Promise<ScheduledGatewayPrewarmResult> {
  const nowMilliseconds = now();
  const hasUpcomingSession = await store.hasPreparingScheduledBetween(
    new Date(nowMilliseconds - LIVE_GATEWAY_PREWARM_LATE_GRACE_MILLISECONDS).toISOString(),
    new Date(nowMilliseconds + LIVE_GATEWAY_PREWARM_LEAD_MILLISECONDS).toISOString(),
  );
  if (!hasUpcomingSession) return { warmed: false, status: null };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("LIVE_GATEWAY_PREWARM_TIMEOUT")), LIVE_GATEWAY_PREWARM_TIMEOUT_MILLISECONDS);
  try {
    const response = await request(getServerLiveGatewayHealthUrl(gatewayUrl), {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("LIVE_GATEWAY_PREWARM_UNHEALTHY");
    return { warmed: true, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}
