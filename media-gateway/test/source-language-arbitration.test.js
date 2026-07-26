import assert from "node:assert/strict";
import test from "node:test";

import { LiveMediaPipeline } from "../src/live-media-pipeline.js";

function makeMeetingDependencies() {
  const events = [];
  const sessions = [];
  return {
    events,
    sessions,
    dependencies: {
      liveTranslate: {
        async open(options) {
          const session = {
            ...options,
            async sendAudio() {},
            async audioStreamEnd() {},
            async close() {},
          };
          sessions.push(session);
          return session;
        },
      },
      openaiLiveTranslate: { async open() { throw new Error("UNUSED_VOICE"); } },
      textTranslate: { async translate() { throw new Error("UNUSED_TEXT_TRANSLATE"); } },
      textToSpeech: { async *synthesizeStream() {} },
      publisher: {
        async publish(_sessionId, _language, event, { onLiveEvent } = {}) {
          await onLiveEvent?.(event);
          events.push(event);
        },
        async markLive() {},
      },
    },
  };
}

test("meeting target lanes cannot override the canonical input direction for one utterance", async () => {
  const state = makeMeetingDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "direction-arbitration",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko", "en"],
    dependencies: state.dependencies,
  });
  await pipeline.start();

  const sourceText = "한국 CRE 시장을 설명하겠습니다.";
  const koreanTarget = state.sessions.find((session) => session.language === "ko");
  const englishTarget = state.sessions.find((session) => session.language === "en");
  await koreanTarget.onInputCaption({
    text: sourceText,
    isFinal: true,
    languageCode: "ko-KR",
    utteranceKey: "gemini:ko:1:1",
  });

  // Independent target sessions hear the same audio but can disagree on the
  // input language. The canonical input transcript must win for both lanes;
  // otherwise the EN lane treats this translation as an EN source echo and
  // silently drops the sentence.
  await englishTarget.onCaption({
    text: "I will explain the Korean CRE market.",
    isFinal: true,
    sourceText,
    sourceLanguage: "en-US",
    utteranceKey: "gemini:en:1:1",
  });

  const translated = state.events.find((event) => event.language === "en" && event.isFinal);
  assert.ok(translated, "the translated lane must survive a sibling session's direction flip");
  assert.equal(translated.sourceLanguage, "ko");
  assert.equal(translated.sourceText, sourceText);
  await pipeline.close();
});

test("a committed boundary permits the next canonical sentence to switch direction", async () => {
  const state = makeMeetingDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "direction-boundary",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko", "en"],
    dependencies: state.dependencies,
  });
  await pipeline.start();

  const koreanTarget = state.sessions.find((session) => session.language === "ko");
  const englishTarget = state.sessions.find((session) => session.language === "en");
  const koreanSource = "Cushman & Wakefield의 한국 CRE 시장을 설명하겠습니다.";
  await koreanTarget.onInputCaption({
    text: koreanSource,
    isFinal: true,
    languageCode: "ko-KR",
    utteranceKey: "gemini:ko:1:1",
  });
  await englishTarget.onCaption({
    text: "I will explain Cushman & Wakefield's Korean CRE market.",
    isFinal: true,
    sourceText: koreanSource,
    sourceLanguage: "en-US",
    utteranceKey: "gemini:en:1:1",
  });

  const englishSource = "Now I will continue with the leasing outlook.";
  await koreanTarget.onInputCaption({
    text: englishSource,
    isFinal: true,
    languageCode: "en-US",
    utteranceKey: "gemini:ko:1:2",
  });
  await koreanTarget.onCaption({
    text: "이제 임대시장 전망을 이어서 설명하겠습니다.",
    isFinal: true,
    sourceText: englishSource,
    sourceLanguage: "ko-KR",
    utteranceKey: "gemini:ko:1:2",
  });

  const englishTranslation = state.events.find(
    (event) => event.language === "en" && event.sourceText === koreanSource,
  );
  const koreanTranslation = state.events.find(
    (event) => event.language === "ko" && event.sourceText === englishSource,
  );
  assert.equal(englishTranslation?.sourceLanguage, "ko");
  assert.equal(koreanTranslation?.sourceLanguage, "en");
  await pipeline.close();
});
