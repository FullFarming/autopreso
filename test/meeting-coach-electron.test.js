import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  MEETING_COACH_CHANNELS,
  createCanonicalCaptionSubscriber,
  normalizeMeetingCoachWindowBounds,
  registerMeetingCoachIpc,
} from "../electron/meeting-coach-ipc.js";

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
    this.webContents = new FakeWebContents(FakeWindow.created.length + 10);
    FakeWindow.created.push(this);
  }

  async loadURL(url) {
    this.loadedUrl = url;
    this.webContents.url = url;
  }

  isDestroyed() { return this.destroyed; }
  show() { this.visible = true; }
  focus() { this.focused = true; }
  setBounds(bounds) { this.bounds = bounds; }
  getBounds() { return this.bounds ?? { x: 0, y: 0, width: this.options.width, height: this.options.height }; }
  closeForTest() {
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit("closed");
  }
}

function createFakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
  };
}

function createSnapshot(overrides = {}) {
  return {
    coachSessionId: "coach-1",
    state: "LIVE",
    brief: { id: "brief-1", version: 2, title: "APAC IT Call" },
    prepMessages: [{ id: "prep-1", role: "USER", text: "이번 달 노트북은 12대입니다.", createdAt: "2026-08-01T00:00:00.000Z" }],
    prepLane: { status: "READY", partialText: "" },
    turns: [],
    currentQuestion: null,
    autoLane: { status: "IDLE" },
    manualLane: { status: "IDLE", partialText: "" },
    connection: { caption: "CONNECTED", provider: "READY" },
    ...overrides,
  };
}

function createFakeEngine(snapshotOverrides = {}, behaviorOverrides = {}) {
  let snapshot = createSnapshot(snapshotOverrides);
  const listeners = new Set();
  const calls = [];
  const update = (patch) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener(snapshot);
  };
  return {
    calls,
    getSnapshot: async () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    interview: async (request) => ({ reply: `asked:${request.message}` }),
    saveDraft: async ({ brief }) => { calls.push(["saveDraft", brief]); update({ brief }); return brief; },
    freezeBrief: async ({ brief }) => { calls.push(["freezeBrief", brief]); update({ brief: { ...brief, status: "FROZEN" } }); return snapshot.brief; },
    start: async (request) => { calls.push(["start", request]); update({ state: "LIVE", coachSessionId: "coach-1" }); },
    answerTurn: async (request) => { calls.push(["answerTurn", request]); },
    runManualAction: async ({ action, text, onPartial }) => {
      calls.push(["runManualAction", { action, text }]);
      update({ manualLane: { requestId: "manual-1", action, input: text, status: "GENERATING", partialText: "" } });
      onPartial?.("Hi");
      onPartial?.("Hi there");
      update({ manualLane: { requestId: "manual-1", action, input: text, status: "READY_GROUNDED", partialText: "", result: { english: "Hi there", korean: "안녕하세요" } } });
      return snapshot.manualLane.result;
    },
    useRecommendation: async (request) => {
      calls.push(["useRecommendation", request]);
      const used = {
        id: "used-turn-1",
        sourceTurnId: request.sourceTurnId,
        english: "Server answer",
        korean: "서버 답변",
        evidenceRefs: ["fact-laptops"],
        usedAt: "2026-08-01T00:00:00.000Z",
      };
      update({ usedRecommendations: [used] });
      return used;
    },
    acceptFinalizedTurn: async (turn) => { calls.push(["acceptFinalizedTurn", turn]); },
    acceptLocalSpeechActivity: async (activity) => { calls.push(["acceptLocalSpeechActivity", activity]); },
    end: async (request) => { calls.push(["end", request]); update({ state: "ENDED" }); },
    dispose: () => { calls.push(["dispose"]); },
    ...behaviorOverrides,
  };
}

function createHarness(options = {}) {
  FakeWindow.created = [];
  const ipc = createFakeIpc();
  const engine = createFakeEngine(options.engineSnapshot, options.engineOverrides);
  const dashboard = new FakeWindow({ width: 1440, height: 900 });
  dashboard.webContents.url = `${LOCAL_ORIGIN}/subtitle.html`;
  const screenApi = options.screenApi ?? {
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  };
  const runtime = registerMeetingCoachIpc({
    app: { getPath: () => "/tmp/nova-test" },
    ipc,
    BrowserWindowClass: FakeWindow,
    screenApi,
    engine,
    serverUrl: LOCAL_ORIGIN,
    localAppOrigin: LOCAL_ORIGIN,
    getDashboardWindow: () => dashboard,
    canStartProtectedAction: options.canStartProtectedAction,
    createWebSocket: () => null,
    boundsStore: options.boundsStore ?? { load: async () => ({}), save: async () => {} },
  });
  return { ipc, engine, dashboard, runtime };
}

function eventFor(window, url = window.webContents.getURL()) {
  window.webContents.url = url;
  return { sender: window.webContents, senderFrame: { url } };
}

function assertLiveTiles(recordBounds, responseBounds, workArea) {
  for (const bounds of [recordBounds, responseBounds]) {
    assert.ok(bounds.x >= workArea.x, "tile x starts inside the work area");
    assert.ok(bounds.y >= workArea.y, "tile y starts inside the work area");
    assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width, "tile width stays inside the work area");
    assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height, "tile height stays inside the work area");
  }
  assert.ok(recordBounds.y < responseBounds.y, "record tile is above response tile");
  assert.ok(recordBounds.y + recordBounds.height <= responseBounds.y, "record and response tiles do not overlap");
}

test("recovers Meeting Coach bounds onto a visible display", () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1280, height: 800 } }];
  assert.deepEqual(
    normalizeMeetingCoachWindowBounds({ x: 8_000, y: -4_000, width: 620, height: 900 }, displays, { width: 620, height: 760 }),
    { x: 330, y: 20, width: 620, height: 760 },
  );
  assert.deepEqual(
    normalizeMeetingCoachWindowBounds({ x: 80, y: 40, width: 560, height: 700 }, displays, { width: 620, height: 760 }),
    { x: 80, y: 40, width: 560, height: 700 },
  );
  assert.deepEqual(
    normalizeMeetingCoachWindowBounds({ x: 900, y: 40, width: 560, height: 700 }, displays, { width: 620, height: 760 }),
    { x: 330, y: 20, width: 620, height: 760 },
  );
});

test("arranges live Meeting Coach windows as non-overlapping right-side tiles", async () => {
  const { ipc, runtime } = createHarness();
  await runtime.openLiveWindows();
  const [, record, response] = FakeWindow.created;

  assert.equal(typeof ipc.handlers.get(MEETING_COACH_CHANNELS.arrangeWindows), "function");
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };
  assertLiveTiles(record.getBounds(), response.getBounds(), workArea);
  assert.equal(record.getBounds().x, response.getBounds().x);
  assert.ok(record.getBounds().x >= workArea.x + workArea.width - 640, "tiles stay on the right side");

  record.setBounds({ x: 12, y: 12, width: 500, height: 360 });
  const arranged = await ipc.handlers.get(MEETING_COACH_CHANNELS.arrangeWindows)(eventFor(record));
  assert.equal(arranged.ok, true);
  assertLiveTiles(record.getBounds(), response.getBounds(), workArea);
});

test("dashboard Live Coach entry routes to Meeting Prep until a session is active", async () => {
  const { ipc, dashboard } = createHarness({
    engineSnapshot: { coachSessionId: null, state: "PREPARED", brief: null },
  });

  const result = await ipc.handlers.get(MEETING_COACH_CHANNELS.openLiveWindows)(eventFor(dashboard));

  assert.equal(result.ok, true);
  assert.equal(FakeWindow.created.length, 2);
  assert.equal(FakeWindow.created[1].loadedUrl, `${LOCAL_ORIGIN}/meeting-coach-prep.html`);
  assert.equal(
    FakeWindow.created.some((window) => window.loadedUrl === `${LOCAL_ORIGIN}/meeting-coach-record.html`),
    false,
  );
  assert.equal(
    FakeWindow.created.some((window) => window.loadedUrl === `${LOCAL_ORIGIN}/meeting-coach-response.html`),
    false,
  );
});

test("display removal re-arranges live windows inside the remaining work area", async () => {
  class FakeScreen extends EventEmitter {
    constructor() {
      super();
      this.displays = [
        { workArea: { x: 0, y: 0, width: 1440, height: 900 } },
        { workArea: { x: 1440, y: 0, width: 1440, height: 900 } },
      ];
    }
    getAllDisplays() { return this.displays; }
    getPrimaryDisplay() { return this.displays[0]; }
  }
  const screenApi = new FakeScreen();
  const { runtime } = createHarness({ screenApi });
  await runtime.openLiveWindows();
  const [, record, response] = FakeWindow.created;
  record.setBounds({ x: 2100, y: 40, width: 620, height: 400 });
  response.setBounds({ x: 2100, y: 480, width: 620, height: 400 });

  screenApi.displays = [{ workArea: { x: 0, y: 0, width: 1280, height: 800 } }];
  screenApi.emit("display-removed");
  await new Promise((resolve) => setImmediate(resolve));

  assertLiveTiles(record.getBounds(), response.getBounds(), screenApi.displays[0].workArea);
});

test("opens three hardened windows with independent live-window closure", async () => {
  const { runtime, engine } = createHarness();
  await runtime.openPrep();
  await runtime.openRecord();
  await runtime.openResponse();

  const [dashboard, prep, record, response] = FakeWindow.created;
  assert.equal(prep.loadedUrl, `${LOCAL_ORIGIN}/meeting-coach-prep.html`);
  assert.equal(record.loadedUrl, `${LOCAL_ORIGIN}/meeting-coach-record.html`);
  assert.equal(response.loadedUrl, `${LOCAL_ORIGIN}/meeting-coach-response.html`);
  for (const window of [prep, record, response]) {
    assert.equal(window.options.webPreferences.contextIsolation, true);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.sandbox, true);
    assert.equal(window.webContents.windowOpenHandler({ url: "https://evil.example" }).action, "deny");
  }
  assert.equal(record.options.alwaysOnTop, true);
  assert.equal(response.options.alwaysOnTop, true);
  assert.equal(prep.options.alwaysOnTop, false);

  record.closeForTest();
  assert.equal(response.isDestroyed(), false);
  assert.equal(engine.calls.some(([name]) => name === "end"), false);
  await runtime.openRecord();
  assert.notEqual(FakeWindow.created.at(-1), record);
  assert.equal(dashboard.isDestroyed(), false);
});

test("rejects spoofed origins and unregistered local renderers on every IPC read", async () => {
  const { ipc, runtime } = createHarness();
  await runtime.openRecord();
  const record = FakeWindow.created.at(-1);
  const handler = ipc.handlers.get(MEETING_COACH_CHANNELS.getSnapshot);

  const response = await handler(eventFor(record));
  assert.deepEqual(response, { ok: true, data: await runtime.getSnapshot() });
  assert.deepEqual(response.data.prepMessages, createSnapshot().prepMessages);
  await assert.rejects(() => handler(eventFor(record, "http://127.0.0.1:3210.evil.example/meeting-coach-record.html")), /FORBIDDEN/);

  const unknown = new FakeWindow({ width: 1, height: 1 });
  unknown.webContents.url = `${LOCAL_ORIGIN}/meeting-coach-record.html`;
  await assert.rejects(() => handler(eventFor(unknown)), /FORBIDDEN/);
});

test("composer partials are bounded snapshot state and clear after completion", async () => {
  const { ipc, runtime } = createHarness();
  await runtime.openResponse();
  const response = FakeWindow.created.at(-1);
  response.webContents.sent.length = 0;

  const result = await ipc.handlers.get(MEETING_COACH_CHANNELS.manualAction)(eventFor(response), {
    action: "TRANSLATE",
    text: "안녕하세요",
  });
  assert.equal(result.ok, true);
  const snapshots = response.webContents.sent
    .filter(({ channel }) => channel === MEETING_COACH_CHANNELS.snapshot)
    .map(({ payload }) => payload);
  assert.ok(snapshots.some((snapshot) => snapshot.manualLane.partialText === "Hi"));
  assert.ok(snapshots.some((snapshot) => snapshot.manualLane.partialText === "Hi there"));
  assert.equal(snapshots.at(-1).manualLane.partialText, "");
  assert.ok(snapshots.every((snapshot, index) => index === 0 || snapshot.seq > snapshots[index - 1].seq));
  assert.equal(JSON.stringify(snapshots).includes("apiKey"), false);
});

test("IPC records recommendation usage through the engine without trusting renderer text", async () => {
  const { ipc, runtime, engine } = createHarness();
  await runtime.openResponse();
  const response = FakeWindow.created.at(-1);

  const result = await ipc.handlers.get(MEETING_COACH_CHANNELS.useRecommendation)(eventFor(response), {
    sourceTurnId: "turn-1",
    english: "<script>forged</script>",
    korean: "조작",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(engine.calls.at(-1), ["useRecommendation", {
    sourceTurnId: "turn-1",
    english: "<script>forged</script>",
    korean: "조작",
  }]);
  assert.equal(result.data.english, "Server answer");
});

test("IPC maps unknown internal errors to a generic message without leaking details", async () => {
  const internalMessage = "ENOENT: /Users/private/customer-notes.json token=secret";
  const { ipc, runtime } = createHarness({
    engineOverrides: {
      runManualAction: async () => { throw new Error(internalMessage); },
    },
  });
  await runtime.openResponse();
  const response = FakeWindow.created.at(-1);

  const result = await ipc.handlers.get(MEETING_COACH_CHANNELS.manualAction)(eventFor(response), {
    action: "DRAFT",
    text: "answer",
  });

  assert.deepEqual(result, {
    ok: false,
    error: "Meeting Coach 요청을 처리하지 못했습니다.",
    code: "MEETING_COACH_FAILED",
  });
  assert.doesNotMatch(JSON.stringify(result), /private|customer-notes|secret/u);
});

test("IPC maps approved actionable error codes to canonical safe messages", async () => {
  const internalMessage = "internal parser detail /Users/private/brief.json";
  const { ipc, runtime } = createHarness({
    engineOverrides: {
      freezeBrief: async () => {
        throw Object.assign(new Error(internalMessage), { code: "AGENDA_REQUIRED" });
      },
    },
  });
  await runtime.openPrep();
  const prep = FakeWindow.created.at(-1);

  const result = await ipc.handlers.get(MEETING_COACH_CHANNELS.freezeBrief)(eventFor(prep), {});

  assert.deepEqual(result, {
    ok: false,
    error: "회의 브리프를 확정하려면 안건이 하나 이상 필요합니다.",
    code: "AGENDA_REQUIRED",
  });
  assert.doesNotMatch(JSON.stringify(result), /internal|private|brief\.json/u);
});

test("IPC preserves canonical domain and Gemini recovery messages through an allowlist", async () => {
  const expectedMessages = {
    SAFE_FALLBACK_REQUIRED: "회의 브리프를 확정하려면 안전 답변이 하나 이상 필요합니다.",
    CONTRADICTION_ACK_REQUIRED: "회의 브리프의 모든 상충 정보 경고를 확인해 주세요.",
    AI_INTERVIEW_FAILED: "AI 사전 인터뷰를 완료하지 못했습니다.",
    INVALID_AI_INTERVIEW: "AI 사전 인터뷰 응답을 확인할 수 없습니다.",
    FROZEN_BRIEF_NOT_FOUND: "확정된 회의 브리프를 찾을 수 없습니다.",
    SESSION_ALREADY_ACTIVE: "다른 회의가 이미 진행 중입니다.",
    SESSION_NOT_STARTED: "Meeting Coach 회의가 시작되지 않았습니다.",
    SESSION_NOT_READY: "Meeting Coach 회의가 준비되지 않았습니다.",
    FINALIZED_TURN_NOT_FOUND: "확정된 발화 기록을 찾을 수 없습니다.",
    MANUAL_TEXT_REQUIRED: "번역하거나 다듬을 문장을 입력해 주세요.",
    READY_RECOMMENDATION_NOT_FOUND: "사용할 수 있는 현재 추천 답변을 찾을 수 없습니다.",
    INVALID_LOCAL_SPEECH_PHASE: "로컬 발화 상태가 올바르지 않습니다.",
    INVALID_LOCAL_SPEECH_SEQUENCE: "로컬 발화 순서가 올바르지 않습니다.",
    RATE_LIMIT_CLOCK_INVALID: "AI 요청 제한 상태를 확인할 수 없습니다.",
    RATE_LIMITED: "AI 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    GEMINI_API_KEY_REQUIRED: "Gemini API 키를 설정해 주세요.",
    GEMINI_UNAVAILABLE: "Gemini 연결을 시작할 수 없습니다.",
    GEMINI_PROMPT_TOO_LARGE: "Gemini 요청 내용이 허용된 길이를 초과했습니다.",
    GEMINI_EMPTY_RESPONSE: "Gemini가 빈 응답을 반환했습니다.",
    GEMINI_TIMEOUT: "응답 시간이 초과되었습니다. 다시 시도해 주세요.",
    GEMINI_ABORTED: "Gemini 요청이 취소되었습니다.",
    GEMINI_AUTH_FAILED: "Gemini API 키를 확인해 주세요.",
    GEMINI_RATE_LIMITED: "Gemini 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.",
    GEMINI_FAILED: "Gemini 응답을 생성하지 못했습니다.",
  };
  let currentCode = "";
  const { ipc, runtime } = createHarness({
    engineOverrides: {
      runManualAction: async () => {
        throw Object.assign(new Error("untrusted internal detail"), { code: currentCode });
      },
    },
  });
  await runtime.openResponse();
  const response = FakeWindow.created.at(-1);
  const handler = ipc.handlers.get(MEETING_COACH_CHANNELS.manualAction);

  for (const [code, error] of Object.entries(expectedMessages)) {
    currentCode = code;
    assert.deepEqual(await handler(eventFor(response), { action: "DRAFT", text: "answer" }), {
      ok: false,
      error,
      code,
    });
  }
});

test("canonical caption subscriber accepts committed gaps, clears coaching on local speech, and seals matching source end", () => {
  const sockets = [];
  const accepted = [];
  const ended = [];
  const connections = [];
  const localSpeech = [];
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.url = "";
      this.options = { headers: { Origin: "" } };
    }
    close() { this.emit("close"); }
  }
  const subscriber = createCanonicalCaptionSubscriber({
    serverUrl: LOCAL_ORIGIN,
    localAppOrigin: LOCAL_ORIGIN,
    createWebSocket: (url, options) => {
      const socket = new FakeSocket();
      socket.url = url;
      const headers = options.headers && typeof options.headers === "object" ? options.headers : {};
      socket.options = { headers: { Origin: String("Origin" in headers ? headers.Origin : "") } };
      sockets.push(socket);
      return socket;
    },
    onCommitted: (turn) => accepted.push(turn),
    onLocalSpeech: (activity) => localSpeech.push(activity),
    onSourceEnded: (sourceSessionId) => ended.push(sourceSessionId),
    onConnection: (state) => connections.push(state),
    reconnect: false,
  });

  subscriber.start();
  subscriber.start();
  assert.equal(sockets.length, 1, "start is idempotent and does not duplicate the canonical subscription");
  const socket = sockets[0];
  socket.emit("open");
  assert.equal(socket.url, "ws://127.0.0.1:3210/ws");
  assert.equal(socket.options.headers.Origin, LOCAL_ORIGIN);
  const send = (payload) => socket.emit("message", Buffer.from(JSON.stringify(payload)));
  send({ type: "subtitle:committed", streamId: "stream-1", seq: 1, utteranceKey: "u-1", source: "system", sourceText: "Hi", translatedText: "안녕", targetLanguage: "ko" });
  send({ type: "subtitle:committed", streamId: "stream-1", seq: 1, utteranceKey: "u-1", source: "system", sourceText: "duplicate", translatedText: "중복", targetLanguage: "ko" });
  send({ type: "subtitle:partial", streamId: "stream-1", seq: 2, source: "system", sourceText: "remote partial" });
  send({ type: "subtitle:partial", streamId: "stream-1", liveSessionId: "call-1", seq: 3, source: "mic", sourceText: "I will" });
  send({ type: "subtitle:partial", streamId: "stream-1", liveSessionId: "call-1", seq: 3, source: "mic", sourceText: "duplicate" });
  send({ type: "subtitle:committed", streamId: "stream-1", liveSessionId: "call-1", seq: 4, utteranceKey: "u-4", source: "mic", sourceText: "I will check.", translatedText: "확인하겠습니다.", targetLanguage: "ko" });
  send({ type: "subtitle:committed", streamId: "stream-1", seq: 5, utteranceKey: "u-5", liveSessionId: "call-1", source: "live-call", sourceText: "Any issue?", translatedText: "문제가 있나요?", targetLanguage: "ko", liveCallSpeaker: { role: "participant", name: "Alex" } });
  send({ type: "subtitle:stopped", sessionId: "call-1" });

  assert.deepEqual(accepted.map((turn) => [turn.seq, turn.id, turn.lane]), [
    [1, "stream-1:u-1", "SYSTEM_AUDIO"],
    [4, "stream-1:u-4", "LOCAL_MIC"],
    [5, "stream-1:u-5", "SYSTEM_AUDIO"],
  ]);
  assert.deepEqual(localSpeech, [
    { sourceSessionId: "call-1", seq: 3, phase: "PARTIAL" },
    { sourceSessionId: "call-1", seq: 4, phase: "FINAL" },
  ]);
  assert.deepEqual(ended, ["call-1"]);
  subscriber.stop();
  assert.equal(socket.listenerCount("open"), 0);
  assert.equal(socket.listenerCount("message"), 0);
  assert.equal(socket.listenerCount("close"), 0);
  assert.equal(socket.listenerCount("error"), 0);
  assert.deepEqual(connections, ["CONNECTING", "CONNECTED", "DISCONNECTED"]);
});

test("IPC forwards local speech activity before committed transcript and disposes engine once", async () => {
  FakeWindow.created = [];
  const ipc = createFakeIpc();
  const engine = createFakeEngine();
  let socket;
  class FakeSocket extends EventEmitter {
    close() { this.emit("close"); }
  }
  const runtime = registerMeetingCoachIpc({
    app: { getPath: () => "/tmp/nova-test" },
    ipc,
    BrowserWindowClass: FakeWindow,
    screenApi: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }] },
    engine,
    serverUrl: LOCAL_ORIGIN,
    localAppOrigin: LOCAL_ORIGIN,
    createWebSocket: () => { socket = new FakeSocket(); return socket; },
  });

  const send = (payload) => socket.emit("message", Buffer.from(JSON.stringify(payload)));
  send({ type: "subtitle:partial", streamId: "stream-2", liveSessionId: "call-2", seq: 7, source: "mic", sourceText: "Let me" });
  send({ type: "subtitle:committed", streamId: "stream-2", liveSessionId: "call-2", seq: 8, utteranceKey: "u-8", source: "mic", sourceText: "Let me confirm." });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(engine.calls.slice(0, 3).map(([name]) => name), [
    "acceptLocalSpeechActivity",
    "acceptLocalSpeechActivity",
    "acceptFinalizedTurn",
  ]);
  runtime.dispose();
  runtime.dispose();
  assert.equal(engine.calls.filter(([name]) => name === "dispose").length, 1);
});

test("preload exposes narrow snapshot methods, unsubscribe functions, and no credentials or raw stream", async () => {
  const preload = await fs.readFile(path.join(process.cwd(), "electron", "preload.js"), "utf8");
  assert.match(preload, /meetingCoachGetSnapshot/u);
  assert.match(preload, /meetingCoachUseRecommendation/u);
  assert.match(preload, /onMeetingCoachSnapshot/u);
  assert.match(preload, /removeListener\("meeting-coach:snapshot"/u);
  assert.doesNotMatch(preload, /OPENAI_API_KEY|GEMINI_API_KEY|apiKeys\??\.(?:openai|gemini)|rawSSE|EventSource/u);
  assert.doesNotMatch(preload, /onMeetingCoach(?:Transcript|Question|Suggestion)/u);
});


test("logout gate prevents new Coach paid work after hydration and tracks existing work", async () => {
  let canStart = true;
  /** @type {((value: unknown) => void) | undefined} */
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const h = createHarness({ canStartProtectedAction: () => canStart, engineOverrides: { interview: () => pending } });
  const prep = await h.runtime.openPrep();
  const event = { sender: prep.webContents, senderFrame: { url: prep.webContents.getURL() } };
  const running = h.ipc.handlers.get(MEETING_COACH_CHANNELS.interview)(event, {});
  await Promise.resolve();
  assert.equal(h.runtime.hasPendingOperations(), true);
  canStart = false;
  const denied = await h.ipc.handlers.get(MEETING_COACH_CHANNELS.start)(event, {});
  assert.equal(denied.code, "HOST_LOGIN_REQUIRED");
  assert.equal(h.engine.calls.some(([name]) => name === "start"), false);
  assert.ok(release);
  release({ reply: "done" });
  await running;
  assert.equal(h.runtime.hasPendingOperations(), false);
  h.runtime.dispose();
});

test("a committed caption remains pending through persistence even after the Coach session ends", async () => {
  let canStart = true;
  /** @type {((value?: unknown) => void) | undefined} */
  let releasePersistence;
  const persistence = new Promise((resolve) => { releasePersistence = resolve; });
  let accepted = 0;
  const engine = createFakeEngine({}, {
    acceptFinalizedTurn: async () => { accepted++; await persistence; },
  });
  class FakeSocket extends EventEmitter { close() { this.emit("close"); } }
  const socket = new FakeSocket();
  const runtime = registerMeetingCoachIpc({
    app: { getPath: () => "/tmp/nova-test" }, ipc: createFakeIpc(), BrowserWindowClass: FakeWindow,
    engine, serverUrl: LOCAL_ORIGIN, localAppOrigin: LOCAL_ORIGIN,
    createWebSocket: () => socket, canStartProtectedAction: () => canStart,
  });
  const send = (seq) => socket.emit("message", Buffer.from(JSON.stringify({
    type: "subtitle:committed", streamId: "stream-end", liveSessionId: "call-end", seq,
    utteranceKey: `u-${seq}`, source: "system", sourceText: "Can we confirm the schedule?",
    translatedText: "일정을 확인할 수 있을까요?", targetLanguage: "ko",
  })));
  try {
    send(1);
    await Promise.resolve();
    await engine.end({});
    assert.equal((await runtime.getSnapshot()).state, "ENDED");
    assert.equal(accepted, 1);
    assert.equal(runtime.hasPendingOperations(), true, "END is not proof that the earlier persistence callback has finished");
    assert.ok(releasePersistence);
    releasePersistence();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.hasPendingOperations(), false);
    canStart = false;
    send(2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(accepted, 1, "logout prevents a new source callback from entering the engine");
  } finally {
    releasePersistence?.();
    runtime.dispose();
  }
});
