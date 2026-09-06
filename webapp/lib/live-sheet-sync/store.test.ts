import assert from "node:assert/strict";
import test from "node:test";

import { SupabaseLiveSheetSyncStore } from "./store";

const JOB_ID = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";
const SESSION_ID = "0192d0f4-9f72-7a36-91f5-6a76ef736f42";
const CLAIM_TOKEN = "0192d0f4-9f72-7a36-91f5-6a76ef736f43";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("store claims, reads, completes, and fails only through exact fenced RPC shapes", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const responses = [
    jsonResponse([{
      job_id: JOB_ID, session_id: SESSION_ID, session_index_row: 8, sheet_id: 91,
      tab_title: "2026-08-15 실적 발표 #91", should_create: true, projection_version: 4,
      previous_participant_count: 3, workbook_ref_version: 1, reason: "participant_changed",
    }]),
    jsonResponse([{
      session_index_row: 8, sheet_id: 91, tab_title: "2026-08-15 실적 발표 #91", should_create: true,
      projection_version: 4, previous_participant_count: 3, session_id: SESSION_ID,
      session_date: "2026-08-15", session_title: "실적 발표", session_status: "stopped",
      summary_state: "ready", languages: ["ko", "en"], archived_at: null, archive_deleted_at: null,
      participant_count: 1,
      participants: [{
        participantId: "0192d0f4-9f72-7a36-91f5-6a76ef736f44", email: null,
        company: null, department: "Finance", jobTitle: "Director",
        joinedAt: "2026-08-15T01:00:00.000Z", leftAt: null, deliveryStatus: "eligible",
        consents: {
          privacy: { noticeVersion: "v1", isAccepted: true, acceptedAt: "2026-08-15T01:00:01.000Z", withdrawnAt: null, recordedAt: "2026-08-15T01:00:01.000Z" },
          summary_delivery: { noticeVersion: "v1", isAccepted: false, acceptedAt: null, withdrawnAt: null, recordedAt: "2026-08-15T01:00:02.000Z" },
        },
      }],
    }]),
    jsonResponse(true),
    jsonResponse(true),
  ];
  const store = new SupabaseLiveSheetSyncStore({
    baseUrl: "https://project-ref.supabase.co",
    credential: { key: "server-secret", kind: "secret" },
    workbookId: "workbook_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    randomUuid: () => CLAIM_TOKEN,
    async fetchFn(input, init) {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return responses.shift() ?? jsonResponse(null, 500);
    },
  });

  const claim = await store.claimNext();
  assert.ok(claim);
  assert.equal(claim.claimToken, CLAIM_TOKEN);
  const projection = await store.readCanonicalProjection(claim);
  assert.equal(projection.session.sheetLink, "https://docs.google.com/spreadsheets/d/workbook_ABCDEFGHIJKLMNOPQRSTUVWXYZ/edit#gid=91");
  assert.equal(projection.participants[0]?.email, null, "legacy identity must remain absent rather than be fabricated");
  assert.equal(projection.participants[0]?.privacy.state, "accepted");
  assert.equal(projection.participants[0]?.summaryDelivery.state, "declined");
  assert.equal(projection.participants[0]?.marketing.state, "not_recorded");
  assert.doesNotMatch(JSON.stringify(projection), /unknown@example|legacy@example/u);
  await store.complete(claim, { participantCount: 1 });
  await store.fail(claim, "SHEETS_UNAVAILABLE");

  assert.deepEqual(calls.map((call) => call.url.slice(call.url.lastIndexOf("/") + 1)), [
    "claim_live_sheet_sync_job_v1", "read_live_sheet_projection_v1",
    "complete_live_sheet_sync_job_v1", "fail_live_sheet_sync_job_v1",
  ]);
  assert.deepEqual(calls[0]?.body, { p_claim_token: CLAIM_TOKEN });
  assert.deepEqual(calls[2]?.body, {
    p_job_id: JOB_ID, p_claim_token: CLAIM_TOKEN, p_projection_version: 4, p_participant_count: 1,
  });
});

test("store returns null only for an empty claim and rejects unknown or mismatched provider fields", async () => {
  const empty = new SupabaseLiveSheetSyncStore({
    baseUrl: "https://project-ref.supabase.co", credential: { key: "server-secret", kind: "secret" },
    workbookId: "workbook_ABCDEFGHIJKLMNOPQRSTUVWXYZ", randomUuid: () => CLAIM_TOKEN,
    async fetchFn() { return jsonResponse([]); },
  });
  assert.equal(await empty.claimNext(), null);

  for (const badRow of [
    [{ job_id: JOB_ID, unexpected: true }],
    [{
      job_id: JOB_ID, session_id: SESSION_ID, session_index_row: 8, sheet_id: 91,
      tab_title: "tab", should_create: true, projection_version: 4,
      previous_participant_count: 0, workbook_ref_version: 2, reason: "participant_changed",
    }],
    [{
      job_id: JOB_ID, session_id: SESSION_ID, session_index_row: 8, sheet_id: 0,
      tab_title: "tab", should_create: true, projection_version: 4,
      previous_participant_count: 0, workbook_ref_version: 1, reason: "participant_changed",
    }],
    [{
      job_id: JOB_ID, session_id: SESSION_ID, session_index_row: 8, sheet_id: 2_147_483_648,
      tab_title: "tab", should_create: true, projection_version: 4,
      previous_participant_count: 0, workbook_ref_version: 1, reason: "participant_changed",
    }],
  ]) {
    const store = new SupabaseLiveSheetSyncStore({
      baseUrl: "https://project-ref.supabase.co", credential: { key: "server-secret", kind: "secret" },
      workbookId: "workbook_ABCDEFGHIJKLMNOPQRSTUVWXYZ", randomUuid: () => CLAIM_TOKEN,
      async fetchFn() { return jsonResponse(badRow); },
    });
    await assert.rejects(store.claimNext(), /시트 동기화 저장소/u);
  }
});

test("canonical projection rejects corrupt per-session sheet ids while the index gid contract remains separate", async () => {
  for (const sheetId of [0, 2_147_483_648]) {
    const responses = [
      jsonResponse([{
        job_id: JOB_ID, session_id: SESSION_ID, session_index_row: 8, sheet_id: 91,
        tab_title: "tab", should_create: false, projection_version: 4,
        previous_participant_count: 0, workbook_ref_version: 1, reason: "participant_changed",
      }]),
      jsonResponse([{
        session_index_row: 8, sheet_id: sheetId, tab_title: "tab", should_create: false,
        projection_version: 4, previous_participant_count: 0, session_id: SESSION_ID,
        session_date: "2026-08-15", session_title: "실적 발표", session_status: "stopped",
        summary_state: "ready", languages: ["ko"], archived_at: null, archive_deleted_at: null,
        participant_count: 0, participants: [],
      }]),
    ];
    const store = new SupabaseLiveSheetSyncStore({
      baseUrl: "https://project-ref.supabase.co", credential: { key: "server-secret", kind: "secret" },
      workbookId: "workbook_ABCDEFGHIJKLMNOPQRSTUVWXYZ", randomUuid: () => CLAIM_TOKEN,
      async fetchFn() { return responses.shift() ?? jsonResponse(null, 500); },
    });
    const claim = await store.claimNext();
    assert.ok(claim);
    await assert.rejects(store.readCanonicalProjection(claim), /시트 동기화 저장소/u);
  }
});

test("owned retry is one atomic RPC and maps conflict, unavailable, and authorization without raw bodies", async () => {
  const scenarios = [
    [409, "LIVE_SHEET_RETRY_CONFLICT", "SHEET_SYNC_RETRY_CONFLICT"],
    [400, "LIVE_SHEET_RETRY_NOT_AVAILABLE", "SHEET_SYNC_RETRY_NOT_AVAILABLE"],
    [403, "HOST_ACCESS_REQUIRED private@example.com", "LIVE_RECORD_NOT_FOUND"],
  ] as const;
  for (const [status, providerMessage, expectedCode] of scenarios) {
    const store = new SupabaseLiveSheetSyncStore({
      baseUrl: "https://project-ref.supabase.co", credential: { key: "server-secret", kind: "secret" },
      workbookId: "workbook_ABCDEFGHIJKLMNOPQRSTUVWXYZ", randomUuid: () => CLAIM_TOKEN,
      async fetchFn(_input, init) {
        assert.deepEqual(JSON.parse(String(init?.body)), { p_session_id: SESSION_ID, p_host_id: "admin@example.com" });
        return jsonResponse({ message: providerMessage }, status);
      },
    });
    await assert.rejects(
      store.retryOwned("admin@example.com", SESSION_ID),
      (error: unknown) => error instanceof Error
        && "code" in error && error.code === expectedCode
        && !error.message.includes("private@example.com"),
    );
  }
});
