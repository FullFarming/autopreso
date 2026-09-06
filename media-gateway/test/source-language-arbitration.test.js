import assert from "node:assert/strict";
import test from "node:test";

import { LiveMediaPipeline } from "./helpers/gemini-pipeline.js";

function createHarness() {
  const events = [];
  const translationCalls = [];
  let sourceSeq = 0;
  const dependencies = {
    speechToText: {
      async open() {
        return { async sendAudio() {}, async close() {}, async getFinalWords() { return []; } };
      },
    },
    textTranslate: {
      async translate(input) {
        translationCalls.push(input);
        return input.language === "en"
          ? "I will explain the Korean commercial real estate market."
          : "이제 임대시장 전망을 이어서 설명하겠습니다.";
      },
    },
    publisher: {
      async persistAuthoritativeSource() {
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
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "direction-arbitration",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko", "en"],
    dependencies,
  });
  return { pipeline, events, translationCalls };
}

test("one committed STT result is authoritative for every caption lane", async () => {
  const harness = createHarness();
  await harness.pipeline.start();
  const sourceText = "한국 부동산 시장을 설명하겠습니다.";

  await harness.pipeline.acceptFinalUtterance({
    speakerLabel: "1",
    text: sourceText,
    sourceLanguage: "ko-KR",
    sourceEndedAt: "2026-08-27T00:00:00.000Z",
  });

  const source = harness.events.find((event) => event.language === "ko" && event.isFinal);
  const translated = harness.events.find((event) => event.language === "en" && event.isFinal);
  assert.equal(source?.origin, "source");
  assert.equal(source?.sourceLanguage, "ko");
  assert.equal(translated?.sourceLanguage, "ko");
  assert.equal(translated?.sourceText, sourceText);
  assert.deepEqual(harness.translationCalls.map((call) => call.language), ["en"]);
  await harness.pipeline.close();
});

test("a committed boundary permits the next source sentence to switch direction", async () => {
  const harness = createHarness();
  await harness.pipeline.start();
  const koreanSource = "한국 상업용 부동산 시장을 설명하겠습니다.";
  const englishSource = "Now I will continue with the leasing outlook.";

  await harness.pipeline.acceptFinalUtterance({
    speakerLabel: "1",
    text: koreanSource,
    sourceLanguage: "ko-KR",
    sourceEndedAt: "2026-08-27T00:00:00.000Z",
  });
  await harness.pipeline.acceptFinalUtterance({
    speakerLabel: "1",
    text: englishSource,
    sourceLanguage: "en-US",
    sourceEndedAt: "2026-08-27T00:00:01.000Z",
  });

  const englishTranslation = harness.events.find(
    (event) => event.language === "en" && event.sourceText === koreanSource,
  );
  const koreanTranslation = harness.events.find(
    (event) => event.language === "ko" && event.sourceText === englishSource,
  );
  assert.equal(englishTranslation?.sourceLanguage, "ko");
  assert.equal(koreanTranslation?.sourceLanguage, "en");
  assert.deepEqual(harness.translationCalls.map((call) => call.language), ["en", "ko"]);
  await harness.pipeline.close();
});
