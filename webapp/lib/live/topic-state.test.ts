import assert from "node:assert/strict";
import test from "node:test";

import type { LiveTopicPublicMetadata, LiveTopicUpsertEvent } from "../live-contract";
import { applyLiveTopicUpsert, createLiveTopicState, mergeLiveTopicSnapshot, projectTopicMemberships } from "./topic-state";

const sessionId = "0192d0f4-9f72-7a36-91f5-6a76ef736f42";
const firstTopicId = "0192d0f4-9f72-7a36-91f5-6a76ef736f43";
const secondTopicId = "0192d0f4-9f72-7a36-91f5-6a76ef736f44";

function topic(overrides: Partial<LiveTopicPublicMetadata> = {}): LiveTopicPublicMetadata {
  return {
    id: firstTopicId,
    sessionId,
    ordinal: 1,
    title: "Revenue outlook",
    summary: null,
    status: "active",
    completionReason: null,
    detectorHealth: "healthy",
    startedAt: "2026-08-15T00:00:00.000Z",
    completedAt: null,
    version: 1,
    ...overrides,
  };
}

function event(topicValue: LiveTopicPublicMetadata, utteranceKey = "gateway:source:1"): LiveTopicUpsertEvent {
  return {
    type: "topic-upsert",
    sessionId,
    topic: topicValue,
    membershipsAdded: [{ sessionId, topicId: topicValue.id, utteranceKey, position: 1 }],
  };
}

test("topic live events are session-fenced, version-monotonic, and membership-idempotent", () => {
  const initial = createLiveTopicState(sessionId);
  const current = applyLiveTopicUpsert(initial, event(topic({ version: 2 })));
  const replayed = applyLiveTopicUpsert(current, event(topic({ version: 2 })));
  const stale = applyLiveTopicUpsert(replayed, event(topic({ title: "stale", version: 1 })));

  assert.equal(stale.topics[0]?.title, "Revenue outlook");
  assert.equal(stale.topicMemberships.length, 1);
  assert.throws(() => applyLiveTopicUpsert(stale, { ...event(topic()), sessionId: secondTopicId }));
});

test("same-version filler events add membership without replacing topic metadata", () => {
  const current = applyLiveTopicUpsert(createLiveTopicState(sessionId), event(topic({ version: 2 })));
  const filler = applyLiveTopicUpsert(current, {
    ...event(topic({ title: "Ignored replay metadata", version: 2 }), "gateway:source:2"),
    membershipsAdded: [{
      sessionId,
      topicId: firstTopicId,
      utteranceKey: "gateway:source:2",
      position: 2,
    }],
  });

  assert.equal(filler.topics[0]?.title, "Revenue outlook");
  assert.deepEqual(filler.topicMemberships.map((membership) => membership.utteranceKey), [
    "gateway:source:1",
    "gateway:source:2",
  ]);
});

test("a topic completion is final against stale events and only one topic remains active", () => {
  const active = applyLiveTopicUpsert(createLiveTopicState(sessionId), event(topic({ version: 2 })));
  const completedTopic = topic({
    status: "completed",
    completionReason: "semantic_shift",
    completedAt: "2026-08-15T00:01:00.000Z",
    summary: "Revenue guidance was discussed.",
    version: 3,
  });
  const completed = applyLiveTopicUpsert(active, event(completedTopic));
  const staleReactivation = applyLiveTopicUpsert(completed, event(topic({ version: 2 })));
  const next = applyLiveTopicUpsert(staleReactivation, event(topic({
    id: secondTopicId,
    ordinal: 2,
    title: "AI investment",
    version: 1,
  }), "gateway:source:2"));

  assert.equal(next.topics.find((value) => value.id === firstTopicId)?.status, "completed");
  assert.deepEqual(next.topics.filter((value) => value.status === "active").map((value) => value.id), [secondTopicId]);
});

test("a late snapshot cannot overwrite newer live topic versions or memberships", () => {
  const live = applyLiveTopicUpsert(createLiveTopicState(sessionId), event(topic({ title: "Live title", version: 4 })));
  const merged = mergeLiveTopicSnapshot(live, {
    topics: [topic({ title: "Late snapshot", version: 2 })],
    topicMemberships: [],
  });

  assert.equal(merged.topics[0]?.title, "Live title");
  assert.equal(merged.topicMemberships.length, 1);
});

test("late snapshot followed by a replayed topic event never duplicates membership", () => {
  const live = applyLiveTopicUpsert(createLiveTopicState(sessionId), event(topic({ version: 2 })));
  const afterSnapshot = mergeLiveTopicSnapshot(live, {
    topics: [topic({ version: 2 })],
    topicMemberships: [{
      sessionId,
      topicId: firstTopicId,
      utteranceKey: "gateway:source:1",
      position: 1,
    }],
  });
  const afterReplay = applyLiveTopicUpsert(afterSnapshot, event(topic({ version: 2 })));

  assert.equal(afterReplay.topics.length, 1);
  assert.equal(afterReplay.topicMemberships.length, 1);
});

test("transcript projection joins topics only through stable utterance provenance", () => {
  const projected = projectTopicMemberships([
    { seq: 1, utteranceKey: "gateway:source:1", sourceText: "Revenue increased." },
    { seq: 2, utteranceKey: null, sourceText: "Unassigned caption." },
  ], [{ sessionId, topicId: firstTopicId, utteranceKey: "gateway:source:1", position: 3 }]);

  assert.deepEqual(projected[0], {
    seq: 1,
    utteranceKey: "gateway:source:1",
    sourceText: "Revenue increased.",
    topicId: firstTopicId,
    topicPosition: 3,
  });
  assert.equal("topicId" in (projected[1] ?? {}), false);
});
