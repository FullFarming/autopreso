"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { decodeAudioChunk } from "@/lib/live-contract";
import { LANGUAGE_LABELS } from "@/lib/languageDetect";
import type {
  ApiResponse,
  CaptionEvent,
  LiveBroadcastEvent,
  LiveFloorHolder,
  LiveOutputMode,
  LiveSession,
  LiveSessionStatus,
  LiveSessionType,
  LiveSnapshot,
  RecordingStatusEvent,
  SpeakerAssignment,
} from "@/lib/live-contract";
import { getReconnectDelayMilliseconds, getReconnectStatus } from "./connection-resilience";
import type { MeetingSummary } from "@/lib/live/summary";
import MeetingMinutes, { type TranscriptEntry } from "./MeetingMinutes";
import { isPinnedToLatest as isPinnedNearTop, newestFirst } from "@/lib/live/caption-feed";
import { countdownMsUntil, formatCountdown } from "@/lib/live/countdown";
import MeetingTurnFeed from "./MeetingTurnFeed";
import {
  prepareSpeakCapture,
  SpeakCaptureError,
  type PreparedSpeakCapture,
  type SpeakSession,
} from "./speak-client";
import SpeakerCaption, { resolveSpeakerColor, speakerMetaLine } from "./SpeakerCaption";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const LIVE_GATEWAY_URL = process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL ?? "";
const DEVICE_STORAGE_KEY = "rnw-live-viewer-device-v1";
/** Caption text-size range, as a multiplier on the base caption size. 1 is the
 *  designed default; the ceiling keeps roughly two lines of Korean readable on a
 *  375px viewport rather than allowing an unusable zoom. */
const CAPTION_SCALE_MIN = 1;
const CAPTION_SCALE_MAX = 2;
const inviteTokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const MAX_INTERPRETATION_QUEUE_SECONDS = 30;
const MAX_INTERPRETATION_QUEUE_BYTES = 24_000 * 2 * MAX_INTERPRETATION_QUEUE_SECONDS;
const MAX_INTERPRETATION_PLAYBACK_RATE = 1.6;
const MAX_PLAYBACK_RATE_RISE_PER_CHUNK = 0.08;
const MAX_PLAYBACK_RATE_FALL_PER_CHUNK = 0.04;

function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code;
}

function getAdaptiveInterpretationPlaybackRate(queueAheadSeconds: number, previousRate: number): number {
  const queueAhead = Math.max(0, Number.isFinite(queueAheadSeconds) ? queueAheadSeconds : 0);
  const currentRate = Math.max(1, Math.min(MAX_INTERPRETATION_PLAYBACK_RATE,
    Number.isFinite(previousRate) ? previousRate : 1));
  let targetRate = 1;
  if (queueAhead >= 10) targetRate = MAX_INTERPRETATION_PLAYBACK_RATE;
  else if (queueAhead > 4) targetRate = 1.25 + ((queueAhead - 4) / 6) * 0.2;
  else if (queueAhead > 1) targetRate = 1 + ((queueAhead - 1) / 3) * 0.25;
  const delta = targetRate - currentRate;
  if (delta > 0) return Math.min(MAX_INTERPRETATION_PLAYBACK_RATE, currentRate + Math.min(delta, MAX_PLAYBACK_RATE_RISE_PER_CHUNK));
  return Math.max(1, currentRate + Math.max(delta, -MAX_PLAYBACK_RATE_FALL_PER_CHUNK));
}

interface ViewerJoinData {
  viewerToken: string;
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
    /** Mirrors the wire type. Narrowing this to the joinable states meant the
     *  snapshot merge could not carry status through at all, which silently
     *  disabled the snapshot-failure guard that reads it. */
    status?: LiveSessionStatus;
    hasCoverImage?: boolean;
    coverImageVersion?: string | null;
  };
  viewerCount: number;
}

interface ViewerState extends ViewerJoinData {
  accessToken: string;
  displayName: string;
  department: string;
  jobTitle: string;
}

interface PipFrame {
  sessionType: LiveSessionType;
  outputMode: LiveOutputMode;
  captions: CaptionEvent[];
  status: string;
}

interface FallbackPip {
  video: HTMLVideoElement;
  stream: MediaStream;
  timer: number;
}

function takeInviteTokenFromHash(): string | null {
  const fragment = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const inviteToken = new URLSearchParams(fragment).get("invite");
  if (inviteToken === null) return null;
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return inviteTokenPattern.test(inviteToken) ? inviteToken : "";
}

function drawWrappedText(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number): void {
  const words = Array.from(text);
  let line = "";
  let row = 0;
  for (const word of words) {
    const candidate = line + word;
    if (line && context.measureText(candidate).width > maxWidth) {
      context.fillText(line, x, y + row * lineHeight);
      line = word;
      row += 1;
      if (row >= 3) break;
    } else {
      line = candidate;
    }
  }
  if (line && row < 3) context.fillText(line, x, y + row * lineHeight);
}

function drawFallbackPipFrame(context: CanvasRenderingContext2D, frame: PipFrame): void {
  const width = context.canvas.width;
  const height = context.canvas.height;
  context.fillStyle = "#0c0a09";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#a8a29e";
  context.font = "500 24px Pretendard, sans-serif";
  const isAudioOnly = frame.outputMode === "audio";
  const outputLabel = frame.outputMode === "captions"
    ? "Captions"
    : frame.outputMode === "captions_audio" ? "Captions + translated audio" : "Translated audio";
  context.fillText(`${frame.sessionType.toUpperCase()} · ${outputLabel} · ${frame.status}`, 56, 62);

  if (isAudioOnly) {
    context.fillStyle = "#ffffff";
    context.font = "600 58px Pretendard, sans-serif";
    context.fillText("Translated audio is playing", 56, 330);
    return;
  }

  const caption = frame.captions.at(-1);
  if (!caption) {
    context.fillStyle = "#a8a29e";
    context.font = "500 34px Inter, sans-serif";
    context.fillText("Waiting for captions.", 56, 330);
    return;
  }
  const speakerColor = resolveSpeakerColor(caption.speaker);
  context.fillStyle = speakerColor;
  context.fillRect(56, 132, 8, 456);
  context.beginPath();
  context.arc(91, 163, 9, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#a8a29e";
  context.font = "600 25px Inter, sans-serif";
  context.fillText(speakerMetaLine(caption.speaker), 116, 171);
  context.fillStyle = "#ffffff";
  context.font = "600 50px Inter, sans-serif";
  drawWrappedText(context, caption.text, 88, 264, width - 144, 74);
}

function mergeViewerSnapshot(current: ViewerState, snapshot: LiveSnapshot): ViewerState {
  return {
    ...current,
    viewerCount: snapshot.session.viewerCount,
    session: {
      id: snapshot.session.id,
      title: snapshot.session.title,
      scheduledAt: snapshot.session.scheduledAt,
      sessionType: snapshot.session.sessionType,
      outputMode: snapshot.session.outputMode,
      // status MUST be carried through. It is the sole input to the
      // snapshot-failure guard in subscribe(), which rethrows when the session
      // is live or paused. Dropping it here left status undefined after the
      // first successful merge, so from then on a failed snapshot during a
      // language switch silently produced an empty caption pane with no error —
      // subscribe() had already cleared captions.
      status: snapshot.session.status,
      maxViewers: snapshot.session.maxViewers,
      languages: snapshot.session.languages,
      expiresAt: snapshot.session.expiresAt,
      hasCoverImage: snapshot.session.hasCoverImage,
      coverImageVersion: snapshot.session.coverImageVersion,
    },
  };
}

function makeDeviceId(): string {
  const current = localStorage.getItem(DEVICE_STORAGE_KEY);
  if (current) return current;
  const next = crypto.randomUUID();
  localStorage.setItem(DEVICE_STORAGE_KEY, next);
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLiveSessionType(value: unknown): value is LiveSessionType {
  return value === "presentation" || value === "meeting";
}

function isLiveOutputMode(value: unknown): value is LiveOutputMode {
  return value === "captions" || value === "captions_audio" || value === "audio";
}

function getSpeakerVoiceStatus(speaker: SpeakerAssignment, outputMode: LiveOutputMode): string {
  if (outputMode === "captions") return "Captions only";
  const voiceStatus: unknown = speaker.voiceStatus;
  if (voiceStatus === undefined) return speaker.voiceName ? `Voice ready · ${speaker.voiceName}` : "Analyzing voice";
  if (voiceStatus === "ready") return speaker.voiceName ? `Voice ready · ${speaker.voiceName}` : "Voice ready";
  if (voiceStatus === "unavailable") return "Unavailable";
  if (voiceStatus === "disabled") return "Captions only";
  return "Analyzing voice";
}

function getDeliveryMethod(sessionType: LiveSessionType, outputMode: LiveOutputMode): { title: string; description: string } {
  if (sessionType === "presentation") {
    return outputMode === "captions"
      ? { title: "Live captions", description: "Captions appear in your selected language while the host speaks." }
      : { title: "Live captions + audio", description: "Translated audio plays as each sentence is completed." };
  }
  return outputMode === "captions"
    ? { title: "Speaker captions", description: "Translated captions are grouped by speaker." }
    : { title: "Speaker captions + audio", description: "Translated audio follows each completed turn." };
}

export function SpeakControlIcon({ state }: { state: "idle" | "starting" | "speaking" }) {
  if (state === "speaking") {
    return <span className="live-speak-button-waves" aria-hidden="true"><i /><i /><i /><i /><i /></span>;
  }
  if (state === "starting") {
    return <span className="live-speak-connecting" aria-hidden="true"><i /><i /><i /></span>;
  }
  return (
    <svg className="live-speak-microphone" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.75a3 3 0 0 0-3 3v5.5a3 3 0 1 0 6 0v-5.5a3 3 0 0 0-3-3Z" />
      <path d="M6.75 11.75v.5a5.25 5.25 0 0 0 10.5 0v-.5M12 17.5v2.75M9.25 20.25h5.5" />
    </svg>
  );
}

function captionConnectionLabel(status: LiveSessionStatus | "ready" | "unavailable"): string {
  if (status === "live" || status === "ready") return "Live";
  if (status === "preparing") return "Preparing captions";
  if (status === "paused") return "Paused by host";
  if (status === "stopped") return "Live ended";
  if (status === "unavailable") return "Language unavailable";
  return "Check connection";
}

function isViewerJoinData(value: unknown): value is ViewerJoinData {
  if (!isRecord(value) || !isRecord(value.grant) || !isRecord(value.session)) return false;
  return typeof value.viewerToken === "string"
    && typeof value.grant.id === "string"
    && typeof value.grant.sessionId === "string"
    && typeof value.grant.userId === "string"
    && typeof value.grant.expiresAt === "string"
    && typeof value.session.id === "string"
    && typeof value.session.title === "string"
    && (value.session.scheduledAt === null || typeof value.session.scheduledAt === "string")
    && isLiveSessionType(value.session.sessionType)
    && isLiveOutputMode(value.session.outputMode)
    && Number.isInteger(value.session.maxViewers)
    && Number(value.session.maxViewers) >= 1
    && Number(value.session.maxViewers) <= 50
    && Array.isArray(value.session.languages)
    && value.session.languages.length >= 1
    && value.session.languages.length <= 3
    && value.session.languages.every((language) => typeof language === "string")
    && new Set(value.session.languages).size === value.session.languages.length
    && typeof value.session.expiresAt === "string"
    && typeof value.viewerCount === "number"
    && Number.isInteger(value.viewerCount)
    && value.viewerCount >= 0
    && value.viewerCount <= Number(value.session.maxViewers);
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
    // Provenance fields are optional so older gateways keep validating, but a
    // present value must be well-typed — it is rendered into the DOM.
    && (value.sourceText === undefined || value.sourceText === null || typeof value.sourceText === "string")
    && (value.sourceLanguage === undefined || value.sourceLanguage === null || typeof value.sourceLanguage === "string")
    && (value.translationStatus === undefined || value.translationStatus === "verbatim"
      || value.translationStatus === "translated" || value.translationStatus === "failed")
    && typeof value.sourceEndedAt === "string"
    && typeof value.emittedAt === "string";
}

function isSpeaker(value: unknown): value is SpeakerAssignment {
  return isRecord(value)
    && typeof value.speakerId === "string"
    && typeof value.label === "string"
    && typeof value.colorToken === "string"
    && (typeof value.voiceName === "string" || value.voiceName === null)
    && typeof value.lastSeenAt === "string"
    // Identity fields are optional on the wire but ARE rendered into the DOM by
    // speakerMetaLine, which calls .trim() on each. A non-string here threw
    // inside render and blanked the whole viewer, so validate them for the same
    // reason the provenance fields are validated.
    && (value.name === undefined || value.name === null || typeof value.name === "string")
    && (value.department === undefined || value.department === null || typeof value.department === "string")
    && (value.jobTitle === undefined || value.jobTitle === null || typeof value.jobTitle === "string")
    && (value.voiceStatus === undefined || value.voiceStatus === "disabled" || value.voiceStatus === "analyzing"
      || value.voiceStatus === "ready" || value.voiceStatus === "unavailable");
}

function isControlEvent(value: unknown): value is Exclude<LiveBroadcastEvent, CaptionEvent | RecordingStatusEvent> {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.type !== "string") return false;
  if (value.type === "session-status") {
    return value.status === "preparing" || value.status === "live" || value.status === "paused"
      || value.status === "stopped" || value.status === "failed";
  }
  if (value.type === "language-status") {
    return typeof value.language === "string"
      && (value.status === "preparing" || value.status === "ready" || value.status === "unavailable")
      && (value.code === undefined || typeof value.code === "string");
  }
  if (value.type === "speaker-legend") {
    return Array.isArray(value.speakers) && value.speakers.every(isSpeaker);
  }
  if (value.type === "floor") {
    // Contract C5: holder now carries { participantId, name, department,
    // jobTitle }; older gateways send { displayName }. Accept both.
    return value.holder === null
      || (isRecord(value.holder)
        && (typeof value.holder.displayName === "string" || typeof value.holder.name === "string")
        && (value.holder.participantId === undefined || typeof value.holder.participantId === "string")
        && (value.holder.department === undefined || typeof value.holder.department === "string")
        && (value.holder.jobTitle === undefined || typeof value.holder.jobTitle === "string"));
  }
  if (value.type === "language-removed") {
    return typeof value.language === "string" && value.code === "LANGUAGE_REMOVED";
  }
  if (value.type === "audio-control") {
    return Number.isSafeInteger(value.seq)
      && Number(value.seq) >= 0
      && typeof value.language === "string"
      && (value.action === "clear" || value.action === "restart")
      && (value.reason === "interrupted" || value.reason === "queue_restart");
  }
  return value.type === "error" && typeof value.code === "string" && typeof value.message === "string";
}

function isRecordingStatusEvent(value: unknown): value is RecordingStatusEvent {
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

function parseBroadcastEvent(value: unknown): LiveBroadcastEvent | null {
  if (isCaptionEvent(value)) return value;
  if (isRecordingStatusEvent(value)) return value;
  return isControlEvent(value) ? value : null;
}

async function readApi<T>(response: Response): Promise<T> {
  const payload = await response.json() as ApiResponse<T>;
  if (!payload.ok) throw new ApiRequestError(payload.error, payload.code);
  return payload.data;
}

class ApiRequestError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

function normalizeDisplayName(value: string): string {
  return value.normalize("NFC").trim();
}

function normalizeProfileField(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function getJoinErrorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return error instanceof Error ? error.message : "Unable to join the live session.";
  if (error.code === "CAPACITY_REACHED" || error.code === "SESSION_FULL") {
    return "This meeting is full.";
  }
  if (error.code === "INVITE_EXPIRED") {
    return "Guest entry is closed or this QR invite has expired.";
  }
  return error.message;
}

function captionLaneKey(caption: CaptionEvent): string {
  return caption.speaker?.speakerId ?? "presenter";
}

function normalizeCaptionText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function mergeCaptionTimeline(current: CaptionEvent[], incoming: CaptionEvent): CaptionEvent[] {
  const lane = captionLaneKey(incoming);
  const normalizedText = normalizeCaptionText(incoming.text);
  if (!normalizedText) return current;

  const isDuplicateFinal = incoming.isFinal && current.some((caption) => caption.isFinal
    && (caption.seq === incoming.seq
      || (captionLaneKey(caption) === lane && normalizeCaptionText(caption.text) === normalizedText)));
  if (isDuplicateFinal) {
    return current.filter((caption) => caption.isFinal
      || (captionLaneKey(caption) !== lane && captionLaneKey(caption) !== "live"));
  }

  const existingPartial = current.find((caption) => !caption.isFinal && captionLaneKey(caption) === lane);
  if (!incoming.isFinal && existingPartial?.seq === incoming.seq
    && normalizeCaptionText(existingPartial.text) === normalizedText) return current;

  // A finalized caption also clears the synthetic "live" interim lane the
  // gateway uses for meeting-mode partials, so stale partial text never
  // lingers in the live sheet after the utterance is committed.
  const withoutCurrentPartial = current.filter((caption) => caption.isFinal
    || (captionLaneKey(caption) !== lane && !(incoming.isFinal && captionLaneKey(caption) === "live")));
  return [...withoutCurrentPartial, incoming].slice(-200);
}

export function floorHolderName(holder: LiveFloorHolder | null): string | null {
  if (!holder) return null;
  return holder.name?.trim() || holder.displayName?.trim() || null;
}

function useLiveInterpretationAudio(onQueueRestart: () => void, onPlaybackBlocked: () => void) {
  const contextRef = useRef<AudioContext | null>(null);
  const nextStartRef = useRef(0);
  const queuedPcmBytesRef = useRef(0);
  const playbackRateRef = useRef(1);
  const isEnabledRef = useRef(false);
  const scheduledSourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const sourceByteLengthsRef = useRef(new Map<AudioBufferSourceNode, number>());
  const [isEnabled, setIsEnabled] = useState(false);

  const stopScheduledSources = useCallback(() => {
    for (const source of scheduledSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // 이미 종료된 소스는 onended에서 같은 정리 경로를 따릅니다.
      }
      source.disconnect();
    }
    scheduledSourcesRef.current.clear();
    sourceByteLengthsRef.current.clear();
    queuedPcmBytesRef.current = 0;
    playbackRateRef.current = 1;
  }, []);

  const restartQueue = useCallback(() => {
    stopScheduledSources();
    nextStartRef.current = contextRef.current?.currentTime ?? 0;
    playbackRateRef.current = 1;
  }, [stopScheduledSources]);

  const clear = useCallback(() => {
    const context = contextRef.current;
    contextRef.current = null;
    nextStartRef.current = 0;
    isEnabledRef.current = false;
    setIsEnabled(false);
    stopScheduledSources();
    if (context) void context.close();
  }, [stopScheduledSources]);

  const enable = useCallback(async () => {
    const context = contextRef.current ?? new AudioContext({ sampleRate: 24_000 });
    contextRef.current = context;
    await context.resume();
    if (context.state !== "running") throw new Error("Audio permission is required. Choose Audio On again.");
    nextStartRef.current = context.currentTime;
    isEnabledRef.current = true;
    setIsEnabled(true);
  }, []);

  const enqueue = useCallback((pcmBytes: ArrayBuffer, sampleRate: number) => {
    const context = contextRef.current;
    if (!context || !isEnabledRef.current) return;
    if (context.state !== "running") {
      restartQueue();
      isEnabledRef.current = false;
      setIsEnabled(false);
      onPlaybackBlocked();
      return;
    }
    if (sampleRate !== 24_000 || pcmBytes.byteLength === 0 || pcmBytes.byteLength % 2 !== 0) return;
    const pcm = new Int16Array(pcmBytes);
    const buffer = context.createBuffer(1, pcm.length, sampleRate);
    const isQueueIdle = scheduledSourcesRef.current.size === 0;
    const queueAhead = Math.max(0, nextStartRef.current - context.currentTime);
    let playbackRate = isQueueIdle
      ? 1
      : getAdaptiveInterpretationPlaybackRate(queueAhead + buffer.duration, playbackRateRef.current);
    const projectedQueueDuration = queueAhead + buffer.duration / playbackRate;
    if (projectedQueueDuration > MAX_INTERPRETATION_QUEUE_SECONDS
      || queuedPcmBytesRef.current + pcmBytes.byteLength > MAX_INTERPRETATION_QUEUE_BYTES) {
      restartQueue();
      onQueueRestart();
      playbackRate = 1;
    }
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) channel[index] = pcm[index] / 32_768;
    const source = context.createBufferSource();
    scheduledSourcesRef.current.add(source);
    sourceByteLengthsRef.current.set(source, pcmBytes.byteLength);
    queuedPcmBytesRef.current += pcmBytes.byteLength;
    source.addEventListener("ended", () => {
      scheduledSourcesRef.current.delete(source);
      const byteLength = sourceByteLengthsRef.current.get(source) ?? 0;
      sourceByteLengthsRef.current.delete(source);
      queuedPcmBytesRef.current = Math.max(0, queuedPcmBytesRef.current - byteLength);
      source.disconnect();
      if (scheduledSourcesRef.current.size === 0) playbackRateRef.current = 1;
    }, { once: true });
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime, nextStartRef.current);
    source.start(startAt);
    playbackRateRef.current = playbackRate;
    nextStartRef.current = startAt + buffer.duration / playbackRate;
  }, [onPlaybackBlocked, onQueueRestart, restartQueue]);

  useEffect(() => clear, [clear]);
  return { clear, enable, enqueue, isEnabled, restartQueue };
}

export function ViewerStage({ sessionType, outputMode, captions, speakers, status, sessionStatus = "live", isAudioEnabled, floorHolder = null }: {
  sessionType: LiveSessionType;
  outputMode: LiveOutputMode;
  captions: CaptionEvent[];
  speakers: SpeakerAssignment[];
  status: string;
  sessionStatus?: LiveSessionStatus;
  isAudioEnabled: boolean;
  floorHolder?: string | null;
}) {
  // Newest-first feed: the live edge is the TOP of the history and older
  // captions push downward. Scrolling down reads history without losing the
  // place; a floating jump control returns to the live edge (top).
  const historyRef = useRef<HTMLDivElement>(null);
  const [isPinnedToLatest, setIsPinnedToLatest] = useState(true);
  const finalCaptions = captions.filter((caption) => caption.isFinal);
  const partialCaptions = captions.filter((caption) => !caption.isFinal);
  const orderedFinalCaptions = newestFirst(finalCaptions);
  const latestFinalSeq = finalCaptions.at(-1)?.seq ?? 0;
  const latestPartialText = partialCaptions.at(-1)?.text ?? "";

  useEffect(() => {
    if (!isPinnedToLatest) return;
    const history = historyRef.current;
    if (history) history.scrollTop = 0;
  }, [latestFinalSeq, latestPartialText, isPinnedToLatest]);

  const handleHistoryScroll = useCallback(() => {
    const history = historyRef.current;
    if (!history) return;
    setIsPinnedToLatest(isPinnedNearTop(history.scrollTop));
  }, []);

  const returnToLatest = useCallback(() => {
    const history = historyRef.current;
    if (history) history.scrollTop = 0;
    setIsPinnedToLatest(true);
  }, []);
  const isAudioOnly = outputMode === "audio";
  const hasAudio = outputMode !== "captions";
  const deliveryMethod = getDeliveryMethod(sessionType, outputMode);
  const lifecycleLabel = sessionStatus === "live"
    ? "Live now"
    : sessionStatus === "paused" ? "Paused by host" : "Live unavailable";
  return (
    <div className="live-viewer-stage">
      <div className="live-viewer-stage-header">
        <span className="live-eyebrow">{sessionType === "presentation" ? "Presentation" : "Meeting"} · {outputMode === "captions"
          ? "Captions"
          : outputMode === "captions_audio" ? "Captions + translated audio" : "Translated audio"}</span>
        <span className="live-connection-state" role="status" aria-live="polite">
          <span className={`live-status-dot ${sessionStatus === "live" ? "is-live" : ""}`} aria-hidden="true" />
          {lifecycleLabel}
          <span className="sr-only"> · Connection: {status}</span>
        </span>
      </div>
      {isAudioOnly ? (
        <div className="live-audio-only-state">
          <span className="live-audio-bars" aria-hidden="true"><i /><i /><i /><i /></span>
          <strong>{isAudioEnabled ? `${deliveryMethod.title} playing` : `${deliveryMethod.title} ready`}</strong>
          <p>{deliveryMethod.description} Audio stays muted until you choose Audio On.</p>
        </div>
      ) : sessionType === "meeting" ? (
        <MeetingTurnFeed captions={captions} floorHolder={floorHolder}
          emptyMessage="Speaker chapters will appear here when the meeting starts." />
      ) : (
        <div className="live-caption-stack">
          {finalCaptions.length === 0 && partialCaptions.length === 0
            ? <p className="live-empty-caption">Waiting for the host to start.</p>
            : null}
          <div className="live-caption-current" aria-live="off" aria-label="Caption currently updating">
            {partialCaptions.map((caption) => (
              <SpeakerCaption key={`partial-${captionLaneKey(caption)}`} caption={caption} active />
            ))}
          </div>
          <div ref={historyRef} className="live-caption-history is-scrollable" aria-live="polite"
            aria-relevant="additions" onScroll={handleHistoryScroll}>
            {orderedFinalCaptions.map((caption, index) => (
              <SpeakerCaption key={`final-${caption.seq}`} caption={caption} active={partialCaptions.length === 0 && index === 0} />
            ))}
          </div>
          {!isPinnedToLatest && (
            <button type="button" className="live-jump-latest" onClick={returnToLatest}
              aria-label="Return to the latest caption">
              최신으로
            </button>
          )}
        </div>
      )}
      {hasAudio && !isAudioOnly && <p className="live-audio-consent-state" role="status">{isAudioEnabled ? "Translated audio is on." : "Choose Audio On to hear translated audio."}</p>}
      {speakers.length > 0 && sessionType === "meeting" && (
        <div className="live-viewer-legend" aria-label="Speaker legend">
          {speakers.map((speaker) => <span key={speaker.speakerId}>
            <i style={{ backgroundColor: resolveSpeakerColor(speaker) }} aria-hidden="true" />
            {speaker.label}<i className="live-speaker-line" style={{ backgroundColor: resolveSpeakerColor(speaker) }} aria-hidden="true" />
            <small>Audio · {getSpeakerVoiceStatus(speaker, outputMode)}</small>
          </span>)}
        </div>
      )}
    </div>
  );
}

export function formatSessionSchedule(scheduledAt: string | null): string {
  if (!scheduledAt) return "Live now";
  const timestamp = Date.parse(scheduledAt);
  if (!Number.isFinite(timestamp)) return "Live now";
  // 2026-07-24 fix: Use the product's fixed KST session clock. Locale formatters
  // emit engine-specific punctuation and previously broke WebKit hydration.
  const date = new Date(timestamp + 9 * 60 * 60 * 1_000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hours = date.getUTCHours();
  const displayHours = hours % 12 || 12;
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const period = hours < 12 ? "AM" : "PM";
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()} · ${displayHours}:${minutes} ${period}`;
}

export function ViewerSessionContext({ title, scheduledAt }: { title: string; scheduledAt: string | null }) {
  return (
    <section className="live-viewer-session-context" aria-label="Session details">
      <h1>{title}</h1>
      <p>{formatSessionSchedule(scheduledAt)}</p>
    </section>
  );
}

export default function LiveViewer({ compact = false }: { compact?: boolean }) {
  const [displayName, setDisplayName] = useState("");
  const [department, setDepartment] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [admissionCode, setAdmissionCode] = useState("");
  const [joinMethod, setJoinMethod] = useState<"invite" | "code">("code");
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [language, setLanguage] = useState("");
  const languageRef = useRef("");
  const [captions, setCaptions] = useState<CaptionEvent[]>([]);
  const [speakers, setSpeakers] = useState<SpeakerAssignment[]>([]);
  const [status, setStatus] = useState("Not connected");
  const [floorHolder, setFloorHolder] = useState<LiveFloorHolder | null>(null);
  const [sessionStatus, setSessionStatus] = useState<LiveSessionStatus>("live");
  const [speakerOverlay, setSpeakerOverlay] = useState<{ name: string; department: string; jobTitle: string } | null>(null);
  const [isWaitingCoverUnavailable, setIsWaitingCoverUnavailable] = useState(false);
  const speakerOverlayTimerRef = useRef<number | null>(null);
  const previousFloorKeyRef = useRef<string | null>(null);
  const viewerSessionTypeRef = useRef<LiveSessionType>("presentation");
  const [joinEndedNotice, setJoinEndedNotice] = useState(false);
  const [isSessionEnded, setIsSessionEnded] = useState(false);
  const [summaryRecord, setSummaryRecord] = useState<{ summary: MeetingSummary; createdAt: string } | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [isMinutesLoading, setIsMinutesLoading] = useState(false);
  const isSessionEndedRef = useRef(false);
  const markSessionEndedRef = useRef<() => void>(() => {});
  const [speakState, setSpeakState] = useState<"idle" | "starting" | "speaking">("idle");
  const speakStateRef = useRef<"idle" | "starting" | "speaking">("idle");
  const speakButtonRef = useRef<HTMLButtonElement>(null);
  const speakSessionRef = useRef<SpeakSession | null>(null);
  const preparedSpeakCaptureRef = useRef<PreparedSpeakCapture | null>(null);
  const speakStartTimerRef = useRef<number | null>(null);
  const speakSocketMessageRef = useRef<(event: Record<string, unknown>) => void>(() => {});
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [pendingInviteToken, setPendingInviteToken] = useState("");
  const [hasLeftSession, setHasLeftSession] = useState(false);
  // Caption text size is a continuous scale on a CSS custom property, not a
  // three-step class cycle. The old `.is-text-large`/`.is-text-largest`
  // classes only had CSS under `.is-compact`, so the control silently did
  // nothing on the desktop /watch route.
  const [captionScale, setCaptionScale] = useState(1);
  const [isTextSizeOpen, setIsTextSizeOpen] = useState(false);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  // Contract C11: waiting-room countdown clock. Ticks only while the session
  // is still preparing; reaching zero never auto-starts anything.
  const [waitingClockMs, setWaitingClockMs] = useState(() => Date.now());
  const pipWindowRef = useRef<Window | null>(null);
  const fallbackPipRef = useRef<FallbackPip | null>(null);
  const pipFrameRef = useRef<PipFrame>({ sessionType: "presentation", outputMode: "captions", captions: [], status: "Not connected" });
  const requestedLanguageRef = useRef("");

  useEffect(() => {
    if (!viewer || isSessionEnded || sessionStatus !== "preparing") return;
    setWaitingClockMs(Date.now()); // the mount-time clock may be minutes old by the time the user joins
    const tick = window.setInterval(() => setWaitingClockMs(Date.now()), 1_000);
    return () => window.clearInterval(tick);
  }, [viewer, isSessionEnded, sessionStatus]);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const audioSocketRef = useRef<WebSocket | null>(null);
  const audioPendingSocketRef = useRef<WebSocket | null>(null);
  const audioReconnectTimerRef = useRef<number | null>(null);
  const audioProactiveTimerRef = useRef<number | null>(null);
  const audioConnectionGenerationRef = useRef(0);
  const lastAudioSeqRef = useRef(-1);
  const minimumAudioSeqRef = useRef(-1);
  // Contract C1/C2: caption sequences are monotonic per (session, language)
  // starting at 1. Track lastSeq per language so a reconnect or language
  // toggle can ask the gateway to replay exactly the missed gap.
  const lastSeqByLanguageRef = useRef<Record<string, number>>({});
  const getLastSeq = useCallback((forLanguage: string): number => lastSeqByLanguageRef.current[forLanguage] ?? 0, []);
  const setLastSeq = useCallback((forLanguage: string, seq: number) => {
    const current = lastSeqByLanguageRef.current[forLanguage] ?? 0;
    if (seq > current) lastSeqByLanguageRef.current[forLanguage] = seq;
  }, []);
  const outputModeRef = useRef<LiveOutputMode>("captions");
  const handleEventRef = useRef<(event: LiveBroadcastEvent) => void>(() => {});
  const setCaptionSnapshot = useCallback((snapshot: LiveSnapshot) => {
    const confirmed = snapshot.captions
      .filter((caption) => caption.isFinal)
      .reduce<CaptionEvent[]>((timeline, caption) => mergeCaptionTimeline(timeline, caption), []);
    setCaptions(confirmed);
    setSpeakers(snapshot.speakers);
    setLastSeq(snapshot.language, snapshot.lastSeq);
    setSessionStatus(snapshot.session.status);
  }, [setLastSeq]);
  const handleAudioQueueRestart = useCallback(() => {
    setStatus("Audio restored · receiving live");
    setError("");
  }, []);
  const handleAudioPlaybackBlocked = useCallback(() => {
    setStatus("Audio permission needed");
    setError("Your browser paused audio. Choose Audio On again.");
  }, []);
  const {
    clear: clearInterpretationAudio,
    enable: enableInterpretationAudio,
    enqueue: enqueueInterpretationAudio,
    isEnabled: isInterpretationAudioEnabled,
    restartQueue: restartInterpretationAudio,
  } = useLiveInterpretationAudio(handleAudioQueueRestart, handleAudioPlaybackBlocked);

  const updateSpeakLevel = useCallback((level: number) => {
    const button = speakButtonRef.current;
    if (button) button.dataset.level = String(Math.min(4, Math.ceil(level * 8)));
  }, []);

  const stopSpeakCapture = useCallback(async () => {
    const session = speakSessionRef.current;
    speakSessionRef.current = null;
    const prepared = preparedSpeakCaptureRef.current;
    preparedSpeakCaptureRef.current = null;
    updateSpeakLevel(0);
    await (session?.stop() ?? prepared?.stop())?.catch(() => undefined);
  }, [updateSpeakLevel]);

  const endSpeaking = useCallback(async (sendEnd: boolean) => {
    if (speakStartTimerRef.current !== null) window.clearTimeout(speakStartTimerRef.current);
    speakStartTimerRef.current = null;
    speakStateRef.current = "idle";
    setSpeakState("idle");
    await stopSpeakCapture();
    const socket = audioSocketRef.current;
    if (sendEnd && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "speak-end" }));
  }, [stopSpeakCapture]);

  speakSocketMessageRef.current = (event) => {
    if (event.type === "speak-started") {
      if (speakStateRef.current !== "starting") {
        const lateSocket = audioSocketRef.current;
        if (lateSocket?.readyState === WebSocket.OPEN) {
          lateSocket.send(JSON.stringify({ type: "speak-end" }));
        }
        return;
      }
      if (speakStartTimerRef.current !== null) window.clearTimeout(speakStartTimerRef.current);
      speakStartTimerRef.current = null;
      const socket = audioSocketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        void endSpeaking(true);
        return;
      }
      const prepared = preparedSpeakCaptureRef.current;
      if (!prepared) {
        setError("The microphone was not prepared. Choose Speak again.");
        void endSpeaking(true);
        return;
      }
      void prepared.start(socket, { onLevel: updateSpeakLevel }).then((session) => {
        if (preparedSpeakCaptureRef.current === prepared) preparedSpeakCaptureRef.current = null;
        if (speakStateRef.current !== "starting") {
          void session.stop();
          return;
        }
        speakSessionRef.current = session;
        speakStateRef.current = "speaking";
        setSpeakState("speaking");
      }).catch((captureError: unknown) => {
        if (preparedSpeakCaptureRef.current === prepared) preparedSpeakCaptureRef.current = null;
        if (speakStateRef.current !== "starting") return;
        setError(captureError instanceof SpeakCaptureError
          ? captureError.message
          : "The browser could not start microphone audio.");
        void endSpeaking(true);
      });
      return;
    }
    if (event.type === "speak-ended") {
      const wasActive = speakStateRef.current !== "idle";
      void endSpeaking(false);
      if (wasActive && event.reason === "preempted") setError("Another guest started speaking, so your turn ended.");
      // Synthesized locally by the socket close handler. The gateway releases
      // the floor on close without notifying, and the capture is bound to the
      // dead socket, so without this the button keeps pulsing while every
      // frame is silently dropped.
      if (wasActive && event.reason === "disconnected") setError("Your speaking turn ended when the connection dropped.");
    }
  };

  const toggleSpeak = useCallback(async () => {
    if (speakStateRef.current !== "idle") return;
    const socket = audioSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("Join the live session before speaking.");
      return;
    }
    setError("");
    speakStateRef.current = "starting";
    setSpeakState("starting");
    try {
      const prepared = await prepareSpeakCapture();
      if (speakStateRef.current !== "starting") {
        await prepared.stop();
        return;
      }
      preparedSpeakCaptureRef.current = prepared;
    } catch (captureError: unknown) {
      speakStateRef.current = "idle";
      setSpeakState("idle");
      setError(captureError instanceof SpeakCaptureError
        ? captureError.message
        : "The browser could not prepare microphone audio.");
      return;
    }
    socket.send(JSON.stringify({ type: "speak-start" }));
    speakStartTimerRef.current = window.setTimeout(() => {
      if (speakStateRef.current === "starting") {
        setError("Could not start your turn. Try again.");
        // sendEnd MUST be true here. This is the one abort path where the
        // client cannot know whether the gateway took the floor: if
        // take_live_floor succeeded but speak-started was lost, the gateway
        // still holds this grant and has already broadcast `floor`. Without
        // an explicit speak-end the room shows "X is speaking" forever and
        // host audio stays gated off, so the whole meeting goes silent.
        void endSpeaking(true);
      }
    }, 5_000);
  }, [endSpeaking]);

  const loadMinutes = useCallback(async () => {
    if (!viewer || !languageRef.current) return;
    setIsMinutesLoading(true);
    const headers = { authorization: `Bearer ${viewer.viewerToken}` };
    const language = encodeURIComponent(languageRef.current);
    try {
      const [summaryResult, transcriptResult] = await Promise.allSettled([
        readApi<{ summary: MeetingSummary; createdAt: string }>(await fetch(
          `/api/live-sessions/${viewer.session.id}/summary?language=${language}`, { headers },
        )),
        readApi<{ utterances: TranscriptEntry[] }>(await fetch(
          `/api/live-sessions/${viewer.session.id}/transcript?language=${language}`, { headers },
        )),
      ]);
      if (summaryResult.status === "fulfilled") setSummaryRecord(summaryResult.value);
      if (transcriptResult.status === "fulfilled") setTranscript(transcriptResult.value.utterances);
    } finally {
      setIsMinutesLoading(false);
    }
  }, [viewer]);

  // Contract C7: summaries are generated automatically after End. While the
  // record is not ready (SUMMARY_NOT_READY), poll with exponential backoff
  // (3s → 6s → 12s → … capped at 48s, ~2 minutes total).
  useEffect(() => {
    if (!isSessionEnded || summaryRecord) return;
    let attempt = 0;
    let timer: number | null = null;
    let isDisposed = false;
    const scheduleNext = () => {
      if (isDisposed || attempt >= 6) return;
      const delay = Math.min(3_000 * 2 ** attempt, 48_000);
      timer = window.setTimeout(() => {
        attempt += 1;
        void loadMinutes().finally(() => { if (!isDisposed) scheduleNext(); });
      }, delay);
    };
    scheduleNext();
    return () => {
      isDisposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [isSessionEnded, loadMinutes, summaryRecord]);

  // 호스트가 라이브를 종료하면 뷰어는 에러가 아니라 회의록 화면으로 전환합니다.
  markSessionEndedRef.current = () => {
    if (isSessionEndedRef.current) return;
    isSessionEndedRef.current = true;
    setIsSessionEnded(true);
    setFloorHolder(null);
    setError("");
    setStatus("Live ended");
    void endSpeaking(false);
    disconnectGateway();
    void loadMinutes();
  };

  const resolveViewerDisconnect = useCallback(async (currentViewer: ViewerState) => {
    try {
      const result = await readApi<{ status: string }>(await fetch(
        `/api/live-sessions/${currentViewer.session.id}/status`,
        { headers: { authorization: `Bearer ${currentViewer.viewerToken}` }, cache: "no-store" },
      ));
      if (result.status === "stopped") {
        markSessionEndedRef.current();
        return true;
      }
    } catch {
      // 상태 확인 실패는 기존 권한 만료 안내로 폴백합니다.
    }
    return false;
  }, []);

  // Lifecycle fallback poll: gateway broadcasts can be missed across
  // reconnects, which stranded viewers on the waiting screen after Go-Live
  // and left them without an "ended" notice after the host stopped. The REST
  // status route is participant-authorized and works post-stop.
  // While waiting for go-live the poll tightens to 2.5s so viewers who missed
  // the gateway's session-status push still enter within a couple of seconds.
  useEffect(() => {
    if (!viewer) return;
    // Stop once the session has ended. `viewer` is deliberately kept after the
    // end so the minutes screen can read it, so without this guard the poll ran
    // forever — and every tick re-issued the 30-day recap cookie and burned a
    // service-role read. A participant leaving the minutes tab open overnight
    // made thousands of pointless requests.
    if (isSessionEnded) return;
    const poll = window.setInterval(() => {
      void (async () => {
        try {
          const result = await readApi<{ status: string }>(await fetch(
            `/api/live-sessions/${viewer.session.id}/status`,
            { headers: { authorization: `Bearer ${viewer.viewerToken}` }, cache: "no-store" },
          ));
          if (result.status === "stopped") {
            markSessionEndedRef.current();
            return;
          }
          if (result.status === "live" || result.status === "paused" || result.status === "preparing") {
            setSessionStatus((current) => current === result.status ? current : result.status as "live" | "paused" | "preparing");
          }
        } catch {
          // Transient failures fall back to the next tick; the gateway path
          // remains the primary signal.
        }
      })();
    }, sessionStatus === "preparing" ? 2_500 : 10_000);
    return () => window.clearInterval(poll);
  }, [viewer, sessionStatus, isSessionEnded]);

  const sessionType = viewer?.session.sessionType ?? "presentation";
  viewerSessionTypeRef.current = sessionType;
  const outputMode = viewer?.session.outputMode ?? "captions";
  const hasAudio = outputMode !== "captions";
  const deliveryMethod = getDeliveryMethod(sessionType, outputMode);
  const languages = viewer?.session.languages ?? [];
  outputModeRef.current = outputMode;
  pipFrameRef.current = { sessionType, outputMode, captions, status };

  const disconnectGateway = useCallback(() => {
    audioConnectionGenerationRef.current += 1;
    if (audioReconnectTimerRef.current !== null) window.clearTimeout(audioReconnectTimerRef.current);
    if (audioProactiveTimerRef.current !== null) window.clearTimeout(audioProactiveTimerRef.current);
    audioReconnectTimerRef.current = null;
    audioProactiveTimerRef.current = null;
    const socket = audioSocketRef.current;
    audioSocketRef.current = null;
    const pendingSocket = audioPendingSocketRef.current;
    audioPendingSocketRef.current = null;
    pendingSocket?.close(1000, "language changed");
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "unsubscribe" }));
    socket?.close(1000, "language changed");
    lastAudioSeqRef.current = -1;
    minimumAudioSeqRef.current = -1;
    clearInterpretationAudio();
  }, [clearInterpretationAudio]);

  const connectGateway = useCallback(async (currentViewer: ViewerState, nextLanguage: string) => {
    if (!LIVE_GATEWAY_URL) throw new Error("The live gateway is not configured.");
    const generation = audioConnectionGenerationRef.current;
    let reconnectAttempt = 0;
    let connectionPromise: Promise<void> | null = null;
    let hasConnected = false;

    const reportConnectionError = (connectionError: unknown) => {
      setError(connectionError instanceof Error ? connectionError.message : "Unable to reconnect to the live session.");
    };

    const scheduleReconnect = () => {
      if (generation !== audioConnectionGenerationRef.current
        || audioReconnectTimerRef.current !== null
        || connectionPromise !== null) return;
      const delayMilliseconds = getReconnectDelayMilliseconds(reconnectAttempt);
      reconnectAttempt += 1;
      setStatus(getReconnectStatus(delayMilliseconds));
      audioReconnectTimerRef.current = window.setTimeout(() => {
        audioReconnectTimerRef.current = null;
        void installConnection().catch((connectionError: unknown) => {
          reportConnectionError(connectionError);
          scheduleReconnect();
        });
      }, delayMilliseconds);
    };

    const openConnection = async (): Promise<void> => {
      const candidate = new WebSocket(LIVE_GATEWAY_URL);
      audioPendingSocketRef.current = candidate;
      candidate.binaryType = "arraybuffer";
      try {
        await new Promise<void>((resolve, reject) => {
          candidate.addEventListener("open", () => resolve(), { once: true });
          candidate.addEventListener("error", () => reject(new Error("Unable to connect to the live gateway.")), { once: true });
        });
        const subscribed = new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            candidate.close();
            reject(new Error("The live connection timed out."));
          }, 5_000);
          candidate.addEventListener("error", () => {
            window.clearTimeout(timeout);
            reject(new Error("Unable to connect to the live gateway."));
          }, { once: true });
          candidate.addEventListener("message", (message) => {
            if (message.data instanceof ArrayBuffer) {
              if (outputModeRef.current === "captions") return;
              // 내 발언이 통역되는 동안에는 재생하지 않습니다(에코 방지).
              if (speakStateRef.current !== "idle") return;
              try {
                const event = decodeAudioChunk(message.data);
                if (event.header.sessionId === currentViewer.session.id && event.header.language === nextLanguage) {
                  if (event.header.seq <= minimumAudioSeqRef.current || event.header.seq <= lastAudioSeqRef.current) return;
                  lastAudioSeqRef.current = event.header.seq;
                  enqueueInterpretationAudio(event.pcm, event.header.sampleRate);
                }
              } catch {
                setError("Unable to read the translated audio stream.");
              }
              return;
            }
            if (typeof message.data !== "string") return;
            try {
              const event: unknown = JSON.parse(message.data);
              if (!isRecord(event)) return;
              if (event.type === "authenticated") {
                // Contract C2: lastSeq lets the gateway replay the missed gap
                // (replay:true caption events reuse the same dedupe path).
                candidate.send(JSON.stringify({
                  type: "subscribe",
                  sessionId: currentViewer.session.id,
                  language: nextLanguage,
                  lastSeq: getLastSeq(nextLanguage),
                }));
              }
              if (event.type === "subscribed") {
                window.clearTimeout(timeout);
                resolve();
              }
              if (event.type === "live-event") {
                const liveEvent = parseBroadcastEvent(event.payload ?? event.event);
                if (liveEvent) handleEventRef.current(liveEvent);
              }
              if (event.type === "speak-started" || event.type === "speak-ended") speakSocketMessageRef.current(event);
              if (event.type === "error" && typeof event.message === "string") setError(event.message);
            } catch {
              setError("Unable to read a live connection message.");
            }
          });
        });
        candidate.send(JSON.stringify({ type: "authenticate", token: currentViewer.viewerToken }));
        await subscribed;
        if (candidate.readyState !== WebSocket.OPEN) throw new Error("The live connection closed unexpectedly.");
        if (generation !== audioConnectionGenerationRef.current) {
          if (audioPendingSocketRef.current === candidate) audioPendingSocketRef.current = null;
          candidate.close(1000, "stale connection");
          return;
        }
        if (hasConnected) {
          // Snapshot stays as the fallback when replay could not close the gap.
          const snapshot = await readApi<LiveSnapshot>(await fetch(
            `/api/live-sessions/${currentViewer.session.id}/snapshot?language=${encodeURIComponent(nextLanguage)}`,
            { headers: { authorization: `Bearer ${currentViewer.viewerToken}` } },
          ));
          if (snapshot.lastSeq >= getLastSeq(nextLanguage)) {
            setCaptionSnapshot(snapshot);
          }
          setViewer((activeViewer) => activeViewer ? mergeViewerSnapshot(activeViewer, snapshot) : activeViewer);
        }
        hasConnected = true;
        const previous = audioSocketRef.current;
        if (audioPendingSocketRef.current === candidate) audioPendingSocketRef.current = null;
        audioSocketRef.current = candidate;
        previous?.close(1000, "connection refreshed");
        setStatus(outputModeRef.current !== "captions"
          ? "Connected · translated audio"
          : "Connected · live captions");
        // A transient pre-connect failure must not keep the error banner up
        // once the live pipeline is actually flowing.
        setError("");
        const connectedAt = Date.now();
        candidate.addEventListener("close", (event) => {
          if (generation !== audioConnectionGenerationRef.current || audioSocketRef.current !== candidate) return;
          // A closed socket ends the turn no matter why it closed — including
          // the 50-minute proactive refresh below, which closes the socket out
          // from under an active speaker. speak-client binds capture to one
          // socket and drops every frame once it is not OPEN, so the state must
          // be reset here or the mic goes dead while the UI still says live.
          if (speakStateRef.current !== "idle") {
            speakSocketMessageRef.current({ type: "speak-ended", reason: "disconnected" });
          }
          if (event.code === 4401 || event.code === 4403) {
            audioSocketRef.current = null;
            restartInterpretationAudio();
            // 권한 만료가 아니라 호스트가 종료한 경우라면 회의록 화면으로 넘어갑니다.
            void resolveViewerDisconnect(currentViewer).then((didEnd) => {
              if (didEnd) return;
              setStatus("Viewing access expired");
              setError("Your viewing access expired. Scan the host QR code again.");
            });
            return;
          }
          if (Date.now() - connectedAt >= 30_000) reconnectAttempt = 0;
          if (event.code === 4408 || event.reason.includes("SLOW_CONSUMER")) {
            minimumAudioSeqRef.current = lastAudioSeqRef.current;
            restartInterpretationAudio();
            setStatus("Restoring audio · reconnecting");
            audioSocketRef.current = null;
            scheduleReconnect();
            return;
          }
          audioSocketRef.current = null;
          scheduleReconnect();
        });
        if (audioProactiveTimerRef.current !== null) window.clearTimeout(audioProactiveTimerRef.current);
        audioProactiveTimerRef.current = window.setTimeout(() => {
          void installConnection().catch((connectionError: unknown) => {
            reportConnectionError(connectionError);
            scheduleReconnect();
          });
        }, 50 * 60 * 1_000);
      } catch (connectionError) {
        if (audioPendingSocketRef.current === candidate) audioPendingSocketRef.current = null;
        candidate.close();
        throw connectionError;
      }
    };

    const installConnection = async (): Promise<void> => {
      if (connectionPromise) return connectionPromise;
      connectionPromise = openConnection();
      try {
        await connectionPromise;
      } finally {
        connectionPromise = null;
      }
    };

    try {
      await installConnection();
    } catch (connectionError) {
      reportConnectionError(connectionError);
      scheduleReconnect();
    }
  }, [enqueueInterpretationAudio, getLastSeq, resolveViewerDisconnect, restartInterpretationAudio, setCaptionSnapshot]);

  const showSpeakerOverlay = useCallback((holder: LiveFloorHolder) => {
    const name = floorHolderName(holder);
    if (!name) return;
    if (speakerOverlayTimerRef.current !== null) window.clearTimeout(speakerOverlayTimerRef.current);
    setSpeakerOverlay({
      name,
      department: holder.department?.trim() ?? "",
      jobTitle: holder.jobTitle?.trim() ?? "",
    });
    speakerOverlayTimerRef.current = window.setTimeout(() => {
      speakerOverlayTimerRef.current = null;
      setSpeakerOverlay(null);
    }, 4_000);
  }, []);

  useEffect(() => () => {
    if (speakerOverlayTimerRef.current !== null) window.clearTimeout(speakerOverlayTimerRef.current);
  }, []);

  const handleEvent = useCallback((event: LiveBroadcastEvent) => {
    if (event.type === "caption") {
      // A caption can only come from a running host pipeline: if the viewer
      // missed the session-status broadcast (reconnect gap), leave the
      // waiting screen anyway instead of hiding live captions behind it.
      setSessionStatus((current) => current === "preparing" ? "live" : current);
      // Resume bookkeeping is COMMITTED-only (contract C1). Interim captions
      // carry the seq their committed line is ABOUT to take, so running the
      // strict-greater guard over them would raise lastSeq to N and then drop
      // the real final at N — blanking the feed. Interim captions need no seq
      // guard anyway: mergeCaptionTimeline replaces the partial in its lane.
      if (event.isFinal) {
        // Per-language strict-greater guard; seq starts at 1, so 0 means
        // "nothing received yet" and the first caption always passes.
        if (event.seq <= getLastSeq(event.language)) return;
        setLastSeq(event.language, event.seq);
      }
      if (event.language !== languageRef.current) return;
      setCaptions((current) => mergeCaptionTimeline(current, event));
      return;
    }
    if (event.type === "recording-status") {
      if (event.language === languageRef.current) setError(event.message);
      return;
    }
    if (event.type === "speaker-legend") setSpeakers(event.speakers);
    if (event.type === "floor") {
      const holder = event.holder;
      setFloorHolder(holder);
      const holderKey = holder ? `${holder.participantId ?? ""}:${floorHolderName(holder) ?? ""}` : null;
      // Speaker-change overlay is a live-call (meeting/floor) feature only.
      if (holder && holderKey !== previousFloorKeyRef.current
        && viewerSessionTypeRef.current === "meeting") {
        showSpeakerOverlay(holder);
      }
      previousFloorKeyRef.current = holderKey;
    }
    if (event.type === "session-status") {
      setSessionStatus(event.status);
      setStatus(captionConnectionLabel(event.status));
      // Going live supersedes any stale pre-live warning banner.
      if (event.status === "live") setError("");
      if (event.status === "stopped") markSessionEndedRef.current();
    }
    if (event.type === "language-status" && event.language === languageRef.current) setStatus(captionConnectionLabel(event.status));
    if (event.type === "language-removed" && event.language === languageRef.current) setError("The host stopped this language. Choose another language.");
    if (event.type === "audio-control" && event.language === languageRef.current) {
      if (event.seq <= minimumAudioSeqRef.current) return;
      minimumAudioSeqRef.current = Math.max(minimumAudioSeqRef.current, event.seq);
      restartInterpretationAudio();
      if (event.action === "restart") setStatus("Audio restored · receiving live");
    }
    if (event.type === "error") setError(event.message);
  }, [endSpeaking, getLastSeq, restartInterpretationAudio, setLastSeq, showSpeakerOverlay]);
  handleEventRef.current = handleEvent;

  const subscribe = useCallback(async (nextLanguage: string, currentViewer: ViewerState) => {
    // 언어 교체의 순서는 계약입니다: 기존 소켓과 오디오를 먼저 제거하고,
    // 새 스냅샷을 읽은 뒤 새 언어를 구독해 과거 이벤트가 섞이지 않게 합니다.
    await endSpeaking(true);
    disconnectGateway();
    languageRef.current = nextLanguage;
    setCaptions([]);
    setSpeakers([]);
    // Per-language lastSeq memory is kept across language switches so the
    // gateway can replay only the true gap when this language is revisited.
    setStatus("Loading recent captions");

    let snapshot: LiveSnapshot | null = null;
    try {
      snapshot = await readApi<LiveSnapshot>(await fetch(
        `/api/live-sessions/${currentViewer.session.id}/snapshot?language=${encodeURIComponent(nextLanguage)}`,
        { headers: { authorization: `Bearer ${currentViewer.viewerToken}` } },
      ));
    } catch (snapshotError) {
      // Before Go-Live there is nothing to replay; a pre-live snapshot
      // failure must not abort the join (it used to surface as a bogus
      // "grant expired" banner on the waiting screen). Only a session that is
      // definitely running treats snapshot failures as real errors — an
      // absent/unknown status fails safe toward waiting, not toward a banner.
      const sessionStatus = currentViewer.session.status;
      if (sessionStatus === "live" || sessionStatus === "paused") throw snapshotError;
    }
    if (snapshot) {
      setCaptionSnapshot(snapshot);
      const refreshedViewer = mergeViewerSnapshot(currentViewer, snapshot);
      setViewer(refreshedViewer);
      await connectGateway(refreshedViewer, nextLanguage);
      return;
    }
    await connectGateway(currentViewer, nextLanguage);
  }, [connectGateway, disconnectGateway, endSpeaking, setCaptionSnapshot]);

  const join = useCallback(async () => {
    const normalizedDisplayName = normalizeDisplayName(displayName);
    const normalizedDepartment = normalizeProfileField(department);
    const normalizedJobTitle = normalizeProfileField(jobTitle);
    const normalizedAdmissionCode = admissionCode.replace(/\D/gu, "").slice(0, 6);
    if (normalizedDisplayName.length < 1 || normalizedDisplayName.length > 40) {
      setError("Enter a name between 1 and 40 characters.");
      return;
    }
    if (normalizedDepartment.length < 1 || normalizedDepartment.length > 80) {
      setError("Enter a department between 1 and 80 characters.");
      return;
    }
    if (normalizedJobTitle.length < 1 || normalizedJobTitle.length > 100) {
      setError("Enter a job title between 1 and 100 characters.");
      return;
    }
    if (joinMethod === "code" && normalizedAdmissionCode.length !== 6) {
      setError("Enter the 6-digit access code shown by the host.");
      return;
    }
    if (joinMethod === "invite" && !pendingInviteToken) {
      setError("This invite link is invalid. Use the 6-digit access code instead.");
      return;
    }
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      setError("The guest connection is not configured.");
      return;
    }
    setIsBusy(true);
    setError("");
    let hasRedeemedGrant = false;
    try {
      const supabase = supabaseRef.current ?? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, storageKey: "rnw-live-viewer-auth-v1" },
      });
      supabaseRef.current = supabase;
      const existing = await supabase.auth.getSession();
      let accessToken = existing.data.session?.access_token ?? "";
      if (!accessToken) {
        const signedIn = await supabase.auth.signInAnonymously();
        if (signedIn.error || !signedIn.data.session) throw new Error("Unable to start guest access.");
        accessToken = signedIn.data.session.access_token;
      }
      const result = await readApi<unknown>(await fetch("/api/live-sessions/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(joinMethod === "invite" ? { inviteToken: pendingInviteToken } : { admissionCode: normalizedAdmissionCode }),
          displayName: normalizedDisplayName,
          department: normalizedDepartment,
          jobTitle: normalizedJobTitle,
          deviceId: makeDeviceId(),
          accessToken,
        }),
      }));
      if (!isViewerJoinData(result)) throw new Error("The guest join response is invalid.");
      hasRedeemedGrant = true;
      const nextViewer = {
        ...result,
        accessToken,
        displayName: normalizedDisplayName,
        department: normalizedDepartment,
        jobTitle: normalizedJobTitle,
      };
      const requestedLanguage = requestedLanguageRef.current
        || new URLSearchParams(window.location.search).get("language");
      const firstLanguage = requestedLanguage && result.session.languages.includes(requestedLanguage)
        ? requestedLanguage
        : result.session.languages[0];
      if (!firstLanguage) throw new Error("No viewing language is available.");
      setSessionStatus(result.session.status ?? "live");
      setStatus(captionConnectionLabel(result.session.status ?? "live"));
      setViewer(nextViewer);
      setLanguage(firstLanguage);
      languageRef.current = firstLanguage;
      await subscribe(firstLanguage, nextViewer);
    } catch (joinError) {
      if (joinError instanceof ApiRequestError) {
        // A closed admission almost always means the host ended the session:
        // show a proper ended screen instead of a generic join error.
        if (joinError.code === "ADMISSION_CLOSED") {
          setJoinEndedNotice(true);
          return;
        }
        setError(getJoinErrorMessage(joinError));
      } else if (!hasRedeemedGrant) {
        setError("This QR invite is invalid or has expired.");
      } else {
        setError(getJoinErrorMessage(joinError));
      }
    } finally {
      setIsBusy(false);
    }
  }, [admissionCode, department, displayName, jobTitle, joinMethod, pendingInviteToken, subscribe]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    requestedLanguageRef.current = params.get("language") ?? "";
    const inviteToken = takeInviteTokenFromHash();
    if (inviteToken === null) return;
    if (!inviteToken) {
      setError("This QR invite is invalid or has expired.");
      return;
    }
    setPendingInviteToken(inviteToken);
    setJoinMethod("invite");
  }, []);

  const changeLanguage = useCallback(async (nextLanguage: string) => {
    if (!viewer || nextLanguage === language) return;
    languageRef.current = nextLanguage;
    setLanguage(nextLanguage);
    setError("");
    try {
      await subscribe(nextLanguage, viewer);
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : "Unable to change language.");
    }
  }, [language, subscribe, viewer]);

  const openPip = useCallback(async () => {
    const pipApi = (window as Window & { documentPictureInPicture?: { requestWindow(options: { width: number; height: number }): Promise<Window> } }).documentPictureInPicture;
    if (!pipApi) {
      if (!document.pictureInPictureEnabled) {
        setError("Picture in Picture is not available in this browser.");
        return;
      }
      const previous = fallbackPipRef.current;
      if (previous) {
        window.clearInterval(previous.timer);
        for (const track of previous.stream.getTracks()) track.stop();
        previous.video.remove();
      }
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext("2d");
      if (!context) {
        setError("Unable to create the Picture in Picture caption view.");
        return;
      }
      drawFallbackPipFrame(context, pipFrameRef.current);
      const stream = canvas.captureStream(12);
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      video.style.position = "fixed";
      video.style.width = "1px";
      video.style.height = "1px";
      video.style.opacity = "0";
      video.style.pointerEvents = "none";
      document.body.append(video);
      const timer = window.setInterval(() => drawFallbackPipFrame(context, pipFrameRef.current), 100);
      fallbackPipRef.current = { video, stream, timer };
      const cleanFallback = () => {
        const active = fallbackPipRef.current;
        if (!active || active.video !== video) return;
        window.clearInterval(active.timer);
        for (const track of active.stream.getTracks()) track.stop();
        active.video.remove();
        fallbackPipRef.current = null;
      };
      video.addEventListener("leavepictureinpicture", cleanFallback, { once: true });
      try {
        await video.play();
        await video.requestPictureInPicture();
      } catch {
        cleanFallback();
        setError("Unable to open Picture in Picture.");
      }
      return;
    }
    const nextWindow = await pipApi.requestWindow({ width: 720, height: 360 });
    for (const styleSheet of Array.from(document.styleSheets)) {
      if (styleSheet.href) {
        const link = nextWindow.document.createElement("link");
        link.rel = "stylesheet";
        link.href = styleSheet.href;
        nextWindow.document.head.append(link);
      }
    }
    nextWindow.document.body.className = "live-pip-body";
    nextWindow.addEventListener("pagehide", () => {
      pipWindowRef.current = null;
      setPipWindow(null);
    }, { once: true });
    pipWindowRef.current = nextWindow;
    setPipWindow(nextWindow);
  }, []);

  const leaveMeeting = useCallback(async () => {
    const currentViewer = viewer;
    await endSpeaking(true);
    if (currentViewer) {
      try {
        await readApi<unknown>(await fetch(`/api/live-sessions/${currentViewer.session.id}/leave`, {
          method: "POST",
          headers: { authorization: `Bearer ${currentViewer.viewerToken}` },
        }));
      } catch {
        setStatus("Left locally");
      }
    }
    disconnectGateway();
    clearInterpretationAudio();
    pipWindowRef.current?.close();
    setViewer(null);
    setHasLeftSession(true);
    setError("");
  }, [clearInterpretationAudio, disconnectGateway, endSpeaking, viewer]);

  useEffect(() => () => {
    void stopSpeakCapture();
    disconnectGateway();
    pipWindowRef.current?.close();
    const fallback = fallbackPipRef.current;
    if (fallback) {
      window.clearInterval(fallback.timer);
      for (const track of fallback.stream.getTracks()) track.stop();
      fallback.video.remove();
      fallbackPipRef.current = null;
    }
  }, [disconnectGateway, stopSpeakCapture]);

  useEffect(() => {
    if (!viewer || window.parent === window) return;
    window.parent.postMessage({
      type: "realtime-noel-viewer-state",
      sessionType,
      outputMode,
    }, "*");
  }, [outputMode, sessionType, viewer]);

  const floorHolderLabel = floorHolderName(floorHolder);
  const stage = useMemo(() => <ViewerStage sessionType={sessionType} outputMode={outputMode}
    captions={captions} speakers={speakers} status={status} isAudioEnabled={isInterpretationAudioEnabled}
    sessionStatus={sessionStatus} floorHolder={floorHolderLabel} />,
  [captions, floorHolderLabel, isInterpretationAudioEnabled, outputMode, sessionStatus, sessionType, speakers, status]);

  if (hasLeftSession) {
    return (
      <main className={`live-viewer-shell live-viewer-closed ${compact ? "is-compact" : ""}`}>
        <p>You left the meeting.</p>
        {/* Leaving must not be a dead end. A participant who drops mid-call
            returns to this same URL, and re-entering the host's access code
            restores their seat and record. Clearing hasLeftSession with viewer
            still null falls through to the join card, which already supports
            both the invite link and the 6-digit code. This also rescues a
            failed POST /leave, which previously stranded the user here with a
            grant the server never released. */}
        <button type="button" className="live-primary-action" onClick={() => {
          setHasLeftSession(false);
          setError("");
          setStatus("Enter the access code to rejoin");
        }}>
          Rejoin
        </button>
      </main>
    );
  }

  if (joinEndedNotice && !viewer) {
    // Dedicated ended screen for new entrants who reach a finished session.
    return (
      <main className={`live-viewer-shell live-viewer-closed ${compact ? "is-compact" : ""}`}>
        <section className="live-session-ended-screen" role="status">
          <span className="live-minutes-ended-dot" aria-hidden="true" />
          <strong>Live session ended</strong>
          <p>The host has ended this live session. Ask the host for a new invite to join the next one.</p>
          <button type="button" onClick={() => { setJoinEndedNotice(false); setError(""); }}>Back</button>
        </section>
      </main>
    );
  }

  if (!viewer) {
    const hasValidProfile = normalizeDisplayName(displayName).length > 0
      && normalizeProfileField(department).length > 0
      && normalizeProfileField(jobTitle).length > 0;
    const canJoin = hasValidProfile && (joinMethod === "invite"
      ? Boolean(pendingInviteToken)
      : admissionCode.replace(/\D/gu, "").length === 6);
    return (
      <main className={`live-viewer-shell is-join ${compact ? "is-compact" : ""}`}>
        <section className="live-join-card">
            <span className="live-join-wordmark">Realtime Noel</span>
            <h1 className="live-join-heading">Live Call</h1>
            <p className="live-join-lede">
              {joinMethod === "invite"
                ? "You scanned the session QR — no access code needed. Enter your profile to join."
                : "Joining by link — enter your profile and the 6-digit access code from the host."}
            </p>
            <div className="live-join-methods" role="group" aria-label="Join method">
              {pendingInviteToken && (
                <button type="button" aria-pressed={joinMethod === "invite"}
                  className={joinMethod === "invite" ? "is-selected" : ""}
                  onClick={() => { setJoinMethod("invite"); setError(""); }}>
                  Invite link
                </button>
              )}
              <button type="button" aria-pressed={joinMethod === "code"}
                className={joinMethod === "code" ? "is-selected" : ""}
                onClick={() => { setJoinMethod("code"); setError(""); }}>
                Access code
              </button>
            </div>
            <label htmlFor="live-display-name">Your name</label>
            <input id="live-display-name" className="live-name-input" autoComplete="name" maxLength={40} value={displayName}
              onChange={(event) => { setDisplayName(event.target.value); setError(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") void join(); }}
              placeholder="Enter your name" required />
            <label htmlFor="live-department">Department</label>
            <input id="live-department" className="live-name-input" autoComplete="organization-title" maxLength={80} value={department}
              onChange={(event) => { setDepartment(event.target.value); setError(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") void join(); }}
              placeholder="Enter your department" required />
            <label htmlFor="live-job-title">Job title</label>
            <input id="live-job-title" className="live-name-input" autoComplete="organization-title" maxLength={100} value={jobTitle}
              onChange={(event) => { setJobTitle(event.target.value); setError(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") void join(); }}
              placeholder="Enter your job title" required />
            {joinMethod === "code" && (
              <>
                <label htmlFor="live-admission-code">6-digit access code</label>
                <input id="live-admission-code" className="live-code-input" autoComplete="one-time-code" inputMode="numeric"
                  pattern="[0-9]{6}" maxLength={6} value={admissionCode}
                  onChange={(event) => { setAdmissionCode(event.target.value.replace(/\D/gu, "").slice(0, 6)); setError(""); }}
                  onKeyDown={(event) => { if (event.key === "Enter") void join(); }}
                  placeholder="000000" required />
              </>
            )}
            <button type="button" className="live-primary-action"
              disabled={isBusy || !canJoin}
              onClick={() => void join()}>
              {isBusy ? "Joining…" : "Join live"}
            </button>
            <p className="live-join-mic-note">Microphone access is requested only when you choose Speak.</p>
            {error && <div className="live-error" role="alert">{error}</div>}
          </section>
      </main>
    );
  }

  return (
    <main className={`live-viewer-shell ${compact ? "is-compact" : ""}`}
      style={{ "--live-caption-scale": captionScale } as CSSProperties}>
      {/* The top bar keeps only identity and the way out. Reading controls moved
          down to sit directly above the caption record — that is where they are
          used, and it keeps the title as the first thing read. */}
      <header className="glass-pill live-viewer-toolbar">
        <strong>Realtime Noel</strong>
        {/* Translated audio is surfaced ONLY for audio-only sessions, where it is
            the entire product. A caption session is caption-first, so the toggle
            would be noise — but hiding it unconditionally would make an
            `outputMode: "audio"` session unusable, since it has no captions to
            fall back on. The AI-synthetic-interpretation disclosure rides with
            the control, so it stays wherever the control does. */}
        {outputMode === "audio" && (
          <>
            <span id="viewer-delivery-method-description" className="sr-only">{deliveryMethod.description}</span>
            <button type="button" className={isInterpretationAudioEnabled ? "is-selected" : ""}
              aria-pressed={isInterpretationAudioEnabled} disabled={!language} onClick={() => void enableInterpretationAudio()}
              aria-describedby="viewer-delivery-method-description"
              aria-label={isInterpretationAudioEnabled ? "Translated audio is on" : "Turn translated audio on"}>
              {isInterpretationAudioEnabled ? "Audio On" : "Audio Off"}
            </button>
          </>
        )}
        <button type="button" className="live-pip-button" onClick={() => void openPip()} aria-label="Open Picture in Picture">PiP</button>
        <button type="button" className="live-leave-button" aria-label="Leave meeting" onClick={() => void leaveMeeting()}>Leave</button>
      </header>
      <ViewerSessionContext title={viewer.session.title} scheduledAt={viewer.session.scheduledAt} />
      {/* Caption controls: language, then text size, with the session meta label
          trailing. Live Call is caption-first, so translated-audio controls are
          deliberately not surfaced here. One element = one grid cell; the compact
          shell is a fixed-row grid, so a second sibling here would be pushed
          past the caption stage instead of sitting above it. */}
      <div className="live-caption-controls">
        <div className="live-language-switch" role="group" aria-label="Caption language">
          {languages.map((item) => (
            <button key={item} type="button" className={item === language ? "is-selected" : ""}
              aria-pressed={item === language} title={languageLabel(item)}
              onClick={() => void changeLanguage(item)}>
              {item.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="live-text-size">
          <button type="button" className="live-text-size-button"
            aria-expanded={isTextSizeOpen} aria-controls="live-caption-scale"
            aria-label="Caption text size" title="Caption text size"
            onClick={() => setIsTextSizeOpen((open) => !open)}>
            Aa
          </button>
          {/* Kept mounted so the slider keeps its value and stays reachable by
              label; visibility is CSS so no layout jump on open. */}
          <label className={`live-text-size-slider ${isTextSizeOpen ? "is-open" : ""}`}
            hidden={!isTextSizeOpen}>
            <span className="sr-only">Caption text size</span>
            <input id="live-caption-scale" type="range"
              min={CAPTION_SCALE_MIN} max={CAPTION_SCALE_MAX} step={0.1}
              value={captionScale}
              onChange={(event) => setCaptionScale(Number(event.target.value))} />
          </label>
        </div>
        <span className="live-viewer-delivery-method" aria-label={`Current delivery: ${deliveryMethod.title}`}>
          {deliveryMethod.title}
        </span>
      </div>
      {error && <div className="live-error" role="alert">{error}</div>}
      {speakerOverlay && !isSessionEnded && sessionStatus !== "preparing" && (
        <div className="live-speaker-change-overlay" role="status" aria-live="polite">
          <strong>{speakerOverlay.name}</strong>
          {(speakerOverlay.department || speakerOverlay.jobTitle) && (
            <span>{[speakerOverlay.department, speakerOverlay.jobTitle].filter(Boolean).join(" · ")}</span>
          )}
        </div>
      )}
      {isSessionEnded ? (
        <div className="live-ended-view">
          <section className="live-session-ended-banner" role="status" aria-live="assertive">
            <span className="live-minutes-ended-dot" aria-hidden="true" />
            <div>
              <strong>Live session ended</strong>
              <p>The host ended the call. Your meeting record is below.</p>
            </div>
          </section>
          <MeetingMinutes summary={summaryRecord?.summary ?? null} summaryCreatedAt={summaryRecord?.createdAt ?? null}
            transcript={transcript} isLoading={isMinutesLoading} onRetry={() => void loadMinutes()} />
        </div>
      ) : sessionStatus === "preparing" ? (
        <section className="live-waiting-screen" aria-label="Waiting for the host">
          {/* The join redemption payload does not carry hasCoverImage, so the
              waiting room always attempts the cover (public-by-UUID route)
              and simply hides it when the session has none. */}
          {!isWaitingCoverUnavailable && (
            <>
              <img className="live-waiting-cover"
                src={`/api/live-sessions/${viewer.session.id}/cover${viewer.session.coverImageVersion ? `?v=${viewer.session.coverImageVersion}` : ""}`}
                alt="" aria-hidden="true"
                onError={() => setIsWaitingCoverUnavailable(true)} />
              <div className="live-waiting-scrim" aria-hidden="true" />
            </>
          )}
          <h2>{viewer.session.title}</h2>
          <p className="live-waiting-schedule">{formatSessionSchedule(viewer.session.scheduledAt)}</p>
          {(() => {
            const remainingMs = countdownMsUntil(viewer.session.scheduledAt, waitingClockMs);
            return remainingMs !== null && remainingMs > 0 ? (
              <div className="live-waiting-ring" aria-hidden="false">
                <span className="live-loading-ring" aria-hidden="true" />
                <p className="live-waiting-countdown" role="timer" aria-label="Time until the scheduled start">
                  {formatCountdown(remainingMs)}
                </p>
              </div>
            ) : (
              <span className="live-waiting-pulse" aria-hidden="true" />
            );
          })()}
          <strong role="status">Waiting for host</strong>
          <p>The live session has not started yet. Captions begin automatically when the host starts.</p>
          <button type="button" className="live-leave-button" onClick={() => void leaveMeeting()}>Leave</button>
        </section>
      ) : (
        <>
          {sessionStatus === "paused" && (
            <div className="live-paused-banner" role="status">
              <span className="live-status-dot" aria-hidden="true" />
              Paused by host · the session will continue shortly
            </div>
          )}
          {stage}
        </>
      )}
      {sessionType === "meeting" && !isSessionEnded && sessionStatus !== "preparing" && (
        /* Copy-free floor control: the mic button fills the whole bottom bar
           as one press target. While speaking only the button animates like a
           recording indicator — the caption feed stays fully visible. */
        <div className="live-speak-bar">
          <button type="button"
            ref={speakButtonRef}
            className={`live-speak-button ${speakState === "speaking" ? "is-speaking" : ""} ${speakState === "starting" ? "is-starting" : ""}`}
            disabled={!language || speakState === "starting"}
            aria-pressed={speakState === "speaking"}
            aria-label={speakState === "speaking"
              ? "Stop speaking"
              : speakState === "starting" ? "Connecting microphone" : "Start speaking"}
            data-level="0"
            onClick={() => void (speakState === "speaking" ? endSpeaking(true) : toggleSpeak())}>
            <SpeakControlIcon state={speakState} />
          </button>
        </div>
      )}
      <footer className="live-viewer-footer"><span>{viewer.displayName} · {viewer.department} · {viewer.jobTitle}</span><span>{viewer.viewerCount}/{viewer.session.maxViewers} joined · Valid until the host ends this session</span></footer>
      {pipWindow && createPortal(stage, pipWindow.document.body)}
    </main>
  );
}
