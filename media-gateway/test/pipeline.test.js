import assert from "node:assert/strict";
import test from "node:test";

import { LiveMediaPipeline } from "../src/live-media-pipeline.js";

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
        async open({ language, onCaption, onAudio, onInterruption }) {
          const session = { language, onCaption, onAudio, onInterruption, sent: [], ended: 0, async sendAudio(frame) { this.sent.push(frame); }, async audioStreamEnd() { this.ended += 1; }, async close() {} };
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
      textTranslate: { async translate({ text, language, glossaryPack }) { translated.push([text, language, glossaryPack]); return `${language}:${text}`; } },
      textToSpeech: {
        async *synthesizeStream(input) {
          synthesized.push(input);
          yield new Uint8Array(6_000);
          yield new Uint8Array(6_000);
        },
      },
      publisher: {
        async publish(_sessionId, _language, event) { events.push(event); },
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
  await state.liveSessions[0].onCaption({ text: "안녕하세요", isFinal: true });
  await state.liveSessions[0].onCaption({ text: "안녕하세요", isFinal: true });
  const captions = state.events.filter((event) => event.type === "caption");
  assert.deepEqual(captions.map((event) => [event.text, event.isFinal]), [
    ["안녕", false],
    ["안녕하세요", false],
    ["안녕하세요", true],
  ]);
  assert.deepEqual(captions.map((event) => event.seq), [1, 2, 3]);
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
    ["en", "speaker-1", "en:hello"],
    ["ja", "speaker-1", "ja:hello"],
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
    return `${language}:${text}`;
  };
  const pipeline = new LiveMediaPipeline({ sessionId: "s-language-isolation", mode: "meeting", languages: ["en", "ja"], dependencies: state.dependencies });
  await pipeline.start();
  const first = pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "one", sourceEndedAt: "2026-07-19T00:00:00.000Z" });
  const second = pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "two", sourceEndedAt: "2026-07-19T00:00:01.000Z" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    state.events.filter((event) => event.type === "caption" && event.language === "en").map((event) => event.text),
    ["en:one", "en:two"],
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
  assert.equal(caption.text, "ko:caption only");
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
  assert.deepEqual(state.synthesized.map((input) => input.text), ["ko:one"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(state.synthesized.map((input) => input.text), ["ko:one", "ko:two"]);
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
    initialSequence: meeting.lastSequence,
  });
  await townhall.start();
  await townhall.acceptFinalUtterance({ speakerLabel: "A", text: "two", sourceEndedAt: "2026-07-19T00:00:01.000Z" });
  const after = townhall.speakers.getOrCreate("A");
  assert.equal(after.speakerId, before.speakerId);
  assert.equal(after.colorToken, before.colorToken);
  assert.equal(after.voiceName, "Achernar");
  assert.equal(townhallState.synthesized[0].voiceName, "Achernar");
  const townhallAudio = townhallState.events.find((event) => event.header?.type === "audio-chunk");
  assert.ok(townhallAudio.header.seq > meeting.lastSequence, "hot-swap sequence must remain monotonic");
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
  assert.deepEqual(state.synthesized.map((input) => input.text), ["ko:one", "ko:late", "ko:three"]);
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

function tonePcm(frequency, milliseconds) {
  const sampleCount = Math.round(16_000 * milliseconds / 1_000);
  const bytes = new Uint8Array(sampleCount * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < sampleCount; index += 1) {
    view.setInt16(index * 2, Math.round(Math.sin(2 * Math.PI * frequency * index / 16_000) * 14_000), true);
  }
  return bytes;
}
