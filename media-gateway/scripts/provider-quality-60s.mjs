import { pathToFileURL } from "node:url";

import {
  createCommittedCaptionFinalizer,
  createGeminiCaptionConfig,
  geminiCaptionConfigFingerprint,
  GEMINI_WORKLOAD_MODEL_MATRIX,
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
    translatedText: "쿠시먼앤드웨이크필드는 노엘을 사용합니다.",
    requiredTerms: Object.freeze(["쿠시먼앤드웨이크필드", "노엘"]),
  }),
  Object.freeze({
    sourceLanguage: "ko",
    targetLanguage: "en",
    sourceText: "쿠시먼앤드웨이크필드는 노엘을 사용합니다.",
    translatedText: "Cushman & Wakefield uses NOEL.",
    requiredTerms: Object.freeze(["Cushman & Wakefield", "NOEL"]),
  }),
]);

/**
 * Runs a 60-second-equivalent, no-network caption contract check. Provider
 * results are injected so CI validates Transcribe Live -> Gemini text
 * translation -> terminology repair without credentials or quota use.
 */
export async function runGeminiCaptionQualityCheck() {
  const config = createGeminiCaptionConfig({
    translationLanguages: ["en", "ko"],
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

  const liveMetrics = await runLiveCaptionCheck(config, utteranceCount);
  const metrics = Object.freeze({
    code: "OK",
    provider: config.provider,
    transcriptionModel: config.models.transcription,
    textModel: config.models.polish,
    configFingerprint: geminiCaptionConfigFingerprint(config),
    simulatedAudioMilliseconds: SIMULATED_AUDIO_MILLISECONDS,
    utterances: utteranceCount,
    finalized,
    polishCalls,
    bidirectionalDirections: config.directions.length,
    ...liveMetrics,
  });
  if (metrics.provider !== "gemini") throw new Error("QUALITY_NON_GEMINI_PROVIDER");
  if (metrics.transcriptionModel !== GEMINI_WORKLOAD_MODEL_MATRIX.transcription
    || metrics.textModel !== GEMINI_WORKLOAD_MODEL_MATRIX.translation) {
    throw new Error("QUALITY_MODEL_MATRIX_MISMATCH");
  }
  if (metrics.finalized !== utteranceCount || metrics.polishCalls !== utteranceCount) {
    throw new Error("QUALITY_FINALIZER_INCOMPLETE");
  }
  if (metrics.committedCaptions !== utteranceCount * config.languages.length
    || metrics.translatedCaptions !== utteranceCount) {
    throw new Error("QUALITY_CAPTION_ROUTING_FAILED");
  }
  return metrics;
}

async function runLiveCaptionCheck(config, utteranceCount) {
  const published = [];
  let transcriptionSessions = 0;
  let sourceSequence = 0;
  const pipeline = new LiveMediaPipeline({
    sessionId: "gemini-quality-fixture",
    sessionType: "meeting",
    languages: config.languages,
    captionConfig: config,
    captionConfigFingerprint: geminiCaptionConfigFingerprint(config),
    dependencies: {
      speechToText: {
        async open() {
          transcriptionSessions += 1;
          return {
            async sendAudio() {},
            async close() {},
          };
        },
      },
      textTranslate: {
        async translate({ text, language }) {
          const qualityCase = QUALITY_CASES.find((entry) => entry.sourceText === text && entry.targetLanguage === language);
          if (!qualityCase) throw new Error("QUALITY_TRANSLATION_FIXTURE_MISSING");
          return qualityCase.translatedText;
        },
      },
      captionPolish: { async polish({ translatedText }) { return translatedText; } },
      publisher: {
        async markLive() {},
        async persistAuthoritativeSource() {
          sourceSequence += 1;
          return { sourceUtteranceId: `source-${sourceSequence}`, sourceSeq: sourceSequence, idempotent: false };
        },
        async publish(_sessionId, _language, event) {
          published.push(event);
        },
      },
    },
  });
  await pipeline.start();
  try {
    for (let index = 0; index < utteranceCount; index += 1) {
      const qualityCase = QUALITY_CASES[index % QUALITY_CASES.length];
      await pipeline.acceptFinalUtterance({
        speakerLabel: "Host",
        text: qualityCase.sourceText,
        sourceLanguage: qualityCase.sourceLanguage,
        sourceStartOffsetMs: index * UTTERANCE_MILLISECONDS,
        sourceEndOffsetMs: (index + 1) * UTTERANCE_MILLISECONDS,
        sourceEndedAt: new Date(index * UTTERANCE_MILLISECONDS).toISOString(),
      });
    }
  } finally {
    await pipeline.close();
  }
  const committed = published.filter((event) => event.type === "caption" && event.isFinal === true);
  return {
    transcriptionSessions,
    committedCaptions: committed.length,
    translatedCaptions: committed.filter((event) => event.translationStatus === "translated").length,
  };
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
