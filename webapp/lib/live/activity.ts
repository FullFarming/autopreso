import type { LiveHostParticipantActivity, LiveSpeechActivity } from "../live-contract";
import { canonicalizeParticipantEmail, maskParticipantEmail } from "../security/participant-identity";
import { supabaseAdminHeaders } from "../security/supabase-server-access";
import { getLiveStoreConfig, type LiveStoreConfig } from "./config";
import { SummaryError } from "./summary";

/** recentSpeeches만 만들면 되므로 최신 100행만 내려받는다 — 이전의
 *  seq.asc + 5,000행은 5초 폴링마다 50배를 읽고도 "최근"이 아니었다. */
const RECENT_SPEECH_LIMIT = 100;

interface ParticipantRow {
  participantId: string;
  displayName: string;
  email: string | null;
  company: string | null;
  summaryConsentAt: string | null;
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
  participants: LiveHostParticipantActivity[];
  recentSpeeches: LiveSpeechActivity[];
}

interface ParticipantReadOptions {
  signal?: AbortSignal;
}

export async function buildParticipantRoster(
  sessionId: string,
  hostId: string,
  fetchFn: typeof fetch = fetch,
  config: LiveStoreConfig = getLiveStoreConfig(),
  options: ParticipantReadOptions = {},
): Promise<LiveHostParticipantActivity[]> {
  const headers = supabaseAdminHeaders(config.credential);
  const participantResponse = await fetchFn(`${config.baseUrl}/rest/v1/rpc/read_live_participant_roster`, {
    method: "POST",
    cache: "no-store",
    signal: options.signal,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ p_session_id: sessionId, p_host_id: hostId }),
  });
  if (!participantResponse.ok) {
    throw new SummaryError("참가자 활동을 읽을 수 없습니다.", "PARTICIPANT_ACTIVITY_READ_FAILED", 502);
  }
  const participantBody: unknown = await participantResponse.json();
  if (!Array.isArray(participantBody)) {
    throw new SummaryError("참가자 활동을 읽을 수 없습니다.", "PARTICIPANT_ACTIVITY_READ_FAILED", 502);
  }
  const participants = participantBody.map(parseParticipantRow).filter((row): row is ParticipantRow => row !== null);
  return participants.map(publicParticipantActivity);
}

export async function buildParticipantActivity(
  sessionId: string,
  hostId: string,
  language: string,
  fetchFn: typeof fetch = fetch,
  config: LiveStoreConfig = getLiveStoreConfig(),
  options: ParticipantReadOptions = {},
): Promise<ParticipantActivityResult> {
  const utteranceQuery = new URLSearchParams({
    session_id: `eq.${sessionId}`,
    language: `eq.${language}`,
    select: "seq,participant_id,speaker_label,speaker_name,text,source_started_at,source_ended_at,emitted_at",
    order: "seq.desc",
    limit: String(RECENT_SPEECH_LIMIT),
  });
  const headers = supabaseAdminHeaders(config.credential);
  const [participantResponse, utteranceResponse] = await Promise.all([
    fetchFn(`${config.baseUrl}/rest/v1/rpc/read_live_participant_roster`, {
      method: "POST",
      cache: "no-store",
      signal: options.signal,
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ p_session_id: sessionId, p_host_id: hostId }),
    }),
    fetchFn(`${config.baseUrl}/rest/v1/live_utterances?${utteranceQuery}`, {
      cache: "no-store",
      signal: options.signal,
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
  const utterances = utteranceBody.map(parseUtteranceRow).filter((row): row is UtteranceRow => row !== null)
    .reverse(); // seq.desc로 받아 화면용 오름차순으로 복원
  const participantById = new Map(participants.map((participant) => [participant.participantId, participant]));
  return {
    participants: participants.map(publicParticipantActivity),
    recentSpeeches: utterances.map((utterance) => {
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

function publicParticipantActivity(participant: ParticipantRow): LiveHostParticipantActivity {
  return {
    participantId: participant.participantId,
    displayName: participant.displayName,
    email: participant.email,
    company: participant.company,
    summaryConsentAt: participant.summaryConsentAt,
    department: participant.department,
    jobTitle: participant.jobTitle,
    joinedAt: participant.joinedAt,
    lastSeenAt: participant.lastSeenAt,
    isPresent: participant.leftAt === null,
    utteranceCount: participant.utteranceCount,
    speakingSeconds: Math.round(participant.speakingSeconds * 10) / 10,
    lastSpokeAt: participant.lastSpokeAt,
  };
}

function parseParticipantRow(value: unknown): ParticipantRow | null {
  if (!isRecord(value)) return null;
  const participantId = asBoundedString(value.participant_id, 128);
  const displayName = asBoundedString(value.display_name, 40);
  const email = asNullableCanonicalEmail(value.email);
  const company = asNullableBoundedString(value.company, 100);
  const summaryConsentAt = value.summary_consent_at === null ? null : asTimestamp(value.summary_consent_at);
  const department = asOptionalBoundedString(value.department, 80);
  const jobTitle = asOptionalBoundedString(value.job_title, 100);
  const joinedAt = asTimestamp(value.joined_at);
  const lastSeenAt = asTimestamp(value.last_seen_at);
  const leftAt = value.left_at === null ? null : asTimestamp(value.left_at);
  const utteranceCount = Number(value.utterance_count);
  const speakingSeconds = Number(value.speaking_seconds);
  const lastSpokeAt = value.last_spoke_at === null ? null : asTimestamp(value.last_spoke_at);
  if (!participantId || !displayName || email === undefined || company === undefined
    || summaryConsentAt === undefined || department === null || jobTitle === null
    || !joinedAt || !lastSeenAt || value.left_at !== null && !leftAt) {
    return null;
  }
  if (email !== null && maskParticipantEmail(email) !== displayName) return null;
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
    email,
    company,
    summaryConsentAt,
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

function asOptionalBoundedString(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  return Array.from(normalized).length <= maxLength ? normalized : null;
}

function asNullableBoundedString(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFC").trim();
  return normalized.length >= 1 && Array.from(normalized).length <= maxLength ? normalized : undefined;
}

function asNullableCanonicalEmail(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  try {
    const canonical = canonicalizeParticipantEmail(value);
    return canonical === value ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function asTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
