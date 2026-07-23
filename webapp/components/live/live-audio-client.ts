import type { GlossaryPack, LiveOutputMode, LiveSessionType, LiveVoiceProvider, SpeakerAssignment } from "@/lib/live-contract";
import {
  getReconnectDelayMilliseconds,
  getReconnectStatus,
} from "./connection-resilience";

const LIVE_PCM_FRAME_BYTES = 1_280;

export type LiveInputSource = "mic" | "system" | "both";

interface GatewayCredentials {
  token: string;
  gatewayUrl: string;
  expiresAt: string;
}

interface AudioClientOptions {
  sessionId: string;
  version: number;
  sessionType: LiveSessionType;
  languages: string[];
  inputSource: LiveInputSource;
  outputMode: LiveOutputMode;
  voiceProvider: LiveVoiceProvider;
  maxViewers: number;
  glossaryPack: GlossaryPack;
  credentials: GatewayCredentials;
  refreshCredentials: () => Promise<GatewayCredentials>;
  onStatus: (status: string) => void;
  onError: (message: string) => void;
  onSpeakers: (speakers: SpeakerAssignment[]) => void;
  onLanguageStatus: (language: string, status: "preparing" | "ready" | "unavailable") => void;
}

interface LiveAudioSettings {
  version: number;
  sessionType: LiveSessionType;
  languages: string[];
  outputMode: LiveOutputMode;
  voiceProvider: LiveVoiceProvider;
  maxViewers: number;
  glossaryPack: GlossaryPack;
}

interface OpenedGatewaySocket {
  socket: WebSocket;
  proactiveReconnectDelay: number;
}

interface WorkletChunkMessage {
  type: "chunk";
  recordedAt: number;
  pcm: ArrayBuffer;
}

interface WorkletEndMessage {
  type: "audioStreamEnd";
}

function isWorkletMessage(value: unknown): value is WorkletChunkMessage | WorkletEndMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "audioStreamEnd") return true;
  return message.type === "chunk"
    && typeof message.recordedAt === "number"
    && message.pcm instanceof ArrayBuffer;
}

function isSpeakerAssignment(value: unknown): value is SpeakerAssignment {
  if (!value || typeof value !== "object") return false;
  const speaker = value as Record<string, unknown>;
  return typeof speaker.speakerId === "string"
    && typeof speaker.label === "string"
    && typeof speaker.colorToken === "string"
    && (typeof speaker.voiceName === "string" || speaker.voiceName === null)
    && typeof speaker.lastSeenAt === "string"
    && (speaker.voiceStatus === undefined || speaker.voiceStatus === "disabled" || speaker.voiceStatus === "analyzing"
      || speaker.voiceStatus === "ready" || speaker.voiceStatus === "unavailable");
}

function assertSessionVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("라이브 세션 버전이 올바르지 않습니다.");
  }
}

function getGatewayCredentialRefreshDelay(
  credentials: GatewayCredentials,
  nowMilliseconds = Date.now(),
): number {
  const expiresAtMilliseconds = Date.parse(credentials.expiresAt);
  if (!Number.isFinite(expiresAtMilliseconds)) {
    throw new Error("미디어 게이트웨이 자격 증명의 만료시각이 올바르지 않습니다.");
  }
  if (expiresAtMilliseconds - nowMilliseconds <= 60_000) {
    throw new Error("미디어 게이트웨이 자격 증명이 만료됐거나 곧 만료됩니다.");
  }
  return Math.min(50 * 60 * 1_000, expiresAtMilliseconds - nowMilliseconds - 60_000);
}

function waitForMessage(socket: WebSocket, expectedType: string, timeoutMilliseconds = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      socket.removeEventListener("message", handleMessage);
      reject(new Error("미디어 게이트웨이 응답 시간이 초과됐습니다."));
    }, timeoutMilliseconds);
    function handleMessage(event: MessageEvent<unknown>) {
      if (typeof event.data !== "string") return;
      try {
        const value: unknown = JSON.parse(event.data);
        if (!value || typeof value !== "object" || (value as Record<string, unknown>).type !== expectedType) return;
        window.clearTimeout(timeout);
        socket.removeEventListener("message", handleMessage);
        resolve();
      } catch {
        // 다른 이벤트는 상시 상태 리스너가 처리합니다.
      }
    }
    socket.addEventListener("message", handleMessage);
  });
}

async function openSocket(
  options: AudioClientOptions,
  credentials: GatewayCredentials,
  settings: LiveAudioSettings,
  attachPersistentListeners: (socket: WebSocket) => void,
): Promise<OpenedGatewaySocket> {
  assertSessionVersion(settings.version);
  getGatewayCredentialRefreshDelay(credentials);
  const socket = new WebSocket(credentials.gatewayUrl);
  socket.binaryType = "arraybuffer";
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("미디어 게이트웨이에 연결할 수 없습니다.")), { once: true });
    });
    const authenticated = waitForMessage(socket, "authenticated");
    socket.send(JSON.stringify({ type: "authenticate", token: credentials.token }));
    await authenticated;
    attachPersistentListeners(socket);
    const started = waitForMessage(socket, "started");
    socket.send(JSON.stringify({
      type: "start",
      sessionId: options.sessionId,
      version: settings.version,
      sessionType: settings.sessionType,
      languages: settings.languages,
      outputMode: settings.outputMode,
      voiceProvider: settings.voiceProvider,
      maxViewers: settings.maxViewers,
      glossaryPack: settings.glossaryPack,
      inputSource: options.inputSource,
    }));
    await started;
    if (socket.readyState !== WebSocket.OPEN) throw new Error("미디어 게이트웨이 연결이 시작 직후 종료됐습니다.");
    return { socket, proactiveReconnectDelay: getGatewayCredentialRefreshDelay(credentials) };
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function getStreams(inputSource: LiveInputSource): Promise<MediaStream[]> {
  const streams: MediaStream[] = [];
  if (inputSource === "mic" || inputSource === "both") {
    streams.push(await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    }));
  }
  if (inputSource === "system" || inputSource === "both") {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (display.getAudioTracks().length === 0) {
      for (const track of display.getTracks()) track.stop();
      throw new Error("공유한 화면에서 시스템 오디오가 선택되지 않았습니다.");
    }
    streams.push(display);
  }
  return streams;
}

export interface LiveAudioClient {
  update(settings: LiveAudioSettings): Promise<void>;
  stop(): Promise<void>;
}

export async function startLiveAudioClient(options: AudioClientOptions): Promise<LiveAudioClient> {
  assertSessionVersion(options.version);
  getGatewayCredentialRefreshDelay(options.credentials);
  const streams: MediaStream[] = [];
  let context: AudioContext | null = null;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let proactiveReconnectTimer: number | null = null;
  let reconnectPromise: Promise<void> | null = null;
  let reconnectAttempt = 0;
  let isReplacing = false;
  let isStopped = false;
  let currentSettings: LiveAudioSettings = {
    version: options.version,
    sessionType: options.sessionType,
    languages: [...options.languages],
    outputMode: options.outputMode,
    voiceProvider: options.voiceProvider,
    maxViewers: options.maxViewers,
    glossaryPack: options.glossaryPack,
  };
  const attachedSockets = new WeakSet<WebSocket>();

  const clearReconnectTimers = () => {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    if (proactiveReconnectTimer !== null) window.clearTimeout(proactiveReconnectTimer);
    reconnectTimer = null;
    proactiveReconnectTimer = null;
  };

  const attachPersistentListeners = (candidate: WebSocket) => {
    if (attachedSockets.has(candidate)) return;
    attachedSockets.add(candidate);
    candidate.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        const value: unknown = JSON.parse(event.data);
        if (!value || typeof value !== "object") return;
        const message = value as Record<string, unknown>;
        if (message.type === "status" && typeof message.status === "string") options.onStatus(message.status);
        if (message.type === "error" && typeof message.message === "string") options.onError(message.message);
        if (message.type === "speaker-legend" && Array.isArray(message.speakers) && message.speakers.every(isSpeakerAssignment)) {
          options.onSpeakers(message.speakers);
        }
        if (message.type === "language-status"
          && typeof message.language === "string"
          && (message.status === "preparing" || message.status === "ready" || message.status === "unavailable")) {
          options.onLanguageStatus(message.language, message.status);
        }
      } catch {
        options.onError("게이트웨이 상태 메시지를 읽을 수 없습니다.");
      }
    });
    candidate.addEventListener("close", () => {
      if (isStopped || isReplacing || socket !== candidate) return;
      scheduleReconnect();
    });
  };

  const scheduleReconnect = () => {
    if (isStopped || reconnectTimer !== null || reconnectPromise !== null) return;
    const delayMilliseconds = getReconnectDelayMilliseconds(reconnectAttempt);
    reconnectAttempt += 1;
    options.onStatus(getReconnectStatus(delayMilliseconds));
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void reconnect();
    }, delayMilliseconds);
  };

  const scheduleProactiveReconnect = (delayMilliseconds: number) => {
    if (proactiveReconnectTimer !== null) window.clearTimeout(proactiveReconnectTimer);
    // 2026-07-19 fix: 게이트웨이 토큰 만료와 Cloud Run 연결 상한 중 이른 시점에 교체합니다.
    proactiveReconnectTimer = window.setTimeout(() => { void reconnect(); }, delayMilliseconds);
  };

  const reconnect = async (): Promise<void> => {
    if (isStopped) return;
    if (reconnectPromise) return reconnectPromise;
    let hasReconnected = false;
    reconnectPromise = (async () => {
      clearReconnectTimers();
      const credentials = await options.refreshCredentials();
      if (isStopped) return;
      getGatewayCredentialRefreshDelay(credentials);
      isReplacing = true;
      try {
        const opened = await openSocket(options, credentials, currentSettings, attachPersistentListeners);
        if (isStopped) {
          opened.socket.close(1000, "host stopped");
          return;
        }
        const previous = socket;
        socket = opened.socket;
        previous?.close(1000, "connection refreshed");
        reconnectAttempt = 0;
        scheduleProactiveReconnect(opened.proactiveReconnectDelay);
        options.onStatus("연결됨 · 송출 중");
      } finally {
        isReplacing = false;
      }
    })();
    try {
      await reconnectPromise;
      hasReconnected = true;
    } catch (error: unknown) {
      if (!isStopped) options.onError(error instanceof Error ? error.message : "미디어 게이트웨이에 다시 연결할 수 없습니다.");
    } finally {
      reconnectPromise = null;
    }
    if (!isStopped && !hasReconnected) scheduleReconnect();
  };

  try {
    streams.push(...await getStreams(options.inputSource));
    context = new AudioContext();
    await context.audioWorklet.addModule("/live-audio-worklet.js");
    const worklet = new AudioWorkletNode(context, "live-pcm-processor", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    for (const stream of streams) context.createMediaStreamSource(stream).connect(worklet);
    const opened = await openSocket(options, options.credentials, currentSettings, attachPersistentListeners);
    socket = opened.socket;
    reconnectAttempt = 0;
    scheduleProactiveReconnect(opened.proactiveReconnectDelay);
    worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      if (!isWorkletMessage(event.data) || socket?.readyState !== WebSocket.OPEN) return;
      if (event.data.type === "audioStreamEnd") {
        socket.send(JSON.stringify({ type: "audioStreamEnd" }));
        return;
      }
      // 2026-07-19 feat: 실시간성 보존을 위해 750ms를 넘긴 대기 프레임은 폐기합니다.
      if (Date.now() - event.data.recordedAt > 750 || event.data.pcm.byteLength !== LIVE_PCM_FRAME_BYTES) return;
      socket.send(event.data.pcm);
    };
    options.onStatus("연결됨 · 송출 중");
    return {
      async update(settings) {
        if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("미디어 게이트웨이가 연결되어 있지 않습니다.");
        assertSessionVersion(settings.version);
        const updated = waitForMessage(socket, "updated");
        socket.send(JSON.stringify({
          type: "update",
          sessionId: options.sessionId,
          version: settings.version,
          sessionType: settings.sessionType,
          languages: settings.languages,
          outputMode: settings.outputMode,
          voiceProvider: settings.voiceProvider,
          maxViewers: settings.maxViewers,
          glossaryPack: settings.glossaryPack,
          inputSource: options.inputSource,
        }));
        await updated;
        currentSettings = {
          version: settings.version,
          sessionType: settings.sessionType,
          languages: [...settings.languages],
          outputMode: settings.outputMode,
          voiceProvider: settings.voiceProvider,
          maxViewers: settings.maxViewers,
          glossaryPack: settings.glossaryPack,
        };
      },
      async stop() {
        isStopped = true;
        clearReconnectTimers();
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "audioStreamEnd" }));
        socket?.close(1000, "host stopped");
        for (const stream of streams) for (const track of stream.getTracks()) track.stop();
        await context?.close();
      },
    };
  } catch (error) {
    isStopped = true;
    clearReconnectTimers();
    socket?.close();
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
    await context?.close();
    throw error;
  }
}
