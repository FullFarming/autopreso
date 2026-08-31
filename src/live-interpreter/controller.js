import {
  MAX_INTERPRETER_TRANSCRIPT_CHARS,
  buildLiveInterpreterLanes,
  createLiveInterpreterError,
  sanitizeCommittedTranscriptRecord,
  sanitizeInterpreterDelta,
  sanitizeInterpreterText,
} from "./domain.js";
import { createOpenAiRealtimeTranslationSession } from "./openai.js";

/** @typedef {{start: () => Promise<void>, appendAudio: (audioBase64: unknown) => void, stop: () => Promise<void>}} TranslationProvider */
/** @typedef {{apiKey: string, lane: string, sourceLanguage: string, targetLanguage: string, onEvent: (event: unknown) => void}} TranslationProviderOptions */

/**
 * @param {{
 * getApiKey?: () => unknown|Promise<unknown>,
 * createProvider?: (options: TranslationProviderOptions) => TranslationProvider,
 * store?: {appendRecord?: (record: unknown) => Promise<unknown>},
 * now?: () => string,
 * createId?: (prefix: string) => string,
 * maxReconnectsPerLane?: number,
 * }} options
 */
export function createLiveInterpreterController({
  getApiKey,
  createProvider = createOpenAiRealtimeTranslationSession,
  store,
  now = () => new Date().toISOString(),
  createId = (prefix) => `${prefix}-${crypto.randomUUID()}`,
  maxReconnectsPerLane = 3,
} = {}) {
  const listeners = new Set();
  const providers = new Map();
  const laneConnections = new Map();
  const reconnectCounts = new Map();
  let controllerState = "IDLE";
  let sessionId = null;
  let mode = null;
  let userLanguage = null;
  let otherLanguage = null;
  let laneDefinitions = {};
  let laneStates = {};
  let records = [];
  let audioDelta = null;
  let activeApiKey = "";
  let sessionGeneration = 0;
  let connectionSequence = 0;
  let startPromise = null;
  let stopPromise = null;
  let snapshot = buildSnapshot();

  function getSnapshot() {
    return snapshot;
  }

  /** @param {(value: ReturnType<typeof buildSnapshot>) => void} listener */
  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Live Interpreter listener is required.");
    listeners.add(listener);
    listener(snapshot);
    return () => listeners.delete(listener);
  }

  /** @param {{mode?: unknown, userLanguage?: unknown, otherLanguage?: unknown}} request */
  async function start(request = {}) {
    const definitions = buildLiveInterpreterLanes(request);
    const normalizedMode = String(request.mode);
    const normalizedUserLanguage = definitions[normalizedMode === "ONLINE" ? "OUTBOUND" : "USER"].sourceLanguage;
    const normalizedOtherLanguage = definitions[normalizedMode === "ONLINE" ? "INBOUND" : "OTHER"].sourceLanguage;
    if (controllerState === "RUNNING" && mode === normalizedMode
      && userLanguage === normalizedUserLanguage && otherLanguage === normalizedOtherLanguage) return snapshot;
    if (startPromise) return startPromise;
    if (controllerState !== "IDLE") {
      throw createLiveInterpreterError("SESSION_ALREADY_ACTIVE", "다른 실시간 통역 세션이 이미 실행 중입니다.");
    }
    startPromise = startSession({
      definitions,
      normalizedMode,
      normalizedUserLanguage,
      normalizedOtherLanguage,
    }).finally(() => { startPromise = null; });
    return startPromise;
  }

  async function startSession({ definitions, normalizedMode, normalizedUserLanguage, normalizedOtherLanguage }) {
    controllerState = "STARTING";
    sessionId = createId("session");
    mode = normalizedMode;
    userLanguage = normalizedUserLanguage;
    otherLanguage = normalizedOtherLanguage;
    laneDefinitions = definitions;
    laneStates = Object.fromEntries(Object.keys(definitions).map((lane) => [lane, emptyLaneState("CONNECTING")]));
    audioDelta = null;
    reconnectCounts.clear();
    sessionGeneration += 1;
    const generation = sessionGeneration;
    publish();
    let key;
    try {
      key = await getApiKey?.();
    } catch {
      sessionGeneration += 1;
      controllerState = "ERROR";
      sessionId = null;
      mode = null;
      userLanguage = null;
      otherLanguage = null;
      laneDefinitions = {};
      laneStates = {};
      publish();
      throw createLiveInterpreterError("OPENAI_API_KEY_LOAD_FAILED", "OpenAI API 키를 불러오지 못했습니다.");
    }
    activeApiKey = typeof key === "string" ? key.trim() : "";
    if (!activeApiKey) {
      controllerState = "ERROR";
      publish();
      throw createLiveInterpreterError("OPENAI_API_KEY_REQUIRED", "OpenAI API 키를 설정해 주세요.");
    }
    try {
      const created = Object.entries(definitions).map(([lane, definition]) => createLaneProvider({ lane, definition, generation }));
      await Promise.all(created.map((provider) => provider.start()));
      if (generation !== sessionGeneration) throw createLiveInterpreterError("STALE_SESSION", "종료된 통역 세션입니다.");
      controllerState = "RUNNING";
      publish();
      return snapshot;
    } catch (error) {
      await Promise.allSettled([...providers.values()].map((provider) => provider.stop()));
      providers.clear();
      laneConnections.clear();
      activeApiKey = "";
      controllerState = "ERROR";
      publish();
      throw error;
    }
  }

  function createLaneProvider({ lane, definition, generation }) {
    const connectionId = ++connectionSequence;
    laneConnections.set(lane, connectionId);
    const provider = createProvider({
      apiKey: activeApiKey,
      lane,
      sourceLanguage: definition.sourceLanguage,
      targetLanguage: definition.targetLanguage,
      onEvent: (event) => handleProviderEvent({ generation, lane, connectionId, event }),
    });
    providers.set(lane, provider);
    return provider;
  }

  function handleProviderEvent({ generation, lane, connectionId, event }) {
    if (generation !== sessionGeneration || laneConnections.get(lane) !== connectionId || !isProviderEvent(event)) return;
    const current = laneStates[lane];
    if (!current) return;
    if (event.type === "state") {
      laneStates = { ...laneStates, [lane]: { ...current, state: event.state } };
      publish();
      return;
    }
    if (event.type === "error") {
      laneStates = { ...laneStates, [lane]: { ...current, state: "ERROR", errorCode: sanitizeInterpreterText(event.code, 80) || "PROVIDER_ERROR" } };
      publish();
      return;
    }
    if (event.type === "input_transcript_delta" || event.type === "output_transcript_delta") {
      const field = event.type === "input_transcript_delta" ? "inputTranscript" : "outputTranscript";
      const combined = sanitizeInterpreterDelta(`${current[field]}${event.delta}`, MAX_INTERPRETER_TRANSCRIPT_CHARS);
      laneStates = { ...laneStates, [lane]: { ...current, [field]: combined } };
      publish();
      return;
    }
    if (event.type === "output_audio_delta") {
      audioDelta = Object.freeze({
        lane,
        sampleRate: 24_000,
        audioBase64: event.audioBase64,
        eventId: createId("audio"),
      });
      publish();
      return;
    }
    if (event.type === "transcript_committed") commitTranscript(lane);
  }

  function commitTranscript(lane) {
    const current = laneStates[lane];
    const definition = laneDefinitions[lane];
    if (!current || !definition || !sessionId) return;
    const sourceText = sanitizeInterpreterText(current.inputTranscript);
    const translatedText = sanitizeInterpreterText(current.outputTranscript);
    if (!sourceText && !translatedText) return;
    const record = sanitizeCommittedTranscriptRecord({
      id: createId("record"),
      sessionId,
      lane,
      sourceLanguage: definition.sourceLanguage,
      targetLanguage: definition.targetLanguage,
      sourceText,
      translatedText,
      createdAt: now(),
    });
    records = [...records, record].slice(-2_000);
    laneStates = { ...laneStates, [lane]: { ...current, inputTranscript: "", outputTranscript: "" } };
    publish();
    void Promise.resolve(store?.appendRecord?.(record)).catch(() => {});
  }

  /** @param {{lane?: unknown, audioBase64?: unknown}} packet */
  function pushPcm(packet = {}) {
    if (controllerState !== "RUNNING") {
      throw createLiveInterpreterError("SESSION_NOT_ACTIVE", "실시간 통역 세션이 활성 상태가 아닙니다.");
    }
    const lane = String(packet.lane ?? "");
    const provider = providers.get(lane);
    if (!provider) throw createLiveInterpreterError("LANE_NOT_ACTIVE", `Live Interpreter lane ${lane || "unknown"} is not active.`);
    provider.appendAudio(packet.audioBase64);
  }

  /** @param {unknown} laneValue */
  async function reconnect(laneValue) {
    if (controllerState !== "RUNNING") throw createLiveInterpreterError("SESSION_NOT_ACTIVE", "실시간 통역 세션이 활성 상태가 아닙니다.");
    const lane = String(laneValue ?? "");
    const currentProvider = providers.get(lane);
    const definition = laneDefinitions[lane];
    if (!currentProvider || !definition) throw createLiveInterpreterError("LANE_NOT_ACTIVE", "재연결할 통역 레인을 찾을 수 없습니다.");
    const count = reconnectCounts.get(lane) ?? 0;
    if (count >= Math.max(0, Number(maxReconnectsPerLane) || 0)) {
      throw createLiveInterpreterError("RECONNECT_LIMIT_REACHED", "통역 레인 재연결 한도에 도달했습니다.");
    }
    reconnectCounts.set(lane, count + 1);
    laneConnections.set(lane, ++connectionSequence);
    await currentProvider.stop();
    const provider = createLaneProvider({ lane, definition, generation: sessionGeneration });
    laneStates = { ...laneStates, [lane]: emptyLaneState("CONNECTING") };
    publish();
    await provider.start();
    return snapshot;
  }

  function stop() {
    if (controllerState === "IDLE") return Promise.resolve(snapshot);
    if (stopPromise) return stopPromise;
    stopPromise = stopSession().finally(() => { stopPromise = null; });
    return stopPromise;
  }

  async function stopSession() {
    controllerState = "STOPPING";
    publish();
    const results = await Promise.allSettled([...providers.values()].map((provider) => provider.stop()));
    sessionGeneration += 1;
    providers.clear();
    laneConnections.clear();
    activeApiKey = "";
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") {
      controllerState = "ERROR";
      laneStates = Object.fromEntries(Object.keys(laneStates).map((lane) => [lane, { ...laneStates[lane], state: "ERROR", errorCode: "PROVIDER_CLOSE_FAILED" }]));
      publish();
      throw createLiveInterpreterError("PROVIDER_CLOSE_FAILED", "통역 제공자 세션을 안전하게 종료하지 못했습니다.");
    }
    controllerState = "IDLE";
    sessionId = null;
    mode = null;
    userLanguage = null;
    otherLanguage = null;
    laneDefinitions = {};
    laneStates = {};
    audioDelta = null;
    publish();
    return snapshot;
  }

  async function dispose() {
    try {
      await stop();
    } finally {
      listeners.clear();
    }
  }

  function publish() {
    snapshot = buildSnapshot();
    for (const listener of listeners) listener(snapshot);
  }

  function buildSnapshot() {
    const frozenLanes = Object.freeze(Object.fromEntries(Object.entries(laneStates).map(([lane, state]) => [lane, Object.freeze({ ...state })])));
    return Object.freeze({
      state: controllerState,
      sessionId,
      mode,
      userLanguage,
      otherLanguage,
      lanes: frozenLanes,
      records: Object.freeze(records.map((record) => Object.freeze({ ...record }))),
      audioDelta,
    });
  }

  return Object.freeze({ getSnapshot, subscribe, start, pushPcm, reconnect, stop, dispose });
}

/** @param {string} state */
function emptyLaneState(state) {
  return Object.freeze({ state, inputTranscript: "", outputTranscript: "", errorCode: null });
}

/** @param {unknown} event @returns {event is Record<string, unknown> & {type: string}} */
function isProviderEvent(event) {
  return Boolean(event) && typeof event === "object" && !Array.isArray(event) && "type" in event && typeof event.type === "string";
}
