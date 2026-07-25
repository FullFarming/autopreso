import type { LiveParticipantActivity, LiveSpeechActivity } from "../live-contract";
import { supabaseAdminHeaders } from "../security/supabase-server-access";
import { getLiveStoreConfig, type LiveStoreConfig } from "./config";
import { SummaryError } from "./summary";

const MAX_UTTERANCES = 5_000;

interface ParticipantRow {
  participantId: string;
  displayName: string;
  department: string;
  jobTitle: string;
  joinedAt: string;
  lastSeenAt: string;
  leftAt: string | null;
  utteranceCount: number;
  speakingSeconds: number;
  lastSpokeAt: string | null;
}

interface UtteranceRow {
  seq: number;
  participantId: string | null;
  speakerName: string;
  text: string;
  startedAt: string | null;
  endedAt: string;
  emittedAt: string;
}

export interface ParticipantActivityResult {
  participants: LiveParticipantActivity[];
  recentSpeeches: LiveSpeechActivity[];
}

export async function buildParticipantActivity(
  sessionId: string,
  hostId: string,
  language: string,
  fetchFn: typeof fetch = fetch,
  config: LiveStoreConfig = getLiveStoreConfig(),
): Promise<ParticipantActivityResult> {
  const utteranceQuery = new URLSearchParams({
    session_id: `eq.${sessionId}`,
    language: `eq.${language}`,
    select: "seq,participant_id,speaker_label,speaker_name,text,source_started_at,source_ended_at,emitted_at",
    order: "seq.asc",
    limit: String(MAX_UTTERANCES),
  });
  const headers = supabaseAdminHeaders(config.credential);
  const [participantResponse, utteranceResponse] = await Promise.all([
    fetchFn(`${config.baseUrl}/rest/v1/rpc/read_live_participant_roster`, {
      method: "POST",
      cache: "no-store",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ p_session_id: sessionId, p_host_id: hostId }),
    }),
    fetchFn(`${config.baseUrl}/rest/v1/live_utterances?${utteranceQuery}`, {
      cache: "no-store",
      headers,
    }),
  ]);
  if (!participantResponse.ok || !utteranceResponse.ok) {
    throw new SummaryError("참가자 활동을 읽을 수 없습니다.", "PARTICIPANT_ACTIVITY_READ_FAILED", 502);
  }
  const participantBody: unknown = await participantResponse.json();
  const utteranceBody: unknown = await utteranceResponse.json();
  if (!Array.isArray(participantBody) || !Array.isArray(utteranceBody)) {
    throw new SummaryError("참가자 활동을 읽을 수 없습니다.", "PARTICIPANT_ACTIVITY_READ_FAILED", 502);
  }
  const participants = participantBody.map(parseParticipantRow).filter((row): row is ParticipantRow => row !== null);
  const utterances = utteranceBody.map(parseUtteranceRow).filter((row): row is UtteranceRow => row !== null);
  const participantById = new Map(participants.map((participant) => [participant.participantId, participant]));
  return {
    participants: participants.map((participant) => ({
      participantId: participant.participantId,
      displayName: participant.displayName,
      department: participant.department,
      jobTitle: participant.jobTitle,
      joinedAt: participant.joinedAt,
      lastSeenAt: participant.lastSeenAt,
      isPresent: participant.leftAt === null,
      utteranceCount: participant.utteranceCount,
      speakingSeconds: Math.round(participant.speakingSeconds * 10) / 10,
      lastSpokeAt: participant.lastSpokeAt,
    })),
    recentSpeeches: utterances.slice(-100).map((utterance) => {
      const participant = utterance.participantId ? participantById.get(utterance.participantId) : undefined;
      return {
        seq: utterance.seq,
        participantId: utterance.participantId,
        displayName: participant?.displayName ?? utterance.speakerName,
        department: participant?.department ?? "",
        jobTitle: participant?.jobTitle ?? "",
        text: utterance.text,
        startedAt: utterance.startedAt,
        endedAt: utterance.endedAt,
      };
    }),
  };
}

function parseParticipantRow(value: unknown): ParticipantRow | null {
  if (!isRecord(value)) return null;
  const participantId = asBoundedString(value.participant_id, 128);
  const displayName = asBoundedString(value.display_name, 40);
  const department = asBoundedString(value.department, 80);
  const jobTitle = asBoundedString(value.job_title, 80);
  const joinedAt = asTimestamp(value.joined_at);
  const lastSeenAt = asTimestamp(value.last_seen_at);
  const leftAt = value.left_at === null ? null : asTimestamp(value.left_at);
  const utteranceCount = Number(value.utterance_count);
  const speakingSeconds = Number(value.speaking_seconds);
  const lastSpokeAt = value.last_spoke_at === null ? null : asTimestamp(value.last_spoke_at);
  if (!participantId || !displayName || !department || !jobTitle || !joinedAt || !lastSeenAt || value.left_at !== null && !leftAt) {
    return null;
  }
  if (!Number.isSafeInteger(utteranceCount)
    || utteranceCount < 0
    || !Number.isFinite(speakingSeconds)
    || speakingSeconds < 0
    || value.last_spoke_at !== null && !lastSpokeAt) {
    return null;
  }
  return {
    participantId,
    displayName,
    department,
    jobTitle,
    joinedAt,
    lastSeenAt,
    leftAt,
    utteranceCount,
    speakingSeconds,
    lastSpokeAt,
  };
}

function parseUtteranceRow(value: unknown): UtteranceRow | null {
  if (!isRecord(value)) return null;
  const seq = Number(value.seq);
  const participantId = asBoundedString(value.participant_id, 128);
  const speakerName = asBoundedString(value.speaker_name, 80) ?? "Speaker";
  const text = asBoundedString(value.text, 20_000);
  const startedAt = value.source_started_at === null ? null : asTimestamp(value.source_started_at);
  const endedAt = asTimestamp(value.source_ended_at);
  const emittedAt = asTimestamp(value.emitted_at);
  if (!Number.isSafeInteger(seq) || seq < 0 || !text || !endedAt || !emittedAt) return null;
  return {
    seq,
    participantId,
    speakerName,
    text,
    startedAt,
    endedAt,
    emittedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  return normalized.length >= 1 && Array.from(normalized).length <= maxLength ? normalized : null;
}

function asTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
