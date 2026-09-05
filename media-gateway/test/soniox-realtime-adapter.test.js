// The fake socket implements only the `ws` surface the adapter touches.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";

import { SonioxRealtimeAdapter } from "../src/engines/soniox-realtime-adapter.js";
import { SONIOX_CONTROL } from "../../packages/caption-core/soniox-protocol.js";

const FRAME = Buffer.alloc(1_280, 7);
const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  sent = [];
  closeCalls = 0;
  url = "";

  send(value) {
    if (this.readyState !== WebSocket.OPEN) throw new Error("fake socket: send before open");
    this.sent.push(value);
  }
  open() { this.readyState = WebSocket.OPEN; this.emit("open"); }
  close() {
    this.closeCalls += 1;
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1000, Buffer.alloc(0));
  }
  terminate() { this.close(); }
  message(payload) { this.emit("message", Buffer.from(JSON.stringify(payload), "utf8"), false); }
  finalizeCount() { return this.sent.filter((value) => value === SONIOX_CONTROL.finalize).length; }
  keepaliveCount() { return this.sent.filter((value) => value === SONIOX_CONTROL.keepalive).length; }
}

/** Deterministic clock: timers fire in deadline order while `advance` walks the clock forward. */
function createClock(start = 1_700_000_000_000) {
  let current = start;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(callback, delay) {
      sequence += 1;
      timers.set(sequence, { at: current + delay, callback });
      return sequence;
    },
    clearTimer(id) { timers.delete(id); },
    pending() { return [...timers.values()]; },
    async advance(milliseconds) {
      const target = current + milliseconds;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        current = Math.max(current, timer.at);
        timer.callback();
        await flush();
      }
      current = target;
      await flush();
    },
  };
}

async function openAdapter({ adapter: adapterOverrides = {}, callbacks = {}, autoOpen = true } = {}) {
  const clock = createClock();
  const sockets = [];
  const adapter = new SonioxRealtimeAdapter({
    apiKey: "fixture-key",
    languageMode: "auto",
    translation: true,
    translationLanguages: ["en", "ko"],
    glossaryText: "NOVA = 노바\nCRE",
    domainText: "commercial real estate",
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    createWebSocket: (url) => {
      const socket = new FakeSocket();
      socket.url = url;
      sockets.push(socket);
      if (autoOpen) queueMicrotask(() => socket.open());
      return socket;
    },
    ...adapterOverrides,
  });
  const finals = [];
  const partials = [];
  const translations = [];
  const discards = [];
  const stream = await adapter.open({
    onFinalUtterance: (utterance) => { finals.push(utterance); },
    onPartialTranscript: (partial) => { partials.push(partial); },
    onPartialTranslation: (translation) => { translations.push(translation); },
    onContinuityDiscard: (event) => { discards.push(event); },
    ...callbacks,
  });
  return { adapter, clock, sockets, socket: sockets[0], stream, finals, partials, translations, discards };
}

const sourceFinal = (text, { language = "ko", start_ms = 100, end_ms = 600 } = {}) =>
  ({ text, is_final: true, language, start_ms, end_ms });
const sourceProvisional = (text, language = "ko") => ({ text, is_final: false, language });
const translationToken = (text, { is_final, language = "en", source_language = "ko" }) =>
  ({ text, is_final, language, source_language, translation_status: "translation" });

test("(a) the first frame is the Soniox config and audio goes out as unchanged 1,280-byte binary frames", async () => {
  const { adapter, socket, stream } = await openAdapter();
  assert.equal(adapter.provider, "soniox");
  assert.equal(adapter.languageMode, "auto");
  assert.equal(adapter.translation, true);
  assert.equal(socket.url, "wss://stt-rt.soniox.com/transcribe-websocket");
  assert.equal(socket.sent.length, 1);
  assert.equal(typeof socket.sent[0], "string", "config travels as a TEXT frame");
  const config = JSON.parse(socket.sent[0]);
  assert.equal(config.model, "stt-rt-v5");
  assert.equal(config.api_key, "fixture-key");
  assert.equal(config.sample_rate, 16_000);
  assert.equal(config.audio_format, "pcm_s16le");
  assert.equal(config.language_hints_strict, false);
  assert.deepEqual(config.language_hints, ["en", "ko"]);
  assert.deepEqual(config.translation, { type: "two_way", language_a: "ko", language_b: "en" });
  assert.ok(config.context.terms.includes("NOVA"));
  assert.deepEqual(config.context.translation_terms, [{ source: "NOVA", target: "노바" }]);
  assert.deepEqual(config.context.general, [{ key: "domain", value: "commercial real estate" }]);
  assert.equal(JSON.stringify(adapter).includes("fixture-key"), false, "the key lives only in a private field");
  assert.equal(Object.values(adapter).includes("fixture-key"), false);

  await stream.sendAudio(new Uint8Array(FRAME));
  await stream.sendAudio(new Uint8Array(FRAME));
  assert.equal(socket.sent.length, 3);
  assert.ok(Buffer.isBuffer(socket.sent[1]), "audio is a binary frame");
  assert.equal(socket.sent[1].length, 1_280, "gateway PCM is already 16 kHz mono: no resampling, no coalescing");
  assert.ok(socket.sent[1].equals(FRAME));
  await assert.rejects(stream.sendAudio(new Uint8Array(1_000)), /STT_AUDIO_REQUEST_INVALID/u);
  assert.equal(stream.getUsage().inputAudioMilliseconds, 80);
  assert.equal(stream.supportsRolloverRemap, false);
  stream.abort();
});

test("(a') a transcription-only selection sends no translation block and validates the pair at construction", async () => {
  const { socket, stream } = await openAdapter({ adapter: { translation: false, translationLanguages: ["ko"], languageMode: "ko" } });
  const config = JSON.parse(socket.sent[0]);
  assert.equal("translation" in config, false);
  assert.deepEqual(config.language_hints, ["ko"]);
  stream.abort();
  assert.throws(() => new SonioxRealtimeAdapter({ apiKey: "fixture-key", translation: true, translationLanguages: ["en", "ko", "ja"] }), /SONIOX_TRANSLATION_TARGET_REQUIRED/u);
  assert.throws(() => new SonioxRealtimeAdapter({ apiKey: "", translation: false, translationLanguages: ["ko"] }), /SONIOX_API_KEY_REQUIRED/u);
});

test("(b) source final + translation final + <end> commit one utterance carrying the segment translation", async () => {
  const { clock, socket, stream, finals, partials, translations } = await openAdapter();
  socket.message({ tokens: [sourceFinal("안녕하세요")] });
  socket.message({ tokens: [translationToken("Hello", { is_final: false })] });
  await flush();
  assert.equal(typeof partials[0].segmentId, "string");
  assert.deepEqual(partials.map(({ segmentId, ...value }) => value), [{ text: "안녕하세요", sourceLanguage: "ko" }]);
  assert.equal(translations.length, 1);
  assert.equal(translations[0].language, "en");
  assert.equal(translations[0].text, "Hello");
  assert.equal(translations[0].sourceLanguage, "ko");
  assert.equal(typeof translations[0].segmentId, "string");
  assert.equal(finals.length, 0, "nothing commits before a boundary token");

  socket.message({ tokens: [translationToken("Hello", { is_final: true }), { text: "<end>", is_final: true }] });
  await flush();
  assert.equal(finals.length, 1);
  assert.equal(finals[0].segmentId, partials[0].segmentId);
  assert.deepEqual(finals[0], {
    segmentId: partials[0].segmentId,
    speakerLabel: "speaker-1",
    text: "안녕하세요",
    rawText: "안녕하세요",
    sourceLanguage: "ko",
    sourceStartOffsetMs: 100,
    sourceEndOffsetMs: 600,
    sourceEndedAt: new Date(clock.now()).toISOString(),
    translations: { en: { text: "Hello", sourceLanguage: "ko" } },
  });
  assert.equal(translations.length, 1, "a translation already final in the <end> frame produces no extra partial");
  stream.abort();
});

test("(c) a keepalive control frame goes out after 8 s of silence and never while audio flows", async () => {
  const { clock, socket, stream } = await openAdapter();
  await clock.advance(7_000);
  assert.equal(socket.keepaliveCount(), 0);
  await clock.advance(13_000);
  assert.ok(socket.keepaliveCount() >= 1, "20 s without audio produced a keepalive");
  const before = socket.keepaliveCount();
  for (let index = 0; index < 20; index += 1) {
    await stream.sendAudio(new Uint8Array(FRAME));
    await clock.advance(1_000);
  }
  assert.equal(socket.keepaliveCount(), before, "audio every second keeps the socket alive on its own");
  assert.equal(typeof socket.sent.find((value) => value === SONIOX_CONTROL.keepalive), "string", "keepalive is a TEXT frame");
  stream.abort();
});

test("(d) an unauthenticated error terminates the stream with SONIOX_UNAUTHENTICATED and never reconnects", async () => {
  const { clock, sockets, socket, stream, finals } = await openAdapter();
  socket.message({ error_type: "unauthenticated", error_message: "invalid api key", request_id: "req-1" });
  await flush();
  await assert.rejects(stream.sendAudio(new Uint8Array(FRAME)), /SONIOX_UNAUTHENTICATED/u);
  assert.throws(() => stream.assertDrained(), /SONIOX_UNAUTHENTICATED/u);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  await clock.advance(60_000);
  assert.equal(sockets.length, 1, "no reconnect after an auth failure");
  socket.message({ tokens: [sourceFinal("늦은 토큰"), { text: "<end>", is_final: true }] });
  await flush();
  assert.equal(finals.length, 0, "messages after the terminal error are ignored");
  await stream.close();
  assert.throws(() => stream.assertDrained(), /SONIOX_UNAUTHENTICATED/u);
});

test("(d') other provider error types map to the shared SONIOX_* codes", async () => {
  for (const [errorType, code] of [
    ["limit_exceeded", "SONIOX_RATE_LIMITED"],
    ["service_unavailable", "SONIOX_UNAVAILABLE"],
    ["invalid_request", "SONIOX_INVALID_REQUEST"],
    ["max_duration_reached", "SONIOX_MAX_DURATION"],
    ["something_new", "SONIOX_PROVIDER_FAILED"],
  ]) {
    const { socket, stream } = await openAdapter();
    socket.message({ error_type: errorType });
    await flush();
    assert.throws(() => stream.assertDrained(), new RegExp(code, "u"));
  }
  const { socket, stream } = await openAdapter();
  socket.emit("message", Buffer.from("not json", "utf8"), false);
  await flush();
  assert.throws(() => stream.assertDrained(), /SONIOX_MESSAGE_INVALID/u);
});

test("(e) gracefulDrain sends the empty TEXT frame and resolves on finished", async () => {
  const { clock, socket, stream } = await openAdapter();
  await stream.sendAudio(new Uint8Array(FRAME));
  let drained = false;
  const draining = stream.gracefulDrain().then(() => { drained = true; });
  await flush();
  assert.equal(socket.sent.at(-1), "", "end of audio is an EMPTY TEXT frame");
  assert.equal(socket.sent.some((value) => Buffer.isBuffer(value) && value.length === 0), false, "never an empty binary frame");
  assert.equal(drained, false);
  await clock.advance(4_000);
  assert.equal(drained, false);
  socket.message({ tokens: [{ text: "<end>", is_final: true }], finished: true });
  await draining;
  assert.equal(drained, true);
  assert.doesNotThrow(() => stream.assertDrained());
  await stream.close();

  const stalled = await openAdapter();
  const stalledDrain = assert.rejects(stalled.stream.gracefulDrain(), /STT_DRAIN_TIMEOUT/u);
  await flush();
  await stalled.clock.advance(5_000);
  await stalledDrain;
  assert.throws(() => stalled.stream.assertDrained(), /STT_DRAIN_TIMEOUT/u);
});

test("(e') finished with committed text and no boundary still commits the last utterance", async () => {
  const { socket, stream, finals } = await openAdapter();
  socket.message({ tokens: [sourceFinal("마지막 문장")] });
  const draining = stream.gracefulDrain();
  await flush();
  socket.message({ tokens: [], finished: true });
  await draining;
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, "마지막 문장");
  await stream.close();
});

test("(f) close drains, closes the socket, and resolves the transport summary", async () => {
  const { clock, socket, stream } = await openAdapter();
  for (let index = 0; index < 3; index += 1) await stream.sendAudio(new Uint8Array(FRAME));
  const closing = stream.close();
  await flush();
  assert.equal(socket.sent.at(-1), "");
  socket.message({ finished: true });
  const result = await closing;
  assert.deepEqual(result, { transportClosed: true, inputAudioMilliseconds: 120 });
  assert.equal(socket.closeCalls >= 1, true);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  assert.deepEqual(stream.getUsage(), { inputAudioMilliseconds: 120 });
  assert.equal(clock.pending().length, 0, "no keepalive, lifetime, or finalize timer survives close");
  assert.equal(await stream.close(), result, "close is idempotent");
  await assert.rejects(stream.sendAudio(new Uint8Array(FRAME)), /STT_STREAM_CLOSED/u);
});

test("(g) 1.2 s without new tokens while final text is pending sends exactly one finalize; <fin> commits like <end>", async () => {
  const { clock, socket, stream, finals } = await openAdapter();
  socket.message({ tokens: [sourceFinal("첫 문장", { start_ms: 0, end_ms: 900 })] });
  await clock.advance(1_199);
  assert.equal(socket.finalizeCount(), 0);
  await clock.advance(1);
  assert.equal(socket.finalizeCount(), 1);
  assert.equal(typeof socket.sent.at(-1), "string");
  assert.equal(socket.sent.at(-1), SONIOX_CONTROL.finalize);
  await clock.advance(5_000);
  assert.equal(socket.finalizeCount(), 1, "no re-send while the finalize is in flight");
  socket.message({ tokens: [translationToken("First sentence", { is_final: true }), { text: "<fin>", is_final: true }] });
  await flush();
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, "첫 문장");
  assert.equal(finals[0].speakerLabel, "speaker-1");
  assert.equal(finals[0].sourceStartOffsetMs, 0);
  assert.equal(finals[0].sourceEndOffsetMs, 900);
  assert.deepEqual(finals[0].translations, { en: { text: "First sentence", sourceLanguage: "ko" } });
  // The boundary re-arms the scheduler for the next segment.
  socket.message({ tokens: [sourceFinal("둘째 문장", { start_ms: 1_000, end_ms: 1_800 })] });
  await clock.advance(1_200);
  assert.equal(socket.finalizeCount(), 2);
  stream.abort();
});

test("(g') tokens every 500 ms for 15 s finalize once at the segment cap; a provisional-only stretch never finalizes", async () => {
  const capped = await openAdapter();
  for (let index = 0; index < 30; index += 1) {
    capped.socket.message({ tokens: [sourceFinal(`토큰${index} `, { start_ms: index * 500, end_ms: index * 500 + 400 })] });
    if (index === 29) assert.equal(capped.socket.finalizeCount(), 0, "still under the cap at 14.5 s");
    await capped.clock.advance(500);
  }
  assert.equal(capped.socket.finalizeCount(), 1, "one finalize exactly at the 15 s segment cap");
  await capped.clock.advance(3_000);
  assert.equal(capped.socket.finalizeCount(), 1);
  capped.stream.abort();

  const provisional = await openAdapter();
  for (let index = 0; index < 40; index += 1) {
    provisional.socket.message({ tokens: [sourceProvisional(`임시${index}`)] });
    await provisional.clock.advance(500);
  }
  assert.equal(provisional.socket.finalizeCount(), 0, "provisional tokens alone are nothing to finalize");
  assert.equal(provisional.finals.length, 0);
  provisional.stream.abort();

  const empty = await openAdapter();
  empty.socket.message({ tokens: [sourceFinal("확정")] });
  await empty.clock.advance(600);
  empty.socket.message({ tokens: [] });
  await empty.clock.advance(600);
  assert.equal(empty.socket.finalizeCount(), 1, "an empty result frame does not postpone the idle finalize");
  empty.stream.abort();
});

test("(g'') close and abort cancel a pending finalize timer", async () => {
  const aborted = await openAdapter();
  aborted.socket.message({ tokens: [sourceFinal("취소될 문장")] });
  assert.ok(aborted.clock.pending().some((timer) => timer.at === aborted.clock.now() + 1_200), "finalize is armed");
  aborted.stream.abort();
  assert.equal(aborted.clock.pending().length, 0);
  await aborted.clock.advance(2_000);
  assert.equal(aborted.socket.finalizeCount(), 0);
  assert.equal(aborted.socket.readyState, WebSocket.CLOSED);
  assert.throws(() => aborted.stream.assertDrained(), /STT_DRAIN_ABORTED/u);

  const closed = await openAdapter();
  closed.socket.message({ tokens: [sourceFinal("마감 문장")] });
  const closing = closed.stream.close();
  await flush();
  assert.equal(closed.clock.pending().filter((timer) => timer.at === closed.clock.now() + 1_200).length, 0, "the idle finalize is gone once the stream is ending");
  closed.socket.message({ tokens: [{ text: "<end>", is_final: true }], finished: true });
  await closing;
  assert.equal(closed.socket.finalizeCount(), 0);
  assert.equal(closed.finals.length, 1);
});

test("the 290-minute connection budget fails the stream with SONIOX_MAX_DURATION so the owner reopens", async () => {
  const { clock, socket, stream, discards } = await openAdapter();
  socket.message({ tokens: [sourceFinal("진행 중 문장")] });
  await clock.advance(17_400_000);
  assert.throws(() => stream.assertDrained(), /SONIOX_MAX_DURATION/u);
  await assert.rejects(stream.sendAudio(new Uint8Array(FRAME)), /SONIOX_MAX_DURATION/u);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  assert.equal(discards.length, 1, "committed text that never reached a boundary is reported as discarded");
  assert.equal(discards[0].reason, "SONIOX_MAX_DURATION");
  assert.equal(stream.maxConnectionMilliseconds, 17_400_000);
});

test("open rejects on connect timeout, pre-open socket failure, and an already-aborted signal", async () => {
  const clock = createClock();
  const sockets = [];
  const build = () => new SonioxRealtimeAdapter({
    apiKey: "fixture-key", translation: true, translationLanguages: ["en", "ko"],
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    createWebSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
  });
  const timingOut = assert.rejects(build().open({ onFinalUtterance() {} }), /STT_CONNECT_TIMEOUT/u);
  await clock.advance(10_000);
  await timingOut;
  assert.equal(sockets[0].readyState, WebSocket.CLOSED);

  const failing = assert.rejects(build().open({ onFinalUtterance() {} }), /STT_CONNECT_FAILED/u);
  await flush();
  sockets[1].emit("error", new Error("ECONNREFUSED"));
  await failing;

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(build().open({ onFinalUtterance() {}, signal: controller.signal }), /STT_CONNECT_ABORTED/u);
  assert.equal(sockets.length, 2, "an aborted signal never opens a socket");
  await assert.rejects(build().open({ onFinalUtterance: "nope" }), /STT_CALLBACK_INVALID/u);
});

test("a rejected final-utterance callback and an unexpected socket close both terminate the stream", async () => {
  const failing = await openAdapter({ callbacks: { onFinalUtterance: async () => { throw new Error("PUBLISH_FAILED"); } } });
  failing.socket.message({ tokens: [sourceFinal("실패"), { text: "<end>", is_final: true }] });
  await flush();
  await flush();
  assert.throws(() => failing.stream.assertDrained(), /PUBLISH_FAILED/u);
  assert.equal(failing.socket.readyState, WebSocket.CLOSED);

  const dropped = await openAdapter();
  dropped.socket.close();
  await flush();
  assert.throws(() => dropped.stream.assertDrained(), /STT_PROVIDER_CLOSED/u);
  assert.equal(dropped.clock.pending().length, 0);
});

test("(M1/M2) an unsolicited finished commits pending text, close waits for that callback, and the stream fails STT_PROVIDER_CLOSED", async () => {
  let release;
  let settled = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const { socket, stream } = await openAdapter({ callbacks: { onFinalUtterance: async (utterance) => { seen.push(utterance); await gate; settled = true; } } });
  socket.message({ tokens: [sourceFinal("서버가 끝낸 문장")], finished: true });
  await flush();
  assert.equal(seen.length, 1, "committed text is closed like a <fin> before the stream is failed");
  assert.equal(seen[0].text, "서버가 끝낸 문장");
  let closed = false;
  const closing = stream.close().then((result) => { closed = true; return result; });
  await flush();
  await flush();
  assert.equal(closed, false, "close resolves only after the utterance callback settled");
  release();
  const result = await closing;
  assert.equal(settled, true);
  assert.equal(result.transportClosed, true);
  assert.throws(() => stream.assertDrained(), /STT_PROVIDER_CLOSED/u, "a finished nobody asked for is a dead socket");

  const idle = await openAdapter();
  idle.socket.message({ tokens: [], finished: true });
  await flush();
  assert.throws(() => idle.stream.assertDrained(), /STT_PROVIDER_CLOSED/u);
  assert.equal(idle.socket.readyState, WebSocket.CLOSED);
  assert.equal(idle.finals.length, 0);
});

test("(M3) a socket that closes mid-drain fails STT_PROVIDER_CLOSED at once instead of waiting out the drain deadline", async () => {
  const { clock, socket, stream } = await openAdapter();
  const draining = assert.rejects(stream.gracefulDrain(), /STT_PROVIDER_CLOSED/u);
  await flush();
  assert.equal(socket.sent.at(-1), "");
  socket.close();
  await draining;
  assert.throws(() => stream.assertDrained(), /STT_PROVIDER_CLOSED/u);
  assert.equal(clock.pending().length, 0, "the drain deadline and the keepalive are both gone");
});

test("(M4) raw ws send failures surface as STT_PROVIDER_WRITE_FAILED, never as the socket's own message", async () => {
  const { socket, stream } = await openAdapter();
  socket.send = () => { throw new Error("WebSocket is not open: readyState 3 (CLOSED) internal detail"); };
  await assert.rejects(stream.sendAudio(new Uint8Array(FRAME)), (error) => error.message === "STT_PROVIDER_WRITE_FAILED");
  assert.throws(() => stream.assertDrained(), (error) => error.message === "STT_PROVIDER_WRITE_FAILED");

  const draining = await openAdapter();
  draining.socket.send = () => { throw new Error("raw ws failure"); };
  await assert.rejects(draining.stream.gracefulDrain(), (error) => error.message === "STT_PROVIDER_WRITE_FAILED");
  assert.throws(() => draining.stream.assertDrained(), (error) => error.message === "STT_PROVIDER_WRITE_FAILED");
});

test("(M5) an oversized provider frame is rejected as SONIOX_MESSAGE_INVALID before it is decoded", async () => {
  const { socket, stream } = await openAdapter();
  socket.emit("message", Buffer.alloc(1_048_577, 0x20), false);
  await flush();
  assert.throws(() => stream.assertDrained(), /SONIOX_MESSAGE_INVALID/u);
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

test("(M6) the 65th in-flight frame is refused with STT_AUDIO_BACKPRESSURE without failing the stream", async () => {
  const { socket, stream } = await openAdapter();
  const results = Array.from({ length: 65 }, () => stream.sendAudio(new Uint8Array(FRAME)));
  await assert.rejects(results[64], /STT_AUDIO_BACKPRESSURE/u);
  await Promise.all(results.slice(0, 64));
  assert.doesNotThrow(() => stream.assertDrained());
  assert.equal(socket.sent.filter(Buffer.isBuffer).length, 64);
  await stream.sendAudio(new Uint8Array(FRAME));
  assert.equal(stream.getUsage().inputAudioMilliseconds, 65 * 40);
  stream.abort();
});

test("(M6) a partial callback that throws or rejects fails the stream with STT_PARTIAL_CALLBACK_FAILED", async () => {
  const throwing = await openAdapter({ callbacks: { onPartialTranscript: () => { throw new Error("RENDER_FAILED"); } } });
  throwing.socket.message({ tokens: [sourceProvisional("임시")] });
  await flush();
  assert.throws(() => throwing.stream.assertDrained(), (error) => error.message === "STT_PARTIAL_CALLBACK_FAILED");

  const rejecting = await openAdapter({ callbacks: { onPartialTranslation: async () => { throw new Error("PUBLISH_FAILED"); } } });
  rejecting.socket.message({ tokens: [translationToken("Hel", { is_final: false })] });
  await flush();
  await flush();
  assert.throws(() => rejecting.stream.assertDrained(), (error) => error.message === "STT_PARTIAL_CALLBACK_FAILED");
});

test("(M6) an owner signal aborted after open fails the stream with STT_DRAIN_ABORTED and closes the socket", async () => {
  const controller = new AbortController();
  const { socket, stream } = await openAdapter({ callbacks: { signal: controller.signal } });
  await stream.sendAudio(new Uint8Array(FRAME));
  controller.abort();
  await flush();
  assert.throws(() => stream.assertDrained(), /STT_DRAIN_ABORTED/u);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  await assert.rejects(stream.sendAudio(new Uint8Array(FRAME)), /STT_DRAIN_ABORTED/u);
});

test("(M6) consecutive segments never share translation lanes", async () => {
  const { socket, stream, finals } = await openAdapter();
  socket.message({ tokens: [sourceFinal("첫째", { start_ms: 0, end_ms: 500 }), translationToken("First", { is_final: true }), { text: "<end>", is_final: true }] });
  socket.message({ tokens: [sourceFinal("둘째", { start_ms: 600, end_ms: 1_100 }), { text: "<end>", is_final: true }] });
  await flush();
  assert.equal(finals.length, 2);
  assert.deepEqual(finals[0].translations, { en: { text: "First", sourceLanguage: "ko" } });
  assert.deepEqual(finals[1].translations, {});
  assert.equal("en" in finals[1].translations, false);
  assert.equal(finals[1].sourceStartOffsetMs, 600);
  stream.abort();
});

test("(M8) provider errors carry request_id as a property, never inside the message", async () => {
  const tagged = await openAdapter();
  tagged.socket.message({ error_type: "limit_exceeded", error_message: "quota", request_id: "req-42" });
  await flush();
  let caught = null;
  try { tagged.stream.assertDrained(); } catch (error) { caught = error; }
  assert.equal(caught?.message, "SONIOX_RATE_LIMITED");
  assert.equal(caught?.requestId, "req-42");

  const oversized = await openAdapter();
  oversized.socket.message({ error_type: "service_unavailable", request_id: "x".repeat(129) });
  await flush();
  caught = null;
  try { oversized.stream.assertDrained(); } catch (error) { caught = error; }
  assert.equal(caught?.message, "SONIOX_UNAVAILABLE");
  assert.equal("requestId" in caught, false);
});
