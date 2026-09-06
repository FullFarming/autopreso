import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BoundedJsonBodyError,
  MAX_LIVE_JSON_BODY_BYTES,
  readBoundedJsonBody,
} from "../security/bounded-json-body";

test("bounded live JSON accepts exact application/json with declared or streaming length", async () => {
  const body = JSON.stringify({ summaryConsent: true });
  const declared = new Request("https://app.example.com/api/live", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(body).byteLength),
    },
    body,
  });
  const streaming = new Request("https://app.example.com/api/live", {
    method: "PUT",
    headers: { "content-type": "application/json; charset=UTF-8" },
    body,
  });

  assert.deepEqual(await readBoundedJsonBody(declared), { summaryConsent: true });
  assert.deepEqual(await readBoundedJsonBody(streaming), { summaryConsent: true });
});

test("bounded live JSON rejects hostile content types, lengths, and malformed bodies", async () => {
  const cases = [
    new Request("https://app.example.com/api/live", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    }),
    new Request("https://app.example.com/api/live", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "01" },
      body: "{}",
    }),
    new Request("https://app.example.com/api/live", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_LIVE_JSON_BODY_BYTES + 1),
      },
      body: "{}",
    }),
    new Request("https://app.example.com/api/live", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
  ];

  for (const request of cases) {
    await assert.rejects(() => readBoundedJsonBody(request), BoundedJsonBodyError);
  }
});

test("bounded live JSON counts UTF-8 bytes and stops missing-length streams over the limit", async () => {
  const multibyte = JSON.stringify({ value: "가" });
  const multibyteBytes = new TextEncoder().encode(multibyte).byteLength;
  await assert.rejects(
    () => readBoundedJsonBody(new Request("https://app.example.com/api/live", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: multibyte,
    }), multibyteBytes - 1),
    (error: unknown) => error instanceof BoundedJsonBodyError && error.status === 413,
  );

  await assert.rejects(
    () => readBoundedJsonBody(new Request("https://app.example.com/api/live", {
      method: "POST",
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      body: JSON.stringify({ value: "x".repeat(MAX_LIVE_JSON_BODY_BYTES) }),
    })),
    (error: unknown) => error instanceof BoundedJsonBodyError && error.status === 413,
  );
});

test("participant consent route enforces origin, participant auth, rate limit, then parses body", () => {
  const source = readFileSync("app/api/live-sessions/[id]/consents/route.ts", "utf8");
  const originIndex = source.indexOf("assertStrictOrigin(request)");
  const authIndex = source.indexOf("authorizeParticipantRecordRequest(request, sessionId, admissionStore)");
  const rateIndex = source.indexOf("enforceLiveConsentRateLimit(participant.userId, sessionId, admissionStore)");
  const parseIndex = source.indexOf("await readBoundedJsonBody(request)");
  const updateIndex = source.indexOf("updateParticipantConsents(sessionId, participant.userId, body)");

  assert.ok(originIndex >= 0);
  assert.ok(originIndex < authIndex);
  assert.ok(authIndex < rateIndex);
  assert.ok(rateIndex < parseIndex);
  assert.ok(parseIndex < updateIndex);
  assert.doesNotMatch(source.slice(parseIndex, updateIndex), /participantId|body\.sessionId/u);
});

test("public join validates and bounds JSON before schema parsing", () => {
  const source = readFileSync("app/api/live-sessions/join/route.ts", "utf8");
  const boundedReadIndex = source.indexOf("await readBoundedJsonBody(request)");
  const schemaIndex = source.indexOf("joinLiveSessionInputSchema.safeParse");
  const rateIndex = source.indexOf("enforceJoinPreflightRateLimits(request, body.deviceId, store)");

  assert.ok(boundedReadIndex >= 0 && boundedReadIndex < schemaIndex && schemaIndex < rateIndex);
  assert.match(source, /BoundedJsonBodyError/u);
  assert.match(source, /withCors\(apiError\(error\.message, error\.code, error\.status\), request\)/u);
});

test("live records routes are host-authenticated and private no-store", () => {
  const routeSources = [
    "app/api/live-records/route.ts",
    "app/api/live-records/[id]/route.ts",
    "app/api/live-records/[id]/restore/route.ts",
    "app/api/live-records/[id]/purge-eligibility/route.ts",
    "app/api/live-records/[id]/transcript/route.ts",
  ].map((path) => readFileSync(path, "utf8"));

  for (const source of routeSources) {
    assert.match(source, /requireHost\(request\)|requireHost\(_request\)/u);
    assert.match(source, /privateNoStoreHeaders\(\)/u);
  }

  const detailSource = routeSources[1] ?? "";
  assert.ok(detailSource.indexOf("requireHost(request)") < detailSource.indexOf("service.getDetail(hostId, sessionId"));
  assert.ok(detailSource.indexOf("requireHost(_request)") < detailSource.indexOf("service.softDelete(hostId, sessionId"));
});

test("authoritative transcript route authorizes the host before reading immutable audit rows", () => {
  const source = readFileSync("app/api/live-records/[id]/transcript/route.ts", "utf8");
  const authIndex = source.indexOf("requireHost(request)");
  const rateLimitIndex = source.indexOf("enforceAuthoritativeTranscriptReadRateLimit(hostId, sessionId, admissionStore)");
  const readIndex = source.indexOf("service.getAuthoritativeTranscript(hostId, sessionId");

  assert.ok(authIndex >= 0);
  assert.ok(rateLimitIndex > authIndex);
  assert.ok(readIndex > rateLimitIndex);
  assert.doesNotMatch(source, /authorizeParticipantRecordRequest|isHostOwnershipMiss/u);
  assert.match(source, /privateNoStoreHeaders\(\)/u);
});

test("summary generation rejects non-terminal sessions before claiming provider work", () => {
  const source = readFileSync("app/api/live-sessions/[id]/summary/route.ts", "utf8");
  const post = source.slice(source.indexOf("export async function POST"), source.indexOf("export async function GET"));
  const ownershipIndex = post.indexOf("assertHostSessionOwnership(sessionId, hostId)");
  const lifecycleIndex = post.indexOf("readSessionLifecycle(sessionId)");
  const terminalIndex = post.indexOf("isTerminalSummarySession(lifecycle)");
  const claimIndex = post.indexOf("claimMeetingSummaryGeneration(sessionId, language)");

  assert.ok(ownershipIndex >= 0 && ownershipIndex < lifecycleIndex);
  assert.ok(lifecycleIndex < terminalIndex && terminalIndex < claimIndex);
  assert.match(source, /lifecycle\.status === "stopped" \|\| lifecycle\.status === "failed"/u);
  assert.match(source, /SUMMARY_SESSION_NOT_ENDED/u);
});
