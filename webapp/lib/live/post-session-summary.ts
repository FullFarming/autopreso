// Contract C7: after the host ends a Live Call, meeting summaries are
// generated automatically for every active session language. This runs
// best-effort in the background — it never blocks or fails the End response.

import { buildParticipantRoster } from "./activity";
import {
  SUMMARY_READ_TIMEOUT_MILLISECONDS,
  claimMeetingSummaryGeneration,
  completeMeetingSummaryGeneration,
  failMeetingSummaryGeneration,
  fetchMeetingSessionContext,
  fetchSummaryUtterances,
  fetchTopicTranscript,
  generateMeetingSummary,
  readMeetingSummary,
  SummaryError,
  type MeetingSessionContext,
  type MeetingSummary,
  type MeetingUtterance,
  withSummaryReadDeadline,
} from "./summary";
import type { LiveHostParticipantActivity, LiveTopicSnapshot } from "../live-contract";

export type SummaryLanguageOutcome =
  | { status: "saved"; summary: MeetingSummary; model: string; utteranceCount: number }
  | { status: "ready"; summary: MeetingSummary; model: string | null; utteranceCount: number }
  | { status: "running" | "failed" | "empty" };

export interface PostSessionSummaryDependencies {
  generateForLanguage: (sessionId: string, hostId: string, language: string) => Promise<SummaryLanguageOutcome>;
  languageDependencies: Partial<SummaryLanguageGenerationDependencies>;
  log: (message: string, error?: unknown) => void;
}

export interface SummaryLanguageGenerationDependencies {
  claim: typeof claimMeetingSummaryGeneration;
  complete: typeof completeMeetingSummaryGeneration;
  fail: typeof failMeetingSummaryGeneration;
  fetchUtterances: (sessionId: string, language: string, options?: { signal?: AbortSignal }) => Promise<MeetingUtterance[]>;
  fetchTopicTranscript: (sessionId: string, language: string, options?: { signal?: AbortSignal }) => Promise<LiveTopicSnapshot>;
  fetchSessionContext: (sessionId: string, options?: { signal?: AbortSignal }) => Promise<MeetingSessionContext | null>;
  buildRoster: (sessionId: string, hostId: string, options?: { signal?: AbortSignal }) => Promise<LiveHostParticipantActivity[]>;
  generate: typeof generateMeetingSummary;
  read: typeof readMeetingSummary;
  readTimeoutMilliseconds: number;
}

const defaultLanguageDependencies: SummaryLanguageGenerationDependencies = {
  claim: claimMeetingSummaryGeneration,
  complete: completeMeetingSummaryGeneration,
  fail: failMeetingSummaryGeneration,
  fetchUtterances: (sessionId, language, options) => fetchSummaryUtterances(sessionId, language, fetch, options),
  fetchTopicTranscript: (sessionId, language, options) => fetchTopicTranscript(sessionId, language, options),
  fetchSessionContext: (sessionId, options) => fetchMeetingSessionContext(sessionId, options),
  buildRoster: (sessionId, hostId, options) => buildParticipantRoster(sessionId, hostId, fetch, undefined, options),
  generate: generateMeetingSummary,
  read: readMeetingSummary,
  readTimeoutMilliseconds: SUMMARY_READ_TIMEOUT_MILLISECONDS,
};
const SUMMARY_LANGUAGE_CONCURRENCY = 2;

export async function generateSummaryForLanguage(
  sessionId: string,
  hostId: string,
  language: string,
  dependencies: Partial<SummaryLanguageGenerationDependencies> = {},
): Promise<SummaryLanguageOutcome> {
  const deps: SummaryLanguageGenerationDependencies = { ...defaultLanguageDependencies, ...dependencies };
  const claim = await deps.claim(sessionId, language);
  if (claim.status === "ready") {
    const record = await withSummaryReadDeadline(
      (signal) => deps.read(sessionId, language, fetch, { signal }),
      deps.readTimeoutMilliseconds,
    );
    if (!record) throw new SummaryError("완료된 요약을 읽을 수 없습니다.", "SUMMARY_READY_MISSING", 502);
    return { status: "ready", summary: record.summary, model: record.model, utteranceCount: 0 };
  }
  if (claim.status === "running") return { status: "running" };
  if (claim.status === "exhausted" || claim.status === "permanent_failed") return { status: "failed" };
  if (claim.status !== "claimed") throw new SummaryError("요약 생성 상태가 올바르지 않습니다.", "SUMMARY_STATE_FAILED", 502);

  try {
    const [utterances, participants, topicSnapshot, sessionContext] = await withSummaryReadDeadline(
      (signal) => Promise.all([
        deps.fetchUtterances(sessionId, language, { signal }),
        deps.buildRoster(sessionId, hostId, { signal }),
        deps.fetchTopicTranscript(sessionId, language, { signal }),
        deps.fetchSessionContext(sessionId, { signal }),
      ]),
      deps.readTimeoutMilliseconds,
    );
    if (utterances.length === 0) {
      await deps.fail(sessionId, language, claim.generationToken, "NO_UTTERANCES");
      return { status: "empty" };
    }
    const participantById = new Map(participants.map((participant) => [participant.participantId, participant]));
    const attributed: MeetingUtterance[] = utterances.map((utterance) => {
      const participant = utterance.participantId ? participantById.get(utterance.participantId) : undefined;
      return participant
        ? {
            ...utterance,
            speakerName: participant.displayName,
            speakerDepartment: participant.department,
            speakerJobTitle: participant.jobTitle,
          }
        : utterance;
    });
    const generated = await deps.generate({ sessionId, utterances: attributed, topicSnapshot, sessionContext }, language);
    const { summary, model } = generated;
    const completed = await deps.complete(
      sessionId, language, claim.generationToken, summary, model,
    );
    if (!completed) throw new SummaryError("요약 완료 상태를 저장할 수 없습니다.", "SUMMARY_COMPLETE_FAILED", 502);
    return { status: "saved", summary, model, utteranceCount: utterances.length };
  } catch (error: unknown) {
    const errorCode = error instanceof SummaryError ? error.code : "SUMMARY_FAILED";
    await deps.fail(sessionId, language, claim.generationToken, errorCode).catch(() => false);
    throw error;
  }
}

const defaultDependencies: PostSessionSummaryDependencies = {
  generateForLanguage: generateSummaryForLanguage,
  languageDependencies: {},
  log: (message, error) => {
    const code = error instanceof SummaryError ? error.code : "SUMMARY_FAILED";
    console.error(`${message} ${code}`);
  },
};

/** Best-effort: languages are independent and each claim is attempted once. */
export async function generateSessionSummariesAfterEnd(
  sessionId: string,
  hostId: string,
  languages: readonly string[],
  dependencies: Partial<PostSessionSummaryDependencies> = {},
): Promise<{ saved: string[]; ready: string[]; running: string[]; empty: string[]; failed: string[] }> {
  const deps: PostSessionSummaryDependencies = { ...defaultDependencies, ...dependencies };
  const saved: string[] = [];
  const ready: string[] = [];
  const running: string[] = [];
  const empty: string[] = [];
  const failed: string[] = [];
  const uniqueLanguages = [...new Set(languages)];
  const sharedLanguageDependencies = createSharedLanguageDependencies(sessionId, uniqueLanguages, deps.languageDependencies);
  const generateForLanguage = dependencies.generateForLanguage
    ?? ((targetSessionId: string, targetHostId: string, language: string) => generateSummaryForLanguage(
      targetSessionId,
      targetHostId,
      language,
      sharedLanguageDependencies,
    ));
  const outcomes: Array<{ language: string; outcome: SummaryLanguageOutcome }> = [];
  let nextLanguageIndex = 0;
  const workerCount = Math.min(SUMMARY_LANGUAGE_CONCURRENCY, uniqueLanguages.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextLanguageIndex < uniqueLanguages.length) {
      const language = uniqueLanguages[nextLanguageIndex];
      nextLanguageIndex += 1;
      if (!language) continue;
      try {
        outcomes.push({ language, outcome: await generateForLanguage(sessionId, hostId, language) });
      } catch (error: unknown) {
        deps.log(`live post-session summary failed (${language})`, error);
        outcomes.push({ language, outcome: { status: "failed" as const } });
      }
    }
  }));
  for (const { language, outcome } of outcomes) {
    if (outcome.status === "saved") saved.push(language);
    else if (outcome.status === "ready") ready.push(language);
    else if (outcome.status === "running") running.push(language);
    else if (outcome.status === "empty") empty.push(language);
    else failed.push(language);
  }
  return { saved, ready, running, empty, failed };
}

function createSharedLanguageDependencies(
  sessionId: string,
  languages: readonly string[],
  overrides: Partial<SummaryLanguageGenerationDependencies>,
): Partial<SummaryLanguageGenerationDependencies> {
  const firstLanguage = languages[0] ?? "ko";
  const readTopicContext = overrides.fetchTopicTranscript ?? defaultLanguageDependencies.fetchTopicTranscript;
  let topicSnapshotPromise: Promise<LiveTopicSnapshot> | null = null;
  return {
    ...overrides,
    fetchTopicTranscript(targetSessionId, language, options) {
      if (targetSessionId !== sessionId) {
        return readTopicContext(targetSessionId, language, options);
      }
      topicSnapshotPromise ??= readTopicContext(targetSessionId, firstLanguage, options);
      return topicSnapshotPromise;
    },
  };
}
