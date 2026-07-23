// Meeting summary: reads the speaker-attributed utterance record of a live
// session from Supabase, asks Gemini for a structured recap (chapters,
// decisions, action items, speaker highlights), and upserts it into
// live_meeting_summaries keyed by (session_id, language).

import { LANGUAGE_LABELS } from "@/lib/languageDetect";
import { LiveSecurityConfigurationError } from "@/lib/security/config";
import { getSupabaseServerAccess, supabaseAdminHeaders } from "@/lib/security/supabase-server-access";

const DEFAULT_SUMMARY_MODEL = "gemini-flash-latest";
const MAX_SUMMARY_INPUT_CHARS = 120_000;

export interface MeetingUtterance {
  seq: number;
  speakerName: string | null;
  speakerLabel: string | null;
  text: string;
  emittedAt: string;
}

export interface MeetingSummary {
  title: string;
  overview: string;
  chapters: Array<{ title: string; summary: string }>;
  decisions: string[];
  actionItems: string[];
  speakerHighlights: Array<{ speaker: string; highlight: string }>;
}

export class SummaryError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, limit);
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
  const summary: MeetingSummary = {
    title: String(value.title ?? "").trim().slice(0, 200),
    overview: String(value.overview ?? "").trim().slice(0, 4_000),
    chapters,
    decisions: asStringArray(value.decisions, 20),
    actionItems: asStringArray(value.actionItems, 20),
    speakerHighlights,
  };
  if (!summary.title || !summary.overview) {
    throw new SummaryError("요약 응답이 올바르지 않습니다.", "SUMMARY_PARSE_FAILED", 502);
  }
  return summary;
}

export async function fetchUtterances(sessionId: string, language: string, fetchFn: typeof fetch = fetch): Promise<MeetingUtterance[]> {
  const access = getSupabaseServerAccess();
  const query = new URLSearchParams({
    session_id: `eq.${sessionId}`,
    language: `eq.${language}`,
    select: "seq,speaker_name,speaker_label,text,emitted_at",
    order: "seq.asc",
    limit: "5000",
  });
  const response = await fetchFn(`${access.url}/rest/v1/live_utterances?${query}`, {
    cache: "no-store",
    headers: supabaseAdminHeaders(access.credential),
  });
  if (!response.ok) throw new SummaryError("발언 기록을 읽을 수 없습니다.", "UTTERANCES_READ_FAILED", 502);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new SummaryError("발언 기록을 읽을 수 없습니다.", "UTTERANCES_READ_FAILED", 502);
  return rows.filter(isRecord).map((row) => ({
    seq: Number(row.seq),
    speakerName: typeof row.speaker_name === "string" ? row.speaker_name : null,
    speakerLabel: typeof row.speaker_label === "string" ? row.speaker_label : null,
    text: String(row.text ?? ""),
    emittedAt: String(row.emitted_at ?? ""),
  })).filter((row) => Number.isSafeInteger(row.seq) && row.text.trim().length > 0);
}

export function buildSummaryPrompt(utterances: MeetingUtterance[], language: string): string {
  const languageLabel = LANGUAGE_LABELS[language] ?? language;
  let transcript = "";
  for (const utterance of utterances) {
    const speaker = utterance.speakerName ?? utterance.speakerLabel ?? "발표자";
    const line = `[${utterance.emittedAt}] ${speaker}: ${utterance.text}\n`;
    if (transcript.length + line.length > MAX_SUMMARY_INPUT_CHARS) break;
    transcript += line;
  }
  return [
    `You are a professional meeting recap writer. Summarize the meeting transcript below in ${languageLabel}.`,
    "Return ONLY a JSON object with this exact shape:",
    `{"title": string, "overview": string, "chapters": [{"title": string, "summary": string}], "decisions": [string], "actionItems": [string], "speakerHighlights": [{"speaker": string, "highlight": string}]}`,
    "- title: one-line meeting title.",
    "- overview: 3-5 sentence recap.",
    "- chapters: 2-8 chronological sections (like earnings-call chapters).",
    "- decisions: concrete decisions made (empty array if none).",
    "- actionItems: follow-ups with owners when stated (empty array if none).",
    "- speakerHighlights: one key point per named speaker.",
    "Keep every value in the target language. Do not invent facts.",
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

export async function generateMeetingSummary(
  utterances: MeetingUtterance[],
  language: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ summary: MeetingSummary; model: string }> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new LiveSecurityConfigurationError("GEMINI_API_KEY가 설정되지 않았습니다.");
  const model = process.env.GEMINI_SUMMARY_MODEL?.trim() || DEFAULT_SUMMARY_MODEL;
  const response = await fetchFn(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildSummaryPrompt(utterances, language) }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    },
  );
  if (!response.ok) throw new SummaryError("요약 생성에 실패했습니다.", "SUMMARY_GENERATION_FAILED", 502);
  const payload: unknown = await response.json();
  const text = isRecord(payload)
    && Array.isArray((payload as { candidates?: unknown }).candidates)
    ? (() => {
      const candidate: unknown = (payload as { candidates: unknown[] }).candidates[0];
      if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) return "";
      const part: unknown = candidate.content.parts[0];
      return isRecord(part) && typeof part.text === "string" ? part.text : "";
    })()
    : "";
  if (!text) throw new SummaryError("요약 생성에 실패했습니다.", "SUMMARY_GENERATION_FAILED", 502);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SummaryError("요약 응답이 올바르지 않습니다.", "SUMMARY_PARSE_FAILED", 502);
  }
  return { summary: parseMeetingSummary(parsed), model };
}

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
