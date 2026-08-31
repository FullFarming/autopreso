import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getGatewayConnectionPresentation } from "./gateway-connection-presentation";

test("gateway states expose safe Korean labels without provider details", () => {
  assert.deepEqual(getGatewayConnectionPresentation("connected"), {
    label: "실시간 연결",
    stateLabel: "연결됨",
    tone: "ok",
  });
  assert.equal(getGatewayConnectionPresentation("reconnecting").stateLabel, "다시 연결 중");
  assert.equal(getGatewayConnectionPresentation("failed").stateLabel, "연결 종료");
  for (const state of ["idle", "warming", "connecting", "connected", "reconnecting", "error", "paused", "ended", "failed"] as const) {
    assert.doesNotMatch(JSON.stringify(getGatewayConnectionPresentation(state)), /gemini|google|cloud run|gateway|token|model/iu);
  }
});

test("shared connection control is a disclosure with bounded announcements", () => {
  const source = readFileSync(new URL("./GatewayConnectionStatus.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("./gateway-connection-status.module.css", import.meta.url), "utf8");
  assert.match(source, /<details/u);
  assert.match(source, /<summary[\s\S]*aria-label=/u);
  assert.match(source, /role="status" aria-live="polite"/u);
  assert.match(source, /stateLabel/u);
  assert.doesNotMatch(source, /fetch\(|\/health|\bprovider\b|\bmodel\b|\btoken\b/iu);
  assert.match(styles, /min-height:\s*44px/u);
  assert.match(styles, /outline:\s*2px solid var\(--nova-system-default\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}|linear-gradient|radial-gradient/iu);
});
