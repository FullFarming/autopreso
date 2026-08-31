import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

/** @typedef {{ ok: true, data?: { userId: string, expiresAt?: string } } | { ok: false, code: string, retryAfterSeconds?: number }} HostSessionReply */
/** @typedef {{ getHostSession: () => Promise<HostSessionReply>, openHostLogin?: () => Promise<HostSessionReply>, logoutHostSession?: () => Promise<HostSessionReply> }} HostSessionBridge */

const workspace = readFileSync(new URL("../public/subtitle-workspace.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/subtitle.html", import.meta.url), "utf8");

/** @param {HostSessionBridge} bridge */
function mount(bridge) {
  const nodes = new Map();
  for (const id of ["live-host-login-section", "live-host-login-status", "live-host-account", "open-live-host-login", "logout-live-host-session"]) nodes.set(id, {
    textContent: "", hidden: false, disabled: false, dataset: {}, listeners: {},
    classList: { toggle() {} }, setAttribute() {}, removeAttribute() {},
    addEventListener(name, handler) { this.listeners[name] = handler; },
  });
  const window = { realtimeNoelDesktop: bridge, listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; } };
  const context = { document: { visibilityState: "visible", getElementById: (id) => nodes.get(id), querySelectorAll: () => [] }, window,
    t: (key, values) => `${key}${values ? JSON.stringify(values) : ""}` };
  vm.createContext(context);
  const start = workspace.indexOf("// ── Shared host session");
  const end = workspace.indexOf("// ── Theme:", start);
  assert.ok(start >= 0 && end > start, "shared host session controls must replace password storage controls");
  vm.runInContext(`${workspace.slice(start, end)}\nglobalThis.refresh = refreshHostLoginStatus; globalThis.render = renderHostLoginStatus;`, context);
  return { nodes, window, refresh: () => context.refresh(), render: () => context.render(), document: context.document };
}

test("desktop account controls use the shared session without exposing a password form", async () => {
  assert.doesNotMatch(html, /name="liveHost(?:Password|Id|Name)"|save-live-host-login|live-host-password-reveal/u);
  assert.doesNotMatch(workspace, /saveLiveHostLogin|liveHostPassword|pendingLiveCallRetry|startLiveCallButton\?\.click\(\)/u);
  const h = mount({ getHostSession: async () => ({ ok: true, data: { userId: "account-a", expiresAt: "2099-01-01T00:00:00Z" } }) });
  await h.refresh();
  assert.equal(h.nodes.get("live-host-account").textContent, "account-a");
  assert.equal(h.nodes.get("open-live-host-login").hidden, true);
  assert.equal(h.nodes.get("logout-live-host-session").hidden, false);
});

test("session reads are deduplicated and a failed read does not claim logout", async () => {
  let calls = 0;
  /** @type {(value: HostSessionReply) => void} */
  let resolve = () => { throw new Error("Session request has not started"); };
  /** @type {Promise<HostSessionReply>} */
  const pending = new Promise((done) => { resolve = done; });
  /** @type {HostSessionBridge} */
  const bridge = { getHostSession: () => { calls += 1; return pending; } };
  const h = mount(bridge);
  const second = h.refresh();
  assert.equal(calls, 1);
  resolve({ ok: true, data: { userId: "account-a", expiresAt: "2099-01-01T00:00:00Z" } });
  await second;
  bridge.getHostSession = async () => ({ ok: false, code: "NETWORK_UNAVAILABLE" });
  await h.refresh();
  assert.equal(h.nodes.get("live-host-account").textContent, "account-a");
  assert.match(h.nodes.get("live-host-login-status").textContent, /hostSessionUnavailable/u);
});

test("sign-in is explicit and rejected logout preserves the current account", async () => {
  let opens = 0;
  /** @type {HostSessionBridge} */
  const bridge = { getHostSession: async () => ({ ok: false, code: "HOST_LOGIN_REQUIRED" }),
    openHostLogin: async () => { opens += 1; return { ok: true, data: { userId: "account-b", expiresAt: "2099-01-01T00:00:00Z" } }; },
    logoutHostSession: async () => ({ ok: false, code: "LIVE_SESSION_ACTIVE" }) };
  const h = mount(bridge);
  await h.refresh();
  assert.equal(opens, 0);
  await h.nodes.get("open-live-host-login").listeners.click();
  assert.equal(opens, 1);
  assert.equal(h.nodes.get("live-host-account").textContent, "account-b");
  await h.nodes.get("logout-live-host-session").listeners.click();
  assert.equal(h.nodes.get("live-host-account").textContent, "account-b");
  assert.match(h.nodes.get("live-host-login-status").textContent, /hostLogoutLive/u);
  bridge.logoutHostSession = async () => ({ ok: true });
  await h.nodes.get("logout-live-host-session").listeners.click();
  assert.equal(h.nodes.get("logout-live-host-session").hidden, true);
});


test("opening sign-in is single-flight, cancellation stays signed out, and no live action is dispatched", async () => {
  let opens = 0;
  /** @type {(value: HostSessionReply) => void} */
  let resolve = () => { throw new Error("Session request has not started"); };
  const h = mount({ getHostSession: async () => ({ ok: false, code: "HOST_LOGIN_REQUIRED" }),
    openHostLogin: () => { opens += 1; return new Promise(done => { resolve = done; }); } });
  await h.refresh();
  const button = h.nodes.get("open-live-host-login");
  const first = button.listeners.click();
  const second = button.listeners.click();
  await Promise.resolve();
  assert.equal(opens, 1);
  assert.equal(button.disabled, true);
  resolve({ ok: false, code: "LOGIN_CANCELLED" });
  await Promise.all([first, second]);
  assert.equal(button.disabled, false);
  assert.equal(button.hidden, false);
  assert.match(h.nodes.get("live-host-login-status").textContent, /hostLoginCancelled/u);
});

test("hidden window focus and local copy rerender perform no session reads", async () => {
  let reads = 0;
  const h = mount({ getHostSession: async () => { reads += 1; return { ok: true, data: { userId: "account-a" } }; } });
  await h.refresh();
  h.document.visibilityState = "hidden";
  h.window.listeners.focus();
  h.render();
  assert.equal(reads, 1);
  h.document.visibilityState = "visible";
  h.window.listeners.focus();
  await h.refresh();
  assert.equal(reads, 2);
});

test("unavailable logout preserves account and rate limiting never opens sign-in automatically", async () => {
  let opens = 0;
  /** @type {HostSessionBridge} */
  const bridge = { getHostSession: async () => ({ ok: true, data: { userId: "account-a" } }),
    openHostLogin: async () => { opens += 1; return { ok: false, code: "LOGIN_CANCELLED" }; },
    logoutHostSession: async () => ({ ok: false, code: "NETWORK_UNAVAILABLE" }) };
  const h = mount(bridge);
  await h.refresh();
  await h.nodes.get("logout-live-host-session").listeners.click();
  assert.equal(h.nodes.get("live-host-account").textContent, "account-a");
  assert.match(h.nodes.get("live-host-login-status").textContent, /hostSessionUnavailable/u);
  bridge.getHostSession = async () => ({ ok: false, code: "RATE_LIMITED", retryAfterSeconds: 900 });
  await h.refresh();
  assert.match(h.nodes.get("live-host-login-status").textContent, /rateLimited.*900/u);
  assert.equal(opens, 0);
});
