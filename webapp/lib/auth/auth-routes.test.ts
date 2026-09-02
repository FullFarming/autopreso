import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { isPublicUnauthenticatedPath } from "../security/csrf";

const exchange = readFileSync(resolve(process.cwd(), "app/api/auth/exchange/route.ts"), "utf8");
const desktop = readFileSync(resolve(process.cwd(), "app/api/auth/desktop-exchange/route.ts"), "utf8");

test("auth pages and exchange routes are reachable before login; console stays protected", () => {
  for (const p of ["/auth/callback", "/pending", "/api/auth/exchange", "/api/auth/desktop-exchange"]) assert.equal(isPublicUnauthenticatedPath(p), true, p);
  for (const p of ["/console", "/console/users", "/admin"]) assert.equal(isPublicUnauthenticatedPath(p), false, p);
});

test("exchange route shares the login rate limiter and origin check, sets the cookie only for approved web logins, and never echoes tokens", () => {
  assert.match(exchange, /assertStrictOrigin\(request\)/u);
  assert.match(exchange, /loginRateLimiter\.check\(request\.headers\)/u);
  assert.match(exchange, /enforceHostLoginRateLimit\(request, admissionStore\)/u);
  assert.match(exchange, /readBoundedJsonBody\(request\)/u);
  assert.match(exchange, /outcome\.kind === "approved" && parsed\.data\.client !== "desktop"/u);
  assert.match(exchange, /response\.cookies\.set\(SESSION_COOKIE/u);
  assert.match(exchange, /httpOnly: true/u);
  assert.doesNotMatch(exchange, /accessToken\s*[,}]\s*\)/u, "route must not place the access token in responses or logs");
  assert.doesNotMatch(exchange, /console\.(log|info|warn|error)\(/u);
});

test("desktop exchange consumes the code once, requires approved status, and issues the same cookie shape", () => {
  assert.match(desktop, /assertStrictOrigin\(request\)/u);
  assert.match(desktop, /consumeDesktopCode\(\{ code: parsed\.data\.code, state: parsed\.data\.state \}\)/u);
  assert.match(desktop, /"DESKTOP_CODE_INVALID", 401/u);
  assert.match(desktop, /"PROFILE_NOT_APPROVED", 403/u);
  assert.match(desktop, /createSessionToken\(consumed\.hostId\)/u);
  assert.match(desktop, /maxAge: SESSION_TTL_SECONDS/u);
  assert.doesNotMatch(desktop, /console\.(log|info|warn|error)\(/u);
});
