import assert from "node:assert/strict";
import test from "node:test";

import { createCrossChannelEchoDeduper } from "../packages/caption-core/index.js";
import { createCrossChannelEchoRegistry } from "../src/subtitle-realtime.js";

function makePair(now) {
  return {
    reference: createCrossChannelEchoRegistry(),
    shared: createCrossChannelEchoDeduper({ now }),
  };
}

test("shared echo deduper matches Caption-only suppression and expiry", () => {
  const originalNow = Date.now;
  let timestamp = 10_000;
  Date.now = () => timestamp;
  try {
    const pair = makePair(() => timestamp);
    for (const registry of Object.values(pair)) {
      registry.recordSource("system:ko", "We are reviewing the hotel market today.");
    }
    assert.equal(
      pair.shared.outputEchoesAnotherSource("mic:ko", "We are reviewing the hotel market today"),
      pair.reference.outputEchoesAnotherSource("mic:ko", "We are reviewing the hotel market today"),
    );

    timestamp += 6_001;
    assert.equal(
      pair.shared.outputEchoesAnotherSource("mic:ko", "We are reviewing the hotel market today"),
      pair.reference.outputEchoesAnotherSource("mic:ko", "We are reviewing the hotel market today"),
    );
  } finally {
    Date.now = originalNow;
  }
});

test("shared echo deduper matches Caption-only retroactive partial clearing", () => {
  const pair = makePair(() => Date.now());
  for (const registry of Object.values(pair)) {
    let cleared = 0;
    registry.registerChannel("mic:ko", {
      getLastPartial: () => "We are reviewing the hotel market",
      clearEcho: () => { cleared += 1; },
    });
    registry.recordSource("system:ko", "We are reviewing the hotel market today");
    assert.equal(cleared, 1);
  }
});

test("same words are accepted when genuinely repeated outside the echo window", () => {
  let timestamp = 1_000;
  const deduper = createCrossChannelEchoDeduper({ now: () => timestamp });
  deduper.recordSource("system:en", "동일 문장을 다시 말합니다");
  assert.equal(deduper.outputEchoesAnotherSource("mic:en", "동일 문장을 다시 말합니다"), true);
  timestamp += 6_001;
  assert.equal(deduper.outputEchoesAnotherSource("mic:en", "동일 문장을 다시 말합니다"), false);
});

test("source observation atomically identifies system and mic capture of the same utterance", () => {
  let timestamp = 1_000;
  const deduper = createCrossChannelEchoDeduper({ now: () => timestamp });
  assert.deepEqual(deduper.observeSource("system:ko", "We are reviewing the market."), {
    normalizedText: "wearereviewingthemarket",
    isDuplicate: false,
  });
  timestamp += 80;
  assert.equal(deduper.observeSource("mic:ko", "We are reviewing the market").isDuplicate, true);
  timestamp += 6_001;
  assert.equal(deduper.observeSource("mic:ko", "We are reviewing the market").isDuplicate, false);
});
