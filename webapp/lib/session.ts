// Stateless HMAC-signed session token. Uses Web Crypto so the same code runs
// in the Edge middleware runtime and in Node route handlers.
import { HOST_ID_PATTERN, isCurrentHostSessionUser, isProfileBackedHostId } from "./security/host-session-policy";

export const SESSION_COOKIE = "rnw_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1_000;
const LEGACY_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const SESSION_REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1_000;
const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

export interface HostSession {
  userId: string;
  expiresAt: number;
  authenticatedAt: number;
  issuedAt: number;
}

const encoder = new TextEncoder();

const SESSION_SECRET = (() => {
  const value = process.env.SESSION_SECRET?.trim();
  if (process.env.NODE_ENV === "production" && (!value || value.length < 32)) {
    throw new Error("SESSION_SECRET must be configured with at least 32 characters");
  }
  return value ?? "realtime-noel-web-dev-secret-change-me";
})();

function sessionSecret(): string {
  return SESSION_SECRET;
}

async function hmacHex(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createSessionToken(userId: string = "admin"): Promise<string> {
  if (!HOST_ID_PATTERN.test(userId)) throw new Error("호스트 인증 정보가 올바르지 않습니다.");
  const now = Date.now();
  return signSession({ userId, expiresAt: now + SESSION_TTL_MS, authenticatedAt: now, issuedAt: now });
}

async function signSession(session: HostSession): Promise<string> {
  const payload = `${session.userId}|${session.expiresAt}|${session.authenticatedAt}|${session.issuedAt}|v2`;
  const signature = await hmacHex(payload);
  return `${btoa(payload)}.${signature}`;
}

export async function readSessionToken(token: string | undefined | null): Promise<HostSession | null> {
  if (!token || token.length > 512) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const encodedPayload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedPayload) || !/^[a-f0-9]{64}$/u.test(signature)) return null;
  let payload = "";
  try {
    payload = atob(encodedPayload);
  } catch {
    return null;
  }
  if (btoa(payload) !== encodedPayload) return null;
  const expected = await hmacHex(payload);
  if (!timingSafeEqualHex(signature, expected)) return null;
  const parts = payload.split("|");
  if (parts.length !== 2 && (parts.length !== 5 || parts[4] !== "v2")) return null;
  const userId = parts[0];
  // A profile-backed host carries its auth uuid as the cookie subject and is not in ADMIN_USER_IDS.
  // Revocation for uuid hosts is the `requireHost` / session-route status gate (60 s cache, Task 4);
  // the Edge middleware stays cookie-only and never queries the profile store.
  if (!HOST_ID_PATTERN.test(userId) || !(isCurrentHostSessionUser(userId) || isProfileBackedHostId(userId))) return null;
  const numericParts = parts.length === 2 ? parts.slice(1) : parts.slice(1, 4);
  if (numericParts.some((value) => !/^[1-9][0-9]{0,15}$/u.test(value) || !Number.isSafeInteger(Number(value)))) return null;
  const expiresAt = Number(parts[1]);
  const authenticatedAt = parts.length === 2 ? expiresAt - LEGACY_SESSION_TTL_MS : Number(parts[2]);
  const issuedAt = parts.length === 2 ? authenticatedAt : Number(parts[3]);
  const now = Date.now();
  const ttl = parts.length === 2 ? LEGACY_SESSION_TTL_MS : SESSION_TTL_MS;
  if (authenticatedAt <= 0 || issuedAt < authenticatedAt || issuedAt > now || expiresAt <= now
    || expiresAt <= issuedAt || expiresAt > issuedAt + ttl
    || expiresAt > authenticatedAt + SESSION_ABSOLUTE_TTL_MS) return null;
  return { userId, expiresAt, authenticatedAt, issuedAt };
}

export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  return (await readSessionToken(token)) !== null;
}

export async function refreshSessionToken(token: string | undefined | null): Promise<{ token: string; session: HostSession } | null> {
  const previous = await readSessionToken(token);
  if (!previous) return null;
  const now = Date.now();
  if (previous.expiresAt <= now || previous.expiresAt - now > SESSION_REFRESH_THRESHOLD_MS) return null;
  const expiresAt = Math.min(now + SESSION_TTL_MS, previous.authenticatedAt + SESSION_ABSOLUTE_TTL_MS);
  if (expiresAt <= previous.expiresAt) return null;
  const session = { ...previous, expiresAt, issuedAt: now };
  return { token: await signSession(session), session };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
