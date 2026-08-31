import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

test("translate close waits for physical closure and never claims a hanging close succeeded", async () => {
  for (const stalled of [false, true]) {
    let release;
    const physical = new Promise((resolve) => { release = resolve; });
    const h = harness({ drainMilliseconds: 1, shutdownTimeoutMilliseconds: 25 });
    h.provider.close = () => physical;
    const session = await h.adapter.open({ onTranscript() {} });
    let resolved = false;
    const closing = session.close().then((result) => { resolved = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(resolved, false, "physical close is still pending");
    if (!stalled) release();
    const result = await closing;
    assert.equal(result.transportClosed, !stalled);
    assert.equal(result.errorCode, stalled ? "LIVE_TRANSLATE_DRAIN_TIMEOUT" : null);
    if (stalled) release();
  }
});
import { GeminiLiveTranslateAdapter } from "../src/gemini-live-translate-adapter.js";
import { createGoogleLiveClient } from "../src/google-live-client.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(options = {}) {
  const requests = [];
  const writes = [];
  let closes = 0;
  const provider = {
    sendRealtimeInput(value) { writes.push(value); },
    close() { closes += 1; },
  };
  const client = { live: { async connect(request) { requests.push(request); return provider; } } };
  const adapter = new GeminiLiveTranslateAdapter({ client, targetLanguageCode: "ko", drainMilliseconds: 5, ...options });
  return { adapter, requests, writes, provider, get closes() { return closes; } };
}

function wireHarness() {
  const sockets = [];
  class Socket extends EventEmitter {
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    terminations = 0;
    constructor() { super(); sockets.push(this); }
    open() { this.readyState = 1; this.emit("open"); }
    message(value) { this.emit("message", Buffer.from(JSON.stringify(value))); }
    send(value, callback) { this.sent.push(JSON.parse(value)); callback?.(); }
    terminate() { this.terminations += 1; this.readyState = 3; this.emit("close", 1006); }
  }
  const client = createGoogleLiveClient({ apiKey: "fixture-only-key", WebSocketImpl: Socket });
  const adapter = new GeminiLiveTranslateAdapter({ client, targetLanguageCode: "en", drainMilliseconds: 5 });
  return { sockets, client, adapter };
}

test("translate adapter and cancellable wire client preserve the fixed target and terminate after bounded drain", async () => {
  const h = wireHarness();
  const transcripts = [];
  const pending = h.adapter.open({ onTranscript: (event) => transcripts.push(event) });
  const socket = h.sockets[0];
  socket.open();
  socket.message({ setupComplete: {} });
  const session = await pending;
  assert.deepEqual(socket.sent[0], { setup: {
    model: "models/gemini-3.5-live-translate-preview",
    generationConfig: { responseModalities: ["AUDIO"], translationConfig: { targetLanguageCode: "en", echoTargetLanguage: true } },
    inputAudioTranscription: {}, outputAudioTranscription: {},
  } });
  socket.message({ serverContent: { inputTranscription: { text: "안녕하세요", languageCode: "ko" } } });
  socket.message({ serverContent: { outputTranscription: { text: "Hello", languageCode: "en", finished: true } } });
  await session.sendAudio(Buffer.alloc(1280));
  const result = await session.close();
  assert.deepEqual(transcripts.map((event) => event.direction), ["input", "output"]);
  assert.equal(socket.sent.filter((message) => message.realtimeInput?.audio).length, 1);
  assert.equal(socket.sent.filter((message) => message.realtimeInput?.audioStreamEnd).length, 1);
  assert.equal(result.protocolCompletionVerified, false);
  assert.equal(result.errorCode, null);
  assert.equal(h.client.activeConnections, 0);
  assert.equal(socket.terminations, 1);
});

test("translate adapter cancels a physical wire connection before setup, without a returned session handle", async () => {
  const h = wireHarness();
  const controller = new AbortController();
  const pending = h.adapter.open({ onTranscript() {}, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /LIVE_TRANSLATE_ABORTED/);
  assert.equal(h.client.activeConnections, 0);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].terminations, 1);
  h.sockets[0].open();
  h.sockets[0].message({ setupComplete: {} });
  assert.equal(h.sockets[0].sent.length, 0);
});

test("fixed target AUDIO echo session preserves independent raw transcription observations", async () => {
  const h = harness();
  const transcripts = [];
  const boundaries = [];
  const session = await h.adapter.open({ onTranscript: (event) => transcripts.push(event), onBoundary: (event) => boundaries.push(event) });
  const request = h.requests[0];
  assert.equal(request.model, "gemini-3.5-live-translate-preview");
  assert.deepEqual(request.config.translationConfig, { targetLanguageCode: "ko", echoTargetLanguage: true });
  assert.deepEqual(request.config.responseModalities, ["AUDIO"]);
  assert.deepEqual(request.config.inputAudioTranscription, {});
  assert.deepEqual(request.config.outputAudioTranscription, {});
  assert.equal(request.signal, request.config.abortSignal);
  assert.equal("systemInstruction" in request.config, false);
  request.callbacks.onmessage({ serverContent: { outputTranscription: { text: " 네,", languageCode: "ko" } } });
  request.callbacks.onmessage({ serverContent: { inputTranscription: { text: "yes, yes", languageCode: "en", finished: true } } });
  request.callbacks.onmessage({ serverContent: { outputTranscription: { text: " 네", languageCode: "ko" } } });
  request.callbacks.onmessage({ serverContent: { outputTranscription: { finished: true }, generationComplete: true, turnComplete: true } });
  await tick();
  assert.deepEqual(transcripts.map(({ direction, text, finished }) => ({ direction, text, finished })), [
    { direction: "output", text: " 네,", finished: null },
    { direction: "input", text: "yes, yes", finished: true },
    { direction: "output", text: " 네", finished: null },
    { direction: "output", text: "", finished: true },
  ]);
  assert.deepEqual(transcripts.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.ok(transcripts.every((event) => !("sourceId" in event) && !("isFinal" in event)));
  assert.equal(session.exactSourceCorrespondence, false);
  assert.equal(session.transcriptTextSemantics, "unverified");
  assert.equal(boundaries[0].turnComplete, true);
  assert.equal((await session.close()).protocolCompletionVerified, false);
});

test("40ms PCM frames are copied at admission, sent in 100ms chunks, and never replayed across end markers", async () => {
  const h = harness();
  const session = await h.adapter.open({ onTranscript() {} });
  const frame = Buffer.alloc(1280, 3);
  const firstWrite = session.sendAudio(frame);
  frame.fill(9);
  await firstWrite;
  await session.sendAudio(Buffer.alloc(1280, 4));
  await session.sendAudio(Buffer.alloc(1280, 5));
  await session.audioStreamEnd();
  await session.audioStreamEnd();
  const audio = h.writes.filter((value) => value.audio).map((value) => Buffer.from(value.audio.data, "base64"));
  assert.equal(audio.length, 2);
  assert.ok(audio.every((value) => value.length === 3200));
  assert.deepEqual(Buffer.concat(audio).subarray(0, 3840), Buffer.concat([Buffer.alloc(1280, 3), Buffer.alloc(1280, 4), Buffer.alloc(1280, 5)]));
  assert.ok(Buffer.concat(audio).subarray(3840).every((value) => value === 0));
  const closing = session.close();
  assert.equal(session.close(), closing);
  await closing;
  assert.equal(h.writes.filter((value) => value.audioStreamEnd).length, 1);
  assert.equal(h.closes, 1);
  await assert.rejects(session.sendAudio(Buffer.alloc(1280)), /LIVE_TRANSLATE_CLOSED/);
});

test("connect deadline aborts the actual connector and closes a late resolved session", async () => {
  const late = deferred();
  let request;
  let closes = 0;
  const h = harness({ connectTimeoutMilliseconds: 5, client: { live: { connect(value) { request = value; return late.promise; } } } });
  await assert.rejects(h.adapter.open({ onTranscript() {} }), /LIVE_TRANSLATE_CONNECT_TIMEOUT/);
  assert.equal(request.signal.aborted, true);
  late.resolve({ sendRealtimeInput() {}, close() { closes += 1; } });
  await tick();
  assert.equal(closes, 1);
});

test("abort before or during setup never sends PCM or reconnects", async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness();
  await assert.rejects(h.adapter.open({ onTranscript() {}, signal: controller.signal }), /LIVE_TRANSLATE_ABORTED/);
  assert.equal(h.requests.length, 0);
  const nextController = new AbortController();
  const pending = deferred();
  let request;
  const next = harness({ client: { live: { connect(value) { request = value; return pending.promise; } } } });
  const opening = next.adapter.open({ onTranscript() {}, signal: nextController.signal });
  nextController.abort();
  await assert.rejects(opening, /LIVE_TRANSLATE_ABORTED/);
  assert.equal(request.signal.aborted, true);
});

test("audio backpressure terminates once rather than silently dropping admitted speech", async () => {
  const gate = deferred();
  const h = harness({ maxPendingFrames: 1 });
  h.provider.sendRealtimeInput = () => gate.promise;
  const session = await h.adapter.open({ onTranscript() {} });
  await session.sendAudio(Buffer.alloc(1280));
  await session.sendAudio(Buffer.alloc(1280));
  const blocked = session.sendAudio(Buffer.alloc(1280));
  await assert.rejects(session.sendAudio(Buffer.alloc(1280)), /LIVE_TRANSLATE_AUDIO_BACKPRESSURE/);
  gate.resolve();
  await assert.rejects(blocked, /LIVE_TRANSLATE_AUDIO_BACKPRESSURE/);
  assert.equal(h.closes, 1);
  await session.close();
});

test("slow transcript consumer is bounded", async () => {
  const gate = deferred();
  const errors = [];
  const h = harness({ maxPendingEvents: 1 });
  const session = await h.adapter.open({ onTranscript: () => gate.promise, onError: (error) => errors.push(error.message) });
  h.requests[0].callbacks.onmessage({ serverContent: { inputTranscription: { text: "one" } } });
  h.requests[0].callbacks.onmessage({ serverContent: { inputTranscription: { text: "two" } } });
  assert.deepEqual(errors, ["LIVE_TRANSLATE_EVENT_BACKPRESSURE"]);
  assert.equal(h.closes, 1);
  gate.resolve();
  await session.close();
});

test("consumer rejection and transport exception expose only fixed error codes", async () => {
  const secret = "provider-private-detail";
  const h = harness();
  const errors = [];
  const session = await h.adapter.open({ onTranscript: () => Promise.reject(new Error(secret)), onError: (error) => errors.push(error.message) });
  h.requests[0].callbacks.onmessage({ serverContent: { inputTranscription: { text: "one" } } });
  await tick();
  assert.deepEqual(errors, ["LIVE_TRANSLATE_CONSUMER_FAILED"]);
  await session.close();
  const next = harness();
  next.provider.sendRealtimeInput = () => { throw new Error(secret); };
  const nextSession = await next.adapter.open({ onTranscript() {} });
  await nextSession.sendAudio(Buffer.alloc(1280));
  await nextSession.sendAudio(Buffer.alloc(1280));
  await assert.rejects(nextSession.sendAudio(Buffer.alloc(1280)), { message: "LIVE_TRANSLATE_WRITE_FAILED" });
  assert.equal(next.closes, 1);
  await nextSession.close();
});

test("continued input after an end marker has its own tail and emits a new end once", async () => {
  const h = harness();
  const session = await h.adapter.open({ onTranscript() {} });
  await session.sendAudio(Buffer.alloc(1280, 1));
  await session.audioStreamEnd();
  await session.sendAudio(Buffer.alloc(1280, 2));
  await session.close();
  assert.deepEqual(h.writes.map((value) => value.audioStreamEnd ? "end" : Buffer.from(value.audio.data, "base64")[0]), [1, "end", 2, "end"]);
});

test("a GoAway is an observation, never an invented final or automatic reconnection", async () => {
  const h = harness();
  const boundaries = [];
  const session = await h.adapter.open({ onTranscript() {}, onBoundary: (event) => boundaries.push(event) });
  h.requests[0].callbacks.onmessage({ goAway: { timeLeft: "10s" } });
  await tick();
  assert.deepEqual(boundaries, [{ goAway: true, targetLanguageCode: "ko" }]);
  assert.equal(h.requests.length, 1);
  assert.equal((await session.close()).protocolCompletionVerified, false);
});

test("drain timeout aborts a stalled transport and never reports protocol completion", async () => {
  const gate = deferred();
  const h = harness({ shutdownTimeoutMilliseconds: 15 });
  h.provider.sendRealtimeInput = () => gate.promise;
  const session = await h.adapter.open({ onTranscript() {} });
  const result = await session.close();
  assert.equal(result.errorCode, "LIVE_TRANSLATE_DRAIN_TIMEOUT");
  assert.equal(result.protocolCompletionVerified, false);
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.closes, 1);
  gate.resolve();
});

test("late drain observations are delivered before close; post-close callbacks are inert", async () => {
  const events = [];
  const h = harness({ drainMilliseconds: 15 });
  const session = await h.adapter.open({ onTranscript: (event) => events.push(event) });
  const closing = session.close();
  h.requests[0].callbacks.onmessage({ serverContent: { outputTranscription: { text: "끝", finished: true } } });
  await closing;
  h.requests[0].callbacks.onmessage({ serverContent: { outputTranscription: { text: "늦음", finished: true } } });
  await tick();
  assert.equal(events.length, 1);
});

test("audio is discarded and usage is bounded numeric metadata only, with unknown usage kept null", async () => {
  const usage = [];
  const h = harness();
  const session = await h.adapter.open({ onTranscript() {}, onUsage: (value) => usage.push(value) });
  assert.equal(session.getUsage().providerUsage, null);
  h.requests[0].callbacks.onmessage({ usageMetadata: { promptTokenCount: 100, responseTokenCount: 12, totalTokenCount: 112, hiddenText: "never emit" }, serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(4800).toString("base64") } }] } } });
  await tick();
  assert.equal(session.getUsage().outputAudioMilliseconds, 100);
  assert.deepEqual(usage[0].providerUsage, { promptTokenCount: 100, responseTokenCount: 12, totalTokenCount: 112 });
  assert.equal(JSON.stringify(usage).includes("never emit"), false);
  await session.close();
});

test("invalid metadata, forbidden model/echo override, and oversize text fail closed", async () => {
  for (const options of [{ model: "gemini-3.7-flash" }, { echoTargetLanguage: false }, { targetLanguageCode: "not-a-language" }, { maxPendingFrames: Infinity }]) {
    assert.throws(() => harness(options), /LIVE_TRANSLATE_/);
  }
  for (const content of [{ outputTranscription: { text: "x".repeat(16001) } }, { inputTranscription: { text: "safe", finished: "true" } }, { outputTranscription: { text: "Hello", languageCode: "en" } }]) {
    const h = harness();
    const received = [];
    const session = await h.adapter.open({ onTranscript: (event) => received.push(event) });
    h.requests[0].callbacks.onmessage({ serverContent: content });
    await tick();
    assert.equal(h.closes, 1);
    assert.equal(received.length, 0);
    await session.close();
  }
});

test("application connection ceiling and provider errors terminate without automatic retry", async () => {
  const errors = [];
  const h = harness({ maxConnectionMilliseconds: 10 });
  const session = await h.adapter.open({ onTranscript() {}, onError: (error) => errors.push(error.message) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(errors, ["LIVE_TRANSLATE_CONNECTION_LIMIT"]);
  h.requests[0].callbacks.onerror(new Error("private provider detail"));
  assert.equal(h.requests.length, 1);
  assert.equal(h.closes, 1);
  assert.throws(() => session.assertDrained(), /LIVE_TRANSLATE_CONNECTION_LIMIT/);
  await session.close();
});
