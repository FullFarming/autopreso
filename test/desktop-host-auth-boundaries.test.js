import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const main = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
function source(start, end) {
  const first = main.indexOf(start);
  const last = main.indexOf(end, first + 1);
  assert.ok(first >= 0 && last > first);
  return main.slice(first, last);
}
function deferred() {
  /** @type {((value?: unknown) => void) | undefined} */
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve(value) { assert.ok(resolve); resolve(value); } };
}
function harness() {
  const handlers = new Map();
  const calls = [];
  const context = {
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    isAllowedOrigin: () => true, localAppOrigin: "http://127.0.0.1:3210", Set,
    isHostLogoutPending: false, isHostLoginPending: false, desktopLoginPromise: null,
    isDesktopAuthenticated: true,
    hasActiveDesktopMedia: async () => false,
    desktopHostSession: {
      ensureSession: async () => ({ ok: false, code: "HOST_LOGIN_REQUIRED" }),
      logout: async () => { calls.push("logout"); return { ok: true }; },
    },
    openHostLoginWindow: async () => ({ ok: false, code: "LOGIN_CANCELLED" }),
    session: { defaultSession: { cookies: { flushStore: async () => { calls.push("flush"); } } } },
    showDashboardWindow: () => calls.push("dashboard"),
    app: { relaunch: () => calls.push("relaunch"), quit: () => calls.push("quit") },
    setImmediate: (callback) => callback(),
  };
  vm.runInNewContext(source('  ipcMain.handle("host-session:open-login"', '  ipcMain.handle("system:open-screen-recording-settings"'), context);
  const event = { sender: { getURL: () => "http://127.0.0.1:3210/subtitle.html" } };
  return { context, calls, invoke: (name) => handlers.get(`host-session:${name}`)(event) };
}

test("remote login and logout exclude one another even while active-media inspection awaits", async () => {
  const h = harness();
  const media = deferred();
  h.context.hasActiveDesktopMedia = () => media.promise;
  const login = h.invoke("open-login");
  assert.equal((await h.invoke("logout")).code, "HOST_LOGIN_IN_PROGRESS");
  assert.deepEqual(h.calls, []);
  media.resolve(false);
  await login;
  assert.equal(h.context.isHostLoginPending, false);
});

test("logout blocks login and new work until clear-cookie persistence completes", async () => {
  const h = harness();
  const flush = deferred();
  h.context.session.defaultSession.cookies.flushStore = () => flush.promise;
  const logout = h.invoke("logout");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.context.isHostLogoutPending, true);
  assert.equal((await h.invoke("open-login")).code, "HOST_LOGOUT_IN_PROGRESS");
  assert.deepEqual(h.calls, ["logout"]);
  flush.resolve(undefined);
  assert.equal((await logout).ok, true);
  assert.deepEqual(h.calls, ["logout", "relaunch", "quit"]);
});

test("an active session or logout network failure never deletes cookies or restarts", async () => {
  const h = harness();
  h.context.hasActiveDesktopMedia = async () => Boolean(true);
  assert.equal((await h.invoke("logout")).code, "LIVE_SESSION_ACTIVE");
  assert.equal(h.context.isHostLogoutPending, false);
  assert.deepEqual(h.calls, []);
  h.context.hasActiveDesktopMedia = async () => false;
  h.context.desktopHostSession.logout = async () => ({ ok: false, code: "NETWORK_UNAVAILABLE" });
  assert.equal((await h.invoke("logout")).code, "NETWORK_UNAVAILABLE");
  assert.equal(h.context.isDesktopAuthenticated, true);
  assert.equal(h.context.isHostLogoutPending, false);
  assert.deepEqual(h.calls, []);
});

test("Windows first-login window transition survives until local app bootstrap completes", () => {
  /** @type {(() => void) | undefined} */
  let onClosed;
  let quits = 0;
  const context = {
    app: { on: (_event, listener) => { onClosed = listener; }, quit: () => { quits++; } },
    process: { platform: "win32" }, isDesktopBooting: true, desktopLoginPromise: null,
  };
  vm.runInNewContext(source('app.on("window-all-closed"', '// macOS: clicking'), context);
  assert.ok(onClosed);
  onClosed();
  assert.equal(quits, 0);
  context.isDesktopBooting = false;
  onClosed();
  assert.equal(quits, 1);
  assert.match(main, /then\(createApp\)\.then\(\(\) => \{ isDesktopBooting = false;/u);
});

test("boot cannot prompt for microphone, start local services, or show local windows before cookie verification", () => {
  const boot = source("async function createApp()", "function syncOverlayBoundsAndTop");
  const verified = boot.indexOf("if (!authenticated.ok || isQuitting)");
  assert.ok(verified > boot.indexOf("desktopHostSession.ensureSession()"));
  for (const operation of ["loadSettingsStoreResiliently()", "startDesktopServer(settingsStore, liveWorkspaceUrl)", "ensureMicrophoneAccess()", "createDashboardWindow(", "createOverlayWindow(", "registerOverlayIpc("]) {
    assert.ok(boot.indexOf(operation) > verified, operation);
  }
});

test("destroying the dashboard during quit never reenters app.quit but a user close still quits", () => {
  const handlers = new Map();
  let quits = 0;
  const context = {
    dashboardWindow: { on: (event, listener) => handlers.set(event, listener) },
    isQuitting: true,
    app: { quit: () => { quits++; } },
  };
  vm.runInNewContext(source('  dashboardWindow.on("closed"', '  // The dashboard renderer is the ONLY'), context);
  handlers.get("closed")();
  assert.equal(quits, 0);
  assert.equal(context.dashboardWindow, null);
  context.isQuitting = false;
  handlers.get("closed")();
  assert.equal(quits, 1);
});

test("quit after async cleanup waits for the next event loop turn instead of reentering in a microtask", async () => {
  const handlers = new Map();
  const queued = [];
  let quits = 0;
  let prevented = 0;
  const context = {
    app: { on: (event, listener) => handlers.set(event, listener), quit: () => { quits++; } },
    hasPreparedDesktopShutdown: false, isQuitting: false,
    liveCallSession: null, liveGatewayBridge: null, liveInterpreterRuntime: {},
    liveAccessHeartbeat: { close() {} },
    prepareDesktopShutdown: async () => {},
    setImmediate: (callback) => { queued.push(callback); },
  };
  vm.runInNewContext(main.slice(main.lastIndexOf('app.on("before-quit"')), context);
  handlers.get("before-quit")({ preventDefault() { prevented++; } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(prevented, 1);
  assert.equal(quits, 0, "native before-quit must unwind before a second quit starts");
  assert.equal(queued.length, 1);
  queued[0]();
  assert.equal(quits, 1);
});

test("main registers the nova scheme, parses deep links on macOS and Windows, checks state, and exchanges the code over the default session", () => {
  assert.match(main, /if \(app\.isPackaged \|\| process\.env\.NOVA_DEV_DEEP_LINK === "1"\) app\.setAsDefaultProtocolClient\("nova"\);/u, "dev runs must not steal nova:// from the installed app");
  assert.equal(main.match(/setAsDefaultProtocolClient\(/gu)?.length, 1, "the scheme is registered in exactly one guarded place");
  assert.match(main, /app\.on\("open-url", \(event, url\) => \{\s*event\.preventDefault\(\);\s*void handleDesktopAuthDeepLink\(url\);/u);
  assert.match(main, /findDesktopAuthDeepLink\(argv\)/u);
  assert.match(main, /if \(!parsed \|\| !pendingDesktopLoginState \|\| parsed\.state !== pendingDesktopLoginState\)/u);
  assert.match(main, /"\/api\/auth\/desktop-exchange"/u);
  assert.match(main, /ipcMain\.handle\("desktop-login:open-external"/u);
  assert.match(main, /isAllowedDesktopExternalLogin\(/u);
  assert.doesNotMatch(main, /console\.[a-z]+\([^)]*(?:parsed\.code|deepLink|deep_link)/u, "codes and deep links are never logged");
});
