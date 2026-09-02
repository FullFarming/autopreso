import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SONIOX_CONTROL,
  buildSonioxConfig,
  createSonioxFinalizeScheduler,
  createSonioxTokenReducer,
} from "../packages/caption-core/soniox-protocol.js";

test("config: auto mode restricts to ko+en, single modes pin one language, two_way for two languages", () => {
  const auto = buildSonioxConfig({ apiKey: "fixture-key", languageMode: "auto", languages: ["en", "ko"], translation: true, context: { terms: ["NOVA"] }, clientReferenceId: "s1" });
  assert.equal(auto.model, "stt-rt-v5");
  assert.deepEqual([auto.audio_format, auto.sample_rate, auto.num_channels], ["pcm_s16le", 16000, 1]);
  assert.deepEqual(auto.language_hints, ["ko", "en"]);
  assert.equal(auto.language_hints_strict, true);
  assert.deepEqual(auto.translation, { type: "two_way", language_a: "ko", language_b: "en" });
  assert.equal(auto.enable_endpoint_detection, true);
  assert.equal(auto.max_endpoint_delay_ms, 2000);
  const ko = buildSonioxConfig({ apiKey: "fixture-key", languageMode: "ko", languages: ["en", "ko"], translation: true });
  assert.deepEqual(ko.language_hints, ["ko"]);
  const none = buildSonioxConfig({ apiKey: "fixture-key", languageMode: "auto", languages: ["en", "ko"], translation: false });
  assert.equal(Object.hasOwn(none, "translation"), false);
  assert.throws(() => buildSonioxConfig({ apiKey: "", languageMode: "auto", languages: ["en", "ko"] }), /SONIOX_API_KEY_REQUIRED/u);
  assert.throws(() => buildSonioxConfig({ apiKey: "k", languageMode: "auto", languages: ["en", "ko", "ja"], translation: true }), /SONIOX_TRANSLATION_PAIR/u);
});

// Fix round 2 (M5): translation_terms is bounded by pair COUNT and by total
// characters. 200 pairs of long phrases would otherwise blow past what the
// provider accepts for the context payload.
test("config: translation_terms are capped at 200 pairs and 3,000 combined characters", () => {
  /** @param {Record<string, unknown>} config @returns {Array<{source: string, target: string}>} */
  const pairs = (config) => /** @type {any} */ (config.context).translation_terms;
  const short = Array.from({ length: 260 }, (_, index) => ({ source: `s${index}`, target: `t${index}` }));
  const capped = buildSonioxConfig({ apiKey: "fixture-key", languageMode: "auto", languages: ["en", "ko"], context: { translationTerms: short } });
  assert.equal(pairs(capped).length, 200);

  const long = Array.from({ length: 200 }, (_, index) => ({ source: `s${index}`.padEnd(40, "x"), target: `t${index}`.padEnd(40, "y") }));
  const trimmed = buildSonioxConfig({ apiKey: "fixture-key", languageMode: "auto", languages: ["en", "ko"], context: { translationTerms: long } });
  const characters = pairs(trimmed).reduce((total, pair) => total + pair.source.length + pair.target.length, 0);
  assert.ok(characters <= 3_000, `combined characters ${characters}`);
  assert.equal(pairs(trimmed).length, 37, "stops adding pairs once the character budget is spent");
  assert.deepEqual(pairs(trimmed)[0], { source: long[0].source, target: long[0].target });
});

// Event order note (Task 5 ruling 4): partials fire once per `apply()` after the
// token loop, while `<end>` closes the segment *inside* that loop. A translation
// token that is already final in the same frame as `<end>` therefore never
// produces a partial - it is committed directly - so the deterministic order is
// source partials -> translation partials -> (on `<end>`) source final ->
// translation finals -> boundary.
test("reducer: finals append, non-finals replace, <end> commits a segment with timestamps", () => {
  const events = [];
  const reducer = createSonioxTokenReducer({
    onSourcePartial: (e) => events.push(["sp", e.text]),
    onSourceFinal: (e) => events.push(["sf", e.text, e.startMs, e.endMs, e.language]),
    onTranslationPartial: (e) => events.push(["tp", e.text, e.language]),
    onTranslationFinal: (e) => events.push(["tf", e.text, e.language, e.sourceLanguage]),
    onBoundary: (kind) => events.push(["b", kind]),
  });
  reducer.apply({ tokens: [
    { text: "안녕", is_final: true, translation_status: "original", language: "ko", start_ms: 600, end_ms: 800 },
    { text: "하세", is_final: false, translation_status: "original", language: "ko" },
  ] });
  reducer.apply({ tokens: [
    { text: "하세요", is_final: true, translation_status: "original", language: "ko", start_ms: 800, end_ms: 1040 },
    { text: "Hel", is_final: false, translation_status: "translation", language: "en", source_language: "ko" },
  ] });
  reducer.apply({ tokens: [
    { text: "Hello", is_final: true, translation_status: "translation", language: "en", source_language: "ko" },
    { text: "<end>", is_final: true },
  ] });
  assert.deepEqual(events, [
    ["sp", "안녕하세"],
    ["sp", "안녕하세요"],
    ["tp", "Hel", "en"],
    ["sf", "안녕하세요", 600, 1040, "ko"],
    ["tf", "Hello", "en", "ko"],
    ["b", "endpoint"],
  ]);
});

test("reducer: keeps Korean spacing (no trim/join), ignores <fin> text, same segmentId for source and translation", () => {
  const seen = [];
  const reducer = createSonioxTokenReducer({
    onSourcePartial() {}, onTranslationPartial() {},
    onSourceFinal: (e) => seen.push(["s", e.text, e.segmentId]),
    onTranslationFinal: (e) => seen.push(["t", e.text, e.segmentId]),
    onBoundary: (kind) => seen.push(["b", kind]),
  });
  reducer.apply({ tokens: [
    { text: "이번", is_final: true, translation_status: "original", language: "ko", start_ms: 0, end_ms: 200 },
    { text: " 분기", is_final: true, translation_status: "original", language: "ko", start_ms: 200, end_ms: 400 },
    { text: "This quarter", is_final: true, translation_status: "translation", language: "en", source_language: "ko" },
    { text: "<fin>", is_final: true },
  ] });
  assert.equal(seen[0][1], "이번 분기");
  assert.equal(seen[1][1], "This quarter");
  assert.equal(seen[0][2], seen[1][2]);
  assert.deepEqual(seen[2], ["b", "manual-finalize"]);
  assert.equal(SONIOX_CONTROL.keepalive, '{"type":"keepalive"}');
});

test("reducer: a provisional token that precedes <end> in the same frame never leaks into the next segment", () => {
  const events = [];
  const reducer = createSonioxTokenReducer({
    onSourcePartial: (e) => events.push(["sp", e.text, e.segmentId]),
    onSourceFinal: (e) => events.push(["sf", e.text]),
    onTranslationPartial: (e) => events.push(["tp", e.text]),
    onTranslationFinal: (e) => events.push(["tf", e.text]),
    onBoundary: (kind) => events.push(["b", kind]),
  });
  reducer.apply({ tokens: [
    { text: "이번", is_final: true, translation_status: "original", language: "ko", start_ms: 0, end_ms: 200 },
    { text: " 분기에", is_final: false, translation_status: "original", language: "ko" },
    { text: "Quarter", is_final: false, translation_status: "translation", language: "en", source_language: "ko" },
    { text: "<end>", is_final: true },
  ] });
  assert.deepEqual(events, [["sf", "이번"], ["b", "endpoint"]]);

  reducer.apply({ tokens: [
    { text: "매출", is_final: false, translation_status: "original", language: "ko" },
  ] });
  assert.deepEqual(events.at(-1), ["sp", "매출", events.at(-1)[2]]);
  assert.equal(events.filter(([kind]) => kind === "sp").length, 1, "no partial was flushed for the closed segment");
});

// Spike 2026-09-02 (US endpoint, 17 s of continuous synthetic speech): Soniox
// produced zero <end> tokens, and the reducer commits only on <end>/<fin>, so
// the app must ask for <fin> itself. The reducer therefore reports whether any
// final source text is still waiting for a boundary.
test("reducer: hasPendingFinalText reports uncommitted final source text until a boundary", () => {
  const reducer = createSonioxTokenReducer({
    onSourcePartial() {}, onSourceFinal() {}, onTranslationPartial() {}, onTranslationFinal() {}, onBoundary() {},
  });
  assert.equal(reducer.hasPendingFinalText(), false);
  reducer.apply({ tokens: [{ text: "안녕", is_final: false, translation_status: "original", language: "ko" }] });
  assert.equal(reducer.hasPendingFinalText(), false, "provisional text is not pending final text");
  reducer.apply({ tokens: [{ text: "안녕", is_final: true, translation_status: "original", language: "ko", start_ms: 0, end_ms: 200 }] });
  assert.equal(reducer.hasPendingFinalText(), true);
  reducer.apply({ tokens: [
    { text: "Hi", is_final: true, translation_status: "translation", language: "en", source_language: "ko" },
    { text: "<fin>", is_final: true },
  ] });
  assert.equal(reducer.hasPendingFinalText(), false, "<fin> commits the segment");
  reducer.apply({ tokens: [{ text: " ", is_final: true, translation_status: "original", language: "ko" }] });
  assert.equal(reducer.hasPendingFinalText(), false, "whitespace-only finals are not worth a finalize");
  reducer.apply({ tokens: [{ text: "Hello", is_final: true, translation_status: "translation", language: "en", source_language: "ko" }] });
  assert.equal(reducer.hasPendingFinalText(), false, "a translation lane alone does not make source text pending");
});

function createFakeTimers() {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => nowMs,
    setTimer(callback, delay) { const id = nextId++; timers.set(id, { at: nowMs + delay, callback }); return id; },
    clearTimer(id) { timers.delete(id); },
    pending: () => timers.size,
    advance(milliseconds) {
      const target = nowMs + milliseconds;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, timer] = due[0];
        timers.delete(id);
        nowMs = timer.at;
        timer.callback();
      }
      nowMs = target;
    },
  };
}

test("finalize scheduler: fires once after 1.2 s without new tokens while final text is pending", () => {
  const clock = createFakeTimers();
  const fired = [];
  const scheduler = createSonioxFinalizeScheduler({ ...clock, onFinalize: () => fired.push(clock.now()) });
  scheduler.noteTokens({ hasPendingFinalText: false, atMs: 0 });
  clock.advance(2_000);
  assert.deepEqual(fired, [], "nothing pending, nothing to finalize");

  scheduler.noteTokens({ hasPendingFinalText: true, atMs: 2_000 });
  clock.advance(1_000);
  scheduler.noteTokens({ hasPendingFinalText: true, atMs: 3_000 });
  clock.advance(1_100);
  assert.deepEqual(fired, [], "a new token re-arms the idle clock");
  clock.advance(100);
  assert.deepEqual(fired, [4_200]);
  assert.equal(scheduler.isFinalizeInFlight(), true);

  clock.advance(5_000);
  scheduler.noteTokens({ hasPendingFinalText: true, atMs: 9_200 });
  clock.advance(2_000);
  assert.deepEqual(fired, [4_200], "a finalize in flight is never re-sent before a boundary");

  scheduler.noteBoundary();
  assert.equal(scheduler.isFinalizeInFlight(), false);
  scheduler.noteTokens({ hasPendingFinalText: true, atMs: 11_200 });
  clock.advance(1_200);
  assert.deepEqual(fired, [4_200, 12_400], "the boundary re-arms the scheduler");
  scheduler.dispose();
  assert.equal(clock.pending(), 0);
});

test("finalize scheduler: a segment that keeps producing tokens is finalized at the 15 s segment cap", () => {
  const clock = createFakeTimers();
  const fired = [];
  const scheduler = createSonioxFinalizeScheduler({ ...clock, onFinalize: () => fired.push(clock.now()) });
  for (let at = 0; at < 15_000; at += 500) {
    clock.advance(at - clock.now());
    scheduler.noteTokens({ hasPendingFinalText: true, atMs: at });
  }
  assert.deepEqual(fired, [], "tokens every 500 ms keep the idle rule quiet");
  clock.advance(500);
  assert.deepEqual(fired, [15_000], "the segment clock started at the first token of the segment");
  clock.advance(200);
  scheduler.noteTokens({ hasPendingFinalText: true, atMs: 15_200 });
  clock.advance(3_000);
  assert.deepEqual(fired, [15_000], "no second finalize while <fin> is outstanding");

  scheduler.noteBoundary();
  clock.advance(1_800); // 20_000: an idle gap before the next segment must not count against it
  scheduler.noteTokens({ hasPendingFinalText: false, atMs: 20_000 });
  for (let at = 20_500; at <= 35_000; at += 500) {
    clock.advance(at - clock.now());
    scheduler.noteTokens({ hasPendingFinalText: true, atMs: at });
  }
  assert.deepEqual(fired, [15_000, 35_000], "the cap is measured from the segment's first token, not the boundary");

  scheduler.noteBoundary();
  scheduler.noteTokens({ hasPendingFinalText: false, atMs: 40_000 });
  clock.advance(21_000); // 56_000: the wall clock catches up with the token that arrives past the cap
  scheduler.noteTokens({ hasPendingFinalText: true, atMs: 56_000 });
  assert.deepEqual(fired, [15_000, 35_000, 56_000], "pending text arriving past the cap finalizes at once");
  scheduler.dispose();
});

test("finalize scheduler: noteFinalizeSent blocks re-sends, dispose cancels timers, custom windows apply", () => {
  const clock = createFakeTimers();
  const fired = [];
  const scheduler = createSonioxFinalizeScheduler({
    ...clock, idleMilliseconds: 300, maxSegmentMilliseconds: 2_000, onFinalize: () => fired.push(clock.now()),
  });
  scheduler.noteFinalizeSent();
  scheduler.noteTokens({ hasPendingFinalText: true, atMs: 0 });
  clock.advance(1_000);
  assert.deepEqual(fired, [], "a finalize the caller already sent is not duplicated");
  scheduler.noteBoundary();
  scheduler.noteTokens({ hasPendingFinalText: true, atMs: 1_000 });
  clock.advance(300);
  assert.deepEqual(fired, [1_300]);
  scheduler.noteBoundary();
  scheduler.noteTokens({ hasPendingFinalText: true, atMs: 1_300 });
  assert.equal(clock.pending(), 1);
  scheduler.dispose();
  assert.equal(clock.pending(), 0, "dispose clears the armed timer");
  clock.advance(10_000);
  scheduler.noteTokens({ hasPendingFinalText: true, atMs: 11_300 });
  clock.advance(10_000);
  assert.deepEqual(fired, [1_300], "a disposed scheduler never fires again");
});
