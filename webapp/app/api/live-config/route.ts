import { captionEngineAvailability, resolveEngineDefaultsOrFallback } from "@/lib/console/engine-defaults";
import { apiSuccess } from "@/lib/security/api-response";

export const dynamic = "force-dynamic";

// Public, non-secret client configuration. The gateway URL is already baked
// into the browser bundle as NEXT_PUBLIC_LIVE_GATEWAY_URL; this endpoint
// exposes the same value to the desktop app, which cannot read the bundle.
// `engineDefaults` is the console's global caption-engine selection (catalog-
// normalized) - spec §9: the ONLY Live Call engine, shown read-only to hosts;
// a console outage degrades to the catalog default because a missing default
// must never block go-live. `captionEngines` is the catalog with key
// AVAILABILITY only (booleans) - key values never leave the server.
export async function GET() {
  return apiSuccess({
    gatewayUrl: process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL ?? "",
    engineDefaults: await resolveEngineDefaultsOrFallback(),
    captionEngines: captionEngineAvailability(),
  });
}
