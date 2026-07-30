// Contract C7: after the host ends a Live Call, meeting summaries are
// generated automatically for every active session language. This runs
// best-effort in the background — it never blocks or fails the End response.

import { buildParticipantActivity } from "./activity";
import {
  claimMeetingSummaryGeneration,
  completeMeetingSummaryGeneration,
  failMeetingSummaryGeneration,
  fetchUtterances,
  generateMeetingSummary,
  readMeetingSummary,
  SummaryError,
  type MeetingSummary,
  type MeetingUtterance,
} from "./summary";

export type SummaryLanguageOutcome =
  | { status: "saved"; summary: MeetingSummary; model: string; utteranceCount: number }
  | { status: "ready"; summary: MeetingSummary; model: string | null; utteranceCount: number }
  | { status: "running" | "failed" | "empty" };

export interface PostSessionSummaryDependencies {
  generateForLanguage: (sessionId: string, hostId: string, language: string) => Promise<SummaryLanguageOutcome>;
  log: (message: string, error?: unknown) => void;
}

export interface SummaryLanguageGenerationDependencies {
  claim: typeof claimMeetingSummaryGeneration;
  complete: typeof completeMeetingSummaryGeneration;
  fail: typeof failMeetingSummaryGeneration;
  fetchUtterances: typeof fetchUtterances;
  buildActivity: typeof buildParticipantActivity;
  generate: typeof generateMeetingSummary;
  read: typeof readMeetingSummary;
  sleep: (milliseconds: number) => Promise<void>;
  retryDelayMs: number;
}

const defaultLanguageDependencies: SummaryLanguageGenerationDependencies = {
  claim: claimMeetingSummaryGeneration,
  complete: completeMeetingSummaryGeneration,
  fail: failMeetingSummaryGeneration,
  fetchUtterances,
  buildActivity: buildParticipantActivity,
  generate: generateMeetingSummary,
  read: readMeetingSummary,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  retryDelayMs: 1_000,
};

const RETRYABLE_SUMMARY_CODES = new Set([
  "SUMMARY_PROVIDER_RATE_LIMITED",
  "SUMMARY_PROVIDER_UNAVAILABLE",
  "SUMMARY_TIMEOUT",
]);

function isRetryableSummaryError(error: unknown): boolean {
  return error instanceof SummaryError && RETRYABLE_SUMMARY_CODES.has(error.code);
}

export async function generateSummaryForLanguage(
  sessionId: string,
  hostId: string,
  language: string,
  dependencies: Partial<SummaryLanguageGenerationDependencies> = {},
): Promise<SummaryLanguageOutcome> {
  const deps: SummaryLanguageGenerationDependencies = { ...defaultLanguageDependencies, ...dependencies };
  const claim = await deps.claim(sessionId, language);
  if (claim.status === "ready") {
    const record = await deps.read(sessionId, language);
    if (!record) throw new SummaryError("완료된 요약을 읽을 수 없습니다.", "SUMMARY_READY_MISSING", 502);
    return { status: "ready", summary: record.summary, model: record.model, utteranceCount: 0 };
  }
  if (claim.status === "running") return { status: "running" };
  if (claim.status === "exhausted" || claim.status === "permanent_failed") return { status: "failed" };
  if (claim.status !== "claimed") throw new SummaryError("요약 생성 상태가 올바르지 않습니다.", "SUMMARY_STATE_FAILED", 502);

  try {
    const [utterances, activity] = await Promise.all([
      deps.fetchUtterances(sessionId, language),
      deps.buildActivity(sessionId, hostId, language),
    ]);
    if (utterances.length === 0) {
      await deps.fail(sessionId, language, claim.generationToken, "NO_UTTERANCES");
      return { status: "empty" };
    }
    const participantById = new Map(activity.participants.map((participant) => [participant.participantId, participant]));
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
    let generated: Awaited<ReturnType<typeof generateMeetingSummary>>;
    try {
      generated = await deps.generate(attributed, language);
    } catch (error: unknown) {
      if (!isRetryableSummaryError(error)) throw error;
      await deps.sleep(deps.retryDelayMs);
      generated = await deps.generate(attributed, language);
    }
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
  log: (message, error) => console.error(message, error),
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
  const outcomes = await Promise.all([...new Set(languages)].map(async (language) => {
    try {
      return { language, outcome: await deps.generateForLanguage(sessionId, hostId, language) };
    } catch (error: unknown) {
      deps.log(`live post-session summary failed (${sessionId}, ${language})`, error);
      return { language, outcome: { status: "failed" as const } };
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
