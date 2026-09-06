import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const main = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");

function between(start, end) {
  const offset = main.indexOf(start);
  assert.ok(offset >= 0, `missing ${start}`);
  return main.slice(offset, main.indexOf(end, offset));
}

test("desktop shutdown only detaches prepared and live sessions without a remote DELETE", async () => {
  const shutdown = between("async function detachLiveCallForShutdown()", "async function prepareDesktopShutdown()");
  for (const status of ["preparing", "live", "paused"]) {
    const requests = [];
    const bridgeCalls = [];
    const session = { sessionId: "session-1", status, scheduledAt: "2026-09-01T09:00:00Z" };
    const context = vm.createContext({
      liveCallSession: session,
      stopLiveGatewayBridge: async (...args) => { bridgeCalls.push(args); },
      liveCallApi: async (...args) => { requests.push(args); },
      console: { info() {}, warn() {} },
    });
    await vm.runInContext(`${shutdown}\ndetachLiveCallForShutdown()`, context);
    assert.equal(context.liveCallSession, null);
    assert.equal(requests.length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(bridgeCalls)), [["app quitting", { detachRemote: true }]]);
    assert.equal(session.status, status);
    assert.equal(session.scheduledAt, "2026-09-01T09:00:00Z");
  }
});

test("desktop detach closes its bridge without sending stop and explicit end retains stop", async () => {
  const stop = between("async function stopLiveGatewayBridge(", "function adaptCaptionPcmForGateway");
  const sent = [];
  const closed = [];
  const socket = { readyState: 1, send(value) { sent.push(JSON.parse(value)); }, close(...args) { closed.push(args); } };
  const context = vm.createContext({
    liveGatewayBridge: { socket, captionRelay: { close() {} } },
    liveDemandController: null,
    clearLiveBridgeReconnect() {}, clearLiveBridgeCredentialRefresh() {},
    liveBridgeReconnectAttempts: 5, applyAuthoritativeLiveCallFloorSnapshot() {},
    liveBridgeAudioAdapters: new Map(), WebSocket: { OPEN: 1 }, console: { info() {} },
  });
  await vm.runInContext(`${stop}\nstopLiveGatewayBridge("app quitting", { detachRemote: true })`, context);
  assert.deepEqual(sent, [{ type: "detach" }]);
  assert.equal(closed.length, 1);
  assert.equal(context.liveGatewayBridge, null);
  assert.equal(context.liveBridgeReconnectAttempts, 0);
  const end = between('ipcMain.handle("live-call:end"', 'ipcMain.handle("subtitle-overlay:list-displays"');
  assert.match(end, /method: "DELETE"/u);
  assert.match(end, /stopLiveGatewayBridge\("live call ended", \{ terminateRemote: true \}\)/u);
});
