import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { openDesktopHostLogin } from "../electron/desktop-host-login-window.js";

const origin = "https://workspace.example.test/";
const success = { ok: true, data: { userId: "host-test", expiresAt: "2026-10-01T00:00:00Z" } };

class FakeContents extends EventEmitter {
  stopped = false;
  setWindowOpenHandler(handler) { this.openHandler = handler; }
  stop() { this.stopped = true; }
}
class FakeWindow extends EventEmitter {
  destroyed = false;
  visible = false;
  webContents = new FakeContents();
  constructor(options) { super(); this.options = options; this.visible = options.show; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
  show() { this.visible = true; }
  async loadURL(url) { this.loadedUrl = url; }
}

/** @param {{verify?: () => Promise<import("../electron/desktop-host-session.js").HostSessionResult>, onFailure?: () => Promise<boolean>, BrowserWindowClass?: typeof FakeWindow, state?: string, onControls?: (controls: { verifyExternal: () => Promise<void> }) => void}} [options] */
function harness({ verify = async () => success, onFailure = async () => false, BrowserWindowClass = FakeWindow, state = "S".repeat(43), onControls } = {}) {
  /** @type {FakeWindow[]} */
  const windows = [];
  const browserSession = {};
  const result = openDesktopHostLogin({
    BrowserWindowClass,
    browserSession,
    hostSession: { ensureSession: verify },
    baseUrl: origin,
    title: "NOVA 로그인",
    onWindow: (window) => windows.push(window),
    onFailure,
    state,
    onControls,
  });
  const window = windows[0];
  assert.ok(window);
  return { window, windows, result, browserSession, loginUrl: `${origin}login?client=desktop&state=${state}` };
}

test("the login window shares only the cookie session and exposes no native preload or media capability", async () => {
  const h = harness();
  assert.equal(h.window.options.webPreferences.session, h.browserSession);
  assert.match(h.window.options.webPreferences.preload, /desktop-login-preload\.js$/u);
  assert.equal(h.window.options.webPreferences.nodeIntegration, false);
  assert.equal(h.window.options.webPreferences.contextIsolation, true);
  assert.equal(h.window.options.webPreferences.sandbox, true);
  assert.equal(h.window.options.webPreferences.webviewTag, false);
  assert.equal(h.window.visible, true);
  assert.equal(h.window.loadedUrl, h.loginUrl);
  assert.deepEqual(h.window.webContents.openHandler({ url: "https://evil.test" }), { action: "deny" });
  h.window.destroy();
  assert.equal((await h.result).code, "LOGIN_CANCELLED");
});

test("admin navigation is stopped before remote admin code loads and requires a real session check", async () => {
  let checks = 0;
  const h = harness({ verify: async () => { checks++; return success; } });
  let prevented = false;
  h.window.webContents.emit("will-navigate", { preventDefault() { prevented = true; } }, `${origin}admin`);
  assert.equal(prevented, true);
  assert.equal((await h.result).ok, true);
  assert.equal(checks, 1);
  assert.equal(h.window.loadedUrl, h.loginUrl);
  assert.equal(h.window.destroyed, true);
});

test("spoofed redirects and child windows cannot complete authentication", async () => {
  let checks = 0;
  const h = harness({ verify: async () => { checks++; return success; } });
  let prevented = false;
  h.window.webContents.emit("will-redirect", { preventDefault() { prevented = true; } }, "https://workspace.example.test.evil.test/admin");
  assert.equal(prevented, true);
  assert.equal(checks, 0);
  h.window.destroy();
  await h.result;
});

test("a failed session check leaves the window open and never retries without the user's request", async () => {
  let checks = 0;
  let failures = 0;
  const h = harness({ verify: async () => { checks++; return { ok: false, code: "NETWORK_UNAVAILABLE" }; }, onFailure: async () => { failures++; return false; } });
  h.window.webContents.emit("will-navigate", { preventDefault() {} }, `${origin}admin`);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(checks, 1);
  assert.equal(failures, 1);
  assert.equal(h.window.destroyed, false);
  h.window.destroy();
  assert.equal((await h.result).code, "LOGIN_CANCELLED");
});

test("an unresponsive page load stops at its deadline but does not quit or hide the app", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  class HangingWindow extends FakeWindow { loadURL() { return new Promise(() => {}); } }
  let failures = 0;
  const h = harness({ BrowserWindowClass: HangingWindow, onFailure: async () => { failures++; return false; } });
  context.mock.timers.tick(15_000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.window.webContents.stopped, true);
  assert.equal(failures, 1);
  assert.equal(h.window.visible, true);
  assert.equal(h.window.destroyed, false);
  h.window.destroy();
  await h.result;
});

test("a failed load releases its timer before a later manual attempt starts", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  /** @type {((value: boolean) => void) | undefined} */
  let approveRetry;
  const approval = new Promise((resolve) => { approveRetry = resolve; });
  class RetryWindow extends FakeWindow {
    loadURL() { attempts++; return attempts === 1 ? Promise.reject(new Error("offline")) : new Promise(() => {}); }
  }
  const h = harness({ BrowserWindowClass: RetryWindow, onFailure: async () => Boolean(await approval) });
  await Promise.resolve();
  await Promise.resolve();
  context.mock.timers.tick(10_000);
  assert.ok(approveRetry);
  approveRetry(true);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attempts, 2);
  context.mock.timers.tick(5_000);
  assert.equal(h.window.webContents.stopped, false);
  context.mock.timers.tick(10_000);
  assert.equal(h.window.webContents.stopped, true);
  h.window.destroy();
  await h.result;
});

test("login window loads the desktop login URL with state, attaches the login preload, and verifies external deep-link logins", async () => {
  const state = "A".repeat(43);
  /** @type {{ verifyExternal: () => Promise<void> } | undefined} */
  let controls;
  const { windows, result } = harness({ state, onControls: (c) => { controls = c; } });
  await new Promise((r) => setImmediate(r));
  assert.ok(controls);
  assert.equal(windows[0].loadedUrl, `https://workspace.example.test/login?client=desktop&state=${state}`);
  assert.match(windows[0].options.webPreferences.preload, /desktop-login-preload\.js$/u);
  assert.equal(windows[0].options.webPreferences.sandbox, true);
  await controls.verifyExternal();
  assert.deepEqual(await result, success);
  assert.equal(windows[0].destroyed, true);
});
