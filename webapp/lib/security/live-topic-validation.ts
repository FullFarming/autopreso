import { z } from "zod";

const MAX_EVENT_MEMBERSHIPS = 50;
const MAX_SNAPSHOT_TOPICS = 1_000;
const MAX_SNAPSHOT_MEMBERSHIPS = 12_000;
const MAX_UTTERANCE_KEY_CODEPOINTS = 256;

const uuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
);
const positiveSafeIntegerSchema = z.number().int().safe().positive();
const timestampSchema = z.iso.datetime({ offset: true });

function plainTextSchema(maximumCodepoints: number, allowEmpty: boolean) {
  return z.string().refine((value) => {
    const length = Array.from(value).length;
    return value === value.normalize("NFC")
      && (allowEmpty || length > 0)
      && length <= maximumCodepoints
      && !/[<>\p{Cc}\p{Cf}]/u.test(value);
  });
}

const utteranceKeySchema = plainTextSchema(MAX_UTTERANCE_KEY_CODEPOINTS, false);

const liveTopicSchema = z.object({
  id: uuidSchema,
  sessionId: uuidSchema,
  ordinal: positiveSafeIntegerSchema,
  title: plainTextSchema(120, false),
  summary: plainTextSchema(500, true).nullable(),
  status: z.enum(["active", "completed"]),
  completionReason: z.enum(["silence", "semantic_shift", "session_end"]).nullable(),
  detectorHealth: z.enum(["healthy", "degraded"]),
  startedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  version: positiveSafeIntegerSchema,
}).strict().superRefine((topic, context) => {
  const hasCompletion = topic.completionReason !== null && topic.completedAt !== null;
  const hasPartialCompletion = (topic.completionReason === null) !== (topic.completedAt === null);
  if (hasPartialCompletion || (topic.status === "completed") !== hasCompletion) {
    context.addIssue({
      code: "custom",
      message: "Topic completion fields must match its status.",
    });
  }
  if (topic.completedAt !== null && Date.parse(topic.completedAt) < Date.parse(topic.startedAt)) {
    context.addIssue({ code: "custom", message: "Topic completion cannot precede its start." });
  }
});

const liveTopicMembershipSchema = z.object({
  sessionId: uuidSchema,
  topicId: uuidSchema,
  utteranceKey: utteranceKeySchema,
  position: positiveSafeIntegerSchema,
}).strict();

export type LiveTopicPublicMetadata = z.infer<typeof liveTopicSchema>;
export type LiveTopicMembership = z.infer<typeof liveTopicMembershipSchema>;

export interface LiveTopicUpsertEvent {
  type: "topic-upsert";
  sessionId: string;
  topic: LiveTopicPublicMetadata;
  membershipsAdded: LiveTopicMembership[];
}

export interface LiveTopicSnapshot {
  topics: LiveTopicPublicMetadata[];
  topicMemberships: LiveTopicMembership[];
}

function assertExpectedSessionId(actualSessionId: string, expectedSessionId: string): void {
  const expected = uuidSchema.parse(expectedSessionId);
  if (actualSessionId !== expected) throw new Error("Live topic session mismatch.");
}

export function parseLiveTopic(value: unknown, expectedSessionId: string): LiveTopicPublicMetadata {
  const topic = liveTopicSchema.parse(value);
  assertExpectedSessionId(topic.sessionId, expectedSessionId);
  return topic;
}

export function parseLiveTopicMembership(value: unknown, expectedSessionId: string): LiveTopicMembership {
  const membership = liveTopicMembershipSchema.parse(value);
  assertExpectedSessionId(membership.sessionId, expectedSessionId);
  return membership;
}

export function parseLiveTopicUpsertEvent(value: unknown, expectedSessionId: string): LiveTopicUpsertEvent {
  const eventSchema = z.object({
    type: z.literal("topic-upsert"),
    sessionId: uuidSchema,
    topic: liveTopicSchema,
    membershipsAdded: z.array(liveTopicMembershipSchema).max(MAX_EVENT_MEMBERSHIPS),
  }).strict();
  const event = eventSchema.parse(value);
  assertExpectedSessionId(event.sessionId, expectedSessionId);
  assertExpectedSessionId(event.topic.sessionId, expectedSessionId);
  const membershipKeys = new Set<string>();
  const positions = new Set<number>();
  for (const membership of event.membershipsAdded) {
    assertExpectedSessionId(membership.sessionId, expectedSessionId);
    if (membership.topicId !== event.topic.id) throw new Error("Live topic membership mismatch.");
    if (membershipKeys.has(membership.utteranceKey) || positions.has(membership.position)) {
      throw new Error("Live topic event contains duplicate memberships.");
    }
    membershipKeys.add(membership.utteranceKey);
    positions.add(membership.position);
  }
  return event;
}

export function parseLiveTopicSnapshot(value: unknown, expectedSessionId: string): LiveTopicSnapshot {
  const snapshotSchema = z.object({
    topics: z.array(liveTopicSchema).max(MAX_SNAPSHOT_TOPICS),
    topicMemberships: z.array(liveTopicMembershipSchema).max(MAX_SNAPSHOT_MEMBERSHIPS),
  }).strict();
  const snapshot = snapshotSchema.parse(value);
  const topicIds = new Set<string>();
  const ordinals = new Set<number>();
  let activeTopicCount = 0;
  for (const topic of snapshot.topics) {
    assertExpectedSessionId(topic.sessionId, expectedSessionId);
    if (topicIds.has(topic.id) || ordinals.has(topic.ordinal)) {
      throw new Error("Live topic snapshot contains duplicate topics.");
    }
    topicIds.add(topic.id);
    ordinals.add(topic.ordinal);
    if (topic.status === "active") activeTopicCount += 1;
  }
  if (activeTopicCount > 1) throw new Error("Live topic snapshot contains multiple active topics.");
  const membershipKeys = new Set<string>();
  const topicPositions = new Set<string>();
  for (const membership of snapshot.topicMemberships) {
    assertExpectedSessionId(membership.sessionId, expectedSessionId);
    if (!topicIds.has(membership.topicId)) throw new Error("Live topic snapshot membership is orphaned.");
    const topicPosition = `${membership.topicId}\u0000${membership.position}`;
    if (membershipKeys.has(membership.utteranceKey) || topicPositions.has(topicPosition)) {
      throw new Error("Live topic snapshot contains duplicate memberships.");
    }
    membershipKeys.add(membership.utteranceKey);
    topicPositions.add(topicPosition);
  }
  return snapshot;
}

export function privateNoStoreHeaders(): Readonly<Record<"Cache-Control", string>> {
  return { "Cache-Control": "private, no-store" };
}
