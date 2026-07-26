import assert from "node:assert/strict";
import test from "node:test";

import { GeminiTextTranslateAdapter } from "../src/google-provider-adapters.js";

// Perceived realtime on a TRANSLATED lane is bounded by the translation
// round-trip: #drainPartialLane runs one translation at a time per language and
// drops the intermediate partials (latest-wins), so the viewer only sees text
// advance once per round-trip. A 2.5s ceiling meant one slow call could hold the
// lane for 2.5 seconds while fresher speech piled up behind it, which reads as
// the caption "sticking". Abandoning a stale partial sooner lets the NEXT,
// fresher partial go out instead — the finalized utterance is unaffected because
// it retries on its own longer budget.
test("an interim translation is abandoned well before a final one", () => {
  const translator = new GeminiTextTranslateAdapter({ client: { models: { generateContent() {} } } });
  assert.ok(
    translator.partialTimeoutMilliseconds <= 1_200,
    `interim budget is ${translator.partialTimeoutMilliseconds}ms; a stale partial must not hold the lane that long`,
  );
  assert.ok(
    translator.partialTimeoutMilliseconds < translator.timeoutMilliseconds,
    "an interim must never be given as long as a final",
  );
});
