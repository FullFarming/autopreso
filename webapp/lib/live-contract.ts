export type LiveSessionType = "presentation" | "meeting";
export type LiveOutputMode = "captions" | "captions_audio" | "audio";
export type LiveVoiceProvider = "gemini" | "openai";
export type GlossaryPack = "general_cre" | "hotel" | "fnb";
export type VoiceStatus = "disabled" | "analyzing" | "ready" | "unavailable";

export type LiveSessionStatus = "preparing" | "live" | "paused" | "stopped" | "failed";
export type CaptionTranslationStatus = "verbatim" | "translated" | "failed";

export interface LiveSession {
  id: string;
  hostId: string;
  title: string;
  scheduledAt: string | null;
  sessionType: LiveSessionType;
  outputMode: LiveOutputMode;
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
  /** Content-hash version of the cover — clients append it as a cache key
   *  so replacing the cover refreshes already-open stages and viewers. */
  coverImageVersion?: string | null;
}

export interface LiveParticipantIdentity {
  displayName: string;
  department: string;
  jobTitle: string;
}

export type JoinLiveSessionInput = LiveParticipantIdentity & {
  accessToken: string;
  deviceId: string;
  inviteToken?: string;
  admissionCode?: string;
};

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
  /** "verbatim": `text` is the original. "translated": `text` is a real
   *  translation of `sourceText`. "failed": translation failed and the
   *  original was published on this lane, so `text` is NOT in `language` —
   *  the viewer must present it as the original, not as its chosen language. */
  translationStatus?: CaptionTranslationStatus;
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
  | { type: "session-status"; sessionId: string; status: LiveSessionStatus; code?: string }
  | { type: "floor"; sessionId: string; holder: LiveFloorHolder | null }
  | { type: "language-status"; sessionId: string; language: string; status: "preparing" | "ready" | "unavailable"; code?: string }
  | { type: "audio-control"; seq: number; sessionId: string; language: string; action: "clear" | "restart"; reason: "interrupted" | "queue_restart" }
  | { type: "speaker-legend"; sessionId: string; speakers: SpeakerAssignment[] }
  | { type: "language-removed"; sessionId: string; language: string; code: "LANGUAGE_REMOVED" }
  | RecordingStatusEvent
  | { type: "error"; sessionId: string; code: string; message: string };

export type LiveBroadcastEvent = CaptionEvent | LiveControlEvent;

export type ApiSuccess<T> = { ok: true; data: T };
export type ApiFailure = { ok: false; error: string; code: string };
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface CreateLiveSessionInput {
  title: string;
  scheduledAt?: string | null;
  sessionType: LiveSessionType;
  languages: string[];
  outputMode?: LiveOutputMode;
  voiceProvider?: LiveVoiceProvider;
  maxViewers?: number;
  glossaryPack?: GlossaryPack;
}

export interface UpdateLiveSessionInput {
  version: number;
  title?: string;
  scheduledAt?: string | null;
  sessionType?: LiveSessionType;
  languages?: string[];
  outputMode?: LiveOutputMode;
  voiceProvider?: LiveVoiceProvider;
  maxViewers?: number;
  glossaryPack?: GlossaryPack;
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
