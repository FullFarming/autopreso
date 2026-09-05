import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildGeminiTranscribeSetupMessage,
  createGeminiTranscribeTransport,
  handleGeminiTranscribeMessage,
} from "../src/gemini-live-transcribe.js";

const TEST_API_KEY = ["AIza", "local", "transcribe", "test"].join("-");

test("Gemini Transcribe setup pins v1beta TEXT and VERBATIM with bounded vocabulary", () => {
  const vocabulary = Array.from({ length: 105 }, (_, index) => `Term ${index + 1}`);
  const setup = JSON.parse(buildGeminiTranscribeSetupMessage({ customVocabulary: vocabulary }));

  assert.equal(setup.setup.model, "models/gemini-3.5-transcribe-live");
  assert.deepEqual(setup.setup.generationConfig.responseModalities, ["TEXT"]);
  assert.deepEqual(setup.setup.inputAudioTranscription.languageCodes, []);
  assert.equal(setup.setup.inputAudioTranscription.mode, "VERBATIM");
  assert.equal(setup.setup.inputAudioTranscription.customVocabulary.length, 100);
  assert.equal(Object.hasOwn(setup.setup, "outputAudioTranscription"), false);
  assert.equal(Object.hasOwn(setup.setup, "sessionResumption"), false);
});

test("Gemini Transcribe transport uses v1beta and sends only 16kHz PCM input", () => {
  const calls = [];
  const transport = createGeminiTranscribeTransport({ apiKey: TEST_API_KEY });
  transport.connect({
    createWebSocket: (...args) => {
      calls.push(args);
      return {};
    },
  });

  assert.match(calls[0][0], /\.v1beta\.GenerativeService\.BidiGenerateContent\?key=/u);
  assert.equal(calls[0][0].includes(encodeURIComponent(TEST_API_KEY)), true);
  const encoded = transport.audioPayload(Buffer.alloc(4_800).toString("base64"));
  if (typeof encoded !== "string") throw new Error("Expected one audio frame");
  const audio = JSON.parse(encoded);
  assert.equal(audio.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  assert.equal(Buffer.from(audio.realtimeInput.audio.data, "base64").length, 3_200);
  assert.equal(transport.closePayload(), JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
});

test("interim is preview-only and final is authoritative", () => {
  const events = [];
  const context = {
    onInterim: (event) => events.push({ kind: "interim", ...event }),
    onFinal: (event) => events.push({ kind: "final", ...event }),
  };

  handleGeminiTranscribeMessage(JSON.stringify({
    serverContent: {
      interimInputTranscription: { text: "쿠시먼", languageCode: "ko-KR" },
    },
  }), context);
  handleGeminiTranscribeMessage(JSON.stringify({
    serverContent: {
      inputTranscription: { text: "쿠시먼앤드웨이크필드", languageCode: "ko-KR" },
    },
  }), context);

  assert.deepEqual(events, [
    { kind: "interim", text: "쿠시먼", languageCode: "ko-KR" },
    { kind: "final", text: "쿠시먼앤드웨이크필드", languageCode: "ko-KR" },
  ]);
});

test("Transcribe ignores audio/model output and surfaces setup, goAway, and safe errors", () => {
  const events = [];
  const context = {
    onTransportReady: () => events.push("ready"),
    onServerGoAway: () => events.push("goAway"),
    broadcast: (event) => events.push(event),
  };

  handleGeminiTranscribeMessage(JSON.stringify({ setupComplete: {} }), context);
  handleGeminiTranscribeMessage(JSON.stringify({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } }] },
      outputTranscription: { text: "must be ignored" },
    },
  }), context);
  handleGeminiTranscribeMessage(JSON.stringify({ goAway: { timeLeft: "10s" } }), context);
  handleGeminiTranscribeMessage(JSON.stringify({ error: { status: "BAD", message: `${TEST_API_KEY} rejected` } }), context);

  assert.equal(events[0], "ready");
  assert.deepEqual(events[1], { type: "subtitle:status", status: "api_ready" });
  assert.equal(events[2], "goAway");
  assert.equal(events.length, 4);
  assert.equal(events[3].type, "subtitle:error");
  assert.equal(events[3].code, "GEMINI_TRANSCRIBE_ERROR");
  assert.equal(events[3].message.includes(TEST_API_KEY), false);
});

test('Gemini batches short frames to 100ms and flushes the remaining audio before ending', () => {
  const transport = createGeminiTranscribeTransport({ apiKey: 'fixture' });
  const shortFrame = Buffer.alloc(1920).toString('base64');
  assert.equal(transport.audioPayload(shortFrame), null);
  assert.equal(transport.audioPayload(shortFrame), null);
  const encoded = transport.audioPayload(shortFrame);
  if (typeof encoded !== "string") throw new Error("Expected one audio frame");
  const frame = JSON.parse(encoded);
  assert.equal(Buffer.from(frame.realtimeInput.audio.data, 'base64').length, 3200);
  const ending = transport.closePayload();
  assert.ok(Array.isArray(ending));
  assert.equal(Buffer.from(JSON.parse(ending[0]).realtimeInput.audio.data, 'base64').length, 640);
  assert.deepEqual(JSON.parse(ending[1]), { realtimeInput: { audioStreamEnd: true } });
});

test('Gemini classifies credential and transient provider failures for recovery', () => {
  const codes=[];
  handleGeminiTranscribeMessage(Buffer.from(JSON.stringify({error:{code:403,status:'PERMISSION_DENIED'}})), {onError:(code)=>codes.push(code)});
  handleGeminiTranscribeMessage(Buffer.from(JSON.stringify({error:{code:503,status:'UNAVAILABLE'}})), {onError:(code)=>codes.push(code)});
  assert.deepEqual(codes,['GEMINI_TRANSCRIBE_UNAUTHENTICATED','GEMINI_TRANSCRIBE_UNAVAILABLE']);
});
