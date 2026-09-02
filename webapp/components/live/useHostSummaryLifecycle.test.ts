import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SUMMARY_EMPTY_CODES,
  SUMMARY_RESET_FAILURE_CODES,
  getSafeSummaryErrorMessage,
  isSummaryEmptyCode,
  shouldResetSummaryGeneration,
} from "./useHostSummaryLifecycle";

const lifecycle = readFileSync(new URL("./useHostSummaryLifecycle.ts", import.meta.url), "utf8");

test("every failure class a host cannot poll out of authorizes exactly one reset request", () => {
  assert.deepEqual([...SUMMARY_RESET_FAILURE_CODES], [
    "SUMMARY_GENERATION_RETRYABLE_FAILED",
    "SUMMARY_GENERATION_PERMANENT_FAILED",
    "SUMMARY_GENERATION_EXHAUSTED",
  ]);
  for (const code of SUMMARY_RESET_FAILURE_CODES) assert.equal(shouldResetSummaryGeneration(code), true);
  // A request that never reached the API is also unrecoverable by polling.
  assert.equal(shouldResetSummaryGeneration("SUMMARY_REQUEST_FAILED"), true);
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
