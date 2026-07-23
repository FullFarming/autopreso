import { readFile } from "node:fs/promises";

import { v1 as speechV1 } from "@google-cloud/speech";
import { v1 as textToSpeechV1 } from "@google-cloud/text-to-speech";
import { v3 as translateV3 } from "@google-cloud/translate";

import {
  ChirpTextToSpeechAdapter,
  CloudSpeechToTextAdapter,
  CloudTranslationAdvancedAdapter,
} from "../src/google-provider-adapters.js";

const MAX_AUDIO_MILLISECONDS = 60_000;
const FRAME_BYTES = 1_280;

assertDevelopmentGate(process.env);
const pcmPath = String(process.env.QUALITY_PCM16_PATH ?? "").trim();
if (!pcmPath) throw new Error("QUALITY_PCM16_PATH_REQUIRED");
const pcm = new Uint8Array(await readFile(pcmPath));
if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) throw new Error("QUALITY_PCM16_INVALID");
const audioMilliseconds = pcm.byteLength / (16_000 * 2) * 1_000;
if (audioMilliseconds > MAX_AUDIO_MILLISECONDS) throw new Error("QUALITY_PCM16_EXCEEDS_60S");

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const sourceLanguage = String(process.env.QUALITY_SOURCE_LANGUAGE ?? "ko-KR");
const targetLanguage = String(process.env.QUALITY_TARGET_LANGUAGE ?? "en");
const diarization = String(process.env.QUALITY_DIARIZATION ?? "true") !== "false";
const speechClient = new speechV1.SpeechClient();
const translationClient = new translateV3.TranslationServiceClient();
const textToSpeechClient = new textToSpeechV1.TextToSpeechClient();
const speech = new CloudSpeechToTextAdapter({ client: speechClient, projectId, languageCodes: [sourceLanguage], diarization });
const translation = new CloudTranslationAdvancedAdapter({ client: translationClient, projectId });
const tts = new ChirpTextToSpeechAdapter({ client: textToSpeechClient });
const metrics = {
  audioMilliseconds,
  diarization,
  utterances: 0,
  translated: 0,
  completedTts: 0,
  ttsBytes: 0,
  peakBacklogUtterances: 0,
  duplicateSourceRanges: 0,
  continuityDiscardCount: 0,
  backlogAtInputEnd: 0,
  firstUtteranceMilliseconds: null,
  firstTranslationMilliseconds: null,
  firstTtsAudioMilliseconds: null,
  inputElapsedMilliseconds: 0,
  drainMilliseconds: 0,
  elapsedMilliseconds: 0,
  code: "OK",
};
const sourceRanges = new Set();
const startedAt = Date.now();
const providerAbortController = new AbortController();
const deadline = AbortSignal.any([AbortSignal.timeout(120_000), providerAbortController.signal]);

try {
  const session = await speech.open({
    onContinuityDiscard() { metrics.continuityDiscardCount += 1; },
    async onFinalUtterance(utterance) {
      const sourceRange = `${utterance.sourceStartOffsetMs}:${utterance.sourceEndOffsetMs}`;
      if (sourceRanges.has(sourceRange)) metrics.duplicateSourceRanges += 1;
      else sourceRanges.add(sourceRange);
      metrics.utterances += 1;
      metrics.firstUtteranceMilliseconds ??= Date.now() - startedAt;
      metrics.peakBacklogUtterances = Math.max(metrics.peakBacklogUtterances, metrics.utterances - metrics.completedTts);
      const translated = await translation.translate({ text: utterance.text, language: targetLanguage, sourceLanguage: utterance.sourceLanguage });
      metrics.translated += 1;
      metrics.firstTranslationMilliseconds ??= Date.now() - startedAt;
      for await (const chunk of tts.synthesizeStream({
        language: targetLanguage,
        voiceName: "Achernar",
        text: translated,
        sampleRate: 24_000,
        signal: deadline,
      })) {
        metrics.firstTtsAudioMilliseconds ??= Date.now() - startedAt;
        metrics.ttsBytes += chunk.byteLength;
      }
      metrics.completedTts += 1;
    },
  });
  for (let offset = 0; offset < pcm.byteLength; offset += FRAME_BYTES) {
    if (deadline.aborted) throw deadline.reason;
    const frame = pcm.slice(offset, Math.min(offset + FRAME_BYTES, pcm.byteLength));
    if (frame.byteLength < FRAME_BYTES) {
      const padded = new Uint8Array(FRAME_BYTES);
      padded.set(frame);
      await session.sendAudio(padded);
      padded.fill(0);
    } else {
      await session.sendAudio(frame);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  metrics.inputElapsedMilliseconds = Date.now() - startedAt;
  metrics.backlogAtInputEnd = metrics.utterances - metrics.completedTts;
  const drainStartedAt = Date.now();
  const closePromise = session.close();
  let drainTimeout;
  const didDrain = await Promise.race([
    closePromise.then(() => true),
    new Promise((resolve) => { drainTimeout = setTimeout(() => resolve(false), 30_000); }),
  ]).finally(() => clearTimeout(drainTimeout));
  metrics.drainMilliseconds = Date.now() - drainStartedAt;
  if (!didDrain) {
    providerAbortController.abort(new Error("QUALITY_BACKLOG_EXCEEDED"));
    let abortDrainTimeout;
    await Promise.race([
      closePromise,
      new Promise((resolve) => { abortDrainTimeout = setTimeout(resolve, 5_000); }),
    ]).finally(() => clearTimeout(abortDrainTimeout));
    throw new Error("QUALITY_BACKLOG_EXCEEDED");
  }
  if (metrics.utterances === 0) metrics.code = "NO_STABLE_UTTERANCE";
  else if (metrics.duplicateSourceRanges > 0) metrics.code = "QUALITY_DUPLICATE_OUTPUT";
  else if (metrics.completedTts === 0) metrics.code = "QUALITY_NO_TTS_OUTPUT";
  else if (!diarization && Number(metrics.firstTtsAudioMilliseconds) >= 5_000) metrics.code = "QUALITY_FIRST_OUTPUT_SLOW";
  if (metrics.code !== "OK") process.exitCode = 1;
} catch (error) {
  metrics.code = normalizeProbeCode(error);
  if (Number.isInteger(error?.providerStatusCode)) metrics.grpcStatus = error.providerStatusCode;
  if (typeof error?.providerReason === "string") metrics.reason = error.providerReason;
  process.exitCode = 1;
} finally {
  providerAbortController.abort(new Error("QUALITY_PROBE_COMPLETE"));
  await Promise.allSettled([
    speechClient.close(),
    translationClient.close(),
    textToSpeechClient.close(),
  ]);
  pcm.fill(0);
  metrics.elapsedMilliseconds = Date.now() - startedAt;
  process.stdout.write(`${JSON.stringify(metrics)}\n`);
}

function assertDevelopmentGate(environment) {
  if (environment.LIVE_EXTERNAL_ENV !== "development") throw new Error("QUALITY_DEVELOPMENT_ONLY");
  if (!environment.GOOGLE_CLOUD_PROJECT || environment.GOOGLE_CLOUD_PROJECT !== environment.LIVE_ALLOWED_GCP_PROJECT) {
    throw new Error("QUALITY_PROJECT_NOT_ALLOWED");
  }
  if (environment.RUN_LIVE_QUALITY_PROBE !== "I_UNDERSTAND_DEVELOPMENT_ONLY") {
    throw new Error("QUALITY_EXPLICIT_GATE_REQUIRED");
  }
}

function normalizeProbeCode(error) {
  const message = error instanceof Error ? error.message : "QUALITY_PROVIDER_FAILED";
  return /^[A-Z][A-Z0-9_]{2,80}$/u.test(message) ? message : "QUALITY_PROVIDER_FAILED";
}
