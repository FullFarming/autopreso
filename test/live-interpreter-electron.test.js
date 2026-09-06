import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  LIVE_INTERPRETER_CHANNELS,
  registerLiveInterpreterIpc,
  resolveLiveInterpreterEnabled,
} from "../electron/live-interpreter-ipc.js";

const LOCAL_ORIGIN = "http://127.0.0.1:3210";

class FakeWebContents extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.url = "";
    this.sent = [];
    this.destroyed = false;
  }

  getURL() { return this.url; }
  isDestroyed() { return this.destroyed; }
  send(channel, payload) { this.sent.push({ channel, payload }); }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
}

class FakeWindow extends EventEmitter {
  static created = [];

  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.visible = false;
    this.webContents = new FakeWebContents(FakeWindow.created.length + 20);
    this.bounds = { x: 220, y: 160, width: options.width, height: options.height };
    this.alwaysOnTop = false;
    this.resizable = true;
    this.minimumSize = [options.minWidth, options.minHeight];
    this.boundsHistory = [];
    FakeWindow.created.push(this);
  }

  async loadURL(url) {
    this.loadedUrl = url;
    this.webContents.url = url;
  }

  isDestroyed() { return this.destroyed; }
  getBounds() { return { ...this.bounds }; }
  setBounds(bounds) { this.bounds = { ...bounds }; this.boundsHistory.push({ ...bounds }); }
  setAlwaysOnTop(value, level) { this.alwaysOnTop = value; this.alwaysOnTopLevel = level; }
  setResizable(value) { this.resizable = value; }
  setMinimumSize(width, height) { this.minimumSize = [width, height]; }
  show() { this.visible = true; }
  focus() { this.focused = true; }
  close() { this.closeForTest(); }
  closeForTest() {
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit("closed");
  }
}

function createFakeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
    on(channel, handler) { listeners.set(channel, handler); },
    removeListener(channel, handler) {
      if (listeners.get(channel) === handler) listeners.delete(channel);
    },
  };
}

function createSnapshot(overrides = {}) {
  return {
    state: "RUNNING",
    sessionId: "interpreter-1",
    mode: "ONLINE",
    userLanguage: "ko",
    otherLanguage: "en",
    lanes: {
      INBOUND: { state: "ACTIVE", inputTranscript: "Hello", outputTranscript: "안녕하세요", errorCode: null },
      OUTBOUND: { state: "IDLE", inputTranscript: "", outputTranscript: "", errorCode: null },
    },
    records: [{
      id: "record-1",
      sessionId: "interpreter-1",
      lane: "INBOUND",
      sourceLanguage: "en",
      targetLanguage: "ko",
      sourceText: "Hello",
      translatedText: "안녕하세요",
      createdAt: "2026-08-01T00:00:00.000Z",
    }],
    audioDelta: {
      lane: "INBOUND",
      sampleRate: 24_000,
      audioBase64: Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64"),
      eventId: "audio-1",
    },
    apiKey: "sk-must-not-leak",
    provider: { name: "openai", model: "gpt-realtime" },
    rawProviderEvent: { secret: true },
    ...overrides,
  };
}

function createController() {
  /** @type {Record<string, unknown>} */
  let snapshot = createSnapshot();
  const listeners = new Set();
  const calls = [];
  return {
    calls,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { calls.push(["unsubscribe"]); listeners.delete(listener); }; },
    start: async (config) => {
      calls.push(["start", config]);
      snapshot = { ...snapshot, state: "RUNNING", mode: config.mode, userLanguage: config.userLanguage, otherLanguage: config.otherLanguage };
      return snapshot;
    },
    pushPcm: (packet) => { calls.push(["pushPcm", packet]); },
    reconnect: async (lane) => { calls.push(["reconnect", lane]); },
    stop: async () => {
      calls.push(["stop"]);
      snapshot = { ...snapshot, state: "IDLE", sessionId: null, mode: null, userLanguage: null, otherLanguage: null, lanes: {}, audioDelta: null };
    },
    dispose: async () => { calls.push(["dispose"]); },
    emit(next) { snapshot = next; for (const listener of listeners) listener(next); },
  };
}

function createHarness({ featureEnabled = true, controller: providedController = null, screenApi: providedScreenApi = null, canStartProtectedAction = () => Boolean(true) } = {}) {
  FakeWindow.created = [];
  const ipc = createFakeIpc();
  const controller = providedController ?? createController();
  let controllerOptions;
  const dashboard = new FakeWindow({ width: 1440, height: 900 });
  dashboard.webContents.url = `${LOCAL_ORIGIN}/subtitle.html`;
  const settingsStore = { load: async () => ({ apiKeys: { openai: "sk-main-process-only" } }) };
  const screenApi = providedScreenApi ?? {
    getDisplayMatching: () => ({ workArea: { x: 100, y: 50, width: 1_400, height: 900 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1_920, height: 1_080 } }),
  };
  const runtime = registerLiveInterpreterIpc({
    ipc,
    BrowserWindowClass: FakeWindow,
    settingsStore,
    serverUrl: LOCAL_ORIGIN,
    localAppOrigin: LOCAL_ORIGIN,
    featureEnabled,
    canStartProtectedAction,
    platform: "darwin",
    screenApi,
    getDashboardWindow: () => dashboard,
    createController: (options) => {
      controllerOptions = options;
      return controller;
    },
  });
  return { ipc, controller, runtime, dashboard, getControllerOptions: () => controllerOptions };
}

function eventFor(window, url = window.webContents.getURL()) {
  window.webContents.url = url;
  return { sender: window.webContents, senderFrame: { url } };
}

test("Live Interpreter feature flag defaults on and only explicit false disables it", () => {
  assert.equal(resolveLiveInterpreterEnabled({}), true);
  assert.equal(resolveLiveInterpreterEnabled({ REALTIME_NOEL_LIVE_INTERPRETER_ENABLED: "true" }), true);
  assert.equal(resolveLiveInterpreterEnabled({ REALTIME_NOEL_LIVE_INTERPRETER_ENABLED: "0" }), true);
  assert.equal(resolveLiveInterpreterEnabled({ REALTIME_NOEL_LIVE_INTERPRETER_ENABLED: " false " }), false);
  assert.equal(resolveLiveInterpreterEnabled({ REALTIME_NOEL_LIVE_INTERPRETER_ENABLED: false }), false);
});

test("opens one independent hardened interpreter window and closes only that window", async () => {
  const { runtime, controller } = createHarness();
  const first = await runtime.open();
  const second = await runtime.open();

  assert.ok(first instanceof FakeWindow);
  assert.equal(first, second);
  assert.equal(first.loadedUrl, `${LOCAL_ORIGIN}/live-interpreter.html`);
  assert.equal(first.options.webPreferences.contextIsolation, true);
  assert.equal(first.options.webPreferences.nodeIntegration, false);
  assert.equal(first.options.webPreferences.sandbox, true);
  assert.equal(first.options.webPreferences.backgroundThrottling, false);
  assert.equal(first.alwaysOnTop, false);
  assert.equal(first.resizable, true);
  assert.equal(first.webContents.windowOpenHandler({ url: "https://evil.example" }).action, "deny");
  assert.equal(runtime.close(), true);
  assert.equal(first.isDestroyed(), true);
  assert.equal(controller.calls.filter(([name]) => name === "stop").length, 1);
  assert.equal(runtime.close(), false);
});

test("successful start enters a right-top always-on-top Live Dock and stop restores Preflight bounds", async () => {
  const { ipc, runtime } = createHarness();
  const window = await runtime.open();
  assert.ok(window instanceof FakeWindow);
  window.bounds = { x: 220, y: 160, width: 1_000, height: 700 };
  const start = ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.start);
  const stop = ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.stop);
  const started = await start(eventFor(window), {
    mode: "ONLINE",
    userLanguage: "ko",
    otherLanguage: "en",
    devicePreflight: {
      microphone: { available: true, deviceId: "mic-1", label: "MacBook Mic" },
      systemAudio: { available: true, method: "display-capture" },
      virtualOutput: { available: true, deviceId: "blackhole-1", label: "BlackHole 2ch" },
    },
  });

  assert.equal(started.ok, true);
  assert.equal(window.alwaysOnTop, true);
  assert.equal(window.alwaysOnTopLevel, "floating");
  assert.equal(window.resizable, true);
  assert.deepEqual(window.minimumSize, [420, 520]);
  assert.deepEqual(window.bounds, { x: 996, y: 74, width: 480, height: 720 });
  assert.equal(runtime.getWindowMode(), "LIVE_DOCK");

  const stopped = await stop(eventFor(window));
  assert.equal(stopped.ok, true);
  assert.equal(window.alwaysOnTop, false);
  assert.equal(window.resizable, true);
  assert.deepEqual(window.minimumSize, [880, 620]);
  assert.deepEqual(window.bounds, { x: 220, y: 160, width: 1_000, height: 700 });
  assert.equal(runtime.getWindowMode(), "PREFLIGHT");
});

test("Live Dock clamps below its preferred and minimum size on a smaller work area", async () => {
  const screenApi = {
    getDisplayMatching: () => ({ workArea: { x: -800, y: 20, width: 400, height: 480 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1_920, height: 1_080 } }),
  };
  const { ipc, runtime } = createHarness({ screenApi });
  const window = await runtime.open();
  assert.ok(window instanceof FakeWindow);
  await ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.start)(eventFor(window), {
    mode: "IN_PERSON",
    userLanguage: "ko",
    otherLanguage: "en",
    devicePreflight: {
      microphone: { available: true, deviceId: "mic", label: "Mic" },
      systemAudio: { available: false, method: "none" },
      virtualOutput: { available: false, deviceId: "", label: "" },
    },
  });
  assert.deepEqual(window.bounds, { x: -800, y: 20, width: 400, height: 480 });
  assert.deepEqual(window.minimumSize, [400, 480]);
  assert.equal(window.resizable, true);
});

test("Preflight bounds restore is clamped into the selected display work area", async () => {
  const { ipc, runtime } = createHarness();
  const window = await runtime.open();
  assert.ok(window instanceof FakeWindow);
  window.bounds = { x: 50_000, y: -900, width: 20_000, height: 20 };
  const config = {
    mode: "IN_PERSON",
    userLanguage: "ko",
    otherLanguage: "en",
    devicePreflight: {
      microphone: { available: true, deviceId: "mic-1", label: "MacBook Mic" },
      systemAudio: { available: false, method: "none" },
      virtualOutput: { available: false, deviceId: "", label: "" },
    },
  };
  await ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.start)(eventFor(window), config);
  await ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.stop)(eventFor(window));

  assert.deepEqual(window.bounds, { x: 100, y: 50, width: 1_400, height: 620 });
  for (const value of Object.values(window.bounds)) assert.equal(Number.isFinite(value), true);
});

test("failed start stays in Preflight and never enables always-on-top", async () => {
  const controller = createController();
  controller.start = async () => { throw Object.assign(new Error("raw provider body"), { code: "OPENAI_FAILED" }); };
  const { ipc, runtime } = createHarness({ controller });
  const window = await runtime.open();
  assert.ok(window instanceof FakeWindow);
  const response = await ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.start)(eventFor(window), {
    mode: "IN_PERSON",
    userLanguage: "ko",
    otherLanguage: "en",
    devicePreflight: {
      microphone: { available: true, deviceId: "mic", label: "Mic" },
      systemAudio: { available: false, method: "none" },
      virtualOutput: { available: false, deviceId: "", label: "" },
    },
  });
  assert.equal(response.ok, false);
  assert.equal(response.error, "실시간 통역을 처리하지 못했습니다.");
  assert.equal(JSON.stringify(response).includes("raw provider body"), false);
  assert.equal(window.alwaysOnTop, false);
  assert.equal(runtime.getWindowMode(), "PREFLIGHT");
});

test("controller-side session end returns the Live Dock to Preflight", async () => {
  const { ipc, runtime, controller } = createHarness();
  const window = await runtime.open();
  assert.ok(window instanceof FakeWindow);
  await ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.start)(eventFor(window), {
    mode: "IN_PERSON",
    userLanguage: "ko",
    otherLanguage: "en",
    devicePreflight: {
      microphone: { available: true, deviceId: "mic", label: "Mic" },
      systemAudio: { available: false, method: "none" },
      virtualOutput: { available: false, deviceId: "", label: "" },
    },
  });
  assert.equal(runtime.getWindowMode(), "LIVE_DOCK");

  controller.emit({
    state: "IDLE", sessionId: null, mode: null, userLanguage: null, otherLanguage: null,
    lanes: {}, records: [], audioDelta: null,
  });
  assert.equal(runtime.getWindowMode(), "PREFLIGHT");
  assert.equal(window.alwaysOnTop, false);
});

test("missing or malformed display APIs use finite current-window fallback bounds", async () => {
  const { ipc, runtime } = createHarness({
    screenApi: {
      getDisplayMatching: () => { throw new Error("display unavailable"); },
      getPrimaryDisplay: () => ({ workArea: { x: NaN, y: Infinity, width: -1, height: 0 } }),
    },
  });
  const window = await runtime.open();
  assert.ok(window instanceof FakeWindow);
  window.bounds = { x: NaN, y: Infinity, width: -1, height: 0 };
  const config = {
    mode: "IN_PERSON",
    userLanguage: "ko",
    otherLanguage: "en",
    devicePreflight: {
      microphone: { available: true, deviceId: "mic", label: "Mic" },
      systemAudio: { available: false, method: "none" },
      virtualOutput: { available: false, deviceId: "", label: "" },
    },
  };
  await ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.start)(eventFor(window), config);
  for (const value of Object.values(window.bounds)) assert.equal(Number.isFinite(value), true);
  await ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.stop)(eventFor(window));
  assert.deepEqual(window.bounds, { x: 0, y: 0, width: 1_180, height: 780 });
});

test("rejects spoofed origins and unregistered local renderers for reads and audio", async () => {
  const { ipc, runtime, controller, dashboard } = createHarness();
  const window = await runtime.open();
  const getSnapshot = ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.getSnapshot);
  const sendAudio = ipc.listeners.get(LIVE_INTERPRETER_CHANNELS.audio);

  assert.deepEqual(
    await ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.getEnabled)(eventFor(dashboard)),
    { ok: true, data: true },
  );
  assert.equal((await getSnapshot(eventFor(window))).ok, true);
  await assert.rejects(
    () => getSnapshot(eventFor(window, "http://127.0.0.1:3210.evil.example/live-interpreter.html")),
    /FORBIDDEN/u,
  );
  const unknown = new FakeWindow({ width: 1, height: 1 });
  unknown.webContents.url = `${LOCAL_ORIGIN}/live-interpreter.html`;
  await assert.rejects(() => getSnapshot(eventFor(unknown)), /FORBIDDEN/u);

  sendAudio(eventFor(unknown), { lane: "INBOUND", sampleRate: 24_000, frameDurationMs: 100, pcm: new ArrayBuffer(4_800) });
  assert.equal(controller.calls.some(([name]) => name === "pushPcm"), false);
});

test("main process supplies the OpenAI key and renderer snapshots omit credentials and provider metadata", async () => {
  const { ipc, runtime, controller, getControllerOptions } = createHarness();
  const window = await runtime.open();
  assert.equal(await getControllerOptions().getApiKey(), "sk-main-process-only");

  const response = await ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.getSnapshot)(eventFor(window));
  assert.equal(response.ok, true);
  assert.equal(response.data.state, "RUNNING");
  assert.equal(response.data.mode, "ONLINE");
  assert.equal(response.data.lanes.INBOUND.outputTranscript, "안녕하세요");
  assert.equal(response.data.records[0].translatedText, "안녕하세요");
  assert.deepEqual(response.data.audioDelta, {
    lane: "INBOUND",
    sampleRate: 24_000,
    audioBase64: "AQIDBA==",
    eventId: "audio-1",
  });
  assert.equal(JSON.stringify(response.data).includes("sk-must-not-leak"), false);
  assert.equal("apiKey" in response.data, false);
  assert.equal("provider" in response.data, false);
  assert.equal("rawProviderEvent" in response.data, false);

  const maliciousSnapshot = createSnapshot({
    records: [createSnapshot().records[0], { ...createSnapshot().records[0], id: "record-evil", lane: "ADMIN" }],
    audioDelta: { lane: "INBOUND", sampleRate: 24_000, audioBase64: "A", eventId: "bad-audio" },
  });
  controller.emit(maliciousSnapshot);
  const afterMalicious = await ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.getSnapshot)(eventFor(window));
  assert.deepEqual(afterMalicious.data.records.map(({ id }) => id), ["record-1"]);
  assert.equal(afterMalicious.data.audioDelta, null);
});

test("allowlists ONLINE and IN_PERSON start requests and bounded 24k PCM packets", async () => {
  const { ipc, runtime, controller } = createHarness();
  const window = await runtime.open();
  const start = ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.start);
  const sendAudio = ipc.listeners.get(LIVE_INTERPRETER_CHANNELS.audio);

  const online = await start(eventFor(window), {
    mode: "ONLINE",
    userLanguage: "ko",
    otherLanguage: "en",
    devicePreflight: {
      microphone: { available: true, deviceId: "mic-1", label: "MacBook Mic" },
      systemAudio: { available: true, method: "electron-loopback" },
      virtualOutput: { available: true, deviceId: "blackhole-1", label: "BlackHole 2ch" },
    },
  });
  assert.equal(online.ok, true);
  assert.deepEqual(controller.calls.at(-1), ["start", {
    mode: "ONLINE",
    userLanguage: "ko",
    otherLanguage: "en",
  }]);

  const credentialInjection = await start(eventFor(window), {
    mode: "ONLINE",
    userLanguage: "ko",
    otherLanguage: "en",
    apiKey: "sk-renderer-secret",
  });
  assert.equal(credentialInjection.ok, false);
  assert.equal(credentialInjection.code, "INVALID_REQUEST");

  for (const invalid of [
    { mode: "ONLINE", userLanguage: "ko", otherLanguage: "en", devicePreflight: {} },
    { mode: "REMOTE", userLanguage: "ko", otherLanguage: "en" },
    { mode: "IN_PERSON", userLanguage: "en", otherLanguage: "en" },
    { mode: "IN_PERSON", userLanguage: "", otherLanguage: "ko" },
    { mode: "IN_PERSON", userLanguage: "xx", otherLanguage: "ko" },
    { mode: "IN_PERSON", userLanguage: "zh-Hans", otherLanguage: "ko" },
    { mode: "ONLINE", userLanguage: "ko", otherLanguage: "en" },
    {
      mode: "ONLINE", userLanguage: "ko", otherLanguage: "en",
      devicePreflight: {
        microphone: { available: true, deviceId: "mic-1", label: "MacBook Mic" },
        systemAudio: { available: true, method: "display-capture" },
        virtualOutput: { available: true, deviceId: "speaker-1", label: "MacBook Speakers" },
      },
    },
  ]) {
    const response = await start(eventFor(window), invalid);
    assert.equal(response.ok, false);
    assert.equal(response.code, "INVALID_REQUEST");
  }

  const validPcm = new ArrayBuffer(4_800);
  sendAudio(eventFor(window), { lane: "INBOUND", sampleRate: 24_000, frameDurationMs: 100, pcm: validPcm });
  assert.deepEqual(controller.calls.at(-1), ["pushPcm", {
    lane: "INBOUND",
    audioBase64: Buffer.from(validPcm).toString("base64"),
  }]);
  const appendCount = controller.calls.filter(([name]) => name === "pushPcm").length;
  for (const invalid of [
    { lane: "USER", sampleRate: 24_000, frameDurationMs: 100, pcm: validPcm },
    { lane: "INBOUND", sampleRate: 16_000, frameDurationMs: 100, pcm: validPcm },
    { lane: "INBOUND", sampleRate: 24_000, frameDurationMs: 101, pcm: validPcm },
    { lane: "INBOUND", sampleRate: 24_000, frameDurationMs: 100, pcm: new ArrayBuffer(96_002) },
  ]) sendAudio(eventFor(window), invalid);
  assert.equal(controller.calls.filter(([name]) => name === "pushPcm").length, appendCount);

  const inPerson = await start(eventFor(window), {
    mode: "IN_PERSON",
    userLanguage: "ko",
    otherLanguage: "en",
    devicePreflight: {
      microphone: { available: true, deviceId: "", label: "" },
      systemAudio: { available: false, method: "none" },
      virtualOutput: { available: false, deviceId: "", label: "" },
    },
  });
  assert.equal(inPerson.ok, true);
  sendAudio(eventFor(window), { lane: "USER", sampleRate: 24_000, frameDurationMs: 100, pcm: validPcm });
  assert.deepEqual(controller.calls.at(-1), ["pushPcm", {
    lane: "USER",
    audioBase64: Buffer.from(validPcm).toString("base64"),
  }]);
});

test("exposes preflight metadata without installing virtual audio and disposes once", async () => {
  const { ipc, runtime, controller } = createHarness();
  const window = await runtime.open();
  const response = await ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.getDevicePreflight)(eventFor(window));

  assert.deepEqual(response, {
    ok: true,
    data: {
      platform: "darwin",
      sampleRate: 24_000,
      supportsMicrophone: true,
      supportsSystemAudio: true,
      requiresScreenRecordingPermission: true,
      virtualAudio: {
        required: true,
        requiredModes: ["ONLINE"],
        driverName: "BlackHole 2ch",
        detection: "renderer-device-enumeration",
        autoInstallSupported: false,
      },
    },
  });
  const firstShutdown = runtime.dispose();
  const secondShutdown = runtime.dispose();
  assert.equal(firstShutdown, secondShutdown);
  await firstShutdown;
  assert.equal(controller.calls.filter(([name]) => name === "unsubscribe").length, 1);
  assert.equal(controller.calls.filter(([name]) => name === "dispose").length, 1);
  assert.equal(ipc.handlers.size, 0);
  assert.equal(ipc.listeners.size, 0);
});

test("disabled runtime refuses to create a controller or window", async () => {
  const { ipc, runtime, dashboard, getControllerOptions } = createHarness({ featureEnabled: false });
  assert.equal(runtime.isEnabled(), false);
  assert.equal(await runtime.open(), null);
  assert.equal(getControllerOptions(), undefined);
  assert.equal(ipc.handlers.has(LIVE_INTERPRETER_CHANNELS.getEnabled), true);
  assert.equal(ipc.handlers.has(LIVE_INTERPRETER_CHANNELS.open), true);
  assert.deepEqual(
    await ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.getEnabled)(eventFor(dashboard)),
    { ok: true, data: false },
  );
  assert.equal(ipc.listeners.size, 0);
  runtime.dispose();
});

test("preload exposes only narrow Live Interpreter methods with listener cleanup", async () => {
  const preload = await fs.readFile(path.join(process.cwd(), "electron", "preload.js"), "utf8");
  for (const method of [
    "getLiveInterpreterEnabled",
    "openLiveInterpreter",
    "closeLiveInterpreter",
    "getLiveInterpreterSnapshot",
    "startLiveInterpreter",
    "sendLiveInterpreterAudio",
    "reconnectLiveInterpreter",
    "stopLiveInterpreter",
    "getLiveInterpreterDevicePreflight",
    "onLiveInterpreterSnapshot",
  ]) assert.match(preload, new RegExp(`\\b${method}\\b`, "u"));
  assert.match(preload, /removeListener\("live-interpreter:snapshot"/u);
  assert.doesNotMatch(preload, /liveInterpreter(?:ApiKey|Provider|RawProvider|InstallBlackHole)/u);
});

test("main wires the sanitized transcript store and awaits bounded interpreter shutdown", async () => {
  const main = await fs.readFile(path.join(process.cwd(), "electron", "main.js"), "utf8");
  assert.match(main, /createLiveInterpreterStore\(\{[\s\S]*?app\.getPath\("userData"\)[\s\S]*?"live-interpreter"/u);
  assert.doesNotMatch(main, /label: "Live Interpreter"/u);
  assert.match(main, /liveInterpreterRuntime\.shutdown\(\)/u);
  assert.match(main, /Promise\.race\(\[[\s\S]*?Promise\.allSettled\(tasks\)[\s\S]*?setTimeout\(resolve, 4_000\)/u);
});


test("logout gate refuses new Interpreter starts and reconnects while allowing stop", async () => {
  let canStart = true;
  const h = createHarness({ canStartProtectedAction: () => canStart });
  const window = await h.runtime.open();
  const event = eventFor(window);
  canStart = false;
  for (const channel of [LIVE_INTERPRETER_CHANNELS.start, LIVE_INTERPRETER_CHANNELS.reconnect]) {
    const result = await h.ipc.handlers.get(channel)(event, {});
    assert.equal(result.code, "HOST_LOGIN_REQUIRED");
  }
  assert.equal(h.controller.calls.length, 0);
  assert.equal((await h.ipc.handlers.get(LIVE_INTERPRETER_CHANNELS.stop)(event)).ok, true);
  await h.runtime.dispose();
});
