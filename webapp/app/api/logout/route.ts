import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/session";
import { apiError } from "@/lib/security/api-response";
import { assertStrictOrigin } from "@/lib/security/csrf";

export async function POST(request: NextRequest) {
  try { assertStrictOrigin(request); }
  catch { return apiError("허용되지 않은 요청 출처입니다.", "CSRF_REJECTED", 403, { "cache-control": "no-store" }); }
  const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "private, no-store" } });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  response.cookies.set("rnw_name", "", {
    sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0,
  });
  return response;
}
