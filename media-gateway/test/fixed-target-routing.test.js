import assert from "node:assert/strict";
import test from "node:test";
import { LiveMediaPipeline } from "./helpers/gemini-pipeline.js";
import { SupabaseLivePublisher } from "../src/supabase-adapters.js";
import { compileGlossaryDocumentV1 } from "../../packages/caption-core/index.js";

const SESSION = "00000000-0000-4000-8000-000000000001";
const SOURCE = "00000000-0000-4000-8000-000000000002";
const final = (text, sourceLanguage, index = 0) => ({
  text, sourceLanguage, speakerLabel: "1", sourceStartOffsetMs: index * 1_000,
  sourceEndOffsetMs: (index + 1) * 1_000, sourceEndedAt: `2026-08-31T00:00:${String(index).padStart(2, "0")}.000Z`,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

function harness({ translate, persist, languages = ["ko", "en"], glossaryText = "", compiledGlossary } = {}) {
  const sources = [], calls = [], events = [];
  const pipeline = new LiveMediaPipeline({ sessionId: SESSION, sessionType: "meeting", languages, glossaryText, compiledGlossary,
    dependencies: {
      publisher: {
        async persistAuthoritativeSource(input) {
          sources.push(input);
          if (persist) await persist(input);
          return { sourceUtteranceId: SOURCE, sourceSeq: sources.length, idempotent: false };
        },
        async publish(_sessionId, _language, event) { events.push(event); },
      },
      textTranslate: { async translate(input) {
        calls.push(input);
        return translate ? translate(input) : input.language === "ko" ? "번역된 한국어 문장입니다." : "This is the translated sentence.";
      } },
    } });
  return { pipeline, sources, calls, events, captions: () => events.filter((event) => event.type === "caption") };
}

test("neutral unknown source passes the actual publisher contract without killing the next final", async () => {
  const requests = [];
  const publisher = new SupabaseLivePublisher({ baseUrl: "https://fixture.invalid", serviceRoleKey: "test-placeholder",
    async eventFanout() {}, async fetchFn(url, init) {
      requests.push(JSON.parse(init.body));
      return Response.json(url.includes("persist_authoritative")
        ? { ok: true, sourceUtteranceId: SOURCE, sourceSeq: requests.length, idempotent: false } : true);
    } });
  const h = harness();
  h.pipeline.dependencies.publisher = publisher;
  await h.pipeline.acceptFinalUtterance(final("2026", undefined));
  await h.pipeline.acceptFinalUtterance(final("Next sentence is ready.", "en", 1));
  assert.equal(requests.find((request) => request.p_raw_text === "2026").p_source_language, "und");
});

test("numeric source is neutral on every fixed target without translation calls", async () => {
  const h = harness();
  await h.pipeline.acceptFinalUtterance(final(" 2026! ", undefined));
  assert.equal(h.calls.length, 0);
  assert.equal(h.sources[0].rawText, " 2026! ");
  assert.equal(h.sources[0].sourceLanguage, "und");
  assert.deepEqual(h.captions().map((event) => [event.language, event.sourceLanguage, event.translationStatus]),
    [["ko", "und", "verbatim"], ["en", "und", "verbatim"]]);
  assert.equal(h.captions()[0].languageObservation.evidence, "neutral");
});

test("missing provider metadata uses one resolved Korean observation in storage and captions", async () => {
  const h = harness();
  await h.pipeline.acceptFinalUtterance(final("한국 임대시장 전망을 설명합니다", undefined));
  assert.deepEqual(h.calls.map((call) => call.language), ["en"]);
  assert.equal(h.sources[0].sourceLanguage, "ko");
  assert.ok(h.captions().every((caption) => caption.sourceLanguage === "ko"));
  assert.deepEqual(h.captions()[0].languageObservation, h.sources[0].languageObservation);
});

test("mixed clauses translate to both fixed targets and retain their exact raw source", async () => {
  const h = harness();
  const text = "오늘 매출은 증가했습니다. Revenue is down.";
  await h.pipeline.acceptFinalUtterance(final(text, "ko"));
  assert.deepEqual(h.calls.map((call) => call.language), ["ko", "en"]);
  assert.ok(h.calls.every((call) => call.sourceLanguage === undefined));
  assert.equal(h.sources[0].rawText, text);
  assert.equal(h.sources[0].sourceLanguage, "und");
  assert.equal(h.sources[0].languageObservation.state, "mixed");
  assert.ok(h.captions().every((caption) => caption.translationStatus === "translated" && caption.text !== text));
});

test("conflicting metadata and short names never authorize source passthrough", async () => {
  for (const [text, hint] of [["The report is ready for review.", "ko"], ["NVIDIA", "en"], ["OK", "en"]]) {
    const h = harness();
    await h.pipeline.acceptFinalUtterance(final(text, hint));
    assert.equal(h.sources[0].sourceLanguage, "und", text);
    assert.equal(h.sources[0].languageObservation.state, "unknown", text);
    assert.deepEqual(h.calls.map((call) => call.language), ["ko", "en"], text);
    assert.ok(h.calls.every((call) => call.sourceLanguage === undefined), text);
  }
});

test("failed target never emits raw source or consumes a caption sequence", async () => {
  let fail = true;
  const h = harness({ languages: ["ko"], translate() {
    if (fail) throw new Error("PROVIDER_UNAVAILABLE");
    return "한국어 번역이 복구되었습니다.";
  } });
  await h.pipeline.acceptFinalUtterance(final("We publish the report.", "en"));
  assert.equal(h.sources.length, 1);
  assert.equal(h.captions().length, 0);
  assert.ok(h.events.some((event) => event.type === "language-status" && event.status !== "ready"));
  fail = false;
  await h.pipeline.acceptFinalUtterance(final("We continue the meeting.", "en", 1));
  assert.equal(h.sources.length, 2);
  assert.deepEqual(h.captions().map((event) => event.seq), [1]);
});

test("echoed and foreign-clause outputs do not pass merely because three target letters exist", async () => {
  for (const output of ["We will review the report.", "매출은 좋습니다. Revenue is down."]) {
    const h = harness({ languages: ["ko"], translate: () => output });
    await h.pipeline.acceptFinalUtterance(final("We will review the report.", "en"));
    assert.equal(h.sources.length, 1);
    assert.equal(h.captions().length, 0, output);
  }
});

test("concurrent repeated intent waits for the same durable operation and pays once", async () => {
  const gate = deferred();
  const h = harness({ languages: ["ko"], translate: async () => { await gate.promise; return "정상적인 번역 결과입니다."; } });
  const utterance = final("We have one translation request.", "en");
  const first = h.pipeline.acceptFinalUtterance(utterance);
  await tick();
  let duplicateFinished = false;
  const second = h.pipeline.acceptFinalUtterance({ ...utterance }).then(() => { duplicateFinished = true; });
  await tick();
  assert.equal(duplicateFinished, false);
  assert.equal(h.calls.length, 1);
  gate.resolve();
  await Promise.all([first, second]);
  await h.pipeline.acceptFinalUtterance({ ...utterance });
  assert.equal(h.sources.length, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.captions().length, 1);
});

test("source ingress has a finite pending limit even while durable storage stalls", async () => {
  const gate = deferred();
  const h = harness({ persist: () => gate.promise });
  const tasks = Array.from({ length: 64 }, (_, index) => h.pipeline.acceptFinalUtterance({
    ...final("한국어 발언입니다.", "ko"), sourceStartOffsetMs: index, sourceEndOffsetMs: index + 1,
  }));
  const overflow = h.pipeline.acceptFinalUtterance({ ...final("초과 발언입니다.", "ko"), sourceStartOffsetMs: 100 });
  await assert.rejects(overflow, /SOURCE_BACKPRESSURE_EXCEEDED/u);
  gate.resolve();
  await Promise.all(tasks);
});

test("translation receives a cancellation signal and close aborts an in-flight request", async () => {
  let observedSignal;
  const h = harness({ languages: ["ko"], translate: async ({ signal }) => {
    observedSignal = signal;
    await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
    return "늦게 도착한 번역 결과입니다.";
  } });
  const work = h.pipeline.acceptFinalUtterance(final("This translation is pending.", "en"));
  await tick();
  assert.ok(observedSignal instanceof AbortSignal);
  await h.pipeline.close();
  await work;
  assert.equal(observedSignal.aborted, true);
  assert.equal(h.captions().length, 0);
});

test("pause closes the paid speech stream and only explicit resume opens a new stream", async () => {
  const h = harness();
  let opens = 0, closes = 0;
  h.pipeline.dependencies.speechToText = { async open() {
    opens++;
    return { async sendAudio() {}, async close() { closes++; }, async getFinalWords() { return []; } };
  } };
  await h.pipeline.start();
  await h.pipeline.acceptFinalUtterance(final("한국어 문장을 전합니다.", "ko"));
  await h.pipeline.pause();
  assert.equal(opens, 1);
  assert.equal(closes, 1);
  await tick();
  assert.equal(opens, 1);
  await h.pipeline.resume();
  assert.equal(opens, 2);
  await h.pipeline.acceptFinalUtterance(final("한국어 다음 문장입니다.", "ko", 1));
  assert.deepEqual(h.captions().filter((event) => event.language === "ko").map((event) => event.seq), [1, 2]);
  await h.pipeline.close();
  assert.equal(closes, 2);
});

test("a late durable final cannot clear a more recent ephemeral source observation", async () => {
  const h = harness();
  const sourceGate = deferred(), events = [];
  h.pipeline.dependencies.publisher.publishSourceDraft = async (event) => { events.push(event); };
  h.pipeline.acceptPartialTranscript({ text: "첫 번째 한국어 원문입니다", sourceLanguage: "ko" });
  await tick();
  const originalPersist = h.pipeline.dependencies.publisher.persistAuthoritativeSource;
  h.pipeline.dependencies.publisher.persistAuthoritativeSource = async (input) => { await sourceGate.promise; return originalPersist(input); };
  const first = h.pipeline.acceptFinalUtterance(final("첫 번째 한국어 원문입니다", "ko"));
  await tick();
  h.pipeline.acceptPartialTranscript({ text: "Next original sentence begins", sourceLanguage: "en" });
  await tick();
  sourceGate.resolve();
  await first;
  assert.deepEqual(events.map((event) => [event.type, event.revision]), [["source-draft", 1], ["source-draft", 2]]);
  await h.pipeline.acceptFinalUtterance(final("Next original sentence begins", "en", 1));
  await tick();
  assert.equal(events.at(-1).type, "source-draft-clear");
  assert.equal(events.at(-1).revision, 2);
  assert.ok(events.every((event) => !Object.hasOwn(event, "sourceSeq")));
});

test("durable source replay restores existing target captions without paying for another translation", async () => {
  const h = harness();
  h.pipeline.dependencies.publisher.persistAuthoritativeSource = async () => ({ sourceUtteranceId: SOURCE, sourceSeq: 8, idempotent: true });
  const replays = [];
  h.pipeline.dependencies.publisher.replayAuthoritativeSourceCaptions = async (sessionId, sourceId, languages) => {
    replays.push({ sessionId, sourceId, languages });
    return { restoredLanguages: ["ko"], missingLanguages: ["en"] };
  };
  await h.pipeline.acceptFinalUtterance(final("기존에 저장된 발언입니다.", "ko"));
  assert.equal(h.calls.length, 0);
  assert.deepEqual(replays, [{ sessionId: SESSION, sourceId: SOURCE, languages: ["ko", "en"] }]);
  assert.equal(h.captions().length, 0, "publisher replays stored rows without allocating or writing new captions");
  assert.ok(h.events.some((event) => event.language === "en" && event.code === "SOURCE_REPLAY_INCOMPLETE"));
});

test("an ambiguous durable target replay reports incomplete state without automatic inference", async () => {
  const h = harness();
  h.pipeline.dependencies.publisher.persistAuthoritativeSource = async () => ({ sourceUtteranceId: SOURCE, sourceSeq: 8, idempotent: true });
  h.pipeline.dependencies.publisher.replayAuthoritativeSourceCaptions = async () => { throw new Error("READ_FAILED"); };
  await h.pipeline.acceptFinalUtterance(final("Previously committed source.", "en"));
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.events.filter((event) => event.code === "SOURCE_REPLAY_INCOMPLETE").map((event) => event.language), ["ko", "en"]);
});

test("source observation preserves provider regional metadata without changing the normalized target", async () => {
  const h = harness();
  await h.pipeline.acceptFinalUtterance(final("한국어 문장을 전달합니다.", "ko-KR"));
  assert.equal(h.sources[0].languageObservation.providerLanguageCode, "ko-KR");
  assert.equal(h.sources[0].sourceLanguage, "ko");
  assert.deepEqual(h.captions().map((caption) => caption.language), ["ko", "en"]);
});

test("concurrent pipeline starts share one paid speech connection", async () => {
  const h = harness();
  const gate = deferred();
  let opens = 0;
  h.pipeline.dependencies.speechToText = { async open() {
    opens++;
    await gate.promise;
    return { async sendAudio() {}, async close() {}, async getFinalWords() { return []; } };
  } };
  const first = h.pipeline.start(), second = h.pipeline.start();
  await tick();
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(opens, 1);
  await h.pipeline.close();
});

test("pause preserves the source finalized while closing speech without starting target inference", async () => {
  const h = harness();
  h.pipeline.dependencies.speechToText = { async open({ onFinalUtterance }) {
    return { async sendAudio() {}, async getFinalWords() { return []; },
      async close() { await onFinalUtterance(final("The accepted final source is retained.", "en")); } };
  } };
  await h.pipeline.start();
  await h.pipeline.pause();
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0].rawText, "The accepted final source is retained.");
  assert.equal(h.calls.length, 0);
  assert.equal(h.captions().length, 0);
  await h.pipeline.close();
});

test("an unsupported script embedded in Korean cannot become native Korean verbatim", async () => {
  const h = harness();
  await h.pipeline.acceptFinalUtterance(final("한국어 설명입니다. هذا نص آخر", "ko"));
  assert.equal(h.sources[0].sourceLanguage, "und");
  assert.equal(h.sources[0].languageObservation.evidence, "conflict");
  assert.deepEqual(h.calls.map((call) => call.language), ["ko", "en"]);
  assert.ok(h.captions().every((caption) => caption.translationStatus === "translated"));
});

test("Japanese prolonged sound marks preserve a valid fixed Japanese target", async () => {
  const h = harness({ languages: ["ja"], translate: () => "翻訳済み事業アップデート" });
  await h.pipeline.acceptFinalUtterance(final("The business update is ready.", "en"));
  assert.equal(h.captions()[0]?.text, "翻訳済み事業アップデート");
});

test("identical source offsets and words dedupe within a stream but survive pause-resume and rollover", async () => {
  const h = harness();
  const providers = [];
  let now = 0;
  h.pipeline.now = () => now;
  h.pipeline.dependencies.speechToText = { async open(options) {
    providers.push(options);
    return { supportsRolloverRemap: false, async sendAudio() {}, async close() {} };
  } };
  await h.pipeline.start();
  const utterance = final("한국어 문장이 반복됩니다.", "ko");
  await providers[0].onFinalUtterance(utterance);
  await providers[0].onFinalUtterance(utterance);
  await tick();
  assert.equal(h.sources.length, 1);
  await h.pipeline.pause();
  await h.pipeline.resume();
  await providers[1].onFinalUtterance(utterance);
  await providers[1].onFinalUtterance(utterance);
  await tick();
  assert.equal(h.sources.length, 2);
  now = 600_000;
  await h.pipeline.acceptAudio(new Uint8Array(1_280), now);
  assert.equal(providers.length, 3);
  await providers[2].onFinalUtterance(utterance);
  await providers[2].onFinalUtterance(utterance);
  await tick();
  assert.equal(h.sources.length, 3);
  assert.equal(new Set(h.sources.map((source) => source.utteranceKey)).size, 3);
  assert.equal(h.calls.length, 3, "one English translation per actual stream utterance");
  await h.pipeline.close();
});


test("mixed source is immutable and capitalized ordinary English cannot leak to the Korean target", async () => {
  const raw = "  이번 분기 Revenue와 Operating Margin이 개선됐습니다.  ";
  const h = harness({ languages: ["ko"], translate: () => raw.trim() });
  await h.pipeline.acceptFinalUtterance(final(raw, "ko"));
  assert.equal(h.sources[0].rawText, raw);
  assert.equal(h.calls.length, 1);
  assert.equal(h.captions().length, 0);
});

test("explicit protected spellings remain valid without a second translation call", async () => {
  const h = harness({ languages: ["ko"], glossaryText: "NOVA = NOVA\niPhone = iPhone", translate: () => "NOVA의 iPhone 매출이 늘었습니다." });
  await h.pipeline.acceptFinalUtterance(final("NOVA iPhone revenue increased.", "en"));
  assert.equal(h.calls.length, 1);
  assert.equal(h.captions().length, 1);
  assert.equal(h.captions()[0].text, "NOVA의 iPhone 매출이 늘었습니다.");
});

test("mixed Korean interim stays in the original draft and cannot trigger extra translation calls", async () => {
  const h = harness({ languages: ["ko"] });
  const drafts = [];
  h.pipeline.dependencies.publisher.publishSourceDraft = async (event) => { drafts.push(event); };
  const mixed = "오늘 Revenue 자료를 검토하겠습니다.";
  h.pipeline.acceptPartialTranscript({ text: mixed, sourceLanguage: "ko" });
  await tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.captions().length, 0);
  assert.equal(drafts[0].text, mixed);
  h.pipeline.acceptPartialTranscript({ text: "오늘 매출 자료를 검토하겠습니다.", sourceLanguage: "ko" });
  await tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.captions()[0].text, "오늘 매출 자료를 검토하겠습니다.");
});

test("a mixed Korean final receives exactly one initial Korean translation and keeps the raw source", async () => {
  const raw = "  오늘 Revenue 자료를 검토하겠습니다.  ";
  const h = harness({ languages: ["ko"], translate: () => "오늘 매출 자료를 검토하겠습니다." });
  await h.pipeline.acceptFinalUtterance(final(raw, "ko"));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].intent, "final");
  assert.equal(h.sources[0].rawText, raw);
  assert.equal(h.captions()[0].translationStatus, "translated");
  assert.equal(h.captions()[0].text, "오늘 매출 자료를 검토하겠습니다.");
});

test("full pinned canonical preservation accepts exact names but never admits adjacent ordinary English", async () => {
  const compiledGlossary = compileGlossaryDocumentV1({
    schemaVersion: 1, name: "Pinned names", domain: "Business", sourceLanguage: "en", targetLanguages: ["ko"],
    terms: [
      { id: "nova", source: "NOVA", translations: {}, doNotTranslate: true, aliases: ["Novaa"], provenance: { kind: "manual" } },
      { id: "phone", source: "phone product", translations: { ko: "iPhone" }, provenance: { kind: "manual" } },
    ],
    createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z", version: 1,
  });
  for (const [output, expectedCaptions] of [["NOVA의 iPhone 매출이 늘었습니다.", 1], ["NOVA의 iPhone Revenue가 늘었습니다.", 0]]) {
    const h = harness({ languages: ["ko"], compiledGlossary, translate: () => output });
    await h.pipeline.acceptFinalUtterance(final("NOVA phone product revenue increased.", "en"));
    assert.equal(h.calls.length, 1);
    assert.equal(h.captions().length, expectedCaptions);
    if (expectedCaptions) assert.equal(h.captions()[0].text, output);
    await h.pipeline.close();
  }
});
