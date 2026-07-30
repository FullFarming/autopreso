import { pathToFileURL } from "node:url";

import {
  createCommittedCaptionFinalizer,
  createGeminiCaptionConfig,
  geminiCaptionConfigFingerprint,
} from "../../packages/caption-core/index.js";
import { LiveMediaPipeline } from "../src/live-media-pipeline.js";

const SIMULATED_AUDIO_MILLISECONDS = 60_000;
const UTTERANCE_MILLISECONDS = 500;
const QUALITY_GLOSSARY = [
  "[Rules]",
  "Keep registered names exact in both directions.",
  "[Companies]",
  "Cushman & Wakefield = 쿠시먼앤드웨이크필드",
  "NOEL = 노엘",
].join("\n");
const QUALITY_CASES = Object.freeze([
  Object.freeze({
    sourceLanguage: "en",
    targetLanguage: "ko",
    sourceText: "Cushman & Wakefield uses NOEL.",
    translatedText: "쿠시먼앤웨이크필드는 노엘을 사용합니다.",
    requiredTerms: Object.freeze(["쿠시먼앤드웨이크필드", "노엘"]),
  }),
  Object.freeze({
    sourceLanguage: "ko",
    targetLanguage: "en",
    sourceText: "쿠시먼앤드웨이크필드는 노엘을 사용합니다.",
    translatedText: "Cushman and Wakefield uses NOEL.",
    requiredTerms: Object.freeze(["Cushman & Wakefield", "NOEL"]),
  }),
]);

/**
 * Runs a 60-second-equivalent, no-network Gemini caption/audio contract check.
 * It deliberately injects provider outputs: CI validates our shared engine and
 * Live callback wiring without credentials, quota use, or external side effects.
 */
export async function runGeminiCaptionQualityCheck() {
  const config = createGeminiCaptionConfig({
    translationLanguages: ["en", "ko"],
    outputMode: "captions_audio",
    audioLanguage: "en",
    glossaryPresetId: "quality-fixture",
    glossaryPresetName: "Gemini quality fixture",
    glossary: QUALITY_GLOSSARY,
    translationDomain: "Commercial real estate",
    tone: "business",
    captionPolishPolicy: "full",
  });
  let polishCalls = 0;
  const finalizer = createCommittedCaptionFinalizer({
    config,
    async polish({ translatedText }) {
      polishCalls += 1;
      return translatedText;
    },
  });
  const utteranceCount = SIMULATED_AUDIO_MILLISECONDS / UTTERANCE_MILLISECONDS;
  let finalized = 0;
  for (let index = 0; index < utteranceCount; index += 1) {
    const qualityCase = QUALITY_CASES[index % QUALITY_CASES.length];
    const result = await finalizer.finalize(qualityCase);
    if (!result || qualityCase.requiredTerms.some((term) => !result.text.includes(term))) {
      throw new Error("QUALITY_GLOSSARY_PARITY_FAILED");
    }
    finalized += 1;
  }

  const liveMetrics = await runLiveCallbackCheck(config);
  const metrics = Object.freeze({
    code: "OK",
    provider: config.provider,
    voiceProvider: config.voiceProvider,
    configFingerprint: geminiCaptionConfigFingerprint(config),
    simulatedAudioMilliseconds: SIMULATED_AUDIO_MILLISECONDS,
    utterances: utteranceCount,
    finalized,
    polishCalls,
    bidirectionalDirections: config.directions.length,
    ...liveMetrics,
  });
  if (metrics.provider !== "gemini" || metrics.voiceProvider !== "gemini") throw new Error("QUALITY_NON_GEMINI_PROVIDER");
  if (metrics.finalized !== utteranceCount || metrics.polishCalls !== utteranceCount) throw new Error("QUALITY_FINALIZER_INCOMPLETE");
  if (metrics.translatedAudioChunks !== 1 || metrics.sameLanguageAudioChunks !== 0) throw new Error("QUALITY_AUDIO_ROUTING_FAILED");
  return metrics;
}

async function runLiveCallbackCheck(config) {
  const sessions = [];
  const publishedAudioLanguages = [];
  const pipeline = new LiveMediaPipeline({
    sessionId: "gemini-quality-fixture",
    sessionType: "meeting",
    outputMode: config.outputMode,
    voiceProvider: config.voiceProvider,
    languages: config.languages,
    captionConfig: config,
    captionConfigFingerprint: geminiCaptionConfigFingerprint(config),
    dependencies: {
      liveTranslate: {
        async open(callbacks) {
          sessions.push(callbacks);
          return {
            async sendAudio() {},
            async audioStreamEnd() {},
            async close() {},
          };
        },
      },
      captionPolish: { async polish({ translatedText }) { return translatedText; } },
      publisher: {
        async markLive() {},
        async publish() {},
        async publishAudio(_sessionId, language) { publishedAudioLanguages.push(language); },
      },
    },
  });
  await pipeline.start();
  try {
    const englishLane = sessions.find((session) => session.language === "en");
    if (!englishLane) throw new Error("QUALITY_ENGLISH_LANE_MISSING");
    await englishLane.onInputObservation({
      text: "쿠시먼앤드웨이크필드는 노엘을 사용합니다.",
      languageCode: "ko",
      isFinal: true,
    });
    await englishLane.onAudio({
      pcm: new Uint8Array(480),
      sampleRate: 24_000,
      sourceLanguage: "ko",
    });
    const translatedAudioChunks = publishedAudioLanguages.length;
    await englishLane.onInputObservation({
      text: "Cushman & Wakefield uses NOEL.",
      languageCode: "en",
      isFinal: true,
    });
    await englishLane.onAudio({
      pcm: new Uint8Array(480),
      sampleRate: 24_000,
      sourceLanguage: "en",
    });
    return {
      liveSessions: sessions.length,
      translatedAudioChunks,
      sameLanguageAudioChunks: publishedAudioLanguages.length - translatedAudioChunks,
    };
  } finally {
    await pipeline.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertDevelopmentGate(process.env);
    const metrics = await runGeminiCaptionQualityCheck();
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
  } catch (error) {
    const code = normalizeProbeCode(error);
    process.stdout.write(`${JSON.stringify({ code })}\n`);
    process.exitCode = 1;
  }
}

function assertDevelopmentGate(environment) {
  if (environment.LIVE_EXTERNAL_ENV !== "development") throw new Error("QUALITY_DEVELOPMENT_ONLY");
  if (environment.RUN_LIVE_QUALITY_PROBE !== "I_UNDERSTAND_DEVELOPMENT_ONLY") {
    throw new Error("QUALITY_EXPLICIT_GATE_REQUIRED");
  }
}

function normalizeProbeCode(error) {
  const message = error instanceof Error ? error.message : "QUALITY_CHECK_FAILED";
  return /^[A-Z][A-Z0-9_]{2,80}$/u.test(message) ? message : "QUALITY_CHECK_FAILED";
}
