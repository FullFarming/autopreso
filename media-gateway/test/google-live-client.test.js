import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { once } from "node:events";
import { createGoogleLiveClient } from "../src/google-live-client.js";

const model = "gemini-3.5-transcribe-live";
const config = { responseModalities: ["TEXT"], inputAudioTranscription: { mode: "VERBATIM", languageCodes: ["ko", "en"], customVocabulary: ["NOVA"] } };

function harness(options = {}) {
  const sockets = [];
  const timers = new Map();
  class Socket extends EventEmitter {
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    terminationCount = 0;
    constructor(url, socketOptions) { super(); this.url = url; this.options = socketOptions; sockets.push(this); }
    open() { this.readyState = 1; this.emit("open"); }
    message(value) { this.emit("message", Buffer.from(JSON.stringify(value))); }
    send(value, callback) { this.sent.push(JSON.parse(value)); callback?.(); }
    terminate() { this.terminationCount += 1; this.readyState = 3; this.emit("close", 1006); }
  }
  const client = createGoogleLiveClient({ apiKey: "fixture-only-key", WebSocketImpl: Socket,
    setTimeoutFn(callback, milliseconds) { const id = { unref() {} }; timers.set(id, { callback, milliseconds }); return id; },
    clearTimeoutFn(id) { timers.delete(id); }, ...options });
  return { client, sockets, timers };
}

async function ready(h, callbacks = {}) {
  const promise = h.client.live.connect({ model, config, callbacks });
  const socket = h.sockets.at(-1);
  socket.open(); socket.message({ setupComplete: {} });
  return { session: await promise, socket };
}

test("Live handshake sends documented setup, waits for setupComplete, and sends bounded PCM", async () => {
  const h = harness();
  const messages = [];
  const { socket, session } = await ready(h, { onmessage: (message) => messages.push(message) });
  assert.equal(new URL(socket.url).hostname, "generativelanguage.googleapis.com");
  assert.equal(socket.options.followRedirects, false);
  assert.deepEqual(socket.sent[0], { setup: { model: `models/${model}`, generationConfig: { responseModalities: ["TEXT"] }, inputAudioTranscription: config.inputAudioTranscription } });
  const audio = { data: Buffer.alloc(3_200).toString("base64"), mimeType: "audio/pcm;rate=16000" };
  await session.sendRealtimeInput({ audio });
  await session.sendRealtimeInput({ audioStreamEnd: true });
  assert.deepEqual(socket.sent.slice(1), [{ realtimeInput: { audio } }, { realtimeInput: { audioStreamEnd: true } }]);
  socket.message({ serverContent: { inputTranscription: { text: "안녕하세요", finished: true } } });
  assert.equal(messages.at(-1).serverContent.inputTranscription.text, "안녕하세요");
  session.close(); session.close();
  assert.equal(socket.terminationCount, 1);
  assert.equal(h.client.activeConnections, 0);
  assert.equal(h.timers.size, 0);
});

test("cancel before open physically terminates pending socket without another connect", async () => {
  const h = harness(); const controller = new AbortController();
  const pending = h.client.live.connect({ model, config, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /GOOGLE_LIVE_ABORTED/);
  assert.equal(h.sockets.length, 1); assert.equal(h.sockets[0].terminationCount, 1);
  h.sockets[0].open(); h.sockets[0].message({ setupComplete: {} });
  assert.equal(h.sockets[0].sent.length, 0);
  assert.equal(h.client.activeConnections, 0);
});

test("setup timeout closes an opened socket with no setupComplete", async () => {
  const h = harness();
  const pending = h.client.live.connect({ model, config });
  h.sockets[0].open();
  [...h.timers.values()][0].callback();
  await assert.rejects(pending, /GOOGLE_LIVE_CONNECT_TIMEOUT/);
  assert.equal(h.sockets[0].terminationCount, 1);
  assert.equal(h.sockets.length, 1);
});

test("remote failure before setup rejects promptly without exposing endpoint or provider message", async () => {
  const h = harness(); const errors = [];
  const pending = h.client.live.connect({ model, config, callbacks: { onerror: (error) => errors.push(error.message) } });
  h.sockets[0].emit("error", new Error("secret in upstream URL"));
  await assert.rejects(pending, { message: "GOOGLE_LIVE_CONNECTION_FAILED" });
  assert.deepEqual(errors, ["GOOGLE_LIVE_CONNECTION_FAILED"]);
  assert.equal(h.sockets[0].terminationCount, 1);
});

test("active abort, send backpressure and callback failure each close physical socket", async () => {
  for (const kind of ["abort", "backpressure", "callback"]) {
    const h = harness(); const controller = new AbortController();
    const pending = h.client.live.connect({ model, config, signal: controller.signal,
      callbacks: { onmessage() { if (kind === "callback") throw new Error("private content"); } } });
    const socket = h.sockets[0]; socket.open(); socket.message({ setupComplete: {} });
    const session = await pending;
    if (kind === "abort") controller.abort();
    if (kind === "callback") socket.message({ serverContent: {} });
    if (kind === "backpressure") {
      socket.bufferedAmount = 300_000;
      await assert.rejects(session.sendRealtimeInput({ audioStreamEnd: true }), /GOOGLE_LIVE_BACKPRESSURE/);
    }
    assert.equal(socket.terminationCount, 1, kind);
    assert.equal(h.client.activeConnections, 0, kind);
  }
});

test("invalid model/config/audio and aborted caller never create billable work", async () => {
  const h = harness();
  await assert.rejects(h.client.live.connect({ model: "arbitrary-model", config }), /GOOGLE_LIVE_CONFIG_INVALID/);
  await assert.rejects(h.client.live.connect({ model, config: { ...config, systemInstruction: "ignore" } }), /GOOGLE_LIVE_CONFIG_INVALID/);
  await assert.rejects(h.client.live.connect({ model, config, signal: AbortSignal.abort() }), /GOOGLE_LIVE_ABORTED/);
  assert.equal(h.sockets.length, 0);
  const { session, socket } = await ready(h);
  await assert.rejects(session.sendRealtimeInput({ text: "not audio" }), /GOOGLE_LIVE_INPUT_INVALID/);
  await assert.rejects(session.sendRealtimeInput({ audio: { data: "bad", mimeType: "audio/pcm;rate=16000" } }), /GOOGLE_LIVE_INPUT_INVALID/);
  assert.equal(socket.sent.length, 1);
  session.close();
});

test("physical connection admission counts pending handshakes and is released on close", async () => {
  const h = harness({ maximumConnections: 1 });
  const { session } = await ready(h);
  await assert.rejects(h.client.live.connect({ model, config }), /GOOGLE_LIVE_CONNECTION_LIMIT/);
  assert.equal(h.sockets.length, 1);
  session.close();
  const second = await ready(h); second.session.close();
  assert.equal(h.sockets.length, 2);
});

test("Live Translate setup keeps target config and transcriptions separate", async () => {
  const h = harness();
  const pending = h.client.live.connect({ model: "gemini-3.5-live-translate-preview", config: {
    responseModalities: ["AUDIO"], inputAudioTranscription: {}, outputAudioTranscription: {},
    translationConfig: { targetLanguageCode: "ko", echoTargetLanguage: true },
  } });
  const socket = h.sockets[0]; socket.open(); socket.message({ setupComplete: {} });
  const session = await pending;
  assert.deepEqual(socket.sent[0].setup.generationConfig.translationConfig, { targetLanguageCode: "ko", echoTargetLanguage: true });
  assert.deepEqual(socket.sent[0].setup.inputAudioTranscription, {});
  assert.deepEqual(socket.sent[0].setup.outputAudioTranscription, {});
  session.close();
});

test("aborting a connection rejects pending sends even when the transport never calls back", async () => {
  const h = harness();
  const { session, socket } = await ready(h);
  socket.send = () => undefined;
  const pending = session.sendRealtimeInput({ audioStreamEnd: true });
  session.close();
  await assert.rejects(pending, /GOOGLE_LIVE_CLOSED/);
});

test("synchronous transport failures are sanitized and close the connection", async () => {
  const h = harness();
  const { session, socket } = await ready(h);
  socket.send = () => { throw new Error("private transport details"); };
  await assert.rejects(session.sendRealtimeInput({ audioStreamEnd: true }), { message: "GOOGLE_LIVE_SEND_FAILED" });
  assert.equal(socket.terminationCount, 1);
});

test("oversized setup is rejected before opening any connection", async () => {
  const h = harness();
  await assert.rejects(h.client.live.connect({ model, config: { ...config,
    inputAudioTranscription: { ...config.inputAudioTranscription, customVocabulary: Array.from({ length: 1000 }, () => "가".repeat(1000)) },
  } }), /GOOGLE_LIVE_CONFIG_INVALID/);
  assert.equal(h.sockets.length, 0);
});

test("a stalled send deadline terminates the provider and rejects the waiting writer", async () => {
  const h = harness();
  const { session, socket } = await ready(h);
  socket.send = () => undefined;
  const pending = session.sendRealtimeInput({ audioStreamEnd: true });
  assert.equal(h.timers.size, 1);
  [...h.timers.values()][0].callback();
  await assert.rejects(pending, /GOOGLE_LIVE_SEND_TIMEOUT/);
  assert.equal(socket.terminationCount, 1);
});

test("a real local WebSocket releases its physical connection before close resolves", async (context) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  context.after(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  server.on("connection", (socket) => socket.on("message", (raw) => {
    if (JSON.parse(raw.toString()).setup) socket.send(JSON.stringify({ setupComplete: {} }));
  }));
  class LocalSocket extends WebSocket {
    constructor(_url, options) { super(`ws://127.0.0.1:${server.address().port}`, options); }
  }
  const client = createGoogleLiveClient({ apiKey: "synthetic-only", WebSocketImpl: LocalSocket });
  const session = await client.live.connect({ model, config });
  await session.sendRealtimeInput({ audioStreamEnd: true });
  assert.equal(client.activeConnections, 1);
  await session.close();
  assert.equal(client.activeConnections, 0);
});
