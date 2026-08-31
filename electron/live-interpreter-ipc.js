import path from "node:path";

import {
  LIVE_INTERPRETER_LANGUAGES,
  MAX_INTERPRETER_AUDIO_BYTES,
  MAX_INTERPRETER_AUDIO_DELTA_BASE64_CHARS,
} from "../src/live-interpreter/index.js";

/** @typedef {{id: number, getURL?: () => string, isDestroyed?: () => boolean, send: (channel: string, payload: unknown) => void, setWindowOpenHandler?: (handler: () => {action: string}) => void}} WebContentsLike */
/** @typedef {{x: number, y: number, width: number, height: number}} WindowBounds */
/** @typedef {{webContents: WebContentsLike, isDestroyed?: () => boolean, show: () => void, focus: () => void, close: () => void, on: (event: string, listener: () => void) => unknown, loadURL: (url: string) => Promise<unknown>, getBounds?: () => WindowBounds, setBounds?: (bounds: WindowBounds) => void, setAlwaysOnTop?: (value: boolean, level?: string) => void, setResizable?: (value: boolean) => void, setMinimumSize?: (width: number, height: number) => void}} WindowLike */
/** @typedef {{getSnapshot: () => unknown, subscribe?: (listener: (snapshot: unknown) => void) => (() => void), start: (input: unknown) => Promise<unknown>, pushPcm: (input: unknown) => unknown, reconnect: (lane: string) => Promise<unknown>, stop: () => Promise<unknown>, dispose?: () => unknown|Promise<unknown>}} ControllerLike */
/** @typedef {{apiKeys?: {openai?: unknown}}} LoadedSettings */
/** @typedef {{workArea?: WindowBounds}} DisplayLike */
/** @typedef {{getDisplayMatching?: (bounds: WindowBounds) => DisplayLike, getPrimaryDisplay?: () => DisplayLike}} ScreenLike */

export const LIVE_INTERPRETER_CHANNELS = Object.freeze({
  getEnabled: "live-interpreter:get-enabled",
  open: "live-interpreter:open",
  close: "live-interpreter:close",
  getSnapshot: "live-interpreter:get-snapshot",
  start: "live-interpreter:start",
  audio: "live-interpreter:audio",
  reconnect: "live-interpreter:reconnect",
  stop: "live-interpreter:stop",
  getDevicePreflight: "live-interpreter:get-device-preflight",
  snapshot: "live-interpreter:snapshot",
});

const MODES = new Set(["ONLINE", "IN_PERSON"]);
const DEFAULT_LANGUAGES = LIVE_INTERPRETER_LANGUAGES;
const OFFICIAL_LANGUAGES = new Set(LIVE_INTERPRETER_LANGUAGES);
const LANES_BY_MODE = Object.freeze({
  ONLINE: new Set(["INBOUND", "OUTBOUND"]),
  IN_PERSON: new Set(["USER", "OTHER"]),
});
const CONTROLLER_STATES = new Set(["IDLE", "STARTING", "RUNNING", "STOPPING", "ERROR"]);
const LANE_STATES = new Set(["IDLE", "CONNECTING", "ACTIVE", "CLOSING", "CLOSED", "ERROR"]);
const START_KEYS = new Set(["mode", "userLanguage", "otherLanguage", "devicePreflight"]);
const AUDIO_KEYS = new Set(["lane", "sampleRate", "frameDurationMs", "pcm"]);
const RECONNECT_KEYS = new Set(["lane"]);
const DEVICE_PREFLIGHT_KEYS = new Set(["microphone", "systemAudio", "virtualOutput"]);
const MICROPHONE_KEYS = new Set(["available", "deviceId", "label"]);
const SYSTEM_AUDIO_KEYS = new Set(["available", "method"]);
const VIRTUAL_OUTPUT_KEYS = new Set(["available", "deviceId", "label"]);
const SYSTEM_AUDIO_METHODS = new Set(["electron-loopback", "display-capture", "none"]);
const PCM_SAMPLE_RATE = 24_000;
const PCM_FRAME_DURATION_MS = 100;
const PCM_FRAME_BYTES = PCM_SAMPLE_RATE * 2 * PCM_FRAME_DURATION_MS / 1_000;
const MAX_TEXT_LENGTH = 12_000;
const MAX_RECORDS = 500;
const MAX_AUDIO_DELTA_BASE64_LENGTH = MAX_INTERPRETER_AUDIO_DELTA_BASE64_CHARS;
const PREFLIGHT_MIN_WIDTH = 880;
const PREFLIGHT_MIN_HEIGHT = 620;
const DOCK_WIDTH = 480;
const DOCK_HEIGHT = 720;
const DOCK_MIN_WIDTH = 420;
const DOCK_MIN_HEIGHT = 520;
const DOCK_MARGIN = 24;
const FALLBACK_BOUNDS = Object.freeze({ x: 0, y: 0, width: 1_180, height: 780 });

/** @param {Record<string, unknown>} [environment] */
export function resolveLiveInterpreterEnabled(environment = process.env) {
  const value = environment?.REALTIME_NOEL_LIVE_INTERPRETER_ENABLED;
  return !(value === false || (typeof value === "string" && value.trim().toLowerCase() === "false"));
}

/**
 * @param {{
 * ipc: {handle: Function, removeHandler?: Function, on?: Function, removeListener?: Function},
 * BrowserWindowClass: new (options: Record<string, unknown>) => WindowLike,
 * settingsStore: {load: () => Promise<LoadedSettings>}, serverUrl: string, localAppOrigin: string,
 * createController: (options: {getApiKey: () => Promise<string>}) => ControllerLike,
 * getDashboardWindow?: () => WindowLike|null, featureEnabled?: boolean, platform?: string, preloadPath?: string,
 * supportedLanguages?: readonly string[], screenApi?: ScreenLike, canStartProtectedAction?: () => boolean,
 * }} options
 */
export function registerLiveInterpreterIpc({
  ipc,
  BrowserWindowClass,
  settingsStore,
  serverUrl,
  localAppOrigin,
  createController,
  getDashboardWindow = () => null,
  canStartProtectedAction = () => true,
  featureEnabled = true,
  platform = process.platform,
  screenApi,
  preloadPath = path.join(import.meta.dirname, "preload.js"),
  supportedLanguages = DEFAULT_LANGUAGES,
}) {
  if (!ipc?.handle || !BrowserWindowClass || !settingsStore?.load || !serverUrl || !localAppOrigin) {
    throw new Error("Live Interpreter Electron dependencies are required.");
  }
  if (featureEnabled && typeof createController !== "function") {
    throw new Error("Live Interpreter controller factory is required.");
  }

  /** @type {WindowLike|null} */
  let interpreterWindow = null;
  /** @type {ControllerLike|null} */
  let controller = null;
  /** @type {null|(() => void)} */
  let unsubscribe = null;
  let activeMode = null;
  let windowMode = "CLOSED";
  /** @type {WindowBounds|null} */
  let preflightBounds = null;
  let isDisposed = false;
  let pendingOperations = 0;
  /** @type {Promise<unknown>|null} */
  let disposePromise = null;
  const configuredLanguages = Array.isArray(supportedLanguages) ? supportedLanguages : DEFAULT_LANGUAGES;
  const allowedLanguages = new Set(configuredLanguages.filter((language) => OFFICIAL_LANGUAGES.has(language)));

  function isEnabled() {
    return featureEnabled === true && !isDisposed;
  }

  async function getApiKey() {
    const settings = await settingsStore.load();
    if (!isRecord(settings.apiKeys)) return "";
    return cleanText(settings.apiKeys.openai, 500).trim();
  }

  function ensureController() {
    if (!isEnabled()) return null;
    if (controller) return controller;
    const createdController = createController({ getApiKey });
    if (!createdController || typeof createdController.getSnapshot !== "function") {
      controller = null;
      throw new Error("Live Interpreter controller is invalid.");
    }
    controller = createdController;
    if (typeof controller.subscribe === "function") {
      unsubscribe = controller.subscribe((snapshot) => {
        const safeSnapshot = sanitizeSnapshot(snapshot);
        if (safeSnapshot.state === "IDLE" || safeSnapshot.state === "ERROR") {
          activeMode = null;
          returnToPreflight();
        }
        if (isAlive(interpreterWindow)) {
          interpreterWindow.webContents.send(LIVE_INTERPRETER_CHANNELS.snapshot, safeSnapshot);
        }
      });
    }
    return controller;
  }

  async function open() {
    if (!isEnabled() || !canStartProtectedAction()) return null;
    ensureController();
    if (isAlive(interpreterWindow)) {
      interpreterWindow.show();
      interpreterWindow.focus();
      return interpreterWindow;
    }
    const window = new BrowserWindowClass({
      width: 1180,
      height: 780,
      minWidth: 880,
      minHeight: 620,
      title: "NOVA Live Interpreter",
      backgroundColor: "#000000",
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        preload: preloadPath,
      },
    });
    interpreterWindow = window;
    windowMode = "PREFLIGHT";
    preflightBounds = null;
    window.webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));
    window.on("closed", () => {
      if (interpreterWindow === window) interpreterWindow = null;
      windowMode = "CLOSED";
      preflightBounds = null;
      if (activeMode || readSnapshotMode(controller?.getSnapshot?.())) {
        activeMode = null;
        const result = controller?.stop?.();
        if (result && typeof result.catch === "function") result.catch(() => {});
      }
    });
    await window.loadURL(new URL("/live-interpreter.html", serverUrl).toString());
    if (interpreterWindow !== window || !isAlive(window)) return null;
    window.show();
    window.focus();
    window.webContents.send(LIVE_INTERPRETER_CHANNELS.snapshot, sanitizeSnapshot(controller.getSnapshot()));
    return window;
  }

  function close() {
    if (!isAlive(interpreterWindow)) return false;
    interpreterWindow.close();
    return true;
  }

  function enterLiveDock() {
    if (!isAlive(interpreterWindow) || windowMode === "LIVE_DOCK") return;
    const referenceBounds = readWindowBounds(interpreterWindow);
    const workArea = resolveWorkArea(screenApi, referenceBounds);
    preflightBounds = referenceBounds;
    const dockBounds = rightTopDockBounds(workArea);
    interpreterWindow.setMinimumSize?.(
      Math.min(DOCK_MIN_WIDTH, workArea.width),
      Math.min(DOCK_MIN_HEIGHT, workArea.height),
    );
    interpreterWindow.setResizable?.(true);
    interpreterWindow.setBounds?.(dockBounds);
    interpreterWindow.setAlwaysOnTop?.(true, "floating");
    windowMode = "LIVE_DOCK";
  }

  function returnToPreflight() {
    if (!isAlive(interpreterWindow)) {
      windowMode = "CLOSED";
      preflightBounds = null;
      return;
    }
    if (windowMode !== "LIVE_DOCK") {
      windowMode = "PREFLIGHT";
      return;
    }
    const referenceBounds = preflightBounds ?? readWindowBounds(interpreterWindow);
    const workArea = resolveWorkArea(screenApi, referenceBounds);
    const restoredBounds = clampBoundsToWorkArea(referenceBounds, workArea, PREFLIGHT_MIN_WIDTH, PREFLIGHT_MIN_HEIGHT);
    interpreterWindow.setAlwaysOnTop?.(false);
    interpreterWindow.setResizable?.(true);
    interpreterWindow.setMinimumSize?.(
      Math.min(PREFLIGHT_MIN_WIDTH, workArea.width),
      Math.min(PREFLIGHT_MIN_HEIGHT, workArea.height),
    );
    interpreterWindow.setBounds?.(restoredBounds);
    windowMode = "PREFLIGHT";
    preflightBounds = null;
  }

  function assertExactLocalUrl(value) {
    let parsed;
    try {
      parsed = new URL(String(value ?? ""));
    } catch {
      throw new Error("FORBIDDEN");
    }
    if (parsed.origin !== localAppOrigin || parsed.username || parsed.password) throw new Error("FORBIDDEN");
  }

  function senderKind(event) {
    if (!isRecord(event) || !isRecord(event.sender)) throw new Error("FORBIDDEN");
    const senderFrame = isRecord(event.senderFrame) ? event.senderFrame : null;
    const senderUrl = senderFrame?.url
      ?? (typeof event.sender.getURL === "function" ? event.sender.getURL() : "");
    assertExactLocalUrl(senderUrl);
    const senderId = Number(event.sender.id);
    if (isAlive(interpreterWindow) && interpreterWindow.webContents.id === senderId) return "interpreter";
    const dashboardWindow = getDashboardWindow?.();
    if (isAlive(dashboardWindow) && dashboardWindow.webContents.id === senderId) return "dashboard";
    throw new Error("FORBIDDEN");
  }

  function assertSender(event, allowedKinds) {
    if (!allowedKinds.includes(senderKind(event))) throw new Error("FORBIDDEN");
  }

  const registeredHandlers = new Set();
  const registerHandler = (channel, allowedKinds, operation) => {
    ipc.removeHandler?.(channel);
    ipc.handle(channel, async (event, input) => {
      assertSender(event, allowedKinds);
      try {
        const isProtectedOperation = channel === LIVE_INTERPRETER_CHANNELS.start || channel === LIVE_INTERPRETER_CHANNELS.reconnect;
        if (isProtectedOperation && !canStartProtectedAction()) return { ok: false, code: "HOST_LOGIN_REQUIRED", error: "로그인이 필요합니다." };
        if (isProtectedOperation) pendingOperations++;
        try { return { ok: true, data: await operation(input) }; }
        finally { if (isProtectedOperation) pendingOperations--; }
      } catch (error) {
        if (error instanceof Error && error.message === "FORBIDDEN") throw error;
        return {
          ok: false,
          error: userFacingError(error),
          code: errorCode(error),
        };
      }
    });
    registeredHandlers.add(channel);
  };

  registerHandler(LIVE_INTERPRETER_CHANNELS.getEnabled, ["dashboard", "interpreter"], () => isEnabled());
  registerHandler(LIVE_INTERPRETER_CHANNELS.open, ["dashboard", "interpreter"], async () => Boolean(await open()));
  registerHandler(LIVE_INTERPRETER_CHANNELS.close, ["dashboard", "interpreter"], () => close());

  if (featureEnabled) {
    registerHandler(LIVE_INTERPRETER_CHANNELS.getSnapshot, ["interpreter"], () => {
      const activeController = ensureController();
      return sanitizeSnapshot(activeController.getSnapshot());
    });
    registerHandler(LIVE_INTERPRETER_CHANNELS.start, ["interpreter"], async (input) => {
      const config = sanitizeStartRequest(input, allowedLanguages);
      const activeController = ensureController();
      await activeController.start(config.controllerConfig);
      activeMode = config.controllerConfig.mode;
      enterLiveDock();
      return sanitizeSnapshot(activeController.getSnapshot());
    });
    registerHandler(LIVE_INTERPRETER_CHANNELS.reconnect, ["interpreter"], async (input) => {
      const lane = sanitizeReconnectRequest(input, currentMode());
      await ensureController().reconnect(lane);
      return sanitizeSnapshot(ensureController().getSnapshot());
    });
    registerHandler(LIVE_INTERPRETER_CHANNELS.stop, ["interpreter"], async () => {
      try {
        await ensureController().stop();
        return sanitizeSnapshot(ensureController().getSnapshot());
      } finally {
        activeMode = null;
        returnToPreflight();
      }
    });
    registerHandler(LIVE_INTERPRETER_CHANNELS.getDevicePreflight, ["interpreter"], () => (
      devicePreflightMetadata(platform)
    ));
  }

  const audioListener = (event, input) => {
    try {
      assertSender(event, ["interpreter"]);
      const packet = sanitizeAudioPacket(input, currentMode());
      const result = ensureController()?.pushPcm?.(packet);
      void Promise.resolve(result).catch(() => {});
    } catch {
      // Audio is fire-and-forget. Invalid or stale packets are dropped without
      // reflecting attacker-controlled detail into the renderer.
    }
  };
  if (featureEnabled && typeof ipc.on === "function") ipc.on(LIVE_INTERPRETER_CHANNELS.audio, audioListener);

  function currentMode() {
    const snapshot = controller?.getSnapshot?.();
    return readSnapshotMode(snapshot) ?? activeMode;
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    isDisposed = true;
    close();
    for (const channel of registeredHandlers) ipc.removeHandler?.(channel);
    registeredHandlers.clear();
    if (featureEnabled) ipc.removeListener?.(LIVE_INTERPRETER_CHANNELS.audio, audioListener);
    const release = unsubscribe;
    unsubscribe = null;
    release?.();
    const activeController = controller;
    controller = null;
    activeMode = null;
    try {
      disposePromise = Promise.resolve(activeController?.dispose?.()).catch(() => undefined);
    } catch (error) {
      disposePromise = Promise.resolve();
    }
    return disposePromise;
  }

  return {
    isEnabled,
    open,
    close,
    hasPendingOperations: () => pendingOperations > 0,
    getSnapshot: () => sanitizeSnapshot(controller?.getSnapshot?.()),
    getWindowMode: () => windowMode,
    dispose,
    shutdown: dispose,
  };
}

function sanitizeStartRequest(value, allowedLanguages) {
  if (!hasExactKeys(value, START_KEYS) || !Object.hasOwn(value, "devicePreflight")) throw invalidRequest();
  const mode = value.mode;
  const userLanguage = cleanLanguage(value.userLanguage, allowedLanguages);
  const otherLanguage = cleanLanguage(value.otherLanguage, allowedLanguages);
  if (!MODES.has(mode) || !userLanguage || !otherLanguage || userLanguage === otherLanguage) throw invalidRequest();
  sanitizeReportedDevicePreflight(value.devicePreflight, mode);
  return { controllerConfig: { mode, userLanguage, otherLanguage } };
}

function sanitizeReportedDevicePreflight(value, mode) {
  if (!hasExactKeys(value, DEVICE_PREFLIGHT_KEYS)
    || !Object.hasOwn(value, "microphone")
    || !Object.hasOwn(value, "systemAudio")
    || !Object.hasOwn(value, "virtualOutput")) throw invalidRequest();
  if (!hasExactKeys(value.microphone, MICROPHONE_KEYS)
    || !hasExactKeys(value.systemAudio, SYSTEM_AUDIO_KEYS)
    || !hasExactKeys(value.virtualOutput, VIRTUAL_OUTPUT_KEYS)) {
    throw invalidRequest();
  }
  const microphone = value.microphone;
  const systemAudio = value.systemAudio;
  const virtualOutput = value.virtualOutput;
  if (typeof microphone.available !== "boolean"
    || typeof systemAudio.available !== "boolean"
    || typeof virtualOutput.available !== "boolean"
    || !SYSTEM_AUDIO_METHODS.has(systemAudio.method)
    || cleanText(microphone.deviceId, 512) !== microphone.deviceId
    || cleanText(microphone.label, 256) !== microphone.label
    || cleanText(virtualOutput.deviceId, 512) !== virtualOutput.deviceId
    || cleanText(virtualOutput.label, 256) !== virtualOutput.label) throw invalidRequest();
  if (!microphone.available
    || (mode === "ONLINE" && (!systemAudio.available
      || !virtualOutput.available
      || !virtualOutput.deviceId
      || !/blackhole/iu.test(virtualOutput.label)))) throw invalidRequest();
}

function sanitizeReconnectRequest(value, mode) {
  if (!hasExactKeys(value, RECONNECT_KEYS) || !MODES.has(mode) || !LANES_BY_MODE[mode].has(value.lane)) {
    throw invalidRequest();
  }
  return value.lane;
}

function sanitizeAudioPacket(value, mode) {
  if (!hasExactKeys(value, AUDIO_KEYS)
    || !MODES.has(mode)
    || !LANES_BY_MODE[mode].has(value.lane)
    || value.sampleRate !== PCM_SAMPLE_RATE
    || value.frameDurationMs !== PCM_FRAME_DURATION_MS
    || !(value.pcm instanceof ArrayBuffer)
    || value.pcm.byteLength !== PCM_FRAME_BYTES) throw invalidRequest();
  return { lane: value.lane, audioBase64: Buffer.from(value.pcm).toString("base64") };
}

/** @param {WindowLike} window */
function readWindowBounds(window) {
  try {
    return normalizeBounds(window.getBounds?.(), FALLBACK_BOUNDS);
  } catch {
    return { ...FALLBACK_BOUNDS };
  }
}

/** @param {ScreenLike|undefined} screenApi @param {WindowBounds} referenceBounds */
function resolveWorkArea(screenApi, referenceBounds) {
  let display;
  try {
    display = screenApi?.getDisplayMatching?.(referenceBounds);
  } catch {
    display = null;
  }
  if (!isRecord(display)) {
    try {
      display = screenApi?.getPrimaryDisplay?.();
    } catch {
      display = null;
    }
  }
  return normalizeBounds(isRecord(display) ? display.workArea : null, referenceBounds);
}

/** @param {WindowBounds} workArea */
function rightTopDockBounds(workArea) {
  const width = Math.min(DOCK_WIDTH, workArea.width);
  const height = Math.min(DOCK_HEIGHT, workArea.height);
  return {
    x: Math.max(workArea.x, workArea.x + workArea.width - width - DOCK_MARGIN),
    y: Math.min(workArea.y + DOCK_MARGIN, workArea.y + workArea.height - height),
    width,
    height,
  };
}

/**
 * @param {WindowBounds} bounds @param {WindowBounds} workArea
 * @param {number} minimumWidth @param {number} minimumHeight
 */
function clampBoundsToWorkArea(bounds, workArea, minimumWidth, minimumHeight) {
  const width = Math.min(workArea.width, Math.max(Math.min(minimumWidth, workArea.width), bounds.width));
  const height = Math.min(workArea.height, Math.max(Math.min(minimumHeight, workArea.height), bounds.height));
  return {
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

/** @param {unknown} value @param {WindowBounds} fallback */
function normalizeBounds(value, fallback) {
  const source = /** @type {Record<string, unknown>} */ (isRecord(value) ? value : {});
  return {
    x: finiteInteger(source.x, fallback.x),
    y: finiteInteger(source.y, fallback.y),
    width: positiveInteger(source.width, fallback.width),
    height: positiveInteger(source.height, fallback.height),
  };
}

/** @param {unknown} value @param {number} fallback */
function finiteInteger(value, fallback) {
  return Number.isFinite(value) ? Math.round(Number(value)) : fallback;
}

/** @param {unknown} value @param {number} fallback */
function positiveInteger(value, fallback) {
  const number = finiteInteger(value, fallback);
  return number > 0 ? number : fallback;
}

/** @param {number} value @param {number} minimum @param {number} maximum */
function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function sanitizeSnapshot(value) {
  const source = isRecord(value) ? value : {};
  const mode = MODES.has(source.mode) ? source.mode : null;
  const state = CONTROLLER_STATES.has(source.state) ? source.state : "IDLE";
  const allowedLanes = mode ? LANES_BY_MODE[mode] : new Set();
  const lanes = {};
  if (isRecord(source.lanes)) {
    for (const lane of allowedLanes) {
      if (!isRecord(source.lanes[lane])) continue;
      const laneSource = source.lanes[lane];
      lanes[lane] = {
        state: LANE_STATES.has(laneSource.state) ? laneSource.state : "IDLE",
        inputTranscript: cleanText(laneSource.inputTranscript, MAX_TEXT_LENGTH),
        outputTranscript: cleanText(laneSource.outputTranscript, MAX_TEXT_LENGTH),
        errorCode: cleanNullableCode(laneSource.errorCode),
      };
    }
  }
  const records = Array.isArray(source.records)
    ? source.records.slice(-MAX_RECORDS).map((record) => sanitizeRecord(record, allowedLanes)).filter(Boolean)
    : [];
  return {
    state,
    sessionId: cleanNullableText(source.sessionId, 160),
    mode,
    userLanguage: cleanNullableLanguage(source.userLanguage),
    otherLanguage: cleanNullableLanguage(source.otherLanguage),
    lanes,
    records,
    audioDelta: sanitizeAudioDelta(source.audioDelta, allowedLanes),
  };
}

function sanitizeAudioDelta(value, allowedLanes) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !allowedLanes.has(value.lane) || value.sampleRate !== PCM_SAMPLE_RATE) return null;
  const audioBase64 = canonicalPcmBase64(value.audioBase64);
  const eventId = cleanText(value.eventId, 160);
  if (!audioBase64 || !eventId) return null;
  return { lane: value.lane, sampleRate: PCM_SAMPLE_RATE, audioBase64, eventId };
}

function sanitizeRecord(value, allowedLanes) {
  if (!isRecord(value)) return null;
  const lane = cleanCode(value.lane, 20);
  const sourceLanguage = cleanLanguage(value.sourceLanguage);
  const targetLanguage = cleanLanguage(value.targetLanguage);
  if (!allowedLanes.has(lane) || !sourceLanguage || !targetLanguage) return null;
  return {
    id: cleanText(value.id, 160),
    sessionId: cleanText(value.sessionId, 160),
    lane,
    sourceLanguage,
    targetLanguage,
    sourceText: cleanText(value.sourceText, MAX_TEXT_LENGTH),
    translatedText: cleanText(value.translatedText, MAX_TEXT_LENGTH),
    createdAt: cleanText(value.createdAt, 64),
  };
}

function devicePreflightMetadata(platform) {
  const isDarwin = platform === "darwin";
  return {
    platform: cleanCode(platform, 24) || "unknown",
    sampleRate: PCM_SAMPLE_RATE,
    supportsMicrophone: true,
    supportsSystemAudio: isDarwin || platform === "win32",
    requiresScreenRecordingPermission: isDarwin,
    virtualAudio: {
      required: isDarwin,
      requiredModes: isDarwin ? ["ONLINE"] : [],
      driverName: isDarwin ? "BlackHole 2ch" : "",
      detection: "renderer-device-enumeration",
      autoInstallSupported: false,
    },
  };
}

function invalidRequest() {
  return Object.assign(new Error("요청 형식이 올바르지 않습니다."), { code: "INVALID_REQUEST" });
}

function errorCode(error) {
  if (error?.code === "INVALID_REQUEST") return "INVALID_REQUEST";
  const code = cleanCode(error?.code, 80);
  return code || "LIVE_INTERPRETER_ERROR";
}

function userFacingError(error) {
  if (error?.code === "INVALID_REQUEST") return "요청 형식이 올바르지 않습니다.";
  if (error?.code === "OPENAI_API_KEY_REQUIRED") return "설정에서 OpenAI API 키를 입력해 주세요.";
  return "실시간 통역을 처리하지 못했습니다.";
}

function hasExactKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAlive(window) {
  return Boolean(window) && window.isDestroyed?.() !== true && window.webContents?.isDestroyed?.() !== true;
}

function readSnapshotMode(value) {
  return isRecord(value) && MODES.has(value.mode) ? value.mode : null;
}

function cleanText(value, maximum) {
  return typeof value === "string"
    ? value.normalize("NFC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, maximum)
    : "";
}

function canonicalPcmBase64(value) {
  if (typeof value !== "string"
    || !value
    || value.length > MAX_AUDIO_DELTA_BASE64_LENGTH
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return "";
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength === 0
    || bytes.byteLength > MAX_INTERPRETER_AUDIO_BYTES
    || bytes.byteLength % 2 !== 0
    || bytes.toString("base64") !== value) return "";
  return value;
}

function cleanNullableText(value, maximum) {
  if (value === null || value === undefined || value === "") return null;
  return cleanText(value, maximum) || null;
}

function cleanLanguage(value, allowedLanguages = new Set(DEFAULT_LANGUAGES)) {
  const language = cleanText(value, 16);
  return allowedLanguages.has(language) ? language : "";
}

function cleanNullableLanguage(value) {
  return value === null || value === undefined ? null : cleanLanguage(value) || null;
}

function cleanCode(value, maximum) {
  const code = cleanText(value, maximum);
  return /^[A-Za-z0-9_-]+$/u.test(code) ? code : "";
}

function cleanNullableCode(value) {
  return value === null || value === undefined || value === "" ? null : cleanCode(value, 80) || null;
}
