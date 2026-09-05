import assert from "node:assert/strict";
import { test } from "node:test";

import type { CaptionEvent } from "../live-contract";
import {
  getCachedLanguageCaptions,
  isDisplayableCaption,
  isPinnedToLatest,
  LanguageSnapshotRegistry,
  loadLanguageSnapshotOnce,
  mergeCaptionTimeline,
  mergeLanguageCaptionCache,
  newestFirst,
  PIN_THRESHOLD_PX,
} from "./caption-feed";
import { waitForSocketOpen, withAbortTimeout } from "../../components/live/connection-resilience";
import { countdownMsUntil, formatCountdown } from "./countdown";

test("newestFirst reverses without mutating the source array", () => {
  const source = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
  const ordered = newestFirst(source);
  assert.deepEqual(ordered.map((item) => item.seq), [3, 2, 1]);
  assert.deepEqual(source.map((item) => item.seq), [1, 2, 3]);
});

test("newestFirst keeps an empty feed empty", () => {
  assert.deepEqual(newestFirst([]), []);
});

test("isPinnedToLatest pins readers at or near the top of the feed", () => {
  assert.equal(isPinnedToLatest(0), true);
  assert.equal(isPinnedToLatest(PIN_THRESHOLD_PX - 1), true);
  assert.equal(isPinnedToLatest(PIN_THRESHOLD_PX), false);
  assert.equal(isPinnedToLatest(500), false);
});

test("formatCountdown renders HH:MM:SS and clamps at zero", () => {
  assert.equal(formatCountdown(0), "00:00:00");
  assert.equal(formatCountdown(-5_000), "00:00:00");
  assert.equal(formatCountdown(61_000), "00:01:01");
  assert.equal(formatCountdown(3_600_000 + 2 * 60_000 + 3_000), "01:02:03");
});

test("countdownMsUntil returns remaining ms and null for missing or invalid schedules", () => {
  const now = Date.parse("2026-07-23T10:00:00.000Z");
  assert.equal(countdownMsUntil("2026-07-23T10:00:30.000Z", now), 30_000);
  assert.equal(countdownMsUntil("2026-07-23T09:59:00.000Z", now), -60_000);
  assert.equal(countdownMsUntil(null, now), null);
  assert.equal(countdownMsUntil("not-a-date", now), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Web history vs Electron overlay. The web keeps each complete language lane,
// including source speech in its own language. A failed translation is the only
// event hidden because it cannot be trusted to belong to its claimed lane.
// ─────────────────────────────────────────────────────────────────────────────
test("the source-language transcript displays in its selected web history lane", () => {
  assert.equal(isDisplayableCaption({ language: "ko", sourceLanguage: "ko", origin: "source", translationStatus: "verbatim" }), true);
});

test("malformed source provenance fails closed", () => {
  assert.equal(isDisplayableCaption({ language: "ko", origin: "source", translationStatus: "verbatim" }), false);
  assert.equal(isDisplayableCaption({ language: "ko", sourceLanguage: "en", origin: "source", translationStatus: "verbatim" }), false);
  assert.equal(isDisplayableCaption({ language: "ja", sourceLanguage: "ja", origin: "source", translationStatus: "verbatim" }), false);
  assert.equal(isDisplayableCaption({ language: "ko", sourceLanguage: "ko", origin: "source", translationStatus: "failed" }), false,
    "a contradictory failed source event must not bypass the provenance gate");
});

test("a failed translation is recorded but never displayed", () => {
  assert.equal(isDisplayableCaption({ language: "en", sourceLanguage: "ko", translationStatus: "failed" }), false);
});

test("only cross-language canonical translations display outside the source lane", () => {
  assert.equal(isDisplayableCaption({ language: "en", sourceLanguage: "ko", translationStatus: "translated" }), true);
  assert.equal(isDisplayableCaption({ language: "ko", sourceLanguage: "en" }), true,
    "the meeting provider may omit a success status but must retain provenance");
  assert.equal(isDisplayableCaption({}), false);
  assert.equal(isDisplayableCaption({ language: "ko", translationStatus: "verbatim" }), false);
  assert.equal(isDisplayableCaption({ language: "ko", sourceLanguage: "ko", translationStatus: "translated" }), false);
});

test("a canonical source final stays visible when the provider omits the optional origin marker", () => {
  const visiblePartial = {
    language: "ko",
    sourceLanguage: "ko",
    origin: "source",
    translationStatus: "verbatim",
  };
  const canonicalFinal = {
    language: "ko",
    sourceLanguage: "ko",
    translationStatus: "verbatim",
  };

  assert.equal(isDisplayableCaption(visiblePartial), true);
  assert.equal(isDisplayableCaption(canonicalFinal), true,
    "partial -> final must not make a valid participant source sentence disappear");
});

function caption(seq: number, text: string, overrides: Partial<CaptionEvent> = {}): CaptionEvent {
  return {
    type: "caption",
    seq,
    sessionId: "session-1",
    language: "ko",
    speaker: null,
    text,
    isFinal: true,
    sourceEndedAt: `2026-07-26T00:00:${String(seq).padStart(2, "0")}.000Z`,
    emittedAt: `2026-07-26T00:00:${String(seq).padStart(2, "0")}.100Z`,
    ...overrides,
  };
}

test("repeated words with different canonical sequences are preserved", () => {
  const once = mergeCaptionTimeline([], caption(1, "네"));
  const twice = mergeCaptionTimeline(once, caption(2, "네"));

  assert.deepEqual(twice.map((event) => [event.seq, event.text]), [[1, "네"], [2, "네"]]);
});

test("a growing partial updates in place and its final leaves one committed line", () => {
  const firstPartial = mergeCaptionTimeline([], caption(3, "안녕", { isFinal: false }));
  const grownPartial = mergeCaptionTimeline(firstPartial, caption(3, "안녕하세요", { isFinal: false }));
  const committed = mergeCaptionTimeline(grownPartial, caption(3, "안녕하세요"));

  assert.deepEqual(grownPartial.map((event) => [event.seq, event.text, event.isFinal]), [[3, "안녕하세요", false]]);
  assert.deepEqual(committed.map((event) => [event.seq, event.text, event.isFinal]), [[3, "안녕하세요", true]]);
});

test("a transient shorter partial cannot erase already-visible words from the same utterance", () => {
  let timeline = mergeCaptionTimeline([], caption(3, "The participant is speaking through the web app", { isFinal: false }));
  timeline = mergeCaptionTimeline(timeline, caption(3, "The participant is speaking", { isFinal: false }));

  assert.deepEqual(timeline.map((event) => [event.seq, event.text, event.isFinal]), [
    [3, "The participant is speaking through the web app", false],
  ]);
});

test("an out-of-order older partial cannot replace the current utterance", () => {
  let timeline = mergeCaptionTimeline([], caption(8, "Current participant sentence", { isFinal: false }));
  timeline = mergeCaptionTimeline(timeline, caption(7, "Late host fragment", { isFinal: false }));

  assert.deepEqual(timeline.map((event) => [event.seq, event.text]), [[8, "Current participant sentence"]]);
});

test("host and participant partials finalize through one append-only feed contract", () => {
  const participant = {
    speakerId: "participant-1",
    label: "Participant",
    colorToken: "speaker-blue",
    voiceName: null,
    voiceStatus: "disabled" as const,
    lastSeenAt: "2026-07-26T00:00:02.000Z",
  };
  let timeline = mergeCaptionTimeline([], caption(1, "Host final"));
  timeline = mergeCaptionTimeline(timeline, caption(2, "Participant is", { isFinal: false, speaker: participant }));
  timeline = mergeCaptionTimeline(timeline, caption(2, "Participant is speaking", { isFinal: false, speaker: participant }));
  timeline = mergeCaptionTimeline(timeline, caption(2, "Participant is speaking.", { speaker: participant }));
  timeline = mergeCaptionTimeline(timeline, caption(3, "Host returns", { isFinal: false }));
  timeline = mergeCaptionTimeline(timeline, caption(3, "Host returns."));

  assert.deepEqual(timeline.map((event) => [event.seq, event.speaker?.speakerId ?? "host", event.text, event.isFinal]), [
    [1, "host", "Host final", true],
    [2, "participant-1", "Participant is speaking.", true],
    [3, "host", "Host returns.", true],
  ]);
});

test("a late partial cannot resurrect after its sequence is committed", () => {
  const committed = mergeCaptionTimeline([], caption(4, "확정"));
  const withLatePartial = mergeCaptionTimeline(committed, caption(4, "확", { isFinal: false }));

  assert.deepEqual(withLatePartial, committed);
});

test("snapshot and live arrivals merge by sequence instead of request completion order", () => {
  let timeline = mergeCaptionTimeline([], caption(103, "실시간 103"));
  timeline = mergeCaptionTimeline(timeline, caption(101, "스냅샷 101"));
  timeline = mergeCaptionTimeline(timeline, caption(102, "스냅샷 102"));

  assert.deepEqual(timeline.map((event) => event.seq), [101, 102, 103]);
});

test("language cache merges independently and restores the selected language immediately", () => {
  let cache: Record<string, CaptionEvent[]> = {};
  cache = mergeLanguageCaptionCache(cache, "ko", [caption(1, "한국어", { language: "ko" })]);
  cache = mergeLanguageCaptionCache(cache, "en", [caption(1, "English", { language: "en" })]);
  cache = mergeLanguageCaptionCache(cache, "ko", [caption(2, "다시 한국어", { language: "ko" })]);

  assert.deepEqual(cache.ko.map((event) => event.text), ["한국어", "다시 한국어"]);
  assert.deepEqual(cache.en.map((event) => event.text), ["English"]);
});

test("source and late translation form one canonical utterance in separate language lanes", () => {
  const speaker = {
    speakerId: "host",
    label: "Host",
    colorToken: "speaker-blue",
    voiceName: null,
    voiceStatus: "disabled" as const,
    lastSeenAt: "2026-07-26T00:00:01.000Z",
  };
  let cache: Record<string, CaptionEvent[]> = {};
  cache = mergeLanguageCaptionCache(cache, "en", [caption(1, "Welcome", {
    language: "en", origin: "source", translationStatus: "verbatim", speaker,
  })]);
  assert.deepEqual(getCachedLanguageCaptions(cache, "en").map((event) => event.text), ["Welcome"]);
  assert.deepEqual(getCachedLanguageCaptions(cache, "ko"), []);

  cache = mergeLanguageCaptionCache(cache, "ko", [caption(1, "환영합니다", {
    language: "ko", translationStatus: "translated", speaker,
  })]);
  assert.deepEqual([cache.en[0]?.seq, cache.en[0]?.speaker?.speakerId], [1, "host"]);
  assert.deepEqual([cache.ko[0]?.seq, cache.ko[0]?.speaker?.speakerId], [1, "host"]);
  assert.equal(cache.en.length, 1);
  assert.equal(cache.ko.length, 1);
});

test("the production participant source and translation finals survive partial replacement in both lanes", () => {
  const participant = {
    speakerId: "participant:viewer-7",
    label: "Sunny",
    name: "Sunny",
    department: "CRE",
    jobTitle: "Manager",
    colorToken: "speaker-teal",
    voiceName: null,
    voiceStatus: "disabled" as const,
    lastSeenAt: "2026-07-26T22:43:10.000Z",
  };
  let cache: Record<string, CaptionEvent[]> = {};
  cache = mergeLanguageCaptionCache(cache, "ko", [caption(19, "접속이 잘 안 되시는", {
    language: "ko", sourceLanguage: "ko", origin: "source", translationStatus: "verbatim",
    isFinal: false, speaker: participant,
  })]);
  cache = mergeLanguageCaptionCache(cache, "ko", [caption(19, "접속이 잘 안 되시는 것 같아요.", {
    language: "ko", sourceLanguage: "ko", translationStatus: "verbatim", speaker: participant,
  })]);
  cache = mergeLanguageCaptionCache(cache, "en", [caption(15, "You're having trouble connecting.", {
    language: "en", sourceLanguage: "ko", translationStatus: "translated", speaker: participant,
  })]);

  assert.deepEqual(cache.ko.map((event) => [event.seq, event.isFinal, event.speaker?.speakerId]), [
    [19, true, "participant:viewer-7"],
  ]);
  assert.deepEqual(cache.en.map((event) => [event.seq, event.isFinal, event.speaker?.speakerId]), [
    [15, true, "participant:viewer-7"],
  ]);
  assert.deepEqual(cache.ko[0]?.speaker && {
    name: cache.ko[0].speaker.name,
    department: cache.ko[0].speaker.department,
    jobTitle: cache.ko[0].speaker.jobTitle,
  }, { name: "Sunny", department: "CRE", jobTitle: "Manager" });
  assert.equal(isDisplayableCaption(cache.ko[0] ?? {}), true);
  assert.equal(isDisplayableCaption(cache.en[0] ?? {}), true);
});

test("a late reconnect snapshot cannot erase participant metadata from an already-rendered final", () => {
  const liveSpeaker = {
    speakerId: "participant:viewer-7",
    label: "Sunny",
    name: "Sunny",
    department: "CRE",
    jobTitle: "Manager",
    colorToken: "speaker-teal",
    voiceName: null,
    voiceStatus: "disabled" as const,
    lastSeenAt: "2026-07-26T22:43:10.000Z",
  };
  const snapshotSpeaker = {
    speakerId: "participant:viewer-7",
    label: "Sunny",
    colorToken: "speaker-teal",
    voiceName: null,
    voiceStatus: "disabled" as const,
    lastSeenAt: "2026-07-26T22:43:10.000Z",
  };
  let cache = mergeLanguageCaptionCache({}, "ko", [caption(19, "접속이 잘 안 되시는 것 같아요.", {
    language: "ko", sourceLanguage: "ko", translationStatus: "verbatim", speaker: liveSpeaker,
  })]);
  cache = mergeLanguageCaptionCache(cache, "ko", [caption(19, "접속이 잘 안 되시는 것 같아요.", {
    language: "ko", sourceLanguage: "ko", translationStatus: "verbatim", speaker: snapshotSpeaker,
  })]);

  assert.deepEqual(cache.ko[0]?.speaker && {
    speakerId: cache.ko[0].speaker.speakerId,
    name: cache.ko[0].speaker.name,
    department: cache.ko[0].speaker.department,
    jobTitle: cache.ko[0].speaker.jobTitle,
  }, {
    speakerId: "participant:viewer-7",
    name: "Sunny",
    department: "CRE",
    jobTitle: "Manager",
  });
});

test("repeating one utterance preserves two finals in both source and translated lanes", () => {
  let cache: Record<string, CaptionEvent[]> = {};
  for (const seq of [1, 2]) {
    cache = mergeLanguageCaptionCache(cache, "en", [caption(seq, "Yes", {
      language: "en", origin: "source", translationStatus: "verbatim",
    })]);
    cache = mergeLanguageCaptionCache(cache, "ko", [caption(seq, "네", {
      language: "ko", translationStatus: "translated",
    })]);
  }

  assert.deepEqual(cache.en.map((event) => [event.seq, event.text]), [[1, "Yes"], [2, "Yes"]]);
  assert.deepEqual(cache.ko.map((event) => [event.seq, event.text]), [[1, "네"], [2, "네"]]);
});

test("language cache rejects cross-lane events instead of mixing EN and KO", () => {
  const malformed = caption(1, "한국어가 EN에 섞이면 안 됨", { language: "ko" });
  const pollutedCurrent = { en: [malformed] };
  const cache = mergeLanguageCaptionCache(pollutedCurrent, "en", [
    caption(2, "Still Korean", { language: "ko" }),
    caption(2, "English only", { language: "en" }),
  ]);

  assert.deepEqual(cache.en.map((event) => [event.language, event.text]), [["en", "English only"]]);
});

test("host and participant captions append through the same canonical event path", () => {
  const participant = {
    speakerId: "participant-1",
    label: "Participant",
    colorToken: "speaker-blue",
    voiceName: null,
    voiceStatus: "disabled" as const,
    lastSeenAt: "2026-07-26T00:00:02.000Z",
  };
  const hostEvent = caption(1, "호스트 발화");
  const participantEvent = caption(2, "참여자 발화", { speaker: participant });
  const timeline = mergeCaptionTimeline(mergeCaptionTimeline([], hostEvent), participantEvent);

  assert.deepEqual(timeline.map((event) => [event.seq, event.speaker?.speakerId ?? "presenter", event.text]), [
    [1, "presenter", "호스트 발화"],
    [2, "participant-1", "참여자 발화"],
  ]);
});

test("repeated KO and EN switching never cross-contaminates either transcript", () => {
  let cache: Record<string, CaptionEvent[]> = {};
  for (let seq = 1; seq <= 12; seq += 1) {
    const language = seq % 2 === 0 ? "en" : "ko";
    cache = mergeLanguageCaptionCache(cache, language, [caption(seq, `${language}-${seq}`, { language })]);
  }

  assert.deepEqual(cache.ko.map((event) => event.text), ["ko-1", "ko-3", "ko-5", "ko-7", "ko-9", "ko-11"]);
  assert.deepEqual(cache.en.map((event) => event.text), ["en-2", "en-4", "en-6", "en-8", "en-10", "en-12"]);
});

test("1,200 captions per lane survive twenty instant switches without blanking or reload", () => {
  const ko = Array.from({ length: 1_200 }, (_value, index) => caption(index + 1, `ko-${index + 1}`, { language: "ko" }));
  const en = Array.from({ length: 1_200 }, (_value, index) => caption(index + 1, `en-${index + 1}`, { language: "en" }));
  let cache = mergeLanguageCaptionCache({}, "ko", ko);
  cache = mergeLanguageCaptionCache(cache, "en", en);
  const koIdentity = cache.ko;
  const enIdentity = cache.en;

  for (let switchIndex = 0; switchIndex < 20; switchIndex += 1) {
    const language = switchIndex % 2 === 0 ? "ko" : "en";
    const selected = getCachedLanguageCaptions(cache, language);
    assert.equal(selected.length, 1_200);
    assert.equal(selected[0]?.language, language);
    assert.equal(selected.at(-1)?.language, language);
    assert.equal(selected, language === "ko" ? koIdentity : enIdentity,
      "switching must reuse the warm cache instead of reloading it");
  }
});

test("warmed EN and KO toggles do not reload either language snapshot", async () => {
  const snapshots = new LanguageSnapshotRegistry();
  snapshots.reset("session-1");
  let snapshotLoads = 0;
  const selectLanguage = (sessionId: string, language: string) => loadLanguageSnapshotOnce(
    snapshots,
    sessionId,
    language,
    async () => {
      snapshotLoads += 1;
      return { sessionId, language };
    },
  );

  await selectLanguage("session-1", "en");
  await selectLanguage("session-1", "ko");
  assert.equal(snapshotLoads, 2, "warming each language requires one snapshot");

  for (let switchIndex = 0; switchIndex < 20; switchIndex += 1) {
    await selectLanguage("session-1", switchIndex % 2 === 0 ? "en" : "ko");
  }
  assert.equal(snapshotLoads, 2, "warm language switches must be cache-only");

  snapshots.reset("session-2");
  await selectLanguage("session-2", "en");
  assert.equal(snapshotLoads, 3, "a different session must not inherit warmed history");
});

class FakeSocketOpenTarget {
  readonly listeners = new Map<string, Set<EventListener>>();
  isClosed = false;

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.isClosed = true;
  }

  emit(type: "open" | "error"): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }
}

test("a half-open websocket is bounded and closed", async () => {
  const socket = new FakeSocketOpenTarget();

  await assert.rejects(waitForSocketOpen(socket, 5), /timed out/u);
  assert.equal(socket.isClosed, true);
});

test("a websocket that opens before the deadline is kept", async () => {
  const socket = new FakeSocketOpenTarget();
  const opened = waitForSocketOpen(socket, 100);
  socket.emit("open");

  await opened;
  assert.equal(socket.isClosed, false);
});

test("snapshot work receives an abort signal at its deadline", async () => {
  await assert.rejects(withAbortTimeout((signal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), 5), /timed out/u);
});

test("a 450-event gateway replay remains lossless in the UI cache", () => {
  const replay = Array.from({ length: 450 }, (_value, index) => caption(index + 1, `replay-${index + 1}`));
  const cache = mergeLanguageCaptionCache({}, "ko", replay);

  assert.equal(cache.ko.length, 450);
  assert.deepEqual(cache.ko.map((event) => event.seq), Array.from({ length: 450 }, (_value, index) => index + 1));
});

test("the retained committed record reaches the 5,000-event product boundary", () => {
  const record = Array.from({ length: 5_000 }, (_value, index) => caption(index + 1, `record-${index + 1}`));
  const cache = mergeLanguageCaptionCache({}, "ko", record);

  assert.equal(cache.ko.length, 5_000);
  assert.equal(cache.ko[0]?.seq, 1);
  assert.equal(cache.ko.at(-1)?.seq, 5_000);
});

test("one partial is retained in addition to 5,000 committed captions and replaced in place", () => {
  const record = Array.from({ length: 5_000 }, (_value, index) => caption(index + 1, `record-${index + 1}`));
  let cache = mergeLanguageCaptionCache({}, "ko", record);
  cache = mergeLanguageCaptionCache(cache, "ko", [caption(5_001, "진행", { isFinal: false })]);
  cache = mergeLanguageCaptionCache(cache, "ko", [caption(5_001, "진행 중", { isFinal: false })]);

  assert.equal(cache.ko.filter((event) => event.isFinal).length, 5_000);
  assert.deepEqual(cache.ko.filter((event) => !event.isFinal).map((event) => event.text), ["진행 중"]);
});

test("two hours at one final per second plus reconnect headroom remain available in both language lanes", () => {
  const twoHoursWithHeadroom = 7_500;
  const ko = Array.from({ length: twoHoursWithHeadroom }, (_value, index) => caption(index + 1, `ko-${index + 1}`, {
    language: "ko", sourceLanguage: "ko", translationStatus: "verbatim",
  }));
  const en = Array.from({ length: twoHoursWithHeadroom }, (_value, index) => caption(index + 1, `en-${index + 1}`, {
    language: "en", sourceLanguage: "ko", translationStatus: "translated",
  }));
  let cache = mergeLanguageCaptionCache({}, "ko", ko);
  cache = mergeLanguageCaptionCache(cache, "en", en);

  assert.equal(cache.ko.length, twoHoursWithHeadroom);
  assert.equal(cache.en.length, twoHoursWithHeadroom);
  assert.deepEqual([cache.ko[0]?.seq, cache.ko.at(-1)?.seq], [1, twoHoursWithHeadroom]);
  assert.deepEqual([cache.en[0]?.seq, cache.en.at(-1)?.seq], [1, twoHoursWithHeadroom]);
});

test("the two-hour record remains memory-bounded after the 12,000-final safety window", () => {
  const record = Array.from({ length: 12_001 }, (_value, index) => caption(index + 1, `record-${index + 1}`));
  const cache = mergeLanguageCaptionCache({}, "ko", record);

  assert.equal(cache.ko.length, 12_000);
  assert.deepEqual([cache.ko[0]?.seq, cache.ko.at(-1)?.seq], [2, 12_001]);
});

test("an older snapshot final cannot erase a newer live partial", () => {
  let timeline = mergeCaptionTimeline([], caption(451, "지금 말하는 중", { isFinal: false }));
  timeline = mergeCaptionTimeline(timeline, caption(450, "이전 확정"));

  assert.deepEqual(timeline.map((event) => [event.seq, event.isFinal]), [[450, true], [451, false]]);
});

test("direct translation is readable before an independent original exists without inventing its source", () => {
  const translationCapture = { kind: "independent-live-translation", streamGeneration: "10000000-0000-4000-8000-000000000001", captureEpoch: "10000000-0000-4000-8000-000000000002", captureStartedAt: "2026-09-01T00:00:00.000Z", captureEndedAt: "2026-09-01T00:00:01.000Z", finalization: "application-sentence-boundary" };
  assert.equal(isDisplayableCaption({ language: "ko", sourceLanguage: null, translationStatus: "translated", translationCapture }), true);
  assert.equal(isDisplayableCaption({ language: "ko", sourceLanguage: null, translationStatus: "translated", translationCapture: { ...translationCapture, streamGeneration: "forged" } }), false);
  assert.equal(isDisplayableCaption({ language: "ko", sourceLanguage: null, translationStatus: "failed", translationCapture }), false);
  assert.equal(isDisplayableCaption({ language: "ko", sourceLanguage: null, origin: "source", translationStatus: "translated", translationCapture }), false);
});

test("malformed or contradictory independent capture cannot fall back to legacy source provenance", async () => {
  const { parseBroadcastEvent } = await import("../../components/live/viewer-controller-contract");
  const { projectCaptionLane } = await import("../../components/live/translation/topic-presentation");
  const capture = { kind: "independent-live-translation", streamGeneration: "10000000-0000-4000-8000-000000000001", captureEpoch: "10000000-0000-4000-8000-000000000002", captureStartedAt: null, captureEndedAt: "2026-09-01T00:00:01.000Z", finalization: "application-sentence-boundary" } as const;
  const base: CaptionEvent = { type: "caption", sessionId: "session-1", language: "ko", seq: 1,
    speaker: null, text: "번역된 문장입니다.", isFinal: true, sourceText: null, sourceLanguage: null,
    sourceEndedAt: capture.captureEndedAt, emittedAt: capture.captureEndedAt,
    translationStatus: "translated", translationCapture: capture };
  const invalidCases: Array<Record<string, unknown>> = [
    { translationCapture: { ...capture, streamGeneration: "forged" }, sourceText: "Unverified source", sourceLanguage: "en" },
    { translationCapture: null, sourceText: "Unverified source", sourceLanguage: "en" },
    { translationCapture: { ...capture, captureStartedAt: "2026-09-01T00:00:02.000Z" } },
    { translationCapture: { ...capture, providerSecret: "must-not-survive" } },
    { sourceStartedAt: capture.captureEndedAt },
    { languageObservation: { state: "single", languageCode: "en", providerLanguageCode: "en", evidence: "provider", languages: ["en"] } },
    { sourceText: "Unverified source" }, { sourceLanguage: "en" }, { origin: "source" },
    { authoritativeSourceId: "10000000-0000-4000-8000-000000000003" },
    { translationStatus: "verbatim", sourceLanguage: "ko" }, { translationStatus: "failed" },
  ];
  for (const overrides of invalidCases) {
    const event = { ...base };
    for (const [key, value] of Object.entries(overrides)) Reflect.set(event, key, value);
    assert.equal(parseBroadcastEvent(event), null, `wire rejection: ${JSON.stringify(overrides)}`);
    assert.equal(isDisplayableCaption(event), false, `feed rejection: ${JSON.stringify(overrides)}`);
    for (const kind of ["source", "translation"] as const) {
      assert.deepEqual(projectCaptionLane([{ ...event, id: "one" }], { id: kind, kind, language: "ko", label: kind }), [],
        `projection rejection: ${kind} ${JSON.stringify(overrides)}`);
    }
  }
  assert.deepEqual(parseBroadcastEvent(base), base);
  assert.equal(isDisplayableCaption(base), true);
  assert.equal(projectCaptionLane([{ ...base, id: "one" }], { id: "translation:ko", kind: "translation", language: "ko", label: "한국어" }).length, 1);
  assert.deepEqual(projectCaptionLane([{ ...base, id: "one" }], { id: "source", kind: "source", language: "und", label: "원문" }), []);
});

test("snapshot rehydrates independent captures unchanged and refuses malformed rows or legacy snapshot fallbacks", async () => {
  const { SupabaseLiveSessionStore } = await import("./store");
  const { parseBroadcastEvent } = await import("../../components/live/viewer-controller-contract");
  const capture = { kind: "independent-live-translation", streamGeneration: "10000000-0000-4000-8000-000000000001", captureEpoch: "10000000-0000-4000-8000-000000000002", captureStartedAt: null, captureEndedAt: "2026-09-01T00:00:01.000Z", finalization: "application-sentence-boundary" } as const;
  const sessionRow = { id: "10000000-0000-4000-8000-000000000009", host_id: "host-1", session_type: "meeting", output_mode: "captions",
    max_viewers: 50, glossary_pack: "general_cre", title: "Fixture", status: "live", languages: ["ko", "en"], viewer_count: 1,
    version: 1, voice_provider: "gemini", admission_open_until: null, expires_at: "2099-01-01T00:00:00.000Z" };
  const row = { seq: 1, participant_id: null, speaker_label: null, speaker_name: null,
    text: "독립 번역입니다.", source_text: null, source_language: null, source_started_at: null,
    origin: null, translation_status: "translated", translation_capture: capture,
    utterance_key: `lt:${capture.streamGeneration}:1`, source_ended_at: capture.captureEndedAt, emitted_at: capture.captureEndedAt };
  let utteranceRows: unknown[] = [row];
  let snapshotRows: unknown[] = [];
  const store = new SupabaseLiveSessionStore("https://fixture.supabase.co", { key: "sb_secret_fixture-only", kind: "secret" }, async url => {
    const target = String(url);
    if (target.includes("read_live_topic_context")) return Response.json({ ok: true, event: "topic-upsert", topics: [], topic_memberships: [], memberships_added: [], latest_source_seq: 0 });
    if (target.includes("live_utterances")) return Response.json(utteranceRows);
    if (target.includes("live_snapshots")) return Response.json(snapshotRows);
    if (target.includes("session_speakers")) return Response.json([]);
    return Response.json([sessionRow]);
  });
  const snapshot = await store.getSnapshot(sessionRow.id, "ko");
  assert.ok(snapshot);
  assert.equal(snapshot.lastSeq, 1);
  assert.equal(snapshot.captions.length, 1);
  assert.deepEqual(snapshot.captions[0].translationCapture, capture);
  assert.equal(snapshot.captions[0].sourceText, null);
  assert.equal(snapshot.captions[0].sourceLanguage, null);
  assert.deepEqual(parseBroadcastEvent(snapshot.captions[0]), snapshot.captions[0]);
  for (const fields of [
    { translation_capture: { ...capture, captureEpoch: "malformed" }, source_text: "Unverified source", source_language: "en" },
    { source_text: "Unverified source" }, { origin: "source" }, { translation_status: "failed" },
  ]) {
    utteranceRows = [{ ...row, ...fields }];
    await assert.rejects(store.getSnapshot(sessionRow.id, "ko"), { code: "INVALID_TRANSLATION_CAPTURE" });
  }
  utteranceRows = [];
  snapshotRows = [{ last_seq: 1, captions: [{ ...snapshot.captions[0], translationCapture: { ...capture, captureEpoch: "malformed" }, sourceText: "Unverified source", sourceLanguage: "en" }], speaker_legend: [] }];
  await assert.rejects(store.getSnapshot(sessionRow.id, "ko"), { code: "INVALID_TRANSLATION_CAPTURE" });
});


test("fixed language caches preserve independent captures across late snapshot replay without adding a source", async () => {
  const { projectCaptionLane, buildTranslationLanes } = await import("../../components/live/translation/topic-presentation");
  const capture = { kind: "independent-live-translation", streamGeneration: "10000000-0000-4000-8000-000000000001", captureEpoch: "10000000-0000-4000-8000-000000000002", captureStartedAt: null, captureEndedAt: "2026-09-01T00:00:01.000Z", finalization: "application-sentence-boundary" } as const;
  const direct = (seq: number, language: string): CaptionEvent => ({ type: "caption", sessionId: "fixture", language, seq,
    speaker: null, text: `${language} ${seq}`, isFinal: true, sourceText: null, sourceLanguage: null,
    utteranceKey: `lt:${capture.streamGeneration}:${seq}`, sourceEndedAt: capture.captureEndedAt,
    emittedAt: capture.captureEndedAt, translationStatus: "translated", translationCapture: capture });
  let cache = mergeLanguageCaptionCache({}, "en", [direct(3, "en")]);
  cache = mergeLanguageCaptionCache(cache, "ko", [direct(1, "ko")]);
  cache = mergeLanguageCaptionCache(cache, "en", [direct(1, "en"), direct(2, "en")]);
  assert.deepEqual(cache.en.map(event => event.seq), [1, 2, 3]);
  assert.deepEqual(cache.ko.map(event => event.seq), [1]);
  for (const sourceLanguage of ["ko", "en", "und"]) {
    const lanes = buildTranslationLanes(sourceLanguage, ["ko", "en"]);
    assert.deepEqual(lanes.map(lane => lane.id), ["source", "translation:ko", "translation:en"]);
    for (const lane of lanes) {
      const inputs = (lane.kind === "source" ? Object.values(cache).flat() : cache[lane.language])
        .map(event => ({ ...event, id: `${event.language}:${event.seq}` }));
      const projected = projectCaptionLane(inputs, lane);
      assert.equal(projected.length, lane.kind === "source" ? 0 : cache[lane.language].length);
    }
  }
  assert.equal(Object.values(cache).flat().every(event => event.sourceText === null && event.sourceLanguage === null), true);
  assert.deepEqual(cache.en[0].translationCapture, capture);
});
