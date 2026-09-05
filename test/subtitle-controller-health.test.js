import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

function harness(inputMode = "system_mic") {
  const source = readFileSync(new URL("../public/subtitle-controller.js", import.meta.url), "utf8");
  const declarations = source.slice(source.indexOf("const TRANSLATION_EVENT_STALE_MS"), source.indexOf("initLanguage();"));
  const functions = source.slice(source.indexOf("function resetTranslationHealthEvents") >= 0
    ? source.indexOf("function resetTranslationHealthEvents") : source.indexOf("function noteTranslationHealthEvent"), source.indexOf("function isSupportedLanguage"));
  let now = 10_000;
  const context = {
    settings: { inputMode, micDeviceId: "mic-a" },
    Date: { now: () => now }, t: key => key, liveCallStatus: { dataset: {} },
    healthLabel: { dataset: {}, textContent: "" }, healthDetail: { textContent: "", hidden: false },
    setControllerStatus() {},
  };
  const api = vm.runInNewContext(`${declarations}\n${functions}\ntranslationHealth.socketState='open';
    syncLiveBridgeStatus({armed:true,live:true,bridge:{state:'connected'}});
    ({note:noteTranslationHealthEvent,sync:syncLiveBridgeStatus,health:translationHealth,
      render:renderTranslationHealth});`, context);
  return {
    context, api,
    at(time) { now = time; },
    input(sourceName, status) { api.note({ type: "subtitle:input-status", source: sourceName, status }); },
    caption() { api.note({ type: "subtitle:committed" }); },
    display() { api.render(now); return context.liveCallStatus.dataset.connectionState; },
  };
}

test("silent system input cannot erase continuous microphone signal or hide a translation stall", () => {
  const h = harness();
  for (let time = 10_000; time <= 48_000; time += 1_000) {
    h.at(time); h.input("mic", "signal"); h.input("system", "silent");
  }
  assert.equal(h.display(), "recovering");
  assert.equal(h.api.health.signalSinceAt, 10_000);
  h.caption();
  assert.equal(h.display(), "healthy", "recent real captions still prove output while either configured source has signal");
});

test("input aggregation excludes disabled sources and expires each source independently", () => {
  const h = harness("mic");
  h.input("mic", "silent"); h.input("system", "signal"); h.caption();
  assert.equal(h.display(), "waiting", "a disabled system source cannot mark the microphone healthy");
  h.context.settings.inputMode = "system_mic";
  h.at(20_000); h.input("mic", "signal"); h.input("system", "silent");
  h.at(25_001); h.input("system", "silent");
  assert.equal(h.display(), "waiting", "fresh system silence cannot keep an expired microphone signal active");
  assert.equal(h.api.health.signalSinceAt, null);
});

test("device changes, input mode changes, stop and a new live call clear previous signal evidence", () => {
  const h = harness(); h.input("mic", "signal"); h.caption();
  assert.equal(h.display(), "healthy");
  h.context.settings.micDeviceId = "mic-b";
  assert.equal(h.display(), "waiting");
  assert.equal(h.api.health.lastCaptionAt, null);
  h.input("mic", "signal"); h.caption();
  h.context.settings.inputMode = "system";
  assert.equal(h.display(), "waiting");
  h.input("mic", "signal");
  assert.equal(h.api.health.signalSinceAt, null);
  h.input("system", "signal"); h.caption();
  h.api.note({ type: "subtitle:stopped" });
  assert.equal(h.api.health.lastCaptionAt, null);
  assert.equal(h.api.health.signalSinceAt, null);
  h.input("system", "signal"); h.caption();
  h.api.sync({ armed: false, live: false, bridge: { state: "idle" } });
  h.api.sync({ armed: true, live: true, bridge: { state: "connected" } });
  assert.equal(h.display(), "waiting");
});

test("real bridge and local socket failures retain priority over healthy input evidence", () => {
  const h = harness(); h.input("mic", "signal"); h.caption();
  h.api.health.mediaWaiting = true;
  h.api.health.bridgeState = "failed";
  assert.equal(h.display(), "disconnected");
  h.api.health.bridgeState = "connected"; h.api.health.socketState = "closed";
  assert.equal(h.display(), "disconnected");
});
