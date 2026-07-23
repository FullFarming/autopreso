import assert from "node:assert/strict";
import test from "node:test";

import { buildGeminiSetupMessage, createGeminiAudioPacketizer, handleGeminiLiveMessage } from "./geminiChannel";
import type { TransportCtx } from "./channelCore";

function createContext() {
  let sourceText = "";
  const languageEvidence: Array<{ delta: string; code: unknown }> = [];
  const ctx = {
    source: "mic",
    targetLanguage: "ko",
    getSourceText: () => sourceText,
    setSourceText: (value: string) => { sourceText = value; },
    getTranslatedText: () => "",
    setTranslatedText() {},
    shouldDisplay: () => true,
    rememberSourceTranscriptDelta: (delta: string, code?: unknown) => { languageEvidence.push({ delta, code }); },
    rememberSourceTranscriptSnapshot() {},
    emitPartial() {},
    scheduleCommit() {},
    commitSubtitle() {},
    resetUtterance() {},
    onSessionClosed() {},
    onTransportReady() {},
    getResumptionHandle: () => "",
    setResumptionHandle(_handle: string) {},
    onServerGoAway() {},
    send() {},
    broadcast() {},
  } satisfies TransportCtx;
  return { ctx, languageEvidence };
}

test("Gemini input transcription forwards provider languageCode with script text", () => {
  const { ctx, languageEvidence } = createContext();
  handleGeminiLiveMessage(JSON.stringify({
    serverContent: { inputTranscription: { text: "Good morning 김민수", languageCode: "en-US" } },
  }), ctx);
  handleGeminiLiveMessage(JSON.stringify({
    serverContent: { inputTranscription: { text: "오늘 ADR과 GOP를 검토합니다", languageCode: "ko-KR" } },
  }), ctx);

  assert.deepEqual(languageEvidence, [
    { delta: "Good morning 김민수", code: "en-US" },
    { delta: "오늘 ADR과 GOP를 검토합니다", code: "ko-KR" },
  ]);
});

test("Gemini setup preserves canonical simplified and traditional Chinese targets", () => {
  const simplified = JSON.parse(buildGeminiSetupMessage("zh-Hans"));
  const traditional = JSON.parse(buildGeminiSetupMessage("zh-Hant"));
  assert.equal(simplified.setup.generationConfig.translationConfig.targetLanguageCode, "zh-Hans");
  assert.equal(traditional.setup.generationConfig.translationConfig.targetLanguageCode, "zh-Hant");
  assert.equal(JSON.parse(buildGeminiSetupMessage("ko")).setup.generationConfig.translationConfig.targetLanguageCode, "ko-KR");
});

test("Gemini setup resumes the same logical session and GoAway requests proactive reconnect", () => {
  const setup = JSON.parse(buildGeminiSetupMessage("ko", "resume-handle"));
  assert.deepEqual(setup.setup.sessionResumption, { handle: "resume-handle" });
  const { ctx } = createContext();
  let handle = "";
  let reconnects = 0;
  ctx.setResumptionHandle = (value: string) => { handle = value; };
  ctx.onServerGoAway = () => { reconnects += 1; };
  handleGeminiLiveMessage(JSON.stringify({ sessionResumptionUpdate: { resumable: true, newHandle: "next-handle" } }), ctx);
  handleGeminiLiveMessage(JSON.stringify({ goAway: { timeLeft: "5s" } }), ctx);
  assert.equal(handle, "next-handle");
  assert.equal(reconnects, 1);
});

function pcm24kChunk(fill: number): string {
  return Buffer.alloc(1_920, fill).toString("base64");
}

test("Gemini packetizer converts three 40 ms inputs into one exact 100 ms frame and keeps a 20 ms tail", () => {
  const packetizer = createGeminiAudioPacketizer();
  assert.deepEqual(packetizer.push(pcm24kChunk(1)), []);
  assert.deepEqual(packetizer.push(pcm24kChunk(2)), []);
  const first = packetizer.push(pcm24kChunk(3));
  assert.equal(first.length, 1);
  assert.equal(Buffer.from(first[0], "base64").byteLength, 3_200);

  assert.deepEqual(packetizer.push(pcm24kChunk(4)), []);
  const second = packetizer.push(pcm24kChunk(5));
  assert.equal(second.length, 1, "the saved 20 ms tail must complete with two later 40 ms inputs");
  assert.equal(Buffer.from(second[0], "base64").byteLength, 3_200);
});

test("Gemini packetizer reset prevents a paused or reconnected stream from inheriting an old tail", () => {
  const packetizer = createGeminiAudioPacketizer();
  packetizer.push(pcm24kChunk(1));
  packetizer.reset();
  packetizer.push(pcm24kChunk(2));
  packetizer.push(pcm24kChunk(2));
  const output = packetizer.push(pcm24kChunk(2));
  assert.equal(output.length, 1);
  assert.deepEqual([...Buffer.from(output[0], "base64")], new Array(3_200).fill(2));
});
