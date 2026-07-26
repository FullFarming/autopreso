import assert from "node:assert/strict";
import test from "node:test";

import {
  getDefaultLiveSchedule,
  INVALID_LIVE_SCHEDULE_ERROR,
  PAST_LIVE_SCHEDULE_ERROR,
  validateLiveSchedule,
} from "./live-session-schedule";

test("default schedule is ten minutes ahead and rounded up to five minutes", () => {
  const result = getDefaultLiveSchedule(new Date(2026, 6, 26, 10, 53, 42));

  assert.deepEqual(result, { sessionDate: "2026-07-26", startTime: "11:05" });
});

test("default schedule crosses the local date boundary safely", () => {
  const result = getDefaultLiveSchedule(new Date(2026, 6, 26, 23, 53, 42));

  assert.deepEqual(result, { sessionDate: "2026-07-27", startTime: "00:05" });
});

test("schedule validation returns the local time as an ISO instant", () => {
  const now = new Date(2026, 6, 26, 10, 53, 0);
  const result = validateLiveSchedule("2026-07-26", "11:05", now.getTime());

  assert.deepEqual(result, {
    scheduledAt: new Date(2026, 6, 26, 11, 5, 0).toISOString(),
    error: "",
  });
});

test("schedule validation rejects past and malformed local times", () => {
  const now = new Date(2026, 6, 26, 10, 53, 0).getTime();

  assert.equal(validateLiveSchedule("2026-07-26", "10:53", now).error, PAST_LIVE_SCHEDULE_ERROR);
  assert.equal(validateLiveSchedule("2026-02-30", "11:05", now).error, INVALID_LIVE_SCHEDULE_ERROR);
  assert.equal(validateLiveSchedule("2026-07-26", "24:00", now).error, INVALID_LIVE_SCHEDULE_ERROR);
});
