import assert from "node:assert/strict";
import { test } from "node:test";

import { SONIOX_CONTROL, buildSonioxConfig, createSonioxTokenReducer } from "../packages/caption-core/soniox-protocol.js";

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
