import { pathToFileURL } from "node:url";

import { readGatewayEnvironment } from "./config.js";
import { createGatewayServer } from "./gateway-server.js";
import {
  ChirpTextToSpeechAdapter,
  CloudSpeechToTextAdapter,
  CloudTranslationAdvancedAdapter,
  GeminiLiveTranslateAdapter,
} from "./google-provider-adapters.js";
import { LiveMediaPipeline } from "./live-media-pipeline.js";
import { OpenAIRealtimeTranslationAdapter } from "./openai-realtime-translation.js";
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
  gateway = createGatewayServer({
    gatewaySecret: config.gatewaySecret,
    viewerSecret: config.viewerSecret,
    hostAuthorizer,
    viewerAuthorizer,
    floorController: new SupabaseFloorController(config),
    async pipelineFactory(message, previousPipeline, onHostEvent) {
      return new LiveMediaPipeline({
        sessionId: message.sessionId,
        sessionType: message.sessionType,
        outputMode: message.outputMode,
        voiceProvider: message.voiceProvider,
        maxViewers: message.maxViewers,
        glossaryPack: message.glossaryPack,
        languages: message.languages,
        speakerRegistry: previousPipeline?.speakers,
        initialSequence: previousPipeline?.lastSequence ?? 0,
        onHostEvent,
        dependencies: {
          liveTranslate: new GeminiLiveTranslateAdapter({ client: geminiClient, model: config.geminiLiveModel }),
          openaiLiveTranslate: new OpenAIRealtimeTranslationAdapter({ apiKey: config.openaiApiKey }),
          speechToText: new CloudSpeechToTextAdapter({ client: speechClient, projectId: config.projectId, languageCodes: config.sttLanguageCodes }),
          textTranslate: new CloudTranslationAdvancedAdapter({ client: translationClient, projectId: config.projectId }),
          textToSpeech: new ChirpTextToSpeechAdapter({ client: textToSpeechClient }),
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
