import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isHostSessionPage } from "./host-session-pages";

test("session maintenance excludes login, participants, demos, and similarly named routes", () => {
  for (const path of ["/admin", "/records", "/m/records"]) assert.equal(isHostSessionPage(path), true, path);
  for (const path of [null, "/stage/session-id", "/", "/login", "/watch", "/m/watch", "/m/watch/demo", "/admin-other", "/records/demo", "/stage", "/stage/a/child", "/stage/"]) assert.equal(isHostSessionPage(path), false, String(path));
});

test("maintenance pauses on errors, never forces navigation, and does not restart when UI language changes", () => {
  const source = readFileSync(new URL("./HostSessionKeeper.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(!isHostSessionPage\(pathname\)\) return/u);
  assert.match(source, /document\.visibilityState !== "visible"/u);
  assert.match(source, /automaticChecksStopped = result\.kind !== "authenticated"/u);
  assert.match(source, /role="status"/u);
  assert.match(source, /href="\/login"/u);
  assert.doesNotMatch(source, /router\.|location\.|\[pathname,\s*(?:t|language)/u);
});

test("logout navigation is conditional on a confirmed coordinator result", () => {
  const source = readFileSync(new URL("../GlassTopBar.tsx", import.meta.url), "utf8");
  assert.match(source, /await logoutHostSession\(\)/u);
  assert.ok(source.indexOf("await logoutHostSession()") < source.indexOf('router.push("/login")'));
  assert.match(source, /catch[\s\S]*setLogoutError/u);
  assert.doesNotMatch(source, /finally\s*\{\s*router\./u);
});
