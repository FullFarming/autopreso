import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { MESSAGES } from "../public/subtitle-i18n.js";
import { resolveSelectedOverlayDisplay } from "../src/live-caption-ipc-relay.js";

const mainSource = fs.readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
const preloadSource = fs.readFileSync(new URL("../electron/preload.js", import.meta.url), "utf8");
// public/ is the only copy that exists: it is what src/server.js serves out of
// PUBLIC_DIR and what npm `files` and electron-builder `build.files` ship. The
// root-level subtitle-* duplicates were deleted -- they were referenced by
// nothing, and editing one silently had no effect on the shipped app.
const dashboardSource = fs.readFileSync(new URL("../public/subtitle-dashboard.js", import.meta.url), "utf8");

function sourceBetween(start, end) {
  const startIndex = mainSource.indexOf(start);
  const endIndex = mainSource.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source start: ${start}`);
  assert.notEqual(endIndex, -1, `missing source end: ${end}`);
  return mainSource.slice(startIndex, endIndex);
}

test("Live Call feature flag defaults on and turns off only on explicit false", () => {
  const isLiveCallEnabled = vm.runInNewContext(
    `${sourceBetween("function isLiveCallEnabled", "function resolveStageDisplayPlacement")}; isLiveCallEnabled`,
    {},
  );
  assert.equal(isLiveCallEnabled({}), true);
  assert.equal(isLiveCallEnabled({ REALTIME_NOEL_LIVE_CALL_ENABLED: undefined }), true);
  assert.equal(isLiveCallEnabled({ REALTIME_NOEL_LIVE_CALL_ENABLED: "" }), true);
  assert.equal(isLiveCallEnabled({ REALTIME_NOEL_LIVE_CALL_ENABLED: "true" }), true);
  assert.equal(isLiveCallEnabled({ REALTIME_NOEL_LIVE_CALL_ENABLED: "0" }), true);
  assert.equal(isLiveCallEnabled({ REALTIME_NOEL_LIVE_CALL_ENABLED: "false" }), false);
  assert.equal(isLiveCallEnabled({ REALTIME_NOEL_LIVE_CALL_ENABLED: " FALSE " }), false);
});

test("stage is opened only by the direct main-process route", () => {
  assert.doesNotMatch(mainSource, /STAGE_WINDOW_NAME|isStageWindowRequest|configureLiveWorkspaceNavigation/u);
  const openStage = sourceBetween("async function openLiveStageOverlay", "// Live Call feature flag");
  assert.match(openStage, /new BrowserWindow/u);
  assert.match(openStage, /\/stage\/\$\{encodeURIComponent\(sessionId\)\}/u);
  assert.match(openStage, /await window\.loadURL/u);
  assert.doesNotMatch(openStage, /window\.open|frameName/u);
});

test("stage placement follows the caption overlay's selected display", () => {
  const resolveStageDisplayPlacement = vm.runInNewContext(
    `${sourceBetween("function resolveStageDisplayPlacement", "function stageWindowPlacement")}; resolveStageDisplayPlacement`,
    { resolveSelectedOverlayDisplay },
  );
  const primary = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 } };
  const extended = { id: 2, bounds: { x: 1512, y: 0, width: 1920, height: 1080 } };
  // Placement objects are created inside the vm context, so compare plain
  // JSON snapshots rather than prototypes.
  const placement = (displays, primaryId, preferredId) =>
    JSON.parse(JSON.stringify(resolveStageDisplayPlacement(displays, primaryId, preferredId)));

  // The QR stage sits on the SAME monitor as the caption overlay: the
  // selected overlay display wins, fullscreen while another display remains
  // for the controller/dashboard.
  assert.deepEqual(placement([primary, extended], primary.id, String(extended.id)), { bounds: extended.bounds, fullscreen: true });
  assert.deepEqual(placement([primary, extended], primary.id, String(primary.id)), { bounds: primary.bounds, fullscreen: true });
  // Display order must not matter.
  assert.deepEqual(placement([extended, primary], primary.id, String(extended.id)), { bounds: extended.bounds, fullscreen: true });
  // No explicit selection: reserve the primary display for the controller and
  // put captions/stage on the first connected non-primary display.
  assert.deepEqual(placement([primary, extended], primary.id, ""), { bounds: extended.bounds, fullscreen: true });
  // Selected display unplugged: fall back to the primary display.
  assert.deepEqual(placement([primary], primary.id, String(extended.id)), { bounds: primary.bounds, fullscreen: false });
  // Single display: mirror-like large window instead of fullscreen takeover.
  assert.deepEqual(placement([primary], primary.id, ""), { bounds: primary.bounds, fullscreen: false });
  // Defensive: empty display list yields no placement.
  assert.equal(resolveStageDisplayPlacement([], primary.id, ""), null);
});

test("stage window repositions when the overlay display selection changes", () => {
  // The select-display IPC moves the caption overlay; the QR stage must move
  // with it ("자막 위치를 설정할때 같이 움직여야 해").
  const selectHandler = sourceBetween(
    'ipcMain.handle("subtitle-overlay:select-display"',
    'ipcMain.handle("subtitle-overlay:get-enabled"',
  );
  assert.match(selectHandler, /repositionStageWindow\(\)/u);
  // stageWindowPlacement resolves against the persisted overlay selection.
  const stagePlacementSource = sourceBetween("function stageWindowPlacement", "function applyStagePlacement");
  assert.match(stagePlacementSource, /preferredOverlayDisplayId/u);
});

test("direct stage window is positioned and keeps hardened renderer settings", () => {
  const openHandler = sourceBetween("async function openLiveStageOverlay", "// Live Call feature flag");
  assert.match(openHandler, /frame: false/u);
  assert.match(openHandler, /sandbox: true/u);
  assert.match(openHandler, /webSecurity: true/u);
  assert.match(openHandler, /allowRunningInsecureContent: false/u);
  assert.match(openHandler, /adoptStageWindow\(window, origin, stagePath\)/u);
  // Display hot-plug: stage window repositions when displays come and go.
  assert.match(mainSource, /screen\.on\("display-removed", repositionStageWindow\)/u);
  assert.match(mainSource, /screen\.on\("display-added", repositionStageWindow\)/u);
});

test("feature flag gates the live workspace IPC and is exposed to the dashboard", () => {
  assert.match(mainSource, /ipcMain\.handle\("live-workspace:get-enabled"/u);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\("live-workspace:open"/u);
  const enabledIpc = sourceBetween('ipcMain.handle("live-workspace:get-enabled"', 'ipcMain.handle("live-call:start"');
  assert.match(enabledIpc, /liveCallEnabled/u);
  assert.match(enabledIpc, /isAllowedOrigin/u);
  assert.match(preloadSource, /getLiveCallEnabled: \(\) => ipcRenderer\.invoke\("live-workspace:get-enabled"\)/u);
});

// ── Three-surface reachability ─────────────────────────────────────────────
// controller / captions overlay / main program window must each be reachable on
// their own. The controller and the overlays are pinned at the "screen-saver"
// level and set skipTaskbar, and Go-Live HIDES the main window — which also
// removes it from the macOS Window menu. With no `activate` handler and a
// Controller-only submenu, a hidden main window had no way back at all.

function windowReachabilitySource() {
  return sourceBetween("function showDashboardWindow", "function showControllerWindow");
}

test("showing the main window raises it and never reloads, recreates or closes it", () => {
  const calls = [];
  const dashboardWindow = {
    destroyed: false,
    minimized: true,
    isDestroyed() { return this.destroyed; },
    isMinimized() { return this.minimized; },
    restore() { calls.push("restore"); this.minimized = false; },
    show() { calls.push("show"); },
    moveTop() { calls.push("moveTop"); },
    focus() { calls.push("focus"); },
  };
  const showDashboardWindow = vm.runInNewContext(
    `${windowReachabilitySource()}; showDashboardWindow`,
    { dashboardWindow, isDesktopAuthenticated: true, overlayEnabled: true, isQuitting: false, maintainOverlayWindow: () => {}, overlayWindows: new Map() },
  );

  assert.equal(showDashboardWindow(), true);
  // show() alone leaves it buried behind whatever was in front.
  assert.deepEqual(calls, ["restore", "show", "moveTop", "focus"]);

  // Already visible: idempotent, no restore.
  calls.length = 0;
  assert.equal(showDashboardWindow(), true);
  assert.deepEqual(calls, ["show", "moveTop", "focus"]);

  // A destroyed window is reported, never resurrected — recreating it would
  // build a NEW renderer and lose the host mic capture mid-call.
  dashboardWindow.destroyed = true;
  calls.length = 0;
  assert.equal(showDashboardWindow(), false);
  assert.deepEqual(calls, []);

  const body = windowReachabilitySource();
  assert.doesNotMatch(
    body,
    /loadURL|\breload\b|new BrowserWindow|\.destroy\(|\.close\(|app\.quit|liveCallSession|stopLiveGatewayBridge/u,
    "reachability must be visibility-only: no reload, recreate, close or session teardown",
  );
});

test("showing the subtitle overlays re-asserts them without rewriting the persisted setting", () => {
  const calls = [];
  const context = {
    overlayEnabled: true,
    isQuitting: false,
    overlayWindows: new Map([["11", { isDestroyed: () => false }]]),
    maintainOverlayWindow: () => calls.push("maintain"),
    dashboardWindow: null,
  };
  const showSubtitleOverlays = vm.runInNewContext(
    `${windowReachabilitySource()}; showSubtitleOverlays`,
    context,
  );
  assert.equal(showSubtitleOverlays(), true);
  assert.deepEqual(calls, ["maintain"]);

  // Overlays turned off by the host stay off: this must not flip the setting.
  context.overlayEnabled = false;
  calls.length = 0;
  assert.equal(showSubtitleOverlays(), false);
  assert.deepEqual(calls, []);

  // ...and nothing pops up mid-shutdown.
  context.overlayEnabled = true;
  context.isQuitting = true;
  assert.equal(showSubtitleOverlays(), false);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(windowReachabilitySource(), /settingsStore|overlayEnabled = /u);
});

test("macOS dock activation brings the main window back without disturbing a live call", () => {
  const handlers = new Map();
  const calls = [];
  const context = {
    app: { on: (event, handler) => handlers.set(event, handler), quit: () => calls.push("QUIT") },
    isQuitting: false,
    overlayEnabled: true,
    showDashboardWindow: () => { calls.push("show-dashboard"); return true; },
    maintainOverlayWindow: () => calls.push("maintain-overlays"),
  };
  const activateSource = sourceBetween('app.on("activate"', "let hasPreparedDesktopShutdown");
  vm.runInNewContext(activateSource, context);

  const activate = handlers.get("activate");
  assert.ok(activate, "without an activate handler a hidden main window has no way back from the dock");
  activate();
  assert.deepEqual(calls, ["show-dashboard", "maintain-overlays"]);

  // Quitting wins — no window pops up while the app is shutting down.
  context.isQuitting = true;
  calls.length = 0;
  activate();
  assert.deepEqual(calls, []);

  // Nothing on this path may reach the before-quit connection cleanup.
  assert.doesNotMatch(activateSource, /quit\(|liveCallSession|stopLiveGatewayBridge|\.destroy\(/u);
});

// The menu labels come from the shared i18n dictionary, so the menu follows the
// language the renderer picked. The test builds the menu once per language.
function buildApplicationMenu(language) {
  /** @type {{ role?: string, label?: string, submenu?: { label?: string, accelerator?: string, click?: () => void }[] }[] | null} */
  let template = null;
  const calls = [];
  const controllerWindow = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    hide() { calls.push("hide-controller"); },
  };
  const context = {
    process: { platform: "darwin" },
    Menu: {
      buildFromTemplate: (value) => { template = value; return { built: true }; },
      setApplicationMenu: () => calls.push("installed"),
    },
    controllerWindow,
    showDashboardWindow: () => { calls.push("show-dashboard"); return true; },
    showControllerWindow: () => { calls.push("show-controller"); return true; },
    showSubtitleOverlays: () => { calls.push("show-overlays"); return true; },
    meetingCoachRuntime: { openPrep: () => calls.push("show-meeting-prep") },
    app: { quit: () => calls.push("QUIT") },
    // Same lookup the main process uses; the menu is not allowed to hard-code copy.
    translate: (key) => MESSAGES[language][key],
    normalizeLanguage: () => language,
    setLanguage: () => language,
  };
  const installApplicationMenu = vm.runInNewContext(
    `${sourceBetween("function installApplicationMenu", "function destroyOverlayWindow")}; installApplicationMenu`,
    context,
  );
  installApplicationMenu("http://127.0.0.1:3210");
  return { template, calls };
}

test("the application menu exposes only NOVA caption surfaces and ends nothing", () => {
  const { template, calls } = buildApplicationMenu("en");
  assert.ok(template, "an application menu must be built");

  const items = template.flatMap((entry) => entry.submenu ?? []).filter((item) => item.label);
  const byLabel = new Map(items.map((item) => [item.label, item]));
  // One place that can reach every surface, whatever state the others are in.
  assert.equal(byLabel.get("Show Main Window")?.accelerator, "CommandOrControl+Shift+M");
  assert.equal(byLabel.has("Meeting Prep"), false);
  assert.equal(byLabel.has("Live Interpreter"), false);
  assert.equal(byLabel.get("Show Caption Controller")?.accelerator, "CommandOrControl+Shift+C");
  assert.equal(byLabel.get("Show Subtitle Overlays")?.accelerator, "CommandOrControl+Shift+O");
  assert.ok(byLabel.has("Hide Caption Controller"));
  // The stock window menu (Minimize/Zoom) is kept alongside it.
  assert.ok(template.some((entry) => entry.role === "windowMenu"));

  calls.length = 0;
  for (const item of byLabel.values()) item.click();
  assert.deepEqual(calls, ["show-dashboard", "show-controller", "hide-controller", "show-overlays"]);
  assert.equal(calls.includes("QUIT"), false, "no menu item may reach the quit path that ends the Live Call");
});

test("the application menu follows the UI language the renderer reports", () => {
  const korean = buildApplicationMenu("ko");
  const koreanLabels = (korean.template ?? []).flatMap((entry) => entry.submenu ?? []).map((item) => item.label);
  assert.ok(koreanLabels.includes(MESSAGES.ko["menu.showMainWindow"]));
  assert.ok(koreanLabels.includes(MESSAGES.ko["menu.showSubtitleOverlays"]));
  assert.notEqual(MESSAGES.ko["menu.showMainWindow"], MESSAGES.en["menu.showMainWindow"]);

  // The renderer's choice arrives over IPC and rebuilds the menu in place.
  assert.match(mainSource, /ipcMain\.handle\("app:set-ui-language"/u);
  assert.match(mainSource, /function applyUiLanguage[\s\S]{0,240}installApplicationMenu\(lastServerUrl\)/u);
  assert.match(preloadSource, /setUiLanguage: \(language\) => ipcRenderer\.invoke\("app:set-ui-language", language\)/u);
});

test("every main-window restore path goes through the shared show helper", () => {
  // Duplicated show()/focus() bodies were how the dock-click gap and the
  // missing moveTop() drifted apart in the first place.
  const secondInstance = sourceBetween('app.on("second-instance"', "// A malformed settings.json");
  assert.match(secondInstance, /showDashboardWindow\(\)/u);
  assert.doesNotMatch(secondInstance, /dashboardWindow\.show\(\)/u);
  const restore = sourceBetween("function restoreDashboardAfterLiveCall", "async function detachLiveCallForShutdown");
  assert.match(restore, /isQuitting/u);
  assert.match(restore, /showDashboardWindow\(\)/u);
  assert.doesNotMatch(restore, /dashboardWindow\.show\(\)/u);
});

test("dashboard hides the Live Call entry when the desktop flag is off", () => {
  assert.match(dashboardSource, /getLiveCallEnabled/u);
  assert.match(dashboardSource, /\.live-handoff/u);
  assert.match(dashboardSource, /hidden/u);
});

// The controller floats above the main window at "screen-saver" level and the
// main window is hidden outright during a Live Call, so the controller needs its
// own way back to it. This is the button behind that.
test("the controller's Main button raises the main window without touching the call", () => {
  const handlers = new Map();
  const shown = [];
  const source = sourceBetween('ipcMain.handle("app:show-main-window"', 'ipcMain.handle("app:quit"');
  vm.runInNewContext(source, {
    ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
    showDashboardWindow: () => { shown.push("showDashboardWindow"); return true; },
  });

  const handler = handlers.get("app:show-main-window");
  assert.equal(typeof handler, "function", "app:show-main-window must be registered");
  assert.equal(handler(), true, "the renderer learns whether the window was actually there");
  assert.deepEqual(shown, ["showDashboardWindow"], "delegates to the shared visibility-only helper");

  // Raising a window must never end the session: app.quit would reach the
  // before-quit handler, which deliberately tears the Live Call down.
  assert.doesNotMatch(
    source,
    /loadURL|\breload\b|new BrowserWindow|\.destroy\(|\.close\(|app\.quit|isQuitting = true|liveCallSession|stopLiveGatewayBridge/u,
    "showing the main window must be visibility-only",
  );

  // Exposed on the preload bridge the controller actually talks to.
  assert.match(preloadSource, /showMainWindow: \(\) => ipcRenderer\.invoke\("app:show-main-window"\)/u);
});

// The calendar is only as good as this wiring: without it every record is
// "local" and a real Live Call never appears on the grid.
test("captions started during a Live Call are recorded as that meeting", () => {
  const dashboard = fs.readFileSync(new URL("../public/subtitle-dashboard.js", import.meta.url), "utf8");

  // The renderer asks the main process who is live, and sends it with the start.
  assert.match(dashboard, /async function describeActiveMeeting/u);
  assert.match(dashboard, /meeting: await describeActiveMeeting\(\)/u);
  assert.match(dashboard, /kind: "live-call"/u);
  // No call, or an unreachable bridge, must degrade to a local record rather
  // than throwing inside session start.
  const body = dashboard.slice(
    dashboard.indexOf("async function describeActiveMeeting"),
    dashboard.indexOf("async function syncLiveCallAudioBridge"),
  );
  assert.match(body, /catch \{\s*return \{ kind: "local" \};/u);
  assert.match(body, /if \(!liveState\?\.armed \|\| !liveState\.live\) return \{ kind: "local" \};/u);

  // liveStartedAt is stamped at Go-Live, not at arm time, and the title has to
  // reach the renderer for the calendar to label the block.
  const state = sourceBetween('ipcMain.handle("live-call:get-state"', 'ipcMain.handle("live-call:host-speak"');
  assert.match(state, /liveStartedAt: liveCallSession\.liveStartedAt/u);
  assert.match(state, /title: liveCallSession\.title/u);
});
