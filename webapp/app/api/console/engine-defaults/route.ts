import type { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/auth/require-admin";
import { consoleEngineCatalog, consoleFailure } from "@/lib/console/console-route";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { assertStrictOrigin } from "@/lib/security/csrf";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export const dynamic = "force-dynamic";

/**
 * `GET /api/console/engine-defaults` → `{ catalog }`: the engine catalog with availability as env
 * booleans only. The stored global `engine_defaults` value decides nothing since D1 (engines are
 * per user), so it is deliberately not returned - surfacing it read as if it were still in force.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
    return apiSuccess({ catalog: consoleEngineCatalog() }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    return consoleFailure(error, "엔진 기본값을 읽을 수 없습니다.", "CONSOLE_ENGINE_READ_FAILED");
  }
}

/**
 * Retired (D1, 2026-09-05): the Live Call engine is assigned per user from
 * `PATCH /api/console/users { voiceProvider }`; the global `engine_defaults` value decides
 * nothing any more, so writing it is refused after the usual origin and admin guards.
 */
export async function PUT(request: NextRequest) {
  try {
    assertStrictOrigin(request);
    await requireAdmin(request);
    return apiError("전역 엔진 기본값은 더 이상 사용하지 않습니다. 사용자 탭에서 사용자별 엔진을 바꾸세요.", "ENGINE_DEFAULTS_RETIRED", 410, privateNoStoreHeaders());
  } catch (error: unknown) {
    return consoleFailure(error, "엔진 기본값을 저장할 수 없습니다.", "CONSOLE_ENGINE_WRITE_FAILED");
  }
}
