import assert from "node:assert/strict";
import test from "node:test";

import { LiveRecordsError } from "./errors";
import { SupabaseLiveRecordsStore } from "./supabase-store";

const sessionId = "11111111-1111-4111-8111-111111111111";
const participantId = "22222222-2222-4222-8222-222222222222";
const hostId = "host-1";
const participantUserId = "viewer-1";
const baseUrl = "https://dev-ref.supabase.co";

test("SupabaseLiveRecordsStore lists owner-scoped records through exact admin RPC body", async () => {
  const calls: CapturedRequest[] = [];
  const store = createStore(calls, async (path) => {
    assert.equal(path, "/rest/v1/rpc/list_owned_live_records_v1");
    return Response.json([{
      session_id: sessionId,
      title: "Q3 Earnings",
      status: "stopped",
      languages: ["ko", "en"],
      created_at: "2026-08-15T00:00:00.000Z",
      scheduled_at: null,
      ended_at: "2026-08-15T01:00:00.000Z",
      archived_at: "2026-08-15T01:00:00.000Z",
      participant_count: 7,
      summary_state: "ready",
      sheet_sync_state: "succeeded",
      sheet_error_code: null,
      total_count: 11,
    }]);
  });

  const page = await store.listOwnedLiveRecords(hostId, {
    page: 1,
    pageSize: 10,
    search: "Q3",
  });

  assert.deepEqual(calls[0]?.json, {
    p_host_id: hostId,
    p_page: 1,
    p_page_size: 10,
    p_search: "Q3",
  });
  assert.equal(page.total, 11);
  assert.equal(page.hasNextPage, true);
  assert.equal(page.items[0]?.sessionId, sessionId);
  assert.equal(page.items[0]?.summaryStates.ko.status, "ready");
  assert.equal(page.items[0]?.summaryStates.en.status, "ready");
  assert.equal(page.items[0]?.sheetStatus.state, "succeeded");
  assert.equal(JSON.stringify(page).includes("host_id"), false);
});

test("SupabaseLiveRecordsStore reads detail base projection and safe sheet coordinates", async () => {
  const calls: CapturedRequest[] = [];
  const store = createStore(calls, async (path) => {
    assert.equal(path, "/rest/v1/rpc/read_owned_live_record_v1");
    return Response.json([{
      session_id: sessionId,
      title: "Q3 Earnings",
      status: "stopped",
      session_type: "presentation",
      output_mode: "captions",
      languages: ["ko", "en"],
      created_at: "2026-08-15T00:00:00.000Z",
      scheduled_at: null,
      ended_at: "2026-08-15T01:00:00.000Z",
      archived_at: "2026-08-15T01:00:00.000Z",
      participant_count: 7,
      utterance_count: 31,
      topic_count: 4,
      summary_state: "pending",
      sheet_sync_state: "syncing",
      sheet_error_code: "RATE_LIMITED",
      sheet_id: 123,
      session_index_row: 8,
      tab_title: "2026-08-15 Q3 Earnings #123",
      projection_version: 9,
      last_exported_projection_version: 7,
      last_exported_participant_count: 6,
    }]);
  });

  const record = await store.getOwnedLiveRecordBase(hostId, sessionId);

  assert.deepEqual(calls[0]?.json, { p_host_id: hostId, p_session_id: sessionId });
  assert.equal(record?.sheetStatus.state, "running");
  assert.equal(record?.sheetStatus.safeErrorCode, "RATE_LIMITED");
  assert.equal(record?.summaryStates.ko.status, "running");
  assert.equal(record?.summaryStates.en.status, "running");
  assert.equal(JSON.stringify(record).includes("model"), false);
});

test("SupabaseLiveRecordsStore reads the owner-scoped authoritative audit projection with an exact cursor contract", async () => {
  const calls: CapturedRequest[] = [];
  const store = createStore(calls, async (path) => {
    assert.equal(path, "/rest/v1/rpc/read_owned_authoritative_live_transcript_v1");
    return Response.json([{
      source_utterance_id: "33333333-3333-4333-8333-333333333333",
      source_seq: 8,
      utterance_key: "gateway:source:8",
      raw_text: "  Revenue was $10 million.  ",
      normalized_text: "Revenue was USD 10 million.",
      effective_text: "Revenue was USD 10 million.",
      source_language: "en",
      speaker_role: "host",
      speaker_label: "Host",
      speaker_name: "Noel Kim",
      speaker_department: "IR",
      speaker_job_title: "Director",
      participant_id: null,
      source_started_at: "2026-08-15T00:00:01.000Z",
      source_ended_at: "2026-08-15T00:00:02.000Z",
      provider_committed_at: "2026-08-15T00:00:02.100Z",
      stt_provider: "google-cloud-stt-v2",
      stt_model: "chirp_3",
      translation_model: "gemini-3.7-flash",
      pipeline_config_fingerprint: `sha256:${"a".repeat(64)}`,
      glossary_fingerprint: `sha256:${"b".repeat(64)}`,
      correction_revision: 0,
      corrected_at: null,
      translations: [{
        language: "ko",
        seq: 8,
        text: "매출은 1천만 달러였습니다.",
        translationStatus: "translated",
        emittedAt: "2026-08-15T00:00:02.500Z",
      }],
    }]);
  });

  const rows = await store.listOwnedAuthoritativeTranscript(hostId, sessionId, {
    afterSourceSeq: 7,
    limit: 200,
  });

  assert.deepEqual(calls[0]?.json, {
    p_host_id: hostId,
    p_session_id: sessionId,
    p_after_source_seq: 7,
    p_limit: 200,
  });
  assert.equal(rows[0]?.rawText, "  Revenue was $10 million.  ");
  assert.equal(rows[0]?.normalizedText, "Revenue was USD 10 million.");
  assert.equal(rows[0]?.translations[0]?.translationStatus, "translated");
});

test("SupabaseLiveRecordsStore rejects oversized authoritative fields and aggregate pages", async () => {
  const oversizedFieldStore = createStore([], async () => Response.json([{
    ...authoritativeTranscriptRow(1),
    raw_text: "x".repeat(8_001),
  }]));
  await assert.rejects(
    oversizedFieldStore.listOwnedAuthoritativeTranscript(hostId, sessionId, { afterSourceSeq: 0, limit: 50 }),
    (error: unknown) => error instanceof LiveRecordsError
      && error.code === "LIVE_RECORDS_STORE_UNAVAILABLE",
  );

  const aggregateStore = createStore([], async () => Response.json(
    Array.from({ length: 50 }, (_value, index) => authoritativeTranscriptRow(index + 1, 2_000)),
  ));
  await assert.rejects(
    aggregateStore.listOwnedAuthoritativeTranscript(hostId, sessionId, { afterSourceSeq: 0, limit: 50 }),
    (error: unknown) => error instanceof LiveRecordsError
      && error.code === "LIVE_RECORDS_STORE_UNAVAILABLE",
  );
});

test("SupabaseLiveRecordsStore projects participant purpose consent states without internal user ids", async () => {
  const calls: CapturedRequest[] = [];
  const store = createStore(calls, async (path) => {
    assert.equal(path, "/rest/v1/rpc/read_owned_live_record_participants_v1");
    return Response.json([{
      participant_id: participantId,
      display_name: "v***@example.com",
      email: "viewer@example.com",
      company: "CW",
      department: "Strategy",
      job_title: "Director",
      joined_at: "2026-08-15T00:05:00.000Z",
      left_at: null,
      privacy_is_accepted: true,
      privacy_notice_version: "privacy-v1",
      privacy_accepted_at: "2026-08-15T00:04:00.000Z",
      privacy_withdrawn_at: null,
      summary_delivery_is_accepted: false,
      summary_delivery_notice_version: "summary-v1",
      summary_delivery_accepted_at: "2026-08-15T00:04:00.000Z",
      summary_delivery_withdrawn_at: "2026-08-15T00:30:00.000Z",
      marketing_is_accepted: false,
      marketing_notice_version: "marketing-v1",
      marketing_accepted_at: null,
      marketing_withdrawn_at: null,
      delivery_status: "not_requested",
    }]);
  });

  const participants = await store.listOwnedLiveRecordParticipants(hostId, sessionId);

  assert.deepEqual(calls[0]?.json, { p_host_id: hostId, p_session_id: sessionId });
  assert.equal(participants[0]?.email, "viewer@example.com");
  assert.equal(participants[0]?.summaryConsentAt, null);
  assert.equal(participants[0]?.consents.privacy.accepted, true);
  assert.equal(participants[0]?.consents.summaryDelivery.accepted, false);
  assert.equal(participants[0]?.consents.summaryDelivery.decidedAt, "2026-08-15T00:30:00.000Z");
  assert.equal(participants[0]?.consents.marketing.noticeVersion, "marketing-v1");
  assert.equal(JSON.stringify(participants).includes("participantUserId"), false);
});

test("SupabaseLiveRecordsStore mutates archives and parses purge eligibility through exact RPCs", async () => {
  const calls: CapturedRequest[] = [];
  const store = createStore(calls, async (path) => {
    if (path.endsWith("/soft_delete_owned_live_record_v1")) {
      return Response.json([archiveRow("2026-08-15T02:00:00.000Z", "2026-09-14T02:00:00.000Z")]);
    }
    if (path.endsWith("/restore_owned_live_record_v1")) {
      return Response.json([archiveRow(null, null)]);
    }
    if (path.endsWith("/read_owned_live_record_purge_eligibility_v1")) {
      return Response.json([{
        session_id: sessionId,
        is_deleted: true,
        is_purge_eligible: false,
        archive_deleted_at: "2026-08-15T02:00:00.000Z",
        archive_purge_after: "2026-09-14T02:00:00.000Z",
        recovery_seconds_remaining: 123,
      }]);
    }
    throw new Error(`unexpected path ${path}`);
  });

  const deleted = await store.softDeleteOwnedLiveRecord(hostId, sessionId, "ignored");
  const restored = await store.restoreOwnedLiveRecord(hostId, sessionId);
  const eligibility = await store.getOwnedPurgeEligibility(hostId, sessionId, "ignored");

  assert.equal(deleted?.deletedAt, "2026-08-15T02:00:00.000Z");
  assert.equal(restored?.deletedAt, null);
  assert.equal(eligibility?.reason, "RETENTION_WINDOW_ACTIVE");
  assert.deepEqual(calls.map((call) => call.json), [
    { p_host_id: hostId, p_session_id: sessionId },
    { p_host_id: hostId, p_session_id: sessionId },
    { p_host_id: hostId, p_session_id: sessionId },
  ]);
});

test("SupabaseLiveRecordsStore updates participant consents with one atomic choices RPC after server-side participant id resolution", async () => {
  const calls: CapturedRequest[] = [];
  const store = createStore(calls, async (path) => {
    if (path.startsWith("/rest/v1/live_participants?")) {
      return Response.json([{ id: participantId }]);
    }
    if (path === "/rest/v1/rpc/record_live_participant_consent_choices_v1") {
      const body = calls.at(-1)?.json as Record<string, unknown>;
      return Response.json([
        consentChoiceRow({
          sessionId: body.p_session_id,
          participantId: body.p_participant_id,
          purpose: "summary_delivery",
          noticeVersion: body.p_summary_notice_version,
          accepted: body.p_summary_is_accepted,
        }),
        consentChoiceRow({
          sessionId: body.p_session_id,
          participantId: body.p_participant_id,
          purpose: "marketing",
          noticeVersion: body.p_marketing_notice_version,
          accepted: body.p_marketing_is_accepted,
        }),
      ]);
    }
    throw new Error(`unexpected path ${path}`);
  });

  const projection = await store.updateParticipantConsents({
    sessionId,
    participantUserId,
    decidedAt: "2026-08-15T02:00:00.000Z",
    consents: [
      { purpose: "summary_delivery", accepted: true, noticeVersion: "summary-v1" },
      { purpose: "marketing", accepted: false, noticeVersion: "marketing-v1" },
    ],
  });

  assert.equal(new URL(`${baseUrl}${calls[0]?.path}`).searchParams.get("user_id"), `eq.${participantUserId}`);
  assert.deepEqual(calls.slice(1).map((call) => call.json), [
    {
      p_session_id: sessionId,
      p_participant_id: participantId,
      p_user_id: participantUserId,
      p_summary_is_accepted: true,
      p_summary_notice_version: "summary-v1",
      p_marketing_is_accepted: false,
      p_marketing_notice_version: "marketing-v1",
    },
  ]);
  assert.equal(projection.summaryDelivery.accepted, true);
  assert.equal(projection.summaryDelivery.decidedAt, "2026-08-15T02:00:00.000Z");
  assert.equal(projection.marketing.accepted, false);
});

test("SupabaseLiveRecordsStore cannot partially commit one consent purpose through legacy per-purpose RPCs", async () => {
  const calls: CapturedRequest[] = [];
  const store = createStore(calls, async (path) => {
    if (path.startsWith("/rest/v1/live_participants?")) {
      return Response.json([{ id: participantId }]);
    }
    if (path === "/rest/v1/rpc/record_live_participant_consent_v1") {
      throw new Error("legacy per-purpose RPC must not be called");
    }
    if (path === "/rest/v1/rpc/record_live_participant_consent_choices_v1") {
      const body = calls.at(-1)?.json as Record<string, unknown>;
      return Response.json([
        consentChoiceRow({
          sessionId: body.p_session_id,
          participantId: body.p_participant_id,
          purpose: "summary_delivery",
          noticeVersion: body.p_summary_notice_version,
          accepted: body.p_summary_is_accepted,
        }),
        consentChoiceRow({
          sessionId: body.p_session_id,
          participantId: body.p_participant_id,
          purpose: "marketing",
          noticeVersion: body.p_marketing_notice_version,
          accepted: body.p_marketing_is_accepted,
        }),
      ]);
    }
    throw new Error(`unexpected path ${path}`);
  });

  await store.updateParticipantConsents({
    sessionId,
    participantUserId,
    decidedAt: "2026-08-15T02:00:00.000Z",
    consents: [
      { purpose: "summary_delivery", accepted: true, noticeVersion: "summary-v1" },
      { purpose: "marketing", accepted: true, noticeVersion: "marketing-v1" },
    ],
  });

  assert.deepEqual(calls.map((call) => call.path), [
    "/rest/v1/live_participants?select=id&session_id=eq.11111111-1111-4111-8111-111111111111&user_id=eq.viewer-1&order=joined_at.desc%2Cid.desc&limit=1",
    "/rest/v1/rpc/record_live_participant_consent_choices_v1",
  ]);
});

test("SupabaseLiveRecordsStore maps owner miss and invalid stored shapes to stable Korean errors", async () => {
  const ownerMissStore = createStore([], async () => Response.json(
    { code: "42501", message: "HOST_ACCESS_REQUIRED" },
    { status: 403 },
  ));
  await assert.rejects(
    ownerMissStore.getOwnedLiveRecordBase(hostId, sessionId),
    (error: unknown) => error instanceof LiveRecordsError
      && error.status === 404
      && error.code === "LIVE_RECORD_NOT_FOUND",
  );

  const notReadyStore = createStore([], async () => Response.json(
    { code: "P0001", message: "LIVE_TRANSCRIPT_NOT_READY" },
    { status: 400 },
  ));
  await assert.rejects(
    notReadyStore.listOwnedAuthoritativeTranscript(hostId, sessionId, { afterSourceSeq: 0, limit: 50 }),
    (error: unknown) => error instanceof LiveRecordsError
      && error.status === 409
      && error.code === "AUTHORITATIVE_TRANSCRIPT_NOT_READY",
  );

  const invalidStore = createStore([], async () => Response.json([{ session_id: sessionId }]));
  await assert.rejects(
    invalidStore.listOwnedLiveRecords(hostId, { page: 1, pageSize: 20, search: null }),
    (error: unknown) => error instanceof LiveRecordsError
      && error.status === 503
      && error.code === "LIVE_RECORDS_STORE_UNAVAILABLE",
  );
});

test("SupabaseLiveRecordsStore rejects internal projection leaks from admin RPC rows", async () => {
  const store = createStore([], async () => Response.json([{
    session_id: sessionId,
    title: "Q3 Earnings",
    status: "stopped",
    languages: ["ko"],
    created_at: "2026-08-15T00:00:00.000Z",
    scheduled_at: null,
    ended_at: "2026-08-15T01:00:00.000Z",
    archived_at: "2026-08-15T01:00:00.000Z",
    participant_count: 7,
    summary_state: "ready",
    sheet_sync_state: "succeeded",
    sheet_error_code: null,
    total_count: 1,
    host_id: "leaked-host",
    model: "gemini-3.7-flash",
  }]));

  await assert.rejects(
    store.listOwnedLiveRecords(hostId, { page: 1, pageSize: 20, search: null }),
    (error: unknown) => error instanceof LiveRecordsError
      && error.status === 503
      && error.code === "LIVE_RECORDS_STORE_UNAVAILABLE",
  );
});

interface CapturedRequest {
  path: string;
  json: unknown;
}

function createStore(
  calls: CapturedRequest[],
  handler: (path: string) => Promise<Response>,
): SupabaseLiveRecordsStore {
  return new SupabaseLiveRecordsStore({
    getServerAccess: () => ({
      url: baseUrl,
      credential: { key: "sb_secret_1234567890abcdef", kind: "secret" },
    }),
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
      calls.push({ path: `${url.pathname}${url.search}`, json: body });
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as Record<string, string> | undefined)?.apikey, "sb_secret_1234567890abcdef");
      return handler(`${url.pathname}${url.search}`);
    },
  });
}

function archiveRow(deletedAt: string | null, purgeAfter: string | null) {
  return {
    session_id: sessionId,
    archived_at: "2026-08-15T01:00:00.000Z",
    archive_deleted_at: deletedAt,
    archive_purge_after: purgeAfter,
  };
}

function authoritativeTranscriptRow(sourceSeq: number, textLength = 10) {
  const text = "x".repeat(textLength);
  return {
    source_utterance_id: `33333333-3333-4333-8333-${String(sourceSeq).padStart(12, "0")}`,
    source_seq: sourceSeq,
    utterance_key: `gateway:source:${sourceSeq}`,
    raw_text: text,
    normalized_text: text,
    effective_text: text,
    source_language: "en",
    speaker_role: "host",
    speaker_label: "Host",
    speaker_name: "Noel Kim",
    speaker_department: "IR",
    speaker_job_title: "Director",
    participant_id: null,
    source_started_at: "2026-08-15T00:00:01.000Z",
    source_ended_at: "2026-08-15T00:00:02.000Z",
    provider_committed_at: "2026-08-15T00:00:02.100Z",
    stt_provider: "google-cloud-stt-v2",
    stt_model: "chirp_3",
    translation_model: "gemini-3.7-flash",
    pipeline_config_fingerprint: `sha256:${"a".repeat(64)}`,
    glossary_fingerprint: `sha256:${"b".repeat(64)}`,
    correction_revision: 0,
    corrected_at: null,
    translations: ["ko", "ja", "zh"].map((language) => ({
      language,
      seq: sourceSeq,
      text,
      translationStatus: "translated",
      emittedAt: "2026-08-15T00:00:02.500Z",
    })),
  };
}

function consentChoiceRow(input: {
  sessionId: unknown;
  participantId: unknown;
  purpose: "summary_delivery" | "marketing";
  noticeVersion: unknown;
  accepted: unknown;
}) {
  return {
    consent_id: input.purpose === "summary_delivery"
      ? "33333333-3333-4333-8333-333333333333"
      : "44444444-4444-4444-8444-444444444444",
    session_id: input.sessionId,
    participant_id: input.participantId,
    purpose: input.purpose,
    notice_version: input.noticeVersion,
    revision: 2,
    is_accepted: input.accepted,
    accepted_at: input.accepted === true ? "2026-08-15T02:00:00.000Z" : null,
    withdrawn_at: input.accepted === false ? "2026-08-15T02:00:00.000Z" : null,
    recorded_at: "2026-08-15T02:00:00.000Z",
    projection_version: 12,
  };
}
