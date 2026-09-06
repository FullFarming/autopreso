import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { CaptionEvent } from "../../lib/live-contract";
import { mergeLanguageCaptionCache } from "../../lib/live/caption-feed";

import {
  buildTranslationLanes,
  projectCaptionLane,
} from "./translation/topic-presentation";
import {
  readViewerRecoveryContext,
  writeViewerRecoveryContext,
} from "./viewer-session-recovery";

const directory = resolve(process.cwd(), "components/live");
const read = (file: string) => readFileSync(resolve(directory, file), "utf8");

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const sessionId = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";
const topicId = "0192d0f4-9f72-7a36-91f5-6a76ef736f42";

test("a ready lane does not erase an earlier incomplete translation history notice", () => {
  const viewer = read("LiveViewer.tsx");
  const surface = read("quality/ViewerLiveSurface.tsx");
  const notice = read("quality/ViewerLaneHealthNotice.tsx");
  const statusHandler = viewer.slice(viewer.indexOf('if (event.type === "language-status")'), viewer.indexOf('if (event.type === "language-removed")'));
  assert.match(statusHandler, /event.code === "SOURCE_REPLAY_INCOMPLETE"/u);
  assert.match(statusHandler, /setIncompleteLanguages\(\(current\) => \[\.\.\.new Set\(\[\.\.\.current, event.language\]\)\]\)/u);
  assert.doesNotMatch(statusHandler, /setIncompleteLanguages[^;]*filter|setIncompleteLanguages\(\[\]\)/u);
  assert.match(surface, /isIncomplete=\{selectedLane\?\.kind === "translation" && incompleteLanguages.includes\(selectedLane.language\)\}/u);
  assert.match(notice, /일부 번역 기록을 복구하지 못했어요. 원문에서 확인해 주세요./u);
});

test("viewer target tabs remain fixed through unknown, Korean, English and speaker changes", () => {
  for (const sourceLanguage of [null, "ko", "en", "ko", "und"]) {
    assert.deepEqual(buildTranslationLanes(sourceLanguage, ["ko", "en", "ja"]).map((lane) => lane.id), [
      "source", "translation:ko", "translation:en", "translation:ja",
    ]);
  }
});

test("fixed target includes verified native speech and rejects conflicting or unknown original text", () => {
  const result = projectCaptionLane([
    { id: "native", language: "ko", sourceLanguage: "ko", text: "같은 언어 발언", isFinal: true, translationStatus: "verbatim", origin: "source" },
    { id: "translated", language: "ko", sourceLanguage: "en", text: "번역 발언", sourceText: "Translated speech", isFinal: true, translationStatus: "translated" },
    { id: "wrong", language: "ko", sourceLanguage: "en", text: "Do not relabel me", isFinal: true, translationStatus: "verbatim", origin: "source" },
    { id: "unknown", language: "ko", sourceLanguage: "und", text: "mixed words", isFinal: true, translationStatus: "verbatim" },
    { id: "failed", language: "ko", sourceLanguage: "ko", text: "실패 원문", isFinal: true, translationStatus: "failed", origin: "source" },
    { id: "neutral", language: "ko", sourceLanguage: "und", text: "2026", isFinal: true, translationStatus: "verbatim", origin: "source",
      languageObservation: { state: "unknown", languageCode: "und", providerLanguageCode: null, evidence: "neutral", languages: [] } },
  ], { id: "translation:ko", kind: "translation", language: "ko", label: "한국어" });
  assert.deepEqual(result.map((caption) => caption.text), ["같은 언어 발언", "번역 발언", "2026"]);
  assert.deepEqual(result.map((caption) => caption.language), ["ko", "ko", "ko"]);
});

test("source presentation keeps each original segment language instead of the latest speaking language", () => {
  const result = projectCaptionLane([
    { id: "ko", language: "ko", sourceLanguage: "ko", text: "안녕하세요", isFinal: true, translationStatus: "verbatim", origin: "source" },
    { id: "en", language: "en", sourceLanguage: "en", text: "Hello", isFinal: true, translationStatus: "verbatim", origin: "source" },
    { id: "mixed", language: "und", sourceLanguage: "und", text: "안녕 hello", isFinal: true, translationStatus: "verbatim", origin: "source" },
  ], { id: "source", kind: "source", language: "en", label: "원문" });
  assert.deepEqual(result.map((caption) => caption.language), ["ko", "en", "und"]);
});

test("original lane uses source provenance and never relabels untranslated translation text", () => {
  const source = projectCaptionLane([
    { id: "one", utteranceKey: "utterance:1", language: "en", sourceLanguage: "ko", text: "Hello", sourceText: "안녕하세요", isFinal: true, translationStatus: "translated" },
    { id: "two", utteranceKey: "utterance:2", language: "en", sourceLanguage: "ko", text: "No provenance", isFinal: true, translationStatus: "translated" },
  ], { id: "source", kind: "source", language: "ko", label: "원문" });
  assert.deepEqual(source.map((caption) => caption.text), ["안녕하세요"]);
  assert.doesNotMatch(JSON.stringify(source), /No provenance/u);
});

test("late English history after switching to Korean adds original text without replacing Korean captions", () => {
  const makeCaption = (language: string, seq: number, text: string, sourceText: string | null): CaptionEvent => ({
    type: "caption", sessionId, language, seq, text, sourceText, sourceLanguage: "ko",
    speaker: null, isFinal: true, utteranceKey: `utterance:${seq}`,
    translationStatus: language === "ko" ? "verbatim" : "translated",
    ...(language === "ko" ? { origin: "source" as const } : {}),
    emittedAt: "2026-08-31T01:00:00Z", sourceEndedAt: "2026-08-31T01:00:00Z",
  });
  const englishCache = mergeLanguageCaptionCache({}, "en", [makeCaption("en", 1, "First", "첫 문장")]);
  const koreanCache = mergeLanguageCaptionCache(englishCache, "ko", [makeCaption("ko", 1, "첫 문장", null)]);
  const selectedKoreanCaptions = koreanCache.ko;
  const sourceLane = { id: "source", kind: "source" as const, language: "ko", label: "원문" };
  const projectOriginal = (cache: Record<string, CaptionEvent[]>) => projectCaptionLane(
    Object.values(cache).flat().map((caption) => ({ ...caption, id: `${caption.language}:${caption.seq}` })), sourceLane,
  ).map((caption) => caption.text);
  assert.deepEqual(projectOriginal(koreanCache), ["첫 문장"]);

  const lateCache = mergeLanguageCaptionCache(koreanCache, "en", [makeCaption("en", 2, "Second", "늦게 도착한 둘째 원문")]);
  assert.equal(lateCache.ko, selectedKoreanCaptions, "nonselected snapshots preserve selected captions by reference");
  assert.notEqual(lateCache, koreanCache, "the full cache is the memo invalidation input");
  assert.deepEqual(projectOriginal(lateCache), ["첫 문장", "늦게 도착한 둘째 원문"]);
  assert.deepEqual(projectOriginal(koreanCache), ["첫 문장"], "previous render cache stays immutable");
});

test("source provenance wins conflicting translated siblings while fallback selection stays deterministic", () => {
  const source = projectCaptionLane([
    { id: "fallback-a", utteranceKey: "utterance:1", language: "en", sourceLanguage: "ko", text: "Hello", sourceText: "대체 A", isFinal: true, translationStatus: "translated" },
    { id: "fallback-b", utteranceKey: "utterance:1", language: "ja", sourceLanguage: "ko", text: "こんにちは", sourceText: "대체 B", isFinal: true, translationStatus: "translated" },
    { id: "source", utteranceKey: "utterance:1", language: "ko", sourceLanguage: "ko", text: "실제 원문", isFinal: true, translationStatus: "verbatim", origin: "source" },
    { id: "fallback-c", utteranceKey: "utterance:2", language: "en", sourceLanguage: "ko", text: "First", sourceText: "첫 fallback", isFinal: true, translationStatus: "translated" },
    { id: "fallback-d", utteranceKey: "utterance:2", language: "ja", sourceLanguage: "ko", text: "Second", sourceText: "둘째 fallback", isFinal: true, translationStatus: "translated" },
  ], { id: "source", kind: "source", language: "ko", label: "원문" });
  assert.deepEqual(source.map((caption) => caption.text), ["실제 원문", "첫 fallback"]);
});

test("translation lane accepts only explicit translated provenance", () => {
  const translation = projectCaptionLane([
    { id: "legacy", language: "en", sourceLanguage: "ko", text: "Legacy", sourceText: "레거시", isFinal: true },
    { id: "verified", language: "en", sourceLanguage: "ko", text: "Verified", sourceText: "검증", isFinal: true, translationStatus: "translated" },
  ], { id: "translation:en", kind: "translation", language: "en", label: "English" });
  assert.deepEqual(translation.map((caption) => caption.text), ["Verified"]);
});

test("recovery stores only opaque viewer presentation context", () => {
  const storage = new MemoryStorage();
  writeViewerRecoveryContext(storage, {
    sessionId,
    language: "en",
    preferredTargetLanguage: "en",
    selectedLaneId: "translation:en",
    expandedTopicIds: [topicId],
    anchorUtteranceKey: "gateway:source:41",
    anchorsByLane: { "translation:en": "gateway:source:41" },
  });
  const serialized = [...storage.values.values()][0] ?? "";
  assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), [
    "anchorUtteranceKey", "anchorsByLane", "expandedTopicIds", "language", "preferredTargetLanguage", "selectedLaneId", "sessionId",
  ]);
  assert.doesNotMatch(serialized, /email|token|company|department|jobTitle|consent|title|summary|text/iu);
  assert.equal(readViewerRecoveryContext(storage)?.anchorUtteranceKey, "gateway:source:41");
});

test("live viewer reduces snapshots and topic upserts before presenting assigned and classifying captions", () => {
  const source = read("LiveViewer.tsx");
  const composition = read("viewer-topic-composition.ts");
  const surface = read("quality/ViewerLiveSurface.tsx");
  const lane = read("quality/ViewerTopicLane.tsx");
  const combined = [source, composition, surface, lane].join("\n");
  for (const contract of [
    "createLiveTopicState", "applyLiveTopicUpsert", "mergeLiveTopicSnapshot", "projectTopicMemberships",
    "TranslationLaneTabs", "CurrentTopicPanel", "CompletedTopicAccordion",
  ]) assert.match(combined, new RegExp(contract, "u"));
  assert.match(combined, /분류 중/u);
  assert.match(source, /event\.type === "topic-upsert"/u);
  assert.match(source, /topics:\s*snapshot\.topics,\s*topicMemberships:\s*snapshot\.topicMemberships/u);
  assert.match(source, /data-utterance-key/u);
  assert.match(source, /participantSpeakingEnabled === true/u);
  assert.doesNotMatch(source, /translated-audio|audio-control/u);
});

test("minutes preserve host topics while participant demo covers continuous live and ended records", () => {
  const minutes = read("MeetingMinutes.tsx");
  const model = read("meeting-minutes-model.ts");
  const demo = readFileSync(resolve(process.cwd(), "app/m/watch/demo/page.tsx"), "utf8");
  assert.match(model, /topicId\?: string/u);
  assert.match(model, /topicPosition\?: number/u);
  assert.match(minutes, /MeetingTopicChapters/u);
  assert.match(demo, /ViewerReadingFeed/u);
  assert.match(demo, /ParticipantMeetingMinutes/u);
  assert.doesNotMatch(demo, /CurrentTopicPanel|CompletedTopicAccordion/u);
  assert.match(demo, /degraded/u);
  assert.match(demo, /role="alert"/u);
  assert.match(demo, /buildTranslationLanes\(null, \["ko", "en"\]\)/u);
  assert.doesNotMatch(demo, /translation:ja|日本語/u);
  assert.doesNotMatch(demo, /Current topic|In progress/u);
  assert.match(demo, /request-error/u);
  assert.match(demo, /recapClient=\{recapClient\}/u);
  assert.match(demo, /<select[^>]*aria-label=\{t\("미리보기 상태"\)\}/u);
  assert.match(demo, /const previewStateFieldId = useId\(\)/u);
  assert.match(demo, /<label[^>]*htmlFor=\{previewStateFieldId\}/u);
  assert.match(demo, /<select[^>]*id=\{previewStateFieldId\}[^>]*name="previewState"/u);
  assert.match(demo, /normal|degraded|disconnected|empty/u);
  assert.match(demo, /projectCaptionLane\(inputs, selectedLane\)/u);
  assert.match(demo, /mergeViewerSourceLedger\(\[\], finalized\).map\(presentViewerSourceEvent\)/u);
  assert.match(demo, /aria-label=\{t\("같은 화자의 발언 진행"\)\}/u);
  assert.match(demo, /한국어 발언|영어 발언까지|혼합 발언까지/u);
  assert.doesNotMatch(demo, /fetch\(|getUserMedia|new WebSocket/u);
});

test("viewer live presentation is extracted while source recovery remains immediately available", () => {
  const viewer = read("LiveViewer.tsx");
  const surface = read("quality/ViewerLiveSurface.tsx");
  assert.match(viewer, /<ViewerLiveSurface/u);
  assert.match(surface, /ViewerLaneHealthNotice/u);
  assert.match(surface, /TranslationLaneTabs/u);
  assert.ok(surface.split("\n").length < 400);
});

test("viewer topic CSS reserves the reading surface and accessible interaction states", () => {
  const styles = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
  const marker = styles.indexOf("/* Viewer topic composition */");
  const contract = styles.slice(marker);
  assert.ok(marker >= 0);
  assert.match(contract, /min-height:\s*70(?:d?vh|%)/u);
  assert.match(contract, /min-height:\s*44px/u);
  assert.match(contract, /outline:\s*2px solid var\(--nova-system-default/u);
  assert.match(contract, /prefers-reduced-motion:\s*reduce/u);
  assert.doesNotMatch(contract, /#[0-9a-f]{3,8}\b/iu);
  assert.doesNotMatch(contract, /gradient\(/iu);
});

test("viewer maps lane failures to safe Korean recovery without replacing source captions", () => {
  const source = read("LiveViewer.tsx");
  const surface = read("quality/ViewerLiveSurface.tsx");
  const notice = read("quality/ViewerLaneHealthNotice.tsx");
  assert.match(surface, /ViewerLaneHealthNotice/u);
  assert.match(notice, /원문 보기/u);
  assert.doesNotMatch(source, /setError\(event\.message\)/u);
  assert.match(source, /selectedLaneIdRef\.current = "source"/u);
});
