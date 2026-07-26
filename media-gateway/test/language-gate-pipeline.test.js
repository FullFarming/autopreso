import assert from "node:assert/strict";
import test from "node:test";

import { LiveMediaPipeline } from "../src/live-media-pipeline.js";

// The gateway used to FAIL OPEN: when a lane's translation threw, it published
// the untranslated source text on that lane ("a verbatim caption beats a dropped
// one"). With continuous English input the Korean lane therefore alternated real
// Korean translations and raw English — the 한글↔영어 반복 bug. The desktop engine,
// which is the reference, SUPPRESSES output that is not in the lane's language.

function makeDependencies({ translate } = {}) {
  const events = [];
  return {
    events,
    captions: () => events.filter((event) => event.type === "caption"),
    dependencies: {
      liveTranslate: { async open() { return { async sendAudio() {}, async audioStreamEnd() {}, async close() {} }; } },
      openaiLiveTranslate: { async open() { throw new Error("UNUSED"); } },
      speechToText: {
        async open() {
          return { async sendAudio() {}, async close() {}, async getFinalWords() { return []; } };
        },
      },
      textTranslate: {
        async translate(request) {
          if (translate) return translate(request);
          return `${request.language}:${request.text}`;
        },
      },
      textToSpeech: { async *synthesizeStream() { yield new Uint8Array(6_000); } },
      publisher: {
        async publish(_sessionId, _language, event) { events.push(event); },
        async publishAudio() {},
      },
    },
  };
}

function makePipeline(state, languages = ["ko"]) {
  return new LiveMediaPipeline({
    sessionId: "s1",
    sessionType: "meeting",
    outputMode: "captions",
    languages,
    dependencies: state.dependencies,
    now: () => 0,
  });
}

const ENGLISH_UTTERANCE = {
  speakerLabel: "1",
  text: "We will review the Seoul office market and the tenant representation mandate today",
  sourceLanguage: "en",
  sourceStartOffsetMs: 0,
  sourceEndOffsetMs: 4_000,
  sourceEndedAt: "2026-07-26T00:00:00Z",
};

test("a failed translation is recorded but marked failed so viewers never display it", async () => {
  // Two requirements meet here. The record must never have a hole — a viewer
  // browsing the KO transcript later has to see this utterance — but raw English
  // must never RENDER on the KO lane. So the caption is still published (which
  // is what persists it to live_utterances) and carries translationStatus
  // "failed"; the viewer renders only "translated" captions.
  const state = makeDependencies({
    translate() { throw new Error("PROVIDER_UNAVAILABLE"); },
  });
  const pipeline = makePipeline(state);
  await pipeline.start();

  await pipeline.acceptFinalUtterance(ENGLISH_UTTERANCE);

  const captions = state.captions();
  assert.equal(captions.length, 1, "the record must not lose the utterance");
  assert.equal(captions[0].translationStatus, "failed", "it must be labelled so the viewer hides it");
  assert.equal(captions[0].isFinal, true);
  // The original travels in both fields: `text` because live_utterances.text is
  // NOT NULL, and `sourceText` so the records view can label it as the 원문.
  assert.equal(captions[0].text, ENGLISH_UTTERANCE.text);
  assert.equal(captions[0].sourceText, ENGLISH_UTTERANCE.text);
});

test("a translation that comes back in the wrong language is downgraded to failed", async () => {
  // A provider that echoes the source instead of translating it must not be
  // presented to the viewer as a real translation.
  const state = makeDependencies({
    async translate({ text }) { return text; },
  });
  const pipeline = makePipeline(state);
  await pipeline.start();

  await pipeline.acceptFinalUtterance(ENGLISH_UTTERANCE);

  const captions = state.captions();
  assert.equal(captions.length, 1);
  assert.equal(captions[0].translationStatus, "failed");
});

test("a successful translation still publishes normally", async () => {
  const state = makeDependencies({
    async translate({ text }) { return `서울 오피스 시장을 살펴보겠습니다 (${text.length})`; },
  });
  const pipeline = makePipeline(state);
  await pipeline.start();

  await pipeline.acceptFinalUtterance(ENGLISH_UTTERANCE);

  const captions = state.captions();
  assert.equal(captions.length, 1);
  assert.equal(captions[0].isFinal, true);
  assert.equal(captions[0].translationStatus, "translated");
  assert.match(captions[0].text, /서울 오피스 시장/u);
});

test("a Korean translation carrying many English proper nouns is NOT suppressed", async () => {
  // The gate checks that the target language is PRESENT, not that it dominates:
  // Latin characters here outnumber the Hangul and this must still publish.
  const state = makeDependencies({
    async translate() { return "Cushman & Wakefield Korea의 ADR, RevPAR, GOP 지표입니다"; },
  });
  const pipeline = makePipeline(state);
  await pipeline.start();

  await pipeline.acceptFinalUtterance(ENGLISH_UTTERANCE);

  assert.equal(state.captions().length, 1);
});

test("a failed lane keeps caption seq contiguous for the record", async () => {
  // Failed captions ARE committed (they persist for the record), so they consume
  // a seq like any other final. Contiguity is what matters: a viewer replaying
  // live_utterances by seq must not encounter a gap.
  let shouldFail = true;
  const state = makeDependencies({
    async translate({ text }) {
      if (shouldFail) throw new Error("PROVIDER_UNAVAILABLE");
      return `서울 오피스 시장 이야기입니다 (${text.length})`;
    },
  });
  const pipeline = makePipeline(state);
  await pipeline.start();

  await pipeline.acceptFinalUtterance(ENGLISH_UTTERANCE);
  shouldFail = false;
  await pipeline.acceptFinalUtterance({ ...ENGLISH_UTTERANCE, sourceStartOffsetMs: 5_000, sourceEndOffsetMs: 9_000 });

  const captions = state.captions();
  assert.equal(captions.length, 2, "both utterances are recorded");
  assert.deepEqual(captions.map((caption) => caption.seq), [1, 2]);
  assert.deepEqual(captions.map((caption) => caption.translationStatus), ["failed", "translated"]);
});

test("English contaminated by one Korean word is translated, not passed through verbatim", async () => {
  // STT mislabels this as Korean. textPlausiblyInLanguage() said "Hangul is
  // present, so it is Korean" and published the English verbatim on the KO lane.
  let translateCalls = 0;
  const state = makeDependencies({
    async translate() {
      translateCalls += 1;
      return "명동 자산이 프리미엄에 거래되었습니다";
    },
  });
  const pipeline = makePipeline(state);
  await pipeline.start();

  await pipeline.acceptFinalUtterance({
    ...ENGLISH_UTTERANCE,
    text: "the 명동 asset traded at a premium last quarter",
    sourceLanguage: "ko",
  });

  assert.equal(translateCalls, 1, "the lane must translate rather than trust the STT label");
  const captions = state.captions();
  assert.equal(captions.length, 1);
  assert.equal(captions[0].translationStatus, "translated");
  assert.match(captions[0].text, /명동 자산/u);
});

test("interim captions apply the same source-lane detection as finals", async () => {
  // Without this, the interim flashes raw English on the KO lane and the final
  // is then suppressed — the viewer sees English appear and vanish, which is
  // worse than never showing it.
  let translateCalls = 0;
  const state = makeDependencies({
    async translate() {
      translateCalls += 1;
      return "명동 자산이 프리미엄에 거래되었습니다";
    },
  });
  const pipeline = makePipeline(state);
  await pipeline.start();

  pipeline.acceptPartialTranscript({
    text: "the 명동 asset traded at a premium last quarter",
    sourceLanguage: "ko",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(translateCalls, 1, "the interim must translate rather than trust the STT label");
  const captions = state.captions();
  assert.equal(captions.length, 1);
  assert.equal(captions[0].isFinal, false);
  assert.match(captions[0].text, /명동 자산/u);
});

test("interim captions are suppressed when they are not in the lane language", async () => {
  const state = makeDependencies({
    // A provider that echoes the source back untranslated.
    async translate({ text }) { return text; },
  });
  const pipeline = makePipeline(state);
  await pipeline.start();

  pipeline.acceptPartialTranscript({
    text: "We will review the Seoul office market and the mandate today",
    sourceLanguage: "en",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(
    state.captions().length,
    0,
    `an English interim must not reach the KO lane; published: ${JSON.stringify(state.captions().map((caption) => caption.text))}`,
  );
});

test("genuine Korean speech on the Korean lane still passes through verbatim", async () => {
  let translateCalls = 0;
  const state = makeDependencies({
    async translate() { translateCalls += 1; return "should not be used"; },
  });
  const pipeline = makePipeline(state);
  await pipeline.start();

  await pipeline.acceptFinalUtterance({
    ...ENGLISH_UTTERANCE,
    text: "강남 오피스 공실률은 안정적으로 유지되고 있습니다",
    sourceLanguage: "ko",
  });

  assert.equal(translateCalls, 0, "the source lane must not re-translate its own language");
  const captions = state.captions();
  assert.equal(captions.length, 1);
  assert.equal(captions[0].translationStatus, "verbatim");
  assert.equal(captions[0].sourceText, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// The PRODUCTION caption path. `acceptFinalUtterance` above is the
// direct-injection entry point used by tests; live sessions instead open one
// Gemini Live Translate session per language and every caption arrives through
// `onCaption` -> #publishPresentationCaption. The language gate has to live
// there too, or none of it applies to a real Live Call.
// ─────────────────────────────────────────────────────────────────────────────

function makeLivePipeline(state, languages = ["ko", "en"]) {
  const sessions = new Map();
  state.dependencies.liveTranslate = {
    async open({ language, onCaption, onInputCaption }) {
      sessions.set(language, { onCaption, onInputCaption });
      return { async sendAudio() {}, async audioStreamEnd() {}, async close() {} };
    },
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-live",
    sessionType: "meeting",
    outputMode: "captions",
    languages,
    dependencies: state.dependencies,
    now: () => 0,
  });
  return { pipeline, sessions };
}

test("the live path hides a translation that came back in the wrong language", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();

  // The ko session emitting English is a broken translation. It must still be
  // RECORDED (the transcript cannot have a hole) but the viewer must not show
  // it, so it is labelled rather than presented as a real translation.
  await sessions.get("ko").onCaption({
    text: "We will review the Seoul office market and the mandate today",
    isFinal: true,
  });

  const captions = state.captions();
  assert.equal(captions.length, 1, "the record must keep the utterance");
  assert.equal(captions[0].translationStatus, "failed");
});

test("the live path leaves a genuine translation untouched", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();

  await sessions.get("ko").onCaption({ text: "서울 오피스 시장을 살펴보겠습니다", isFinal: true });

  const captions = state.captions();
  assert.equal(captions.length, 1);
  assert.notEqual(captions[0].translationStatus, "failed");
});

test("the source-language input transcript stays marked origin:source", async () => {
  // This is the record-only lane. The desktop overlay drops it; the webapp must
  // record it and keep it out of the live display.
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();

  await sessions.get("ko").onInputCaption({ text: "안녕하세요 여러분 오늘 발표를 시작하겠습니다", isFinal: true, languageCode: "ko" });

  const captions = state.captions();
  assert.equal(captions.length, 1);
  assert.equal(captions[0].origin, "source");
  assert.notEqual(captions[0].translationStatus, "failed", "the source lane is not a failed translation");
});

test("provider input language wins over script heuristics for code-switched source captions", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();

  await sessions.get("ko").onInputCaption({
    text: "서울 office market 3천억 원",
    isFinal: true,
    languageCode: "en-US",
  });

  const captions = state.captions();
  assert.equal(captions.length, 1);
  assert.equal(captions[0].language, "en");
  assert.equal(captions[0].sourceLanguage, "en");
  assert.equal(captions[0].origin, "source");
});

test("KO and EN same-language output echoes are dropped before durable publish", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();

  await sessions.get("ko").onInputCaption({ text: "한국어 원문입니다.", isFinal: true, languageCode: "ko-KR" });
  await sessions.get("ko").onCaption({
    text: "한국어 원문입니다.",
    isFinal: true,
    sourceText: "한국어 원문입니다.",
    sourceLanguage: "ko-KR",
  });
  await sessions.get("ko").onInputCaption({ text: "English source.", isFinal: true, languageCode: "en-US" });
  await sessions.get("en").onCaption({
    text: "English source.",
    isFinal: true,
    sourceText: "English source.",
    sourceLanguage: "en-US",
  });

  const captions = state.captions();
  assert.deepEqual(captions.map(({ language, origin }) => ({ language, origin })), [
    { language: "ko", origin: "source" },
    { language: "en", origin: "source" },
  ]);
});

test("partial and final echoes stay suppressed while the opposite translation survives", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();

  await sessions.get("ko").onInputCaption({ text: "안녕하세요", isFinal: false, languageCode: "ko-KR" });
  await sessions.get("ko").onCaption({ text: "안녕하세요", isFinal: false, languageCode: "ko-KR" });
  await sessions.get("ko").onInputCaption({ text: "안녕하세요.", isFinal: true, languageCode: "ko-KR" });
  await sessions.get("ko").onCaption({ text: "안녕하세요.", isFinal: true, languageCode: "ko-KR" });
  await sessions.get("en").onCaption({
    text: "Hello.",
    isFinal: true,
    languageCode: "en-US",
    sourceText: "안녕하세요.",
    sourceLanguage: "ko-KR",
  });

  const captions = state.captions();
  assert.equal(captions.filter((caption) => caption.origin === "source").length, 2);
  assert.equal(captions.some((caption) => caption.language === "ko" && caption.origin !== "source"), false);
  assert.equal(captions.some((caption) => caption.language === "en" && caption.text === "Hello."), true);
});

test("provider output language metadata rejects a target mismatch before publish", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();

  await sessions.get("ko").onCaption({
    text: "겉보기에는 한국어지만 provider는 영어로 판정했습니다.",
    isFinal: true,
    languageCode: "en-US",
    sourceText: "English source.",
    sourceLanguage: "en-US",
  });

  assert.equal(state.captions().length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// The caption is the FINAL ARTIFACT: corrections happen inline during
// generation (glossary + number notation), so what is displayed is already the
// finished line and the record simply stores it. Two consequences:
//   - the correction pass must run on EVERY caption, not only glossed finals
//   - interims must get the same pass, or the screen shows an uncorrected line
//     that then visibly changes when the final lands
// ─────────────────────────────────────────────────────────────────────────────

test("number notation applies on the live path even with no glossary configured", () => {
  // normalizeBusinessNumberNotation lives inside applyGlossaryCorrections, so a
  // guard of `if (glossaryText)` silently skipped it for every session that had
  // not picked a glossary preset.
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state, ["en"]);
  return (async () => {
    await pipeline.start();
    await sessions.get("en").onCaption({ text: "We are targeting 3,000억 원 this year.", isFinal: true });
    const captions = state.captions();
    assert.equal(captions.length, 1);
    assert.equal(captions[0].text, "We are targeting KRW 300 billion this year.");
  })();
});

test("an interim carries the same corrections as the final, so nothing changes under the reader", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state, ["en"]);
  await pipeline.start();

  await sessions.get("en").onCaption({ text: "The fund raised 3천억 원", isFinal: false });
  await sessions.get("en").onCaption({ text: "The fund raised 3천억 원.", isFinal: true });

  const captions = state.captions();
  assert.equal(captions.length, 2);
  assert.match(captions[0].text, /KRW 300 billion/u, "the interim must already be corrected");
  assert.match(captions[1].text, /KRW 300 billion/u);
});
