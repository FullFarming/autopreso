import type {
  LiveTopicMembership,
  LiveTopicPublicMetadata,
  LiveTopicSnapshot,
  LiveTopicUpsertEvent,
} from "../live-contract";
import {
  parseLiveTopicSnapshot,
  parseLiveTopicUpsertEvent,
} from "../security/live-topic-validation";

export interface LiveTopicState extends LiveTopicSnapshot {
  sessionId: string;
}

export function createLiveTopicState(sessionId: string): LiveTopicState {
  parseLiveTopicSnapshot({ topics: [], topicMemberships: [] }, sessionId);
  return { sessionId, topics: [], topicMemberships: [] };
}

function mergeMemberships(
  current: LiveTopicMembership[],
  incoming: LiveTopicMembership[],
): LiveTopicMembership[] {
  const byUtteranceKey = new Map(current.map((membership) => [membership.utteranceKey, membership]));
  const byTopicPosition = new Map(current.map((membership) => [
    `${membership.topicId}\u0000${membership.position}`,
    membership,
  ]));
  for (const membership of incoming) {
    const existingByKey = byUtteranceKey.get(membership.utteranceKey);
    const existingByPosition = byTopicPosition.get(`${membership.topicId}\u0000${membership.position}`);
    if (existingByKey || existingByPosition) {
      if (existingByKey?.topicId !== membership.topicId
        || existingByKey.position !== membership.position
        || existingByPosition?.utteranceKey !== membership.utteranceKey) {
        throw new Error("Live topic membership conflict.");
      }
      continue;
    }
    byUtteranceKey.set(membership.utteranceKey, membership);
    byTopicPosition.set(`${membership.topicId}\u0000${membership.position}`, membership);
  }
  return [...byUtteranceKey.values()];
}

function mergeTopic(
  current: LiveTopicPublicMetadata | undefined,
  incoming: LiveTopicPublicMetadata,
): LiveTopicPublicMetadata {
  if (!current || incoming.version > current.version) {
    if (current?.status === "completed" && incoming.status === "active") {
      throw new Error("Completed live topics cannot be reactivated.");
    }
    return incoming;
  }
  return current;
}

function assertOneActive(topics: LiveTopicPublicMetadata[]): void {
  if (topics.filter((topic) => topic.status === "active").length > 1) {
    throw new Error("Live topic state contains multiple active topics.");
  }
}

export function applyLiveTopicUpsert(
  state: LiveTopicState,
  value: LiveTopicUpsertEvent,
): LiveTopicState {
  const event = parseLiveTopicUpsertEvent(value, state.sessionId);
  const topicsById = new Map(state.topics.map((topic) => [topic.id, topic]));
  const existing = topicsById.get(event.topic.id);
  const topic = mergeTopic(existing, event.topic);
  topicsById.set(topic.id, topic);
  const topics = [...topicsById.values()].sort((left, right) => left.ordinal - right.ordinal);
  assertOneActive(topics);
  const topicMemberships = mergeMemberships(state.topicMemberships, event.membershipsAdded);
  return { sessionId: state.sessionId, topics, topicMemberships };
}

export function mergeLiveTopicSnapshot(
  state: LiveTopicState,
  value: LiveTopicSnapshot,
): LiveTopicState {
  const snapshot = parseLiveTopicSnapshot(value, state.sessionId);
  const topicsById = new Map(state.topics.map((topic) => [topic.id, topic]));
  for (const incoming of snapshot.topics) {
    topicsById.set(incoming.id, mergeTopic(topicsById.get(incoming.id), incoming));
  }
  const topics = [...topicsById.values()].sort((left, right) => left.ordinal - right.ordinal);
  assertOneActive(topics);
  return {
    sessionId: state.sessionId,
    topics,
    topicMemberships: mergeMemberships(state.topicMemberships, snapshot.topicMemberships),
  };
}

export function projectTopicMemberships<T extends { utteranceKey?: string | null }>(
  utterances: T[],
  memberships: LiveTopicMembership[],
): Array<T & { topicId?: string; topicPosition?: number }> {
  const byUtteranceKey = new Map(memberships.map((membership) => [membership.utteranceKey, membership]));
  return utterances.map((utterance) => {
    const membership = utterance.utteranceKey ? byUtteranceKey.get(utterance.utteranceKey) : undefined;
    return membership
      ? { ...utterance, topicId: membership.topicId, topicPosition: membership.position }
      : { ...utterance };
  });
}
