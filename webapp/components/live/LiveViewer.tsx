"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { decodeAudioChunk } from "@/lib/live-contract";
import { LANGUAGE_LABELS } from "@/lib/languageDetect";
import type {
  ApiResponse,
  CaptionEvent,
  LiveBroadcastEvent,
  LiveOutputMode,
  LiveSession,
  LiveSessionType,
  LiveSnapshot,
  SpeakerAssignment,
} from "@/lib/live-contract";
import { getReconnectDelayMilliseconds, getReconnectStatus } from "./connection-resilience";
import MeetingTurnFeed from "./MeetingTurnFeed";
import { startSpeakCapture, type SpeakSession } from "./speak-client";
import SpeakerCaption, { resolveSpeakerColor } from "./SpeakerCaption";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const LIVE_GATEWAY_URL = process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL ?? "";
const DEVICE_STORAGE_KEY = "rnw-live-viewer-device-v1";
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
    sessionType: LiveSessionType;
    outputMode: LiveOutputMode;
    maxViewers: number;
    languages: string[];
    expiresAt: string;
  };
  viewerCount: number;
}

interface ViewerState extends ViewerJoinData {
  accessToken: string;
  displayName: string;
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
    ? "자막"
    : frame.outputMode === "captions_audio" ? "자막 + AI 합성 통역 음성" : "AI 합성 통역 음성";
  context.fillText(`${frame.sessionType.toUpperCase()} · ${outputLabel} · ${frame.status}`, 56, 62);

  if (isAudioOnly) {
    context.fillStyle = "#ffffff";
    context.font = "600 58px Pretendard, sans-serif";
    context.fillText("AI 합성 통역 음성 재생 중", 56, 330);
    return;
  }

  const caption = frame.captions.at(-1);
  if (!caption) {
    context.fillStyle = "#a8a29e";
    context.font = "500 34px Inter, sans-serif";
    context.fillText("자막을 기다리고 있습니다.", 56, 330);
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
  context.fillText(caption.speaker?.label ?? "발표자", 116, 171);
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
      sessionType: snapshot.session.sessionType,
      outputMode: snapshot.session.outputMode,
      maxViewers: snapshot.session.maxViewers,
      languages: snapshot.session.languages,
      expiresAt: snapshot.session.expiresAt,
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
  if (outputMode === "captions") return "자막 전용";
  const voiceStatus: unknown = speaker.voiceStatus;
  if (voiceStatus === undefined) return speaker.voiceName ? `음색 배정 완료 · ${speaker.voiceName}` : "자동 분석 중";
  if (voiceStatus === "ready") return speaker.voiceName ? `음색 배정 완료 · ${speaker.voiceName}` : "음색 배정 완료";
  if (voiceStatus === "unavailable") return "사용 불가";
  if (voiceStatus === "disabled") return "자막 전용";
  return "자동 분석 중";
}

function getDeliveryMethod(sessionType: LiveSessionType, outputMode: LiveOutputMode): { title: string; description: string } {
  if (sessionType === "presentation") {
    return outputMode === "captions"
      ? { title: "빠른 실시간 자막", description: "말하는 동안 선택한 언어의 자막을 빠르게 표시합니다." }
      : { title: "안정적인 AI 음성 · 단일 발표자 최적화", description: "문장이 완성되는 대로 일정한 AI 음성으로 재생합니다." };
  }
  return outputMode === "captions"
    ? { title: "화자 구분 자막 · 발화 종료 후 표시", description: "발화가 끝나면 화자를 구분해 번역 자막을 표시합니다." }
    : { title: "화자 구분 · 발화 종료 후 출력", description: "발화가 끝난 뒤 통역 음성을 재생합니다. 장문 무정지 발화에서는 지연될 수 있습니다." };
}

function captionConnectionLabel(status: "preparing" | "live" | "stopped" | "failed" | "ready" | "unavailable"): string {
  if (status === "live" || status === "ready") return "실시간 연결";
  if (status === "preparing") return "자막 준비 중";
  if (status === "stopped") return "라이브가 종료됐습니다";
  if (status === "unavailable") return "이 언어는 잠시 사용할 수 없습니다";
  return "연결을 확인해주세요";
}

function isViewerJoinData(value: unknown): value is ViewerJoinData {
  if (!isRecord(value) || !isRecord(value.grant) || !isRecord(value.session)) return false;
  return typeof value.viewerToken === "string"
    && typeof value.grant.id === "string"
    && typeof value.grant.sessionId === "string"
    && typeof value.grant.userId === "string"
    && typeof value.grant.expiresAt === "string"
    && typeof value.session.id === "string"
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
    && (value.voiceStatus === undefined || value.voiceStatus === "disabled" || value.voiceStatus === "analyzing"
      || value.voiceStatus === "ready" || value.voiceStatus === "unavailable");
}

function isControlEvent(value: unknown): value is Exclude<LiveBroadcastEvent, CaptionEvent> {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.type !== "string") return false;
  if (value.type === "session-status") {
    return value.status === "preparing" || value.status === "live" || value.status === "stopped" || value.status === "failed";
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
    return value.holder === null
      || (isRecord(value.holder) && typeof value.holder.displayName === "string");
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

function parseBroadcastEvent(value: unknown): LiveBroadcastEvent | null {
  if (isCaptionEvent(value)) return value;
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

function getJoinErrorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return error instanceof Error ? error.message : "라이브에 입장할 수 없습니다.";
  if (error.code === "CAPACITY_REACHED" || error.code === "SESSION_FULL") {
    return "참여 정원이 가득 찼습니다. 호스트에게 정원 변경을 요청하세요.";
  }
  if (error.code === "ADMISSION_CLOSED" || error.code === "ADMISSION_EXPIRED" || error.code === "INVITE_EXPIRED") {
    return "입장창이 닫혔거나 초대가 만료되었습니다. 호스트에게 새 초대를 요청하세요.";
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
  if (isDuplicateFinal) return current.filter((caption) => caption.isFinal || captionLaneKey(caption) !== lane);

  const existingPartial = current.find((caption) => !caption.isFinal && captionLaneKey(caption) === lane);
  if (!incoming.isFinal && existingPartial?.seq === incoming.seq
    && normalizeCaptionText(existingPartial.text) === normalizedText) return current;

  const withoutCurrentPartial = current.filter((caption) => caption.isFinal || captionLaneKey(caption) !== lane);
  return [...withoutCurrentPartial, incoming].slice(-60);
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
    if (context.state !== "running") throw new Error("통역 음성 재생 권한이 필요합니다. 재생 버튼을 다시 눌러주세요.");
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

function ViewerStage({ sessionType, outputMode, captions, speakers, status, isAudioEnabled, floorHolder = null }: {
  sessionType: LiveSessionType;
  outputMode: LiveOutputMode;
  captions: CaptionEvent[];
  speakers: SpeakerAssignment[];
  status: string;
  isAudioEnabled: boolean;
  floorHolder?: string | null;
}) {
  const finalCaptions = captions.filter((caption) => caption.isFinal).slice(-8);
  const partialCaptions = captions.filter((caption) => !caption.isFinal);
  const isAudioOnly = outputMode === "audio";
  const hasAudio = outputMode !== "captions";
  const deliveryMethod = getDeliveryMethod(sessionType, outputMode);
  return (
    <div className="live-viewer-stage">
      <div className="live-viewer-stage-header">
        <span className="live-eyebrow">{sessionType === "presentation" ? "Presentation" : "Meeting"} · {outputMode === "captions"
          ? "자막"
          : outputMode === "captions_audio" ? "자막 + AI 합성 통역 음성" : "AI 합성 통역 음성"}</span>
        <span className="live-connection-state" role="status" aria-live="polite"><span className="live-status-dot is-live" aria-hidden="true" />{status}</span>
      </div>
      {isAudioOnly ? (
        <div className="live-audio-only-state">
          <span className="live-audio-bars" aria-hidden="true"><i /><i /><i /><i /></span>
          <strong>{isAudioEnabled ? `${deliveryMethod.title} 재생 중` : `${deliveryMethod.title} 재생 대기`}</strong>
          <p>{deliveryMethod.description} 사용자가 재생 버튼을 누르기 전에는 음소거되며, 이 출력에서는 자막을 표시하지 않습니다.</p>
        </div>
      ) : sessionType === "meeting" ? (
        <MeetingTurnFeed captions={captions} floorHolder={floorHolder}
          emptyMessage="참가자가 말하면 화자별 발언 기록이 여기에 쌓입니다." />
      ) : (
        <div className="live-caption-stack">
          {finalCaptions.length === 0 && partialCaptions.length === 0
            ? <p className="live-empty-caption">호스트가 말하면 선택한 언어의 자막이 표시됩니다.</p>
            : null}
          <div className="live-caption-history" aria-live="polite" aria-relevant="additions">
            {finalCaptions.map((caption, index) => (
              <SpeakerCaption key={`final-${caption.seq}`} caption={caption} active={partialCaptions.length === 0 && index === finalCaptions.length - 1} />
            ))}
          </div>
          <div className="live-caption-current" aria-live="off" aria-label="현재 작성 중인 자막">
            {partialCaptions.map((caption) => (
              <SpeakerCaption key={`partial-${captionLaneKey(caption)}`} caption={caption} active />
            ))}
          </div>
        </div>
      )}
      {hasAudio && !isAudioOnly && <p className="live-audio-consent-state" role="status">{isAudioEnabled ? "AI 합성 통역 음성을 재생하고 있습니다." : "통역 음성은 위의 재생 버튼을 누른 뒤에만 시작됩니다."}</p>}
      {speakers.length > 0 && sessionType === "meeting" && (
        <div className="live-viewer-legend" aria-label="화자 범례">
          {speakers.map((speaker) => <span key={speaker.speakerId}>
            <i style={{ backgroundColor: resolveSpeakerColor(speaker) }} aria-hidden="true" />
            {speaker.label}<i className="live-speaker-line" style={{ backgroundColor: resolveSpeakerColor(speaker) }} aria-hidden="true" />
            <small>음성 · {getSpeakerVoiceStatus(speaker, outputMode)}</small>
          </span>)}
        </div>
      )}
    </div>
  );
}

export default function LiveViewer({ compact = false }: { compact?: boolean }) {
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [language, setLanguage] = useState("");
  const languageRef = useRef("");
  const [captions, setCaptions] = useState<CaptionEvent[]>([]);
  const [speakers, setSpeakers] = useState<SpeakerAssignment[]>([]);
  const [status, setStatus] = useState("연결 전");
  const [floorHolder, setFloorHolder] = useState<string | null>(null);
  const [speakState, setSpeakState] = useState<"idle" | "starting" | "speaking">("idle");
  const speakStateRef = useRef<"idle" | "starting" | "speaking">("idle");
  const speakSessionRef = useRef<SpeakSession | null>(null);
  const speakStartTimerRef = useRef<number | null>(null);
  const speakSocketMessageRef = useRef<(event: Record<string, unknown>) => void>(() => {});
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [pendingInviteToken, setPendingInviteToken] = useState("");
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const pipWindowRef = useRef<Window | null>(null);
  const fallbackPipRef = useRef<FallbackPip | null>(null);
  const pipFrameRef = useRef<PipFrame>({ sessionType: "presentation", outputMode: "captions", captions: [], status: "연결 전" });
  const autoJoinRef = useRef(false);
  const shouldAutoJoinRef = useRef(false);
  const requestedLanguageRef = useRef("");
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const audioSocketRef = useRef<WebSocket | null>(null);
  const audioPendingSocketRef = useRef<WebSocket | null>(null);
  const audioReconnectTimerRef = useRef<number | null>(null);
  const audioProactiveTimerRef = useRef<number | null>(null);
  const audioConnectionGenerationRef = useRef(0);
  const lastAudioSeqRef = useRef(-1);
  const minimumAudioSeqRef = useRef(-1);
  const lastSeqRef = useRef(0);
  const outputModeRef = useRef<LiveOutputMode>("captions");
  const handleEventRef = useRef<(event: LiveBroadcastEvent) => void>(() => {});
  const setCaptionSnapshot = useCallback((snapshot: LiveSnapshot) => {
    const confirmed = snapshot.captions
      .filter((caption) => caption.isFinal)
      .reduce<CaptionEvent[]>((timeline, caption) => mergeCaptionTimeline(timeline, caption), []);
    setCaptions(confirmed);
    setSpeakers(snapshot.speakers);
    lastSeqRef.current = snapshot.lastSeq;
  }, []);
  const handleAudioQueueRestart = useCallback(() => {
    setStatus("통역 음성 자동 복구 · 계속 수신 중");
    setError("");
  }, []);
  const handleAudioPlaybackBlocked = useCallback(() => {
    setStatus("통역 음성 재생 동의 필요");
    setError("출력 장치 또는 브라우저가 음성 재생을 멈췄습니다. 재생 버튼을 다시 눌러주세요.");
  }, []);
  const {
    clear: clearInterpretationAudio,
    enable: enableInterpretationAudio,
    enqueue: enqueueInterpretationAudio,
    isEnabled: isInterpretationAudioEnabled,
    restartQueue: restartInterpretationAudio,
  } = useLiveInterpretationAudio(handleAudioQueueRestart, handleAudioPlaybackBlocked);

  const stopSpeakCapture = useCallback(async () => {
    const session = speakSessionRef.current;
    speakSessionRef.current = null;
    await session?.stop().catch(() => undefined);
  }, []);

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
      if (speakStateRef.current !== "starting") return;
      if (speakStartTimerRef.current !== null) window.clearTimeout(speakStartTimerRef.current);
      speakStartTimerRef.current = null;
      const socket = audioSocketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        void endSpeaking(true);
        return;
      }
      void startSpeakCapture(socket).then((session) => {
        if (speakStateRef.current !== "starting") {
          void session.stop();
          return;
        }
        speakSessionRef.current = session;
        speakStateRef.current = "speaking";
        setSpeakState("speaking");
      }).catch(() => {
        setError("마이크를 사용할 수 없습니다. 브라우저의 마이크 권한을 확인하세요.");
        void endSpeaking(true);
      });
      return;
    }
    if (event.type === "speak-ended") {
      const wasActive = speakStateRef.current !== "idle";
      void endSpeaking(false);
      if (wasActive && event.reason === "preempted") setError("다른 참가자가 발언을 시작해 내 발언이 종료되었습니다.");
    }
  };

  const toggleSpeak = useCallback(async () => {
    if (speakStateRef.current !== "idle") {
      await endSpeaking(true);
      return;
    }
    const socket = audioSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("라이브에 연결된 뒤에 발언할 수 있습니다.");
      return;
    }
    setError("");
    speakStateRef.current = "starting";
    setSpeakState("starting");
    socket.send(JSON.stringify({ type: "speak-start" }));
    speakStartTimerRef.current = window.setTimeout(() => {
      if (speakStateRef.current === "starting") {
        setError("발언권을 가져오지 못했습니다. 잠시 후 다시 시도하세요.");
        void endSpeaking(false);
      }
    }, 5_000);
  }, [endSpeaking]);

  const sessionType = viewer?.session.sessionType ?? "presentation";
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
    if (!LIVE_GATEWAY_URL) throw new Error("라이브 게이트웨이가 설정되지 않았습니다.");
    const generation = audioConnectionGenerationRef.current;
    let reconnectAttempt = 0;
    let connectionPromise: Promise<void> | null = null;
    let hasConnected = false;

    const reportConnectionError = (connectionError: unknown) => {
      setError(connectionError instanceof Error ? connectionError.message : "라이브를 다시 연결할 수 없습니다.");
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
          candidate.addEventListener("error", () => reject(new Error("라이브 게이트웨이에 연결할 수 없습니다.")), { once: true });
        });
        const subscribed = new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            candidate.close();
            reject(new Error("라이브 연결 시간이 초과됐습니다."));
          }, 5_000);
          candidate.addEventListener("error", () => {
            window.clearTimeout(timeout);
            reject(new Error("라이브 게이트웨이에 연결할 수 없습니다."));
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
                setError("통역 음성 프레임을 읽을 수 없습니다.");
              }
              return;
            }
            if (typeof message.data !== "string") return;
            try {
              const event: unknown = JSON.parse(message.data);
              if (!isRecord(event)) return;
              if (event.type === "authenticated") {
                candidate.send(JSON.stringify({ type: "subscribe", sessionId: currentViewer.session.id, language: nextLanguage }));
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
              setError("라이브 연결 메시지를 읽을 수 없습니다.");
            }
          });
        });
        candidate.send(JSON.stringify({ type: "authenticate", token: currentViewer.viewerToken }));
        await subscribed;
        if (candidate.readyState !== WebSocket.OPEN) throw new Error("라이브 연결이 구독 직후 종료됐습니다.");
        if (generation !== audioConnectionGenerationRef.current) {
          if (audioPendingSocketRef.current === candidate) audioPendingSocketRef.current = null;
          candidate.close(1000, "stale connection");
          return;
        }
        if (hasConnected) {
          const snapshot = await readApi<LiveSnapshot>(await fetch(
            `/api/live-sessions/${currentViewer.session.id}/snapshot?language=${encodeURIComponent(nextLanguage)}`,
            { headers: { authorization: `Bearer ${currentViewer.viewerToken}` } },
          ));
          if (snapshot.lastSeq >= lastSeqRef.current) {
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
          ? "연결됨 · AI 합성 통역 음성"
          : "연결됨 · 실시간 자막");
        const connectedAt = Date.now();
        candidate.addEventListener("close", (event) => {
          if (generation !== audioConnectionGenerationRef.current || audioSocketRef.current !== candidate) return;
          if (event.code === 4401 || event.code === 4403) {
            audioSocketRef.current = null;
            restartInterpretationAudio();
            setStatus("통역 음성 인증 만료");
            setError("시청 권한이 만료됐습니다. 세션에 다시 입장해주세요.");
            return;
          }
          if (Date.now() - connectedAt >= 30_000) reconnectAttempt = 0;
          if (event.code === 4408 || event.reason.includes("SLOW_CONSUMER")) {
            minimumAudioSeqRef.current = lastAudioSeqRef.current;
            restartInterpretationAudio();
            setStatus("통역 음성 자동 복구 · 다시 연결 중");
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
  }, [enqueueInterpretationAudio, restartInterpretationAudio, setCaptionSnapshot]);

  const handleEvent = useCallback((event: LiveBroadcastEvent) => {
    if (event.type === "caption") {
      if (event.seq <= lastSeqRef.current) return;
      lastSeqRef.current = event.seq;
      setCaptions((current) => mergeCaptionTimeline(current, event));
      return;
    }
    if (event.type === "speaker-legend") setSpeakers(event.speakers);
    if (event.type === "floor") setFloorHolder(event.holder?.displayName ?? null);
    if (event.type === "session-status") setStatus(captionConnectionLabel(event.status));
    if (event.type === "language-status" && event.language === languageRef.current) setStatus(captionConnectionLabel(event.status));
    if (event.type === "language-removed" && event.language === languageRef.current) setError("호스트가 이 언어를 종료했습니다. 다른 언어를 선택하세요.");
    if (event.type === "audio-control" && event.language === languageRef.current) {
      if (event.seq <= minimumAudioSeqRef.current) return;
      minimumAudioSeqRef.current = Math.max(minimumAudioSeqRef.current, event.seq);
      restartInterpretationAudio();
      if (event.action === "restart") setStatus("통역 음성 자동 복구 · 계속 수신 중");
    }
    if (event.type === "error") setError(event.message);
  }, [restartInterpretationAudio]);
  handleEventRef.current = handleEvent;

  const subscribe = useCallback(async (nextLanguage: string, currentViewer: ViewerState) => {
    // 언어 교체의 순서는 계약입니다: 기존 소켓과 오디오를 먼저 제거하고,
    // 새 스냅샷을 읽은 뒤 새 언어를 구독해 과거 이벤트가 섞이지 않게 합니다.
    await endSpeaking(true);
    disconnectGateway();
    languageRef.current = nextLanguage;
    setCaptions([]);
    setSpeakers([]);
    lastSeqRef.current = 0;
    setStatus("최근 자막을 불러오는 중");

    const snapshot = await readApi<LiveSnapshot>(await fetch(
      `/api/live-sessions/${currentViewer.session.id}/snapshot?language=${encodeURIComponent(nextLanguage)}`,
      { headers: { authorization: `Bearer ${currentViewer.viewerToken}` } },
    ));
    setCaptionSnapshot(snapshot);
    const refreshedViewer = mergeViewerSnapshot(currentViewer, snapshot);
    setViewer(refreshedViewer);
    await connectGateway(refreshedViewer, nextLanguage);
  }, [connectGateway, disconnectGateway, endSpeaking, setCaptionSnapshot]);

  const join = useCallback(async (inviteToken?: string) => {
    const normalized = code.replace(/\D/g, "").slice(0, 6);
    const normalizedDisplayName = normalizeDisplayName(displayName);
    if (normalizedDisplayName.length < 1 || normalizedDisplayName.length > 40) {
      setError("표시할 이름을 1자 이상 40자 이하로 입력하세요.");
      return;
    }
    if (!inviteToken && normalized.length !== 6) {
      setError("6자리 인증번호를 입력하세요.");
      return;
    }
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      setError("시청자 연결 환경이 설정되지 않았습니다.");
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
        if (signedIn.error || !signedIn.data.session) throw new Error("익명 시청자 인증을 시작할 수 없습니다.");
        accessToken = signedIn.data.session.access_token;
      }
      const result = await readApi<unknown>(await fetch("/api/live-sessions/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: inviteToken
          ? JSON.stringify({ inviteToken, displayName: normalizedDisplayName, deviceId: makeDeviceId(), accessToken })
          : JSON.stringify({ code: normalized, displayName: normalizedDisplayName, deviceId: makeDeviceId(), accessToken }),
      }));
      if (!isViewerJoinData(result)) throw new Error("시청자 입장 응답이 올바르지 않습니다.");
      hasRedeemedGrant = true;
      const nextViewer = { ...result, accessToken, displayName: normalizedDisplayName };
      const requestedLanguage = requestedLanguageRef.current
        || new URLSearchParams(window.location.search).get("language");
      const firstLanguage = requestedLanguage && result.session.languages.includes(requestedLanguage)
        ? requestedLanguage
        : result.session.languages[0];
      if (!firstLanguage) throw new Error("시청 가능한 언어가 없습니다.");
      setViewer(nextViewer);
      setLanguage(firstLanguage);
      languageRef.current = firstLanguage;
      await subscribe(firstLanguage, nextViewer);
    } catch (joinError) {
      if (joinError instanceof ApiRequestError) {
        setError(getJoinErrorMessage(joinError));
      } else if (inviteToken && !hasRedeemedGrant) {
        setError("초대 링크가 올바르지 않거나 만료되었습니다. 6자리 인증번호로 입장할 수 있습니다.");
      } else {
        setError(getJoinErrorMessage(joinError));
      }
    } finally {
      setIsBusy(false);
    }
  }, [code, displayName, subscribe]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    requestedLanguageRef.current = params.get("language") ?? "";
    const inviteToken = takeInviteTokenFromHash();
    if (inviteToken === null) return;
    if (!inviteToken) {
      setError("초대 링크가 올바르지 않거나 만료되었습니다. 6자리 인증번호로 입장할 수 있습니다.");
      return;
    }
    setPendingInviteToken(inviteToken);
  }, []);

  useEffect(() => {
    const receiveExtensionJoin = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || !/^chrome-extension:\/\/[a-p]{32}$/u.test(event.origin)) return;
      if (!isRecord(event.data) || event.data.type !== "realtime-noel-viewer-join") return;
      const admissionCode = typeof event.data.code === "string" ? event.data.code.replace(/\D/g, "").slice(0, 6) : "";
      const nextDisplayName = typeof event.data.displayName === "string" ? normalizeDisplayName(event.data.displayName).slice(0, 40) : "";
      const requestedLanguage = typeof event.data.language === "string" ? event.data.language : "";
      if (admissionCode.length !== 6 || !nextDisplayName) return;
      requestedLanguageRef.current = requestedLanguage;
      shouldAutoJoinRef.current = true;
      setCode(admissionCode);
      setDisplayName(nextDisplayName);
    };
    window.addEventListener("message", receiveExtensionJoin);
    if (window.parent !== window) window.parent.postMessage({ type: "realtime-noel-viewer-ready" }, "*");
    return () => window.removeEventListener("message", receiveExtensionJoin);
  }, []);

  useEffect(() => {
    if (autoJoinRef.current) return;
    if (pendingInviteToken || !shouldAutoJoinRef.current || code.length !== 6 || !normalizeDisplayName(displayName)) return;
    autoJoinRef.current = true;
    void join();
  }, [code, displayName, join, pendingInviteToken]);

  const changeLanguage = useCallback(async (nextLanguage: string) => {
    if (!viewer || nextLanguage === language) return;
    languageRef.current = nextLanguage;
    setLanguage(nextLanguage);
    setError("");
    try {
      await subscribe(nextLanguage, viewer);
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : "언어를 변경할 수 없습니다.");
    }
  }, [language, subscribe, viewer]);

  const openPip = useCallback(async () => {
    const pipApi = (window as Window & { documentPictureInPicture?: { requestWindow(options: { width: number; height: number }): Promise<Window> } }).documentPictureInPicture;
    if (!pipApi) {
      if (!document.pictureInPictureEnabled) {
        setError("이 브라우저에서는 PiP를 사용할 수 없습니다.");
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
        setError("PiP 자막 화면을 만들 수 없습니다.");
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
        setError("PiP 자막 창을 열 수 없습니다.");
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

  const stage = useMemo(() => <ViewerStage sessionType={sessionType} outputMode={outputMode}
    captions={captions} speakers={speakers} status={status} isAudioEnabled={isInterpretationAudioEnabled}
    floorHolder={floorHolder} />,
  [captions, floorHolder, isInterpretationAudioEnabled, outputMode, sessionType, speakers, status]);

  if (!viewer) {
    return (
      <main className={`live-viewer-shell ${compact ? "is-compact" : ""}`}>
        <section className="glass live-join-card">
          <span className="live-eyebrow">Realtime Noel · Viewer</span>
          <h1 className="display whitespace-nowrap !text-[clamp(1.75rem,8.4vw,2.8rem)]">내 언어로 함께 듣기</h1>
          <p>{pendingInviteToken ? "초대 링크가 확인되었습니다. 표시할 이름만 입력하면 참여할 수 있습니다." : "표시할 이름과 호스트가 보여준 6자리 인증번호로 참여하세요. 아이디와 비밀번호는 필요하지 않습니다."}</p>
          <label htmlFor="live-display-name">표시할 이름</label>
          <input id="live-display-name" className="live-name-input" autoComplete="name" maxLength={40} value={displayName}
            onChange={(event) => { setDisplayName(event.target.value); setError(""); }}
            onKeyDown={(event) => { if (event.key === "Enter" && pendingInviteToken) void join(pendingInviteToken); }}
            placeholder="예: Noel" aria-describedby="live-name-help" required />
          <small id="live-name-help">1~40자 · 이 세션의 참여자 이름으로만 사용됩니다.</small>
          {!pendingInviteToken && <>
            <label htmlFor="live-code">인증번호</label>
            <input id="live-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(event) => { if (event.key === "Enter") void join(); }}
              placeholder="000000" aria-describedby="live-code-help" />
          </>}
          <small id="live-code-help">입장은 최대 6시간 유지되며 호스트가 입장창이나 세션을 닫으면 종료됩니다.</small>
          <button type="button" className="accent-btn live-primary-action"
            disabled={isBusy || !normalizeDisplayName(displayName) || (!pendingInviteToken && code.length !== 6)}
            onClick={() => void join(pendingInviteToken || undefined)}>
            {isBusy ? "연결 중…" : "라이브 입장"}
          </button>
          {error && <div className="live-error" role="alert">{error}</div>}
        </section>
      </main>
    );
  }

  return (
    <main className={`live-viewer-shell ${compact ? "is-compact" : ""}`}>
      <header className="glass-pill live-viewer-toolbar">
        <strong>Realtime Noel</strong>
        <div className="live-language-switch" role="group" aria-label="자막 언어 선택">
          {languages.map((item) => (
            <button key={item} type="button" className={item === language ? "is-selected" : ""}
              aria-pressed={item === language} onClick={() => void changeLanguage(item)}>
              {languageLabel(item)}
            </button>
          ))}
        </div>
        <span className="live-viewer-delivery-method" aria-label={`현재 전달 방식: ${deliveryMethod.title}`} title={deliveryMethod.description}>{deliveryMethod.title}</span>
        <span id="viewer-delivery-method-description" className="sr-only">{deliveryMethod.description}</span>
        {hasAudio && (
          <>
            <button type="button" className={isInterpretationAudioEnabled ? "is-selected" : ""}
              aria-pressed={isInterpretationAudioEnabled} disabled={!language} onClick={() => void enableInterpretationAudio()}
              aria-describedby="viewer-delivery-method-description"
              aria-label={isInterpretationAudioEnabled ? "AI 합성 통역 음성 재생 중" : "AI 합성 통역 음성 재생 동의"}>
              {isInterpretationAudioEnabled ? "통역 음성 재생 중" : "통역 음성 재생"}
            </button>
          </>
        )}
        <button type="button" onClick={() => void openPip()} aria-label="Picture in Picture로 열기">PiP</button>
      </header>
      {error && <div className="live-error" role="alert">{error}</div>}
      {stage}
      {sessionType === "meeting" && (
        <div className="live-speak-bar">
          {floorHolder && speakState !== "speaking"
            ? <span className="live-floor-indicator"><span className="live-speaking-waves" aria-hidden="true"><i /><i /><i /></span>{floorHolder} 발언 중</span>
            : <span className="live-floor-indicator is-idle">{speakState === "speaking" ? "내 발언이 실시간 번역되고 있습니다" : "버튼을 누르고 말하면 모두에게 번역됩니다"}</span>}
          <button type="button"
            className={`live-speak-button ${speakState === "speaking" ? "is-speaking" : ""}`}
            disabled={!language || speakState === "starting"}
            aria-pressed={speakState === "speaking"}
            onClick={() => void toggleSpeak()}>
            {speakState === "speaking" ? "발언 종료" : speakState === "starting" ? "연결 중…" : "🎙 발언하기"}
          </button>
        </div>
      )}
      <footer className="live-viewer-footer"><span>{viewer.displayName} · {viewer.viewerCount}/{viewer.session.maxViewers}명 접속</span><span>만료 {new Date(viewer.grant.expiresAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</span></footer>
      {pipWindow && createPortal(stage, pipWindow.document.body)}
    </main>
  );
}
