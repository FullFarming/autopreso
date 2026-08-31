import { NextRequest } from "next/server";
import { AuthenticationError, AuthorizationError } from "@/lib/auth/live-auth";
import { authenticateSourceSnapshotRequest, parseSourceSnapshotQuery, SupabaseSourceSnapshotStore } from "@/lib/live/source-snapshot";
import { parseSessionId } from "@/lib/live/validation";
import { toLiveFailure } from "@/lib/live/errors";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { enforceParticipantRecordReadRateLimit } from "@/lib/security/live-rate-limit";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const sessionId = parseSessionId(id);
    const page = parseSourceSnapshotQuery(request.nextUrl.searchParams);
    const identity = await authenticateSourceSnapshotRequest(request, sessionId);
    await enforceParticipantRecordReadRateLimit(identity.userId, sessionId, new SupabaseLiveAdmissionStore());
    // 2026-08-31 feat: RPC checks membership, revocation and the server clock in the same snapshot as the source rows.
    const snapshot = await new SupabaseSourceSnapshotStore().read(sessionId, { ...identity, ...page });
    return apiSuccess(snapshot, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "VIEWER_AUTH_REQUIRED", 401, privateNoStoreHeaders());
    if (error instanceof AuthorizationError) return apiError(error.message, "VIEWER_FORBIDDEN", 403, privateNoStoreHeaders());
    if (error instanceof LiveAdmissionError) return apiError(error.message, error.code, error.status, privateNoStoreHeaders());
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status, privateNoStoreHeaders());
  }
}
