import { apiSuccess } from "@/lib/security/api-response";

// Public, non-secret client configuration. The gateway URL is already baked
// into the browser bundle as NEXT_PUBLIC_LIVE_GATEWAY_URL; this endpoint
// exposes the same value to the desktop app, which cannot read the bundle.
export async function GET() {
  return apiSuccess({ gatewayUrl: process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL ?? "" });
}
