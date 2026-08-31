import { createCaptionPcmResampler } from "./caption-pcm-resampler.js";

const GEMINI_TRANSCRIBE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const GEMINI_TRANSCRIBE_MODEL = "gemini-3.5-transcribe-live";
const GEMINI_SAMPLE_RATE = 16_000;
const MAX_TRANSCRIPT_CHARACTERS = 16_384;
const MAX_CUSTOM_VOCABULARY_ENTRIES = 100;
const MAX_CUSTOM_VOCABULARY_CHARACTERS = 240;

function sanitizeGeminiErrorDetail(value) {
  return String(value ?? "")
    .replace(/(?:AIza|sk-)[A-Za-z0-9_-]+/gu, "[redacted-secret]")
    .replace(/[A-Za-z0-9+/]{64,}={0,2}/gu, "[redacted-data]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, 240);
}

function normalizeCustomVocabulary(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values
    .map((value) => String(value ?? "").normalize("NFC").trim())
    .filter((value) => value.length > 0 && value.length <= MAX_CUSTOM_VOCABULARY_CHARACTERS)
    .filter((value) => !/[\u0000-\u001f\u007f\p{Cf}]/u.test(value))))
    .slice(0, MAX_CUSTOM_VOCABULARY_ENTRIES);
}

export function buildGeminiTranscribeSetupMessage({ customVocabulary = [] } = {}) {
  const vocabulary = normalizeCustomVocabulary(customVocabulary);
  return JSON.stringify({
    setup: {
      model: `models/${GEMINI_TRANSCRIBE_MODEL}`,
      generationConfig: {
        responseModalities: ["TEXT"],
      },
      inputAudioTranscription: {
        languageCodes: [],
        // 2026-08-27 feat: authoritative source must remain literal. Cleanup,
        // translation, and terminology repair happen in the bounded text lane.
        mode: "VERBATIM",
        ...(vocabulary.length > 0 ? { customVocabulary: vocabulary } : {}),
      },
    },
  });
}

function normalizeTranscription(value) {
  if (!value || typeof value !== "object") return null;
  const text = typeof value.text === "string" ? value.text.normalize("NFC").trim() : "";
  if (!text || text.length > MAX_TRANSCRIPT_CHARACTERS) return null;
  const languageCode = typeof value.languageCode === "string" && value.languageCode.length <= 128
    ? value.languageCode
    : undefined;
  return { text, ...(languageCode ? { languageCode } : {}) };
}

export function handleGeminiTranscribeMessage(raw, context = {}) {
  let message;
  try {
    message = JSON.parse(raw.toString("utf8"));
  } catch {
    context.broadcast?.({
      type: "subtitle:error",
      message: "Gemini Transcribe 응답을 읽을 수 없습니다.",
      code: "INVALID_GEMINI_TRANSCRIBE_MESSAGE",
    });
    return;
  }

  if (message.setupComplete !== undefined) {
    context.onTransportReady?.();
    context.broadcast?.({ type: "subtitle:status", status: "api_ready" });
    return;
  }

  if (message.error !== undefined) {
    const detail = sanitizeGeminiErrorDetail(message.error?.message ?? message.error?.status)
      || "Unknown Gemini Transcribe error";
    context.broadcast?.({
      type: "subtitle:error",
      message: `Gemini Transcribe 오류: ${detail}`,
      code: "GEMINI_TRANSCRIBE_ERROR",
    });
    return;
  }

  if (message.goAway !== undefined) {
    context.onServerGoAway?.();
    return;
  }

  const content = message.serverContent;
  if (!content || typeof content !== "object") return;
  const interim = normalizeTranscription(content.interimInputTranscription);
  if (interim) context.onInterim?.(interim);
  const final = normalizeTranscription(content.inputTranscription);
  if (final) context.onFinal?.(final);
}

export function createGeminiTranscribeTransport({ apiKey = "", customVocabulary = [] } = {}) {
  const resampleInput = createCaptionPcmResampler();
  return {
    requiresSetupAck: true,
    connect({ createWebSocket }) {
      const url = `${GEMINI_TRANSCRIBE_URL}?key=${encodeURIComponent(apiKey)}`;
      return createWebSocket(url, undefined, {});
    },
    setupPayloads() {
      return [buildGeminiTranscribeSetupMessage({ customVocabulary })];
    },
    audioPayload(base64Pcm24k) {
      return JSON.stringify({
        realtimeInput: {
          audio: {
            data: resampleInput(Buffer.from(base64Pcm24k, "base64")).toString("base64"),
            mimeType: `audio/pcm;rate=${GEMINI_SAMPLE_RATE}`,
          },
        },
      });
    },
    handleMessage(raw, context) {
      handleGeminiTranscribeMessage(raw, context);
    },
    closePayload() {
      return JSON.stringify({ realtimeInput: { audioStreamEnd: true } });
    },
  };
}

export const geminiTranscribeContract = Object.freeze({
  model: GEMINI_TRANSCRIBE_MODEL,
  maximumSessionMilliseconds: 600_000,
  maximumVocabularyEntries: MAX_CUSTOM_VOCABULARY_ENTRIES,
});
