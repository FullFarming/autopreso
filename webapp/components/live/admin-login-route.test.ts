import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { isPublicUnauthenticatedPath } from "../../lib/security/csrf";

// The webapp must let a host run a live call without the desktop app: the
// participant join screen and the admin sign-in page are the two entrances,
// and each one must expose the route to the other so the role choice is
// visible instead of requiring a memorized URL.
const viewerSource = readFileSync(resolve(process.cwd(), "components/live/LiveViewer.tsx"), "utf8");
const loginSource = readFileSync(resolve(process.cwd(), "app/(login)/login/page.tsx"), "utf8");
const styles = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

test("the first visit is public while administrator and record surfaces stay protected", () => {
  assert.equal(isPublicUnauthenticatedPath("/"), true);
  for (const pathname of ["/admin", "/admin/", "/admin/settings", "/records", "/m/records", "//admin"]) {
    assert.equal(isPublicUnauthenticatedPath(pathname), false, pathname);
  }
});

test("the landing page opens participant entry and the protected admin route owns the host dashboard", () => {
  const home = readFileSync(resolve(process.cwd(), "app/page.tsx"), "utf8");
  assert.match(home, /redirect\(buildParticipantEntryUrl\(await searchParams\)\)/u);
  assert.doesNotMatch(home, /LiveHostDashboard/u);
  const admin = readFileSync(resolve(process.cwd(), "app/admin/page.tsx"), "utf8");
  assert.match(admin, /<LiveHostDashboard\s*\/>/u);
  assert.match(loginSource, /window\.location\.assign\("\/admin"\)/u);
});

test("participant join screen offers the admin sign-in route", () => {
  // The link must live on the join (pre-viewer) screen and point at /login,
  // where middleware-issued sessions land on the host dashboard.
  assert.match(viewerSource, /live-join-admin/u);
  assert.match(viewerSource, /href="\/login"/u);
  assert.match(viewerSource, /관리자로 로그인/u);
});

test("admin sign-in page names the admin role and routes back to participant join", () => {
  assert.match(loginSource, /관리자\(호스트\) 로그인/u);
  assert.match(loginSource, /href="\/watch"/u);
  assert.match(loginSource, /참가자로 입장/u);
});

test("the join screen admin link is styled as a quiet secondary action", () => {
  assert.match(styles, /\.live-join-admin/u);
  assert.match(styles, /\.live-join-admin a \{[^}]*min-height:\s*44px/u);
  assert.match(styles, /\.live-viewer-shell a:focus-visible/u);
});
