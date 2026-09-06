import assert from "node:assert/strict";
import test from "node:test";
import { createGeminiAdmissionController } from "./admission.js";

test("disconnecting and reconnecting cannot reset the same session's paid request window", () => {
  let now = 0;
  const admission = createGeminiAdmissionController({ now: () => now, limits: {
    globalOutstanding: 2, sessionOutstanding: 1, globalRequestsPerMinute: 10,
    sessionRequestsPerMinute: 1, maximumTrackedSessions: 2,
  } });
  admission.acquire("session-1"); admission.release("session-1");
  admission.releaseSession("session-1");
  assert.throws(() => admission.acquire("session-1"), /GEMINI_SESSION_RATE_LIMITED/u);
  now = 60_000;
  admission.releaseSession("session-1");
  admission.acquire("session-1"); admission.release("session-1");
});
