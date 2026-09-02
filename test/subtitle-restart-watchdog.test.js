// Server-side session recovery:
//  1. restartChannels() rebuilds the translation channels in place — same
//     sessionId, audio capture untouched — so an overlay double-click (or any
//     headless client) can recover a stalled session even when no dashboard
//     page is open to run a full stop/start.
//  2. The stall watchdog rebuilds automatically: speech signal is present but
//     the pipeline has produced no subtitle output for stallRestartMs.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";

import { createSubtitleRealtimeManager } from "../src/subtitle-realtime.js";
import { createSttTransport as createRealSttTransport } from "../src/caption-engine/create-stt-transport.js";

class FakeSocket extends EventEmitter {
  constructor(url, init) {
    super();
    this.url = url;
    this.init = init;
    this.sent = [];
    this.readyState = WebSocket.OPEN;
  }

  send(message) {
    this.sent.push(message);
  }

  close() {
    this.closed = true;
    this.emit("close");
  }

  terminate() {
    this.terminated = true;
    this.emit("close");
  }
}

/**
 * @param {{
 *   broadcasts?: Array<Record<string, unknown>>,
 *   sockets?: FakeSocket[],
 *   watchdog?: { intervalMs?: number, stallMs?: number, cooldownMs?: number },
 *   now?: () => number,
 *   subtitle?: Record<string, unknown>,
 * }} options
 */
function buildManager({ broadcasts = [], sockets = [], watchdog, now, subtitle = {} } = {}) {
  return createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: {
          translationProvider: "gemini",
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          ...subtitle,
        },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      setImmediate(() => socket.emit("open"));
      return socket;
    },
    log: { warn() {} },
    polish: async () => "This is a translated caption.",
    partialTranslationDebounceMs: 0,
    ...(now ? { now } : {}),
    ...(watchdog ? { stallWatchdog: watchdog } : {}),
  });
}

test("restartChannels rebuilds translation channels while keeping the session alive", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = buildManager({ broadcasts, sockets });

  await manager.start({ sessionId: "active" });
  const initialCount = sockets.length;
  assert.ok(initialCount > 0);

  // Open-new-before-close-old means restartChannels only settles once the
  // replacement is ready (or its waitUntilReady timeout expires), so it must
  // be driven to readiness rather than merely awaited - otherwise the test
  // burns the full 2.5s fallback for no reason.
  const restarting = manager.restartChannels({ reason: "test" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sockets.length > initialCount, "new sockets are opened for the rebuilt channels");
  for (const socket of sockets.slice(initialCount)) {
    socket.emit("message", JSON.stringify({ setupComplete: {} }));
  }
  const restarted = await restarting;
  assert.equal(restarted, true);
  assert.equal(manager._state.sessionId, "active", "the session survives the rebuild");
  assert.equal(manager._state.active, true);

  // Audio continues to flow into the NEW channels under the same session id.
  const before = sockets.reduce((sum, socket) => sum + socket.sent.length, 0);
  manager.sendAudio({ sessionId: "active", source: "mic", audio: "AAAA" });
  const after = sockets.reduce((sum, socket) => sum + socket.sent.length, 0);
  assert.ok(after > before, "audio reaches the rebuilt channels");

  await manager.stop();
});

test("restartChannels is a no-op when no session is active", async () => {
  const manager = buildManager({ broadcasts: [], sockets: [] });
  assert.equal(await manager.restartChannels(), false);
});

test("stall watchdog rebuilds channels when speech flows but no subtitles come out", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = buildManager({
    broadcasts,
    sockets,
    watchdog: { intervalMs: 15, stallMs: 60, cooldownMs: 200 },
  });

  await manager.start({ sessionId: "active" });
  const initialCount = sockets.length;

  // Speaker keeps talking (signal), pipeline stays silent → watchdog restarts.
  const signalTimer = setInterval(() => manager.noteInputSignal({ sessionId: "active" }), 10);
  await new Promise((resolve) => setTimeout(resolve, 160));
  clearInterval(signalTimer);

  assert.ok(sockets.length > initialCount, "the watchdog rebuilt the channels");
  assert.ok(
    broadcasts.some((message) => message.type === "subtitle:status" && message.status === "recovering"),
    "a recovering status is surfaced to viewers",
  );

  await manager.stop();
});

test("default watchdog does not restart at 1.999s and rebuilds at the exact two-second boundary", async () => {
  const sockets = [];
  const broadcasts = [];
  let now = 10_000;
  const manager = buildManager({
    broadcasts,
    sockets,
    watchdog: { intervalMs: 2 },
    now: () => now,
  });

  await manager.start({ sessionId: "two-second-stall" });
  const initialCount = sockets.length;
  manager.noteInputSignal({ sessionId: "two-second-stall" });

  now = 11_999;
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.equal(sockets.length, initialCount, "1.999 seconds without output is below the restart boundary");

  now = 12_000;
  await new Promise((resolve) => setTimeout(resolve, 8));

  assert.ok(sockets.length > initialCount, "the default recovery threshold must not exceed two seconds");
  assert.equal(
    broadcasts.filter((message) => message.type === "subtitle:status"
      && message.status === "recovering"
      && message.reason === "stall_watchdog").length,
    1,
    "one stalled speech window must trigger exactly one immediate rebuild",
  );

  await manager.stop();
});

test("subtitle output re-arms the two-second stall window during continuous speech", async () => {
  const sockets = [];
  const broadcasts = [];
  let now = 20_000;
  const manager = buildManager({
    broadcasts,
    sockets,
    watchdog: { intervalMs: 2 },
    now: () => now,
  });

  await manager.start({ sessionId: "output-rearms-window" });
  const initialCount = sockets.length;
  await new Promise((resolve) => setTimeout(resolve, 5));
  sockets[0].emit("message", JSON.stringify({ setupComplete: {} }));
  manager.noteInputSignal({ sessionId: "output-rearms-window" });

  now = 21_900;
  sockets[0].emit("message", JSON.stringify({
    serverContent: {
      interimInputTranscription: { text: "오늘 회의를 시작하겠습니다.", languageCode: "ko" },
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(broadcasts.some((message) => message.type === "subtitle:partial"), "test setup must produce visible output");

  now = 23_899;
  manager.noteInputSignal({ sessionId: "output-rearms-window" });
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.equal(sockets.length, initialCount, "recent output resets the no-output timer");

  now = 23_900;
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.ok(sockets.length > initialCount, "a new two-second output gap is detected during the same speech window");

  await manager.stop();
});

test("system output cannot hide a simultaneous stalled microphone source", async () => {
  const sockets = [];
  const broadcasts = [];
  let now = 30_000;
  const manager = buildManager({
    broadcasts,
    sockets,
    subtitle: { inputMode: "system_mic" },
    watchdog: { intervalMs: 2 },
    now: () => now,
  });

  await manager.start({ sessionId: "source-isolated-watchdog" });
  const initialCount = sockets.length;
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0].emit("message", JSON.stringify({ setupComplete: {} }));
  manager.noteInputSignal({ sessionId: "source-isolated-watchdog", source: "mic" });

  now = 31_900;
  sockets[0].emit("message", JSON.stringify({
    serverContent: {
      interimInputTranscription: { text: "오늘 시스템 오디오 번역은 정상입니다.", languageCode: "ko" },
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(broadcasts.some((message) => message.type === "subtitle:partial" && message.source === "system"));

  now = 32_000;
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.ok(sockets.length > initialCount, "mic liveness must be independent from healthy system captions");

  await manager.stop();
});

test("retired channel handlers cannot affect the rebuilt session", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = buildManager({ broadcasts, sockets });

  await manager.start({ sessionId: "generation-fence" });
  const retiredSocket = sockets[0];
  const initialCount = sockets.length;
  const restarting = manager.restartChannels({ reason: "generation_fence_test" });
  await new Promise((resolve) => setImmediate(resolve));
  for (const socket of sockets.slice(initialCount)) {
    socket.emit("message", JSON.stringify({ setupComplete: {} }));
  }
  await restarting;
  broadcasts.length = 0;

  retiredSocket.emit("error", new Error("late retired provider failure"));
  retiredSocket.emit("unexpected-response", null, { statusCode: 407, statusMessage: "retired proxy" });
  retiredSocket.emit("close", 1011, Buffer.from("retired close"));

  assert.equal(
    broadcasts.some((message) => message.type === "subtitle:error"
      || message.type === "subtitle:audio-control"
      || message.status === "reconnecting"),
    false,
    "late error, unexpected-response, and close callbacks must be fenced out",
  );

  await manager.stop();
});

test("a delayed restart cannot tear down a newer session", async () => {
  const sockets = [];
  const broadcasts = [];
  let loadCount = 0;
  const saved = {
    apiKeys: { gemini: "AIza-test" },
    subtitle: { translationProvider: "gemini", inputMode: "mic", languagePair: { a: "en", b: "ko" } },
  };
  /** @type {(value: typeof saved) => void} */
  let releaseDelayedLoad = () => {};
  /** @type {Promise<typeof saved>} */
  const delayedLoad = new Promise((resolve) => { releaseDelayedLoad = resolve; });
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => {
        loadCount += 1;
        if (loadCount === 2) return delayedLoad;
        return saved;
      },
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      setImmediate(() => socket.emit("open"));
      return socket;
    },
    log: { warn() {} },
  });

  await manager.start({ sessionId: "old-session" });
  const delayedRestart = manager.restartChannels({ reason: "delayed" });
  await new Promise((resolve) => setImmediate(resolve));
  await manager.start({ sessionId: "new-session" });
  const newSessionSockets = sockets.slice(-1);

  releaseDelayedLoad(saved);
  assert.equal(await delayedRestart, false, "the obsolete restart must abort after its awaited load");
  assert.equal(manager._state.sessionId, "new-session");
  assert.equal(newSessionSockets.every((socket) => !socket.closed && !socket.terminated), true);

  await manager.stop();
});

test("stall watchdog stays quiet while subtitles are flowing or nobody speaks", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = buildManager({
    broadcasts,
    sockets,
    watchdog: { intervalMs: 15, stallMs: 60, cooldownMs: 200 },
  });

  await manager.start({ sessionId: "active" });
  const initialCount = sockets.length;

  // Case 1: silence — no input signal at all. No restart.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(sockets.length, initialCount, "silence must not trigger a restart");

  // Case 2: speech WITH subtitle output flowing. No restart.
  let outputSequence = 0;
  const signalTimer = setInterval(() => {
    outputSequence += 1;
    manager.noteInputSignal({ sessionId: "active" });
    sockets[0].emit("message", JSON.stringify({
      serverContent: {
        interimInputTranscription: { text: `안녕하세요 오늘 발표를 시작하겠습니다 ${outputSequence}`, languageCode: "ko" },
      },
    }));
  }, 10);
  await new Promise((resolve) => setTimeout(resolve, 140));
  clearInterval(signalTimer);
  assert.equal(sockets.length, initialCount, "active output must not trigger a restart");

  await manager.stop();
});

// Task 6: engine hot swap must open the replacement socket before tearing
// down the old one, so a settings save never produces a silent caption gap
// wider than the new provider's connect time.
test("restartChannels opens the replacement socket before closing the old one", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = buildManager({ broadcasts, sockets });

  await manager.start({ sessionId: "fixture" });
  await new Promise((resolve) => setImmediate(resolve));
  const first = sockets.at(-1);
  first.emit("message", JSON.stringify({ setupComplete: {} }));

  const restart = manager.restartChannels({ reason: "engine_change" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 2, "a new socket was created");
  assert.equal(first.closed, undefined, "old socket still open while the new one connects");

  sockets.at(-1).emit("message", JSON.stringify({ setupComplete: {} }));
  assert.equal(await restart, true);
  assert.equal(first.closed, true);
  const statuses = broadcasts
    .filter((message) => message.type === "subtitle:status")
    .map((message) => `${message.status}:${message.reason ?? ""}`);
  assert.ok(statuses.includes("recovering:engine_change"));
  assert.equal(statuses.at(-1), "listening:");

  await manager.stop();
});

// Fix round 1: if the replacement engine cannot even be constructed (e.g. an
// invalid engine selection reaching the transport factory), restartChannels
// must resolve false - never reject - after closing the still-live previous
// channels and reporting the failure, leaving exactly one generation of
// clients (zero, since the replacement never got one either) behind.
test("restartChannels resolves false and cleans up when the replacement engine cannot be constructed", async () => {
  const sockets = [];
  const broadcasts = [];
  let transportCalls = 0;
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: { translationProvider: "gemini", inputMode: "mic", languagePair: { a: "en", b: "ko" } },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      setImmediate(() => socket.emit("open"));
      return socket;
    },
    log: { warn() {} },
    polish: async () => "This is a translated caption.",
    partialTranslationDebounceMs: 0,
    // First call (start()) builds the real transport so the first socket
    // behaves normally; the second call (restartChannels's replacement)
    // simulates an engine selection that fails to construct at all.
    createSttTransport: (args) => {
      transportCalls += 1;
      if (transportCalls === 2) throw new Error("ENGINE_SELECTION_INVALID");
      return createRealSttTransport(args);
    },
  });

  await manager.start({ sessionId: "engine-restart-failure" });
  await new Promise((resolve) => setImmediate(resolve));
  const first = sockets.at(-1);
  first.emit("message", JSON.stringify({ setupComplete: {} }));

  const restarted = await manager.restartChannels({ reason: "engine_change" });
  assert.equal(restarted, false, "a construction failure must resolve false, not reject");
  assert.equal(first.closed, true, "the old socket was closed");
  const failure = broadcasts.find((message) => message.type === "subtitle:error"
    && message.code === "ENGINE_RESTART_FAILED");
  assert.ok(failure, "subtitle:error with ENGINE_RESTART_FAILED was broadcast");
  assert.equal(manager._state.clients.size, 0, "no client generation is left dangling");

  await manager.stop();
});
