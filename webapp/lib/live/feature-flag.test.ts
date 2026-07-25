import assert from "node:assert/strict";
import test from "node:test";

import { isLiveCallEnabled } from "./feature-flag";

test("live call feature flag defaults to enabled", () => {
  assert.equal(isLiveCallEnabled({}), true);
  assert.equal(isLiveCallEnabled({ NEXT_PUBLIC_LIVE_CALL_ENABLED: "true" }), true);
  assert.equal(isLiveCallEnabled({ NEXT_PUBLIC_LIVE_CALL_ENABLED: "1" }), true);
  assert.equal(isLiveCallEnabled({ NEXT_PUBLIC_LIVE_CALL_ENABLED: "" }), true);
});

test("live call feature flag is disabled only when explicitly false", () => {
  assert.equal(isLiveCallEnabled({ NEXT_PUBLIC_LIVE_CALL_ENABLED: "false" }), false);
  assert.equal(isLiveCallEnabled({ NEXT_PUBLIC_LIVE_CALL_ENABLED: " FALSE " }), false);
});
