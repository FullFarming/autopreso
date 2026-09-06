import type { BootstrapAdminConfig } from "./bootstrap-admins";
import { isBootstrapAdminEmail } from "./bootstrap-admins";
import type { ProfileRecord, SupabaseProfileStore } from "./profile-store";

export const DESKTOP_CODE_TTL_MS = 60_000;
export const DESKTOP_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type ExchangeOutcome =
  | { kind: "approved"; profile: ProfileRecord; next: string; desktopCode?: string }
  | { kind: "pending"; email: string; next: "/pending" }
  | { kind: "forbidden"; code: "PROFILE_REJECTED" | "PROFILE_DISABLED" | "EMAIL_UNCONFIRMED"; email: string };

export interface ExchangeInput { accessToken: string; client: "web" | "desktop"; state?: string; now?: () => number }

export function buildDesktopCallbackUrl(code: string, state: string): string {
  return `nova://auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
}

export async function exchangeSupabaseLogin(
  input: ExchangeInput,
  deps: { store: Pick<SupabaseProfileStore, "verifyAccessToken" | "upsertOnLogin" | "issueDesktopCode">; bootstrap: BootstrapAdminConfig },
): Promise<ExchangeOutcome> {
  if (input.client === "desktop" && !DESKTOP_STATE_PATTERN.test(input.state ?? "")) throw new Error("DESKTOP_STATE_INVALID");
  const user = await deps.store.verifyAccessToken(input.accessToken);
  if (!user.emailConfirmed) return { kind: "forbidden", code: "EMAIL_UNCONFIRMED", email: user.email };
  const profile = await deps.store.upsertOnLogin({
    user, bootstrap: isBootstrapAdminEmail(user.email, deps.bootstrap), legacyHostId: deps.bootstrap.legacyHostId,
  });
  if (profile.status === "pending") return { kind: "pending", email: profile.email, next: "/pending" };
  if (profile.status === "rejected") return { kind: "forbidden", code: "PROFILE_REJECTED", email: profile.email };
  if (profile.status === "disabled") return { kind: "forbidden", code: "PROFILE_DISABLED", email: profile.email };
  if (input.client === "desktop") {
    const now = input.now?.() ?? Date.now();
    const desktopCode = await deps.store.issueDesktopCode({ profileId: profile.id, state: input.state as string, expiresAt: new Date(now + DESKTOP_CODE_TTL_MS) });
    return { kind: "approved", profile, next: buildDesktopCallbackUrl(desktopCode, input.state as string), desktopCode };
  }
  return { kind: "approved", profile, next: "/admin" };
}
