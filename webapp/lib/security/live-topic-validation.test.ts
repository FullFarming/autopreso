import assert from "node:assert/strict";
import test from "node:test";

import {
  parseLiveTopic,
  parseLiveTopicMembership,
  parseLiveTopicSnapshot,
  parseLiveTopicUpsertEvent,
  privateNoStoreHeaders,
} from "./live-topic-validation";

const sessionId = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";
const otherSessionId = "0192d0f4-9f72-7a36-91f5-6a76ef736f42";
const topicId = "0192d0f4-9f72-7a36-91f5-6a76ef736f43";

function activeTopic(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: topicId,
    sessionId,
    ordinal: 1,
    title: "투자 전략",
    summary: null,
    status: "active",
    completionReason: null,
    detectorHealth: "healthy",
    startedAt: "2026-08-15T01:02:03.000Z",
    completedAt: null,
    version: 1,
    ...overrides,
  };
}

function membership(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId,
    topicId,
    utteranceKey: "gateway:source:7",
    position: 1,
    ...overrides,
  };
}

function snapshotTopic(index: number): Record<string, unknown> {
  const id = `0192d0f4-9f72-7a36-91f5-${(index + 1).toString(16).padStart(12, "0")}`;
  return index === 0
    ? activeTopic({ id })
    : activeTopic({
      id,
      ordinal: index + 1,
      status: "completed",
      completionReason: "semantic_shift",
      completedAt: "2026-08-15T01:03:03.000Z",
    });
}

function snapshotMembership(index: number, snapshotTopicId: string = topicId): Record<string, unknown> {
  return membership({
    topicId: snapshotTopicId,
    utteranceKey: `gateway:source:${index + 1}`,
    position: index + 1,
  });
}

test("topic parser accepts bounded public metadata and enforces lifecycle invariants", () => {
  assert.deepEqual(parseLiveTopic(activeTopic(), sessionId), activeTopic());
  assert.deepEqual(parseLiveTopic(activeTopic({
    summary: "결정된 투자 기준을 검토했습니다.",
    status: "completed",
    completionReason: "semantic_shift",
    detectorHealth: "degraded",
    completedAt: "2026-08-15T01:03:03.000Z",
    version: Number.MAX_SAFE_INTEGER,
  }), sessionId), activeTopic({
    summary: "결정된 투자 기준을 검토했습니다.",
    status: "completed",
    completionReason: "semantic_shift",
    detectorHealth: "degraded",
    completedAt: "2026-08-15T01:03:03.000Z",
    version: Number.MAX_SAFE_INTEGER,
  }));

  for (const invalid of [
    activeTopic({ status: "completed", completionReason: null, completedAt: null }),
    activeTopic({ status: "active", completionReason: "silence" }),
    activeTopic({ status: "active", completedAt: "2026-08-15T01:03:03.000Z" }),
    activeTopic({ status: "failed" }),
    activeTopic({ completionReason: "fallback" }),
    activeTopic({ detectorHealth: "unknown" }),
    activeTopic({ ordinal: 0 }),
    activeTopic({ version: Number.MAX_SAFE_INTEGER + 1 }),
    activeTopic({ completedAt: "not-a-date" }),
  ]) assert.throws(() => parseLiveTopic(invalid, sessionId));
});

test("topic text is NFC plain text with codepoint limits and hostile AI output is rejected", () => {
  assert.equal(parseLiveTopic(activeTopic({ title: "가".repeat(120) }), sessionId).title.length, 120);
  assert.equal(parseLiveTopic(activeTopic({ summary: "요".repeat(500) }), sessionId).summary?.length, 500);

  for (const title of [
    "", "가".repeat(121), "e\u0301", "<script>alert(1)</script>", "safe\u0000unsafe",
    "safe\u200Eunsafe", "safe\u202Eunsafe", "safe\u2066unsafe",
  ]) assert.throws(() => parseLiveTopic(activeTopic({ title }), sessionId));

  for (const summary of [
    "요".repeat(501), "e\u0301", "<svg onload=alert(1)>", "safe\u0008unsafe",
    "safe\u200Funsafe", "safe\u202Aunsafe", "safe\u2069unsafe",
  ]) assert.throws(() => parseLiveTopic(activeTopic({ summary }), sessionId));
});

test("topic and membership parsers reject cross-session data, unsafe integers, markup, and PII keys", () => {
  assert.deepEqual(parseLiveTopicMembership(membership(), sessionId), membership());
  for (const invalid of [
    activeTopic({ sessionId: otherSessionId }),
    activeTopic({ email: "private@example.com" }),
    activeTopic({ company: "Private Co" }),
    activeTopic({ token: "opaque-secret" }),
  ]) assert.throws(() => parseLiveTopic(invalid, sessionId));

  for (const invalid of [
    membership({ sessionId: otherSessionId }),
    membership({ topicId: "not-a-uuid" }),
    membership({ position: 0 }),
    membership({ position: Number.MAX_SAFE_INTEGER + 1 }),
    membership({ utteranceKey: "" }),
    membership({ utteranceKey: "<topic>" }),
    membership({ utteranceKey: "safe\u202Eunsafe" }),
    membership({ email: "private@example.com" }),
  ]) assert.throws(() => parseLiveTopicMembership(invalid, sessionId));
});

test("topic upsert events are strict, session-bound, and contain only public metadata", () => {
  const event = {
    type: "topic-upsert",
    sessionId,
    topic: activeTopic(),
    membershipsAdded: [membership()],
  };
  assert.deepEqual(parseLiveTopicUpsertEvent(event, sessionId), event);
  const fiftyMemberships = Array.from({ length: 50 }, (_value, index) => membership({
    utteranceKey: `gateway:source:${index + 1}`,
    position: index + 1,
  }));
  assert.equal(parseLiveTopicUpsertEvent({ ...event, membershipsAdded: fiftyMemberships }, sessionId).membershipsAdded.length, 50);

  for (const invalid of [
    { ...event, type: "topic" },
    { ...event, sessionId: otherSessionId },
    { ...event, topic: activeTopic({ sessionId: otherSessionId }) },
    { ...event, membershipsAdded: [membership({ sessionId: otherSessionId })] },
    { ...event, email: "private@example.com" },
    { ...event, membershipsAdded: [...fiftyMemberships, membership({ utteranceKey: "gateway:source:51", position: 51 })] },
    { ...event, membershipsAdded: [membership(), membership()] },
    { ...event, membershipsAdded: [membership(), membership({ utteranceKey: "gateway:source:8" })] },
  ]) assert.throws(() => parseLiveTopicUpsertEvent(invalid, sessionId));
});

test("topic snapshots bound arrays and require memberships to reference included session topics", () => {
  const snapshot = { topics: [activeTopic()], topicMemberships: [membership()] };
  assert.deepEqual(parseLiveTopicSnapshot(snapshot, sessionId), snapshot);
  assert.deepEqual(parseLiveTopicSnapshot({ topics: [], topicMemberships: [] }, sessionId), {
    topics: [], topicMemberships: [],
  });
  const fiftyMemberships = Array.from({ length: 50 }, (_value, index) => membership({
    utteranceKey: `gateway:source:${index + 1}`,
    position: index + 1,
  }));
  assert.equal(parseLiveTopicSnapshot({ ...snapshot, topicMemberships: fiftyMemberships }, sessionId).topicMemberships.length, 50);

  for (const invalid of [
    { ...snapshot, topicMemberships: [membership({ topicId: otherSessionId })] },
    { ...snapshot, grantId: otherSessionId },
    { topics: [activeTopic(), activeTopic()], topicMemberships: [] },
    { topics: [activeTopic(), activeTopic({ id: otherSessionId, ordinal: 1 })], topicMemberships: [] },
    { topics: [activeTopic(), activeTopic({ id: otherSessionId, ordinal: 2 })], topicMemberships: [] },
  ]) assert.throws(() => parseLiveTopicSnapshot(invalid, sessionId));
});

test("topic snapshots accept the full committed-caption recovery window and reject one item beyond it", () => {
  const topics = Array.from({ length: 1_000 }, (_value, index) => snapshotTopic(index));
  const snapshotTopicId = String(topics[0]?.id);
  const topicMemberships = Array.from(
    { length: 12_000 },
    (_value, index) => snapshotMembership(index, snapshotTopicId),
  );

  assert.equal(parseLiveTopicSnapshot({ topics, topicMemberships: [] }, sessionId).topics.length, 1_000);
  assert.throws(() => parseLiveTopicSnapshot({
    topics: [...topics, snapshotTopic(1_000)],
    topicMemberships: [],
  }, sessionId));
  assert.equal(
    parseLiveTopicSnapshot({ topics: [topics[0]], topicMemberships }, sessionId).topicMemberships.length,
    12_000,
  );
  assert.throws(() => parseLiveTopicSnapshot({
    topics: [topics[0]],
    topicMemberships: [...topicMemberships, snapshotMembership(12_000, snapshotTopicId)],
  }, sessionId));
});

test("private topic-bearing responses use an exact no-store cache policy", () => {
  assert.deepEqual(privateNoStoreHeaders(), { "Cache-Control": "private, no-store" });
});
