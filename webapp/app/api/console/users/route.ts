import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/require-admin";
import { consoleFailure, invalidConsoleRequest } from "@/lib/console/console-route";
import { getConsoleStore } from "@/lib/console/console-store";
import { apiSuccess } from "@/lib/security/api-response";
import { readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { assertStrictOrigin } from "@/lib/security/csrf";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export const dynamic = "force-dynamic";

const listQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "disabled"]).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
}).strict();

const patchUserSchema = z.object({
  profileId: z.uuid(),
  status: z.enum(["approved", "rejected", "disabled"]).optional(),
  voiceProvider: z.enum(["soniox", "gemini"]).optional(),
  reason: z.string().trim().max(200).optional(),
  role: z.enum(["host", "admin"]).optional(),
}).strict().refine((v) => (v.status ? 1 : 0) + (v.role ? 1 : 0) + (v.voiceProvider ? 1 : 0) === 1, "status 또는 role 중 하나만 지정합니다.");

/** `GET /api/console/users?status=&before=` → `{ profiles: ConsoleProfileRow[], pendingCount }`. */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
    const parsed = listQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) return invalidConsoleRequest("사용자 목록 조회 조건이 올바르지 않습니다.");
    const store = getConsoleStore();
    const [profiles, pendingCount] = await Promise.all([
      store.listProfiles({ status: parsed.data.status, before: parsed.data.before }),
      store.countPending(),
    ]);
    return apiSuccess({ profiles, pendingCount }, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    return consoleFailure(error, "사용자 목록을 읽을 수 없습니다.", "CONSOLE_USERS_LIST_FAILED");
  }
}

/** `PATCH /api/console/users { profileId, status? | role?, reason? }` → `{ id, status, role }`. */
export async function PATCH(request: NextRequest) {
  try {
    assertStrictOrigin(request);
    const { profile } = await requireAdmin(request);
    const parsed = patchUserSchema.safeParse(await readBoundedJsonBody(request));
    if (!parsed.success) return invalidConsoleRequest();
    const { profileId, status, role, reason, voiceProvider } = parsed.data;
    const store = getConsoleStore();
    const result = voiceProvider
      ? await store.setProfileVoiceProvider({ actorId: profile.id, profileId, provider: voiceProvider })
      : status
      ? await store.setProfileStatus({ actorId: profile.id, profileId, status, reason })
      : await store.setProfileRole({ actorId: profile.id, profileId, role: role as "host" | "admin" });
    return apiSuccess(result, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    return consoleFailure(error, "사용자 정보를 변경할 수 없습니다.", "CONSOLE_USER_UPDATE_FAILED");
  }
}
