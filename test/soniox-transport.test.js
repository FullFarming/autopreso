// @ts-nocheck - the fake socket implements only the WebSocket surface under test.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";

import { createSonioxTransport } from "../src/caption-engine/soniox-transport.js";

class FakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  sent = [];
  bufferedAmount = 0;

  send(value) { this.sent.push(value); }
  open() { this.readyState = WebSocket.OPEN; this.emit("open"); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close", 1000, Buffer.alloc(0)); }
}

const pcm24k = (value = 1) => Buffer.alloc(4_800, value).toString("base64");

const sonioxEngine = (languageMode) => ({
  stt: { provider: "soniox", model: "stt-rt-v5", languageMode },
  translation: { provider: "soniox", model: "stt-rt-v5" },
  summary: { provider: "gemini", model: "gemini-3.6-flash" },
});

test("first message is the config JSON, audio goes out as binary 16 kHz, replay ring resends on new socket", () => {
  const transport = createSonioxTransport({
    engine: sonioxEngine("ko"),
    settings: { translationLanguages: ["en", "ko"], glossary: "NOVA = 노바", translationDomain: "CRE" },
    apiKey: "fixture-key",
    now: () => 1000,
  });
  assert.equal(transport.requiresSetupAck, false);
  assert.equal(transport.binaryAudio, true);
  const urls = [];
  const socket = transport.connect({ createWebSocket: (url) => { urls.push(url); return new FakeSocket(); } });
  assert.equal(urls[0], "wss://stt-rt.soniox.com/transcribe-websocket");
  assert.equal(socket.readyState, WebSocket.CONNECTING);
  const [setup] = transport.setupPayloads();
  const config = JSON.parse(setup);
  assert.deepEqual(config.language_hints, ["ko"]);
  assert.equal(config.translation.type, "two_way");
  assert.ok(config.context.terms.includes("NOVA"));
  assert.deepEqual(config.context.translation_terms, [{ source: "NOVA", target: "노바" }]);
  assert.equal(setup.includes("fixture-key"), true, "api key travels only in the first message");
  const frame = transport.audioPayload(pcm24k());
  assert.ok(Buffer.isBuffer(frame));
  assert.equal(frame.length, 3_200, "4,800 bytes of 24 kHz PCM resample to 3,200 bytes at 16 kHz");
  const replay = transport.replayPayloads();
  assert.equal(replay.length, 1);
  assert.equal(replay[0].length, 3_200);
  assert.equal(transport.keepalivePayload(), '{"type":"keepalive"}');
  assert.equal(transport.finalizePayload(), '{"type":"finalize"}');
  assert.equal(transport.closePayload(), "", "end of audio is an EMPTY TEXT frame - Soniox never finishes on an empty binary frame");
});

test("the replay ring never grows past 1.5 s of 16 kHz mono PCM", () => {
  const transport = createSonioxTransport({
    engine: sonioxEngine("auto"),
    settings: { translationLanguages: ["en", "ko"], glossary: "" },
    apiKey: "fixture-key",
  });
  for (let index = 0; index < 40; index += 1) transport.audioPayload(pcm24k(index % 5));
  const bytes = transport.replayPayloads().reduce((total, chunk) => total + chunk.length, 0);
  assert.equal(bytes <= transport.replayRingBytes, true, `ring held ${bytes} bytes`);
  assert.equal(bytes > transport.replayRingBytes - 3_200, true, "the ring keeps the newest full window");
});

test("handleMessage maps tokens to onInterim/onFinal/onTranslation and marks finals providerTranslated", () => {
  const transport = createSonioxTransport({
    engine: sonioxEngine("auto"),
    settings: { translationLanguages: ["en", "ko"], glossary: "" },
    apiKey: "fixture-key",
  });
  const seen = [];
  const ctx = {
    onTransportReady: () => seen.push(["ready"]),
    onInterim: (e) => seen.push(["interim", e.text, e.languageCode]),
    onFinal: (e) => seen.push(["final", e.text, e.languageCode, e.providerTranslated]),
    onTranslation: (e) => seen.push(["tr", e.targetLanguage, e.text, e.isFinal, e.provider]),
    onBoundary: (kind) => seen.push(["b", kind]),
    onError: (code) => seen.push(["err", code]),
  };
  transport.handleMessage(Buffer.from(JSON.stringify({ tokens: [
    { text: "안녕하세요", is_final: true, translation_status: "original", language: "ko", start_ms: 0, end_ms: 900 },
    { text: "Hello", is_final: false, translation_status: "translation", language: "en", source_language: "ko" },
  ] })), ctx);
  transport.handleMessage(Buffer.from(JSON.stringify({ tokens: [
    { text: "Hello", is_final: true, translation_status: "translation", language: "en", source_language: "ko" },
    { text: "<end>", is_final: true },
  ] })), ctx);
  assert.deepEqual(seen[0], ["ready"], "first result message doubles as readiness");
  assert.deepEqual(seen[1], ["interim", "안녕하세요", "ko"]);
  assert.deepEqual(seen[2], ["tr", "en", "Hello", false, "soniox"]);
  assert.deepEqual(seen[3], ["final", "안녕하세요", "ko", true]);
  assert.deepEqual(seen[4], ["tr", "en", "Hello", true, "soniox"]);
  assert.deepEqual(seen[5], ["b", "endpoint"]);
  transport.handleMessage(Buffer.from(JSON.stringify({ error_type: "unauthenticated", error_code: 401, request_id: "r1" })), ctx);
  assert.deepEqual(seen.at(-1), ["err", "SONIOX_UNAUTHENTICATED"]);
});

test("translation events carry the segment's source text so echo guards can run", () => {
  const transport = createSonioxTransport({
    engine: sonioxEngine("auto"),
    settings: { translationLanguages: ["en", "ko"], glossary: "" },
    apiKey: "fixture-key",
  });
  const translations = [];
  const ctx = { onTranslation: (event) => translations.push(event) };
  transport.handleMessage(Buffer.from(JSON.stringify({ tokens: [
    { text: "이번 분기", is_final: true, translation_status: "original", language: "ko", start_ms: 0, end_ms: 400 },
    { text: "This quarter", is_final: true, translation_status: "translation", language: "en", source_language: "ko" },
    { text: "<end>", is_final: true },
  ] })), ctx);
  assert.equal(translations.length, 1);
  assert.equal(translations[0].sourceText, "이번 분기");
  assert.equal(translations[0].sourceLanguage, "ko");
});

test("a malformed or oversized frame reports SONIOX_MESSAGE_INVALID instead of throwing", () => {
  const transport = createSonioxTransport({
    engine: sonioxEngine("auto"),
    settings: { translationLanguages: ["en", "ko"], glossary: "" },
    apiKey: "fixture-key",
  });
  const codes = [];
  transport.handleMessage(Buffer.from("not json"), { onError: (code) => codes.push(code) });
  assert.deepEqual(codes, ["SONIOX_MESSAGE_INVALID"]);
});

// setupPayloads() runs inside the WebSocket "open" listener, which is outside
// every try/catch the client owns, so a throw there would take the host process
// down. All validation therefore belongs to assertReady().
test("assertReady owns every start-time rejection and setupPayloads never throws", () => {
  const ready = createSonioxTransport({
    engine: sonioxEngine("auto"),
    settings: { translationLanguages: ["en", "ko"], glossary: "" },
    apiKey: "fixture-key",
  });
  ready.assertReady();

  const keyless = createSonioxTransport({
    engine: sonioxEngine("auto"),
    settings: { translationLanguages: ["en", "ko"], glossary: "" },
    apiKey: "",
  });
  assert.throws(() => keyless.assertReady(), /Soniox API key/u);

  for (const translationLanguages of [["en", "ko", "ja"]]) {
    const transport = createSonioxTransport({
      engine: sonioxEngine("auto"),
      settings: { translationLanguages, glossary: "" },
      apiKey: "fixture-key",
    });
    assert.throws(() => transport.assertReady(), /SONIOX_TRANSLATION_(?:PAIR|TARGET)_REQUIRED/u,
      `${translationLanguages.join("+")} is not a two_way pair`);
    assert.doesNotThrow(() => transport.setupPayloads());
    assert.deepEqual(transport.setupPayloads(), [], "an unusable config yields no setup payload");
  }

  assert.doesNotThrow(() => keyless.setupPayloads());
  assert.deepEqual(keyless.setupPayloads(), []);
});

test("Soniox owns its own rollover instead of the shared 9.5-minute Gemini one", () => {
  const transport = createSonioxTransport({
    engine: sonioxEngine("auto"),
    settings: { translationLanguages: ["en", "ko"], glossary: "" },
    apiKey: "fixture-key",
  });
  assert.equal(transport.rolloverMilliseconds, 17_400_000, "290 minutes");
  assert.equal(transport.rolloverMilliseconds < transport.maximumSessionMilliseconds, true);
});

function createFakeTimers() {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => nowMs,
    setTimer(callback, delay) { const id = nextId++; timers.set(id, { at: nowMs + delay, callback }); return id; },
    clearTimer(id) { timers.delete(id); },
    pending: () => timers.size,
    advance(milliseconds) {
      const target = nowMs + milliseconds;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, timer] = due[0];
        timers.delete(id);
        nowMs = timer.at;
        timer.callback();
      }
      nowMs = target;
    },
  };
}

const koFinal = (text, start_ms, end_ms) => ({ text, is_final: true, translation_status: "original", language: "ko", start_ms, end_ms });
const frame = (tokens) => Buffer.from(JSON.stringify({ tokens }));

// Spike 2026-09-02: 17 s of continuous speech never produced <end>, so the
// transport asks for <fin> itself - 1.2 s without new tokens while final text is
// pending (or a 15 s segment) sends {"type":"finalize"} as a TEXT frame through
// the client's ctx.sendControl hook, at most once per segment.
test("finalize goes out through ctx.sendControl after idle final text, once per segment, and stops at end of audio", () => {
  const clock = createFakeTimers();
  const transport = createSonioxTransport({
    engine: sonioxEngine("auto"),
    settings: { translationLanguages: ["en", "ko"], glossary: "" },
    apiKey: "fixture-key",
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const controls = [];
  const boundaries = [];
  const ctx = {
    sendControl: (payload) => { controls.push(payload); return true; },
    onBoundary: (kind) => boundaries.push(kind),
  };
  transport.setupPayloads();
  transport.handleMessage(frame([koFinal("안녕하세요", 0, 900)]), ctx);
  clock.advance(600);
  transport.handleMessage(frame([]), ctx);
  clock.advance(500);
  assert.deepEqual(controls, [], "an empty result frame is not a new token and does not delay the finalize");
  clock.advance(100);
  assert.deepEqual(controls, ['{"type":"finalize"}']);
  assert.equal(typeof controls[0], "string", "control messages are text frames");

  clock.advance(5_000);
  transport.handleMessage(frame([koFinal(" 여러분", 900, 1_300)]), ctx);
  clock.advance(5_000);
  assert.equal(controls.length, 1, "no re-send while <fin> is outstanding");

  transport.handleMessage(frame([{ text: "<fin>", is_final: true }]), ctx);
  assert.deepEqual(boundaries, ["manual-finalize"]);
  transport.handleMessage(frame([koFinal("다음", 2_000, 2_400)]), ctx);
  clock.advance(1_200);
  assert.equal(controls.length, 2, "the boundary re-arms the scheduler");

  transport.handleMessage(frame([{ text: "<fin>", is_final: true }, koFinal("마지막", 3_000, 3_400)]), ctx);
  assert.equal(clock.pending(), 1, "final text after the boundary in the same frame arms a fresh finalize");
  assert.equal(transport.closePayload(), "");
  assert.equal(clock.pending(), 0, "end of audio cancels the pending finalize");
  clock.advance(20_000);
  assert.equal(controls.length, 2);
});

test("a provisional-only segment never triggers finalize, and a new socket setup discards the old scheduler", () => {
  const clock = createFakeTimers();
  const transport = createSonioxTransport({
    engine: sonioxEngine("auto"),
    settings: { translationLanguages: ["en", "ko"], glossary: "" },
    apiKey: "fixture-key",
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const controls = [];
  const ctx = { sendControl: (payload) => { controls.push(payload); return true; } };
  transport.setupPayloads();
  transport.handleMessage(frame([{ text: "안녕하", is_final: false, translation_status: "original", language: "ko" }]), ctx);
  clock.advance(20_000);
  assert.deepEqual(controls, [], "nothing final is pending, so there is nothing to finalize");

  transport.handleMessage(frame([koFinal("안녕하세요", 0, 900)]), ctx);
  assert.equal(clock.pending(), 1);
  transport.setupPayloads(); // reconnect / rollover: the next socket starts clean
  assert.equal(clock.pending(), 0, "setup for a new socket clears the previous socket's finalize timer");
  transport.dispose();
  clock.advance(20_000);
  assert.deepEqual(controls, []);
});
