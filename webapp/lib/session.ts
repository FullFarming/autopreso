// Stateless HMAC-signed session token. Uses Web Crypto so the same code runs
// in the Edge middleware runtime and in Node route handlers.

export const SESSION_COOKIE = "rnw_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

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
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${userId}|${expiresAt}`;
  const signature = await hmacHex(payload);
  return `${btoa(payload)}.${signature}`;
}

export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const encodedPayload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  let payload = "";
  try {
    payload = atob(encodedPayload);
  } catch {
    return false;
  }
  const expected = await hmacHex(payload);
  if (!timingSafeEqualHex(signature, expected)) return false;
  const parts = payload.split("|");
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  return true;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
