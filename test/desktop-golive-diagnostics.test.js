import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const main = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");

function diagnosticSource() {
  const start = main.indexOf("const DESKTOP_GO_LIVE_FAILURE_STAGES");
  assert.notEqual(start, -1, "Go Live must expose only bounded stage/code diagnostics");
  return main.slice(start, main.indexOf("async function requestDesktopLiveStartIntent", start));
}

test("Go Live diagnostics log only fixed stages and known codes, never returned payload or unknown code content", () => {
  const logs = [];
  const report = vm.runInNewContext(`${diagnosticSource()}; reportDesktopGoLiveFailure`, {
    console: { warn: (message) => logs.push(message) },
  });
  const result = { ok: false, code: "LIVE_CAPTION_PREFLIGHT_TIMEOUT", error: "private response", sessionId: "private-session", token: ["private", "token"].join("-") };
  assert.equal(report("renderer_preflight", result), result);
  assert.equal(logs[0], "[live-go-live] failed stage=renderer_preflight code=LIVE_CAPTION_PREFLIGHT_TIMEOUT");
  report("private-stage", { ...result, code: "PRIVATE_BEARER_VALUE" });
  assert.equal(logs[1], "[live-go-live] failed stage=unknown code=LIVE_CALL_GO_LIVE_FAILED");
  assert.doesNotMatch(logs.join("\n"), /private|PRIVATE_BEARER/u);
});

test("each Go Live failure reports its stage once and releases the manual action without an automatic retry", async () => {
  for (const stage of ["start_intent", "renderer_preflight", "caption_settings", "session_refresh", "gateway_start", "readiness"]) {
    const logs = [], calls = [];
    const fail = { ok: false, code: "NETWORK_UNAVAILABLE" };
    const session = { sessionId: "fixture-call", baseUrl: "https://fixture.invalid", status: "preparing", version: 3 };
    const scope = vm.createContext({
      console: { warn: (message) => logs.push(message) },
      ipcMain: { handle(_channel, handler) { scope.goLive = handler; } },
      isHostLogoutPending: false, isHostLoginPending: false, isLiveCallEnding: false, isLiveCallGoingLive: false,
      isAllowedOrigin: () => true, localAppOrigin: "http://127.0.0.1:3210", liveCallSession: session,
      settingsStore: {}, liveGatewayBridge: { ready: false }, randomUUID: () => "11111111-1111-4111-8111-111111111111",
      requestDesktopLiveStartIntent: async () => { calls.push("start_intent"); return stage === "start_intent" ? fail : { ok: true }; },
      requestRendererLiveCaptionPreflight: async () => { calls.push("renderer_preflight"); return { ...(stage === "renderer_preflight" ? fail : { ok: true }), requestId: "fixture-preflight" }; },
      preflightLiveCallCaptionSession: async () => { calls.push("caption_settings"); return stage === "caption_settings" ? fail : { ok: true }; },
      liveCallApi: async () => { calls.push("session_refresh"); return stage === "session_refresh" ? fail : { ok: true, data: { version: 3 } }; },
      startPreparedLiveGatewayWithRetry: async () => { calls.push("gateway_start"); return stage === "gateway_start" ? fail : { ok: true }; },
      cancelRendererLiveCaptionPreflight() {},
    });
    const start = main.indexOf('  ipcMain.handle("live-call:go-live"');
    const end = main.indexOf("  // The desktop has no browser host-dashboard", start);
    vm.runInContext(`${diagnosticSource()}\n${main.slice(start, end)}`, scope);
    const result = await scope.goLive({ sender: { getURL: () => "http://127.0.0.1:3210" } });
    assert.equal(result.ok, false);
    assert.equal(scope.isLiveCallGoingLive, false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0], `[live-go-live] failed stage=${stage} code=${stage === "readiness" ? "LIVE_READINESS_NOT_CONFIRMED" : "NETWORK_UNAVAILABLE"}`);
    assert.equal(new Set(calls).size, calls.length, "no failed stage may run again automatically");
  }
});
