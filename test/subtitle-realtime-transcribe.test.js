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

  send(value) {
    this.sent.push(value);
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

function createHarness({ polish, settings = {}, ...options } = {}) {
  const sockets = [];
  const events = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (event) => events.push(event),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "test-key", geminiSecondary: "" },
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
