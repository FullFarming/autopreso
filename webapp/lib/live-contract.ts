import type { TranslationCapture } from "./live/translation-capture";
import type { SpeakerProfile } from "../../packages/caption-core/speaker-profile.js";
export type { SpeakerProfile } from "../../packages/caption-core/speaker-profile.js";
import type { LiveModelPreferences } from "./live/model-preferences";
import type { LanguageObservation, SourceEvent, SourceDraftEvent, SourceDraftClearEvent } from "./live/source-contract";
export type { LanguageObservation, SourceEvent, SourceSnapshot, SourceDraftEvent, SourceDraftClearEvent } from "./live/source-contract";

import type {
  LiveTopicMembership,
  LiveTopicPublicMetadata,
  LiveTopicSnapshot,
  LiveTopicUpsertEvent,
} from "./security/live-topic-validation";
import type { BuiltinGlossaryId } from "./glossary-presets/types";

export type {
  LiveTopicMembership,
  LiveTopicPublicMetadata,
  LiveTopicSnapshot,
  LiveTopicUpsertEvent,
} from "./security/live-topic-validation";

export type LiveSessionType = "presentation" | "meeting";
export type LiveOutputMode = "captions";
export type LiveVoiceProvider = "gemini";
export type GlossaryPack = "general_cre" | "hotel" | "fnb";
export type { BuiltinGlossaryId } from "./glossary-presets/types";
export type GlossarySourceKind = "builtin" | "host";
export type VoiceStatus = "disabled" | "analyzing" | "ready" | "unavailable";
export type LiveEventType = "earnings_call" | "investor_day" | "conference" | "other";
export type LiveSessionSection = "prepared_remarks" | "qa" | "other";

export interface LiveAgendaItem {
  ordinal: number;
  label: string;
}

export type LiveSessionStatus = "preparing" | "live" | "paused" | "stopped" | "failed";
export type CaptionTranslationStatus = "verbatim" | "translated" | "failed";

export interface LiveSession {
  id: string;
  hostId: string;
  title: string;
  scheduledAt: string | null;
  sessionType: LiveSessionType;
  /** @deprecated Stored-row compatibility only. All new sessions are captions-only. */
  outputMode: LiveOutputMode;
  /** @deprecated Stored-row compatibility only. Caption contract v2 has no voice provider. */
  voiceProvider: LiveVoiceProvider;
  maxViewers: number;
  glossaryPack: GlossaryPack;
  status: LiveSessionStatus;
  languages: [string, ...string[]];
  viewerCount: number;
  version: number;
  admissionOpenUntil: string | null;
  expiresAt: string;
  endedAt?: string | null;
  /** Contract C10: true when a stage/waiting-room cover image was uploaded.
   *  Clients fetch it from GET /api/live-sessions/[id]/cover. */
  hasCoverImage?: boolean;
  /** Opaque per-upload version — clients append it as a cache key so replacing
   *  the cover refreshes already-open stages and viewers. */
  coverImageVersion?: string | null;
  companyName?: string | null;
  ticker?: string | null;
  fiscalPeriod?: string | null;
  eventType?: LiveEventType | null;
  agenda?: LiveAgendaItem[];
  modelPreferences?: LiveModelPreferences;
  activeSection?: LiveSessionSection;
  sectionStartedAt?: string | null;
  /** Host-owned pre-call capability. Viewers may request the shared floor only
   * when this server-projected value is exactly true. */
  participantSpeakingEnabled: boolean;
  /** Server-owned gateway activation key for the CURRENT activation epoch
   *  (written by the gateway's readiness RPC). A second host client that
   *  presents the SAME key on `start` reattaches the live pipeline warm
   *  (web↔Electron handover); a different key forces a cold restart. Host-only
   *  data — viewer projections (admission store) never include it. */
  activationKey?: string | null;
}

export interface LiveSessionGlossaryPin {
  sessionId: string;
  version: number;
  pinnedGlossaryPresetId: string;
  pinnedGlossaryVersion: number;
  pinnedGlossaryFingerprint: string;
  updatedAt: string;
}

export type LiveSessionGlossaryPinSelection = {
  sourceKind: "builtin";
  sourceId: BuiltinGlossaryId;
  documentVersion?: 1;
} | {
  sourceKind: "host";
  sourceId: string;
  documentVersion: number;
};

export type LiveSessionGlossaryPinItem = LiveSessionGlossaryPinSelection & {
  ordinal: number;
  documentVersion: number;
  fingerprint: string | null;
};

export interface LiveSessionGlossaryPins {
  sessionId: string;
  version: number;
  glossaries: LiveSessionGlossaryPinItem[];
  updatedAt: string;
}

export interface LiveParticipantIdentity {
  displayName: string;
  department: string;
  jobTitle: string;
}

export interface LiveAttendeeSelfProfile {
  email: string;
  displayName: string;
  company: string;
  department: string;
  jobTitle: string;
  summaryConsent: boolean;
}

export type JoinLiveSessionInput = LiveAttendeeSelfProfile & {
  accessToken: string;
  deviceId: string;
} & ({
  inviteToken: string;
  accessCode?: never;
} | {
  inviteToken?: never;
  accessCode: string;
});

export interface LiveHostParticipantActivity extends LiveParticipantActivity {
  email: string | null;
  company: string | null;
  summaryConsentAt: string | null;
}

export interface LiveParticipantActivity extends LiveParticipantIdentity {
  participantId: string;
  joinedAt: string;
  lastSeenAt: string;
  isPresent: boolean;
  utteranceCount: number;
  speakingSeconds: number;
  lastSpokeAt: string | null;
}

export interface LiveSpeechActivity extends LiveParticipantIdentity {
  speakerProfile?: SpeakerProfile;
  seq: number;
  participantId: string | null;
  text: string;
  startedAt: string | null;
  endedAt: string;
}

export interface SpeakerAssignment {
  speakerId: string;
  label: string;
  colorToken: string;
  voiceName: string | null;
  voiceStatus: VoiceStatus;
  lastSeenAt: string;
  /** Contract C5: attributed participant identity, present in meeting mode. */
  name?: string;
  department?: string;
  jobTitle?: string;
}

/** Contract C5: floor holder identity for the speaker-change overlay.
 *  `displayName` is kept for events from older gateways. */
export interface LiveFloorHolder {
  participantId?: string;
  name?: string;
  displayName?: string;
  department?: string;
  jobTitle?: string;
}

export interface CaptionEvent {
  speakerProfile?: SpeakerProfile;
  speakerAttribution?: "unresolved";
  translationCapture?: TranslationCapture;
  observedSourceLanguage?: string | null;
  type: "caption";
  seq: number;
  sessionId: string;
  language: string;
  speaker: SpeakerAssignment | null;
  text: string;
  isFinal: boolean;
  /** What the speaker actually said, when `text` is a translation of it.
   *  null on the source lane, where `text` already IS the original. Powers the
   *  viewer's per-entry 원문보기 disclosure. */
  sourceText?: string | null;
  /** Normalized language the utterance was recognized in, or null when the
   *  STT provider reported none. */
  sourceLanguage?: string | null;
  languageObservation?: LanguageObservation;
  /** "verbatim": `text` is the original. "translated": `text` is a real
   *  translation of `sourceText`. "failed": translation failed and the
   *  original was published on this lane, so `text` is NOT in `language` —
   *  the viewer must present it as the original, not as its chosen language. */
  translationStatus?: CaptionTranslationStatus;
  /** "source" marks the untranslated INPUT transcript. The web viewer keeps it
   *  visible in its own language history; Electron rejects this lane and shows
   *  only the opposite-language translation. See isDisplayableCaption in
   *  lib/live/caption-feed. */
  origin?: "source";
  /** Stable gateway correlation shared by the source and translated lanes. */
  utteranceKey?: string;
  sourceStartedAt?: string | null;
  sourceEndedAt: string;
  emittedAt: string;
  /** Contract C2: true when the gateway re-sends a missed caption after
   *  a viewer subscribes with lastSeq. Same dedupe path as live captions. */
  replay?: boolean;
}

export interface AudioChunkHeader {
  type: "audio-chunk";
  seq: number;
  sessionId: string;
  language: string;
  speaker: SpeakerAssignment | null;
  sampleRate: 24_000;
}

export interface LiveSnapshot {
  session: LiveSession;
  language: string;
  lastSeq: number;
  captions: CaptionEvent[];
  speakers: SpeakerAssignment[];
  topics: LiveTopicPublicMetadata[];
  topicMemberships: LiveTopicMembership[];
}

export interface RecordingStatusEvent {
  type: "recording-status";
  sessionId: string;
  language: string;
  status: "error";
  code: "UTTERANCE_PERSIST_FAILED";
  seq: number;
  message: string;
}

export type LiveControlEvent =
  | { type: "source-status"; sessionId: string; status: "unavailable"; code: "SOURCE_RECORDING_UNAVAILABLE" }
  | { type: "session-status"; sessionId: string; status: LiveSessionStatus; code?: string }
  | { type: "floor"; sessionId: string; holder: LiveFloorHolder | null }
  | { type: "language-status"; sessionId: string; language: string; status: "preparing" | "ready" | "unavailable"; code?: string }
  | { type: "speaker-legend"; sessionId: string; speakers: SpeakerAssignment[] }
  | { type: "language-removed"; sessionId: string; language: string; code: "LANGUAGE_REMOVED" }
  | LiveTopicUpsertEvent
  | RecordingStatusEvent
  | { type: "error"; sessionId: string; code: string; message: string };

export type LiveBroadcastEvent = CaptionEvent | SourceEvent | SourceDraftEvent | SourceDraftClearEvent | LiveControlEvent;

export type ApiSuccess<T> = { ok: true; data: T };
export type ApiFailure = { ok: false; error: string; code: string };
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface CreateLiveSessionInput {
  title: string;
  scheduledAt?: string | null;
  sessionType: LiveSessionType;
  languages: string[];
  /** @deprecated Omit. Accepted temporarily only as the literal `captions`. */
  outputMode?: LiveOutputMode;
  /** @deprecated Omit. Accepted temporarily only as the literal `gemini`. */
  voiceProvider?: LiveVoiceProvider;
  maxViewers?: number;
  glossaryPack?: GlossaryPack;
  companyName?: string | null;
  ticker?: string | null;
  fiscalPeriod?: string | null;
  eventType?: LiveEventType | null;
  agenda?: string[];
  participantSpeakingEnabled?: boolean;
}

export interface UpdateLiveSessionInput {
  version: number;
  title?: string;
  scheduledAt?: string | null;
  sessionType?: LiveSessionType;
  languages?: string[];
  /** @deprecated Omit. Accepted temporarily only as the literal `captions`. */
  outputMode?: LiveOutputMode;
  /** @deprecated Omit. Accepted temporarily only as the literal `gemini`. */
  voiceProvider?: LiveVoiceProvider;
  maxViewers?: number;
  glossaryPack?: GlossaryPack;
  companyName?: string | null;
  ticker?: string | null;
  fiscalPeriod?: string | null;
  eventType?: LiveEventType | null;
  agenda?: string[];
  participantSpeakingEnabled?: boolean;
}

export interface AudioChunkEvent {
  header: AudioChunkHeader;
  pcm: ArrayBuffer;
}

const AUDIO_CHUNK_HEADER_BYTES = 4;
const MAX_AUDIO_CHUNK_HEADER_BYTES = 4_096;
const MAX_AUDIO_CHUNK_PCM_BYTES = 256 * 1_024;

export function encodeAudioChunk(event: AudioChunkEvent): ArrayBuffer {
  const header = new TextEncoder().encode(JSON.stringify(event.header));
  const pcm = new Uint8Array(event.pcm);
  const frame = new Uint8Array(AUDIO_CHUNK_HEADER_BYTES + header.byteLength + pcm.byteLength);
  new DataView(frame.buffer).setUint32(0, header.byteLength, false);
  frame.set(header, AUDIO_CHUNK_HEADER_BYTES);
  frame.set(pcm, AUDIO_CHUNK_HEADER_BYTES + header.byteLength);
  return frame.buffer;
}

export function decodeAudioChunk(frame: ArrayBuffer): AudioChunkEvent {
  if (frame.byteLength < AUDIO_CHUNK_HEADER_BYTES) throw new Error("오디오 프레임이 너무 짧습니다.");
  const bytes = new Uint8Array(frame);
  const headerLength = new DataView(frame).getUint32(0, false);
  const pcmOffset = AUDIO_CHUNK_HEADER_BYTES + headerLength;
  const pcmLength = frame.byteLength - pcmOffset;
  if (headerLength === 0 || headerLength > MAX_AUDIO_CHUNK_HEADER_BYTES || pcmOffset > frame.byteLength) {
    throw new Error("오디오 프레임 헤더가 올바르지 않습니다.");
  }
  if (pcmLength <= 0 || pcmLength > MAX_AUDIO_CHUNK_PCM_BYTES || pcmLength % 2 !== 0) {
    throw new Error("오디오 PCM 길이가 올바르지 않습니다.");
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.slice(AUDIO_CHUNK_HEADER_BYTES, pcmOffset)));
  if (!isAudioChunkHeader(parsed)) throw new Error("오디오 프레임 헤더가 올바르지 않습니다.");
  return { header: parsed, pcm: bytes.slice(pcmOffset).buffer };
}

function isAudioChunkHeader(value: unknown): value is AudioChunkHeader {
  if (!value || typeof value !== "object") return false;
  const header = value as Record<string, unknown>;
  return header.type === "audio-chunk"
    && Number.isSafeInteger(header.seq)
    && Number(header.seq) >= 0
    && typeof header.sessionId === "string"
    && typeof header.language === "string"
    && header.sampleRate === 24_000
    && (header.speaker === null || isSpeakerAssignment(header.speaker));
}

function isSpeakerAssignment(value: unknown): value is SpeakerAssignment {
  if (!value || typeof value !== "object") return false;
  const speaker = value as Record<string, unknown>;
  return typeof speaker.speakerId === "string"
    && typeof speaker.label === "string"
    && typeof speaker.colorToken === "string"
    && (typeof speaker.voiceName === "string" || speaker.voiceName === null)
    && ["disabled", "analyzing", "ready", "unavailable"].includes(String(speaker.voiceStatus))
    && typeof speaker.lastSeenAt === "string";
}
