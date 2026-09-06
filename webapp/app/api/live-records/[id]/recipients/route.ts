import { NextRequest } from "next/server";
import { requireHost } from "@/lib/auth/live-auth";
import { parseSessionId } from "@/lib/live/validation";
import { apiSuccess } from "@/lib/security/api-response";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";
import { createLiveRecapService, recapRouteError } from "@/lib/live-recap/http";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { hostId } = await requireHost(request);
    const sessionId = parseSessionId((await context.params).id);
    const recipients = await createLiveRecapService().readRecipients(sessionId, hostId);
    return apiSuccess(recipients, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) { return recapRouteError(error); }
}
