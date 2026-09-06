import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/require-admin";
import { consoleFailure, invalidConsoleRequest } from "@/lib/console/console-route";
import { getConsoleStore } from "@/lib/console/console-store";
import { consoleSettingsCache } from "@/lib/console/engine-defaults";
import { apiSuccess } from "@/lib/security/api-response";
import { readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { assertStrictOrigin } from "@/lib/security/csrf";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export const dynamic = "force-dynamic";

const putSettingsSchema = z.object({ legacyPasswordLoginEnabled: z.boolean() }).strict();
/** Sent back when the switch is turned off so the console can confirm that `ADMIN_USER_IDS` password login stops working. */
const LEGACY_LOGIN_DISABLED_WARNING = "LEGACY_LOGIN_DISABLED_WARNING";

/** `GET /api/console/settings` → `{ legacyPasswordLoginEnabled }`. */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
    const settings = await getConsoleStore().readSettings();
    return apiSuccess({ legacyPasswordLoginEnabled: settings.legacyPasswordLoginEnabled }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    return consoleFailure(error, "콘솔 설정을 읽을 수 없습니다.", "CONSOLE_SETTINGS_READ_FAILED");
  }
}

/** `PUT /api/console/settings { legacyPasswordLoginEnabled }` → `{ legacyPasswordLoginEnabled, warning? }`. */
export async function PUT(request: NextRequest) {
  try {
    assertStrictOrigin(request);
    const { profile } = await requireAdmin(request);
    const parsed = putSettingsSchema.safeParse(await readBoundedJsonBody(request));
    if (!parsed.success) return invalidConsoleRequest();
    const enabled = parsed.data.legacyPasswordLoginEnabled;
    await getConsoleStore().setLegacyPasswordLogin({ actorId: profile.id, enabled });
    consoleSettingsCache.invalidate();
    return apiSuccess(
      enabled ? { legacyPasswordLoginEnabled: true } : { legacyPasswordLoginEnabled: false, warning: LEGACY_LOGIN_DISABLED_WARNING },
      { headers: privateNoStoreHeaders() },
    );
  } catch (error: unknown) {
    return consoleFailure(error, "콘솔 설정을 저장할 수 없습니다.", "CONSOLE_SETTINGS_WRITE_FAILED");
  }
}
