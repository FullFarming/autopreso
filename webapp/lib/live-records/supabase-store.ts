import {
  getSupabaseServerAccess,
  supabaseAdminHeaders,
} from "../security/supabase-server-access";
import { LiveRecordsError } from "./errors";
import type {
  ConsentPurpose,
  AuthoritativeTranscriptItem,
  AuthoritativeTranscriptTranslation,
  LiveRecordArchiveMutation,
  LiveRecordBase,
  LiveRecordListPage,
  LiveRecordParticipant,
  LiveRecordParticipantConsentState,
  LiveRecordPurgeEligibility,
  LiveRecordsStore,
  ParticipantConsentDecision,
  ParticipantConsentProjection,
  SafeSheetStatus,
  SafeSheetStatusState,
  SafeSummaryStatus,
} from "./service";

type FetchLike = typeof fetch;

interface SupabaseLiveRecordsStoreDependencies {
  fetchFn?: FetchLike;
  getServerAccess?: typeof getSupabaseServerAccess;
}

type RpcErrorBody = {
  code?: string;
  message?: string;
};

const MAX_AUTHORITATIVE_PAGE_TEXT_CODEPOINTS = 400_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const LIST_RECORD_KEYS = new Set([
  "session_id", "title", "status", "languages", "created_at", "scheduled_at",
  "ended_at", "archived_at", "participant_count", "summary_state",
  "sheet_sync_state", "sheet_error_code", "total_count",
]);
const DETAIL_RECORD_KEYS = new Set([
  "session_id", "title", "status", "session_type", "output_mode", "languages",
  "created_at", "scheduled_at", "ended_at", "archived_at", "participant_count",
  "utterance_count", "topic_count", "summary_state", "sheet_sync_state",
  "sheet_error_code", "sheet_id", "session_index_row", "tab_title",
  "projection_version", "last_exported_projection_version",
  "last_exported_participant_count",
]);
const PARTICIPANT_KEYS = new Set([
  "participant_id", "display_name", "email", "company", "department",
  "job_title", "joined_at", "left_at", "privacy_is_accepted",
  "privacy_notice_version", "privacy_accepted_at", "privacy_withdrawn_at",
  "summary_delivery_is_accepted", "summary_delivery_notice_version",
  "summary_delivery_accepted_at", "summary_delivery_withdrawn_at",
  "marketing_is_accepted", "marketing_notice_version", "marketing_accepted_at",
  "marketing_withdrawn_at", "delivery_status",
]);
const ARCHIVE_KEYS = new Set(["session_id", "archived_at", "archive_deleted_at", "archive_purge_after"]);
const PURGE_KEYS = new Set([
  "session_id", "is_deleted", "is_purge_eligible", "archive_deleted_at",
  "archive_purge_after", "recovery_seconds_remaining",
]);
const PARTICIPANT_ID_KEYS = new Set(["id"]);
const CONSENT_KEYS = new Set([
  "consent_id", "session_id", "participant_id", "purpose", "notice_version",
  "revision", "is_accepted", "accepted_at", "withdrawn_at", "recorded_at",
  "projection_version",
]);
const AUTHORITATIVE_TRANSCRIPT_KEYS = new Set([
  "source_utterance_id", "source_seq", "utterance_key", "raw_text",
  "normalized_text", "effective_text", "source_language", "speaker_role",
  "speaker_label", "speaker_name", "speaker_department", "speaker_job_title",
  "participant_id", "source_started_at", "source_ended_at",
  "provider_committed_at", "stt_provider", "stt_model", "translation_model",
  "pipeline_config_fingerprint", "glossary_fingerprint", "correction_revision",
  "corrected_at", "translations",
]);
const AUTHORITATIVE_TRANSLATION_KEYS = new Set([
  "language", "seq", "text", "translationStatus", "emittedAt",
]);

export class SupabaseLiveRecordsStore implements LiveRecordsStore {
  private readonly fetchFn: FetchLike;
  private readonly getServerAccess: typeof getSupabaseServerAccess;

  constructor(dependencies: SupabaseLiveRecordsStoreDependencies = {}) {
    this.fetchFn = dependencies.fetchFn ?? fetch;
    this.getServerAccess = dependencies.getServerAccess ?? getSupabaseServerAccess;
  }

  async listOwnedLiveRecords(
    hostId: string,
    input: { page: number; pageSize: number; search: string | null },
  ): Promise<LiveRecordListPage> {
    const rows = parseRows(await this.rpc("list_owned_live_records_v1", {
      p_host_id: hostId,
      p_page: input.page,
      p_page_size: input.pageSize,
      p_search: input.search ?? "",
    }));
    const items = rows.map(parseListRecordRow);
    const total = rows.length === 0 ? 0 : requiredSafeInteger(rows[0] ?? {}, "total_count", 0);
    return {
      items,
      page: input.page,
      pageSize: input.pageSize,
      total,
      hasNextPage: input.page * input.pageSize < total,
    };
  }

  async getOwnedLiveRecordBase(hostId: string, sessionId: string): Promise<LiveRecordBase | null> {
    const rows = parseRows(await this.rpc("read_owned_live_record_v1", {
      p_host_id: hostId,
      p_session_id: sessionId,
    }));
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw unavailable();
    return parseDetailRecordRow(rows[0] ?? {});
  }

  async softDeleteOwnedLiveRecord(hostId: string, sessionId: string, _nowIso?: string): Promise<LiveRecordArchiveMutation | null> {
    const rows = parseRows(await this.rpc("soft_delete_owned_live_record_v1", {
      p_host_id: hostId,
      p_session_id: sessionId,
    }));
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw unavailable();
    return parseArchiveMutationRow(rows[0] ?? {});
  }

  async restoreOwnedLiveRecord(hostId: string, sessionId: string): Promise<LiveRecordArchiveMutation | null> {
    const rows = parseRows(await this.rpc("restore_owned_live_record_v1", {
      p_host_id: hostId,
      p_session_id: sessionId,
    }));
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw unavailable();
    return parseArchiveMutationRow(rows[0] ?? {});
  }

  async getOwnedPurgeEligibility(hostId: string, sessionId: string, _nowIso?: string): Promise<LiveRecordPurgeEligibility | null> {
    const rows = parseRows(await this.rpc("read_owned_live_record_purge_eligibility_v1", {
      p_host_id: hostId,
      p_session_id: sessionId,
    }));
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw unavailable();
    return parsePurgeEligibilityRow(rows[0] ?? {});
  }

  async listOwnedLiveRecordParticipants(hostId: string, sessionId: string): Promise<LiveRecordParticipant[]> {
    const rows = parseRows(await this.rpc("read_owned_live_record_participants_v1", {
      p_host_id: hostId,
      p_session_id: sessionId,
    }));
    return rows.map(parseParticipantRow);
  }

  async listOwnedAuthoritativeTranscript(
    hostId: string,
    sessionId: string,
    input: { afterSourceSeq: number; limit: number },
  ): Promise<AuthoritativeTranscriptItem[]> {
    const rows = parseRows(await this.rpc("read_owned_authoritative_live_transcript_v1", {
      p_host_id: hostId,
      p_session_id: sessionId,
      p_after_source_seq: input.afterSourceSeq,
      p_limit: input.limit,
    }));
    if (rows.length > input.limit) throw unavailable();
    const items = rows.map(parseAuthoritativeTranscriptRow);
    let previousSourceSeq = input.afterSourceSeq;
    let textCodepoints = 0;
    for (const item of items) {
      if (item.sourceSeq <= previousSourceSeq) throw unavailable();
      previousSourceSeq = item.sourceSeq;
      textCodepoints += Array.from(item.rawText).length
        + Array.from(item.normalizedText).length
        + Array.from(item.effectiveText).length
        + item.translations.reduce((total, translation) => total + Array.from(translation.text).length, 0);
      if (textCodepoints > MAX_AUTHORITATIVE_PAGE_TEXT_CODEPOINTS) throw unavailable();
    }
    return items;
  }

  async updateParticipantConsents(input: {
    sessionId: string;
    participantUserId: string;
    decidedAt: string;
    consents: ParticipantConsentDecision[];
  }): Promise<ParticipantConsentProjection> {
    const participantId = await this.readParticipantId(input.sessionId, input.participantUserId);
    const summaryConsent = findConsentDecision(input.consents, "summary_delivery");
    const marketingConsent = findConsentDecision(input.consents, "marketing");
    const [summaryDelivery, marketing] = await this.recordParticipantConsentChoices({
      sessionId: input.sessionId,
      participantId,
      participantUserId: input.participantUserId,
      summaryConsent,
      marketingConsent,
    });
    return {
      sessionId: input.sessionId,
      summaryDelivery: {
        accepted: summaryDelivery.accepted,
        noticeVersion: summaryDelivery.noticeVersion,
        decidedAt: summaryDelivery.decidedAt ?? input.decidedAt,
      },
      marketing: {
        accepted: marketing.accepted,
        noticeVersion: marketing.noticeVersion,
        decidedAt: marketing.decidedAt ?? input.decidedAt,
      },
    };
  }

  private async readParticipantId(sessionId: string, participantUserId: string): Promise<string> {
    const query = new URLSearchParams({
      select: "id",
      session_id: `eq.${sessionId}`,
      user_id: `eq.${participantUserId}`,
      order: "joined_at.desc,id.desc",
      limit: "1",
    });
    const rows = parseRows(await this.request(`live_participants?${query}`, { method: "GET" }));
    if (rows.length !== 1) {
      throw new LiveRecordsError("이 세션의 동의를 변경할 권한이 없습니다.", "CONSENT_FORBIDDEN", 403);
    }
    assertExactKeys(rows[0] ?? {}, PARTICIPANT_ID_KEYS);
    return requiredString(rows[0] ?? {}, "id");
  }

  private async recordParticipantConsentChoices(input: {
    sessionId: string;
    participantId: string;
    participantUserId: string;
    summaryConsent: ParticipantConsentDecision;
    marketingConsent: ParticipantConsentDecision;
  }): Promise<[{
    purpose: ConsentPurpose;
    accepted: boolean;
    noticeVersion: string;
    decidedAt: string | null;
  }, {
    purpose: ConsentPurpose;
    accepted: boolean;
    noticeVersion: string;
    decidedAt: string | null;
  }]> {
    const rows = parseRows(await this.rpc("record_live_participant_consent_choices_v1", {
      p_session_id: input.sessionId,
      p_participant_id: input.participantId,
      p_user_id: input.participantUserId,
      p_summary_is_accepted: input.summaryConsent.accepted,
      p_summary_notice_version: input.summaryConsent.noticeVersion,
      p_marketing_is_accepted: input.marketingConsent.accepted,
      p_marketing_notice_version: input.marketingConsent.noticeVersion,
    }));
    if (rows.length !== 2) throw unavailable();
    return [
      parseConsentChoiceRow(rows[0] ?? {}, "summary_delivery", input.sessionId, input.participantId),
      parseConsentChoiceRow(rows[1] ?? {}, "marketing", input.sessionId, input.participantId),
    ];
  }

  private async rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`rpc/${name}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const access = this.getServerAccess();
    let response: Response;
    try {
      response = await this.fetchFn(`${access.url}/rest/v1/${path}`, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        headers: {
          ...supabaseAdminHeaders(access.credential),
          "content-type": "application/json",
          ...init.headers,
        },
      });
    } catch {
      throw unavailable();
    }
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) throw mapRpcFailure(response.status, body);
    return body;
  }
}

function parseListRecordRow(row: Record<string, unknown>): LiveRecordBase {
  assertExactKeys(row, LIST_RECORD_KEYS);
  const languages = requiredLanguages(row, "languages");
  const createdAt = requiredTimestamp(row, "created_at");
  const archivedAt = requiredTimestamp(row, "archived_at");
  const summaryStatus = mapSummaryStatus(requiredString(row, "summary_state"));
  return {
    sessionId: requiredString(row, "session_id"),
    title: requiredString(row, "title"),
    status: requiredLiveRecordStatus(row, "status"),
    languages,
    scheduledAt: optionalTimestamp(row, "scheduled_at"),
    startedAt: archivedAt,
    endedAt: optionalTimestamp(row, "ended_at"),
    viewerCount: 0,
    participantCount: requiredSafeInteger(row, "participant_count", 0),
    createdAt,
    updatedAt: archivedAt,
    deletedAt: null,
    purgeEligibleAt: null,
    summaryStates: summaryStatesForLanguages(languages, summaryStatus),
    sheetStatus: parseSheetStatus(row),
  };
}

function parseDetailRecordRow(row: Record<string, unknown>): LiveRecordBase {
  assertExactKeys(row, DETAIL_RECORD_KEYS);
  const languages = requiredLanguages(row, "languages");
  const createdAt = requiredTimestamp(row, "created_at");
  const archivedAt = requiredTimestamp(row, "archived_at");
  const endedAt = optionalTimestamp(row, "ended_at");
  const summaryStatus = mapSummaryStatus(requiredString(row, "summary_state"));
  return {
    sessionId: requiredString(row, "session_id"),
    title: requiredString(row, "title"),
    status: requiredLiveRecordStatus(row, "status"),
    languages,
    scheduledAt: optionalTimestamp(row, "scheduled_at"),
    startedAt: archivedAt,
    endedAt,
    viewerCount: 0,
    participantCount: requiredSafeInteger(row, "participant_count", 0),
    createdAt,
    updatedAt: endedAt ?? archivedAt,
    deletedAt: null,
    purgeEligibleAt: null,
    summaryStates: summaryStatesForLanguages(languages, summaryStatus),
    sheetStatus: parseSheetStatus(row),
  };
}

function parseParticipantRow(row: Record<string, unknown>): LiveRecordParticipant {
  assertExactKeys(row, PARTICIPANT_KEYS);
  const joinedAt = requiredTimestamp(row, "joined_at");
  const leftAt = optionalTimestamp(row, "left_at");
  const summaryDelivery = consentState(
    requiredBoolean(row, "summary_delivery_is_accepted"),
    nullableTimestamp(row, "summary_delivery_accepted_at"),
    nullableTimestamp(row, "summary_delivery_withdrawn_at"),
    nullableString(row, "summary_delivery_notice_version"),
  );
  return {
    participantId: requiredString(row, "participant_id"),
    displayName: requiredString(row, "display_name"),
    email: nullableString(row, "email"),
    company: nullableString(row, "company"),
    department: nullableString(row, "department") ?? "",
    jobTitle: nullableString(row, "job_title") ?? "",
    summaryConsentAt: summaryDelivery.accepted ? summaryDelivery.decidedAt : null,
    joinedAt,
    lastSeenAt: leftAt ?? joinedAt,
    isPresent: leftAt === null,
    utteranceCount: 0,
    speakingSeconds: 0,
    lastSpokeAt: null,
    consents: {
      privacy: consentState(
        requiredBoolean(row, "privacy_is_accepted"),
        nullableTimestamp(row, "privacy_accepted_at"),
        nullableTimestamp(row, "privacy_withdrawn_at"),
        nullableString(row, "privacy_notice_version"),
      ),
      summaryDelivery,
      marketing: consentState(
        requiredBoolean(row, "marketing_is_accepted"),
        nullableTimestamp(row, "marketing_accepted_at"),
        nullableTimestamp(row, "marketing_withdrawn_at"),
        nullableString(row, "marketing_notice_version"),
      ),
    },
  };
}

function parseAuthoritativeTranscriptRow(row: Record<string, unknown>): AuthoritativeTranscriptItem {
  assertExactKeys(row, AUTHORITATIVE_TRANSCRIPT_KEYS);
  const speakerRole = requiredSpeakerRole(row, "speaker_role");
  const participantId = nullableString(row, "participant_id");
  if ((speakerRole === "participant") !== (participantId !== null)) throw unavailable();
  return {
    sourceUtteranceId: requiredUuid(row, "source_utterance_id"),
    sourceSeq: requiredSafeInteger(row, "source_seq", 1),
    utteranceKey: requiredBoundedString(row, "utterance_key", 200, 600),
    rawText: requiredBoundedString(row, "raw_text", 8_000, 24_000),
    normalizedText: requiredBoundedString(row, "normalized_text", 8_000, 24_000),
    effectiveText: requiredBoundedString(row, "effective_text", 8_000, 24_000),
    sourceLanguage: requiredLanguage(row, "source_language"),
    speakerRole,
    speakerLabel: nullableBoundedString(row, "speaker_label", 80, 240),
    speakerName: nullableBoundedString(row, "speaker_name", 40, 120),
    speakerDepartment: nullableBoundedString(row, "speaker_department", 80, 240),
    speakerJobTitle: nullableBoundedString(row, "speaker_job_title", 100, 300),
    participantId: participantId === null ? null : requiredUuid(row, "participant_id"),
    sourceStartedAt: optionalTimestamp(row, "source_started_at"),
    sourceEndedAt: requiredTimestamp(row, "source_ended_at"),
    providerCommittedAt: requiredTimestamp(row, "provider_committed_at"),
    sttProvider: requiredProvider(row, "stt_provider"),
    sttModel: nullableBoundedString(row, "stt_model", 120, 360),
    translationModel: nullableBoundedString(row, "translation_model", 120, 360),
    pipelineConfigFingerprint: nullableFingerprint(row, "pipeline_config_fingerprint"),
    glossaryFingerprint: nullableFingerprint(row, "glossary_fingerprint"),
    correctionRevision: requiredSafeInteger(row, "correction_revision", 0),
    correctedAt: optionalTimestamp(row, "corrected_at"),
    translations: parseAuthoritativeTranslations(row.translations),
  };
}

function parseAuthoritativeTranslations(value: unknown): AuthoritativeTranscriptTranslation[] {
  if (!Array.isArray(value) || value.length > 3 || value.some((item) => !isRecord(item))) throw unavailable();
  return value.map((item) => {
    assertExactKeys(item, AUTHORITATIVE_TRANSLATION_KEYS);
    const translationStatus = requiredString(item, "translationStatus");
    if (translationStatus !== "verbatim" && translationStatus !== "translated" && translationStatus !== "failed") {
      throw unavailable();
    }
    return {
      language: requiredLanguage(item, "language"),
      seq: requiredSafeInteger(item, "seq", 1),
      text: requiredBoundedString(item, "text", 8_000, 24_000),
      translationStatus,
      emittedAt: requiredTimestamp(item, "emittedAt"),
    };
  });
}

function parseArchiveMutationRow(row: Record<string, unknown>): LiveRecordArchiveMutation {
  assertExactKeys(row, ARCHIVE_KEYS);
  return {
    sessionId: requiredString(row, "session_id"),
    deletedAt: optionalTimestamp(row, "archive_deleted_at"),
    purgeEligibleAt: optionalTimestamp(row, "archive_purge_after"),
  };
}

function parsePurgeEligibilityRow(row: Record<string, unknown>): LiveRecordPurgeEligibility {
  assertExactKeys(row, PURGE_KEYS);
  const isDeleted = requiredBoolean(row, "is_deleted");
  const eligible = requiredBoolean(row, "is_purge_eligible");
  return {
    sessionId: requiredString(row, "session_id"),
    eligible,
    reason: eligible ? "ELIGIBLE" : (isDeleted ? "RETENTION_WINDOW_ACTIVE" : "NOT_DELETED"),
    purgeEligibleAt: optionalTimestamp(row, "archive_purge_after"),
  };
}

function parseSheetStatus(row: Record<string, unknown>): SafeSheetStatus {
  return {
    state: mapSheetStatus(requiredString(row, "sheet_sync_state")),
    attemptCount: 0,
    safeErrorCode: nullableSafeErrorCode(row, "sheet_error_code"),
    updatedAt: null,
    ...optionalSafeIntegerObject(row, "sheet_id", "sheetId"),
    ...optionalSafeIntegerObject(row, "session_index_row", "sessionIndexRow"),
    ...optionalStringObject(row, "tab_title", "tabTitle"),
    ...optionalSafeIntegerObject(row, "projection_version", "projectionVersion"),
    ...optionalSafeIntegerObject(row, "last_exported_projection_version", "lastExportedProjectionVersion"),
    ...optionalSafeIntegerObject(row, "last_exported_participant_count", "lastExportedParticipantCount"),
  };
}

function summaryStatesForLanguages(languages: string[], status: SafeSummaryStatus): LiveRecordBase["summaryStates"] {
  return Object.fromEntries(languages.map((language) => [language, { status }]));
}

function consentState(
  accepted: boolean,
  acceptedAt: string | null,
  withdrawnAt: string | null,
  noticeVersion: string | null,
): LiveRecordParticipantConsentState {
  return {
    accepted,
    decidedAt: accepted ? acceptedAt : withdrawnAt,
    noticeVersion,
  };
}

function consentDecisionTimestamp(row: Record<string, unknown>, purpose: ConsentPurpose): string | null {
  if (requiredBoolean(row, "is_accepted")) return nullableTimestamp(row, "accepted_at");
  return purpose === "summary_delivery" || purpose === "marketing"
    ? nullableTimestamp(row, "withdrawn_at") ?? nullableTimestamp(row, "recorded_at")
    : nullableTimestamp(row, "recorded_at");
}

function parseConsentChoiceRow(
  row: Record<string, unknown>,
  expectedPurpose: ConsentPurpose,
  expectedSessionId: string,
  expectedParticipantId: string,
): {
  purpose: ConsentPurpose;
  accepted: boolean;
  noticeVersion: string;
  decidedAt: string | null;
} {
  assertExactKeys(row, CONSENT_KEYS);
  const purpose = requiredConsentPurpose(row, "purpose");
  if (purpose !== expectedPurpose
    || requiredString(row, "session_id") !== expectedSessionId
    || requiredString(row, "participant_id") !== expectedParticipantId) {
    throw unavailable();
  }
  return {
    purpose,
    accepted: requiredBoolean(row, "is_accepted"),
    noticeVersion: requiredString(row, "notice_version"),
    decidedAt: consentDecisionTimestamp(row, purpose),
  };
}

function findConsentDecision(
  consents: readonly ParticipantConsentDecision[],
  purpose: ConsentPurpose,
): ParticipantConsentDecision {
  const decision = consents.find((consent) => consent.purpose === purpose);
  if (!decision) throw unavailable();
  return decision;
}

function parseRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) throw unavailable();
  return value as Record<string, unknown>[];
}

function mapRpcFailure(status: number, value: unknown): LiveRecordsError {
  const body = parseRpcErrorBody(value);
  if (body.message === "HOST_ACCESS_REQUIRED") {
    return new LiveRecordsError("라이브콜 기록을 찾을 수 없습니다.", "LIVE_RECORD_NOT_FOUND", 404);
  }
  if (body.message === "LIVE_TRANSCRIPT_NOT_READY") {
    return new LiveRecordsError(
      "라이브콜 종료 후 원문 기록을 볼 수 있습니다.",
      "AUTHORITATIVE_TRANSCRIPT_NOT_READY",
      409,
    );
  }
  if (body.message === "PARTICIPANT_CONSENT_FORBIDDEN") {
    return new LiveRecordsError("이 세션의 동의를 변경할 권한이 없습니다.", "CONSENT_FORBIDDEN", 403);
  }
  if (body.message === "ARCHIVE_DELETE_NOT_AVAILABLE") {
    return new LiveRecordsError("삭제할 수 있는 라이브콜 기록이 아닙니다.", "LIVE_RECORD_DELETE_NOT_AVAILABLE", 409);
  }
  if (body.message === "ARCHIVE_RESTORE_NOT_AVAILABLE") {
    return new LiveRecordsError("복원할 수 있는 라이브콜 기록이 아닙니다.", "LIVE_RECORD_RESTORE_NOT_AVAILABLE", 409);
  }
  if (status === 400 || body.message?.startsWith("INVALID_LIVE_RECORD_") || body.message === "INVALID_LIVE_CONSENT_INPUT") {
    return new LiveRecordsError("라이브콜 기록 요청이 올바르지 않습니다.", "INVALID_LIVE_RECORDS_REQUEST", 400);
  }
  return unavailable();
}

function parseRpcErrorBody(value: unknown): RpcErrorBody {
  if (!isRecord(value)) return {};
  return {
    code: typeof value.code === "string" ? value.code : undefined,
    message: typeof value.message === "string" ? value.message.slice(0, 200) : undefined,
  };
}

function unavailable(): LiveRecordsError {
  return new LiveRecordsError(
    "라이브콜 기록 저장소에 연결할 수 없습니다.",
    "LIVE_RECORDS_STORE_UNAVAILABLE",
    503,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(row: Record<string, unknown>, expected: ReadonlySet<string>): void {
  const keys = Object.keys(row);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) throw unavailable();
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw unavailable();
  return value;
}

function requiredBoundedString(
  row: Record<string, unknown>,
  key: string,
  maxCodepoints: number,
  maxBytes: number,
): string {
  const value = requiredString(row, key);
  if (Array.from(value).length > maxCodepoints || new TextEncoder().encode(value).byteLength > maxBytes) {
    throw unavailable();
  }
  return value;
}

function nullableBoundedString(
  row: Record<string, unknown>,
  key: string,
  maxCodepoints: number,
  maxBytes: number,
): string | null {
  const value = nullableString(row, key);
  if (value === null) return null;
  if (value.length === 0
    || Array.from(value).length > maxCodepoints
    || new TextEncoder().encode(value).byteLength > maxBytes) {
    throw unavailable();
  }
  return value;
}

function requiredUuid(row: Record<string, unknown>, key: string): string {
  const value = requiredString(row, key);
  if (!UUID_PATTERN.test(value)) throw unavailable();
  return value;
}

function requiredProvider(row: Record<string, unknown>, key: string): string {
  const value = requiredString(row, key);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)) throw unavailable();
  return value;
}

function nullableFingerprint(row: Record<string, unknown>, key: string): string | null {
  const value = nullableString(row, key);
  if (value === null) return null;
  if (!FINGERPRINT_PATTERN.test(value)) throw unavailable();
  return value;
}

function nullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw unavailable();
  return value;
}

function requiredTimestamp(row: Record<string, unknown>, key: string): string {
  const value = requiredString(row, key);
  if (!Number.isFinite(Date.parse(value))) throw unavailable();
  return value;
}

function optionalTimestamp(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw unavailable();
  return value;
}

function nullableTimestamp(row: Record<string, unknown>, key: string): string | null {
  return optionalTimestamp(row, key);
}

function requiredBoolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw unavailable();
  return value;
}

function requiredSafeInteger(row: Record<string, unknown>, key: string, min: number): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw unavailable();
  return value;
}

function optionalSafeIntegerObject<T extends string>(
  row: Record<string, unknown>,
  key: string,
  targetKey: T,
): Partial<Record<T, number | null>> {
  const value = row[key];
  if (value === null || value === undefined) return { [targetKey]: null } as Partial<Record<T, number | null>>;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw unavailable();
  return { [targetKey]: value } as Partial<Record<T, number | null>>;
}

function optionalStringObject<T extends string>(
  row: Record<string, unknown>,
  key: string,
  targetKey: T,
): Partial<Record<T, string | null>> {
  return { [targetKey]: nullableString(row, key) } as Partial<Record<T, string | null>>;
}

function requiredLanguages(row: Record<string, unknown>, key: string): string[] {
  const value = row[key];
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw unavailable();
  const languages = value.map((item) => {
    if (typeof item !== "string" || item.length < 2 || item.length > 12) throw unavailable();
    return item;
  });
  if (new Set(languages).size !== languages.length) throw unavailable();
  return languages;
}

function requiredLanguage(row: Record<string, unknown>, key: string): string {
  const value = requiredString(row, key);
  if (value.length > 35 || !LANGUAGE_PATTERN.test(value)) throw unavailable();
  return value;
}

function requiredSpeakerRole(row: Record<string, unknown>, key: string): AuthoritativeTranscriptItem["speakerRole"] {
  const value = requiredString(row, key);
  if (value === "host" || value === "participant" || value === "unknown") return value;
  throw unavailable();
}

function requiredLiveRecordStatus(row: Record<string, unknown>, key: string): LiveRecordBase["status"] {
  const value = requiredString(row, key);
  if (value === "preparing" || value === "live" || value === "paused" || value === "stopped" || value === "failed") return value;
  throw unavailable();
}

function requiredConsentPurpose(row: Record<string, unknown>, key: string): ConsentPurpose {
  const value = requiredString(row, key);
  if (value === "summary_delivery" || value === "marketing") return value;
  throw unavailable();
}

function mapSummaryStatus(value: string): SafeSummaryStatus {
  if (value === "ready") return "ready";
  if (value === "running" || value === "pending") return "running";
  if (value === "failed") return "retryable_failed";
  if (value === "not_started") return "missing";
  throw unavailable();
}

function mapSheetStatus(value: string): SafeSheetStatusState {
  if (value === "pending") return "pending";
  if (value === "claimed" || value === "syncing") return "running";
  if (value === "succeeded") return "succeeded";
  if (value === "failed") return "failed";
  if (value === "not_started") return "not_configured";
  throw unavailable();
}

function nullableSafeErrorCode(row: Record<string, unknown>, key: string): string | null {
  const value = nullableString(row, key);
  if (value === null) return null;
  if (!/^[A-Z0-9_]{3,64}$/u.test(value)) throw unavailable();
  return value;
}
