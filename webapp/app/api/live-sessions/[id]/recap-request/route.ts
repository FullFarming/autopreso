import { NextRequest } from "next/server";
import { parseSessionId } from "@/lib/live/validation";
import { apiSuccess } from "@/lib/security/api-response";
import { readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { assertStrictOrigin } from "@/lib/security/csrf";
import { SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { enforceLiveConsentRateLimit, enforceParticipantRecordReadRateLimit } from "@/lib/security/live-rate-limit";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";
import { authorizeParticipantRecordRequest } from "@/lib/security/live-viewer-authorization";
import { createLiveRecapService, recapRouteError } from "@/lib/live-recap/http";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const sessionId = parseSessionId((await context.params).id);
    const store = new SupabaseLiveAdmissionStore();
    const participant = await authorizeParticipantRecordRequest(request, sessionId, store);
    await enforceParticipantRecordReadRateLimit(participant.userId, sessionId, store);
    const recapRequest = await createLiveRecapService().readRequest(sessionId, participant.userId);
    return apiSuccess({ request: recapRequest }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) { return recapRouteError(error); }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    assertStrictOrigin(request);
    const sessionId = parseSessionId((await context.params).id);
    const store = new SupabaseLiveAdmissionStore();
    const participant = await authorizeParticipantRecordRequest(request, sessionId, store);
    await enforceLiveConsentRateLimit(participant.userId, sessionId, store);
    const body = await readBoundedJsonBody(request);
    const recapRequest = await createLiveRecapService().request(sessionId, participant.userId, body);
    return apiSuccess({ request: recapRequest }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) { return recapRouteError(error); }
}
