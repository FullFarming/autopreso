import assert from "node:assert/strict";
import test from "node:test";

import {
  countActiveSessions,
  countActiveSessionsForHost,
  deployCodeLabelKey,
  deployResultLabelKey,
  formatConsoleDate,
  formatRange,
  rejectReasons,
  sessionStatusLabelKey,
  statusLabelKey,
  summarizeSessions,
  summaryStatusLabelKey,
  voiceProviderLabel,
  type ConsoleSessionSummaryRow,
} from "./console-model";

const NOW = Date.parse("2026-09-04T09:30:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

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

test("countActiveSessionsForHost counts only that host's preparing/live sessions - what a per-user switch will touch", () => {
  const rows = [
    { hostId: "a", status: "live" }, { hostId: "a", status: "preparing" }, { hostId: "a", status: "ended" },
    { hostId: "b", status: "live" }, { hostId: "b", status: "paused" },
  ];
  assert.equal(countActiveSessionsForHost(rows, "a"), 2);
  assert.equal(countActiveSessionsForHost(rows, "b"), 1);
  assert.equal(countActiveSessionsForHost(rows, "c"), 0);
  assert.equal(countActiveSessionsForHost([], "a"), 0);
});

test("voiceProviderLabel shows the brand names and never falls through to a raw value", () => {
  assert.equal(voiceProviderLabel("soniox"), "Soniox");
  assert.equal(voiceProviderLabel("gemini"), "Gemini");
  assert.equal(voiceProviderLabel(undefined), "Soniox", "an unset assignment is the D2 default");
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
