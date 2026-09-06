import {
  applyStalenessGate,
  appendFinalizedTurn,
  buildCoachPrompt,
  createCoachSession,
  createGeneratingSuggestion,
  createReadyVerifySuggestion,
  prefilterQuestionTurn,
  transitionCoachSession,
  validateComposerAction,
  validateStructuredCoachResponse,
} from "./engine.js";
import {
  generateMeetingCoachStructuredJson,
  streamMeetingCoachComposerText,
  streamMeetingCoachStructuredJson,
} from "./openai-client.js";
import {
  COACH_RESPONSE_SCHEMA,
  INTERVIEW_RESPONSE_SCHEMA,
  appendPrepMessage,
  buildComposerPrompt,
  buildInterviewPrompt,
  extractStreamingJsonString,
  mapComposerResult,
  mergeInterviewPatch,
} from "./prompt-message.js";
import {
  CoachSessionSchema,
  CoachSuggestionSchema,
  DEFAULT_OPENAI_MEETING_COACH_MODEL,
  FinalizedTurnSchema,
  MeetingBriefSchema,
  PrepMessageSchema,
  SIZE_CAPS,
  UseRecommendationRequestSchema,
  UsedRecommendationSchema,
  createApacMeetingBriefDraft,
  freezeMeetingBrief,
  normalizeId,
  normalizeText,
} from "./schema.js";

export { buildComposerPrompt, buildInterviewPrompt } from "./prompt-message.js";

/** @typedef {{ok: boolean, text?: string, code?: string, error?: string}} ProviderResponse */
/**
 * @typedef {{
 * apiKey?: unknown, model?: string, prompt?: string, requestId?: string, abortSignal?: AbortSignal,
 * responseJsonSchema?: Record<string, unknown>, onPartial?: (text: string) => void
 * }} ProviderRequest
 */
/**
 * @typedef {{
 * generateStructuredJson: (request: ProviderRequest) => Promise<ProviderResponse>,
 * streamStructuredJson: (request: ProviderRequest) => Promise<ProviderResponse>,
 * streamComposerText: (request: ProviderRequest) => Promise<ProviderResponse>
 * }} MeetingCoachOpenAi
 */
/** @typedef {{readJsonDocument?: (name: string) => Promise<unknown>, writeJsonDocument?: (name: string, value: unknown) => Promise<unknown>}} MeetingCoachStore */

/**
 * @param {{store?: MeetingCoachStore, getOpenAiApiKey?: () => unknown | Promise<unknown>, model?: string,
 * openai?: MeetingCoachOpenAi, now?: () => string, rateLimitNow?: () => number, autoCoach?: boolean,
 * requestBudget?: number, requestWindowLimit?: number, requestWindowMs?: number}} [options]
 */
export function createMeetingCoachEngine({
  store,
  getOpenAiApiKey,
  model = DEFAULT_OPENAI_MEETING_COACH_MODEL,
  openai = {
    generateStructuredJson: generateMeetingCoachStructuredJson,
    streamStructuredJson: streamMeetingCoachStructuredJson,
    streamComposerText: streamMeetingCoachComposerText,
  },
  now = () => new Date().toISOString(),
  rateLimitNow = () => Date.now(),
  autoCoach = true,
  requestBudget = 240,
  requestWindowLimit = 20,
  requestWindowMs = 60_000,
} = {}) {
  const listeners = new Set();
  let seq = 0;
  let requestSequence = 0;
  let brief = null;
  let session = null;
  let turns = [];
  let suggestions = [];
  let usedRecommendations = [];
  let prepMessages = [];
  let manualInput = "";
  let connection = { caption: "CONNECTING", provider: "IDLE" };
  let autoAbortController = null;
  let manualAbortController = null;
  let interviewAbortController = null;
  let activeAutoRequestId = null;
  let activeManualRequestId = null;
  let activeInterviewRequestId = null;
  let lastLocalActivitySeq = -1;
  const rateLimitBuckets = new Map();
  let snapshot = makeSnapshot();

  function getSnapshot() {
    return snapshot;
  }

  function subscribeSnapshot(listener) {
    listeners.add(listener);
    listener(snapshot);
    return () => listeners.delete(listener);
  }

  async function hydrate() {
    const stored = await store?.readJsonDocument?.("active-state");
    if (!isRecord(stored) || stored.ok === false) return snapshot;
    try {
      brief = stored.brief ? MeetingBriefSchema.parse(stored.brief) : null;
      session = stored.session ? CoachSessionSchema.parse(stored.session) : null;
      turns = Array.isArray(stored.turns) ? stored.turns.map((turn) => FinalizedTurnSchema.parse(turn)) : [];
      suggestions = Array.isArray(stored.suggestions)
        ? stored.suggestions
          .map((suggestion) => CoachSuggestionSchema.parse(suggestion))
          .filter((suggestion) => suggestion.requestKind !== "AUTO_QUESTION")
        : [];
      usedRecommendations = Array.isArray(stored.usedRecommendations)
        ? stored.usedRecommendations.map((recommendation) => UsedRecommendationSchema.parse(recommendation))
        : [];
      prepMessages = Array.isArray(stored.prepMessages)
        ? stored.prepMessages.slice(-SIZE_CAPS.prepMessages).map((message) => PrepMessageSchema.parse(message))
        : [];
      requestSequence = suggestions.length;
      publish();
    } catch {
      brief = null;
      session = null;
      turns = [];
      suggestions = [];
      usedRecommendations = [];
      prepMessages = [];
      publish();
    }
    return snapshot;
  }

  /** @param {{brief?: unknown}} [input] */
  async function saveDraft({ brief: nextBrief } = {}) {
    brief = MeetingBriefSchema.parse({
      ...createApacMeetingBriefDraft({ now: now() }),
      ...(isRecord(nextBrief) ? nextBrief : {}),
      status: "DRAFT",
    });
    await store?.writeJsonDocument?.(`brief-${brief.id}`, brief);
    await persistActiveState();
    publish();
    return brief;
  }

  /** @param {{message?: unknown, onPartial?: (text: string) => void}} [input] */
  async function interview({ message, onPartial } = {}) {
    assertRequestAllowed("INTERVIEW");
    const text = normalizeText(message, SIZE_CAPS.userRequest);
    if (!text) throw new Error("Interview message is required.");
    const draft = brief ?? createApacMeetingBriefDraft({ now: now() });
    brief = draft;
    interviewAbortController?.abort();
    const requestAbortController = new AbortController();
    interviewAbortController = requestAbortController;
    const requestId = nextRequestId("interview");
    activeInterviewRequestId = requestId;
    prepMessages = appendPrepMessage(prepMessages, {
      id: `prep-user-${requestId}`,
      role: "USER",
      text,
      createdAt: now(),
    });
    await persistActiveState();
    setConnection({ provider: "GENERATING" });
    publish({ prepLane: { requestId, status: "GENERATING", partialText: "" } });
    const provider = await openai.streamStructuredJson({
      apiKey: await getOpenAiApiKey?.(),
      model,
      requestId,
      abortSignal: requestAbortController.signal,
      prompt: buildInterviewPrompt({ brief: draft, messages: prepMessages }),
      responseJsonSchema: INTERVIEW_RESPONSE_SCHEMA,
      onPartial: (partialJson) => {
        if (requestId !== activeInterviewRequestId) return;
        const partialText = extractStreamingJsonString(partialJson, "assistantReply");
        onPartial?.(partialText);
        publish({ prepLane: { requestId, status: "GENERATING", partialText } });
      },
    });
    if (requestId !== activeInterviewRequestId || brief?.id !== draft.id || brief?.version !== draft.version) {
      return { brief: snapshot.brief, reply: "", status: "STALE" };
    }
    if (!provider.ok) {
      setConnection({ provider: "ERROR" });
      publish({ prepLane: { requestId, status: "ERROR", partialText: "", error: provider.code } });
      throw createCoachError(provider.error || "AI 사전 인터뷰를 완료하지 못했습니다.", provider.code || "AI_INTERVIEW_FAILED");
    }
    let parsed;
    try {
      parsed = JSON.parse(provider.text ?? "");
    } catch {
      setConnection({ provider: "ERROR" });
      throw createCoachError("AI 사전 인터뷰 응답 형식이 올바르지 않습니다.", "INVALID_AI_INTERVIEW");
    }
    const patch = mergeInterviewPatch(parsed?.briefPatch);
    let nextBrief;
    try {
      nextBrief = MeetingBriefSchema.parse({
        ...draft,
        ...patch,
        id: draft.id,
        schemaVersion: draft.schemaVersion,
        meetingType: draft.meetingType,
        status: "DRAFT",
        version: draft.version,
        createdAt: draft.createdAt,
        updatedAt: now(),
      });
    } catch {
      setConnection({ provider: "ERROR" });
      throw createCoachError("AI 사전 인터뷰 내용을 브리프로 검증할 수 없습니다.", "INVALID_AI_INTERVIEW");
    }
    const saved = await saveDraft({ brief: nextBrief });
    const reply = normalizeText(parsed?.assistantReply, 1_200) || "브리프에 반영했습니다.";
    prepMessages = appendPrepMessage(prepMessages, {
      id: `prep-assistant-${requestId}`,
      role: "ASSISTANT",
      text: reply,
      createdAt: now(),
    });
    activeInterviewRequestId = null;
    await persistActiveState();
    setConnection({ provider: "READY" });
    onPartial?.(reply);
    publish({ prepLane: { requestId, status: "READY", partialText: "" } });
    return { brief: saved, reply };
  }

  /** @param {{brief?: unknown}} [input] */
  async function freezeBrief({ brief: candidateBrief } = {}) {
    brief = freezeMeetingBrief(candidateBrief ?? brief, { now: now() });
    await store?.writeJsonDocument?.(`brief-${brief.id}`, brief);
    await persistActiveState();
    publish();
    return brief;
  }

  /** @param {{briefId?: unknown, sourceSessionId?: string}} [input] */
  async function start({ briefId, sourceSessionId } = {}) {
    if (!brief || brief.id !== normalizeId(briefId)) throw createCoachError("확정된 회의 브리프를 찾을 수 없습니다.", "FROZEN_BRIEF_NOT_FOUND");
    if (session && session.state !== "ENDED") {
      if (session.briefId !== brief.id || session.briefVersion !== brief.version) {
        throw createCoachError("다른 회의가 이미 진행 중입니다.", "SESSION_ALREADY_ACTIVE");
      }
      return session;
    }
    if (session?.state === "ENDED") {
      turns = [];
      suggestions = [];
      usedRecommendations = [];
      manualInput = "";
    }
    session = createCoachSession({ brief, sourceSessionId, now: now() });
    session = transitionCoachSession(session, "ARMED", { now: now() });
    await persistActiveState();
    publish();
    return session;
  }

  /** @param {unknown} turn */
  async function acceptFinalizedTurn(turn) {
    if (!session) throw createCoachError("Meeting Coach 회의가 시작되지 않았습니다.", "SESSION_NOT_STARTED");
    if (session.state === "ENDED") return { session, accepted: false, reason: "SESSION_ENDED" };
    const finalizedTurn = FinalizedTurnSchema.parse(turn);
    const finalizedSourceSessionId = normalizeId(finalizedTurn.sourceSessionId);
    if (session.sourceSessionId !== "pending"
      && finalizedSourceSessionId
      && finalizedSourceSessionId !== session.sourceSessionId) {
      return { session, accepted: false, reason: "SOURCE_SESSION_MISMATCH" };
    }
    const result = appendFinalizedTurn(session, finalizedTurn);
    session = result.session;
    if (result.accepted) {
      if (session.sourceSessionId === "pending" && finalizedTurn.sourceSessionId) {
        session = CoachSessionSchema.parse({ ...session, sourceSessionId: finalizedTurn.sourceSessionId });
      }
      turns = [...turns, finalizedTurn];
      if (session.state === "ARMED") session = transitionCoachSession(session, "ACCEPT_FINAL_TURN", { now: now() });
      if (finalizedTurn.lane === "LOCAL_MIC") clearEphemeralAutoSuggestion();
      const question = prefilterQuestionTurn(finalizedTurn);
      if (question.accepted) {
        autoAbortController?.abort();
        session = { ...session, currentQuestionTurnId: finalizedTurn.id };
      }
    }
    await persistActiveState();
    publish();
    if (autoCoach && result.accepted && session.currentQuestionTurnId === finalizedTurn.id) {
      void answerTurn({ turnId: finalizedTurn.id }).catch(() => {});
    }
    return result;
  }

  /** @param {{turnId?: unknown}} [input] */
  async function answerTurn({ turnId } = {}) {
    if (!session || !brief) throw createCoachError("Meeting Coach 회의가 준비되지 않았습니다.", "SESSION_NOT_READY");
    assertRequestAllowed("ANSWER_TURN");
    const sourceTurn = turns.find((turn) => turn.id === normalizeId(turnId));
    if (!sourceTurn) throw createCoachError("확정된 발화 기록을 찾을 수 없습니다.", "FINALIZED_TURN_NOT_FOUND");
    session = { ...session, currentQuestionTurnId: sourceTurn.id };
    const requestSession = session;
    const requestBrief = brief;
    const requestTurns = turns;
    autoAbortController?.abort();
    const requestAbortController = new AbortController();
    autoAbortController = requestAbortController;
    const requestId = nextRequestId("auto");
    activeAutoRequestId = requestId;
    const generating = createGeneratingSuggestion({
      coachSessionId: session.id,
      requestId,
      briefVersion: requestBrief.version,
      sourceTurnId: sourceTurn.id,
      now: now(),
    });
    suggestions = [...suggestions, generating];
    setConnection({ provider: "GENERATING" });
    publish({ autoLane: { requestId, sourceTurnId: sourceTurn.id, status: "GENERATING" } });

    const provider = await openai.generateStructuredJson({
      apiKey: await getOpenAiApiKey?.(),
      model,
      requestId,
      abortSignal: requestAbortController.signal,
      prompt: buildCoachPrompt({ brief: requestBrief, turns: requestTurns, question: sourceTurn.english || sourceTurn.text }),
      responseJsonSchema: COACH_RESPONSE_SCHEMA,
    });
    const ready = provider.ok
      ? validateStructuredCoachResponse(provider.text, {
        brief: requestBrief,
        turns: requestTurns,
        coachSessionId: requestSession.id,
        requestId,
        sourceTurnId: sourceTurn.id,
        now: now(),
      })
      : createReadyVerifySuggestion({
        coachSessionId: requestSession.id,
        requestId,
        brief: requestBrief,
        sourceTurnId: sourceTurn.id,
        now: now(),
        errorCode: provider.code,
      });
    if (requestId !== activeAutoRequestId
      || session?.id !== requestSession.id
      || session.sourceSessionId !== requestSession.sourceSessionId
      || brief?.id !== requestBrief.id
      || brief.version !== requestBrief.version) {
      const stale = CoachSuggestionSchema.parse({ ...ready, status: "STALE" });
      if (suggestions.some((suggestion) => suggestion.requestId === requestId && suggestion.status === "GENERATING")) {
        suggestions = suggestions.map((suggestion) => suggestion.requestId === requestId && suggestion.status === "GENERATING" ? stale : suggestion);
        publish();
      }
      return stale;
    }
    const gated = applyStalenessGate({ session, suggestion: ready, currentQuestionTurnId: session.currentQuestionTurnId });
    suggestions = [...suggestions.filter((suggestion) => suggestion.requestId !== requestId), gated];
    activeAutoRequestId = null;
    setConnection({ provider: provider.ok ? "READY" : "ERROR" });
    await persistActiveState();
    publish();
    return gated;
  }

  /** @param {{action?: unknown, text?: unknown, onPartial?: (text: string) => void}} [input] */
  async function runManualAction({ action, text, onPartial } = {}) {
    if (!session || !brief) throw createCoachError("Meeting Coach 회의가 준비되지 않았습니다.", "SESSION_NOT_READY");
    assertRequestAllowed("MANUAL_ACTION");
    const requestKind = validateComposerAction(action);
    const previousManual = findLatestSuggestion((suggestion) => suggestion.requestKind !== "AUTO_QUESTION");
    const previousAuto = findLatestSuggestion((suggestion) => suggestion.requestKind === "AUTO_QUESTION");
    const input = normalizeText(text || previousManual?.english || previousAuto?.english, 2_000);
    if (!input) throw createCoachError("번역하거나 다듬을 문장을 입력해 주세요.", "MANUAL_TEXT_REQUIRED");
    manualAbortController?.abort();
    const requestAbortController = new AbortController();
    manualAbortController = requestAbortController;
    const requestId = nextRequestId("manual");
    const requestSession = session;
    const requestBrief = brief;
    activeManualRequestId = requestId;
    manualInput = input;
    setConnection({ provider: "GENERATING" });
    publish({ manualLane: { requestId, action: requestKind, input, status: "GENERATING", partialText: "" } });
    const provider = await openai.streamComposerText({
      apiKey: await getOpenAiApiKey?.(),
      model,
      requestId,
      abortSignal: requestAbortController.signal,
      prompt: buildComposerPrompt({ action: requestKind, input, brief: requestBrief, currentQuestion: snapshot.currentQuestion }),
      onPartial: (partialText) => {
        if (requestId !== activeManualRequestId) return;
        if (typeof onPartial === "function") onPartial(partialText);
        publish({ manualLane: { requestId, action: requestKind, input, status: "GENERATING", partialText } });
      },
    });
    const isCurrentRequest = requestId === activeManualRequestId
      && session?.id === requestSession.id
      && session.sourceSessionId === requestSession.sourceSessionId
      && brief?.id === requestBrief.id
      && brief.version === requestBrief.version;
    const outputText = provider.ok ? normalizeText(provider.text, SIZE_CAPS.userRequest) : "";
    const translatedFields = mapComposerResult({ action: requestKind, input, outputText });
    const suggestion = CoachSuggestionSchema.parse({
      schemaVersion: 1,
      id: `suggestion-${requestId}`,
      coachSessionId: requestSession.id,
      requestId,
      briefVersion: requestBrief.version,
      requestKind,
      status: isCurrentRequest ? (provider.ok ? "READY_GROUNDED" : "ERROR") : "STALE",
      english: translatedFields.english,
      korean: translatedFields.korean,
      evidenceRefs: [],
      createdAt: now(),
      errorCode: provider.ok ? undefined : provider.code,
    });
    if (!isCurrentRequest) return suggestion;
    activeManualRequestId = null;
    suggestions = [...suggestions, suggestion];
    setConnection({ provider: provider.ok ? "READY" : "ERROR" });
    await persistActiveState();
    publish();
    return suggestion;
  }

  /** @param {unknown} input */
  async function useRecommendation(input = {}) {
    if (!session || !brief) throw createCoachError("Meeting Coach 회의가 준비되지 않았습니다.", "SESSION_NOT_READY");
    const request = UseRecommendationRequestSchema.parse(input);
    const existing = usedRecommendations.find((recommendation) => (
      recommendation.coachSessionId === session.id && recommendation.sourceTurnId === request.sourceTurnId
    ));
    if (existing) return existing;
    const suggestion = findLatestSuggestion((candidate) => candidate.requestKind === "AUTO_QUESTION"
      && candidate.coachSessionId === session.id
      && candidate.sourceTurnId === request.sourceTurnId
      && (candidate.status === "READY_GROUNDED" || candidate.status === "READY_VERIFY"));
    if (!suggestion || session.currentQuestionTurnId !== request.sourceTurnId) {
      throw createCoachError("사용할 수 있는 현재 추천 답변을 찾을 수 없습니다.", "READY_RECOMMENDATION_NOT_FOUND");
    }
    const used = UsedRecommendationSchema.parse({
      schemaVersion: 1,
      id: `used-${session.id}-${request.sourceTurnId}`,
      coachSessionId: session.id,
      sourceTurnId: request.sourceTurnId,
      suggestionId: suggestion.id,
      requestId: suggestion.requestId,
      briefVersion: suggestion.briefVersion,
      english: suggestion.english,
      korean: suggestion.korean,
      evidenceRefs: suggestion.evidenceRefs,
      usedAt: now(),
    });
    usedRecommendations = [...usedRecommendations, used];
    await persistActiveState();
    publish();
    return used;
  }

  /** @param {{sourceSessionId?: unknown, seq?: unknown, phase?: unknown}} [input] */
  async function acceptLocalSpeechActivity({ sourceSessionId, seq: activitySeq, phase } = {}) {
    if (!session) return { accepted: false, reason: "SESSION_NOT_STARTED" };
    const normalizedSourceSessionId = normalizeId(sourceSessionId);
    if (session.sourceSessionId !== "pending"
      && normalizedSourceSessionId
      && normalizedSourceSessionId !== session.sourceSessionId) {
      return { accepted: false, reason: "SOURCE_SESSION_MISMATCH" };
    }
    const normalizedPhase = normalizeText(phase, 20).toUpperCase();
    if (!["PARTIAL", "FINAL"].includes(normalizedPhase)) {
      throw createCoachError("로컬 발화 상태가 올바르지 않습니다.", "INVALID_LOCAL_SPEECH_PHASE");
    }
    const numericSeq = Number(activitySeq);
    if (!Number.isSafeInteger(numericSeq) || numericSeq < 0) {
      throw createCoachError("로컬 발화 순서가 올바르지 않습니다.", "INVALID_LOCAL_SPEECH_SEQUENCE");
    }
    if (numericSeq < lastLocalActivitySeq) return { accepted: false, reason: "STALE_LOCAL_ACTIVITY" };
    lastLocalActivitySeq = numericSeq;
    clearEphemeralAutoSuggestion();
    await persistActiveState();
    publish({ autoLane: { requestId: undefined, sourceTurnId: undefined, status: "IDLE", result: null, error: undefined } });
    return { accepted: true, phase: normalizedPhase };
  }

  /** @param {{sourceSessionId?: unknown}} [input] */
  async function end({ sourceSessionId } = {}) {
    if (!session) return null;
    const normalizedSourceSessionId = normalizeId(sourceSessionId);
    if (session.sourceSessionId === "pending" && normalizedSourceSessionId) {
      session = CoachSessionSchema.parse({ ...session, sourceSessionId: normalizedSourceSessionId });
    } else if (normalizedSourceSessionId && normalizedSourceSessionId !== session.sourceSessionId) {
      return session;
    }
    autoAbortController?.abort();
    manualAbortController?.abort();
    interviewAbortController?.abort();
    activeAutoRequestId = null;
    activeManualRequestId = null;
    activeInterviewRequestId = null;
    if (session.state !== "ENDED") session = transitionCoachSession(session, "END", { now: now() });
    await store?.writeJsonDocument?.(`session-${session.id}`, {
      session,
      suggestions: suggestions.filter((suggestion) => suggestion.requestKind !== "AUTO_QUESTION"),
      usedRecommendations,
    });
    await persistActiveState();
    publish();
    return session;
  }

  /** @param {{autoLane?: Record<string, unknown>, manualLane?: Record<string, unknown>, prepLane?: Record<string, unknown>, connection?: Record<string, unknown>}} [overrides] */
  function publish(overrides = {}) {
    snapshot = makeSnapshot(overrides);
    for (const listener of listeners) listener(snapshot);
  }

  /** @param {{autoLane?: Record<string, unknown>, manualLane?: Record<string, unknown>, prepLane?: Record<string, unknown>, connection?: Record<string, unknown>}} [overrides] */
  function makeSnapshot(overrides = {}) {
    const latestAuto = findLatestSuggestion((suggestion) => suggestion.requestKind === "AUTO_QUESTION");
    const latestManual = findLatestSuggestion((suggestion) => suggestion.requestKind !== "AUTO_QUESTION");
    const turnSnapshot = Object.freeze(turns.map((turn) => Object.freeze({ ...turn })));
    const currentQuestion = session?.currentQuestionTurnId
      ? turnSnapshot.find((turn) => turn.id === session.currentQuestionTurnId) ?? null
      : null;
    const briefSnapshot = brief ? deepFreeze(structuredClone(brief)) : null;
    const latestAutoSnapshot = latestAuto ? deepFreeze(structuredClone(latestAuto)) : null;
    const latestManualSnapshot = latestManual ? deepFreeze(structuredClone(latestManual)) : null;
    const prepMessageSnapshot = Object.freeze(prepMessages.map((message) => Object.freeze({ ...message })));
    const usedRecommendationSnapshot = Object.freeze(usedRecommendations.map((recommendation) => Object.freeze({ ...recommendation })));
    return Object.freeze({
      seq: ++seq,
      coachSessionId: session?.id ?? null,
      state: session?.state ?? "PREPARED",
      brief: briefSnapshot,
      prepMessages: prepMessageSnapshot,
      prepLane: Object.freeze({
        requestId: activeInterviewRequestId ?? undefined,
        status: activeInterviewRequestId ? "GENERATING" : "IDLE",
        partialText: "",
        ...overrides.prepLane,
      }),
      turns: turnSnapshot,
      usedRecommendations: usedRecommendationSnapshot,
      currentQuestion,
      autoLane: Object.freeze({
        requestId: latestAuto?.requestId,
        sourceTurnId: latestAuto?.sourceTurnId,
        status: latestAuto?.status ?? "IDLE",
        result: latestAutoSnapshot,
        error: latestAuto?.status === "ERROR" ? latestAuto.errorCode : undefined,
        ...overrides.autoLane,
      }),
      manualLane: Object.freeze({
        requestId: latestManual?.requestId,
        action: latestManual?.requestKind,
        input: manualInput || undefined,
        status: latestManual?.status ?? "IDLE",
        partialText: "",
        result: latestManualSnapshot,
        error: latestManual?.status === "ERROR" ? latestManual.errorCode : undefined,
        ...overrides.manualLane,
      }),
      connection: Object.freeze({ ...connection, ...overrides.connection }),
    });
  }

  /** @param {{caption?: string, provider?: string}} patch */
  function setConnection(patch) {
    connection = { ...connection, ...patch };
    publish();
  }

  /** @param {(suggestion: import("zod").infer<typeof CoachSuggestionSchema>) => boolean} predicate */
  function findLatestSuggestion(predicate) {
    return [...suggestions].reverse().find(predicate) ?? null;
  }

  function currentManualRequestId() {
    return activeManualRequestId;
  }

  function currentAutoRequestId() {
    return activeAutoRequestId;
  }

  function clearEphemeralAutoSuggestion() {
    autoAbortController?.abort();
    autoAbortController = null;
    activeAutoRequestId = null;
    suggestions = suggestions.filter((suggestion) => suggestion.requestKind !== "AUTO_QUESTION");
    if (session?.currentQuestionTurnId) {
      session = CoachSessionSchema.parse({ ...session, currentQuestionTurnId: undefined });
    }
    if (!activeManualRequestId && !activeInterviewRequestId && connection.provider === "GENERATING") {
      connection = { ...connection, provider: "IDLE" };
    }
  }

  /** @param {"INTERVIEW"|"ANSWER_TURN"|"MANUAL_ACTION"} operation */
  function assertRequestAllowed(operation) {
    const key = session?.id ?? "prep";
    const currentTime = Number(rateLimitNow());
    if (!Number.isFinite(currentTime)) throw createCoachError("AI 요청 제한 시계를 확인할 수 없습니다.", "RATE_LIMIT_CLOCK_INVALID");
    const totalLimit = Math.min(1_000, Math.max(1, Math.trunc(Number(requestBudget) || 240)));
    const windowLimit = Math.min(100, Math.max(1, Math.trunc(Number(requestWindowLimit) || 20)));
    const windowDuration = Math.min(3_600_000, Math.max(1_000, Math.trunc(Number(requestWindowMs) || 60_000)));
    const previous = rateLimitBuckets.get(key) ?? { total: 0, timestamps: [] };
    const timestamps = previous.timestamps.filter((timestamp) => currentTime - timestamp < windowDuration);
    if (previous.total >= totalLimit || timestamps.length >= windowLimit) {
      throw createCoachError(`${operation} 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.`, "RATE_LIMITED");
    }
    rateLimitBuckets.set(key, { total: previous.total + 1, timestamps: [...timestamps, currentTime] });
  }

  /** @param {string} prefix */
  function nextRequestId(prefix) {
    requestSequence += 1;
    return `${prefix}-${requestSequence}`;
  }

  async function persistActiveState() {
    await store?.writeJsonDocument?.("active-state", {
      brief,
      session,
      turns,
      suggestions: suggestions.filter((suggestion) => suggestion.requestKind !== "AUTO_QUESTION"),
      usedRecommendations,
      prepMessages,
    });
  }

  function dispose() {
    autoAbortController?.abort();
    manualAbortController?.abort();
    interviewAbortController?.abort();
    activeAutoRequestId = null;
    activeManualRequestId = null;
    activeInterviewRequestId = null;
    listeners.clear();
  }

  return {
    getSnapshot,
    subscribeSnapshot,
    hydrate,
    setConnection,
    saveDraft,
    interview,
    freezeBrief,
    start,
    acceptFinalizedTurn,
    acceptLocalSpeechActivity,
    answerTurn,
    runManualAction,
    useRecommendation,
    end,
    dispose,
  };
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {string} message @param {string} code */
function createCoachError(message, code) {
  return Object.assign(new Error(message), { code });
}
