import assert from "node:assert/strict";
import test from "node:test";

import { LiveMediaPipeline } from "../src/live-media-pipeline.js";
import { SupabaseLivePublisher } from "../src/supabase-adapters.js";

// Target-only fixtures avoid hiding accidental source echoes behind a prefix.
const TRANSLATION_TEXT = { en: "This is the translated sentence.", ko: "번역된 문장입니다.", ja: "翻訳された文章です。", "zh-Hans": "这是翻译后的句子。", "zh-Hant": "這是翻譯後的句子。" };

function makeDependencies() {
  const events = [];
  const speechSessions = [];
  const translated = [];
  const synthesized = [];
  const sources = [];
  return {
    events,
    speechSessions,
    translated,
    synthesized,
    sources,
    dependencies: {
      speechToText: { async open(options) {
        const session = { ...options, async sendAudio() {}, async close() {}, async getFinalWords() { return []; } };
        speechSessions.push(session);
        return session;
      } },
      // The output-language gate (src/language-gate.js) suppresses any caption
      // that is not in its lane's language, so a stub translation has to look
      // like the target language: a bare `${language}:${text}` echo is now
      // correctly dropped on ko/ja lanes. Latin-script lanes need no marker.
      textTranslate: {
        async translate({ text, language, glossaryPack }) {
          translated.push([text, language, glossaryPack]);
          return TRANSLATION_TEXT[language];
        },
      },
      publisher: {
        async publish(_sessionId, _language, event, { onLiveEvent } = {}) {
          await onLiveEvent?.(event);
          events.push(event);
        },
        async persistAuthoritativeSource(value) {
          sources.push(value);
          return { sourceUtteranceId: value.utteranceKey, sourceSeq: 1, idempotent: false };
        },
      },
    },
  };
}

test("idle drain accepts the provider's final tail before stopping the pipeline", async () => {
  const state = makeDependencies();
  state.dependencies.speechToText.open = async (options) => ({
    async sendAudio() {},
    async close() {
      await options.onFinalUtterance({ speakerLabel: "A", text: "the final complete sentence", sourceLanguage: "en",
        sourceEndedAt: "2026-08-31T00:00:00.000Z" });
    },
  });
  const pipeline = new LiveMediaPipeline({ sessionId: "drain", mode: "meeting", languages: ["en"], dependencies: state.dependencies });
  await pipeline.start();
  await pipeline.gracefulDrain();
  assert.ok(state.events.some((event) => event.type === "caption" && event.isFinal && event.text === "the final complete sentence"));
  assert.equal(await pipeline.acceptAudio(new Uint8Array(1280)), false);
  await pipeline.close();
});

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
      let callbackCount = 0;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.dueAt;
        timer.callback();
        callbackCount += 1;
        if (callbackCount > 100) throw new Error("TIMER_LOOP");
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = target;
      await new Promise((resolve) => setImmediate(resolve));
      return callbackCount;
    },
    get pendingCount() {
      return timers.size;
    },
  };
}

test("meeting keeps the finalized speaker attached to each ordered translation", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s2", mode: "meeting", languages: ["en", "ja"], dependencies: state.dependencies });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "hello", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const captions = state.events.filter((event) => event.type === "caption");
  assert.equal(captions.length, 2);
  assert.equal(state.events.filter((event) => event.type === "speaker-legend").length, 2);
  assert.deepEqual(captions.map((event) => [event.language, event.speaker.speakerId, event.text]), [
    ["en", "speaker-1", TRANSLATION_TEXT.en],
    ["ja", "speaker-1", TRANSLATION_TEXT.ja],
  ]);
});

test("one failed Meeting language prepares a restart without stopping the others", async () => {
  const state = makeDependencies();
  state.dependencies.textTranslate.translate = async ({ text, language }) => {
    if (language === "ja") throw new Error("provider unavailable");
    return `${language}:${text}`;
  };
  const pipeline = new LiveMediaPipeline({ sessionId: "s-partial", mode: "meeting", languages: ["en", "ja"], dependencies: state.dependencies });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "hello", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  assert.equal(state.events.filter((event) => event.type === "caption" && event.language === "en").length, 1);
  assert.equal(state.events.some((event) => event.type === "language-status" && event.language === "ja" && event.status === "preparing"), true);
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "again", sourceEndedAt: "2026-07-19T00:00:01.000Z" });
  assert.equal(state.events.filter((event) => event.type === "caption" && event.language === "en").length, 2);
});

test("a slow language does not block the next utterance in another language", async () => {
  const state = makeDependencies();
  let releaseJapanese;
  state.dependencies.textTranslate.translate = async ({ text, language }) => {
    if (language === "ja" && text === "one") await new Promise((resolve) => { releaseJapanese = resolve; });
    return TRANSLATION_TEXT[language];
  };
  const pipeline = new LiveMediaPipeline({ sessionId: "s-language-isolation", mode: "meeting", languages: ["en", "ja"], dependencies: state.dependencies });
  await pipeline.start();
  const first = pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "one", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const second = pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "two", sourceEndedAt: "2026-07-19T00:00:01.000Z" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    state.events.filter((event) => event.type === "caption" && event.language === "en").map((event) => event.text),
    [TRANSLATION_TEXT.en, TRANSLATION_TEXT.en],
  );
  releaseJapanese();
  await Promise.all([first, second]);
});

test("Meeting captions mode publishes speaker captions without opening TTS", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-meeting-captions",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "caption only", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const caption = state.events.find((event) => event.type === "caption");
  assert.equal(caption.text, TRANSLATION_TEXT.ko);
  assert.equal(caption.speaker.voiceStatus, "disabled");
  assert.equal(state.synthesized.length, 0);
});

test("per-language initial sequences seed caption counters independently", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-seeded",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko", "en"],
    dependencies: state.dependencies,
    initialSequences: { ko: 41, en: 7 },
  });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "resume", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const captions = state.events.filter((event) => event.type === "caption");
  assert.equal(captions.find((event) => event.language === "ko").seq, 42);
  assert.equal(captions.find((event) => event.language === "en").seq, 8);
});

test("pause discards new audio, preserves source finals, and resume keeps target sequence", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-pause",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko"],
    dependencies: state.dependencies,
    now: () => 1_000,
  });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "before", sourceEndedAt: "2026-07-19T00:00:00.000Z" });

  await pipeline.pause();
  assert.equal(pipeline.isPaused, true);
  assert.equal(await pipeline.acceptAudio(new Uint8Array(1_280), 1_000), false);
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "while paused", sourceEndedAt: "2026-07-19T00:00:01.000Z" });
  assert.equal(state.events.filter((event) => event.type === "caption").length, 1);
  assert.equal(state.sources.at(-1).rawText, "while paused");

  await pipeline.resume();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "after", sourceEndedAt: "2026-07-19T00:00:02.000Z" });
  const captions = state.events.filter((event) => event.type === "caption");
  assert.deepEqual(captions.map((event) => [event.seq, event.text]), [[1, TRANSLATION_TEXT.ko], [2, TRANSLATION_TEXT.ko]]);
});

// Contract C6: the source-language lane is decided by the STT provider's
// detected `sourceLanguage` on the finalized utterance — the most reliable
// signal the pipeline already has (it reflects what was actually recognized,
// not what the host configured).
test("dual-language lanes emit the source language verbatim and translate only the others", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-dual",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko", "en"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({
    speakerLabel: "A",
    text: "안녕하세요",
    sourceLanguage: "ko-KR",
    sourceEndedAt: "2026-07-23T00:00:00.000Z",
  });
  await pipeline.acceptFinalUtterance({
    speakerLabel: "A",
    text: "good morning",
    sourceLanguage: "en-US",
    sourceEndedAt: "2026-07-23T00:00:02.000Z",
  });

  const captions = state.events.filter((event) => event.type === "caption");
  assert.deepEqual(
    captions.map((event) => [event.language, event.text]).sort(),
    [
      ["en", TRANSLATION_TEXT.en],
      ["en", "good morning"],
      ["ko", TRANSLATION_TEXT.ko],
      ["ko", "안녕하세요"],
    ].sort(),
  );
  // The verbatim lanes never called the translator mock.
  assert.deepEqual(state.translated.map(([text, language]) => [text, language]).sort(), [
    ["good morning", "ko"],
    ["안녕하세요", "en"],
  ].sort());
});

// A viewer reads every speaker in one chosen language, so it must still be
// able to reveal what was actually said. The published caption therefore
// carries the source text and an explicit translationStatus; the viewer must
// never have to guess whether `text` is really in the lane language.
test("finalized captions carry the source text, source language, and translation status", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-source-text",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko", "en"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({
    speakerLabel: "A",
    text: "안녕하세요",
    sourceLanguage: "ko-KR",
    sourceEndedAt: "2026-07-23T00:00:00.000Z",
  });

  const captions = state.events.filter((event) => event.type === "caption");
  const byLanguage = new Map(captions.map((event) => [event.language, event]));

  // The ko lane is the source lane: the text IS the original, so there is no
  // separate original to disclose.
  assert.equal(byLanguage.get("ko").text, "안녕하세요");
  assert.equal(byLanguage.get("ko").sourceText, null);
  assert.equal(byLanguage.get("ko").sourceLanguage, "ko");
  assert.equal(byLanguage.get("ko").translationStatus, "verbatim");

  // The en lane is translated, so it must carry the Korean original.
  assert.equal(byLanguage.get("en").text, TRANSLATION_TEXT.en);
  assert.equal(byLanguage.get("en").sourceText, "안녕하세요");
  assert.equal(byLanguage.get("en").sourceLanguage, "ko");
  assert.equal(byLanguage.get("en").translationStatus, "translated");
});

test("a failed target is absent while the native source lane stays intact", async () => {
  const state = makeDependencies();
  state.dependencies.textTranslate.translate = async () => { throw new Error("LANGUAGE_UNAVAILABLE"); };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-translate-fail",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko", "en"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({
    speakerLabel: "A",
    text: "안녕하세요",
    sourceLanguage: "ko-KR",
    sourceEndedAt: "2026-07-23T00:00:00.000Z",
  });

  // Raw source is available independently; never publish it as failed target text.
  const englishLane = state.events.find((event) => event.type === "caption" && event.language === "en");
  assert.equal(englishLane, undefined);
  // A broken translator must NOT silence the source lane, which needs no
  // translation at all.
  const koreanLane = state.events.find((event) => event.type === "caption" && event.language === "ko");
  assert.equal(koreanLane.text, "안녕하세요");
  assert.equal(koreanLane.translationStatus, "verbatim");
  assert.equal(koreanLane.sourceText, null);
  assert.equal(koreanLane.sourceLanguage, "ko");
});

test("interim captions stay on the authoritative source-language lane", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-partial-source",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko", "en"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  pipeline.acceptPartialTranscript({ text: "안녕하세요 여러분", sourceLanguage: "ko-KR" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const partials = state.events.filter((event) => event.type === "caption" && event.isFinal === false);
  const koreanPartial = partials.find((event) => event.language === "ko");
  assert.equal(partials.some((event) => event.language === "en"), false);
  assert.equal(koreanPartial.sourceText, null);
  assert.equal(koreanPartial.translationStatus, "verbatim");
});

// A polite hand-off is the most common floor transition: A presses Stop, then
// B presses Speak. It arrives as setFloorSpeaker(null) followed by
// setFloorSpeaker(B), and the grace record for A must survive it — A's
// committed caption can land seconds later and must not be credited to B.
test("a polite floor hand-off keeps the previous holder attributable", async () => {
  const state = makeDependencies();
  let clock = 0;
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-polite-handoff",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko"],
    dependencies: state.dependencies,
    now: () => clock,
  });
  await pipeline.start();

  pipeline.setFloorSpeaker({ participantId: "A", displayName: "발표자A" });
  clock = 10_000;
  pipeline.setFloorSpeaker(null);                                        // A stops
  pipeline.setFloorSpeaker({ participantId: "B", displayName: "발표자B" }); // B starts

  // A's audio began before the release, so the fence must return A.
  const forA = pipeline.resolveFloorForCapture(5_000);
  assert.equal(forA?.participantId, "A", "A's pre-release speech must stay with A");
  // B's own speech began after the release and must stay with B.
  const forB = pipeline.resolveFloorForCapture(10_500);
  assert.equal(forB?.participantId, "B");
});

test("SESSION_STOPPED from the publisher stops emission without counting toward the language cooldown", async () => {
  const state = makeDependencies();
  state.dependencies.publisher.publish = async (_sessionId, _language, event) => {
    if (event.type === "caption") throw new Error("SESSION_STOPPED");
    state.events.push(event);
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-stopped",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  for (let index = 0; index < 3; index += 1) {
    await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: `stopped-${index}`, sourceEndedAt: `2026-07-19T00:00:0${index}.000Z` });
  }
  assert.equal(state.events.some((event) => event.type === "language-status" && event.code === "LANGUAGE_COOLDOWN"), false);
  assert.equal(state.events.some((event) => event.type === "language-status" && event.status === "preparing"), false);
});

test("caption finalize-to-publish latency is observed per published caption", async () => {
  const state = makeDependencies();
  const observed = [];
  let now = 10_000;
  state.dependencies.publisher.publish = async (_sessionId, _language, event) => {
    if (event.type === "caption") now += 120;
    state.events.push(event);
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-latency",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko"],
    dependencies: state.dependencies,
    now: () => now,
    observeLatency: (name, value) => observed.push([name, value]),
  });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "measured", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  assert.deepEqual(observed, [["caption_publish_latency_ms", 120]]);
});

test("a seventh named floor participant beyond the six diarization slots keeps correct attribution and joins the legend", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-seventh",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  for (const label of ["A", "B", "C", "D", "E", "F"]) {
    await pipeline.acceptFinalUtterance({ speakerLabel: label, text: `from ${label}`, sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  }
  assert.equal(pipeline.speakers.list().length, 6);

  pipeline.setFloorSpeaker({ participantId: "participant-7", displayName: "일곱번째 참가자" });
  await pipeline.acceptFinalUtterance({ speakerLabel: "G", text: "일곱번째 발언", sourceEndedAt: "2026-07-19T00:00:07.000Z" });

  const caption = state.events.filter((event) => event.type === "caption").at(-1);
  assert.equal(caption.speaker.label, "일곱번째 참가자");
  const legend = pipeline.speakers.list();
  assert.equal(legend.length, 7, "named floor participants may exceed the six-slot diarization cap");
  assert.equal(legend.some((speaker) => speaker.label === "일곱번째 참가자"), true);
});

function tonePcm(frequency, milliseconds) {
  const sampleCount = Math.round(16_000 * milliseconds / 1_000);
  const bytes = new Uint8Array(sampleCount * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < sampleCount; index += 1) {
    view.setInt16(index * 2, Math.round(Math.sin(2 * Math.PI * frequency * index / 16_000) * 14_000), true);
  }
  return bytes;
}

test("a misdetected source language cannot leak untranslated text into another lane", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-script-gate", mode: "meeting", languages: ["en", "ko"], dependencies: state.dependencies });
  await pipeline.start();
  // STT wrongly tags Korean speech as en-US: the en lane must still translate.
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "안녕하세요 여러분", sourceLanguage: "en-US", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const en = state.events.find((event) => event.type === "caption" && event.language === "en");
  assert.equal(en.text, TRANSLATION_TEXT.en);
});

test("matching source language and script keeps verbatim passthrough on the source lane", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-script-ok", mode: "meeting", languages: ["en", "ko"], dependencies: state.dependencies });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "안녕하세요 여러분", sourceLanguage: "ko-KR", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const ko = state.events.find((event) => event.type === "caption" && event.language === "ko");
  const en = state.events.find((event) => event.type === "caption" && event.language === "en");
  assert.equal(ko.text, "안녕하세요 여러분");
  assert.equal(en.text, TRANSLATION_TEXT.en);
});

test("a translate failure leaves its target lane empty and reports degraded health", async () => {
  const state = makeDependencies();
  state.dependencies.textTranslate.translate = async ({ text, language }) => {
    if (language === "ja") throw new Error("provider unavailable");
    return `${language}:${text}`;
  };
  const pipeline = new LiveMediaPipeline({ sessionId: "s-translate-fallback", mode: "meeting", languages: ["en", "ja"], dependencies: state.dependencies });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "hello everyone", sourceLanguage: "en-US", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const ja = state.events.find((event) => event.type === "caption" && event.language === "ja");
  assert.equal(ja, undefined);
  assert.equal(state.events.some((event) => event.type === "language-status" && event.language === "ja" && event.status === "preparing"), true);
});

test("meeting interim transcripts stream only on the source lane", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-partials", mode: "meeting", languages: ["en", "ko"], dependencies: state.dependencies });
  await pipeline.start();
  pipeline.acceptPartialTranscript({ text: "안녕하", sourceLanguage: "ko-KR" });
  await new Promise((resolve) => setImmediate(resolve));
  pipeline.acceptPartialTranscript({ text: "안녕하세요 여러분", sourceLanguage: "ko-KR" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const partials = state.events.filter((event) => event.type === "caption" && !event.isFinal);
  const ko = partials.filter((event) => event.language === "ko").map((event) => event.text);
  const en = partials.filter((event) => event.language === "en").map((event) => event.text);
  assert.deepEqual(ko.at(-1), "안녕하세요 여러분");
  assert.equal(en.length, 0);
  assert.equal(partials.every((event) => event.speaker?.speakerId === "live"), true);
});

test("meeting partial captions dedupe repeats and skip empty text", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-partials-dedupe", mode: "meeting", languages: ["ko"], dependencies: state.dependencies });
  await pipeline.start();
  pipeline.acceptPartialTranscript({ text: "같은 내용", sourceLanguage: "ko-KR" });
  await new Promise((resolve) => setImmediate(resolve));
  pipeline.acceptPartialTranscript({ text: "같은 내용", sourceLanguage: "ko-KR" });
  pipeline.acceptPartialTranscript({ text: "  ", sourceLanguage: "ko-KR" });
  await new Promise((resolve) => setImmediate(resolve));
  const partials = state.events.filter((event) => event.type === "caption" && !event.isFinal);
  assert.equal(partials.length, 1);
});

test("a finalized utterance invalidates in-flight partial work for its lanes", async () => {
  const state = makeDependencies();
  let releaseTranslate = null;
  const baseTranslate = state.dependencies.textTranslate.translate;
  state.dependencies.textTranslate.translate = async (input) => {
    if (!input.text.startsWith("stale")) return baseTranslate(input);
    await new Promise((resolve) => { releaseTranslate = resolve; });
    return baseTranslate(input);
  };
  const pipeline = new LiveMediaPipeline({ sessionId: "s-partials-fence", mode: "meeting", languages: ["en"], dependencies: state.dependencies });
  await pipeline.start();
  pipeline.acceptPartialTranscript({ text: "stale partial", sourceLanguage: "ko-KR" });
  await new Promise((resolve) => setImmediate(resolve));
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "final words", sourceLanguage: "ko-KR", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  releaseTranslate?.();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const captions = state.events.filter((event) => event.type === "caption" && event.language === "en");
  assert.equal(captions.at(-1)?.isFinal, true);
  assert.equal(captions.some((event) => !event.isFinal && event.text.includes("stale")), false);
});

test("translated captions are mirrored to the host socket for bidirectional desktop display", async () => {
  const state = makeDependencies();
  const hostEvents = [];
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-host-mirror",
    mode: "meeting",
    languages: ["en"],
    dependencies: state.dependencies,
    onHostEvent: (event) => hostEvents.push(event),
  });
  await pipeline.start();
  pipeline.setFloorSpeaker({
    participantId: "p1",
    displayName: "김참가",
    department: "호텔팀",
    jobTitle: "Director",
  });
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "참가자 발언입니다", sourceLanguage: "ko-KR", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const captions = hostEvents.filter((event) => event.type === "caption");
  assert.equal(captions.length, 1);
  assert.equal(captions[0].text, TRANSLATION_TEXT.en);
  assert.equal(captions[0].speaker.isParticipant, true);
  assert.equal(captions[0].speaker.name, "김참가");
  assert.equal(captions[0].speakerRole, "participant");
  assert.equal(captions[0].speakerDepartment, "호텔팀");
  assert.equal(captions[0].speakerJobTitle, "Director");
});

test("partial captions carry a full speaker assignment shape the viewer contract accepts", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-partial-shape", mode: "meeting", languages: ["ko"], dependencies: state.dependencies, now: () => 1_753_350_000_000 });
  await pipeline.start();
  pipeline.acceptPartialTranscript({ text: "실시간 확인", sourceLanguage: "ko-KR" });
  await new Promise((resolve) => setImmediate(resolve));
  const partial = state.events.find((event) => event.type === "caption" && !event.isFinal);
  // Mirrors webapp isSpeaker(): every field must be present or the viewer
  // silently drops the caption.
  assert.equal(partial.speaker.speakerId, "live");
  assert.equal(typeof partial.speaker.label, "string");
  assert.equal(typeof partial.speaker.colorToken, "string");
  assert.equal(partial.speaker.voiceName, null);
  assert.equal(partial.speaker.voiceStatus, "disabled");
  assert.equal(typeof partial.speaker.lastSeenAt, "string");
});

// ── Continuity contract: captions must keep reaching viewers ──────────────

/** Mirror of webapp LiveViewer isCaptionEvent/isSpeaker validators: any
 *  caption the gateway publishes MUST pass this or the viewer silently drops
 *  it (the exact bug that hid all partials on 2026-07-24). */
/** Mirrors LiveViewer's resume guard: committed captions run the per-language
 *  strict-greater check and advance lastSeq; interim captions bypass both.
 *  Kept beside viewerAcceptsCaption so a gateway seq change that would blank a
 *  real viewer's feed fails here first. */
function viewerAcceptsSeq(state, event, { committedOnly = true } = {}) {
  const last = state[event.language] ?? 0;
  if (committedOnly && !event.isFinal) return true;
  if (event.seq <= last) return false;
  state[event.language] = event.seq;
  return true;
}

function viewerAcceptsCaption(value) {
  const isSpeakerShape = (speaker) => speaker !== null && typeof speaker === "object"
    && typeof speaker.speakerId === "string"
    && typeof speaker.label === "string"
    && typeof speaker.colorToken === "string"
    && (typeof speaker.voiceName === "string" || speaker.voiceName === null)
    && typeof speaker.lastSeenAt === "string"
    && (speaker.voiceStatus === undefined || ["disabled", "analyzing", "ready", "unavailable"].includes(speaker.voiceStatus));
  return value.type === "caption"
    && Number.isSafeInteger(value.seq) && value.seq >= 0
    && typeof value.sessionId === "string"
    && typeof value.language === "string"
    && (value.speaker === null || isSpeakerShape(value.speaker))
    && typeof value.text === "string"
    && typeof value.isFinal === "boolean"
    && typeof value.sourceEndedAt === "string"
    && typeof value.emittedAt === "string";
}

test("every published caption (partial, diarized final, floor final) passes the viewer contract", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-viewer-contract", mode: "meeting", languages: ["ko", "en"], dependencies: state.dependencies });
  await pipeline.start();
  pipeline.acceptPartialTranscript({ text: "부분 자막", sourceLanguage: "ko-KR" });
  await new Promise((resolve) => setImmediate(resolve));
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "호스트 발화", sourceLanguage: "ko-KR", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  pipeline.setFloorSpeaker({ participantId: "p1", displayName: "김참가" });
  await pipeline.acceptFinalUtterance({ speakerLabel: "B", text: "참가자 발화", sourceLanguage: "ko-KR", sourceStartOffsetMs: 5_000, sourceEndOffsetMs: 6_000, sourceEndedAt: "2026-07-19T00:00:06.000Z" });
  const captions = state.events.filter((event) => event.type === "caption");
  assert.ok(captions.length >= 5);
  for (const caption of captions) {
    assert.equal(viewerAcceptsCaption(caption), true, `viewer would drop: ${JSON.stringify(caption)}`);
  }
});

test("source records survive a full translate outage and target captions recover afterwards", async () => {
  const state = makeDependencies();
  let outage = true;
  state.dependencies.textTranslate.translate = async ({ text, language }) => {
    if (outage) throw new Error("PROVIDER_DOWN");
    return TRANSLATION_TEXT[language];
  };
  let now = 1_000;
  const pipeline = new LiveMediaPipeline({ sessionId: "s-outage", mode: "meeting", languages: ["en"], dependencies: state.dependencies, now: () => now });
  await pipeline.start();
  for (let index = 0; index < 5; index += 1) {
    await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: `발화 ${index}`, sourceLanguage: "ko-KR", sourceStartOffsetMs: index * 1_000, sourceEndOffsetMs: index * 1_000 + 500, sourceEndedAt: `2026-07-19T00:00:0${index}.500Z` });
  }
  // Canonical source storage is independent of failed target delivery.
  const duringOutage = state.events.filter((event) => event.type === "caption" && event.isFinal);
  assert.equal(duringOutage.length, 0, "source text never substitutes for a failed target");
  assert.equal(state.sources.length, 5, "the original record survives a complete translation outage");
  outage = false;
  // Repeated failures arm a 30s cooldown; once it lapses translation must
  // resume on its own and captions must come back.
  now += 31_000;
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "복구 발화", sourceLanguage: "ko-KR", sourceStartOffsetMs: 9_000, sourceEndOffsetMs: 9_500, sourceEndedAt: "2026-07-19T00:00:09.500Z" });
  const afterRecovery = state.events.filter((event) => event.type === "caption" && event.isFinal).at(-1);
  assert.equal(afterRecovery.text, TRANSLATION_TEXT.en, "translation resumes after the provider recovers");
});
