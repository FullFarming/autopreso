import assert from "node:assert/strict";
import test from "node:test";

import { LiveTopicCoordinator } from "../src/live-topic-coordinator.js";
import { createLiveTopicDetector } from "../src/live-topic-detector.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function caption(seq, prefix = "live") {
  return { seq, text: `${prefix} ${seq}`, utteranceKey: `${prefix}-${seq}` };
}

function emptyContext(latestSourceSeq = 0) {
  return {
    ok: true,
    event: "topic-upsert",
    topics: [],
    topicMemberships: [],
    membershipsAdded: [],
    latestSourceSeq,
  };
}

function applied(input) {
  return {
    ok: true,
    status: "applied",
    event: "topic-upsert",
    topics: [],
    membershipsAdded: [],
    input,
  };
}

function healthyDecision() {
  return {
    meaningful: true,
    startsNewTopic: false,
    title: null,
    summary: "논의 내용을 요약했습니다.",
    detectorHealth: "healthy",
    failureCode: null,
  };
}

test("coordinator persists provider summary and retains it on failure without source-text fallback", async () => {
  const inputs = [];
  const requests = [];
  const current = { id: "topic-1", version: 1, status: "active", title: "임대 현황", summary: "이전 AI 요약" };
  let call = 0;
  const coordinator = new LiveTopicCoordinator({
    detector: { async detect(input) {
      requests.push(input);
      call += 1;
      if (call === 1) return { ...healthyDecision(), summary: "신규 계약이 늘어 공실 부담이 줄었습니다." };
      if (call === 2) throw new Error("provider unavailable");
      return { ...healthyDecision(), summary: "<script>unsafe</script>" };
    } },
    store: {
      async readTopicContext() { return { ...emptyContext(), topics: [current] }; },
      async applyTopicTransition(input) {
        inputs.push(input);
        current.summary = input.summary;
        current.version += 1;
        return { ...applied(input), topics: [{ ...current }] };
      },
    },
    eventFanout: async () => {},
  });
  await coordinator.start(SESSION_ID, ["ko"]);
  for (let seq = 1; seq <= 3; seq += 1) {
    coordinator.enqueueSourceFinal(SESSION_ID, "ko", { ...caption(seq), text: `새로운 원문 ${seq}` });
    await coordinator.drain(SESSION_ID);
  }
  assert.equal(inputs[0].summary, "신규 계약이 늘어 공실 부담이 줄었습니다.");
  assert.equal(requests[0].previousSummary, "이전 AI 요약");
  assert.equal(requests[1].previousSummary, inputs[0].summary);
  assert.deepEqual(inputs.slice(1).map((input) => [input.summary, input.detectorHealth]), [
    [inputs[0].summary, "degraded"], [inputs[0].summary, "degraded"],
  ]);
  assert.equal(inputs.some((input) => input.summary.includes("새로운 원문")), false);
});

test("a stale AI summary cannot overwrite a newer topic after a version conflict", async () => {
  const inputs = [];
  let reads = 0;
  let calls = 0;
  const coordinator = new LiveTopicCoordinator({
    detector: { async detect() { calls += 1; return { ...healthyDecision(), summary: "이전 맥락의 AI 요약" }; } },
    store: {
      async readTopicContext() {
        reads += 1;
        return { ...emptyContext(), topics: [{ id: "topic-1", status: "active", title: "논의", version: reads,
          summary: reads === 1 ? "이전 저장 요약" : "다른 발언이 반영된 최신 요약" }] };
      },
      async applyTopicTransition(input) {
        inputs.push(input);
        return inputs.length === 1 ? { ok: false, code: "TOPIC_VERSION_CONFLICT" } : applied(input);
      },
    },
    eventFanout: async () => {},
  });
  await coordinator.start(SESSION_ID, ["ko"]);
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(1));
  await coordinator.drain(SESSION_ID);
  assert.equal(inputs[1].summary, "다른 발언이 반영된 최신 요약");
  assert.equal(inputs[1].detectorHealth, "degraded");
  assert.equal(calls, 1);
});

test("partial and filler inputs cost zero requests while duplicate finals share one summary request", async () => {
  let calls = 0;
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const inputs = [];
  const active = { id: "topic-1", version: 1, status: "active", title: "회의", summary: "기존 AI 요약", detectorHealth: "degraded" };
  const coordinator = new LiveTopicCoordinator({
    detector: createLiveTopicDetector({ async generate() { calls += 1; return response; } }),
    store: {
      async readTopicContext() { return { ...emptyContext(), topics: [active] }; },
      async applyTopicTransition(input) { inputs.push(input); return { ...applied(input), topics: [{ ...active, summary: input.summary }] }; },
    },
    eventFanout: async () => {},
  });
  await coordinator.start(SESSION_ID, ["ko"]);
  coordinator.notePartial(SESSION_ID);
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", { ...caption(1), text: "음... 네, 감사합니다." });
  await coordinator.drain(SESSION_ID);
  assert.equal(calls, 0);
  assert.equal(inputs[0].summary, "기존 AI 요약");
  assert.equal(inputs[0].detectorHealth, "degraded", "filler cannot claim a failed summary has recovered");
  assert.equal(coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(2)), true);
  assert.equal(coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(2)), false);
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
  release({ outputText: JSON.stringify({ meaningful: true, startsNewTopic: false, title: null, summary: "새 AI 요약" }) });
  await coordinator.drain(SESSION_ID);
  assert.equal(coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(2)), false);
  assert.equal(calls, 1);
  assert.equal(inputs[1].summary, "새 AI 요약");
});

test("live finals jump ahead of paged recovery after the current durable transition", async () => {
  const order = [];
  let releaseFirst;
  const firstDecision = new Promise((resolve) => { releaseFirst = resolve; });
  const recovered = [caption(1, "recovery"), caption(2, "recovery"), caption(3, "recovery")]
    .map((value) => ({
      utteranceKey: value.utteranceKey,
      sourceLanguage: "ko",
      sourceSeq: value.seq,
      text: value.text,
      emittedAt: "2026-08-15T00:00:00.000Z",
    }));
  let detectorCalls = 0;
  const coordinator = new LiveTopicCoordinator({
    detector: {
      async detect({ candidateSourceFinal }) {
        detectorCalls += 1;
        order.push(`detect:${candidateSourceFinal.text}`);
        if (detectorCalls === 1) return firstDecision;
        return healthyDecision();
      },
    },
    store: {
      async readTopicContext() { return emptyContext(3); },
      async recoverTopicAssignments() {
        return { ok: true, unassignedFinals: recovered, nextSourceSeq: 3 };
      },
      async applyTopicTransition(input) {
        order.push(`apply:${input.utteranceKey}`);
        return applied(input);
      },
    },
    eventFanout: async () => {},
    maxRecoveryItemsPerSlice: 1,
    yieldFn: () => new Promise((resolve) => setImmediate(resolve)),
  });

  const starting = coordinator.start(SESSION_ID, ["ko"]);
  while (detectorCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(9));
  releaseFirst(healthyDecision());
  await starting;
  await coordinator.drain(SESSION_ID);

  assert.deepEqual(order, [
    "detect:recovery 1", "apply:recovery-1",
    "detect:live 9", "apply:live-9",
    "detect:recovery 2", "apply:recovery-2",
    "detect:recovery 3", "apply:recovery-3",
  ]);
});

test("the pending live queue is bounded and sends overflow back through durable recovery", async () => {
  const failures = [];
  const processed = [];
  let releaseFirst;
  const firstDecision = new Promise((resolve) => { releaseFirst = resolve; });
  let detectorCalls = 0;
  const coordinator = new LiveTopicCoordinator({
    detector: {
      async detect() {
        detectorCalls += 1;
        if (detectorCalls === 1) return firstDecision;
        return healthyDecision();
      },
    },
    store: {
      async readTopicContext() { return emptyContext(); },
      async recoverTopicAssignments() {
        return {
          ok: true,
          unassignedFinals: [{
            utteranceKey: "live-4",
            sourceLanguage: "ko",
            sourceSeq: 4,
            text: "live 4",
            emittedAt: "2026-08-15T00:00:00.000Z",
          }],
          nextSourceSeq: 4,
        };
      },
      async applyTopicTransition(input) {
        processed.push(input.utteranceKey);
        return applied(input);
      },
    },
    eventFanout: async () => {},
    maxPendingLiveFinals: 2,
    observeFailure(code) { failures.push(code); },
  });
  await coordinator.start(SESSION_ID, ["ko"]);

  coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(1));
  while (detectorCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(2));
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(3));
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(4));
  releaseFirst(healthyDecision());
  await coordinator.drain(SESSION_ID);

  assert.deepEqual(processed, ["live-1", "live-2", "live-3", "live-4"]);
  assert.deepEqual(failures, ["TOPIC_LIVE_QUEUE_FULL"]);

  coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(4));
  await coordinator.drain(SESSION_ID);
  assert.deepEqual(processed, ["live-1", "live-2", "live-3", "live-4"]);
});

test("recovery observes page and count budgets while preserving a monotonic cursor", async () => {
  const calls = [];
  const processed = [];
  const failures = [];
  const coordinator = new LiveTopicCoordinator({
    detector: { async detect() { return healthyDecision(); } },
    store: {
      async readTopicContext() { return emptyContext(500); },
      async recoverTopicAssignments(_sessionId, _language, cursor) {
        calls.push(cursor);
        const start = cursor + 1;
        return {
          ok: true,
          unassignedFinals: Array.from({ length: 100 }, (_, index) => ({
            utteranceKey: `recovery-${start + index}`,
            sourceLanguage: "ko",
            sourceSeq: start + index,
            text: `recovery ${start + index}`,
            emittedAt: "2026-08-15T00:00:00.000Z",
          })),
          nextSourceSeq: cursor + 100,
        };
      },
      async applyTopicTransition(input) {
        processed.push(input.sourceSeq);
        return applied(input);
      },
    },
    eventFanout: async () => {},
    maxRecoveryPages: 2,
    maxRecoveryItems: 150,
    maxRecoveryItemsPerSlice: 10,
    observeFailure(code) { failures.push(code); },
    yieldFn: async () => {},
  });

  await coordinator.start(SESSION_ID, ["ko"]);
  await coordinator.drain(SESSION_ID);

  assert.deepEqual(calls, [0, 100]);
  assert.equal(processed.length, 150);
  assert.deepEqual(processed.slice(0, 3), [1, 2, 3]);
  assert.deepEqual(processed.slice(-3), [148, 149, 150]);
  assert.deepEqual(failures, ["TOPIC_RECOVERY_BUDGET_EXHAUSTED"]);
});

test("recovery stops at the elapsed-time budget without starting another transition", async () => {
  const processed = [];
  const failures = [];
  let recoveryTime = 0;
  const coordinator = new LiveTopicCoordinator({
    detector: { async detect() { return healthyDecision(); } },
    store: {
      async readTopicContext() { return emptyContext(2); },
      async recoverTopicAssignments() {
        return {
          ok: true,
          unassignedFinals: [1, 2].map((sourceSeq) => ({
            utteranceKey: `recovery-${sourceSeq}`,
            sourceLanguage: "ko",
            sourceSeq,
            text: `recovery ${sourceSeq}`,
            emittedAt: "2026-08-15T00:00:00.000Z",
          })),
          nextSourceSeq: 2,
        };
      },
      async applyTopicTransition(input) {
        processed.push(input.sourceSeq);
        recoveryTime = 5;
        return applied(input);
      },
    },
    eventFanout: async () => {},
    maxRecoveryMilliseconds: 5,
    recoveryNow: () => recoveryTime,
    observeFailure(code) { failures.push(code); },
  });

  await coordinator.start(SESSION_ID, ["ko"]);
  await coordinator.drain(SESSION_ID);

  assert.deepEqual(processed, [1]);
  assert.deepEqual(failures, ["TOPIC_RECOVERY_BUDGET_EXHAUSTED"]);
});

test("seen utterance keys use a bounded oldest-first window", async () => {
  const processed = [];
  const coordinator = new LiveTopicCoordinator({
    detector: { async detect() { return healthyDecision(); } },
    store: {
      async readTopicContext() { return emptyContext(); },
      async applyTopicTransition(input) {
        processed.push(input.utteranceKey);
        return { ...applied(input), status: "idempotent" };
      },
    },
    eventFanout: async () => {},
    maxSeenUtteranceKeys: 2,
  });
  await coordinator.start(SESSION_ID, ["ko"]);
  for (const seq of [1, 2, 3]) {
    coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(seq));
    await coordinator.drain(SESSION_ID);
  }

  coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(1));
  await coordinator.drain(SESSION_ID);
  assert.deepEqual(processed, ["live-1", "live-2", "live-3", "live-1"]);
});

test("ending a session clears queue state so a restarted session can process the same durable key", async () => {
  const processed = [];
  const store = {
    async readTopicContext() { return emptyContext(); },
    async applyTopicTransition(input) {
      processed.push(input.utteranceKey);
      return applied(input);
    },
    async completeTopicsOnSessionEnd() { return 0; },
  };
  const coordinator = new LiveTopicCoordinator({
    detector: { async detect() { return healthyDecision(); } },
    store,
    eventFanout: async () => {},
  });

  await coordinator.start(SESSION_ID, ["ko"]);
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(1));
  await coordinator.end(SESSION_ID);
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(2));
  await coordinator.start(SESSION_ID, ["ko"]);
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(1));
  await coordinator.drain(SESSION_ID);

  assert.deepEqual(processed, ["live-1", "live-1"]);
});

test("topic detection receives the authoritative coordinator session id", async () => {
  const detectedSessionIds = [];
  const coordinator = new LiveTopicCoordinator({
    detector: {
      async detect(input) {
        detectedSessionIds.push(input.sessionId);
        return healthyDecision();
      },
    },
    store: {
      async readTopicContext() { return emptyContext(); },
      async applyTopicTransition(input) { return applied(input); },
    },
    eventFanout: async () => {},
  });
  await coordinator.start(SESSION_ID, ["ko"]);
  coordinator.enqueueSourceFinal(SESSION_ID, "ko", caption(1));
  await coordinator.drain(SESSION_ID);
  assert.deepEqual(detectedSessionIds, [SESSION_ID]);
});

test("a source final cannot cross into an unregistered session queue", async () => {
  let detectorCalls = 0;
  let transitionCalls = 0;
  const coordinator = new LiveTopicCoordinator({
    detector: { async detect() { detectorCalls += 1; return healthyDecision(); } },
    store: {
      async readTopicContext() { return emptyContext(); },
      async applyTopicTransition(input) { transitionCalls += 1; return applied(input); },
    },
    eventFanout: async () => {},
  });
  await coordinator.start(SESSION_ID, ["ko"]);
  assert.equal(coordinator.enqueueSourceFinal("22222222-2222-4222-8222-222222222222", "ko", caption(1)), false);
  await coordinator.drain(SESSION_ID);
  assert.equal(detectorCalls, 0);
  assert.equal(transitionCalls, 0);
});

test("start resolves after context hydration while recovery continues in the background", async () => {
  let releaseRecovery;
  const recoveryDecision = new Promise((resolve) => { releaseRecovery = resolve; });
  let detectorCalls = 0;
  const coordinator = new LiveTopicCoordinator({
    detector: {
      async detect() {
        detectorCalls += 1;
        return recoveryDecision;
      },
    },
    store: {
      async readTopicContext() { return emptyContext(1); },
      async recoverTopicAssignments() {
        return {
          ok: true,
          unassignedFinals: [{
            utteranceKey: "recovery-1", sourceLanguage: "ko", sourceSeq: 1,
            text: "recovery 1", emittedAt: "2026-08-15T00:00:00.000Z",
          }],
          nextSourceSeq: 1,
        };
      },
      async applyTopicTransition(input) { return applied(input); },
    },
    eventFanout: async () => {},
  });

  const started = coordinator.start(SESSION_ID, ["ko"]);
  const outcome = await Promise.race([
    started.then(() => "started"),
    new Promise((resolve) => setImmediate(() => resolve("blocked"))),
  ]);
  assert.equal(outcome, "started");
  while (detectorCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  releaseRecovery(healthyDecision());
  await coordinator.drain(SESSION_ID);
});
