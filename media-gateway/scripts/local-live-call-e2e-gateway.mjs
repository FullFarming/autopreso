/**
 * TEST-ONLY local Live Call gateway.
 *
 * This process uses the real gateway and Supabase persistence/authorization
 * adapters, but replaces every external speech/translation provider with a
 * deterministic PCM-to-caption pipeline. It must never be exposed beyond the
 * loopback interface or pointed at a hosted Supabase project.
 */
import { pathToFileURL } from "node:url";

import { createGatewayServer } from "../src/gateway-server.js";
import {
  SupabaseFloorController,
  SupabaseHostAuthorizer,
  SupabaseLivePublisher,
  SupabaseViewerAuthorizer,
} from "../src/supabase-adapters.js";

const DEFAULT_PORT = 18_080;
const LOOPBACK_HOST = "127.0.0.1";
const LOCAL_SUPABASE_PORT = "54321";
const TOKEN_SECRET_MINIMUM_LENGTH = 32;

export function readLocalLiveCallE2eEnvironment(environment = process.env) {
  const nodeEnvironment = String(environment.NODE_ENV ?? "development").trim().toLowerCase();
  if (nodeEnvironment === "production") {
    throw new Error("LOCAL_E2E_GATEWAY_FORBIDDEN_IN_PRODUCTION");
  }
  if (nodeEnvironment !== "development" && nodeEnvironment !== "test") {
    throw new Error("LOCAL_E2E_GATEWAY_ENVIRONMENT_INVALID");
  }
  if (String(environment.LIVE_ALLOW_LOCAL_SUPABASE ?? "").trim() !== "true") {
    throw new Error("LIVE_ALLOW_LOCAL_SUPABASE_MUST_BE_TRUE");
  }

  const baseUrl = parseExactLocalSupabaseUrl(environment.SUPABASE_URL);
  const gatewaySecret = requiredSecret(environment, "LIVE_GATEWAY_TOKEN_SECRET");
  const viewerSecret = requiredSecret(environment, "LIVE_VIEWER_TOKEN_SECRET");
  const secretKey = String(environment.SUPABASE_SECRET_KEY ?? "").trim();
  const serviceRoleKey = String(environment.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!secretKey && !serviceRoleKey) throw new Error("LOCAL_SUPABASE_SERVER_KEY_REQUIRED");

  const port = Number(environment.LOCAL_LIVE_CALL_E2E_GATEWAY_PORT ?? DEFAULT_PORT);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("LOCAL_E2E_GATEWAY_PORT_INVALID");
  }

  return Object.freeze({
    port,
    host: LOOPBACK_HOST,
    baseUrl,
    supabaseApiKey: secretKey || serviceRoleKey,
    supabaseKeyType: secretKey ? "secret" : "legacy-service-role",
    gatewaySecret,
    viewerSecret,
  });
}

function parseExactLocalSupabaseUrl(value) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    const hasRootPath = parsed.pathname === "/" || parsed.pathname === "";
    if (parsed.protocol !== "http:"
      || parsed.hostname !== LOOPBACK_HOST
      || parsed.port !== LOCAL_SUPABASE_PORT
      || parsed.username
      || parsed.password
      || !hasRootPath
      || parsed.search
      || parsed.hash) {
      throw new Error("not exact local Supabase");
    }
    return parsed.origin;
  } catch {
    throw new Error("LOCAL_SUPABASE_URL_MUST_BE_LOOPBACK_54321");
  }
}

function requiredSecret(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (value.length < TOKEN_SECRET_MINIMUM_LENGTH) throw new Error(`${name}_TOO_SHORT`);
  return value;
}

export function createDeterministicLocalPipeline({ settings, initialSequences, publisher, onHostEvent, now = Date.now }) {
  if (settings.sessionType !== "meeting"
    || settings.outputMode !== "captions"
    || settings.languages.length !== 2
    || !settings.languages.includes("ko")
    || !settings.languages.includes("en")) {
    throw new Error("LOCAL_E2E_REQUIRES_MEETING_CAPTIONS_KO_EN");
  }
  const sequences = Object.fromEntries(settings.languages.map((language) => [language, initialSequences[language] ?? 0]));
  let floorSpeaker = null;
  let utteranceNumber = 0;
  let isPaused = false;
  let isClosed = false;
  let publishTail = Promise.resolve();

  const pipeline = {
    get lastSequences() { return { ...sequences }; },
    async start() {},
    async tick() {},
    setFloorSpeaker(speaker) { floorSpeaker = speaker; },
    pause() { isPaused = true; },
    resume() { isPaused = false; },
    async acceptAudio(frame) {
      if (isClosed) throw new Error("LOCAL_E2E_PIPELINE_CLOSED");
      if (isPaused || !(frame instanceof Uint8Array) || frame.byteLength === 0) return;
      const capturedSpeaker = floorSpeaker ? { ...floorSpeaker } : null;
      publishTail = publishTail.then(async () => {
        utteranceNumber += 1;
        const timestamp = new Date(now()).toISOString();
        const speakerKind = capturedSpeaker ? "participant" : "host";
        const utteranceKey = `${settings.sessionId}:local-e2e:${speakerKind}:${utteranceNumber}`;
        const koreanText = capturedSpeaker
          ? `참여자 테스트 문장 ${utteranceNumber}`
          : `호스트 테스트 문장 ${utteranceNumber}`;
        const englishText = capturedSpeaker
          ? `Participant test sentence ${utteranceNumber}`
          : `Host test sentence ${utteranceNumber}`;
        const speaker = capturedSpeaker ? localSpeakerAssignment(capturedSpeaker, timestamp) : null;
        // Alternating the deterministic source lane makes both language tabs
        // accumulate a displayable translation while keeping the source-only
        // event hidden by the same viewer rule used in production.
        const sourceLanguage = utteranceNumber % 2 === 1 ? "ko" : "en";
        const captions = [
          {
            type: "caption", seq: ++sequences.ko, sessionId: settings.sessionId, language: "ko",
            speaker, text: koreanText, isFinal: true,
            sourceText: sourceLanguage === "ko" ? null : englishText,
            sourceLanguage,
            translationStatus: sourceLanguage === "ko" ? "verbatim" : "translated",
            ...(sourceLanguage === "ko" ? { origin: "source" } : {}),
            utteranceKey,
            sourceEndedAt: timestamp, emittedAt: timestamp,
          },
          {
            type: "caption", seq: ++sequences.en, sessionId: settings.sessionId, language: "en",
            speaker, text: englishText, isFinal: true,
            sourceText: sourceLanguage === "en" ? null : koreanText,
            sourceLanguage,
            translationStatus: sourceLanguage === "en" ? "verbatim" : "translated",
            ...(sourceLanguage === "en" ? { origin: "source" } : {}),
            utteranceKey,
            sourceEndedAt: timestamp, emittedAt: timestamp,
          },
        ];
        await Promise.all(captions.map((caption) => publisher.publish(
          settings.sessionId,
          caption.language,
          caption,
          { onLiveEvent: onHostEvent },
        )));
      });
      return publishTail;
    },
    async endAudioStream() { await publishTail; },
    async close() { isClosed = true; await publishTail; },
  };
  return pipeline;
}

function localSpeakerAssignment(speaker, timestamp) {
  const participantId = String(speaker.participantId ?? "").trim();
  const displayName = String(speaker.displayName ?? "참가자").trim() || "참가자";
  return {
    speakerId: `participant:${participantId}`,
    label: displayName,
    name: displayName,
    colorToken: "speaker-teal",
    voiceName: null,
    voiceStatus: "disabled",
    lastSeenAt: timestamp,
  };
}

export function createLocalLiveCallE2eGateway(config = readLocalLiveCallE2eEnvironment()) {
  assertLocalE2eConfig(config);
  const viewerAuthorizer = new SupabaseViewerAuthorizer(config);
  const hostAuthorizer = new SupabaseHostAuthorizer(config);
  const floorController = new SupabaseFloorController(config);
  let gateway;
  const publisher = new SupabaseLivePublisher({
    ...config,
    eventFanout(sessionId, language, event) { return gateway.broadcastEvent(sessionId, language, event); },
    async audioFanout() {},
  });
  gateway = createGatewayServer({
    gatewaySecret: config.gatewaySecret,
    viewerSecret: config.viewerSecret,
    securityPolicy: Object.freeze({
      allowedOrigins: new Set(["http://127.0.0.1:3000", "http://localhost:3000"]),
      allowTrustedNonBrowser: false,
      allowLoopbackWithoutOrigin: true,
      metricsToken: "",
    }),
    viewerAuthorizer,
    hostAuthorizer,
    floorController,
    floorTakeCooldownMilliseconds: 0,
    fetchFloorParticipant: (sessionId, participantId) => floorController.getParticipant(sessionId, participantId),
    replayUtterances: (sessionId, language, afterSeq, limit, options) => publisher.fetchUtterancesAfter(
      sessionId, language, afterSeq, limit, options,
    ),
    async pipelineFactory(settings, previousPipeline, onHostEvent) {
      const persisted = await publisher.fetchLastUtteranceSeqs(settings.sessionId, settings.languages);
      const previous = previousPipeline?.lastSequences ?? {};
      const initialSequences = Object.fromEntries(settings.languages.map((language) => [
        language,
        Math.max(persisted[language] ?? 0, previous[language] ?? 0),
      ]));
      return createDeterministicLocalPipeline({ settings, initialSequences, publisher, onHostEvent });
    },
  });
  return gateway;
}

function assertLocalE2eConfig(config) {
  if (String(process.env.NODE_ENV ?? "development").trim().toLowerCase() === "production") {
    throw new Error("LOCAL_E2E_GATEWAY_FORBIDDEN_IN_PRODUCTION");
  }
  if (config.host !== LOOPBACK_HOST || parseExactLocalSupabaseUrl(config.baseUrl) !== config.baseUrl) {
    throw new Error("LOCAL_E2E_GATEWAY_LOOPBACK_REQUIRED");
  }
  if (config.gatewaySecret.length < TOKEN_SECRET_MINIMUM_LENGTH
    || config.viewerSecret.length < TOKEN_SECRET_MINIMUM_LENGTH) {
    throw new Error("LOCAL_E2E_GATEWAY_SECRET_INVALID");
  }
}

export async function startLocalLiveCallE2eGateway(environment = process.env) {
  const config = readLocalLiveCallE2eEnvironment(environment);
  const gateway = createLocalLiveCallE2eGateway(config);
  await new Promise((resolve, reject) => {
    gateway.server.once("error", reject);
    gateway.server.listen(config.port, config.host, () => {
      gateway.server.removeListener("error", reject);
      resolve();
    });
  });
  return { gateway, config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLocalLiveCallE2eGateway().then(({ gateway, config }) => {
    process.stdout.write(`TEST-ONLY local Live Call gateway listening on http://${config.host}:${config.port}\n`);
    const shutdown = async () => {
      await gateway.close();
      process.exitCode = 0;
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "LOCAL_E2E_GATEWAY_START_FAILED"}\n`);
    process.exitCode = 1;
  });
}
