import type { NextRequest } from "next/server";
import { requireHost } from "../../auth/live-auth";
import { SupabaseLiveAdmissionStore } from "../../security/live-admission-store";
import { authorizeParticipantRecordRequest, isHostOwnershipMiss } from "../../security/live-viewer-authorization";

export async function authorizeSpeakerPhoto(
  request: Pick<NextRequest, "cookies">,
  sessionId: string,
  store = new SupabaseLiveAdmissionStore(),
  authenticateHost: typeof requireHost = requireHost,
): Promise<void> {
  try {
    const { hostId } = await authenticateHost(request);
    await store.assertHostSessionOwnership(sessionId, hostId);
    return;
  } catch (error) { if (!isHostOwnershipMiss(error)) throw error; }
  await authorizeParticipantRecordRequest(request, sessionId, store);
}
