import { LiveTopicCoordinator } from "./live-topic-coordinator.js";
import { resolveBuiltInGlossaryDocument } from "./glossary-packs.js";
import { compileGlossaryDocumentV1, mergeCompiledGlossariesV1 } from "../../packages/caption-core/index.js";

export { LiveTopicCoordinator };

export class SupabaseMediaDemandStore {
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.credential = resolveSupabaseCredential(config);
    this.fetchFn = config.fetchFn ?? fetch;
  }

  async read(sessionId) {
    return this.rpc("get_live_media_runtime_v1", { p_session_id: sessionId });
  }

  async transition(sessionId, epoch, ownerId, action, details = {}) {
    return this.rpc("gateway_live_media_v1", {
      p_session_id: sessionId, p_epoch: epoch, p_owner_id: ownerId, p_action: action,
      p_connection_id: details.connectionId ?? null,
      p_grant_id: details.grantId ?? null, p_user_id: details.userId ?? null,
      p_connection_ids: details.connectionIds ?? [],
    });
  }

  async rpc(name, payload) {
    const response = await this.fetchFn(`${this.baseUrl}/rest/v1/rpc/${name}`, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(5_000),
      headers: createSupabaseHeaders(this.credential, { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error("MEDIA_CONTROL_UNAVAILABLE");
    const result = await response.json();
    if (result === null && name === "get_live_media_runtime_v1") return null;
    if (!result || typeof result !== "object" || Array.isArray(result)
      || typeof result.sessionId !== "string" || !Number.isSafeInteger(result.epoch)
      || !["sleeping", "waking", "active", "draining", "failed", "ended"].includes(result.state)
      || typeof result.hostSourceReady !== "boolean" || !Number.isSafeInteger(result.connectedCount)) {
      throw new Error("MEDIA_CONTROL_INVALID");
    }
    return result;
  }
}

const DEFAULT_SNAPSHOT_GUARD_TIMEOUT_MILLISECONDS = 5_000;
const MAX_SNAPSHOT_GUARD_TIMEOUT_MILLISECONDS = 60_000;
const DEFAULT_RECONCILIATION_TIMEOUT_MILLISECONDS = 5_000;
const MAX_RECONCILIATION_TIMEOUT_MILLISECONDS = 5_000;
const MAX_RECENT_TOPIC_FINALS = 8;
const MAX_AUTHORITATIVE_SOURCE_CHARACTERS = 8_000;
const MAX_AUTHORITATIVE_SOURCE_BYTES = 24_000;
const MAX_AUTHORITATIVE_UTTERANCE_KEY_CHARACTERS = 200;
const MAX_AUTHORITATIVE_UTTERANCE_KEY_BYTES = 600;
const HOST_GLOSSARY_MERGE_PRIORITY = 100;

export class SupabaseLivePublisher {
  constructor({
    baseUrl,
    supabaseApiKey,
    supabaseKeyType,
    serviceRoleKey,
    eventFanout,
    sourceEventFanout = null,
    fetchFn = fetch,
    topicDetector = null,
    topicNow = Date.now,
    observeTopicFailure = () => undefined,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    snapshotGuardTimeoutMilliseconds = DEFAULT_SNAPSHOT_GUARD_TIMEOUT_MILLISECONDS,
    reconciliationTimeoutMilliseconds = DEFAULT_RECONCILIATION_TIMEOUT_MILLISECONDS,
  }) {
    if (!Number.isSafeInteger(snapshotGuardTimeoutMilliseconds)
      || snapshotGuardTimeoutMilliseconds < 1
      || snapshotGuardTimeoutMilliseconds > MAX_SNAPSHOT_GUARD_TIMEOUT_MILLISECONDS) {
      throw new Error("INVALID_SNAPSHOT_GUARD_TIMEOUT");
    }
    if (!Number.isSafeInteger(reconciliationTimeoutMilliseconds)
      || reconciliationTimeoutMilliseconds < 1
      || reconciliationTimeoutMilliseconds > MAX_RECONCILIATION_TIMEOUT_MILLISECONDS) {
      throw new Error("INVALID_RECONCILIATION_TIMEOUT");
    }
    this.baseUrl = baseUrl;
    this.supabaseCredential = resolveSupabaseCredential({ supabaseApiKey, supabaseKeyType, serviceRoleKey });
    this.eventFanout = eventFanout;
    this.sourceEventFanout = sourceEventFanout;
    this.fetchFn = fetchFn;
    this.snapshotGuardTimeoutMilliseconds = snapshotGuardTimeoutMilliseconds;
    this.reconciliationTimeoutMilliseconds = reconciliationTimeoutMilliseconds;
    this.failedDurableCaptionLanes = new Set();
    this.failedAuthoritativeSourceSessions = new Set();
    this.topicCoordinator = topicDetector ? new LiveTopicCoordinator({
      detector: topicDetector,
      store: this,
      eventFanout,
      now: topicNow,
      observeFailure: observeTopicFailure,
      setTimeoutFn,
      clearTimeoutFn,
    }) : null;
  }

  withMediaFence(mediaFence, { pipelineGeneration = null } = {}) {
    return {
      publish: (sessionId, language, event, options) => this.publish(sessionId, language, event, { ...options, mediaFence }),
      persistAuthoritativeSource: (input) => this.persistAuthoritativeSource(input, { mediaFence, pipelineGeneration }),
      publishSourceDraft: (event) => this.publishSourceDraft(event, { mediaFence, pipelineGeneration }),
      replayAuthoritativeSourceCaptions: (...args) => this.replayAuthoritativeSourceCaptions(...args),
      startTopicSession: (...args) => this.startTopicSession(...args),
      pauseTopicSession: (...args) => this.pauseTopicSession(...args),
      resumeTopicSession: (...args) => this.resumeTopicSession(...args),
      noteTopicPartial: (...args) => this.noteTopicPartial(...args),
      endTopicSession: (...args) => this.endTopicSession(...args),
      suspendTopicSession: (...args) => this.suspendTopicSession(...args),
    };
  }

  async publish(sessionId, language, event, { onLiveEvent = null, mediaFence = null } = {}) {
    const durableLaneKey = `${sessionId}\u0000${language}`;
    if (event.type === "caption" && this.failedDurableCaptionLanes.has(durableLaneKey)) {
      throw new Error("DURABLE_CAPTION_LANE_FAILED");
    }
    if (event.type === "caption" && event.isFinal) {
      // Paint the completed wording immediately, but keep it explicitly
      // provisional until the durable row and snapshot commit atomically.
      // The durable event reuses this seq, so viewers upgrade one line instead
      // of appending a duplicate or waiting on database latency.
      const provisionalEvent = { ...event, isFinal: false };
      await Promise.all([
        this.eventFanout(sessionId, language, provisionalEvent),
        typeof onLiveEvent === "function" ? onLiveEvent(provisionalEvent) : undefined,
      ]);
      let durableResult;
      try {
        // These headings exist only on the live Electron event. The deployed
        // snapshot RPC intentionally rejects unknown top-level keys; durable
        // identity remains in the validated nested speaker object/columns.
        const durableEvent = { ...event };
        delete durableEvent.speakerRole;
        delete durableEvent.speakerName;
        delete durableEvent.speakerDepartment;
        delete durableEvent.speakerJobTitle;
        // Language evidence is stored once on the linked authoritative source.
        delete durableEvent.languageObservation;
        // The final flag is delivered only after this atomic commit succeeds.
        durableResult = await this.#requestSnapshotGuard(mediaFence
          ? "/rest/v1/rpc/persist_live_final_caption_if_active_fenced_v1"
          : "/rest/v1/rpc/persist_live_final_caption_if_active", {
          method: "POST",
          body: JSON.stringify({
            p_session_id: sessionId,
            ...(mediaFence ? { p_epoch: mediaFence.epoch, p_owner_id: mediaFence.ownerId } : {}),
            p_language: language,
            p_event: durableEvent,
            p_seq: event.seq,
            p_text: event.text,
            p_speaker_label: event.speaker?.speakerId ?? null,
            p_speaker_name: event.speaker?.label ?? null,
            p_source_started_at: event.sourceStartedAt ?? null,
            p_source_ended_at: event.sourceEndedAt,
            p_emitted_at: event.emittedAt,
            p_participant_id: participantIdFromSpeaker(event.speaker),
            p_source_text: event.sourceText ?? null,
            p_source_language: event.sourceLanguage ?? null,
            p_origin: event.origin ?? null,
            p_utterance_key: event.utteranceKey ?? null,
            p_translation_status: event.translationStatus
              ?? (event.origin === "source" ? "verbatim" : event.sourceText ? "translated" : null),
            ...(event.authoritativeSourceId
              ? { p_authoritative_source_id: event.authoritativeSourceId }
              : {}),
          }),
        });
      } catch (error) {
        // No automatic retry: the commit outcome may be ambiguous. Latch this
        // lane closed so a later N+1 can never become a durable seq gap.
        this.failedDurableCaptionLanes.add(durableLaneKey);
        throw new Error("DURABLE_CAPTION_PERSIST_FAILED", { cause: error });
      }
      if (durableResult === false) throw new Error("SESSION_STOPPED");
    }
    if (event.type === "speaker-legend") {
      await this.#guardedRpc("persist_session_speakers_if_active", {
        p_session_id: sessionId,
        p_language: language,
        p_speakers: event.speakers,
      });
    }
    await Promise.all([
      this.eventFanout(sessionId, language, event),
      typeof onLiveEvent === "function" ? onLiveEvent(event) : undefined,
    ]);
    if (event.type === "caption"
      && event.isFinal
      && event.origin === "source"
      && typeof event.utteranceKey === "string"
      && event.utteranceKey) {
      this.enqueueTopicSourceFinal(sessionId, language, event);
    }
  }

  async publishSourceDraft(event, { mediaFence = null, pipelineGeneration = null } = {}) {
    if (!isPlainRecord(event) || !["source-draft", "source-draft-clear"].includes(event.type)
      || !isUuid(event.sessionId) || !isUuid(event.generation)
      || !Number.isSafeInteger(event.revision) || event.revision < 1) throw new Error("INVALID_SOURCE_DRAFT");
    const base = { type: event.type, sessionId: event.sessionId, generation: event.generation, revision: event.revision };
    if (event.type === "source-draft-clear") {
      if (this.sourceEventFanout) await this.sourceEventFanout(base, { mediaFence, pipelineGeneration });
      return;
    }
    const role = event.speaker?.role;
    if (!["host", "participant", "unknown"].includes(role)) throw new Error("INVALID_SOURCE_DRAFT");
    const sourceLanguage = requirePattern(event.sourceLanguage, /^[a-z]{2,3}(?:-[A-Za-z]{4})?$/u, 16);
    const languageObservation = normalizeLanguageObservation(event.languageObservation, sourceLanguage);
    if (languageObservation === null) throw new Error("INVALID_SOURCE_DRAFT");
    const draft = { ...base, text: requireBoundedText(event.text, 8000, 24000), sourceLanguage, languageObservation,
      speaker: { role, label: role === "host" ? "발표자" : role === "participant" ? "참여자" : "화자 미상" },
      emittedAt: requireIsoInstant(event.emittedAt) };
    if (this.sourceEventFanout) await this.sourceEventFanout(draft, { mediaFence, pipelineGeneration });
  }

  async persistAuthoritativeSource(input, { mediaFence = null, pipelineGeneration = null } = {}) {
    const normalized = normalizeAuthoritativeSourceInput(input);
    if (this.failedAuthoritativeSourceSessions.has(normalized.sessionId)) {
      throw new Error("AUTHORITATIVE_SOURCE_LANE_FAILED");
    }
    try {
      const rpcVersion = normalized.languageObservation === null ? "v1" : "v2";
      const value = await this.#requestSnapshotGuard(
        `/rest/v1/rpc/persist_authoritative_live_source_utterance_${rpcVersion}${mediaFence ? "_fenced_v1" : ""}`,
        {
          method: "POST",
          body: JSON.stringify({
            p_session_id: normalized.sessionId,
            ...(mediaFence ? { p_epoch: mediaFence.epoch, p_owner_id: mediaFence.ownerId } : {}),
            p_utterance_key: normalized.utteranceKey,
            p_raw_text: normalized.rawText,
            p_normalized_text: normalized.normalizedText,
            p_source_language: normalized.sourceLanguage,
            ...(normalized.languageObservation === null ? {} : { p_language_observation: normalized.languageObservation }),
            p_speaker_role: normalized.speakerRole,
            p_speaker_label: normalized.speakerLabel,
            p_speaker_name: normalized.speakerName,
            p_speaker_department: normalized.speakerDepartment,
            p_speaker_job_title: normalized.speakerJobTitle,
            p_participant_id: normalized.participantId,
            p_source_started_at: normalized.sourceStartedAt,
            p_source_ended_at: normalized.sourceEndedAt,
            p_provider_committed_at: normalized.providerCommittedAt,
            p_stt_provider: normalized.sttProvider,
            p_stt_model: normalized.sttModel,
            p_translation_model: normalized.translationModel,
            p_pipeline_config_fingerprint: normalized.pipelineConfigFingerprint,
          }),
        },
      );
      const identity = parseAuthoritativeSourceResponse(value);
      if (this.sourceEventFanout) await this.sourceEventFanout({
        type: "source", sessionId: normalized.sessionId, sourceUtteranceId: identity.sourceUtteranceId,
        sourceSeq: identity.sourceSeq, utteranceKey: normalized.utteranceKey, text: normalized.normalizedText,
        sourceLanguage: normalized.sourceLanguage, languageObservation: normalized.languageObservation,
        speaker: { role: normalized.speakerRole, label: normalized.speakerRole === "host" ? "발표자"
          : normalized.speakerRole === "participant" ? "참여자" : "화자 미상" },
        isFinal: true, sourceStartedAt: normalized.sourceStartedAt, sourceEndedAt: normalized.sourceEndedAt,
        emittedAt: normalized.providerCommittedAt,
      }, { mediaFence, pipelineGeneration });
      return identity;
    } catch (error) {
      // The HTTP outcome may be ambiguous. Never retry in this process: a new
      // gateway process can safely replay the deterministic utterance key and
      // let the row-locked RPC return the same source identity.
      this.failedAuthoritativeSourceSessions.add(normalized.sessionId);
      throw new Error("AUTHORITATIVE_SOURCE_PERSIST_FAILED", { cause: error });
    }
  }

  /** Unlatch a session's authoritative-source lane when its pipeline is
   *  replaced. Safe because the persist RPC is row-locked and idempotent per
   *  deterministic utterance key: an ambiguous commit either landed (a replay
   *  of the same key returns the same identity) or didn't, and a replacement
   *  pipeline derives fresh keys, so no durable identity can fork. Without
   *  this the latch outlives the failed pipeline (the publisher is process-
   *  global) and every replacement dies on its first final forever. */
  resetAuthoritativeSourceLane(sessionId) {
    this.failedAuthoritativeSourceSessions.delete(sessionId);
  }

  startTopicSession(sessionId, languages) {
    return this.topicCoordinator?.start(sessionId, languages);
  }

  suspendTopicSession(sessionId) {
    return this.topicCoordinator?.suspend(sessionId);
  }

  enqueueTopicSourceFinal(sessionId, language, caption) {
    this.topicCoordinator?.enqueueSourceFinal(sessionId, language, caption);
  }

  noteTopicPartial(sessionId) {
    this.topicCoordinator?.notePartial(sessionId);
  }

  pauseTopicSession(sessionId) {
    this.topicCoordinator?.pause(sessionId);
  }

  resumeTopicSession(sessionId) {
    this.topicCoordinator?.resume(sessionId);
  }

  endTopicSession(sessionId) {
    return this.topicCoordinator?.end(sessionId);
  }

  drainTopicSession(sessionId) {
    return this.topicCoordinator?.drain(sessionId);
  }

  async readTopicContext(sessionId, language) {
    const value = await this.#topicRpc("read_live_topic_context", {
      p_session_id: sessionId,
      p_language: language,
    });
    return parseTopicContextResponse(value, sessionId);
  }

  async applyTopicTransition(input) {
    const value = await this.#topicRpc("apply_live_topic_transition", {
      p_session_id: input.sessionId,
      p_language: input.language,
      p_utterance_key: input.utteranceKey,
      p_source_seq: input.sourceSeq,
      p_meaningful: input.meaningful,
      p_decision: input.decision,
      p_expected_topic_id: input.expectedTopicId,
      p_expected_version: input.expectedVersion,
      p_title: input.title,
      p_summary: input.summary,
      p_detector_health: input.detectorHealth,
    });
    return parseTopicMutationResponse(value, input.sessionId);
  }

  async completeIdleTopic(input) {
    const value = await this.#topicRpc("complete_idle_live_topic", {
      p_session_id: input.sessionId,
      p_language: input.language,
      p_topic_id: input.topicId,
      p_expected_version: input.expectedVersion,
    });
    return parseTopicMutationResponse(value, input.sessionId);
  }

  async completeTopicsOnSessionEnd(sessionId) {
    const value = await this.#topicRpc("complete_live_topics_on_session_end", { p_session_id: sessionId });
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("INVALID_TOPIC_RPC_RESPONSE");
    return value;
  }

  async recoverTopicAssignments(sessionId, language, afterSourceSeq = 0) {
    const value = await this.#topicRpc("recover_live_topic_assignments", {
      p_session_id: sessionId,
      p_language: language,
      p_after_source_seq: afterSourceSeq,
    });
    return parseTopicRecoveryResponse(value);
  }

  async fetchRecentTopicFinals(sessionId, utteranceKeys) {
    if (!Array.isArray(utteranceKeys) || utteranceKeys.length > MAX_RECENT_TOPIC_FINALS) {
      throw new Error("INVALID_TOPIC_CONTEXT_KEYS");
    }
    if (utteranceKeys.length === 0) return [];
    const uniqueKeys = [...new Set(utteranceKeys)];
    if (uniqueKeys.length !== utteranceKeys.length) throw new Error("INVALID_TOPIC_CONTEXT_KEYS");
    for (const utteranceKey of uniqueKeys) {
      if (typeof utteranceKey !== "string"
        || utteranceKey.length < 1
        || utteranceKey.length > 256
        || /[\p{Cc}\p{Cf}<>]/u.test(utteranceKey)) {
        throw new Error("INVALID_TOPIC_CONTEXT_KEYS");
      }
    }
    const query = new URLSearchParams({
      session_id: `eq.${sessionId}`,
      origin: "eq.source",
      utterance_key: `in.(${uniqueKeys.map((value) => JSON.stringify(value)).join(",")})`,
      select: "text,utterance_key,emitted_at",
      limit: String(uniqueKeys.length),
    });
    const value = await this.#request(`/rest/v1/live_utterances?${query}`, { method: "GET" });
    if (!Array.isArray(value) || value.length !== uniqueKeys.length) throw new Error("INVALID_TOPIC_CONTEXT_RESPONSE");
    const expectedKeys = new Set(uniqueKeys);
    const rows = value.map((row) => {
      const utteranceKey = isPlainRecord(row) && typeof row.utterance_key === "string" ? row.utterance_key : "";
      if (!expectedKeys.delete(utteranceKey)) throw new Error("INVALID_TOPIC_CONTEXT_RESPONSE");
      return parseTopicContextSourceFinal(row, utteranceKey);
    });
    if (expectedKeys.size > 0) throw new Error("INVALID_TOPIC_CONTEXT_RESPONSE");
    return rows
      .sort((left, right) => Date.parse(left.emittedAt) - Date.parse(right.emittedAt))
      .map(({ text }) => ({ text }));
  }

  #topicRpc(name, body) {
    return this.#request(`/rest/v1/rpc/${name}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async #requestSnapshotGuard(path, init) {
    const abortController = new AbortController();
    const timer = setTimeout(() => {
      abortController.abort(new Error("SNAPSHOT_GUARD_TIMEOUT"));
    }, this.snapshotGuardTimeoutMilliseconds);
    try {
      return await waitForAbort(
        this.#request(path, { ...init, signal: abortController.signal }),
        abortController.signal,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #guardedRpc(name, payload) {
    const result = await this.#request(`/rest/v1/rpc/${name}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    if (result !== true) throw new Error("SESSION_STOPPED");
  }

  /** Max persisted caption seq per language, used to seed pipeline counters
   *  so seq survives host reconnects and process restarts (contract C1). */
  async fetchLastUtteranceSeqs(sessionId, languages) {
    const entries = await Promise.all(languages.map(async (language) => {
      const query = new URLSearchParams({
        session_id: `eq.${sessionId}`,
        language: `eq.${language}`,
        select: "seq",
        order: "seq.desc",
        limit: "1",
      });
      const rows = await this.#request(`/rest/v1/live_utterances?${query}`, { method: "GET" });
      if (!Array.isArray(rows) || rows.length > 1) throw new Error("DURABLE_CAPTION_SEED_INVALID");
      if (rows.length === 0) return [language, 0];
      const seq = rows[0]?.seq;
      if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("DURABLE_CAPTION_SEED_INVALID");
      return [language, seq];
    }));
    return Object.fromEntries(entries);
  }

  /** Resolve an ambiguous final only after PostgreSQL has serialized this RPC
   *  behind the original persistence transaction's live-session row lock.
   *  The failed final is deliberately not retried: callers rebuild the lane
   *  from this definitive durable sequence instead. */
  async reconcileCaptionLane(sessionId, language, { signal } = {}) {
    const durableLaneKey = `${sessionId}\u0000${language}`;
    const abortController = new AbortController();
    const abortFromCaller = () => {
      abortController.abort(abortReason(signal, "DURABLE_CAPTION_RECONCILIATION_ABORTED"));
    };
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      abortController.abort(new Error("DURABLE_CAPTION_RECONCILIATION_TIMEOUT"));
    }, this.reconciliationTimeoutMilliseconds);
    let result;
    try {
      if (abortController.signal.aborted) throw abortReason(
        abortController.signal,
        "DURABLE_CAPTION_RECONCILIATION_ABORTED",
      );
      result = await waitForAbort(
        this.#request("/rest/v1/rpc/reconcile_live_caption_lane", {
          method: "POST",
          signal: abortController.signal,
          body: JSON.stringify({
            p_session_id: sessionId,
            p_language: language,
          }),
        }),
        abortController.signal,
      );
    } catch (error) {
      throw new Error("DURABLE_CAPTION_RECONCILIATION_FAILED", { cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
    const maxSequence = result && typeof result === "object" && !Array.isArray(result)
      ? result.max_seq
      : undefined;
    if (!Number.isSafeInteger(maxSequence) || maxSequence < 0) {
      throw new Error("DURABLE_CAPTION_RECONCILIATION_FAILED");
    }
    // A malformed or failed response leaves the latch intact. Only the row-
    // locked database result above proves that no late commit can still race.
    this.failedDurableCaptionLanes.delete(durableLaneKey);
    return maxSequence;
  }

  async replayAuthoritativeSourceCaptions(sessionId, sourceUtteranceId, languages, { signal } = {}) {
    requireUuid(sessionId); requireUuid(sourceUtteranceId);
    if (!Array.isArray(languages) || languages.length > 16 || new Set(languages).size !== languages.length
      || languages.some((language) => typeof language !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z]{4})?$/u.test(language))) {
      throw new Error("INVALID_SOURCE_REPLAY_INPUT");
    }
    const result = await Promise.all(languages.map(async (language) => {
      const events = await this.fetchUtterancesAfter(sessionId, language, 0, 200, { signal, sourceUtteranceId });
      if (events.length === 200) throw new Error("SOURCE_REPLAY_TOO_LARGE");
      for (const event of events) {
        if (signal?.aborted) throw signal.reason ?? new Error("SOURCE_REPLAY_ABORTED");
        await this.eventFanout(sessionId, language, { ...event, replay: true });
      }
      return { language, restored: events.length > 0 };
    }));
    return { restoredLanguages: result.filter((entry) => entry.restored).map((entry) => entry.language),
      missingLanguages: result.filter((entry) => !entry.restored).map((entry) => entry.language) };
  }

  async readCaptionSourceObservations(sessionId, rows, { signal } = {}) {
    const ids = [...new Set(rows.map((row) => row.authoritative_source_id).filter((id) => id !== null && id !== undefined))];
    if (ids.length === 0) return new Map();
    if (ids.length > 500 || ids.some((id) => !isUuid(id))) throw new Error("INVALID_SOURCE_OBSERVATION_RESPONSE");
    const values = await this.#request("/rest/v1/rpc/read_live_caption_source_observations_v1", {
      method: "POST", signal, body: JSON.stringify({ p_session_id: sessionId, p_source_ids: ids }),
    });
    if (!Array.isArray(values) || values.length !== ids.length) throw new Error("INVALID_SOURCE_OBSERVATION_RESPONSE");
    const observations = new Map();
    for (const value of values) {
      if (!isPlainRecord(value) || !ids.includes(value.source_utterance_id) || observations.has(value.source_utterance_id)
        || !Number.isSafeInteger(value.source_seq) || value.source_seq < 1) throw new Error("INVALID_SOURCE_OBSERVATION_RESPONSE");
      const observation = normalizeLanguageObservation(value.language_observation, value.language_observation?.languageCode);
      observations.set(value.source_utterance_id, observation);
    }
    return observations;
  }

  /** Persisted utterances with seq > afterSeq for viewer replay (contract C2). */
  async fetchUtterancesAfter(sessionId, language, afterSeq, limit = 200, { signal, sourceUtteranceId } = {}) {
    const query = new URLSearchParams({
      session_id: `eq.${sessionId}`,
      language: `eq.${language}`,
      seq: `gt.${afterSeq}`,
      select: "seq,participant_id,speaker_label,speaker_name,text,source_text,source_language,origin,utterance_key,translation_status,source_ended_at,emitted_at,authoritative_source_id",
      order: "seq.asc",
      limit: String(limit),
    });
    if (sourceUtteranceId) query.set("authoritative_source_id", `eq.${requireUuid(sourceUtteranceId)}`);
    const rows = await this.#request(`/rest/v1/live_utterances?${query}`, { method: "GET", signal });
    if (!Array.isArray(rows)) throw new Error("INVALID_SOURCE_REPLAY_RESPONSE");
    const observations = await this.readCaptionSourceObservations(sessionId, rows, { signal });
    return rows.map((row) => ({
      type: "caption",
      seq: Number(row.seq),
      sessionId,
      language,
      // Must be a COMPLETE SpeakerAssignment: the viewer contract validates
      // every field and silently drops replayed captions whose speaker shape
      // is partial — which would make missed history unrecoverable after a
      // reconnect.
      speaker: row.participant_id || row.speaker_label || row.speaker_name
        ? {
          speakerId: String(row.participant_id ? `participant:${row.participant_id}` : row.speaker_label ?? row.speaker_name),
          label: row.speaker_name ?? row.speaker_label ?? "",
          name: row.speaker_name ?? "",
          colorToken: "speaker-teal",
          voiceName: null,
          voiceStatus: "disabled",
          lastSeenAt: row.emitted_at,
        }
        : null,
      text: row.text,
      isFinal: true,
      // Replayed history must support the same 원문보기 disclosure as live
      // captions, otherwise reconnecting silently loses the originals. A row
      // predating the provenance columns replays with null and the viewer
      // simply offers no disclosure for it.
      sourceText: row.source_text ?? null,
      sourceLanguage: row.source_language ?? null,
      translationStatus: replayTranslationStatus(row),
      ...(observations.get(row.authoritative_source_id) ? { languageObservation: observations.get(row.authoritative_source_id) } : {}),
      ...(row.origin === "source" ? { origin: "source" } : {}),
      ...(typeof row.utterance_key === "string" && row.utterance_key.length > 0
        ? { utteranceKey: row.utterance_key }
        : {}),
      sourceEndedAt: row.source_ended_at,
      emittedAt: row.emitted_at,
    }));
  }

  async markLive(sessionId) {
    await this.#request(`/rest/v1/live_sessions?id=eq.${encodeURIComponent(sessionId)}&status=eq.preparing`, {
      method: "PATCH",
      body: JSON.stringify({ status: "live", updated_at: new Date().toISOString() }),
    });
  }

  async #request(path, init) {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers: createSupabaseHeaders(this.supabaseCredential, {
        "Content-Type": "application/json",
        ...init.headers,
      }),
    });
    if (!response.ok) throw new Error("SUPABASE_PUBLISH_FAILED");
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : undefined;
  }
}

function parseTopicContextResponse(value, expectedSessionId) {
  if (isTopicErrorResponse(value)) return value;
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["event", "latest_source_seq", "memberships_added", "ok", "topic_memberships", "topics"])
    || value.ok !== true
    || value.event !== "topic-upsert"
    || !Number.isSafeInteger(value.latest_source_seq)
    || value.latest_source_seq < 0
    || !Array.isArray(value.topics)
    || value.topics.length > 1_000
    || !Array.isArray(value.topic_memberships)
    || value.topic_memberships.length > 12_000
    || !Array.isArray(value.memberships_added)
    || value.memberships_added.length > 50) {
    throw new Error("INVALID_TOPIC_RPC_RESPONSE");
  }
  const topics = value.topics.map((topicValue) => parsePublicTopic(topicValue, expectedSessionId));
  const topicIds = new Set(topics.map(({ id }) => id));
  return {
    ok: true,
    event: "topic-upsert",
    topics,
    topicMemberships: value.topic_memberships.map(
      (membershipValue) => parsePublicTopicMembership(membershipValue, expectedSessionId, topicIds),
    ),
    membershipsAdded: value.memberships_added.map(
      (membershipValue) => parsePublicTopicMembership(membershipValue, expectedSessionId, topicIds),
    ),
    latestSourceSeq: value.latest_source_seq,
  };
}

function parseTopicMutationResponse(value, expectedSessionId) {
  if (isTopicErrorResponse(value)) return value;
  if (!isPlainRecord(value)
    || !Object.keys(value).every((key) => ["event", "memberships_added", "ok", "status", "topics"].includes(key))
    || !hasRequiredKeys(value, ["event", "memberships_added", "ok", "topics"])
    || value.ok !== true
    || value.event !== "topic-upsert"
    || (value.status !== undefined && !["applied", "idempotent", "ignored", "processed"].includes(value.status))
    || !Array.isArray(value.memberships_added)
    || value.memberships_added.length > 50
    || !Array.isArray(value.topics)
    || value.topics.length > 2) {
    throw new Error("INVALID_TOPIC_RPC_RESPONSE");
  }
  const topics = value.topics.map((topicValue) => parsePublicTopic(topicValue, expectedSessionId));
  const topicIds = new Set(topics.map(({ id }) => id));
  return {
    ok: true,
    ...(value.status ? { status: value.status } : {}),
    event: "topic-upsert",
    topics,
    membershipsAdded: value.memberships_added.map(
      (membershipValue) => parsePublicTopicMembership(membershipValue, expectedSessionId, topicIds),
    ),
  };
}

function parseTopicRecoveryResponse(value) {
  if (isTopicErrorResponse(value)) return value;
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["next_source_seq", "ok", "unassigned_finals"])
    || value.ok !== true
    || !Number.isSafeInteger(value.next_source_seq)
    || value.next_source_seq < 0
    || !Array.isArray(value.unassigned_finals)
    || value.unassigned_finals.length > 100) {
    throw new Error("INVALID_TOPIC_RPC_RESPONSE");
  }
  return {
    ok: true,
    unassignedFinals: value.unassigned_finals.map(parseRecoveredSourceFinal),
    nextSourceSeq: value.next_source_seq,
  };
}

function parseRecoveredSourceFinal(value) {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["emitted_at", "source_language", "source_seq", "text", "utterance_key"])
    || typeof value.utterance_key !== "string"
    || value.utterance_key.length < 1
    || value.utterance_key.length > 256
    || /[\p{Cc}\p{Cf}<>]/u.test(value.utterance_key)
    || typeof value.source_language !== "string"
    || !/^[a-z]{2,3}(?:-[A-Za-z]{4})?$/u.test(value.source_language)
    || !Number.isSafeInteger(value.source_seq)
    || value.source_seq < 1
    || !isSafePlainText(value.text, 1, 2_000)
    || !isIsoInstant(value.emitted_at)) {
    throw new Error("INVALID_TOPIC_RPC_RESPONSE");
  }
  return {
    utteranceKey: value.utterance_key,
    sourceLanguage: value.source_language,
    sourceSeq: value.source_seq,
    text: value.text,
    emittedAt: value.emitted_at,
  };
}

function parseTopicContextSourceFinal(value, expectedUtteranceKey) {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["emitted_at", "text", "utterance_key"])
    || value.utterance_key !== expectedUtteranceKey
    || !isIsoInstant(value.emitted_at)
    || !isSafePlainText(value.text, 1, 2_000)) {
    throw new Error("INVALID_TOPIC_CONTEXT_RESPONSE");
  }
  return { emittedAt: value.emitted_at, text: value.text };
}

function parsePublicTopic(value, expectedSessionId) {
  const expectedKeys = [
    "completed_at", "completion_reason", "detector_health", "id", "ordinal", "session_id",
    "started_at", "status", "summary", "title", "version",
  ];
  if (!isPlainRecord(value)
    || !hasExactKeys(value, expectedKeys)
    || !isUuid(value.id)
    || !isUuid(value.session_id)
    || value.session_id !== expectedSessionId
    || !Number.isSafeInteger(value.ordinal)
    || value.ordinal < 1
    || !isSafePlainText(value.title, 1, 120)
    || (value.summary !== null && !isSafePlainText(value.summary, 1, 500))
    || !["active", "completed"].includes(value.status)
    || !["healthy", "degraded"].includes(value.detector_health)
    || !isIsoInstant(value.started_at)
    || !Number.isSafeInteger(value.version)
    || value.version < 1) {
    throw new Error("INVALID_TOPIC_RPC_RESPONSE");
  }
  const isActive = value.status === "active";
  if ((isActive && (value.completion_reason !== null || value.completed_at !== null))
    || (!isActive
      && (!["silence", "semantic_shift", "session_end"].includes(value.completion_reason)
        || !isIsoInstant(value.completed_at)))) {
    throw new Error("INVALID_TOPIC_RPC_RESPONSE");
  }
  return {
    id: value.id,
    sessionId: value.session_id,
    ordinal: value.ordinal,
    title: value.title,
    summary: value.summary,
    status: value.status,
    completionReason: value.completion_reason,
    detectorHealth: value.detector_health,
    startedAt: value.started_at,
    completedAt: value.completed_at,
    version: value.version,
  };
}

function parsePublicTopicMembership(value, expectedSessionId, topicIds) {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["position", "session_id", "topic_id", "utterance_key"])
    || !isUuid(value.session_id)
    || value.session_id !== expectedSessionId
    || !isUuid(value.topic_id)
    || !topicIds.has(value.topic_id)
    || typeof value.utterance_key !== "string"
    || value.utterance_key.length < 1
    || value.utterance_key.length > 256
    || /[\p{Cc}\p{Cf}<>]/u.test(value.utterance_key)
    || !Number.isSafeInteger(value.position)
    || value.position < 1) {
    throw new Error("INVALID_TOPIC_RPC_RESPONSE");
  }
  return {
    sessionId: value.session_id,
    topicId: value.topic_id,
    utteranceKey: value.utterance_key,
    position: value.position,
  };
}

function isTopicErrorResponse(value) {
  return isPlainRecord(value)
    && hasExactKeys(value, ["code", "ok"])
    && value.ok === false
    && typeof value.code === "string"
    && /^[A-Z][A-Z0-9_]{2,80}$/u.test(value.code);
}

function isSafePlainText(value, minimum, maximum) {
  return typeof value === "string"
    && value === value.normalize("NFC").trim()
    && Array.from(value).length >= minimum
    && Array.from(value).length <= maximum
    && !/[\p{Cc}\p{Cf}<>]/u.test(value);
}

function isIsoInstant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  return Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function hasRequiredKeys(value, keys) {
  return keys.every((key) => Object.hasOwn(value, key));
}

function replayTranslationStatus(row) {
  if (["verbatim", "translated", "failed"].includes(row.translation_status)) {
    return row.translation_status;
  }
  return row.source_text ? "translated" : "verbatim";
}

function normalizeAuthoritativeSourceInput(input) {
  if (!isPlainRecord(input) || !isUuid(input.sessionId)) {
    throw new Error("INVALID_AUTHORITATIVE_SOURCE_INPUT");
  }
  const utteranceKey = requireBoundedText(
    input.utteranceKey,
    MAX_AUTHORITATIVE_UTTERANCE_KEY_CHARACTERS,
    MAX_AUTHORITATIVE_UTTERANCE_KEY_BYTES,
    { canonical: true, forbidMarkup: true },
  );
  const rawText = requireBoundedText(
    input.rawText,
    MAX_AUTHORITATIVE_SOURCE_CHARACTERS,
    MAX_AUTHORITATIVE_SOURCE_BYTES,
  );
  const normalizedText = requireBoundedText(
    input.normalizedText,
    MAX_AUTHORITATIVE_SOURCE_CHARACTERS,
    MAX_AUTHORITATIVE_SOURCE_BYTES,
    { canonical: true },
  );
  const sourceLanguage = requirePattern(input.sourceLanguage, /^[a-z]{2,3}(?:-[A-Za-z]{4})?$/u, 16);
  if (!["host", "participant", "unknown"].includes(input.speakerRole)) {
    throw new Error("INVALID_AUTHORITATIVE_SOURCE_INPUT");
  }
  const sourceStartedAt = optionalIsoInstant(input.sourceStartedAt);
  const sourceEndedAt = requireIsoInstant(input.sourceEndedAt);
  const providerCommittedAt = requireIsoInstant(input.providerCommittedAt);
  const startedMilliseconds = sourceStartedAt === null ? null : Date.parse(sourceStartedAt);
  const endedMilliseconds = Date.parse(sourceEndedAt);
  const committedMilliseconds = Date.parse(providerCommittedAt);
  if ((startedMilliseconds !== null
      && (startedMilliseconds > endedMilliseconds || endedMilliseconds - startedMilliseconds > 60 * 60_000))
    || endedMilliseconds > committedMilliseconds) {
    throw new Error("INVALID_AUTHORITATIVE_SOURCE_INPUT");
  }
  return {
    sessionId: input.sessionId,
    utteranceKey,
    rawText,
    normalizedText,
    sourceLanguage,
    languageObservation: normalizeLanguageObservation(input.languageObservation, sourceLanguage),
    speakerRole: input.speakerRole,
    speakerLabel: optionalSnapshot(input.speakerLabel, 80),
    speakerName: optionalSnapshot(input.speakerName, 40),
    speakerDepartment: optionalSnapshot(input.speakerDepartment, 80),
    speakerJobTitle: optionalSnapshot(input.speakerJobTitle, 100),
    participantId: input.participantId === null ? null : requireUuid(input.participantId),
    sourceStartedAt,
    sourceEndedAt,
    providerCommittedAt,
    sttProvider: requirePattern(input.sttProvider, /^[a-z0-9][a-z0-9._-]{0,63}$/u, 64),
    sttModel: optionalModel(input.sttModel),
    translationModel: optionalModel(input.translationModel),
    pipelineConfigFingerprint: input.pipelineConfigFingerprint === null
      ? null
      : requirePattern(input.pipelineConfigFingerprint, /^sha256:[a-f0-9]{64}$/u, 71),
  };
}

function normalizeLanguageObservation(value, sourceLanguage) {
  if (value === undefined || value === null) return null;
  if (!isPlainRecord(value) || !hasExactKeys(value, ["state", "languageCode", "providerLanguageCode", "evidence", "languages"])
    || !["single", "mixed", "unknown"].includes(value.state)
    || value.languageCode !== sourceLanguage
    || !["provider-and-script", "script", "provider", "conflict", "neutral", "insufficient"].includes(value.evidence)
    || !Array.isArray(value.languages) || value.languages.length > 16
    || value.languages.some((code) => typeof code !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z]{4})?$/u.test(code))
    || new Set(value.languages).size !== value.languages.length
    || (value.providerLanguageCode !== null && (typeof value.providerLanguageCode !== "string"
      || value.providerLanguageCode.length > 35 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(value.providerLanguageCode)))
    || (value.state === "single" ? sourceLanguage === "und" || value.languages.length !== 1 || value.languages[0] !== sourceLanguage
      : sourceLanguage !== "und")) throw new Error("INVALID_AUTHORITATIVE_SOURCE_INPUT");
  return { ...value, languages: [...value.languages] };
}

function parseAuthoritativeSourceResponse(value) {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["idempotent", "ok", "sourceSeq", "sourceUtteranceId"])
    || value.ok !== true
    || !isUuid(value.sourceUtteranceId)
    || !Number.isSafeInteger(value.sourceSeq)
    || value.sourceSeq < 1
    || typeof value.idempotent !== "boolean") {
    throw new Error("INVALID_AUTHORITATIVE_SOURCE_RESPONSE");
  }
  return {
    sourceUtteranceId: value.sourceUtteranceId,
    sourceSeq: value.sourceSeq,
    idempotent: value.idempotent,
  };
}

function requireBoundedText(value, maximumCharacters, maximumBytes, { canonical = false, forbidMarkup = false } = {}) {
  if (typeof value !== "string"
    || value.trim().length === 0
    || Array.from(value).length > maximumCharacters
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || (canonical && value !== value.normalize("NFC").trim())
    || (forbidMarkup && /[\p{Cc}\p{Cf}<>]/u.test(value))) {
    throw new Error("INVALID_AUTHORITATIVE_SOURCE_INPUT");
  }
  return value;
}

function optionalSnapshot(value, maximumCharacters) {
  if (value === null || value === undefined || value === "") return null;
  return requireBoundedText(value, maximumCharacters, maximumCharacters * 4, {
    canonical: true,
    forbidMarkup: true,
  });
}

function optionalModel(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string"
    || value !== value.trim()
    || value.length > 120
    || /[\p{Cc}\p{Cf}<>]/u.test(value)) {
    throw new Error("INVALID_AUTHORITATIVE_SOURCE_INPUT");
  }
  return value;
}

function requirePattern(value, pattern, maximumCharacters) {
  if (typeof value !== "string" || value.length > maximumCharacters || !pattern.test(value)) {
    throw new Error("INVALID_AUTHORITATIVE_SOURCE_INPUT");
  }
  return value;
}

function requireUuid(value) {
  if (!isUuid(value)) throw new Error("INVALID_AUTHORITATIVE_SOURCE_INPUT");
  return value;
}

function requireIsoInstant(value) {
  if (!isIsoInstant(value)) throw new Error("INVALID_AUTHORITATIVE_SOURCE_INPUT");
  return value;
}

function optionalIsoInstant(value) {
  return value === null || value === undefined ? null : requireIsoInstant(value);
}

function waitForAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal, "SNAPSHOT_GUARD_TIMEOUT"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal, "SNAPSHOT_GUARD_TIMEOUT"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal, fallbackCode) {
  return signal.reason instanceof Error ? signal.reason : new Error(fallbackCode);
}

function participantIdFromSpeaker(speaker) {
  const speakerId = speaker?.speakerId;
  if (typeof speakerId !== "string" || !speakerId.startsWith("participant:")) return null;
  return speakerId.slice("participant:".length) || null;
}

export class SupabasePinnedGlossaryLoader {
  constructor({ baseUrl, supabaseApiKey, supabaseKeyType, serviceRoleKey, fetchFn = fetch }) {
    this.baseUrl = baseUrl;
    this.supabaseCredential = resolveSupabaseCredential({ supabaseApiKey, supabaseKeyType, serviceRoleKey });
    this.fetchFn = fetchFn;
  }

  async load(sessionId, { signal } = {}) {
    const requestedSessionId = String(sessionId ?? "").trim();
    if (!requestedSessionId || requestedSessionId.length > 128 || /[\p{Cc}\p{Cf}<>]/u.test(requestedSessionId)) {
      throw new Error("INVALID_PINNED_GLOSSARY_REQUEST");
    }
    const pluralResponse = await this.fetchFn(`${this.baseUrl}/rest/v1/rpc/read_live_session_pinned_glossaries_v2`, {
      method: "POST",
      cache: "no-store",
      signal,
      headers: createSupabaseHeaders(this.supabaseCredential, { "Content-Type": "application/json" }),
      body: JSON.stringify({ p_live_session_id: requestedSessionId }),
    });
    if (pluralResponse.ok) return this.#parsePluralResponse(await pluralResponse.json().catch(() => null), requestedSessionId);
    throw new Error("PINNED_GLOSSARY_READ_FAILED");
  }

  #parsePluralResponse(rows, requestedSessionId) {
    if (!Array.isArray(rows)) throw new Error("INVALID_PINNED_GLOSSARY_RESPONSE");
    if (rows.length === 0) return null;
    if (rows.length > 5) throw new Error("INVALID_PINNED_GLOSSARY_RESPONSE");
    const documents = [];
    const compiledDocuments = [];
    const sourceKinds = [];
    const selectedSources = new Set();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!isPlainRecord(row)
        || !hasExactKeys(row, ["session_id", "ordinal", "source_kind", "source_id", "document_version", "fingerprint", "glossary_document"])
        || row.session_id !== requestedSessionId
        || row.ordinal !== index + 1
        || !["builtin", "host"].includes(row.source_kind)
        || typeof row.source_id !== "string"
        || !row.source_id
        || !Number.isSafeInteger(row.document_version)
        || row.document_version < 1) {
        throw new Error("INVALID_PINNED_GLOSSARY_RESPONSE");
      }
      const sourceKey = `${row.source_kind}:${row.source_id}`;
      if (selectedSources.has(sourceKey)) throw new Error("INVALID_PINNED_GLOSSARY_RESPONSE");
      selectedSources.add(sourceKey);

      if (row.source_kind === "builtin") {
        if (row.document_version !== 1 || row.fingerprint !== null || row.glossary_document !== null) {
          throw new Error("INVALID_PINNED_GLOSSARY_RESPONSE");
        }
        try {
          const document = resolveBuiltInGlossaryDocument(row.source_id, row.document_version);
          documents.push(document);
          compiledDocuments.push(compileGlossaryDocumentV1(document));
          sourceKinds.push("builtin");
        } catch {
          throw new Error("INVALID_PINNED_GLOSSARY_RESPONSE");
        }
        continue;
      }

      if (!isUuid(row.source_id)
        || typeof row.fingerprint !== "string"
        || !isPlainRecord(row.glossary_document)) {
        throw new Error("INVALID_PINNED_GLOSSARY_RESPONSE");
      }
      let compiled;
      try {
        compiled = compileGlossaryDocumentV1(row.glossary_document);
      } catch {
        throw new Error("INVALID_PINNED_GLOSSARY_RESPONSE");
      }
      if (compiled.version !== row.document_version || compiled.fingerprint !== row.fingerprint) {
        throw new Error("INVALID_PINNED_GLOSSARY_RESPONSE");
      }
      documents.push(row.glossary_document);
      compiledDocuments.push(compiled);
      sourceKinds.push("host");
    }
    if (compiledDocuments.length === 1) return compiledDocuments[0];
    try {
      const mergeDocuments = documents.map((document, index) => sourceKinds[index] === "host"
        ? promoteHostGlossaryForMerge(document)
        : document);
      return mergeCompiledGlossariesV1(mergeDocuments);
    } catch {
      throw new Error("INVALID_PINNED_GLOSSARY_RESPONSE");
    }
  }
}

function promoteHostGlossaryForMerge(document) {
  return {
    ...document,
    terms: document.terms.map((term) => ({
      ...term,
      priority: HOST_GLOSSARY_MERGE_PRIORITY,
    })),
  };
}

export class SupabaseViewerAuthorizer {
  constructor({ baseUrl, supabaseApiKey, supabaseKeyType, serviceRoleKey, fetchFn = fetch }) {
    this.baseUrl = baseUrl;
    this.supabaseCredential = resolveSupabaseCredential({ supabaseApiKey, supabaseKeyType, serviceRoleKey });
    this.fetchFn = fetchFn;
  }

  async authorize(claims, sessionId, language, { signal } = {}) {
    if (claims.sessionId !== sessionId) return false;
    const key = `${sessionId}\u0000${claims.grantId}\u0000${claims.userId}\u0000${language}`;
    try {
      const results = await this.authorizeBatch([{
        key,
        sessionId,
        grantId: claims.grantId,
        userId: claims.userId,
        language,
      }], { signal });
      return results.get(key) === true;
    } catch {
      return false;
    }
  }

  async authorizeBatch(requests, { signal } = {}) {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 50) {
      throw new Error("INVALID_VIEWER_AUTHORIZATION_BATCH_REQUEST");
    }
    const keys = new Set();
    for (const request of requests) {
      if (!isPlainRecord(request)
        || !hasExactKeys(request, ["key", "sessionId", "grantId", "userId", "language"])
        || [request.key, request.sessionId, request.grantId, request.userId, request.language]
          .some((value) => typeof value !== "string" || !value)
        || keys.has(request.key)) {
        throw new Error("INVALID_VIEWER_AUTHORIZATION_BATCH_REQUEST");
      }
      keys.add(request.key);
    }
    const response = await this.fetchFn(`${this.baseUrl}/rest/v1/rpc/authorize_live_viewer_grants_v1`, {
      method: "POST",
      cache: "no-store",
      signal,
      headers: createSupabaseHeaders(this.supabaseCredential, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        p_requests: requests.map((request) => ({
          session_id: request.sessionId,
          grant_id: request.grantId,
          user_id: request.userId,
          language: request.language,
        })),
      }),
    });
    if (!response.ok) throw new Error("VIEWER_AUTHORIZATION_BATCH_FAILED");
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows) || rows.length !== requests.length) {
      throw new Error("INVALID_VIEWER_AUTHORIZATION_BATCH_RESPONSE");
    }
    const results = new Map();
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index];
      const row = rows[index];
      if (!isPlainRecord(row)
        || !hasExactKeys(row, ["session_id", "grant_id", "user_id", "language", "authorized"])
        || row.session_id !== request.sessionId
        || row.grant_id !== request.grantId
        || row.user_id !== request.userId
        || row.language !== request.language
        || typeof row.authorized !== "boolean") {
        throw new Error("INVALID_VIEWER_AUTHORIZATION_BATCH_RESPONSE");
      }
      results.set(request.key, row.authorized);
    }
    return results;
  }

  async authorizeSpeaking(claims, sessionId, { signal } = {}) {
    if (claims?.role !== "VIEWER"
      || claims.sessionId !== sessionId
      || !isUuid(sessionId)
      || !isUuid(claims.grantId)
      || typeof claims.userId !== "string"
      || claims.userId.length < 1
      || claims.userId.length > 200
      || /[\p{Cc}\p{Cf}<>]/u.test(claims.userId)) {
      return false;
    }
    const response = await this.fetchFn(
      `${this.baseUrl}/rest/v1/rpc/authorize_live_participant_speaking_v1`,
      {
        method: "POST",
        cache: "no-store",
        signal,
        headers: createSupabaseHeaders(this.supabaseCredential, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          p_session_id: sessionId,
          p_grant_id: claims.grantId,
          p_user_id: claims.userId,
        }),
      },
    );
    if (!response.ok) throw new Error("PARTICIPANT_SPEAKING_AUTHORIZATION_FAILED");
    const value = await response.json().catch(() => null);
    if (typeof value !== "boolean") throw new Error("INVALID_PARTICIPANT_SPEAKING_AUTHORIZATION_RESPONSE");
    return value;
  }
}

export class SupabaseHostAuthorizer {
  constructor({ baseUrl, supabaseApiKey, supabaseKeyType, serviceRoleKey, fetchFn = fetch }) {
    this.baseUrl = baseUrl;
    this.supabaseCredential = resolveSupabaseCredential({ supabaseApiKey, supabaseKeyType, serviceRoleKey });
    this.fetchFn = fetchFn;
  }

  async authorize(claims, settings, { signal, requireLive = false, compareVersion = true, readinessStart = false } = {}) {
    const settingsSessionType = settings.sessionType ?? (settings.mode === "presentation" ? "presentation" : "meeting");
    const settingsOutputMode = settings.outputMode
      ?? (settings.mode === "townhall" || ["fixed_voice", "auto_voice"].includes(settings.voiceOutputMode) ? "audio" : "captions");
    const settingsMaxViewers = settings.maxViewers ?? 50;
    const settingsVoiceProvider = settingsSessionType === "presentation"
      && ["captions_audio", "audio"].includes(settingsOutputMode)
      ? settings.voiceProvider ?? "gemini"
      : "gemini";
    if (claims.role !== "HOST"
      || typeof claims.sub !== "string"
      || claims.sessionId !== settings.sessionId
      || !Number.isSafeInteger(settings.version)
      || !Array.isArray(settings.languages)) {
      console.warn(`[host-authorize] rejected: malformed claims/settings session=${settings.sessionId} version=${settings.version}`);
      return false;
    }
    const query = new URLSearchParams({
      id: `eq.${settings.sessionId}`,
      expires_at: `gt.${new Date().toISOString()}`,
      select: "id,host_id,status,version,session_type,output_mode,voice_provider,max_viewers,mode,languages,voice_output_mode,pinned_glossary_fingerprint",
      limit: "1",
    });
    const response = await this.fetchFn(`${this.baseUrl}/rest/v1/live_sessions?${query}`, {
      cache: "no-store",
      signal,
      headers: createSupabaseHeaders(this.supabaseCredential),
    });
    if (!response.ok) {
      console.warn(`[host-authorize] rejected: live_sessions REST HTTP ${response.status} session=${settings.sessionId}`);
      return false;
    }
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length !== 1) {
      console.warn(`[host-authorize] rejected: no active session row (id/expiry filter) session=${settings.sessionId} rows=${Array.isArray(rows) ? rows.length : "invalid"}`);
      return false;
    }
    const row = rows[0];
    const rowSessionType = row.session_type ?? (row.mode === "presentation" ? "presentation" : "meeting");
    const rowOutputMode = row.output_mode
      ?? (row.mode === "townhall" || ["fixed_voice", "auto_voice"].includes(row.voice_output_mode) ? "audio" : "captions");
    const rowVoiceProvider = rowSessionType === "presentation" && ["captions_audio", "audio"].includes(rowOutputMode)
      ? row.voice_provider ?? "gemini"
      : "gemini";
    // Paused sessions keep a valid host lease (contract C4): pause must not
    // close the host socket.
    const readinessMode = row.status === "live" && row.version === settings.version
      ? "resume-live"
      : "activate";
    const isReadinessVersion = row.status === "preparing"
      ? row.version === settings.version
      : row.status === "live" && (row.version === settings.version || row.version === settings.version + 1);
    const isActiveStatus = readinessStart
      ? isReadinessVersion
      : requireLive
        ? ["live", "paused"].includes(row.status)
        : ["preparing", "live", "paused"].includes(row.status);
    const pinnedGlossaryFingerprint = row.pinned_glossary_fingerprint ?? null;
    const hasValidPinnedGlossaryFingerprint = !readinessStart
      || (Object.hasOwn(row, "pinned_glossary_fingerprint")
        && (pinnedGlossaryFingerprint === null
          || /^sha256:[a-f0-9]{64}$/u.test(pinnedGlossaryFingerprint)));
    const isAuthorized = row.host_id === claims.sub
      && isActiveStatus
      && (readinessStart || !compareVersion || row.version === settings.version)
      && rowSessionType === settingsSessionType
      && rowOutputMode === settingsOutputMode
      && rowVoiceProvider === settingsVoiceProvider
      && (row.max_viewers ?? 50) === settingsMaxViewers
      && Array.isArray(row.languages)
      && row.languages.length === settings.languages.length
      && row.languages.every((language, index) => language === settings.languages[index])
      && hasValidPinnedGlossaryFingerprint;
    if (!isAuthorized) {
      // Session config only — never tokens or transcript content. This names
      // the exact mismatched field so host-start rejections stop being blind.
      console.warn(`[host-authorize] rejected session=${settings.sessionId} `
        + `status=${row.status} requireLive=${requireLive} `
        + `version=${row.version}/${settings.version} type=${rowSessionType}/${settingsSessionType} `
        + `output=${rowOutputMode}/${settingsOutputMode} voice=${rowVoiceProvider}/${settingsVoiceProvider} `
        + `viewers=${row.max_viewers ?? 50}/${settingsMaxViewers} `
        + `languages=${JSON.stringify(row.languages)}/${JSON.stringify(settings.languages)} host=${row.host_id === claims.sub}`);
    }
    if (!isAuthorized) return false;
    return readinessStart ? { pinnedGlossaryFingerprint, readinessMode, sessionStatus: row.status } : true;
  }

  async activate(claims, settings, { signal } = {}) {
    const response = await this.fetchFn(`${this.baseUrl}/rest/v1/rpc/activate_live_session_after_gateway_ready_v1`, {
      method: "POST",
      cache: "no-store",
      signal,
      headers: createSupabaseHeaders(this.supabaseCredential),
      body: JSON.stringify({
        p_session_id: settings.sessionId,
        p_host_id: claims.sub,
        p_expected_version: settings.version,
        p_activation_key: settings.activationKey,
        p_gateway_settings_fingerprint: settings.gatewaySettingsFingerprint,
        p_session_type: settings.sessionType,
        p_output_mode: settings.outputMode,
        p_voice_provider: settings.voiceProvider,
        p_languages: settings.languages,
        p_max_viewers: settings.maxViewers,
        p_glossary_pack: settings.glossaryPack ?? "general_cre",
        p_pinned_glossary_fingerprint: settings.pinnedGlossaryFingerprint,
      }),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => null);
      const allowedCodes = ["GATEWAY_READINESS_CONFLICT", "INVALID_GATEWAY_READINESS_INPUT", "HOST_ACCESS_REQUIRED"];
      const safeCode = isPlainRecord(failure)
        ? allowedCodes.find((code) => failure.message === code || failure.code === code) ?? "GATEWAY_READINESS_FAILED"
        : "GATEWAY_READINESS_FAILED";
      // Status and PostgREST code only — never the body. A stale schema cache
      // (PGRST202 404) once failed every go-live with zero log output.
      const rawCode = isPlainRecord(failure) && typeof failure.code === "string"
        ? failure.code.slice(0, 40).replace(/[^A-Za-z0-9_-]/gu, "")
        : "none";
      console.warn(`[host-activate] rejected session=${settings.sessionId} http=${response.status} code=${rawCode} mapped=${safeCode}`);
      throw new Error(safeCode);
    }
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)
      || rows.length !== 1
      || !isPlainRecord(rows[0])
      || !hasExactKeys(rows[0], ["session_id", "status", "version"])
      || rows[0].session_id !== settings.sessionId
      || rows[0].status !== "live"
      || rows[0].version !== settings.version + 1) {
      throw new Error("INVALID_GATEWAY_READINESS_RESPONSE");
    }
    return { sessionId: rows[0].session_id, status: rows[0].status, version: rows[0].version };
  }
}

export class SupabaseFloorController {
  constructor({ baseUrl, supabaseApiKey, supabaseKeyType, serviceRoleKey, fetchFn = fetch }) {
    this.baseUrl = baseUrl;
    this.supabaseCredential = resolveSupabaseCredential({ supabaseApiKey, supabaseKeyType, serviceRoleKey });
    this.fetchFn = fetchFn;
  }

  async take(sessionId, grantId) {
    try {
      const value = await this.#rpc("take_live_floor", { p_session_id: sessionId, p_grant_id: grantId });
      if (value && typeof value === "object" && value.ok === true) {
        return {
          ok: true,
          displayName: typeof value.displayName === "string" ? value.displayName : "참가자",
          participantId: typeof value.participantId === "string" ? value.participantId : grantId,
        };
      }
      const code = value && typeof value === "object" && typeof value.code === "string" ? value.code : "FLOOR_DENIED";
      return { ok: false, code };
    } catch {
      return { ok: false, code: "FLOOR_DENIED" };
    }
  }

  async release(sessionId, grantId) {
    try {
      return await this.#rpc("release_live_floor", { p_session_id: sessionId, p_grant_id: grantId ?? null }) === true;
    } catch {
      return false;
    }
  }

  /** Holder identity for floor broadcasts (contract C5). Best-effort: null on failure. */
  async getParticipant(sessionId, participantId) {
    try {
      const query = new URLSearchParams({
        session_id: `eq.${sessionId}`,
        id: `eq.${participantId}`,
        select: "display_name,department,job_title",
        limit: "1",
      });
      const response = await this.fetchFn(`${this.baseUrl}/rest/v1/live_participants?${query}`, {
        cache: "no-store",
        headers: createSupabaseHeaders(this.supabaseCredential),
      });
      if (!response.ok) return null;
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length !== 1) return null;
      return {
        name: typeof rows[0].display_name === "string" ? rows[0].display_name : "",
        department: typeof rows[0].department === "string" ? rows[0].department : "",
        jobTitle: typeof rows[0].job_title === "string" ? rows[0].job_title : "",
      };
    } catch {
      return null;
    }
  }

  async #rpc(name, payload) {
    const response = await this.fetchFn(`${this.baseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      cache: "no-store",
      headers: createSupabaseHeaders(this.supabaseCredential, { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error("SUPABASE_FLOOR_RPC_FAILED");
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : undefined;
  }
}

function resolveSupabaseCredential({ supabaseApiKey, supabaseKeyType, serviceRoleKey }) {
  const configuredApiKey = typeof supabaseApiKey === "string" ? supabaseApiKey.trim() : "";
  if (configuredApiKey) {
    if (!["secret", "legacy-service-role"].includes(supabaseKeyType)) {
      throw new Error("SUPABASE_SERVER_CREDENTIAL_TYPE_INVALID");
    }
    // The key SHAPE wins over the configured slot: a legacy service_role JWT
    // (eyJ…) placed in the SUPABASE_SECRET_KEY slot must still be sent with
    // Bearer authorization — apikey-only downgrades it to anon and RLS
    // silently empties every read.
    const keyType = configuredApiKey.startsWith("eyJ") ? "legacy-service-role" : supabaseKeyType;
    return { apiKey: configuredApiKey, keyType };
  }
  const legacyKey = typeof serviceRoleKey === "string" ? serviceRoleKey.trim() : "";
  if (legacyKey) return { apiKey: legacyKey, keyType: "legacy-service-role" };
  throw new Error("SUPABASE_SERVER_CREDENTIAL_REQUIRED");
}

function createSupabaseHeaders(credential, initialHeaders) {
  const headers = new Headers(initialHeaders);
  headers.set("apikey", credential.apiKey);
  if (credential.keyType === "legacy-service-role") headers.set("authorization", `Bearer ${credential.apiKey}`);
  else headers.delete("authorization");
  return headers;
}
