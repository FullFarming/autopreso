import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { LiveMediaPipeline } from "../src/live-media-pipeline.js";

const TARGET_TEXT = {
  en: "translated business update",
  ja: "翻訳済み事業アップデート",
};

test("production Live Call uses one host STT stream, no Gemini Live audio, and at most three caption lanes", async () => {
  const events = [];
  const translationCalls = [];
  const speechSessions = [];
  let emitPartial = () => undefined;
  let emitFinal = () => undefined;
  const dependencies = {
    // Deliberately no liveTranslate dependency: this is the server.js
    // production contract, not the legacy provider compatibility seam.
    speechToText: {
      async open(options) {
        emitPartial = options.onPartialTranscript;
        emitFinal = options.onFinalUtterance;
        const session = {
          frames: 0,
          async sendAudio() { this.frames += 1; },
          async close() {},
          async getFinalWords() { return []; },
        };
        speechSessions.push(session);
        return session;
      },
    },
    textTranslate: {
      async translate({ language }) {
        translationCalls.push(language);
        return TARGET_TEXT[language];
      },
    },
    publisher: {
      async persistAuthoritativeSource() {
        return {
          sourceUtteranceId: "00000000-0000-4000-8000-000000000001",
          sourceSeq: 1,
          idempotent: false,
        };
      },
      async publish(_sessionId, _language, event) { events.push(event); },
      async publishAudio() { throw new Error("AUDIO_OUTPUT_FORBIDDEN"); },
    },
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "captions-only",
    sessionType: "presentation",
    outputMode: "captions",
    maxViewers: 200,
    languages: ["ko", "en", "ja"],
    dependencies,
    now: () => 0,
  });
  await pipeline.start();
  assert.equal(speechSessions.length, 1);

  await pipeline.acceptAudio(new Uint8Array(1_280), 0, undefined, "mic");
  assert.equal(speechSessions[0].frames, 1);
  await assert.rejects(
    () => pipeline.acceptAudio(new Uint8Array(1_280), 0, undefined, "system"),
    /MULTIPLE_HOST_AUDIO_SOURCES_FORBIDDEN/u,
  );

  emitPartial({ text: "사업 업데이트입니다", sourceLanguage: "ko-KR" });
  await new Promise((resolve) => setImmediate(resolve));
  const partials = events.filter((event) => event.type === "caption" && !event.isFinal);
  assert.deepEqual(partials.map((event) => event.language), ["ko"]);
  assert.equal(translationCalls.length, 0, "interim speech must not multiply Gemini text calls");

  await emitFinal({
    speakerLabel: "1",
    text: "사업 업데이트입니다",
    sourceLanguage: "ko-KR",
    sourceStartOffsetMs: 0,
    sourceEndOffsetMs: 1_000,
    sourceEndedAt: "2026-08-29T01:00:01.000Z",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await pipeline.close();

  assert.deepEqual(translationCalls.sort(), ["en", "ja"]);
  const finals = events.filter((event) => event.type === "caption" && event.isFinal);
  assert.deepEqual(finals.map((event) => event.language).sort(), ["en", "ja", "ko"]);
  assert.ok(finals.every((event) => event.type === "caption"));
});


test("production Gateway defaults to a two-hour host audio budget", () => {
  const source = readFileSync(new URL("../src/gateway-server.js", import.meta.url), "utf8");
  assert.match(source, /maxSessionAudioMilliseconds = 2 \* 60 \* 60 \* 1_000/u);
  assert.match(source, /maxSessionAudioBytes = INPUT_BYTES_PER_SECOND \* 2 \* 60 \* 60/u);
});

test("participant floor audio shares the captions-only STT stream without tripping the host source pin", async () => {
  const speechSessions = [];
  const dependencies = {
    speechToText: {
      async open() {
        const session = {
          frames: 0,
          async sendAudio() { this.frames += 1; },
          async close() {},
          async getFinalWords() { return []; },
        };
        speechSessions.push(session);
        return session;
      },
    },
    textTranslate: { async translate() { return "translated"; } },
    publisher: {
      async persistAuthoritativeSource() {
        return {
          sourceUtteranceId: "00000000-0000-4000-8000-000000000001",
          sourceSeq: 1,
          idempotent: false,
        };
      },
      async publish() {},
    },
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "captions-only-meeting",
    sessionType: "meeting",
    outputMode: "captions",
    maxViewers: 200,
    languages: ["ko", "en"],
    dependencies,
    now: () => 0,
  });
  await pipeline.start();

  // Host pins first, a participant takes the floor, then the host resumes.
  await pipeline.acceptAudio(new Uint8Array(1_280), 0, undefined, "mic");
  const floorSpeaker = {
    participantId: "00000000-0000-4000-8000-0000000000aa",
    displayName: "참가자",
    department: null,
    jobTitle: null,
  };
  await pipeline.acceptAudio(new Uint8Array(1_280), 0, floorSpeaker, "participant");
  await pipeline.acceptAudio(new Uint8Array(1_280), 0, undefined, "mic");
  assert.equal(speechSessions[0].frames, 3);

  // The pin still rejects a second HOST capture source.
  await assert.rejects(
    () => pipeline.acceptAudio(new Uint8Array(1_280), 0, undefined, "system"),
    /MULTIPLE_HOST_AUDIO_SOURCES_FORBIDDEN/u,
  );

  await pipeline.close();
});

test("participant floor audio arriving first does not steal the host source pin", async () => {
  const speechSessions = [];
  const dependencies = {
    speechToText: {
      async open() {
        const session = {
          frames: 0,
          async sendAudio() { this.frames += 1; },
          async close() {},
          async getFinalWords() { return []; },
        };
        speechSessions.push(session);
        return session;
      },
    },
    textTranslate: { async translate() { return "translated"; } },
    publisher: {
      async persistAuthoritativeSource() {
        return {
          sourceUtteranceId: "00000000-0000-4000-8000-000000000001",
          sourceSeq: 1,
          idempotent: false,
        };
      },
      async publish() {},
    },
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "captions-only-meeting-2",
    sessionType: "meeting",
    outputMode: "captions",
    maxViewers: 200,
    languages: ["ko", "en"],
    dependencies,
    now: () => 0,
  });
  await pipeline.start();

  const floorSpeaker = {
    participantId: "00000000-0000-4000-8000-0000000000aa",
    displayName: "참가자",
    department: null,
    jobTitle: null,
  };
  await pipeline.acceptAudio(new Uint8Array(1_280), 0, floorSpeaker, "participant");
  await pipeline.acceptAudio(new Uint8Array(1_280), 0, undefined, "mic");
  assert.equal(speechSessions[0].frames, 2);

  await pipeline.close();
});

test("final translation receives the previous committed source sentences as rolling context", async () => {
  const translateInputs = [];
  let emitFinal = () => undefined;
  let sourceSeq = 0;
  const dependencies = {
    speechToText: {
      async open(options) {
        emitFinal = options.onFinalUtterance;
        return {
          async sendAudio() {},
          async close() {},
          async getFinalWords() { return []; },
        };
      },
    },
    textTranslate: {
      async translate(input) {
        translateInputs.push(input);
        return "translated";
      },
    },
    publisher: {
      async persistAuthoritativeSource() {
        sourceSeq += 1;
        return {
          sourceUtteranceId: `00000000-0000-4000-8000-00000000000${sourceSeq}`,
          sourceSeq,
          idempotent: false,
        };
      },
      async publish() {},
    },
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "captions-context",
    sessionType: "presentation",
    outputMode: "captions",
    languages: ["ko", "en"],
    dependencies,
    now: () => 0,
  });
  await pipeline.start();

  const finals = [
    "순영업소득이 작년에 크게 올랐습니다",
    "이번 분기에도 다시 올랐습니다",
    "내년에는 더 오를 전망입니다",
  ];
  for (const [index, text] of finals.entries()) {
    await emitFinal({
      speakerLabel: "1",
      text,
      sourceLanguage: "ko-KR",
      sourceStartOffsetMs: index * 1_000,
      sourceEndOffsetMs: (index + 1) * 1_000,
      sourceEndedAt: `2026-08-29T01:00:0${index + 1}.000Z`,
    });
    // The per-language queues start their tasks on a macrotask tick; without
    // this flush close() would cancel translations that never got to run.
    await new Promise((resolve) => setImmediate(resolve));
  }
  await pipeline.close();

  assert.equal(translateInputs.length, 3);
  assert.equal(translateInputs[0].recentSourceText ?? "", "");
  assert.match(translateInputs[1].recentSourceText, /순영업소득이 작년에/u);
  assert.match(translateInputs[2].recentSourceText, /순영업소득이 작년에/u);
  assert.match(translateInputs[2].recentSourceText, /이번 분기에도/u);
  assert.doesNotMatch(translateInputs[2].recentSourceText, /내년에는/u, "the current utterance is not its own context");
});
