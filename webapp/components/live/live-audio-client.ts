import { hasValidTranslationCaptureProvenance } from "../../lib/live/translation-capture";
import { sourceEventSchema, type SourceEvent } from "../../lib/live/source-contract";
import { createGeminiCaptionConfig } from "../../../packages/caption-core/gemini-caption-contract.js";
import { normalizeEngineSelection } from "../../../packages/caption-core/caption-engine-catalog.js";
import type { EngineSelection, LiveModelPreferences } from "../../lib/live/model-preferences";
import type { CaptionEvent, GlossaryPack, LiveOutputMode, LiveSessionStatus, LiveSessionType, LiveVoiceProvider, SpeakerAssignment } from "@/lib/live-contract";
import {
  getReconnectDelayMilliseconds,
  getReconnectStatus,
} from "./connection-resilience";
import { canConnectHostMedia, type HostDemandControl } from "./host-demand-control";

const LIVE_PCM_FRAME_BYTES = 1_280;
/** Gateway close code when another HOST connection takes over this session. */
const HOST_REPLACED_CLOSE_CODE = 4410;
/** Frames older than this are dropped by the gateway's stale-frame guard, so
 *  spooling them across a socket swap would only waste bandwidth. */
const FRAME_SPOOL_STALE_MILLISECONDS = 750;
const STOP_ACK_TIMEOUT_MILLISECONDS = 2_000;
const GATEWAY_CONNECTION_TIMEOUT_MILLISECONDS = 20_000;
const gatewayWarmupFlights = new Map<string, Promise<void>>();
const prewarmedGatewayUrls = new Set<string>();
const ACTIVATION_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type LiveInputSource = "mic" | "system" | "both";

/** Read-only engine runtime status the gateway sends the host (`engine-status`):
 *  one event per engine role on start, on an admin engine switch, and on failure. */
export interface EngineStatusEvent {
  role: "stt" | "translation";
  provider: string;
  model: string;
  status: "connecting" | "ready" | "failed";
  code?: string;
}
const ENGINE_STATUS_ROLES = new Set(["stt", "translation"]);
const ENGINE_STATUS_VALUES = new Set(["connecting", "ready", "failed"]);
const ENGINE_STATUS_TOKEN = /^[A-Za-z0-9._-]{1,80}$/u;
function readEngineStatusEvent(message: Record<string, unknown>, sessionId: string): EngineStatusEvent | null {
  if (message.type !== "engine-status" || message.sessionId !== sessionId) return null;
  const { role, provider, model, status, code } = message;
  if (typeof role !== "string" || !ENGINE_STATUS_ROLES.has(role)) return null;
  if (typeof status !== "string" || !ENGINE_STATUS_VALUES.has(status)) return null;
  if (typeof provider !== "string" || !ENGINE_STATUS_TOKEN.test(provider)) return null;
  if (typeof model !== "string" || !ENGINE_STATUS_TOKEN.test(model)) return null;
  if (code !== undefined && (typeof code !== "string" || !/^[A-Z0-9_]{1,80}$/u.test(code))) return null;
  const event: EngineStatusEvent = { role: role as EngineStatusEvent["role"], provider, model, status: status as EngineStatusEvent["status"] };
  return code === undefined ? event : { ...event, code };
}

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
  domainText?: string;
  modelPreferences?: LiveModelPreferences;
  activationKey?: string | null;
  initialControl?: "start" | "restart";
  sessionStatus?: LiveSessionStatus;
  /** Specific microphone to capture; default input when omitted. */
  audioDeviceId?: string;
  credentials: GatewayCredentials;
  refreshCredentials: () => Promise<GatewayCredentials>;
  refreshSettings?: () => Promise<LiveAudioSettings>;
  demandControl?: HostDemandControl;
  onCaption?: (caption: CaptionEvent) => void;
  onSource?: (source: SourceEvent) => void;
  onSourceStatus?: (status: "unavailable") => void;
  onStatus: (status: string) => void;
  onError: (message: string) => void;
  onManualRestartRequired?: () => void;
  onSpeakers: (speakers: SpeakerAssignment[]) => void;
  onLanguageStatus: (language: string, status: "preparing" | "ready" | "unavailable") => void;
  /** Read-only engine runtime status; the admin console owns the engine itself. */
  onEngineStatus?: (status: EngineStatusEvent) => void;
  /** Another client took this session's HOST slot (gateway close 4410). The
   *  client has already stopped itself; reconnecting would seize the session
   *  back and ping-pong the socket, so the UI offers a manual restart instead. */
  onReplaced?: () => void;
}

export interface LiveAudioSettings {
  version: number;
  sessionStatus?: LiveSessionStatus;
  sessionType: LiveSessionType;
  languages: string[];
  outputMode: LiveOutputMode;
  voiceProvider: LiveVoiceProvider;
  maxViewers: number;
  glossaryPack: GlossaryPack;
  domainText?: string;
  modelPreferences?: LiveModelPreferences;
}

const INVALID_ENGINE_MESSAGE = "자막 엔진 선택이 올바르지 않습니다.";

// The server always returns the normalized `{ engine, engineHistory }` shape
// (lib/live/model-preferences.ts); the client re-validates the engine against
// the catalog and carries nothing else - history is server-owned.
function readHostModelPreferences(value: unknown): LiveModelPreferences {
  if (value === undefined) return { engine: normalizeEngineSelection(undefined) as EngineSelection, engineHistory: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID_ENGINE_MESSAGE);
  const preferences = value as Record<string, unknown>;
  if (Object.keys(preferences).some((key) => key !== "engine" && key !== "engineHistory")
    || !preferences.engine || typeof preferences.engine !== "object" || Array.isArray(preferences.engine)) throw new Error(INVALID_ENGINE_MESSAGE);
  try {
    return { engine: normalizeEngineSelection(preferences.engine) as EngineSelection, engineHistory: [] };
  } catch {
    throw new Error(INVALID_ENGINE_MESSAGE);
  }
}

function buildHostCaptionConfig(settings: LiveAudioSettings) {
  const { engine } = readHostModelPreferences(settings.modelPreferences);
  return createGeminiCaptionConfig({ languages: settings.languages, outputMode: settings.outputMode,
    glossaryPack: settings.glossaryPack, domainText: settings.domainText ?? "", engine });
}

interface OpenedGatewaySocket {
  socket: WebSocket;
  version: number;
  proactiveReconnectDelay: number;
  detachPersistentListeners: () => void;
}

export type LiveAudioRecoveryStatus =
  | "microphone-permission-required"
  | "audio-user-activation-required"
  | "replaced-by-other-host";

export class LiveAudioRecoveryError extends Error {
  readonly status: LiveAudioRecoveryStatus;

  constructor(
    status: LiveAudioRecoveryStatus,
    message: string,
  ) {
    super(message);
    this.name = "LiveAudioRecoveryError";
    this.status = status;
  }
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

function isHostCaptionEvent(
  value: unknown,
  sessionId: string,
  configuredLanguages: readonly string[],
): value is CaptionEvent {
  if (!value || typeof value !== "object") return false;
  const caption = value as Record<string, unknown>;
  const utteranceKey = caption.utteranceKey;
  return caption.type === "caption"
    && caption.sessionId === sessionId
    && typeof caption.language === "string"
    && configuredLanguages.includes(caption.language)
    && Number.isSafeInteger(caption.seq)
    && Number(caption.seq) >= 1
    && typeof caption.text === "string"
    && caption.text.length <= 20_000
    && typeof caption.isFinal === "boolean"
    && (caption.speaker === null || isSpeakerAssignment(caption.speaker))
    && typeof caption.sourceEndedAt === "string"
    && typeof caption.emittedAt === "string"
    && (utteranceKey === undefined
      || (typeof utteranceKey === "string" && utteranceKey.length >= 1 && utteranceKey.length <= 256))
    && (caption.sourceText === undefined || caption.sourceText === null || typeof caption.sourceText === "string")
    && hasValidTranslationCaptureProvenance(caption)
    && (caption.sourceLanguage === undefined || caption.sourceLanguage === null || typeof caption.sourceLanguage === "string")
    && (caption.translationStatus === undefined
      || caption.translationStatus === "verbatim"
      || caption.translationStatus === "translated"
      || caption.translationStatus === "failed")
    && (caption.origin === undefined || caption.origin === "source")
    && (caption.replay === undefined || typeof caption.replay === "boolean");
}

function assertSessionVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("The live session version is invalid.");
  }
}

function createActivationKey(): string {
  const key = crypto.randomUUID();
  if (!ACTIVATION_KEY_PATTERN.test(key)) throw new Error("The live activation key is invalid.");
  return key;
}

function assertActivationKey(value: string): void {
  if (!ACTIVATION_KEY_PATTERN.test(value)) throw new Error("The live activation key is invalid.");
}

function getGatewayCredentialRefreshDelay(
  credentials: GatewayCredentials,
  nowMilliseconds = Date.now(),
): number {
  const expiresAtMilliseconds = Date.parse(credentials.expiresAt);
  if (!Number.isFinite(expiresAtMilliseconds)) {
    throw new Error("The media gateway credential expiry is invalid.");
  }
  if (expiresAtMilliseconds - nowMilliseconds <= 60_000) {
    throw new Error("The media gateway credentials have expired or will expire shortly.");
  }
  return Math.min(50 * 60 * 1_000, expiresAtMilliseconds - nowMilliseconds - 60_000);
}

function parseGatewayEndpoint(gatewayUrl: string): { socketUrl: string; healthUrl: string } {
  let endpoint: URL;
  try {
    endpoint = new URL(gatewayUrl);
  } catch {
    throw new Error("The media gateway URL is invalid.");
  }
  if (endpoint.protocol !== "wss:"
    || endpoint.pathname !== "/live"
    || endpoint.port !== ""
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.search !== ""
    || endpoint.hash !== "") {
    throw new Error("The media gateway URL is invalid.");
  }
  const healthEndpoint = new URL(endpoint.href);
  healthEndpoint.protocol = "https:";
  healthEndpoint.pathname = "/health";
  return { socketUrl: endpoint.href, healthUrl: healthEndpoint.href };
}

export function getLiveGatewayHealthUrl(gatewayUrl: string): string {
  return parseGatewayEndpoint(gatewayUrl).healthUrl;
}

interface GatewayWarmupClock {
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

async function warmGateway(
  healthUrl: string,
  request: typeof fetch = fetch,
  clock: GatewayWarmupClock = window,
): Promise<void> {
  const existing = gatewayWarmupFlights.get(healthUrl);
  if (existing) return existing;
  const abortController = new AbortController();
  const flight = (async () => {
    const timeout = clock.setTimeout(
      () => abortController.abort(),
      GATEWAY_CONNECTION_TIMEOUT_MILLISECONDS,
    );
    try {
      const response = await request(healthUrl, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "manual",
        signal: abortController.signal,
      });
      if (!response.ok) throw new Error("The media gateway health check failed.");
    } catch {
      // Warmup is advisory; the authenticated WebSocket remains authoritative.
    } finally {
      clock.clearTimeout(timeout);
    }
  })();
  gatewayWarmupFlights.set(healthUrl, flight);
  try {
    await flight;
  } finally {
    if (gatewayWarmupFlights.get(healthUrl) === flight) gatewayWarmupFlights.delete(healthUrl);
  }
}

export async function warmLiveGateway(
  gatewayUrl: string,
  request: typeof fetch = fetch,
  clock: GatewayWarmupClock = window,
): Promise<void> {
  return warmGateway(getLiveGatewayHealthUrl(gatewayUrl), request, clock);
}

export async function prewarmLiveGateway(
  gatewayUrl: string,
  request: typeof fetch = fetch,
  clock: GatewayWarmupClock = window,
): Promise<void> {
  const healthUrl = getLiveGatewayHealthUrl(gatewayUrl);
  await warmGateway(healthUrl, request, clock);
  prewarmedGatewayUrls.add(healthUrl);
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const timeout = window.setTimeout(
      () => fail(new Error("The media gateway connection timed out.")),
      GATEWAY_CONNECTION_TIMEOUT_MILLISECONDS,
    );
    function handleOpen() { cleanup(); resolve(); }
    function handleError() { fail(new Error("Unable to connect to the media gateway.")); }
    function handleClose() { fail(new Error("The media gateway connection closed.")); }
    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleError, { once: true });
    socket.addEventListener("close", handleClose, { once: true });
  });
}

function waitForMessage(socket: WebSocket, expectedType: string, timeoutMilliseconds = 5_000, expectedSessionId?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("close", handleClose);
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const timeout = window.setTimeout(() => fail(new Error("The media gateway timed out.")), timeoutMilliseconds);
    function handleClose() { fail(new Error("The media gateway connection closed.")); }
    function handleMessage(event: MessageEvent<unknown>) {
      if (typeof event.data !== "string") return;
      try {
        const value: unknown = JSON.parse(event.data);
        if (!value || typeof value !== "object") return;
        const type = (value as Record<string, unknown>).type;
        if (type === "error") { fail(new Error("The media gateway rejected the request.")); return; }
        if (type !== expectedType) return;
        if (expectedSessionId && (value as Record<string, unknown>).sessionId !== expectedSessionId) return;
        cleanup();
        resolve();
      } catch {
        // 다른 이벤트는 상시 상태 리스너가 처리합니다.
      }
    }
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", handleClose, { once: true });
  });
}

function waitForStartedMessage(socket: WebSocket, timeoutMilliseconds = 5_000, expectedType = "started"): Promise<{ version: number }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("close", handleClose);
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const timeout = window.setTimeout(() => fail(new Error("The media gateway timed out.")), timeoutMilliseconds);
    function handleClose() { fail(new Error("The media gateway connection closed.")); }
    function handleMessage(event: MessageEvent<unknown>) {
      if (typeof event.data !== "string") return;
      try {
        const value: unknown = JSON.parse(event.data);
        if (!value || typeof value !== "object") return;
        const message = value as Record<string, unknown>;
        if (message.type === "error") { fail(new Error("The media gateway rejected the request.")); return; }
        if (message.type !== expectedType) return;
        if (!Number.isSafeInteger(message.version) || Number(message.version) < 1) {
          fail(new Error("The media gateway returned an invalid session version."));
          return;
        }
        cleanup();
        resolve({ version: Number(message.version) });
      } catch {
        // 다른 이벤트는 상시 상태 리스너가 처리합니다.
      }
    }
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", handleClose, { once: true });
  });
}

async function openSocket(
  options: AudioClientOptions,
  credentials: GatewayCredentials,
  settings: LiveAudioSettings,
  activationVersion: number,
  activationKey: string | null,
  attachPersistentListeners: (socket: WebSocket) => () => void,
  demandEnabled = false,
  isManualRestart = false,
): Promise<OpenedGatewaySocket> {
  assertSessionVersion(settings.version);
  const captionConfig = buildHostCaptionConfig(settings);
  assertSessionVersion(activationVersion);
  if (activationKey !== null) assertActivationKey(activationKey);
  const hasReadinessActivation = activationKey !== null && (!isManualRestart || settings.sessionStatus === "preparing");
  if (isManualRestart && settings.sessionStatus === "preparing" && !hasReadinessActivation) throw new Error("라이브 시작 인증을 다시 확인해 주세요.");
  getGatewayCredentialRefreshDelay(credentials);
  const endpoint = parseGatewayEndpoint(credentials.gatewayUrl);
  const socket = new WebSocket(endpoint.socketUrl);
  socket.binaryType = "arraybuffer";
  let detachPersistentListeners: (() => void) | null = null;
  try {
    await waitForSocketOpen(socket);
    const authenticated = waitForMessage(socket, "authenticated");
    socket.send(JSON.stringify({ type: "authenticate", token: credentials.token }));
    await authenticated;
    detachPersistentListeners = attachPersistentListeners(socket);
    const started = waitForStartedMessage(socket, 5_000, isManualRestart ? "restarted" : "started");
    socket.send(JSON.stringify({
      type: isManualRestart ? "restart" : "start",
      sessionId: options.sessionId,
      version: isManualRestart || demandEnabled || activationKey === null ? settings.version : activationVersion,
      ...(demandEnabled ? { demandEnabled: true } : {}),
      ...(hasReadinessActivation ? { activationKey } : {}),
      sessionType: settings.sessionType,
      languages: settings.languages,
      outputMode: settings.outputMode,
      voiceProvider: settings.voiceProvider,
      maxViewers: settings.maxViewers,
      glossaryPack: settings.glossaryPack,
      domainText: settings.domainText ?? "",
      captionConfig,
      inputSource: options.inputSource,
    }));
    const startedAck = await started;
    if (socket.readyState !== WebSocket.OPEN) throw new Error("The media gateway connection closed during startup.");
    return {
      socket,
      version: startedAck.version,
      proactiveReconnectDelay: getGatewayCredentialRefreshDelay(credentials),
      detachPersistentListeners,
    };
  } catch (error) {
    detachPersistentListeners?.();
    socket.close();
    throw error;
  }
}

async function getStreams(inputSource: LiveInputSource, audioDeviceId?: string): Promise<MediaStream[]> {
  const streams: MediaStream[] = [];
  try {
    if (inputSource === "mic" || inputSource === "both") {
      try {
        streams.push(await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
            ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}),
          },
        }));
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          throw new LiveAudioRecoveryError(
            "microphone-permission-required",
            "Allow microphone access, then reconnect.",
          );
        }
        throw error;
      }
    }
    if (inputSource === "system" || inputSource === "both") {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (display.getAudioTracks().length === 0) {
        for (const track of display.getTracks()) track.stop();
        throw new Error("System audio was not included with the shared screen.");
      }
      streams.push(display);
    }
    return streams;
  } catch (error) {
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
    throw error;
  }
}

export interface LiveAudioClient {
  isWaitingForParticipants?(): boolean;
  update(settings: LiveAudioSettings): Promise<void>;
  restart(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  disconnect(): Promise<void>;
  drain(): Promise<void>;
  stop(): Promise<void>;
}

export async function startLiveAudioClient(options: AudioClientOptions): Promise<LiveAudioClient> {
  assertSessionVersion(options.version);
  if (options.initialControl !== undefined && options.initialControl !== "start" && options.initialControl !== "restart") throw new Error("라이브 연결 요청이 올바르지 않습니다.");
  const activationKey = options.activationKey === null ? null : options.activationKey ?? createActivationKey();
  const activationVersion = options.version;
  if (activationKey !== null) assertActivationKey(activationKey);
  getGatewayCredentialRefreshDelay(options.credentials);
  const initialGatewayEndpoint = parseGatewayEndpoint(options.credentials.gatewayUrl);
  const streams: MediaStream[] = [];
  let context: AudioContext | null = null;
  let worklet: AudioWorkletNode | null = null;
  let socket: WebSocket | null = null;
  let detachSocketListeners: (() => void) | null = null;
  let reconnectTimer: number | null = null;
  let proactiveReconnectTimer: number | null = null;
  let reconnectPromise: Promise<void> | null = null;
  let reconnectAttempt = 0;
  let isReplacing = false;
  let isStopped = false;
  let stopPromise: Promise<void> | null = null;
  let drainPromise: Promise<void> | null = null;
  let isLocalMediaReleased = false;
  let demandTimer: number | null = null;
  let isDemandEnabled = false;
  let isMediaIdle = false;
  let isCapturePaused = false;
  let isManualRestartRequired = false;
  let hasPendingManualRestart = options.initialControl === "restart";
  let manualRestartPromise: Promise<void> | null = null;
  let currentSettings: LiveAudioSettings = {
    version: options.version,
    sessionStatus: options.sessionStatus,
    sessionType: options.sessionType,
    languages: [...options.languages],
    outputMode: options.outputMode,
    voiceProvider: options.voiceProvider,
    maxViewers: options.maxViewers,
    glossaryPack: options.glossaryPack,
    domainText: options.domainText ?? "",
    modelPreferences: readHostModelPreferences(options.modelPreferences),
  };
  const socketListenerDisposers = new WeakMap<WebSocket, () => void>();
  const captionCursors = new Map<string, {
    finalSeq: number;
    partialSeq: number;
    partialUtteranceKey: string | null;
  }>();

  const releaseLocalMedia = async () => {
    if (isLocalMediaReleased) return;
    isLocalMediaReleased = true;
    if (demandTimer !== null) window.clearTimeout(demandTimer);
    demandTimer = null;
    if (worklet) worklet.port.onmessage = null;
    detachSocketListeners?.();
    detachSocketListeners = null;
    if (socket && socket.readyState !== WebSocket.CLOSING && socket.readyState !== WebSocket.CLOSED) {
      socket.close(1000, "host connection released");
    }
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
    const releaseLease = isDemandEnabled ? options.demandControl?.setSourceReady(false).catch(() => {
      options.onError("마이크 준비 상태 해제를 확인하지 못했습니다. 연결 임대가 만료되면 정리됩니다.");
    }) : undefined;
    await Promise.all([context?.close(), releaseLease]);
  };

  const clearReconnectTimers = () => {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    if (proactiveReconnectTimer !== null) window.clearTimeout(proactiveReconnectTimer);
    reconnectTimer = null;
    proactiveReconnectTimer = null;
  };

  /** Speech captured while the socket is being replaced. Bounded by the
   *  gateway's own 750ms stale-frame budget — anything older is dropped
   *  server-side anyway, so the spool never grows past ~19 frames. */
  let frameSpool: Array<{ pcm: ArrayBuffer; recordedAt: number }> = [];

  const enterMediaIdle = () => {
    isMediaIdle = true;
    clearReconnectTimers();
    frameSpool = [];
    detachSocketListeners?.();
    detachSocketListeners = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "media idle");
    socket = null;
    options.onStatus("참여자 대기 · 대기 중 발언은 기록되지 않아요");
  };

  const checkDemand = async (): Promise<boolean> => {
    if (isManualRestartRequired) return false;
    if (!options.demandControl) return true;
    let runtime = await options.demandControl.read();
    if (isStopped) return false;
    if (isDemandEnabled && !runtime.enabled) throw new Error("참여자 대기 기능이 변경되었습니다. 연결 상태를 다시 확인해 주세요.");
    isDemandEnabled = runtime.enabled;
    if (!runtime.enabled) return true;
    if (runtime.state === "ended" || runtime.state === "failed") {
      enterMediaIdle();
      throw new Error(runtime.state === "ended" ? "회의가 종료됐습니다." : "실시간 연결을 다시 시작해 주세요.");
    }
    const isSourceReady = !isStopped && !isCapturePaused && context?.state === "running"
      && streams.some((stream) => stream.getAudioTracks().some((track) => track.readyState === "live"));
    await options.demandControl.setSourceReady(isSourceReady);
    if (isStopped) return false;
    runtime = await options.demandControl.read();
    if (isStopped) return false;
    if (!runtime.enabled) throw new Error("참여자 대기 기능이 변경되었습니다. 연결 상태를 다시 확인해 주세요.");
    if (runtime.state === "sleeping") enterMediaIdle();
    return isSourceReady && canConnectHostMedia(runtime);
  };

  const scheduleDemandCheck = () => {
    if (!isDemandEnabled || isStopped || isManualRestartRequired || demandTimer !== null) return;
    demandTimer = window.setTimeout(() => {
      demandTimer = null;
      void (async () => {
        try {
          if (await checkDemand() && (!socket || socket.readyState !== WebSocket.OPEN)) await reconnect(true);
          scheduleDemandCheck();
        } catch (error) {
          enterMediaIdle();
          options.onError(error instanceof Error ? error.message : "참여자 연결 상태를 확인하지 못했습니다.");
        }
      })();
    }, 5_000);
  };

  const spoolFrame = (pcm: ArrayBuffer, recordedAt: number) => {
    frameSpool.push({ pcm, recordedAt });
    const staleBefore = Date.now() - FRAME_SPOOL_STALE_MILLISECONDS;
    while (frameSpool.length > 0 && frameSpool[0].recordedAt < staleBefore) frameSpool.shift();
  };

  const flushFrameSpool = () => {
    const pending = frameSpool;
    frameSpool = [];
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const staleBefore = Date.now() - FRAME_SPOOL_STALE_MILLISECONDS;
    for (const frame of pending) {
      if (frame.recordedAt >= staleBefore) socket.send(frame.pcm);
    }
  };

  const endAfterReplacement = async () => {
    if (isStopped) return;
    isStopped = true;
    clearReconnectTimers();
    frameSpool = [];
    try {
      await releaseLocalMedia();
    } catch {
      // The takeover already owns the session; local cleanup is best-effort.
    }
    if (options.onReplaced) options.onReplaced();
    else options.onError("다른 기기에서 호스트로 접속해 이 기기의 송출이 중지되었습니다.");
  };

  let lastSourceSeq = 0;
  const attachPersistentListeners = (candidate: WebSocket) => {
    const existingDisposer = socketListenerDisposers.get(candidate);
    if (existingDisposer) return existingDisposer;
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") return;
      try {
        const value: unknown = JSON.parse(event.data);
        if (!value || typeof value !== "object") return;
        const message = value as Record<string, unknown>;
        if (message.type === "source") {
          const source = sourceEventSchema.safeParse(message);
          if (isStopped || !source.success || source.data.sessionId !== options.sessionId || source.data.sourceSeq <= lastSourceSeq) return;
          lastSourceSeq = source.data.sourceSeq;
          options.onSource?.(source.data);
          return;
        }
        if (message.type === "source-status") {
          if (!isStopped && message.sessionId === options.sessionId && message.status === "unavailable"
            && message.code === "SOURCE_RECORDING_UNAVAILABLE"
            && Object.keys(message).every((key) => ["type", "sessionId", "status", "code"].includes(key))) options.onSourceStatus?.("unavailable");
          return;
        }
        if (message.type === "media-idle" && message.sessionId === options.sessionId && isDemandEnabled) {
          candidate.send(JSON.stringify({ type: "media-idle-ack", epoch: message.epoch }));
          enterMediaIdle();
          return;
        }
        if (isHostCaptionEvent(message, options.sessionId, currentSettings.languages)) {
          const cursor = captionCursors.get(message.language) ?? {
            finalSeq: 0,
            partialSeq: 0,
            partialUtteranceKey: null,
          };
          const utteranceKey = message.utteranceKey ?? null;
          if (message.isFinal) {
            if (message.seq <= cursor.finalSeq) return;
            if (message.seq === cursor.partialSeq
              && cursor.partialUtteranceKey !== null
              && utteranceKey !== null
              && cursor.partialUtteranceKey !== utteranceKey) return;
            captionCursors.set(message.language, {
              finalSeq: message.seq,
              partialSeq: message.seq,
              partialUtteranceKey: utteranceKey,
            });
          } else {
            if (message.seq <= cursor.finalSeq || message.seq < cursor.partialSeq) return;
            if (message.seq === cursor.partialSeq
              && cursor.partialUtteranceKey !== null
              && utteranceKey !== null
              && cursor.partialUtteranceKey !== utteranceKey) return;
            captionCursors.set(message.language, {
              ...cursor,
              partialSeq: message.seq,
              partialUtteranceKey: utteranceKey,
            });
          }
          options.onCaption?.(message);
          return;
        }
        if (message.type === "session-status"
          && message.sessionId === options.sessionId
          && (message.status === "preparing" || message.status === "live" || message.status === "paused"
            || message.status === "stopped" || message.status === "failed")) {
          options.onStatus(message.status);
        }
        if (message.type === "status" && typeof message.status === "string") options.onStatus(message.status);
        if (message.type === "error") {
          if (message.requiresManualRestart === true || message.code === "PIPELINE_RESTART_REQUIRED" || message.code === "PIPELINE_CLEANUP_FAILED") {
            isManualRestartRequired = true;
            options.onManualRestartRequired?.();
            hasPendingManualRestart = false;
            enterMediaIdle();
            if (demandTimer !== null) window.clearTimeout(demandTimer);
            demandTimer = null;
          }
          if (typeof message.message === "string") options.onError(message.message);
        }
        if (message.type === "speaker-legend" && Array.isArray(message.speakers) && message.speakers.every(isSpeakerAssignment)) {
          options.onSpeakers(message.speakers);
        }
        if (message.type === "engine-status") {
          const engineStatus = readEngineStatusEvent(message, options.sessionId);
          if (engineStatus && !isStopped) options.onEngineStatus?.(engineStatus);
          return;
        }
        if (message.type === "language-status"
          && message.sessionId === options.sessionId
          && typeof message.language === "string"
          && currentSettings.languages.includes(message.language)
          && (message.status === "preparing" || message.status === "ready" || message.status === "unavailable")) {
          options.onLanguageStatus(message.language, message.status);
        }
      } catch {
        options.onError("Unable to read a gateway status message.");
      }
    };
    const handleClose = (event: Event) => {
      if (isStopped || isReplacing || socket !== candidate) return;
      // 4410 = another host took over (second tab, or a web↔Electron
      // takeover). Our OWN credential swap also 4410s the old socket, but the
      // isReplacing / socket-identity guards above already exclude that case.
      if ((event as CloseEvent).code === HOST_REPLACED_CLOSE_CODE) {
        void endAfterReplacement();
        return;
      }
      scheduleReconnect();
    };
    const dispose = () => {
      candidate.removeEventListener("message", handleMessage);
      candidate.removeEventListener("close", handleClose);
      socketListenerDisposers.delete(candidate);
    };
    candidate.addEventListener("message", handleMessage);
    candidate.addEventListener("close", handleClose);
    socketListenerDisposers.set(candidate, dispose);
    return dispose;
  };

  const scheduleReconnect = () => {
    if (isStopped || isMediaIdle || isManualRestartRequired || reconnectTimer !== null || reconnectPromise !== null) return;
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

  const refreshDemandSettings = async (isManualRestart = false) => {
    if (!isDemandEnabled && !isManualRestart) return;
    if (!options.refreshSettings) throw new Error("최신 회의 설정을 확인할 수 없습니다.");
    const fresh = await options.refreshSettings();
    assertSessionVersion(fresh.version);
    currentSettings = { ...fresh, languages: [...fresh.languages], modelPreferences: readHostModelPreferences(fresh.modelPreferences) };
  };

  const reconnect = async (throwOnError = false): Promise<void> => {
    if (isStopped) return;
    if (reconnectPromise) return reconnectPromise;
    let hasReconnected = false;
    reconnectPromise = (async () => {
      clearReconnectTimers();
      if (!await checkDemand()) return;
      isMediaIdle = false;
      const credentials = await options.refreshCredentials();
      if (isStopped) return;
      await refreshDemandSettings(hasPendingManualRestart);
      if (isStopped) return;
      if (isDemandEnabled && !await checkDemand()) return;
      getGatewayCredentialRefreshDelay(credentials);
      isReplacing = true;
      try {
        const isManualRestart = hasPendingManualRestart;
        hasPendingManualRestart = false;
        const opened = await openSocket(options, credentials, currentSettings, activationVersion, activationKey, attachPersistentListeners, isDemandEnabled, isManualRestart);
        if (isStopped) {
          opened.detachPersistentListeners();
          opened.socket.close(1000, "host stopped");
          return;
        }
        const previous = socket;
        const detachPreviousListeners = detachSocketListeners;
        socket = opened.socket;
        currentSettings = { ...currentSettings, version: opened.version };
        detachSocketListeners = opened.detachPersistentListeners;
        detachPreviousListeners?.();
        if (previous && previous.readyState !== WebSocket.CLOSING && previous.readyState !== WebSocket.CLOSED) {
          previous.close(1000, "connection refreshed");
        }
        reconnectAttempt = 0;
        scheduleProactiveReconnect(opened.proactiveReconnectDelay);
        isReplacing = false;
        flushFrameSpool();
        options.onStatus("Connected · broadcasting");
      } finally {
        isReplacing = false;
      }
    })();
    try {
      await reconnectPromise;
      hasReconnected = true;
    } catch (error: unknown) {
      if (!isStopped) options.onError(error instanceof Error ? error.message : "Unable to reconnect to the media gateway.");
      if (isDemandEnabled) {
        enterMediaIdle();
        if (demandTimer !== null) window.clearTimeout(demandTimer);
        demandTimer = null;
      }
      if (throwOnError) throw error;
    } finally {
      reconnectPromise = null;
    }
    if (!isStopped && !hasReconnected) scheduleReconnect();
  };

  try {
    streams.push(...await getStreams(options.inputSource, options.audioDeviceId));
    context = new AudioContext();
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          throw new LiveAudioRecoveryError(
            "audio-user-activation-required",
            "Reconnect microphone from the browser.",
          );
        }
        throw error;
      }
    }
    await context.audioWorklet.addModule("/live-audio-worklet.js");
    worklet = new AudioWorkletNode(context, "live-pcm-processor", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    for (const stream of streams) context.createMediaStreamSource(stream).connect(worklet);
    const shouldConnect = await checkDemand();
    if (shouldConnect && !isDemandEnabled && !prewarmedGatewayUrls.delete(initialGatewayEndpoint.healthUrl)) {
      await warmGateway(initialGatewayEndpoint.healthUrl);
    }
    if (shouldConnect) {
      await refreshDemandSettings(hasPendingManualRestart);
      isMediaIdle = false;
      const isManualRestart = hasPendingManualRestart;
      hasPendingManualRestart = false;
      const opened = await openSocket(options, options.credentials, currentSettings, activationVersion, activationKey, attachPersistentListeners, isDemandEnabled, isManualRestart);
      socket = opened.socket;
      currentSettings = { ...currentSettings, version: opened.version };
      detachSocketListeners = opened.detachPersistentListeners;
      reconnectAttempt = 0;
      scheduleProactiveReconnect(opened.proactiveReconnectDelay);
    } else enterMediaIdle();
    scheduleDemandCheck();
    worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      if (isStopped || isCapturePaused || isMediaIdle) return;
      if (!isWorkletMessage(event.data)) return;
      if (event.data.type === "audioStreamEnd") {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "audioStreamEnd" }));
        return;
      }
      // 2026-07-19 feat: 실시간성 보존을 위해 750ms를 넘긴 대기 프레임은 폐기합니다.
      if (Date.now() - event.data.recordedAt > FRAME_SPOOL_STALE_MILLISECONDS
        || event.data.pcm.byteLength !== LIVE_PCM_FRAME_BYTES) return;
      if (socket?.readyState === WebSocket.OPEN && !isReplacing) {
        socket.send(event.data.pcm);
        return;
      }
      // Socket swap in flight: keep speech within the gateway's stale budget
      // so the token rollover does not punch a hole in the transcript.
      if (!isStopped && !isMediaIdle) spoolFrame(event.data.pcm, event.data.recordedAt);
    };
    if (!isMediaIdle) options.onStatus("Connected · broadcasting");
    return {
      isWaitingForParticipants: () => isMediaIdle,
      async update(settings) {
        const modelPreferences = readHostModelPreferences(settings.modelPreferences === undefined ? currentSettings.modelPreferences : settings.modelPreferences);
        const captionConfig = buildHostCaptionConfig({ ...settings, modelPreferences });
        if (isDemandEnabled && isMediaIdle) {
          assertSessionVersion(settings.version);
          currentSettings = { ...settings, languages: [...settings.languages], modelPreferences };
          return;
        }
        if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("The media gateway is not connected.");
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
          domainText: settings.domainText ?? "",
          captionConfig,
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
          domainText: settings.domainText ?? "",
          modelPreferences,
        };
      },
      async restart() {
        if (manualRestartPromise) return manualRestartPromise;
        manualRestartPromise = (async () => {
          if (isStopped) throw new Error("이미 종료한 연결입니다.");
          clearReconnectTimers();
          if (reconnectPromise) await reconnectPromise.catch(() => {});
          if (isStopped) throw new Error("이미 종료한 연결입니다.");
          if (isDemandEnabled) {
            if (!options.demandControl) throw new Error("참여자 대기 기능을 확인할 수 없습니다.");
            await options.demandControl.retryStart();
          }
          if (isStopped) return;
          isManualRestartRequired = false;
          hasPendingManualRestart = true;
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            await reconnect(true);
          } else {
            await refreshDemandSettings(true);
            if (isStopped || !socket || socket.readyState !== WebSocket.OPEN) throw new Error("연결 상태가 변경됐습니다. 다시 시작해 주세요.");
            hasPendingManualRestart = false;
            const restarted = waitForStartedMessage(socket, 5_000, "restarted");
            socket.send(JSON.stringify({ type: "restart", sessionId: options.sessionId,
              version: currentSettings.version, sessionType: currentSettings.sessionType, languages: currentSettings.languages,
              outputMode: currentSettings.outputMode, voiceProvider: currentSettings.voiceProvider,
              maxViewers: currentSettings.maxViewers, glossaryPack: currentSettings.glossaryPack, domainText: currentSettings.domainText ?? "",
              captionConfig: buildHostCaptionConfig(currentSettings),
              ...(currentSettings.sessionStatus === "preparing" && activationKey !== null ? { activationKey } : {}),
              ...(isDemandEnabled ? { demandEnabled: true } : {}), inputSource: options.inputSource }));
            const ack = await restarted;
            currentSettings = { ...currentSettings, version: ack.version };
          }
          scheduleDemandCheck();
        })().catch((error: unknown) => {
          hasPendingManualRestart = false;
          throw error;
        }).finally(() => { manualRestartPromise = null; });
        return manualRestartPromise;
      },
      async pause() {
        isCapturePaused = true;
        await context?.suspend();
        if (isDemandEnabled && isMediaIdle) { await options.demandControl?.setSourceReady(false); return; }
        if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("The media gateway is not connected.");
        const paused = waitForMessage(socket, "paused", STOP_ACK_TIMEOUT_MILLISECONDS);
        socket.send(JSON.stringify({ type: "pause" }));
        await paused;
      },
      async resume() {
        isCapturePaused = false;
        if (isDemandEnabled && isMediaIdle) { await context?.resume(); await reconnect(true); scheduleDemandCheck(); return; }
        if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("The media gateway is not connected.");
        const resumed = waitForMessage(socket, "resumed", STOP_ACK_TIMEOUT_MILLISECONDS);
        socket.send(JSON.stringify({ type: "resume" }));
        await resumed;
        try {
          await context?.resume();
        } catch (error) {
          if (socket.readyState === WebSocket.OPEN) {
            const paused = waitForMessage(socket, "paused", STOP_ACK_TIMEOUT_MILLISECONDS);
            socket.send(JSON.stringify({ type: "pause" }));
            await paused.catch(() => undefined);
          }
          throw error;
        }
      },
      async disconnect() {
        if (stopPromise) return stopPromise;
        isStopped = true;
        clearReconnectTimers();
        frameSpool = [];
        stopPromise = (async () => {
          try {
            // 2026-08-31 fix: Navigation releases capture without the terminal
            // stop signal, so the saved session and participant view survive.
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "detach" }));
            }
          } finally {
            await releaseLocalMedia();
          }
        })();
        return stopPromise;
      },
      async drain() {
        if (drainPromise) return drainPromise;
        isStopped = true;
        isCapturePaused = true;
        clearReconnectTimers();
        frameSpool = [];
        drainPromise = (async () => {
          await context?.suspend();
          if (isDemandEnabled && isMediaIdle && !socket) return;
          const activeSocket = socket;
          if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
            throw new Error("원문 저장을 확인할 연결이 없습니다. 회의 종료를 다시 시도해 주세요.");
          }
          const drained = waitForMessage(activeSocket, "drained", 12_000, options.sessionId);
          activeSocket.send(JSON.stringify({ type: "drain", sessionId: options.sessionId }));
          await drained;
        })().catch((error: unknown) => { drainPromise = null; throw error; });
        return drainPromise;
      },
      async stop() {
        if (stopPromise) return stopPromise;
        isStopped = true;
        clearReconnectTimers();
        stopPromise = (async () => {
          try {
            const activeSocket = socket;
            if (activeSocket?.readyState === WebSocket.OPEN) {
              const audioEnded = waitForMessage(activeSocket, "audio-stream-ended", STOP_ACK_TIMEOUT_MILLISECONDS);
              activeSocket.send(JSON.stringify({ type: "audioStreamEnd" }));
              await audioEnded.catch(() => undefined);
              if (activeSocket.readyState === WebSocket.OPEN) {
                const stopped = waitForMessage(activeSocket, "stopped", STOP_ACK_TIMEOUT_MILLISECONDS);
                activeSocket.send(JSON.stringify({ type: "stop" }));
                await stopped.catch(() => undefined);
              }
            }
          } finally {
            await releaseLocalMedia();
          }
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    isStopped = true;
    clearReconnectTimers();
    await releaseLocalMedia();
    throw error;
  }
}
