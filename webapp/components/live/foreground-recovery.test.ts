import assert from "node:assert/strict";
import test from "node:test";

import {
  requestForegroundRecovery,
  type ForegroundRecoveryState,
  shouldRequestForegroundRecovery,
} from "./foreground-recovery";

test("only visible lifecycle events request foreground recovery", () => {
  assert.equal(shouldRequestForegroundRecovery("visibilitychange", "hidden"), false);
  assert.equal(shouldRequestForegroundRecovery("visibilitychange", "visible"), true);
  assert.equal(shouldRequestForegroundRecovery("pageshow", "visible"), true);
  assert.equal(shouldRequestForegroundRecovery("online", "hidden"), false);
});

test("foreground recovery is single-flight and becomes available after completion", async () => {
  const state: ForegroundRecoveryState = { inFlight: null };
  let resolveRecovery!: () => void;
  let calls = 0;
  const recover = () => {
    calls += 1;
    return new Promise<void>((resolve) => { resolveRecovery = resolve; });
  };

  const first = requestForegroundRecovery(state, "pageshow", "visible", recover);
  const duplicate = requestForegroundRecovery(state, "online", "visible", recover);
  assert.equal(first, duplicate);
  assert.equal(calls, 1);
  resolveRecovery();
  await first;
  assert.equal(state.inFlight, null);

  await requestForegroundRecovery(state, "online", "visible", async () => { calls += 1; });
  assert.equal(calls, 2);
});

test("hidden recovery neither runs nor occupies the single-flight slot", () => {
  const state: ForegroundRecoveryState = { inFlight: null };
  let calls = 0;
  const result = requestForegroundRecovery(state, "visibilitychange", "hidden", () => { calls += 1; });

  assert.equal(result, null);
  assert.equal(state.inFlight, null);
  assert.equal(calls, 0);
});
