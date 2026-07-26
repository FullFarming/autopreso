import assert from "node:assert/strict";
import test from "node:test";

import { GeminiLiveTranslateAdapter } from "../src/google-provider-adapters.js";
import { LiveMediaPipeline } from "../src/live-media-pipeline.js";

// Enough target-script characters to clear the output-language gate's
// "target language must be PRESENT" threshold (3 chars).
const TRANSLATION_MARKERS = { en: "translated ", ko: "번역됨 ", ja: "翻訳済 ", "zh-Hans": "已翻译 ", "zh-Hant": "已翻譯 " };

function makeDependencies() {
  const events = [];
  const liveSessions = [];
  const openaiVoiceSessions = [];
  const speechSessions = [];
  const translated = [];
  const synthesized = [];
  return {
    events,
    liveSessions,
    openaiVoiceSessions,
    speechSessions,
    translated,
    synthesized,
    dependencies: {
      liveTranslate: {
        async open({ language, onCaption, onAudio, onInterruption, onInputCaption }) {
          const session = { language, onCaption, onAudio, onInterruption, onInputCaption, sent: [], ended: 0, async sendAudio(frame, metadata) { this.sent.push({ frame, metadata }); }, async audioStreamEnd() { this.ended += 1; }, async close() {} };
          liveSessions.push(session);
          return session;
        },
      },
      openaiLiveTranslate: {
        async open({ language, onAudio, onInterruption }) {
          const session = { language, onAudio, onInterruption, sent: [], ended: 0, async sendAudio(frame) { this.sent.push(frame); }, async audioStreamEnd() { this.ended += 1; }, async close() {} };
          openaiVoiceSessions.push(session);
          return session;
        },
      },
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
          return `${language}:${TRANSLATION_MARKERS[language] ?? ""}${text}`;
        },
      },
      textToSpeech: {
        async *synthesizeStream(input) {
          synthesized.push(input);
          yield new Uint8Array(6_000);
          yield new Uint8Array(6_000);
        },
      },
      publisher: {
        async publish(_sessionId, _language, event, { onLiveEvent } = {}) {
          await onLiveEvent?.(event);
          events.push(event);
        },
        async publishAudio(_sessionId, _language, header, pcm) { events.push({ header, byteLength: pcm.byteLength, pcm: Uint8Array.from(pcm) }); },
      },
    },
  };
}

test("presentation opens one provider session per language, not per viewer", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s1", mode: "presentation", languages: ["en", "ko"], dependencies: state.dependencies, now: () => 0 });
  await pipeline.start();
  await pipeline.acceptAudio(new Uint8Array(1_280), 0);
  assert.equal(state.liveSessions.length, 2);
  assert.deepEqual(state.liveSessions.map((session) => session.sent.length), [1, 1]);
});

test("Presentation keeps Gemini captions and routes only translated audio through OpenAI", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "presentation-openai-voice",
    sessionType: "presentation",
    outputMode: "captions_audio",
    voiceProvider: "openai",
    languages: ["ko"],
    dependencies: state.dependencies,
    now: () => 1_000,
  });
  await pipeline.start();
  assert.equal(state.liveSessions.length, 1);
  assert.equal(state.openaiVoiceSessions.length, 1);
  assert.equal(state.speechSessions.length, 0);

  await state.liveSessions[0].onCaption({ text: "Gemini caption", isFinal: true });
  await state.liveSessions[0].onAudio({ sampleRate: 24_000, pcm: new Uint8Array([1, 0]) });
  await state.openaiVoiceSessions[0].onAudio({ sampleRate: 24_000, pcm: new Uint8Array([2, 0]) });
  await pipeline.acceptAudio(new Uint8Array(1_280), 1_000);

  assert.equal(state.events.filter((event) => event.type === "caption").length, 1);
  assert.deepEqual(state.events.filter((event) => event.header?.type === "audio-chunk").map((event) => [...event.pcm]), [[2, 0]]);
  assert.equal(state.liveSessions[0].sent.length, 1);
  assert.equal(state.openaiVoiceSessions[0].sent.length, 1);
});

test("Presentation coalesces repeated partial snapshots and publishes one ordered final", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "presentation-caption-coalescing",
    sessionType: "presentation",
    outputMode: "captions",
    languages: ["ko"],
    dependencies: state.dependencies,
    now: () => 1_000,
  });
  await pipeline.start();
  await state.liveSessions[0].onCaption({ text: "안녕", isFinal: false });
  await state.liveSessions[0].onCaption({ text: "안녕", isFinal: false });
  await state.liveSessions[0].onCaption({ text: "안녕하세요", isFinal: false });
  await state.liveSessions[0].onCaption({ text: "안녕하세요", isFinal: true, utteranceKey: "turn-1" });
  await state.liveSessions[0].onCaption({ text: "안녕하세요", isFinal: true, utteranceKey: "turn-1" });
  const captions = state.events.filter((event) => event.type === "caption");
  assert.deepEqual(captions.map((event) => [event.text, event.isFinal]), [
    ["안녕", false],
    ["안녕하세요", false],
    ["안녕하세요", true],
  ]);
  // Contract C1: interim captions carry the seq their committed line WILL
  // take, without consuming it. Two partials and the final that supersedes
  // them are all the same committed line, so all three report seq 1. The
  // durable counter only advances on the final.
  assert.deepEqual(captions.map((event) => event.seq), [1, 1, 1]);
  assert.deepEqual(captions.filter((event) => event.isFinal).map((event) => event.seq), [1]);
});

test("Presentation OpenAI voice failure clears audio but leaves Gemini captions running", async () => {
  const state = makeDependencies();
  state.dependencies.openaiLiveTranslate.open = async ({ language, onAudio }) => {
    const session = { language, onAudio, async sendAudio() { throw new Error("VOICE_DOWN"); }, async audioStreamEnd() {}, async close() {} };
    state.openaiVoiceSessions.push(session);
    return session;
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "presentation-openai-failure",
    sessionType: "presentation",
    outputMode: "captions_audio",
    voiceProvider: "openai",
    languages: ["ko"],
    dependencies: state.dependencies,
    now: () => 1_000,
  });
  await pipeline.start();
  assert.equal(await pipeline.acceptAudio(new Uint8Array(1_280), 1_000), true);
  await state.liveSessions[0].onCaption({ text: "captions survive", isFinal: true });
  assert.equal(state.events.some((event) => event.type === "caption" && event.text === "captions survive"), true);
  assert.equal(state.events.some((event) => event.type === "language-status" && event.code === "VOICE_UNAVAILABLE"), true);
  assert.equal(state.events.some((event) => event.type === "audio-control" && event.action === "clear"), true);
});

test("Presentation captions stay on Gemini and Gemini remains the default voice provider", async () => {
  for (const [outputMode, expectedCaptions, expectedAudio] of [
    ["captions", 1, 0],
    ["captions_audio", 1, 1],
    ["audio", 0, 1],
  ]) {
    const state = makeDependencies();
    const pipeline = new LiveMediaPipeline({
      sessionId: `presentation-${outputMode}`,
      sessionType: "presentation",
      outputMode,
      glossaryPack: "hotel",
      languages: ["en"],
      dependencies: state.dependencies,
    });
    await pipeline.start();
    assert.equal(state.liveSessions.length, 1);
    assert.equal(state.speechSessions.length, 0);
    await state.liveSessions[0].onCaption({ text: "hello", isFinal: true });
    if (outputMode !== "captions") await state.liveSessions[0].onAudio({ sampleRate: 24_000, pcm: new Uint8Array([1, 0]) });
    assert.equal(state.events.filter((event) => event.type === "caption").length, expectedCaptions);
    assert.equal(state.events.filter((event) => event.header?.type === "audio-chunk").length, expectedAudio);
  }
});

test("Presentation forwards Gemini interruption so every client can clear scheduled playback", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "presentation-interrupted",
    sessionType: "presentation",
    outputMode: "captions",
    languages: ["ko"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  await state.liveSessions[0].onInterruption();
  const event = state.events.find((value) => value.type === "audio-control");
  assert.deepEqual(event, {
    type: "audio-control",
    seq: 1,
    sessionId: "presentation-interrupted",
    language: "ko",
    action: "clear",
    reason: "interrupted",
  });
});

test("meeting keeps the finalized speaker attached to each ordered translation", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s2", mode: "meeting", languages: ["en", "ja"], dependencies: state.dependencies });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "hello", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const captions = state.events.filter((event) => event.type === "caption");
  assert.equal(captions.length, 2);
  assert.equal(state.events.filter((event) => event.type === "speaker-legend").length, 2);
  assert.deepEqual(captions.map((event) => [event.language, event.speaker.speakerId, event.text]), [
    ["en", "speaker-1", "en:translated hello"],
    ["ja", "speaker-1", "ja:翻訳済 hello"],
  ]);
});

test("Meeting coalesces a duplicated finalized STT utterance into one caption and one TTS job", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-final-dedupe", mode: "townhall", languages: ["ko"], dependencies: state.dependencies });
  await pipeline.start();
  const utterance = {
    speakerLabel: "A",
    text: "same final",
    sourceStartOffsetMs: 1_000,
    sourceEndOffsetMs: 1_700,
    sourceEndedAt: "2026-07-19T00:00:01.700Z",
  };
  await Promise.all([pipeline.acceptFinalUtterance(utterance), pipeline.acceptFinalUtterance({ ...utterance })]);
  assert.equal(state.translated.length, 1);
  assert.equal(state.synthesized.length, 1);
  assert.equal(state.events.filter((event) => event.header?.type === "audio-chunk").length, 1);
});

test("Meeting does not coalesce identical words spoken at different source offsets", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-final-repeat", mode: "townhall", languages: ["ko"], dependencies: state.dependencies });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "yes", sourceStartOffsetMs: 1_000, sourceEndOffsetMs: 1_200, sourceEndedAt: "2026-07-19T00:00:01.200Z" });
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "yes", sourceStartOffsetMs: 2_000, sourceEndOffsetMs: 2_200, sourceEndedAt: "2026-07-19T00:00:02.200Z" });
  assert.equal(state.synthesized.length, 2);
});

test("Meeting captions-audio emits both while audio emits TTS only", async () => {
  for (const [outputMode, expectedCaptions] of [["captions_audio", 1], ["audio", 0]]) {
    const state = makeDependencies();
    const pipeline = new LiveMediaPipeline({
      sessionId: `meeting-${outputMode}`,
      sessionType: "meeting",
      outputMode,
      glossaryPack: "fnb",
      languages: ["en"],
      dependencies: state.dependencies,
    });
    await pipeline.start();
    await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "hello", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
    assert.equal(state.events.filter((event) => event.type === "caption").length, expectedCaptions);
    assert.equal(state.events.filter((event) => event.header?.type === "audio-chunk").length, 1);
    assert.equal(state.synthesized[0].glossaryPack, undefined);
    assert.deepEqual(state.translated[0], ["hello", "en", "fnb"]);
  }
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
    return `${language}:${TRANSLATION_MARKERS[language] ?? ""}${text}`;
  };
  const pipeline = new LiveMediaPipeline({ sessionId: "s-language-isolation", mode: "meeting", languages: ["en", "ja"], dependencies: state.dependencies });
  await pipeline.start();
  const first = pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "one", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const second = pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "two", sourceEndedAt: "2026-07-19T00:00:01.000Z" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    state.events.filter((event) => event.type === "caption" && event.language === "en").map((event) => event.text),
    ["en:translated one", "en:translated two"],
  );
  releaseJapanese();
  await Promise.all([first, second]);
});

test("townhall fixes one voice per speaker and emits 250 ms PCM chunks", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s3", mode: "townhall", languages: ["ko"], dependencies: state.dependencies });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "one", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "two", sourceEndedAt: "2026-07-19T00:00:01.000Z" });
  assert.equal(state.synthesized[0].voiceName, state.synthesized[1].voiceName);
  const audioEvents = state.events.filter((event) => event.header?.type === "audio-chunk");
  assert.equal(audioEvents.length, 2);
  assert.deepEqual(audioEvents.map((event) => event.byteLength), [12_000, 12_000]);
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
  assert.equal(caption.text, "ko:번역됨 caption only");
  assert.equal(caption.speaker.voiceStatus, "disabled");
  assert.equal(state.synthesized.length, 0);
});

test("Townhall auto voice keeps different speaker labels distinct and fixes compatible presets", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-townhall-auto",
    mode: "townhall",
    voiceOutputMode: "auto_voice",
    languages: ["ko"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  const firstPcm = tonePcm(110, 800);
  const secondPcm = tonePcm(115, 800);
  const thirdPcm = tonePcm(300, 800);
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "one", pcmWindow: firstPcm, sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  await pipeline.acceptFinalUtterance({ speakerLabel: "B", text: "two", pcmWindow: secondPcm, sourceEndedAt: "2026-07-19T00:00:01.000Z" });
  await pipeline.acceptFinalUtterance({ speakerLabel: "C", text: "three", pcmWindow: thirdPcm, sourceEndedAt: "2026-07-19T00:00:02.000Z" });

  const speakers = pipeline.speakers.list();
  assert.deepEqual(speakers.map((speaker) => speaker.speakerId), ["speaker-1", "speaker-2", "speaker-3"]);
  assert.equal(new Set(speakers.map((speaker) => speaker.voiceName)).size, 3);
  assert.equal(speakers.every((speaker) => speaker.voiceStatus === "ready"), true);
  assert.equal(speakers.some((speaker) => "acousticRange" in speaker), false);
  assert.deepEqual(state.synthesized.map((request) => request.voiceName), speakers.map((speaker) => speaker.voiceName));
  assert.equal([firstPcm, secondPcm, thirdPcm].every((pcm) => pcm.every((byte) => byte === 0)), true);
});

test("legacy Townhall auto voice maps to Meeting audio without acoustic inference", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-townhall-auto-uncertain",
    mode: "townhall",
    voiceOutputMode: "auto_voice",
    languages: ["ko"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "legacy", pcmWindow: null, sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  assert.equal(pipeline.sessionType, "meeting");
  assert.equal(pipeline.outputMode, "audio");
  assert.equal(state.synthesized.length, 1);
  assert.equal(pipeline.speakers.list()[0].voiceStatus, "ready");
});

test("Townhall publishes the first complete PCM chunk before synthesis ends and keeps utterance order", async () => {
  const state = makeDependencies();
  let releaseFirst;
  state.dependencies.textToSpeech.synthesizeStream = async function* (input) {
    state.synthesized.push(input);
    yield new Uint8Array(5_999);
    yield new Uint8Array(6_001);
    if (input.text.endsWith("one")) await new Promise((resolve) => { releaseFirst = resolve; });
  };
  const pipeline = new LiveMediaPipeline({ sessionId: "s-stream", mode: "townhall", languages: ["ko"], dependencies: state.dependencies });
  await pipeline.start();
  const first = pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "one", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const second = pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "two", sourceEndedAt: "2026-07-19T00:00:01.000Z" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.events.filter((event) => event.header?.type === "audio-chunk").length, 1);
  assert.deepEqual(state.synthesized.map((input) => input.text), ["ko:번역됨 one"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(state.synthesized.map((input) => input.text), ["ko:번역됨 one", "ko:번역됨 two"]);
});

test("Townhall publishes the final even PCM remainder without silence padding", async () => {
  const state = makeDependencies();
  state.dependencies.textToSpeech.synthesizeStream = async function* () {
    const pcm = new Uint8Array(2_000);
    pcm.fill(7);
    yield pcm;
  };
  const pipeline = new LiveMediaPipeline({ sessionId: "s-final-frame", mode: "townhall", languages: ["ko"], dependencies: state.dependencies });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "short", sourceEndedAt: "2026-07-19T00:00:00.000Z" });

  const audio = state.events.find((event) => event.header?.type === "audio-chunk");
  assert.equal(audio.byteLength, 2_000);
  assert.deepEqual(audio.pcm, new Uint8Array(2_000).fill(7));
});

test("mode hot-swap preserves speaker identity and deterministically adds a Townhall voice", async () => {
  const meetingState = makeDependencies();
  const meeting = new LiveMediaPipeline({ sessionId: "s-hot", mode: "meeting", languages: ["ko"], dependencies: meetingState.dependencies });
  await meeting.start();
  await meeting.acceptFinalUtterance({ speakerLabel: "A", text: "one", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const before = meeting.speakers.getOrCreate("A");

  const townhallState = makeDependencies();
  const townhall = new LiveMediaPipeline({
    sessionId: "s-hot",
    mode: "townhall",
    languages: ["ko"],
    dependencies: townhallState.dependencies,
    speakerRegistry: meeting.speakers,
    initialSequences: meeting.lastSequences,
  });
  await townhall.start();
  await townhall.acceptFinalUtterance({ speakerLabel: "A", text: "two", sourceEndedAt: "2026-07-19T00:00:01.000Z" });
  const after = townhall.speakers.getOrCreate("A");
  assert.equal(after.speakerId, before.speakerId);
  assert.equal(after.colorToken, before.colorToken);
  assert.equal(after.voiceName, "Achernar");
  assert.equal(townhallState.synthesized[0].voiceName, "Achernar");
  const townhallAudio = townhallState.events.find((event) => event.header?.type === "audio-chunk");
  assert.ok(townhallAudio.header.seq >= 1, "audio chunks keep their own transient counter");
  // Hot-swap seeds every per-language caption counter so caption seq stays
  // monotonic across pipelines (audio never consumes caption seq): the
  // townhall utterance above continues right after the meeting's last seq.
  assert.equal(townhall.lastSequences.ko, meeting.lastSequences.ko + 1);
});

test("Townhall keeps streaming when synthesis itself lasts longer than three seconds", async () => {
  const state = makeDependencies();
  let now = 0;
  state.dependencies.textToSpeech.synthesizeStream = async function* () {
    now = 3_001;
    yield new Uint8Array(12_000);
    now = 8_000;
    yield new Uint8Array(12_000);
  };
  const pipeline = new LiveMediaPipeline({ sessionId: "s-late", mode: "townhall", languages: ["ko"], dependencies: state.dependencies, now: () => now });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "late", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  assert.equal(state.events.filter((event) => event.header?.type === "audio-chunk").length, 2);
  assert.equal(state.events.some((event) => event.type === "caption"), false, "Townhall is audio-only");
});

test("Townhall aborts a provider that never yields after an inactivity timeout and restarts the language worker", async () => {
  const state = makeDependencies();
  let deadlineTimer;
  let wasCancelled = false;
  state.dependencies.textToSpeech.synthesizeStream = async function* ({ signal }) {
    try {
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      yield new Uint8Array();
    } finally {
      wasCancelled = true;
    }
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-stalled",
    mode: "townhall",
    languages: ["ko"],
    dependencies: state.dependencies,
    now: () => 0,
    setTimeoutFn(callback, delay) {
      deadlineTimer = { callback, delay };
      return deadlineTimer;
    },
    clearTimeoutFn() {},
  });
  await pipeline.start();
  const utterance = pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "stalled", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deadlineTimer.delay, 10_000);
  deadlineTimer.callback();
  await utterance;
  assert.equal(state.events.some((event) => event.type === "language-status" && event.status === "preparing"), true);
  await pipeline.close();
  assert.equal(wasCancelled, true);
});

test("pipeline close immediately aborts active Townhall synthesis and clears its timer", async () => {
  const state = makeDependencies();
  let wasCancelled = false;
  let cleared = 0;
  state.dependencies.textToSpeech.synthesizeStream = async function* ({ signal }) {
    try {
      await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      yield new Uint8Array();
    } finally {
      wasCancelled = true;
    }
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-close-stalled",
    mode: "townhall",
    languages: ["ko"],
    dependencies: state.dependencies,
    setTimeoutFn() { return { pending: true }; },
    clearTimeoutFn() { cleared += 1; },
  });
  await pipeline.start();
  const utterance = pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "stalled", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const utteranceSettled = assert.doesNotReject(() => utterance);
  await new Promise((resolve) => setImmediate(resolve));

  await pipeline.close();
  await utteranceSettled;
  assert.equal(wasCancelled, true);
  assert.equal(cleared, 2);
});

test("Townhall restarts one language after a TTS response overflow and accepts the next utterance", async () => {
  const state = makeDependencies();
  let attempts = 0;
  state.dependencies.textToSpeech.synthesizeStream = async function* () {
    attempts += 1;
    if (attempts === 1) throw new Error("TTS_RESPONSE_BUFFER_EXCEEDED");
    yield new Uint8Array(12_000);
  };
  const pipeline = new LiveMediaPipeline({ sessionId: "s-buffer-overflow", mode: "townhall", languages: ["ko"], dependencies: state.dependencies });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "overflow", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "recovered", sourceEndedAt: "2026-07-19T00:00:01.000Z" });
  assert.equal(
    state.events.some((event) => event.type === "language-status" && event.status === "preparing" && event.code === "TTS_RESPONSE_BUFFER_EXCEEDED"),
    true,
  );
  assert.equal(state.events.filter((event) => event.header?.type === "audio-chunk").length, 1);
});

test("Townhall does not arm an inactivity timer when the TTS adapter returns no iterator", async () => {
  const state = makeDependencies();
  let cleared = 0;
  state.dependencies.textToSpeech.synthesizeStream = () => null;
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-invalid-stream",
    mode: "townhall",
    languages: ["ko"],
    dependencies: state.dependencies,
    setTimeoutFn() { return { timer: true }; },
    clearTimeoutFn() { cleared += 1; },
  });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "invalid", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  assert.equal(cleared, 0);
});

test("Townhall preserves an utterance that waited over three seconds and continues in order", async () => {
  const state = makeDependencies();
  let now = 0;
  let releaseFirst;
  state.dependencies.textToSpeech.synthesizeStream = async function* (input) {
    state.synthesized.push(input);
    const { text } = input;
    if (text.endsWith("one")) await new Promise((resolve) => { releaseFirst = resolve; });
    yield new Uint8Array(12_000);
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-queue-restart",
    mode: "townhall",
    languages: ["ko"],
    dependencies: state.dependencies,
    now: () => now,
  });
  await pipeline.start();
  const first = pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "one", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  await new Promise((resolve) => setImmediate(resolve));
  const late = pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "late", sourceEndedAt: "2026-07-19T00:00:01.000Z" });
  now = 3_001;
  releaseFirst();
  await Promise.all([first, late]);
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "three", sourceEndedAt: "2026-07-19T00:00:02.000Z" });

  assert.equal(state.events.filter((event) => event.header?.type === "audio-chunk").length, 3);
  assert.deepEqual(state.synthesized.map((input) => input.text), ["ko:번역됨 one", "ko:번역됨 late", "ko:번역됨 three"]);
  assert.equal(state.events.some((event) => event.type === "audio-control" && event.action === "restart"), false);
});

test("Townhall opens a bounded cooldown after three consecutive language failures and later recovers", async () => {
  const state = makeDependencies();
  let now = 0;
  let attempts = 0;
  state.dependencies.textToSpeech.synthesizeStream = async function* () {
    attempts += 1;
    if (attempts <= 3) throw new Error("TTS_STREAM_FAILED");
    yield new Uint8Array(12_000);
  };
  const pipeline = new LiveMediaPipeline({ sessionId: "s-cooldown", mode: "townhall", languages: ["ko"], dependencies: state.dependencies, now: () => now });
  await pipeline.start();
  for (let index = 0; index < 3; index += 1) {
    await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: `fail-${index}`, sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  }
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "cooldown-skip", sourceEndedAt: "2026-07-19T00:00:01.000Z" });
  assert.equal(attempts, 3);
  assert.equal(state.events.some((event) => event.type === "language-status" && event.status === "unavailable" && event.code === "LANGUAGE_COOLDOWN"), true);
  now = 30_001;
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "recovered", sourceEndedAt: "2026-07-19T00:00:31.000Z" });
  assert.equal(attempts, 4);
  assert.equal(state.events.at(-1).status, "ready");
});

test("stale host frames are dropped and pauses close the provider audio turn", async () => {
  const state = makeDependencies();
  let now = 2_000;
  const pipeline = new LiveMediaPipeline({ sessionId: "s4", mode: "presentation", languages: ["en"], dependencies: state.dependencies, now: () => now });
  await pipeline.start();
  assert.equal(await pipeline.acceptAudio(new Uint8Array(1_280), 1_000), false);
  assert.equal(state.liveSessions[0].sent.length, 0);
  await pipeline.acceptAudio(new Uint8Array(1_280), 2_000);
  now = 3_001;
  await pipeline.tick();
  assert.equal(state.liveSessions[0].ended, 1);
});

test("caption seq is per-language monotonic from 1 and audio events never consume it", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-per-language-seq",
    sessionType: "meeting",
    outputMode: "captions_audio",
    languages: ["en", "ja"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "one", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "two", sourceEndedAt: "2026-07-19T00:00:01.000Z" });

  const captions = state.events.filter((event) => event.type === "caption");
  assert.deepEqual(captions.filter((event) => event.language === "en").map((event) => event.seq), [1, 2]);
  assert.deepEqual(captions.filter((event) => event.language === "ja").map((event) => event.seq), [1, 2]);
  // Audio chunks were interleaved between captions but the caption lanes above
  // stayed dense: the audio events run on their own transient counter.
  assert.ok(state.events.filter((event) => event.header?.type === "audio-chunk").length >= 2);
  assert.deepEqual(pipeline.lastSequences, { en: 2, ja: 2 });
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

test("pause discards audio and finalized utterances; resume restores emission with intact seq", async () => {
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

  pipeline.pause();
  assert.equal(pipeline.isPaused, true);
  assert.equal(await pipeline.acceptAudio(new Uint8Array(1_280), 1_000), false);
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "while paused", sourceEndedAt: "2026-07-19T00:00:01.000Z" });
  assert.equal(state.events.filter((event) => event.type === "caption").length, 1);

  pipeline.resume();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "after", sourceEndedAt: "2026-07-19T00:00:02.000Z" });
  const captions = state.events.filter((event) => event.type === "caption");
  assert.deepEqual(captions.map((event) => [event.seq, event.text]), [[1, "ko:번역됨 before"], [2, "ko:번역됨 after"]]);
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
      ["en", "en:translated 안녕하세요"],
      ["en", "good morning"],
      ["ko", "ko:번역됨 good morning"],
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
  assert.equal(byLanguage.get("en").text, "en:translated 안녕하세요");
  assert.equal(byLanguage.get("en").sourceText, "안녕하세요");
  assert.equal(byLanguage.get("en").sourceLanguage, "ko");
  assert.equal(byLanguage.get("en").translationStatus, "translated");
});

test("a failed translation is recorded with a failed label, and the source lane is intact", async () => {
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

  // The caption IS published, because the record must stay hole-free — a viewer
  // browsing the English transcript later still needs this utterance. It carries
  // translationStatus "failed", and the VIEWER renders only "translated"
  // captions, so the Korean text never reaches an English screen.
  const englishLane = state.events.find((event) => event.type === "caption" && event.language === "en");
  assert.equal(englishLane.text, "안녕하세요");
  assert.equal(englishLane.translationStatus, "failed");
  assert.equal(englishLane.sourceText, "안녕하세요");
  assert.equal(englishLane.sourceLanguage, "ko");
  // A broken translator must NOT silence the source lane, which needs no
  // translation at all.
  const koreanLane = state.events.find((event) => event.type === "caption" && event.language === "ko");
  assert.equal(koreanLane.text, "안녕하세요");
  assert.equal(koreanLane.translationStatus, "verbatim");
  assert.equal(koreanLane.sourceText, null);
  assert.equal(koreanLane.sourceLanguage, "ko");
});

test("interim captions carry the same provenance fields as finals", async () => {
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
  const englishPartial = partials.find((event) => event.language === "en");
  const koreanPartial = partials.find((event) => event.language === "ko");
  assert.equal(englishPartial.sourceText, "안녕하세요 여러분");
  assert.equal(englishPartial.sourceLanguage, "ko");
  assert.equal(englishPartial.translationStatus, "translated");
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

// Contract C1: interim captions must NOT consume the finalized caption seq
// space. Only finals persist, so fetchLastUtteranceSeqs returns the last FINAL
// seq — and that value reseeds a fresh pipeline. If partials advance the same
// counter, the reseed regresses below what viewers already saw, and the
// viewer's `seq <= lastSeq` guard then drops every subsequent caption for the
// rest of the meeting.
test("interim captions never consume the finalized caption seq space", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-seq-space",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko"],
    dependencies: state.dependencies,
    now: () => 0,
  });
  await pipeline.start();

  for (let index = 0; index < 20; index += 1) {
    await state.liveSessions[0].onCaption({ text: `partial ${index}`, isFinal: false });
  }
  await state.liveSessions[0].onCaption({ text: "committed line", isFinal: true });
  for (let index = 0; index < 30; index += 1) {
    await state.liveSessions[0].onCaption({ text: `after ${index}`, isFinal: false });
  }

  const captions = state.events.filter((event) => event.type === "caption");
  const finals = captions.filter((event) => event.isFinal);

  assert.equal(finals.length, 1);
  // 20 interim captions preceded the commit, and it still takes seq 1 — that
  // is the whole fix. Before it, the commit took seq 21 while viewers had
  // already been shown seq 51, so the reseed regressed by 30.
  assert.equal(finals.at(-1).seq, 1, "interim captions must not consume commit seq");
  // The durable invariant: the finals max (what fetchLastUtteranceSeqs
  // returns) is never below any FINAL seq delivered, so a reseed cannot
  // regress the committed stream. Interim seq is deliberately excluded — it
  // is a forward-looking hint and the viewer ignores it for resume.
  const finalsMax = Math.max(...finals.map((event) => event.seq));
  assert.ok(finals.every((event) => event.seq <= finalsMax));
  assert.deepEqual(finals.map((event) => event.seq), [1], "commit seq stays gap-free from 1");
});

// A speaker genuinely repeating a sentence is not the model re-emitting one.
// The dedupe memo must therefore be time-gated: identical text only counts as
// a re-emission when it lands within a second of the previous publish.
test("an identical sentence said again after a pause publishes again", async () => {
  const state = makeDependencies();
  let clock = 0;
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-repeat",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko"],
    dependencies: state.dependencies,
    now: () => clock,
  });
  await pipeline.start();

  await state.liveSessions[0].onCaption({ text: "네, 맞습니다.", isFinal: true });
  // Same words, three seconds later — a real second utterance.
  clock = 3_000;
  await state.liveSessions[0].onCaption({ text: "네, 맞습니다.", isFinal: true });

  const finals = state.events.filter((event) => event.type === "caption" && event.isFinal);
  assert.equal(finals.length, 2, "a repeated acknowledgement must not be swallowed");
  assert.deepEqual(finals.map((event) => event.text), ["네, 맞습니다.", "네, 맞습니다."]);
  assert.ok(finals[1].seq > finals[0].seq, "the repeat takes its own caption seq");
});

test("a provider re-emitting the same text within a second is still suppressed", async () => {
  const state = makeDependencies();
  let clock = 0;
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-reemit",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko"],
    dependencies: state.dependencies,
    now: () => clock,
  });
  await pipeline.start();

  await state.liveSessions[0].onCaption({ text: "동일한 문장", isFinal: true, utteranceKey: "provider-turn-1" });
  clock = 200;
  await state.liveSessions[0].onCaption({ text: "동일한 문장", isFinal: true, utteranceKey: "provider-turn-1" });

  const finals = state.events.filter((event) => event.type === "caption" && event.isFinal);
  assert.equal(finals.length, 1, "an immediate duplicate is a provider re-emission");
});

test("TTS synthesis is skipped for zero-subscriber languages while captions still translate", async () => {
  const state = makeDependencies();
  const subscribers = new Map([["ko", 0]]);
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-tts-skip",
    sessionType: "meeting",
    outputMode: "captions_audio",
    languages: ["ko"],
    dependencies: state.dependencies,
    getSubscriberCount: (language) => subscribers.get(language) ?? 0,
  });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "nobody listening", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  assert.equal(state.translated.length, 1, "caption translation must still run (contract C6)");
  assert.equal(state.events.filter((event) => event.type === "caption").length, 1);
  assert.equal(state.synthesized.length, 0, "no subscriber → no TTS");

  subscribers.set("ko", 1);
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "listener arrived", sourceEndedAt: "2026-07-19T00:00:01.000Z" });
  assert.equal(state.synthesized.length, 1, "TTS resumes for subsequent utterances");
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
  assert.equal(en.text, "en:translated 안녕하세요 여러분");
});

test("matching source language and script keeps verbatim passthrough on the source lane", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-script-ok", mode: "meeting", languages: ["en", "ko"], dependencies: state.dependencies });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "안녕하세요 여러분", sourceLanguage: "ko-KR", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const ko = state.events.find((event) => event.type === "caption" && event.language === "ko");
  const en = state.events.find((event) => event.type === "caption" && event.language === "en");
  assert.equal(ko.text, "안녕하세요 여러분");
  assert.equal(en.text, "en:translated 안녕하세요 여러분");
});

test("a translate failure records the source on that lane but labels it failed", async () => {
  const state = makeDependencies();
  state.dependencies.textTranslate.translate = async ({ text, language }) => {
    if (language === "ja") throw new Error("provider unavailable");
    return `${language}:${text}`;
  };
  const pipeline = new LiveMediaPipeline({ sessionId: "s-translate-fallback", mode: "meeting", languages: ["en", "ja"], dependencies: state.dependencies });
  await pipeline.start();
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "hello everyone", sourceLanguage: "en-US", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  // Recorded (so the ja transcript has no hole) but labelled, so the viewer's
  // "render only translated" filter keeps English off a Japanese screen. The
  // language-status signal still reports the lane as degraded.
  const ja = state.events.find((event) => event.type === "caption" && event.language === "ja");
  assert.equal(ja.text, "hello everyone");
  assert.equal(ja.translationStatus, "failed");
  assert.equal(state.events.some((event) => event.type === "language-status" && event.language === "ja" && event.status === "preparing"), true);
});

test("meeting interim transcripts stream partial captions to every lane", async () => {
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
  assert.deepEqual(en.at(-1), "en:translated 안녕하세요 여러분");
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

test("captions are mirrored to the host socket for bidirectional desktop display", async () => {
  const state = makeDependencies();
  const hostEvents = [];
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-host-mirror",
    mode: "meeting",
    languages: ["ko"],
    dependencies: state.dependencies,
    onHostEvent: (event) => hostEvents.push(event),
  });
  await pipeline.start();
  pipeline.setFloorSpeaker({ participantId: "p1", displayName: "김참가" });
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "참가자 발언입니다", sourceLanguage: "ko-KR", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const captions = hostEvents.filter((event) => event.type === "caption");
  assert.equal(captions.length, 1);
  assert.equal(captions[0].text, "참가자 발언입니다");
  assert.equal(captions[0].speaker.isParticipant, true);
  assert.equal(captions[0].speaker.name, "김참가");
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

test("a realistic interim/commit stream loses no committed caption at the viewer", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-viewer-guard",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko"],
    dependencies: state.dependencies,
    now: () => 0,
  });
  await pipeline.start();

  // Three utterances, each streamed as partials then committed.
  for (let utterance = 0; utterance < 3; utterance += 1) {
    for (let step = 0; step < 5; step += 1) {
      await state.liveSessions[0].onCaption({ text: `u${utterance} step ${step}`, isFinal: false });
    }
    await state.liveSessions[0].onCaption({ text: `utterance ${utterance} committed.`, isFinal: true });
  }

  const captions = state.events.filter((event) => event.type === "caption");
  const finals = captions.filter((event) => event.isFinal);
  assert.equal(finals.length, 3);
  assert.deepEqual(finals.map((event) => event.seq), [1, 2, 3]);

  // With the corrected guard every commit reaches the feed.
  const live = {};
  const accepted = captions.filter((event) => viewerAcceptsSeq(live, event));
  assert.equal(accepted.filter((event) => event.isFinal).length, 3, "no commit may be dropped");

  // And the guard is load-bearing: applying it to interim captions too — the
  // pre-fix behaviour — silently eats commits, which is the blank-feed bug.
  const naive = {};
  const naiveAccepted = captions.filter((event) => viewerAcceptsSeq(naive, event, { committedOnly: false }));
  assert.ok(
    naiveAccepted.filter((event) => event.isFinal).length < 3,
    "guarding interim captions must be demonstrably wrong, or this test proves nothing",
  );
});

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

test("captions keep flowing through a full translate outage and recover afterwards", async () => {
  const state = makeDependencies();
  let outage = true;
  state.dependencies.textTranslate.translate = async ({ text, language }) => {
    if (outage) throw new Error("PROVIDER_DOWN");
    return `${language}:${TRANSLATION_MARKERS[language] ?? ""}${text}`;
  };
  let now = 1_000;
  const pipeline = new LiveMediaPipeline({ sessionId: "s-outage", mode: "meeting", languages: ["en"], dependencies: state.dependencies, now: () => now });
  await pipeline.start();
  for (let index = 0; index < 5; index += 1) {
    await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: `발화 ${index}`, sourceLanguage: "ko-KR", sourceStartOffsetMs: index * 1_000, sourceEndOffsetMs: index * 1_000 + 500, sourceEndedAt: `2026-07-19T00:00:0${index}.500Z` });
  }
  // An outage must not put a hole in the record, so captions keep being
  // published with the source text — but every one is labelled "failed", which
  // is what stops the viewer rendering Korean on the English lane. Recording and
  // displaying are deliberately separate concerns.
  const duringOutage = state.events.filter((event) => event.type === "caption" && event.isFinal);
  assert.equal(duringOutage.length, 5, "an outage must never drop a caption from the record");
  assert.equal(duringOutage.every((event) => event.text.startsWith("발화")), true);
  assert.equal(duringOutage.every((event) => event.translationStatus === "failed"), true,
    "every outage caption must be labelled so the viewer hides it");
  outage = false;
  // Repeated failures arm a 30s cooldown; once it lapses translation must
  // resume on its own and captions must come back.
  now += 31_000;
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "복구 발화", sourceLanguage: "ko-KR", sourceStartOffsetMs: 9_000, sourceEndOffsetMs: 9_500, sourceEndedAt: "2026-07-19T00:00:09.500Z" });
  const afterRecovery = state.events.filter((event) => event.type === "caption" && event.isFinal).at(-1);
  assert.equal(afterRecovery.text, "en:translated 복구 발화", "translation resumes after the provider recovers");
});

// ── 2026-07-24 provider split: meeting captions on Gemini Live Translate ──

test("meeting opens live-translate sessions per language and never Cloud STT", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-live-meeting", mode: "meeting", languages: ["ko", "en"], dependencies: state.dependencies });
  await pipeline.start();
  assert.equal(state.liveSessions.length, 2);
  assert.equal(state.speechSessions.length, 0);
  await pipeline.acceptAudio(new Uint8Array(1_280), Date.now());
  assert.deepEqual(state.liveSessions.map((session) => session.sent.length), [1, 1]);
});

test("meeting live-translate captions carry floor attribution while a participant speaks", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-live-floor", mode: "meeting", languages: ["ko", "en"], dependencies: state.dependencies });
  await pipeline.start();
  const enSession = state.liveSessions.find((session) => session.language === "en");
  await enSession.onCaption({ text: "Hello from the floor", isFinal: false });
  pipeline.setFloorSpeaker({ participantId: "p1", displayName: "김참가" });
  await enSession.onCaption({ text: "Hello from the floor, everyone", isFinal: true });
  const captions = state.events.filter((event) => event.type === "caption" && event.language === "en");
  assert.equal(captions[0].speaker, null);
  assert.equal(captions.at(-1).speaker?.name, "김참가");
  assert.equal(captions.at(-1).speaker?.isParticipant, true);
});

test("the meeting input transcript feeds the source-language lane like the desktop hub", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-live-input", mode: "meeting", languages: ["ko", "en"], dependencies: state.dependencies });
  await pipeline.start();
  const firstSession = state.liveSessions[0];
  assert.equal(typeof firstSession.onInputCaption, "function", "only the first session surfaces input transcripts");
  assert.equal(state.liveSessions[1].onInputCaption, undefined);
  await firstSession.onInputCaption({ text: "안녕하세요 여러분", isFinal: false, languageCode: "ko-KR" });
  await firstSession.onInputCaption({ text: "안녕하세요 여러분 반갑습니다", isFinal: true, languageCode: "ko-KR" });
  const koCaptions = state.events.filter((event) => event.type === "caption" && event.language === "ko");
  assert.deepEqual(koCaptions.map((event) => [event.text, event.isFinal]), [
    ["안녕하세요 여러분", false],
    ["안녕하세요 여러분 반갑습니다", true],
  ]);
  // English speech routes to the en lane by script when the hint is absent.
  await firstSession.onInputCaption({ text: "Let us move on to the next item", isFinal: true });
  const enCaptions = state.events.filter((event) => event.type === "caption" && event.language === "en");
  assert.equal(enCaptions.at(-1).text, "Let us move on to the next item");
});

test("meeting finals run the desktop deterministic glossary pass", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-live-glossary",
    mode: "meeting",
    languages: ["en"],
    glossaryText: "힐튼 가든 인 = Hilton Garden Inn\n르메르디앙 = Le Méridien",
    dependencies: state.dependencies,
  });
  await pipeline.start();
  await state.liveSessions[0].onCaption({ text: "We toured 힐튼 가든 인 yesterday", isFinal: false });
  await state.liveSessions[0].onCaption({ text: "We toured 힐튼 가든 인 yesterday", isFinal: true });
  const captions = state.events.filter((event) => event.type === "caption");
  // Changed 2026-07-26: partials now run the deterministic pass too. The
  // caption is the final artifact, so the reader must not watch a line rewrite
  // itself from "힐튼 가든 인" to "Hilton Garden Inn" when the final lands — and
  // the record has to agree with what was on screen. The original "verbatim for
  // latency" tradeoff was measured at ~0.13ms per line against the 19KB CRE
  // glossary, which is not a latency cost worth that inconsistency. The LLM
  // polish stays finals-only; that one IS a network round-trip.
  assert.equal(captions[0].text, "We toured Hilton Garden Inn yesterday", "partials enforce the glossary too");
  assert.equal(captions.at(-1).text, "We toured Hilton Garden Inn yesterday", "finals enforce the glossary");
});

test("meeting audio output opens OpenAI voice sessions, never Gemini voice", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-live-voice",
    sessionType: "meeting",
    outputMode: "captions_audio",
    languages: ["ko"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  assert.equal(state.openaiVoiceSessions.length, 1);
  // Gemini live sessions still caption but their audio callback is inert.
  await state.liveSessions[0].onAudio({ sampleRate: 24_000, pcm: new Uint8Array([1, 0]) });
  assert.equal(state.events.filter((event) => event.header?.type === "audio-chunk").length, 0);
  await state.openaiVoiceSessions[0].onAudio({ sampleRate: 24_000, pcm: new Uint8Array([2, 0]) });
  assert.equal(state.events.filter((event) => event.header?.type === "audio-chunk").length, 1);
});

test("meeting live-translate captions mirror to the host socket", async () => {
  const state = makeDependencies();
  const hostEvents = [];
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-live-host-mirror",
    mode: "meeting",
    languages: ["ko"],
    dependencies: state.dependencies,
    onHostEvent: (event) => hostEvents.push(event),
  });
  await pipeline.start();
  await state.liveSessions[0].onCaption({ text: "미러링 확인", isFinal: true });
  assert.equal(hostEvents.filter((event) => event.type === "caption").length, 1);
});

test("desktop host mirror is emitted before durable persistence completes", async () => {
  const state = makeDependencies();
  let releasePersistence;
  const persistenceGate = new Promise((resolve) => { releasePersistence = resolve; });
  const hostEvents = [];
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-fast-host-mirror", sessionType: "meeting", outputMode: "captions",
    languages: ["ko"], dependencies: state.dependencies, onHostEvent: (event) => hostEvents.push(event),
  });
  await pipeline.start();
  state.dependencies.publisher.publish = async (_sessionId, _language, event, { onLiveEvent } = {}) => {
    await onLiveEvent?.(event);
    await persistenceGate;
  };
  const publishing = state.liveSessions[0].onCaption({ text: "지연 없는 미러", isFinal: true, utteranceKey: "turn-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hostEvents.some((event) => event.text === "지연 없는 미러"), true);
  releasePersistence();
  await publishing;
});

test("floor captions carry participant:<id> speakerId so records attribute to the participant", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-participant-id", mode: "meeting", languages: ["en"], dependencies: state.dependencies });
  await pipeline.start();
  pipeline.setFloorSpeaker({ participantId: "p-77", displayName: "김참가", department: "재무팀", jobTitle: "매니저" });
  await state.liveSessions[0].onCaption({ text: "Participant speech.", isFinal: true });
  const caption = state.events.filter((event) => event.type === "caption").at(-1);
  assert.equal(caption.speaker.speakerId, "participant:p-77");
  assert.equal(caption.speaker.name, "김참가");
  assert.equal(caption.speaker.department, "재무팀");
  assert.equal(caption.speaker.jobTitle, "매니저");
});

test("input-transcript captions are marked origin source; translated lanes are not", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-origin", mode: "meeting", languages: ["ko", "en"], dependencies: state.dependencies });
  await pipeline.start();
  await state.liveSessions[0].onInputCaption({ text: "안녕하세요 여러분.", isFinal: true, languageCode: "ko-KR" });
  const enSession = state.liveSessions.find((session) => session.language === "en");
  await enSession.onCaption({ text: "Hello everyone.", isFinal: true });
  const koCaption = state.events.find((event) => event.type === "caption" && event.language === "ko");
  const enCaption = state.events.find((event) => event.type === "caption" && event.language === "en");
  assert.equal(koCaption.origin, "source");
  assert.equal("origin" in enCaption, false);
});

test("meeting finals run the desktop second-pass polish before the deterministic glossary", async () => {
  const state = makeDependencies();
  const polishCalls = [];
  state.dependencies.captionPolish = {
    async polish(input) {
      polishCalls.push(input);
      return "We toured 힐튼 가든 인 yesterday, and results exceeded expectations.";
    },
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-polish",
    mode: "meeting",
    languages: ["en"],
    glossaryText: "힐튼 가든 인 = Hilton Garden Inn",
    translationTone: "business",
    domainText: "호텔 미팅",
    dependencies: state.dependencies,
  });
  await pipeline.start();
  await state.liveSessions[0].onCaption({ text: "we toured hilton garden inn yesterday and results were good", isFinal: true });
  assert.equal(polishCalls.length, 1);
  assert.equal(polishCalls[0].tone, "business");
  assert.equal(polishCalls[0].domain, "호텔 미팅");
  const final = state.events.filter((event) => event.type === "caption").at(-1);
  // Polish output, then the deterministic glossary net fixes the Korean term.
  assert.equal(final.text, "We toured Hilton Garden Inn yesterday, and results exceeded expectations.");
});

test("meeting translated finals carry the same source text into polish, host mirror, and persistence", async () => {
  const state = makeDependencies();
  const hostEvents = [];
  const polishCalls = [];
  state.dependencies.captionPolish = {
    async polish(input) { polishCalls.push(input); return input.translatedText; },
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-source-parity",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko", "en"],
    dependencies: state.dependencies,
    onHostEvent: (event) => hostEvents.push(event),
  });
  await pipeline.start();
  await state.liveSessions[0].onInputCaption({ text: "안녕하세요", isFinal: true, languageCode: "ko-KR" });
  const enSession = state.liveSessions.find((session) => session.language === "en");
  await enSession.onCaption({ text: "Hello.", isFinal: true });
  const persisted = state.events.find((event) => event.type === "caption" && event.language === "en");
  const mirrored = hostEvents.find((event) => event.type === "caption" && event.language === "en");
  assert.equal(polishCalls.at(-1).sourceText, "안녕하세요");
  assert.equal(persisted.sourceText, "안녕하세요");
  assert.equal(persisted.sourceLanguage, "ko");
  const source = state.events.find((event) => event.type === "caption" && event.origin === "source");
  assert.equal(persisted.utteranceKey, source.utteranceKey);
  assert.deepEqual(mirrored, persisted);
});

test("a later input partial cannot steal an earlier final's source correlation", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-source-fifo",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko", "en"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  const input = state.liveSessions[0].onInputCaption;
  await input({ text: "첫 번째 문장", isFinal: true, languageCode: "ko-KR" });
  await input({ text: "두 번째 진행 중", isFinal: false, languageCode: "ko-KR" });
  const enSession = state.liveSessions.find((session) => session.language === "en");
  await enSession.onCaption({ text: "The first sentence.", isFinal: true });
  const translated = state.events.find((event) => event.type === "caption" && event.language === "en");
  assert.equal(translated.sourceText, "첫 번째 문장");
  assert.match(translated.utteranceKey, /:input:1$/u);
});

test("an explicit provider identity resynchronizes after a missing translated final", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-source-resync", sessionType: "meeting", outputMode: "captions",
    languages: ["ko", "en"], dependencies: state.dependencies,
  });
  await pipeline.start();
  const input = state.liveSessions[0].onInputCaption;
  await input({ text: "첫 번째 원문", isFinal: true, languageCode: "ko-KR", utteranceKey: "gemini:ko:1:1" });
  await input({ text: "두 번째 원문", isFinal: true, languageCode: "ko-KR", utteranceKey: "gemini:ko:1:2" });
  const enSession = state.liveSessions.find((session) => session.language === "en");
  await enSession.onCaption({
    text: "The second source.", isFinal: true, sourceText: "두 번째 원문",
    sourceLanguage: "ko", utteranceKey: "gemini:en:1:2",
  });
  const translated = state.events.find((event) => event.type === "caption" && event.language === "en");
  assert.equal(translated.sourceText, "두 번째 원문");
  assert.equal(translated.utteranceKey, "gemini:ko:1:2");
  await input({ text: "세 번째 원문", isFinal: true, languageCode: "ko-KR", utteranceKey: "gemini:ko:1:3" });
  await enSession.onCaption({ text: "The third source.", isFinal: true });
  const translatedFinals = state.events.filter((event) => event.type === "caption" && event.language === "en");
  assert.equal(translatedFinals[1].sourceText, "세 번째 원문");
  assert.equal(translatedFinals[1].utteranceKey, "gemini:ko:1:3");
});

test("lane-local identity preserves repeated sentences while skipping a missing translation", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-source-repeat-resync", sessionType: "meeting", outputMode: "captions",
    languages: ["ko", "en"], dependencies: state.dependencies,
  });
  await pipeline.start();
  const input = state.liveSessions[0].onInputCaption;
  await input({ text: "네", isFinal: true, languageCode: "ko-KR", utteranceKey: "gemini:ko:4:1" });
  await input({ text: "네", isFinal: true, languageCode: "ko-KR", utteranceKey: "gemini:ko:4:2" });
  const enSession = state.liveSessions.find((session) => session.language === "en");
  await enSession.onCaption({
    text: "Yes.", isFinal: true, sourceText: "네", sourceLanguage: "ko",
    utteranceKey: "gemini:en:4:2",
  });
  const translated = state.events.find((event) => event.type === "caption" && event.language === "en");
  assert.equal(translated.sourceText, "네");
  assert.equal(translated.utteranceKey, "gemini:ko:4:2");

  await input({ text: "다음 문장", isFinal: true, languageCode: "ko-KR", utteranceKey: "gemini:ko:4:3" });
  await enSession.onCaption({ text: "The next sentence.", isFinal: true });
  const translatedFinals = state.events.filter((event) => event.type === "caption" && event.language === "en");
  assert.equal(translatedFinals[1].sourceText, "다음 문장");
  assert.equal(translatedFinals[1].utteranceKey, "gemini:ko:4:3");
});

test("an equal lane-local coordinate cannot steal a differently worded canonical source", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-coordinate-collision", sessionType: "meeting", outputMode: "captions",
    languages: ["ko", "en"], dependencies: state.dependencies,
  });
  await pipeline.start();
  const input = state.liveSessions[0].onInputCaption;
  await input({ text: "첫 번째 원문", isFinal: true, languageCode: "ko-KR", utteranceKey: "gemini:ko:2:1" });
  const enSession = state.liveSessions.find((session) => session.language === "en");
  await enSession.onCaption({
    text: "Different speech.", isFinal: true, sourceText: "서로 다른 발화", sourceLanguage: "ko",
    utteranceKey: "gemini:en:2:1",
  });
  const firstTranslation = state.events.find((event) => event.type === "caption" && event.language === "en");
  assert.equal(firstTranslation.sourceText, "서로 다른 발화");
  assert.equal(firstTranslation.utteranceKey, "gemini:en:2:1");

  await input({ text: "두 번째 원문", isFinal: true, languageCode: "ko-KR", utteranceKey: "gemini:ko:2:2" });
  await enSession.onCaption({
    text: "The second source.", isFinal: true, sourceText: "두 번째 원문", sourceLanguage: "ko",
    utteranceKey: "gemini:en:2:2",
  });
  const translations = state.events.filter((event) => event.type === "caption" && event.language === "en");
  assert.equal(translations[1].sourceText, "두 번째 원문");
  assert.equal(translations[1].utteranceKey, "gemini:ko:2:2");
});

test("Gemini callback metadata preserves capture-time floor identity across a handoff", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-floor-capture", sessionType: "meeting", outputMode: "captions",
    languages: ["ko"], dependencies: state.dependencies, now: () => 1_000,
  });
  await pipeline.start();
  pipeline.setFloorSpeaker({ participantId: "A", displayName: "발표자A" });
  await pipeline.acceptAudio(new Uint8Array(1_280), 1_000);
  pipeline.setFloorSpeaker({ participantId: "B", displayName: "발표자B" });
  await pipeline.acceptAudio(new Uint8Array(1_280), 1_001);
  const firstCapture = state.liveSessions[0].sent[0].metadata;
  assert.equal(firstCapture.floorSpeaker.participantId, "A");
  await state.liveSessions[0].onInputCaption({
    text: "늦게 확정된 A 발언", isFinal: true, languageCode: "ko-KR",
    utteranceKey: "turn:A", capturedAt: firstCapture.capturedAt, floorSpeaker: firstCapture.floorSpeaker,
  });
  const final = state.events.find((event) => event.type === "caption" && event.isFinal);
  assert.equal(final.speaker.speakerId, "participant:A");
});

test("participant stop before a late final preserves identity and source provenance on both lanes", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-participant-late-final", sessionType: "meeting", outputMode: "captions",
    languages: ["ko", "en"], dependencies: state.dependencies, now: () => 1_000,
  });
  await pipeline.start();
  const participant = {
    participantId: "participant-77",
    displayName: "참가자 77",
    department: "Advisory",
    jobTitle: "Manager",
  };
  pipeline.setFloorSpeaker(participant);
  const queuedAudio = pipeline.acceptAudio(new Uint8Array(1_280), 1_000, participant);
  pipeline.setFloorSpeaker(null);
  await queuedAudio;

  const [koreanSession, englishSession] = state.liveSessions;
  const captured = koreanSession.sent[0].metadata;
  await koreanSession.onInputCaption({
    text: "참가자가 늦게 확정한 문장입니다", isFinal: true, languageCode: "ko-KR",
    utteranceKey: "participant-turn-1", ...captured,
  });
  await englishSession.onCaption({
    text: "This participant sentence finalized late.", isFinal: true,
    sourceText: "참가자가 늦게 확정한 문장입니다", sourceLanguage: "ko",
    utteranceKey: "participant-turn-1", ...captured,
  });

  const finals = state.events.filter((event) => event.type === "caption" && event.isFinal);
  assert.equal(finals.length, 2);
  const byLanguage = new Map(finals.map((event) => [event.language, event]));
  for (const language of ["ko", "en"]) {
    const event = byLanguage.get(language);
    assert.equal(event.speaker.speakerId, "participant:participant-77");
    assert.equal(event.sourceLanguage, "ko");
    assert.equal(event.utteranceKey, "participant-turn-1");
  }
  assert.equal(byLanguage.get("ko").origin, "source");
  assert.equal(byLanguage.get("ko").sourceText, null);
  assert.equal(byLanguage.get("en").sourceText, "참가자가 늦게 확정한 문장입니다");
});

test("actual Gemini path keeps late A final but does not attribute new host speech to released A", async () => {
  const state = makeDependencies();
  const events = [];
  let messageHandler;
  let clock = 1_000;
  state.dependencies.liveTranslate = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  state.dependencies.publisher.publish = async (_sessionId, language, event) => events.push({ ...event, language });
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-floor-release-host", sessionType: "meeting", outputMode: "captions",
    languages: ["en"], dependencies: state.dependencies, now: () => clock,
  });
  await pipeline.start();
  pipeline.setFloorSpeaker({ participantId: "A", displayName: "발표자A" });
  await pipeline.acceptAudio(new Uint8Array(1_280), 1_000);
  clock = 2_000;
  pipeline.setFloorSpeaker(null);
  clock = 2_100;
  await pipeline.acceptAudio(new Uint8Array(1_280), 2_100);
  messageHandler({ serverContent: {
    inputTranscription: { text: "A의 늦은 원문", languageCode: "ko-KR" },
    outputTranscription: { text: "Late words from A" }, turnComplete: true,
  } });
  messageHandler({ serverContent: {
    inputTranscription: { text: "호스트 새 발언", languageCode: "ko-KR" },
    outputTranscription: { text: "New host speech" }, turnComplete: true,
  } });
  for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  const finals = events.filter((event) => event.type === "caption" && event.isFinal);
  assert.equal(finals[0].speaker?.speakerId, "participant:A");
  assert.equal(finals[1].speaker, null);
  await pipeline.close();
});

test("distinct input identities preserve rapid repeated final captions", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-repeat-identity", sessionType: "meeting", outputMode: "captions",
    languages: ["ko"], dependencies: state.dependencies,
  });
  await pipeline.start();
  const session = state.liveSessions[0];
  await session.onInputCaption({ text: "네", isFinal: true, languageCode: "ko-KR" });
  await session.onInputCaption({ text: "네", isFinal: true, languageCode: "ko-KR" });
  const finals = state.events.filter((event) => event.type === "caption" && event.isFinal && event.origin === "source");
  assert.equal(finals.length, 2);
  assert.notEqual(finals[0].utteranceKey, finals[1].utteranceKey);
});

// The p95 committed-caption target is unmeasurable without this: latency was
// only ever observed on #processFinalUtterance, which no session type reaches.
test("the live caption path reports publish and polish latency", async () => {
  const state = makeDependencies();
  const observed = [];
  let clock = 0;
  state.dependencies.captionPolish = {
    async polish({ translatedText }) { clock += 400; return translatedText; },
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-latency",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko"],
    dependencies: state.dependencies,
    now: () => clock,
    observeLatency: (name, value) => observed.push([name, value]),
  });
  await pipeline.start();

  await state.liveSessions[0].onCaption({ text: "확정된 문장입니다.", isFinal: false });
  assert.equal(observed.length, 0, "interim captions carry no committed-latency target");

  await state.liveSessions[0].onCaption({ text: "확정된 문장입니다.", isFinal: true });
  const names = observed.map(([name]) => name);
  assert.ok(names.includes("caption_publish_latency_ms"), `missing publish latency: ${names.join(",")}`);
  assert.ok(names.includes("caption_polish_latency_ms"), `missing polish latency: ${names.join(",")}`);
  // Polish is separable from total, so a slow second pass is distinguishable
  // from a slow provider.
  const polish = observed.find(([name]) => name === "caption_polish_latency_ms")[1];
  assert.equal(polish, 400);
  assert.ok(observed.every(([, value]) => Number.isFinite(value) && value >= 0));
});
