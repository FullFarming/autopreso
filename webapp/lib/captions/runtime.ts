import { createHmac } from "node:crypto";
import { resolveHostEngineAssignment } from "../console/engine-defaults";
import { LIVE_GATEWAY_TOKEN_SECRET } from "../security/config";
import { SupabaseLiveAdmissionStore } from "../security/live-admission-store";
import { SupabaseManagedCaptionSessions } from "./store";
import { CaptionBroker } from "./broker";

const LIMITS = { stop: { count: 12, seconds: 60 }, start: { count: 30, seconds: 3600 }, renew: { count: 6, seconds: 60 },
  credentials: { count: 18, seconds: 60 }, translate: { count: 360, seconds: 60 } } as const;
let broker: CaptionBroker | null = null;
export function getCaptionBroker(): CaptionBroker {
  broker ??= new CaptionBroker({
    secret: LIVE_GATEWAY_TOKEN_SECRET,
    sessions: new SupabaseManagedCaptionSessions(),
    readAssignment: resolveHostEngineAssignment,
    readKey(provider) {
      const key = (provider === "soniox" ? process.env.SONIOX_API_KEY : process.env.GEMINI_API_KEY)?.trim();
      if (!key) throw new Error("Caption provider key is not configured");
      return key;
    },
    async consumeLimit(hostId, operation) {
      const limit = LIMITS[operation];
      return new SupabaseLiveAdmissionStore().consumeRateLimit({
        scope: `caption-${operation}`, keyHash: createHmac("sha256", LIVE_GATEWAY_TOKEN_SECRET).update(`caption-host:${hostId}`).digest("hex"),
        limit: limit.count, windowSeconds: limit.seconds,
      });
    },
  });
  return broker;
}
