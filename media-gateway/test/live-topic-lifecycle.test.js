import assert from "node:assert/strict";
import test from "node:test";

import { LiveTopicCoordinator, SupabaseLivePublisher } from "../src/supabase-adapters.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TOPIC_ID = "22222222-2222-4222-8222-222222222222";

function topic(overrides = {}) {
  return {
    id: TOPIC_ID,
    sessionId: SESSION_ID,
    ordinal: 1,
    title: "운영 실적",
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

function membership(utteranceKey, position) {
  return { sessionId: SESSION_ID, topicId: TOPIC_ID, utteranceKey, position };
}

function rawTopic(overrides = {}) {
  const value = topic(overrides);
  return {
    id: value.id,
    session_id: value.sessionId,
    ordinal: value.ordinal,
    title: value.title,
    summary: value.summary,
    status: value.status,
    completion_reason: value.completionReason,
    detector_health: value.detectorHealth,
    started_at: value.startedAt,
    completed_at: value.completedAt,
    version: value.version,
  };
}

function rawMembership(utteranceKey, position) {
  return { session_id: SESSION_ID, topic_id: TOPIC_ID, utterance_key: utteranceKey, position };
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not met");
}

function manualClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeoutFn(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeoutFn(id) { timers.delete(id); },
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = target;
    },
  };
}

test("durable source finals fan out before an exactly-once ordered detector queue", async () => {
  const timeline = [];
  let releaseFirst;
  const firstDecision = new Promise((resolve) => { releaseFirst = resolve; });
  let detectorCalls = 0;
  const store = {
    async readTopicContext() { return { ok: true, event: "topic-upsert", topics: [], topicMemberships: [], membershipsAdded: [], latestSourceSeq: 0 }; },
    async recoverTopicAssignments() { return { ok: true, unassignedFinals: [] }; },
    async applyTopicTransition(input) {
      timeline.push(`db:${input.utteranceKey}`);
      return {
        ok: true, status: "applied", event: "topic-upsert",
        topics: [topic({ version: input.sourceSeq })],
        membershipsAdded: [membership(input.utteranceKey, input.sourceSeq)],
      };
    },
  };
  const coordinator = new LiveTopicCoordinator({
    store,
    detector: {
      async detect({ candidateSourceFinal }) {
        detectorCalls += 1;
        timeline.push(`detect:${candidateSourceFinal.text}`);
        if (detectorCalls === 1) return firstDecision;
        return { meaningful: true, startsNewTopic: false, title: null, summary: "논의 내용을 요약했습니다.", detectorHealth: "healthy", failureCode: null };
      },
    },
    async eventFanout(_sessionId, language, event) { timeline.push(`event:${language}:${event.membershipsAdded[0].utteranceKey}`); },
  });
  await coordinator.start(SESSION_ID, ["ko", "en"]);

  coordinator.enqueueSourceFinal(SESSION_ID, "ko", { seq: 1, text: "첫 번째", utteranceKey: "u-1" });
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", { seq: 2, text: "두 번째", utteranceKey: "u-2" });
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", { seq: 1, text: "중복", utteranceKey: "u-1" });
  await waitFor(() => detectorCalls === 1);
  assert.deepEqual(timeline, ["detect:첫 번째"]);

  releaseFirst({ meaningful: true, startsNewTopic: true, title: "첫 주제", summary: "첫 주제 논의를 정리했습니다.", detectorHealth: "healthy", failureCode: null });
  await coordinator.drain(SESSION_ID);
  assert.equal(detectorCalls, 2);
  assert.deepEqual(timeline, [
    "detect:첫 번째", "db:u-1", "event:ko:u-1", "event:en:u-1",
    "detect:두 번째", "db:u-2", "event:ko:u-2", "event:en:u-2",
  ]);
});

test("publisher returns after durable caption fanout without waiting for topic detection", async () => {
  const events = [];
  let detectorStarted = false;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "secret",
    topicDetector: { async detect() { detectorStarted = true; return new Promise(() => {}); } },
    async eventFanout(_sessionId, _language, event) { events.push(event); },
    async audioFanout() {},
    async fetchFn(url) {
      if (url.includes("persist_live_final_caption_if_active")) return Response.json(true);
      if (url.includes("read_live_topic_context")) {
        return Response.json({ ok: true, event: "topic-upsert", topics: [], topic_memberships: [], memberships_added: [], latest_source_seq: 0 });
      }
      if (url.includes("recover_live_topic_assignments")) return Response.json({ ok: true, unassigned_finals: [], next_source_seq: 0 });
      throw new Error(`unexpected ${url}`);
    },
  });
  await publisher.startTopicSession(SESSION_ID, ["ko", "en"]);
  await publisher.publish(SESSION_ID, "ko", {
    type: "caption", seq: 1, sessionId: SESSION_ID, language: "ko", text: "순영업소득",
    isFinal: true, origin: "source", utteranceKey: "u-1", translationStatus: "verbatim",
    sourceEndedAt: "2026-08-15T00:00:01.000Z", emittedAt: "2026-08-15T00:00:01.100Z",
  });
  await waitFor(() => detectorStarted);
  assert.deepEqual(events.map(({ type, isFinal }) => [type, isFinal]), [["caption", false], ["caption", true]]);
});

test("partial activity postpones 12-second idle completion and pause time is ignored", async () => {
  const clock = manualClock();
  const idleCalls = [];
  const store = {
    async readTopicContext() {
      return { ok: true, event: "topic-upsert", topics: [topic()], topicMemberships: [], membershipsAdded: [], latestSourceSeq: 0 };
    },
    async recoverTopicAssignments() { return { ok: true, unassignedFinals: [] }; },
    async completeIdleTopic(input) {
      idleCalls.push(input);
      return { ok: true, event: "topic-upsert", topics: [topic({ status: "completed", completionReason: "silence", completedAt: "2026-08-15T00:00:12.000Z", version: 2 })], membershipsAdded: [] };
    },
  };
  const coordinator = new LiveTopicCoordinator({
    store,
    detector: { async detect() { throw new Error("unused"); } },
    eventFanout: async () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  await coordinator.start(SESSION_ID, ["ko"]);
  coordinator.notePartial(SESSION_ID);
  await clock.advance(11_000);
  coordinator.notePartial(SESSION_ID);
  await clock.advance(11_999);
  assert.equal(idleCalls.length, 0);
  coordinator.pause(SESSION_ID);
  await clock.advance(60_000);
  assert.equal(idleCalls.length, 0);
  coordinator.resume(SESSION_ID);
  await clock.advance(12_000);
  await coordinator.drain(SESSION_ID);
  assert.deepEqual(idleCalls, [{ sessionId: SESSION_ID, language: "ko", topicId: TOPIC_ID, expectedVersion: 1 }]);
});

test("silence is anchored before detector latency and one DB clock race is rescheduled", async () => {
  const clock = manualClock();
  let releaseDecision;
  const delayedDecision = new Promise((resolve) => { releaseDecision = resolve; });
  let idleCalls = 0;
  const store = {
    async readTopicContext() { return { ok: true, event: "topic-upsert", topics: [], topicMemberships: [], membershipsAdded: [], latestSourceSeq: 0 }; },
    async applyTopicTransition() {
      return { ok: true, status: "applied", event: "topic-upsert", topics: [topic()], membershipsAdded: [membership("u-delay", 1)] };
    },
    async completeIdleTopic() {
      idleCalls += 1;
      if (idleCalls === 1) return { ok: false, code: "TOPIC_NOT_IDLE" };
      return {
        ok: true, event: "topic-upsert",
        topics: [topic({ status: "completed", completionReason: "silence", completedAt: "2026-08-15T00:00:24.000Z", version: 2 })],
        membershipsAdded: [],
      };
    },
  };
  const coordinator = new LiveTopicCoordinator({
    store,
    detector: { async detect() { return delayedDecision; } },
    eventFanout: async () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  await coordinator.start(SESSION_ID, ["ko"]);
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", { seq: 1, text: "지연된 감지", utteranceKey: "u-delay" });
  await clock.advance(2_500);
  releaseDecision({ meaningful: true, startsNewTopic: false, title: null, summary: "논의 내용을 요약했습니다.", detectorHealth: "healthy", failureCode: null });
  await coordinator.drain(SESSION_ID);
  await clock.advance(9_499);
  assert.equal(idleCalls, 0);
  await clock.advance(1);
  await coordinator.drain(SESSION_ID);
  assert.equal(idleCalls, 1);
  await clock.advance(11_999);
  assert.equal(idleCalls, 1);
  await clock.advance(1);
  await coordinator.drain(SESSION_ID);
  assert.equal(idleCalls, 2);
});

test("a non-meaningful final is persisted without extending or cancelling active-topic silence", async () => {
  const clock = manualClock();
  const transitions = [];
  let idleCalls = 0;
  const store = {
    async readTopicContext() {
      return { ok: true, event: "topic-upsert", topics: [topic()], topicMemberships: [], membershipsAdded: [], latestSourceSeq: 0 };
    },
    async applyTopicTransition(input) {
      transitions.push(input);
      return {
        ok: true, status: "applied", event: "topic-upsert", topics: [topic()],
        membershipsAdded: [membership(input.utteranceKey, 1)],
      };
    },
    async completeIdleTopic() {
      idleCalls += 1;
      return {
        ok: true, event: "topic-upsert",
        topics: [topic({ status: "completed", completionReason: "silence", completedAt: "2026-08-15T00:00:12.000Z", version: 2 })],
        membershipsAdded: [],
      };
    },
  };
  const coordinator = new LiveTopicCoordinator({
    store,
    detector: {
      async detect() {
        return { meaningful: false, startsNewTopic: false, title: null, summary: null, detectorHealth: "healthy", failureCode: null };
      },
    },
    eventFanout: async () => {},
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  await coordinator.start(SESSION_ID, ["ko"]);
  await clock.advance(5_000);
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", { seq: 2, text: "음", utteranceKey: "u-filler" });
  await coordinator.drain(SESSION_ID);
  assert.equal(transitions[0].meaningful, false);
  await clock.advance(6_999);
  assert.equal(idleCalls, 0);
  await clock.advance(1);
  await coordinator.drain(SESSION_ID);
  assert.equal(idleCalls, 1);
});

test("ordered topic failures are observed without rejecting the caption-facing queue", async () => {
  const failures = [];
  const coordinator = new LiveTopicCoordinator({
    store: {
      async readTopicContext() { return { ok: true, event: "topic-upsert", topics: [], topicMemberships: [], membershipsAdded: [], latestSourceSeq: 0 }; },
      async applyTopicTransition() { throw new Error("contains private transcript and must not escape"); },
    },
    detector: {
      async detect() { return { meaningful: true, startsNewTopic: false, title: null, summary: "논의 내용을 요약했습니다.", detectorHealth: "healthy", failureCode: null }; },
    },
    eventFanout: async () => {},
    observeFailure(code) { failures.push(code); },
  });
  await coordinator.start(SESSION_ID, ["ko"]);
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", { seq: 1, text: "비공개 원문", utteranceKey: "u-private" });
  await coordinator.drain(SESSION_ID);
  assert.deepEqual(failures, ["TOPIC_LIFECYCLE_FAILED"]);
  assert.equal(JSON.stringify(failures).includes("비공개 원문"), false);
});

test("a version conflict refreshes CAS and retries once without rerunning the provider", async () => {
  let contextReads = 0;
  let detectorCalls = 0;
  const transitions = [];
  const store = {
    async readTopicContext() {
      contextReads += 1;
      return contextReads === 1
        ? { ok: true, event: "topic-upsert", topics: [], topicMemberships: [], membershipsAdded: [], latestSourceSeq: 0 }
        : { ok: true, event: "topic-upsert", topics: [topic({ version: 2 })], topicMemberships: [], membershipsAdded: [], latestSourceSeq: 1 };
    },
    async recoverTopicAssignments() { return { ok: true, unassignedFinals: [], nextSourceSeq: 1 }; },
    async applyTopicTransition(input) {
      transitions.push(input);
      if (transitions.length === 1) return { ok: false, code: "TOPIC_VERSION_CONFLICT" };
      return {
        ok: true, status: "applied", event: "topic-upsert", topics: [topic({ version: 3 })],
        membershipsAdded: [membership(input.utteranceKey, 1)],
      };
    },
  };
  const coordinator = new LiveTopicCoordinator({
    store,
    detector: {
      async detect() {
        detectorCalls += 1;
        return { meaningful: true, startsNewTopic: false, title: null, summary: "논의 내용을 요약했습니다.", detectorHealth: "healthy", failureCode: null };
      },
    },
    eventFanout: async () => {},
  });
  await coordinator.start(SESSION_ID, ["ko"]);
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", { seq: 1, text: "동시 수정 문장", utteranceKey: "u-cas" });
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", { seq: 1, text: "동시 수정 문장", utteranceKey: "u-cas" });
  await coordinator.drain(SESSION_ID);

  assert.equal(detectorCalls, 1);
  assert.equal(transitions.length, 2);
  assert.deepEqual(transitions.map(({ expectedTopicId, expectedVersion }) => [expectedTopicId, expectedVersion]), [
    [null, null], [TOPIC_ID, 2],
  ]);
});

test("a repeated CAS failure remains processable after the single retry", async () => {
  let detectorCalls = 0;
  let transitions = 0;
  const failures = [];
  const store = {
    async readTopicContext() {
      return { ok: true, event: "topic-upsert", topics: [topic({ version: 2 })], topicMemberships: [], membershipsAdded: [], latestSourceSeq: 1 };
    },
    async recoverTopicAssignments() { return { ok: true, unassignedFinals: [], nextSourceSeq: 1 }; },
    async applyTopicTransition() {
      transitions += 1;
      return { ok: false, code: "TOPIC_VERSION_CONFLICT" };
    },
  };
  const coordinator = new LiveTopicCoordinator({
    store,
    detector: {
      async detect() {
        detectorCalls += 1;
        return { meaningful: true, startsNewTopic: false, title: null, summary: "논의 내용을 요약했습니다.", detectorHealth: "healthy", failureCode: null };
      },
    },
    eventFanout: async () => {},
    observeFailure(code) { failures.push(code); },
  });
  await coordinator.start(SESSION_ID, ["ko"]);
  const caption = { seq: 2, text: "재처리할 문장", utteranceKey: "u-retryable" };
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption);
  await coordinator.drain(SESSION_ID);
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption);
  await coordinator.drain(SESSION_ID);

  assert.equal(detectorCalls, 2);
  assert.equal(transitions, 4);
  assert.deepEqual(failures, ["TOPIC_TRANSITION_FAILED", "TOPIC_TRANSITION_FAILED"]);
});

test("restart recovery and session end broadcast only committed topic events", async () => {
  const events = [];
  let ended = 0;
  const recoveredMembership = membership("recovered-u", 1);
  const store = {
    async readTopicContext() {
      return { ok: true, event: "topic-upsert", topics: [topic()], topicMemberships: [], membershipsAdded: [], latestSourceSeq: 1 };
    },
    async recoverTopicAssignments() {
      return {
        ok: true,
        unassignedFinals: [{
          utteranceKey: "recovered-u", sourceLanguage: "ko", sourceSeq: 1,
          text: "복구된 원문", emittedAt: "2026-08-15T00:00:01.000Z",
        }],
      };
    },
    async applyTopicTransition() {
      return {
        ok: true, status: "applied", event: "topic-upsert",
        topics: [topic({ detectorHealth: "degraded", version: 2 })],
        membershipsAdded: [recoveredMembership],
      };
    },
    async completeTopicsOnSessionEnd() { ended += 1; return 1; },
  };
  const coordinator = new LiveTopicCoordinator({
    store,
    detector: {
      async detect() {
        return { meaningful: true, startsNewTopic: false, title: null, detectorHealth: "degraded", failureCode: "RECOVERY" };
      },
    },
    async eventFanout(_sessionId, language, event) { events.push([language, event]); },
  });
  await coordinator.start(SESSION_ID, ["ko", "en"]);
  await coordinator.drain(SESSION_ID);
  assert.deepEqual(events.map(([language]) => language), ["ko", "en"]);
  assert.deepEqual(events[0][1].membershipsAdded, [recoveredMembership]);
  await coordinator.end(SESSION_ID);
  assert.equal(ended, 1);
});

test("restart recovery pages only the durable source lane and de-duplicates keys across pages", async () => {
  const recoveryCalls = [];
  const processed = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    utteranceKey: `recovered-${index + 1}`,
    sourceLanguage: "ko",
    sourceSeq: index + 1,
    text: `복구 문장 ${index + 1}`,
    emittedAt: "2026-08-15T00:00:01.000Z",
  }));
  const store = {
    async readTopicContext(_sessionId, language) {
      return {
        ok: true, event: "topic-upsert", topics: [topic()], topicMemberships: [], membershipsAdded: [],
        latestSourceSeq: language === "ko" ? 101 : 0,
      };
    },
    async recoverTopicAssignments(_sessionId, language, cursor) {
      recoveryCalls.push([language, cursor]);
      if (cursor === 0) return { ok: true, unassignedFinals: firstPage, nextSourceSeq: 100 };
      return {
        ok: true,
        unassignedFinals: [firstPage[99], {
          utteranceKey: "recovered-101", sourceLanguage: "ko", sourceSeq: 101,
          text: "복구 문장 101", emittedAt: "2026-08-15T00:00:02.000Z",
        }],
        nextSourceSeq: 101,
      };
    },
    async applyTopicTransition(input) {
      processed.push(input.utteranceKey);
      return { ok: true, status: "idempotent", event: "topic-upsert", topics: [topic()], membershipsAdded: [] };
    },
  };
  const coordinator = new LiveTopicCoordinator({
    store,
    detector: {
      async detect() {
        return { meaningful: true, startsNewTopic: false, title: null, summary: "논의 내용을 요약했습니다.", detectorHealth: "healthy", failureCode: null };
      },
    },
    eventFanout: async () => {},
  });

  await coordinator.start(SESSION_ID, ["ko", "en"]);
  await coordinator.drain(SESSION_ID);
  assert.deepEqual(recoveryCalls, [["ko", 0], ["ko", 100]]);
  assert.equal(processed.length, 101);
  assert.equal(new Set(processed).size, 101);
});

test("a semantic shift emits the committed old and new topic records to every language", async () => {
  const nextTopicId = "33333333-3333-4333-8333-333333333333";
  const events = [];
  let providerCalls = 0;
  const detectorContexts = [];
  let applyCalls = 0;
  let appliedSummary = null;
  const store = {
    async readTopicContext() {
      return { ok: true, event: "topic-upsert", topics: [topic({ summary: "이전 운영 실적 요약" })], topicMemberships: [], membershipsAdded: [], latestSourceSeq: 0 };
    },
    async applyTopicTransition(input) {
      applyCalls += 1;
      appliedSummary = input.summary;
      if (applyCalls > 1) {
        return {
          ok: true, status: "applied", event: "topic-upsert",
          topics: [topic({ id: nextTopicId, ordinal: 2, title: "임대 전략", summary: input.summary, version: 2 })],
          membershipsAdded: [{ sessionId: SESSION_ID, topicId: nextTopicId, utteranceKey: input.utteranceKey, position: 2 }],
        };
      }
      return {
        ok: true, status: "applied", event: "topic-upsert",
        topics: [
          topic({ summary: "이전 운영 실적 요약", status: "completed", completionReason: "semantic_shift", completedAt: "2026-08-15T00:00:05.000Z", version: 2 }),
          topic({ id: nextTopicId, ordinal: 2, title: input.title, summary: input.summary, version: 1 }),
        ],
        membershipsAdded: [{ sessionId: SESSION_ID, topicId: nextTopicId, utteranceKey: input.utteranceKey, position: 1 }],
      };
    },
  };
  const coordinator = new LiveTopicCoordinator({
    store,
    detector: {
      async detect(input) {
        providerCalls += 1;
        detectorContexts.push(input);
        return providerCalls === 1
          ? { meaningful: true, startsNewTopic: true, title: "임대 전략", summary: "새 임대 전략을 요약했습니다.", detectorHealth: "healthy", failureCode: null }
          : { meaningful: true, startsNewTopic: false, title: null, summary: "논의 내용을 요약했습니다.", detectorHealth: "healthy", failureCode: null };
      },
    },
    async eventFanout(_sessionId, language, event) { events.push([language, event]); },
  });
  await coordinator.start(SESSION_ID, ["ko", "en"]);
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", { seq: 2, text: "임대 전략을 논의합니다", utteranceKey: "u-shift" });
  await coordinator.drain(SESSION_ID);

  assert.deepEqual(events.map(([language, event]) => [language, event.topic.id]), [
    ["ko", TOPIC_ID], ["en", TOPIC_ID], ["ko", nextTopicId], ["en", nextTopicId],
  ]);
  assert.deepEqual(events[0][1].membershipsAdded, []);
  assert.deepEqual(events[2][1].membershipsAdded.map(({ utteranceKey }) => utteranceKey), ["u-shift"]);
  assert.equal(events[0][1].topic.summary, "이전 운영 실적 요약");
  assert.equal(events[2][1].topic.summary, "새 임대 전략을 요약했습니다.");
  assert.equal(appliedSummary, "새 임대 전략을 요약했습니다.");
  assert.equal(providerCalls, 1);
  assert.equal(detectorContexts[0].previousSummary, "이전 운영 실적 요약");
  assert.equal(events[2][1].topic.summary.includes("이전 운영 실적"), false);

  coordinator.enqueueSourceFinal(SESSION_ID, "ko", { seq: 3, text: "새 주제 후속 문장", utteranceKey: "u-after-shift" });
  await coordinator.drain(SESSION_ID);
  assert.deepEqual(detectorContexts[1].recentSourceFinals, [{ text: "임대 전략을 논의합니다" }]);
  assert.equal(providerCalls, 2);
  assert.equal(detectorContexts[1].previousSummary, "새 임대 전략을 요약했습니다.");
});

test("restart hydrates assigned active-topic finals before classifying the next source final", async () => {
  const detectorContexts = [];
  const hydrationCalls = [];
  const store = {
    async readTopicContext() {
      return {
        ok: true, event: "topic-upsert", topics: [topic()],
        topicMemberships: [membership("assigned-1", 1), membership("assigned-2", 2)],
        membershipsAdded: [], latestSourceSeq: 1,
      };
    },
    async fetchRecentTopicFinals(sessionId, utteranceKeys) {
      hydrationCalls.push({ sessionId, utteranceKeys });
      return [{ text: "기존 한국어 임대료 논의" }, { text: "Existing English vacancy review" }];
    },
    async recoverTopicAssignments() { return { ok: true, unassignedFinals: [], nextSourceSeq: 1 }; },
    async applyTopicTransition(input) {
      return { ok: true, status: "applied", event: "topic-upsert", topics: [topic({ summary: input.summary, version: 2 })], membershipsAdded: [membership(input.utteranceKey, 3)] };
    },
  };
  const coordinator = new LiveTopicCoordinator({
    store,
    detector: {
      async detect(input) {
        detectorContexts.push(input);
        return { meaningful: true, startsNewTopic: false, title: null, summary: "논의 내용을 요약했습니다.", detectorHealth: "healthy", failureCode: null };
      },
    },
    eventFanout: async () => {},
  });
  await coordinator.start(SESSION_ID, ["ko", "en"]);
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", { seq: 3, text: "관리비도 확인합니다", utteranceKey: "new-3" });
  await coordinator.drain(SESSION_ID);

  assert.deepEqual(hydrationCalls, [{ sessionId: SESSION_ID, utteranceKeys: ["assigned-1", "assigned-2"] }]);
  assert.deepEqual(detectorContexts[0].recentSourceFinals, [
    { text: "기존 한국어 임대료 논의" }, { text: "Existing English vacancy review" },
  ]);
});

test("topic RPC wrappers use exact service-role procedures and reject malformed public shapes", async () => {
  const calls = [];
  const responses = [
    { ok: true, event: "topic-upsert", topics: [rawTopic()], topic_memberships: [rawMembership("u-1", 1)], memberships_added: [], latest_source_seq: 1 },
    { ok: true, status: "applied", event: "topic-upsert", topics: [rawTopic({ version: 2 })], memberships_added: [rawMembership("u-2", 2)] },
    { ok: true, event: "topic-upsert", topics: [rawTopic({ status: "completed", completionReason: "silence", completedAt: "2026-08-15T00:00:12.000Z", version: 3 })], memberships_added: [] },
    1,
    { ok: true, unassigned_finals: [], next_source_seq: 0 },
  ];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url, init) { calls.push({ url, body: JSON.parse(init.body) }); return Response.json(responses.shift()); },
  });
  await publisher.readTopicContext(SESSION_ID, "ko");
  await publisher.applyTopicTransition({ sessionId: SESSION_ID, language: "ko", utteranceKey: "u-2", sourceSeq: 2, meaningful: true, decision: "continue", expectedTopicId: TOPIC_ID, expectedVersion: 1, title: "운영 실적", summary: null, detectorHealth: "healthy" });
  await publisher.completeIdleTopic({ sessionId: SESSION_ID, language: "ko", topicId: TOPIC_ID, expectedVersion: 2 });
  await publisher.completeTopicsOnSessionEnd(SESSION_ID);
  await publisher.recoverTopicAssignments(SESSION_ID, "ko");
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    "/rest/v1/rpc/read_live_topic_context",
    "/rest/v1/rpc/apply_live_topic_transition",
    "/rest/v1/rpc/complete_idle_live_topic",
    "/rest/v1/rpc/complete_live_topics_on_session_end",
    "/rest/v1/rpc/recover_live_topic_assignments",
  ]);
  assert.deepEqual(calls[1].body, {
    p_session_id: SESSION_ID, p_language: "ko", p_utterance_key: "u-2", p_source_seq: 2,
    p_meaningful: true, p_decision: "continue", p_expected_topic_id: TOPIC_ID, p_expected_version: 1,
    p_title: "운영 실적", p_summary: null, p_detector_health: "healthy",
  });
  assert.deepEqual(calls[4].body, {
    p_session_id: SESSION_ID, p_language: "ko", p_after_source_seq: 0,
  });

  const malformed = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn() { return Response.json({ ok: true, event: "topic-upsert", topics: [{ ...rawTopic(), title: "<script>" }], topic_memberships: [], memberships_added: [], latest_source_seq: 0 }); },
  });
  await assert.rejects(() => malformed.readTopicContext(SESSION_ID, "ko"), /INVALID_TOPIC_RPC_RESPONSE/u);
});

test("topic RPC parsing enforces schema caps, expected session, and membership topic links", async () => {
  const createPublisher = (response) => new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn() { return Response.json(response); },
  });
  const allowed = {
    ok: true, event: "topic-upsert",
    topics: Array.from({ length: 41 }, () => rawTopic()),
    topic_memberships: Array.from({ length: 51 }, (_, index) => rawMembership(`allowed-${index}`, index + 1)),
    memberships_added: [], latest_source_seq: 51,
  };
  const parsed = await createPublisher(allowed).readTopicContext(SESSION_ID, "ko");
  assert.equal(parsed.topics.length, 41);
  assert.equal(parsed.topicMemberships.length, 51);

  await assert.rejects(
    () => createPublisher({ ...allowed, topics: Array.from({ length: 1_001 }, () => rawTopic()) }).readTopicContext(SESSION_ID, "ko"),
    /INVALID_TOPIC_RPC_RESPONSE/u,
  );
  await assert.rejects(
    () => createPublisher({ ...allowed, topic_memberships: Array.from({ length: 12_001 }, () => rawMembership("too-many", 1)) }).readTopicContext(SESSION_ID, "ko"),
    /INVALID_TOPIC_RPC_RESPONSE/u,
  );

  const otherSessionId = "44444444-4444-4444-8444-444444444444";
  const wrongTopicSession = { ...allowed, topics: [rawTopic({ sessionId: otherSessionId })], topic_memberships: [] };
  await assert.rejects(() => createPublisher(wrongTopicSession).readTopicContext(SESSION_ID, "ko"), /INVALID_TOPIC_RPC_RESPONSE/u);
  const wrongMembershipSession = {
    ...allowed, topics: [rawTopic()],
    topic_memberships: [{ ...rawMembership("wrong-session", 1), session_id: otherSessionId }],
  };
  await assert.rejects(() => createPublisher(wrongMembershipSession).readTopicContext(SESSION_ID, "ko"), /INVALID_TOPIC_RPC_RESPONSE/u);
  const danglingMembership = {
    ...allowed, topics: [rawTopic()],
    topic_memberships: [{ ...rawMembership("dangling", 1), topic_id: "55555555-5555-4555-8555-555555555555" }],
  };
  await assert.rejects(() => createPublisher(danglingMembership).readTopicContext(SESSION_ID, "ko"), /INVALID_TOPIC_RPC_RESPONSE/u);

  const tooManyEventMemberships = {
    ok: true, status: "applied", event: "topic-upsert", topics: [rawTopic()],
    memberships_added: Array.from({ length: 51 }, (_, index) => rawMembership(`event-${index}`, index + 1)),
  };
  await assert.rejects(
    () => createPublisher(tooManyEventMemberships).applyTopicTransition({
      sessionId: SESSION_ID, language: "ko", utteranceKey: "u-cap", sourceSeq: 1,
      meaningful: true, decision: "continue", expectedTopicId: TOPIC_ID, expectedVersion: 1,
      title: "운영 실적", summary: "요약", detectorHealth: "healthy",
    }),
    /INVALID_TOPIC_RPC_RESPONSE/u,
  );
});

test("publisher hydrates mixed-language source siblings in emitted-time order", async () => {
  const calls = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url) {
      const parsed = new URL(url);
      calls.push(parsed);
      return Response.json([
        { emitted_at: "2026-08-15T00:00:02.000Z", text: "두 번째 문장", utterance_key: "assigned-2" },
        { emitted_at: "2026-08-15T00:00:01.000Z", text: "첫 번째 문장", utterance_key: "assigned-1" },
      ]);
    },
  });

  const finals = await publisher.fetchRecentTopicFinals(SESSION_ID, ["assigned-2", "assigned-1"]);
  assert.deepEqual(finals, [{ text: "첫 번째 문장" }, { text: "두 번째 문장" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls.every((url) => url.pathname === "/rest/v1/live_utterances"), true);
  assert.equal(calls.every((url) => url.searchParams.get("origin") === "eq.source"), true);
  assert.equal(calls.every((url) => url.searchParams.has("language") === false), true);
  assert.equal(calls.every((url) => url.searchParams.get("select") === "text,utterance_key,emitted_at"), true);
  assert.equal(calls.every((url) => url.searchParams.get("limit") === "2"), true);
  assert.equal(calls[0].searchParams.get("utterance_key"), "in.(\"assigned-2\",\"assigned-1\")");

  const malformed = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn() {
      return Response.json([{
        emitted_at: "2026-08-15T00:00:01.000Z", text: "<secret>", utterance_key: "assigned-1",
      }]);
    },
  });
  await assert.rejects(
    () => malformed.fetchRecentTopicFinals(SESSION_ID, ["assigned-1"]),
    /INVALID_TOPIC_CONTEXT_RESPONSE/u,
  );
});
