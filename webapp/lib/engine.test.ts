import assert from "node:assert/strict";
import test from "node:test";

import { targetsForConfig } from "./engine";

test("one input fans out to at most three distinct target channels", () => {
  assert.deepEqual(targetsForConfig({
    languagePair: "ko-en",
    targetLanguages: ["en", "ko", "ja", "en", "zh-Hans"],
  }), ["en", "ko", "ja"]);
});

test("target fanout canonicalizes aliases and rejects unsupported languages", () => {
  assert.deepEqual(targetsForConfig({
    languagePair: "ko-en",
    targetLanguages: [" en-US ", "en", "zh-TW", "unsupported", "ja-JP"],
  }), ["en", "zh-Hant", "ja"]);
});
