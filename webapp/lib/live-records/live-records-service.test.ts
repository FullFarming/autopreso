import assert from "node:assert/strict";
import test from "node:test";

import type { MeetingSummary } from "../live/summary";
import type { HostTranscriptReadRecord } from "../live/transcript-read";
import {
  LiveRecordsError,
  LiveRecordsService,
  type LiveRecordBase,
  type LiveRecordParticipant,
  type LiveRecordsStore,
} from "./service";

const sessionId = "11111111-1111-4111-8111-111111111111";
const hostId = "host-1";
const otherHostId = "host-2";
const participantUserId = "user-1";

test("live records detail authorizes owner before reading transcript topics summary or roster", async () => {
  const calls: string[] = [];
  const store = new FakeLiveRecordsStore({ calls });
  const service = new LiveRecordsService(store, {
    readTranscript: async () => {
      calls.push("read-transcript");
      return transcriptFixture();
    },
    readSummary: async (_sessionId, language) => {
      calls.push(`read-summary:${language}`);
      return language === "ko"
        ? { summary: summaryFixture(), model: "gemini-3.7-flash", createdAt: "2026-08-15T01:00:00.000Z" }
        : null;
    },
    readSummaryStatus: async (_sessionId, language) => {
      calls.push(`read-summary-status:${language}`);
      return { status: language === "en" ? "running" : "missing" };
    },
  });

  await assert.rejects(
    service.getDetail(otherHostId, sessionId, { language: "ko" }),
    (error: unknown) => error instanceof LiveRecordsError && error.code === "LIVE_RECORD_NOT_FOUND",
  );
  assert.deepEqual(calls, [`get-owned:${otherHostId}:${sessionId}`]);

  const detail = await service.getDetail(hostId, sessionId, { language: "ko" });
  assert.deepEqual(calls.slice(1), [
    `get-owned:${hostId}:${sessionId}`,
    "read-transcript",
    `list-participants:${hostId}:${sessionId}`,
    "read-summary:ko",
    "read-summary:en",
    "read-summary-status:en",
  ]);
  assert.equal(detail.record.sessionId, sessionId);
  assert.equal(detail.transcript.language, "ko");
  assert.equal(detail.summaryStates.ko.status, "ready");
  assert.equal(Object.hasOwn(detail.summaryStates.ko, "model"), false);
  assert.equal(detail.summary?.language, "ko");
  assert.equal(detail.summary?.createdAt, "2026-08-15T01:00:00.000Z");
  assert.equal(detail.summary?.summary.title, "Q3 요약");
  assert.equal(detail.summaryStates.en.status, "running");
  assert.equal(detail.participants[0]?.participantId, "participant-1");
  assert.equal(detail.participants[0]?.consents.privacy.accepted, true);
  assert.equal(detail.participants[0]?.consents.marketing.accepted, false);
});

test("authoritative admin transcript verifies ownership before bounded audit reads", async () => {
  const calls: string[] = [];
  const store = new FakeLiveRecordsStore({ calls });
  const service = new LiveRecordsService(store);

  await assert.rejects(
    service.getAuthoritativeTranscript(otherHostId, sessionId, { afterSourceSeq: "0", pageSize: "500" }),
    (error: unknown) => error instanceof LiveRecordsError && error.code === "LIVE_RECORD_NOT_FOUND",
  );
  assert.deepEqual(calls, [`get-owned:${otherHostId}:${sessionId}`]);

  const page = await service.getAuthoritativeTranscript(hostId, sessionId, {
    afterSourceSeq: "7",
    pageSize: "500",
  });
  assert.deepEqual(calls.slice(1), [
    `get-owned:${hostId}:${sessionId}`,
    `read-authoritative:${hostId}:${sessionId}:7:50`,
  ]);
  assert.equal(page.sessionId, sessionId);
  assert.equal(page.pageSize, 50);
  assert.equal(page.afterSourceSeq, 7);
  assert.equal(page.items[0]?.rawText, "  Revenue was $10 million.  ");
  assert.equal(page.items[0]?.normalizedText, "Revenue was USD 10 million.");
  assert.equal(page.items[0]?.effectiveText, "Revenue was USD 10 million.");
  assert.equal(page.items[0]?.translations[0]?.language, "ko");
});

test("authoritative admin transcript stays unavailable until terminal archive evidence exists", async () => {
  for (const status of ["preparing", "live", "paused"] as const) {
    const calls: string[] = [];
    const service = new LiveRecordsService(new FakeLiveRecordsStore({
      calls,
      record: { ...recordFixture(), status, endedAt: null },
    }));
    await assert.rejects(
      service.getAuthoritativeTranscript(hostId, sessionId),
      (error: unknown) => error instanceof LiveRecordsError
        && error.code === "AUTHORITATIVE_TRANSCRIPT_NOT_READY"
        && error.status === 409,
    );
    assert.deepEqual(calls, [`get-owned:${hostId}:${sessionId}`]);
  }

  const noCompletionEvidenceCalls: string[] = [];
  const noCompletionEvidence = new LiveRecordsService(new FakeLiveRecordsStore({
    calls: noCompletionEvidenceCalls,
    record: { ...recordFixture(), status: "failed", startedAt: null, endedAt: null },
  }));
  await assert.rejects(
    noCompletionEvidence.getAuthoritativeTranscript(hostId, sessionId),
    (error: unknown) => error instanceof LiveRecordsError
      && error.code === "AUTHORITATIVE_TRANSCRIPT_NOT_READY",
  );
  assert.deepEqual(noCompletionEvidenceCalls, [`get-owned:${hostId}:${sessionId}`]);

  for (const record of [
    { ...recordFixture(), status: "stopped" as const, endedAt: "2026-08-15T01:00:00.000Z" },
    { ...recordFixture(), status: "failed" as const, endedAt: null },
  ]) {
    const service = new LiveRecordsService(new FakeLiveRecordsStore({ record }));
    assert.equal((await service.getAuthoritativeTranscript(hostId, sessionId)).items.length, 1);
  }
});

test("live records list clamps pagination and returns safe archive projections only", async () => {
  const store = new FakeLiveRecordsStore();
  const service = new LiveRecordsService(store);

  const page = await service.list(hostId, {
    page: "2",
    pageSize: "500",
    search: ` ${"A".repeat(160)} `,
  });

  assert.equal(store.lastListInput?.page, 2);
  assert.equal(store.lastListInput?.pageSize, 50);
  assert.equal(store.lastListInput?.search, "A".repeat(100));
  assert.equal(page.items[0]?.summaryStates.ko.status, "ready");
  assert.equal(page.items[0]?.sheetStatus.state, "not_configured");
  assert.equal(JSON.stringify(page).includes("Transcript body"), false);
});

test("participant consent update and withdraw are scoped by authenticated participant user id", async () => {
  const store = new FakeLiveRecordsStore();
  const service = new LiveRecordsService(store, {}, () => Date.parse("2026-08-15T02:00:00.000Z"));

  const accepted = await service.updateParticipantConsents(sessionId, participantUserId, {
    summaryConsent: true,
    marketingConsent: true,
    consentNoticeVersions: {
      summaryDelivery: "summary-v1",
      marketing: "marketing-v1",
    },
  });

  assert.equal(store.lastConsentInput?.participantUserId, participantUserId);
  assert.deepEqual(store.lastConsentInput?.consents.map((consent) => consent.purpose), ["summary_delivery", "marketing"]);
  assert.equal(accepted.summaryDelivery.accepted, true);
  assert.equal(accepted.marketing.accepted, true);

  const withdrawn = await service.updateParticipantConsents(sessionId, participantUserId, {
    summaryConsent: false,
    marketingConsent: false,
    consentNoticeVersions: {
      summaryDelivery: "summary-v1",
      marketing: "marketing-v1",
    },
  });

  assert.equal(withdrawn.summaryDelivery.accepted, false);
  assert.equal(withdrawn.marketing.accepted, false);
  assert.equal(store.lastConsentInput?.consents[0]?.accepted, false);
});

test("live record archive supports soft delete restore and explicit purge eligibility", async () => {
  const store = new FakeLiveRecordsStore();
  const service = new LiveRecordsService(store, {}, () => Date.parse("2026-08-15T03:00:00.000Z"));

  const deleted = await service.softDelete(hostId, sessionId);
  assert.equal(deleted.deletedAt, "2026-08-15T03:00:00.000Z");
  assert.equal(deleted.purgeEligibleAt, "2026-09-14T03:00:00.000Z");

  const restored = await service.restore(hostId, sessionId);
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.purgeEligibleAt, null);

  const eligibility = await service.getPurgeEligibility(hostId, sessionId);
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, "RETENTION_WINDOW_ACTIVE");
});

function recordFixture(): LiveRecordBase {
  return {
    sessionId,
    title: "Q3 Earnings Live",
    status: "stopped",
    languages: ["ko", "en"],
    scheduledAt: null,
    startedAt: "2026-08-15T00:00:00.000Z",
    endedAt: "2026-08-15T01:00:00.000Z",
    viewerCount: 12,
    participantCount: 3,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T01:00:00.000Z",
    deletedAt: null,
    purgeEligibleAt: null,
    sheetStatus: {
      state: "not_configured",
      attemptCount: 0,
      safeErrorCode: null,
      updatedAt: null,
    },
    summaryStates: {
      ko: { status: "ready", createdAt: "2026-08-15T01:00:00.000Z" },
      en: { status: "missing" },
    },
  };
}

function transcriptFixture(): HostTranscriptReadRecord {
  return {
    language: "ko",
    event: {
      companyName: "Cushman",
      ticker: "CWK",
      fiscalPeriod: "Q3 2026",
      eventType: "earnings_call",
      agenda: [],
      activeSection: "prepared_remarks",
      sectionStartedAt: null,
    },
    topics: [{
      id: "22222222-2222-4222-8222-222222222222",
      sessionId,
      ordinal: 1,
      title: "실적 개요",
      summary: "매출과 점유율 논의",
      status: "completed",
      completionReason: "session_end",
      detectorHealth: "healthy",
      startedAt: "2026-08-15T00:00:00.000Z",
      completedAt: "2026-08-15T00:02:00.000Z",
      version: 1,
    }],
    utterances: [{
      seq: 1,
      speaker: "Host",
      text: "Transcript body",
      emittedAt: "2026-08-15T00:00:01.000Z",
      topicId: "topic-1",
      topicPosition: 1,
    }],
  };
}

function summaryFixture(): MeetingSummary {
  return {
    title: "Q3 요약",
    overview: "핵심 실적 요약",
    chapters: [],
    decisions: [],
    actionItems: [],
    speakerHighlights: [],
    participationStats: [],
  };
}

function participantFixture(): LiveRecordParticipant {
  return {
    participantId: "participant-1",
    displayName: "v***@example.com",
    email: "viewer@example.com",
    company: "CW",
    department: "Strategy",
    jobTitle: "Director",
    summaryConsentAt: "2026-08-15T00:00:00.000Z",
    joinedAt: "2026-08-15T00:00:00.000Z",
    lastSeenAt: "2026-08-15T00:10:00.000Z",
    isPresent: true,
    lastSpokeAt: null,
    utteranceCount: 0,
    speakingSeconds: 0,
    consents: {
      privacy: {
        accepted: true,
        decidedAt: "2026-08-15T00:00:00.000Z",
        noticeVersion: "privacy-v1",
      },
      summaryDelivery: {
        accepted: true,
        decidedAt: "2026-08-15T00:00:00.000Z",
        noticeVersion: "summary-v1",
      },
      marketing: {
        accepted: false,
        decidedAt: "2026-08-15T00:00:00.000Z",
        noticeVersion: "marketing-v1",
      },
    },
  };
}

class FakeLiveRecordsStore implements LiveRecordsStore {
  readonly calls: string[];
  private readonly recordOverride: LiveRecordBase | null | undefined;
  lastListInput: { page: number; pageSize: number; search: string | null } | null = null;
  lastConsentInput: Parameters<LiveRecordsStore["updateParticipantConsents"]>[0] | null = null;

  constructor(input: { calls?: string[]; record?: LiveRecordBase | null } = {}) {
    this.calls = input.calls ?? [];
    this.recordOverride = input.record;
  }

  async listOwnedLiveRecords(_hostIdValue: string, input: { page: number; pageSize: number; search: string | null }) {
    this.lastListInput = input;
    return {
      items: [recordFixture()],
      page: input.page,
      pageSize: input.pageSize,
      total: 1,
      hasNextPage: false,
    };
  }

  async getOwnedLiveRecordBase(hostIdValue: string, sessionIdValue: string) {
    this.calls.push(`get-owned:${hostIdValue}:${sessionIdValue}`);
    if (hostIdValue !== hostId || sessionIdValue !== sessionId) return null;
    return this.recordOverride === undefined ? recordFixture() : this.recordOverride;
  }

  async softDeleteOwnedLiveRecord(hostIdValue: string, sessionIdValue: string, nowIso: string) {
    if (hostIdValue !== hostId || sessionIdValue !== sessionId) return null;
    return {
      sessionId,
      deletedAt: nowIso,
      purgeEligibleAt: new Date(Date.parse(nowIso) + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    };
  }

  async restoreOwnedLiveRecord(hostIdValue: string, sessionIdValue: string) {
    if (hostIdValue !== hostId || sessionIdValue !== sessionId) return null;
    return { sessionId, deletedAt: null, purgeEligibleAt: null };
  }

  async getOwnedPurgeEligibility(hostIdValue: string, sessionIdValue: string) {
    if (hostIdValue !== hostId || sessionIdValue !== sessionId) return null;
    return {
      sessionId,
      eligible: false,
      reason: "RETENTION_WINDOW_ACTIVE" as const,
      purgeEligibleAt: "2026-09-14T03:00:00.000Z",
    };
  }

  async listOwnedLiveRecordParticipants(hostIdValue: string, sessionIdValue: string) {
    this.calls.push(`list-participants:${hostIdValue}:${sessionIdValue}`);
    if (hostIdValue !== hostId || sessionIdValue !== sessionId) return [];
    return [participantFixture()];
  }

  async listOwnedAuthoritativeTranscript(
    hostIdValue: string,
    sessionIdValue: string,
    input: { afterSourceSeq: number; limit: number },
  ) {
    this.calls.push(`read-authoritative:${hostIdValue}:${sessionIdValue}:${input.afterSourceSeq}:${input.limit}`);
    return [{
      sourceUtteranceId: "33333333-3333-4333-8333-333333333333",
      sourceSeq: 8,
      utteranceKey: "gateway:source:8",
      rawText: "  Revenue was $10 million.  ",
      normalizedText: "Revenue was USD 10 million.",
      effectiveText: "Revenue was USD 10 million.",
      sourceLanguage: "en",
      speakerRole: "host" as const,
      speakerLabel: "Host",
      speakerName: "Noel Kim",
      speakerDepartment: "IR",
      speakerJobTitle: "Director",
      participantId: null,
      sourceStartedAt: "2026-08-15T00:00:01.000Z",
      sourceEndedAt: "2026-08-15T00:00:02.000Z",
      providerCommittedAt: "2026-08-15T00:00:02.100Z",
      sttProvider: "google-cloud-stt-v2",
      sttModel: "chirp_3",
      translationModel: "gemini-3.7-flash",
      pipelineConfigFingerprint: "pipeline-sha256",
      glossaryFingerprint: "glossary-sha256",
      correctionRevision: 0,
      correctedAt: null,
      translations: [{
        language: "ko",
        seq: 8,
        text: "매출은 1천만 달러였습니다.",
        translationStatus: "translated" as const,
        emittedAt: "2026-08-15T00:00:02.500Z",
      }],
    }];
  }

  async updateParticipantConsents(input: Parameters<LiveRecordsStore["updateParticipantConsents"]>[0]) {
    this.lastConsentInput = input;
    const summary = input.consents.find((consent) => consent.purpose === "summary_delivery");
    const marketing = input.consents.find((consent) => consent.purpose === "marketing");
    return {
      sessionId: input.sessionId,
      summaryDelivery: {
        accepted: summary?.accepted ?? false,
        noticeVersion: summary?.noticeVersion ?? "",
        decidedAt: input.decidedAt,
      },
      marketing: {
        accepted: marketing?.accepted ?? false,
        noticeVersion: marketing?.noticeVersion ?? "",
        decidedAt: input.decidedAt,
      },
    };
  }
}
