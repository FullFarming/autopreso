import assert from "node:assert/strict";
import test from "node:test";
import { MediaDemandCoordinator } from "../src/media-demand-coordinator.js";

const connectionId = "11111111-1111-4111-8111-111111111111";
function fixture(overrides = {}) {
  let now = 1_000;
  let runtime = { sessionId: "session", state: "waking", epoch: 1, hostSourceReady: true,
    connectedCount: 0, pendingCount: 1, wakeDeadline: new Date(46_000).toISOString(), idleAfter: null, ...overrides };
  const actions = [];
  const idle = [];
  const store = {
    async read() { return runtime; },
    async transition(sessionId, epoch, ownerId, action) {
      actions.push(action);
      assert.equal(epoch, runtime.epoch);
      if (action === "connect") runtime = { ...runtime, connectedCount: 1, idleAfter: null };
      if (action === "disconnect") runtime = { ...runtime, connectedCount: 0, idleAfter: new Date(now + 30_000).toISOString() };
      if (action === "ready") runtime = { ...runtime, state: "active" };
      return runtime;
    },
  };
  const coordinator = new MediaDemandCoordinator({ store, now: () => now, pollMilliseconds: 100_000,
    startTimeoutMilliseconds: 1, onIdle: async (...args) => { idle.push(args); } });
  return { coordinator, actions, idle, setNow(value) { now = value; },
    update(value) { runtime = { ...runtime, ...value }; } };
}

test("a ticket alone cannot pass provider readiness", async (context) => {
  const f = fixture(); context.after(() => f.coordinator.close());
  await assert.rejects(f.coordinator.ready("session", 1), /MEDIA_DEMAND_LOST/);
  assert.equal(f.actions.includes("ready"), false);
});
test("first authenticated viewer allows start and last departure drains after grace", async (context) => {
  const f = fixture(); context.after(() => f.coordinator.close());
  const connection = await f.coordinator.connect({ sessionId: "session", grantId: "grant", userId: "user" }, { connectionId, epoch: 1 });
  assert.equal(await f.coordinator.prepare("session"), 1);
  await f.coordinator.ready("session", 1);
  await f.coordinator.disconnect("session", connection);
  f.setNow(30_999); await f.coordinator.tick(); assert.equal(f.idle.length, 0);
  f.setNow(31_000); await f.coordinator.tick(); assert.equal(f.idle.length, 1);
  assert.equal(f.idle[0][2], "no_audience");
  assert.equal(f.actions.at(-1), "sleep");
});
test("refresh reconnect cancels idle and stale epoch disconnect cannot remove a new connection", async (context) => {
  const f = fixture(); context.after(() => f.coordinator.close());
  const claims = { sessionId: "session", grantId: "grant", userId: "user" };
  const old = await f.coordinator.connect(claims, { connectionId, epoch: 1 });
  await f.coordinator.disconnect("session", old);
  f.update({ epoch: 2 });
  await f.coordinator.connect(claims, { connectionId, epoch: 2 });
  await f.coordinator.disconnect("session", old);
  f.setNow(40_000); await f.coordinator.tick();
  assert.equal(f.idle.length, 0);
});
test("host source loss closes a room even while its viewer remains connected", async (context) => {
  const f = fixture(); context.after(() => f.coordinator.close());
  await f.coordinator.connect({ sessionId: "session", grantId: "grant", userId: "user" }, { connectionId, epoch: 1 });
  f.update({ hostSourceReady: false }); await f.coordinator.tick();
  assert.equal(f.idle[0][2], "source_unavailable");
});
test("waking deadline closes connected waiters instead of leaving billable sockets", async (context) => {
  const f = fixture(); context.after(() => f.coordinator.close());
  await f.coordinator.connect({ sessionId: "session", grantId: "grant", userId: "user" }, { connectionId, epoch: 1 });
  f.setNow(46_001); await f.coordinator.tick();
  assert.equal(f.idle[0][2], "MEDIA_START_TIMEOUT");
  assert.equal(f.actions.at(-1), "fail");
});

test("a viewer reconnect racing the drain transaction cancels idle instead of failing the active room", async (context) => {
  const f = fixture({ state: "active", idleAfter: new Date(1_000).toISOString() });
  context.after(() => f.coordinator.close());
  const originalTransition = f.coordinator.store.transition;
  await f.coordinator.connect({ sessionId: "session", grantId: "grant", userId: "user" }, { connectionId, epoch: 1 });
  f.update({ connectedCount: 0, idleAfter: new Date(1_000).toISOString() });
  f.coordinator.store.transition = async (...args) => {
    if (args[3] === "drain") {
      f.update({ connectedCount: 1, idleAfter: null });
      throw new Error("MEDIA_DRAIN_NOT_DUE");
    }
    return originalTransition(...args);
  };
  await f.coordinator.tick();
  assert.equal(f.idle.length, 0);
  assert.equal(f.actions.includes("fail"), false);
  assert.equal(f.coordinator.sessions.get("session").closing, false);
});
