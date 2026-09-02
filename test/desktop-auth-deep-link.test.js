import assert from "node:assert/strict";
import test from "node:test";
import { buildDesktopLoginUrl, createDesktopLoginState, findDesktopAuthDeepLink, isAllowedDesktopExternalLogin, parseDesktopAuthDeepLink } from "../electron/desktop-auth-deep-link.js";

const state = "A".repeat(43);
const code = "b".repeat(64);
const base = "https://workspace.example.test";

test("state is 32 random bytes as base64url", () => {
  const value = createDesktopLoginState(() => Buffer.alloc(32, 1));
  assert.match(value, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(value, Buffer.alloc(32, 1).toString("base64url"));
});

test("deep link parsing accepts only nova://auth/callback with a 64-hex code and 43-char state", () => {
  assert.deepEqual(parseDesktopAuthDeepLink(`nova://auth/callback?code=${code}&state=${state}`), { code, state });
  for (const bad of [`nova://auth/other?code=${code}&state=${state}`, `nova://auth/callback?code=xyz&state=${state}`, `nova://auth/callback?code=${code}&state=short`,
    `https://auth/callback?code=${code}&state=${state}`, `nova://auth/callback?code=${code}&state=${state}&extra=1`, "", null, 42]) {
    assert.equal(parseDesktopAuthDeepLink(bad), null, String(bad));
  }
});

test("argv scanning finds the deep link and ignores everything else", () => {
  assert.equal(findDesktopAuthDeepLink(["NOVA.exe", "--flag", `nova://auth/callback?code=${code}&state=${state}`]), `nova://auth/callback?code=${code}&state=${state}`);
  assert.equal(findDesktopAuthDeepLink(["NOVA.exe", "https://example.com"]), null);
});

test("login URL and external-login allowlist are bound to the workspace origin", () => {
  assert.equal(buildDesktopLoginUrl(`${base}/`, state), `${base}/login?client=desktop&state=${state}`);
  assert.equal(isAllowedDesktopExternalLogin(`${base}/login?client=desktop&state=${state}&auto=google`, base), true);
  assert.equal(isAllowedDesktopExternalLogin(`https://evil.example/login?client=desktop&state=${state}&auto=google`, base), false);
  assert.equal(isAllowedDesktopExternalLogin(`${base}/admin?client=desktop&state=${state}&auto=google`, base), false);
  assert.equal(isAllowedDesktopExternalLogin(`${base}/login?client=desktop&state=${state}`, base), false, "auto=google required");
  assert.equal(isAllowedDesktopExternalLogin(`${base}/login?client=desktop&state=${state}&auto=google&x=1`, base), false, "no extra params");
});
