import path from "node:path";

import { createMeetingCoachEngine, createMeetingCoachStore } from "../src/meeting-coach/index.js";

/** @typedef {{on?: (event: string, listener: (...args: unknown[]) => void) => unknown, off?: (event: string, listener: (...args: unknown[]) => void) => unknown, removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown, close?: () => void}} SocketLike */
/** @typedef {{id: number, getURL?: () => string, isDestroyed?: () => boolean, send: (channel: string, payload: unknown) => void, setWindowOpenHandler?: (handler: () => {action: string}) => void}} WebContentsLike */
/** @typedef {{webContents: WebContentsLike, isDestroyed?: () => boolean, show: () => void, focus: () => void, on: (event: string, listener: () => void) => unknown, loadURL: (url: string) => Promise<unknown>, getBounds?: () => unknown, setBounds?: (bounds: {x:number,y:number,width:number,height:number}) => void}} WindowLike */
/** @typedef {new (options: Record<string, unknown>) => WindowLike} WindowConstructor */
/** @typedef {{handle: (channel: string, listener: (event: unknown, input: unknown) => Promise<unknown>) => void, removeHandler?: (channel: string) => void}} IpcLike */
/** @typedef {{load?: () => Promise<unknown>}} SettingsStoreLike */
/** @typedef {{load?: (kind: string) => Promise<unknown>, save?: (kind: string, bounds: unknown) => Promise<void>}} BoundsStoreLike */
/** @typedef {{getAllDisplays?: () => Array<{workArea: {x:number,y:number,width:number,height:number}}>, getPrimaryDisplay?: () => {workArea: {x:number,y:number,width:number,height:number}}, on?: (event: string, listener: () => void) => unknown, off?: (event: string, listener: () => void) => unknown, removeListener?: (event: string, listener: () => void) => unknown}} ScreenLike */
/**
 * @typedef {{
 * hydrate?: () => Promise<unknown>, subscribeSnapshot?: (listener: (snapshot: unknown) => void) => (() => void),
 * subscribe?: (listener: (snapshot: unknown) => void) => (() => void), getSnapshot: () => unknown | Promise<unknown>,
 * setConnection?: (patch: {caption?: string, provider?: string}) => void,
 * interview: (input: unknown) => Promise<unknown>, saveDraft: (input: unknown) => Promise<unknown>,
 * freezeBrief: (input: unknown) => Promise<unknown>, start: (input: unknown) => Promise<unknown>,
 * acceptLocalSpeechActivity?: (input: unknown) => Promise<unknown>, acceptFinalizedTurn: (input: unknown) => Promise<unknown>,
 * answerTurn: (input: unknown) => Promise<unknown>, runManualAction: (input: unknown) => Promise<unknown>,
 * useRecommendation: (input: unknown) => Promise<unknown>,
 * end: (input: unknown) => Promise<unknown>, dispose?: () => void
 * }} MeetingCoachEngineLike
 */

export const MEETING_COACH_CHANNELS = Object.freeze({
  getSnapshot: "meeting-coach:get-snapshot",
  interview: "meeting-coach:interview",
  saveDraft: "meeting-coach:save-draft",
  freezeBrief: "meeting-coach:freeze-brief",
  start: "meeting-coach:start",
  openPrep: "meeting-coach:open-prep",
  openRecord: "meeting-coach:open-record",
  openResponse: "meeting-coach:open-response",
  openLiveWindows: "meeting-coach:open-live-windows",
  arrangeWindows: "meeting-coach:arrange-windows",
  answerTurn: "meeting-coach:answer-turn",
  manualAction: "meeting-coach:manual-action",
  useRecommendation: "meeting-coach:use-recommendation",
  end: "meeting-coach:end",
  snapshot: "meeting-coach:snapshot",
});

const WINDOW_SPECS = Object.freeze({
  prep: Object.freeze({ route: "meeting-coach-prep.html", width: 760, height: 820, alwaysOnTop: false }),
  record: Object.freeze({ route: "meeting-coach-record.html", width: 560, height: 760, alwaysOnTop: true }),
  response: Object.freeze({ route: "meeting-coach-response.html", width: 620, height: 760, alwaysOnTop: true }),
});

const SAFE_ERROR_MESSAGES = Object.freeze({
  AGENDA_REQUIRED: "회의 브리프를 확정하려면 안건이 하나 이상 필요합니다.",
  SAFE_FALLBACK_REQUIRED: "회의 브리프를 확정하려면 안전 답변이 하나 이상 필요합니다.",
  CONTRADICTION_ACK_REQUIRED: "회의 브리프의 모든 상충 정보 경고를 확인해 주세요.",
  AI_INTERVIEW_FAILED: "AI 사전 인터뷰를 완료하지 못했습니다.",
  INVALID_AI_INTERVIEW: "AI 사전 인터뷰 응답을 확인할 수 없습니다.",
  FROZEN_BRIEF_NOT_FOUND: "확정된 회의 브리프를 찾을 수 없습니다.",
  SESSION_ALREADY_ACTIVE: "다른 회의가 이미 진행 중입니다.",
  SESSION_NOT_STARTED: "Meeting Coach 회의가 시작되지 않았습니다.",
  SESSION_NOT_READY: "Meeting Coach 회의가 준비되지 않았습니다.",
  FINALIZED_TURN_NOT_FOUND: "확정된 발화 기록을 찾을 수 없습니다.",
  MANUAL_TEXT_REQUIRED: "번역하거나 다듬을 문장을 입력해 주세요.",
  READY_RECOMMENDATION_NOT_FOUND: "사용할 수 있는 현재 추천 답변을 찾을 수 없습니다.",
  INVALID_LOCAL_SPEECH_PHASE: "로컬 발화 상태가 올바르지 않습니다.",
  INVALID_LOCAL_SPEECH_SEQUENCE: "로컬 발화 순서가 올바르지 않습니다.",
  RATE_LIMIT_CLOCK_INVALID: "AI 요청 제한 상태를 확인할 수 없습니다.",
  RATE_LIMITED: "AI 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  GEMINI_API_KEY_REQUIRED: "Gemini API 키를 설정해 주세요.",
  GEMINI_UNAVAILABLE: "Gemini 연결을 시작할 수 없습니다.",
  GEMINI_PROMPT_TOO_LARGE: "Gemini 요청 내용이 허용된 길이를 초과했습니다.",
  GEMINI_EMPTY_RESPONSE: "Gemini가 빈 응답을 반환했습니다.",
  GEMINI_TIMEOUT: "응답 시간이 초과되었습니다. 다시 시도해 주세요.",
  GEMINI_ABORTED: "Gemini 요청이 취소되었습니다.",
  GEMINI_AUTH_FAILED: "Gemini API 키를 확인해 주세요.",
  GEMINI_RATE_LIMITED: "Gemini 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.",
  GEMINI_FAILED: "Gemini 응답을 생성하지 못했습니다.",
});

/** @param {Record<string, unknown> | null | undefined} saved @param {Array<{workArea?: {x:number,y:number,width:number,height:number}}>} displays @param {{width:number,height:number}} defaults */
export function normalizeMeetingCoachWindowBounds(saved, displays, defaults) {
  const workAreas = Array.isArray(displays) ? displays.map((display) => display?.workArea).filter(Boolean) : [];
  const fallbackArea = workAreas[0] ?? { x: 0, y: 0, width: 1440, height: 900 };
  const width = clampInteger(saved?.width, 420, fallbackArea.width, defaults.width);
  const height = clampInteger(saved?.height, 520, fallbackArea.height, defaults.height);
  const isVisible = workAreas.some((area) => rectangleInside({
    x: Number(saved?.x), y: Number(saved?.y), width, height,
  }, area));
  if (isVisible) return { x: Math.round(Number(saved?.x)), y: Math.round(Number(saved?.y)), width, height };
  const fallbackWidth = clampInteger(defaults.width, 420, fallbackArea.width, defaults.width);
  const fallbackHeight = clampInteger(defaults.height, 520, fallbackArea.height, defaults.height);
  return {
    x: Math.round(fallbackArea.x + (fallbackArea.width - fallbackWidth) / 2),
    y: Math.round(fallbackArea.y + (fallbackArea.height - fallbackHeight) / 2),
    width: fallbackWidth,
    height: fallbackHeight,
  };
}

/**
 * @param {{serverUrl?: string, localAppOrigin?: string, createWebSocket?: (url: string, options: Record<string, unknown>) => SocketLike | null,
 * onCommitted?: (turn: unknown) => void, onLocalSpeech?: (activity: {sourceSessionId: string, seq: number, phase: "PARTIAL"|"FINAL"}) => void,
 * onSourceEnded?: (sourceSessionId: string) => void,
 * onConnection?: (state: string) => void, reconnect?: boolean, reconnectDelayMs?: number}} [options]
 */
export function createCanonicalCaptionSubscriber({
  serverUrl,
  localAppOrigin,
  createWebSocket,
  onCommitted,
  onLocalSpeech,
  onSourceEnded,
  onConnection,
  reconnect = true,
  reconnectDelayMs = 1_000,
} = {}) {
  let socket = null;
  let reconnectTimer = null;
  let isStopped = true;
  const lastSeqByStream = new Map();
  const lastLocalSpeechSeqByStream = new Map();
  /** @type {{socket: SocketLike, open: (...args: unknown[]) => void, message: (...args: unknown[]) => void, close: (...args: unknown[]) => void, error: (...args: unknown[]) => void} | null} */
  let socketBinding = null;

  function start() {
    if (!isStopped) return;
    isStopped = false;
    onConnection?.("CONNECTING");
    connect();
  }

  function connect() {
    if (isStopped || typeof createWebSocket !== "function") return;
    const url = new URL("/ws", serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const nextSocket = createWebSocket(url.toString(), { headers: { Origin: localAppOrigin } });
    if (!nextSocket) return;
    socket = nextSocket;
    const binding = {
      socket: nextSocket,
      open: () => onConnection?.("CONNECTED"),
      message: handleMessage,
      close: () => scheduleReconnect(nextSocket),
      error: () => {},
    };
    socketBinding = binding;
    nextSocket.on?.("open", binding.open);
    nextSocket.on?.("message", binding.message);
    nextSocket.on?.("close", binding.close);
    nextSocket.on?.("error", binding.error);
  }

  function handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message?.type === "subtitle:stopped") {
      const sourceSessionId = cleanText(message.sessionId ?? message.liveSessionId, 160);
      if (sourceSessionId) {
        clearSessionSequences(lastSeqByStream, sourceSessionId);
        clearSessionSequences(lastLocalSpeechSeqByStream, sourceSessionId);
        onSourceEnded?.(sourceSessionId);
      }
      return;
    }
    if (message?.type !== "subtitle:partial" && message?.type !== "subtitle:committed") return;
    const seq = Number(message.seq);
    if (!Number.isSafeInteger(seq) || seq < 0) return;
    const streamId = cleanText(message.streamId ?? message.liveSessionId ?? "local", 160) || "local";
    const sourceSessionId = cleanText(message.liveSessionId ?? message.sessionId ?? streamId, 120) || streamId;
    const streamKey = `${sourceSessionId}\u0000${streamId}`;
    const phase = message.type === "subtitle:partial" ? "PARTIAL" : "FINAL";
    if (isLocalCaption(message) && hasCaptionText(message) && seq > (lastLocalSpeechSeqByStream.get(streamKey) ?? -1)) {
      lastLocalSpeechSeqByStream.set(streamKey, seq);
      onLocalSpeech?.({ sourceSessionId, seq, phase });
    }
    if (message.type !== "subtitle:committed") return;
    if (seq <= (lastSeqByStream.get(streamKey) ?? -1)) return;
    lastSeqByStream.set(streamKey, seq);
    const turn = captionToFinalizedTurn(message, { streamId, seq });
    if (turn) onCommitted?.(turn);
  }

  /** @param {SocketLike} closedSocket */
  function scheduleReconnect(closedSocket) {
    detachSocket(closedSocket);
    if (socket !== closedSocket) return;
    socket = null;
    if (isStopped) return;
    onConnection?.("DISCONNECTED");
    if (!reconnect) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelayMs);
  }

  function stop() {
    if (isStopped) return;
    isStopped = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const active = socket;
    socket = null;
    detachSocket(active);
    onConnection?.("DISCONNECTED");
    active?.close?.();
  }

  /** @param {SocketLike | null} target */
  function detachSocket(target) {
    const binding = socketBinding;
    if (!target || !binding || binding.socket !== target) return;
    const remove = typeof target.off === "function"
      ? target.off.bind(target)
      : target.removeListener?.bind(target);
    remove?.("open", binding.open);
    remove?.("message", binding.message);
    remove?.("close", binding.close);
    remove?.("error", binding.error);
    socketBinding = null;
  }

  return { start, stop };
}

/**
 * @param {{app?: {getPath: (name: string) => string, once?: (event: string, listener: () => void) => void}, ipc?: IpcLike,
 * BrowserWindowClass?: WindowConstructor, screenApi?: ScreenLike, settingsStore?: SettingsStoreLike,
 * serverUrl?: string, localAppOrigin?: string, getDashboardWindow?: () => WindowLike | null,
 * createWebSocket?: (url: string, options: Record<string, unknown>) => SocketLike | null,
 * canStartProtectedAction?: () => boolean, boundsStore?: BoundsStoreLike, engine?: MeetingCoachEngineLike}} [options]
 */
export function registerMeetingCoachIpc({
  app,
  ipc,
  BrowserWindowClass,
  screenApi,
  settingsStore,
  serverUrl,
  localAppOrigin,
  getDashboardWindow = () => null,
  canStartProtectedAction = () => true,
  createWebSocket,
  boundsStore = createMemoryBoundsStore(),
  engine: providedEngine,
} = {}) {
  if (!ipc?.handle || !BrowserWindowClass || !serverUrl || !localAppOrigin) {
    throw new Error("Meeting Coach Electron dependencies are required.");
  }
  if (!providedEngine && !app) throw new Error("Meeting Coach app dependency is required.");
  const engine = providedEngine ?? createMeetingCoachEngine({
    store: createMeetingCoachStore({ directory: path.join(app?.getPath("userData") ?? "", "meeting-coach") }),
    getOpenAiApiKey: async () => {
      const settings = await settingsStore?.load?.();
      return readOpenAiApiKey(settings);
    },
  });
  /** @type {{prep: WindowLike | null, record: WindowLike | null, response: WindowLike | null}} */
  const windows = { prep: null, record: null, response: null };
  const allowedWebContents = new Map();
  let snapshotSeq = 0;
  let currentSnapshot = stampSnapshot(null);
  let isDisposed = false;
  let pendingOperations = 0;
  const hydration = Promise.resolve(engine.hydrate?.()).catch(() => null);

  const subscribe = engine.subscribeSnapshot ?? ("subscribe" in engine ? engine.subscribe : undefined);
  const unsubscribe = subscribe?.call(engine, (nextSnapshot) => {
    currentSnapshot = stampSnapshot(nextSnapshot);
    broadcastSnapshot();
  });
  const captionSubscriber = createCanonicalCaptionSubscriber({
    serverUrl,
    localAppOrigin,
    createWebSocket,
    onLocalSpeech: (activity) => {
      void hydration.then(() => engine.acceptLocalSpeechActivity?.(activity)).catch(() => {});
    },
    onCommitted: (turn) => {
      void hydration.then(async () => {
        if (!canStartProtectedAction()) return;
        pendingOperations++;
        try { await engine.acceptFinalizedTurn(turn); }
        finally { pendingOperations--; }
      }).catch(() => {});
    },
    onSourceEnded: (sourceSessionId) => { void hydration.then(() => engine.end({ sourceSessionId })).catch(() => {}); },
    onConnection: (caption) => engine.setConnection?.({ caption }),
  });
  captionSubscriber.start();
  const onDisplayChanged = () => {
    void arrangeLiveWindows().catch(() => {});
  };
  screenApi?.on?.("display-removed", onDisplayChanged);
  screenApi?.on?.("display-metrics-changed", onDisplayChanged);

  /** @param {unknown} value */
  function stampSnapshot(value) {
    const source = isRecord(value) ? value : {};
    const providerSeq = Number.isSafeInteger(source.seq) ? Number(source.seq) : 0;
    snapshotSeq = Math.max(snapshotSeq + 1, providerSeq);
    return Object.freeze({
      seq: snapshotSeq,
      coachSessionId: source.coachSessionId ?? null,
      state: source.state ?? "PREPARED",
      brief: source.brief ?? null,
      prepMessages: normalizePrepMessages(source.prepMessages),
      prepLane: normalizePrepLane(source.prepLane),
      turns: Array.isArray(source.turns) ? structuredClone(source.turns) : [],
      usedRecommendations: Array.isArray(source.usedRecommendations) ? structuredClone(source.usedRecommendations) : [],
      currentQuestion: source.currentQuestion ?? null,
      autoLane: { status: "IDLE", ...(isRecord(source.autoLane) ? source.autoLane : {}) },
      manualLane: { status: "IDLE", partialText: "", ...(isRecord(source.manualLane) ? source.manualLane : {}) },
      connection: { caption: "CONNECTING", provider: "IDLE", ...(isRecord(source.connection) ? source.connection : {}) },
    });
  }

  async function getSnapshot() {
    await hydration;
    if (!currentSnapshot.coachSessionId && typeof engine.getSnapshot === "function") {
      const next = await engine.getSnapshot();
      currentSnapshot = stampSnapshot(next);
    }
    return currentSnapshot;
  }

  function broadcastSnapshot() {
    for (const window of Object.values(windows)) {
      if (isAlive(window)) window.webContents.send(MEETING_COACH_CHANNELS.snapshot, currentSnapshot);
    }
  }

  /** @param {"prep"|"record"|"response"} kind */
  async function openWindow(kind) {
    if (!canStartProtectedAction()) return null;
    const existing = windows[kind];
    if (isAlive(existing)) {
      existing.show();
      existing.focus();
      return existing;
    }
    const spec = WINDOW_SPECS[kind];
    const savedBounds = await boundsStore.load?.(kind);
    if (!canStartProtectedAction()) return null;
    const displays = screenApi?.getAllDisplays?.() ?? [screenApi?.getPrimaryDisplay?.()].filter(Boolean);
    const bounds = normalizeMeetingCoachWindowBounds(isRecord(savedBounds) ? savedBounds : null, displays, spec);
    const window = new BrowserWindowClass({
      ...bounds,
      minWidth: 420,
      minHeight: 520,
      title: `NOVA Meeting Coach · ${kind}`,
      alwaysOnTop: spec.alwaysOnTop,
      backgroundColor: "#0A0A0B",
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(import.meta.dirname, "preload.js"),
      },
    });
    windows[kind] = window;
    allowedWebContents.set(window.webContents.id, kind);
    window.webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));
    window.on("closed", () => {
      allowedWebContents.delete(window.webContents.id);
      windows[kind] = null;
    });
    window.on("close", () => { void boundsStore.save?.(kind, window.getBounds?.()); });
    await window.loadURL(new URL(`/${spec.route}`, serverUrl).toString());
    window.show();
    window.focus();
    window.webContents.send(MEETING_COACH_CHANNELS.snapshot, await getSnapshot());
    return window;
  }

  async function openAndArrangeLiveWindows() {
    const snapshot = await getSnapshot();
    if (!snapshot.coachSessionId || (snapshot.state !== "ARMED" && snapshot.state !== "LIVE")) {
      await openWindow("prep");
      return getSnapshot();
    }
    await Promise.all([openWindow("record"), openWindow("response")]);
    arrangeLiveWindows();
    return getSnapshot();
  }

  async function arrangeLiveWindows() {
    const recordWindow = isAlive(windows.record) ? windows.record : null;
    const responseWindow = isAlive(windows.response) ? windows.response : null;
    if (!recordWindow || !responseWindow) return { arranged: false };
    const workArea = selectLiveWorkArea([
      recordWindow.getBounds?.(),
      responseWindow.getBounds?.(),
    ], getDisplays(screenApi));
    const { record, response } = createLiveTileBounds(workArea, WINDOW_SPECS.record, WINDOW_SPECS.response);
    recordWindow.setBounds?.(record);
    responseWindow.setBounds?.(response);
    return { arranged: true, record, response };
  }

  /** @param {unknown} event @param {string[]} allowedKinds */
  function assertSender(event, allowedKinds) {
    if (!isRecord(event)) throw new Error("FORBIDDEN");
    const senderFrame = isRecord(event.senderFrame) ? event.senderFrame : null;
    const sender = isRecord(event.sender) ? event.sender : null;
    const senderUrl = String(senderFrame?.url || (typeof sender?.getURL === "function" ? sender.getURL() : ""));
    let parsed;
    try {
      parsed = new URL(senderUrl);
    } catch {
      throw new Error("FORBIDDEN");
    }
    if (parsed.origin !== localAppOrigin || parsed.username || parsed.password) throw new Error("FORBIDDEN");
    const dashboard = getDashboardWindow?.();
    const senderId = Number(sender?.id);
    const kind = allowedWebContents.get(senderId)
      ?? (dashboard?.webContents?.id === senderId ? "dashboard" : "");
    if (!kind || !allowedKinds.includes(kind)) throw new Error("FORBIDDEN");
  }

  /** @param {string} channel @param {string[]} allowedKinds @param {(input: unknown) => unknown | Promise<unknown>} operation */
  const handle = (channel, allowedKinds, operation) => {
    ipc.removeHandler?.(channel);
    ipc.handle(channel, async (event, input) => {
      try {
        assertSender(event, allowedKinds);
        await hydration;
        if (channel !== MEETING_COACH_CHANNELS.getSnapshot && channel !== MEETING_COACH_CHANNELS.end
          && !canStartProtectedAction()) return { ok: false, code: "HOST_LOGIN_REQUIRED", error: "로그인이 필요합니다." };
        const isProtectedOperation = channel !== MEETING_COACH_CHANNELS.getSnapshot;
        if (isProtectedOperation) pendingOperations++;
        try { return { ok: true, data: await operation(input) }; }
        finally { if (isProtectedOperation) pendingOperations--; }
      } catch (error) {
        if (error instanceof Error && error.message === "FORBIDDEN") throw error;
        const code = normalizeErrorCode(error);
        return { ok: false, error: userFacingError(code), code };
      }
    });
  };

  handle(MEETING_COACH_CHANNELS.getSnapshot, ["dashboard", "prep", "record", "response"], getSnapshot);
  handle(MEETING_COACH_CHANNELS.interview, ["prep"], (input) => engine.interview(input));
  handle(MEETING_COACH_CHANNELS.saveDraft, ["prep"], (input) => engine.saveDraft(input));
  handle(MEETING_COACH_CHANNELS.freezeBrief, ["prep"], (input) => engine.freezeBrief(input));
  handle(MEETING_COACH_CHANNELS.start, ["prep"], (input) => engine.start(input));
  handle(MEETING_COACH_CHANNELS.openPrep, ["dashboard", "prep"], () => openWindow("prep"));
  handle(MEETING_COACH_CHANNELS.openRecord, ["dashboard", "prep", "record", "response"], () => openWindow("record"));
  handle(MEETING_COACH_CHANNELS.openResponse, ["dashboard", "prep", "record", "response"], () => openWindow("response"));
  handle(MEETING_COACH_CHANNELS.openLiveWindows, ["dashboard", "prep", "record", "response"], openAndArrangeLiveWindows);
  handle(MEETING_COACH_CHANNELS.arrangeWindows, ["dashboard", "prep", "record", "response"], arrangeLiveWindows);
  handle(MEETING_COACH_CHANNELS.answerTurn, ["record", "response"], (input) => engine.answerTurn(input));
  handle(MEETING_COACH_CHANNELS.manualAction, ["response"], (input) => engine.runManualAction({
    ...(isRecord(input) ? input : {}),
    onPartial: (partialText) => {
      currentSnapshot = stampSnapshot({
        ...currentSnapshot,
        manualLane: { ...currentSnapshot.manualLane, status: "GENERATING", partialText: cleanText(partialText, 20_000) },
      });
      broadcastSnapshot();
    },
  }));
  handle(MEETING_COACH_CHANNELS.useRecommendation, ["response"], (input) => engine.useRecommendation(input));
  handle(MEETING_COACH_CHANNELS.end, ["dashboard", "prep", "record", "response"], (input) => engine.end(input));

  function dispose() {
    if (isDisposed) return;
    isDisposed = true;
    captionSubscriber.stop();
    unsubscribe?.();
    engine.dispose?.();
    const removeScreenListener = typeof screenApi?.off === "function"
      ? screenApi.off.bind(screenApi)
      : screenApi?.removeListener?.bind(screenApi);
    removeScreenListener?.("display-removed", onDisplayChanged);
    removeScreenListener?.("display-metrics-changed", onDisplayChanged);
    for (const channel of Object.values(MEETING_COACH_CHANNELS)) {
      if (channel !== MEETING_COACH_CHANNELS.snapshot) ipc.removeHandler?.(channel);
    }
  }
  app?.once?.("before-quit", dispose);

  return {
    getSnapshot,
    hasPendingOperations: () => pendingOperations > 0,
    openPrep: () => openWindow("prep"),
    openRecord: () => openWindow("record"),
    openResponse: () => openWindow("response"),
    openLiveWindows: openAndArrangeLiveWindows,
    arrangeLiveWindows,
    dispose,
  };
}

/** @param {Record<string, unknown>} message @param {{streamId: string, seq: number}} context */
function captionToFinalizedTurn(message, { streamId, seq }) {
  const sourceText = cleanText(message.sourceText ?? (message.origin === "source" ? message.text : ""), 12_000);
  const translatedText = cleanText(message.translatedText ?? message.text, 12_000);
  if (!sourceText && !translatedText) return null;
  const targetLanguage = cleanText(message.targetLanguage ?? message.language, 16).toLowerCase();
  const sourceLanguage = cleanText(message.sourceLanguage, 16).toLowerCase();
  const english = targetLanguage.startsWith("en") ? translatedText : sourceText;
  const korean = targetLanguage.startsWith("ko") ? translatedText : (sourceLanguage.startsWith("ko") ? sourceText : "");
  const liveCallSpeaker = isRecord(message.liveCallSpeaker) ? message.liveCallSpeaker : null;
  const speakerValue = isRecord(message.speaker) ? message.speaker.name : message.speaker;
  const speaker = cleanText(
    liveCallSpeaker?.name ?? message.speakerName ?? speakerValue ?? "Speaker",
    120,
  );
  const source = cleanText(message.source, 40).toLowerCase();
  const lane = source.includes("mic") || liveCallSpeaker?.role === "host" ? "LOCAL_MIC" : "SYSTEM_AUDIO";
  const utteranceKey = cleanText(message.utteranceKey ?? message.id ?? seq, 160);
  return {
    id: `${streamId}:${utteranceKey}`,
    sourceSessionId: cleanText(message.liveSessionId ?? message.sessionId ?? streamId, 120),
    seq,
    speaker,
    lane,
    isFinal: true,
    text: english || sourceText || translatedText,
    english: english || sourceText || translatedText,
    korean,
    startedAt: message.startedAt ?? message.createdAt ?? new Date().toISOString(),
    endedAt: message.endedAt ?? message.createdAt ?? new Date().toISOString(),
  };
}

/** @param {Record<string, unknown>} message */
function isLocalCaption(message) {
  const liveCallSpeaker = isRecord(message.liveCallSpeaker) ? message.liveCallSpeaker : null;
  const source = cleanText(message.source, 40).toLowerCase();
  return source.includes("mic") || liveCallSpeaker?.role === "host";
}

/** @param {Record<string, unknown>} message */
function hasCaptionText(message) {
  return Boolean(cleanText(message.sourceText ?? message.translatedText ?? message.text, 12_000));
}

/** @param {Map<string, number>} sequences @param {string} sourceSessionId */
function clearSessionSequences(sequences, sourceSessionId) {
  const prefix = `${sourceSessionId}\u0000`;
  for (const key of sequences.keys()) {
    if (key.slice(0, prefix.length) === prefix) sequences.delete(key);
  }
}

/** @param {unknown} value */
function normalizePrepMessages(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-200).flatMap((candidate) => {
    if (!isRecord(candidate) || (candidate.role !== "USER" && candidate.role !== "ASSISTANT")) return [];
    const id = cleanText(candidate.id, 160);
    const text = cleanText(candidate.text, 20_000);
    const createdAt = cleanText(candidate.createdAt, 40);
    return id && text && createdAt ? [{ id, role: candidate.role, text, createdAt }] : [];
  });
}

/** @param {unknown} value */
function normalizePrepLane(value) {
  if (!isRecord(value)) return { status: "IDLE", partialText: "" };
  const statuses = new Set(["IDLE", "GENERATING", "READY", "ERROR"]);
  const status = typeof value.status === "string" && statuses.has(value.status) ? value.status : "IDLE";
  const requestId = cleanText(value.requestId, 160);
  const partialText = cleanText(value.partialText, 20_000);
  const error = cleanText(value.error, 300);
  return {
    ...(requestId ? { requestId } : {}),
    status,
    partialText,
    ...(error ? { error } : {}),
  };
}

/** @returns {BoundsStoreLike} */
function createMemoryBoundsStore() {
  const values = new Map();
  return {
    async load(kind) { return values.get(kind); },
    async save(kind, bounds) { values.set(kind, bounds); },
  };
}

/** @param {WindowLike | null | undefined} window */
function isAlive(window) {
  return Boolean(window && !window.isDestroyed?.() && !window.webContents?.isDestroyed?.());
}

/** @param {{x:number,y:number,width:number,height:number}} a @param {{x:number,y:number,width:number,height:number}} b */
function rectanglesOverlap(a, b) {
  return Number.isFinite(a.x) && Number.isFinite(a.y)
    && a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** @param {unknown} a @param {{x:number,y:number,width:number,height:number}} b */
function rectangleInside(a, b) {
  if (!isRecord(a)) return false;
  const x = Number(a.x);
  const y = Number(a.y);
  const width = Number(a.width);
  const height = Number(a.height);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height)
    && x >= b.x && y >= b.y
    && x + width <= b.x + b.width
    && y + height <= b.y + b.height;
}

/** @param {ScreenLike | undefined} screenApi */
function getDisplays(screenApi) {
  const displays = screenApi?.getAllDisplays?.();
  if (Array.isArray(displays) && displays.length > 0) return displays;
  const primary = screenApi?.getPrimaryDisplay?.();
  return primary ? [primary] : [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }];
}

/** @param {unknown[]} currentBounds @param {Array<{workArea?: {x:number,y:number,width:number,height:number}}>} displays */
function selectLiveWorkArea(currentBounds, displays) {
  const workAreas = displays.map((display) => display?.workArea).filter(Boolean);
  for (const bounds of currentBounds) {
    const area = workAreas.find((candidate) => rectangleInside(bounds, candidate) || (isRecord(bounds) && rectanglesOverlap({
      x: Number(bounds.x),
      y: Number(bounds.y),
      width: Number(bounds.width),
      height: Number(bounds.height),
    }, candidate)));
    if (area) return area;
  }
  return workAreas[0] ?? { x: 0, y: 0, width: 1440, height: 900 };
}

/** @param {{x:number,y:number,width:number,height:number}} workArea @param {{width:number,height:number}} recordSpec @param {{width:number,height:number}} responseSpec */
function createLiveTileBounds(workArea, recordSpec, responseSpec) {
  const gap = 16;
  const width = clampInteger(Math.max(recordSpec.width, responseSpec.width), 420, Math.max(420, workArea.width - gap * 2), 620);
  const availableHeight = Math.max(360, workArea.height - gap * 3);
  const height = Math.max(320, Math.floor(availableHeight / 2));
  const x = Math.round(workArea.x + workArea.width - width - gap);
  const topY = Math.round(workArea.y + gap);
  const bottomY = Math.round(topY + height + gap);
  return {
    record: { x, y: topY, width, height },
    response: { x, y: bottomY, width, height },
  };
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback */
function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : Math.min(max, fallback);
}

/** @param {unknown} value @param {number} limit */
function cleanText(value, limit) {
  return String(value ?? "").normalize("NFC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ").trim().slice(0, limit);
}

/** @param {unknown} error */
function normalizeErrorCode(error) {
  return cleanText(isRecord(error) ? error.code ?? "MEETING_COACH_FAILED" : "MEETING_COACH_FAILED", 80).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/** @param {string} code */
function userFacingError(code) {
  return SAFE_ERROR_MESSAGES[code] ?? "Meeting Coach 요청을 처리하지 못했습니다.";
}

/** @param {unknown} settings */
function readOpenAiApiKey(settings) {
  if (!isRecord(settings) || !isRecord(settings.apiKeys)) return "";
  return String(settings.apiKeys.gemini ?? "").trim();
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
