import assert from "node:assert/strict";
import { test } from "node:test";

import { isPinnedToLatest, newestFirst, PIN_THRESHOLD_PX } from "./caption-feed";
import { countdownMsUntil, formatCountdown } from "./countdown";

test("newestFirst reverses without mutating the source array", () => {
  const source = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
  const ordered = newestFirst(source);
  assert.deepEqual(ordered.map((item) => item.seq), [3, 2, 1]);
  assert.deepEqual(source.map((item) => item.seq), [1, 2, 3]);
});

test("newestFirst keeps an empty feed empty", () => {
  assert.deepEqual(newestFirst([]), []);
});

test("isPinnedToLatest pins readers at or near the top of the feed", () => {
  assert.equal(isPinnedToLatest(0), true);
  assert.equal(isPinnedToLatest(PIN_THRESHOLD_PX - 1), true);
  assert.equal(isPinnedToLatest(PIN_THRESHOLD_PX), false);
  assert.equal(isPinnedToLatest(500), false);
});

test("formatCountdown renders HH:MM:SS and clamps at zero", () => {
  assert.equal(formatCountdown(0), "00:00:00");
  assert.equal(formatCountdown(-5_000), "00:00:00");
  assert.equal(formatCountdown(61_000), "00:01:01");
  assert.equal(formatCountdown(3_600_000 + 2 * 60_000 + 3_000), "01:02:03");
});

test("countdownMsUntil returns remaining ms and null for missing or invalid schedules", () => {
  const now = Date.parse("2026-07-23T10:00:00.000Z");
  assert.equal(countdownMsUntil("2026-07-23T10:00:30.000Z", now), 30_000);
  assert.equal(countdownMsUntil("2026-07-23T09:59:00.000Z", now), -60_000);
  assert.equal(countdownMsUntil(null, now), null);
  assert.equal(countdownMsUntil("not-a-date", now), null);
});
