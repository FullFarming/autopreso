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
  assert.equal(transport.closePayload().length, 0, "an empty binary frame signals end of audio");
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

test("assertReady refuses to open a session without a Soniox key", () => {
  const transport = createSonioxTransport({
    engine: sonioxEngine("auto"),
    settings: { translationLanguages: ["en", "ko"], glossary: "" },
    apiKey: "fixture-key",
  });
  transport.assertReady();
  const keyless = createSonioxTransport({
    engine: sonioxEngine("auto"),
    settings: { translationLanguages: ["en", "ko"], glossary: "" },
    apiKey: "",
  });
  assert.throws(() => keyless.assertReady(), /Soniox API key/u);
  assert.throws(() => keyless.setupPayloads(), /SONIOX_API_KEY_REQUIRED/u);
});
