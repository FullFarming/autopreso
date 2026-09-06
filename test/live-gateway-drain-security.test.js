import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const main = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
const drainCode = main.slice(main.indexOf("async function drainLiveGatewayBridge("), main.indexOf("async function stopLiveGatewayBridge("));
const endCode = main.slice(main.indexOf('ipcMain.handle("live-call:end"'), main.indexOf('ipcMain.handle("subtitle-overlay:list-displays"'));
/**
 * @typedef {{ok: boolean, data?: Record<string, unknown>, code?: string}} Response
 * @param {{bridge?: boolean, demandEnabled?: boolean, read?: (path: string, options: {method: string}) => Promise<Response>, drainResult?: Response}} options
 */
function harness({ bridge = false, demandEnabled = false, read, drainResult = { ok: true } } = {}) {
  const session = { sessionId: "synthetic-meeting", baseUrl: "https://example.test", status: "live", version: 3, demandEnabled };
  const calls = [], reconnects = [];
  const context = vm.createContext({
    liveCallSession: session, liveGatewayBridge: bridge ? { session, ready: true, socket: {} } : null,
    liveBridgeAudioAdapters: new Map([["mic", {}]]), isLiveCallEnding: false,
    liveCallApi: async (_base, path, options) => {
      calls.push({ path, method: options.method });
      return read ? read(path, options) : { ok: true, data: { id: session.sessionId, status: "live" } };
    },
    requestLiveGatewayDrain: async () => drainResult,
    isAllowedOrigin: () => true, localAppOrigin: "http://localhost:3210",
    clearLiveBridgeReconnect() {}, clearLiveBridgeCredentialRefresh() {},
    scheduleLiveGatewayReconnect: value => reconnects.push(value),
    reconcileLiveCallEnd: async () => ({ terminal: true, status: "stopped" }),
    applyAuthoritativeLiveCallFloorSnapshot() {}, relayLiveCallFloorToRenderers() {},
    stopLiveGatewayBridge: async () => {}, clearLiveBridgeAlert() {},
    stageWindow: null, restoreDashboardAfterLiveCall() {}, archiveLiveCallSession: async () => {},
    ipcMain: { handle(_name, callback) { context.end = callback; } }, console,
  });
  vm.runInContext(`${drainCode}\n${endCode}\nglobalThis.drain = drainLiveGatewayBridge;`, context);
  return { session, context, calls, reconnects, end: () => context.end({ sender: { getURL: () => "http://localhost:3210/subtitle.html" } }) };
}

test("missing bridge during a live meeting cannot certify an empty provider buffer", async () => {
  const h = harness();
  const result = await h.end();
  assert.equal(result.ok, false); assert.equal(result.code, "MEDIA_DRAIN_CONNECTION_REQUIRED");
  assert.deepEqual(h.calls.map(call => call.method), ["GET"]);
  assert.equal(h.reconnects.length, 0);
  assert.equal(h.session.requiresManualGatewayRestart, true);
});

test("a verified never-started or terminal meeting can finish without a media connection", async () => {
  for (const status of ["preparing", "stopped"]) {
    const h = harness({ read: async () => ({ ok: true, data: { id: "synthetic-meeting", status } }) });
    assert.equal((await h.end()).ok, true);
    assert.deepEqual(h.calls.map(call => call.method), ["GET", "DELETE"]);
  }
});

test("missing bridge requires an exact current session before trusting sleeping demand runtime", async () => {
  for (const current of [{ ok: false }, { ok: true, data: { id: "other-meeting", status: "live" } }]) {
    const h = harness({ demandEnabled: true, read: async path => path.endsWith("/runtime")
      ? { ok: true, data: { enabled: true, state: "sleeping" } } : current });
    assert.equal((await h.end()).ok, false);
    assert.equal(h.calls.some(call => call.method === "DELETE"), false);
    assert.equal(h.reconnects.length, 0);
  }
  const h = harness({ demandEnabled: true, read: async path => path.endsWith("/runtime")
    ? { ok: true, data: { enabled: true, state: "sleeping" } }
    : { ok: true, data: { id: "synthetic-meeting", status: "live" } } });
  assert.equal((await h.end()).ok, true);
});

test("drain timeout keeps terminal writes and automatic paid reconnect disabled", async () => {
  const h = harness({ bridge: true, drainResult: { ok: false, code: "MEDIA_DRAIN_TIMEOUT" } });
  assert.equal((await h.end()).code, "MEDIA_DRAIN_TIMEOUT");
  assert.equal(h.calls.length, 0); assert.equal(h.reconnects.length, 0);
  assert.equal(h.session.requiresManualGatewayRestart, true);
  assert.equal(h.context.liveGatewayBridge.ready, false);
  assert.equal(h.context.liveBridgeAudioAdapters.size, 0);
});

test("late read confirmation cannot certify a replaced meeting or new bridge", async () => {
  /** @type {(value: Response) => void} */
  let resolveRead = () => {};
  const h = harness({ read: () => new Promise(resolve => { resolveRead = resolve; }) });
  const ending = h.end();
  h.context.liveCallSession = { ...h.session };
  resolveRead({ ok: true, data: { id: "synthetic-meeting", status: "preparing" } });
  assert.equal((await ending).code, "LIVE_CALL_STATE_CHANGED");
  assert.equal(h.calls.some(call => call.method === "DELETE"), false);
  assert.equal(h.reconnects.length, 0);
});
