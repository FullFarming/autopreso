import assert from "node:assert/strict";
import test from "node:test";

import type { LiveSession, LiveSessionGlossaryPin, LiveSnapshot, LiveTopicSnapshot } from "../live-contract";
import { SummaryError, type MeetingUtterance } from "./summary";
import { MemoryLiveSessionStore, SupabaseLiveSessionStore, type LiveSessionStore } from "./store";
import {
  MAX_TRANSCRIPT_TOPIC_MEMBERSHIPS,
  MAX_TRANSCRIPT_TOPICS,
  MAX_TRANSCRIPT_UTTERANCES,
  clearTranscriptReadCacheForTest,
  readCachedHostLiveTranscript,
  readCachedLiveTranscript,
} from "./transcript-read";

const sessionId = "11111111-1111-4111-8111-111111111111";

test("authorized transcript reads share one bounded single-flight record after auth", async () => {
  clearTranscriptReadCacheForTest();
  let utteranceReads = 0;
  let topicReads = 0;
  let sessionReads = 0;
  const sessionSignals: Array<AbortSignal | undefined> = [];
  const store = new FakeTranscriptStore({
    getTopicTranscript: async () => {
      topicReads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return topicSnapshotFixture();
    },
    get: async (_sessionId, options) => {
      sessionReads += 1;
      sessionSignals.push(options?.signal);
      return sessionFixture();
    },
  });
  const requests = Array.from({ length: 50 }, () => readCachedLiveTranscript(sessionId, "ko", {
    getStore: () => store,
    fetchUtterances: async (_sessionId, _language, _fetchFn, options) => {
      utteranceReads += 1;
      assert.equal(options?.maxRows, MAX_TRANSCRIPT_UTTERANCES + 1);
      assert.ok(options?.signal instanceof AbortSignal);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [utteranceFixture()];
    },
    now: () => 1_000,
  }));
  const records = await Promise.all(requests);

  assert.equal(utteranceReads, 1);
  assert.equal(topicReads, 1);
  assert.equal(sessionReads, 1);
  assert.equal(sessionSignals.every((signal) => signal instanceof AbortSignal), true);
  assert.equal(records.every((record) => record === records[0]), true);
  assert.deepEqual(records[0], {
    language: "ko",
    event: {
      companyName: "NOVA REIT",
      ticker: "NOVA",
      fiscalPeriod: "Q2 2026",
      eventType: "earnings_call",
      agenda: [{ ordinal: 1, label: "Prepared remarks" }],
      activeSection: "prepared_remarks",
      sectionStartedAt: null,
    },
    topics: topicSnapshotFixture().topics,
    utterances: [{
      seq: 1,
      speaker: "Noel Kim",
      text: "매출은 안정적입니다.",
      emittedAt: "2026-08-15T00:00:02.000Z",
    }],
  });
  assert.equal(JSON.stringify(records[0]).includes("participant-1"), false);
  assert.equal(JSON.stringify(records[0]).includes("Revenue is stable."), false);
  assert.equal(JSON.stringify(records[0]).includes("gateway:source:1"), false);
});

test("host and participant transcript projections use separate caches and DTOs", async () => {
  clearTranscriptReadCacheForTest();
  let reads = 0;
  const dependencies = {
    getStore: () => new FakeTranscriptStore(),
    fetchUtterances: async () => {
      reads += 1;
      return [utteranceFixture()];
    },
    now: () => 1_000,
  };

  const participant = await readCachedLiveTranscript(sessionId, "ko", dependencies);
  const host = await readCachedHostLiveTranscript(sessionId, "ko", dependencies);

  assert.equal(reads, 2);
  assert.equal(Object.hasOwn(participant.utterances[0] ?? {}, "sourceText"), false);
  assert.equal(host.utterances[0]?.sourceText, "Revenue is stable.");
  assert.equal(host.utterances[0]?.participantId, "participant-1");
  assert.notEqual(participant, host);
});

test("participant transcript stays unavailable until terminal status has durable end evidence", async () => {
  clearTranscriptReadCacheForTest();
  let utteranceReads = 0;
  let topicReads = 0;
  const read = (session: LiveSession) => readCachedLiveTranscript(sessionId, "ko", {
    getStore: () => new FakeTranscriptStore({
      get: async () => session,
      getTopicTranscript: async () => {
        topicReads += 1;
        return topicSnapshotFixture();
      },
    }),
    fetchUtterances: async () => {
      utteranceReads += 1;
      return [utteranceFixture()];
    },
  });

  await assert.rejects(
    () => read({ ...sessionFixture(), status: "live", endedAt: null }),
    (error: unknown) => error instanceof SummaryError
      && error.code === "TRANSCRIPT_NOT_READY"
      && error.status === 409,
  );
  await assert.rejects(
    () => read({ ...sessionFixture(), status: "stopped", endedAt: null }),
    (error: unknown) => error instanceof SummaryError
      && error.code === "TRANSCRIPT_NOT_READY"
      && error.status === 409,
  );
  assert.equal(utteranceReads, 0);
  assert.equal(topicReads, 0);
});

test("failed session transcript is readable only when endedAt is valid", async () => {
  clearTranscriptReadCacheForTest();
  const record = await readCachedLiveTranscript(sessionId, "ko", {
    getStore: () => new FakeTranscriptStore({
      get: async () => ({ ...sessionFixture(), status: "failed", endedAt: "2026-08-15T01:00:00.000Z" }),
    }),
    fetchUtterances: async () => [utteranceFixture()],
  });
  assert.equal(record.utterances.length, 1);
});

test("pending transcript reads stay single-flight even after the short cache TTL", async () => {
  clearTranscriptReadCacheForTest();
  let now = 1_000;
  const pendingRead: { release: (() => void) | null } = { release: null };
  let utteranceReads = 0;
  const first = readCachedLiveTranscript(sessionId, "ko", {
    getStore: () => new FakeTranscriptStore(),
    fetchUtterances: async () => {
      utteranceReads += 1;
      await new Promise<void>((resolve) => {
        pendingRead.release = resolve;
      });
      return [utteranceFixture()];
    },
    now: () => now,
  });
  await new Promise((resolve) => setImmediate(resolve));

  now = 2_500;
  const second = readCachedLiveTranscript(sessionId, "ko", {
    getStore: () => new FakeTranscriptStore(),
    fetchUtterances: async () => {
      utteranceReads += 1;
      return [utteranceFixture()];
    },
    now: () => now,
  });
  assert.ok(pendingRead.release);
  pendingRead.release();
  const [firstRecord, secondRecord] = await Promise.all([first, second]);

  assert.equal(utteranceReads, 1);
  assert.equal(firstRecord, secondRecord);
});

test("transcript read deadline aborts outstanding reads and fails closed", async () => {
  clearTranscriptReadCacheForTest();
  const captured: { signal: AbortSignal | null } = { signal: null };
  await assert.rejects(
    () => readCachedLiveTranscript(sessionId, "ko", {
      getStore: () => new FakeTranscriptStore({
        getTopicTranscript: async (_sessionId, options) => {
          captured.signal = options?.signal ?? null;
          await new Promise(() => undefined);
          return topicSnapshotFixture();
        },
        get: async () => sessionFixture(),
      }),
      fetchUtterances: async () => new Promise(() => undefined),
      timeoutMilliseconds: 5,
    }),
    (error: unknown) => error instanceof SummaryError && error.code === "TRANSCRIPT_READ_FAILED",
  );
  assert.equal(captured.signal?.aborted, true);
});

test("transcript caps fail closed before exposing oversized records", async () => {
  clearTranscriptReadCacheForTest();
  const tooManyUtterances = Array.from({ length: MAX_TRANSCRIPT_UTTERANCES + 1 }, (_, index) => utteranceFixture(index + 1));
  await assert.rejects(
    () => readCachedLiveTranscript(sessionId, "ko", {
      getStore: () => new FakeTranscriptStore(),
      fetchUtterances: async () => tooManyUtterances,
    }),
    (error: unknown) => error instanceof SummaryError && error.code === "TRANSCRIPT_TOO_LARGE",
  );

  clearTranscriptReadCacheForTest();
  const tooManyTopics = {
    topics: Array.from({ length: MAX_TRANSCRIPT_TOPICS + 1 }, (_, index) => ({
      ...topicSnapshotFixture().topics[0],
      id: `topic-${index + 1}`,
      ordinal: index + 1,
    })),
    topicMemberships: [],
  };
  await assert.rejects(
    () => readCachedLiveTranscript(sessionId, "ko", {
      getStore: () => new FakeTranscriptStore({ getTopicTranscript: async () => tooManyTopics }),
      fetchUtterances: async () => [utteranceFixture()],
    }),
    (error: unknown) => error instanceof SummaryError && error.code === "TRANSCRIPT_TOO_LARGE",
  );

  clearTranscriptReadCacheForTest();
  const tooManyMemberships = {
    topics: topicSnapshotFixture().topics,
    topicMemberships: Array.from({ length: MAX_TRANSCRIPT_TOPIC_MEMBERSHIPS + 1 }, (_, index) => ({
      sessionId,
      topicId: "topic-1",
      utteranceKey: `gateway:source:${index + 1}`,
      position: index + 1,
    })),
  };
  await assert.rejects(
    () => readCachedLiveTranscript(sessionId, "ko", {
      getStore: () => new FakeTranscriptStore({ getTopicTranscript: async () => tooManyMemberships }),
      fetchUtterances: async () => [utteranceFixture()],
    }),
    (error: unknown) => error instanceof SummaryError && error.code === "TRANSCRIPT_TOO_LARGE",
  );
});

test("Supabase topic transcript accepts route caps and forwards the read AbortSignal", async () => {
  const topicId = "22222222-2222-4222-8222-222222222222";
  const controller = new AbortController();
  const seenSignals: Array<AbortSignal | null | undefined> = [];
  const store = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"b".repeat(24)}`, kind: "secret" },
    (async (input, init) => {
      seenSignals.push(init?.signal);
      const target = String(input);
      if (target.includes("live_topics")) {
        return Response.json(Array.from({ length: MAX_TRANSCRIPT_TOPICS + 1 }, (_value, index) => ({
          id: index === 0 ? topicId : `33333333-3333-4333-8333-${String(index).padStart(12, "0").slice(0, 12)}`,
          session_id: sessionId,
          ordinal: index + 1,
          title: `Topic ${index + 1}`,
          summary: null,
          status: "completed",
          completion_reason: "shifted",
          detector_health: "healthy",
          started_at: "2026-08-15T00:00:00.000Z",
          completed_at: "2026-08-15T00:01:00.000Z",
          version: 1,
        })));
      }
      return Response.json([]);
    }) as typeof fetch,
  );

  await assert.rejects(
    () => store.getTopicTranscript(sessionId, {
      maxTopics: MAX_TRANSCRIPT_TOPICS,
      maxTopicMemberships: MAX_TRANSCRIPT_TOPIC_MEMBERSHIPS,
      signal: controller.signal,
    }),
    /주제/u,
  );
  assert.equal(seenSignals.every((signal) => signal === controller.signal), true);
});

class FakeTranscriptStore extends MemoryLiveSessionStore implements LiveSessionStore {
  private readonly overrides: {
    get?: (sessionId: string, options?: { signal?: AbortSignal }) => Promise<LiveSession | null>;
    getTopicTranscript?: (sessionId: string, options?: { signal?: AbortSignal }) => Promise<LiveTopicSnapshot>;
  };

  constructor(overrides: FakeTranscriptStore["overrides"] = {}) {
    super(() => Date.UTC(2026, 7, 15));
    this.overrides = overrides;
  }

  override async get(sessionIdValue: string, _options: { signal?: AbortSignal } = {}): Promise<LiveSession | null> {
    return this.overrides.get?.(sessionIdValue, _options) ?? sessionFixture();
  }

  override async getTopicTranscript(sessionIdValue: string, options?: { signal?: AbortSignal }): Promise<LiveTopicSnapshot> {
    return this.overrides.getTopicTranscript?.(sessionIdValue, options) ?? topicSnapshotFixture();
  }

  override async pinGlossaryVersionOwned(): Promise<LiveSessionGlossaryPin> {
    throw new Error("not used");
  }
}

function sessionFixture(): LiveSession {
  return {
    id: sessionId,
    hostId: "host@example.com",
    title: "Earnings Call",
    scheduledAt: null,
    sessionType: "meeting",
    outputMode: "captions",
    voiceProvider: "gemini",
    participantSpeakingEnabled: true,
    maxViewers: 50,
    glossaryPack: "general_cre",
    status: "stopped",
    languages: ["ko", "en"],
    viewerCount: 0,
    version: 3,
    admissionOpenUntil: null,
    expiresAt: "2026-08-15T06:00:00.000Z",
    endedAt: "2026-08-15T01:00:00.000Z",
    companyName: "NOVA REIT",
    ticker: "NOVA",
    fiscalPeriod: "Q2 2026",
    eventType: "earnings_call",
    agenda: [{ ordinal: 1, label: "Prepared remarks" }],
    activeSection: "prepared_remarks",
    sectionStartedAt: null,
  };
}

function topicSnapshotFixture(): LiveTopicSnapshot {
  return {
    topics: [{
      id: "topic-1",
      sessionId,
      ordinal: 1,
      title: "Revenue outlook",
      summary: null,
      status: "completed",
      completionReason: "semantic_shift",
      detectorHealth: "healthy",
      startedAt: "2026-08-15T00:00:01.000Z",
      completedAt: "2026-08-15T00:00:05.000Z",
      version: 1,
    }],
    topicMemberships: [{
      sessionId,
      topicId: "topic-1",
      utteranceKey: "gateway:source:1",
      position: 1,
    }],
  };
}

function utteranceFixture(seq = 1): MeetingUtterance {
  return {
    seq,
    participantId: "participant-1",
    speakerName: "Noel Kim",
    speakerLabel: "Speaker 1",
    speakerDepartment: null,
    speakerJobTitle: null,
    text: "매출은 안정적입니다.",
    sourceText: "Revenue is stable.",
    sourceLanguage: "en",
    origin: "source",
    utteranceKey: `gateway:source:${seq}`,
    translationStatus: "translated",
    sourceStartedAt: "2026-08-15T00:00:01.000Z",
    sourceEndedAt: "2026-08-15T00:00:02.000Z",
    emittedAt: "2026-08-15T00:00:02.000Z",
  };
}
