import { encodeAudioFrame } from "./binary-audio.js";

export class SupabaseLivePublisher {
  constructor({ baseUrl, supabaseApiKey, supabaseKeyType, serviceRoleKey, eventFanout, audioFanout, fetchFn = fetch }) {
    this.baseUrl = baseUrl;
    this.supabaseCredential = resolveSupabaseCredential({ supabaseApiKey, supabaseKeyType, serviceRoleKey });
    this.eventFanout = eventFanout;
    this.audioFanout = audioFanout;
    this.fetchFn = fetchFn;
  }

  async publish(sessionId, language, event) {
    if (event.type === "caption" && event.isFinal) {
      await this.#guardedRpc("persist_live_snapshot_if_active", {
        p_session_id: sessionId,
        p_language: language,
        p_event: event,
      });
      // Meeting-record persistence is best-effort: a declined or failing RPC
      // (row cap, transient network) must not interrupt the live broadcast.
      try {
        await this.#request("/rest/v1/rpc/persist_live_utterance_if_active", {
          method: "POST",
          body: JSON.stringify({
            p_session_id: sessionId,
            p_language: language,
            p_seq: event.seq,
            p_text: event.text,
            p_speaker_label: event.speaker?.speakerId ?? null,
            p_speaker_name: event.speaker?.label ?? null,
            p_source_ended_at: event.sourceEndedAt,
            p_emitted_at: event.emittedAt,
          }),
        });
      } catch {
        // Intentionally swallowed; see comment above.
      }
    }
    if (event.type === "speaker-legend") {
      await this.#guardedRpc("persist_session_speakers_if_active", {
        p_session_id: sessionId,
        p_language: language,
        p_speakers: event.speakers,
      });
    }
    await this.eventFanout(sessionId, language, event);
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
      || !Array.isArray(settings.languages)) return false;
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
    if (!response.ok) return false;
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length !== 1) return false;
    const row = rows[0];
    const rowSessionType = row.session_type ?? (row.mode === "presentation" ? "presentation" : "meeting");
    const rowOutputMode = row.output_mode
      ?? (row.mode === "townhall" || ["fixed_voice", "auto_voice"].includes(row.voice_output_mode) ? "audio" : "captions");
    const rowVoiceProvider = rowSessionType === "presentation" && ["captions_audio", "audio"].includes(rowOutputMode)
      ? row.voice_provider ?? "gemini"
      : "gemini";
    const isActiveStatus = requireLive ? row.status === "live" : ["preparing", "live"].includes(row.status);
    return row.host_id === claims.sub
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
        return { ok: true, displayName: typeof value.displayName === "string" ? value.displayName : "참가자" };
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
    return { apiKey: configuredApiKey, keyType: supabaseKeyType };
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
