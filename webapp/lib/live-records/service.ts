import type { LiveTopicSnapshot } from "../live-contract";
import type { RecordingGap } from "../live-recap/contract";
import {
  readMeetingSummary,
  readMeetingSummaryGenerationStatus,
  type MeetingSummary,
  type SummaryGenerationStatus,
  withSummaryReadDeadline,
} from "../live/summary";
import { readCachedHostLiveTranscript, type HostTranscriptReadRecord } from "../live/transcript-read";
import { participantConsentUpdateInputSchema } from "../security/live-consent-validation";
import { LiveRecordsError } from "./errors";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const DEFAULT_TRANSCRIPT_PAGE_SIZE = 50;
const MAX_TRANSCRIPT_PAGE_SIZE = 50;
const MAX_SEARCH_CHARS = 100;
const PURGE_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

export type LiveRecordStatus = "preparing" | "live" | "paused" | "stopped" | "failed";
export type SafeSummaryStatus = SummaryGenerationStatus["status"];
export type SafeSheetStatusState = "not_configured" | "pending" | "running" | "succeeded" | "failed";
export type ConsentPurpose = "summary_delivery" | "marketing";

export interface SafeSummaryState {
  status: SafeSummaryStatus;
  createdAt?: string;
}

export interface SafeSheetStatus {
  state: SafeSheetStatusState;
  attemptCount: number;
  safeErrorCode: string | null;
  updatedAt: string | null;
  lastExportedAt?: string | null;
  sheetId?: number | null;
  sessionIndexRow?: number | null;
  tabTitle?: string | null;
  projectionVersion?: number | null;
  lastExportedProjectionVersion?: number | null;
  lastExportedParticipantCount?: number | null;
}

export interface LiveRecordBase {
  sessionId: string;
  title: string;
  status: LiveRecordStatus;
  languages: string[];
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  viewerCount: number;
  participantCount: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  purgeEligibleAt: string | null;
  summaryStates: Record<string, SafeSummaryState>;
  sheetStatus: SafeSheetStatus;
}

export interface LiveRecordListPage {
  items: LiveRecordBase[];
  page: number;
  pageSize: number;
  total: number;
  hasNextPage: boolean;
}

export interface LiveRecordDetail {
  record: LiveRecordBase;
  selectedLanguage: string;
  transcript: HostTranscriptReadRecord;
  topics: LiveTopicSnapshot["topics"];
  summary: LiveRecordSelectedSummary | null;
  participants: LiveRecordParticipant[];
  summaryStates: Record<string, SafeSummaryState>;
}

export interface LiveRecordSelectedSummary {
  language: string;
  summary: MeetingSummary;
  createdAt: string;
}

export interface LiveRecordParticipantConsentState {
  accepted: boolean;
  decidedAt: string | null;
  noticeVersion: string | null;
}

export interface LiveRecordParticipant {
  participantId: string;
  displayName: string;
  email: string | null;
  company: string | null;
  department: string;
  jobTitle: string;
  summaryConsentAt: string | null;
  joinedAt: string;
  lastSeenAt: string;
  isPresent: boolean;
  utteranceCount: number;
  speakingSeconds: number;
  lastSpokeAt: string | null;
  consents: {
    privacy: LiveRecordParticipantConsentState;
    summaryDelivery: LiveRecordParticipantConsentState;
    marketing: LiveRecordParticipantConsentState;
  };
}

export interface LiveRecordArchiveMutation {
  sessionId: string;
  deletedAt: string | null;
  purgeEligibleAt: string | null;
}

export interface LiveRecordPurgeEligibility {
  sessionId: string;
  eligible: boolean;
  reason: "NOT_DELETED" | "RETENTION_WINDOW_ACTIVE" | "ELIGIBLE" | "LEGAL_HOLD";
  purgeEligibleAt: string | null;
}

export interface AuthoritativeTranscriptTranslation {
  language: string;
  seq: number;
  text: string;
  translationStatus: "verbatim" | "translated" | "failed";
  emittedAt: string;
}

export interface AuthoritativeTranscriptItem {
  speakerProfile?: import("../../../packages/caption-core/speaker-profile.js").SpeakerProfile;
  speakerAttribution?: "unresolved";
  sourceUtteranceId: string;
  sourceSeq: number;
  utteranceKey: string;
  rawText: string;
  normalizedText: string;
  effectiveText: string;
  sourceLanguage: string;
  speakerRole: "host" | "participant" | "unknown";
  speakerLabel: string | null;
  speakerName: string | null;
  speakerDepartment: string | null;
  speakerJobTitle: string | null;
  participantId: string | null;
  sourceStartedAt: string | null;
  sourceEndedAt: string;
  providerCommittedAt: string;
  sttProvider: string;
  sttModel: string | null;
  translationModel: string | null;
  pipelineConfigFingerprint: string | null;
  glossaryFingerprint: string | null;
  correctionRevision: number;
  correctedAt: string | null;
  translations: AuthoritativeTranscriptTranslation[];
}

export interface AuthoritativeTranscriptPage {
  sessionId: string;
  afterSourceSeq: number;
  pageSize: number;
  items: AuthoritativeTranscriptItem[];
  nextAfterSourceSeq: number | null;
  hasNextPage: boolean;
  recordingGaps?: RecordingGap[];
}

export interface ParticipantConsentDecision {
  purpose: ConsentPurpose;
  accepted: boolean;
  noticeVersion: string;
}

export interface ParticipantConsentProjection {
  sessionId: string;
  summaryDelivery: {
    accepted: boolean;
    noticeVersion: string;
    decidedAt: string;
  };
  marketing: {
    accepted: boolean;
    noticeVersion: string;
    decidedAt: string;
  };
}

export interface LiveRecordsStore {
  listOwnedLiveRecords(
    hostId: string,
    input: { page: number; pageSize: number; search: string | null },
  ): Promise<LiveRecordListPage>;
  getOwnedLiveRecordBase(hostId: string, sessionId: string): Promise<LiveRecordBase | null>;
  softDeleteOwnedLiveRecord(hostId: string, sessionId: string, nowIso: string): Promise<LiveRecordArchiveMutation | null>;
  restoreOwnedLiveRecord(hostId: string, sessionId: string): Promise<LiveRecordArchiveMutation | null>;
  getOwnedPurgeEligibility(hostId: string, sessionId: string, nowIso: string): Promise<LiveRecordPurgeEligibility | null>;
  listOwnedLiveRecordParticipants(hostId: string, sessionId: string): Promise<LiveRecordParticipant[]>;
  listOwnedAuthoritativeTranscript(
    hostId: string,
    sessionId: string,
    input: { afterSourceSeq: number; limit: number },
  ): Promise<AuthoritativeTranscriptItem[]>;
  updateParticipantConsents(input: {
    sessionId: string;
    participantUserId: string;
    decidedAt: string;
    consents: ParticipantConsentDecision[];
  }): Promise<ParticipantConsentProjection>;
}

export interface LiveRecordsReaders {
  readTranscript: (sessionId: string, language: string) => Promise<HostTranscriptReadRecord>;
  readSummary: (
    sessionId: string,
    language: string,
  ) => Promise<{ summary: MeetingSummary; model: string | null; createdAt: string } | null>;
  readSummaryStatus: (sessionId: string, language: string) => Promise<SummaryGenerationStatus>;
}

export { LiveRecordsError } from "./errors";

export class LiveRecordsService {
  private readonly store: LiveRecordsStore;
  private readonly readers: LiveRecordsReaders;
  private readonly now: () => number;

  constructor(
    store: LiveRecordsStore,
    readers: Partial<LiveRecordsReaders> = {},
    now: () => number = Date.now,
  ) {
    this.store = store;
    this.readers = {
      readTranscript: readers.readTranscript ?? ((sessionId, language) => readCachedHostLiveTranscript(sessionId, language)),
      readSummary: readers.readSummary
        ?? ((sessionId, language) => withSummaryReadDeadline((signal) => readMeetingSummary(sessionId, language, fetch, { signal }))),
      readSummaryStatus: readers.readSummaryStatus
        ?? ((sessionId, language) => withSummaryReadDeadline((signal) => readMeetingSummaryGenerationStatus(sessionId, language, fetch, { signal }))),
    };
    this.now = now;
  }

  async list(
    hostId: string,
    input: { page?: unknown; pageSize?: unknown; search?: unknown } = {},
  ): Promise<LiveRecordListPage> {
    return this.store.listOwnedLiveRecords(hostId, {
      page: parsePage(input.page),
      pageSize: parsePageSize(input.pageSize),
      search: parseSearch(input.search),
    });
  }

  async getDetail(
    hostId: string,
    sessionId: string,
    input: { language?: unknown } = {},
  ): Promise<LiveRecordDetail> {
    const record = await this.store.getOwnedLiveRecordBase(hostId, sessionId);
    if (!record) throw new LiveRecordsError("라이브콜 기록을 찾을 수 없습니다.", "LIVE_RECORD_NOT_FOUND", 404);
    const selectedLanguage = parseRecordLanguage(input.language, record.languages);
    const [transcript, participants, summaries] = await Promise.all([
      this.readers.readTranscript(sessionId, selectedLanguage),
      this.store.listOwnedLiveRecordParticipants(hostId, sessionId),
      this.readSummaryStates(sessionId, record.languages, selectedLanguage),
    ]);
    return {
      record: { ...record, summaryStates: summaries.states },
      selectedLanguage,
      transcript,
      topics: transcript.topics,
      summary: summaries.selected,
      participants,
      summaryStates: summaries.states,
    };
  }

  async softDelete(hostId: string, sessionId: string): Promise<LiveRecordArchiveMutation> {
    const nowIso = new Date(this.now()).toISOString();
    const deleted = await this.store.softDeleteOwnedLiveRecord(hostId, sessionId, nowIso);
    if (!deleted) throw new LiveRecordsError("라이브콜 기록을 찾을 수 없습니다.", "LIVE_RECORD_NOT_FOUND", 404);
    return deleted;
  }

  async restore(hostId: string, sessionId: string): Promise<LiveRecordArchiveMutation> {
    const restored = await this.store.restoreOwnedLiveRecord(hostId, sessionId);
    if (!restored) throw new LiveRecordsError("라이브콜 기록을 찾을 수 없습니다.", "LIVE_RECORD_NOT_FOUND", 404);
    return restored;
  }

  async getPurgeEligibility(hostId: string, sessionId: string): Promise<LiveRecordPurgeEligibility> {
    const eligibility = await this.store.getOwnedPurgeEligibility(
      hostId,
      sessionId,
      new Date(this.now()).toISOString(),
    );
    if (!eligibility) throw new LiveRecordsError("라이브콜 기록을 찾을 수 없습니다.", "LIVE_RECORD_NOT_FOUND", 404);
    return eligibility;
  }

  async getAuthoritativeTranscript(
    hostId: string,
    sessionId: string,
    input: { afterSourceSeq?: unknown; pageSize?: unknown } = {},
  ): Promise<AuthoritativeTranscriptPage> {
    // Ownership is intentionally checked before the privileged audit RPC so
    // another host cannot use cursor behavior to infer whether rows exist.
    const record = await this.store.getOwnedLiveRecordBase(hostId, sessionId);
    if (!record) throw new LiveRecordsError("라이브콜 기록을 찾을 수 없습니다.", "LIVE_RECORD_NOT_FOUND", 404);
    const isTerminal = record.status === "stopped" || record.status === "failed";
    // `startedAt` is the current safe records projection of the archive
    // completion timestamp; failed sessions may not have `endedAt`.
    if (!isTerminal || (!record.endedAt && !record.startedAt)) {
      throw new LiveRecordsError(
        "라이브콜 종료 후 원문 기록을 볼 수 있습니다.",
        "AUTHORITATIVE_TRANSCRIPT_NOT_READY",
        409,
      );
    }
    const afterSourceSeq = parseAfterSourceSeq(input.afterSourceSeq);
    const pageSize = parseTranscriptPageSize(input.pageSize);
    const items = await this.store.listOwnedAuthoritativeTranscript(hostId, sessionId, {
      afterSourceSeq,
      limit: pageSize,
    });
    const lastItem = items.at(-1);
    return {
      sessionId,
      afterSourceSeq,
      pageSize,
      items,
      nextAfterSourceSeq: items.length === pageSize && lastItem ? lastItem.sourceSeq : null,
      hasNextPage: items.length === pageSize,
    };
  }

  async updateParticipantConsents(
    sessionId: string,
    participantUserId: string,
    input: unknown,
  ): Promise<ParticipantConsentProjection> {
    const result = participantConsentUpdateInputSchema.safeParse(input);
    if (!result.success) {
      throw new LiveRecordsError("동의 요청 형식이 올바르지 않습니다.", "INVALID_CONSENT_REQUEST", 400);
    }
    const parsed = result.data;
    const decidedAt = new Date(this.now()).toISOString();
    return this.store.updateParticipantConsents({
      sessionId,
      participantUserId,
      decidedAt,
      consents: [
        {
          purpose: "summary_delivery",
          accepted: parsed.summaryConsent,
          noticeVersion: parsed.consentNoticeVersions.summaryDelivery,
        },
        {
          purpose: "marketing",
          accepted: parsed.marketingConsent,
          noticeVersion: parsed.consentNoticeVersions.marketing,
        },
      ],
    });
  }

  private async readSummaryStates(
    sessionId: string,
    languages: string[],
    selectedLanguage: string,
  ): Promise<{ states: Record<string, SafeSummaryState>; selected: LiveRecordSelectedSummary | null }> {
    let selected: LiveRecordSelectedSummary | null = null;
    const entries = await Promise.all(languages.map(async (language) => {
      const record = await this.readers.readSummary(sessionId, language);
      if (record) {
        if (language === selectedLanguage) {
          selected = { language, summary: record.summary, createdAt: record.createdAt };
        }
        return [language, {
          status: "ready" as const,
          createdAt: record.createdAt,
        }] as const;
      }
      const generation = await this.readers.readSummaryStatus(sessionId, language);
      return [language, { status: generation.status }] as const;
    }));
    return { states: Object.fromEntries(entries), selected };
  }
}

export function defaultPurgeEligibleAt(deletedAt: string): string {
  return new Date(Date.parse(deletedAt) + PURGE_RETENTION_MILLISECONDS).toISOString();
}

function parsePage(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_PAGE;
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isSafeInteger(parsed) && Number(parsed) >= 1 ? Number(parsed) : DEFAULT_PAGE;
}

function parsePageSize(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_PAGE_SIZE;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Number(parsed), MAX_PAGE_SIZE);
}

function parseAfterSourceSeq(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isSafeInteger(parsed) && Number(parsed) >= 0 ? Number(parsed) : 0;
}

function parseTranscriptPageSize(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_TRANSCRIPT_PAGE_SIZE;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1) return DEFAULT_TRANSCRIPT_PAGE_SIZE;
  return Math.min(Number(parsed), MAX_TRANSCRIPT_PAGE_SIZE);
}

function parseSearch(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, MAX_SEARCH_CHARS).join("");
}

function parseRecordLanguage(value: unknown, languages: readonly string[]): string {
  if (typeof value === "string" && languages.includes(value)) return value;
  const first = languages[0];
  if (!first) throw new LiveRecordsError("라이브콜 기록 언어가 올바르지 않습니다.", "LIVE_RECORD_INVALID_LANGUAGE", 503);
  return first;
}
