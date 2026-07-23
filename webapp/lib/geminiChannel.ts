// Gemini Live API transport for realtime subtitle translation
// (gemini-3.5-live-translate-preview). Ported from
// autopreso/src/gemini-live-translate.js.
//
// Auth: /api/gemini-token returns the API key to authenticated sessions and
// the socket connects with `?key=<key>`. The ephemeral authTokens API
// (?access_token=...) returned 404 as of 2026-06, so it is no longer used.
//
// The Live API takes PCM16 mono 16 kHz input while our capture pipeline
// delivers 24 kHz, so audio payloads are resampled here. Translated AUDIO
// parts are discarded — only the input/output text transcripts feed subtitles.

import { GEMINI_SAMPLE_RATE, OPENAI_SAMPLE_RATE, createStreamingPcm16Resampler } from "./audio";
import type { Transport, TransportCtx } from "./channelCore";
import { toGeminiLanguageCode, type LanguageCode } from "./languageDetect";

const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-live-translate-preview";
const GEMINI_INPUT_CHUNK_BYTES = 3_200;

export function createGeminiAudioPacketizer() {
  const resampler = createStreamingPcm16Resampler(OPENAI_SAMPLE_RATE, GEMINI_SAMPLE_RATE);
  let tail = new Uint8Array(0);
  return {
    push(base64Pcm24k: string): string[] {
      const resampled = resampler.push(base64Pcm24k);
      const combined = new Uint8Array(tail.byteLength + resampled.byteLength);
      combined.set(tail);
      combined.set(resampled, tail.byteLength);
      const frames: string[] = [];
      const completeBytes = combined.byteLength - (combined.byteLength % GEMINI_INPUT_CHUNK_BYTES);
      for (let offset = 0; offset < completeBytes; offset += GEMINI_INPUT_CHUNK_BYTES) {
        let binary = "";
        const frame = combined.subarray(offset, offset + GEMINI_INPUT_CHUNK_BYTES);
        for (let index = 0; index < frame.length; index += 1) binary += String.fromCharCode(frame[index]);
        frames.push(btoa(binary));
      }
      tail = combined.slice(completeBytes);
      return frames;
    },
    reset() {
      resampler.reset();
      tail = new Uint8Array(0);
    },
  };
}

export function buildGeminiSetupMessage(targetLanguage: LanguageCode, resumptionHandle = ""): string {
  // Field placement verified against the live endpoint (2026-06 probe):
  // the transcription configs are SETUP-level fields and translationConfig
  // lives inside generationConfig. Any other placement makes the server close
  // the socket with 1007 "Unknown name ... Cannot find field" before
  // setupComplete.
  //
  // responseModalities stays AUDIO: ALL Gemini Live models are audio-first.
  // Live-verified 2026-06-14: flash-live & native-audio reject TEXT with 1007
  // ("response modalities (TEXT) is not supported"); the translate model accepts
  // TEXT but still synthesizes audio (~49 audio parts) and reports the
  // translation via outputTranscription either way — so TEXT buys nothing.
  // The translation text therefore arrives as outputTranscription; we discard
  // the synthesized audio modelTurn parts.
  return JSON.stringify({
    setup: {
      model: `models/${DEFAULT_GEMINI_MODEL}`,
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
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {},
    },
  });
}

// The docs are ambiguous on whether transcription messages are append
// fragments or full snapshots; normalize both. A snapshot that starts with the
// accumulated text replaces it, anything else appends.
function mergeTranscript(accumulated: string, incoming: unknown): string {
  const text = String(incoming ?? "");
  if (!text) return accumulated;
  if (accumulated && text.startsWith(accumulated)) return text;
  return `${accumulated}${text}`;
}

export function handleGeminiLiveMessage(raw: string, ctx: TransportCtx) {
  const line = raw;
  if (!line.trim()) return;
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    ctx.broadcast({ type: "error", message: `Invalid Gemini live message: ${line}`, code: "INVALID_GEMINI_MESSAGE" });
    return;
  }

  if (message.setupComplete !== undefined) {
    // The Live API handshake: only after BidiGenerateContentSetupComplete may
    // the client stream realtimeInput. Unblocks the channel's audio buffer.
    ctx.onTransportReady();
    ctx.broadcast({ type: "status", status: "api_ready", source: ctx.source, targetLanguage: ctx.targetLanguage });
    return;
  }

  if (message.error !== undefined) {
    const detail = message.error?.message ?? JSON.stringify(message.error);
    const status = message.error?.status ? ` (${message.error.status})` : "";
    ctx.broadcast({
      type: "error",
      message: `Gemini Live error${status}: ${detail}`,
      code: "GEMINI_LIVE_ERROR",
    });
    return;
  }

  if (message.goAway !== undefined) {
    ctx.broadcast({ type: "status", status: "reconnecting", source: ctx.source, targetLanguage: ctx.targetLanguage });
    ctx.onServerGoAway?.();
    return;
  }

  if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate?.newHandle) {
    ctx.setResumptionHandle?.(String(message.sessionResumptionUpdate.newHandle));
    return;
  }

  const content = message.serverContent;
  if (!content) return;

  const inputText = content.inputTranscription?.text;
  if (inputText) {
    const previous = String(ctx.getSourceText() ?? "");
    const next = mergeTranscript(previous, inputText);
    ctx.setSourceText(next);
    ctx.rememberSourceTranscriptDelta(
      next.startsWith(previous) ? next.slice(previous.length) : next,
      content.inputTranscription?.languageCode,
    );
    ctx.emitPartial();
  }

  // In TEXT mode the translation streams via outputTranscription; some model
  // builds may instead put it in modelTurn text parts — accept either.
  const modelTurnText = (content.modelTurn?.parts ?? [])
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
  const outputText = content.outputTranscription?.text || modelTurnText;
  if (outputText) {
    ctx.setTranslatedText(mergeTranscript(String(ctx.getTranslatedText() ?? ""), outputText));
    ctx.emitPartial();
    ctx.scheduleCommit();
  }

  if (content.turnComplete) {
    const sourceText = String(ctx.getSourceText() ?? "").trim();
    const translatedText = String(ctx.getTranslatedText() ?? "").trim();
    if (translatedText && ctx.shouldDisplay() !== false) {
      ctx.commitSubtitle({ sourceText, translatedText });
    }
    ctx.resetUtterance();
  }
}

async function fetchApiKey(): Promise<string> {
  const response = await fetch("/api/gemini-token", { method: "POST" });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `Gemini 키 조회 실패 (${response.status})`);
  }
  const key = data?.key;
  if (!key) throw new Error("Gemini 키 응답에 key가 없습니다.");
  return String(key);
}

export function createGeminiTransport({
  targetLanguage,
}: {
  targetLanguage: LanguageCode;
}): Transport {
  const audioPacketizer = createGeminiAudioPacketizer();
  return {
    // The Live API rejects realtimeInput sent before setupComplete; the
    // channel must buffer audio until the ack arrives.
    requiresSetupAck: true,
    async connect() {
      // Key is exposed only to authenticated sessions; the ephemeral
      // authTokens API was 404 as of 2026-06.
      const key = await fetchApiKey();
      const url = `${GEMINI_LIVE_URL}?key=${encodeURIComponent(key)}`;
      return new WebSocket(url);
    },
    setupPayloads({ resumptionHandle = "" } = {}) {
      return [buildGeminiSetupMessage(targetLanguage, resumptionHandle)];
    },
    audioPayload(base64Pcm24k: string) {
      return audioPacketizer.push(base64Pcm24k).map((data) => JSON.stringify({
          realtimeInput: {
            audio: {
              data,
              mimeType: `audio/pcm;rate=${GEMINI_SAMPLE_RATE}`,
            },
          },
        }));
    },
    resetAudioInput() {
      audioPacketizer.reset();
    },
    handleMessage(raw: string, ctx: TransportCtx) {
      handleGeminiLiveMessage(raw, ctx);
    },
    // No graceful close handshake in the Live API — undefined means the
    // channel closes the socket immediately.
    closePayload() {
      return undefined;
    },
  };
}
