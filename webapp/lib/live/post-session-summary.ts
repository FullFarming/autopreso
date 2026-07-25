// Contract C7: after the host ends a Live Call, meeting summaries are
// generated automatically for every active session language. This runs
// best-effort in the background — it never blocks or fails the End response.

import { buildParticipantActivity } from "./activity";
import {
  fetchUtterances,
  generateMeetingSummary,
  upsertMeetingSummary,
  type MeetingUtterance,
} from "./summary";

export interface PostSessionSummaryDependencies {
  generateForLanguage: (sessionId: string, hostId: string, language: string) => Promise<"saved" | "empty">;
  log: (message: string, error?: unknown) => void;
  retryDelayMs: number;
  sleep: (milliseconds: number) => Promise<void>;
}

async function generateForLanguageDefault(
  sessionId: string,
  hostId: string,
  language: string,
): Promise<"saved" | "empty"> {
  const [utterances, activity] = await Promise.all([
    fetchUtterances(sessionId, language),
    buildParticipantActivity(sessionId, hostId, language),
  ]);
  if (utterances.length === 0) return "empty";
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
  const { summary, model } = await generateMeetingSummary(attributed, language);
  await upsertMeetingSummary(sessionId, language, summary, model);
  return "saved";
}

const defaultDependencies: PostSessionSummaryDependencies = {
  generateForLanguage: generateForLanguageDefault,
  log: (message, error) => console.error(message, error),
  retryDelayMs: 2_000,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/** Best-effort: one retry per language, failures are logged and swallowed. */
export async function generateSessionSummariesAfterEnd(
  sessionId: string,
  hostId: string,
  languages: readonly string[],
  dependencies: Partial<PostSessionSummaryDependencies> = {},
): Promise<{ saved: string[]; empty: string[]; failed: string[] }> {
  const deps: PostSessionSummaryDependencies = { ...defaultDependencies, ...dependencies };
  const saved: string[] = [];
  const empty: string[] = [];
  const failed: string[] = [];
  for (const language of languages) {
    let outcome: "saved" | "empty" | null = null;
    for (let attempt = 0; attempt < 2 && outcome === null; attempt += 1) {
      try {
        outcome = await deps.generateForLanguage(sessionId, hostId, language);
      } catch (error: unknown) {
        deps.log(`live post-session summary failed (${sessionId}, ${language}, attempt ${attempt + 1})`, error);
        if (attempt === 0) await deps.sleep(deps.retryDelayMs);
      }
    }
    if (outcome === "saved") saved.push(language);
    else if (outcome === "empty") empty.push(language);
    else failed.push(language);
  }
  return { saved, empty, failed };
}
