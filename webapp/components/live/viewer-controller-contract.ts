import { hasValidTranslationCaptureProvenance } from "../../lib/live/translation-capture";
import type {
  ApiResponse,
  CaptionEvent,
  LiveAttendeeSelfProfile,
  LiveBroadcastEvent,
  LiveAgendaItem,
  LiveEventType,
  LiveOutputMode,
  LiveSessionSection,
  LiveSessionStatus,
  LiveSessionType,
  LiveSnapshot,
  RecordingStatusEvent,
  SpeakerAssignment,
} from "@/lib/live-contract";
import { parseLiveTopicUpsertEvent } from "../../lib/security/live-topic-validation";
import { languageObservationSchema, sourceEventSchema, sourceDraftEventSchema, sourceDraftClearEventSchema } from "../../lib/live/source-contract";

export interface ViewerJoinData {
  grant: { id: string; sessionId: string; userId: string; expiresAt: string };
  session: {
    id: string;
    title: string;
    scheduledAt: string | null;
    sessionType: LiveSessionType;
    outputMode: LiveOutputMode;
    maxViewers: number;
    languages: string[];
    expiresAt: string;
    endedAt?: string | null;
    status?: LiveSessionStatus;
    hasCoverImage?: boolean;
    coverImageVersion?: string | null;
    companyName?: string | null;
    ticker?: string | null;
    fiscalPeriod?: string | null;
    eventType?: LiveEventType | null;
    agenda?: LiveAgendaItem[];
    activeSection?: LiveSessionSection;
    sectionStartedAt?: string | null;
    /** Missing on legacy joins; the UI treats anything except true as denied. */
    participantSpeakingEnabled?: boolean;
  };
  self: LiveAttendeeSelfProfile;
  viewerCount: number;
}

export type ViewerState = Omit<ViewerJoinData, "grant" | "viewerCount"> & {
  grant?: ViewerJoinData["grant"];
  viewerCount?: number;
};
export type SettledRequest<T> = { ok: true; value: T } | { ok: false; error: unknown };

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSpeaker(value: unknown): value is SpeakerAssignment {
  return isRecord(value)
    && typeof value.speakerId === "string"
    && typeof value.label === "string"
    && typeof value.colorToken === "string"
    && (typeof value.voiceName === "string" || value.voiceName === null)
    && typeof value.lastSeenAt === "string"
    && (value.name === undefined || value.name === null || typeof value.name === "string")
    && (value.department === undefined || value.department === null || typeof value.department === "string")
    && (value.jobTitle === undefined || value.jobTitle === null || typeof value.jobTitle === "string")
    && (value.voiceStatus === undefined || value.voiceStatus === "disabled" || value.voiceStatus === "analyzing"
      || value.voiceStatus === "ready" || value.voiceStatus === "unavailable");
}

function isCaptionEvent(value: unknown): value is CaptionEvent {
  if (!isRecord(value)) return false;
  return value.type === "caption"
    && Number.isSafeInteger(value.seq)
    && Number(value.seq) >= 0
    && typeof value.sessionId === "string"
    && typeof value.language === "string"
    && (value.speaker === null || isSpeaker(value.speaker))
    && typeof value.text === "string"
    && typeof value.isFinal === "boolean"
    && (value.sourceText === undefined || value.sourceText === null || typeof value.sourceText === "string")
    && hasValidTranslationCaptureProvenance(value)
    && (value.sourceLanguage === undefined || value.sourceLanguage === null || typeof value.sourceLanguage === "string")
    && (value.languageObservation === undefined || languageObservationSchema.safeParse(value.languageObservation).success)
    && (value.translationStatus === undefined || value.translationStatus === "verbatim"
      || value.translationStatus === "translated" || value.translationStatus === "failed")
    && (value.origin === undefined || value.origin === "source")
    && (value.utteranceKey === undefined || (typeof value.utteranceKey === "string"
      && value.utteranceKey.length <= 256 && !/[<>\p{Cc}\p{Cf}]/u.test(value.utteranceKey)))
    && typeof value.sourceEndedAt === "string"
    && typeof value.emittedAt === "string";
}

export function isRecordingStatus(value: unknown): value is RecordingStatusEvent {
  return isRecord(value)
    && value.type === "recording-status"
    && typeof value.sessionId === "string"
    && typeof value.language === "string"
    && value.status === "error"
    && value.code === "UTTERANCE_PERSIST_FAILED"
    && Number.isSafeInteger(value.seq)
    && Number(value.seq) >= 0
    && typeof value.message === "string";
}

function isControlEvent(value: unknown): value is Exclude<LiveBroadcastEvent, CaptionEvent | RecordingStatusEvent> {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.type !== "string") return false;
  if (value.type === "session-status") return ["preparing", "live", "paused", "stopped", "failed"].includes(String(value.status));
  if (value.type === "language-status") {
    return typeof value.language === "string"
      && ["preparing", "ready", "unavailable"].includes(String(value.status))
      && (value.code === undefined || typeof value.code === "string");
  }
  if (value.type === "speaker-legend") return Array.isArray(value.speakers) && value.speakers.every(isSpeaker);
  if (value.type === "floor") {
    return value.holder === null || (isRecord(value.holder)
      && (typeof value.holder.name === "string" || typeof value.holder.displayName === "string")
      && (value.holder.participantId === undefined || typeof value.holder.participantId === "string")
      && (value.holder.department === undefined || typeof value.holder.department === "string")
      && (value.holder.jobTitle === undefined || typeof value.holder.jobTitle === "string"));
  }
  if (value.type === "language-removed") return typeof value.language === "string" && value.code === "LANGUAGE_REMOVED";
  if (value.type === "topic-upsert") {
    try {
      parseLiveTopicUpsertEvent(value, value.sessionId);
      return true;
    } catch {
      return false;
    }
  }
  return value.type === "error" && typeof value.code === "string" && typeof value.message === "string";
}

export function parseBroadcastEvent(value: unknown): LiveBroadcastEvent | null {
  if (isRecord(value) && value.type === "source") {
    const parsed = sourceEventSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  if (isRecord(value) && (value.type === "source-draft" || value.type === "source-draft-clear")) {
    const parsed = value.type === "source-draft" ? sourceDraftEventSchema.safeParse(value) : sourceDraftClearEventSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  if (isRecord(value) && value.type === "source-status" && typeof value.sessionId === "string"
    && value.status === "unavailable" && value.code === "SOURCE_RECORDING_UNAVAILABLE") return {
      type: "source-status", sessionId: value.sessionId, status: "unavailable", code: "SOURCE_RECORDING_UNAVAILABLE",
    };
  if (isCaptionEvent(value)) return value;
  if (isRecordingStatus(value)) return value;
  return isControlEvent(value) ? value : null;
}

export function isViewerJoinData(value: unknown): value is ViewerJoinData {
  if (!isRecord(value) || !isRecord(value.grant) || !isRecord(value.session) || !isRecord(value.self)) return false;
  return typeof value.grant.id === "string"
    && typeof value.grant.sessionId === "string"
    && typeof value.grant.userId === "string"
    && typeof value.grant.expiresAt === "string"
    && typeof value.session.id === "string"
    && value.grant.sessionId === value.session.id
    && typeof value.session.title === "string"
    && (value.session.scheduledAt === null || typeof value.session.scheduledAt === "string")
    && (value.session.sessionType === "presentation" || value.session.sessionType === "meeting")
    && value.session.outputMode === "captions"
    && Number.isInteger(value.session.maxViewers)
    && Number(value.session.maxViewers) >= 1
    && Number(value.session.maxViewers) <= 200
    && Array.isArray(value.session.languages)
    && value.session.languages.length >= 1
    && value.session.languages.length <= 3
    && value.session.languages.every((language) => typeof language === "string")
    && new Set(value.session.languages).size === value.session.languages.length
    && typeof value.session.expiresAt === "string"
    && (value.session.status === undefined || ["preparing", "live", "paused", "stopped", "failed"].includes(String(value.session.status)))
    && (value.session.participantSpeakingEnabled === undefined || typeof value.session.participantSpeakingEnabled === "boolean")
    && isOptionalNullableText(value.session.companyName, 160)
    && (value.session.ticker === undefined || value.session.ticker === null
      || (typeof value.session.ticker === "string" && /^[A-Z0-9.-]{1,12}$/u.test(value.session.ticker)))
    && isOptionalNullableText(value.session.fiscalPeriod, 80)
    && (value.session.eventType === undefined || value.session.eventType === null
      || ["earnings_call", "investor_day", "conference", "other"].includes(String(value.session.eventType)))
    && (value.session.agenda === undefined || (Array.isArray(value.session.agenda)
      && value.session.agenda.length <= 20 && value.session.agenda.every(isAgendaItem)))
    && (value.session.activeSection === undefined
      || ["prepared_remarks", "qa", "other"].includes(String(value.session.activeSection)))
    && isOptionalNullableText(value.session.sectionStartedAt, 64)
    && typeof value.self.email === "string"
    && typeof value.self.displayName === "string"
    && typeof value.self.company === "string"
    && typeof value.self.department === "string"
    && typeof value.self.jobTitle === "string"
    && typeof value.self.summaryConsent === "boolean"
    && Number.isInteger(value.viewerCount)
    && Number(value.viewerCount) >= 0
    && Number(value.viewerCount) <= Number(value.session.maxViewers);
}

function isOptionalNullableText(value: unknown, maximumLength: number): boolean {
  return value === undefined || value === null
    || (typeof value === "string" && Array.from(value).length <= maximumLength);
}

function isAgendaItem(value: unknown): value is LiveAgendaItem {
  return isRecord(value)
    && Number.isSafeInteger(value.ordinal)
    && Number(value.ordinal) >= 1
    && Number(value.ordinal) <= 20
    && typeof value.label === "string"
    && Array.from(value.label).length > 0
    && Array.from(value.label).length <= 120
    && !/[<>\p{Cc}\p{Cf}]/u.test(value.label);
}

export function mergeViewerSnapshot(current: ViewerState, snapshot: LiveSnapshot): ViewerState {
  return {
    ...current,
    viewerCount: snapshot.session.viewerCount,
    session: {
      id: snapshot.session.id,
      title: snapshot.session.title,
      scheduledAt: snapshot.session.scheduledAt,
      sessionType: snapshot.session.sessionType,
      outputMode: snapshot.session.outputMode,
      status: snapshot.session.status,
      maxViewers: snapshot.session.maxViewers,
      languages: snapshot.session.languages,
      expiresAt: snapshot.session.expiresAt,
      hasCoverImage: snapshot.session.hasCoverImage,
      coverImageVersion: snapshot.session.coverImageVersion,
      companyName: snapshot.session.companyName,
      ticker: snapshot.session.ticker,
      fiscalPeriod: snapshot.session.fiscalPeriod,
      eventType: snapshot.session.eventType,
      agenda: snapshot.session.agenda ? [...snapshot.session.agenda] : undefined,
      activeSection: snapshot.session.activeSection,
      sectionStartedAt: snapshot.session.sectionStartedAt,
      participantSpeakingEnabled: snapshot.session.participantSpeakingEnabled ?? false,
    },
  };
}

export async function readApi<T>(response: Response): Promise<T> {
  const payload = await response.json() as ApiResponse<T>;
  if (!payload.ok) throw new ApiRequestError(payload.error, payload.code, response.status);
  if (!response.ok) throw new ApiRequestError("요청을 처리하지 못했습니다.", "REQUEST_FAILED", response.status);
  return payload.data;
}

export async function settleRequest<T>(request: Promise<T>): Promise<SettledRequest<T>> {
  try {
    return { ok: true, value: await request };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

export function normalizeEmail(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

export function normalizeProfileField(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

export function getJoinErrorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return "라이브콜에 참여할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  if (error.code === "CAPACITY_REACHED" || error.code === "SESSION_FULL") return "참여 인원이 가득 찼습니다.";
  if (error.code === "INVITE_EXPIRED") return "참여가 마감되었거나 QR 초대가 만료되었습니다.";
  return "라이브콜에 참여할 수 없습니다. 입력 정보를 확인해 주세요.";
}
