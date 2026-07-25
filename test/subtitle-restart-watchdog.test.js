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

/** @param {any} options */
function buildManager({ broadcasts, sockets, watchdog } = {}) {
  return createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", languagePair: { a: "en", b: "ko" } },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      setImmediate(() => socket.emit("open"));
      return socket;
    },
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

  const restarted = await manager.restartChannels({ reason: "test" });
  assert.equal(restarted, true);
  assert.ok(sockets.length > initialCount, "new sockets are opened for the rebuilt channels");
  assert.equal(manager._state.sessionId, "active", "the session survives the rebuild");
  assert.equal(manager._state.active, true);

  // Audio continues to flow into the NEW channels under the same session id.
  await new Promise((resolve) => setImmediate(resolve));
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
  const signalTimer = setInterval(() => {
    manager.noteInputSignal({ sessionId: "active" });
    sockets[0].emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "안녕하세요 오늘 발표를 시작하겠습니다 " }));
    sockets[0].emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "Hello, let us begin today. " }));
  }, 10);
  await new Promise((resolve) => setTimeout(resolve, 140));
  clearInterval(signalTimer);
  assert.equal(sockets.length, initialCount, "active output must not trigger a restart");

  await manager.stop();
});
