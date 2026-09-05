import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/require-admin";
import { consoleFailure, invalidConsoleRequest } from "@/lib/console/console-route";
import { getConsoleStore } from "@/lib/console/console-store";
import { engineSelectionForVoiceProvider } from "@/lib/console/engine-defaults";
import { deployEngineToHostSessions, readDeployGatewayUrl } from "@/lib/console/engine-deploy";
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
}).strict().refine((v) => (v.status ? 1 : 0) + (v.role ? 1 : 0) + (v.voiceProvider ? 1 : 0) === 1, "status, role, voiceProvider 중 하나만 지정합니다.");

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

/**
 * `PATCH /api/console/users { profileId, status? | role? | voiceProvider?, reason? }`.
 * `status`/`role` answer `{ id, status, role }`. `voiceProvider` (D1, operator-only) writes the
 * profile first (authoritative, persists for future sessions), then switches every
 * `preparing|live` session of that user immediately - admin RPC per session with the new
 * assignment revision, then the gateway push - and answers
 * `{ id, status, role, voiceProvider, results: [{ sessionId, result, code? }], summary }`.
 * Per-session failures are rows, not errors; the deploy audit row is best-effort.
 */
export async function PATCH(request: NextRequest) {
  try {
    assertStrictOrigin(request);
    const { hostId: actorHostId, profile } = await requireAdmin(request);
    const parsed = patchUserSchema.safeParse(await readBoundedJsonBody(request));
    if (!parsed.success) return invalidConsoleRequest();
    const { profileId, status, role, reason, voiceProvider } = parsed.data;
    const store = getConsoleStore();
    if (voiceProvider) {
      const changed = await store.setProfileVoiceProvider({ actorId: profile.id, profileId, provider: voiceProvider });
      const engine = engineSelectionForVoiceProvider(changed.provider);
      const { results, summary } = await deployEngineToHostSessions({
        store, actorId: profile.id, actorHostId, hostId: changed.hostId, engine, assignmentRevision: changed.revision, gatewayUrl: readDeployGatewayUrl(),
      });
      try {
        await store.recordEngineDeploy({ actorId: profile.id, engine, summary, target: { profileId: changed.id, hostId: changed.hostId, voiceProvider: changed.provider, revision: changed.revision } });
      } catch {
        // The assignment itself is already logged by the RPC (`kind: "user_assignment"`); the
        // counters row must not turn a completed switch into an error the operator would retry.
      }
      return apiSuccess({ id: changed.id, status: changed.status, role: changed.role, voiceProvider: changed.provider, results, summary }, { headers: privateNoStoreHeaders() });
    }
    const result = status
      ? await store.setProfileStatus({ actorId: profile.id, profileId, status, reason })
      : await store.setProfileRole({ actorId: profile.id, profileId, role: role as "host" | "admin" });
    return apiSuccess(result, { headers: privateNoStoreHeaders() });
  } catch (error: unknown) {
    return consoleFailure(error, "사용자 정보를 변경할 수 없습니다.", "CONSOLE_USER_UPDATE_FAILED");
  }
}
