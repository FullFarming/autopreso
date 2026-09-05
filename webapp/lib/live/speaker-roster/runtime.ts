import type { NextRequest } from "next/server";
import { requireHost } from "../../auth/live-auth";
import { LiveSessionError } from "../errors";
import { LIVE_ADMISSION_PEPPER } from "../../security/config";
import { opaqueIdentifier } from "../../security/hmac";
import { SupabaseLiveAdmissionStore } from "../../security/live-admission-store";
import { authorizeSpeakerPhoto } from "./authorization";
import { SupabaseSpeakerRosterStore } from "./store";
import { createSpeakerRosterHandlers } from "./handlers";

export function speakerRosterHandlers() {
  const admissionStore = new SupabaseLiveAdmissionStore();
  return createSpeakerRosterHandlers<NextRequest>({
    store: new SupabaseSpeakerRosterStore(), requireHost,
    async authorizePhoto(request, sessionId) {
      await authorizeSpeakerPhoto(request, sessionId, admissionStore);
    },
    async rateLimit(hostId, sessionId, kind) {
      const scope = kind === "photo" ? "speaker-photo" : "speaker-roster";
      const keyHash = await opaqueIdentifier(LIVE_ADMISSION_PEPPER, scope, `${hostId}:${sessionId}`);
      const allowed = await admissionStore.consumeRateLimit({ scope, keyHash, limit: kind === "photo" ? 30 : 120, windowSeconds: 60 });
      if (!allowed) throw new LiveSessionError("요청이 너무 많습니다. 잠시 후 다시 시도하세요.", "SPEAKER_ROSTER_RATE_LIMITED", 429);
    },
  });
}
