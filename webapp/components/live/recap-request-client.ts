import { z } from "zod";

export const RECAP_REQUEST_NOTICE_VERSION = "summary-original-email-v2";
const requestSchema = z.object({ id: z.string(), sessionId: z.string(), requestedAt: z.string(),
  noticeVersion: z.string(), status: z.enum(["requested", "cancelled"]), email: z.string(), revision: z.number().int() });
export type ViewerRecapRequest = z.infer<typeof requestSchema>;

export async function readRecapRequest(sessionId: string, fetcher: typeof fetch = fetch): Promise<ViewerRecapRequest | null> {
  return readResponse(await fetcher(`/api/live-sessions/${encodeURIComponent(sessionId)}/recap-request`, { cache: "no-store" }), sessionId);
}

export async function saveRecapRequest(sessionId: string, idempotencyKey: string, fetcher: typeof fetch = fetch): Promise<ViewerRecapRequest> {
  const request = await readResponse(await fetcher(`/api/live-sessions/${encodeURIComponent(sessionId)}/recap-request`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ noticeVersion: RECAP_REQUEST_NOTICE_VERSION, accepted: true, idempotencyKey }),
  }), sessionId);
  if (!request || request.status !== "requested") throw new Error("수신 신청을 저장하지 못했어요. 다시 확인해 주세요.");
  return request;
}

async function readResponse(response: Response, sessionId: string): Promise<ViewerRecapRequest | null> {
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error("수신 신청을 확인하지 못했어요. 다시 시도해 주세요.");
  const envelope = z.object({ ok: z.literal(true), data: z.object({ request: requestSchema.nullable() }) }).parse(payload);
  if (envelope.data.request && envelope.data.request.sessionId !== sessionId) throw new Error("다른 회의의 수신 신청입니다.");
  return envelope.data.request;
}
