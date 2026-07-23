import assert from "node:assert/strict";
import test from "node:test";

import { OrderedTaskQueue } from "../src/ordered-task-queue.js";

test("ordered queue emits in submission order even when work resolves out of order", async () => {
  const resolvers = [];
  const queue = new OrderedTaskQueue();
  const first = queue.enqueue(() => new Promise((resolve) => resolvers.push(() => resolve("first"))));
  const second = queue.enqueue(() => Promise.resolve("second"));
  await new Promise((resolve) => setImmediate(resolve));
  resolvers[0]();
  assert.equal(await first, "first");
  assert.equal(await second, "second");
});

test("ordered queue does not drop work that waits behind a long provider call", async () => {
  const queue = new OrderedTaskQueue();
  let release;
  const first = queue.enqueue(async () => {
    return new Promise((resolve) => { release = resolve; });
  });
  const late = queue.enqueue(() => Promise.resolve("late"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.pending, 2);
  release("ok");
  assert.equal(await first, "ok");
  assert.equal(await late, "late");
});

test("ordered queue applies bounded backpressure and admits waiting work without dropping it", async () => {
  const states = [];
  const queue = new OrderedTaskQueue({ maxPending: 2, onBackpressureChange: (value) => states.push(value) });
  let release;
  const first = queue.enqueue(() => new Promise((resolve) => { release = resolve; }));
  const second = queue.enqueue(() => Promise.resolve("second"));
  const overflow = queue.enqueue(() => Promise.resolve("overflow"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.isBackpressured, true);
  release("first");
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.equal(await overflow, "overflow");
  assert.deepEqual(states, [true, false]);
});

test("ordered queue fails visibly when both bounded work and admission queues are full", async () => {
  const queue = new OrderedTaskQueue({ maxPending: 1, maxWaiting: 1 });
  let release;
  const first = queue.enqueue(() => new Promise((resolve) => { release = resolve; }));
  const waiting = queue.enqueue(() => Promise.resolve("waiting"));
  await assert.rejects(queue.enqueue(() => Promise.resolve("overflow")), /QUEUE_BACKPRESSURE_EXCEEDED/u);
  await new Promise((resolve) => setImmediate(resolve));
  release("first");
  assert.equal(await first, "first");
  assert.equal(await waiting, "waiting");
});

test("ordered queue times out a hung task and continues with the next final item", async () => {
  const queue = new OrderedTaskQueue({ taskTimeoutMs: 15 });
  const hung = queue.enqueue(() => new Promise(() => {}));
  const next = queue.enqueue(() => Promise.resolve("next"));
  await assert.rejects(hung, /QUEUE_TASK_TIMEOUT/u);
  assert.equal(await next, "next");
  await queue.drain();
});

test("ordered queue admission cannot wait forever behind a full hung queue", async () => {
  const queue = new OrderedTaskQueue({ maxPending: 1, maxWaiting: 1, taskTimeoutMs: 100, admissionTimeoutMs: 15 });
  const first = queue.enqueue(() => new Promise(() => {}));
  await assert.rejects(queue.enqueue(() => Promise.resolve("late")), /QUEUE_ADMISSION_TIMEOUT/u);
  await assert.rejects(first, /QUEUE_TASK_TIMEOUT/u);
  await queue.drain();
});

test("drain yields to admission timers instead of spinning on an already-settled tail", async () => {
  const queue = new OrderedTaskQueue({ maxPending: 1, maxWaiting: 1, taskTimeoutMs: 25, admissionTimeoutMs: 10 });
  void queue.enqueue(() => new Promise(() => {})).catch(() => undefined);
  void queue.enqueue(() => Promise.resolve()).catch(() => undefined);
  await Promise.race([
    queue.drain(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("DRAIN_STARVED_TIMERS")), 100)),
  ]);
});

test("timed-out work receives an abort signal that blocks late side effects", async () => {
  const queue = new OrderedTaskQueue({ taskTimeoutMs: 10 });
  let release;
  const published = [];
  const completion = queue.enqueue(async (signal) => {
    await new Promise((resolve) => { release = resolve; });
    if (!signal.aborted) published.push("late");
  });
  await assert.rejects(completion, /QUEUE_TASK_TIMEOUT/u);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published, []);
});
