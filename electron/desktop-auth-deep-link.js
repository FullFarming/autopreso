// Desktop Google login round-trips through the system browser and comes back
// as `nova://auth/callback?code=<64 hex>&state=<43 base64url>`. Everything the
// main process accepts from that URL - or opens externally on the login
// window's behalf - is validated here so `main.js` only wires events together.
import crypto from "node:crypto";

export const DESKTOP_AUTH_SCHEME = "nova";
const STATE = /^[A-Za-z0-9_-]{43}$/u;
const CODE = /^[0-9a-f]{64}$/u;

export function createDesktopLoginState(randomBytesFn = crypto.randomBytes) {
  return Buffer.from(randomBytesFn(32)).toString("base64url");
}

export function parseDesktopAuthDeepLink(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== `${DESKTOP_AUTH_SCHEME}:` || url.host !== "auth" || url.pathname !== "/callback") return null;
  const keys = [...url.searchParams.keys()].sort();
  if (keys.join(",") !== "code,state") return null;
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  return CODE.test(code) && STATE.test(state) ? { code, state } : null;
}

// Windows/Linux deliver the deep link as an argv entry of the second instance.
export function findDesktopAuthDeepLink(argv) {
  if (!Array.isArray(argv)) return null;
  return argv.find((arg) => typeof arg === "string" && arg.startsWith(`${DESKTOP_AUTH_SCHEME}://`) && parseDesktopAuthDeepLink(arg)) ?? null;
}

export function buildDesktopLoginUrl(baseUrl, state) {
  const url = new URL("/login", baseUrl);
  url.search = new URLSearchParams({ client: "desktop", state }).toString();
  return url.href;
}

// The login page may ask the main process to open exactly one URL in the
// system browser: the workspace's own /login with client=desktop, the pending
// state, auto=google, and nothing else.
export function isAllowedDesktopExternalLogin(value, baseUrl) {
  if (typeof value !== "string" || /[\r\n]/u.test(value) || value.length > 512) return false;
  let target; let origin;
  try { target = new URL(value); origin = new URL(baseUrl).origin; } catch { return false; }
  if (target.origin !== origin || target.pathname !== "/login" || target.username || target.password || target.hash) return false;
  const keys = [...target.searchParams.keys()].sort().join(",");
  return keys === "auto,client,state" && target.searchParams.get("client") === "desktop"
    && target.searchParams.get("auto") === "google" && STATE.test(target.searchParams.get("state") ?? "");
}
