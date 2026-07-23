// OpenAI realtime translation transport for the BROWSER (ephemeral auth).
//
// Why this differs from the desktop (src/subtitle-realtime.js): the realtime
// *translation* model (/v1/realtime/translations, gpt-realtime-translate) only
// works with a direct API-key (Authorization header) — and browsers cannot set
// WebSocket headers. Ephemeral client secrets, the only browser-safe auth, only
// support session.type "realtime" and "transcription" (live-verified: minting
// type "translation" returns 400). So the browser uses the GA **realtime**
// session (gpt-realtime, ephemeral OK) as a simultaneous interpreter: the model
// is instructed to translate the input audio into the target language and emits
// streaming text via response.output_text.delta. Input transcription runs in
// the same session to provide the source line + source-language detection.

import { type LanguageCode } from "./languageDetect";
import type { Transport, TransportCtx } from "./channelCore";
import type { AudioSource } from "./types";

const REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime";
const MAX_CLIENT_SECRET_CHARS = 8_192;
const MAX_TOKEN_ERROR_MESSAGE_CHARS = 200;
const TOKEN_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readClientSecretEnvelope(payload: unknown): string | null {
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.data)) return null;
  const value = payload.data.value;
  const expiresAt = payload.data.expires_at;
  const hasValidExpiry = expiresAt === null
    || (typeof expiresAt === "number" && Number.isFinite(expiresAt))
    || (typeof expiresAt === "string" && Boolean(expiresAt.trim()));
  if (typeof value !== "string" || !value.trim() || value.length > MAX_CLIENT_SECRET_CHARS) return null;
  if (/[\u0000-\u0020\u007f]/u.test(value) || !hasValidExpiry) return null;
  return value;
}

function readTokenErrorEnvelope(payload: unknown): { message: string; code: string } | null {
  if (!isRecord(payload) || payload.ok !== false) return null;
  const message = payload.error;
  const code = payload.code;
  if (typeof message !== "string" || typeof code !== "string") return null;
  const normalizedMessage = message.trim();
  if (!normalizedMessage || normalizedMessage.length > MAX_TOKEN_ERROR_MESSAGE_CHARS) return null;
  if (!/[가-힣]/u.test(normalizedMessage) || /[<>\u0000-\u001f\u007f]/u.test(normalizedMessage)) return null;
  if (!TOKEN_ERROR_CODE_PATTERN.test(code)) return null;
  return { message: normalizedMessage, code };
}

const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  ko: "Korean",
  en: "English",
  ja: "Japanese",
};

export function buildInterpreterSession(
  targetLanguage: LanguageCode,
  enableTranscription = true,
  opts: { glossary?: string; domain?: string } = {},
) {
  const language = LANGUAGE_NAMES[targetLanguage] ?? "Korean";
  const input: Record<string, unknown> = {
    // VAD marks utterance boundaries only; we issue response.create ourselves on
    // speech_stopped (guarded so overlapping clauses never collide with an
    // in-flight response). Auto create_response defaults to the audio modality
    // and yields no output_text — live-verified. A shorter silence window
    // segments at natural clause pauses so the translation streams out
    // sooner/more "live" instead of waiting for a long end-of-utterance gap.
    turn_detection: { type: "server_vad", create_response: false, silence_duration_ms: 300, prefix_padding_ms: 200 },
  };
  // Source transcription powers the source line + suppression gate (small
  // add-on cost). The engine disables it only for single-direction sessions
  // where the source line is hidden.
  if (enableTranscription) input.transcription = { model: "gpt-4o-mini-transcribe" };

  let instructions =
    `You are a simultaneous interpreter. Translate the user's spoken audio into natural ${language}. ` +
    `Output ONLY the ${language} translation — no commentary, labels, or quotes. ` +
    `Detect the spoken language independently for every VAD turn, including immediate English↔Korean switches. ` +
    `If the audio is already in ${language}, output it cleaned up. Names and acronyms may remain in their original script. ` +
    `Preserve numbers and never copy other source-language wording.`;
  const domain = String(opts.domain ?? "").trim();
  if (domain) {
    instructions += ` DOMAIN: ${domain}. Resolve ambiguous words with the sense a domain expert would use.`;
  }
  const glossary = String(opts.glossary ?? "").trim();
  if (glossary) {
    // Glossary applied at the model level so the base translation already honors
    // it (partials included) — the commit-time polish step is the cross-model
    // reinforcement. Same policy on any engine; OpenAI just also bakes it in.
    instructions +=
      ` TERMINOLOGY (mandatory): the glossary below lists symmetric term/idiom pairs. ` +
      `Whenever either side of a pair appears, render it with its exact counterpart; ` +
      `translate idioms sense-for-sense, preferring an equivalent target-language idiom; ` +
      `keep acronyms verbatim. Apply a pair only where its term actually appears.\nGLOSSARY:\n${glossary}`;
  }

  return {
    type: "realtime",
    output_modalities: ["text"],
    instructions,
    audio: { input },
  };
}

export async function mintClientSecret(): Promise<string> {
  let response: Response;
  try {
    response = await fetch("/api/openai-token", { method: "POST" });
  } catch {
    throw new Error("OpenAI 토큰 발급 요청에 실패했습니다.");
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {}
  if (!response.ok) {
    const failure = readTokenErrorEnvelope(payload);
    if (failure) throw new Error(`${failure.message} (${failure.code})`);
    throw new Error(`OpenAI 토큰 발급에 실패했습니다. (${response.status})`);
  }
  const value = readClientSecretEnvelope(payload);
  if (!value) throw new Error("OpenAI 토큰 응답이 올바르지 않습니다.");
  return value;
}

export function createOpenAITransport({
  targetLanguage,
  enableTranscription = true,
  glossary,
  domain,
}: {
  source: AudioSource;
  targetLanguage: LanguageCode;
  enableTranscription?: boolean;
  glossary?: string;
  domain?: string;
}): Transport {
  // Per-channel response-lifecycle state. The realtime API allows only one
  // active response at a time; firing response.create while one is in flight
  // errors with "active response in progress" and merges clauses into one late
  // block. We serialize: create when idle, else mark pending and fire it the
  // moment the current response completes — each clause translated exactly once
  // (no token waste), streamed as soon as the model can.
  const responses = { busy: false, pending: false };

  return {
    async connect() {
      const clientSecret = await mintClientSecret();
      // GA shape: auth rides on the secret subprotocol (browsers can't set the
      // Authorization header). The legacy "openai-beta.realtime-v1" subprotocol
      // is gone — it now closes the session with code 4000.
      return new WebSocket(REALTIME_URL, ["realtime", `openai-insecure-api-key.${clientSecret}`]);
    },
    setupPayloads() {
      return [JSON.stringify({ type: "session.update", session: buildInterpreterSession(targetLanguage, enableTranscription, { glossary, domain }) })];
    },
    audioPayload(audio: string) {
      return JSON.stringify({ type: "input_audio_buffer.append", audio });
    },
    handleMessage(raw: string, ctx: TransportCtx) {
      handleRealtimeMessage(raw, ctx, responses);
    },
    // GA realtime has no session.close handshake — the channel closes the
    // socket directly. Commits fire per-utterance on response.output_text.done,
    // so an immediate close never drops a finished line.
  };
}

export function handleRealtimeMessage(
  line: string,
  ctx: TransportCtx,
  responses: { busy: boolean; pending: boolean } = { busy: false, pending: false },
) {
  if (!line.trim()) return;
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    ctx.broadcast({ type: "error", message: `Invalid realtime message: ${line}`, code: "INVALID_REALTIME_MESSAGE" });
    return;
  }

  const { source, targetLanguage } = ctx;

  switch (message.type) {
    case "session.created":
    case "session.updated":
      ctx.broadcast({ type: "status", status: "api_ready", source, targetLanguage });
      return;

    // Source transcript (for the optional source line + source-language gate).
    case "conversation.item.input_audio_transcription.delta":
      ctx.setSourceText(`${ctx.getSourceText()}${message.delta ?? ""}`);
      ctx.rememberSourceTranscriptDelta(message.delta ?? "", message.language);
      ctx.emitPartial();
      return;

    case "conversation.item.input_audio_transcription.completed": {
      const previous = String(ctx.getSourceText() ?? "");
      const next = String(message.transcript ?? previous);
      ctx.setSourceText(next);
      ctx.rememberSourceTranscriptSnapshot(next, previous, message.language);
      ctx.emitPartial();
      return;
    }

    // Streaming translation output — the realtime interpreter's text response.
    case "response.output_text.delta":
      ctx.setTranslatedText(`${ctx.getTranslatedText()}${message.delta ?? ""}`);
      ctx.emitPartial();
      return;

    case "response.output_text.done": {
      if (typeof message.text === "string" && message.text.trim()) {
        ctx.setTranslatedText(message.text);
      }
      const sourceText = String(ctx.getSourceText() ?? "").trim();
      const translatedText = String(ctx.getTranslatedText() ?? "").trim();
      if (translatedText && ctx.shouldDisplay() !== false) {
        ctx.commitSubtitle({ sourceText, translatedText });
      }
      ctx.setSourceText("");
      ctx.setTranslatedText("");
      ctx.resetUtterance();
      return;
    }

    case "input_audio_buffer.speech_started":
      ctx.resetUtterance();
      ctx.broadcast({ type: "status", status: "hearing", source, targetLanguage });
      return;

    case "input_audio_buffer.speech_stopped":
      // VAD committed this clause's audio. Translate it now if idle; if a
      // previous clause is still translating, queue exactly one follow-up so we
      // never collide ("active response in progress") or re-translate.
      if (responses.busy) {
        responses.pending = true;
      } else {
        responses.busy = true;
        ctx.send(JSON.stringify({ type: "response.create" }));
      }
      ctx.broadcast({ type: "status", status: "translating", source, targetLanguage });
      return;

    case "response.created":
      responses.busy = true;
      return;

    case "response.done":
      responses.busy = false;
      if (responses.pending) {
        responses.pending = false;
        responses.busy = true;
        ctx.send(JSON.stringify({ type: "response.create" }));
      }
      return;

    case "error":
      // A rejected/failed response (e.g. "conversation_already_has_active_
      // response") emits `error` with NO matching response.done — which would
      // leave responses.busy stuck true and silence the channel forever. Reset
      // the guard so the next utterance recovers. (A still-active original
      // response will harmlessly emit its own response.done afterwards.)
      responses.busy = false;
      responses.pending = false;
      ctx.broadcast({
        type: "error",
        message: message.error?.message ?? "Realtime translation error",
        code: message.error?.code ?? "REALTIME_TRANSLATION_ERROR",
      });
      return;

    default:
      return;
  }
}
