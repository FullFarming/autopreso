import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSheetBatchRequests,
  createLiveSheetSyncWorker,
  type LiveSheetProjection,
  type SheetSyncClaim,
} from "./index";

const CLAIM: SheetSyncClaim = {
  jobId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
  claimToken: "0192d0f4-9f72-7a36-91f5-6a76ef736f43",
  sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f42",
  sessionIndexRow: 8,
  sheetId: 91,
  tabTitle: "2026-08-15 실적 발표",
  shouldCreate: true,
  projectionVersion: 4,
  previousParticipantCount: 3,
  workbookRefVersion: 1,
  reason: "participant_changed",
};

const PROJECTION: LiveSheetProjection = {
  sessionId: CLAIM.sessionId,
  projectionVersion: 4,
  sessionIndexRow: 8,
  sheetId: 91,
  tabTitle: "2026-08-15 실적 발표",
  shouldCreate: true,
  previousParticipantCount: 3,
  session: {
    date: "2026-08-15", title: "실적 발표", status: "stopped", languages: ["ko", "en"],
    participantCount: 1, summaryState: "ready", sheetSyncState: "running",
    sheetLink: "https://docs.google.com/spreadsheets/d/workbook/edit#gid=91",
  },
  participants: [{
    email: "private@example.com", company: "+Example", department: "Finance", jobTitle: "Director",
    joinedAt: "2026-08-15T01:00:00.000Z",
    privacy: { state: "accepted", at: "2026-08-15T01:00:01.000Z" },
    summaryDelivery: { state: "declined", at: "2026-08-15T01:00:01.000Z" },
    marketing: { state: "withdrawn", at: "2026-08-15T01:30:00.000Z" },
    deliveryStatus: "not_requested",
  }],
};

test("projection creates or reuses a deterministic tab and atomically overwrites index plus bounded participant snapshot", () => {
  const requests = buildSheetBatchRequests(PROJECTION, { sessionIndexSheetId: 7 });
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[0], { addSheet: { properties: { sheetId: 91, title: "2026-08-15 실적 발표" } } });
  const serialized = JSON.stringify(requests);
  assert.match(serialized, /세션 ID/u);
  assert.match(serialized, /참여자 이메일/u);
  assert.match(serialized, /"stringValue":"private@example.com"/u);
  assert.match(serialized, /"stringValue":"'\+Example"/u);
  assert.doesNotMatch(serialized, /formulaValue/u);
  assert.doesNotMatch(serialized, /transcript|summaryBody|token|privateKey/u);
  const participantUpdate = requests[3] as { updateCells: { range: { endRowIndex: number }; rows: unknown[] } };
  assert.equal(participantUpdate.updateCells.range.endRowIndex, 4, "trailing rows are cleared through the prior snapshot bound");
  assert.equal(participantUpdate.updateCells.rows.length, 2);

  const reused = buildSheetBatchRequests(
    { ...PROJECTION, shouldCreate: false, previousParticipantCount: 1 },
    { sessionIndexSheetId: 7 },
  );
  assert.equal(reused.length, 3);
});

test("legacy participants with no email project one empty literal without fabricating identity", () => {
  const requests = buildSheetBatchRequests({
    ...PROJECTION,
    participants: [{ ...PROJECTION.participants[0]!, email: null }],
  }, { sessionIndexSheetId: 7 });
  const serialized = JSON.stringify(requests);
  assert.match(serialized, /참여자 이메일/u);
  assert.match(serialized, /"stringValue":""/u);
  assert.doesNotMatch(serialized, /unknown@example|legacy@example|participant@example/u);
});

test("one claimed job performs one physical attempt and completion uses the exact claim fence", async () => {
  const calls: string[] = [];
  const worker = createLiveSheetSyncWorker({
    store: {
      async claimNext() { calls.push("claim"); return CLAIM; },
      async readCanonicalProjection(claim) { assert.deepEqual(claim, CLAIM); calls.push("read"); return PROJECTION; },
      async complete(claim, result) { assert.deepEqual(claim, CLAIM); assert.equal(result.participantCount, 1); calls.push("complete"); },
      async fail() { throw new Error("not reached"); },
    },
    sheetsClient: { async batchUpdate() { calls.push("provider"); } },
    sessionIndexSheetId: 7,
  });
  assert.deepEqual(await worker.runNext(), { status: "completed", jobId: CLAIM.jobId });
  assert.deepEqual(calls, ["claim", "read", "provider", "complete"]);
});

test("provider failure records one allowlisted code without retry or raw PII", async () => {
  let providerCalls = 0;
  const failures: string[] = [];
  const worker = createLiveSheetSyncWorker({
    store: {
      async claimNext() { return CLAIM; },
      async readCanonicalProjection() { return PROJECTION; },
      async complete() { throw new Error("not reached"); },
      async fail(_claim, code) { failures.push(code); },
    },
    sheetsClient: { async batchUpdate() { providerCalls += 1; throw new Error("private@example.com access-token"); } },
    sessionIndexSheetId: 7,
  });
  assert.deepEqual(await worker.runNext(), { status: "failed", jobId: CLAIM.jobId, code: "SHEETS_PROVIDER_FAILED" });
  assert.equal(providerCalls, 1);
  assert.deepEqual(failures, ["SHEETS_PROVIDER_FAILED"]);
});

test("invalid canonical projection is failed before any Google request", async () => {
  let providers = 0;
  const failures: string[] = [];
  const worker = createLiveSheetSyncWorker({
    store: {
      async claimNext() { return CLAIM; },
      async readCanonicalProjection() { return { ...PROJECTION, sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f99" }; },
      async complete() { throw new Error("not reached"); },
      async fail(_claim, code) { failures.push(code); },
    },
    sheetsClient: { async batchUpdate() { providers += 1; } },
    sessionIndexSheetId: 7,
  });
  assert.deepEqual(await worker.runNext(), { status: "failed", jobId: CLAIM.jobId, code: "SHEETS_INVALID_REQUEST" });
  assert.equal(providers, 0);
  assert.deepEqual(failures, ["SHEETS_INVALID_REQUEST"]);
});

test("a stalled physical request is aborted once and recorded without retry", async () => {
  let providers = 0;
  const failures: string[] = [];
  const worker = createLiveSheetSyncWorker({
    store: {
      async claimNext() { return CLAIM; },
      async readCanonicalProjection() { return PROJECTION; },
      async complete() { throw new Error("not reached"); },
      async fail(_claim, code) { failures.push(code); },
    },
    sheetsClient: {
      async batchUpdate(_requests, options) {
        providers += 1;
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("raw timeout private@example.com")), { once: true });
        });
      },
    },
    sessionIndexSheetId: 7,
    timeoutMilliseconds: 5,
  });
  assert.deepEqual(await worker.runNext(), { status: "failed", jobId: CLAIM.jobId, code: "SHEETS_ABORTED" });
  assert.equal(providers, 1);
  assert.deepEqual(failures, ["SHEETS_ABORTED"]);
});

test("a provider that completes after the deadline cannot cross the completion CAS fence", async () => {
  let completions = 0;
  const failures: string[] = [];
  const worker = createLiveSheetSyncWorker({
    store: {
      async claimNext() { return CLAIM; },
      async readCanonicalProjection() { return PROJECTION; },
      async complete() { completions += 1; },
      async fail(_claim, code) { failures.push(code); },
    },
    sheetsClient: {
      async batchUpdate(_requests, options) {
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => setImmediate(resolve), { once: true });
        });
      },
    },
    sessionIndexSheetId: 7,
    timeoutMilliseconds: 5,
  });
  assert.deepEqual(await worker.runNext(), { status: "failed", jobId: CLAIM.jobId, code: "SHEETS_ABORTED" });
  assert.equal(completions, 0);
  assert.deepEqual(failures, ["SHEETS_ABORTED"]);
});

test("concurrent triggers share one claim flight and an empty queue makes no provider call", async () => {
  let claims = 0;
  let providers = 0;
  const claimGate: { release?: () => void } = {};
  const worker = createLiveSheetSyncWorker({
    store: {
      async claimNext() {
        claims += 1;
        await new Promise<void>((resolve) => { claimGate.release = resolve; });
        return claims === 1 ? CLAIM : null;
      },
      async readCanonicalProjection() { return PROJECTION; },
      async complete() {}, async fail() {},
    },
    sheetsClient: { async batchUpdate() { providers += 1; } },
    sessionIndexSheetId: 7,
  });
  const first = worker.runNext();
  const duplicate = worker.runNext();
  assert.equal(first, duplicate);
  claimGate.release?.();
  assert.deepEqual(await first, { status: "completed", jobId: CLAIM.jobId });
  assert.equal(claims, 1);
  assert.equal(providers, 1);
});
