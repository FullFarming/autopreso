import { HOST_ID_PATTERN } from "../security/host-session-policy";

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/u;

export interface BootstrapAdminConfig { emails: ReadonlySet<string>; legacyHostId: string | null; }

export function readBootstrapAdminConfig(env: Readonly<Record<string, string | undefined>> = process.env): BootstrapAdminConfig {
  const emails = (env.ADMIN_BOOTSTRAP_EMAILS ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (emails.length > 20 || emails.some((email) => !EMAIL_PATTERN.test(email))) {
    throw new Error("ADMIN_BOOTSTRAP_EMAILS 설정이 올바르지 않습니다.");
  }
  const firstLegacy = (env.ADMIN_USER_IDS ?? "").split(",").map((v) => v.trim()).find(Boolean) ?? "";
  return { emails: new Set(emails), legacyHostId: HOST_ID_PATTERN.test(firstLegacy) ? firstLegacy : null };
}

export function isBootstrapAdminEmail(email: string, config: BootstrapAdminConfig): boolean {
  return config.emails.has(email.trim().toLowerCase());
}

/**
 * The only thing the legacy login route may ever log: a break-glass cookie was issued for the
 * bootstrap admin while the profile store was unreachable. The code alone - no host id, email,
 * or credential - so the route keeps its "never logs credentials" pin.
 */
export function warnBreakGlassLogin(code: string): void {
  console.warn(`[auth] legacy break-glass login: ${code}`);
}
