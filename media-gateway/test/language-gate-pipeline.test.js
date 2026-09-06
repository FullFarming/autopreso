import assert from "node:assert/strict";
import test from "node:test";

import { LiveMediaPipeline } from "./helpers/gemini-pipeline.js";

const ENGLISH_UTTERANCE = Object.freeze({
  speakerLabel: "1",
  text: "We will review the Seoul office market and the tenant representation mandate today",
  sourceLanguage: "en",
  sourceStartOffsetMs: 0,
  sourceEndOffsetMs: 4_000,
  sourceEndedAt: "2026-08-27T00:00:00.000Z",
});

function createHarness({ languages = ["ko"], translate, glossaryText = "" } = {}) {
  const events = [];
  const sources = [];
  const translationCalls = [];
  let sourceSeq = 0;
  const pipeline = new LiveMediaPipeline({
    sessionId: "language-gate",
    sessionType: "meeting",
    outputMode: "captions",
    languages,
    glossaryText,
    dependencies: {
      speechToText: {
        async open() {
          return { async sendAudio() {}, async close() {}, async getFinalWords() { return []; } };
        },
      },
      textTranslate: {
        async translate(input) {
          translationCalls.push(input);
          if (translate) return translate(input);
          return input.language === "ko" ? "서울 오피스 시장을 검토하겠습니다." : "We will review the Seoul office market.";
        },
      },
      publisher: {
        async persistAuthoritativeSource(input) {
          sources.push(input);
          sourceSeq += 1;
          return {
            sourceUtteranceId: `00000000-0000-4000-8000-${String(sourceSeq).padStart(12, "0")}`,
            sourceSeq,
            idempotent: false,
          };
        },
        async publish(_sessionId, _language, event) { events.push(event); },
        async markLive() {},
      },
    },
  });
  return {
    pipeline,
    events,
    sources,
    translationCalls,
    captions: () => events.filter((event) => event.type === "caption"),
  };
}

test("a failed translation preserves its source without publishing target text", async () => {
  const harness = createHarness({ translate() { throw new Error("PROVIDER_UNAVAILABLE"); } });
  await harness.pipeline.start();
  await harness.pipeline.acceptFinalUtterance(ENGLISH_UTTERANCE);
  assert.equal(harness.captions().length, 0);
  assert.equal(harness.sources[0].rawText, ENGLISH_UTTERANCE.text);
  await harness.pipeline.close();
});

test("a provider echo is suppressed instead of presented as a translation", async () => {
  const harness = createHarness({ translate({ text }) { return text; } });
  await harness.pipeline.start();
  await harness.pipeline.acceptFinalUtterance(ENGLISH_UTTERANCE);
  assert.equal(harness.captions().length, 0);
  await harness.pipeline.close();
});

test("a valid target-language translation publishes normally", async () => {
  const harness = createHarness();
  await harness.pipeline.start();
  await harness.pipeline.acceptFinalUtterance(ENGLISH_UTTERANCE);
  const [caption] = harness.captions();
  assert.equal(caption.translationStatus, "translated");
  assert.match(caption.text, /서울 오피스 시장/u);
  await harness.pipeline.close();
});

test("Korean translations retain explicitly registered English names and acronyms", async () => {
  const harness = createHarness({
    glossaryText: "Cushman & Wakefield Korea = Cushman & Wakefield Korea\nADR = ADR\nRevPAR = RevPAR\nGOP = GOP",
    translate() { return "Cushman & Wakefield Korea의 ADR, RevPAR, GOP 지표입니다"; },
  });
  await harness.pipeline.start();
  await harness.pipeline.acceptFinalUtterance(ENGLISH_UTTERANCE);
  assert.equal(harness.captions()[0]?.translationStatus, "translated");
  await harness.pipeline.close();
});

test("failed and successful finals keep the durable sequence contiguous", async () => {
  let shouldFail = true;
  const harness = createHarness({
    translate() {
      if (shouldFail) throw new Error("PROVIDER_UNAVAILABLE");
      return "서울 오피스 시장을 다시 검토합니다.";
    },
  });
  await harness.pipeline.start();
  await harness.pipeline.acceptFinalUtterance(ENGLISH_UTTERANCE);
  shouldFail = false;
  await harness.pipeline.acceptFinalUtterance({
    ...ENGLISH_UTTERANCE,
    sourceStartOffsetMs: 5_000,
    sourceEndOffsetMs: 9_000,
    sourceEndedAt: "2026-08-27T00:00:05.000Z",
  });
  assert.deepEqual(harness.captions().map((caption) => caption.seq), [1]);
  assert.equal(harness.sources.length, 2);
  await harness.pipeline.close();
});

test("English with one Korean place name is translated on the Korean lane", async () => {
  const harness = createHarness();
  await harness.pipeline.start();
  await harness.pipeline.acceptFinalUtterance({
    ...ENGLISH_UTTERANCE,
    text: "We will review the 서울 office market today",
    sourceLanguage: "en-US",
  });
  assert.equal(harness.translationCalls.length, 1);
  assert.equal(harness.captions()[0]?.translationStatus, "translated");
  await harness.pipeline.close();
});

test("interim transcription publishes only the detected source lane", async () => {
  const harness = createHarness({ languages: ["ko", "en"] });
  await harness.pipeline.start();
  harness.pipeline.acceptPartialTranscript({ text: "We are reviewing leasing demand", sourceLanguage: "en-US" });
  await new Promise((resolve) => setImmediate(resolve));
  const partials = harness.captions().filter((caption) => !caption.isFinal);
  assert.deepEqual(partials.map((caption) => caption.language), ["en"]);
  assert.equal(partials[0]?.origin, "source");
  assert.equal(harness.translationCalls.length, 0, "partial STT must not multiply Gemini text calls");
  await harness.pipeline.close();
});

test("clear Hangul selects the Korean source lane when provider metadata is absent", async () => {
  const harness = createHarness({ languages: ["ko", "en"] });
  await harness.pipeline.start();
  harness.pipeline.acceptPartialTranscript({ text: "한국 임대시장 전망을 설명합니다" });
  await new Promise((resolve) => setImmediate(resolve));
  const [partial] = harness.captions().filter((caption) => !caption.isFinal);
  assert.equal(partial?.language, "ko");
  assert.equal(partial?.translationStatus, "verbatim");
  await harness.pipeline.close();
});

test("genuine Korean speech stays verbatim on the Korean final lane", async () => {
  const harness = createHarness({ languages: ["ko", "en"] });
  await harness.pipeline.start();
  await harness.pipeline.acceptFinalUtterance({
    speakerLabel: "1",
    text: "한국 임대시장 전망을 설명합니다",
    sourceLanguage: "ko-KR",
    sourceEndedAt: "2026-08-27T00:00:00.000Z",
  });
  const source = harness.captions().find((caption) => caption.language === "ko");
  assert.equal(source?.origin, "source");
  assert.equal(source?.translationStatus, "verbatim");
  assert.equal(source?.sourceText, null);
  await harness.pipeline.close();
});

test("authoritative persistence keeps provider raw text separate from NFC-normalized caption text", async () => {
  const harness = createHarness({ languages: ["ko"] });
  const decomposed = "  감정평가를 검토합니다  ";
  await harness.pipeline.start();
  await harness.pipeline.acceptFinalUtterance({
    speakerLabel: "1",
    text: decomposed,
    sourceLanguage: "ko-KR",
    sourceEndedAt: "2026-08-27T00:00:00.000Z",
  });
  assert.equal(harness.sources[0]?.rawText, decomposed);
  assert.equal(harness.sources[0]?.normalizedText, "감정평가를 검토합니다");
  assert.equal(harness.captions()[0]?.text, "감정평가를 검토합니다");
  await harness.pipeline.close();
});
