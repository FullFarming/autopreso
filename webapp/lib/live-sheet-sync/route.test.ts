import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("sheet retry route is the only public sync mutation and orders origin, ADMIN auth, rate, atomic retry, then post-commit work", () => {
  const source = readFileSync("app/api/live-records/[id]/sheet-sync/retry/route.ts", "utf8");
  const origin = source.indexOf("assertStrictOrigin(request)");
  const auth = source.indexOf("requireHost(request)");
  const parse = source.indexOf("const sessionId = parseSessionId");
  const retry = source.indexOf("retryOwned(hostId, sessionId)");
  assert.ok(origin >= 0 && origin < auth && auth < parse && parse < retry);
  assert.match(source, /privateNoStoreHeaders\(\)/u);
  assert.doesNotMatch(source, /request\.json\(|jobId|fetch\(/u);
  assert.equal(readFileSync("components/live/records/records-client.ts", "utf8").includes("/sheet-sync/retry"), true);
});

test("canonical session mutations schedule the internal worker only after their durable mutation", () => {
  const cases = [
    ["app/api/live-sessions/route.ts", ".create(hostId", "scheduleLiveSheetSyncAfterCommit(after)"],
    ["app/api/live-sessions/join/route.ts", "store.redeemAttendee(", "scheduleLiveSheetSyncAfterCommit(after)"],
    ["app/api/live-sessions/[id]/consents/route.ts", "updateParticipantConsents(", "scheduleLiveSheetSyncAfterCommit(after)"],
    ["app/api/live-sessions/[id]/route.ts", ".end(hostId, id)", "scheduleLiveSheetSyncAfterCommit(after)"],
    ["app/api/live-records/[id]/route.ts", ".softDelete(hostId, sessionId)", "scheduleLiveSheetSyncAfterCommit(after)"],
    ["app/api/live-records/[id]/restore/route.ts", ".restore(hostId, sessionId)", "scheduleLiveSheetSyncAfterCommit(after)"],
  ] as const;
  for (const [path, mutation, schedule] of cases) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /import \{ after/u, path);
    const mutationIndex = source.indexOf(mutation);
    assert.ok(mutationIndex >= 0, path);
    assert.ok(mutationIndex < source.indexOf(schedule, mutationIndex), path);
  }
});

test("manual and automatic summary completion schedule the Sheets worker after durable completion", () => {
  const manualSource = readFileSync("app/api/live-sessions/[id]/summary/route.ts", "utf8");
  const manualCompletion = manualSource.indexOf("completeMeetingSummaryGeneration(");
  assert.ok(manualCompletion >= 0);
  assert.ok(manualCompletion < manualSource.indexOf("scheduleLiveSheetSyncAfterCommit(after)", manualCompletion));

  const endSource = readFileSync("app/api/live-sessions/[id]/route.ts", "utf8");
  const automaticCompletion = endSource.indexOf("await generateSessionSummariesAfterEnd(");
  assert.ok(automaticCompletion >= 0);
  assert.ok(automaticCompletion < endSource.indexOf("scheduleLiveSheetSyncAfterCommit(after)", automaticCompletion));
});
