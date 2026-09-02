// @ts-nocheck - the fake socket implements only the WebSocket surface under test.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";

import { createSubtitleRealtimeManager } from "../src/subtitle-realtime.js";

class FakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent = [];
  deferClose = false;
  closeCalls = 0;

  sendOptions = [];

  send(value, options) {
    this.sent.push(value);
    this.sendOptions.push(options);
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  close(code = 1000) {
    this.closeCalls += 1;
    if (this.deferClose) return;
    this.finishClose(code);
  }

  finishClose(code = 1000) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.alloc(0));
  }

  terminate() {
    this.close(1006);
  }
}

function createHarness({ polish, settings = {}, apiKeys = {}, ...options } = {}) {
  const sockets = [];
  const events = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (event) => events.push(event),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "test-key", geminiSecondary: "", ...apiKeys },
        subtitle: {
          inputMode: "mic",
          translationLanguages: ["en", "ko", "ja"],
          glossary: "Cushman & Wakefield = 쿠시먼앤드웨이크필드\nNOI = 순영업소득",
          ...settings,
        },
      }),
    },
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    polish,
    partialTranslationDebounceMs: 5,
    ...options,
  });
  return { manager, sockets, events };
}

// A combined STT+translation provider (Soniox) hands the pipeline a finished
// translation. The transport contract lets it surface that through onTranslation
// and flag the matching final as providerTranslated.
function createFakeCombinedTransport() {
  return {
    providerLabel: "Fake Combined",
    maximumSessionMilliseconds: 600_000,
    assertReady() {},
    connect({ createWebSocket }) { return createWebSocket("wss://combined.invalid", undefined, {}); },
    setupPayloads() { return ["setup"]; },
    audioPayload(audio) { return `audio:${audio}`; },
    closePayload() { return "close"; },
    handleMessage(raw, ctx) {
      const message = JSON.parse(String(raw));
      if (message.ready) {
        ctx.onTransportReady();
        return;
      }
      if (message.boundary) {
        ctx.onBoundary?.(message.boundary);
        return;
      }
      if (!message.translation) return;
      ctx.onTranslation?.(message.translation);
      if (message.translation.isFinal) {
        ctx.onFinal({
          text: message.translation.sourceText,
          languageCode: message.translation.sourceLanguage,
          providerTranslated: true,
        });
      }
    },
  };
}

test("a provider-delivered translation is committed without a text-translation call", async () => {
  const polishCalls = [];
  const { manager, sockets, events } = createHarness({
    settings: { translationLanguages: ["en", "ko"] },
    polish: async (request) => {
      polishCalls.push(request);
      return "text-lane translation that must never appear";
    },
    createSttTransport: () => createFakeCombinedTransport(),
  });

  await manager.start({ sessionId: "combined-provider" });
  assert.equal(sockets.length, 1);
  sockets[0].open();
  sockets[0].emit("message", JSON.stringify({ ready: true }));
  sockets[0].emit("message", JSON.stringify({
    translation: {
      text: "Hello everyone",
      targetLanguage: "en",
      sourceText: "안녕하세요 여러분",
      sourceLanguage: "ko",
      isFinal: false,
      provider: "soniox",
      segmentId: "seg-1",
    },
  }));
  sockets[0].emit("message", JSON.stringify({
    translation: {
      text: "Hello everyone, welcome.",
      targetLanguage: "en",
      sourceText: "안녕하세요 여러분, 환영합니다",
      sourceLanguage: "ko",
      isFinal: true,
      provider: "soniox",
      segmentId: "seg-1",
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(polishCalls, []);
  const partials = events.filter((event) => event.type === "subtitle:partial");
  assert.equal(partials.length, 1);
  assert.equal(partials[0].targetLanguage, "en");
  assert.equal(partials[0].translatedText, "Hello everyone");
  const committed = events.filter((event) => event.type === "subtitle:committed");
  assert.equal(committed.length, 1);
  assert.equal(committed[0].targetLanguage, "en");
  assert.equal(committed[0].translatedText, "Hello everyone, welcome.");
  assert.equal(committed[0].translationProvider, "soniox");
  assert.equal(committed[0].segmentId, "seg-1");
  assert.equal(committed[0].isAuthoritative, true);
});

// A provider translation is still model output: ruling 1 of Task 5 makes it
// clear the same gates a Gemini final does.
async function runProviderTranslation(translation, { settings = {} } = {}) {
  const polishCalls = [];
  const { manager, sockets, events } = createHarness({
    settings: { translationLanguages: ["en", "ko"], glossary: "", ...settings },
    polish: async (request) => { polishCalls.push(request); return "text-lane output that must never appear"; },
    createSttTransport: () => createFakeCombinedTransport(),
  });
  await manager.start({ sessionId: "provider-translation-guards" });
  try {
    sockets[0].open();
    sockets[0].emit("message", JSON.stringify({ ready: true }));
    sockets[0].emit("message", JSON.stringify({ translation }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally { await manager.stop(); }
  return { events, polishCalls };
}

test("a provider translation that merely echoes the source is dropped, not committed", async () => {
  const { events, polishCalls } = await runProviderTranslation({
    text: "Quarterly Revenue Report",
    targetLanguage: "en",
    sourceText: "Quarterly Revenue Report",
    sourceLanguage: "ko",
    isFinal: true,
    provider: "soniox",
    segmentId: "echo-1",
  });
  assert.equal(events.some((event) => event.type === "subtitle:committed"), false, JSON.stringify(events));
  assert.equal(events.some((event) => event.code === "TEXT_TRANSLATION_FAILED"), false);
  assert.deepEqual(polishCalls, [], "a dropped provider translation must not fall back to a Gemini call");
});

test("a provider translation whose source is already this lane's language clears the lane", async () => {
  const { events } = await runProviderTranslation({
    text: "안녕하세요 여러분",
    targetLanguage: "ko",
    sourceText: "안녕하세요 여러분",
    sourceLanguage: "ko",
    isFinal: true,
    provider: "soniox",
    segmentId: "same-lang-1",
  });
  const cleared = events.filter((event) => event.type === "subtitle:clear");
  assert.equal(cleared.length, 1, JSON.stringify(events));
  assert.equal(cleared[0].targetLanguage, "ko");
  assert.equal(cleared[0].reason, "same_language_source");
  assert.equal(events.some((event) => event.type === "subtitle:committed"), false);
});

test("a provider final that never reached the target language reports TEXT_TRANSLATION_FAILED", async () => {
  const { events } = await runProviderTranslation({
    text: "Revenue increased sharply.",
    targetLanguage: "ko",
    sourceText: "Our revenue increased sharply this quarter.",
    sourceLanguage: "en",
    isFinal: true,
    provider: "soniox",
    segmentId: "target-miss-1",
  });
  const failures = events.filter((event) => event.code === "TEXT_TRANSLATION_FAILED");
  assert.equal(failures.length, 1, JSON.stringify(events));
  assert.equal(failures[0].targetLanguage, "ko");
  assert.equal(events.some((event) => event.type === "subtitle:committed"), false);
});

test("a same-language provider PARTIAL is ignored while the FINAL clears the lane", async () => {
  const base = {
    text: "안녕하세요 여러분",
    targetLanguage: "ko",
    sourceText: "안녕하세요 여러분",
    sourceLanguage: "ko",
    provider: "soniox",
    segmentId: "same-lang-partial",
  };
  const partial = await runProviderTranslation({ ...base, isFinal: false });
  assert.equal(partial.events.some((event) => event.type === "subtitle:clear"), false,
    `a partial must not clear the lane: ${JSON.stringify(partial.events)}`);
  assert.equal(partial.events.some((event) => event.type === "subtitle:partial"), false);

  const final = await runProviderTranslation({ ...base, isFinal: true });
  const cleared = final.events.filter((event) => event.type === "subtitle:clear");
  assert.equal(cleared.length, 1, JSON.stringify(final.events));
  assert.equal(cleared[0].reason, "same_language_source");
});

const SONIOX_ENGINE = Object.freeze({
  stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" },
  translation: { provider: "soniox", model: "stt-rt-v5" },
  summary: { provider: "gemini", model: "gemini-3.6-flash" },
});

// Drives the REAL Soniox transport (binary audio, no setup ack, replay ring,
// provider error codes) over the harness's fake socket.
function createSonioxHarness({ settings = {}, ...options } = {}) {
  return createHarness({
    settings: { translationLanguages: ["en", "ko"], glossary: "", engine: SONIOX_ENGINE, ...settings },
    apiKeys: { soniox: "fixture-key" },
    polish: async () => "text-lane output that must never appear",
    ...options,
  });
}

const audioFrame = (value = 1) => Buffer.alloc(4_800, value).toString("base64");
const settle = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Fix round 2 (I4): the combined engine's language-PAIR constraint is refused
// during normalization, so an unusable selection is rejected by start() before
// a socket exists. The transport's own assertReady/setupPayloads guard (an
// unusable config must never throw out of the "open" listener) is still there
// and is covered directly by test/soniox-transport.test.js.
test("a soniox engine that cannot build a config is refused before any socket opens", async () => {
  const { manager, sockets } = createSonioxHarness({
    settings: { translationLanguages: ["en", "ko", "ja"] },
  });
  await assert.rejects(manager.start({ sessionId: "soniox-bad-pair" }), /자막 언어가 정확히 2개/u);
  try {
    await settle(10);
    assert.equal(sockets.length, 0, "no socket is opened for an unusable config");
    // Audio keeps arriving from the renderer after a failed start; it must not
    // throw out of the async WebSocket listener that delivers it.
    assert.doesNotThrow(() => manager.sendAudio({
      sessionId: "soniox-bad-pair", source: "mic", audio: audioFrame(),
    }));
    assert.equal(sockets.length, 0);
  } finally { await manager.stop(); }
});

test("a soniox session does not take the shared Gemini rollover", async () => {
  const { manager, sockets } = createSonioxHarness({
    transcribeRolloverMs: 15,
    transcribeFinalDrainMs: 5,
    reconnectBaseMs: 1,
  });
  await manager.start({ sessionId: "soniox-no-rollover" });
  try {
    sockets[0].open();
    await settle(45);
    assert.equal(sockets.length, 1, "the transport's own 290-minute rollover must win");
    assert.equal(sockets[0].readyState, WebSocket.OPEN);
  } finally { await manager.stop(); }
});

test("replay payloads are withheld on first open and resent after a reconnect", async () => {
  const { manager, sockets } = createSonioxHarness({ reconnectBaseMs: 1 });
  await manager.start({ sessionId: "soniox-replay" });
  try {
    const first = sockets[0];
    first.open();
    assert.equal(first.sent.length, 1, "first open sends the config and nothing else");
    manager.sendAudio({ sessionId: "soniox-replay", source: "mic", audio: audioFrame() });
    const sentLive = first.sent.filter((value) => Buffer.isBuffer(value) && value.length > 0);
    assert.equal(sentLive.length, 1);

    first.finishClose(1006);
    await settle(25);
    assert.equal(sockets.length, 2, "a non-graceful close reconnects");
    const second = sockets[1];
    second.open();
    const replayed = second.sent.filter((value) => Buffer.isBuffer(value) && value.length > 0);
    assert.equal(replayed.length, 1, "the reconnect replays the buffered audio tail");
    assert.equal(replayed[0].length, 3_200);
    assert.equal(replayed[0].equals(sentLive[0]), true);
  } finally { await manager.stop(); }
});

test("an unauthenticated soniox rejection reports the code and never starts a reconnect ladder", async () => {
  const { manager, sockets, events } = createSonioxHarness({ reconnectBaseMs: 1 });
  await manager.start({ sessionId: "soniox-unauthenticated" });
  try {
    sockets[0].open();
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      error_type: "unauthenticated", error_code: 401, request_id: "r1",
    })));
    await settle(5);
    const failures = events.filter((event) => event.code === "SONIOX_UNAUTHENTICATED");
    assert.equal(failures.length, 1, JSON.stringify(events));
    assert.equal(failures[0].type, "subtitle:error");
    assert.equal(failures[0].requestId, "r1");

    sockets[0].finishClose(1006);
    await settle(25);
    assert.equal(sockets.length, 1, "a key rejection must not be retried");
  } finally { await manager.stop(); }
});

test("soniox engine sends config first, binary audio frames, and commits provider translations without Gemini calls", async () => {
  let textCalls = 0;
  const { manager, sockets, events } = createHarness({
    settings: {
      translationLanguages: ["en", "ko"],
      glossary: "",
      engine: {
        stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" },
        translation: { provider: "soniox", model: "stt-rt-v5" },
        summary: { provider: "gemini", model: "gemini-3.6-flash" },
      },
    },
    apiKeys: { soniox: "fixture-key" },
    polish: async () => { textCalls += 1; return "text-lane output that must never appear"; },
  });

  await manager.start({ sessionId: "soniox-engine" });
  try {
    const socket = sockets.at(-1);
    socket.open();
    const config = JSON.parse(socket.sent[0]);
    assert.equal(config.model, "stt-rt-v5");
    assert.deepEqual(config.language_hints, ["ko", "en"]);
    manager.sendAudio({
      sessionId: "soniox-engine",
      source: "mic",
      audio: Buffer.alloc(4_800, 1).toString("base64"),
    });
    assert.ok(Buffer.isBuffer(socket.sent.at(-1)), "audio is a binary frame");
    socket.emit("message", Buffer.from(JSON.stringify({ tokens: [
      { text: "안녕하세요", is_final: true, translation_status: "original", language: "ko", start_ms: 0, end_ms: 800 },
      { text: "Hello", is_final: true, translation_status: "translation", language: "en", source_language: "ko" },
      { text: "<end>", is_final: true },
    ] })));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const committed = events.filter((event) => event.type === "subtitle:committed");
    assert.equal(committed.length, 1, JSON.stringify(events));
    assert.equal(committed[0].targetLanguage, "en");
    assert.equal(committed[0].translatedText, "Hello");
    assert.equal(committed[0].sourceText, "안녕하세요");
    assert.equal(committed[0].translationProvider, "soniox");
    assert.equal(textCalls, 0);
  } finally { await manager.stop(); }
});

// Fix round 2 (I2): the combined engine's SOURCE partials must not open the
// Gemini text lane. Soniox emits them through onInterim, and the client used to
// fan every interim to lane.preview() - which paid Gemini for a preview
// translation of a line Soniox was about to translate itself, and painted that
// preview with translationProvider "gemini" over the provider's own partial.
test("a combined engine's source partials never reach the Gemini text lane", async () => {
  let textCalls = 0;
  const { manager, sockets, events } = createHarness({
    settings: {
      translationLanguages: ["en", "ko"],
      glossary: "",
      engine: {
        stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" },
        translation: { provider: "soniox", model: "stt-rt-v5" },
        summary: { provider: "gemini", model: "gemini-3.6-flash" },
      },
    },
    apiKeys: { soniox: "fixture-key" },
    polish: async () => { textCalls += 1; return "text-lane output that must never appear"; },
  });

  await manager.start({ sessionId: "soniox-no-preview" });
  try {
    const socket = sockets.at(-1);
    socket.open();
    // A provisional source token: the only thing Soniox has produced so far.
    socket.emit("message", Buffer.from(JSON.stringify({ tokens: [
      { text: "안녕하", is_final: false, translation_status: "original", language: "ko" },
    ] })));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(textCalls, 0, "a source interim must not buy a Gemini preview");
    assert.equal(events.some((event) => event.type === "subtitle:partial" && event.translationProvider === "gemini"), false,
      JSON.stringify(events));

    // The provider's own translation still flows, and the final still commits.
    socket.emit("message", Buffer.from(JSON.stringify({ tokens: [
      { text: "안녕하세요", is_final: true, translation_status: "original", language: "ko", start_ms: 0, end_ms: 800 },
      { text: "Hello", is_final: true, translation_status: "translation", language: "en", source_language: "ko" },
      { text: "<end>", is_final: true },
    ] })));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(textCalls, 0, "a provider-translated final is never re-translated");
    const committed = events.filter((event) => event.type === "subtitle:committed");
    assert.equal(committed.length, 1, JSON.stringify(events));
    assert.equal(committed[0].translationProvider, "soniox");
    assert.equal(events.some((event) => event.type === "subtitle:partial" && event.translationProvider === "gemini"), false);
  } finally { await manager.stop(); }
});

test("one source opens one Transcribe session and final source fans out through text translation", async () => {
  const requests = [];
  const translations = { ko: "쿠시먼앤드웨이크필드의 순영업소득입니다.", ja: "クッシュマン・アンド・ウェイクフィールドのNOIです。" };
  const { manager, sockets, events } = createHarness({
    polish: async (request) => {
      requests.push(request);
      return translations[request.targetLanguage] ?? request.sourceText;
    },
  });

  await manager.start({ sessionId: "transcribe-final" });
  assert.equal(sockets.length, 1);
  sockets[0].open();
  const setup = JSON.parse(sockets[0].sent[0]);
  assert.equal(setup.setup.model, "models/gemini-3.5-transcribe-live");
  assert.deepEqual(setup.setup.generationConfig.responseModalities, ["TEXT"]);
  assert.equal(setup.setup.inputAudioTranscription.mode, "VERBATIM");
  sockets[0].emit("message", JSON.stringify({ setupComplete: {} }));
  sockets[0].emit("message", JSON.stringify({
    serverContent: {
      inputTranscription: {
        text: "Cushman & Wakefield NOI update.",
        languageCode: "en-US",
      },
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(requests.map((request) => request.targetLanguage).sort(), ["ja", "ko"]);
  assert.equal(requests.every((request) => request.translatedText === "…"), true);
  const committed = events.filter((event) => event.type === "subtitle:committed");
  assert.equal(committed.length, 2);
  assert.equal(committed.some((event) => event.targetLanguage === "en"), false);
  assert.equal(events.some((event) => event.type === "subtitle:translated-audio"), false);
});

test("latest interim wins, publishes translated preview only, and final invalidates stale partial", async () => {
  let releaseFirst;
  const firstTranslation = new Promise((resolve) => { releaseFirst = resolve; });
  const requests = [];
  const { manager, sockets, events } = createHarness({
    settings: { translationLanguages: ["en", "ko"] },
    polish: async (request) => {
      requests.push(request.sourceText);
      if (request.sourceText === "First draft") return firstTranslation;
      if (request.sourceText === "Final sentence") return "최종 문장";
      return "두 번째 초안";
    },
  });

  await manager.start({ sessionId: "transcribe-interim" });
  sockets[0].open();
  sockets[0].emit("message", JSON.stringify({ setupComplete: {} }));
  sockets[0].emit("message", JSON.stringify({ serverContent: { interimInputTranscription: { text: "First draft", languageCode: "en-US" } } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  sockets[0].emit("message", JSON.stringify({ serverContent: { interimInputTranscription: { text: "Second draft", languageCode: "en-US" } } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  sockets[0].emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "Final sentence", languageCode: "en-US" } } }));
  releaseFirst("폐기할 첫 초안");
  await new Promise((resolve) => setTimeout(resolve, 30));

  const partials = events.filter((event) => event.type === "subtitle:partial");
  assert.equal(partials.some((event) => event.translatedText === "폐기할 첫 초안"), false);
  assert.equal(partials.every((event) => event.translatedText !== event.sourceText), true);
  assert.equal(events.some((event) => event.type === "subtitle:committed" && event.translatedText === "최종 문장"), true);
});

test("interim preview translation is physically bounded to one Gemini text call per lane", async () => {
  let active = 0;
  let maxActive = 0;
  let releases = [];
  const requested = [];
  const { manager, sockets } = createHarness({
    settings: { translationLanguages: ["en", "ko"] },
    polish: async (request) => {
      if (request.targetLanguage !== "ko") return request.sourceText;
      active += 1;
      maxActive = Math.max(maxActive, active);
      requested.push(request.sourceText);
      await new Promise((resolve) => { releases.push(resolve); });
      active -= 1;
      return request.sourceText === "Preview three" ? "미리보기 셋" : "오래된 미리보기";
    },
  });

  await manager.start({ sessionId: "transcribe-preview-backpressure" });
  sockets[0].open();
  sockets[0].emit("message", JSON.stringify({ setupComplete: {} }));
  sockets[0].emit("message", JSON.stringify({ serverContent: { interimInputTranscription: { text: "Preview one", languageCode: "en-US" } } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  sockets[0].emit("message", JSON.stringify({ serverContent: { interimInputTranscription: { text: "Preview two", languageCode: "en-US" } } }));
  sockets[0].emit("message", JSON.stringify({ serverContent: { interimInputTranscription: { text: "Preview three", languageCode: "en-US" } } }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(maxActive, 1);
  assert.deepEqual(requested, ["Preview one"]);
  releases.shift()?.();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(maxActive, 1);
  assert.deepEqual(requested, ["Preview one", "Preview three"]);
  releases.shift()?.();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await manager.stop();
});

test("translation failure never leaks source text into a target caption lane", async () => {
  const { manager, sockets, events } = createHarness({
    settings: { translationLanguages: ["en", "ko"] },
    polish: async () => { throw new Error("provider unavailable"); },
  });

  await manager.start({ sessionId: "transcribe-failure" });
  sockets[0].open();
  sockets[0].emit("message", JSON.stringify({ setupComplete: {} }));
  sockets[0].emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "Confidential source", languageCode: "en-US" } } }));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(
    events.some((event) => ["subtitle:partial", "subtitle:committed"].includes(event.type)),
    false,
    JSON.stringify(events),
  );
  assert.equal(events.some((event) => event.code === "TEXT_TRANSLATION_FAILED"), true);
});

test("Transcribe session rolls before the ten-minute provider limit", async () => {
  const { manager, sockets } = createHarness({
    settings: { translationLanguages: ["en", "ko"] },
    polish: async () => "번역",
    transcribeRolloverMs: 20,
    transcribeFinalDrainMs: 5,
    reconnectBaseMs: 1,
  });

  await manager.start({ sessionId: "transcribe-rollover" });
  sockets[0].open();
  sockets[0].emit("message", JSON.stringify({ setupComplete: {} }));
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].readyState, WebSocket.CLOSED);
  await manager.stop();
});

test("Transcribe rollover drains the old socket and preserves bounded new audio for the next socket", async () => {
  const { manager, sockets, events } = createHarness({
    settings: { translationLanguages: ["en", "ko"] },
    polish: async () => "번역",
    transcribeRolloverMs: 15,
    transcribeFinalDrainMs: 10,
    reconnectBaseMs: 1,
  });

  await manager.start({ sessionId: "transcribe-rollover-tail" });
  sockets[0].deferClose = true;
  sockets[0].open();
  sockets[0].emit("message", JSON.stringify({ setupComplete: {} }));
  const initialAudio = Buffer.alloc(4_800, 1).toString("base64");
  manager.sendAudio({ sessionId: "transcribe-rollover-tail", source: "mic", audio: initialAudio });
  await new Promise((resolve) => setTimeout(resolve, 18));

  const closePayload = JSON.stringify({ realtimeInput: { audioStreamEnd: true } });
  assert.equal(sockets[0].sent.includes(closePayload), true);
  sockets[0].emit("message", JSON.stringify({
    serverContent: { inputTranscription: { text: "Tail sentence", languageCode: "en-US" } },
  }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(events.some((event) => event.type === "subtitle:committed" && event.sourceText === "Tail sentence"), true);
  const oldAudioPayloadCount = sockets[0].sent.filter((value) => {
    try { return Boolean(JSON.parse(value).realtimeInput?.audio); } catch { return false; }
  }).length;
  for (let index = 0; index < 12; index += 1) {
    manager.sendAudio({
      sessionId: "transcribe-rollover-tail",
      source: "mic",
      audio: Buffer.alloc(4_800, index + 2).toString("base64"),
    });
  }
  assert.equal(sockets[0].sent.filter((value) => {
    try { return Boolean(JSON.parse(value).realtimeInput?.audio); } catch { return false; }
  }).length, oldAudioPayloadCount, "new frames must not be written after audioStreamEnd");

  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.equal(sockets[0].closeCalls > 0, true);
  sockets[0].deferClose = false;
  sockets[0].finishClose();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sockets.length, 2);
  sockets[1].open();
  sockets[1].emit("message", JSON.stringify({ setupComplete: {} }));

  const replayedAudio = sockets[1].sent.filter((value) => {
    try { return Boolean(JSON.parse(value).realtimeInput?.audio); } catch { return false; }
  });
  assert.equal(replayedAudio.length, 8, "only the bounded newest rollover frames are preserved");
  await manager.stop();
});

test("mixed Korean speech still gets a Korean target translation while its mixed source remains unchanged", async () => {
  const sourceText = "이번 분기 Revenue와 Operating Margin이 개선됐습니다.";
  const requests = [];
  const { manager, sockets, events } = createHarness({
    settings: { translationLanguages: ["en", "ko"], glossary: "" },
    polish: async (request) => {
      requests.push(request);
      return request.targetLanguage === "ko" ? "이번 분기 매출과 영업 이익률이 개선됐습니다." : "Revenue and operating margin improved this quarter.";
    },
  });
  await manager.start({ sessionId: "mixed-korean-target" });
  try {
    sockets[0].open();
    sockets[0].emit("message", JSON.stringify({ setupComplete: {} }));
    sockets[0].emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: sourceText, languageCode: "ko" } } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const korean = events.filter((event) => event.type === "subtitle:committed" && event.targetLanguage === "ko");
    assert.equal(korean.length, 1);
    assert.equal(korean[0].sourceText, sourceText);
    assert.equal(korean[0].translatedText, "이번 분기 매출과 영업 이익률이 개선됐습니다.");
    assert.equal(requests.filter((request) => request.targetLanguage === "ko").length, 1);
  } finally { await manager.stop(); }
});

test("desktop finals reject unregistered capitalized English but accept explicit identity-preserved product names without retry", async () => {
  for (const [glossary, translated, expected] of [
    ["", "이번 분기 Revenue가 늘었습니다.", 0],
    ["iPhone = iPhone", "iPhone 매출이 늘었습니다.", 1],
  ]) {
    let calls = 0;
    const { manager, sockets, events } = createHarness({
      settings: { translationLanguages: ["en", "ko"], glossary },
      polish: async () => { calls++; return translated; },
    });
    await manager.start({ sessionId: `target-quality-${expected}` });
    try {
      sockets[0].open();
      sockets[0].emit("message", JSON.stringify({ setupComplete: {} }));
      sockets[0].emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "Product revenue has increased.", languageCode: "en" } } }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(events.filter((event) => event.type === "subtitle:committed" && event.targetLanguage === "ko").length, expected);
      assert.equal(calls, 1);
    } finally { await manager.stop(); }
  }
});


test("desktop previews apply the same Korean output and protected-term rules with one call", async () => {
  for (const [glossary, translated, expected] of [
    ["", "이번 분기 Revenue가 늘었습니다.", 0],
    ["iPhone = iPhone", "iPhone 매출이 늘었습니다.", 1],
  ]) {
    let calls = 0;
    const { manager, sockets, events } = createHarness({
      settings: { translationLanguages: ["en", "ko"], glossary },
      polish: async () => { calls++; return translated; },
    });
    await manager.start({ sessionId: `preview-quality-${expected}` });
    try {
      sockets[0].open();
      sockets[0].emit("message", JSON.stringify({ setupComplete: {} }));
      sockets[0].emit("message", JSON.stringify({ serverContent: { interimInputTranscription: { text: "Product revenue has increased.", languageCode: "en" } } }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(events.filter((event) => event.type === "subtitle:partial" && event.targetLanguage === "ko").length, expected);
      assert.equal(calls, 1);
    } finally { await manager.stop(); }
  }
});

test("pure or explicitly preserved Korean sources never add a same-target model call", async () => {
  for (const text of ["이번 분기 매출이 늘었습니다.", "iPhone 매출이 늘었습니다."]) {
    const requests = [];
    const { manager, sockets } = createHarness({
      settings: { translationLanguages: ["en", "ko"], glossary: "iPhone = iPhone" },
      polish: async (request) => { requests.push(request); return "Revenue has increased."; },
    });
    await manager.start({ sessionId: "source-copy-quality" });
    try {
      sockets[0].open();
      sockets[0].emit("message", JSON.stringify({ setupComplete: {} }));
      sockets[0].emit("message", JSON.stringify({ serverContent: { inputTranscription: { text, languageCode: "ko" } } }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(requests.map((request) => request.targetLanguage), ["en"]);
    } finally { await manager.stop(); }
  }
});

// Spike 2026-09-02: Soniox finishes a stream only on an empty TEXT frame. The
// empty BINARY frame the transport used to send left the provider waiting until
// the drain timeout, so end-of-audio must reach the wire as a string.
test("a graceful soniox stop ends the stream with an empty text frame while audio stays binary", async () => {
  const { manager, sockets } = createSonioxHarness();
  await manager.start({ sessionId: "soniox-text-close" });
  const socket = sockets[0];
  socket.open();
  manager.sendAudio({ sessionId: "soniox-text-close", source: "mic", audio: audioFrame() });
  await manager.stop();
  assert.equal(socket.sent.at(-1), "", "end of audio is an empty string frame");
  assert.equal(socket.sendOptions.at(-1)?.binary, undefined, "the closing frame is sent as text, not binary");
  assert.ok(Buffer.isBuffer(socket.sent.at(-2)), "the audio frame before it is still a Buffer");
  assert.equal(socket.sendOptions.at(-2)?.binary, true, "audio frames are still binary");
});

// The transport can ask the client to send a control frame on its own
// initiative (Soniox's finalize timer). The hook rides on the handleMessage ctx,
// sends a text frame on the live socket only, and reports whether it did.
test("ctx.sendControl sends a text frame on the live socket and is a no-op after close", async () => {
  const results = [];
  let ctxRef = null;
  const transport = {
    ...createFakeCombinedTransport(),
    handleMessage(raw, ctx) {
      ctxRef = ctx;
      const message = JSON.parse(String(raw));
      if (message.ready) ctx.onTransportReady();
      if (message.control) results.push(ctx.sendControl(message.control));
    },
  };
  const { manager, sockets } = createHarness({
    settings: { translationLanguages: ["en", "ko"] },
    polish: async () => "unused",
    createSttTransport: () => transport,
  });
  await manager.start({ sessionId: "control-frame" });
  const socket = sockets[0];
  socket.open();
  socket.emit("message", JSON.stringify({ ready: true }));
  socket.emit("message", JSON.stringify({ control: '{"type":"finalize"}' }));
  assert.deepEqual(results, [true]);
  assert.equal(socket.sent.at(-1), '{"type":"finalize"}');
  assert.equal(socket.sendOptions.at(-1)?.binary, undefined, "control frames are text");
  await manager.stop();
  const sentBefore = socket.sent.length;
  assert.equal(ctxRef.sendControl('{"type":"finalize"}'), false, "a closed client refuses to send");
  assert.equal(socket.sent.length, sentBefore);
});
