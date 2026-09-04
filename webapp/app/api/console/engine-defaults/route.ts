import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/require-admin";
import { consoleEngineCatalog, consoleFailure, invalidConsoleRequest, normalizeSubmittedEngine } from "@/lib/console/console-route";
import { getConsoleStore } from "@/lib/console/console-store";
import { consoleSettingsCache, readStoredEngineDefaults } from "@/lib/console/engine-defaults";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { assertStrictOrigin } from "@/lib/security/csrf";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export const dynamic = "force-dynamic";

const putEngineSchema = z.object({ engine: z.unknown() }).strict();

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

/** `PUT /api/console/engine-defaults { engine }` → `{ engine }` (normalized). Invalidates the settings memo so new sessions see it. */
export async function PUT(request: NextRequest) {
  try {
    assertStrictOrigin(request);
    const { profile } = await requireAdmin(request);
    const parsed = putEngineSchema.safeParse(await readBoundedJsonBody(request));
    // `z.unknown()` treats a missing key as present-undefined, and the catalog reads undefined as
    // "use the default" - an explicit body is required so a typo cannot silently reset the defaults.
    if (!parsed.success || parsed.data.engine === undefined) return invalidConsoleRequest();
    const engine = normalizeSubmittedEngine(parsed.data.engine);
    if (!engine) return apiError("엔진 설정이 올바르지 않습니다.", "ENGINE_INVALID", 400, privateNoStoreHeaders());
    await getConsoleStore().setEngineDefaults({ actorId: profile.id, engine });
    consoleSettingsCache.invalidate();
    return apiSuccess({ engine }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    return consoleFailure(error, "엔진 기본값을 저장할 수 없습니다.", "CONSOLE_ENGINE_WRITE_FAILED");
  }
}
