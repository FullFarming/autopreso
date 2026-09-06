// Relative import on purpose: the node:test loader (lib/security/test-typescript-loader.mjs)
// resolves only "./" and "../" specifiers, not the "@/" path alias.
import { HOST_ID_PATTERN } from "../../lib/security/host-session-policy";

export type LoginMode = "signin" | "signup";
export type IdentifierKind = "email" | "legacy-id" | "invalid";
export type DesktopLoginParams = { client: "desktop"; state: string };
export type CallbackParams = DesktopLoginParams | { client: "web" };
export type SignupErrors = { name?: string; email?: string; password?: string };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/u;
// 32 random bytes as base64url; pinned by the desktop_login_codes SQL check and Task 3/6.
const STATE = /^[A-Za-z0-9_-]{43}$/u;
// C0 controls, DEL, and C1 controls never belong in a message shown to the user.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/gu;
export const SIGNUP_PASSWORD_MIN_LENGTH = 8;
const PASSWORD_TOO_SHORT_KEY = "passwordTooShort";

export function classifyIdentifier(value: string): IdentifierKind {
  const trimmed = value.trim();
  if (!trimmed) return "invalid";
  if (trimmed.includes("@")) return EMAIL.test(trimmed) ? "email" : "invalid";
  return HOST_ID_PATTERN.test(trimmed) ? "legacy-id" : "invalid";
}

export function validateSignup(input: { name: string; email: string; password: string }): SignupErrors {
  const errors: SignupErrors = {};
  if (!input.name.trim()) errors.name = "nameRequired";
  if (!EMAIL.test(input.email.trim())) errors.email = "emailInvalid";
  if (input.password.length < SIGNUP_PASSWORD_MIN_LENGTH) errors.password = PASSWORD_TOO_SHORT_KEY;
  return errors;
}

export function readDesktopLoginParams(search: string): DesktopLoginParams | null {
  const params = new URLSearchParams(search);
  const state = params.get("state") ?? "";
  return params.get("client") === "desktop" && STATE.test(state) ? { client: "desktop", state } : null;
}

export function readCallbackParams(search: string): CallbackParams {
  return readDesktopLoginParams(search) ?? { client: "web" };
}

export function buildDesktopGoogleStartUrl(origin: string, state: string): string {
  return `${origin}/login?client=desktop&state=${state}&auto=google`;
}

export function buildCallbackRedirect(origin: string, desktop: { state: string } | null): string {
  return desktop ? `${origin}/auth/callback?client=desktop&state=${desktop.state}` : `${origin}/auth/callback`;
}

export function safeSupabaseErrorMessage(search: string): string | null {
  const raw = new URLSearchParams(search).get("error_description");
  if (!raw) return null;
  const cleaned = raw.replace(CONTROL_CHARACTERS, "").trim().slice(0, 200);
  return cleaned || null;
}

// Maps a failed POST /api/auth/exchange to the message key shown to the user.
// 403 codes come from the route contract (PROFILE_REJECTED / PROFILE_DISABLED /
// EMAIL_UNCONFIRMED); anything else reads as bad credentials so the UI never
// echoes server text.
export function exchangeFailureKey(status: number, code: string | undefined): string {
  if (status === 429) return "rateLimited";
  if (status === 403) {
    if (code === "PROFILE_DISABLED") return "forbiddenDisabled";
    if (code === "EMAIL_UNCONFIRMED") return "emailUnconfirmed";
    return "forbiddenRejected";
  }
  return "invalidCredentials";
}
