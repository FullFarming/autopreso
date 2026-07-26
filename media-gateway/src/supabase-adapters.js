import { encodeAudioFrame } from "./binary-audio.js";

const DEFAULT_SNAPSHOT_GUARD_TIMEOUT_MILLISECONDS = 5_000;
const MAX_SNAPSHOT_GUARD_TIMEOUT_MILLISECONDS = 60_000;

export class SupabaseLivePublisher {
  constructor({
    baseUrl,
    supabaseApiKey,
    supabaseKeyType,
    serviceRoleKey,
    eventFanout,
    audioFanout,
    fetchFn = fetch,
    snapshotGuardTimeoutMilliseconds = DEFAULT_SNAPSHOT_GUARD_TIMEOUT_MILLISECONDS,
  }) {
    if (!Number.isSafeInteger(snapshotGuardTimeoutMilliseconds)
      || snapshotGuardTimeoutMilliseconds < 1
      || snapshotGuardTimeoutMilliseconds > MAX_SNAPSHOT_GUARD_TIMEOUT_MILLISECONDS) {
      throw new Error("INVALID_SNAPSHOT_GUARD_TIMEOUT");
    }
    this.baseUrl = baseUrl;
    this.supabaseCredential = resolveSupabaseCredential({ supabaseApiKey, supabaseKeyType, serviceRoleKey });
    this.eventFanout = eventFanout;
    this.audioFanout = audioFanout;
    this.fetchFn = fetchFn;
    this.snapshotGuardTimeoutMilliseconds = snapshotGuardTimeoutMilliseconds;
  }

  async publish(sessionId, language, event, { onLiveEvent = null } = {}) {
    let recordingError = null;
    if (event.type === "caption" && event.isFinal) {
      // 2026-07-26 security: Snapshot RPC is the active-session guard. No
      // viewer or host delivery occurs until it confirms this final is live.
      const snapshotResult = await this.#requestSnapshotGuard("/rest/v1/rpc/persist_live_snapshot_if_active", {
        method: "POST",
        body: JSON.stringify({
          p_session_id: sessionId,
          p_language: language,
          p_event: event,
        }),
      });
      if (snapshotResult === false) throw new Error("SESSION_STOPPED");
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
    if (event.type === "caption" && event.isFinal) {
      // Meeting-record persistence is best-effort: a declined or failing RPC
      // (row cap, transient network) must not interrupt the live broadcast.
      try {
        const utteranceResult = await this.#request("/rest/v1/rpc/persist_live_utterance_if_active", {
          method: "POST",
          body: JSON.stringify({
            p_session_id: sessionId,
            p_language: language,
            p_seq: event.seq,
            p_text: event.text,
            p_speaker_label: event.speaker?.speakerId ?? null,
            p_speaker_name: event.speaker?.label ?? null,
            p_source_started_at: event.sourceStartedAt ?? null,
            p_source_ended_at: event.sourceEndedAt,
            p_emitted_at: event.emittedAt,
            p_participant_id: participantIdFromSpeaker(event.speaker),
            // Provenance for the viewer's original/translation disclosure.
            // Null on the source lane, where p_text already IS the original.
            p_source_text: event.sourceText ?? null,
            p_source_language: event.sourceLanguage ?? null,
            p_origin: event.origin ?? null,
            p_utterance_key: event.utteranceKey ?? null,
            p_translation_status: event.translationStatus
              ?? (event.origin === "source" ? "verbatim" : event.sourceText ? "translated" : null),
          }),
        });
        if (utteranceResult !== true) recordingError = createRecordingError(sessionId, language, event.seq);
      } catch {
        recordingError = createRecordingError(sessionId, language, event.seq);
      }
    }
    if (recordingError) await this.eventFanout(sessionId, language, recordingError);
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

  async publishAudio(sessionId, language, header, pcm) {
    await this.audioFanout(sessionId, language, encodeAudioFrame(header, pcm));
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
      const seq = Array.isArray(rows) && rows.length === 1 ? Number(rows[0].seq) : 0;
      return [language, Number.isSafeInteger(seq) && seq > 0 ? seq : 0];
    }));
    return Object.fromEntries(entries);
  }

  /** Persisted utterances with seq > afterSeq for viewer replay (contract C2). */
  async fetchUtterancesAfter(sessionId, language, afterSeq, limit = 200, { signal } = {}) {
    const query = new URLSearchParams({
      session_id: `eq.${sessionId}`,
      language: `eq.${language}`,
      seq: `gt.${afterSeq}`,
      select: "seq,participant_id,speaker_label,speaker_name,text,source_text,source_language,origin,utterance_key,translation_status,source_ended_at,emitted_at",
      order: "seq.asc",
      limit: String(limit),
    });
    const rows = await this.#request(`/rest/v1/live_utterances?${query}`, { method: "GET", signal });
    if (!Array.isArray(rows)) return [];
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

function replayTranslationStatus(row) {
  if (["verbatim", "translated", "failed"].includes(row.translation_status)) {
    return row.translation_status;
  }
  return row.source_text ? "translated" : "verbatim";
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

function createRecordingError(sessionId, language, seq) {
  return {
    type: "recording-status",
    sessionId,
    language,
    status: "error",
    code: "UTTERANCE_PERSIST_FAILED",
    seq,
    message: "자막은 계속 표시되지만 기록 저장에 실패했습니다.",
  };
}

function participantIdFromSpeaker(speaker) {
  const speakerId = speaker?.speakerId;
  if (typeof speakerId !== "string" || !speakerId.startsWith("participant:")) return null;
  return speakerId.slice("participant:".length) || null;
}

export class SupabaseViewerAuthorizer {
  constructor({ baseUrl, supabaseApiKey, supabaseKeyType, serviceRoleKey, fetchFn = fetch }) {
    this.baseUrl = baseUrl;
    this.supabaseCredential = resolveSupabaseCredential({ supabaseApiKey, supabaseKeyType, serviceRoleKey });
    this.fetchFn = fetchFn;
  }

  async authorize(claims, sessionId, language, { signal } = {}) {
    if (claims.sessionId !== sessionId) return false;
    const response = await this.fetchFn(`${this.baseUrl}/rest/v1/rpc/authorize_live_viewer_topic`, {
      method: "POST",
      cache: "no-store",
      signal,
      headers: createSupabaseHeaders(this.supabaseCredential, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        p_session_id: sessionId,
        p_grant_id: claims.grantId,
        p_user_id: claims.userId,
        p_language: language,
      }),
    });
    if (!response.ok) return false;
    const value = await response.json().catch(() => false);
    return value === true;
  }
}

export class SupabaseHostAuthorizer {
  constructor({ baseUrl, supabaseApiKey, supabaseKeyType, serviceRoleKey, fetchFn = fetch }) {
    this.baseUrl = baseUrl;
    this.supabaseCredential = resolveSupabaseCredential({ supabaseApiKey, supabaseKeyType, serviceRoleKey });
    this.fetchFn = fetchFn;
  }

  async authorize(claims, settings, { signal, requireLive = false, compareVersion = true } = {}) {
    const settingsSessionType = settings.sessionType ?? (settings.mode === "presentation" ? "presentation" : "meeting");
    const settingsOutputMode = settings.outputMode
      ?? (settings.mode === "townhall" || ["fixed_voice", "auto_voice"].includes(settings.voiceOutputMode) ? "audio" : "captions");
    const settingsMaxViewers = settings.maxViewers ?? 50;
    const settingsGlossaryPack = settings.glossaryPack ?? "general_cre";
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
      select: "id,host_id,status,version,session_type,output_mode,voice_provider,max_viewers,glossary_pack,mode,languages,voice_output_mode",
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
    const isActiveStatus = requireLive
      ? ["live", "paused"].includes(row.status)
      : ["preparing", "live", "paused"].includes(row.status);
    const isAuthorized = row.host_id === claims.sub
      && isActiveStatus
      && (!compareVersion || row.version === settings.version)
      && rowSessionType === settingsSessionType
      && rowOutputMode === settingsOutputMode
      && rowVoiceProvider === settingsVoiceProvider
      && (row.max_viewers ?? 50) === settingsMaxViewers
      && (row.glossary_pack ?? "general_cre") === settingsGlossaryPack
      && Array.isArray(row.languages)
      && row.languages.length === settings.languages.length
      && row.languages.every((language, index) => language === settings.languages[index]);
    if (!isAuthorized) {
      // Session config only — never tokens or transcript content. This names
      // the exact mismatched field so host-start rejections stop being blind.
      console.warn(`[host-authorize] rejected session=${settings.sessionId} `
        + `status=${row.status} requireLive=${requireLive} `
        + `version=${row.version}/${settings.version} type=${rowSessionType}/${settingsSessionType} `
        + `output=${rowOutputMode}/${settingsOutputMode} voice=${rowVoiceProvider}/${settingsVoiceProvider} `
        + `viewers=${row.max_viewers ?? 50}/${settingsMaxViewers} glossary=${row.glossary_pack ?? "general_cre"}/${settingsGlossaryPack} `
        + `languages=${JSON.stringify(row.languages)}/${JSON.stringify(settings.languages)} host=${row.host_id === claims.sub}`);
    }
    return isAuthorized;
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
