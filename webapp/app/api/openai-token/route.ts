import {
  getOpenAiApiKey,
  consumeOpenAiTranslationRateLimit,
  OpenAiTranslationConfigurationError,
  OpenAiTranslationRequestTooLargeError,
  readBoundedJson,
} from "../../../lib/security/openai-translation-security";
import {
  LANGUAGE_CODES,
  normalizeLanguageCode,
  toOpenAITranslationLanguageCode,
  type CanonicalLanguageCode,
} from "../../../lib/languageDetect";

const OPENAI_CLIENT_SECRET_URL = "https://api.openai.com/v1/realtime/translations/client_secrets";
const OPENAI_REQUEST_TIMEOUT_MS = 8_000;
const OPENAI_TRANSLATION_MODEL = "gpt-realtime-translate";
const OPENAI_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
const MAX_CLIENT_SECRET_CHARS = 8_192;
const OPENAI_TRANSLATION_LANGUAGE_CODES = new Set(LANGUAGE_CODES.map(toOpenAITranslationLanguageCode));

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function success<T>(data: T): Response {
  return Response.json({ ok: true, data });
}

function failure(error: string, code: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ ok: false, error, code }, { status, headers });
}

function readClientSecret(payload: unknown, serverApiKey: string): {
  value: string;
  expires_at: number;
} | null {
  if (!isRecord(payload)) return null;
  const nested = isRecord(payload.client_secret) ? payload.client_secret : null;
  const rawValue = payload.value ?? nested?.value;
  const expiresAt = payload.expires_at ?? nested?.expires_at;
  if (typeof rawValue !== "string"
    || !rawValue.trim()
    || rawValue.length > MAX_CLIENT_SECRET_CHARS
    || /[\x00-\x20\x7f]/u.test(rawValue)
    || rawValue === serverApiKey) return null;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  return { value: rawValue, expires_at: expiresAt };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function readTargetLanguage(request: Request): Promise<CanonicalLanguageCode | null> {
  const payload = await readBoundedJson(request);
  if (!isRecord(payload)) return null;
  const language = normalizeLanguageCode(payload.targetLanguage);
  return language && OPENAI_TRANSLATION_LANGUAGE_CODES.has(toOpenAITranslationLanguageCode(language))
    ? language
    : null;
}

// 2026-07-22 fix: Bind every browser secret to one translation target. This
// keeps the long-lived key server-side and prevents a captured ephemeral token
// from changing the model or output language after issuance.
export async function POST(request: Request): Promise<Response> {
  let targetLanguage: CanonicalLanguageCode | null;
  try {
    targetLanguage = await readTargetLanguage(request);
  } catch (error: unknown) {
    if (!(error instanceof OpenAiTranslationRequestTooLargeError)) throw error;
    return failure(
      "OpenAI 번역 요청이 올바르지 않습니다.",
      "OPENAI_TOKEN_REQUEST_INVALID",
      400,
    );
  }
  if (!targetLanguage) {
    return failure(
      "지원하지 않는 OpenAI 번역 대상 언어입니다.",
      "OPENAI_TARGET_LANGUAGE_INVALID",
      400,
    );
  }
  let apiKey: string;
  try {
    apiKey = getOpenAiApiKey();
  } catch (error: unknown) {
    if (!(error instanceof OpenAiTranslationConfigurationError)) throw error;
    return failure(
      "OpenAI 임시 토큰 기능이 설정되지 않았습니다.",
      "OPENAI_TOKEN_NOT_CONFIGURED",
      503,
    );
  }

  let rateLimit;
  try {
    rateLimit = await consumeOpenAiTranslationRateLimit(request.headers);
  } catch {
    return failure(
      "OpenAI 번역 연결 보안을 확인할 수 없습니다.",
      "OPENAI_TOKEN_SECURITY_UNAVAILABLE",
      503,
    );
  }
  if (!rateLimit.isAllowed) {
    return failure(
      "OpenAI 번역 연결 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      "OPENAI_TOKEN_RATE_LIMITED",
      429,
      { "retry-after": String(rateLimit.retryAfterSeconds) },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_REQUEST_TIMEOUT_MS);
  const body = {
    session: {
      model: OPENAI_TRANSLATION_MODEL,
      audio: {
        input: { transcription: { model: OPENAI_TRANSCRIPTION_MODEL } },
        output: { language: toOpenAITranslationLanguageCode(targetLanguage) },
      },
    },
  };

  const mint = () => fetch(OPENAI_CLIENT_SECRET_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: controller.signal,
  });

  try {
    const response = await mint();
    if (!response.ok) {
      return failure(
        "OpenAI 임시 토큰을 발급할 수 없습니다.",
        "OPENAI_TOKEN_PROVIDER_ERROR",
        502,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return failure(
        "OpenAI 임시 토큰 응답이 올바르지 않습니다.",
        "OPENAI_TOKEN_INVALID_RESPONSE",
        502,
      );
    }
    const secret = readClientSecret(payload, apiKey);
    if (!secret) {
      return failure(
        "OpenAI 임시 토큰 응답이 올바르지 않습니다.",
        "OPENAI_TOKEN_INVALID_RESPONSE",
        502,
      );
    }
    return success(secret);
  } catch (error: unknown) {
    if (isAbortError(error)) {
      return failure(
        "OpenAI 임시 토큰 발급 요청 시간이 초과되었습니다.",
        "OPENAI_TOKEN_TIMEOUT",
        504,
      );
    }
    return failure(
      "OpenAI 임시 토큰을 발급할 수 없습니다.",
      "OPENAI_TOKEN_REQUEST_FAILED",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}
