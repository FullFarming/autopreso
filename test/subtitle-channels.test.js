import assert from "node:assert/strict";
import { test } from "node:test";

import { createSubtitleChannelHub } from "../src/subtitle-channels.js";

function partial(targetLanguage, text, source = "system") {
  return { type: "subtitle:partial", source, targetLanguage, sourceLanguage: "ko", translationRole: 1, sourceText: "원문", translatedText: text };
}

function committed(targetLanguage, text, source = "system") {
  return { type: "subtitle:committed", source, targetLanguage, sourceLanguage: "ko", translationRole: 1, sourceText: "원문", translatedText: text };
}

test("ingest stamps a monotonically increasing seq on subtitle line messages", () => {
  const hub = createSubtitleChannelHub();
  const a = hub.ingest(partial("en", "hello"));
  const b = hub.ingest(committed("en", "hello world"));
  assert.equal(typeof a.seq, "number");
  assert.equal(b.seq > a.seq, true);
});

test("retired translated-audio messages are never delivered or assigned caption sequence numbers", () => {
  const hub = createSubtitleChannelHub();
  const audio = hub.ingest({ type: "subtitle:translated-audio", source: "mic", targetLanguage: "ko", audio: "AAAA", sampleRate: 24_000 });
  const clear = hub.ingest({ type: "subtitle:audio-control", source: "mic", targetLanguage: "ko", action: "clear", reason: "interrupted" });
  assert.equal(audio.seq, undefined);
  assert.equal(clear.seq, undefined);
  assert.equal(hub.shouldSend({}, audio), false);
  assert.equal(hub.shouldSend({}, clear), false);
});

test("clients receive everything until they subscribe", () => {
  const hub = createSubtitleChannelHub();
  const client = {};
  assert.equal(hub.shouldSend(client, hub.ingest(partial("en", "hello"))), true);
  assert.equal(hub.shouldSend(client, hub.ingest(partial("ja", "こんにちは"))), true);
  // Non-lane messages (no targetLanguage) always pass.
  assert.equal(hub.shouldSend(client, { type: "subtitle:status", status: "listening" }), true);
});

test("a subscribed client only receives its languages, plus global messages", () => {
  const hub = createSubtitleChannelHub();
  const client = {};
  hub.subscribe(client, ["ja"]);
  assert.equal(hub.shouldSend(client, hub.ingest(partial("ja", "こんにちは"))), true);
  assert.equal(hub.shouldSend(client, hub.ingest(partial("en", "hello"))), false);
  assert.equal(hub.shouldSend(client, hub.ingest({ type: "subtitle:clear", source: "system", targetLanguage: "en", reason: "silence" })), false);
  assert.equal(hub.shouldSend(client, { type: "subtitle:status", status: "listening" }), true);
  assert.equal(hub.shouldSend(client, { type: "subtitle:error", message: "x", code: "Y" }), true);
});

test("subscribe(null) restores receive-all", () => {
  const hub = createSubtitleChannelHub();
  const client = {};
  hub.subscribe(client, ["ja"]);
  hub.subscribe(client, null);
  assert.equal(hub.shouldSend(client, hub.ingest(partial("en", "hello"))), true);
});

test("snapshot returns the last line per lane, filtered by subscription", () => {
  const hub = createSubtitleChannelHub();
  hub.ingest(partial("en", "hello"));
  hub.ingest(committed("en", "hello world"));
  hub.ingest(partial("ja", "こんにちは"));
  const all = hub.snapshotFor({});
  assert.equal(all.type, "subtitle:snapshot");
  assert.equal(typeof all.streamId, "string");
  assert.equal(all.lanes.length, 2);
  const client = {};
  hub.subscribe(client, ["en"]);
  const filtered = hub.snapshotFor(client);
  assert.equal(filtered.lanes.length, 1);
  assert.equal(filtered.lanes[0].targetLanguage, "en");
  assert.equal(filtered.lanes[0].translatedText, "hello world");
});

test("clear removes the lane; idle status clears all lanes", () => {
  const hub = createSubtitleChannelHub();
  hub.ingest(committed("en", "hello", "system"));
  hub.ingest(committed("en", "bonjour", "mic"));
  hub.ingest({ type: "subtitle:clear", source: "system", targetLanguage: "en", reason: "silence" });
  assert.equal(hub.snapshotFor({}).lanes.length, 1); // mic lane survives
  hub.ingest({ type: "subtitle:status", status: "idle" });
  assert.equal(hub.snapshotFor({}).lanes.length, 0);
});

test("removeClient drops the subscription state", () => {
  const hub = createSubtitleChannelHub();
  const client = {};
  hub.subscribe(client, ["ja"]);
  hub.removeClient(client);
  assert.equal(hub.shouldSend(client, hub.ingest(partial("en", "hello"))), true);
});

test("subscribe validates languages and ignores junk entries", () => {
  const hub = createSubtitleChannelHub();
  const client = {};
  hub.subscribe(client, ["ja", "klingon", 42]);
  assert.equal(hub.shouldSend(client, hub.ingest(partial("ja", "こんにちは"))), true);
  assert.equal(hub.shouldSend(client, hub.ingest(partial("en", "hello"))), false);
  // All-junk list → treated as receive-all (never silently blackhole a viewer).
  const other = {};
  hub.subscribe(other, ["klingon"]);
  assert.equal(hub.shouldSend(other, hub.ingest(partial("en", "hello"))), true);
});
