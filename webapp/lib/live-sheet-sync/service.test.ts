import assert from "node:assert/strict";
import test from "node:test";

import { LiveSheetSyncError } from "./errors";
import { LiveSheetSyncService } from "./service";
import { createLiveSheetSyncScheduler } from "./scheduler";
import type { SheetSyncRunResult } from "./worker";

const SESSION_ID = "0192d0f4-9f72-7a36-91f5-6a76ef736f42";

test("ADMIN retry consumes a bounded rate slot before one owned atomic retry, then schedules post-commit work", async () => {
  const calls: string[] = [];
  let scheduled: (() => Promise<void>) | undefined;
  const service = new LiveSheetSyncService({
    store: {
      async retryOwned(hostId, sessionId) {
        assert.equal(hostId, "admin@example.com");
        assert.equal(sessionId, SESSION_ID);
        calls.push("retry");
        return { projectionVersion: 8, state: "pending" };
      },
    },
    rateLimitStore: {
      async consumeRateLimit(input) {
        assert.equal(input.scope, "sheet-sync-retry-host-session");
        assert.match(input.keyHash, /^[0-9a-f]{64}$/u);
        assert.deepEqual({ limit: input.limit, windowSeconds: input.windowSeconds }, { limit: 5, windowSeconds: 3600 });
        calls.push("rate");
        return true;
      },
    },
    scheduleAfterCommit(callback) { calls.push("schedule"); scheduled = callback; },
    runWorker: async () => { calls.push("worker"); return { status: "idle" }; },
  });
  assert.deepEqual(await service.retryOwned("admin@example.com", SESSION_ID), { projectionVersion: 8, state: "pending" });
  assert.deepEqual(calls, ["rate", "retry", "schedule"]);
  await scheduled?.();
  assert.deepEqual(calls, ["rate", "retry", "schedule", "worker"]);
});

test("rate rejection performs neither retry RPC nor worker scheduling", async () => {
  let retryCalls = 0;
  let schedules = 0;
  const service = new LiveSheetSyncService({
    store: { async retryOwned() { retryCalls += 1; return { projectionVersion: 1, state: "pending" }; } },
    rateLimitStore: { async consumeRateLimit() { return false; } },
    scheduleAfterCommit() { schedules += 1; },
    runWorker: async () => undefined,
  });
  await assert.rejects(service.retryOwned("admin@example.com", SESSION_ID), (error: unknown) =>
    error instanceof LiveSheetSyncError && error.code === "SHEET_SYNC_RATE_LIMITED");
  assert.equal(retryCalls, 0);
  assert.equal(schedules, 0);
});

test("post-commit scheduler never reverses the canonical mutation and observes only safe outcome fields", async () => {
  const observations: unknown[] = [];
  let callback: (() => Promise<void>) | undefined;
  const scheduler = createLiveSheetSyncScheduler({
    worker: { async runNext() { throw new Error("private@example.com access-token"); } },
    scheduleAfterCommit(value) { callback = value; },
    observe(value) { observations.push(value); },
  });
  assert.doesNotThrow(() => scheduler.trigger());
  await callback?.();
  assert.deepEqual(observations, [{ workload: "sheet_sync", resultCode: "SHEETS_WORKER_FAILED" }]);
  assert.doesNotMatch(JSON.stringify(observations), /private@example\.com|access-token/u);
});

test("one bounded post-commit trigger drains distinct queued jobs until the durable queue is empty", async () => {
  const results: SheetSyncRunResult[] = [
    { status: "completed", jobId: "job-1" },
    { status: "failed", jobId: "job-2", code: "SHEETS_UNAVAILABLE" },
    { status: "idle" },
  ];
  let callback: (() => Promise<void>) | undefined;
  let calls = 0;
  const scheduler = createLiveSheetSyncScheduler({
    worker: { async runNext() { calls += 1; return results.shift() ?? { status: "idle" }; } },
    scheduleAfterCommit(value) { callback = value; },
  });
  scheduler.trigger();
  await callback?.();
  assert.equal(calls, 3);
});

test("a bounded trigger schedules continuation slices until more than ten durable jobs are empty", async () => {
  const callbacks: Array<() => Promise<void>> = [];
  let remaining = 11;
  let calls = 0;
  const scheduler = createLiveSheetSyncScheduler({
    worker: {
      async runNext() {
        calls += 1;
        if (remaining === 0) return { status: "idle" };
        remaining -= 1;
        return { status: "completed", jobId: `job-${remaining}` };
      },
    },
    scheduleAfterCommit(callback) { callbacks.push(callback); },
  });

  scheduler.trigger();
  while (callbacks.length > 0) await callbacks.shift()?.();

  assert.equal(calls, 12);
  assert.equal(remaining, 0);
});

test("concurrent triggers coalesce behind one continuation chain without losing newly queued work", async () => {
  const callbacks: Array<() => Promise<void>> = [];
  let remaining = 11;
  let calls = 0;
  const scheduler = createLiveSheetSyncScheduler({
    worker: {
      async runNext() {
        calls += 1;
        if (remaining === 0) return { status: "idle" };
        remaining -= 1;
        return { status: "completed", jobId: `job-${remaining}` };
      },
    },
    scheduleAfterCommit(callback) { callbacks.push(callback); },
  });

  scheduler.trigger();
  scheduler.trigger();
  assert.equal(callbacks.length, 1);
  while (callbacks.length > 0) await callbacks.shift()?.();

  assert.equal(calls, 12);
  assert.equal(remaining, 0);
});
