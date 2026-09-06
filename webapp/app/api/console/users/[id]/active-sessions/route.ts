import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/require-admin";
import { consoleFailure, invalidConsoleRequest } from "@/lib/console/console-route";
import { ConsoleStoreError, getConsoleStore } from "@/lib/console/console-store";
import { apiSuccess } from "@/lib/security/api-response";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export const dynamic = "force-dynamic";

interface RouteContext { params: Promise<{ id: string }> }
const profileIdSchema = z.uuid();

/**
 * `GET /api/console/users/[id]/active-sessions` → `{ count, sessions: [{ id, status, languages }] }`:
 * exactly the `preparing|live` sessions a `PATCH { voiceProvider }` for this profile would switch
 * (I3 - the confirm dialog quotes this instead of filtering the all-time session list). The host
 * id is read from the profile row server-side; the client only names the profile.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { profile } = await requireAdmin(request);
    const parsed = profileIdSchema.safeParse((await context.params).id);
    if (!parsed.success) return invalidConsoleRequest("사용자 ID가 올바르지 않습니다.");
    const store = getConsoleStore();
    const target = await store.readProfileById({ actorId: profile.id, profileId: parsed.data });
    if (!target) throw new ConsoleStoreError("사용자를 찾을 수 없습니다.", "PROFILE_NOT_FOUND", 404);
    const sessions = await store.listActiveSessionsForHost(target.hostId);
    return apiSuccess({ count: sessions.length, sessions }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    return consoleFailure(error, "진행 중인 세션을 읽을 수 없습니다.", "CONSOLE_ACTIVE_SESSIONS_FAILED");
  }
}
