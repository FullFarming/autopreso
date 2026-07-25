// Gemini Live API transport for realtime subtitle translation
// (gemini-3.5-live-translate-preview, public preview 2026-06).
//
// The Live API takes PCM16 mono 16 kHz input while our capture pipeline
// delivers 24 kHz, so audio payloads are resampled here. Gemini's translated
// PCM16 mono 24 kHz output is forwarded only after strict envelope validation.

import { isSupportedSubtitleLanguage, toGeminiLanguageCode } from "./subtitle-languages.js";

// 2026-07-23 fix: the translate-preview model accepts setup on v1beta but
// closes with 1007 "Request contains an invalid argument" on the FIRST audio
// chunk. Live-probed: only the v1alpha endpoint keeps the session alive
// (matching the official SDK, which speaks v1alpha for the Live API).
const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-live-translate-preview";
const INPUT_SAMPLE_RATE = 24000;
const GEMINI_SAMPLE_RATE = 16000;
const TRANSLATED_AUDIO_SAMPLE_RATE = 24000;
const TRANSLATED_AUDIO_MIME_TYPE = "audio/pcm;rate=24000";
const MAX_TRANSLATED_AUDIO_BYTES = 256 * 1024;
const GEMINI_RESAMPLER_TAPS = 129;
const GEMINI_RESAMPLER_HALF_LENGTH = (GEMINI_RESAMPLER_TAPS - 1) / 2;
const GEMINI_RESAMPLER_CUTOFF_HZ = 7_200;

function decodeTranslatedAudio(inlineData) {
  if (!inlineData || typeof inlineData !== "object") return null;
  if (inlineData.mimeType !== TRANSLATED_AUDIO_MIME_TYPE) return null;
  const data = inlineData.data;
  if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return null;
  const pcm = Buffer.from(data, "base64");
  if (pcm.length === 0 || pcm.length % 2 !== 0 || pcm.length > MAX_TRANSLATED_AUDIO_BYTES) return null;
  if (pcm.toString("base64") !== data) return null;
  let isSilent = true;
  for (const byte of pcm) {
    if (byte === 0) continue;
    isSilent = false;
    break;
  }
  return { audio: data, isSilent };
}

function sanitizeGeminiErrorDetail(value) {
  return String(value ?? "")
    .replace(/(?:AIza|sk-)[A-Za-z0-9_-]+/g, "[redacted-secret]")
    .replace(/[A-Za-z0-9+/]{64,}={0,2}/g, "[redacted-data]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 240);
}

/**
 * Linear-interpolation resampler for base64 PCM16 mono audio.
 * @param {string} base64
 * @param {number} fromRate
 * @param {number} toRate
 */
export function resamplePcm16Base64(base64, fromRate, toRate) {
  if (fromRate === toRate) return base64;
  const input = Buffer.from(base64, "base64");
  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples === 0) return base64;
  const outputSamples = Math.max(1, Math.floor((inputSamples * toRate) / fromRate));
  const output = Buffer.alloc(outputSamples * 2);
  // Fixed rate-ratio stepping (not endpoint-aligned): streamed chunks must
  // keep a constant phase across chunk boundaries or the audio drifts.
  const step = fromRate / toRate;
  for (let i = 0; i < outputSamples; i += 1) {
    const position = i * step;
    const index = Math.floor(position);
    const fraction = position - index;
    const current = input.readInt16LE(index * 2);
    const next = index + 1 < inputSamples ? input.readInt16LE((index + 1) * 2) : current;
    output.writeInt16LE(Math.round(current + (next - current) * fraction), i * 2);
  }
  return output.toString("base64");
}

function sinc(value) {
  if (Math.abs(value) < Number.EPSILON) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

function createResamplerKernel(fraction) {
  const cutoff = GEMINI_RESAMPLER_CUTOFF_HZ / INPUT_SAMPLE_RATE;
  const firstOffset = Math.ceil(fraction - GEMINI_RESAMPLER_HALF_LENGTH);
  const lastOffset = Math.floor(fraction + GEMINI_RESAMPLER_HALF_LENGTH);
  const weights = [];
  let weightSum = 0;
  for (let offset = firstOffset; offset <= lastOffset; offset += 1) {
    const distance = offset - fraction;
    const window = 0.42
      + 0.5 * Math.cos((Math.PI * distance) / GEMINI_RESAMPLER_HALF_LENGTH)
      + 0.08 * Math.cos((2 * Math.PI * distance) / GEMINI_RESAMPLER_HALF_LENGTH);
    const weight = 2 * cutoff * sinc(2 * cutoff * distance) * window;
    weights.push({ offset, weight });
    weightSum += weight;
  }
  return weights.map(({ offset, weight }) => ({ offset, weight: weight / weightSum }));
}

function createGeminiInputResampler() {
  const kernels = [createResamplerKernel(0), createResamplerKernel(0.5)];
  let history = new Int16Array(0);
  let inputSampleOffset = 0;
  let nextOutputPosition = 0;

  return function downsample(base64) {
    const inputBuffer = Buffer.from(base64, "base64");
    const input = new Int16Array(Math.floor(inputBuffer.length / 2));
    for (let index = 0; index < input.length; index += 1) input[index] = inputBuffer.readInt16LE(index * 2);
    if (input.length === 0) return base64;

    const combined = new Int16Array(history.length + input.length);
    combined.set(history);
    combined.set(input, history.length);
    const combinedOffset = inputSampleOffset - history.length;
    const inputEnd = inputSampleOffset + input.length;
    const output = [];

    while (Math.floor(nextOutputPosition) < inputEnd) {
      const delayedCenter = nextOutputPosition - GEMINI_RESAMPLER_HALF_LENGTH;
      const centerIndex = Math.floor(delayedCenter);
      const fraction = delayedCenter - centerIndex;
      const kernel = fraction < 0.25 ? kernels[0] : kernels[1];
      let sample = 0;
      for (const { offset, weight } of kernel) {
        const combinedIndex = centerIndex + offset - combinedOffset;
        if (combinedIndex >= 0 && combinedIndex < combined.length) sample += combined[combinedIndex] * weight;
      }
      output.push(Math.max(-32_768, Math.min(32_767, Math.round(sample))));
      nextOutputPosition += INPUT_SAMPLE_RATE / GEMINI_SAMPLE_RATE;
    }

    const historyLength = Math.min(GEMINI_RESAMPLER_TAPS - 1, combined.length);
    history = combined.slice(combined.length - historyLength);
    inputSampleOffset = inputEnd;
    const outputBuffer = Buffer.alloc(output.length * 2);
    output.forEach((sample, index) => outputBuffer.writeInt16LE(sample, index * 2));
    return outputBuffer.toString("base64");
  };
}

/** @param {any} settings @param {string} targetLanguage @param {string|null} resumptionHandle */
export function buildGeminiSetupMessage(settings = {}, targetLanguage = "ko", resumptionHandle = null) {
  const model = typeof settings.geminiModel === "string" && settings.geminiModel.trim()
    ? settings.geminiModel.trim()
    : DEFAULT_GEMINI_MODEL;
  // 2026-06-19 fix: the raw WebSocket endpoint rejects transcription toggles
  // inside generationConfig even though the docs show that shape. Live-probed
  // accepted shape: transcription toggles at setup level, translationConfig in
  // generationConfig.
  return JSON.stringify({
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: {
          targetLanguageCode: toGeminiLanguageCode(targetLanguage),
          // Same-language input should stay silent on this channel; the
          // opposite-direction channel renders it. Mirrors the OpenAI dual
          // target-channel routing.
          echoTargetLanguage: false,
        },
      },
      realtimeInputConfig: {
        automaticActivityDetection: {
          // Faster word/segment separation: a shorter end-of-speech silence
          // window finalizes each utterance sooner without clipping mid-word.
          prefixPaddingMs: 100,
          silenceDurationMs: 450,
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // 2026-07-20 fix: gemini-3.5-live-translate-preview is a translation-only
      // pipeline and does not support instructions. Glossary enforcement stays
      // in the deterministic/second-pass subtitle layer after transcription.
      // Hours-long sessions (ai.google.dev/gemini-api/docs/live-session): audio
      // sessions hard-cap at ~15 min and the connection lifetime is ~10 min.
      // Sliding-window context compression removes the abrupt duration cap, and
      // session resumption lets a dropped connection continue the SAME logical
      // session via the server-issued handle — together they keep subtitles
      // running for hours instead of cutting off mid-meeting.
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {},
    },
  });
}

// Official Live API contract (ai.google.dev/api/live): transcription messages
// are "sent independently of the other server messages" with NO guaranteed
// ordering, and the client ACCUMULATES the fragments. Some model versions send
// incremental fragments, others a growing cumulative snapshot. This merge
// handles both WITHOUT ever shrinking or duplicating — which is what made
// Korean output (agglutinative, frequently revised) churn and read garbled
// while English (rarely revised) looked clean:
//   - exact duplicate                  → ignore
//   - cumulative superset (grows)      → replace (snapshot)
//   - out-of-order earlier prefix      → ignore (never shrink back)
//   - duplicate trailing fragment      → ignore
//   - genuine new increment            → append
const MAX_TRANSCRIPT_CHARS = 16_384;

function boundTranscript(value) {
  const text = String(value ?? "");
  return text.length <= MAX_TRANSCRIPT_CHARS ? text : text.slice(-MAX_TRANSCRIPT_CHARS);
}

function isSubtitleDebugEnabled(ctx = {}) {
  return ctx.debug === true || process.env.SUBTITLE_DEBUG === "1" || process.env.SUBTITLE_DEBUG === "true";
}

function mergeTranscript(accumulated, incoming) {
  const prev = String(accumulated ?? "");
  const text = String(incoming ?? "");
  if (!text) return boundTranscript(prev);
  if (!prev) return boundTranscript(text);
  if (text === prev) return boundTranscript(prev);
  if (text.startsWith(prev)) return boundTranscript(text);
  if (prev.startsWith(text)) return boundTranscript(prev);
  if (prev.endsWith(text)) return boundTranscript(prev);
  return boundTranscript(`${prev}${text}`);
}

/** @param {string|Buffer} raw @param {any} ctx */
export function handleGeminiLiveMessage(raw, ctx = {}) {
  const line = raw.toString("utf8");
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    ctx.broadcast?.({ type: "subtitle:error", message: "Invalid Gemini live message.", code: "INVALID_GEMINI_MESSAGE" });
    return;
  }

  if (message.setupComplete !== undefined) {
    // The Live API handshake: only after BidiGenerateContentSetupComplete may
    // the client stream realtimeInput. Unblocks the channel's audio buffer.
    ctx.onTransportReady?.();
    ctx.broadcast?.({ type: "subtitle:status", status: "api_ready" });
    return;
  }

  if (message.error !== undefined) {
    const detail = sanitizeGeminiErrorDetail(message.error?.message ?? message.error?.status)
      || "Unknown Gemini Live error";
    const safeStatus = sanitizeGeminiErrorDetail(message.error?.status);
    const status = safeStatus ? ` (${safeStatus})` : "";
    ctx.broadcast?.({
      type: "subtitle:error",
      message: `Gemini Live error${status}: ${detail}`,
      code: "GEMINI_LIVE_ERROR",
    });
    return;
  }

  // Server-issued resumption handle: store the latest so a reconnect can
  // continue the SAME session (context preserved) instead of starting fresh.
  if (message.sessionResumptionUpdate !== undefined) {
    const update = message.sessionResumptionUpdate;
    if (update?.resumable && update?.newHandle) ctx.setResumptionHandle?.(update.newHandle);
    return;
  }

  if (message.goAway !== undefined) {
    // The connection is about to be terminated; flag the channel to reconnect
    // (with the resumption handle) so a long session continues uninterrupted.
    ctx.broadcast?.({ type: "subtitle:status", status: "reconnecting" });
    ctx.onServerGoAway?.();
    return;
  }

  const content = message.serverContent;
  if (!content) return;

  // A barge-in/interrupt voids the in-progress generation (docs: "stop and
  // empty the current playback queue"). Drop the half-formed partial so a stale
  // fragment can't linger or merge into the next utterance.
  if (content.interrupted) {
    if (["captions_audio", "audio"].includes(ctx.outputMode)) {
      ctx.broadcast?.({
        type: "subtitle:audio-control",
        action: "clear",
        source: ctx.source,
        targetLanguage: ctx.targetLanguage,
        reason: "interrupted",
      });
      ctx.clearAudio?.();
    }
    ctx.resetUtterance?.();
    return;
  }

  const inputText = content.inputTranscription?.text;
  if (inputText && String(inputText).length <= MAX_TRANSCRIPT_CHARS) {
    if (isSubtitleDebugEnabled(ctx)) ctx.broadcast?.({ type: "subtitle:debug", channel: ctx.targetLanguage, kind: "input", languageCode: content.inputTranscription?.languageCode ?? null, text: boundTranscript(inputText) });
    const previous = String(ctx.getSourceText?.() ?? "");
    const next = mergeTranscript(previous, inputText);
    ctx.setSourceText?.(next);
    ctx.rememberSourceTranscriptDelta?.(
      next.startsWith(previous) ? next.slice(previous.length) : next,
      content.inputTranscription?.languageCode,
    );
    ctx.emitPartial?.();
  }

  if (
    ["captions_audio", "audio"].includes(ctx.outputMode)
    && ["mic", "system"].includes(ctx.source)
    && isSupportedSubtitleLanguage(ctx.targetLanguage)
    && ctx.shouldEmitAudio?.() !== false
  ) {
    for (const part of content.modelTurn?.parts ?? []) {
      const decodedAudio = decodeTranslatedAudio(part?.inlineData);
      if (!decodedAudio || decodedAudio.isSilent) continue;
      ctx.broadcast?.({
        type: "subtitle:translated-audio",
        source: ctx.source,
        targetLanguage: ctx.targetLanguage,
        sampleRate: TRANSLATED_AUDIO_SAMPLE_RATE,
        mimeType: TRANSLATED_AUDIO_MIME_TYPE,
        audio: decodedAudio.audio,
      });
    }
  }

  const outputText = content.outputTranscription?.text;
  if (outputText && String(outputText).length <= MAX_TRANSCRIPT_CHARS) {
    if (isSubtitleDebugEnabled(ctx)) ctx.broadcast?.({ type: "subtitle:debug", channel: ctx.targetLanguage, kind: "output", text: boundTranscript(outputText) });
    ctx.setTranslatedText?.(mergeTranscript(String(ctx.getTranslatedText?.() ?? ""), outputText));
    if (typeof ctx.schedulePartialFlush === "function") ctx.schedulePartialFlush();
    else ctx.emitPartial?.();
  }

  if (content.turnComplete || content.generationComplete) {
    const sourceText = String(ctx.getSourceText?.() ?? "").trim();
    const translatedText = String(ctx.getTranslatedText?.() ?? "").trim();
    const willCommit = Boolean(translatedText) && ctx.shouldDisplay?.() !== false;
    if (isSubtitleDebugEnabled(ctx)) ctx.broadcast?.({ type: "subtitle:debug", channel: ctx.targetLanguage, kind: "turnEnd", text: `commit=${willCommit} :: ${translatedText.slice(-40)}` });
    if (willCommit) {
      ctx.commitSubtitle?.({ sourceText, translatedText });
    }
    ctx.resetUtterance?.();
  }
}

/** @param {any} options */
export function createGeminiTransport({ settings = {}, targetLanguage = "ko", apiKey = "" } = {}) {
  const downsampleGeminiInput = createGeminiInputResampler();
  return {
    // The Live API rejects realtimeInput sent before setupComplete; the
    // channel must buffer audio until the ack arrives.
    requiresSetupAck: true,
    connect({ createWebSocket }) {
      const url = `${GEMINI_LIVE_URL}?key=${encodeURIComponent(apiKey)}`;
      return createWebSocket(url, undefined, {});
    },
    setupPayloads({ resumptionHandle = null } = {}) {
      return [buildGeminiSetupMessage(settings, targetLanguage, resumptionHandle)];
    },
    audioPayload(base64Pcm24k) {
      return JSON.stringify({
        realtimeInput: {
          audio: {
            data: downsampleGeminiInput(base64Pcm24k),
            mimeType: `audio/pcm;rate=${GEMINI_SAMPLE_RATE}`,
          },
        },
      });
    },
    handleMessage(raw, ctx) {
      handleGeminiLiveMessage(raw, ctx);
    },
    // No graceful close handshake in the Live API — undefined means the
    // channel closes the socket immediately.
    closePayload() {
      return undefined;
    },
  };
}
