import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { OpenAIRealtimeTranslationAdapter, resamplePcm16Mono } from "../src/openai-realtime-translation.js";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
  }
  send(value) {
    const message = JSON.parse(value);
    this.sent.push(message);
    if (message.type === "session.close") queueMicrotask(() => this.emit("message", JSON.stringify({ type: "session.closed" })));
  }
  close() { this.readyState = 3; this.emit("close", 1000, Buffer.alloc(0)); }
  terminate() { this.readyState = 3; }
}

function createReadyAdapter(socket, options = {}) {
  return new OpenAIRealtimeTranslationAdapter({
    apiKey: "sk-secret",
    ...options,
    createWebSocket(url, protocols, connectionOptions) {
      options.onConnect?.({ url, protocols, connectionOptions });
      queueMicrotask(() => socket.emit("open"));
      queueMicrotask(() => socket.emit("message", JSON.stringify({ type: "session.updated" })));
      return socket;
    },
  });
}

test("OpenAI translation uses the official endpoint, server auth, and audio-only session", async () => {
  const socket = new FakeSocket();
  let connection;
  const adapter = createReadyAdapter(socket, { onConnect(value) { connection = value; } });
  const session = await adapter.open({ language: "ko", async onAudio() {} });
  assert.equal(connection.url, "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate");
  assert.equal(connection.connectionOptions.headers.Authorization, "Bearer sk-secret");
  assert.equal(connection.connectionOptions.headers["OpenAI-Safety-Identifier"], "realtime-noel-live-translation");
  assert.deepEqual(socket.sent[0], {
    type: "session.update",
    session: {
      audio: { output: { language: "ko" } },
    },
  });
  await session.close();
});

test("OpenAI translation resamples input to PCM16 24 kHz and emits only output audio", async () => {
  const socket = new FakeSocket();
  const audio = [];
  const adapter = createReadyAdapter(socket);
  const session = await adapter.open({ language: "ko", async onAudio(value) { audio.push(value); } });
  await session.sendAudio(new Uint8Array(1_280));
  const append = socket.sent.find((message) => message.type === "session.input_audio_buffer.append");
  assert.equal(Buffer.from(append.audio, "base64").byteLength, 1_920);
  socket.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "숨겨진 텍스트" }));
  socket.emit("message", JSON.stringify({ type: "session.output_audio.delta", delta: Buffer.from([1, 0, 2, 0]).toString("base64") }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(audio, [{ sampleRate: 24_000, pcm: Uint8Array.from([1, 0, 2, 0]) }]);
  await session.close();
});

test("OpenAI translation drops live input under socket backpressure and closes with session.close", async () => {
  const socket = new FakeSocket();
  const adapter = createReadyAdapter(socket, { maxBufferedBytes: 100, closeTimeoutMilliseconds: 20 });
  const session = await adapter.open({ language: "en", async onAudio() {} });
  socket.bufferedAmount = 101;
  assert.equal(await session.sendAudio(new Uint8Array(1_280)), false);
  const closing = session.close();
  assert.equal(socket.sent.at(-1).type, "session.close");
  await closing;
});

test("PCM resampling rejects malformed frames and preserves 16 kHz duration at 24 kHz", () => {
  assert.throws(() => resamplePcm16Mono(new Uint8Array(3), 16_000, 24_000), /INVALID_PCM16/u);
  assert.equal(resamplePcm16Mono(new Uint8Array(1_280), 16_000, 24_000).byteLength, 1_920);
});

test("OpenAI translation waits for the target-language session.updated acknowledgement", async () => {
  const socket = new FakeSocket();
  let didOpen = false;
  const adapter = new OpenAIRealtimeTranslationAdapter({
    apiKey: "sk-secret",
    createWebSocket() {
      queueMicrotask(() => socket.emit("open"));
      return socket;
    },
  });
  const opening = adapter.open({ language: "ko", async onAudio() {} }).then((session) => {
    didOpen = true;
    return session;
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit("message", JSON.stringify({ type: "session.created" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(didOpen, false);
  socket.emit("message", JSON.stringify({ type: "session.updated" }));
  const session = await opening;
  await session.close();
});

test("OpenAI translation terminates a socket that never acknowledges setup", async () => {
  const socket = new FakeSocket();
  let terminated = 0;
  socket.terminate = () => { terminated += 1; socket.readyState = 3; };
  const adapter = new OpenAIRealtimeTranslationAdapter({
    apiKey: "sk-secret",
    connectTimeoutMilliseconds: 5,
    createWebSocket() {
      queueMicrotask(() => socket.emit("open"));
      return socket;
    },
  });
  const rejected = assert.rejects(() => adapter.open({ language: "ko", async onAudio() {} }), /CONNECT_TIMEOUT/u);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await rejected;
  assert.equal(terminated, 1);
});

test("one rejected audio callback cannot poison later translated audio", async () => {
  const socket = new FakeSocket();
  const received = [];
  let callbacks = 0;
  const adapter = createReadyAdapter(socket);
  const session = await adapter.open({
    language: "ko",
    async onAudio(value) {
      callbacks += 1;
      if (callbacks === 1) throw new Error("PLAYER_RESET");
      received.push([...value.pcm]);
    },
  });
  socket.emit("message", JSON.stringify({ type: "session.output_audio.delta", delta: Buffer.from([1, 0]).toString("base64") }));
  socket.emit("message", JSON.stringify({ type: "session.output_audio.delta", delta: Buffer.from([2, 0]).toString("base64") }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [[2, 0]]);
  await session.close();
});
