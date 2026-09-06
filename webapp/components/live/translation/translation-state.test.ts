import assert from "node:assert/strict";
import test from "node:test";
import {
  isPinnedToLiveEdge,
  resolveLanguageSelectorPresentation,
} from "./translation-state";

test("the live edge stays pinned through 48px and unpins after it", () => {
  assert.equal(isPinnedToLiveEdge({ scrollHeight: 1_000, scrollTop: 752, clientHeight: 200 }), true);
  assert.equal(isPinnedToLiveEdge({ scrollHeight: 1_000, scrollTop: 751, clientHeight: 200 }), false);
});

test("three spacious languages use segments while compact or larger sets use select", () => {
  assert.equal(resolveLanguageSelectorPresentation(3, false), "segmented");
  assert.equal(resolveLanguageSelectorPresentation(3, true), "select");
  assert.equal(resolveLanguageSelectorPresentation(4, false), "select");
});
