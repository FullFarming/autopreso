import assert from "node:assert/strict";
import test from "node:test";

import { createSourceLanguageConsensus } from "../packages/caption-core/index.js";
import { createCrossChannelEchoRegistry } from "../src/subtitle-realtime.js";

function withFakeClock(run) {
  const originalNow = Date.now;
  let timestamp = 10_000;
  Date.now = () => timestamp;
  try {
    run({ advance(milliseconds) { timestamp += milliseconds; } });
  } finally {
    Date.now = originalNow;
  }
}

function makePair() {
  return {
    reference: createCrossChannelEchoRegistry(),
    shared: createSourceLanguageConsensus(),
  };
}

function report(pair, channelKey, language, sourceText, options = {}) {
  pair.reference.reportSource(channelKey, language, sourceText, options);
  pair.shared.reportSource(channelKey, language, sourceText, options);
}

function assertResolved(pair, fallback = "unknown", options = {}) {
  assert.equal(pair.shared.resolveSource(fallback, options), pair.reference.resolveSource(fallback, options));
}

test("shared consensus matches captions-only for fresh consensus, disagreement and sustained-English switching", () => {
  withFakeClock(({ advance }) => {
    const pair = makePair();
    report(pair, "ko", "ko", "오늘 세션을 시작하겠습니다", { isStrong: true });
    report(pair, "en", "ko", "오늘 세션을 시작하겠습니다", { isStrong: true });
    assertResolved(pair, "unknown");

    advance(2_100);
    pair.reference.resetSource("ko");
    pair.reference.resetSource("en");
    pair.shared.resetSource("ko");
    pair.shared.resetSource("en");
    report(pair, "ko", "en", "We now genuinely switch to the English section", { isStrong: true });
    report(pair, "en", "ko", "예스 나우 잉글리시 섹션", { isStrong: true });
    assertResolved(pair, "en", { isStrong: true, channelKey: "ko" });
    assertResolved(pair, "ko", { isStrong: true, channelKey: "en" });
  });
});

test("shared consensus matches captions-only when recent tail changes from English to Korean", () => {
  withFakeClock(() => {
    const pair = makePair();
    report(pair, "ko", "en", "We are seeing strong demand across the office market");
    report(pair, "en", "ko", "위 아 씨잉 스트롱 디맨드");
    assertResolved(pair, "unknown");

    const mixed = "We are seeing strong demand across the office market. 이제부터 한국어로 시장 전망을 말씀드리겠습니다";
    report(pair, "ko", "ko", mixed);
    report(pair, "en", "ko", mixed);
    assertResolved(pair, "unknown");
  });
});

test("shared consensus matches captions-only solo fallback after 15 seconds and 8 strong reports", () => {
  withFakeClock(({ advance }) => {
    const pair = makePair();
    report(pair, "ko", "ko", "한국어 합의입니다", { isStrong: true });
    report(pair, "en", "ko", "한국어 합의입니다", { isStrong: true });
    pair.reference.resetSource("ko");
    pair.reference.resetSource("en");
    pair.shared.resetSource("ko");
    pair.shared.resetSource("en");

    for (let index = 0; index < 8; index += 1) {
      advance(2_100);
      report(pair, "ko", "en", "Only the surviving channel reports sustained English speech", { isStrong: true });
      pair.reference.resetSource("ko");
      pair.shared.resetSource("ko");
      assertResolved(pair, "en", { isStrong: true, channelKey: "ko" });
    }
    report(pair, "ko", "en", "Only the surviving channel reports sustained English speech", { isStrong: true });
    assertResolved(pair, "en", { isStrong: true, channelKey: "ko" });
  });
});

test("shared channel clear and speaker reset preserve captions-only reset semantics", () => {
  withFakeClock(() => {
    const pair = makePair();
    report(pair, "ko", "en", "We are discussing the hotel market today");
    report(pair, "en", "en", "We are discussing the hotel market today");
    pair.reference.resetSource("ko");
    pair.shared.clearChannel("ko");
    assertResolved(pair, "unknown");
    pair.reference.resetSource();
    pair.shared.resetForSpeakerBoundary();
    assertResolved(pair, "ko");
  });
});
