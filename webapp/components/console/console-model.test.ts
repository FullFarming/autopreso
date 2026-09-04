import assert from "node:assert/strict";
import test from "node:test";

import {
  countActiveSessions,
  deployCodeLabelKey,
  deployResultLabelKey,
  filterTranslationOptions,
  formatConsoleDate,
  formatRange,
  isEngineDirty,
  languageModesFor,
  reconcileEngineSelection,
  rejectReasons,
  sessionStatusLabelKey,
  statusLabelKey,
  summarizeSessions,
  summaryStatusLabelKey,
  type ConsoleEngineCatalog,
  type ConsoleSessionSummaryRow,
} from "./console-model";

const NOW = Date.parse("2026-09-04T09:30:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const catalog: ConsoleEngineCatalog = {
  stt: [
    { provider: "gemini", model: "gemini-3.5-transcribe-live", label: "Gemini 3.5 Transcribe Live", requiredApiKey: "gemini", available: true, languageModes: ["auto"] },
    { provider: "soniox", model: "stt-rt-v5", label: "Soniox stt-rt-v5", requiredApiKey: "soniox", available: false, languageModes: ["auto", "ko", "en"] },
  ],
  translation: [
    { provider: "gemini", model: "gemini-3.6-flash", label: "Gemini 3.6 Flash", requiredApiKey: "gemini", available: true, languageModes: [] },
    { provider: "gemini", model: "gemini-3.7-flash", label: "Gemini 3.7 Flash", requiredApiKey: "gemini", available: true, languageModes: [] },
    { provider: "soniox", model: "stt-rt-v5", label: "Soniox stt-rt-v5 (STT 결합)", requiredApiKey: "soniox", available: false, languageModes: ["auto", "ko", "en"], requiresSttProvider: "soniox", requiredLanguageCount: 2 },
  ],
  summary: [
    { provider: "gemini", model: "gemini-3.6-flash", label: "Gemini 3.6 Flash", requiredApiKey: "gemini", available: true, languageModes: [] },
  ],
};

const geminiEngine = {
  stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
  translation: { provider: "gemini", model: "gemini-3.6-flash" },
  summary: { provider: "gemini", model: "gemini-3.6-flash" },
};

function session(overrides: Partial<ConsoleSessionSummaryRow>): ConsoleSessionSummaryRow {
  return { status: "stopped", createdAt: new Date(NOW - 3 * DAY).toISOString(), utteranceCount: 0, summaryStatus: null, ...overrides };
}

test("formatRange turns the chip value into an ISO lower bound or null for the whole history", () => {
  assert.equal(formatRange("7d", NOW), new Date(NOW - 7 * DAY).toISOString());
  assert.equal(formatRange("30d", NOW), new Date(NOW - 30 * DAY).toISOString());
  assert.equal(formatRange("all", NOW), null);
});

test("summarizeSessions counts today's sessions, live ones, a week of utterances, and failed summaries", () => {
  const rows = [
    session({ createdAt: "2026-09-04T01:00:00.000Z", status: "live", utteranceCount: 12, summaryStatus: null }),
    session({ createdAt: "2026-09-03T23:59:00.000Z", status: "stopped", utteranceCount: 8, summaryStatus: "failed" }),
    session({ createdAt: new Date(NOW - 8 * DAY).toISOString(), status: "stopped", utteranceCount: 100, summaryStatus: "succeeded" }),
    session({ createdAt: "not a date", status: "preparing", utteranceCount: 5, summaryStatus: "failed" }),
  ];
  assert.deepEqual(summarizeSessions(rows, NOW), { today: 1, live: 1, utterances7d: 20, summaryFailures: 2 });
  assert.deepEqual(summarizeSessions([], NOW), { today: 0, live: 0, utterances7d: 0, summaryFailures: 0 });
});

test("countActiveSessions is the number a deploy will switch immediately: preparing and live only", () => {
  const rows = [session({ status: "live" }), session({ status: "preparing" }), session({ status: "paused" }), session({ status: "stopped" }), session({ status: "failed" })];
  assert.equal(countActiveSessions(rows), 2);
  assert.equal(countActiveSessions([]), 0);
});

test("filterTranslationOptions hides combined engines whose STT provider is not selected", () => {
  assert.deepEqual(filterTranslationOptions(catalog, "gemini").map((entry) => entry.model), ["gemini-3.6-flash", "gemini-3.7-flash"]);
  assert.deepEqual(filterTranslationOptions(catalog, "soniox").map((entry) => `${entry.provider}/${entry.model}`), ["gemini/gemini-3.6-flash", "gemini/gemini-3.7-flash", "soniox/stt-rt-v5"]);
});

test("languageModesFor follows the STT entry and falls back to auto for an unknown entry", () => {
  assert.deepEqual(languageModesFor(catalog, "gemini", "gemini-3.5-transcribe-live"), ["auto"]);
  assert.deepEqual(languageModesFor(catalog, "soniox", "stt-rt-v5"), ["auto", "ko", "en"]);
  assert.deepEqual(languageModesFor(catalog, "nope", "x"), ["auto"]);
});

test("reconcileEngineSelection repairs a translation or language mode the new STT no longer allows", () => {
  const sonioxCombined = { ...geminiEngine, stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" }, translation: { provider: "soniox", model: "stt-rt-v5" } };
  const backToGemini = reconcileEngineSelection(catalog, { ...sonioxCombined, stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "ko" } });
  assert.deepEqual(backToGemini, geminiEngine);
  // A valid selection is returned unchanged (same reference), so a dirty check stays honest.
  assert.equal(reconcileEngineSelection(catalog, geminiEngine), geminiEngine);
  assert.equal(reconcileEngineSelection(catalog, sonioxCombined), sonioxCombined);
});

test("isEngineDirty compares the three roles plus the STT language mode structurally", () => {
  assert.equal(isEngineDirty(geminiEngine, { ...geminiEngine }), false);
  assert.equal(isEngineDirty(geminiEngine, { ...geminiEngine, stt: { ...geminiEngine.stt, languageMode: "ko" } }), true);
  assert.equal(isEngineDirty(geminiEngine, { ...geminiEngine, translation: { provider: "gemini", model: "gemini-3.7-flash" } }), true);
  assert.equal(isEngineDirty(geminiEngine, null), false);
  assert.equal(isEngineDirty(null, geminiEngine), false);
});

test("label keys map every status to a message key and never fall through to raw values", () => {
  assert.deepEqual(["pending", "approved", "rejected", "disabled"].map(statusLabelKey), ["대기", "승인", "반려", "비활성"]);
  assert.deepEqual(["preparing", "live", "paused", "stopped", "failed", "weird"].map(sessionStatusLabelKey), ["준비 중", "진행 중", "일시 정지", "종료됨", "실패", "종료됨"]);
  assert.deepEqual((["succeeded", "running", "failed", null] as const).map(summaryStatusLabelKey), ["요약 완료", "요약 중", "요약 실패", "요약 없음"]);
  assert.deepEqual([...rejectReasons], ["unverified", "duplicate", "other"]);
});

test("deploy result labels never fall through: an unknown result reads as 실패, a known code maps to console copy, an unknown code stays raw", () => {
  assert.deepEqual(["switched", "queued", "failed", "exploded"].map(deployResultLabelKey), ["전환됨", "대기열", "실패", "실패"]);
  assert.equal(deployCodeLabelKey("ENGINE_INVALID"), "지원하지 않는 엔진 조합입니다.");
  assert.equal(deployCodeLabelKey("CONSOLE_STORE_UNAVAILABLE"), "콘솔 저장소에 연결할 수 없습니다.");
  // A gateway code the console does not know is shown verbatim so the operator can still search for it.
  assert.equal(deployCodeLabelKey("GATEWAY_UNREACHABLE"), "GATEWAY_UNREACHABLE");
});

test("formatConsoleDate renders Asia/Seoul wall time with the zone visible, and nothing for a missing or invalid value", () => {
  for (const locale of ["ko-KR", "en-US", "ja-JP"]) {
    const text = formatConsoleDate("2026-09-04T09:30:00.000Z", locale);
    assert.match(text, /GMT\+9/u, locale);
    assert.match(text, /(?:06|18):30/u, locale);
  }
  assert.equal(formatConsoleDate(null, "ko-KR"), "");
  assert.equal(formatConsoleDate("not a date", "ko-KR"), "");
});
