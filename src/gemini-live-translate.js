// Gemini Live API transport for realtime subtitle translation
// (gemini-3.5-live-translate-preview, public preview 2026-06).
//
// The Live API takes PCM16 mono 16 kHz input while our capture pipeline
// delivers 24 kHz, so audio payloads are resampled here. Gemini's translated
// PCM16 mono 24 kHz output is forwarded only after strict envelope validation.

import { isSupportedSubtitleLanguage, toGeminiLanguageCode } from "./subtitle-languages.js";
import { createCaptionPcmResampler } from "./caption-pcm-resampler.js";

// 2026-07-23 fix: the translate-preview model accepts setup on v1beta but
// closes with 1007 "Request contains an invalid argument" on the FIRST audio
// chunk. Live-probed: only the v1alpha endpoint keeps the session alive
// (matching the official SDK, which speaks v1alpha for the Live API).
const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-live-translate-preview";
const GEMINI_SAMPLE_RATE = 16000;
const TRANSLATED_AUDIO_SAMPLE_RATE = 24000;
const TRANSLATED_AUDIO_MIME_TYPE = "audio/pcm;rate=24000";
const MAX_TRANSLATED_AUDIO_BYTES = 256 * 1024;

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
// handles both WITHOUT duplicating — which is what made
// Korean output (agglutinative, frequently revised) churn and read garbled
// while English (rarely revised) looked clean:
//   - exact duplicate                  → ignore
//   - cumulative superset (grows)      → replace (snapshot)
//   - out-of-order earlier prefix      → ignore (never shrink back)
//   - duplicate trailing fragment      → ignore
//   - overlapping increment            → append only the unseen suffix
//   - conservative in-place revision   → replace the mutable snapshot
//   - genuine new increment            → append
const MAX_TRANSCRIPT_CHARS = 16_384;

function boundTranscript(value) {
  const text = String(value ?? "");
  return text.length <= MAX_TRANSCRIPT_CHARS ? text : text.slice(-MAX_TRANSCRIPT_CHARS);
}

function isSubtitleDebugEnabled(ctx = {}) {
  return ctx.debug === true || process.env.SUBTITLE_DEBUG === "1" || process.env.SUBTITLE_DEBUG === "true";
}

function sharedPrefixLength(left, right) {
  const maximum = Math.min(left.length, right.length);
  let index = 0;
  while (index < maximum && left[index] === right[index]) index += 1;
  return index;
}

function trailingOverlapLength(left, right) {
  const maximum = Math.min(left.length, right.length);
  if (maximum === 0) return 0;
  const pattern = right.slice(0, maximum);
  const prefixLengths = new Int32Array(pattern.length);
  for (let index = 1, matched = 0; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = prefixLengths[matched - 1];
    if (pattern[index] === pattern[matched]) matched += 1;
    prefixLengths[index] = matched;
  }
  const suffix = left.slice(-maximum);
  let overlapLength = 0;
  for (let index = 0; index < suffix.length; index += 1) {
    while (overlapLength > 0 && suffix[index] !== pattern[overlapLength]) {
      overlapLength = prefixLengths[overlapLength - 1];
    }
    if (suffix[index] === pattern[overlapLength]) overlapLength += 1;
    if (overlapLength === pattern.length && index < suffix.length - 1) {
      overlapLength = prefixLengths[overlapLength - 1];
    }
  }
  if (overlapLength > 1) return overlapLength;
  const before = left[left.length - 2] ?? "";
  const after = right[1] ?? "";
  return overlapLength === 1
    && /[^\p{L}\p{N}]/u.test(before)
    && /[^\p{L}\p{N}]/u.test(after)
    ? 1
    : 0;
}

function isConservativeRevision(previous, incoming) {
  if (previous.length < 8 || incoming.length < 8) return false;
  const shared = sharedPrefixLength(previous, incoming);
  return shared >= 4
    && shared / Math.min(previous.length, incoming.length) >= 0.3
    && incoming.length >= previous.length * 0.6;
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
  const overlapLength = trailingOverlapLength(prev, text);
  if (overlapLength > 0) return boundTranscript(`${prev}${text.slice(overlapLength)}`);
  // Gemini occasionally reissues the current mutable phrase with a small
  // correction instead of a prefix-growing snapshot. Replace only when a
  // substantial beginning is shared; unrelated long deltas remain append-only.
  if (isConservativeRevision(prev, text)) return boundTranscript(text);
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
    const outputLanguageCode = content.outputTranscription?.languageCode;
    if (ctx.isProviderOutputLanguageAllowed?.(outputLanguageCode) === false) {
      ctx.noteProviderOutputLanguageViolation?.(outputLanguageCode);
    } else {
      if (isSubtitleDebugEnabled(ctx)) ctx.broadcast?.({ type: "subtitle:debug", channel: ctx.targetLanguage, kind: "output", text: boundTranscript(outputText) });
      ctx.setTranslatedText?.(mergeTranscript(String(ctx.getTranslatedText?.() ?? ""), outputText));
      if (typeof ctx.schedulePartialFlush === "function") ctx.schedulePartialFlush();
      else ctx.emitPartial?.();
    }
  }

  if (content.turnComplete || content.generationComplete) {
    const sourceText = String(ctx.getSourceText?.() ?? "").trim();
    const translatedText = String(ctx.getTranslatedText?.() ?? "").trim();
    // Partials stay behind the strict output-language display gate, but a final
    // wrong-language draft must still reach the commit pipeline: its second pass
    // can recover from the source, or reject it and recycle a contaminated Live
    // session. Dropping it here made provider drift invisible and permanent.
    const willCommit = Boolean(translatedText)
      && (typeof ctx.shouldCommit === "function" ? ctx.shouldCommit() : ctx.shouldDisplay?.() !== false);
    if (isSubtitleDebugEnabled(ctx)) ctx.broadcast?.({ type: "subtitle:debug", channel: ctx.targetLanguage, kind: "turnEnd", text: `commit=${willCommit} :: ${translatedText.slice(-40)}` });
    if (willCommit) {
      ctx.commitSubtitle?.({ sourceText, translatedText });
    }
    ctx.resetUtterance?.({ preserveSilenceClear: true });
  }
}

/** @param {any} options */
export function createGeminiTransport({ settings = {}, targetLanguage = "ko", apiKey = "" } = {}) {
  const downsampleGeminiInput = createCaptionPcmResampler();
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
            data: downsampleGeminiInput(Buffer.from(base64Pcm24k, "base64")).toString("base64"),
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
