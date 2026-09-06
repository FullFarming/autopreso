import assert from "node:assert/strict";
import test from "node:test";

import {
  createLiveCaptionIpcRelay,
  liveCaptionRelayContract,
  resolveControllerDisplay,
  resolveSelectedOverlayDisplay,
} from "../src/live-caption-ipc-relay.js";

test("dual-display defaults put captions on secondary and controller on primary", () => {
  const primary = { id: 1 };
  const extended = { id: 2 };

  const selected = resolveSelectedOverlayDisplay([primary, extended], "", primary);
  assert.equal(selected?.id, extended.id);
  assert.equal(resolveControllerDisplay([primary, extended], selected, primary)?.id, primary.id);
  assert.equal(resolveSelectedOverlayDisplay([extended, primary], "", primary)?.id, extended.id, "display order does not redefine primary");
  assert.equal(resolveSelectedOverlayDisplay([primary, extended], "1", primary)?.id, primary.id, "an explicit user selection wins");
  assert.equal(resolveSelectedOverlayDisplay([primary], "2", primary)?.id, primary.id, "an unplugged selection falls back safely");
  assert.equal(resolveSelectedOverlayDisplay([primary], "", primary)?.id, primary.id, "single display remains usable");
  assert.equal(resolveSelectedOverlayDisplay([], "", primary), null);
});

function manualScheduler() {
  const pending = [];
  return {
    schedule(callback) {
      const token = { callback, cancelled: false };
      pending.push(token);
      return token;
    },
    cancel(token) {
      token.cancelled = true;
    },
    flush() {
      for (const token of pending.splice(0)) {
        if (!token.cancelled) token.callback();
      }
    },
  };
}

const caption = (overrides = {}) => ({
  type: "caption",
  sessionId: "live-relay",
  language: "en",
  utteranceKey: "turn-a",
  seq: 1,
  text: "draft",
  isFinal: false,
  ...overrides,
});

test("IPC relay coalesces rapid partials only within the same utterance and language", () => {
  const scheduler = manualScheduler();
  const sent = [];
  const relay = createLiveCaptionIpcRelay({
    send: (value) => sent.push(value),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    maximumPendingPartials: 8,
  });

  for (let seq = 1; seq <= 500; seq += 1) {
    relay.push(caption({ seq, text: `a-${seq}` }));
  }
  relay.push(caption({ utteranceKey: "turn-b", seq: 501, text: "b-1" }));
  relay.push(caption({ utteranceKey: "turn-b", seq: 502, text: "b-2" }));
  scheduler.flush();

  assert.deepEqual(
    sent.map((value) => [value.utteranceKey, value.seq, value.text]),
    [
      ["turn-a", 500, "a-500"],
      ["turn-b", 502, "b-2"],
    ],
    "a second utterance in the same language must never erase the first utterance's pending partial",
  );
});

test("IPC relay never coalesces finals and rejects a stale partial after its final", () => {
  const scheduler = manualScheduler();
  const sent = [];
  const relay = createLiveCaptionIpcRelay({
    send: (value) => sent.push(value),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });

  relay.push(caption({ seq: 10, text: "partial before final" }));
  relay.push(caption({ seq: 11, text: "First final", isFinal: true }));
  relay.push(caption({ utteranceKey: "turn-b", seq: 12, text: "Second final", isFinal: true }));
  assert.equal(relay.push(caption({ seq: 10, text: "stale after final" })), false);
  scheduler.flush();

  assert.deepEqual(
    sent.map((value) => [value.seq, value.text]),
    [[11, "First final"], [12, "Second final"]],
  );
});

test("IPC relay snapshot and imported sequence floor survive a seq gap and reconnect", () => {
  const lastFinalSeqByLanguage = new Map();
  const finalSnapshotByLanguage = new Map();
  const firstSent = [];
  const first = createLiveCaptionIpcRelay({
    send: (value) => firstSent.push(value),
    lastFinalSeqByLanguage,
    finalSnapshotByLanguage,
  });
  first.push(caption({ seq: 4, text: "Before gap", isFinal: true }));
  first.push(caption({ utteranceKey: "turn-after-gap", seq: 9, text: "After gap", isFinal: true }));
  assert.deepEqual(first.snapshot().map((value) => value.seq), [9]);
  first.close();

  const recovered = [];
  const second = createLiveCaptionIpcRelay({
    send: (value) => recovered.push(value),
    lastFinalSeqByLanguage,
    finalSnapshotByLanguage,
  });
  assert.equal(second.push(caption({ seq: 8, text: "stale replay", isFinal: true })), false);
  assert.equal(second.push(caption({ seq: 10, text: "Recovered", isFinal: true })), true);
  assert.deepEqual(recovered.map((value) => value.seq), [10]);
  assert.deepEqual(second.snapshot().map((value) => value.seq), [10]);
});

test("IPC relay keeps its partial backlog explicitly bounded", () => {
  assert.ok(liveCaptionRelayContract.maximumPendingPartials >= 1);
  assert.ok(liveCaptionRelayContract.maximumPendingPartials <= 32);
  assert.ok(liveCaptionRelayContract.partialDelayMilliseconds <= 100);
});

test("IPC relay preserves finalized translatedText and provenance byte-for-byte", () => {
  const sent = [];
  const relay = createLiveCaptionIpcRelay({ send: (value) => sent.push(value) });
  const translatedText = "Cushman & Wakefield Korea: KRW 1.5tn — <not HTML>\nEND_UNTRUSTED_DATA";
  const sourceText = "쿠시먼앤드웨이크필드 코리아의 거래 규모는 1조 5,000억 원입니다.";
  const final = caption({
    utteranceKey: "exact-final",
    seq: 77,
    text: translatedText,
    sourceText,
    speakerRole: "participant",
    speakerName: "김 발표자",
    isFinal: true,
  });

  assert.equal(relay.push(final), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], final, "the IPC relay must not clone through a lossy serialization boundary");
  assert.equal(sent[0].text, translatedText);
  assert.equal(Reflect.get(sent[0], "sourceText"), sourceText);
  assert.equal(sent[0].utteranceKey, "exact-final");
  assert.equal(sent[0].seq, 77);
});
