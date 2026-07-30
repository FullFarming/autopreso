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

function makeManualClock(start = 0) {
  let now = start;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeoutFn(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, dueAt: now + delay });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.dueAt;
        timer.callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = target;
      await new Promise((resolve) => setImmediate(resolve));
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

function makeLivePipeline(state, languages = ["ko", "en"], clock = null, options = {}) {
  const sessions = new Map();
  const sourceSessions = new Map();
  state.dependencies.liveTranslate = {
    async open({ language, inputSource = "system", onCaption, onInputCaption, onInputObservation }) {
      const session = { onCaption, onInputCaption, onInputObservation };
      sourceSessions.set(`${inputSource}:${language}`, session);
      if (inputSource === "system") sessions.set(language, session);
      return { async sendAudio() {}, async audioStreamEnd() {}, async close() {} };
    },
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-live",
    sessionType: "meeting",
    outputMode: "captions",
    languages,
    dependencies: state.dependencies,
    now: clock?.now ?? (() => 0),
    ...(clock ? {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    } : {}),
    ...options,
  });
  return { pipeline, sessions, sourceSessions };
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

test("clear single-script evidence corrects an in-pair provider mislabel", async () => {
  const cases = [
    { text: "Clearly English only.", languageCode: "ko-KR", expectedLanguage: "en" },
    { text: "명백한 한국어 문장입니다.", languageCode: "en-US", expectedLanguage: "ko" },
  ];

  for (const scenario of cases) {
    const state = makeDependencies();
    const { pipeline, sessions } = makeLivePipeline(state);
    await pipeline.start();
    await sessions.get("ko").onInputCaption({ ...scenario, isFinal: true });
    assert.equal(state.captions()[0]?.language, scenario.expectedLanguage);
    await pipeline.close();
  }
});

test("a clear new KO turn overrides the previous EN consensus on its first caption", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();

  for (const language of ["ko", "en"]) {
    await sessions.get(language).onInputObservation?.({
      text: "We will review the Seoul office market today.",
      languageCode: "en-US",
    });
  }
  await sessions.get("ko").onInputCaption({
    text: "이제 한국어 문장입니다.",
    isFinal: true,
    languageCode: "ko-KR",
  });

  assert.equal(state.captions()[0]?.language, "ko");
});

test("a mixed Korean turn overrides stale EN consensus with either KO or und metadata", async () => {
  for (const languageCode of ["ko-KR", "und"]) {
    const state = makeDependencies();
    const { pipeline, sessions } = makeLivePipeline(state);
    await pipeline.start();
    for (const language of ["ko", "en"]) {
      await sessions.get(language).onInputObservation?.({
        text: "We will review the Seoul office market today.",
        languageCode: "en-US",
      });
    }
    await sessions.get("ko").onInputCaption({
      text: "오늘 office market을 검토합니다.",
      isFinal: true,
      languageCode,
    });
    await pipeline.close();
    assert.equal(state.captions()[0]?.language, "ko", `${languageCode} must begin a Korean turn`);
  }
});

test("ambiguous revisions keep the utterance's EN-KO language lock until final", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();

  await sessions.get("ko").onInputCaption({
    text: "오늘 office market을",
    isFinal: false,
    languageCode: "ko-KR",
  });
  await sessions.get("ko").onInputCaption({
    text: "temporarily looks English 하지만",
    isFinal: true,
    languageCode: "en-US",
  });

  await pipeline.close();
  assert.deepEqual(state.captions().map((caption) => caption.language), ["ko"]);
});

test("outside Latin-script provider metadata cannot enter EN-KO source or translated records", async () => {
  const cases = [
    {
      inputSource: "system",
      sourceText: "We will review the Seoul office market today.",
      providerLanguage: "ja-JP",
      targetLanguage: "ko",
      translatedText: "오늘 서울 오피스 시장을 검토하겠습니다.",
    },
    {
      inputSource: "participant",
      sourceText: "We will review the Seoul office market today.",
      providerLanguage: "vi-VN",
      targetLanguage: "ko",
      translatedText: "오늘 서울 오피스 시장을 검토하겠습니다.",
    },
  ];

  for (const scenario of cases) {
    const state = makeDependencies();
    const { pipeline, sourceSessions } = makeLivePipeline(state);
    await pipeline.start();
    if (scenario.inputSource === "participant") {
      pipeline.setFloorSpeaker({ participantId: "participant-1", displayName: "Participant" });
      await pipeline.acceptAudio(new Uint8Array(1_280), 0, {
        participantId: "participant-1",
        displayName: "Participant",
      }, "participant");
    }

    const inputLane = sourceSessions.get(`${scenario.inputSource}:ko`);
    const outputLane = sourceSessions.get(`${scenario.inputSource}:${scenario.targetLanguage}`);
    for (const language of ["ko", "en"]) {
      await sourceSessions.get(`${scenario.inputSource}:${language}`).onInputObservation?.({
        text: scenario.sourceText,
        languageCode: scenario.providerLanguage,
      });
    }
    await inputLane.onInputCaption({
      text: scenario.sourceText,
      isFinal: true,
      languageCode: scenario.providerLanguage,
    });
    await outputLane.onCaption({
      text: scenario.translatedText,
      isFinal: true,
      languageCode: scenario.targetLanguage,
    });

    const captions = state.captions();
    assert.deepEqual(captions, [], `${scenario.providerLanguage} must not create source or translated records`);
    await pipeline.close();
  }
});

test("Korean CRE grammar with Latin acronyms and proper nouns stays on the KO source lane", async () => {
  for (const languageCode of ["ko-KR", "und", undefined]) {
    const state = makeDependencies();
    const { pipeline, sessions } = makeLivePipeline(state);
    await pipeline.start();

    await sessions.get("ko").onInputCaption({
      text: "Cushman & Wakefield Korea의 ADR, RevPAR 지표입니다.",
      isFinal: true,
      ...(languageCode === undefined ? {} : { languageCode }),
    });

    assert.deepEqual(
      state.captions().map(({ language, origin }) => ({ language, origin })),
      [{ language: "ko", origin: "source" }],
    );
    await pipeline.close();
  }
});

test("strong Hangul replaces stale outside metadata without allowing that metadata into state", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();

  await sessions.get("ko").onInputCaption({
    text: "오늘 서울 오피스 시장을 검토하겠습니다.",
    isFinal: true,
    languageCode: "fr-FR",
  });

  assert.equal(state.captions().length, 1);
  assert.equal(state.captions()[0].language, "ko");
  assert.equal(state.captions()[0].sourceLanguage, "ko");
});

test("a weak Hangul fragment cannot override outside provider metadata", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();
  await sessions.get("ko").onInputCaption({ text: "네", isFinal: true, languageCode: "fr-FR" });
  assert.equal(state.captions().length, 0);
});

test("genuinely unsupported scripts and malformed provider hints still fail closed", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();
  const input = sessions.get("ko").onInputCaption;

  await input({ text: "日本市場の最新情報", isFinal: false, languageCode: "ja-JP" });
  await input({ text: "日本市場の最新情報です。", isFinal: true, languageCode: "ja" });
  await input({ text: "Прогноз рынка Москвы.", isFinal: true, languageCode: "ru" });
  await input({ text: "Looks English but the hint is malformed.", isFinal: true, languageCode: "not-a-language" });

  assert.equal(state.captions().length, 0, "unsupported or malformed explicit hints must not become source rows");
});

test("all outside EN-KO source metadata is rejected for both partial and final callbacks", async () => {
  for (const languageCode of ["vi-VN", "ja-JP", "zh-CN", "es-ES", "fr-FR"]) {
    const state = makeDependencies();
    const clock = makeManualClock(1_000);
    const { pipeline, sessions } = makeLivePipeline(state, ["ko", "en"], clock);
    await pipeline.start();
    await sessions.get("ko").onInputCaption({
      text: "We will review the Seoul office market.",
      isFinal: false,
      languageCode,
    });
    await clock.advance(500);
    await sessions.get("ko").onInputCaption({
      text: "We will review the Seoul office market today.",
      isFinal: true,
      languageCode,
    });
    assert.equal(state.captions().length, 0, `${languageCode} source callbacks must fail closed`);
    await pipeline.close();
  }
});

test("missing or und source metadata cannot bypass the EN-KO script firewall", async () => {
  const unsupported = [
    "Ở đây bạn có thể xem và chúng ta bắt đầu.",
    "日本市場の最新情報です。",
    "你好世界今天开会。",
    "Прогноз рынка Москвы.",
    "Aquí puede ver el informe y podemos comenzar.",
    "Vous pouvez consulter le rapport et commencer.",
    "Wir können heute den Markt prüfen und beginnen.",
    "Possiamo esaminare il mercato e iniziare oggi.",
    "Podemos rever o mercado e começar hoje.",
    "Kita dapat melihat laporan dan mulai hari ini.",
  ];
  for (const languageCode of [undefined, "und"]) {
    for (const text of unsupported) {
      const state = makeDependencies();
      const clock = makeManualClock(1_000);
      const { pipeline, sessions } = makeLivePipeline(state, ["ko", "en"], clock);
      await pipeline.start();
      await sessions.get("ko").onInputCaption({
        text,
        isFinal: false,
        ...(languageCode === undefined ? {} : { languageCode }),
      });
      await clock.advance(500);
      await sessions.get("ko").onInputCaption({
        text,
        isFinal: true,
        ...(languageCode === undefined ? {} : { languageCode }),
      });
      assert.equal(state.captions().length, 0, `${languageCode ?? "missing"}: ${text}`);
      await pipeline.close();
    }
  }
});

test("an earlier EN consensus cannot relabel a genuinely unsupported source script", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();

  for (const language of ["ko", "en"]) {
    await sessions.get(language).onInputObservation?.({
      text: "We will review the Seoul office market today.",
      languageCode: "en-US",
    });
  }
  await sessions.get("ko").onInputCaption({
    text: "日本市場の最新情報です。",
    isFinal: true,
    languageCode: "ja-JP",
  });

  assert.equal(state.captions().length, 0, "stale pair consensus must never override an unsupported provider language");
});

test("foreign scripts fail closed even when the provider mislabels them as EN or KO", async () => {
  const cases = [
    { text: "日本市場の最新情報です。", languageCode: "en-US" },
    { text: "Прогноз рынка Москвы.", languageCode: "ko-KR" },
    { text: "你好世界", languageCode: "en" },
  ];

  for (const scenario of cases) {
    const state = makeDependencies();
    const { pipeline, sessions } = makeLivePipeline(state);
    await pipeline.start();
    await sessions.get("ko").onInputCaption({ ...scenario, isFinal: true });
    assert.equal(state.captions().length, 0, `${scenario.text} must not become an EN/KO source row`);
    await pipeline.close();
  }
});

test("short output callbacks require the configured target script and reject third-language scripts", async () => {
  const invalidOutputs = [
    { text: "はい", languageCode: "ja-JP" },
    { text: "你好", languageCode: "zh-CN" },
    { text: "Да", languageCode: "ru-RU" },
  ];

  for (const output of invalidOutputs) {
    const state = makeDependencies();
    const { pipeline, sessions } = makeLivePipeline(state);
    await pipeline.start();
    await sessions.get("ko").onInputCaption({ text: "Yes", isFinal: true, languageCode: "en-US" });
    await sessions.get("ko").onCaption({
      ...output,
      isFinal: true,
      sourceText: "Yes",
      sourceLanguage: "en-US",
    });
    const outputCaptions = state.captions().filter((caption) => caption.origin !== "source");
    assert.ok(
      outputCaptions.every((caption) => caption.translationStatus !== "translated"),
      `${output.text} must not be accepted as a Korean translation`,
    );
    await pipeline.close();
  }

  const validCases = [
    { sourceText: "Yes", sourceLanguage: "en-US", targetLanguage: "ko", translatedText: "네" },
    { sourceText: "Yes", sourceLanguage: "en-US", targetLanguage: "ko", translatedText: "OK" },
    { sourceText: "네", sourceLanguage: "ko-KR", targetLanguage: "en", translatedText: "OK" },
  ];
  for (const scenario of validCases) {
    const state = makeDependencies();
    const { pipeline, sessions } = makeLivePipeline(state);
    await pipeline.start();
    await sessions.get("ko").onInputCaption({
      text: scenario.sourceText,
      isFinal: true,
      languageCode: scenario.sourceLanguage,
    });
    await sessions.get(scenario.targetLanguage).onCaption({
      text: scenario.translatedText,
      isFinal: true,
      languageCode: scenario.targetLanguage,
      sourceText: scenario.sourceText,
      sourceLanguage: scenario.sourceLanguage,
    });
    const translated = state.captions().filter((caption) => caption.origin !== "source");
    assert.equal(translated.length, 1, `${scenario.translatedText} must remain a valid short translation`);
    assert.equal(translated[0].translationStatus, "translated");
    await pipeline.close();
  }
});

test("malformed provider source metadata cannot create an uncorrelated translated output", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();

  await sessions.get("ko").onCaption({
    text: "서울 시장을 검토하겠습니다.",
    isFinal: true,
    languageCode: "ko-KR",
    sourceText: "We will review the Seoul market.",
    sourceLanguage: "not-a-language",
  });

  assert.equal(state.captions().length, 0, "malformed explicit source metadata must fail closed");
});

test("malformed observations cannot poison the next EN-KO source decision", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();

  for (const language of ["ko", "en"]) {
    await sessions.get(language).onInputObservation?.({
      text: "Clearly English only.",
      languageCode: "not-a-language",
    });
  }
  await sessions.get("ko").onInputCaption({
    text: "OK 네",
    isFinal: true,
    languageCode: "und",
  });
  await pipeline.close();

  assert.equal(state.captions()[0]?.language, "ko");
});

test("missing and und input hints retain script fallback while explicit KO and EN remain canonical", async () => {
  const state = makeDependencies();
  const clock = makeManualClock(1_000);
  const { pipeline, sessions } = makeLivePipeline(state, ["ko", "en"], clock);
  await pipeline.start();
  const input = sessions.get("ko").onInputCaption;

  await input({ text: "Fallback English partial", isFinal: false });
  await clock.advance(500);
  await input({ text: "한국어 미확정 코드입니다.", isFinal: true, languageCode: "und" });
  await input({ text: "명시적 한국어입니다.", isFinal: true, languageCode: "ko-KR" });
  await input({ text: "Explicit English.", isFinal: true, languageCode: "en-US" });

  assert.deepEqual(state.captions().map(({ language, isFinal, origin }) => ({ language, isFinal, origin })), [
    { language: "en", isFinal: false, origin: "source" },
    { language: "ko", isFinal: true, origin: "source" },
    { language: "ko", isFinal: true, origin: "source" },
    { language: "en", isFinal: true, origin: "source" },
  ]);
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
  const clock = makeManualClock(1_000);
  const { pipeline, sessions } = makeLivePipeline(state, ["ko", "en"], clock);
  await pipeline.start();

  await sessions.get("ko").onInputCaption({ text: "안녕하세요 오늘 회의를 시작합니다", isFinal: false, languageCode: "ko-KR" });
  await sessions.get("ko").onCaption({ text: "안녕하세요 오늘 회의를 시작합니다", isFinal: false, languageCode: "ko-KR" });
  await clock.advance(500);
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

test("target text beats contradictory output language metadata, but wrong-target text is dropped", async () => {
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

  assert.equal(state.captions().length, 1, "output languageCode may repeat the input language on a valid translation");
  await sessions.get("ko").onCaption({
    text: "This is still English source output.",
    isFinal: true,
    languageCode: "en-US",
    sourceText: "English source.",
    sourceLanguage: "en-US",
  });
  assert.equal(state.captions().length, 1, "metadata and target-script mismatch together must fail closed");
});

test("output callbacks drop unsupported explicit languages but allow und to use the target gate", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();
  const koreanOutput = sessions.get("ko").onCaption;

  await koreanOutput({
    text: "겉보기에는 한국어인 러시아어 콜백",
    isFinal: false,
    languageCode: "ko-KR",
    sourceText: "Прогноз рынка Москвы.",
    sourceLanguage: "ru",
  });
  await koreanOutput({
    text: "겉보기에는 한국어인 일본어 콜백입니다.",
    isFinal: true,
    languageCode: "ko-KR",
    sourceText: "日本市場の最新情報です。",
    sourceLanguage: "ja-JP",
  });
  await koreanOutput({
    text: "언어 미확정 상태의 정상 한국어 번역입니다.",
    isFinal: true,
    languageCode: "und",
    sourceText: "A valid English source.",
    sourceLanguage: "en-US",
  });

  const captions = state.captions();
  assert.equal(captions.length, 1);
  assert.equal(captions[0].language, "ko");
  assert.equal(captions[0].text, "언어 미확정 상태의 정상 한국어 번역입니다.");
});

test("outside output metadata is rejected for partials and finals even when text looks like the target", async () => {
  const unsupportedLanguages = ["vi-VN", "ja-JP", "zh-CN", "es-ES", "fr-FR", "not-a-language"];
  for (const languageCode of unsupportedLanguages) {
    const state = makeDependencies();
    const clock = makeManualClock(1_000);
    const { pipeline, sessions } = makeLivePipeline(state, ["ko", "en"], clock);
    await pipeline.start();
    await sessions.get("ko").onInputCaption({
      text: "We will review the Seoul office market.",
      isFinal: true,
      languageCode: "en-US",
    });
    await sessions.get("ko").onCaption({
      text: "서울 오피스 시장을 검토하겠습니다.",
      isFinal: false,
      languageCode,
      sourceText: "We will review the Seoul office market.",
      sourceLanguage: "en-US",
    });
    await clock.advance(500);
    await sessions.get("ko").onCaption({
      text: "서울 오피스 시장을 검토하겠습니다.",
      isFinal: true,
      languageCode,
      sourceText: "We will review the Seoul office market.",
      sourceLanguage: "en-US",
    });

    assert.deepEqual(
      state.captions().map(({ language, origin }) => ({ language, origin })),
      [{ language: "en", origin: "source" }],
      `${languageCode} output metadata must never create a caption or record`,
    );
    await pipeline.close();
  }
});

test("non-string output metadata also fails closed before persistence", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();
  await sessions.get("ko").onCaption({
    text: "서울 오피스 시장을 검토하겠습니다.",
    isFinal: true,
    languageCode: { language: "ko" },
    sourceText: "We will review the Seoul office market.",
    sourceLanguage: "en-US",
  });
  assert.equal(state.captions().length, 0);
});

test("missing or und output metadata still rejects short and long third-language text", async () => {
  const unsupported = [
    "はい",
    "你好",
    "Да",
    "Ở đây bạn có thể xem và chúng ta bắt đầu.",
    "Aquí puede ver el informe y podemos comenzar.",
    "Vous pouvez consulter le rapport et commencer.",
    "Wir können heute den Markt prüfen und beginnen.",
    "Possiamo esaminare il mercato e iniziare oggi.",
    "Podemos rever o mercado e começar hoje.",
    "Kita dapat melihat laporan dan mulai hari ini.",
  ];
  for (const languageCode of [undefined, "und"]) {
    for (const text of unsupported) {
      const state = makeDependencies();
      const { pipeline, sessions } = makeLivePipeline(state);
      await pipeline.start();
      await sessions.get("ko").onCaption({
        text,
        isFinal: true,
        ...(languageCode === undefined ? {} : { languageCode }),
        sourceText: "We will review the Seoul office market.",
        sourceLanguage: "en-US",
      });
      assert.equal(state.captions().length, 0, `${languageCode ?? "missing"}: ${text}`);
      await pipeline.close();
    }
  }
});

test("two consecutive EN-KO language drifts request one fresh pipeline recovery", async () => {
  const state = makeDependencies();
  const fatalErrors = [];
  const { pipeline, sessions } = makeLivePipeline(state, ["ko", "en"], null, {
    onFatalError: (error) => fatalErrors.push(error),
  });
  await pipeline.start();

  await sessions.get("ko").onCaption({
    text: "서울 오피스 시장을 검토하겠습니다.",
    isFinal: false,
    languageCode: "vi-VN",
    sourceText: "We will review the Seoul office market.",
    sourceLanguage: "en-US",
  });
  assert.equal(fatalErrors.length, 0, "one anomalous callback is dropped without reconnecting");
  await sessions.get("ko").onCaption({
    text: "서울 오피스 시장을 검토하겠습니다.",
    isFinal: true,
    languageCode: "ja-JP",
    sourceText: "We will review the Seoul office market.",
    sourceLanguage: "en-US",
  });
  await sessions.get("ko").onCaption({
    text: "서울 오피스 시장을 검토하겠습니다.",
    isFinal: true,
    languageCode: "fr-FR",
    sourceText: "We will review the Seoul office market.",
    sourceLanguage: "en-US",
  });

  assert.equal(fatalErrors.length, 1);
  assert.equal(fatalErrors[0].message, "TRANSLATION_LANGUAGE_DRIFT");
  assert.equal(state.captions().length, 0);
});

test("a post-polish third-language draft is blocked before seq and persistence", async () => {
  const state = makeDependencies();
  let polishCalls = 0;
  state.dependencies.captionPolish = {
    async polish() {
      polishCalls += 1;
      return "日本市場の最新情報です。";
    },
  };
  const { pipeline, sessions } = makeLivePipeline(state, ["ko", "en"], null, {
    captionPolishPolicy: "full",
  });
  await pipeline.start();

  await sessions.get("ko").onCaption({
    text: "서울 오피스 시장을 검토하겠습니다.",
    isFinal: true,
    languageCode: "ko-KR",
    sourceText: "We will review the Seoul office market.",
    sourceLanguage: "en-US",
  });

  assert.equal(polishCalls, 1, "full policy must exercise the post-polish language gate");
  assert.equal(state.captions().length, 0);
  assert.equal(pipeline.lastSequence, 0, "a rejected polish result must not consume durable seq");
});

test("committed CRE normalization never mutates the source-language record", async () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state);
  await pipeline.start();
  const sourceText = "The transaction value is KRW 300 billion.";

  await sessions.get("ko").onInputCaption({
    text: sourceText,
    isFinal: true,
    languageCode: "en-US",
  });

  assert.equal(state.captions().length, 1);
  assert.equal(state.captions()[0].origin, "source");
  assert.equal(state.captions()[0].text, sourceText);
});

// ─────────────────────────────────────────────────────────────────────────────
// The caption is the FINAL ARTIFACT: corrections happen inline during
// generation (glossary + number notation), so what is displayed is already the
// finished line and the record simply stores it. Two consequences:
//   - the correction pass must run on EVERY caption, not only glossed finals
//   - interims must get the same pass, or the screen shows an uncorrected line
//     that then visibly changes when the final lands
// ─────────────────────────────────────────────────────────────────────────────

test("committed CRE number notation applies with no glossary configured", () => {
  const state = makeDependencies();
  const { pipeline, sessions } = makeLivePipeline(state, ["en"]);
  return (async () => {
    await pipeline.start();
    await sessions.get("en").onCaption({ text: "We are targeting 3,000억 원 this year.", isFinal: true });
    const captions = state.captions();
    assert.equal(captions.length, 1);
    assert.equal(captions[0].text, "We are targeting KRW 300bn this year.");
  })();
});

test("an incomplete number stays raw in partials and normalizes only on commit", async () => {
  const state = makeDependencies();
  const clock = makeManualClock(1_000);
  const { pipeline, sessions } = makeLivePipeline(state, ["en"], clock);
  await pipeline.start();

  await sessions.get("en").onCaption({ text: "The fund raised 3천억 원", isFinal: false });
  await clock.advance(500);
  await sessions.get("en").onCaption({ text: "The fund raised 3천억 원.", isFinal: true });

  const captions = state.captions();
  assert.equal(captions.length, 2);
  assert.equal(captions[0].text, "The fund raised 3천억 원", "the interim must remain byte-stable");
  assert.match(captions[1].text, /KRW 300bn/u);
});
