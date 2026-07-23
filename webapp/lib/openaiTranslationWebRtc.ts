import {
  createSpokenLanguageState,
  toOpenAITranslationLanguageCode,
  type DetectedLanguage,
  type LanguageCode,
} from "./languageDetect";
import type { AudioSource, EngineEvent, PolishFn, ToneKind } from "./types";

const TRANSLATION_CALL_URL = "https://api.openai.com/v1/realtime/translations/calls";
const REQUEST_TIMEOUT_MS = 8_000;
const COMMIT_QUIET_MS = 650;
const MAX_CLIENT_SECRET_CHARS = 8_192;
const MAX_TOKEN_ERROR_MESSAGE_CHARS = 200;
const TOKEN_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MAX_TRANSCRIPT_CHARS = 32_768;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readClientSecretEnvelope(payload: unknown): string | null {
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.data)) return null;
  const value = payload.data.value;
  const expiresAt = payload.data.expires_at;
  const hasValidExpiry = expiresAt === null
    || (typeof expiresAt === "number" && Number.isFinite(expiresAt))
    || (typeof expiresAt === "string" && Boolean(expiresAt.trim()));
  if (typeof value !== "string" || !value.trim() || value.length > MAX_CLIENT_SECRET_CHARS) return null;
  if (/[\x00-\x20\x7f]/u.test(value) || !hasValidExpiry) return null;
  return value;
}

function readTokenErrorEnvelope(payload: unknown): { message: string; code: string } | null {
  if (!isRecord(payload) || payload.ok !== false) return null;
  const message = payload.error;
  const code = payload.code;
  if (typeof message !== "string" || typeof code !== "string") return null;
  const normalizedMessage = message.trim();
  if (!normalizedMessage || normalizedMessage.length > MAX_TOKEN_ERROR_MESSAGE_CHARS) return null;
  if (!/[가-힣]/u.test(normalizedMessage) || /[<>\x00-\x1f\x7f]/u.test(normalizedMessage)) return null;
  if (!TOKEN_ERROR_CODE_PATTERN.test(code)) return null;
  return { message: normalizedMessage, code };
}

export async function mintTranslationClientSecret(
  targetLanguage: LanguageCode,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher("/api/openai-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetLanguage: toOpenAITranslationLanguageCode(targetLanguage) }),
    });
  } catch {
    throw new Error("OpenAI 번역 토큰 발급 요청에 실패했습니다.");
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // The provider response is intentionally never copied into a browser error.
  }
  if (!response.ok) {
    const failure = readTokenErrorEnvelope(payload);
    if (failure) throw new Error(`${failure.message} (${failure.code})`);
    throw new Error(`OpenAI 번역 토큰 발급에 실패했습니다. (${response.status})`);
  }
  const value = readClientSecretEnvelope(payload);
  if (!value) throw new Error("OpenAI 번역 토큰 응답이 올바르지 않습니다.");
  return value;
}

export interface OpenAITranslationEventState {
  sourceText: string;
  translatedText: string;
  languageState?: ReturnType<typeof createSpokenLanguageState>;
}

interface OpenAITranslationEventContext {
  source: AudioSource;
  targetLanguage: LanguageCode;
  emit: (event: EngineEvent) => void;
  scheduleCommit: () => void;
  commit: () => void;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function appendBounded(current: string, delta: unknown): string {
  const next = `${current}${readText(delta)}`;
  return next.length <= MAX_TRANSCRIPT_CHARS ? next : next.slice(-MAX_TRANSCRIPT_CHARS);
}

function replaceBounded(value: unknown): string {
  const text = readText(value);
  return text.length <= MAX_TRANSCRIPT_CHARS ? text : text.slice(-MAX_TRANSCRIPT_CHARS);
}

function getLanguageState(state: OpenAITranslationEventState): ReturnType<typeof createSpokenLanguageState> {
  state.languageState ??= createSpokenLanguageState();
  return state.languageState;
}

export function handleOpenAITranslationEvent(
  raw: string,
  state: OpenAITranslationEventState,
  context: OpenAITranslationEventContext,
): void {
  let message: JsonRecord;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return;
    message = parsed;
  } catch {
    context.emit({
      type: "error",
      message: "OpenAI 번역 이벤트를 읽을 수 없습니다.",
      code: "OPENAI_TRANSLATION_EVENT_INVALID",
    });
    return;
  }

  const type = readText(message.type);
  switch (type) {
    case "session.created":
    case "session.updated":
      context.emit({
        type: "status",
        status: "api_ready",
        source: context.source,
        targetLanguage: context.targetLanguage,
      });
      return;

    case "session.input_transcript.delta": {
      const delta = readText(message.delta);
      state.sourceText = appendBounded(state.sourceText, delta);
      const sourceLanguage = getLanguageState(state).rememberDelta(
        delta,
        message.language ?? message.language_code,
      );
      if (sourceLanguage === context.targetLanguage) state.translatedText = "";
      if (state.translatedText && sourceLanguage !== context.targetLanguage) {
        context.emit({
          type: "partial",
          source: context.source,
          targetLanguage: context.targetLanguage,
          sourceText: state.sourceText.trim(),
          translatedText: state.translatedText.trim(),
        });
      }
      return;
    }

    case "session.input_transcript.done":
    case "session.input_transcript.completed": {
      const transcript = readText(message.transcript) || readText(message.text);
      if (transcript) {
        const previous = state.sourceText;
        state.sourceText = replaceBounded(transcript);
        getLanguageState(state).rememberSnapshot(
          state.sourceText,
          previous,
          message.language ?? message.language_code,
        );
      }
      return;
    }

    case "session.output_transcript.delta": {
      const delta = readText(message.delta);
      if (!delta) return;
      if (getLanguageState(state).resolved(state.sourceText) === context.targetLanguage) {
        state.translatedText = "";
        return;
      }
      state.translatedText = appendBounded(state.translatedText, delta);
      context.emit({
        type: "partial",
        source: context.source,
        targetLanguage: context.targetLanguage,
        sourceText: state.sourceText.trim(),
        translatedText: state.translatedText.trim(),
      });
      context.scheduleCommit();
      return;
    }

    case "session.output_transcript.done":
    case "session.output_transcript.completed": {
      const transcript = readText(message.transcript) || readText(message.text);
      if (transcript) state.translatedText = replaceBounded(transcript);
      context.commit();
      return;
    }

    case "error":
      context.emit({
        type: "error",
        message: "OpenAI 실시간 번역 세션에서 오류가 발생했습니다.",
        code: "OPENAI_TRANSLATION_SESSION_ERROR",
      });
      return;

    default:
      return;
  }
}

export interface OpenAITranslationWebRtcSession {
  /** Must be called synchronously from the user's Start/Play action. */
  allowPlayback(): void;
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createOpenAITranslationWebRtc({
  source,
  targetLanguage,
  stream,
  emit,
  polish,
  tone = "natural",
  glossary = "",
  domain = "",
  fetcher = fetch,
  createPeerConnection = () => new RTCPeerConnection(),
  createAudioElement = () => new Audio(),
}: {
  source: AudioSource;
  targetLanguage: LanguageCode;
  stream: MediaStream;
  emit: (event: EngineEvent) => void;
  polish?: PolishFn;
  tone?: ToneKind;
  glossary?: string;
  domain?: string;
  fetcher?: typeof fetch;
  createPeerConnection?: () => RTCPeerConnection;
  createAudioElement?: () => HTMLAudioElement;
}): OpenAITranslationWebRtcSession {
  const state: OpenAITranslationEventState = { sourceText: "", translatedText: "" };
  let peer: RTCPeerConnection | null = null;
  let dataChannel: RTCDataChannel | null = null;
  let audioElement: HTMLAudioElement | null = null;
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  let playbackAllowed = false;
  let started = false;
  let closed = false;

  function clearCommitTimer(): void {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = null;
  }

  function resetTranscript(): void {
    clearCommitTimer();
    state.sourceText = "";
    state.translatedText = "";
    state.languageState?.reset();
  }

  async function commit(): Promise<void> {
    clearCommitTimer();
    const sourceText = state.sourceText.trim();
    const translatedText = state.translatedText.trim();
    const sourceLanguage: DetectedLanguage = getLanguageState(state).resolved(sourceText);
    // Reset before optional asynchronous polishing. New stream deltas may arrive
    // while polish is in flight and must belong to the next subtitle, not be
    // erased when the previous commit finishes.
    resetTranscript();
    if (!translatedText || closed) return;
    // The dedicated interpreter can intentionally stay silent when the source
    // already matches its target. If it does echo text, suppress it quietly;
    // silence is expected behavior, never a provider failure or reconnect cue.
    if (sourceLanguage === targetLanguage) {
      return;
    }
    const rawTranslation = translatedText;
    let finalTranslation = rawTranslation;
    if (polish) {
      try {
        finalTranslation = (await polish({
          sourceText,
          translatedText: rawTranslation,
          targetLanguage,
          tone,
          glossary,
          domain,
        })) || rawTranslation;
      } catch {
        finalTranslation = rawTranslation;
      }
    }
    if (!closed) {
      emit({ type: "committed", source, targetLanguage, sourceText, translatedText: finalTranslation });
    }
  }

  function scheduleCommit(): void {
    clearCommitTimer();
    commitTimer = setTimeout(() => { void commit(); }, COMMIT_QUIET_MS);
  }

  function playRemoteAudio(): void {
    if (!audioElement || !playbackAllowed || !audioElement.srcObject) return;
    audioElement.autoplay = true;
    void audioElement.play().catch(() => {
      emit({
        type: "status",
        status: "audio_playback_blocked",
        source,
        targetLanguage,
      });
    });
  }

  return {
    allowPlayback() {
      playbackAllowed = true;
      playRemoteAudio();
    },

    async start() {
      if (started || closed) return;
      started = true;
      const track = stream.getAudioTracks()[0];
      if (!track) {
        started = false;
        throw new Error("OpenAI 번역에 사용할 오디오 트랙이 없습니다.");
      }

      const currentPeer = createPeerConnection();
      const currentAudio = createAudioElement();
      // OpenAI's WebRTC translation guide uses autoplay for the remote track.
      // This element is created only after the user starts the live session;
      // a denied play() is surfaced so the UI can request another explicit tap.
      currentAudio.autoplay = playbackAllowed;
      currentAudio.setAttribute("playsinline", "");
      peer = currentPeer;
      audioElement = currentAudio;
      currentPeer.addTrack(track, stream);
      currentPeer.ontrack = (event) => {
        if (closed) return;
        const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
        currentAudio.srcObject = remoteStream;
        playRemoteAudio();
      };

      const currentDataChannel = currentPeer.createDataChannel("oai-events");
      dataChannel = currentDataChannel;
      currentDataChannel.addEventListener("message", (event) => {
        if (typeof event.data !== "string" || closed) return;
        handleOpenAITranslationEvent(event.data, state, {
          source,
          targetLanguage,
          emit,
          scheduleCommit,
          commit: () => { void commit(); },
        });
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const secret = await mintTranslationClientSecret(targetLanguage, fetcher);
        const offer = await currentPeer.createOffer();
        await currentPeer.setLocalDescription(offer);
        const response = await fetcher(TRANSLATION_CALL_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp ?? "",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("OpenAI Translation WebRTC 연결이 거부되었습니다.");
        const answerSdp = await response.text();
        if (!answerSdp.trim()) throw new Error("OpenAI Translation SDP 응답이 비어 있습니다.");
        await currentPeer.setRemoteDescription({ type: "answer", sdp: answerSdp });
        emit({ type: "status", status: "api_ready", source, targetLanguage });
      } catch (error: unknown) {
        currentDataChannel.close();
        currentPeer.close();
        peer = null;
        dataChannel = null;
        audioElement = null;
        started = false;
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("OpenAI 실시간 번역 연결 시간이 초과되었습니다.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      clearCommitTimer();
      dataChannel?.close();
      dataChannel = null;
      peer?.close();
      peer = null;
      if (audioElement) {
        audioElement.pause();
        audioElement.srcObject = null;
      }
      audioElement = null;
      resetTranscript();
    },
  };
}
