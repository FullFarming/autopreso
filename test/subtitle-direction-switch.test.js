// Direction-switch smoothness ("영어였다가 한글이었다가 통역이 부드럽게 이어지지 않음"):
//  1. when the spoken language flips mid-utterance, the subtitle that is ALREADY
//     ON SCREEN is finalized as a committed line (sentence completed) instead of
//     vanishing half-way,
//  2. the cross-channel sustained-English tie-break judges the RECENT tail of
//     the source, so accumulated English from before the switch cannot pin the
//     authoritative source to "en" after the speaker has moved on to Korean.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";

import {
  createCrossChannelEchoRegistry,
  createSubtitleRealtimeManager,
} from "../src/subtitle-realtime.js";

class FakeSocket extends EventEmitter {
  constructor(url, init) {
    super();
    this.url = url;
    this.init = init;
    this.sent = [];
    this.readyState = WebSocket.OPEN;
  }

  send(message) {
    this.sent.push(message);
  }

  close() {
    this.closed = true;
    this.emit("close");
  }

  terminate() {
    this.terminated = true;
    this.emit("close");
  }
}

test("a source-language switch finalizes the on-screen partial as a committed line", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", languagePair: { a: "en", b: "ko" } },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];

  // English speech translated into Korean; the partial is on screen.
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "We will now discuss the market outlook for this year." }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.done", transcript: "We will now discuss the market outlook for this year." }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "올해 시장 전망에 대해 말씀드리겠습니다" }));

  const partials = broadcasts.filter((message) => message.type === "subtitle:partial" && message.targetLanguage === "ko");
  assert.equal(partials.length >= 1, true, "the Korean translation partial must be on screen first");

  // The speaker switches to Korean mid-flow. The Korean channel's source is now
  // its own target language — the old behavior wiped the on-screen sentence.
  // It must instead be finalized as a committed line before the lane clears.
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "안녕하세요 여러분 오늘 발표를 시작하겠습니다" }));

  const committed = broadcasts.filter((message) => message.type === "subtitle:committed" && message.targetLanguage === "ko");
  assert.equal(committed.length, 1, "the on-screen sentence is committed at the switch");
  assert.equal(committed[0].translatedText, "올해 시장 전망에 대해 말씀드리겠습니다");
  assert.equal(committed[0].sourceLanguage, "en", "the committed line keeps the direction it was translated in");

  await manager.stop();
});

test("sustained-English tie-break yields to Korean as soon as the recent tail turns Korean", () => {
  const registry = createCrossChannelEchoRegistry();

  // While English is spoken, both channels disagree (one transliterates), and
  // the sustained-English rule correctly pins the source to English.
  registry.reportSource("ko", "en", "We are seeing strong demand across the office market");
  registry.reportSource("en", "ko", "위 아 씨잉 스트롱 디맨드");
  assert.equal(registry.resolveSource("unknown"), "en");

  // The speaker switches to Korean. The accumulated buffer still carries the
  // earlier English, but the RECENT tail is Korean — sustained-English must not
  // keep forcing "en", and the fresh two-channel Korean consensus must win.
  const mixedBuffer = "We are seeing strong demand across the office market 안녕하세요 오늘은 임대차 시장을 말씀드리겠습니다";
  registry.reportSource("ko", "ko", mixedBuffer);
  registry.reportSource("en", "ko", mixedBuffer);
  assert.equal(registry.resolveSource("unknown"), "ko", "fresh Korean consensus takes over immediately");
});

test("source arbitration resets per channel without erasing a sibling still finishing the same utterance", () => {
  const registry = createCrossChannelEchoRegistry();
  registry.reportSource("ko", "en", "We are discussing the hotel market today");
  registry.reportSource("en", "en", "We are discussing the hotel market today");
  assert.equal(registry.resolveSource("unknown"), "en");

  registry.resetSource("ko");
  assert.equal(registry.resolveSource("unknown"), "en", "the sibling report remains valid until its own turn ends");

  registry.resetSource("en");
  assert.equal(registry.resolveSource("ko"), "en", "sequential provider turn boundaries preserve the last consensus briefly");
  registry.resetSource();
  assert.equal(registry.resolveSource("ko"), "ko", "an explicit session reset clears the consensus");
});

test("strong new-turn script evidence bypasses consensus when no fresh sibling contradicts it", () => {
  const registry = createCrossChannelEchoRegistry();
  registry.reportSource("ko", "en", "We are discussing the hotel market today");
  registry.reportSource("en", "en", "We are discussing the hotel market today");
  registry.resetSource();
  registry.reportSource("ko", "ko", "새로운 한국어 발화입니다", { isStrong: true });

  assert.equal(
    registry.resolveSource("ko", { isStrong: true, channelKey: "ko" }),
    "ko",
    "a real Korean turn must not wait for a consensus that no sibling still supports",
  );
});

test("a lone strong Latin flip cannot defeat a fresh strong Korean sibling, but two-channel EN consensus can", () => {
  const registry = createCrossChannelEchoRegistry();
  registry.reportSource("ko", "ko", "현재 한국어로 호텔 시장을 설명합니다", { isStrong: true });
  registry.reportSource("en", "ko", "현재 한국어로 호텔 시장을 설명합니다", { isStrong: true });
  assert.equal(registry.resolveSource("ko"), "ko");

  registry.reportSource(
    "ko",
    "en",
    "Kushiman and Wakefield Korea is explaining the hotel market",
    { isStrong: true },
  );
  assert.equal(
    registry.resolveSource("en", { isStrong: true, channelKey: "ko" }),
    "ko",
    "the KO-target channel's English transliteration must not become a same-language echo",
  );

  registry.reportSource("en", "en", "We now switch to the English section", { isStrong: true });
  assert.equal(
    registry.resolveSource("en", { isStrong: true, channelKey: "ko" }),
    "en",
    "both channels agreeing on English releases the previous Korean lock immediately",
  );
});

test("turnComplete resets preserve the last two-channel consensus against the first transliterated chunk", () => {
  const registry = createCrossChannelEchoRegistry();
  registry.reportSource("ko", "ko", "한국어 발화가 계속 이어지고 있습니다", { isStrong: true });
  registry.reportSource("en", "ko", "한국어 발화가 계속 이어지고 있습니다", { isStrong: true });
  assert.equal(registry.resolveSource("ko"), "ko");

  registry.resetSource("ko");
  registry.resetSource("en");
  registry.reportSource(
    "ko",
    "en",
    "Kushiman and Wakefield Korea continues the hotel discussion",
    { isStrong: true },
  );
  assert.equal(
    registry.resolveSource("en", { isStrong: true, channelKey: "ko" }),
    "ko",
    "provider turn boundaries must not erase the real continuous-speech consensus",
  );

  registry.reportSource("en", "en", "We genuinely switch to English now", { isStrong: true });
  assert.equal(
    registry.resolveSource("en", { isStrong: true, channelKey: "ko" }),
    "en",
    "a genuine two-channel English consensus replaces the held Korean language immediately",
  );
});

// NOTE on the deliberate BOUND in the next two tests.
//
// A held "ko" consensus facing (a) one fresh strong report saying "en" whose source
// is sustained Latin English and (b) one fresh strong report saying "ko" whose source
// is Hangul is EXACTLY the same arbiter input in two scenarios with OPPOSITE correct
// answers:
//   * English is now being spoken; the en-target channel is transliterating it into
//     Hangul ("예스 예스 나우…")           → correct answer "en"
//   * Korean is still being spoken; the ko-target channel is transliterating it into
//     Latin ("Kushiman and Wakefield…")    → correct answer "ko"
// No per-window rule can separate them, so the split is purely TEMPORAL and the
// product decision is the documented one: the consensus wins while it is still
// FRESH (within SOURCE_HOLD_MS = 2000ms), and once it goes stale the sustained-English
// tie-break wins — English recognition is the accepted priority, and a full Korean
// mis-transcription may briefly mis-direct after the hold expires.
//
// An UNBOUNDED sticky hold is not an option: because a fresh consensus only ever
// re-arms on a genuine ≥2-channel agreement, "sticky forever" meant that the first
// Korean sentence of a bilingual meeting froze the arbitrated source for the entire
// session — Korean viewers then saw NOTHING for every later English passage.
test("two-channel consensus stays sticky through a transliteration phase while the hold is fresh", () => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const registry = createCrossChannelEchoRegistry();
    registry.reportSource("ko", "ko", "한국어 발화가 계속 이어집니다", { isStrong: true });
    registry.reportSource("en", "ko", "한국어 발화가 계속 이어집니다", { isStrong: true });

    // Continuous Korean speech: provider turn boundaries reset the per-channel
    // reports repeatedly, and the ko-target channel keeps Latin-transliterating the
    // Korean. Realtime partials arrive every few hundred ms, so the whole phase stays
    // inside SOURCE_HOLD_MS — the held Korean consensus must survive all of it.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      registry.resetSource("ko");
      registry.resetSource("en");
      now += 200;
      registry.reportSource(
        "ko",
        "en",
        "Kushiman and Wakefield Korea continues speaking in a transliterated phase",
        { isStrong: true },
      );
      assert.equal(registry.resolveSource("en", { isStrong: true, channelKey: "ko" }), "ko");
      now += 100;
      registry.reportSource("en", "ko", "실제 음성은 여전히 한국어입니다", { isStrong: true });
      assert.equal(registry.resolveSource("ko", { isStrong: true, channelKey: "en" }), "ko");
    }
    assert.ok(now - 10_000 < 2_000, "the transliteration phase must stay inside SOURCE_HOLD_MS");

    now += 100;
    registry.reportSource("ko", "en", "We now genuinely switch to English", { isStrong: true });
    registry.reportSource("en", "en", "We now genuinely switch to English", { isStrong: true });
    assert.equal(registry.resolveSource("en", { isStrong: true, channelKey: "ko" }), "en");
  } finally {
    Date.now = originalNow;
  }
});

test("a LONE sustained-English report never unseats a held consensus, however long it persists", () => {
  // The tie-break resolves a cross-channel DISAGREEMENT, so it needs a sibling. One
  // channel alone reporting sustained Latin English is just as likely transliterating
  // continuing Korean, so the held consensus must outlast it no matter how stale the
  // hold gets. (The bounded long-term escape for a channel that has genuinely
  // disappeared is SOURCE_SOLO_FALLBACK — covered by the next test.)
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const registry = createCrossChannelEchoRegistry();
    registry.reportSource("ko", "ko", "한국어 발화가 계속 이어집니다", { isStrong: true });
    registry.reportSource("en", "ko", "한국어 발화가 계속 이어집니다", { isStrong: true });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      registry.resetSource("ko");
      registry.resetSource("en");
      now += 2_500; // far past SOURCE_HOLD_MS
      registry.reportSource(
        "ko",
        "en",
        "Kushiman and Wakefield Korea continues speaking in a transliterated phase",
        { isStrong: true },
      );
      assert.equal(
        registry.resolveSource("en", { isStrong: true, channelKey: "ko" }),
        "ko",
        "a lone transliterated report is not a disagreement — the consensus holds",
      );
    }
  } finally {
    Date.now = originalNow;
  }
});

test("a STALE consensus yields to the sustained-English tie-break when the channels disagree", () => {
  // The S1-1 regression. A consensus forms on the first Korean sentence, the speaker
  // pauses, then switches to English: the ko-target channel hears real Latin English
  // while the en-target channel hallucinates a Hangul transliteration. The hold used
  // to be UNBOUNDED for a consensus (resolveSource returned it before the staleness
  // check, and the tie-break was gated on `!authoritativeIsConsensus`), so the
  // arbitrated source stayed pinned to "ko" for the rest of the session — Korean
  // viewers got NOTHING for the whole English passage and English viewers had their
  // own words echoed back. SOURCE_HOLD_MS must bound a consensus hold too.
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const registry = createCrossChannelEchoRegistry();
    registry.reportSource("ko", "ko", "오늘 세션을 시작하겠습니다", { isStrong: true });
    registry.reportSource("en", "ko", "오늘 세션을 시작하겠습니다", { isStrong: true });
    assert.equal(registry.resolveSource("unknown"), "ko", "the Korean consensus is authoritative first");

    // The turn commits (per-channel resets) and the speaker pauses past SOURCE_HOLD_MS.
    registry.resetSource("ko");
    registry.resetSource("en");
    now += 2_500;

    // English now: real Latin English on the ko-target channel, a Hangul
    // transliteration on the en-target channel. Different wordings, so the
    // cross-channel containment check cannot catch the echo.
    registry.reportSource("ko", "en", "We were now being a panelist discussion and integrated session today", { isStrong: true });
    registry.reportSource("en", "ko", "예스 예스 나우 아워 패널 디스커션", { isStrong: true });

    assert.equal(
      registry.resolveSource("en", { isStrong: true, channelKey: "ko" }),
      "en",
      "the ko-target channel must see source=en so it translates the English into Korean",
    );
    assert.equal(
      registry.resolveSource("ko", { isStrong: true, channelKey: "en" }),
      "en",
      "the en-target channel must see source=en so it suppresses its English echo",
    );
  } finally {
    Date.now = originalNow;
  }
});

test("a FRESH consensus still blocks the sustained-English tie-break (no baseline regression)", () => {
  // The same disagreement 300ms after the consensus formed — i.e. continuous
  // same-direction speech, where the consensus is re-confirmed every few hundred ms.
  // Here the hold MUST win, which is what keeps the KO→EN direction rock-solid
  // against a lone hallucinated languageCode flip.
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const registry = createCrossChannelEchoRegistry();
    registry.reportSource("ko", "ko", "오늘 세션을 시작하겠습니다", { isStrong: true });
    registry.reportSource("en", "ko", "오늘 세션을 시작하겠습니다", { isStrong: true });
    now += 300;
    registry.reportSource("ko", "en", "We were now being a panelist discussion and integrated session today", { isStrong: true });
    registry.reportSource("en", "ko", "예스 예스 나우 아워 패널 디스커션", { isStrong: true });
    assert.equal(registry.resolveSource("en", { isStrong: true, channelKey: "ko" }), "ko");
    assert.equal(registry.resolveSource("unknown"), "ko");
  } finally {
    Date.now = originalNow;
  }
});

test("sticky consensus has a bounded long-term fallback when its sibling channel disappears", () => {
  const originalNow = Date.now;
  let now = 50_000;
  Date.now = () => now;
  try {
    const registry = createCrossChannelEchoRegistry();
    registry.reportSource("ko", "ko", "한국어 합의입니다", { isStrong: true });
    registry.reportSource("en", "ko", "한국어 합의입니다", { isStrong: true });
    registry.resetSource("ko");
    registry.resetSource("en");

    for (let report = 0; report < 8; report += 1) {
      now += 2_500;
      registry.reportSource("ko", "en", "Only the surviving channel reports sustained English speech", { isStrong: true });
      registry.resetSource("ko");
    }
    registry.reportSource("ko", "en", "Only the surviving channel reports sustained English speech", { isStrong: true });
    assert.equal(registry.resolveSource("en", { isStrong: true, channelKey: "ko" }), "en");
  } finally {
    Date.now = originalNow;
  }
});

// KO -> EN -> KO in one session. Two behaviours used to be asserted together
// under the mixed caption+audio mode: captions must not pin the source language
// to the first segment, and the stale interpreted-audio queue must be dropped at
// the boundary. That mode is retired, so the scenario runs once per surviving
// mode and each asserts the half that mode can actually produce.
async function runDirectionSwitchScenario(outputMode) {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: {
          translationProvider: "gemini",
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          outputMode,
          audioLanguage: "en",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "provider-tail-switch" });
  const englishTarget = sockets[0];

  englishTarget.emit("message", JSON.stringify({
    serverContent: { inputTranscription: { text: "처음에는 한국어로 시장을 설명합니다", languageCode: "ko" } },
  }));
  englishTarget.emit("message", JSON.stringify({
    serverContent: { outputTranscription: { text: "First, we explain the market in Korean." } },
  }));

  englishTarget.emit("message", JSON.stringify({
    serverContent: { inputTranscription: { text: "We now switch to English for the next section", languageCode: "en" } },
  }));
  englishTarget.emit("message", JSON.stringify({
    serverContent: { outputTranscription: { text: "We now switch to English for the next section." } },
  }));

  englishTarget.emit("message", JSON.stringify({
    serverContent: { inputTranscription: { text: "다시 한국어로 호텔 투자 전략을 설명합니다", languageCode: "ko" } },
  }));
  englishTarget.emit("message", JSON.stringify({
    serverContent: { outputTranscription: { text: "We return to Korean to explain the hotel investment strategy." } },
  }));

  await manager.stop();
  return broadcasts;
}

test("Gemini provider codes do not make cumulative source text pin KO to EN to KO switching", async () => {
  const broadcasts = await runDirectionSwitchScenario("captions");
  const englishPartials = broadcasts.filter((message) => message.type === "subtitle:partial" && message.targetLanguage === "en");
  assert.equal(englishPartials.length >= 2, true);
  assert.equal(englishPartials.at(-1).sourceLanguage, "ko");
  assert.equal(englishPartials.at(-1).sourceText, "다시 한국어로 호텔 투자 전략을 설명합니다");
  assert.equal(
    englishPartials.some((message) => message.sourceLanguage === "en"),
    false,
    "same-language EN target output must never be emitted during the middle English segment",
  );
});

test("the stale interpreted-audio queue is cleared at a direction boundary", async () => {
  const broadcasts = await runDirectionSwitchScenario("audio");
  assert.equal(
    broadcasts.some((message) => message.type === "subtitle:audio-control"
      && message.targetLanguage === "en"
      && message.reason === "source_language_changed"),
    true,
    "the stale interpreted-audio queue is cleared at the direction boundary",
  );
});
