import assert from "node:assert/strict";
import test from "node:test";

import {
  buildViewerSurfaceUrl,
  getViewerSurfaceRedirect,
  isIpadUserAgent,
} from "./viewer-surface-routing";

const IPHONE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const IPAD_USER_AGENT = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const IPADOS_DESKTOP_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

test("iPad and iPadOS desktop mode use the desktop watch surface", () => {
  assert.equal(isIpadUserAgent(IPAD_USER_AGENT, 5), true);
  assert.equal(isIpadUserAgent(IPADOS_DESKTOP_USER_AGENT, 5), true);
  assert.equal(getViewerSurfaceRedirect("/m/watch", IPAD_USER_AGENT, 5), "/watch");
  assert.equal(getViewerSurfaceRedirect("/m/watch", IPADOS_DESKTOP_USER_AGENT, 5), "/watch");
});

test("a touch Mac is not treated as iPad without the iPadOS Mobile marker", () => {
  const macUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15";
  assert.equal(isIpadUserAgent(macUserAgent, 5), false);
  assert.equal(getViewerSurfaceRedirect("/m/watch", macUserAgent, 5), null);
});

test("iPhone uses the compact surface while other route combinations stay put", () => {
  assert.equal(getViewerSurfaceRedirect("/watch", IPHONE_USER_AGENT, 5), "/m/watch");
  assert.equal(getViewerSurfaceRedirect("/m/watch", IPHONE_USER_AGENT, 5), null);
  assert.equal(getViewerSurfaceRedirect("/watch", IPAD_USER_AGENT, 5), null);
});

test("surface redirect preserves query and opaque QR fragment byte-for-byte", () => {
  assert.equal(
    buildViewerSurfaceUrl("/watch", "?language=ko", "#invite=opaque%2Btoken%3D"),
    "/watch?language=ko#invite=opaque%2Btoken%3D",
  );
});
