// Queue-accumulation stall guards ("큐가 쌓이면 멈추는 현상"):
//  1. subtitle audio must never pile up in a slow translation socket's send
//     buffer — realtime audio is dropped (stay live) instead of queued forever,
//  2. a hung agent turn must never jam the transcript turn queue permanently,
//  3. the turn queue's overflow buffer must stay bounded,
//  4. subtitle history persistence must not rewrite settings.json on every
//     committed line (disk-write pileup),
//  5. settings-store writes are serialized + atomic so concurrent saves can't
//     interleave and corrupt settings.json.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";

import { createSubtitleRealtimeManager } from "../src/subtitle-realtime.js";
import { createTranscriptTurnQueue } from "../src/transcript-turn-queue.js";
import { createSubtitleHistory } from "../src/subtitle-history.js";
import { createSettingsStore } from "../src/settings-store.js";

class FakeSocket extends EventEmitter {
  constructor(url, init) {
    super();
    this.url = url;
    this.init = init;
    this.sent = [];
    this.readyState = WebSocket.OPEN;
    this.bufferedAmount = 0;
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

async function startManagerWithSockets() {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
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
  });
  await manager.start({ sessionId: "active" });
  await new Promise((resolve) => setImmediate(resolve));
  return { manager, sockets };
}

test("subtitle audio is dropped instead of queued when the translation socket backs up", async () => {
  const { manager, sockets } = await startManagerWithSockets();
  const socket = sockets[0];
  const before = socket.sent.length;

  manager.sendAudio({ sessionId: "active", source: "mic", audio: "AAAA" });
  assert.equal(socket.sent.length, before + 1, "audio flows while the socket buffer is empty");

  // The socket send buffer has backed up past the live threshold: new frames
  // must be DROPPED (stay realtime) instead of piling into memory until the
  // whole pipeline stalls.
  socket.bufferedAmount = 8 * 1024 * 1024;
  manager.sendAudio({ sessionId: "active", source: "mic", audio: "BBBB" });
  manager.sendAudio({ sessionId: "active", source: "mic", audio: "CCCC" });
  assert.equal(socket.sent.length, before + 1, "backed-up socket drops frames");

  // Buffer drained → audio resumes.
  socket.bufferedAmount = 0;
  manager.sendAudio({ sessionId: "active", source: "mic", audio: "DDDD" });
  assert.equal(socket.sent.length, before + 2, "audio resumes once the buffer drains");

  await manager.stop();
});

test("a hung turn cannot jam the transcript turn queue forever", async () => {
  const ran = [];
  const queue = createTranscriptTurnQueue({
    debounceMs: 0,
    turnTimeoutMs: 30,
    runTurn: async (text) => {
      ran.push(text);
      if (text === "hang") await new Promise(() => {});
    },
  });

  queue.enqueue("hang");
  queue.enqueue("after");
  // Without a turn timeout the queue stays `running` forever and "after" never
  // fires. With the timeout the queue must move on.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(ran, ["hang", "after"]);
});

test("turn queue overflow buffer stays bounded while a turn is running", async () => {
  let release = (..._args) => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const ran = [];
  const queue = createTranscriptTurnQueue({
    debounceMs: 0,
    maxBufferedChunks: 5,
    runTurn: async (text) => {
      ran.push(text);
      if (text === "first") await gate;
    },
  });

  queue.enqueue("first");
  for (let i = 0; i < 50; i += 1) queue.enqueue(`chunk-${i}`);
  release();
  await queue.idle();

  assert.equal(ran.length, 2, "buffered chunks coalesce into one follow-up turn");
  const followUp = ran[1].split("\n");
  assert.equal(followUp.length, 5, "only the most recent chunks are kept");
  assert.equal(followUp[followUp.length - 1], "chunk-49");
});

test("subtitle history batches disk writes instead of persisting every committed line", async () => {
  let saves = 0;
  const history = createSubtitleHistory({
    settingsStore: {
      load: async () => ({ subtitle: { recordProvider: "none" } }),
      save: async () => { saves += 1; },
    },
    persistDelayMs: 50,
  });

  for (let i = 0; i < 10; i += 1) {
    await history.record({ translatedText: `line ${i}`, source: "mic", targetLanguage: "en" });
  }
  assert.equal(saves, 0, "rapid committed lines do not each rewrite settings.json");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(saves, 1, "the batch persists once after the burst");
  assert.equal(history.getSnapshot().records.length, 10);
});

test("concurrent settings saves are serialized and the file stays valid JSON", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-store-"));
  const filePath = path.join(dir, "settings.json");
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: () => null });
  await store.load();

  await Promise.all(Array.from({ length: 25 }, (_, i) =>
    store.save({ subtitleHistory: { records: [{ translatedText: `r${i}`.repeat(2000) }] } })));

  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  assert.ok(parsed.subtitleHistory.records[0].translatedText.length > 0);
  const leftovers = (await fs.readdir(dir)).filter((name) => name !== "settings.json");
  assert.deepEqual(leftovers, [], "no temp files left behind");
});
