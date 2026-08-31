import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appendRecoverableHostSessions,
  buildHostSessionIdentityPatch,
  canApplyHostRecovery,
  getHostSessionScheduleFields,
  resolveHostSessionRecovery,
  type RecoverableHostSession,
} from "./host-session-recovery";

test("late recovery completion cannot replace a newer user intent or clear its busy state", async () => {
  let epoch = 1;
  const capturedEpoch = epoch;
  let selected = "new-session";
  let isBusy = true;
  const completion = Promise.resolve().then(() => {
    if (!canApplyHostRecovery(capturedEpoch, epoch, true)) return;
    selected = "old-session";
    isBusy = false;
  });
  epoch += 1;
  await completion;
  assert.equal(selected, "new-session");
  assert.equal(isBusy, true);
  assert.equal(canApplyHostRecovery(epoch, epoch, false), false);
  assert.equal(canApplyHostRecovery(epoch, epoch, true), true);
});

test("saved schedule round-trips local date and time without changing a past schedule", () => {
  const saved = { title: "Saved session", scheduledAt: new Date(2026, 7, 1, 9, 15).toISOString() };
  const fields = getHostSessionScheduleFields(saved.scheduledAt);
  assert.deepEqual(fields, { sessionDate: "2026-08-01", startTime: "09:15" });
  assert.deepEqual(buildHostSessionIdentityPatch(saved, { title: saved.title, ...fields }, Date.now()), {});
  assert.deepEqual(buildHostSessionIdentityPatch(saved, { title: "Updated title", ...fields }, Date.now()), { title: "Updated title" });
});

test("schedule changes validate future dates and leave untouched unscheduled sessions alone", () => {
  const now = new Date(2026, 7, 31, 9, 0).getTime();
  const saved = { title: "Saved", scheduledAt: null };
  assert.deepEqual(getHostSessionScheduleFields(null), { sessionDate: "", startTime: "" });
  assert.deepEqual(buildHostSessionIdentityPatch(saved, { title: "Saved", sessionDate: "", startTime: "" }, now), {});
  assert.deepEqual(buildHostSessionIdentityPatch(saved, { title: "Saved", sessionDate: "2026-09-01", startTime: "10:00" }, now), {
    scheduledAt: new Date(2026, 8, 1, 10, 0).toISOString(),
  });
  for (const sessionDate of ["2026-08-01", "2026-02-30", "bad"]) {
    assert.throws(() => buildHostSessionIdentityPatch(saved, { title: "Saved", sessionDate, startTime: "10:00" }, now));
  }
});

function session(
  id: string,
  status: RecoverableHostSession["status"],
): RecoverableHostSession {
  return {
    id,
    title: `Session ${id}`,
    status,
    scheduledAt: null,
    viewerCount: 0,
    version: 1,
  };
}

test("one recoverable session is restored for every active status", () => {
  for (const status of ["preparing", "live", "paused"] as const) {
    const recoverable = session(status, status);

    assert.deepEqual(resolveHostSessionRecovery([recoverable]), {
      kind: "restore",
      session: recoverable,
    });
  }
});

test("multiple recoverable sessions require selection and preserve newest-first input", () => {
  const newest = session("newest", "live");
  const older = session("older", "paused");
  const oldest = session("oldest", "preparing");

  assert.deepEqual(resolveHostSessionRecovery([newest, older, oldest]), {
    kind: "choose",
    sessions: [newest, older, oldest],
  });
});

test("a partial recovery page cannot auto-select its only visible session", () => {
  const first = session("first", "preparing");
  assert.deepEqual(resolveHostSessionRecovery([first], 100), { kind: "choose", sessions: [first] });
});

test("appending overlapping pages preserves selection order and newer session versions", () => {
  const first = { ...session("first", "preparing"), version: 3 };
  const second = session("second", "paused");
  const third = session("third", "live");
  assert.deepEqual(appendRecoverableHostSessions([first, second], [session("first", "preparing"), third, { ...second, version: 2 }]),
    [first, { ...second, version: 2 }, third]);
});

test("no active session resolves to idle and ended or failed rows stay inactive", () => {
  assert.deepEqual(resolveHostSessionRecovery([]), { kind: "idle" });
  assert.deepEqual(resolveHostSessionRecovery([
    session("ended", "stopped"),
    session("failed", "failed"),
  ]), { kind: "idle" });
});

test("inactive rows cannot displace one valid recovery candidate", () => {
  const active = session("active", "paused");

  assert.deepEqual(resolveHostSessionRecovery([
    session("ended", "stopped"),
    active,
    session("failed", "failed"),
  ]), {
    kind: "restore",
    session: active,
  });
});

test("recoverable session API shape contains only the documented fields", () => {
  assert.deepEqual(Object.keys(session("shape", "live")), [
    "id",
    "title",
    "status",
    "scheduledAt",
    "viewerCount",
    "version",
  ]);
});
