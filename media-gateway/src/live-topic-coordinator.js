import { parseLiveTopicDecision } from "./live-topic-detector.js";

const TOPIC_IDLE_MILLISECONDS = 12_000;
const MAX_RECENT_TOPIC_FINALS = 8;
const DEFAULT_MAX_PENDING_LIVE_FINALS = 256;
const DEFAULT_MAX_RECOVERY_ITEMS = 10_000;
const DEFAULT_MAX_RECOVERY_ITEMS_PER_SLICE = 25;
const DEFAULT_MAX_RECOVERY_PAGES = 100;
const DEFAULT_MAX_RECOVERY_MILLISECONDS = 5_000;
const DEFAULT_MAX_SEEN_UTTERANCE_KEYS = 4_096;
const RECOVERY_PAGE_SIZE = 100;
const TERMINAL_TRANSITION_STATUSES = new Set(["applied", "idempotent", "ignored", "processed"]);

export class LiveTopicCoordinator {
  constructor({
    detector,
    store,
    eventFanout,
    now = Date.now,
    observeFailure = () => undefined,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    yieldFn = () => new Promise((resolve) => setImmediate(resolve)),
    recoveryNow = () => performance.now(),
    maxPendingLiveFinals = DEFAULT_MAX_PENDING_LIVE_FINALS,
    maxRecoveryItems = DEFAULT_MAX_RECOVERY_ITEMS,
    maxRecoveryItemsPerSlice = DEFAULT_MAX_RECOVERY_ITEMS_PER_SLICE,
    maxRecoveryPages = DEFAULT_MAX_RECOVERY_PAGES,
    maxRecoveryMilliseconds = DEFAULT_MAX_RECOVERY_MILLISECONDS,
    maxSeenUtteranceKeys = DEFAULT_MAX_SEEN_UTTERANCE_KEYS,
  }) {
    if (typeof detector?.detect !== "function" || !store || typeof eventFanout !== "function") {
      throw new Error("INVALID_TOPIC_COORDINATOR");
    }
    for (const value of [
      maxPendingLiveFinals,
      maxRecoveryItems,
      maxRecoveryItemsPerSlice,
      maxRecoveryPages,
      maxRecoveryMilliseconds,
      maxSeenUtteranceKeys,
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("INVALID_TOPIC_COORDINATOR_BUDGET");
    }
    if (typeof yieldFn !== "function" || typeof recoveryNow !== "function") {
      throw new Error("INVALID_TOPIC_COORDINATOR_SCHEDULER");
    }
    this.detector = detector;
    this.store = store;
    this.eventFanout = eventFanout;
    this.now = now;
    this.observeFailure = observeFailure;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.yieldFn = yieldFn;
    this.recoveryNow = recoveryNow;
    this.maxPendingLiveFinals = maxPendingLiveFinals;
    this.maxRecoveryItems = maxRecoveryItems;
    this.maxRecoveryItemsPerSlice = maxRecoveryItemsPerSlice;
    this.maxRecoveryPages = maxRecoveryPages;
    this.maxRecoveryMilliseconds = maxRecoveryMilliseconds;
    this.maxSeenUtteranceKeys = maxSeenUtteranceKeys;
    this.sessions = new Map();
  }

  async start(sessionId, languages) {
    let state = this.sessions.get(sessionId);
    if (state) {
      for (const language of languages) state.languages.add(language);
      await state.ready;
      return;
    }
    state = this.#createState(languages);
    this.sessions.set(sessionId, state);
    state.ready = this.#initialize(sessionId, state).catch(() => {
      this.observeFailure("TOPIC_LIFECYCLE_FAILED");
    }).then(() => {
      state.isReady = true;
      this.#ensurePump(sessionId, state);
    });
    await state.ready;
  }

  enqueueSourceFinal(sessionId, language, caption) {
    const state = this.sessions.get(sessionId);
    if (!state || !state.isAccepting
      || state.seenUtteranceKeys.has(caption.utteranceKey)
      || state.inFlightUtteranceKeys.has(caption.utteranceKey)) return false;
    if (state.liveQueue.length >= this.maxPendingLiveFinals) {
      this.observeFailure("TOPIC_LIVE_QUEUE_FULL");
      this.#requestRecovery(state, language);
      this.#ensurePump(sessionId, state);
      return false;
    }
    state.inFlightUtteranceKeys.add(caption.utteranceKey);
    this.#clearIdle(state);
    state.liveQueue.push({ language, caption: { ...caption, topicObservedAt: this.now() } });
    this.#ensurePump(sessionId, state);
    return true;
  }

  notePartial(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state || state.isPaused || !state.activeTopic) return;
    state.idleAnchorAt = this.now();
    this.#scheduleIdle(sessionId, state);
  }

  pause(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.isPaused = true;
    state.pausedAt = this.now();
    this.#clearIdle(state);
  }

  resume(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.pausedAt !== null && state.idleAnchorAt !== null) {
      state.idleAnchorAt += Math.max(0, this.now() - state.pausedAt);
    }
    state.pausedAt = null;
    state.isPaused = false;
    if (state.activeTopic) this.#scheduleIdle(sessionId, state);
  }

  async end(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.isAccepting = false;
    this.#clearIdle(state);
    await state.ready;
    await this.drain(sessionId);
    const changed = await this.store.completeTopicsOnSessionEnd(sessionId);
    if (changed > 0 && state.sourceLanguage) {
      const context = await this.store.readTopicContext(sessionId, state.sourceLanguage);
      if (context.ok === true) await this.#broadcast(sessionId, state, context);
    }
    state.liveQueue.length = 0;
    state.controlQueue.length = 0;
    state.recoveryLanes.length = 0;
    state.seenUtteranceKeys.clear();
    state.inFlightUtteranceKeys.clear();
    state.recentSourceFinals.length = 0;
    this.sessions.delete(sessionId);
  }

  async drain(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    await state.ready;
    while (true) {
      this.#ensurePump(sessionId, state);
      const tail = state.tail;
      await tail;
      if (!state.isRunning && !this.#hasWork(state)) return;
    }
  }

  async suspend(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.isAccepting = false;
    this.pause(sessionId);
    // Durable source rows remain available to the next start's recovery.
    state.liveQueue.length = 0;
    state.controlQueue.length = 0;
    state.recoveryLanes.length = 0;
    await state.tail;
    if (this.sessions.get(sessionId) === state) this.sessions.delete(sessionId);
  }

  #createState(languages) {
    return {
      languages: new Set(languages),
      activeTopic: null,
      sourceLanguage: languages[0] ?? null,
      recentSourceFinals: [],
      seenUtteranceKeys: new Set(),
      inFlightUtteranceKeys: new Set(),
      liveQueue: [],
      controlQueue: [],
      recoveryLanes: [],
      recoveryLaneIndex: 0,
      recoveryItemsExamined: 0,
      recoveryPagesRead: 0,
      recoveryStartedAt: this.recoveryNow(),
      didReportRecoveryBudget: false,
      isPaused: false,
      isAccepting: true,
      isReady: false,
      isRunning: false,
      idleTimer: null,
      idleAnchorAt: null,
      pausedAt: null,
      hasHydratedContext: false,
      ready: Promise.resolve(),
      tail: Promise.resolve(),
    };
  }

  async #initialize(sessionId, state) {
    for (const language of state.languages) {
      const context = await this.store.readTopicContext(sessionId, language);
      if (context.ok !== true) continue;
      this.#adoptContext(state, context);
      if (context.latestSourceSeq <= 0) continue;
      await this.#hydrateRecentFinals(sessionId, state, context);
      this.#requestRecovery(state, language);
    }
    if (state.activeTopic) this.#scheduleIdle(sessionId, state);
  }

  async #hydrateRecentFinals(sessionId, state, context) {
    const activeTopic = context.topics.find((value) => value.status === "active") ?? null;
    if (!activeTopic || state.hasHydratedContext || typeof this.store.fetchRecentTopicFinals !== "function") return;
    const activeKeys = context.topicMemberships
      .filter((value) => value.topicId === activeTopic.id)
      .sort((left, right) => left.position - right.position)
      .slice(-MAX_RECENT_TOPIC_FINALS)
      .map((value) => value.utteranceKey);
    if (activeKeys.length === 0) return;
    state.hasHydratedContext = true;
    try {
      state.recentSourceFinals = await this.store.fetchRecentTopicFinals(sessionId, activeKeys);
    } catch {
      this.observeFailure("TOPIC_CONTEXT_HYDRATION_FAILED");
    }
  }

  #requestRecovery(state, language) {
    if (!this.#hasRecoveryWork(state)) {
      state.recoveryItemsExamined = 0;
      state.recoveryPagesRead = 0;
      state.recoveryStartedAt = this.recoveryNow();
      state.didReportRecoveryBudget = false;
    }
    const existing = state.recoveryLanes.find((lane) => lane.language === language);
    if (existing) {
      if (existing.isDone) {
        if (existing.pendingIndex >= existing.pending.length && existing.pending.length > 0) {
          existing.cursor = existing.nextCursor;
        }
        existing.pending = [];
        existing.pendingIndex = 0;
        existing.isTerminalPage = false;
      }
      existing.isDone = false;
      return;
    }
    state.recoveryLanes.push({
      language,
      cursor: 0,
      pending: [],
      pendingIndex: 0,
      nextCursor: 0,
      isTerminalPage: false,
      isDone: false,
    });
  }

  #ensurePump(sessionId, state) {
    if (!state.isReady || state.isRunning || !this.#hasWork(state)) return;
    state.isRunning = true;
    state.tail = this.#runPump(sessionId, state).catch(() => {
      this.observeFailure("TOPIC_LIFECYCLE_FAILED");
    }).finally(() => {
      state.isRunning = false;
      if (this.#hasWork(state)) this.#ensurePump(sessionId, state);
    });
  }

  async #runPump(sessionId, state) {
    let recoveryItemsInSlice = 0;
    while (true) {
      const live = state.liveQueue.shift();
      if (live) {
        recoveryItemsInSlice = 0;
        await this.#runLiveItem(sessionId, state, live);
        continue;
      }
      const control = state.controlQueue.shift();
      if (control) {
        recoveryItemsInSlice = 0;
        await control();
        continue;
      }
      if (!this.#hasRecoveryWork(state)) return;
      if (recoveryItemsInSlice >= this.maxRecoveryItemsPerSlice) {
        recoveryItemsInSlice = 0;
        await this.yieldFn();
        continue;
      }
      const recovered = await this.#takeRecoveryItem(sessionId, state);
      if (!recovered) continue;
      if (state.liveQueue.length > 0) {
        recovered.lane.pendingIndex -= 1;
        state.recoveryItemsExamined -= 1;
        continue;
      }
      recoveryItemsInSlice += 1;
      await this.#runRecoveryItem(sessionId, state, recovered.value);
    }
  }

  async #runLiveItem(sessionId, state, item) {
    try {
      await this.#processSourceFinal(sessionId, state, item.language, item.caption);
    } catch {
      this.observeFailure("TOPIC_LIFECYCLE_FAILED");
    } finally {
      state.inFlightUtteranceKeys.delete(item.caption.utteranceKey);
    }
  }

  async #runRecoveryItem(sessionId, state, sourceFinal) {
    if (state.seenUtteranceKeys.has(sourceFinal.utteranceKey)
      || state.inFlightUtteranceKeys.has(sourceFinal.utteranceKey)) return;
    state.inFlightUtteranceKeys.add(sourceFinal.utteranceKey);
    try {
      await this.#processSourceFinal(sessionId, state, sourceFinal.sourceLanguage, {
        seq: sourceFinal.sourceSeq,
        text: sourceFinal.text,
        utteranceKey: sourceFinal.utteranceKey,
        emittedAt: sourceFinal.emittedAt,
      });
    } catch {
      this.observeFailure("TOPIC_LIFECYCLE_FAILED");
    } finally {
      state.inFlightUtteranceKeys.delete(sourceFinal.utteranceKey);
    }
  }

  async #takeRecoveryItem(sessionId, state) {
    if (this.#recoveryBudgetExpired(state)) {
      this.#exhaustRecovery(state);
      return null;
    }
    const laneCount = state.recoveryLanes.length;
    for (let attempt = 0; attempt < laneCount; attempt += 1) {
      const laneIndex = state.recoveryLaneIndex % laneCount;
      state.recoveryLaneIndex = (laneIndex + 1) % laneCount;
      const lane = state.recoveryLanes[laneIndex];
      if (lane.isDone) continue;
      if (lane.pendingIndex >= lane.pending.length) {
        if (lane.pending.length > 0) {
          lane.cursor = lane.nextCursor;
          if (lane.isTerminalPage) {
            lane.isDone = true;
            continue;
          }
        }
        if (state.recoveryPagesRead >= this.maxRecoveryPages || this.#recoveryBudgetExpired(state)) {
          this.#exhaustRecovery(state);
          return null;
        }
        const recovered = await this.store.recoverTopicAssignments(sessionId, lane.language, lane.cursor);
        state.recoveryPagesRead += 1;
        if (recovered.ok !== true) {
          lane.isDone = true;
          continue;
        }
        lane.pending = recovered.unassignedFinals;
        lane.pendingIndex = 0;
        lane.nextCursor = recovered.nextSourceSeq;
        lane.isTerminalPage = recovered.unassignedFinals.length < RECOVERY_PAGE_SIZE
          || recovered.nextSourceSeq <= lane.cursor;
        if (lane.pending.length === 0) {
          lane.cursor = lane.nextCursor;
          lane.isDone = true;
          continue;
        }
      }
      const value = lane.pending[lane.pendingIndex];
      lane.pendingIndex += 1;
      state.recoveryItemsExamined += 1;
      return { lane, value };
    }
    return null;
  }

  #recoveryBudgetExpired(state) {
    return state.recoveryItemsExamined >= this.maxRecoveryItems
      || this.recoveryNow() - state.recoveryStartedAt >= this.maxRecoveryMilliseconds;
  }

  #exhaustRecovery(state) {
    for (const lane of state.recoveryLanes) lane.isDone = true;
    if (state.didReportRecoveryBudget) return;
    state.didReportRecoveryBudget = true;
    this.observeFailure("TOPIC_RECOVERY_BUDGET_EXHAUSTED");
  }

  #hasWork(state) {
    return state.liveQueue.length > 0 || state.controlQueue.length > 0 || this.#hasRecoveryWork(state);
  }

  #hasRecoveryWork(state) {
    return state.recoveryLanes.some((lane) => !lane.isDone);
  }

  async #processSourceFinal(sessionId, state, language, caption) {
    state.sourceLanguage = language;
    let decision;
    try {
      decision = await this.detector.detect({
        sessionId,
        recentSourceFinals: state.recentSourceFinals,
        candidateSourceFinal: { text: caption.text },
        previousSummary: state.activeTopic?.summary ?? null,
      });
      if (decision.detectorHealth !== "healthy") throw new Error("TOPIC_DETECTOR_DEGRADED");
      decision = { ...decision, ...parseLiveTopicDecision(JSON.stringify({
        meaningful: decision.meaningful, startsNewTopic: decision.startsNewTopic,
        title: decision.title, summary: decision.summary,
      })) };
    } catch {
      decision = { meaningful: true, startsNewTopic: false, title: null, summary: null, detectorHealth: "degraded" };
    }
    let activeTopic = state.activeTopic;
    const createTransition = () => ({
      sessionId,
      language,
      utteranceKey: caption.utteranceKey,
      sourceSeq: caption.seq,
      meaningful: decision.meaningful,
      decision: decision.startsNewTopic ? "shift" : "continue",
      expectedTopicId: activeTopic?.id ?? null,
      expectedVersion: activeTopic?.version ?? null,
      title: decision.title ?? activeTopic?.title ?? "Live topic",
      summary: decision.meaningful && decision.detectorHealth === "healthy"
        ? decision.summary
        : activeTopic?.summary ?? null,
      detectorHealth: decision.detectorHealth === "degraded"
        || (!decision.meaningful && activeTopic?.detectorHealth === "degraded") ? "degraded" : "healthy",
    });
    let result = await this.store.applyTopicTransition(createTransition());
    if (result.ok !== true && result.code === "TOPIC_VERSION_CONFLICT") {
      const context = await this.store.readTopicContext(sessionId, language);
      if (context.ok !== true) return;
      const previousTopicId = activeTopic?.id;
      this.#adoptContext(state, context);
      activeTopic = state.activeTopic;
      if (activeTopic?.id !== previousTopicId) state.recentSourceFinals = [];
      // 2026-08-31 fix: The generated summary used an outdated topic snapshot.
      // Preserve the refreshed summary without another paid model request.
      decision = { ...decision, startsNewTopic: false, title: null, summary: null, detectorHealth: "degraded" };
      result = await this.store.applyTopicTransition(createTransition());
    }
    if (result.ok !== true || !TERMINAL_TRANSITION_STATUSES.has(result.status)) {
      this.observeFailure("TOPIC_TRANSITION_FAILED");
      return;
    }
    this.#rememberSeenKey(state, caption.utteranceKey);
    this.#adoptMutation(state, result);
    if (result.status === "applied") await this.#broadcast(sessionId, state, result);
    if (!decision.meaningful) {
      if (state.activeTopic && !state.isPaused) this.#scheduleIdle(sessionId, state);
      return;
    }
    state.recentSourceFinals = decision.startsNewTopic
      ? [{ text: caption.text }]
      : [...state.recentSourceFinals, { text: caption.text }].slice(-MAX_RECENT_TOPIC_FINALS);
    state.idleAnchorAt = caption.topicObservedAt;
    if (state.activeTopic && !state.isPaused) this.#scheduleIdle(sessionId, state);
  }

  #rememberSeenKey(state, utteranceKey) {
    if (state.seenUtteranceKeys.has(utteranceKey)) state.seenUtteranceKeys.delete(utteranceKey);
    state.seenUtteranceKeys.add(utteranceKey);
    while (state.seenUtteranceKeys.size > this.maxSeenUtteranceKeys) {
      state.seenUtteranceKeys.delete(state.seenUtteranceKeys.values().next().value);
    }
  }

  #scheduleIdle(sessionId, state, { retryCount = 0, delay = null } = {}) {
    this.#clearIdle(state);
    if (state.isPaused || !state.activeTopic || !state.sourceLanguage || !state.isAccepting) return;
    if (!Number.isFinite(state.idleAnchorAt)) state.idleAnchorAt = this.now();
    const remaining = delay ?? Math.max(0, TOPIC_IDLE_MILLISECONDS - Math.max(0, this.now() - state.idleAnchorAt));
    state.idleTimer = this.setTimeoutFn(() => {
      state.idleTimer = null;
      state.controlQueue.push(async () => {
        if (state.isPaused || !state.activeTopic || !state.isAccepting) return;
        const result = await this.store.completeIdleTopic({
          sessionId,
          language: state.sourceLanguage,
          topicId: state.activeTopic.id,
          expectedVersion: state.activeTopic.version,
        });
        if (result.ok !== true) {
          if (retryCount < 1 && ["TOPIC_NOT_IDLE", "LATEST_SOURCE_FINAL_UNASSIGNED"].includes(result.code)) {
            state.idleAnchorAt = this.now();
            this.#scheduleIdle(sessionId, state, { retryCount: retryCount + 1, delay: TOPIC_IDLE_MILLISECONDS });
          } else {
            this.observeFailure("TOPIC_IDLE_COMPLETION_FAILED");
          }
          return;
        }
        this.#adoptMutation(state, result);
        await this.#broadcast(sessionId, state, result);
      });
      this.#ensurePump(sessionId, state);
    }, remaining);
    state.idleTimer?.unref?.();
  }

  #clearIdle(state) {
    if (state.idleTimer === null) return;
    this.clearTimeoutFn(state.idleTimer);
    state.idleTimer = null;
  }

  #adoptContext(state, context) {
    for (const membershipValue of context.topicMemberships) {
      this.#rememberSeenKey(state, membershipValue.utteranceKey);
    }
    state.activeTopic = context.topics.find((value) => value.status === "active") ?? null;
  }

  #adoptMutation(state, result) {
    const active = result.topics.find((value) => value.status === "active") ?? null;
    const completedActive = result.topics.some(
      (value) => value.status === "completed" && value.id === state.activeTopic?.id,
    );
    if (active) state.activeTopic = active;
    else if (completedActive) state.activeTopic = null;
  }

  async #broadcast(sessionId, state, result) {
    for (const topicValue of result.topics) {
      const membershipsAdded = result.membershipsAdded.filter(
        (membershipValue) => membershipValue.topicId === topicValue.id,
      );
      const event = { type: "topic-upsert", sessionId, topic: topicValue, membershipsAdded };
      await Promise.all([...state.languages].map((language) => this.eventFanout(sessionId, language, event)));
    }
  }
}
