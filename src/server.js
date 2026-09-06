import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocket, WebSocketServer } from "ws";

import {
  DEFAULT_SUBTITLE_SETTINGS,
  validateSubtitleSettings,
} from "./settings-store.js";
import { generateGeminiTextWithModelFallback } from "./gemini-text-generation.js";

import { GLOSSARY_PRESETS } from "./glossary-presets.js";
import { createSessionTranscripts } from "./session-transcripts.js";
import { createSubtitleChannelHub, isRetiredTranslatedAudioMessage } from "./subtitle-channels.js";
import { createSubtitleHistory, historyToCsv } from "./subtitle-history.js";
import { normalizeSubtitleControllerCommand } from "./subtitle-controller-command.js";
import { normalizeSpeakerProfile } from "../packages/caption-core/speaker-profile.js";
import { SUBTITLE_LANGUAGES, isSupportedSubtitleLanguage } from "./subtitle-languages.js";
import { getBuiltInGlossary } from "../packages/caption-core/index.js";
import {
  captionEngineCatalogForClient,
  GEMINI_ENGINE_SELECTION,
  findEngineEntry,
  normalizeEngineSelection,
} from "../packages/caption-core/caption-engine-catalog.js";
import { createSubtitlePolisher } from "./subtitle-polish.js";
import { createSubtitleRealtimeManager } from "./subtitle-realtime.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const NOVA_SHARED_NO_STORE_ASSETS = new Set([
  "nova-core.css",
  "nova-transcript.js",
  "subtitle-language-catalog.js",
  "system-language.js",
  "system-language-button.js",
  "system-language-button.css",
  "subtitle-i18n.js",
  "subtitle-i18n-ja.js",
]);
const SUBTITLE_NO_STORE_ASSETS = new Set([
  "subtitle.html",
  "subtitle-dashboard.js",
  "subtitle-workspace.js",
  "subtitle-model-settings.js",
  "subtitle.css",
  "subtitle-overlay.html",
  "subtitle-overlay.js",
  "subtitle-controller.html",
  "subtitle-controller.js",
  "subtitle-controller-refined.css",
  "subtitle-speakers.js",
  "subtitle-speakers.css",
  "subtitle-controls.js",
  "subtitle-controls.css",
]);
const NOVA_STATIC_ASSETS = new Set([
  ...NOVA_SHARED_NO_STORE_ASSETS,
  ...SUBTITLE_NO_STORE_ASSETS,
  "controller-appearance.js", "subtitle-audio-capture.js", "records-calendar.js",
  "icons/check.svg", "icons/chevron-down.svg", "icons/file-text.svg",
  "icons/globe.svg", "icons/radio.svg", "icons/settings.svg", "icons/users.svg",
]);

function broadcast(wss, message) {
  const serialized = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(serialized);
  }
}

const OPENAI_REALTIME_TRANSCRIPTION_VALIDATE_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const MAX_PENDING_UNKEYED_LIVE_CALL_SOURCES = 100;
const MAX_PENDING_KEYED_LIVE_CALL_SOURCES = 500;
const SUBTITLE_PCM_FRAME_BYTES = 4_800;
const SUBTITLE_PCM_FRAME_BASE64_CHARS = 6_400;
const SUBTITLE_PCM_FRAMES_PER_SECOND = 10;
const SUBTITLE_PCM_BURST_FRAMES = 20;
const MAX_LIVE_CALL_CAPTION_TEXT_CHARS = 2_000;

function validateSubtitleAudioFrame({ client, source, audio, budgets, now = Date.now() }) {
  const normalizedSource = source === "system" || source === "mic" ? source : "";
  if (!normalizedSource
    || typeof audio !== "string"
    || audio.length !== SUBTITLE_PCM_FRAME_BASE64_CHARS
    || !/^[A-Za-z0-9+/]+$/u.test(audio)) return null;
  const bytes = Buffer.from(audio, "base64");
  if (bytes.length !== SUBTITLE_PCM_FRAME_BYTES || bytes.toString("base64") !== audio) return null;

  let clientBudgets = budgets.get(client);
  if (!clientBudgets) {
    clientBudgets = new Map();
    budgets.set(client, clientBudgets);
  }
  const previous = clientBudgets.get(normalizedSource) ?? {
    tokens: SUBTITLE_PCM_BURST_FRAMES,
    updatedAt: now,
  };
  const elapsedMilliseconds = Math.max(0, now - previous.updatedAt);
  const tokens = Math.min(
    SUBTITLE_PCM_BURST_FRAMES,
    previous.tokens + elapsedMilliseconds * SUBTITLE_PCM_FRAMES_PER_SECOND / 1_000,
  );
  if (tokens < 1) {
    clientBudgets.set(normalizedSource, { tokens, updatedAt: now });
    return null;
  }
  clientBudgets.set(normalizedSource, { tokens: tokens - 1, updatedAt: now });
  return { source: normalizedSource, audio };
}

export async function startServer(options) {
  const app = express();
  const configuredLiveCallProducerCapability = typeof options.liveCallProducerCapability === "string"
    ? Buffer.from(options.liveCallProducerCapability, "utf8")
    : null;
  const hasLiveCallProducerCapability = (message) => {
    if (!configuredLiveCallProducerCapability) return true;
    if (typeof message?.producerCapability !== "string") return false;
    const supplied = Buffer.from(message.producerCapability, "utf8");
    return supplied.length === configuredLiveCallProducerCapability.length
      && timingSafeEqual(supplied, configuredLiveCallProducerCapability);
  };
  app.use((req, res, next) => {
    if (!isMutatingMethod(req.method) || isAllowedLocalOrigin(req.headers.origin, req.headers.host, { allowMissingOrigin: false })) {
      next();
      return;
    }
    res.status(403).json({ ok: false, error: "허용되지 않은 요청 출처입니다.", code: "INVALID_ORIGIN" });
  });
  app.use(express.json({ limit: "1mb" }));
  app.get(["/", "/index.html", "/subtitle"], (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(PUBLIC_DIR, "subtitle.html"));
  });
  const serveNovaAsset = express.static(PUBLIC_DIR, {
    index: false,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Surrogate-Control", "no-store");
    },
  });
  app.use((req, res, next) => {
    // 2026-09-05 fix: Only NOVA assets cross this product's local HTTP boundary.
    if (!NOVA_STATIC_ASSETS.has(req.path.slice(1))) return next();
    return serveNovaAsset(req, res, next);
  });

  const httpServer = createHttpServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  httpServer.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws" || !isAllowedLocalOrigin(request.headers.origin, request.headers.host)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
  });
  const subtitleHistory = createSubtitleHistory({
    settingsStore: options.settingsStore,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    log: options.log ?? console,
  });
  await subtitleHistory.hydrate();
  // Per-session recording: unlike the rolling translation-only history above,
  // this keeps the ORIGINAL source text with per-line timestamps so a session
  // can be replayed and AI-summarized after it ends.
  const sessionTranscripts = options.transcriptsDir
    ? createSessionTranscripts({
      storageDir: options.transcriptsDir,
      log: options.log ?? console,
      persistDelayMs: options.transcriptPersistDelayMs,
    })
    : null;
  let transcriptRecordTail = Promise.resolve();
  const pendingLiveCallSources = new Map();
  const pendingUnkeyedLiveCallSources = [];
  const recentlyRecordedLiveCallSources = new Set();
  let liveCallCaptionProducer = null;
  let liveCallCaptionSessionId = "";
  let liveCallCaptionProducerKind = null;
  let authoritativeLiveCallSessionId = "";
  let authoritativeLiveCallFloorMode = "blocked";
  let authoritativeLiveCallFloorHolderId = "";
  let authoritativeLiveCallFloorRevision = -1;
  const subtitleAudioBudgets = new WeakMap();
  const authoritativeFloorResult = (ok) => ({
    ok,
    mode: authoritativeLiveCallFloorMode,
    liveSessionId: authoritativeLiveCallSessionId,
    floorRevision: authoritativeLiveCallFloorRevision,
    holder: authoritativeLiveCallFloorMode === "participant"
      ? { participantId: authoritativeLiveCallFloorHolderId }
      : null,
  });
  const applyLiveCallFloorSnapshot = (snapshot) => {
    if (snapshot === null) {
      authoritativeLiveCallSessionId = "";
      authoritativeLiveCallFloorMode = "blocked";
      authoritativeLiveCallFloorHolderId = "";
      authoritativeLiveCallFloorRevision = -1;
      return authoritativeFloorResult(true);
    }
    const sessionId = snapshot && snapshot.type === "floor" && typeof snapshot.sessionId === "string"
      ? snapshot.sessionId.trim().slice(0, 240)
      : "";
    const floorRevision = snapshot?.floorRevision;
    const isHostFloor = snapshot?.holder === null;
    const participantId = !isHostFloor
      && snapshot?.holder
      && typeof snapshot.holder === "object"
      && !Array.isArray(snapshot.holder)
      && typeof snapshot.holder.participantId === "string"
      ? snapshot.holder.participantId.trim().slice(0, 240)
      : "";
    if (!sessionId || !Number.isSafeInteger(floorRevision) || floorRevision < 0 || (!isHostFloor && !participantId)) {
      authoritativeLiveCallSessionId = "";
      authoritativeLiveCallFloorMode = "blocked";
      authoritativeLiveCallFloorHolderId = "";
      authoritativeLiveCallFloorRevision = -1;
      return authoritativeFloorResult(false);
    }
    if (liveCallCaptionSessionId && sessionId !== liveCallCaptionSessionId) {
      return authoritativeFloorResult(false);
    }
    if (sessionId === authoritativeLiveCallSessionId && floorRevision < authoritativeLiveCallFloorRevision) {
      return authoritativeFloorResult(false);
    }
    if (sessionId === authoritativeLiveCallSessionId && floorRevision === authoritativeLiveCallFloorRevision) {
      const requestedMode = isHostFloor ? "host" : "participant";
      const requestedHolderId = isHostFloor ? "" : participantId;
      return authoritativeFloorResult(
        requestedMode === authoritativeLiveCallFloorMode
        && requestedHolderId === authoritativeLiveCallFloorHolderId,
      );
    }
    authoritativeLiveCallSessionId = sessionId;
    authoritativeLiveCallFloorMode = isHostFloor ? "host" : "participant";
    authoritativeLiveCallFloorHolderId = isHostFloor ? "" : participantId;
    authoritativeLiveCallFloorRevision = floorRevision;
    return authoritativeFloorResult(true);
  };
  // Silence-clear parity with captions-only: the gateway emits no clear event,
  // so without this the overlay holds a finished live-call sentence for the
  // 15-20s stale backstops. The window is SILENCE_CLEAR_MS (3s, the
  // captions-only silence threshold in subtitle-realtime.js) plus
  // SUBTITLE_PREVIOUS_SENTENCE_LINGER_MS (3s, how long a completed sentence
  // stays readable). A bare 3s measured this way removed the last sentence the
  // moment silence was detected, with none of that reading time — gateway
  // partials arrive every ~500ms (PARTIAL_MAX_HOLD_MILLISECONDS), so the timer
  // effectively starts at the last spoken word rather than after the
  // captions-only delta tail.
  const liveCallSilenceClearMilliseconds = Number.isFinite(options.liveCallSilenceClearMilliseconds)
    ? options.liveCallSilenceClearMilliseconds
    : 6_000;
  const liveCallSilenceClearTimers = new Map();
  // Per-lane highest sourceSeq that reached the display (partials carry the
  // seq their final will take). A final BELOW it belongs to an older sentence
  // than what viewers already read, so it routes to records/history only.
  const liveCallLaneMaxSourceSeq = new Map();
  function cancelLiveCallSilenceClears() {
    for (const timer of liveCallSilenceClearTimers.values()) clearTimeout(timer);
    liveCallSilenceClearTimers.clear();
    liveCallLaneMaxSourceSeq.clear();
  }
  function armLiveCallSilenceClear(liveSessionId, targetLanguage) {
    if (!liveSessionId || !targetLanguage) return;
    const existing = liveCallSilenceClearTimers.get(targetLanguage);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      liveCallSilenceClearTimers.delete(targetLanguage);
      if (liveSessionId !== liveCallCaptionSessionId) return;
      broadcastSubtitleMessage({
        type: "subtitle:clear",
        source: "live-call",
        liveSessionId,
        targetLanguage,
        reason: "silence",
      });
    }, liveCallSilenceClearMilliseconds);
    timer.unref?.();
    liveCallSilenceClearTimers.set(targetLanguage, timer);
  }
  let subtitleSessionProducer = null;
  let subtitleSessionId = "";
  let isSubtitleLocalProviderActive = false;
  let pendingSubtitleProviderStarts = 0;
  let isSubtitleSessionStopping = false;
  let subtitleProducerTransitionTail = Promise.resolve();
  const queueSubtitleProducerTransition = (operation) => {
    const result = subtitleProducerTransitionTail.then(operation, operation);
    subtitleProducerTransitionTail = result.catch(() => undefined);
    return result;
  };
  const stopSubtitleProviderSafely = async (sessionId, reason) => {
    try {
      await queueSubtitleProducerTransition(() => subtitles.stop(sessionId));
      return null;
    } catch (error) {
      (options.log ?? console).warn?.(
        `[subtitle] local provider stop failed (${reason}): ${error?.message ?? error}`,
      );
      return error;
    }
  };
  const queueTranscriptLine = (line) => {
    transcriptRecordTail = transcriptRecordTail
      .then(() => sessionTranscripts?.recordLine(line))
      .catch((error) => (options.log ?? console).warn?.(`[session-transcripts] record skipped: ${error?.message ?? error}`));
    return transcriptRecordTail;
  };
  const isHybridLocalStatus = (message) => (
    liveCallCaptionProducer !== null
    && liveCallCaptionProducer === subtitleSessionProducer
    && Boolean(liveCallCaptionSessionId)
    && message?.type === "subtitle:status"
    && message?.source !== "live-call"
  );
  // Per-viewer subtitle channels: every lane message gets a seq stamp and is
  // fanned out through the hub so a client subscribed to specific languages
  // (subtitle:subscribe) only receives its own lanes. Clients that never
  // subscribe receive everything, exactly as before.
  const subtitleHub = createSubtitleChannelHub();
  const normalizeLiveCallCaptionText = (value) => String(value ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_LIVE_CALL_CAPTION_TEXT_CHARS);
  const broadcastSubtitleMessage = (message) => {
    if (isRetiredTranslatedAudioMessage(message)) return;
    // Local provider health is useful to the host, but the hub's generic
    // connecting/idle semantics clear the canonical Live Call session. Keep
    // health visible without letting it erase participant snapshot identity.
    const stamped = isHybridLocalStatus(message) ? message : subtitleHub.ingest(message);
    const serialized = JSON.stringify(stamped);
    for (const wsClient of wss.clients) {
      if (wsClient.readyState === WebSocket.OPEN && subtitleHub.shouldSend(wsClient, stamped)) {
        wsClient.send(serialized);
      }
    }
    if (message.type !== "subtitle:committed") return;
    void queueTranscriptLine(message);
    void subtitleHistory.record(message)
      .then((snapshot) => broadcast(wss, { type: "subtitle:history", ...snapshot }))
      .catch((error) => broadcast(wss, {
        type: "subtitle:history",
        ...subtitleHistory.getSnapshot(),
        recorderStatus: { ...subtitleHistory.getSnapshot().recorderStatus, lastError: error.message },
      }));
  };
  // The "polish" call IS the text-translation half of the two-stage caption
  // engine, so its model comes from the saved engine selection. The catalog's
  // per-model fallback chain is availability routing only — one attempt per
  // model inside the polisher's own deadline, never a quality override
  // (2026-08-31 incident: a 503 on the primary blanked every committed line).
  const subtitlePolish = async (args) => {
    const saved = options.settingsStore ? await options.settingsStore.load() : {};
    const env = options.env ?? process.env;
    const polishOptions = selectSubtitlePolishOptions({ args, saved, env });
    if (!polishOptions) {
      if (args?.required) throw Object.assign(new Error("TRANSLATION_CONFIG_ERROR"), { code: "TRANSLATION_CONFIG_ERROR" });
      return args?.translatedText;
    }
    const polisher = createSubtitlePolisher({
      generateText: options.subtitleGeminiPolishGenerateText ?? ((request) => generateGeminiTextWithModelFallback({
        ...request,
        models: [polishOptions.modelId, ...polishOptions.fallbackModels],
        apiKey: polishOptions.apiKey,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
        perAttemptTimeoutMs: 2_800,
      })),
      model: polishOptions.modelId,
    });
    return polisher.polish(args);
  };
  const subtitles = (options.createSubtitleRealtimeManager ?? createSubtitleRealtimeManager)({
    broadcast: broadcastSubtitleMessage,
    settingsStore: options.settingsStore,
    env: options.env ?? process.env,
    createWebSocket: options.createSubtitleWebSocket,
    polish: options.subtitlePolish ?? subtitlePolish,
    createCaptionCredential: options.createCaptionCredential,
    renewCaptionSession: options.renewCaptionSession,
    stopCaptionSession: options.stopCaptionSession,
    translateCaption: options.translateCaption,
  });

  app.get("/api/config", async (_req, res) => {
    let sanitized = options.settingsStore ? await options.settingsStore.getSanitized() : null;
    if (typeof options.resolveCaptionEngine === "function") {
      try {
        const engine = normalizeEngineSelection(await options.resolveCaptionEngine());
        sanitized = { ...(sanitized ?? {}), subtitle: { ...(sanitized?.subtitle ?? {}), engine } };
      } catch {
        return res.status(503).json({ ok: false, code: "ENGINE_ASSIGNMENT_UNAVAILABLE", error: "로그인 후 배정된 엔진을 다시 확인해 주세요." });
      }
    }
    res.json({
      settings: sanitized,
      captionEngines: captionEngineCatalogForClient({
        hasApiKeys: { gemini: Boolean(sanitized?.hasGeminiKey), soniox: Boolean(sanitized?.hasSonioxKey) },
      }),
    });
  });

  app.get("/api/settings", async (_req, res) => {
    if (!options.settingsStore) return res.status(404).json({ error: "Settings store not available." });
    const settings = await options.settingsStore.getSanitized();
    if (typeof options.resolveCaptionEngine === "function") {
      try {
        const engine = normalizeEngineSelection(await options.resolveCaptionEngine());
        return res.json({ ...settings, subtitle: { ...settings.subtitle, engine } });
      } catch {
        return res.status(503).json({ ok: false, code: "ENGINE_ASSIGNMENT_UNAVAILABLE", error: "로그인 후 배정된 엔진을 다시 확인해 주세요." });
      }
    }
    res.json(settings);
  });

  app.get("/api/subtitles/history", (_req, res) => {
    res.json({ ok: true, data: subtitleHistory.getSnapshot() });
  });

  // Language registry for the dashboard/overlay UI — the single source of
  // truth lives in src/subtitle-languages.js; the frontend fetches it here so
  // the pill list never drifts from what the server accepts.
  app.get("/api/subtitle-languages", (_req, res) => {
    res.json({
      ok: true,
      languages: SUBTITLE_LANGUAGES.map(({ code, label, nativeLabel }) => ({ code, label, nativeLabel })),
    });
  });

  // Portable settings transfer remains subtitle-only so a downloaded file can
  // never become a second plaintext store for long-lived provider credentials.
  app.get("/api/glossary-presets", (_req, res) => {
    res.json(GLOSSARY_PRESETS);
  });

  // Read-only projection of a built-in glossary pack for the dashboard's
  // detail popup. Only the fields the viewer needs — never ids, tags, or
  // provenance — so the payload stays a display contract, not a data export.
  app.get("/api/built-in-glossaries/:id", (req, res) => {
    const glossary = getBuiltInGlossary(String(req.params.id ?? ""));
    if (!glossary) return res.status(404).json({ ok: false, error: "UNKNOWN_GLOSSARY" });
    res.json({
      ok: true,
      glossary: {
        id: glossary.id,
        label: glossary.label,
        description: glossary.description,
        sourceLanguage: glossary.document.sourceLanguage,
        targetLanguages: glossary.document.targetLanguages,
        terms: glossary.document.terms.map(({ source, translations, context }) => ({ source, translations, context })),
      },
    });
  });

  app.get("/api/settings/export", async (_req, res) => {
    if (!options.settingsStore) return res.status(404).json({ error: "Settings store not available." });
    const settings = await options.settingsStore.load();
    const payload = createSafeSettingsExport(settings);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("content-disposition", 'attachment; filename="realtime-noel-settings.json"');
    res.send(JSON.stringify(payload, null, 2));
  });

  app.get("/api/subtitles/history/export.csv", (_req, res) => {
    const csv = historyToCsv(subtitleHistory.getSnapshot());
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", 'attachment; filename="realtime-noel-subtitles.csv"');
    // UTF-8 BOM so Excel decodes Korean correctly on double-click.
    res.send(String.fromCharCode(0xfeff) + csv);
  });

  app.post("/api/subtitles/history/clear", async (_req, res) => {
    const snapshot = await subtitleHistory.clear();
    broadcast(wss, { type: "subtitle:history", ...snapshot });
    res.json({ ok: true, data: snapshot });
  });

  // Session transcripts: full timestamped source-text record per caption
  // session, plus on-demand (and post-stop automatic) AI summaries.
  const selectTranscriptSummaryGenerator = async () => {
    if (options.subtitleSummaryGenerateText) return options.subtitleSummaryGenerateText;
    const saved = options.settingsStore ? await options.settingsStore.load() : {};
    const env = options.env ?? process.env;
    const geminiKey = saved.apiKeys?.gemini || env.GEMINI_API_KEY || "";
    if (geminiKey) {
      const summary = selectSubtitleEngineModel(saved, "summary");
      return (request) => generateGeminiTextWithModelFallback({
        ...request,
        models: [summary.modelId, ...summary.fallbackModels],
        apiKey: geminiKey,
        // Summaries produce long output; give each model attempt a real window.
        perAttemptTimeoutMs: 20_000,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
      });
    }
    return null;
  };

  const summarizeSessionTranscript = async (sessionId) => {
    if (!sessionTranscripts) throw new Error("세션 기록 저장소가 설정되지 않았습니다.");
    const generator = await selectTranscriptSummaryGenerator();
    if (!generator) throw createSafeHttpError(
      503,
      "TRANSCRIPT_SUMMARY_UNAVAILABLE",
      "AI 요약을 사용하려면 Gemini API 키를 설정해 주세요.",
    );
    const summary = await sessionTranscripts.summarize(sessionId, generator);
    broadcast(wss, { type: "subtitle:session-summary", sessionId, summary });
    return summary;
  };

  app.get("/api/subtitles/sessions", async (req, res) => {
    if (!sessionTranscripts) return res.json({ ok: true, data: [] });
    // The records calendar asks for one visible range at a time, so the response
    // is bounded by what is on screen rather than by the whole history.
    const kind = req.query.kind === "live-call" || req.query.kind === "local" ? req.query.kind : undefined;
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    res.json({ ok: true, data: await sessionTranscripts.list({ kind, from, to }) });
  });

  app.get("/api/subtitles/sessions/:id", async (req, res) => {
    if (!sessionTranscripts) return res.status(404).json({ ok: false, error: "세션 기록 저장소가 설정되지 않았습니다." });
    const session = await sessionTranscripts.get(req.params.id);
    if (!session) return res.status(404).json({ ok: false, error: "세션 기록을 찾을 수 없습니다." });
    res.json({ ok: true, data: session });
  });

  app.post("/api/subtitles/sessions/:id/summary", async (req, res) => {
    try {
      res.json({ ok: true, data: await summarizeSessionTranscript(req.params.id) });
    } catch (error) {
      const safe = safeHttpErrorResponse(error);
      res.status(safe.status).json({ ok: false, error: safe.error, code: safe.code });
    }
  });

  // Live Call archives arrive from the Electron main process after the host
  // ends a call: full speaker-attributed transcript (+ meeting summary when
  // the workspace already generated one). Transcripts can exceed the global
  // 1mb JSON cap, so this route parses its own body.
  app.post("/api/subtitles/sessions/import", express.json({ limit: "25mb" }), async (req, res) => {
    if (!sessionTranscripts) return res.status(404).json({ ok: false, error: "세션 기록 저장소가 설정되지 않았습니다." });
    const meta = await sessionTranscripts.importSession(req.body ?? {});
    if (!meta) return res.status(400).json({ ok: false, error: "세션 기록 형식이 올바르지 않습니다." });
    broadcast(wss, { type: "subtitle:sessions", sessions: await sessionTranscripts.list() });
    // Live Call recap belongs to the workspace job; import must never duplicate paid generation.
    if (meta.kind !== "live-call" && !meta.hasSummary && meta.lineCount > 0) {
      summarizeSessionTranscript(meta.id).catch((error) => {
        (options.log ?? console).warn?.(`[session-transcripts] import summary skipped: ${error?.message ?? error}`);
      });
    }
    res.json({ ok: true, data: meta });
  });

  app.get("/api/subtitles/sessions/:id/audio/:source", async (req, res) => {
    const audioPath = await sessionTranscripts?.getAudioFile(req.params.id, req.params.source);
    if (!audioPath) return res.status(404).json({ ok: false, error: "세션 음성 파일이 없습니다." });
    res.setHeader("content-type", "audio/wav");
    res.sendFile(audioPath);
  });

  app.post("/api/subtitles/openai/validate", async (req, res) => {
    const providedApiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
    const saved = options.settingsStore ? await options.settingsStore.load() : {};
    const env = options.env ?? process.env;
    const apiKey = providedApiKey || saved.apiKeys?.openai || env.OPENAI_API_KEY || "";
    if (!apiKey.trim()) {
      return res.status(400).json({
        ok: false,
        error: "OpenAI API key를 입력하세요.",
        code: "OPENAI_KEY_REQUIRED",
      });
    }
    try {
      await validateOpenAIRealtimeTranscriptionKey({
        apiKey,
        model: saved.transcription?.openai?.model || "gpt-realtime-whisper",
        createWebSocket: options.createSubtitleWebSocket ?? ((url, protocols, init) => new WebSocket(url, protocols, init)),
      });
      res.json({ ok: true, data: { status: "valid" } });
    } catch {
      res.status(400).json({
        ok: false,
        error: "OpenAI Realtime 연결 확인에 실패했습니다. API key, 네트워크, 사용량 한도를 확인하세요.",
        code: "OPENAI_REALTIME_VALIDATE_FAILED",
      });
    }
  });

  let isGeminiValidationPending = false;
  let lastGeminiValidationAt = 0;
  app.post("/api/subtitles/gemini/validate", async (req, res) => {
    const providedApiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
    const saved = options.settingsStore ? await options.settingsStore.load() : {};
    const env = options.env ?? process.env;
    const apiKey = providedApiKey || saved.apiKeys?.gemini || env.GEMINI_API_KEY || "";
    if (!apiKey.trim() || apiKey.length > 512 || /[\p{Cc}\p{Cf}]/u.test(apiKey)) {
      return res.status(400).json({
        ok: false,
        error: "Gemini API key를 입력하세요.",
        code: "GEMINI_KEY_REQUIRED",
      });
    }
    if (isGeminiValidationPending || Date.now() - lastGeminiValidationAt < 10_000) {
      return res.status(429).json({ ok: false, error: "연결 확인 중입니다. 잠시 후 다시 시도해 주세요.", code: "GEMINI_VALIDATE_RATE_LIMITED" });
    }
    isGeminiValidationPending = true;
    lastGeminiValidationAt = Date.now();
    try {
      await validateGeminiModelAccess({
        apiKey,
        model: selectSubtitleEngineModel(saved, "summary").modelId,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
      });
      res.json({ ok: true, data: { status: "valid" } });
    } catch {
      res.status(400).json({
        ok: false,
        error: "Gemini 연결 확인에 실패했습니다. API key, 프로젝트 권한, 사용량 한도를 확인하세요.",
        code: "GEMINI_VALIDATE_FAILED",
      });
    } finally {
      isGeminiValidationPending = false;
    }
  });

  // 2026-09-05 fix: 저장한 설정은 다음 자막 세션에서 읽는다. 진행 중인 세션의
  // 배정과 용어집은 연결 교체 중에도 유지되어야 한다.
  async function saveSettingsAndApply(patch) {
    await options.settingsStore.save(patch);
  }

  app.put("/api/settings", async (req, res) => {
    if (!options.settingsStore) return res.status(404).json({ error: "Settings store not available." });
    try {
      await saveSettingsAndApply(req.body ?? {});
      const sanitized = await options.settingsStore.getSanitized();
      res.json({ settings: sanitized });
      broadcast(wss, { type: "settings", settings: sanitized });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  httpServer.on("close", () => {
    subtitles.close();
  });

  wss.on("connection", async (client, request) => {
    const hasTrustedBrowserOrigin = typeof request?.headers?.origin === "string"
      && isAllowedLocalOrigin(request.headers.origin, request.headers.host);
    if (options.settingsStore) {
      const sanitized = await options.settingsStore.getSanitized();
      client.send(JSON.stringify({ type: "settings", settings: sanitized }));
    }
    client.send(JSON.stringify({ type: "subtitle:history", ...subtitleHistory.getSnapshot() }));
    // Late-join sync: paint the current live subtitle lanes immediately
    // instead of waiting for the next partial.
    client.send(JSON.stringify(subtitleHub.snapshotFor(client)));
    client.on("close", () => {
      subtitleHub.removeClient(client);
      if (client === subtitleSessionProducer) {
        const orphanedSessionId = subtitleSessionId;
        const shouldCloseLocalProvider = isSubtitleLocalProviderActive || pendingSubtitleProviderStarts > 0;
        // Keep the transcript active for renderer recovery, but never leave a
        // paid local provider orphaned after its only audio producer vanished.
        if (!isSubtitleSessionStopping) {
          isSubtitleSessionStopping = true;
          const closed = shouldCloseLocalProvider && orphanedSessionId
            ? stopSubtitleProviderSafely(orphanedSessionId, "owner_closed") : Promise.resolve();
          void closed.then(() => {
            if (client !== subtitleSessionProducer || orphanedSessionId !== subtitleSessionId) return;
            subtitleSessionProducer = null;
            subtitleSessionId = "";
            isSubtitleLocalProviderActive = false;
            isSubtitleSessionStopping = false;
          });
        }
      }
      if (client === liveCallCaptionProducer) {
        cancelLiveCallSilenceClears();
        subtitleHub.clearLiveCallSession(liveCallCaptionSessionId);
        liveCallCaptionProducer = null;
        liveCallCaptionSessionId = "";
        liveCallCaptionProducerKind = null;
      }
    });
    client.on("message", async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message.type === "settings:update" && options.settingsStore) {
        if (!hasTrustedBrowserOrigin) return;
        try {
          await saveSettingsAndApply(message.patch ?? {});
          const sanitized = await options.settingsStore.getSanitized();
          broadcast(wss, { type: "settings", settings: sanitized });
        } catch (error) {
          client.send(JSON.stringify({ type: "error", message: `Failed to apply settings: ${error.message}` }));
        }
      }

      if (message.type === "subtitle:live-call-caption") {
        // Live Call participant (Speak) captions: the media gateway mirrors
        // them to the desktop host socket, the Electron main process forwards
        // them over IPC, and the dashboard relays them here. Rebroadcast as
        // native subtitle lines so the overlay, preview, history, and session
        // records treat participant speech exactly like local captions.
        // Identity travels as structured fields — the overlay renders a
        // name·department·title badge instead of a "Name:" text prefix, and
        // the session record keeps attribution via the speaker field.
        if (!hasLiveCallProducerCapability(message)) {
          client.send(JSON.stringify({
            type: "subtitle:error",
            code: "LIVE_CALL_PRODUCER_CAPABILITY_INVALID",
            message: "Live Call 자막 채널을 확인할 수 없습니다.",
          }));
          return;
        }
        if (client !== liveCallCaptionProducer || !liveCallCaptionSessionId) {
          client.send(JSON.stringify({
            type: "subtitle:error",
            message: "활성 Live Call 자막 채널이 아닙니다.",
            code: "LIVE_CALL_CAPTION_PRODUCER_MISMATCH",
          }));
          return;
        }
        const relaySessionId = typeof message.sessionId === "string"
          ? message.sessionId.trim().slice(0, 240)
          : "";
        if (!relaySessionId || relaySessionId !== liveCallCaptionSessionId) {
          client.send(JSON.stringify({
            type: "subtitle:error",
            message: "Live Call 세션이 일치하지 않습니다.",
            code: "LIVE_CALL_CAPTION_SESSION_MISMATCH",
          }));
          return;
        }
        const translatedText = normalizeLiveCallCaptionText(message.translatedText);
        const suppliedSpeakerName = String(message.speaker ?? "").trim().slice(0, 80);
        const suppliedSpeakerRole = ["host", "participant"].includes(message.speakerRole)
          ? message.speakerRole
          : "";
        const speakerRole = suppliedSpeakerRole || (suppliedSpeakerName ? "participant" : "host");
        let speakerProfile;
        if (message.speakerProfile != null) {
          try { speakerProfile = normalizeSpeakerProfile(message.speakerProfile); }
          catch {
            client.send(JSON.stringify({ type: "subtitle:error", code: "INVALID_SPEAKER_PROFILE", message: "발언자 정보를 확인할 수 없습니다." }));
            return;
          }
        }
        const speakerAttribution = message.speakerAttribution === "unresolved" ? "unresolved" : undefined;
        if (speakerAttribution) speakerProfile = undefined;
        const speakerName = speakerAttribution ? "발언자 확인 필요" : speakerProfile?.displayName || suppliedSpeakerName || "Host";
        const speakerDepartment = speakerRole === "participant"
          ? String(message.speakerDepartment ?? "").trim().slice(0, 80)
          : "";
        const speakerJobTitle = speakerRole === "participant"
          ? String(message.speakerJobTitle ?? "").trim().slice(0, 100)
          : "";
        if (translatedText && message.recordOnly === true) {
          // 원문 보관: the untranslated source line goes into the session
          // record (Records shows the original alongside the translation)
          // but NEVER onto the overlay — screen captions stay
          // translation-direction only, exactly like the subtitle policy.
          const utteranceKey = typeof message.utteranceKey === "string" && message.utteranceKey
            ? message.utteranceKey.slice(0, 240)
            : null;
          if (utteranceKey && recentlyRecordedLiveCallSources.delete(utteranceKey)) return;
          const sourceLine = {
            speaker: speakerName,
            ...(speakerAttribution ? { speakerAttribution } : {}),
            ...(speakerProfile ? { speakerProfile } : {}),
            sourceText: translatedText,
            translatedText: "",
          };
          if (utteranceKey) {
            if (!pendingLiveCallSources.has(utteranceKey)
              && pendingLiveCallSources.size >= MAX_PENDING_KEYED_LIVE_CALL_SOURCES) {
              const oldestKey = pendingLiveCallSources.keys().next().value;
              const overflow = pendingLiveCallSources.get(oldestKey);
              pendingLiveCallSources.delete(oldestKey);
              if (overflow) void queueTranscriptLine(overflow);
            }
            pendingLiveCallSources.set(utteranceKey, sourceLine);
          } else {
            if (pendingUnkeyedLiveCallSources.length >= MAX_PENDING_UNKEYED_LIVE_CALL_SOURCES) {
              const overflow = pendingUnkeyedLiveCallSources.shift();
              if (overflow) void queueTranscriptLine(overflow);
            }
            pendingUnkeyedLiveCallSources.push(sourceLine);
          }
          return;
        }
        if (translatedText) {
          let sourceText = normalizeLiveCallCaptionText(message.sourceText);
          const utteranceKey = typeof message.utteranceKey === "string" && message.utteranceKey
            ? message.utteranceKey.slice(0, 240)
            : null;
          let pending = null;
          if (utteranceKey && message.partial !== true) {
            pending = pendingLiveCallSources.get(utteranceKey) ?? null;
            if (!sourceText && pending) sourceText = pending.sourceText;
            pendingLiveCallSources.delete(utteranceKey);
            recentlyRecordedLiveCallSources.add(utteranceKey);
            if (recentlyRecordedLiveCallSources.size > 500) {
              recentlyRecordedLiveCallSources.delete(recentlyRecordedLiveCallSources.values().next().value);
            }
          } else if (!utteranceKey && message.partial !== true) {
            const matchingIndex = pendingUnkeyedLiveCallSources.findIndex((line) => line.speaker === speakerName);
            if (matchingIndex >= 0) {
              [pending] = pendingUnkeyedLiveCallSources.splice(matchingIndex, 1);
              if (!sourceText) sourceText = pending.sourceText;
            }
          }
          const sourceSeq = Number.isSafeInteger(message.sourceSeq) && message.sourceSeq >= 0
            ? message.sourceSeq
            : null;
          const laneLanguage = String(message.targetLanguage ?? "");
          // Caption-only parity. The overlay builds its rolling 2-3 line word
          // stream from COMMITTED lines plus the live partial tail
          // (renderLane in subtitle-overlay.js), so finals must keep
          // displaying — they are what the accumulated text is made of.
          // Caption-only looks smooth because its final lands in order, on the
          // sentence currently on screen. What broke live-call is ORDER: the
          // gateway awaits the polish pass, so a final can arrive after newer
          // partials already painted (interims carry the seq their final will
          // take — contract C1). Only those out-of-order finals go to
          // records/history; painting one rewinds the lane to an older
          // sentence, which caption-only never does.
          const laneDisplayedSeq = liveCallLaneMaxSourceSeq.get(laneLanguage) ?? -1;
          const isRecordOnlyFinal = message.partial !== true && sourceSeq !== null && sourceSeq < laneDisplayedSeq;
          if (!isRecordOnlyFinal && sourceSeq !== null && sourceSeq > laneDisplayedSeq) {
            liveCallLaneMaxSourceSeq.set(laneLanguage, sourceSeq);
          }
          const line = {
            type: message.partial ? "subtitle:partial" : "subtitle:committed",
            source: "live-call",
            liveSessionId: relaySessionId,
            targetLanguage: laneLanguage,
            sourceText,
            sourceLanguage: String(message.sourceLanguage ?? ""),
            utteranceKey,
            ...(sourceSeq !== null ? { sourceSeq } : {}),
            translatedText,
            speaker: speakerName,
            ...(speakerAttribution ? { speakerAttribution } : {}),
            ...(speakerProfile ? { speakerProfile } : {}),
            liveCallSpeaker: {
              ...(speakerAttribution ? { speakerAttribution } : {}),
              ...(speakerProfile ? { speakerProfile } : {}),
              role: speakerRole,
              name: speakerName,
              department: speakerDepartment,
              jobTitle: speakerJobTitle,
            },
          };
          if (isRecordOnlyFinal) {
            void queueTranscriptLine(line);
            void subtitleHistory.record(line)
              .then((snapshot) => broadcast(wss, { type: "subtitle:history", ...snapshot }))
              .catch(() => {});
            return;
          }
          broadcastSubtitleMessage(line);
          armLiveCallSilenceClear(relaySessionId, laneLanguage);
        }
      }

      if (message.type === "subtitle:mirror") {
        if (!hasTrustedBrowserOrigin) return;
        // Phone-link mirror: the dashboard renderer receives lines from the
        // paired web session (Supabase, Chromium network stack → passes
        // corporate proxies) and relays them here; rebroadcast as real
        // subtitle events so the overlay/preview/history treat them natively.
        const translatedText = String(message.translatedText ?? "").trim();
        if (translatedText) {
          const line = {
            type: message.partial ? "subtitle:partial" : "subtitle:committed",
            source: "mirror",
            targetLanguage: String(message.targetLanguage ?? ""),
            sourceText: String(message.sourceText ?? ""),
            translatedText: message.speaker ? `${message.speaker}: ${translatedText}` : translatedText,
          };
          broadcastSubtitleMessage(line);
        }
      }

      if (message.type === "subtitle:preflight") {
        const requestId = typeof message.requestId === "string" ? message.requestId.slice(0, 128) : "";
        try {
          if (options.canStartSubtitleSession && !options.canStartSubtitleSession()) throw new Error("HOST_LOGIN_REQUIRED");
          const meeting = message.meeting && typeof message.meeting === "object" ? message.meeting : {};
          if (!requestId || !hasTrustedBrowserOrigin || meeting.kind !== "live-call") {
            throw new Error("LIVE_CALL_CAPTION_PREFLIGHT_UNTRUSTED");
          }
          if (!hasLiveCallProducerCapability(message)) {
            throw new Error("LIVE_CALL_PRODUCER_CAPABILITY_INVALID");
          }
          if (typeof meeting.liveSessionId !== "string" || !meeting.liveSessionId.trim()) {
            throw new Error("LIVE_CALL_SESSION_REQUIRED");
          }
          validateSubtitleSettings(message.settings);
          client.send(JSON.stringify({ type: "subtitle:preflight-ready", requestId }));
        } catch (error) {
          client.send(JSON.stringify({
            type: "subtitle:preflight-failed",
            requestId,
            message: error?.message ?? "SUBTITLE_PREFLIGHT_FAILED",
            code: "SUBTITLE_PREFLIGHT_FAILED",
          }));
        }
      }

      if (message.type === "subtitle:start") {
        if (options.canStartSubtitleSession && !options.canStartSubtitleSession()) {
          client.send(JSON.stringify({ type: "subtitle:error", sessionId: typeof message.sessionId === "string" ? message.sessionId : "", code: "SUBTITLE_START_FAILED", message: "HOST_LOGIN_REQUIRED" }));
          return;
        }
        let didAttemptLocalProviderStart = false;
        let didClaimSubtitleSession = false;
        let requestedSessionId = "";
        try {
          if (!hasTrustedBrowserOrigin) throw new Error("SUBTITLE_PRODUCER_UNTRUSTED");
          requestedSessionId = typeof message.sessionId === "string" ? message.sessionId.trim().slice(0, 240) : "";
          if (!requestedSessionId) throw new Error("SUBTITLE_SESSION_REQUIRED");
          const requestedProducerKind = message.captionProducer === "hybrid"
            ? "hybrid"
            : message.captionProducer === "gateway"
              ? "gateway"
              : "local";
          if (requestedProducerKind === "hybrid" && !hasLiveCallProducerCapability(message)) {
            throw new Error("LIVE_CALL_PRODUCER_CAPABILITY_INVALID");
          }
          validateSubtitleSettings(message.settings);
          if (subtitleSessionProducer && subtitleSessionProducer !== client) {
            throw new Error("SUBTITLE_PRODUCER_ACTIVE");
          }
          if (subtitleSessionProducer === client && subtitleSessionId && subtitleSessionId !== requestedSessionId) {
            throw new Error("SUBTITLE_SESSION_ACTIVE");
          }
          if (isSubtitleSessionStopping || pendingSubtitleProviderStarts > 0) {
            throw new Error("SUBTITLE_SESSION_TRANSITION_PENDING");
          }
          const meeting = message.meeting && typeof message.meeting === "object" ? message.meeting : {};
          const requestedLiveSessionId = String(meeting.liveSessionId ?? "").trim().slice(0, 240);
          if (requestedProducerKind === "gateway" || requestedProducerKind === "hybrid") {
            if (!hasTrustedBrowserOrigin || meeting.kind !== "live-call") {
              throw new Error("LIVE_CALL_CAPTION_PRODUCER_UNTRUSTED");
            }
            if (!requestedLiveSessionId) throw new Error("LIVE_CALL_SESSION_REQUIRED");
            if (liveCallCaptionProducer && liveCallCaptionProducer !== client) {
              throw new Error("LIVE_CALL_CAPTION_PRODUCER_ACTIVE");
            }
            if (liveCallCaptionProducer === client
              && liveCallCaptionSessionId
              && liveCallCaptionSessionId !== requestedLiveSessionId) {
              throw new Error("LIVE_CALL_CAPTION_SESSION_ACTIVE");
            }
          } else if (client === liveCallCaptionProducer
            && (meeting.kind !== "live-call" || requestedLiveSessionId !== liveCallCaptionSessionId)) {
            throw new Error("LIVE_CALL_LOCAL_SESSION_MISMATCH");
          }
          subtitleSessionProducer = client;
          subtitleSessionId = requestedSessionId;
          didClaimSubtitleSession = true;
          if (requestedProducerKind === "gateway" || requestedProducerKind === "hybrid") {
            liveCallCaptionProducer = client;
            liveCallCaptionSessionId = requestedLiveSessionId;
            liveCallCaptionProducerKind = requestedProducerKind;
            cancelLiveCallSilenceClears();
            subtitleHub.setLiveCallSession(liveCallCaptionSessionId);
          }
          if (requestedProducerKind !== "gateway") {
            didAttemptLocalProviderStart = true;
            pendingSubtitleProviderStarts += 1;
            try {
              await queueSubtitleProducerTransition(async () => {
                let startSettings = message.settings;
                let managedSession;
                if (requestedProducerKind === "local") {
                  let engine;
                  if (typeof options.startCaptionSession === "function") {
                    const saved = options.settingsStore ? await options.settingsStore.load() : {};
                    const settings = { ...DEFAULT_SUBTITLE_SETTINGS, ...(saved.subtitle ?? {}), ...(message.settings ?? {}) };
                    validateSubtitleSettings(settings);
                    managedSession = await options.startCaptionSession(settings.translationLanguages);
                    engine = normalizeEngineSelection(managedSession.engine);
                    startSettings = settings;
                  } else {
                    if (typeof options.resolveCaptionEngine !== "function") throw new Error("ENGINE_ASSIGNMENT_REQUIRED");
                    engine = normalizeEngineSelection(await options.resolveCaptionEngine());
                  }
                  if (client !== subtitleSessionProducer || subtitleSessionId !== requestedSessionId || isSubtitleSessionStopping) {
                    if (managedSession) await options.stopCaptionSession(managedSession);
                    return;
                  }
                  // 2026-09-05 fix: A renderer's settings cannot override the administrator's session-start assignment.
                  startSettings = { ...(startSettings ?? {}), engine };
                }
                try {
                  await subtitles.start({ sessionId: requestedSessionId, settings: startSettings, managedSession });
                } catch (error) {
                  if (managedSession) await options.stopCaptionSession(managedSession);
                  throw error;
                }
                isSubtitleLocalProviderActive = true;
              });
            } finally {
              pendingSubtitleProviderStarts -= 1;
            }
          }
          // 2026-08-31 fix: STOP/owner-close must drain an in-flight paid start before a replacement can claim it.
          if (client !== subtitleSessionProducer || subtitleSessionId !== requestedSessionId || isSubtitleSessionStopping) return;
          // Optional meeting identity. When captions are running for a Live Call
          // the record must be anchored to the CALL's start and carry its title,
          // because that is what the records calendar places on the grid. Every
          // field is bounded and validated inside begin(); absent means a plain
          // local caption session, which is the historical behaviour.
          await sessionTranscripts?.begin({
            sessionId: requestedSessionId,
            kind: meeting.kind === "live-call" ? "live-call" : "local",
            liveSessionId: typeof meeting.liveSessionId === "string" ? meeting.liveSessionId : "",
            title: typeof meeting.title === "string" ? meeting.title : "",
            startedAt: typeof meeting.startedAt === "string" ? meeting.startedAt : "",
          });
          if (client !== subtitleSessionProducer || subtitleSessionId !== requestedSessionId || isSubtitleSessionStopping) return;
          client.send(JSON.stringify({
            type: "subtitle:started",
            sessionId: requestedSessionId,
            captionProducer: requestedProducerKind,
          }));
        } catch (error) {
          // 2026-08-31 fix: A rejected replacement never acquired the existing session's cleanup authority.
          const shouldCompensateLocalProvider = didClaimSubtitleSession
            && client === subtitleSessionProducer && subtitleSessionId === requestedSessionId
            && !isSubtitleSessionStopping
            && (didAttemptLocalProviderStart || isSubtitleLocalProviderActive);
          if (shouldCompensateLocalProvider) {
            await stopSubtitleProviderSafely(requestedSessionId, "start_failed");
          }
          const stillOwnsRequestedSession = didClaimSubtitleSession
            && client === subtitleSessionProducer && subtitleSessionId === requestedSessionId
            && !isSubtitleSessionStopping;
          if (stillOwnsRequestedSession) {
            subtitleSessionProducer = null;
            subtitleSessionId = "";
            isSubtitleLocalProviderActive = false;
          }
          if (stillOwnsRequestedSession && client === liveCallCaptionProducer) {
            cancelLiveCallSilenceClears();
            subtitleHub.clearLiveCallSession(liveCallCaptionSessionId);
            liveCallCaptionProducer = null;
            liveCallCaptionSessionId = "";
            liveCallCaptionProducerKind = null;
          }
          client.send(JSON.stringify({
            type: "subtitle:error",
            sessionId: typeof message.sessionId === "string" ? message.sessionId : "",
            captionProducer: message.captionProducer === "hybrid"
              ? "hybrid"
              : message.captionProducer === "gateway"
                ? "gateway"
                : "local",
            message: error.message,
            code: "SUBTITLE_START_FAILED",
          }));
        }
      }

      if (message.type === "subtitle:live-call-floor") {
        if (!hasLiveCallProducerCapability(message)) {
          client.send(JSON.stringify({
            type: "subtitle:error",
            code: "LIVE_CALL_PRODUCER_CAPABILITY_INVALID",
            message: "Live Call 자막 채널을 확인할 수 없습니다.",
          }));
          return;
        }
        const requestSessionId = typeof message.sessionId === "string"
          ? message.sessionId.trim().slice(0, 240)
          : "";
        const requestLiveSessionId = typeof message.liveSessionId === "string"
          ? message.liveSessionId.trim().slice(0, 240)
          : "";
        const ownsHybridSession = hasTrustedBrowserOrigin
          && client === subtitleSessionProducer
          && client === liveCallCaptionProducer
          && isSubtitleLocalProviderActive
          && requestSessionId === subtitleSessionId
          && requestLiveSessionId === liveCallCaptionSessionId;
        if (!ownsHybridSession) {
          client.send(JSON.stringify({
            type: "subtitle:error",
            code: "LIVE_CALL_FLOOR_OWNER_MISMATCH",
            message: "활성 Live Call 자막 세션이 아닙니다.",
          }));
          return;
        }
        const floorRevision = message.floorRevision;
        if (!Number.isSafeInteger(floorRevision) || floorRevision < 0) {
          client.send(JSON.stringify({
            type: "subtitle:error",
            code: "LIVE_CALL_FLOOR_INVALID",
            message: "Live Call 발언권 상태가 올바르지 않습니다.",
          }));
          return;
        }
        const isHostFloor = message.holder === null;
        const participantId = !isHostFloor
          && message.holder
          && typeof message.holder === "object"
          && !Array.isArray(message.holder)
          ? String(message.holder.participantId ?? "").trim().slice(0, 240)
          : "";
        if (!isHostFloor && !participantId) {
          client.send(JSON.stringify({
            type: "subtitle:error",
            code: "LIVE_CALL_FLOOR_INVALID",
            message: "Live Call 발언권 상태가 올바르지 않습니다.",
          }));
          return;
        }
        const requestedMode = isHostFloor ? "host" : "participant";
        const requestedHolderId = isHostFloor ? "" : participantId;
        const matchesAuthoritativeFloor = requestLiveSessionId === authoritativeLiveCallSessionId
          && floorRevision === authoritativeLiveCallFloorRevision
          && requestedMode === authoritativeLiveCallFloorMode
          && requestedHolderId === authoritativeLiveCallFloorHolderId;
        if (!matchesAuthoritativeFloor) {
          client.send(JSON.stringify({
            type: "subtitle:error",
            code: "LIVE_CALL_FLOOR_AUTHORITY_MISMATCH",
            message: "확인되지 않은 Live Call 발언권 상태는 적용할 수 없습니다.",
          }));
          return;
        }
        client.send(JSON.stringify({
          type: "subtitle:live-call-floor-applied",
          sessionId: subtitleSessionId,
          liveSessionId: liveCallCaptionSessionId,
          floorRevision,
          mode: authoritativeLiveCallFloorMode,
        }));
      }

      if (message.type === "subtitle:audio") {
        if (client !== subtitleSessionProducer
          || message.sessionId !== subtitleSessionId
          || !isSubtitleLocalProviderActive) return;
        const normalizedAudio = client === liveCallCaptionProducer
          && liveCallCaptionProducerKind === "hybrid"
          ? validateSubtitleAudioFrame({
            client,
            source: message.source,
            audio: message.audio,
            budgets: subtitleAudioBudgets,
          })
          : { source: message.source, audio: message.audio };
        if (!normalizedAudio) return;
        subtitles.sendAudio({
          sessionId: message.sessionId,
          source: normalizedAudio.source,
          audio: normalizedAudio.audio,
        });
        // Archive the raw session audio (24 kHz PCM16) alongside the
        // transcript so Records can replay what was actually said.
        void sessionTranscripts?.appendAudioChunk(normalizedAudio.source, normalizedAudio.audio);
      }

      if (message.type === "subtitle:producer-stop") {
        if (typeof message.sessionId !== "string" || message.sessionId.length === 0) return;
        if (client !== subtitleSessionProducer || message.sessionId !== subtitleSessionId) {
          client.send(JSON.stringify({
            type: "subtitle:error",
            requestId: typeof message.requestId === "string" ? message.requestId : "",
            code: "SUBTITLE_PRODUCER_MISMATCH",
            message: "활성 자막 세션이 아닙니다.",
          }));
          return;
        }
        if (isSubtitleLocalProviderActive) {
          const stopError = await stopSubtitleProviderSafely(message.sessionId, "producer_stop");
          isSubtitleLocalProviderActive = false;
          if (stopError) {
            client.send(JSON.stringify({
              type: "subtitle:error",
              code: "SUBTITLE_PROVIDER_STOP_FAILED",
              message: "로컬 자막 엔진을 종료하지 못했습니다.",
            }));
            return;
          }
        }
        client.send(JSON.stringify({
          type: "subtitle:producer-stopped",
          requestId: typeof message.requestId === "string" ? message.requestId : "",
        }));
      }

      if (message.type === "subtitle:subscribe") {
        // languages: array of codes to receive, or null/[] for everything.
        // Responds with a snapshot of the currently visible lanes so the
        // subscribing viewer paints the live line immediately.
        const snapshot = subtitleHub.subscribe(client, message.languages ?? null);
        client.send(JSON.stringify(snapshot));
      }

      if (message.type === "subtitle:input-status") {
        if (client !== subtitleSessionProducer
          || message.sessionId !== subtitleSessionId
          || !isSubtitleLocalProviderActive) return;
        // Feed the stall watchdog: speech signal present → subtitles expected.
        if (message.status === "signal") {
          subtitles.noteInputSignal({
            sessionId: message.sessionId,
            source: message.source === "mic" ? "mic" : "system",
          });
        }
        broadcast(wss, {
          type: "subtitle:input-status",
          source: message.source === "mic" ? "mic" : "system",
          status: ["signal", "waiting", "silent"].includes(message.status) ? message.status : "waiting",
          level: Number.isFinite(Number(message.level)) ? Math.max(0, Math.min(1, Number(message.level))) : 0,
        });
      }

      if (message.type === "subtitle:control") {
        if (!hasTrustedBrowserOrigin) return;
        const control = normalizeSubtitleControllerCommand(message);
        if (!control) return;
        const { command } = control;
        // Server-side recovery: rebuild the translation channels directly so a
        // restart works even when no dashboard page is open to run a full
        // stop/start (overlay double-click, headless viewers). A connected
        // dashboard still performs its full restart on the broadcast below —
        // its new session simply replaces the rebuilt channels.
        if (command === "restart") void subtitles.restartChannels({ reason: "control_restart" });
        broadcast(wss, control);
      }

      if (message.type === "subtitle:stop") {
        if (typeof message.sessionId !== "string" || message.sessionId.length === 0) return;
        if (client !== subtitleSessionProducer || message.sessionId !== subtitleSessionId || isSubtitleSessionStopping) {
          client.send(JSON.stringify({
            type: "subtitle:error",
            code: "SUBTITLE_SESSION_MISMATCH",
            sessionId: message.sessionId,
            requestId: typeof message.requestId === "string" ? message.requestId.slice(0, 128) : "",
            message: "활성 자막 세션이 아닙니다.",
          }));
          return;
        }
        isSubtitleSessionStopping = true;
        const shouldBroadcastTerminalIdle = client === liveCallCaptionProducer
          || !isSubtitleLocalProviderActive;
        let providerStopError = null;
        if (isSubtitleLocalProviderActive || pendingSubtitleProviderStarts > 0) {
          providerStopError = await stopSubtitleProviderSafely(message.sessionId, "session_stop");
          isSubtitleLocalProviderActive = false;
        }
        // Gateway-caption sessions deliberately keep the local realtime manager
        // cold, so its stop() has no active state from which to emit idle. The
        // accepted session stop still owns the terminal display boundary.
        if (shouldBroadcastTerminalIdle) {
          broadcastSubtitleMessage({
            type: "subtitle:status",
            status: "idle",
            ...(client === liveCallCaptionProducer ? { source: "live-call" } : {}),
          });
        }
        for (const sourceLine of pendingLiveCallSources.values()) void queueTranscriptLine(sourceLine);
        for (const sourceLine of pendingUnkeyedLiveCallSources) void queueTranscriptLine(sourceLine);
        pendingLiveCallSources.clear();
        pendingUnkeyedLiveCallSources.length = 0;
        recentlyRecordedLiveCallSources.clear();
        if (client === liveCallCaptionProducer) {
          cancelLiveCallSilenceClears();
          subtitleHub.clearLiveCallSession(liveCallCaptionSessionId);
          liveCallCaptionProducer = null;
          liveCallCaptionSessionId = "";
          liveCallCaptionProducerKind = null;
        }
        let ended = null;
        let didFinalizeFail = false;
        try {
          await transcriptRecordTail;
          ended = await sessionTranscripts?.end();
          broadcast(wss, { type: "subtitle:sessions", sessions: await (sessionTranscripts?.list() ?? []) });
        } catch {
          didFinalizeFail = true;
        } finally {
          // 2026-09-01 fix: Failed record I/O must not retain ownership of an already stopped provider.
          if (client === subtitleSessionProducer && message.sessionId === subtitleSessionId) {
            subtitleSessionProducer = null;
            subtitleSessionId = "";
            isSubtitleSessionStopping = false;
          }
        }
        if (providerStopError || didFinalizeFail) {
          client.send(JSON.stringify({
            type: "subtitle:error",
            code: providerStopError ? "SUBTITLE_PROVIDER_STOP_FAILED" : "SUBTITLE_SESSION_FINALIZE_FAILED",
            sessionId: message.sessionId,
            requestId: typeof message.requestId === "string" ? message.requestId.slice(0, 128) : "",
            message: providerStopError ? "로컬 자막 엔진 종료를 확인하지 못했습니다." : "자막은 종료했지만 기록 저장을 완료하지 못했습니다.",
          }));
        } else {
          client.send(JSON.stringify({
            type: "subtitle:stopped",
            sessionId: message.sessionId,
            requestId: typeof message.requestId === "string" ? message.requestId.slice(0, 128) : "",
          }));
        }
        if (ended && ended.kind !== "live-call" && ended.lineCount > 0) {
          summarizeSessionTranscript(ended.id).catch((error) => {
            (options.log ?? console).warn?.(`[session-transcripts] auto summary skipped: ${error?.message ?? error}`);
          });
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve(undefined);
    });
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    app,
    applyLiveCallFloorSnapshot,
    httpServer,
    hasActiveSubtitleSession: () => Boolean(subtitleSessionId || liveCallCaptionSessionId || isSubtitleLocalProviderActive || subtitles._state?.active),
    url: `http://${options.host}:${port}`,
  };
}

export function createSafeSettingsExport(settings) {
  const source = settings?.subtitle && typeof settings.subtitle === "object"
    ? settings.subtitle
    : {};
  const subtitle = {};
  for (const key of Object.keys(DEFAULT_SUBTITLE_SETTINGS)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    subtitle[key] = structuredClone(source[key]);
  }
  return { subtitle };
}

class SafeHttpError extends Error {
  constructor(status, code, safeMessage) {
    super(safeMessage);
    this.name = "SafeHttpError";
    this.status = status;
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

function createSafeHttpError(status, code, safeMessage) {
  return new SafeHttpError(status, code, safeMessage);
}

function safeHttpErrorResponse(error) {
  if (isSafeHttpError(error)
    && error.status >= 400
    && error.status <= 599) {
    return { status: error.status, code: error.code, error: error.safeMessage };
  }
  return {
    status: 422,
    code: "TRANSCRIPT_SUMMARY_FAILED",
    error: "AI 요약을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  };
}

function isSafeHttpError(error) {
  return error instanceof SafeHttpError
    && Number.isInteger(error.status)
    && typeof error.code === "string"
    && /^[A-Z0-9_]+$/u.test(error.code)
    && typeof error.safeMessage === "string"
    && error.safeMessage.trim().length > 0;
}

function isMutatingMethod(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method);
}

function isAllowedLocalOrigin(origin, host, { allowMissingOrigin = true } = {}) {
  if (!origin) return allowMissingOrigin;
  if (!host) return false;
  try {
    const rawOrigin = String(origin).trim();
    const originUrl = new URL(rawOrigin);
    const hostUrl = new URL(`http://${host}`);
    const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
    return rawOrigin === originUrl.origin
      && loopbackHosts.has(originUrl.hostname)
      && loopbackHosts.has(hostUrl.hostname)
      && originUrl.host === hostUrl.host
      && (originUrl.protocol === "http:" || originUrl.protocol === "https:");
  } catch {
    return false;
  }
}

function validateOpenAIRealtimeTranscriptionKey({ apiKey, model, createWebSocket }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error, socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close?.();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => settle(new Error("OpenAI Realtime validation timed out."), socket), 8000);
    let socket;
    try {
      socket = createWebSocket(OPENAI_REALTIME_TRANSCRIPTION_VALIDATE_URL, undefined, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "OpenAI-Safety-Identifier": "realtime-noel-key-validation",
        },
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    socket.on("open", () => {
      socket.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24_000 },
              transcription: { model },
            },
          },
        },
      }));
    });
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        settle(new Error("Invalid OpenAI Realtime validation response."), socket);
        return;
      }
      if (
        message.type === "transcription_session.updated"
        || message.type === "session.updated"
      ) {
        settle(null, socket);
      }
      if (message.type === "error") {
        settle(new Error(message.error?.message ?? "OpenAI Realtime validation failed."), socket);
      }
    });
    socket.on("error", (error) => settle(error, socket));
    socket.on("close", () => {
      if (!settled) settle(new Error("OpenAI Realtime validation closed before confirmation."), socket);
    });
  });
}

async function validateGeminiModelAccess({ apiKey, model, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // 2026-09-01 fix: Settings validation must not create paid inference or
    // misclassify model overload as an invalid API key.
    const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, {
      method: "GET", redirect: "error", headers: { "x-goog-api-key": apiKey }, signal: controller.signal,
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("GEMINI_MODEL_ACCESS_FAILED");
  } finally {
    clearTimeout(timer);
  }
}

/** @param {any} options */
export function selectSubtitlePolishOptions({ args = {}, saved = {}, env = process.env } = {}) {
  if (normalizeEngineSelection(saved.subtitle?.engine).translation.provider === "soniox") return null;
  const hasGlossaryOrDomain = Boolean(String(args.glossary ?? "").trim() || String(args.domain ?? "").trim());
  const shouldRecoverPlaceholder = isEllipsisPlaceholder(args.translatedText)
    && String(args.sourceText ?? "").trim().length > 0;
  if (args.tone !== "business" && !hasGlossaryOrDomain && !shouldRecoverPlaceholder) return null;
  const provider = "gemini";
  const secondaryKey = (saved.apiKeys?.geminiSecondary
    || env.GEMINI_SECONDARY_API_KEY
    || saved.apiKeys?.gemini
    || env.GEMINI_API_KEY
    || "").trim();
  if (!secondaryKey) return null;

  const { modelId, fallbackModels } = selectSubtitleEngineModel(saved, "translation");
  return { provider, apiKey: secondaryKey, modelId, fallbackModels };
}

/**
 * Resolves one Gemini text role from the saved engine selection. A non-Gemini
 * (combined-provider) selection has no separate text model, so the catalog
 * default stands in for the roles the desktop still runs through Gemini.
 *
 * @param {any} saved
 * @param {"translation"|"summary"} role
 */
function selectSubtitleEngineModel(saved, role) {
  const selected = saved?.subtitle?.engine?.[role];
  const modelId = selected?.provider === "gemini" && typeof selected.model === "string"
    ? selected.model
    : GEMINI_ENGINE_SELECTION[role].model;
  return { modelId, fallbackModels: findEngineEntry(role, "gemini", modelId)?.fallbackModels ?? [] };
}

function isEllipsisPlaceholder(value) {
  return /^\s*(?:\.{2,}|…+)\s*$/.test(String(value ?? ""));
}
