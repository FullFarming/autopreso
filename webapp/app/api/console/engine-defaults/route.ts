import type { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/auth/require-admin";
import { consoleEngineCatalog, consoleFailure } from "@/lib/console/console-route";
import { getConsoleStore } from "@/lib/console/console-store";
import { readStoredEngineDefaults } from "@/lib/console/engine-defaults";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { assertStrictOrigin } from "@/lib/security/csrf";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export const dynamic = "force-dynamic";

/** `GET /api/console/engine-defaults` → `{ engine, catalog, updatedAt, updatedByEmail }`; the catalog marks availability by env booleans only. */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
    const settings = await getConsoleStore().readSettings();
    return apiSuccess({
      engine: readStoredEngineDefaults(settings.engine),
      catalog: consoleEngineCatalog(),
      updatedAt: settings.engineUpdatedAt,
      updatedByEmail: settings.engineUpdatedByEmail,
    }, { headers: privateNoStoreHeaders() });
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
