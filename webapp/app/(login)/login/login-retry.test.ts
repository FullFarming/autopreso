import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getLoginRetryDeadline, getLoginRetrySeconds } from "./login-retry";

test("Retry-After accepts server seconds and HTTP dates without inventing a wait", () => {
  const now = Date.parse("2026-08-31T00:00:00Z");
  assert.equal(getLoginRetryDeadline("60", now), now + 60_000);
  assert.equal(getLoginRetryDeadline("0", now), now);
  assert.equal(getLoginRetryDeadline("Mon, 31 Aug 2026 00:02:00 GMT", now), now + 120_000);
  for (const invalid of [null, "", "-1", "1.5", "NaN", "999999999999999999", "tomorrow"]) assert.equal(getLoginRetryDeadline(invalid, now), null);
  assert.equal(getLoginRetrySeconds(now + 1001, now), 2);
  assert.equal(getLoginRetrySeconds(now + 1, now), 1);
  assert.equal(getLoginRetrySeconds(now, now), 0);
  assert.equal(getLoginRetrySeconds(now - 1000, now), 0);
});

test("login waits for explicit submission and erases password state before navigation", () => {
  // The credential form now lives in the shared login card; the page only mounts it.
  const source = readFileSync(new URL("../../../components/auth/LoginCard.tsx", import.meta.url), "utf8");
  assert.match(source, /headers\.get\("Retry-After"\)/u);
  assert.match(source, /retryUntilRef\.current > Date\.now\(\)/u);
  assert.match(source, /disabled=\{submitting \|\| retrySeconds > 0\}/u);
  assert.match(source, /role="timer" aria-live="off"/u);
  assert.ok(source.indexOf('setPassword("")') < source.indexOf('window.location.assign("/admin")'));
  assert.doesNotMatch(source, /set(?:Timeout|Interval)\([^;]*handleSubmit/u);
});
