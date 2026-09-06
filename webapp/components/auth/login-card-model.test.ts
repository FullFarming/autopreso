import assert from "node:assert/strict";
import test from "node:test";

import { buildCallbackRedirect, buildDesktopGoogleStartUrl, classifyIdentifier, exchangeFailureKey, readCallbackParams, readDesktopLoginParams, safeSupabaseErrorMessage, validateSignup } from "./login-card-model";

const state = "s".repeat(43);

test("identifier routing: emails go to Supabase, host ids to the legacy route, junk is invalid", () => {
  assert.equal(classifyIdentifier(" Noel@Example.com "), "email");
  assert.equal(classifyIdentifier("noel"), "legacy-id");
  assert.equal(classifyIdentifier("noel kim"), "invalid");
  assert.equal(classifyIdentifier("@nope"), "invalid");
  assert.equal(classifyIdentifier(""), "invalid");
});

test("signup validation returns message keys per field", () => {
  const errors = validateSignup({ name: "", email: "bad", password: "short" });
  assert.deepEqual(Object.keys(errors), ["name", "email", "password"]);
  assert.equal(errors.name, "nameRequired");
  assert.equal(errors.email, "emailInvalid");
  assert.equal(errors.password, "passwordTooShort");
  assert.deepEqual(validateSignup({ name: "Noel", email: "n@x.io", password: "12345678" }), {});
});

test("desktop params require a 43-char state and build the system-browser start URL", () => {
  assert.deepEqual(readDesktopLoginParams(`?client=desktop&state=${state}`), { client: "desktop", state });
  assert.equal(readDesktopLoginParams("?client=desktop&state=short"), null);
  assert.equal(readDesktopLoginParams("?client=web"), null);
  assert.equal(buildDesktopGoogleStartUrl("https://nova.test", state), `https://nova.test/login?client=desktop&state=${state}&auto=google`);
  assert.equal(buildCallbackRedirect("https://nova.test", { state }), `https://nova.test/auth/callback?client=desktop&state=${state}`);
  assert.equal(buildCallbackRedirect("https://nova.test", null), "https://nova.test/auth/callback");
  assert.deepEqual(readCallbackParams(`?client=desktop&state=${state}`), { client: "desktop", state });
  assert.deepEqual(readCallbackParams("?client=desktop&state=x"), { client: "web" });
});

test("supabase error descriptions are bounded and sanitized", () => {
  assert.equal(safeSupabaseErrorMessage("?error=access_denied&error_description=User+cancelled"), "User cancelled");
  assert.equal(safeSupabaseErrorMessage(`?error_description=${"a".repeat(300)}`)?.length, 200);
  assert.equal(safeSupabaseErrorMessage("?error_description=%0Aline%07bell"), "linebell");
  assert.equal(safeSupabaseErrorMessage("?ok=1"), null);
});

test("exchange failures map to message keys by status and route code, never to server text", () => {
  assert.equal(exchangeFailureKey(403, "PROFILE_REJECTED"), "forbiddenRejected");
  assert.equal(exchangeFailureKey(403, "PROFILE_DISABLED"), "forbiddenDisabled");
  assert.equal(exchangeFailureKey(403, "EMAIL_UNCONFIRMED"), "emailUnconfirmed");
  assert.equal(exchangeFailureKey(403, undefined), "forbiddenRejected");
  assert.equal(exchangeFailureKey(429, "LOGIN_RATE_LIMITED"), "rateLimited");
  assert.equal(exchangeFailureKey(401, "AUTH_TOKEN_INVALID"), "invalidCredentials");
  assert.equal(exchangeFailureKey(500, undefined), "invalidCredentials");
});
