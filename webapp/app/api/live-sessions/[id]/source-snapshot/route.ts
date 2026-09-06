import { NextRequest } from "next/server";
import { AuthenticationError, AuthorizationError } from "@/lib/auth/live-auth";
import { authenticateSourceSnapshotAudience, parseSourceSnapshotQuery, SupabaseSourceSnapshotStore } from "@/lib/live/source-snapshot";
import { parseSessionId } from "@/lib/live/validation";
import { toLiveFailure } from "@/lib/live/errors";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { enforceAuthoritativeTranscriptReadRateLimit, enforceParticipantRecordReadRateLimit } from "@/lib/security/live-rate-limit";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const audience = request.nextUrl.searchParams.get("audience");
  try {
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const page = parseSourceSnapshotQuery(request.nextUrl.searchParams);
    const identity = await authenticateSourceSnapshotAudience(request, sessionId, audience);
    const admission = new SupabaseLiveAdmissionStore();
    const store = new SupabaseSourceSnapshotStore();
    // Each role uses its own database authorization; a host cookie must never
    // silently extend a participant's six-hour record access.
    if (identity.role === "host") {
      await enforceAuthoritativeTranscriptReadRateLimit(identity.hostId, sessionId, admission);
      return apiSuccess(await store.readHost(sessionId, { hostId: identity.hostId, ...page }), { headers: privateNoStoreHeaders() });
    }
    await enforceParticipantRecordReadRateLimit(identity.userId, sessionId, admission);
    const snapshot = await store.read(sessionId, { ...identity, ...page });
    return apiSuccess(snapshot, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, audience === "host" ? "HOST_AUTH_REQUIRED" : "VIEWER_AUTH_REQUIRED", 401, privateNoStoreHeaders());
    if (error instanceof AuthorizationError) return apiError(error.message, audience === "host" ? "HOST_FORBIDDEN" : "VIEWER_FORBIDDEN", 403, privateNoStoreHeaders());
    if (error instanceof LiveAdmissionError) return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
  }
}
