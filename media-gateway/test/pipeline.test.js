import assert from "node:assert/strict";
import test from "node:test";

import { GeminiLiveTranslateAdapter } from "../src/google-provider-adapters.js";
import { LiveMediaPipeline } from "../src/live-media-pipeline.js";
import { SupabaseLivePublisher } from "../src/supabase-adapters.js";

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
        async open({ language, inputSource, channelId, onCaption, onAudio, onInterruption, onInputCaption, onInputObservation }) {
          const session = { language, inputSource, channelId, onCaption, onAudio, onInterruption, onInputCaption, onInputObservation, sent: [], ended: 0, async sendAudio(frame, metadata) { this.sent.push({ frame, metadata }); }, async audioStreamEnd() { this.ended += 1; }, async close() {} };
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

test("presentation opens one provider session per language, not per viewer", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s1", mode: "presentation", languages: ["en", "ko"], dependencies: state.dependencies, now: () => 0 });
  await pipeline.start();
  await pipeline.acceptAudio(new Uint8Array(1_280), 0);
  assert.equal(state.liveSessions.length, 2);
  assert.deepEqual(state.liveSessions.map((session) => session.sent.length), [1, 1]);
});
test("meeting reports input observations from every target lane while publishing one canonical source lane", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-consensus", mode: "meeting", languages: ["ko", "en"], dependencies: state.dependencies });
  await pipeline.start();

  assert.ok(state.liveSessions.every((session) => typeof session.onInputObservation === "function"));
  await state.liveSessions[1].onInputObservation({ text: "안녕하세요.", isFinal: true, languageCode: "ko-KR" });
  await state.liveSessions[0].onInputObservation({ text: "안녕하세요.", isFinal: true, languageCode: "ko-KR" });
  await state.liveSessions[0].onInputCaption({ text: "안녕하세요.", isFinal: true, languageCode: "ko-KR" });

  const sources = state.events.filter((event) => event.type === "caption" && event.origin === "source");
  assert.equal(sources.length, 1);
  assert.equal(sources[0].language, "ko");
});

test("a blocked target audio lane cannot delay another target lane", async () => {
  const state = makeDependencies();
  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  state.dependencies.liveTranslate.open = async (options) => {
    const isSlow = options.language === "ko";
    const session = {
      ...options,
      sent: 0,
      async sendAudio() { this.sent += 1; if (isSlow) await slowGate; },
      async audioStreamEnd() {},
      async close() {},
    };
    state.liveSessions.push(session);
    return session;
  };
  const pipeline = new LiveMediaPipeline({ sessionId: "s-audio-isolation", mode: "meeting", languages: ["ko", "en"], dependencies: state.dependencies, now: () => 1_000 });
  await pipeline.start();

  await pipeline.acceptAudio(new Uint8Array(1_280), 1_000);
  await pipeline.acceptAudio(new Uint8Array(1_280), 1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.liveSessions.find((session) => session.language === "en").sent, 2);
  releaseSlow();
  await pipeline.close();
});

test("a five-second provider reconnect preserves the bounded audio backlog without permanently removing the caption lane", async () => {
  const state = makeDependencies();
  const clock = makeManualClock(1_000);
  const observations = [];
  const fatalErrors = [];
  let releaseReconnect;
  const reconnectGate = new Promise((resolve) => { releaseReconnect = resolve; });
  let openCount = 0;
  state.dependencies.liveTranslate.open = async (options) => {
    openCount += 1;
    const session = {
      ...options,
      sent: 0,
      async sendAudio() {
        this.sent += 1;
        if (this.sent === 1) await reconnectGate;
      },
      async audioStreamEnd() {},
      async close() {},
    };
    state.liveSessions.push(session);
    return session;
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-five-second-reconnect",
    mode: "meeting",
    languages: ["ko"],
    dependencies: state.dependencies,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    observeLatency: (name, value) => observations.push([name, value]),
    onFatalError: (error) => fatalErrors.push(error),
  });
  await pipeline.start();

  const frame = new Uint8Array(1_280);
  for (let index = 0; index < 126; index += 1) {
    await pipeline.acceptAudio(frame, clock.now());
  }
  const advance = clock.advance(5_000);
  releaseReconnect();
  await advance;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(openCount, 1, "an in-session reconnect must not force a manual pipeline replacement");
  assert.equal(fatalErrors.length, 0, "a reconnect inside the provider's documented 5s backoff is transient");
  assert.equal(state.liveSessions[0].sent, 126, "the bounded reconnect backlog must drain in capture order");
  assert.equal(
    observations.some(([name]) => name === "caption_audio_lane_frames_dropped_total"),
    false,
    "a normal 5s provider reconnect must not discard the speaker's sentence",
  );

  await pipeline.acceptAudio(frame, clock.now());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.liveSessions[0].sent, 127, "the original caption lane remains writable after reconnect");
  await pipeline.close();
});

test("a virtual two-hour host and participant call survives repeated reconnect windows with dense bilingual seq", async () => {
  const state = makeDependencies();
  const startedAt = Date.parse("2026-07-27T00:00:00.000Z");
  const clock = makeManualClock(startedAt);
  const observations = [];
  const fatalErrors = [];
  let reconnectWindows = 0;
  state.dependencies.liveTranslate.open = async (options) => {
    const session = {
      ...options,
      sent: 0,
      async sendAudio() {
        this.sent += 1;
        if (this.sent % 300 !== 0) return;
        reconnectWindows += 1;
        await new Promise((resolve) => clock.setTimeoutFn(resolve, 5_000));
      },
      async audioStreamEnd() {},
      async close() {},
    };
    state.liveSessions.push(session);
    return session;
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-two-hour-soak",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko", "en"],
    dependencies: state.dependencies,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    observeLatency: (name, value) => observations.push([name, value]),
    onFatalError: (error) => fatalErrors.push(error),
  });
  await pipeline.start();

  const frame = new Uint8Array(1_280);
  let isParticipant = false;
  for (let elapsedSeconds = 0; elapsedSeconds < 2 * 60 * 60; elapsedSeconds += 1) {
    const nextIsParticipant = Math.floor(elapsedSeconds / 30) % 2 === 1;
    if (nextIsParticipant !== isParticipant) {
      isParticipant = nextIsParticipant;
      pipeline.setFloorSpeaker(isParticipant
        ? { participantId: "participant-soak", displayName: "Soak Participant", department: "", jobTitle: "" }
        : null);
    }
    await pipeline.acceptAudio(
      frame,
      clock.now(),
      isParticipant
        ? { participantId: "participant-soak", displayName: "Soak Participant", department: "", jobTitle: "" }
        : null,
      isParticipant ? "participant" : "system",
    );
    if (elapsedSeconds % 60 === 0) {
      const speaksKorean = Math.floor(elapsedSeconds / 60) % 2 === 1;
      await pipeline.acceptFinalUtterance({
        speakerLabel: isParticipant ? "participant-soak" : "host-soak",
        text: speaksKorean ? `한국어 문장 ${elapsedSeconds}입니다.` : `English sentence ${elapsedSeconds}.`,
        sourceLanguage: speaksKorean ? "ko-KR" : "en-US",
        sourceEndedAt: new Date(clock.now()).toISOString(),
      });
    }
    await clock.advance(1_000);
  }
  await clock.advance(10_000);
  await pipeline.close();

  assert.ok(clock.now() - startedAt > 2 * 60 * 60 * 1_000, "the accelerated soak must cross two full hours");
  assert.ok(reconnectWindows >= 40, "the soak must exercise repeated provider reconnects across both sources and lanes");
  assert.equal(fatalErrors.length, 0, "no transient provider reconnect may require manual refresh");
  assert.deepEqual(pipeline.lastSequences, { ko: 120, en: 120 });
  for (const language of ["ko", "en"]) {
    assert.deepEqual(
      state.events
        .filter((event) => event.type === "caption" && event.isFinal && event.language === language)
        .map((event) => event.seq),
      Array.from({ length: 120 }, (_, index) => index + 1),
      `${language} durable caption seq must stay gap-free through the full soak`,
    );
  }
  assert.equal(
    observations.some(([name]) => name.endsWith("audio_lane_frames_dropped_total")),
    false,
    "bounded 5s reconnects must not lose host or participant audio",
  );
});

test("a provider write stuck beyond the recovery window escalates once with observable timeout metrics", async () => {
  const state = makeDependencies();
  const clock = makeManualClock(1_000);
  const observations = [];
  const fatalErrors = [];
  state.dependencies.liveTranslate.open = async (options) => {
    const session = {
      ...options,
      async sendAudio() { await new Promise(() => {}); },
      async audioStreamEnd() {},
      async close() { await new Promise(() => {}); },
    };
    state.liveSessions.push(session);
    return session;
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-bounded-stuck-write",
    mode: "meeting",
    languages: ["ko"],
    dependencies: state.dependencies,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    observeLatency: (name, value) => observations.push([name, value]),
    onFatalError: (error) => fatalErrors.push(error),
  });
  await pipeline.start();
  await pipeline.acceptAudio(new Uint8Array(1_280), clock.now());
  await clock.advance(10_001);

  assert.deepEqual(fatalErrors.map((error) => error.message), ["AUDIO_LANE_TIMEOUT"]);
  assert.ok(observations.some(([name, value]) => name === "caption_audio_lane_failures_total" && value === 1));
  assert.ok(observations.some(([name, value]) => name === "caption_audio_lane_timeouts_total" && value === 1));
  await pipeline.close();
});

test("a blocked system source lane cannot delay or receive mic source audio", async () => {
  const state = makeDependencies();
  let releaseSystem;
  const systemGate = new Promise((resolve) => { releaseSystem = resolve; });
  state.dependencies.liveTranslate.open = async (options) => {
    const session = {
      ...options, sent: [],
      async sendAudio(frame, metadata) { this.sent.push({ frame, metadata }); if (options.inputSource === "system") await systemGate; },
      async audioStreamEnd() {}, async close() {},
    };
    state.liveSessions.push(session);
    return session;
  };
  const pipeline = new LiveMediaPipeline({ sessionId: "s-source-isolation", mode: "meeting", languages: ["ko"], dependencies: state.dependencies, now: () => 1_000 });
  await pipeline.start();
  await pipeline.acceptAudio(new Uint8Array(1_280).fill(1), 1_000, null, "system");
  await pipeline.acceptAudio(new Uint8Array(1_280).fill(2), 1_000, null, "mic");
  await new Promise((resolve) => setImmediate(resolve));
  const mic = state.liveSessions.find((session) => session.inputSource === "mic");
  assert.equal(mic.sent.length, 1);
  assert.equal(mic.sent[0].metadata.source, "mic");
  assert.equal(mic.sent[0].frame[0], 2);
  releaseSystem();
  await pipeline.close();
});

test("system and mic copies of one utterance produce one source row and one translated row", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-source-dedupe", mode: "meeting", languages: ["ko"], dependencies: state.dependencies, now: () => 1_000 });
  await pipeline.start();
  await pipeline.acceptAudio(new Uint8Array(1_280), 1_000, null, "mic");
  const system = state.liveSessions.find((session) => session.inputSource === "system");
  const mic = state.liveSessions.find((session) => session.inputSource === "mic");
  for (const session of [system, mic]) {
    const input = { text: "This is the same source sentence.", isFinal: true, languageCode: "en-US", targetLanguage: "ko", inputSource: session.inputSource };
    await session.onInputObservation(input);
    await session.onInputCaption(input);
    await session.onCaption({ text: "동일한 번역 문장입니다.", isFinal: true, sourceText: input.text, sourceLanguage: "en-US", inputSource: session.inputSource });
  }
  const finals = state.events.filter((event) => event.type === "caption" && event.isFinal);
  assert.equal(finals.filter((event) => event.origin === "source").length, 0, "an absent EN record lane stays absent");
  assert.equal(finals.filter((event) => event.language === "ko").length, 1);
});

test("duplicate-source suppression stays hard-bounded during a long meeting", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({ sessionId: "s-source-dedupe-bound", mode: "meeting", languages: ["ko"], dependencies: state.dependencies, now: () => 1_000 });
  await pipeline.start();
  await pipeline.acceptAudio(new Uint8Array(1_280), 1_000, null, "mic");
  const system = state.liveSessions.find((session) => session.inputSource === "system");
  const mic = state.liveSessions.find((session) => session.inputSource === "mic");
  for (let index = 0; index < 300; index += 1) {
    const text = `Unique duplicated source sentence number ${index}.`;
    await system.onInputObservation({ text, isFinal: true, languageCode: "en-US" });
    await mic.onInputObservation({ text, isFinal: true, languageCode: "en-US" });
  }
  await mic.onCaption({ text: "첫 번째 오래된 번역입니다.", isFinal: true, sourceText: "Unique duplicated source sentence number 0.", sourceLanguage: "en-US" });
  await mic.onCaption({ text: "최신 중복 번역입니다.", isFinal: true, sourceText: "Unique duplicated source sentence number 299.", sourceLanguage: "en-US" });
  const finals = state.events.filter((event) => event.type === "caption" && event.isFinal);
  assert.equal(finals.length, 1, "oldest suppression entry is evicted while the newest remains suppressed");
  assert.equal(finals[0].text, "첫 번째 오래된 번역입니다.");
});

test("caption polish policy supports off, selective, and full modes", async () => {
  for (const [policy, expectedCalls] of [["off", 0], ["selective", 0], ["full", 1]]) {
    const state = makeDependencies();
    let calls = 0;
    state.dependencies.captionPolish = { async polish({ translatedText }) { calls += 1; return translatedText; } };
    const pipeline = new LiveMediaPipeline({
      sessionId: `s-polish-${policy}`, mode: "meeting", languages: ["ko"], dependencies: state.dependencies,
      captionPolishPolicy: policy,
    });
    await pipeline.start();
    await state.liveSessions[0].onCaption({ text: "일반 번역 문장입니다.", isFinal: true });
    assert.equal(calls, expectedCalls, policy);
    await pipeline.close();
  }
});

test("Presentation normalizes a stale OpenAI voice setting and uses Gemini for captions and translated audio", async () => {
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
  assert.equal(state.openaiVoiceSessions.length, 0);
  assert.equal(state.speechSessions.length, 0);

  await state.liveSessions[0].onCaption({ text: "Gemini caption", isFinal: true });
  await state.liveSessions[0].onAudio({ sampleRate: 24_000, pcm: new Uint8Array([1, 0]) });
  await pipeline.acceptAudio(new Uint8Array(1_280), 1_000);

  assert.equal(state.events.filter((event) => event.type === "caption").length, 1);
  assert.deepEqual(state.events.filter((event) => event.header?.type === "audio-chunk").map((event) => [...event.pcm]), [[1, 0]]);
  assert.equal(state.liveSessions[0].sent.length, 1);
});

test("Presentation cancels rapid partial snapshots when their ordered final arrives", async () => {
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
    ["안녕하세요", true],
  ]);
  // The final supersedes every not-yet-visible revision and remains the first
  // durable sequence in the lane.
  assert.deepEqual(captions.map((event) => event.seq), [1]);
  assert.deepEqual(captions.filter((event) => event.isFinal).map((event) => event.seq), [1]);
});

test("Live Call emits only the latest rapid revision within the captions-only 500 ms hold", async () => {
  const state = makeDependencies();
  const clock = makeManualClock(1_000);
  const pipeline = new LiveMediaPipeline({
    sessionId: "partial-stability",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["en"],
    dependencies: state.dependencies,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  await pipeline.start();
  const session = state.liveSessions[0];

  await session.onCaption({ text: "The first growing revision", isFinal: false });
  await clock.advance(139);
  await session.onCaption({ text: "The second growing revision", isFinal: false });
  await clock.advance(140);
  await session.onCaption({ text: "The latest stable revision", isFinal: false });
  await clock.advance(221);

  const partials = state.events.filter((event) => event.type === "caption" && !event.isFinal);
  assert.deepEqual(partials.map((event) => event.text), ["The latest stable revision"]);
  await pipeline.close();
});

test("an undersized partial expires without a zero-delay timer loop", async () => {
  const state = makeDependencies();
  const clock = makeManualClock(1_000);
  const pipeline = new LiveMediaPipeline({
    sessionId: "short-partial-deadline",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["en"],
    dependencies: state.dependencies,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  await pipeline.start();
  await state.liveSessions[0].onCaption({ text: "Tiny", isFinal: false });
  const callbackCount = await clock.advance(1_000);
  assert.ok(callbackCount <= 4, `short hold armed ${callbackCount} callbacks`);
  assert.equal(clock.pendingCount, 0);
  assert.equal(state.events.some((event) => event.type === "caption"), false);
  await pipeline.close();
});

test("a stalled partial publisher keeps only one active publication and one latest revision", async () => {
  const state = makeDependencies();
  const published = [];
  const releases = [];
  let active = 0;
  let maximumActive = 0;
  state.dependencies.publisher.publish = async (_sessionId, _language, event, { onLiveEvent } = {}) => {
    if (event.type !== "caption") return;
    published.push(event.text);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await onLiveEvent?.(event);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "partial-backpressure",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["en"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  const session = state.liveSessions[0];

  await session.onCaption({ text: "First complete-looking partial.", isFinal: false });
  await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < 50; index += 1) {
    await session.onCaption({ text: `Latest revision number ${index}.`, isFinal: false });
  }
  assert.deepEqual(published, ["First complete-looking partial."]);
  assert.equal(maximumActive, 1);

  releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published, ["First complete-looking partial.", "Latest revision number 49."]);
  assert.equal(maximumActive, 1);
  releases.shift()?.();
  await pipeline.close();
});

test("a final waits behind an active partial and cancels every queued revision", async () => {
  const state = makeDependencies();
  const published = [];
  let releasePartial;
  state.dependencies.publisher.publish = async (_sessionId, _language, event, { onLiveEvent } = {}) => {
    await onLiveEvent?.(event);
    if (event.type !== "caption") return;
    if (event.type === "caption" && !event.isFinal) {
      await new Promise((resolve) => { releasePartial = resolve; });
    }
    published.push([event.text, event.isFinal]);
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "partial-final-order",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["en"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  const session = state.liveSessions[0];
  await session.onCaption({ text: "Visible partial sentence.", isFinal: false });
  await new Promise((resolve) => setImmediate(resolve));
  await session.onCaption({ text: "Queued revision sentence.", isFinal: false });
  const finalPublication = session.onCaption({ text: "Final sentence.", isFinal: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published, []);
  releasePartial?.();
  await finalPublication;
  assert.deepEqual(published, [
    ["Visible partial sentence.", false],
    ["Final sentence.", true],
  ]);
  await pipeline.close();
});

test("floor changes and stop cancel pending stabilized partials", async () => {
  for (const action of ["floor", "stop"]) {
    const state = makeDependencies();
    const clock = makeManualClock(1_000);
    const pipeline = new LiveMediaPipeline({
      sessionId: `partial-cancel-${action}`,
      sessionType: "meeting",
      outputMode: "captions",
      languages: ["en"],
      dependencies: state.dependencies,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    await pipeline.start();
    await state.liveSessions[0].onCaption({ text: "Pending long-enough revision", isFinal: false });
    if (action === "floor") pipeline.setFloorSpeaker({ participantId: "next", displayName: "다음 화자" });
    else await pipeline.close();
    await clock.advance(1_000);
    assert.equal(state.events.some((event) => event.type === "caption"), false);
    assert.equal(clock.pendingCount, 0);
    if (action === "floor") await pipeline.close();
  }
});

test("Presentation never opens the retired OpenAI live-translation voice lane", async () => {
  const state = makeDependencies();
  let openaiOpenCalls = 0;
  state.dependencies.openaiLiveTranslate.open = async ({ language, onAudio }) => {
    openaiOpenCalls += 1;
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
  await state.liveSessions[0].onAudio({ sampleRate: 24_000, pcm: new Uint8Array([2, 0]) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(openaiOpenCalls, 0);
  assert.equal(state.events.some((event) => event.type === "caption" && event.text === "captions survive"), true);
  assert.equal(state.events.some((event) => event.type === "language-status" && event.code === "VOICE_UNAVAILABLE"), false);
  assert.equal(state.events.some((event) => event.header?.type === "audio-chunk"), true);
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
  const englishAudioLane = state.liveSessions.find((session) => session.language === "en");
  await englishAudioLane.onAudio({ sampleRate: 24_000, pcm: new Uint8Array([1, 0]) });
  await pipeline.acceptFinalUtterance({ speakerLabel: "A", text: "two", sourceEndedAt: "2026-07-19T00:00:01.000Z" });

  const captions = state.events.filter((event) => event.type === "caption");
  assert.deepEqual(captions.filter((event) => event.language === "en").map((event) => event.seq), [1, 2]);
  assert.deepEqual(captions.filter((event) => event.language === "ja").map((event) => event.seq), [1, 2]);
  // Audio chunks were interleaved between captions but the caption lanes above
  // stayed dense: the audio events run on their own transient counter.
  assert.equal(state.events.filter((event) => event.header?.type === "audio-chunk").length, 1);
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
  // Without this the trailing interim leaves a 140ms partial-debounce timer
  // armed, and the whole test FILE never exits — the gateway suite hung
  // instead of reporting.
  await pipeline.close();
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
  assert.equal(captions[0].text, "en:translated 참가자 발언입니다");
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
      await state.liveSessions[0].onCaption({ text: `u${utterance} step ${step}.`, isFinal: false });
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
  pipeline.setFloorSpeaker({
    participantId: "p1",
    displayName: "김참가",
    department: "호텔팀",
    jobTitle: "Director",
  });
  await enSession.onCaption({ text: "Hello from the floor, everyone", isFinal: true });
  const captions = state.events.filter((event) => event.type === "caption" && event.language === "en");
  assert.equal(captions.length, 1, "the pending host partial is cancelled at the floor boundary");
  assert.equal(captions.at(-1).speaker?.name, "김참가");
  assert.equal(captions.at(-1).speaker?.isParticipant, true);
  assert.equal(captions.at(-1).speakerRole, "participant");
  assert.equal(captions.at(-1).speakerName, "김참가");
  assert.equal(captions.at(-1).speakerDepartment, "호텔팀");
  assert.equal(captions.at(-1).speakerJobTitle, "Director");
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
    ["안녕하세요 여러분 반갑습니다", true],
  ]);
  assert.equal(koCaptions[0].speakerRole, "host");
  assert.equal(koCaptions[0].speakerName, "Host");
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

test("meeting audio output reuses Gemini caption sessions and never opens OpenAI live translation", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-live-voice",
    sessionType: "meeting",
    outputMode: "captions_audio",
    languages: ["ko"],
    dependencies: state.dependencies,
  });
  await pipeline.start();
  assert.equal(state.openaiVoiceSessions.length, 0);
  await state.liveSessions[0].onAudio({ sampleRate: 24_000, pcm: new Uint8Array([1, 0]) });
  assert.equal(state.events.filter((event) => event.header?.type === "audio-chunk").length, 1);
  assert.deepEqual(state.events.find((event) => event.header?.type === "audio-chunk").pcm, new Uint8Array([1, 0]));
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

test("desktop host mirror follows the publisher durable live-event boundary", async () => {
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
    await persistenceGate;
    await onLiveEvent?.(event);
  };
  const publishing = state.liveSessions[0].onCaption({ text: "내구성 이후 미러", isFinal: true, utteranceKey: "turn-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hostEvents.some((event) => event.text === "내구성 이후 미러"), false);
  releasePersistence();
  await publishing;
  assert.equal(hostEvents.some((event) => event.text === "내구성 이후 미러"), true);
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
    captionPolishPolicy: "full",
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
    captionPolishPolicy: "full",
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

test("meeting keeps bilingual records but mirrors only translated captions to the desktop", async () => {
  const state = makeDependencies();
  const hostEvents = [];
  const polishCalls = [];
  state.dependencies.captionPolish = {
    async polish(input) {
      polishCalls.push(input);
      return input.translatedText;
    },
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-screen-translation-only",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["en", "ko"],
    captionPolishPolicy: "full",
    dependencies: state.dependencies,
    onHostEvent: (event) => hostEvents.push(event),
  });
  await pipeline.start();
  const inputSession = state.liveSessions[0];
  const koreanSession = state.liveSessions.find((session) => session.language === "ko");

  await inputSession.onInputCaption({
    text: "This source belongs only in the bilingual web record.",
    isFinal: true,
    languageCode: "en-US",
    utteranceKey: "turn-1",
  });
  await koreanSession.onCaption({
    text: "이 원문은 이중 언어 웹 기록에만 포함됩니다.",
    isFinal: true,
    sourceText: "This source belongs only in the bilingual web record.",
    sourceLanguage: "en-US",
    utteranceKey: "turn-1",
  });

  const persisted = state.events.filter((event) => event.type === "caption" && event.isFinal);
  assert.deepEqual(persisted.map((event) => [event.language, event.origin ?? null]), [
    ["en", "source"],
    ["ko", null],
  ], "the web record must retain both source and translated lanes");
  assert.equal(polishCalls.length, 1, "the untranslated source record must never consume the polish budget");
  assert.equal(polishCalls[0].targetLanguage, "ko");
  assert.deepEqual(
    hostEvents.filter((event) => event.type === "caption").map((event) => [event.language, event.text]),
    [["ko", "이 원문은 이중 언어 웹 기록에만 포함됩니다."]],
    "the desktop screen must receive only the opposite-language translation",
  );
  await pipeline.close();
});

test("meeting never mirrors a failed target-lane echo to the desktop", async () => {
  const state = makeDependencies();
  const hostEvents = [];
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-screen-failed-hidden",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["en", "ko"],
    dependencies: state.dependencies,
    onHostEvent: (event) => hostEvents.push(event),
  });
  await pipeline.start();
  const inputSession = state.liveSessions[0];
  const koreanSession = state.liveSessions.find((session) => session.language === "ko");
  await inputSession.onInputCaption({
    text: "This untranslated echo must stay in records only.",
    isFinal: true,
    languageCode: "en-US",
    utteranceKey: "turn-failed",
  });
  await koreanSession.onCaption({
    text: "This untranslated echo must stay in records only.",
    isFinal: true,
    sourceText: "This untranslated echo must stay in records only.",
    sourceLanguage: "en-US",
    utteranceKey: "turn-failed",
  });

  const failed = state.events.find((event) => event.type === "caption" && event.translationStatus === "failed");
  assert.ok(failed, "the failed lane remains durable for audit/history continuity");
  assert.equal(hostEvents.some((event) => event.translationStatus === "failed"), false);
  assert.equal(hostEvents.some((event) => event.origin === "source"), false);
  await pipeline.close();
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
  // The "두 번째 진행 중" partial arms a 140ms debounce timer that outlives the
  // test; see the same close() in the seq-space test above.
  await pipeline.close();
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

test("actual Gemini path retains a post-release A final and does not attribute new host speech to A", async () => {
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
  messageHandler({ serverContent: {
    inputTranscription: { text: "A의 늦은", languageCode: "ko-KR" },
  } });
  for (let tick = 0; tick < 2; tick += 1) await new Promise((resolve) => setImmediate(resolve));
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
  assert.equal(finals[0].speaker.speakerId, "participant:A");
  assert.equal(finals[0].sourceStartedAt, "1970-01-01T00:00:01.000Z");
  assert.equal(finals[0].sourceText, "A의 늦은 원문");
  assert.equal(finals[1].speaker, null);
  assert.equal(finals[1].sourceText, "호스트 새 발언");
  await pipeline.close();
});

test("actual Gemini partials keep flowing while ordered finals wait on caption polish", async () => {
  const state = makeDependencies();
  let messageHandler;
  const pendingPolish = [];
  state.dependencies.liveTranslate = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  state.dependencies.captionPolish = {
    polish({ translatedText }) {
      return new Promise((resolve) => pendingPolish.push({ translatedText, resolve }));
    },
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-polish-does-not-block-partials", sessionType: "meeting", outputMode: "captions",
    languages: ["en"], captionPolishPolicy: "full", dependencies: state.dependencies,
  });
  await pipeline.start();
  const settle = async () => {
    for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  messageHandler({ serverContent: {
    inputTranscription: { text: "첫째 원문", languageCode: "ko-KR" },
    outputTranscription: { text: "First translated sentence" },
    turnComplete: true,
  } });
  await settle();
  assert.equal(pendingPolish.length, 1);

  messageHandler({ serverContent: {
    inputTranscription: { text: "둘째 원문", languageCode: "ko-KR" },
    outputTranscription: { text: "Second translation growing." },
  } });
  await settle();
  assert.equal(
    state.events.some((event) => event.type === "caption" && !event.isFinal && event.text === "Second translation growing."),
    true,
  );

  messageHandler({ serverContent: { turnComplete: true } });
  await settle();
  assert.equal(pendingPolish.length, 2);
  pendingPolish[1].resolve("Second translation finalized.");
  await settle();
  assert.equal(state.events.some((event) => event.type === "caption" && event.isFinal), false);
  pendingPolish[0].resolve("First translation finalized.");
  await settle();

  const finals = state.events.filter((event) => event.type === "caption" && event.isFinal);
  assert.deepEqual(finals.map((event) => [event.seq, event.text, event.sourceText]), [
    [1, "First translation finalized.", "첫째 원문"],
    [2, "Second translation finalized.", "둘째 원문"],
  ]);
  assert.notEqual(finals[0].utteranceKey, finals[1].utteranceKey);
  await pipeline.close();
});

test("actual participant KO callback keeps EN partial growth when output languageCode repeats the source", async () => {
  const state = makeDependencies();
  const handlers = new Map();
  state.dependencies.liveTranslate = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      handlers.set(options.config.translationConfig.targetLanguageCode, options.callbacks.onmessage);
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-participant-ko-en", sessionType: "meeting", outputMode: "captions",
    languages: ["ko", "en"], dependencies: state.dependencies,
  });
  await pipeline.start();
  pipeline.setFloorSpeaker({ participantId: "participant-ko", displayName: "한국어 참가자" });

  handlers.get("ko")({ serverContent: { inputTranscription: { text: "안녕하세요", languageCode: "ko-KR" } } });
  handlers.get("en")({ serverContent: {
    inputTranscription: { text: "안녕하세요", languageCode: "ko-KR" },
    outputTranscription: { text: "Hello", languageCode: "ko-KR" },
  } });
  handlers.get("ko")({ serverContent: { inputTranscription: { text: " 여러분.", languageCode: "ko-KR" }, turnComplete: true } });
  handlers.get("en")({ serverContent: {
    inputTranscription: { text: " 여러분.", languageCode: "ko-KR" },
    outputTranscription: { text: " everyone.", languageCode: "ko-KR" },
    turnComplete: true,
  } });
  for (let tick = 0; tick < 8; tick += 1) await new Promise((resolve) => setImmediate(resolve));

  const english = state.events.filter((event) => event.type === "caption" && event.language === "en");
  assert.equal(english.some((event) => event.isFinal === false && event.text === "Hello"), false,
    "a five-character provider guess stays hidden until the sentence is committed");
  const final = english.find((event) => event.isFinal === true);
  assert.equal(final?.text, "Hello everyone.");
  assert.equal(final?.sourceLanguage, "ko");
  assert.equal(final?.origin, undefined);
  assert.equal(final?.speaker?.speakerId, "participant:participant-ko");
  assert.match(final?.utteranceKey ?? "", /^gemini:/u);
  await pipeline.close();
});

test("host and returning participant finals persist both lanes with stable capture identity and no seq gaps", async () => {
  const state = makeDependencies();
  const handlers = new Map();
  const rpcCalls = [];
  const fanoutEvents = [];
  let clock = Date.parse("2026-07-26T03:00:00.000Z");
  state.dependencies.liveTranslate = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      handlers.set(options.config.translationConfig.targetLanguageCode, options.callbacks.onmessage);
      return { sendRealtimeInput() {}, close() {} };
    } } },
    now: () => clock,
  });
  state.dependencies.publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "secret",
    async eventFanout(_sessionId, language, event) { fanoutEvents.push({ ...event, language }); },
    async audioFanout() {},
    async fetchFn(url, init) {
      const call = { path: new URL(String(url)).pathname, body: JSON.parse(init.body) };
      rpcCalls.push(call);
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-host-participant-cycle", sessionType: "meeting", outputMode: "captions",
    languages: ["ko", "en"], dependencies: state.dependencies, now: () => clock,
  });
  await pipeline.start();
  const settle = async () => {
    for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const capture = async (capturedAt) => {
    clock = capturedAt;
    await pipeline.acceptAudio(new Uint8Array(1_280), capturedAt);
    await pipeline.endAudioStream();
  };
  const sourceFinal = async (text) => {
    handlers.get("ko")({ serverContent: {
      inputTranscription: { text, languageCode: "ko-KR" }, turnComplete: true,
    } });
    await settle();
  };
  const translatedFinal = async (sourceText, translatedText) => {
    handlers.get("en")({ serverContent: {
      inputTranscription: { text: sourceText, languageCode: "ko-KR" },
      outputTranscription: { text: translatedText, languageCode: "ko-KR" },
      turnComplete: true,
    } });
    await settle();
  };
  const base = clock;

  await capture(base);
  await sourceFinal("호스트 첫 문장");
  await translatedFinal("호스트 첫 문장", "The host's first sentence.");

  // Reproduce the canary race: a host capture remains without an input final
  // immediately before the participant takes the floor.
  await capture(base + 500);
  const participant = { participantId: "participant-A", displayName: "참가자 A" };
  pipeline.setFloorSpeaker(participant);
  await capture(base + 1_000);
  await sourceFinal("참가자 첫 문장");
  await capture(base + 1_500);
  await sourceFinal("참가자 둘째 문장");

  pipeline.setFloorSpeaker(null);
  await translatedFinal("참가자 첫 문장", "The participant's first sentence.");
  await translatedFinal("참가자 둘째 문장", "The participant's second sentence.");

  await capture(base + 2_000);
  await sourceFinal("호스트 복귀 문장");
  await translatedFinal("호스트 복귀 문장", "The host returns.");

  pipeline.setFloorSpeaker(participant);
  await capture(base + 3_000);
  await sourceFinal("참가자 재진입 문장");
  await translatedFinal("참가자 재진입 문장", "The participant returns.");

  const utteranceCalls = rpcCalls.filter((call) => call.path.endsWith("/persist_live_final_caption_if_active"));
  assert.equal(utteranceCalls.length, 10);
  for (const language of ["ko", "en"]) {
    const rows = utteranceCalls.filter((call) => call.body.p_language === language).map((call) => call.body);
    assert.deepEqual(rows.map((row) => row.p_seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(rows.map((row) => row.p_participant_id), [null, "participant-A", "participant-A", null, "participant-A"]);
    assert.deepEqual(rows.map((row) => row.p_speaker_label), [null, "participant:participant-A", "participant:participant-A", null, "participant:participant-A"]);
    assert.deepEqual(rows.map((row) => row.p_source_started_at), [
      new Date(base).toISOString(),
      new Date(base + 1_000).toISOString(),
      new Date(base + 1_500).toISOString(),
      new Date(base + 2_000).toISOString(),
      new Date(base + 3_000).toISOString(),
    ]);
  }
  assert.equal(fanoutEvents.some((event) => event.type === "recording-error"), false);
  await pipeline.close();
});

test("floor transition never lets a new participant partial inherit the host source context", async () => {
  const state = makeDependencies();
  const pipeline = new LiveMediaPipeline({
    sessionId: "s-floor-partial-fence", sessionType: "meeting", outputMode: "captions",
    languages: ["ko", "en"], dependencies: state.dependencies,
  });
  await pipeline.start();
  const source = state.liveSessions.find((session) => typeof session.onInputCaption === "function");
  const english = state.liveSessions.find((session) => session.language === "en");

  await source.onInputCaption({ text: "호스트 문장.", isFinal: false, languageCode: "ko-KR" });
  await english.onCaption({ text: "Host sentence.", isFinal: false });
  await new Promise((resolve) => setImmediate(resolve));
  const hostTranslation = state.events.find((event) => event.type === "caption" && event.language === "en");
  pipeline.setFloorSpeaker({ participantId: "new-speaker", displayName: "새 참가자" });

  await english.onCaption({ text: "New", isFinal: false });
  assert.equal(
    state.events.filter((event) => event.type === "caption" && event.language === "en").length,
    1,
    "an output partial arriving before its new source must not reuse the host utterance",
  );
  await source.onInputCaption({ text: "새 참가자 문장.", isFinal: false, languageCode: "ko-KR" });
  await english.onCaption({ text: "New participant sentence.", isFinal: false });
  await new Promise((resolve) => setImmediate(resolve));

  const participantTranslation = state.events.filter(
    (event) => event.type === "caption" && event.language === "en",
  ).at(-1);
  assert.notEqual(participantTranslation.utteranceKey, hostTranslation.utteranceKey);
  assert.equal(participantTranslation.sourceLanguage, "ko");
  assert.equal(participantTranslation.speaker.speakerId, "participant:new-speaker");
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
    captionPolishPolicy: "full",
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
