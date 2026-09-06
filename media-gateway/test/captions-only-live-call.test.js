import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { LiveMediaPipeline } from "./helpers/gemini-pipeline.js";
import { GEMINI_ENGINE_SELECTION as DEFAULT_ENGINE_SELECTION } from "../../packages/caption-core/caption-engine-catalog.js";
import { createGeminiCaptionConfig } from "../../packages/caption-core/index.js";

const TARGET_TEXT = {
  en: "translated business update",
  ja: "翻訳済み事業アップデート",
};

test("one STT stream feeds every caption lane; targets are translated once per committed final", async () => {
  const events = [];
  const translationCalls = [];
  const speechSessions = [];
  let emitPartial = () => undefined;
  let emitFinal = () => undefined;
  const dependencies = {
    // Injected provider seams; production server.js builds the same two
    // dependencies from the session's engine selection via engines/create-engines.js.
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

test("legacy injected STT participant floor does not trip the host source pin", async () => {
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


const SONIOX_ENGINE = Object.freeze({
  stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" },
  translation: { provider: "soniox", model: "stt-rt-v5" },
  summary: { provider: "gemini", model: "gemini-3.6-flash" },
});

const KOREAN_SOURCE = "사업 업데이트입니다";

function createEngineHarness({ engine, textTranslate, languages = ["ko", "en"], sessionType = "presentation" }) {
  const events = [];
  const hostEvents = [];
  const sourceWrites = [];
  const stream = { onPartialTranscript: null, onPartialTranslation: null, onFinalUtterance: null, onContinuityDiscard: null };
  const dependencies = {
    speechToText: {
      async open(options) {
        Object.assign(stream, {
          onPartialTranscript: options.onPartialTranscript,
          onPartialTranslation: options.onPartialTranslation,
          onFinalUtterance: options.onFinalUtterance,
          onContinuityDiscard: options.onContinuityDiscard,
        });
        return { supportsRolloverRemap: false, async sendAudio() {}, async close() {} };
      },
    },
    textTranslate,
    publisher: {
      async persistAuthoritativeSource(input) {
        sourceWrites.push(input);
        return {
          sourceUtteranceId: `00000000-0000-4000-8000-${String(sourceWrites.length).padStart(12, "0")}`,
          sourceSeq: sourceWrites.length,
          idempotent: false,
        };
      },
      async publish(_sessionId, _language, event) { events.push(event); },
      async publishSourceStatus(event) { events.push(event); },
    },
  };
  const captionConfig = createGeminiCaptionConfig({ engine, languages });
  const pipeline = new LiveMediaPipeline({
    sessionId: "engine-harness",
    sessionType,
    outputMode: "captions",
    maxViewers: 200,
    languages,
    captionConfig,
    dependencies,
    onHostEvent: (event) => hostEvents.push(event),
    now: () => 0,
  });
  return { pipeline, events, hostEvents, sourceWrites, stream, tick: () => new Promise((resolve) => setImmediate(resolve)) };
}

function koreanFinal(overrides = {}) {
  return {
    speakerLabel: "speaker-1",
    text: KOREAN_SOURCE,
    sourceLanguage: "ko",
    sourceStartOffsetMs: 0,
    sourceEndOffsetMs: 1_000,
    sourceEndedAt: "2026-09-03T01:00:01.000Z",
    ...overrides,
  };
}

test("combined engine: the final's attached translation becomes the target caption without any text-translate call", async () => {
  const h = createEngineHarness({ engine: SONIOX_ENGINE, textTranslate: null });
  assert.equal(h.pipeline.isCombined, true);
  await h.pipeline.start();
  await h.stream.onFinalUtterance(koreanFinal({ translations: { en: { text: "This is a business update.", sourceLanguage: "ko" } } }));
  await h.tick();
  await h.pipeline.close();

  const finals = h.events.filter((event) => event.type === "caption" && event.isFinal);
  const english = finals.find((event) => event.language === "en");
  const korean = finals.find((event) => event.language === "ko");
  assert.equal(english.text, "This is a business update.");
  assert.equal(english.translationStatus, "translated");
  assert.equal(english.translationModel, "stt-rt-v5");
  assert.equal(english.sourceText, KOREAN_SOURCE);
  assert.equal(english.seq, 1);
  assert.equal(korean.translationStatus, "verbatim");
  assert.equal(Object.hasOwn(korean, "translationModel"), false, "the source lane is not a translation");
  assert.equal(h.sourceWrites.length, 1);
  assert.equal(h.sourceWrites[0].sttProvider, "soniox");
  assert.equal(h.sourceWrites[0].sttModel, "stt-rt-v5");
  assert.equal(h.sourceWrites[0].translationModel, "stt-rt-v5");
});

test("combined engine: a partial translation paints the target lane as an interim carrying the coming final's seq (contract C1)", async () => {
  const h = createEngineHarness({ engine: SONIOX_ENGINE, textTranslate: null });
  await h.pipeline.start();
  h.stream.onPartialTranslation({ language: "en", text: "This is a busi", sourceLanguage: "ko" });
  await h.tick();
  let interims = h.events.filter((event) => event.type === "caption" && !event.isFinal && event.language === "en");
  assert.equal(interims.length, 1);
  assert.equal(interims[0].text, "This is a busi");
  assert.equal(interims[0].seq, 1, "an interim carries the seq the coming final will take");
  assert.equal(interims[0].translationStatus, "translated");
  assert.equal(interims[0].sourceLanguage, "ko");
  assert.deepEqual(h.pipeline.lastSequences, { ko: 0, en: 0 }, "interims never consume a seq");

  await h.stream.onFinalUtterance(koreanFinal({ translations: { en: { text: "This is a business update.", sourceLanguage: "ko" } } }));
  await h.tick();
  const englishFinal = h.events.find((event) => event.type === "caption" && event.isFinal && event.language === "en");
  assert.equal(englishFinal.seq, 1, "the final takes exactly the seq the interim announced");

  h.stream.onPartialTranslation({ language: "en", text: "Next sentence", sourceLanguage: "ko" });
  await h.tick();
  interims = h.events.filter((event) => event.type === "caption" && !event.isFinal && event.language === "en");
  assert.equal(interims.at(-1).seq, 2);
  assert.deepEqual(h.pipeline.lastSequences, { ko: 1, en: 1 });

  // Same-language and unknown-lane interims are ignored: the source lane's
  // verbatim interim already covers the former, the latter has no viewers.
  h.stream.onPartialTranslation({ language: "ko", text: "사업", sourceLanguage: "ko" });
  h.stream.onPartialTranslation({ language: "ja", text: "事業", sourceLanguage: "ko" });
  await h.tick();
  assert.equal(h.events.filter((event) => event.type === "caption" && !event.isFinal && event.language !== "en").length, 0);
  await h.pipeline.close();
});

test("combined engine: a final missing its target lane publishes the original labelled failed and marks the lane unavailable", async () => {
  const h = createEngineHarness({ engine: SONIOX_ENGINE, textTranslate: null });
  await h.pipeline.start();
  await h.stream.onFinalUtterance(koreanFinal({ translations: {} }));
  await h.tick();
  await h.pipeline.close();
  const english = h.events.find((event) => event.type === "caption" && event.isFinal && event.language === "en");
  assert.equal(english.translationStatus, "failed");
  assert.equal(english.text, KOREAN_SOURCE);
  assert.equal(english.seq, 1);
  assert.equal(Object.hasOwn(english, "translationModel"), false, "a fail-open caption names no model: nothing translated it");
  assert.ok(h.events.some((event) => event.type === "language-status" && event.language === "en"
    && event.status === "unavailable" && event.code === "LANGUAGE_UNAVAILABLE"));
});

test("combined engine: consecutive missing lanes stay fail-open and never enter the three-strike cooldown", async () => {
  const h = createEngineHarness({ engine: SONIOX_ENGINE, textTranslate: null });
  await h.pipeline.start();
  for (let index = 0; index < 4; index += 1) {
    await h.stream.onFinalUtterance(koreanFinal({
      text: `${KOREAN_SOURCE} ${index + 1}`,
      translations: {},
      sourceStartOffsetMs: index * 2_000,
      sourceEndOffsetMs: index * 2_000 + 1_000,
      sourceEndedAt: `2026-09-03T01:00:0${index + 1}.000Z`,
    }));
    await h.tick();
  }
  await h.pipeline.close();
  const english = h.events.filter((event) => event.type === "caption" && event.isFinal && event.language === "en");
  assert.deepEqual(english.map((event) => event.seq), [1, 2, 3, 4], "every missing lane still publishes a durable final");
  assert.deepEqual(english.map((event) => event.translationStatus), ["failed", "failed", "failed", "failed"]);
  assert.deepEqual(english.map((event) => event.text), [1, 2, 3, 4].map((n) => `${KOREAN_SOURCE} ${n}`));
  assert.equal(english.some((event) => Object.hasOwn(event, "translationModel")), false);
  assert.equal(h.events.some((event) => event.type === "language-status" && event.code === "LANGUAGE_COOLDOWN"), false,
    "a provider that cannot be re-asked must not be cooled down; the lane would go dark for 30 s");
  const korean = h.events.filter((event) => event.type === "caption" && event.isFinal && event.language === "ko");
  assert.deepEqual(korean.map((event) => event.seq), [1, 2, 3, 4]);
});

test("combined engine: the first translated lane after a run of misses re-announces the lane ready", async () => {
  const h = createEngineHarness({ engine: SONIOX_ENGINE, textTranslate: null });
  await h.pipeline.start();
  await h.stream.onFinalUtterance(koreanFinal({ translations: {} }));
  await h.tick();
  await h.stream.onFinalUtterance(koreanFinal({
    text: `${KOREAN_SOURCE} 둘`,
    translations: { en: { text: "This is the second business update." } },
    sourceStartOffsetMs: 2_000,
    sourceEndOffsetMs: 3_000,
    sourceEndedAt: "2026-09-03T01:00:03.000Z",
  }));
  await h.tick();
  await h.pipeline.close();
  const statuses = h.events.filter((event) => event.type === "language-status" && event.language === "en").map((event) => event.status);
  assert.deepEqual(statuses, ["ready", "unavailable", "ready"], "start-up ready, the miss, then the recovery re-announced");
  const english = h.events.filter((event) => event.type === "caption" && event.isFinal && event.language === "en");
  assert.deepEqual(english.map((event) => [event.seq, event.translationStatus]), [[1, "failed"], [2, "translated"]]);
  assert.equal(english[1].translationModel, "stt-rt-v5");
});

test("gemini engine: three consecutive translator failures still cool the lane down and the fourth final publishes nothing there", async () => {
  const h = createEngineHarness({
    engine: DEFAULT_ENGINE_SELECTION,
    textTranslate: { async translate() { throw new Error("GEMINI_TRANSLATE_FAILED"); } },
  });
  await h.pipeline.start();
  for (let index = 0; index < 4; index += 1) {
    await h.stream.onFinalUtterance(koreanFinal({
      text: `${KOREAN_SOURCE} ${index + 1}`,
      sourceStartOffsetMs: index * 2_000,
      sourceEndOffsetMs: index * 2_000 + 1_000,
      sourceEndedAt: `2026-09-03T01:00:0${index + 1}.000Z`,
    }));
    await h.tick();
  }
  await h.pipeline.close();
  assert.equal(h.events.filter((event) => event.type === "caption" && event.isFinal && event.language === "en").length, 0,
    "the Gemini path stays fail-closed: no caption on a lane whose translator failed");
  assert.equal(h.events.filter((event) => event.type === "language-status" && event.language === "en" && event.code === "LANGUAGE_COOLDOWN").length, 1);
  const korean = h.events.filter((event) => event.type === "caption" && event.isFinal && event.language === "ko");
  assert.deepEqual(korean.map((event) => event.seq), [1, 2, 3, 4]);
});

test("gemini engine: provenance names Transcribe Live and the model that actually produced each translation", async () => {
  const translateCalls = [];
  const h = createEngineHarness({
    engine: DEFAULT_ENGINE_SELECTION,
    textTranslate: {
      async translate() { throw new Error("PLAIN_TRANSLATE_MUST_NOT_BE_USED_WHEN_PROVENANCE_EXISTS"); },
      async translateWithProvenance(input) {
        translateCalls.push(input);
        return { text: "This is a business update.", provider: "gemini", model: "gemini-3.5-flash-lite", latencyMs: 12 };
      },
    },
  });
  assert.equal(h.pipeline.isCombined, false);
  await h.pipeline.start();
  await h.stream.onFinalUtterance(koreanFinal());
  await h.tick();
  await h.pipeline.close();
  assert.equal(translateCalls.length, 1);
  assert.equal(translateCalls[0].language, "en");
  const english = h.events.find((event) => event.type === "caption" && event.isFinal && event.language === "en");
  assert.equal(english.text, "This is a business update.");
  assert.equal(english.translationModel, "gemini-3.5-flash-lite", "the fallback model that produced the text is recorded, not the primary");
  assert.equal(h.sourceWrites[0].sttProvider, "gemini-transcribe-live");
  assert.equal(h.sourceWrites[0].sttModel, "gemini-3.5-transcribe-live");
  assert.equal(h.sourceWrites[0].translationModel, "gemini-3.6-flash");
});

test("a non-combined engine refuses to start without a text translator", () => {
  assert.throws(() => createEngineHarness({ engine: DEFAULT_ENGINE_SELECTION, textTranslate: null }), /TEXT_TRANSLATE_REQUIRED/u);
  assert.doesNotThrow(() => createEngineHarness({ engine: SONIOX_ENGINE, textTranslate: null }));
});

test("a provider that discards committed source text reports the original record as unavailable once", async () => {
  const h = createEngineHarness({ engine: SONIOX_ENGINE, textTranslate: null });
  await h.pipeline.start();
  h.stream.onContinuityDiscard({ reason: "SONIOX_MAX_DURATION" });
  h.stream.onContinuityDiscard({ reason: "SONIOX_MAX_DURATION" });
  await h.tick();
  const statuses = [...h.events, ...h.hostEvents].filter((event) => event.type === "source-status");
  assert.equal(statuses.length, 2, "one host mirror and one publisher fanout");
  assert.ok(statuses.every((event) => event.status === "unavailable" && event.code === "SOURCE_RECORDING_UNAVAILABLE"));
  await h.pipeline.close();
});
