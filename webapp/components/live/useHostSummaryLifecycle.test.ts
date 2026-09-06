import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SUMMARY_EMPTY_CODES,
  SUMMARY_RESET_FAILURE_CODES,
  getSafeSummaryErrorMessage,
  isSummaryEmptyCode,
  isSummaryReadRetryable,
  shouldResetSummaryGeneration,
} from "./useHostSummaryLifecycle";

const lifecycle = readFileSync(new URL("./useHostSummaryLifecycle.ts", import.meta.url), "utf8");

test("every failure class a host cannot poll out of authorizes a reset request, bounded by the per-host-session summary rate limit", () => {
  assert.deepEqual([...SUMMARY_RESET_FAILURE_CODES], [
    "SUMMARY_GENERATION_RETRYABLE_FAILED",
    "SUMMARY_GENERATION_PERMANENT_FAILED",
    "SUMMARY_GENERATION_EXHAUSTED",
  ]);
  for (const code of SUMMARY_RESET_FAILURE_CODES) assert.equal(shouldResetSummaryGeneration(code), true);
  // A missing response leaves generation unknown; only GET can establish its state.
  assert.equal(shouldResetSummaryGeneration("SUMMARY_REQUEST_FAILED"), false);
  for (const pollableCode of ["", "SUMMARY_NOT_READY", "SUMMARY_GENERATION_RUNNING"]) {
    assert.equal(shouldResetSummaryGeneration(pollableCode), false,
      "a running or not-yet-ready generation must keep polling instead of resetting");
  }
  for (const code of SUMMARY_EMPTY_CODES) {
    assert.equal(shouldResetSummaryGeneration(code), false, "there is nothing to regenerate from an empty record");
  }
  assert.equal(shouldResetSummaryGeneration("SUMMARY_FORBIDDEN"), false);
});

test("an empty record is recognized from both the current and the legacy API code", () => {
  assert.deepEqual([...SUMMARY_EMPTY_CODES], ["SUMMARY_NO_UTTERANCES", "NO_UTTERANCES"]);
  for (const code of SUMMARY_EMPTY_CODES) assert.equal(isSummaryEmptyCode(code), true);
  assert.equal(isSummaryEmptyCode(""), false);
  assert.equal(isSummaryEmptyCode(undefined), false);
  assert.equal(isSummaryEmptyCode("SUMMARY_GENERATION_PERMANENT_FAILED"), false);
  // An empty record must never be described with failure copy.
  for (const code of SUMMARY_EMPTY_CODES) {
    assert.equal(getSafeSummaryErrorMessage(code), "");
  }
  assert.equal(getSafeSummaryErrorMessage("SUMMARY_GENERATION_PERMANENT_FAILED"), "회의 요약을 생성하지 못했습니다. 관리자에게 문의해 주세요.");
});

test("the host recovery request carries the reset flag behind the existing single-flight guard", () => {
  const start = lifecycle.indexOf("const retrySummary");
  const end = lifecycle.indexOf("useEffect(() =>", start);
  assert.ok(start >= 0 && end > start);
  const retry = lifecycle.slice(start, end);
  assert.match(retry, /!shouldResetSummaryGeneration\(summaryFailureCode\)/u);
  assert.equal(retry.match(/method: "POST"/gu)?.length, 1, "one operator action must make exactly one request");
  assert.ok(retry.indexOf("if (retryRef.current") < retry.indexOf("method: \"POST\""));
  assert.match(retry, /body: JSON\.stringify\(\{ language, reset: true \}\)/u);
  assert.match(lifecycle, /shouldResetSummaryGeneration\(summaryFailureCode\)\)? void retrySummary\(\)/u);
});

test("the recovery POST shows the skeleton while it runs instead of the failure branch it is meant to clear", () => {
  const start = lifecycle.indexOf("const retrySummary");
  const end = lifecycle.indexOf("useEffect(() =>", start);
  const retry = lifecycle.slice(start, end);
  const request = retry.indexOf("await fetch");
  assert.ok(request > 0);
  const beforeRequest = retry.slice(0, request);
  // The POST is the generation itself: MeetingMinutes renders the skeleton
  // only while pollingState is "polling", so it must be set before the await,
  // after the single-flight guard, with a fresh elapsed-time origin.
  assert.ok(beforeRequest.indexOf("if (retryRef.current") < beforeRequest.indexOf('setPollingState("polling")'),
    "the single-flight guard runs first; a rejected duplicate click must not reset the state");
  assert.match(beforeRequest, /setPollingState\("polling"\);\s*\n\s*setPollingStartedAt\(Date\.now\(\)\);/u,
    "the skeleton and its elapsed-time origin start before the POST is awaited");
  // A failed POST still reverts to the failure classes, as before.
  assert.match(retry, /if \(!payload\.ok\) \{[\s\S]*setPollingState\(payload\.code === "SUMMARY_GENERATION_EXHAUSTED" \? "exhausted" : "failed"\)/u);
  assert.match(retry, /catch \{[\s\S]*setPollingRound\(\(round\) => round \+ 1\)/u);
  // The GET loop is keyed on pollingRound and may only restart once the POST
  // has answered; the pre-request block must not touch it.
  assert.doesNotMatch(beforeRequest, /setPollingRound/u);
});

test("a POST answered with SUMMARY_GENERATION_RUNNING keeps polling: another worker holds the lane the host asked for", () => {
  const start = lifecycle.indexOf("const retrySummary");
  const end = lifecycle.indexOf("useEffect(() =>", start);
  const retry = lifecycle.slice(start, end);
  const rejected = retry.indexOf("if (!payload.ok)");
  const running = retry.indexOf('payload.code === "SUMMARY_GENERATION_RUNNING"', rejected);
  assert.ok(rejected > 0 && running > rejected, "the running answer is handled inside the rejected-payload branch");
  const runningBranch = retry.slice(running, retry.indexOf("return;", running));
  assert.match(runningBranch, /setSummaryFailureCode\(""\)/u, "a running generation is not a failure code to retain");
  assert.match(runningBranch, /setPollingRound\(\(round\) => round \+ 1\)/u, "the GET loop must resume to pick up the other worker's result");
  assert.doesNotMatch(runningBranch, /setPollingState\("failed"\)|setPollingState\("exhausted"\)|setSummaryError\(getSafe/u,
    "a running generation must never be rendered as a failure");
});

test("an empty record stops polling without an error state or a retry affordance", () => {
  const start = lifecycle.indexOf("const loadSummary");
  const end = lifecycle.indexOf("const loadTranscript", start);
  const load = lifecycle.slice(start, end);
  assert.match(load, /isSummaryEmptyCode\(payload\.code\)/u);
  assert.match(load, /isSummaryEmptyCode\(payload\.code\)[\s\S]{0,320}setSummaryError\(""\)/u,
    "an empty record must never be shown as an error");
  assert.match(load, /isSummaryEmptyCode\(payload\.code\)[\s\S]{0,320}return false/u,
    "an empty record is terminal: polling must stop");
  assert.match(lifecycle, /isSummaryEmpty/u);
  assert.match(lifecycle, /if \(!endedSession \|\| summary \|\| isSummaryEmpty\) return;/u,
    "a settled empty record must not restart the poll loop");
});

test("read transport failures never authorize regeneration or mask an authoritative terminal state", () => {
  for (const status of [0, 408, 429, 500, 502, 503, 504]) assert.equal(isSummaryReadRetryable(undefined, status), true);
  for (const code of ["SUMMARY_READ_TIMEOUT", "SUMMARY_STATE_FAILED", "SUMMARY_READY_MISSING", "SUMMARY_READ_FAILED"])
    assert.equal(isSummaryReadRetryable(code, 504), true);
  for (const code of SUMMARY_RESET_FAILURE_CODES) assert.equal(isSummaryReadRetryable(code, 503), false);
  assert.equal(isSummaryReadRetryable("SUMMARY_FORBIDDEN", 403), false);
  assert.equal(isSummaryReadRetryable("SUMMARY_REFUSED", 502), false);
  const exhausted = lifecycle.slice(lifecycle.indexOf("onExhausted:"), lifecycle.indexOf("onError:"));
  assert.doesNotMatch(exhausted, /SUMMARY_GENERATION_EXHAUSTED/);
  assert.match(exhausted, /SUMMARY_REQUEST_FAILURE_CODE/);
});
