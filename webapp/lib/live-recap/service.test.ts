import assert from "node:assert/strict";
import test from "node:test";
import { LiveRecapService, type LiveRecapStore } from "./service";
import { RECAP_NOTICE_VERSION, type RecapRequest, type RecapRequestInput } from "./contract";

const sessionId = "11111111-1111-4111-8111-111111111111";
const key = "22222222-2222-4222-8222-222222222222";
const record: RecapRequest = { id: key, sessionId, requestedAt: "2026-08-31T00:00:00Z",
  noticeVersion: RECAP_NOTICE_VERSION, status: "requested", email: "participant@example.test", revision: 1 };

function fixture() {
  const calls: { sessionId: string; userId: string; input: RecapRequestInput }[] = [];
  const store: LiveRecapStore = {
    request: async (sessionId, userId, input) => { calls.push({ sessionId, userId, input }); return record; },
    readRequest: async () => record,
    readRecipients: async () => ({ requests: [] }),
    readExportSnapshot: async () => { throw new Error("unused"); },
  };
  return { service: new LiveRecapService(store), calls };
}

test("recap request passes only authenticated identity and affirmative current notice to its atomic store", async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.request(sessionId, "authenticated-user", {
    accepted: true, noticeVersion: RECAP_NOTICE_VERSION, idempotencyKey: key,
  }), record);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.userId, "authenticated-user");
  assert.deepEqual(Object.keys(calls[0]?.input ?? {}).sort(), ["accepted", "idempotencyKey", "noticeVersion"]);
});

test("recap request rejects injected recipients, marketing changes, old notices and non-affirmative consent before storage", async () => {
  const { service, calls } = fixture();
  const base = { accepted: true, noticeVersion: RECAP_NOTICE_VERSION, idempotencyKey: key };
  for (const input of [{ ...base, email: "victim@example.test" }, { ...base, marketingConsent: true },
    { ...base, participantId: key }, { ...base, accepted: false }, { ...base, noticeVersion: "summary-delivery-v1" },
    { ...base, idempotencyKey: "invalid" }]) {
    await assert.rejects(() => service.request(sessionId, "user", input), { code: "INVALID_RECAP_REQUEST" });
  }
  assert.equal(calls.length, 0);
});

test("repeat requests preserve database outcome and timestamp without creating email work", async () => {
  const { service } = fixture();
  const input = { accepted: true, noticeVersion: RECAP_NOTICE_VERSION, idempotencyKey: key };
  const results = await Promise.all([service.request(sessionId, "user", input), service.request(sessionId, "user", input)]);
  assert.deepEqual(results, [record, record]);
});
