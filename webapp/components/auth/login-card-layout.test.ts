import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const card = readFileSync(resolve(process.cwd(), "components/auth/LoginCard.tsx"), "utf8");
const css = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const callback = readFileSync(resolve(process.cwd(), "app/auth/callback/page.tsx"), "utf8");
const pending = readFileSync(resolve(process.cwd(), "app/pending/page.tsx"), "utf8");
const messages = readFileSync(resolve(process.cwd(), "lib/system-language/login-messages.ts"), "utf8");

test("the card has exactly one primary action (Google), then a divider, then the credential form, then quiet links", () => {
  const googleIndex = card.indexOf('data-auth-action="google"');
  const dividerIndex = card.indexOf('className="auth-divider"');
  const formIndex = card.indexOf('data-auth-action="submit"');
  const linksIndex = card.indexOf('className="auth-links"');
  assert.ok(googleIndex > -1 && googleIndex < dividerIndex && dividerIndex < formIndex && formIndex < linksIndex);
  assert.equal((card.match(/live-primary-action/gu) ?? []).length, 1, "only the Google button is primary");
  assert.match(card, /<GoogleIcon/u);
  assert.doesNotMatch(card, /[\u{1F300}-\u{1FAFF}]/u, "no emoji icons");
});

test("password visibility toggle, blur validation, busy state, and signup mode exist", () => {
  assert.match(card, /aria-pressed=\{showPassword\}/u);
  assert.match(card, /onBlur=\{/u);
  assert.match(card, /aria-busy=\{submitting\}/u);
  assert.match(card, /mode === "signup"/u);
  assert.match(card, /signUp\(\{/u);
  assert.match(card, /signInWithPassword\(\{/u);
  assert.match(card, /signInWithOAuth\(\{ provider: "google"/u);
  assert.match(card, /fetch\("\/api\/auth\/exchange"/u);
  assert.match(card, /fetch\("\/api\/login"/u, "legacy id login remains");
  assert.match(card, /window\.novaDesktopLogin\?\.openExternal\(/u);
});

test("styles: 375px single column, 44px targets, focus ring kept", () => {
  assert.match(css, /\.auth-card \{[^}]*max-width:\s*(?:26rem|28rem|420px|440px)/u);
  assert.match(css, /\.auth-card (?:button|\.auth-button)[^{]*\{[^}]*min-height:\s*44px/u);
  assert.match(css, /\.auth-divider/u);
  assert.match(css, /\.auth-links a,\s*\.auth-links button[^{]*\{[^}]*min-height:\s*44px/u);
  assert.doesNotMatch(css, /\.auth-card [^{]*\{[^}]*outline:\s*none/u);
});

test("callback and pending pages: exchange, safe error text, desktop return button, logout", () => {
  assert.match(callback, /getSession\(\)/u);
  assert.match(callback, /fetch\("\/api\/auth\/exchange"/u);
  assert.match(callback, /safeSupabaseErrorMessage\(/u);
  assert.match(callback, /startsWith\("nova:\/\/"\)/u);
  assert.match(pending, /signOut\(\)/u);
  assert.match(pending, /fetch\("\/api\/logout"/u);
  for (const key of ["googleContinue", "or", "identifier", "password", "signIn", "signUp", "resetPassword", "checkEmail", "pendingTitle", "returnToApp"]) {
    assert.match(messages, new RegExp(`\\b${key}:`, "u"), key);
  }
});

test("login dictionary: identical keys in ko/en/ja, every message non-empty, placeholders agree with Korean", async () => {
  const { loginMessages } = await import("../../lib/system-language/login-messages");
  const placeholders = (text: string) => [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/gu)].map((match) => match[1]).sort();
  for (const language of ["en", "ja"] as const) {
    assert.deepEqual(Object.keys(loginMessages[language]), Object.keys(loginMessages.ko), language);
    for (const [key, message] of Object.entries(loginMessages[language])) {
      assert.ok(message.trim(), `${language}: ${key}`);
      assert.deepEqual(placeholders(message), placeholders(loginMessages.ko[key]), `${language}: ${key}`);
    }
  }
});
