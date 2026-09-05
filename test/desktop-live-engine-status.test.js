import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

import { MESSAGES } from "../public/subtitle-i18n.js";
import { JA } from "../public/subtitle-i18n-ja.js";

const mainSource = fs.readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
const controllerSource = fs.readFileSync(new URL("../public/subtitle-controller.js", import.meta.url), "utf8");
const controllerHtml = fs.readFileSync(new URL("../public/subtitle-controller.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/subtitle.css", import.meta.url), "utf8");

function sourceBetween(start, end) {
  const startIndex = mainSource.indexOf(start);
  const endIndex = mainSource.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source start: ${start}`);
  assert.notEqual(endIndex, -1, `missing source end: ${end}`);
  return mainSource.slice(startIndex, endIndex);
}

test("main keeps a bounded engine-status projection per role and exposes it through live-call:get-state", () => {
  const handler = sourceBetween('} else if (message.type === "engine-status") {', '} else if (message.type === "language-status") {');
  assert.match(handler, /message\.sessionId !== armedSession\.sessionId\) return;/u);
  assert.match(handler, /bridge\.engineStatuses\.set\(projected\.role, projected\)/u);
  assert.match(mainSource, /engineStatuses: new Map\(\),/u);
  assert.match(sourceBetween("function liveBridgeStatus()", "function shouldBlockLiveHostAudioForFloor"), /engine: projectLiveEngineStatuses\(liveGatewayBridge\?\.engineStatuses\)/u);

  const context = vm.createContext({});
  vm.runInContext(`${sourceBetween("const LIVE_ENGINE_STATUS_ROLES", "function liveBridgeStatus()")}; this.projectLiveEngineStatus = projectLiveEngineStatus; this.projectLiveEngineStatuses = projectLiveEngineStatuses;`, context);
  const ready = { type: "engine-status", sessionId: "s", role: "stt", provider: "gemini", model: "gemini-3.5-transcribe-live", status: "ready" };
  // vm objects live in another realm; compare structurally.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(context.projectLiveEngineStatus(ready)), { role: "stt", provider: "gemini", model: "gemini-3.5-transcribe-live", status: "ready" });
  for (const bad of [null, { ...ready, role: "summary" }, { ...ready, status: "exploded" }, { ...ready, model: "<b>x</b>" }, { ...ready, provider: "" }]) {
    assert.equal(context.projectLiveEngineStatus(bad), null);
  }
  // A code rides only on `failed`, and only as a machine token — provider prose never reaches the renderer.
  assert.deepEqual(context.projectLiveEngineStatus({ ...ready, code: "IGNORED_ON_READY" }).code, undefined);
  assert.deepEqual(context.projectLiveEngineStatus({ ...ready, status: "failed", code: "quota exceeded: key sk-..." }).code, undefined);
  const failed = { ...ready, role: "translation", model: "gemini-3.7-flash", status: "failed", code: "STT_PROVIDER_UNAVAILABLE" };
  assert.equal(context.projectLiveEngineStatuses(undefined), null);
  assert.equal(context.projectLiveEngineStatuses(new Map()), null);
  assert.deepEqual(context.projectLiveEngineStatuses(new Map([["stt", ready], ["translation", { ...ready, role: "translation", status: "connecting" }]])).state, "connecting");
  assert.deepEqual(context.projectLiveEngineStatuses(new Map([["stt", ready], ["translation", { ...ready, role: "translation" }]])).state, "ready");
  const projected = plain(context.projectLiveEngineStatuses(new Map([["stt", ready], ["translation", failed]])));
  assert.equal(projected.state, "failed");
  assert.equal(projected.code, "STT_PROVIDER_UNAVAILABLE");
  assert.deepEqual(projected.roles.map((row) => row.model), ["gemini-3.5-transcribe-live", "gemini-3.7-flash"]);
});

test("controller renders the engine pill read-only from the polled bridge state, as text, in every catalog", () => {
  assert.match(controllerHtml, /id="controller-engine" class="mp-engine" role="status"[^>]*hidden>/u);
  assert.match(controllerSource, /const enginePill = document\.getElementById\("controller-engine"\)/u);
  assert.match(controllerSource, /renderEnginePill\(state\.bridge\?\.engine \?\? null\)/u);
  assert.match(controllerSource, /renderEnginePill\(null\)/u, "the pill clears when the call is disarmed");
  const render = controllerSource.slice(controllerSource.indexOf("function renderEnginePill("), controllerSource.indexOf("\n}\n", controllerSource.indexOf("function renderEnginePill(")));
  assert.match(render, /enginePill\.textContent =/u);
  assert.doesNotMatch(render, /innerHTML/u);
  assert.match(render, /\["connecting", "ready", "failed"\]\.includes\(engine\?\.state\)/u);
  // No engine picker or switch call anywhere on the desktop controller.
  assert.doesNotMatch(controllerSource, /internal\/sessions|engine-defaults/u);
  assert.match(css, /\.mp-engine\[data-state="failed"\]/u);
  for (const key of ["controller.engine", "controller.engineConnecting", "controller.engineReady", "controller.engineFailed"]) {
    assert.ok(MESSAGES.en[key], `${key} en`);
    assert.ok(MESSAGES.ko[key], `${key} ko`);
    assert.ok(JA[key], `${key} ja`);
  }
});
