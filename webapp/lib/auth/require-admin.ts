import type { NextRequest } from "next/server";

import { SESSION_COOKIE } from "../session";
import { AuthorizationError, requireHost } from "./live-auth";
import { readHostProfile } from "./profile-status-cache";
import type { ProfileRecord } from "./profile-store";

export interface AdminActor { hostId: string; profile: ProfileRecord }

/**
 * Console guard: an approved host cookie (requireHost: signature, TTL, profile status) whose
 * profile row is `role = admin`. Legacy password hosts have no profile row and are refused too -
 * the console's RPCs take a profile uuid as actor, so there is nothing they could act as.
 * `profile.id` is the `p_actor_id` every mutating console RPC expects.
 */
export async function requireAdmin(request: Pick<NextRequest, "cookies">): Promise<AdminActor> {
  const { hostId } = await requireHost(request);
  const profile = await readHostProfile(hostId);
  if (!profile || profile.role !== "admin" || profile.status !== "approved") {
    throw new AuthorizationError("관리자 권한이 필요합니다.");
  }
  return { hostId, profile };
}

/** Same gate for server components, which hold the cookie value (`cookies().get(SESSION_COOKIE)?.value`) rather than a request. */
export async function requireAdminFromCookieValue(token: string | undefined): Promise<AdminActor> {
  const cookies = { get: (name: string) => (name === SESSION_COOKIE && token ? { name, value: token } : undefined) };
  return requireAdmin({ cookies } as unknown as Pick<NextRequest, "cookies">);
}
