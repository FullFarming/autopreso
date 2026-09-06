import assert from "node:assert/strict";
import test from "node:test";

import {
  buildParticipantEntryUrl,
  buildViewerSurfaceUrl,
  getViewerSurfaceRedirect,
  isIpadUserAgent,
} from "./viewer-surface-routing";

test("participant entry has a fixed local destination and preserves only one language selection", () => {
  assert.equal(buildParticipantEntryUrl({}), "/watch");
  assert.equal(buildParticipantEntryUrl({ language: "ko" }), "/watch?language=ko");
  assert.equal(buildParticipantEntryUrl({ language: ["ko", "en"] }), "/watch");
  assert.equal(buildParticipantEntryUrl({ next: "https://evil.test", redirect: "//evil.test", invite: "private-token" }), "/watch");
  const maliciousLanguage = "//evil.test/#invite=secret&next=/admin";
  const destination = new URL(buildParticipantEntryUrl({ language: maliciousLanguage }), "https://nova.test");
  assert.equal(destination.origin, "https://nova.test");
  assert.equal(destination.pathname, "/watch");
  assert.equal(destination.searchParams.get("language"), maliciousLanguage);
  assert.equal(destination.hash, "");
  assert.equal(destination.searchParams.has("next"), false);
});

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
