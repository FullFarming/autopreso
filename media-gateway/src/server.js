import { pathToFileURL } from "node:url";

import { createCaptionPolisher } from "./caption-polish.js";
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
    replayUtterances: (sessionId, language, afterSeq, limit) => publisher.fetchUtterancesAfter(sessionId, language, afterSeq, limit),
    async pipelineFactory(message, previousPipeline, onHostEvent) {
      // Per-language caption seq survives host reconnects and process
      // restarts: seed from persisted max(seq), best-effort, and never go
      // backwards relative to the previous in-memory pipeline (contract C1).
      const initialSequences = { ...(previousPipeline?.lastSequences ?? {}) };
      try {
        const persisted = await publisher.fetchLastUtteranceSeqs(message.sessionId, message.languages);
        for (const [language, seq] of Object.entries(persisted)) {
          initialSequences[language] = Math.max(initialSequences[language] ?? 0, seq);
        }
      } catch {
        // Best-effort: fall back to the previous pipeline counters (or 0).
      }
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
          // Desktop-parity second-pass finalizer for committed captions.
          // 1.5s matches the desktop finalizer's ceiling. The 4s default was
          // set when polish blocked the provider callback chain, where every
          // extra second also delayed interpreted AUDIO playout.
          captionPolish: createCaptionPolisher({ client: geminiClient, model: config.geminiTextModel, timeoutMs: 1_500 }),
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
  await new Promise((resolve) => gateway.server.listen(config.port, "0.0.0.0", resolve));
  return gateway;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMediaGateway().then(() => {
    process.stdout.write("Realtime Noel media gateway listening\n");
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "미디어 게이트웨이를 시작하지 못했습니다."}\n`);
    process.exitCode = 1;
  });
}
