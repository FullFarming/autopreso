import assert from "node:assert/strict";
import test from "node:test";

import { generateSessionSummariesAfterEnd } from "./post-session-summary";

test("post-session summaries run per language with one retry and never throw", async () => {
  const calls: Array<{ language: string }> = [];
  let koAttempts = 0;
  const result = await generateSessionSummariesAfterEnd("session-1", "host-1", ["ko", "en", "ja"], {
    sleep: async () => {},
    log: () => {},
    generateForLanguage: async (_sessionId, _hostId, language) => {
      calls.push({ language });
      if (language === "ko") {
        koAttempts += 1;
        if (koAttempts === 1) throw new Error("transient");
        return "saved";
      }
      if (language === "en") return "empty";
      throw new Error("always fails");
    },
  });
  assert.deepEqual(result.saved, ["ko"]);
  assert.deepEqual(result.empty, ["en"]);
  assert.deepEqual(result.failed, ["ja"]);
  // ko retried once, en succeeded first try, ja retried once then gave up.
  assert.equal(calls.filter((call) => call.language === "ko").length, 2);
  assert.equal(calls.filter((call) => call.language === "en").length, 1);
  assert.equal(calls.filter((call) => call.language === "ja").length, 2);
});
