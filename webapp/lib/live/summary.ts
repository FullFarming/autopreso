// Meeting summary: live translation remains on the configured Gemini pipeline.
// Only the post-meeting record uses the OpenAI Responses API with a strict
// schema so stored recaps have one stable contract.

import { LANGUAGE_LABELS } from "../languageDetect";
import { getSupabaseServerAccess, supabaseAdminHeaders } from "../security/supabase-server-access";

import { getMeetingSummaryConfig, type MeetingSummaryConfig } from "./config";

const MAX_SUMMARY_INPUT_CHARS = 120_000;
const UTTERANCE_PAGE_SIZE = 1_000;

export interface MeetingUtterance {
  seq: number;
  participantId: string | null;
  speakerName: string | null;
  speakerLabel: string | null;
  speakerDepartment: string | null;
  speakerJobTitle: string | null;
  text: string;
  sourceStartedAt: string | null;
  sourceEndedAt: string;
  emittedAt: string;
}

export interface MeetingActionItem {
  description: string;
  owner: string;
  due: string;
}

export interface MeetingSummary {
  title: string;
  overview: string;
  chapters: Array<{ title: string; summary: string }>;
  decisions: string[];
  actionItems: MeetingActionItem[];
  speakerHighlights: Array<{ speaker: string; highlight: string }>;
  participationStats: Array<{
    speaker: string;
    department: string;
    jobTitle: string;
    utteranceCount: number;
    speakingSeconds: number;
  }>;
}

export class SummaryError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 1_000))
    .slice(0, limit);
}

const UNKNOWN_ACTION_FIELD = "미정";

/** Accepts the strict object shape and legacy stored string entries. */
function asActionItems(value: unknown, limit: number): MeetingActionItem[] {
  if (!Array.isArray(value)) return [];
  const items: MeetingActionItem[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const description = entry.trim().slice(0, 1_000);
      if (description) items.push({ description, owner: UNKNOWN_ACTION_FIELD, due: UNKNOWN_ACTION_FIELD });
      continue;
    }
    if (!isRecord(entry)) continue;
    const description = String(entry.description ?? "").trim().slice(0, 1_000);
    if (!description) continue;
    items.push({
      description,
      owner: String(entry.owner ?? "").trim().slice(0, 200) || UNKNOWN_ACTION_FIELD,
      due: String(entry.due ?? "").trim().slice(0, 200) || UNKNOWN_ACTION_FIELD,
    });
  }
  return items.slice(0, limit);
}

export function parseMeetingSummary(value: unknown): MeetingSummary {
  if (!isRecord(value)) throw new SummaryError("요약 응답이 올바르지 않습니다.", "SUMMARY_PARSE_FAILED", 502);
  const chapters = Array.isArray(value.chapters)
    ? value.chapters.filter(isRecord)
      .map((chapter) => ({ title: String(chapter.title ?? "").trim(), summary: String(chapter.summary ?? "").trim() }))
      .filter((chapter) => chapter.title && chapter.summary)
      .slice(0, 12)
    : [];
  const speakerHighlights = Array.isArray(value.speakerHighlights)
    ? value.speakerHighlights.filter(isRecord)
      .map((entry) => ({ speaker: String(entry.speaker ?? "").trim(), highlight: String(entry.highlight ?? "").trim() }))
      .filter((entry) => entry.speaker && entry.highlight)
      .slice(0, 12)
    : [];
  const participationStats = Array.isArray(value.participationStats)
    ? value.participationStats.filter(isRecord)
      .map((entry) => ({
        speaker: String(entry.speaker ?? "").trim().slice(0, 80),
        department: String(entry.department ?? "").trim().slice(0, 80),
        jobTitle: String(entry.jobTitle ?? "").trim().slice(0, 80),
        utteranceCount: Number(entry.utteranceCount),
        speakingSeconds: Number(entry.speakingSeconds),
      }))
      .filter((entry) => entry.speaker
        && Number.isSafeInteger(entry.utteranceCount)
        && entry.utteranceCount >= 0
        && Number.isFinite(entry.speakingSeconds)
        && entry.speakingSeconds >= 0)
      .slice(0, 50)
    : [];
  const summary: MeetingSummary = {
    title: String(value.title ?? "").trim().slice(0, 200),
    overview: String(value.overview ?? "").trim().slice(0, 4_000),
    chapters,
    decisions: asStringArray(value.decisions, 20),
    actionItems: asActionItems(value.actionItems, 20),
    speakerHighlights,
    participationStats,
  };
  if (!summary.title || !summary.overview) {
    throw new SummaryError("요약 응답이 올바르지 않습니다.", "SUMMARY_PARSE_FAILED", 502);
  }
  return summary;
}

export async function fetchUtterances(sessionId: string, language: string, fetchFn: typeof fetch = fetch): Promise<MeetingUtterance[]> {
  const access = getSupabaseServerAccess();
  const utterances: MeetingUtterance[] = [];
  let afterSeq: number | null = null;
  while (true) {
    const query = new URLSearchParams({
      session_id: `eq.${sessionId}`,
      language: `eq.${language}`,
      select: "seq,participant_id,speaker_name,speaker_label,text,source_started_at,source_ended_at,emitted_at",
      order: "seq.asc",
      limit: String(UTTERANCE_PAGE_SIZE),
    });
    if (afterSeq !== null) query.set("seq", `gt.${afterSeq}`);
    let response: Response;
    try {
      response = await fetchFn(`${access.url}/rest/v1/live_utterances?${query}`, {
        cache: "no-store",
        headers: supabaseAdminHeaders(access.credential),
      });
    } catch {
      throw utteranceReadError();
    }
    if (!response.ok) throw utteranceReadError();
    let page: unknown;
    try {
      page = await response.json();
    } catch {
      throw utteranceReadError();
    }
    if (!Array.isArray(page) || page.length > UTTERANCE_PAGE_SIZE) throw utteranceReadError();
    for (const value of page) {
      if (!isRecord(value)) throw utteranceReadError();
      const utterance = parseUtteranceRow(value);
      if (!utterance || (afterSeq !== null && utterance.seq <= afterSeq)) throw utteranceReadError();
      utterances.push(utterance);
      afterSeq = utterance.seq;
    }
    if (page.length < UTTERANCE_PAGE_SIZE) return utterances;
  }
}

function parseUtteranceRow(row: Record<string, unknown>): MeetingUtterance | null {
  const seq = Number(row.seq);
  const text = String(row.text ?? "");
  if (!Number.isSafeInteger(seq) || seq < 0 || text.trim().length === 0) return null;
  return {
    seq,
    participantId: typeof row.participant_id === "string"
      ? row.participant_id
      : participantIdFromSpeakerLabel(row.speaker_label),
    speakerName: typeof row.speaker_name === "string" ? row.speaker_name : null,
    speakerLabel: typeof row.speaker_label === "string" ? row.speaker_label : null,
    speakerDepartment: null,
    speakerJobTitle: null,
    text,
    sourceStartedAt: typeof row.source_started_at === "string" ? row.source_started_at : null,
    sourceEndedAt: String(row.source_ended_at ?? ""),
    emittedAt: String(row.emitted_at ?? ""),
  };
}

function utteranceReadError(): SummaryError {
  return new SummaryError("발언 기록을 읽을 수 없습니다.", "UTTERANCES_READ_FAILED", 502);
}

function participantIdFromSpeakerLabel(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("participant:")) return null;
  const participantId = value.slice("participant:".length);
  return participantId.length > 0 ? participantId : null;
}

export function buildSummaryPrompt(utterances: MeetingUtterance[], language: string): string {
  const languageLabel = LANGUAGE_LABELS[language] ?? language;
  let transcript = "";
  for (const utterance of utterances) {
    const speaker = utterance.speakerName ?? utterance.speakerLabel ?? "발표자";
    const identity = [speaker, utterance.speakerDepartment, utterance.speakerJobTitle].filter(Boolean).join(" · ");
    const line = `[${utterance.emittedAt}] ${identity}: ${utterance.text}\n`;
    if (transcript.length + line.length > MAX_SUMMARY_INPUT_CHARS) break;
    transcript += line;
  }
  return [
    `You are a professional meeting recap writer. Summarize the meeting transcript below in ${languageLabel}.`,
    "- title: one-line meeting title.",
    "- overview: 3-5 sentence recap.",
    "- chapters: 2-8 chronological sections (like earnings-call chapters).",
    "- decisions: concrete decisions made (empty array if none).",
    "- actionItems: follow-up objects with description, owner, due (empty array if none). Use \"미정\" for owner or due when the transcript does not state them.",
    "- speakerHighlights: one key point per named speaker.",
    "- participationStats: speaker-level counts and speaking duration from the supplied transcript metadata.",
    "Keep every value in the target language. Do not invent facts.",
    "Return empty arrays when the transcript does not establish an item.",
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

export async function generateMeetingSummary(
  utterances: MeetingUtterance[],
  language: string,
  fetchFn: typeof fetch = fetch,
  config: MeetingSummaryConfig = getMeetingSummaryConfig(),
): Promise<{ summary: MeetingSummary; model: string }> {
  const response = await fetchFn(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        store: false,
        reasoning: { effort: "none" },
        instructions: "Produce a grounded meeting record. Follow the supplied JSON schema exactly.",
        input: buildSummaryPrompt(utterances, language),
        text: {
          format: {
            type: "json_schema",
            name: "realtime_noel_meeting_minutes",
            strict: true,
            schema: MEETING_SUMMARY_JSON_SCHEMA,
          },
        },
      }),
    },
  );
  if (!response.ok) throw new SummaryError("요약 생성에 실패했습니다.", "SUMMARY_GENERATION_FAILED", 502);
  const payload: unknown = await response.json();
  const text = extractResponsesOutputText(payload);
  if (!text) throw new SummaryError("요약 생성에 실패했습니다.", "SUMMARY_GENERATION_FAILED", 502);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SummaryError("요약 응답이 올바르지 않습니다.", "SUMMARY_PARSE_FAILED", 502);
  }
  const summary = parseMeetingSummary(parsed);
  return {
    summary: {
      ...summary,
      participationStats: deriveParticipationStats(utterances),
    },
    model: config.model,
  };
}

export function deriveParticipationStats(
  utterances: MeetingUtterance[],
): MeetingSummary["participationStats"] {
  const statistics = new Map<string, MeetingSummary["participationStats"][number]>();
  for (const utterance of utterances) {
    const speaker = utterance.speakerName ?? utterance.speakerLabel ?? "Speaker";
    const key = utterance.participantId ?? speaker;
    const current = statistics.get(key) ?? {
      speaker,
      department: utterance.speakerDepartment ?? "",
      jobTitle: utterance.speakerJobTitle ?? "",
      utteranceCount: 0,
      speakingSeconds: 0,
    };
    current.utteranceCount += 1;
    current.speakingSeconds += utteranceDurationSeconds(utterance);
    statistics.set(key, current);
  }
  return [...statistics.values()].map((statistic) => ({
    ...statistic,
    speakingSeconds: Math.round(statistic.speakingSeconds * 10) / 10,
  })).slice(0, 50);
}

function utteranceDurationSeconds(utterance: MeetingUtterance): number {
  if (!utterance.sourceStartedAt) return 0;
  const duration = (Date.parse(utterance.sourceEndedAt) - Date.parse(utterance.sourceStartedAt)) / 1_000;
  return Number.isFinite(duration) && duration >= 0 && duration <= 60 * 60 ? duration : 0;
}

function extractResponsesOutputText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.output)) return "";
  for (const output of payload.output) {
    if (!isRecord(output) || output.type !== "message" || !Array.isArray(output.content)) continue;
    for (const content of output.content) {
      if (!isRecord(content)) continue;
      if (content.type === "refusal") {
        throw new SummaryError("요약 요청이 거절되었습니다.", "SUMMARY_REFUSED", 422);
      }
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

const STRING_ARRAY_SCHEMA = {
  type: "array",
  items: { type: "string" },
} as const;

const MEETING_SUMMARY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "overview",
    "chapters",
    "decisions",
    "actionItems",
    "speakerHighlights",
    "participationStats",
  ],
  properties: {
    title: { type: "string" },
    overview: { type: "string" },
    chapters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "summary"],
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
    decisions: STRING_ARRAY_SCHEMA,
    actionItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "owner", "due"],
        properties: {
          description: { type: "string" },
          owner: { type: "string" },
          due: { type: "string" },
        },
      },
    },
    speakerHighlights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["speaker", "highlight"],
        properties: {
          speaker: { type: "string" },
          highlight: { type: "string" },
        },
      },
    },
    participationStats: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["speaker", "department", "jobTitle", "utteranceCount", "speakingSeconds"],
        properties: {
          speaker: { type: "string" },
          department: { type: "string" },
          jobTitle: { type: "string" },
          utteranceCount: { type: "integer", minimum: 0 },
          speakingSeconds: { type: "number", minimum: 0 },
        },
      },
    },
  },
} as const;

export async function upsertMeetingSummary(
  sessionId: string,
  language: string,
  summary: MeetingSummary,
  model: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const access = getSupabaseServerAccess();
  const response = await fetchFn(
    `${access.url}/rest/v1/live_meeting_summaries?on_conflict=session_id,language`,
    {
      method: "POST",
      headers: {
        ...supabaseAdminHeaders(access.credential),
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        session_id: sessionId,
        language,
        summary,
        model,
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!response.ok) throw new SummaryError("요약을 저장할 수 없습니다.", "SUMMARY_SAVE_FAILED", 502);
}

export async function readMeetingSummary(
  sessionId: string,
  language: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ summary: MeetingSummary; model: string | null; createdAt: string } | null> {
  const access = getSupabaseServerAccess();
  const query = new URLSearchParams({
    session_id: `eq.${sessionId}`,
    language: `eq.${language}`,
    select: "summary,model,created_at",
    limit: "1",
  });
  const response = await fetchFn(`${access.url}/rest/v1/live_meeting_summaries?${query}`, {
    cache: "no-store",
    headers: supabaseAdminHeaders(access.credential),
  });
  if (!response.ok) throw new SummaryError("요약을 읽을 수 없습니다.", "SUMMARY_READ_FAILED", 502);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows) || rows.length === 0 || !isRecord(rows[0])) return null;
  const row = rows[0];
  return {
    summary: parseMeetingSummary(row.summary),
    model: typeof row.model === "string" ? row.model : null,
    createdAt: String(row.created_at ?? ""),
  };
}
