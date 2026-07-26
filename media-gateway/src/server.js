import { pathToFileURL } from "node:url";

import { createCaptionPolisher } from "./caption-polish.js";
import { buildGlossaryInstruction } from "./glossary-packs.js";
import { readGatewayEnvironment } from "./config.js";
import { createGatewayServer } from "./gateway-server.js";
import {
  ChirpTextToSpeechAdapter,
  CloudSpeechToTextAdapter,
  CloudTranslationAdvancedAdapter,
  GeminiLiveTranslateAdapter,
  GeminiTextTranslateAdapter,
} from "./google-provider-adapters.js";
import { LiveMediaPipeline } from "./live-media-pipeline.js";
import { OpenAIRealtimeTranslationAdapter, OpenAITextToSpeechAdapter } from "./openai-realtime-translation.js";
import { SupabaseFloorController, SupabaseHostAuthorizer, SupabaseLivePublisher, SupabaseViewerAuthorizer } from "./supabase-adapters.js";

export function resolveTextToSpeechV1Client(textToSpeechModule) {
  const TextToSpeechClient = textToSpeechModule.v1?.TextToSpeechClient
    ?? textToSpeechModule.default?.v1?.TextToSpeechClient;
  if (!TextToSpeechClient) throw new Error("TTS_V1_CLIENT_UNAVAILABLE");
  return TextToSpeechClient;
}

export function listenMediaGateway(server, config) {
  return new Promise((resolve) => server.listen(config.port, config.host, resolve));
}

export async function startMediaGateway(config = readGatewayEnvironment()) {
  const [{ GoogleGenAI }, speechModule, textToSpeechModule, translateModule] = await Promise.all([
    import("@google/genai"),
    import("@google-cloud/speech"),
    import("@google-cloud/text-to-speech"),
    import("@google-cloud/translate"),
  ]);
  const geminiClient = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const speechClient = new speechModule.v1.SpeechClient();
  const TextToSpeechClient = resolveTextToSpeechV1Client(textToSpeechModule);
  const textToSpeechClient = new TextToSpeechClient();
  const TranslationServiceClient = translateModule.v3?.TranslationServiceClient
    ?? translateModule.default?.v3?.TranslationServiceClient;
  if (!TranslationServiceClient) throw new Error("TRANSLATION_V3_CLIENT_UNAVAILABLE");
  const translationClient = new TranslationServiceClient();
  const viewerAuthorizer = new SupabaseViewerAuthorizer(config);
  const hostAuthorizer = new SupabaseHostAuthorizer(config);
  let gateway;
  const publisher = new SupabaseLivePublisher({
    ...config,
    eventFanout(sessionId, language, event) { return gateway.broadcastEvent(sessionId, language, event); },
    audioFanout(sessionId, language, frame) { return gateway.broadcastAudio(sessionId, language, frame); },
  });
  const floorController = new SupabaseFloorController(config);
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
        languages: message.languages,
        speakerRegistry: previousPipeline?.speakers,
        initialSequences,
        getSubscriberCount: (language) => gateway.subscriberCount(message.sessionId, language),
        observeLatency: (name, value) => gateway.metrics.observe(name, value),
        onHostEvent,
        onFatalError: options.onFatalError,
        dependencies: {
          liveTranslate: new GeminiLiveTranslateAdapter({ client: geminiClient, model: config.geminiLiveModel }),
          openaiLiveTranslate: new OpenAIRealtimeTranslationAdapter({ apiKey: config.openaiApiKey, model: config.openaiRealtimeTranslateModel }),
          speechToText: new CloudSpeechToTextAdapter({ client: speechClient, projectId: config.projectId, languageCodes: config.sttLanguageCodes }),
          // Finals through Gemini Flash (desktop-pipeline tone parity); every
          // partial and any Gemini failure routes to Cloud Translate.
          textTranslate: new GeminiTextTranslateAdapter({
            client: geminiClient,
            model: config.geminiTextModel,
            fallback: new CloudTranslationAdvancedAdapter({ client: translationClient, projectId: config.projectId }),
          }),
          // Confirmed provider split: captions = Gemini 3.5, voice = OpenAI.
          // Meeting/townhall TTS speaks through OpenAI with Chirp as the
          // never-silent fallback; presentation voice is unaffected (it uses
          // the live-translate audio path above).
          // 2026-07-26 fix: Match the desktop caption finalizer's six-second
          // quality budget. Live audio has a separate callback tail, so a slow
          // caption polish cannot delay interpreted audio playback.
          captionPolish: createCaptionPolisher({
            client: geminiClient,
            model: config.geminiTextModel,
            timeoutMs: 6_000,
            // CRE is the product default, so it is the standing domain
            // instruction rather than a pack nothing reads.
            defaultDomain: buildGlossaryInstruction("general_cre"),
          }),
          textToSpeech: message.sessionType === "presentation"
            ? new ChirpTextToSpeechAdapter({ client: textToSpeechClient })
            : new OpenAITextToSpeechAdapter({
              apiKey: config.openaiApiKey,
              fallback: new ChirpTextToSpeechAdapter({ client: textToSpeechClient }),
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
