import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { startServer } from "../src/server.js";
import { createSettingsStore } from "../src/settings-store.js";
import { createGeminiCaptionConfig } from "../packages/caption-core/gemini-caption-contract.js";
import { normalizeSubtitleSettings } from "../src/subtitle-realtime.js";

const GEMINI_ENGINE = Object.freeze({
  stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
  translation: { provider: "gemini", model: "gemini-3.6-flash" },
  summary: { provider: "gemini", model: "gemini-3.6-flash" },
});
const SONIOX_ENGINE = Object.freeze({
  stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" },
  translation: { provider: "soniox", model: "stt-rt-v5" },
  summary: { provider: "gemini", model: "gemini-3.7-flash" },
});
const summaryEngine = (model) => ({ ...GEMINI_ENGINE, summary: { provider: "gemini", model } });

function deferred() {
  /** @type {() => void} */
  let resolve;
  const promise = new Promise((done) => { resolve = () => done(undefined); });
  return { promise, resolve };
}

async function harness(context, beforeSave = async (_patch) => {}, options = {}, beforeLoad = async () => {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-model-security-"));
  const store = createSettingsStore({ filePath: path.join(dir, "settings.json"), env: {}, readCodexAuth: () => null });
  await store.load();
  const state = { active: false, starts: 0, saves: 0, startRequests: [] };
  const { httpServer, url } = await startServer({
    ...options,
    host: "127.0.0.1", port: 0, moonshineModel: "medium",
    settingsStore: { ...store,
      async load() { await beforeLoad(); return store.load(); },
      async save(patch) { state.saves += 1; await beforeSave(patch); return store.save(patch); },
    },
    createTranscription: () => ({ ready: async () => {}, sendAudio() {}, stop() {}, close() {} }),
    createSubtitleRealtimeManager: () => ({
      _state: state,
      start(input) { state.active = true; state.starts += 1; state.startRequests.push(input); },
      stop() { state.active = false; }, close() {}, sendAudio() {},
    }),
  });
  const socket = new WebSocket(`${url.replace("http:", "ws:")}/ws`, { origin: new URL(url).origin });
  const messages = [];
  const listeners = new Set();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    for (const listener of listeners) listener(message);
  });
  context.after(async () => {
    socket.terminate();
    await new Promise((resolve) => httpServer.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  function receive(predicate) {
    const index = messages.findIndex(predicate);
    if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error("Expected local WS response timed out")); }, 2500);
      const listener = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        messages.splice(messages.indexOf(message), 1);
        resolve(message);
      };
      listeners.add(listener);
    });
  }
  await once(socket, "open");
  await receive((message) => message.type === "subtitle:snapshot");
  messages.length = 0;
  const send = (message) => socket.send(JSON.stringify(message));
  const put = (patch) => fetch(`${url}/api/settings`, {
    method: "PUT", headers: { origin: new URL(url).origin, "content-type": "application/json" }, body: JSON.stringify(patch),
  });
  const start = (id) => send({ type: "subtitle:start", sessionId: id, settings: {} });
  async function flushFrames() { const pong = once(socket, "pong"); socket.ping(); await pong; }
  return { state, store, send, put, start, receive, flushFrames };
}

for (const transport of ["REST", "WS"]) {
  test(`${transport} in-flight engine write never starts a provider and the applied engine still needs an explicit start`, async (context) => {
    const entered = deferred();
    const release = deferred();
    context.after(() => release.resolve());
    const app = await harness(context, async () => { entered.resolve(); await release.promise; });
    const patch = { subtitle: { engine: summaryEngine("gemini-3.7-flash") } };
    const saving = transport === "REST" ? app.put(patch) : null;
    if (transport === "WS") app.send({ type: "settings:update", patch });
    await entered.promise;
    // A preflight is a readiness check, never a provider start — not even
    // while an engine write is still in flight.
    app.send({ type: "subtitle:preflight", requestId: "pending-save", meeting: { kind: "live-call", liveSessionId: "live-1" }, settings: {} });
    const preflight = await app.receive((message) => message.requestId === "pending-save");
    assert.equal(preflight.type, "subtitle:preflight-ready");
    assert.equal(app.state.starts, 0);
    release.resolve();
    if (saving) assert.equal((await saving).status, 200);
    await app.receive((message) => message.type === "settings" && message.settings.subtitle.engine.summary.model === "gemini-3.7-flash");
    assert.equal(app.state.starts, 0, "saving never starts a provider automatically");
    app.start("explicit-start");
    assert.equal((await app.receive((message) => message.sessionId === "explicit-start")).type, "subtitle:started");
    assert.equal(app.state.starts, 1);
    assert.deepEqual((await app.store.load()).subtitle.engine, summaryEngine("gemini-3.7-flash"));
  });
}

test("active WS rejects each forged engine before persisting it but permits the same pinned engine", async (context) => {
  const app = await harness(context);
  app.start("active");
  assert.equal((await app.receive((message) => message.sessionId === "active")).type, "subtitle:started");
  const forged = [
    { ...GEMINI_ENGINE, stt: { provider: "gemini", model: "forged-model", languageMode: "auto" } },
    { ...GEMINI_ENGINE, summary: { provider: "forged", model: "gemini-3.6-flash" } },
    // A Gemini STT cannot restrict the input language, and the Soniox
    // translation lane is only valid alongside the Soniox STT.
    { ...GEMINI_ENGINE, stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "ko" } },
    { ...GEMINI_ENGINE, translation: { provider: "soniox", model: "stt-rt-v5" } },
  ];
  for (const engine of forged) {
    app.send({ type: "settings:update", patch: { subtitle: { engine } } });
    assert.match((await app.receive((message) => message.type === "error")).message, /지원하지|올바르지/u);
    assert.deepEqual((await app.store.load()).subtitle.engine, GEMINI_ENGINE);
  }
  // Validation lives inside the store's write, so a rejected engine reaches
  // save() and is refused there — what must never happen is a forged engine
  // landing in the settings file, asserted per case above.
  const savesBeforeValidWrite = app.state.saves;
  app.send({ type: "settings:update", patch: { subtitle: { engine: GEMINI_ENGINE } } });
  await app.receive((message) => message.type === "settings");
  assert.equal(app.state.saves, savesBeforeValidWrite + 1);
  assert.equal(app.state.starts, 1, "same-engine storage does not restart a provider");
});

test("failed engine storage releases the start fence without applying the failed engine", async (context) => {
  const app = await harness(context, async () => { throw new Error("LOCAL_TEST_WRITE_FAILED"); });
  assert.equal((await app.put({ subtitle: { engine: summaryEngine("gemini-3.7-flash") } })).status, 400);
  assert.deepEqual((await app.store.load()).subtitle.engine, GEMINI_ENGINE, "a failed write never applies the engine");
  app.start("after-storage-failure");
  assert.equal((await app.receive((message) => message.sessionId === "after-storage-failure")).type, "subtitle:started");
  assert.equal(app.state.starts, 1);
});

test("concurrent engine writes never start a provider and never leave a half-applied engine", async (context) => {
  const first = deferred();
  const second = deferred();
  const entered = deferred();
  let count = 0;
  context.after(() => { first.resolve(); second.resolve(); });
  const app = await harness(context, async () => {
    count += 1;
    const gate = count === 1 ? first : second;
    if (count === 2) entered.resolve();
    await gate.promise;
  });
  const one = app.put({ subtitle: { engine: GEMINI_ENGINE } });
  const two = app.put({ subtitle: { engine: summaryEngine("gemini-3.7-flash") } });
  await entered.promise;
  first.resolve();
  await Promise.race([one, two]);
  assert.equal(app.state.starts, 0, "an engine write is not a provider start");
  second.resolve();
  assert.deepEqual((await Promise.all([one, two])).map((response) => response.status), [200, 200]);
  const applied = (await app.store.load()).subtitle.engine;
  assert.ok([GEMINI_ENGINE, summaryEngine("gemini-3.7-flash")].some((engine) => JSON.stringify(engine) === JSON.stringify(applied)),
    "a concurrent write never leaves a partially applied engine behind");
  assert.equal(app.state.starts, 0);
  app.start("all-writes-finished");
  assert.equal((await app.receive((message) => message.sessionId === "all-writes-finished")).type, "subtitle:started");
  assert.equal(app.state.starts, 1);
});

test("a local WS start cannot override the saved engine and saved policy defeats surplus renderer aliases", async (context) => {
  const app = await harness(context);
  // A forged engine is refused outright; a *valid but unsaved* engine (Soniox,
  // a paid transport the user never selected) is silently replaced by the saved
  // one instead of reaching the provider.
  app.send({ type: "subtitle:start", sessionId: "local-forged", settings: { engine: { ...GEMINI_ENGINE, summary: { provider: "gemini", model: "forged" } } } });
  assert.equal((await app.receive((message) => message.sessionId === "local-forged")).type, "subtitle:error");
  assert.equal(app.state.starts, 0);
  for (const requestedEngine of [SONIOX_ENGINE, summaryEngine("gemini-3.7-flash")]) {
    app.send({ type: "subtitle:start", sessionId: "local-pinned", captionProducer: "local", settings: {
      inputMode: "mic", translationLanguages: ["ko", "en"], engine: requestedEngine,
      transcriptionModel: "forged", transcribeModel: "forged", summaryModel: "forged",
      models: { transcription: "forged", summary: "forged" },
    } });
    assert.equal((await app.receive((message) => message.sessionId === "local-pinned")).type, "subtitle:started");
    const actual = app.state.startRequests.at(-1).settings;
    assert.equal(actual.engine.stt.provider, "gemini", "the saved engine defeats the requested one");
    assert.deepEqual(actual.engine, GEMINI_ENGINE);
    const saved = (await app.store.load()).subtitle;
    assert.deepEqual(saved.engine, GEMINI_ENGINE, "a start never rewrites the saved engine");
    const config = createGeminiCaptionConfig(normalizeSubtitleSettings({ ...saved, ...actual }));
    assert.equal(config.engine.stt.provider, "gemini");
    assert.equal(config.models.transcription, GEMINI_ENGINE.stt.model);
    assert.equal(config.models.summary, GEMINI_ENGINE.summary.model);
    assert.equal(actual.inputMode, "mic");
    app.send({ type: "subtitle:stop", sessionId: "local-pinned", requestId: `stop-${requestedEngine.stt.provider}` });
    await app.receive((message) => message.requestId === `stop-${requestedEngine.stt.provider}`);
  }
  assert.equal(app.state.starts, 2);
});

test("hybrid keeps the trusted DB-pinned engine and rejects an untrusted producer before dispatch", async (context) => {
  const app = await harness(context, undefined, { liveCallProducerCapability: "synthetic-main-capability" });
  const settings = { engine: GEMINI_ENGINE };
  const request = { type: "subtitle:start", sessionId: "hybrid-pinned", captionProducer: "hybrid", settings,
    meeting: { kind: "live-call", liveSessionId: "database-pinned-call" } };
  app.send(request);
  assert.equal((await app.receive((message) => message.sessionId === request.sessionId)).message, "LIVE_CALL_PRODUCER_CAPABILITY_INVALID");
  assert.equal(app.state.starts, 0);
  app.send({ ...request, producerCapability: "synthetic-main-capability" });
  assert.equal((await app.receive((message) => message.sessionId === request.sessionId)).type, "subtitle:started");
  assert.deepEqual(app.state.startRequests[0].settings, settings);
  assert.deepEqual((await app.store.load()).subtitle.engine, GEMINI_ENGINE, "the meeting pin does not rewrite local preferences");
});

test("STOP during the saved-engine read cannot start a provider after the stop acknowledgement", async (context) => {
  const entered = deferred();
  const release = deferred();
  let shouldBlock = false;
  context.after(() => release.resolve());
  const app = await harness(context, undefined, {}, async () => {
    if (shouldBlock) { entered.resolve(); await release.promise; }
  });
  shouldBlock = true;
  app.start("stop-during-model-read");
  await entered.promise;
  app.send({ type: "subtitle:stop", sessionId: "stop-during-model-read", requestId: "stop-model-read" });
  await app.flushFrames();
  shouldBlock = false;
  release.resolve();
  const stopped = await app.receive((message) => message.requestId === "stop-model-read");
  assert.equal(stopped.type, "subtitle:stopped");
  assert.equal(app.state.starts, 0);
  app.start("next-explicit-start");
  assert.equal((await app.receive((message) => message.sessionId === "next-explicit-start")).type, "subtitle:started");
  assert.equal(app.state.starts, 1);
});

test("failed saved-engine read cannot fall back to a renderer engine or retain start ownership", async (context) => {
  let shouldFail = false;
  const app = await harness(context, undefined, {}, async () => { if (shouldFail) throw new Error("LOCAL_TEST_READ_FAILED"); });
  shouldFail = true;
  app.send({ type: "subtitle:start", sessionId: "failed-read", settings: { engine: SONIOX_ENGINE } });
  assert.equal((await app.receive((message) => message.sessionId === "failed-read")).type, "subtitle:error");
  assert.equal(app.state.starts, 0);
  shouldFail = false;
  app.start("retry-after-read-failure");
  assert.equal((await app.receive((message) => message.sessionId === "retry-after-read-failure")).type, "subtitle:started");
  assert.equal(app.state.starts, 1);
});
