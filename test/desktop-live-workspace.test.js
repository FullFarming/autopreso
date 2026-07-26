import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const mainSource = fs.readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
const preloadSource = fs.readFileSync(new URL("../electron/preload.js", import.meta.url), "utf8");

function sourceBetween(start, end) {
  const startIndex = mainSource.indexOf(start);
  const endIndex = mainSource.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1);
  assert.notEqual(endIndex, -1);
  return mainSource.slice(startIndex, endIndex);
}

test("preload does not expose the retired Live workspace launcher", async () => {
  const invoked = [];
  /** @type {{ openLiveWorkspace?: () => Promise<boolean> } | null} */
  let exposed;
  const context = {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld(_name, value) { exposed = value; } },
        ipcRenderer: { invoke(channel, ...args) { invoked.push({ channel, args }); return Promise.resolve(true); } },
      };
    },
  };
  new vm.Script(preloadSource, { filename: "preload.js" }).runInNewContext(context);
  assert.ok(exposed);
  assert.equal(typeof exposed.openLiveWorkspace, "undefined");
  assert.equal(invoked.some(({ channel }) => channel === "live-workspace:open"), false);
});

test("desktop Live Call has no host workspace or login-window path", () => {
  assert.match(mainSource, /DEFAULT_LIVE_WORKSPACE_URL = "https:\/\/realtime-noel-web\.vercel\.app\/"/u);
  assert.match(mainSource, /REALTIME_NOEL_LIVE_URL/u);
  assert.match(mainSource, /app\.isPackaged/u);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\("live-workspace:open"/u);
  assert.doesNotMatch(mainSource, /function openLiveWorkspace|liveWorkspaceWindow/u);
  assert.doesNotMatch(preloadSource, /openLiveWorkspace|live-workspace:open/u);
  assert.match(mainSource, /event\.sender\.getURL\(\)/u);
  assert.match(mainSource, /async function openLiveStageOverlay/u);
  assert.match(mainSource, /contextIsolation: true/u);
  assert.match(mainSource, /nodeIntegration: false/u);
  assert.match(mainSource, /sandbox: true/u);
  assert.match(mainSource, /webSecurity: true/u);
  assert.match(mainSource, /allowRunningInsecureContent: false/u);
  assert.match(mainSource, /setWindowOpenHandler/u);
  assert.match(mainSource, /will-navigate/u);
  assert.match(mainSource, /will-redirect/u);
  assert.match(mainSource, /target\.protocol === "https:"/u);
  assert.match(mainSource, /target\.pathname !== "\/"/u);
  assert.match(mainSource, /target\.username/u);
  assert.match(mainSource, /target\.password/u);
  assert.match(mainSource, /target\.search/u);
  assert.match(mainSource, /target\.hash/u);
  assert.match(mainSource, /new Set\(\["127\.0\.0\.1", "localhost", "\[::1\]"\]\)\.has\(target\.hostname\)/u);
  assert.doesNotMatch(mainSource, /targetUrl\.startsWith|requestingUrl\.startsWith|requestingOrigin\.startsWith/u);
});

test("development Live URL validation rejects credential and origin confusion attacks", () => {
  const parseLiveWorkspaceUrl = vm.runInNewContext(
    `${sourceBetween("function parseLiveWorkspaceUrl", "// ── One-button Live Call")}; parseLiveWorkspaceUrl`,
    { URL, Set },
  );
  assert.equal(parseLiveWorkspaceUrl("https://dev.example.test/"), "https://dev.example.test/");
  assert.equal(parseLiveWorkspaceUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000/");
  assert.equal(parseLiveWorkspaceUrl("http://localhost:3000/"), "http://localhost:3000/");
  for (const malicious of [
    "http://dev.example.test/",
    "http://127.0.0.1.evil.test:3000/",
    "https://user:pass@dev.example.test/",
    "https://dev.example.test/path",
    "https://dev.example.test/?token=value",
    "https://dev.example.test/#fragment",
    "file:///tmp/index.html",
  ]) {
    assert.throws(() => parseLiveWorkspaceUrl(malicious));
  }
});

test("Stage navigation permits only the exact session path and origin", () => {
  const navigationFunctions = [
    sourceBetween("function isExactLiveStageUrl", "// Live Call feature flag"),
    sourceBetween("function parseHttpTarget", "function createOverlayWindow"),
  ].join("\n");
  const isExactLiveStageUrl = vm.runInNewContext(
    `${navigationFunctions}; isExactLiveStageUrl`,
    { URL },
  );
  assert.equal(isExactLiveStageUrl("https://live.example.test/stage/one#invite=x", "https://live.example.test", "/stage/one"), true);
  assert.equal(isExactLiveStageUrl("https://live.example.test/login", "https://live.example.test", "/stage/one"), false);
  assert.equal(isExactLiveStageUrl("https://live.example.test/stage/two", "https://live.example.test", "/stage/one"), false);
  assert.equal(isExactLiveStageUrl("https://live.example.test.evil.test/stage/one", "https://live.example.test", "/stage/one"), false);
  assert.equal(isExactLiveStageUrl("https://live.example.test:444/stage/one", "https://live.example.test", "/stage/one"), false);
  assert.equal(isExactLiveStageUrl("javascript:alert(1)", "https://live.example.test", "/stage/one"), false);

  const isAllowedOrigin = vm.runInNewContext(
    `${sourceBetween("function isAllowedOrigin", "function createNoopTranscription")}; isAllowedOrigin`,
    { URL },
  );
  const allowed = new Set(["http://127.0.0.1:3210", "https://live.example.test"]);
  assert.equal(isAllowedOrigin("http://127.0.0.1:3210/subtitle.html", allowed), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:9999/subtitle.html", allowed), false);
  assert.equal(isAllowedOrigin("https://live.example.test/watch", allowed), true);
  assert.equal(isAllowedOrigin("https://live.example.test.evil.test/watch", allowed), false);
});

test("external links allow only HTTPS and bounded injection-safe mailto URLs", () => {
  assert.match(mainSource, /MAILTO_MAX_URL_LENGTH = 4_096/u);
  assert.match(mainSource, /target\.protocol !== "mailto:"/u);
  assert.match(mainSource, /\[\\r\\n\]/u);
  assert.equal(mainSource.includes(String.raw`if (/^https:\/\//.test(targetUrl))`), false);

  const parseAllowedExternalTarget = vm.runInNewContext(
    `${sourceBetween("function parseAllowedExternalTarget", "function createOverlayWindow")}; parseAllowedExternalTarget`,
    { URL, MAILTO_MAX_URL_LENGTH: 4_096 },
  );
  assert.equal(
    parseAllowedExternalTarget("https://docs.example.test/invite").href,
    "https://docs.example.test/invite",
  );
  assert.equal(
    parseAllowedExternalTarget("mailto:guest@example.test?subject=Realtime%20Noel").href,
    "mailto:guest@example.test?subject=Realtime%20Noel",
  );
  assert.equal(
    parseAllowedExternalTarget("mailto:?subject=Realtime%20Noel&body=Join%20code%20123456").href,
    "mailto:?subject=Realtime%20Noel&body=Join%20code%20123456",
  );

  const longMailto = `mailto:guest@example.test?body=${"a".repeat(4_096)}`;
  for (const malicious of [
    "http://docs.example.test/invite",
    "file:///tmp/invite.txt",
    "javascript:alert(1)",
    "data:text/html,hello",
    "custom:invite",
    "mailto:guest@example.test?subject=hello\r\nBcc:attacker@example.test",
    "mailto:guest@example.test?subject=hello%0d%0aBcc%3Aattacker%40example.test",
    "mailto:?subject=hello&bcc=attacker@example.test",
    "mailto:?cc=attacker@example.test&body=hello",
    "mailto:?subject=one&subject=two",
    "mailto:",
    longMailto,
  ]) {
    assert.equal(parseAllowedExternalTarget(malicious), null);
  }
});

test("media capture and invitation clipboard writes are limited to an exact origin set", () => {
  assert.match(mainSource, /allowedMediaOrigins\.has\(/u);
  assert.match(mainSource, /request\.securityOrigin/u);
  assert.match(mainSource, /request\.userGesture === true/u);
  assert.match(mainSource, /details\?\.isMainFrame === true/u);
  assert.match(mainSource, /ALLOWED_RENDERER_PERMISSIONS = new Set\(\["media", "display-capture", "clipboard-sanitized-write"\]\)/u);
  assert.doesNotMatch(mainSource, /ALLOWED_RENDERER_PERMISSIONS[^\n]+"clipboard-read"/u);
  assert.match(mainSource, /setDisplayMediaRequestHandler/u);
  assert.match(mainSource, /setPermissionRequestHandler/u);
  assert.match(mainSource, /setPermissionCheckHandler/u);
  assert.doesNotMatch(mainSource, /hostname === "127\.0\.0\.1" \|\| url\.hostname === "localhost"/u);
});

test("display capture denial contains Electron's missing-video callback throw", () => {
  const warnings = [];
  const completeDisplayMediaRequest = vm.runInNewContext(
    `${sourceBetween("function completeDisplayMediaRequest", "function configureSystemAudioCapture")}; completeDisplayMediaRequest`,
    { console: { warn: (message) => warnings.push(message) } },
  );

  const completed = completeDisplayMediaRequest(() => {
    throw new TypeError("Video was requested, but no video stream was provided");
  }, {});

  assert.equal(completed, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Video was requested, but no video stream was provided/u);
  const captureHandler = sourceBetween("function configureSystemAudioCapture", "function configureMediaPermissions");
  assert.doesNotMatch(captureHandler, /(?<!completeDisplayMediaRequest\()callback\(/u);
});

// ── Renderer death recovery ────────────────────────────────────────────────
// `isDestroyed()` stays false for a crashed or blank renderer, so the 1s
// overlay watchdog could not see either failure: an overlay whose loadURL
// failed left that display with no subtitles until restart, and a dead
// dashboard renderer (the only host mic source during a Live Call) meant
// viewers got silence with the call still reporting "live".

function loadRendererRecovery(overrides = {}) {
  const timers = [];
  const cleared = [];
  const logs = { warn: [], error: [] };
  const context = {
    isQuitting: false,
    RENDERER_RELOAD_BASE_MS: 1_000,
    RENDERER_RELOAD_MAX_MS: 15_000,
    MAX_RENDERER_RELOADS: 5,
    console: {
      warn: (message) => logs.warn.push(message),
      error: (message) => logs.error.push(message),
      info: () => {},
    },
    setTimeout: (callback, delay) => {
      const token = { callback, delay };
      timers.push(token);
      return token;
    },
    clearTimeout: (token) => cleared.push(token),
    Promise,
    Math,
    ...overrides,
  };
  const attachRendererRecovery = vm.runInNewContext(
    `${sourceBetween("function attachRendererRecovery", "async function startDesktopServer")}; attachRendererRecovery`,
    context,
  );
  return { attachRendererRecovery, timers, cleared, logs, context };
}

function fakeWindow() {
  const handlers = new Map();
  const windowHandlers = new Map();
  return {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    on(event, handler) { windowHandlers.set(event, handler); },
    emitWindow(event, ...args) { windowHandlers.get(event)?.(...args); },
    webContents: {
      on(event, handler) { handlers.set(event, handler); },
    },
    emit(event, ...args) {
      assert.ok(handlers.has(event), `no listener registered for ${event}`);
      return handlers.get(event)(...args);
    },
    has(event) { return handlers.has(event); },
  };
}

test("renderer recovery reloads a failed page with capped exponential backoff", async () => {
  const { attachRendererRecovery, timers } = loadRendererRecovery();
  const window = fakeWindow();
  let reloads = 0;
  const failures = [];
  attachRendererRecovery(window, {
    label: "overlay:1",
    reload: () => { reloads += 1; },
    onFailure: (reason) => failures.push(reason),
  });
  // Both death modes the watchdog is blind to must be observed.
  assert.ok(window.has("did-fail-load"));
  assert.ok(window.has("render-process-gone"));
  assert.ok(window.has("unresponsive"));

  // 1s, 2s, 4s, 8s, then clamped at the 15s ceiling.
  const expected = [1_000, 2_000, 4_000, 8_000, 15_000];
  for (const delay of expected) {
    window.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "http://x/y", true);
    assert.equal(timers.at(-1).delay, delay);
    timers.at(-1).callback();
    await Promise.resolve();
  }
  assert.equal(reloads, expected.length);
  assert.deepEqual(failures, []);

  // The ceiling DISARMS the loop and escalates instead of retrying forever.
  window.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "http://x/y", true);
  assert.equal(timers.length, expected.length);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /did-fail-load -105/u);
});

test("renderer recovery ignores aborted loads, subframes and clean exits, and resets on a good load", () => {
  const { attachRendererRecovery, timers } = loadRendererRecovery();
  const window = fakeWindow();
  attachRendererRecovery(window, { label: "overlay:2", reload: () => {} });

  window.emit("did-fail-load", {}, -3, "ERR_ABORTED", "http://x/y", true);
  window.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "http://x/y", false);
  window.emit("render-process-gone", {}, { reason: "clean-exit" });
  assert.equal(timers.length, 0, "a superseded navigation or subframe error is not a renderer death");

  // A real crash schedules; a later successful load resets the backoff budget.
  window.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1_000);
  timers[0].callback();
  window.emit("did-finish-load");
  window.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(timers.at(-1).delay, 1_000, "a healthy load restores the fast-retry budget");
});

test("renderer recovery stops scheduling once the app is quitting or the window is gone", () => {
  const { attachRendererRecovery, timers, cleared } = loadRendererRecovery({ isQuitting: true });
  const window = fakeWindow();
  attachRendererRecovery(window, { label: "overlay:3", reload: () => {} });
  window.emit("did-fail-load", {}, -105, "ERR_FAILED", "http://x/y", true);
  assert.equal(timers.length, 0);

  const alive = loadRendererRecovery();
  const secondWindow = fakeWindow();
  alive.attachRendererRecovery(secondWindow, { label: "overlay:4", reload: () => {} });
  secondWindow.emit("did-fail-load", {}, -105, "ERR_FAILED", "http://x/y", true);
  assert.equal(alive.timers.length, 1);
  // Closing the window must cancel the armed reload timer.
  secondWindow.emitWindow("closed");
  assert.equal(alive.cleared.length, 1);
  assert.equal(cleared.length, 0);
});

test("dashboard, controller and overlay windows all get renderer recovery", () => {
  assert.match(mainSource, /MAX_RENDERER_RELOADS = 5/u);
  assert.match(mainSource, /RENDERER_RELOAD_BASE_MS = 1_000/u);
  assert.match(mainSource, /RENDERER_RELOAD_MAX_MS = 15_000/u);
  const dashboard = sourceBetween("async function createDashboardWindow", "function resolveLiveWorkspaceUrl");
  assert.match(dashboard, /attachRendererRecovery\(dashboardWindow/u);
  // A dead dashboard renderer means the host mic is gone: stop the bridge and
  // surface it rather than leaving the call "live" over silence.
  assert.match(dashboard, /stopLiveGatewayBridge\("dashboard renderer lost"\)/u);
  assert.match(dashboard, /HOST_AUDIO_RENDERER_LOST/u);
  assert.match(dashboard, /notifyLiveBridgeFailure\(/u);
  const overlay = sourceBetween("function createOverlayWindowForDisplay", "// Reconcile one overlay window");
  assert.match(overlay, /attachRendererRecovery\(window/u);
  assert.match(overlay, /did-finish-load/u, "a recovered overlay must be shown; ready-to-show fires only once");
  const controller = sourceBetween("function createControllerWindow", "function createOverlayWindowForDisplay");
  assert.match(controller, /attachRendererRecovery\(controllerWindow/u);
});

// ── Overlay click-through leak ─────────────────────────────────────────────
// The overlay is fullscreen, transparent, focusable:false and click-through, so
// the ONLY thing keeping the host's screen usable is
// setIgnoreMouseEvents(true). While the cursor hovers a subtitle box the
// renderer claims interactivity (`interactiveOverlayIds`) and the 1s watchdog
// re-applies that claim every tick. If the renderer then dies or reloads, it can
// never release the claim — subtitle-overlay.js only reports `false` on a
// mousemove that CHANGES its own flag, and after a reload that flag already
// starts false. The overlay then swallows every click on the display forever,
// which looks exactly like "the app vanished under the overlay".

/**
 * @param {{ displays: { id: number, bounds: { x: number, y: number, width: number, height: number } }[],
 *           overlayEnabled?: boolean, overlaysMuted?: boolean, isQuitting?: boolean }} options
 */
function loadOverlayWindows({ displays, overlayEnabled = true, overlaysMuted = false, isQuitting = false }) {
  const created = [];
  let nextId = 1;
  function FakeOverlayWindow(options) {
    const contentsHandlers = new Map();
    const windowHandlers = new Map();
    const push = (map, event, handler) => {
      if (!map.has(event)) map.set(event, []);
      map.get(event).push(handler);
    };
    const window = {
      id: nextId++,
      options,
      destroyed: false,
      visible: false,
      loads: 0,
      // Full history so we can prove the FINAL state is click-through.
      ignoreMouse: [],
      isDestroyed() { return this.destroyed; },
      isVisible() { return this.visible; },
      showInactive() { this.visible = true; },
      show() { this.visible = true; },
      hide() { this.visible = false; },
      focus() { throw new Error("an overlay must never take focus"); },
      moveTop() {},
      setAlwaysOnTop() {},
      setVisibleOnAllWorkspaces() {},
      setBounds() {},
      setIgnoreMouseEvents(ignore) { this.ignoreMouse.push(ignore); },
      loadURL() { this.loads += 1; return Promise.resolve(); },
      destroy() {
        this.destroyed = true;
        for (const handler of windowHandlers.get("closed") ?? []) handler();
      },
      on(event, handler) { push(windowHandlers, event, handler); },
      once(event, handler) { push(windowHandlers, event, handler); },
      webContents: { on(event, handler) { push(contentsHandlers, event, handler); } },
      emitContents(event, ...args) {
        const handlers = contentsHandlers.get(event) ?? [];
        assert.notEqual(handlers.length, 0, `no webContents listener for ${event}`);
        for (const handler of handlers) handler(...args);
      },
      emitWindow(event, ...args) {
        for (const handler of windowHandlers.get(event) ?? []) handler(...args);
      },
    };
    created.push(window);
    return window;
  }
  const context = {
    BrowserWindow: FakeOverlayWindow,
    screen: { getAllDisplays: () => displays },
    overlayWindows: new Map(),
    interactiveOverlayIds: new Set(),
    overlayEnabled,
    // Momentary caption hide. The watchdog gates on it, so the harness has to
    // supply it or maintainOverlayWindow throws on a bare reference.
    overlaysMuted,
    isQuitting,
    overlayUrl: "http://127.0.0.1:3210",
    OVERLAY_TOP_LEVEL: "screen-saver",
    // Recovery and top-level re-assertion are covered by their own tests.
    attachRendererRecovery: () => ({ cancel() {} }),
    reassertOverlayTop: () => {},
    path: { join: (...parts) => parts.join("/") },
    __dirnameStub: "/app/electron",
    console: { warn() {}, error() {}, info() {} },
    Promise,
    Set,
    Map,
  };
  // `import.meta` is a module-only syntax form and cannot be parsed by
  // runInNewContext, so the preload path resolution is stubbed out.
  const overlaySource = sourceBetween("function createOverlayWindowForDisplay", "// Re-assert the always-on-top level")
    .replaceAll("import.meta.dirname", "__dirnameStub");
  const api = vm.runInNewContext(
    `${overlaySource}; ({ syncOverlayBounds, maintainOverlayWindow, createOverlayWindowForDisplay })`,
    context,
  );
  return { ...api, context, created };
}

test("a dead overlay renderer releases its click-through claim instead of swallowing every click", () => {
  const displays = [{ id: 11, bounds: { x: 0, y: 0, width: 1512, height: 982 } }];
  const overlay = loadOverlayWindows({ displays });
  overlay.syncOverlayBounds();
  const [window] = overlay.created;
  assert.equal(overlay.created.length, 1);
  assert.equal(window.ignoreMouse.at(-1), true, "a new overlay starts click-through");

  // The cursor is over a subtitle box: the page has claimed real clicks.
  overlay.context.interactiveOverlayIds.add(window.id);
  window.setIgnoreMouseEvents(false);
  assert.equal(window.ignoreMouse.at(-1), false);

  // ...and the renderer dies mid-hover.
  window.emitContents("render-process-gone", {}, { reason: "crashed" });
  assert.equal(
    overlay.context.interactiveOverlayIds.has(window.id),
    false,
    "a dead renderer's hover claim must be dropped — it can never release it itself",
  );
  assert.equal(window.ignoreMouse.at(-1), true, "the overlay must go click-through immediately, not after a reload");

  // The watchdog must not resurrect the stale claim on its next tick.
  overlay.maintainOverlayWindow();
  assert.equal(window.ignoreMouse.at(-1), true);
  // Recovery is visibility-only: no reload, recreate or destroy from this path.
  assert.equal(window.loads, 1);
  assert.equal(window.destroyed, false);
  assert.equal(overlay.created.length, 1);
});

test("a reloaded overlay starts click-through again even if it died mid-hover", () => {
  const displays = [{ id: 12, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
  const overlay = loadOverlayWindows({ displays });
  overlay.syncOverlayBounds();
  const [window] = overlay.created;

  // A stale claim that survived (e.g. the page was reloaded by the recovery
  // backoff rather than crashing outright).
  overlay.context.interactiveOverlayIds.add(window.id);
  window.emitContents("did-finish-load");
  assert.equal(overlay.context.interactiveOverlayIds.has(window.id), false);
  assert.equal(window.ignoreMouse.at(-1), true);
  // The recovered overlay is still shown — without stealing focus.
  assert.equal(window.visible, true);

  // And the watchdog keeps it click-through.
  overlay.maintainOverlayWindow();
  assert.equal(window.ignoreMouse.at(-1), true);
});

test("a live hover claim is still honoured by the watchdog", () => {
  const displays = [{ id: 13, bounds: { x: 0, y: 0, width: 1512, height: 982 } }];
  const overlay = loadOverlayWindows({ displays });
  overlay.syncOverlayBounds();
  const [window] = overlay.created;
  // No death, no reload: the hover claim must survive so double-click-to-restart
  // keeps working. This is the behaviour the fix must NOT regress.
  overlay.context.interactiveOverlayIds.add(window.id);
  overlay.maintainOverlayWindow();
  assert.equal(window.ignoreMouse.at(-1), false);
});

// Momentary caption hide, for playing a video mid-session. What matters is what
// it does NOT do: it must not persist, must not destroy the overlay windows, and
// must not be the overlayEnabled setting wearing a different name.
test("hiding captions momentarily is visibility-only and never persisted", () => {
  const source = fs.readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
  const start = source.indexOf('ipcMain.handle("subtitle-overlay:set-muted"');
  assert.notEqual(start, -1, "the mute IPC must exist");
  const handler = source.slice(start, source.indexOf('ipcMain.handle("subtitle-overlay:get-muted"', start));

  // Persisting it would survive a restart with nothing on screen explaining why.
  assert.doesNotMatch(handler, /settingsStore\.save/u, "a momentary hide must not be written to settings");
  // Destroying the windows reloads the renderer and throws away what is on screen;
  // that is the overlayEnabled setting's job, not this one's.
  assert.doesNotMatch(handler, /destroyOverlayWindow/u, "a momentary hide must not destroy the overlay windows");
  assert.match(handler, /isAllowedOrigin/u, "the renderer origin is checked like every other overlay IPC");
  assert.match(handler, /window\.hide\(\)/u);

  // The 1s watchdog re-shows any hidden overlay, so without this gate the hide is
  // undone within a second.
  const watchdog = source.slice(
    source.indexOf("function maintainOverlayWindow"),
    source.indexOf("function reassertOverlayTop"),
  );
  assert.match(watchdog, /!overlayEnabled \|\| overlaysMuted/u, "the watchdog must respect the mute");

  // Turning the overlay setting back on must clear a stale mute, or the setting
  // looks broken.
  const setEnabled = source.slice(
    source.indexOf('ipcMain.handle("subtitle-overlay:set-enabled"'),
    source.indexOf('ipcMain.handle("subtitle-overlay:set-interactive"'),
  );
  assert.match(setEnabled, /overlaysMuted = false/u);

  // In-memory only: there is no read of a persisted mute anywhere.
  assert.doesNotMatch(source, /subtitle:\s*\{\s*overlaysMuted/u);
});

test("the controller surfaces the caption hide with a visible state and no HTML sink", () => {
  const html = fs.readFileSync(new URL("../public/subtitle-controller.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../public/subtitle-controller.js", import.meta.url), "utf8");
  const preload = fs.readFileSync(new URL("../electron/preload.js", import.meta.url), "utf8");

  assert.match(html, /id="controller-mute-captions"/u);
  assert.match(preload, /setOverlaysMuted: \(muted\) => ipcRenderer\.invoke\("subtitle-overlay:set-muted"/u);
  // Both icons ship in the markup and a class picks one: innerHTML is forbidden
  // in this codebase and pinned by other tests.
  assert.match(html, /mp-icon-when-visible/u);
  assert.match(html, /mp-icon-when-muted/u);
  assert.doesNotMatch(js, /\.innerHTML\s*=/u);
  // A forgotten mute is indistinguishable from broken captions, so the button
  // paints its state rather than only firing the IPC.
  assert.match(js, /classList\.toggle\("is-muted"/u);
  assert.match(js, /aria-pressed/u);
  // Paint from what the main process reports: a rejected origin check returns the
  // unchanged value, and an optimistic paint would then lie.
  assert.match(js, /await window\.realtimeNoelDesktop\.setOverlaysMuted\(next\)/u);
});
