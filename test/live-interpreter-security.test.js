// @ts-nocheck - compact Electron fakes intentionally implement only the IPC security surface.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  LIVE_INTERPRETER_CHANNELS,
  registerLiveInterpreterIpc,
} from "../electron/live-interpreter-ipc.js";
import {
  LIVE_INTERPRETER_LANGUAGES,
  OPENAI_REALTIME_TRANSLATIONS_URL,
  createLiveInterpreterController,
  createLiveInterpreterStore,
} from "../src/live-interpreter/index.js";
import { startServer } from "../src/server.js";

const LOCAL_ORIGIN = "http://127.0.0.1:3210";
const NOW = "2026-08-01T00:00:00.000Z";
const EXPECTED_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "worker-src 'none'",
].join("; ");

class FakeWebContents extends EventEmitter {
  constructor(id) { super(); this.id = id; this.url = ""; this.destroyed = false; this.sent = []; }
  getURL() { return this.url; }
  isDestroyed() { return this.destroyed; }
  send(channel, payload) { this.sent.push({ channel, payload }); }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
}

class FakeWindow extends EventEmitter {
  static sequence = 10;
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.webContents = new FakeWebContents(++FakeWindow.sequence);
    this.bounds = { x: 20, y: 20, width: options.width ?? 1_180, height: options.height ?? 780 };
    this.alwaysOnTop = false;
  }
  async loadURL(url) { this.loadedUrl = url; this.webContents.url = url; }
  isDestroyed() { return this.destroyed; }
  getBounds() { return { ...this.bounds }; }
  setBounds(value) { this.bounds = { ...value }; }
  setAlwaysOnTop(value) { this.alwaysOnTop = value; }
  setResizable() {}
  setMinimumSize() {}
  show() {}
  focus() {}
  close() { this.destroyed = true; this.webContents.destroyed = true; this.emit("closed"); }
}

function createIpcHarness({ supportedLanguages = LIVE_INTERPRETER_LANGUAGES, snapshot } = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const calls = [];
  const controller = {
    getSnapshot: () => snapshot ?? {
      state: "IDLE", sessionId: null, mode: null, userLanguage: null, otherLanguage: null,
      lanes: {}, records: [], audioDelta: null,
    },
    subscribe: () => () => {},
    start: async (value) => { calls.push(["start", value]); },
    pushPcm: (value) => { calls.push(["pushPcm", value]); },
    reconnect: async () => {},
    stop: async () => {},
    dispose: async () => {},
  };
  const ipc = {
    handlers,
    listeners,
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => { if (listeners.get(channel) === listener) listeners.delete(channel); },
  };
  const dashboard = new FakeWindow({});
  dashboard.webContents.url = `${LOCAL_ORIGIN}/subtitle.html`;
  const runtime = registerLiveInterpreterIpc({
    ipc,
    BrowserWindowClass: FakeWindow,
    settingsStore: { load: async () => ({ apiKeys: { openai: "sk-main-only" } }) },
    serverUrl: LOCAL_ORIGIN,
    localAppOrigin: LOCAL_ORIGIN,
    createController: () => controller,
    getDashboardWindow: () => dashboard,
    supportedLanguages,
    screenApi: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1_280, height: 720 } }),
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1_280, height: 720 } }),
    },
  });
  return { calls, controller, handlers, ipc, listeners, runtime };
}

function eventFor(window, url = window.webContents.url) {
  window.webContents.url = url;
  return { sender: window.webContents, senderFrame: { url } };
}

function validPreflight(overrides = {}) {
  return {
    microphone: { available: true, deviceId: "mic-1", label: "Local Mic" },
    systemAudio: { available: true, method: "display-capture" },
    virtualOutput: { available: true, deviceId: "blackhole-1", label: "BlackHole 2ch" },
    ...overrides,
  };
}

function readyTranscription() {
  return { ready: async () => {}, sendAudio() {}, stop() {}, close() {} };
}

test("Live Interpreter assets receive local-only CSP and no-store without changing unrelated assets", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1", port: 0, moonshineModel: "medium", openaiApiKey: "test",
    createTranscription: readyTranscription,
  });
  try {
    for (const asset of ["live-interpreter.html", "live-interpreter.js", "live-interpreter-audio.js", "live-interpreter.css"]) {
      const response = await fetch(`${url}/${asset}`);
      assert.equal(response.status, 200, asset);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/u, asset);
      if (asset.endsWith(".html")) assert.equal(response.headers.get("content-security-policy"), EXPECTED_CSP);
    }
    const unrelated = await fetch(`${url}/app.js`);
    assert.equal(unrelated.headers.get("content-security-policy"), null);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("IPC cannot widen the official 13-language allowlist and requires BlackHole proof for ONLINE", async () => {
  assert.deepEqual([...LIVE_INTERPRETER_LANGUAGES], ["es", "pt", "fr", "ja", "ru", "zh", "de", "ko", "hi", "id", "vi", "it", "en"]);
  const { calls, handlers, runtime } = createIpcHarness({ supportedLanguages: [...LIVE_INTERPRETER_LANGUAGES, "xx"] });
  const window = await runtime.open();
  const start = handlers.get(LIVE_INTERPRETER_CHANNELS.start);

  for (const input of [
    { mode: "ONLINE", userLanguage: "ko", otherLanguage: "xx", devicePreflight: validPreflight() },
    { mode: "ONLINE", userLanguage: "ko", otherLanguage: "en" },
    { mode: "ONLINE", userLanguage: "ko", otherLanguage: "en", devicePreflight: validPreflight({ virtualOutput: { available: false, deviceId: "", label: "" } }) },
    { mode: "ONLINE", userLanguage: "ko", otherLanguage: "en", devicePreflight: validPreflight({ virtualOutput: { available: true, deviceId: "speaker", label: "Built-in Output" } }) },
  ]) {
    const response = await start(eventFor(window), input);
    assert.equal(response.ok, false);
    assert.equal(response.code, "INVALID_REQUEST");
  }
  assert.equal(calls.length, 0);

  const accepted = await start(eventFor(window), {
    mode: "ONLINE", userLanguage: "ko", otherLanguage: "en", devicePreflight: validPreflight(),
  });
  assert.equal(accepted.ok, true);
  assert.equal(calls.length, 1);
  runtime.dispose();
});

test("IPC requires an exact registered local sender and canonical fixed-size ArrayBuffer PCM", async () => {
  const { calls, handlers, listeners, runtime } = createIpcHarness();
  const window = await runtime.open();
  const start = handlers.get(LIVE_INTERPRETER_CHANNELS.start);
  await start(eventFor(window), { mode: "ONLINE", userLanguage: "ko", otherLanguage: "en", devicePreflight: validPreflight() });
  const audio = listeners.get(LIVE_INTERPRETER_CHANNELS.audio);
  const valid = new ArrayBuffer(4_800);
  audio(eventFor(window), { lane: "INBOUND", sampleRate: 24_000, frameDurationMs: 100, pcm: valid });
  const acceptedCount = calls.filter(([name]) => name === "pushPcm").length;
  assert.equal(acceptedCount, 1);

  const unknown = new FakeWindow({});
  unknown.webContents.url = `${LOCAL_ORIGIN}/live-interpreter.html`;
  for (const [event, pcm] of [
    [eventFor(unknown), valid],
    [eventFor(window, "http://127.0.0.1:3210.evil.example/live-interpreter.html"), valid],
    [eventFor(window), new Uint8Array(4_800)],
    [eventFor(window), new ArrayBuffer(4_798)],
  ]) audio(event, { lane: "INBOUND", sampleRate: 24_000, frameDurationMs: 100, pcm });
  assert.equal(calls.filter(([name]) => name === "pushPcm").length, acceptedCount);
  runtime.dispose();
});

test("spoofed senders cannot trigger Live Dock and disposed feature stays fail-closed", async () => {
  const { calls, handlers, runtime } = createIpcHarness();
  const window = await runtime.open();
  const unknown = new FakeWindow({});
  unknown.webContents.url = `${LOCAL_ORIGIN}/live-interpreter.html`;
  const input = {
    mode: "IN_PERSON",
    userLanguage: "ko",
    otherLanguage: "en",
    devicePreflight: {
      microphone: { available: true, deviceId: "mic", label: "Mic" },
      systemAudio: { available: false, method: "none" },
      virtualOutput: { available: false, deviceId: "", label: "" },
    },
  };
  await assert.rejects(
    handlers.get(LIVE_INTERPRETER_CHANNELS.start)(eventFor(unknown), input),
    /FORBIDDEN/u,
  );
  assert.equal(window.alwaysOnTop, false);
  assert.equal(calls.length, 0);

  await runtime.dispose();
  assert.equal(await runtime.open(), null);
  assert.equal(runtime.getWindowMode(), "CLOSED");
});

test("renderer snapshots NFC-sanitize text and reject non-canonical or oversized provider audio", async () => {
  const base = {
    state: "RUNNING", sessionId: "session-1", mode: "ONLINE", userLanguage: "ko", otherLanguage: "en",
    lanes: { INBOUND: { state: "ACTIVE", inputTranscript: "Cafe\u0301\u0000", outputTranscript: "안녕\u0007", errorCode: null } },
    records: [],
    audioDelta: { lane: "INBOUND", sampleRate: 24_000, audioBase64: "AQI", eventId: "audio-1" },
    apiKey: "sk-leak", provider: { rawBody: "secret" },
  };
  const { handlers, runtime } = createIpcHarness({ snapshot: base });
  const window = await runtime.open();
  const response = await handlers.get(LIVE_INTERPRETER_CHANNELS.getSnapshot)(eventFor(window));
  assert.equal(response.data.lanes.INBOUND.inputTranscript, "Café");
  assert.equal(response.data.lanes.INBOUND.outputTranscript, "안녕");
  assert.equal(response.data.audioDelta, null);
  assert.equal(JSON.stringify(response.data).includes("sk-leak"), false);
  assert.equal(JSON.stringify(response.data).includes("rawBody"), false);
  runtime.dispose();
});

test("audio never persists and controller dispose fences sockets, queues, and listeners", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "live-interpreter-security-"));
  const store = createLiveInterpreterStore({ directory });
  await store.appendRecord({
    id: "record-1", sessionId: "session-1", lane: "INBOUND", sourceLanguage: "en", targetLanguage: "ko",
    sourceText: "hello", translatedText: "안녕", createdAt: NOW, audioBase64: "AQID",
  });
  assert.equal((await readFile(path.join(directory, "transcripts.json"), "utf8")).includes("AQID"), false);

  const providers = [];
  const controller = createLiveInterpreterController({
    getApiKey: () => "sk-main-only",
    createProvider: (options) => {
      const provider = {
        options,
        stopped: 0,
        async start() { options.onEvent({ type: "state", state: "ACTIVE" }); },
        appendAudio() {},
        async stop() { this.stopped += 1; options.onEvent({ type: "state", state: "CLOSED" }); },
      };
      providers.push(provider);
      return provider;
    },
  });
  let notifications = 0;
  controller.subscribe(() => { notifications += 1; });
  await controller.start({ mode: "ONLINE", userLanguage: "ko", otherLanguage: "en" });
  await controller.dispose();
  const settledNotifications = notifications;
  providers[0].options.onEvent({ type: "output_audio_delta", audioBase64: "AQID" });
  assert.equal(providers.every((provider) => provider.stopped === 1), true);
  assert.equal(notifications, settledNotifications);
  assert.equal(controller.getSnapshot().audioDelta, null);
});

test("surface forbids active content sinks, persistence, arbitrary provider URLs, and sensitive logging", async () => {
  const [html, ui, audio, ipc, provider, controller, store] = await Promise.all([
    readFile(new URL("../public/live-interpreter.html", import.meta.url), "utf8"),
    readFile(new URL("../public/live-interpreter.js", import.meta.url), "utf8"),
    readFile(new URL("../public/live-interpreter-audio.js", import.meta.url), "utf8"),
    readFile(new URL("../electron/live-interpreter-ipc.js", import.meta.url), "utf8"),
    readFile(new URL("../src/live-interpreter/openai.js", import.meta.url), "utf8"),
    readFile(new URL("../src/live-interpreter/controller.js", import.meta.url), "utf8"),
    readFile(new URL("../src/live-interpreter/store.js", import.meta.url), "utf8"),
  ]);
  assert.equal(OPENAI_REALTIME_TRANSLATIONS_URL, "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate");
  for (const source of [html, ui, audio]) assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|eval\s*\(|new Function/u);
  for (const source of [ui, audio, controller, store]) assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/u);
  assert.doesNotMatch(`${ipc}\n${provider}\n${controller}`, /console\.(?:log|debug|info|warn|error)/u);
  assert.doesNotMatch(provider, /options\.(?:url|endpoint)|new URL\([^)]*(?:input|request|config)/u);
  assert.match(ipc, /REALTIME_NOEL_LIVE_INTERPRETER_ENABLED/u);
});
