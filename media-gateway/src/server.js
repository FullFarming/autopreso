import { pathToFileURL } from "node:url";

import { createGeminiCaptionConfig, geminiCaptionConfigFingerprint } from "../../packages/caption-core/index.js";
import { createCaptionPolisher } from "./caption-polish.js";
import { buildGlossaryInstruction } from "./glossary-packs.js";
import { readGatewayEnvironment } from "./config.js";
import { createGatewayServer } from "./gateway-server.js";
import {
  CloudSpeechToTextAdapter,
  GeminiLiveTranslateAdapter,
  GeminiTextTranslateAdapter,
} from "./google-provider-adapters.js";
import { LiveMediaPipeline } from "./live-media-pipeline.js";
import { SupabaseFloorController, SupabaseHostAuthorizer, SupabaseLivePublisher, SupabaseViewerAuthorizer } from "./supabase-adapters.js";

export function listenMediaGateway(server, config) {
  return new Promise((resolve) => server.listen(config.port, config.host, resolve));
}

export function createCaptionPolishPolicyResolver({
  defaultPolicy = "selective",
  policyWeights = { off: 0, selective: 10_000, full: 0 },
} = {}) {
  const policies = new Set(["off", "selective", "full"]);
  if (!policies.has(defaultPolicy)) throw new Error("INVALID_CAPTION_POLISH_POLICY");
  const weights = Object.fromEntries([...policies].map((policy) => [policy, policyWeights?.[policy]]));
  if (Object.values(weights).some((value) => !Number.isInteger(value) || value < 0 || value > 10_000)
    || Object.values(weights).reduce((sum, value) => sum + value, 0) > 10_000) {
    throw new Error("INVALID_CAPTION_POLISH_CANARY");
  }
  return (sessionId) => {
    let hash = 2_166_136_261;
    for (const character of String(sessionId)) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    const bucket = hash % 10_000;
    let upperBound = 0;
    for (const policy of ["off", "selective", "full"]) {
      upperBound += weights[policy];
      if (bucket < upperBound) return policy;
    }
    return defaultPolicy;
  };
}

export async function startMediaGateway(config = readGatewayEnvironment()) {
  const [{ GoogleGenAI }, speechModule] = await Promise.all([
    import("@google/genai"),
    import("@google-cloud/speech"),
  ]);
  const geminiClient = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const speechClient = new speechModule.v1.SpeechClient();
  const viewerAuthorizer = new SupabaseViewerAuthorizer(config);
  const hostAuthorizer = new SupabaseHostAuthorizer(config);
  let gateway;
  const publisher = new SupabaseLivePublisher({
    ...config,
    eventFanout(sessionId, language, event) { return gateway.broadcastEvent(sessionId, language, event); },
    audioFanout(sessionId, language, frame) { return gateway.broadcastAudio(sessionId, language, frame); },
  });
  const floorController = new SupabaseFloorController(config);
  const resolveCaptionPolishPolicy = createCaptionPolishPolicyResolver({
    defaultPolicy: "selective",
    policyWeights: config.captionPolishPolicyWeights,
  });
  gateway = createGatewayServer({
    gatewaySecret: config.gatewaySecret,
    viewerSecret: config.viewerSecret,
    hostAuthorizer,
    viewerAuthorizer,
    floorController,
    hostReconnectGraceMilliseconds: config.hostReconnectGraceMilliseconds,
    fetchFloorParticipant: (sessionId, participantId) => floorController.getParticipant(sessionId, participantId),
    replayUtterances: (sessionId, language, afterSeq, limit, options) => publisher.fetchUtterancesAfter(sessionId, language, afterSeq, limit, options),
    async pipelineFactory(message, previousPipeline, onHostEvent, options = {}) {
      // Per-language caption seq survives host reconnects and process
      // restarts. Durable-failure recovery is stricter: the failed final has
      // already consumed an in-memory seq but its commit outcome is unknown,
      // so only the reconciled durable max may seed the replacement.
      const initialSequences = await resolvePipelineInitialSequences({
        publisher,
        message,
        previousPipeline,
        recoveryReason: options.recoveryReason,
        signal: options.signal,
      });
      const captionPolishPolicy = resolveCaptionPolishPolicy(message.sessionId);
      const captionConfig = createGeminiCaptionConfig({
        ...(message.captionConfig ?? {
          glossaryText: message.glossaryText,
          glossaryPack: message.glossaryPack,
          domainText: message.domainText,
          translationTone: message.translationTone,
          languages: message.languages,
          outputMode: message.outputMode,
        }),
        captionPolishPolicy,
      });
      return new LiveMediaPipeline({
        sessionId: message.sessionId,
        sessionType: message.sessionType,
        outputMode: message.outputMode,
        voiceProvider: message.voiceProvider,
        maxViewers: message.maxViewers,
        glossaryPack: message.glossaryPack,
        glossaryText: message.glossaryText,
        translationTone: message.translationTone,
        domainText: message.domainText,
        captionConfig,
        captionConfigFingerprint: geminiCaptionConfigFingerprint(captionConfig),
        audioLanguage: captionConfig.audioLanguage,
        languages: message.languages,
        captionPolishPolicy,
        speakerRegistry: previousPipeline?.speakers,
        initialSequences,
        getSubscriberCount: (language) => gateway.subscriberCount(message.sessionId, language),
        observeLatency: (name, value) => gateway.metrics.observe(name, value),
        onHostEvent,
        onFatalError: options.onFatalError,
        dependencies: {
          liveTranslate: new GeminiLiveTranslateAdapter({
            client: geminiClient,
            model: captionConfig.models.live ?? config.geminiLiveModel,
            finalFlushMilliseconds: captionConfig.streamingPolicy.commitSilenceMilliseconds,
          }),
          speechToText: new CloudSpeechToTextAdapter({ client: speechClient, projectId: config.projectId, languageCodes: config.sttLanguageCodes }),
          // Finals use Gemini Flash, with no alternate translation engine.
          textTranslate: new GeminiTextTranslateAdapter({
            client: geminiClient,
            model: captionConfig.models.polish ?? config.geminiTextModel,
          }),
          // 2026-07-26 fix: Match the desktop caption finalizer's six-second
          // quality budget. Live audio has a separate callback tail, so a slow
          // caption polish cannot delay interpreted audio playback.
          captionPolish: createCaptionPolisher({
            client: geminiClient,
            model: captionConfig.models.polish ?? config.geminiTextModel,
            timeoutMs: 6_000,
            // CRE is the product default, so it is the standing domain
            // instruction rather than a pack nothing reads.
            defaultDomain: buildGlossaryInstruction("general_cre"),
          }),
          publisher,
        },
      });
    },
  });
  await listenMediaGateway(gateway.server, config);
  return gateway;
}

export async function resolvePipelineInitialSequences({
  publisher,
  message,
  previousPipeline = null,
  recoveryReason = null,
  signal = null,
}) {
  const isDurableRecovery = recoveryReason === "durable-caption";
  const initialSequences = isDurableRecovery ? {} : { ...(previousPipeline?.lastSequences ?? {}) };
  try {
    const persisted = isDurableRecovery
      ? Object.fromEntries(await Promise.all(message.languages.map(async (language) => [
        language,
        await publisher.reconcileCaptionLane(message.sessionId, language, { signal }),
      ])))
      : await publisher.fetchLastUtteranceSeqs(message.sessionId, message.languages);
    for (const language of message.languages) {
      const rawPersistedSequence = persisted?.[language];
      if (isDurableRecovery
        && (!Object.hasOwn(persisted ?? {}, language)
          || !Number.isSafeInteger(rawPersistedSequence)
          || rawPersistedSequence < 0)) {
        throw new Error("DURABLE_CAPTION_RECOVERY_SEED_INVALID");
      }
      const persistedSequence = Number(rawPersistedSequence ?? 0);
      const durableSequence = Number.isSafeInteger(persistedSequence) && persistedSequence >= 0
        ? persistedSequence
        : 0;
      initialSequences[language] = isDurableRecovery
        ? durableSequence
        : Math.max(initialSequences[language] ?? 0, durableSequence);
    }
  } catch (error) {
    if (isDurableRecovery) {
      if (error instanceof Error && error.message === "DURABLE_CAPTION_RECOVERY_SEED_INVALID") throw error;
      throw new Error("DURABLE_CAPTION_RECOVERY_SEED_FAILED", { cause: error });
    }
    // Ordinary settings updates preserve the prior in-memory counters when
    // the read is unavailable; they do not follow an ambiguous failed commit.
  }
  return initialSequences;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMediaGateway().then(() => {
    process.stdout.write("Realtime Noel media gateway listening\n");
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "미디어 게이트웨이를 시작하지 못했습니다."}\n`);
    process.exitCode = 1;
  });
}
