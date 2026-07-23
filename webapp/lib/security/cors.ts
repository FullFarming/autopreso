import type { NextRequest } from "next/server";

import { canonicalRequestOrigin } from "./csrf";
import { getAllowedOrigins } from "./config";

export function exactCorsHeaders(request: Pick<NextRequest, "headers">): Headers {
  const headers = new Headers({ vary: "Origin" });
  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin) return headers;
  const origin = canonicalRequestOrigin(rawOrigin);
  if (!origin || !getAllowedOrigins().has(origin)) return headers;
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-max-age", "600");
  return headers;
}
