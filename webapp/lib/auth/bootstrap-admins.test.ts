import assert from "node:assert/strict";
import test from "node:test";
import { isBootstrapAdminEmail, readBootstrapAdminConfig, warnBreakGlassLogin } from "./bootstrap-admins";

test("bootstrap emails are lower-cased, trimmed, capped, and the legacy host id is the first ADMIN_USER_IDS entry", () => {
  const config = readBootstrapAdminConfig({ ADMIN_BOOTSTRAP_EMAILS: " Noel.Kim@Example.com, second@example.com ", ADMIN_USER_IDS: "noel,other" });
  assert.deepEqual([...config.emails], ["noel.kim@example.com", "second@example.com"]);
  assert.equal(config.legacyHostId, "noel");
  assert.equal(isBootstrapAdminEmail("NOEL.KIM@example.com", config), true);
  assert.equal(isBootstrapAdminEmail("guest@example.com", config), false);
});

test("missing or invalid values fail closed", () => {
  assert.deepEqual([...readBootstrapAdminConfig({}).emails], []);
  assert.equal(readBootstrapAdminConfig({ ADMIN_USER_IDS: "bad id!" }).legacyHostId, null);
  assert.throws(() => readBootstrapAdminConfig({ ADMIN_BOOTSTRAP_EMAILS: Array.from({ length: 21 }, (_, i) => `a${i}@x.io`).join(",") }), /ADMIN_BOOTSTRAP_EMAILS/u);
  assert.throws(() => readBootstrapAdminConfig({ ADMIN_BOOTSTRAP_EMAILS: "not-an-email" }), /ADMIN_BOOTSTRAP_EMAILS/u);
});

test("the break-glass warning carries the code only - never a host id, email, or credential", () => {
  const lines: unknown[][] = [];
  const previous = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args); };
  try { warnBreakGlassLogin("ADMIN_BOOTSTRAP_BREAK_GLASS"); }
  finally { console.warn = previous; }
  assert.deepEqual(lines, [["[auth] legacy break-glass login: ADMIN_BOOTSTRAP_BREAK_GLASS"]]);
});
