import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { classifyDesktopConsoleNavigation, openDesktopConsoleWindow } from "../electron/desktop-console-window.js";
import { DEFAULT_ENGINE_SELECTION, normalizeEngineSelection } from "../packages/caption-core/caption-engine-catalog.js";
import { GeminiModelSelectionError, migrateLegacyGeminiModelSelection, readGeminiSelectedModel } from "../packages/caption-core/gemini-model-catalog.js";
import { resolveLiveCallLanguages } from "../src/subtitle-languages.js";
import { MESSAGES } from "../public/subtitle-i18n.js";
import { JA } from "../public/subtitle-i18n-ja.js";

const main = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
const preload = readFileSync(new URL("../electron/preload.js", import.meta.url), "utf8");
const consoleModule = readFileSync(new URL("../electron/desktop-console-window.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/subtitle.html", import.meta.url), "utf8");

function section(start, end) {
  const from = main.indexOf(start);
  const to = main.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} must exist before ${end}`);
  return main.slice(from, to);
}

const origin = "https://workspace.example.test/";

class FakeContents extends EventEmitter {
  setWindowOpenHandler(handler) { this.openHandler = handler; }
}
class FakeWindow extends EventEmitter {
  destroyed = false;
  visible = false;
  focused = 0;
  webContents = new FakeContents();
  constructor(options) { super(); this.options = options; this.visible = options.show === true; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
  show() { this.visible = true; }
  focus() { this.focused += 1; }
  isMinimized() { return false; }
  restore() {}
  async loadURL(url) { this.loadedUrl = url; }
}

function harness(overrides = {}) {
  const external = [];
  const browserSession = {};
  const window = openDesktopConsoleWindow({
    BrowserWindowClass: FakeWindow,
    browserSession,
    baseUrl: origin,
    title: "콘솔",
    openExternal: (url) => { external.push(url); return true; },
    ...overrides,
  });
  return { window, external, browserSession };
}

test("the console window is a sandboxed remote page on the shared cookie session with no preload", async () => {
  const h = harness();
  assert.ok(h.window instanceof FakeWindow);
  const { webPreferences } = h.window.options;
  assert.equal(h.window.options.width, 1200);
  assert.equal(h.window.options.height, 800);
  assert.equal(h.window.options.minWidth, 480);
  assert.equal(h.window.options.minHeight, 640);
  assert.equal(webPreferences.session, h.browserSession);
  assert.equal(webPreferences.preload, undefined);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.webviewTag, false);
  await Promise.resolve();
  assert.equal(h.window.loadedUrl, `${origin}console`);
  h.window.emit("ready-to-show");
  assert.equal(h.window.visible, true);
});

test("only same-origin console, records, admin, and login paths may navigate; everything else is stopped", () => {
  for (const path of ["/console", "/console/", "/console/users", "/console/engine?x=1", "/records", "/records/abc", "/admin", "/admin/", "/login", "/login?client=desktop"]) {
    assert.equal(classifyDesktopConsoleNavigation(`https://workspace.example.test${path}`, origin), "allowed", path);
  }
  for (const url of ["https://workspace.example.test/consoles", "https://workspace.example.test/stage/1", "https://workspace.example.test/m/watch", "https://workspace.example.test/api/console/users",
    "https://workspace.example.test.evil.test/console", "http://workspace.example.test/console", "https://user:secret@workspace.example.test/console", "javascript:alert(1)", "file:///tmp/console.html", "nova://auth/callback"]) {
    assert.equal(classifyDesktopConsoleNavigation(url, origin), "blocked", url);
  }
  const h = harness();
  let prevented = 0;
  const event = { preventDefault() { prevented += 1; } };
  h.window.webContents.emit("will-navigate", { ...event, url: `${origin}console/users` });
  assert.equal(prevented, 0);
  h.window.webContents.emit("will-navigate", { ...event, url: "https://evil.test/console" });
  h.window.webContents.emit("will-redirect", event, `${origin}stage/1`);
  assert.equal(prevented, 2);
  assert.deepEqual(h.external, [], "navigation guards never open the system browser");
});

test("child windows are denied; off-origin http(s) targets go to the system browser, same-origin ones do not", () => {
  const h = harness();
  assert.deepEqual(h.window.webContents.openHandler({ url: "https://docs.example.test/help" }), { action: "deny" });
  assert.deepEqual(h.window.webContents.openHandler({ url: `${origin}console/users` }), { action: "deny" });
  assert.deepEqual(h.window.webContents.openHandler({ url: "javascript:alert(1)" }), { action: "deny" });
  assert.deepEqual(h.external, ["https://docs.example.test/help"]);
});

test("a second open focuses the existing console window instead of creating another", () => {
  const first = harness();
  const second = harness({ existing: first.window });
  assert.equal(second.window, first.window);
  assert.equal(first.window.focused, 1);
  first.window.destroy();
  const third = harness({ existing: first.window });
  assert.notEqual(third.window, first.window);
});

function ipcHarness(overrides = {}) {
  const handlers = new Map();
  const opened = [];
  const context = {
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    isAllowedOrigin: (value, allowed) => allowed.has(new URL(value).origin), localAppOrigin: "http://127.0.0.1:3210", Set, URL,
    isDesktopAuthenticated: true, isQuitting: false,
    desktopHostSession: { getSnapshot: () => ({ ok: true, data: { userId: "noel", expiresAt: "2099-01-01T00:00:00Z", role: "admin" } }) },
    openConsoleWindow: () => { opened.push("console"); },
    ...overrides,
  };
  vm.runInNewContext(section('  ipcMain.handle("console:open"', '  ipcMain.handle("live-workspace:get-enabled"'), context);
  const invoke = (url = "http://127.0.0.1:3210/subtitle.html") => handlers.get("console:open")({ sender: { getURL: () => url } });
  return { context, opened, invoke };
}

test("console:open is gated on the local renderer origin, a verified desktop session, and the admin role", async () => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const admin = ipcHarness();
  assert.deepEqual(plain(await admin.invoke()), { ok: true });
  assert.deepEqual(admin.opened, ["console"]);
  const remote = ipcHarness();
  assert.equal((await remote.invoke("https://workspace.example.test/console")).code, "FORBIDDEN");
  assert.deepEqual(remote.opened, []);
  const signedOut = ipcHarness({ isDesktopAuthenticated: false });
  assert.equal((await signedOut.invoke()).code, "HOST_LOGIN_REQUIRED");
  assert.deepEqual(signedOut.opened, []);
  for (const snapshot of [
    { ok: true, data: { userId: "host-a", expiresAt: "2099-01-01T00:00:00Z", role: "host" } },
    { ok: true, data: { userId: "legacy-a", expiresAt: "2099-01-01T00:00:00Z", role: "legacy" } },
    { ok: true, data: { userId: "legacy-a", expiresAt: "2099-01-01T00:00:00Z" } },
    { ok: false, code: "HOST_LOGIN_REQUIRED" },
  ]) {
    const h = ipcHarness({ desktopHostSession: { getSnapshot: () => snapshot } });
    assert.deepEqual(plain(await h.invoke()), { ok: false, code: "ADMIN_REQUIRED" });
    assert.deepEqual(h.opened, []);
  }
});

test("main, preload, dashboard markup, and all three UI languages carry the console entry point", () => {
  assert.match(main, /ipcMain\.handle\("console:open"/u);
  assert.match(main, /ADMIN_REQUIRED/u);
  assert.match(main, /function openConsoleWindow\(/u);
  assert.match(main, /openDesktopConsoleWindow\(\{[\s\S]{0,600}browserSession: session\.defaultSession/u);
  assert.match(consoleModule, /new URL\("\/console", baseUrl\)/u);
  assert.match(consoleModule, /sandbox: true/u);
  assert.doesNotMatch(consoleModule, /preload:/u, "the console window loads no preload script");
  assert.match(preload, /openConsole: \(\) => ipcRenderer\.invoke\("console:open"\)/u);
  assert.match(html, /<button id="open-live-console" type="button" class="secondary compact"[^>]*data-i18n="settings\.openConsole"[^>]*hidden>/u);
  assert.ok(html.indexOf('id="logout-live-host-session"') < html.indexOf('id="open-live-console"'));
  assert.equal(MESSAGES.ko["settings.openConsole"], "콘솔");
  assert.equal(MESSAGES.en["settings.openConsole"], "Console");
  assert.equal(JA["settings.openConsole"], "コンソール");
  for (const table of [MESSAGES.ko, MESSAGES.en, JA]) assert.equal(typeof table["settings.consoleOpenFailed"], "string");
});

// ── The admin's global engine is the ONLY Live Call engine (spec §9) ────────
// The desktop `subtitle.engine` is local-captions-only: it never reaches the
// `/api/live-sessions` body and the seed never writes into it.

const globalDefault = normalizeEngineSelection({
  stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
  translation: { provider: "gemini", model: "gemini-3.6-flash" },
  summary: { provider: "gemini", model: "gemini-3.7-flash" },
});
const sonioxEngine = normalizeEngineSelection({
  stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" },
  translation: { provider: "soniox", model: "stt-rt-v5" },
  summary: { provider: "gemini", model: "gemini-3.7-flash" },
});
const catalogDefaultPreferences = { source: DEFAULT_ENGINE_SELECTION.stt.model, summary: DEFAULT_ENGINE_SELECTION.summary.model };
const plain = (value) => JSON.parse(JSON.stringify(value));

function liveCallContext(extra = {}) {
  return {
    DEFAULT_ENGINE_SELECTION, normalizeEngineSelection, URL,
    GeminiModelSelectionError, migrateLegacyGeminiModelSelection, readGeminiSelectedModel,
    resolveLiveCallLanguages, LIVE_DRAFT_LANGUAGES: new Set(["ko", "en", "ja"]),
    sanitizeLiveCallGlossaries: (value) => value ?? [], sanitizeLiveCaptionDisplayLanguage: () => "all",
    console: { warn: () => {} },
    ...extra,
  };
}
const modelHelpers = section("function readLiveCallModelPreferences", "function pinLiveCallModelSettings");
const liveCallBuilders = section("function sanitizeLiveCallDraft", "async function openLiveStageOverlay");

/** @param {{ config?: { ok: boolean, code?: string, data?: Record<string, unknown> } }} [options] */
function seedHarness({ config = { ok: true, data: { gatewayUrl: "wss://gw.example.test", engineDefaults: globalDefault } } } = {}) {
  const calls = { api: [], saves: [] };
  const context = liveCallContext({
    liveCallApi: async (baseUrl, pathname, options) => { calls.api.push({ baseUrl, pathname, options }); return config; },
    settingsStore: { save: async (patch) => { calls.saves.push(patch); return patch; } },
  });
  const seed = vm.runInNewContext(`${modelHelpers}\n${liveCallBuilders}\nseedLiveCallEngineDefaults`, context);
  return { calls, seed: () => seed(origin) };
}

test("a new Live Call takes its engine from the admin's global default published by /api/live-config", async () => {
  const h = seedHarness();
  const preferences = await h.seed();
  assert.deepEqual(h.calls.api.map((call) => [call.baseUrl, call.pathname, call.options.method]), [[origin, "/api/live-config", "GET"]]);
  assert.deepEqual(plain(preferences), { source: "gemini-3.5-transcribe-live", summary: "gemini-3.7-flash" });
  // A Soniox global STT has no Gemini source model to name yet (the gateway's
  // Soniox lane is Plan 2); the catalog default source stands in, the summary
  // still follows the admin.
  const soniox = seedHarness({ config: { ok: true, data: { gatewayUrl: "wss://gw.example.test", engineDefaults: sonioxEngine } } });
  assert.deepEqual(plain(await soniox.seed()), { source: DEFAULT_ENGINE_SELECTION.stt.model, summary: "gemini-3.7-flash" });
});

test("an absent, invalid, or unreachable global default falls back to the catalog default — never to the local caption engine", async () => {
  for (const config of [
    { ok: true, data: { gatewayUrl: "wss://gw.example.test" } },
    { ok: true, data: { gatewayUrl: "wss://gw.example.test", engineDefaults: null } },
    { ok: true, data: { gatewayUrl: "wss://gw.example.test", engineDefaults: { stt: { provider: "nope", model: "x", languageMode: "auto" } } } },
    { ok: true, data: { gatewayUrl: "wss://gw.example.test", engineDefaults: "gemini" } },
    { ok: true, data: { gatewayUrl: "wss://gw.example.test", engineDefaults: [] } },
    { ok: true, data: null },
    { ok: false, code: "NETWORK_UNAVAILABLE" },
    { ok: false, code: "HOST_LOGIN_REQUIRED" },
  ]) {
    const h = seedHarness({ config });
    assert.deepEqual(plain(await h.seed()), catalogDefaultPreferences, JSON.stringify(config));
  }
  const seedSource = section("async function seedLiveCallEngineDefaults", "async function openLiveStageOverlay");
  assert.doesNotMatch(seedSource, /subtitle|settingsStore|engineDefaultsSeen|\.save\(/u, "the seed reads no local settings and persists nothing");
  assert.match(seedSource, /DEFAULT_ENGINE_SELECTION/u);
});

test("the local caption engine never reaches the Live Call body: a Soniox subtitle.engine still submits the admin engine", () => {
  const build = vm.runInNewContext(`${modelHelpers}\n${liveCallBuilders}\n(draft, subtitle, preferences) => toLiveCallApiInput(sanitizeLiveCallDraft(draft, subtitle, preferences))`, liveCallContext());
  const adminPreferences = { source: "gemini-3.5-transcribe-live", summary: "gemini-3.7-flash" };
  const localSoniox = Object.freeze({ engine: sonioxEngine, translationLanguages: ["ko", "en"] });
  assert.deepEqual(plain(build({ title: "Synthetic", modelPreferences: { source: "untrusted", summary: "untrusted" } }, localSoniox, adminPreferences).modelPreferences), adminPreferences);
  const localCustomised = { engine: globalDefault, translationLanguages: ["ko", "en"] };
  assert.deepEqual(plain(build({}, localCustomised, catalogDefaultPreferences).modelPreferences), catalogDefaultPreferences,
    "a customised local summary model does not leak into the body when the admin engine is the catalog default");
  assert.deepEqual(plain(build({}, localCustomised, undefined).modelPreferences), catalogDefaultPreferences, "no seeded engine → catalog default");
  assert.equal(localCustomised.engine, globalDefault, "sanitizing never rewrites the local engine");
  assert.doesNotMatch(section("function sanitizeLiveCallDraft", "function toLiveCallApiInput"), /subtitleSettings\.engine|readGeminiSelectedModel/u);
});

test("both desktop create paths log in, seed from the global default, then build the draft with the seeded engine; the local engine and running sessions are untouched", () => {
  for (const [start, end] of [['  ipcMain.handle("live-call:start"', "  async function armPreparedLiveSession"], ['  ipcMain.handle("live-call:register"', '  ipcMain.handle("live-call:list-registered"']]) {
    const handler = section(start, end);
    const login = handler.indexOf("const login = await ensureDesktopHostSession(liveWorkspaceUrl)");
    const seed = handler.indexOf("const modelPreferences = await seedLiveCallEngineDefaults(liveWorkspaceUrl)");
    const draft = handler.indexOf("sanitizeLiveCallDraft(draft, savedSettings?.subtitle, modelPreferences)");
    assert.ok(login >= 0 && login < seed && seed < draft, `${start} must log in, seed, then sanitize with the seeded engine`);
    assert.doesNotMatch(handler, /settingsStore\.save|engineDefaultsSeen/u, `${start} never writes into subtitle.engine`);
  }
  assert.doesNotMatch(main, /engineDefaultsSeen|engineSelectionKey/u);
  for (const untouched of [section("  async function armPreparedLiveSession", "  // Pre-registration:"), section("async function requestDesktopLiveStartIntent", "async function startDesktopLiveDemand")]) {
    assert.doesNotMatch(untouched, /seedLiveCallEngineDefaults/u);
  }
});
