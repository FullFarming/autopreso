import assert from "node:assert/strict";
import test from "node:test";

import { ViewerAuthorizationBatcher } from "../src/viewer-authorization-batcher.js";

function request(index, overrides = {}) {
  return {
    sessionId: "session-1",
    grantId: `grant-${index}`,
    userId: `user-${index}`,
    language: "ko",
    ...overrides,
  };
}

function createManualTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cancelled = true; },
    flushNext() {
      const timer = timers.find((candidate) => !candidate.cancelled);
      assert.ok(timer, "a micro-batch timer must be pending");
      timer.cancelled = true;
      timer.callback();
    },
  };
}

test("50 due grants share one bounded micro-batch and duplicate requests share one result", async () => {
  const calls = [];
  const timers = createManualTimers();
  const batcher = new ViewerAuthorizationBatcher({
    ...timers,
    maxBatchSize: 50,
    async authorizeBatch(requests) {
      calls.push(requests);
      return new Map(requests.map((entry) => [entry.key, true]));
    },
  });
  const checks = Array.from({ length: 50 }, (_, index) => batcher.authorize(request(index)));
  const duplicate = batcher.authorize(request(0));

  assert.equal(calls.length, 0);
  assert.equal((await Promise.all(checks)).every(Boolean), true);
  assert.equal(await duplicate, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 50);
});

test("missing, malformed, or cross-fenced batch results fail closed without per-grant retry", async () => {
  let calls = 0;
  const timers = createManualTimers();
  const batcher = new ViewerAuthorizationBatcher({
    ...timers,
    async authorizeBatch(requests) {
      calls += 1;
      return new Map([
        [requests[0].key, true],
        [requests[1].key, "true"],
        ["session-2\u0000grant-3\u0000user-3\u0000ko", true],
      ]);
    },
  });
  const checks = [batcher.authorize(request(1)), batcher.authorize(request(2)), batcher.authorize(request(3))];

  timers.flushNext();
  assert.deepEqual(await Promise.all(checks), [true, false, false]);
  assert.equal(calls, 1, "a malformed batch must never fall back to one RPC per grant");
});

test("shutdown aborts queued checks and clears pending micro-batch work", async () => {
  let calls = 0;
  const timers = createManualTimers();
  const batcher = new ViewerAuthorizationBatcher({
    ...timers,
    async authorizeBatch() { calls += 1; return new Map(); },
  });
  const pending = batcher.authorize(request(1));

  batcher.close();

  await assert.rejects(pending, /VIEWER_AUTHORIZATION_BATCHER_CLOSED/u);
  assert.equal(calls, 0);
  assert.equal(timers.timers.every((timer) => timer.cancelled), true);
});

test("session teardown fails closed for an active batch and a late true cannot revive it", async () => {
  let resolveBatch;
  const timers = createManualTimers();
  const batcher = new ViewerAuthorizationBatcher({
    ...timers,
    authorizeBatch(requests) {
      return new Promise((resolve) => {
        resolveBatch = () => resolve(new Map(requests.map(({ key }) => [key, true])));
      });
    },
  });
  const pending = batcher.authorize(request(1));
  timers.flushNext();
  await new Promise((resolve) => setImmediate(resolve));

  batcher.deleteSession("session-1");
  assert.equal(await pending, false);
  resolveBatch();
  await new Promise((resolve) => setImmediate(resolve));

  const next = batcher.authorize(request(1));
  timers.flushNext();
  batcher.deleteSession("session-1");
  assert.equal(await next, false);
});

test("50 grants over 60 seconds stay within 60 batch RPCs and a five-second revalidation cadence", async () => {
  let clock = 0;
  let nextOrder = 0;
  let activeBatches = 0;
  let maximumActiveBatches = 0;
  let batchCalls = 0;
  const timers = [];
  const checks = [];
  const authorizationTimes = new Map();
  const setTimeoutFn = (callback, delay) => {
    const timer = { callback, dueAt: clock + delay, order: nextOrder, cancelled: false };
    nextOrder += 1;
    timers.push(timer);
    return timer;
  };
  const batcher = new ViewerAuthorizationBatcher({
    setTimeoutFn,
    clearTimeoutFn(timer) { timer.cancelled = true; },
    batchWindowMilliseconds: 100,
    maxBatchSize: 50,
    async authorizeBatch(requests) {
      batchCalls += 1;
      activeBatches += 1;
      maximumActiveBatches = Math.max(maximumActiveBatches, activeBatches);
      for (const entry of requests) {
        const times = authorizationTimes.get(entry.grantId) ?? [];
        authorizationTimes.set(entry.grantId, [...times, clock]);
      }
      await Promise.resolve();
      activeBatches -= 1;
      return new Map(requests.map(({ key }) => [key, true]));
    },
  });
  for (let cycle = 0; cycle < 12; cycle += 1) {
    for (let index = 0; index < 50; index += 1) {
      setTimeoutFn(() => { checks.push(batcher.authorize(request(index))); }, cycle * 5_000 + (index % 5) * 100);
    }
  }
  while (true) {
    const timer = timers
      .filter((candidate) => !candidate.cancelled && candidate.dueAt <= 60_000)
      .sort((left, right) => left.dueAt - right.dueAt || left.order - right.order)[0];
    if (!timer) break;
    timer.cancelled = true;
    clock = timer.dueAt;
    timer.callback();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal((await Promise.all(checks)).every(Boolean), true);
  assert.ok(batchCalls <= 60, `expected <=60 batch RPCs, received ${batchCalls}`);
  assert.equal(maximumActiveBatches, 1);
  assert.equal(authorizationTimes.size, 50);
  for (const times of authorizationTimes.values()) {
    assert.equal(times.length, 12);
    for (let index = 1; index < times.length; index += 1) assert.ok(times[index] - times[index - 1] <= 5_000);
  }
});
