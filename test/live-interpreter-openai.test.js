// @ts-nocheck - the hand-rolled socket intentionally implements only the provider surface.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  OPENAI_REALTIME_TRANSLATIONS_URL,
  createOpenAiRealtimeTranslationSession,
} from "../src/live-interpreter/index.js";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closed = 0;
    this.terminated = 0;
  }

  send(value) {
    this.sent.push(JSON.parse(String(value)));
  }

  close() {
    this.closed += 1;
  }

  terminate() {
    this.terminated += 1;
  }
}

function createSession(overrides = {}) {
  const socket = new FakeSocket();
  const calls = [];
  const events = [];
  const session = createOpenAiRealtimeTranslationSession({
    apiKey: "sk-secret",
    lane: "INBOUND",
    targetLanguage: "ko",
    onEvent: (event) => events.push(event),
    createWebSocket: (url, protocols, init) => {
      calls.push({ url, protocols, init });
      return socket;
    },
    ...overrides,
  });
  return { socket, calls, events, session };
}

test("OpenAI translation session uses the exact endpoint and language-only output contract", async () => {
  const { socket, calls, session } = createSession();
  const started = session.start();
  assert.equal(calls[0].url, OPENAI_REALTIME_TRANSLATIONS_URL);
  assert.equal(calls[0].url, "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer sk-secret");
  socket.emit("open");
  await started;

  assert.deepEqual(socket.sent, [{
    type: "session.update",
    session: { audio: { output: { language: "ko" } } },
  }]);
  const requestText = JSON.stringify(socket.sent);
  assert.equal(requestText.includes("voice"), false);
  assert.equal(requestText.includes("prompt"), false);
  assert.equal(requestText.includes("sk-secret"), false);
});

test("provider sends bounded continuous base64 PCM16 24k audio without commit messages", async () => {
  const { socket, session } = createSession({ maxAudioBytes: 4 });
  const started = session.start();
  socket.emit("open");
  await started;

  session.appendAudio("AQIDBA==");
  assert.deepEqual(socket.sent.at(-1), { type: "session.input_audio_buffer.append", audio: "AQIDBA==" });
  assert.equal(socket.sent.some((message) => message.type.includes("commit")), false);
  assert.throws(() => session.appendAudio("%%%"), /base64/u);
  assert.throws(
    () => session.appendAudio("AQIDBAU="),
    (error) => error instanceof Error && "code" in error && error.code === "AUDIO_SIZE_EXCEEDED",
  );
});

test("provider forwards only bounded sanitized audio and transcript deltas", async () => {
  const { socket, events, session } = createSession({ maxAudioDeltaBase64Chars: 8, maxTranscriptChars: 5 });
  const started = session.start();
  socket.emit("open");
  await started;
  socket.emit("message", Buffer.from(JSON.stringify({ type: "session.output_audio.delta", delta: "AQID" })));
  socket.emit("message", Buffer.from(JSON.stringify({ type: "session.output_transcript.delta", delta: "Cafe\u0301\u0000!!" })));
  socket.emit("message", Buffer.from(JSON.stringify({ type: "session.input_transcript.delta", delta: "hello\u0000!!" })));
  socket.emit("message", Buffer.from(JSON.stringify({ type: "session.output_audio.delta", delta: "AQIDBAUGBwg=" })));
  socket.emit("message", Buffer.from(JSON.stringify({ type: "provider.secret.body", apiKey: "sk-leak" })));

  assert.deepEqual(events.slice(-3), [
    { type: "output_audio_delta", audioBase64: "AQID" },
    { type: "output_transcript_delta", delta: "Café!" },
    { type: "input_transcript_delta", delta: "hello" },
  ]);
  assert.equal(JSON.stringify(events).includes("sk-leak"), false);
});

test("stop sends session.close and resolves only after session.closed", async () => {
  const { socket, session } = createSession();
  const started = session.start();
  socket.emit("open");
  await started;
  let stopped = false;
  const stopping = session.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.deepEqual(socket.sent.at(-1), { type: "session.close" });
  socket.emit("message", Buffer.from(JSON.stringify({ type: "session.closed" })));
  await stopping;
  assert.equal(stopped, true);
  assert.equal(socket.closed, 1);
  await session.stop();
  assert.equal(socket.sent.filter((message) => message.type === "session.close").length, 1);
});

test("close timeout fails closed and never returns raw provider details", async () => {
  const { socket, session } = createSession({ closeTimeoutMs: 5 });
  const started = session.start();
  socket.emit("open");
  await started;
  await assert.rejects(
    session.stop(),
    (error) => error instanceof Error
      && "code" in error
      && error.code === "OPENAI_CLOSE_TIMEOUT"
      && !error.message.includes("sk-secret"),
  );
  assert.equal(socket.terminated, 1);
});

test("missing key and connection failures use safe errors", async () => {
  const missing = createOpenAiRealtimeTranslationSession({
    apiKey: "",
    lane: "USER",
    targetLanguage: "en",
    onEvent() {},
    createWebSocket: () => { throw new Error("must not connect"); },
  });
  await assert.rejects(missing.start(), (error) => error.code === "OPENAI_API_KEY_REQUIRED");

  const { socket, session } = createSession();
  const started = session.start();
  socket.emit("error", new Error("upstream sk-secret raw body"));
  await assert.rejects(started, (error) => error.code === "OPENAI_CONNECTION_FAILED" && !error.message.includes("raw"));
});
