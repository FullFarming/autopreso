import { LiveSecurityConfigurationError } from "../security/config";
import { isProfileBackedHostId } from "../security/host-session-policy";
import { AuthenticationError } from "./live-auth";
import { SupabaseProfileStore, type ProfileRecord, type ProfileRole, type ProfileStatus } from "./profile-store";

const DEFAULT_TTL_MS = 60_000;
/**
 * How long past its TTL a cached status may still be served while the profile store is down.
 * Ruling 2026-09-05: a Supabase outage must not turn into a mass 401 for every host the moment
 * the 60 s entry lapses, but a stale approval must also not live forever - 10 min past expiry
 * the entry is gone and the host fails closed like a cold miss. Paid provider keys are unaffected
 * either way: the managed-caption broker re-reads `profiles.status` through its own RPCs.
 */
export const STALE_GRACE_MS = 10 * 60_000;
type Reader = (hostId: string) => Promise<ProfileRecord | null>;
type Entry = { value: { status: ProfileStatus; role: ProfileRole } | null; expiresAt: number };

export function createProfileStatusCache(opts: { read: Reader; ttlMs?: number; now?: () => number }) {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  return {
    async get(hostId: string): Promise<{ status: ProfileStatus; role: ProfileRole } | null> {
      const hit = entries.get(hostId);
      if (hit && hit.expiresAt > now()) return hit.value;
      try {
        const row = await opts.read(hostId);
        const value = row ? { status: row.status, role: row.role } : null;
        entries.set(hostId, { value, expiresAt: now() + ttl });
        if (entries.size > 5_000) entries.delete(entries.keys().next().value as string);
        return value;
      } catch {
        // Store outage: serve the last-known answer, but only inside the bounded grace window.
        if (hit && hit.expiresAt + STALE_GRACE_MS >= now()) return hit.value;
        throw new AuthenticationError("호스트 상태를 확인할 수 없습니다.");
      }
    },
    /** The last-known status if it is still inside the grace window; never touches the store. */
    lastKnown(hostId: string): { status: ProfileStatus; role: ProfileRole } | null | undefined {
      const hit = entries.get(hostId);
      return hit && hit.expiresAt + STALE_GRACE_MS >= now() ? hit.value : undefined;
    },
    invalidate(hostId?: string) { if (hostId) entries.delete(hostId); else entries.clear(); },
  };
}

let reader: Reader | null = null;
async function defaultReader(hostId: string): Promise<ProfileRecord | null> {
  if (reader) return reader(hostId);
  try {
    return await new SupabaseProfileStore().readByHostId(hostId);
  } catch (error) {
    // No Supabase server credentials (development/test without a project): there is no profile
    // store to consult, so every host is a legacy password host exactly as before this gate existed.
    if (error instanceof LiveSecurityConfigurationError) return null;
    throw error;
  }
}
export const profileStatusCache = createProfileStatusCache({ read: defaultReader });
/** Test seam: swap the reader without touching the singleton cache. */
export function __setProfileReaderForTests(next: Reader | null): void { reader = next; profileStatusCache.invalidate(); }
/**
 * The full profile row through the same (seam-aware) reader the cache uses. The cache keeps only
 * status/role; `requireAdmin` needs the row's id as the console RPC actor, so it reads uncached.
 */
export async function readHostProfile(hostId: string): Promise<ProfileRecord | null> { return defaultReader(hostId); }

export async function assertHostApproved(hostId: string, cache = profileStatusCache): Promise<{ role: ProfileRole | "legacy" }> {
  const profile = await cache.get(hostId);
  if (profile === null) {
    // `profiles.id` cascades from auth.users: deleting the auth user removes the row while a signed
    // cookie may still be in circulation. A uuid subject without a profile therefore fails closed;
    // only non-uuid ids (ADMIN_USER_IDS password hosts) are the legacy path.
    if (isProfileBackedHostId(hostId)) throw new AuthenticationError("호스트 계정을 찾을 수 없습니다.");
    return { role: "legacy" };
  }
  if (profile.status !== "approved") throw new AuthenticationError("호스트 계정이 승인되지 않았거나 비활성화되었습니다.");
  return { role: profile.role };
}
