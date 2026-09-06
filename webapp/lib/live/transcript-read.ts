import type { LiveSession, LiveTopicSnapshot } from "../live-contract";
import { projectTopicMemberships } from "./topic-state";
import { fetchUtterances, SummaryError, type MeetingUtterance } from "./summary";
import { getLiveSessionStore, type LiveSessionStore } from "./store";

export const TRANSCRIPT_READ_TIMEOUT_MILLISECONDS = 5_000;
export const MAX_TRANSCRIPT_UTTERANCES = 12_000;
export const MAX_TRANSCRIPT_TOPICS = 1_000;
export const MAX_TRANSCRIPT_TOPIC_MEMBERSHIPS = 12_000;

const TRANSCRIPT_CACHE_TTL_MILLISECONDS = 1_000;
const MAX_TRANSCRIPT_CACHE_ENTRIES = 64;

export interface TranscriptReadRecord {
  language: string;
  event: {
    companyName: string | null;
    ticker: string | null;
    fiscalPeriod: string | null;
    eventType: LiveSession["eventType"] | null;
    agenda: NonNullable<LiveSession["agenda"]>;
    activeSection: NonNullable<LiveSession["activeSection"]>;
    sectionStartedAt: string | null;
  };
  topics: LiveTopicSnapshot["topics"];
  utterances: Array<{
    speakerProfile?: import("../../../packages/caption-core/speaker-profile.js").SpeakerProfile;
    speakerAttribution?: "unresolved";
    seq: number;
    speaker: string;
    text: string;
    emittedAt: string;
  }>;
}

export type HostTranscriptReadRecord = Omit<TranscriptReadRecord, "utterances"> & {
  utterances: Array<TranscriptReadRecord["utterances"][number] & {
    participantId?: string;
    sourceText?: string;
    sourceLanguage?: string;
    origin?: "source";
    utteranceKey?: string;
    translationStatus?: "verbatim" | "translated" | "failed";
    topicId?: string;
    topicPosition?: number;
  }>;
};

interface TranscriptReadDeps {
  fetchUtterances?: (
    sessionId: string,
    language: string,
    fetchFn?: typeof fetch,
    options?: {
      maxRows?: number;
      maxTextCodepoints?: number;
      deadlineAt?: number;
      signal?: AbortSignal;
    },
  ) => Promise<MeetingUtterance[]>;
  fetchFn?: typeof fetch;
  getStore?: () => LiveSessionStore;
  now?: () => number;
  timeoutMilliseconds?: number;
}

interface TranscriptCacheEntry {
  expiresAt: number;
  promise: Promise<TranscriptReadRecord>;
  isSettled: boolean;
}

interface HostTranscriptCacheEntry {
  expiresAt: number;
  promise: Promise<HostTranscriptReadRecord>;
  isSettled: boolean;
}

const transcriptReadCache = new Map<string, TranscriptCacheEntry>();
const hostTranscriptReadCache = new Map<string, HostTranscriptCacheEntry>();

export function clearTranscriptReadCacheForTest(): void {
  transcriptReadCache.clear();
  hostTranscriptReadCache.clear();
}

export async function readCachedHostLiveTranscript(
  sessionId: string,
  language: string,
  deps: TranscriptReadDeps = {},
): Promise<HostTranscriptReadRecord> {
  const now = deps.now ?? Date.now;
  const timestamp = now();
  cleanupHostTranscriptCache(timestamp);
  const key = `${sessionId}\u0000${language}`;
  const cached = hostTranscriptReadCache.get(key);
  if (cached && (!cached.isSettled || cached.expiresAt > timestamp)) return cached.promise;

  const timeoutMilliseconds = deps.timeoutMilliseconds ?? TRANSCRIPT_READ_TIMEOUT_MILLISECONDS;
  const entry: HostTranscriptCacheEntry = {
    expiresAt: timestamp + TRANSCRIPT_CACHE_TTL_MILLISECONDS,
    isSettled: false,
    promise: Promise.resolve().then(() => withTranscriptReadDeadline(
      (signal) => readFreshHostLiveTranscript(sessionId, language, signal, {
        ...deps,
        now,
        timeoutMilliseconds,
      }),
      timeoutMilliseconds,
    )),
  };
  hostTranscriptReadCache.set(key, entry);
  entry.promise.then(() => {
    if (hostTranscriptReadCache.get(key) === entry) {
      entry.isSettled = true;
      entry.expiresAt = now() + TRANSCRIPT_CACHE_TTL_MILLISECONDS;
    }
  }, () => {
    if (hostTranscriptReadCache.get(key) === entry) hostTranscriptReadCache.delete(key);
  });
  trimHostTranscriptCache();
  return entry.promise;
}

export async function readCachedLiveTranscript(
  sessionId: string,
  language: string,
  deps: TranscriptReadDeps = {},
): Promise<TranscriptReadRecord> {
  const now = deps.now ?? Date.now;
  const timestamp = now();
  cleanupTranscriptCache(timestamp);
  const key = `${sessionId}\u0000${language}`;
  const cached = transcriptReadCache.get(key);
  if (cached && (!cached.isSettled || cached.expiresAt > timestamp)) return cached.promise;

  const timeoutMilliseconds = deps.timeoutMilliseconds ?? TRANSCRIPT_READ_TIMEOUT_MILLISECONDS;
  const entry: TranscriptCacheEntry = {
    expiresAt: timestamp + TRANSCRIPT_CACHE_TTL_MILLISECONDS,
    isSettled: false,
    promise: Promise.resolve().then(() => withTranscriptReadDeadline(
      (signal) => readFreshLiveTranscript(sessionId, language, signal, {
        ...deps,
        now,
        timeoutMilliseconds,
      }),
      timeoutMilliseconds,
    )),
  };
  transcriptReadCache.set(key, entry);
  entry.promise.then(() => {
    if (transcriptReadCache.get(key) === entry) {
      entry.isSettled = true;
      entry.expiresAt = now() + TRANSCRIPT_CACHE_TTL_MILLISECONDS;
    }
  }, () => {
    if (transcriptReadCache.get(key) === entry) transcriptReadCache.delete(key);
  });
  trimTranscriptCache();
  return entry.promise;
}

async function readFreshLiveTranscript(
  sessionId: string,
  language: string,
  signal: AbortSignal,
  deps: Required<Pick<TranscriptReadDeps, "now" | "timeoutMilliseconds">> & TranscriptReadDeps,
): Promise<TranscriptReadRecord> {
  const store = deps.getStore?.() ?? getLiveSessionStore();
  const readUtterances = deps.fetchUtterances ?? fetchUtterances;
  const deadlineAt = deps.now() + deps.timeoutMilliseconds;
  const session = await store.get(sessionId, { signal });
  if (signal.aborted) throw transcriptReadError();
  assertPublicTranscriptReady(sessionId, session);
  const [utterances, topicSnapshot] = await Promise.all([
    readUtterances(sessionId, language, deps.fetchFn ?? fetch, {
      maxRows: MAX_TRANSCRIPT_UTTERANCES + 1,
      deadlineAt,
      signal,
    }),
    store.getTopicTranscript(sessionId, {
      maxTopics: MAX_TRANSCRIPT_TOPICS,
      maxTopicMemberships: MAX_TRANSCRIPT_TOPIC_MEMBERSHIPS,
      signal,
    }),
  ]);
  if (signal.aborted) throw transcriptReadError();
  if (utterances.length > MAX_TRANSCRIPT_UTTERANCES
    || topicSnapshot.topics.length > MAX_TRANSCRIPT_TOPICS
    || topicSnapshot.topicMemberships.length > MAX_TRANSCRIPT_TOPIC_MEMBERSHIPS) {
    throw new SummaryError("회의록이 너무 큽니다.", "TRANSCRIPT_TOO_LARGE", 413);
  }
  const projectedUtterances = projectTopicMemberships(utterances, topicSnapshot.topicMemberships);
  return {
    language,
    event: {
      companyName: session.companyName ?? null,
      ticker: session.ticker ?? null,
      fiscalPeriod: session.fiscalPeriod ?? null,
      eventType: session.eventType ?? null,
      agenda: session.agenda ?? [],
      activeSection: session.activeSection ?? "prepared_remarks",
      sectionStartedAt: session.sectionStartedAt ?? null,
    },
    topics: topicSnapshot.topics,
    utterances: projectedUtterances.map((utterance) => ({
      ...(utterance.speakerProfile ? { speakerProfile: utterance.speakerProfile } : {}),
      ...(utterance.speakerAttribution ? { speakerAttribution: utterance.speakerAttribution } : {}),
      seq: utterance.seq,
      speaker: utterance.speakerName ?? utterance.speakerLabel ?? "발표자",
      text: utterance.text,
      emittedAt: utterance.emittedAt,
    })),
  };
}

function assertPublicTranscriptReady(sessionId: string, session: LiveSession | null): asserts session is LiveSession {
  if (!session || session.id !== sessionId) throw transcriptReadError();
  const hasTerminalStatus = session.status === "stopped" || session.status === "failed";
  const hasDurableEndEvidence = typeof session.endedAt === "string" && Number.isFinite(Date.parse(session.endedAt));
  if (!hasTerminalStatus || !hasDurableEndEvidence) {
    throw new SummaryError(
      "회의록은 라이브콜 종료 후 확인할 수 있습니다.",
      "TRANSCRIPT_NOT_READY",
      409,
    );
  }
}

async function readFreshHostLiveTranscript(
  sessionId: string,
  language: string,
  signal: AbortSignal,
  deps: Required<Pick<TranscriptReadDeps, "now" | "timeoutMilliseconds">> & TranscriptReadDeps,
): Promise<HostTranscriptReadRecord> {
  const store = deps.getStore?.() ?? getLiveSessionStore();
  const readUtterances = deps.fetchUtterances ?? fetchUtterances;
  const deadlineAt = deps.now() + deps.timeoutMilliseconds;
  const [utterances, topicSnapshot, session] = await Promise.all([
    readUtterances(sessionId, language, deps.fetchFn ?? fetch, {
      maxRows: MAX_TRANSCRIPT_UTTERANCES + 1,
      deadlineAt,
      signal,
    }),
    store.getTopicTranscript(sessionId, {
      maxTopics: MAX_TRANSCRIPT_TOPICS,
      maxTopicMemberships: MAX_TRANSCRIPT_TOPIC_MEMBERSHIPS,
      signal,
    }),
    store.get(sessionId, { signal }),
  ]);
  if (signal.aborted) throw transcriptReadError();
  if (!session || session.id !== sessionId) throw transcriptReadError();
  if (utterances.length > MAX_TRANSCRIPT_UTTERANCES
    || topicSnapshot.topics.length > MAX_TRANSCRIPT_TOPICS
    || topicSnapshot.topicMemberships.length > MAX_TRANSCRIPT_TOPIC_MEMBERSHIPS) {
    throw new SummaryError("회의록이 너무 큽니다.", "TRANSCRIPT_TOO_LARGE", 413);
  }
  const projectedUtterances = projectTopicMemberships(utterances, topicSnapshot.topicMemberships);
  return {
    language,
    event: {
      companyName: session.companyName ?? null,
      ticker: session.ticker ?? null,
      fiscalPeriod: session.fiscalPeriod ?? null,
      eventType: session.eventType ?? null,
      agenda: session.agenda ?? [],
      activeSection: session.activeSection ?? "prepared_remarks",
      sectionStartedAt: session.sectionStartedAt ?? null,
    },
    topics: topicSnapshot.topics,
    utterances: projectedUtterances.map((utterance) => ({
      ...(utterance.speakerProfile ? { speakerProfile: utterance.speakerProfile } : {}),
      ...(utterance.speakerAttribution ? { speakerAttribution: utterance.speakerAttribution } : {}),
      seq: utterance.seq,
      speaker: utterance.speakerName ?? utterance.speakerLabel ?? "발표자",
      text: utterance.text,
      emittedAt: utterance.emittedAt,
      ...(utterance.participantId ? { participantId: utterance.participantId } : {}),
      ...(utterance.sourceText ? { sourceText: utterance.sourceText } : {}),
      ...(utterance.sourceLanguage ? { sourceLanguage: utterance.sourceLanguage } : {}),
      ...(utterance.origin ? { origin: utterance.origin } : {}),
      ...(utterance.utteranceKey ? { utteranceKey: utterance.utteranceKey } : {}),
      ...(utterance.translationStatus ? { translationStatus: utterance.translationStatus } : {}),
      ...(utterance.topicId ? { topicId: utterance.topicId, topicPosition: utterance.topicPosition } : {}),
    })),
  };
}

function withTranscriptReadDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>,
  timeoutMilliseconds: number,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw transcriptReadError();
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutFailure = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = transcriptReadError();
      reject(error);
      controller.abort(error);
    }, timeoutMilliseconds);
  });
  return Promise.race([read(controller.signal), timeoutFailure])
    .finally(() => {
      if (timeout) clearTimeout(timeout);
    });
}

function cleanupTranscriptCache(now: number): void {
  for (const [key, entry] of transcriptReadCache) {
    if (entry.isSettled && entry.expiresAt <= now) transcriptReadCache.delete(key);
  }
}

function cleanupHostTranscriptCache(now: number): void {
  for (const [key, entry] of hostTranscriptReadCache) {
    if (entry.isSettled && entry.expiresAt <= now) hostTranscriptReadCache.delete(key);
  }
}

function trimTranscriptCache(): void {
  while (transcriptReadCache.size > MAX_TRANSCRIPT_CACHE_ENTRIES) {
    const oldest = transcriptReadCache.keys().next().value;
    if (typeof oldest !== "string") return;
    transcriptReadCache.delete(oldest);
  }
}

function trimHostTranscriptCache(): void {
  while (hostTranscriptReadCache.size > MAX_TRANSCRIPT_CACHE_ENTRIES) {
    const oldest = hostTranscriptReadCache.keys().next().value;
    if (typeof oldest !== "string") return;
    hostTranscriptReadCache.delete(oldest);
  }
}

function transcriptReadError(): SummaryError {
  return new SummaryError("회의록을 읽을 수 없습니다.", "TRANSCRIPT_READ_FAILED", 502);
}
