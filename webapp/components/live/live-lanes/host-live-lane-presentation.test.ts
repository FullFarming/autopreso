import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("host lane surface mounts only the selected shared language panel", () => {
  const source = readFileSync(new URL("./HostLiveLaneSurface.tsx", import.meta.url), "utf8");
  assert.match(source, /buildTranslationLanes/u);
  assert.match(source, /projectCaptionLane/u);
  assert.match(source, /TranslationLaneTabs/u);
  assert.match(source, /renderPanel=\{renderLane\}/u);
  assert.match(source, /GatewayConnectionStatus/u);
  assert.doesNotMatch(source, /fetch\(|\/health|\bprovider\b|\bmodel\b|\btoken\b/iu);
});

test("host originals use only the canonical source ledger and preserve its failure state", () => {
  const surface = readFileSync(new URL("./HostLiveLaneSurface.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(surface, /recentSpeeches|sourceFallback/u);
  assert.match(surface, /props\.sources\.map/u);
  assert.match(surface, /lane\.kind === "source" \? sourceInputs/u);
  assert.match(surface, /sourceStatusMessage/u);
});
