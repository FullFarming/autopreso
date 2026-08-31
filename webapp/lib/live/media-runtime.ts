import { z } from "zod";
import { getLiveStoreConfig } from "./config";
import { supabaseAdminHeaders } from "../security/supabase-server-access";

export const mediaRuntimeSchema = z.object({
  sessionId: z.string().uuid(),
  state: z.enum(["sleeping", "waking", "active", "draining", "failed", "ended"]),
  epoch: z.number().int().nonnegative().safe(),
  hostSourceReady: z.boolean(), hasDemand: z.boolean(),
  connectedCount: z.number().int().nonnegative(), pendingCount: z.number().int().nonnegative(),
  canPrepareConnection: z.boolean(),
  wakeDeadline: z.string().nullable(), idleAfter: z.string().nullable(),
}).passthrough();
export type MediaRuntime = z.infer<typeof mediaRuntimeSchema>;

export function isParticipantDemandEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = environment.LIVE_PARTICIPANT_DEMAND_ENABLED ?? "false";
  if (value !== "true" && value !== "false") throw new Error("INVALID_PARTICIPANT_DEMAND_ENABLED");
  return value === "true";
}

export class MediaRuntimeError extends Error {
  constructor(public readonly code: string) { super("실시간 연결 상태를 확인할 수 없습니다."); }
}

export async function callMediaRuntimeRpc(name: string, payload: Record<string, unknown>, fetchFn: typeof fetch = fetch): Promise<unknown> {
  const config = getLiveStoreConfig();
  const response = await fetchFn(`${config.baseUrl}/rest/v1/rpc/${name}`, {
    method: "POST", cache: "no-store", signal: AbortSignal.timeout(5_000),
    headers: { ...supabaseAdminHeaders(config.credential), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new MediaRuntimeError("MEDIA_CONTROL_UNAVAILABLE");
  return response.json();
}

export async function readMediaRuntime(sessionId: string): Promise<MediaRuntime | null> {
  if (!isParticipantDemandEnabled()) return null;
  const result = await callMediaRuntimeRpc("get_live_media_runtime_v1", { p_session_id: sessionId });
  if (result === null) return null;
  return mediaRuntimeSchema.parse(result);
}

export function publicMediaRuntime(runtime: MediaRuntime | null) {
  if (!runtime) return { enabled: false };
  return { enabled: true, sessionId: runtime.sessionId, state: runtime.state, epoch: runtime.epoch,
    hostSourceReady: runtime.hostSourceReady, hasDemand: runtime.hasDemand,
    connectedCount: runtime.connectedCount, pendingCount: runtime.pendingCount,
    canPrepareConnection: runtime.canPrepareConnection, wakeDeadline: runtime.wakeDeadline, idleAfter: runtime.idleAfter };
}

export async function requestMediaStart(sessionId: string, hostId: string, version: number) {
  if (!isParticipantDemandEnabled()) throw new MediaRuntimeError("MEDIA_DEMAND_DISABLED");
  return mediaRuntimeSchema.parse(await callMediaRuntimeRpc("request_live_media_start_v1", {
    p_session_id: sessionId, p_host_id: hostId, p_expected_version: version,
  }));
}

export async function prepareViewerMediaConnection(sessionId: string, grantId: string, userId: string) {
  if (!await readMediaRuntime(sessionId)) return null;
  const result = await callMediaRuntimeRpc("prepare_live_viewer_connection_v1", {
    p_session_id: sessionId, p_grant_id: grantId, p_user_id: userId, p_connection_id: crypto.randomUUID(),
  });
  return z.object({ status: z.enum(["READY", "HOST_WAITING"]), runtime: mediaRuntimeSchema,
    connectionId: z.string().uuid().nullable(), expiresAt: z.string().nullable() }).parse(result);
}
